// PLAN T-2309 (PM-METRIC-003/005/006; D-118; migration 0067) — `track()` và bảng `product_events` trên Postgres thật, bằng vai trò
// `app_runtime`/`app_worker` như chạy thật: ghi được khi có đồng ý (và KHÔNG khi mặc định từ chối/không hợp lệ); lỗi ghi không làm
// hỏng transaction của lệnh; RLS theo tổ chức; app_runtime không SELECT/UPDATE/DELETE, worker không chạm bảng trực tiếp; xoá quá
// hạn đúng mốc 13 THÁNG LỊCH (đúng mốc còn giữ, đồng hồ lệch tương lai không xoá thêm, lô); ngắt liên kết người khi xoá tài khoản.
import { randomUUID } from "node:crypto";
import { migrations, withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveActor } from "../access/actor.ts";
import { createPeriod } from "../billing/billing.ts";
import { executeCommand } from "../pipeline/command.ts";
import { PRODUCT_EVENTS_RETENTION_MONTHS, purgeExpiredOperational } from "../retention/index.ts";
import { configureAnalytics, resetAnalytics, track } from "./index.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let userA: string;
let userB: string;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà nghỉ Sen Hồng", "hotel");
  B = await seedOrg(t.admin, "Nhà trọ Bên Sông", "rental");
  userA = await seedAuthUser(t.admin, "an@example.com");
  userB = await seedAuthUser(t.admin, "binh@example.com");
});
afterAll(async () => {
  await t?.drop();
});
beforeEach(async () => {
  await sql`delete from product_events`.execute(t.admin);
});
afterEach(() => resetAnalytics());

const allow = () => true;
const TASK = { task: "stay_checked_in" };
interface Row {
  id: string;
  organization_id: string;
  property_id: string | null;
  name: string;
  schema_version: number;
  props: Record<string, unknown>;
  actor_user_id: string | null;
  occurred_at: Date;
}
const rows = async () =>
  (await sql<Row>`select * from product_events order by occurred_at, id`.execute(t.admin)).rows;
const count = async () => (await rows()).length;

/** Chèn thẳng bằng admin (bỏ RLS) để dựng dữ liệu "cũ". */
async function seedEvent(org: SeededOrg, occurredAt: string, actor: string | null = null): Promise<string> {
  const id = randomUUID();
  await sql`insert into product_events (id, organization_id, property_id, name, schema_version, props, actor_user_id, occurred_at)
            values (${id}, ${org.orgId}, ${org.propertyId}, 'core_task.completed', 1, '{"task":"stay_checked_in"}'::jsonb,
                    ${actor}, ${occurredAt})`.execute(t.admin);
  return id;
}
const alive = async (id: string) =>
  ((await sql<{ n: number }>`select count(*)::int as n from product_events where id = ${id}`.execute(t.admin))
    .rows[0]?.n ?? 0) > 0;

describe("track() ghi product_events (vai trò app_runtime, RLS theo tổ chức)", () => {
  it("có đồng ý ⇒ ghi đúng tổ chức/cơ sở/tên/phiên bản/props/người/thời điểm; không đồng ý (mặc định) ⇒ không ghi gì", async () => {
    const at = new Date("2026-05-01T03:00:00.000Z");
    const ctxA = { organizationId: A.orgId, propertyId: A.propertyId, actorUserId: userA, occurredAt: at };
    const denied = await withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
      track("core_task.completed", TASK, { ...ctxA, db: trx }),
    );
    expect(denied).toEqual({ status: "dropped", reason: "no_consent" });
    expect(await count()).toBe(0);

    configureAnalytics({ consent: allow });
    const r = await withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
      track("core_task.completed", TASK, { ...ctxA, db: trx }),
    );
    expect(r.status).toBe("recorded");
    const [row] = await rows();
    expect(row).toMatchObject({
      organization_id: A.orgId,
      property_id: A.propertyId,
      name: "core_task.completed",
      schema_version: 1,
      props: TASK,
      actor_user_id: userA,
    });
    expect(row?.occurred_at.toISOString()).toBe(at.toISOString());
  });

  it("không cơ sở/người/thời điểm: property_id và actor_user_id NULL, occurred_at theo đồng hồ CSDL", async () => {
    configureAnalytics({ consent: allow });
    await withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
      track(
        "billing_period.issued",
        { billing_period_id: randomUUID(), invoice_count: 0 },
        { db: trx, organizationId: A.orgId },
      ),
    );
    const [row] = await rows();
    expect(row?.property_id).toBeNull();
    expect(row?.actor_user_id).toBeNull();
    expect(row?.props.invoice_count).toBe(0);
    expect(Math.abs(Date.now() - (row?.occurred_at.getTime() ?? 0))).toBeLessThan(60_000);
  });

  it("payload không hợp lệ ném ở test và KHÔNG ghi; chế độ production bỏ sự kiện, không ném", async () => {
    configureAnalytics({ consent: allow });
    await withTenant(t.runtime, { orgId: A.orgId }, async (trx) => {
      const ctx = { db: trx, organizationId: A.orgId };
      await expect(track("core_task.completed", { task: "x" }, ctx)).rejects.toMatchObject({
        code: "invalid_type",
      });
      await expect(track("core_task.completed", { ...TASK, note: "x" }, ctx)).rejects.toMatchObject({
        code: "pii_key",
      });
      expect(await track("core_task.completed", { task: "x" }, ctx, { strict: false })).toEqual({
        status: "dropped",
        reason: "invalid",
      });
    });
    expect(await count()).toBe(0);
  });

  it("lỗi ghi (RLS: tổ chức khác ngữ cảnh; FK cơ sở của tổ chức khác) không làm transaction của lệnh rơi vào aborted", async () => {
    configureAnalytics({ consent: allow });
    await withTenant(t.runtime, { orgId: A.orgId }, async (trx) => {
      // production: bỏ + trả write_failed, transaction vẫn dùng được và ghi tiếp được
      const rls = await track(
        "core_task.completed",
        TASK,
        { db: trx, organizationId: B.orgId },
        { strict: false },
      );
      expect(rls).toEqual({ status: "dropped", reason: "write_failed" });
      const fk = await track(
        "core_task.completed",
        TASK,
        { db: trx, organizationId: A.orgId, propertyId: B.propertyId },
        { strict: false },
      );
      expect(fk).toEqual({ status: "dropped", reason: "write_failed" });
      expect((await sql<{ one: number }>`select 1 as one`.execute(trx)).rows[0]?.one).toBe(1);
      // dev/test: ném lỗi CSDL thật (để test đỏ), nhưng savepoint đã được lùi nên transaction vẫn dùng được
      await expect(track("core_task.completed", TASK, { db: trx, organizationId: B.orgId })).rejects.toThrow(
        /row-level security/,
      );
      const ok = await track("core_task.completed", TASK, { db: trx, organizationId: A.orgId });
      expect(ok.status).toBe("recorded");
    });
    expect(await count()).toBe(1);
  });

  it("sự kiện nằm cùng transaction với lệnh: lệnh rollback ⇒ không còn sự kiện", async () => {
    configureAnalytics({ consent: allow });
    await expect(
      withTenant(t.runtime, { orgId: A.orgId }, async (trx) => {
        expect((await track("core_task.completed", TASK, { db: trx, organizationId: A.orgId })).status).toBe(
          "recorded",
        );
        throw new Error("lệnh thất bại sau khi đo");
      }),
    ).rejects.toThrow(/lệnh thất bại/);
    expect(await count()).toBe(0);
  });
});

describe("nối vào lớp command (billing.createPeriod)", () => {
  async function runCreate(month: string, fail = false) {
    const actor = await resolveActor(t.runtime, {
      authUserId: A.ownerAuthUserId,
      orgId: A.orgId,
      twoFactorEnabled: true,
    });
    const key = randomUUID();
    return executeCommand(
      t.runtime,
      actor,
      {
        command: "billing.createPeriod",
        idempotencyKey: key,
        payload: { month },
        correlationId: "c-analytics",
      },
      async (ctx) => {
        const data = await createPeriod(ctx, { propertyId: A.propertyId, month });
        if (fail) throw new Error("lệnh thất bại sau createPeriod");
        return { data };
      },
    );
  }

  it("mặc định từ chối ⇒ lệnh chạy bình thường, không có sự kiện; có đồng ý ⇒ ghi billing_period.created với ID, cơ sở, người", async () => {
    const r1 = await runCreate("2026-11");
    expect(r1.status).toBe("committed");
    expect(await count()).toBe(0);

    configureAnalytics({ consent: allow });
    const r2 = await runCreate("2026-12");
    expect(r2.status).toBe("committed");
    const [row] = await rows();
    expect(row).toMatchObject({
      organization_id: A.orgId,
      property_id: A.propertyId,
      name: "billing_period.created",
      actor_user_id: A.ownerAuthUserId,
    });
    expect(row?.props).toEqual({
      billing_period_id: (r2 as { data: { billingPeriodId: string } }).data.billingPeriodId,
    });
    // tạo lại cùng kỳ ⇒ không phải lần tạo mới ⇒ không đo lần nữa
    await runCreate("2026-12");
    expect(await count()).toBe(1);
  });

  it("lệnh thất bại sau khi đo ⇒ rollback cả kỳ thu lẫn sự kiện", async () => {
    configureAnalytics({ consent: allow });
    await expect(runCreate("2027-01", true)).rejects.toThrow(/lệnh thất bại sau createPeriod/);
    expect(await count()).toBe(0);
    const period = await sql<{
      n: number;
    }>`select count(*)::int as n from billing_periods where period_start = '2027-01-01'`.execute(t.admin);
    expect(period.rows[0]?.n).toBe(0);
  });
});

describe("quyền và RLS của product_events", () => {
  it("app_runtime chỉ INSERT: SELECT/UPDATE/DELETE bị từ chối; app_worker không chạm trực tiếp", async () => {
    const id = await seedEvent(A, new Date().toISOString());
    for (const q of [
      sql`select * from product_events`,
      sql`update product_events set actor_user_id = null`,
      sql`delete from product_events`,
    ])
      await expect(withTenant(t.runtime, { orgId: A.orgId }, (trx) => q.execute(trx))).rejects.toThrow(
        /permission denied/,
      );
    for (const q of [
      sql`select * from product_events`,
      sql`insert into product_events (id, organization_id, name, schema_version) values (${randomUUID()}, ${A.orgId}, 'core_task.completed', 1)`,
      sql`update product_events set actor_user_id = null`,
      sql`delete from product_events`,
    ])
      await expect(withTenant(t.worker, { orgId: A.orgId }, (trx) => q.execute(trx))).rejects.toThrow(
        /permission denied/,
      );
    expect(await alive(id)).toBe(true);
  });

  it("RLS: tổ chức A không ghi được hàng của B (kể cả khi chọn org B trong INSERT); đọc cô lập theo tổ chức", async () => {
    await expect(
      withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
        sql`insert into product_events (id, organization_id, name, schema_version)
              values (${randomUUID()}, ${B.orgId}, 'core_task.completed', 1)`.execute(trx),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await count()).toBe(0);
    // Chính sách đọc theo tổ chức (khi sau này có đường đọc): cấp SELECT tạm thời để chứng minh policy lọc đúng, rồi thu hồi.
    await seedEvent(A, new Date().toISOString());
    await seedEvent(B, new Date().toISOString());
    await sql`grant select on product_events to app_runtime`.execute(t.admin);
    try {
      const seen = async (org: SeededOrg) =>
        withTenant(t.runtime, { orgId: org.orgId }, async (trx) =>
          (
            await sql<{ organization_id: string }>`select organization_id from product_events`.execute(trx)
          ).rows.map((r) => r.organization_id),
        );
      expect(await seen(A)).toEqual([A.orgId]);
      expect(await seen(B)).toEqual([B.orgId]);
      await expect(
        t.runtime.transaction().execute((trx) => sql`select * from product_events`.execute(trx)),
      ).rejects.toThrow(/app\.org_id chưa đặt/);
    } finally {
      await sql`revoke select on product_events from app_runtime`.execute(t.admin);
    }
  });

  it("ràng buộc: props phải là object, tên đúng dạng doi_tuong.hanh_dong, phiên bản ≥ 1", async () => {
    const ins = (name: string, version: number, props: string) =>
      sql`insert into product_events (id, organization_id, name, schema_version, props)
          values (${randomUUID()}, ${A.orgId}, ${name}, ${version}, ${props}::jsonb)`.execute(t.admin);
    await expect(ins("core_task.completed", 1, "[]")).rejects.toThrow(/check constraint/);
    await expect(ins("core_task.completed", 1, '"x"')).rejects.toThrow(/check constraint/);
    await expect(ins("Core.Task", 1, "{}")).rejects.toThrow(/check constraint/);
    await expect(ins("nodot", 1, "{}")).rejects.toThrow(/check constraint/);
    await expect(ins("core_task.completed", 0, "{}")).rejects.toThrow(/check constraint/);
    await ins("core_task.completed", 1, "{}");
    expect(await count()).toBe(1);
  });
});

describe("hạn lưu 13 tháng (RET-19) — purgeExpiredOperational / app.purge_product_events", () => {
  const purge = (now: Date, opts: { batch?: number; maxRounds?: number } = {}) =>
    purgeExpiredOperational(t.worker, { now, ...opts }).then((s) => s.productEvents);

  it("hằng số 13 tháng; quá mốc ⇒ xoá (mọi tổ chức), đúng mốc/mới hơn ⇒ giữ; chạy lại = 0", async () => {
    expect(PRODUCT_EVENTS_RETENTION_MONTHS).toBe(13);
    const now = new Date(Date.now() - 1000);
    const cutoff = (
      await sql<{ b: Date }>`select (${now}::timestamptz - make_interval(months => 13)) as b`.execute(t.admin)
    ).rows[0]?.b as Date;
    const at = (ms: number) => new Date(cutoff.getTime() + ms).toISOString();
    const old = await seedEvent(A, at(-1000));
    const oldOther = await seedEvent(B, at(-86_400_000 * 200));
    const boundary = await seedEvent(A, at(0));
    const justNewer = await seedEvent(A, at(1000));
    const recent = await seedEvent(B, new Date().toISOString());
    expect(await purge(now)).toBe(2);
    expect(await alive(old)).toBe(false);
    expect(await alive(oldOther)).toBe(false);
    for (const id of [boundary, justNewer, recent]) expect(await alive(id), id).toBe(true);
    expect(await purge(now)).toBe(0);
  });

  it("tháng LỊCH, không phải 395 ngày: mốc 2026-03-31 − 13 tháng = 2025-02-28", async () => {
    const now = new Date("2026-03-31T00:00:00.000Z");
    const before = await seedEvent(A, "2025-02-27T23:59:59.000Z"); // trước mốc ⇒ xoá
    const boundary = await seedEvent(A, "2025-02-28T00:00:00.000Z"); // đúng mốc ⇒ giữ
    const after = await seedEvent(A, "2025-02-28T12:00:00.000Z"); // 398 ngày trước — luật 395 ngày sẽ xoá nhầm; lịch thì giữ
    expect(await purge(now)).toBe(1);
    expect(await alive(before)).toBe(false);
    expect(await alive(boundary)).toBe(true);
    expect(await alive(after)).toBe(true);
  });

  it("không phụ thuộc múi giờ phiên: phiên Asia/Ho_Chi_Minh cho cùng mốc tháng như UTC", async () => {
    // p_now = 2026-03-30 20:00Z: UTC − 13 tháng = 2025-02-28 20:00Z (kẹp 30/2 → 28/2); theo giờ VN (31/3 03:00) − 13 tháng
    // = 28/2 03:00 +07 = 2025-02-27 20:00Z. Sự kiện 2025-02-28 10:00Z nằm GIỮA hai mốc.
    const pNow = "2026-03-30T20:00:00Z";
    const between = await seedEvent(A, "2025-02-28T10:00:00.000Z");
    const boundary = await seedEvent(A, "2025-02-28T20:00:00.000Z"); // đúng mốc UTC ⇒ giữ
    await t.worker.transaction().execute(async (trx) => {
      await sql`set local time zone 'Asia/Ho_Chi_Minh'`.execute(trx);
      // Đối chứng: cùng phép tính trong phiên này cho mốc theo giờ VN (test phân biệt được).
      const local = await sql<{
        b: Date;
      }>`select (${pNow}::timestamptz - make_interval(months => 13)) as b`.execute(trx);
      expect(local.rows[0]?.b.toISOString()).toBe("2025-02-27T20:00:00.000Z");
      await sql`select app.purge_product_events(${pNow}::timestamptz, 13, 1000)`.execute(trx);
    });
    expect(await alive(between)).toBe(false);
    expect(await alive(boundary)).toBe(true);
  });

  it("đồng hồ worker lệch về tương lai không xoá thêm: mốc bị chặn bởi đồng hồ CSDL", async () => {
    const nearlyDue = await seedEvent(A, new Date(Date.now() - 86_400_000 * 300).toISOString()); // ~10 tháng
    const future = new Date(Date.now() + 86_400_000 * 800);
    expect(await purge(future)).toBe(0);
    expect(await alive(nearlyDue)).toBe(true);
  });

  it("số tháng tối thiểu 1 (0/âm không xoá sạch bảng); theo lô, SKIP LOCKED", async () => {
    const fresh = await seedEvent(A, new Date(Date.now() - 86_400_000 * 10).toISOString());
    const old = await seedEvent(A, new Date(Date.now() - 86_400_000 * 40).toISOString());
    const purgeMonths = async (months: number) =>
      (
        await sql<{ n: number }>`select app.purge_product_events(now(), ${months}::int, 100) as n`.execute(
          t.worker,
        )
      ).rows[0]?.n;
    expect(await purgeMonths(0)).toBe(1); // 0 tháng ⇒ kẹp 1 tháng: hàng 40 ngày xoá, hàng 10 ngày giữ
    expect(await alive(old)).toBe(false);
    expect(await purgeMonths(-5)).toBe(0);
    expect(await alive(fresh)).toBe(true);

    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(await seedEvent(A, new Date(Date.now() - 86_400_000 * 600).toISOString()));
    expect(await purge(new Date(Date.now() - 1000), { batch: 2, maxRounds: 2 })).toBe(4);
    expect(await purge(new Date(Date.now() - 1000), { batch: 2, maxRounds: 2 })).toBe(1);
    expect(await alive(fresh)).toBe(true);
    // lô vượt trần 5000 và <1 được kẹp, không lỗi
    for (const limit of [0, -3, 1_000_000])
      await expect(
        sql`select app.purge_product_events(now(), 13, ${limit}::int)`.execute(t.worker),
      ).resolves.toBeDefined();
  });

  it("app_runtime không gọi được hàm xoá", async () => {
    await expect(
      withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
        sql`select app.purge_product_events(now(), 13, 10)`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("ngắt liên kết khi xoá tài khoản — app.unlink_product_events_actor", () => {
  it("đặt actor_user_id = NULL đúng người, mọi tổ chức; người khác và hàng không người giữ nguyên; chạy lại = 0", async () => {
    const now = new Date().toISOString();
    const a1 = await seedEvent(A, now, userA);
    const a2 = await seedEvent(B, now, userA);
    const b1 = await seedEvent(A, now, userB);
    const none = await seedEvent(A, now, null);
    const actorOf = async (id: string) =>
      (
        await sql<{
          a: string | null;
        }>`select actor_user_id as a from product_events where id = ${id}`.execute(t.admin)
      ).rows[0]?.a;
    const r = await sql<{ n: number }>`select app.unlink_product_events_actor(${userA}) as n`.execute(
      t.worker,
    );
    expect(r.rows[0]?.n).toBe(2);
    expect(await actorOf(a1)).toBeNull();
    expect(await actorOf(a2)).toBeNull();
    expect(await actorOf(b1)).toBe(userB);
    expect(await actorOf(none)).toBeNull();
    expect(
      (await sql<{ n: number }>`select app.unlink_product_events_actor(${userA}) as n`.execute(t.worker))
        .rows[0]?.n,
    ).toBe(0);
    // sự kiện vẫn còn (chỉ gỡ liên kết, không xoá số đo)
    expect(await count()).toBe(4);
  });

  it("NULL không làm gì (không gỡ nhầm hàng không người); id không có ⇒ 0; app_runtime không gọi được", async () => {
    const id = await seedEvent(A, new Date().toISOString(), userB);
    const nul = await sql<{ n: number }>`select app.unlink_product_events_actor(null) as n`.execute(t.worker);
    expect(nul.rows[0]?.n).toBe(0);
    const none = await sql<{
      n: number;
    }>`select app.unlink_product_events_actor(${randomUUID()}) as n`.execute(t.worker);
    expect(none.rows[0]?.n).toBe(0);
    expect(await alive(id)).toBe(true);
    await expect(
      withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
        sql`select app.unlink_product_events_actor(${userB})`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("xoá tài khoản (auth.user) không bị sự kiện chặn: không có khoá ngoại", async () => {
    const u = await seedAuthUser(t.admin, "xoa@example.com");
    await seedEvent(A, new Date().toISOString(), u);
    await sql`delete from auth."user" where id = ${u}`.execute(t.admin);
    expect(await count()).toBe(1);
  });
});

describe("migration 0067 — down/up", () => {
  it("đứng sau 0066; down gỡ bảng + hàm; up áp lại được", async () => {
    const keys = Object.keys(migrations);
    expect(keys.indexOf("0067_product_events")).toBe(keys.indexOf("0066_personal_data_retention") + 1);
    const m = migrations["0067_product_events"];
    if (!m) throw new Error("thiếu migration 0067_product_events");
    const own = await createTestDb();
    try {
      const state = async () =>
        (
          await sql<{ tbl: boolean; fns: number }>`
            select to_regclass('public.product_events') is not null as tbl,
                   (select count(*)::int from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                     where s.nspname = 'app' and p.proname in ('purge_product_events','unlink_product_events_actor')) as fns`.execute(
            own.admin,
          )
        ).rows[0];
      expect(await state()).toEqual({ tbl: true, fns: 2 });
      await own.admin
        .transaction()
        .execute((trx) => (m.down ? m.down(trx) : Promise.reject(new Error("thiếu down"))));
      expect(await state()).toEqual({ tbl: false, fns: 0 });
      await own.admin.transaction().execute((trx) => m.up(trx));
      expect(await state()).toEqual({ tbl: true, fns: 2 });
    } finally {
      await own.drop();
    }
  });
});
