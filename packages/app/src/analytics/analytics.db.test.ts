// T-2309 (PM-METRIC-003/005/006; D-118) — `product_events` trên Postgres thật: ghi qua track() bằng app_runtime, RLS cô lập tổ chức,
// chỉ-thêm (không UPDATE/DELETE trực tiếp), "quên" actor xuyên tổ chức, hạn 13 tháng (đúng mốc), nối vào pipeline lệnh (không nhân đôi khi replay).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type CommandDef, type HttpDeps, handleCommand, handleUserCommand } from "../http/command-route.ts";
import { USER_COMMANDS } from "../http/registry.ts";
import { PRODUCT_EVENT_RETENTION_MONTHS, purgePersonalData } from "../retention/index.ts";
import { testServices } from "../server/services.ts";
import { analyticsActorKey, pseudonymizeActor } from "./actor.ts";
import { forgetAnalyticsActor, track } from "./track.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
const KEY = analyticsActorKey("bi-mat-thu-nghiem-khong-dung-o-production-0123456789");

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS phân tích A");
  B = await seedOrg(t.admin, "KS phân tích B");
});
afterAll(async () => {
  await t?.drop();
});

const sink = () => ({ db: t.runtime, actorKey: KEY });
const rowsOf = (orgId: string) =>
  withTenant(t.runtime, { orgId }, async (trx) => {
    const r = await sql<{ event: string; props: unknown; actor_key: Buffer | null }>`
      select event, props, actor_key from product_events order by occurred_at, id`.execute(trx);
    return r.rows;
  });
const countAll = async () =>
  Number(
    (await sql<{ n: string }>`select count(*)::text as n from product_events`.execute(t.admin)).rows[0]?.n,
  );

describe("ghi qua track()", () => {
  it("ghi một hàng: sự kiện, props enum/số, actor giả danh 32 byte; không có userId thô ở đâu trong hàng", async () => {
    const user = randomUUID();
    await track(sink(), {
      event: "payment.recorded",
      orgId: A.orgId,
      userId: user,
      props: { method: "cash" },
    });
    const rows = await rowsOf(A.orgId);
    const row = rows.find((r) => r.event === "payment.recorded");
    expect(row?.props).toEqual({ method: "cash" });
    expect(row?.actor_key?.equals(pseudonymizeActor(KEY, user))).toBe(true);
    const raw = await sql<{ j: string }>`select to_jsonb(e)::text as j from product_events e`.execute(
      t.admin,
    );
    expect(raw.rows.map((r) => r.j).join("\n")).not.toContain(user);
  });

  it("sự kiện hệ thống (không userId) → actor_key NULL; số 0 và false được giữ nguyên (không thành null)", async () => {
    await track(sink(), {
      event: "lease.created",
      orgId: A.orgId,
      userId: null,
      props: { occupant_count: 0, has_end_date: false },
    });
    const row = (await rowsOf(A.orgId)).find((r) => r.event === "lease.created");
    expect(row?.actor_key).toBeNull();
    expect(row?.props).toEqual({ occupant_count: 0, has_end_date: false });
  });

  it("props sai không bao giờ xuống CSDL (ném trước khi ghi)", async () => {
    const before = await countAll();
    await expect(
      track(sink(), {
        event: "payment.recorded",
        orgId: A.orgId,
        props: { method: "a@example.test" } as never,
      }),
    ).rejects.toThrow();
    expect(await countAll()).toBe(before);
  });

  it("lỗi I/O thật (pool đã đóng) không ném", async () => {
    const dead = await createTestDb();
    const org = await seedOrg(dead.admin, "KS pool chết");
    const db = dead.runtime;
    await dead.drop();
    await expect(
      track({ db, actorKey: KEY }, { event: "billing_period.issued", orgId: org.orgId, props: {} }),
    ).resolves.toBeUndefined();
  });

  it("CSDL chặn dòng sai dạng dù app bị qua mặt: tên sự kiện sai, props không phải object, actor sai độ dài", async () => {
    const bad = (cols: ReturnType<typeof sql>) =>
      withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
        sql`insert into product_events ${cols}`.execute(trx),
      );
    await expect(
      bad(sql`(organization_id, event, props) values (${A.orgId}, 'Bad Name', '{}'::jsonb)`),
    ).rejects.toThrow();
    await expect(
      bad(sql`(organization_id, event, props) values (${A.orgId}, 'a.b', '[]'::jsonb)`),
    ).rejects.toThrow();
    await expect(
      bad(sql`(organization_id, event, actor_key) values (${A.orgId}, 'a.b', '\\x00'::bytea)`),
    ).rejects.toThrow();
  });
});

describe("RLS và quyền", () => {
  it("mỗi tổ chức chỉ thấy sự kiện của mình; không ngữ cảnh tổ chức thì không thấy gì", async () => {
    await track(sink(), {
      event: "organization.registered",
      orgId: B.orgId,
      userId: randomUUID(),
      props: {},
    });
    const a = await rowsOf(A.orgId);
    const b = await rowsOf(B.orgId);
    expect(a.length).toBeGreaterThan(0);
    expect(b.map((r) => r.event)).toEqual(["organization.registered"]);
    expect(a.map((r) => r.event)).not.toContain("organization.registered");
    // Không ngữ cảnh tổ chức: đóng kín (lỗi), không phải "thấy tất cả".
    await expect(sql`select 1 from product_events`.execute(t.runtime)).rejects.toThrow(/org_id/);
  });

  it("không ghi được hàng của tổ chức khác từ ngữ cảnh của mình (WITH CHECK)", async () => {
    await expect(
      withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
        sql`insert into product_events (organization_id, event) values (${B.orgId}, 'a.b')`.execute(trx),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("chỉ-thêm: app_runtime/app_worker không UPDATE/DELETE trực tiếp; app_runtime không gọi hàm xoá; worker không SELECT", async () => {
    for (const db of [t.runtime, t.worker]) {
      await expect(
        withTenant(db, { orgId: A.orgId }, (trx) =>
          sql`update product_events set props = '{}'::jsonb`.execute(trx),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withTenant(db, { orgId: A.orgId }, (trx) => sql`delete from product_events`.execute(trx)),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(sql`select app.purge_product_events(now(), 13, 10)`.execute(t.runtime)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      sql`select app.forget_analytics_actor(${Buffer.alloc(32)})`.execute(t.runtime),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(t.worker, { orgId: A.orgId }, (trx) =>
        sql`select count(*) from product_events`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("forgetAnalyticsActor (xoá tài khoản)", () => {
  it("xoá mọi sự kiện của đúng người ở mọi tổ chức; người khác và sự kiện hệ thống còn nguyên; chạy lại = 0", async () => {
    const me = randomUUID();
    const other = randomUUID();
    await track(sink(), { event: "stay.checked_in", orgId: A.orgId, userId: me, props: { guest_count: 2 } });
    await track(sink(), { event: "stay.checked_in", orgId: B.orgId, userId: me, props: { guest_count: 0 } });
    await track(sink(), {
      event: "stay.walked_in",
      orgId: B.orgId,
      userId: other,
      props: { guest_count: 1 },
    });
    await track(sink(), { event: "billing_period.issued", orgId: A.orgId, props: {} });
    const before = await countAll();
    expect(await forgetAnalyticsActor(t.worker, KEY, me)).toBe(2);
    expect(await countAll()).toBe(before - 2);
    const left = await sql<{ n: string }>`
      select count(*)::text as n from product_events where actor_key = ${pseudonymizeActor(KEY, me)}`.execute(
      t.admin,
    );
    expect(left.rows[0]?.n).toBe("0");
    const kept = await sql<{ n: string }>`
      select count(*)::text as n from product_events where actor_key = ${pseudonymizeActor(KEY, other)}`.execute(
      t.admin,
    );
    expect(kept.rows[0]?.n).toBe("1");
    expect(await forgetAnalyticsActor(t.worker, KEY, me)).toBe(0);
  });

  it("khoá khác (xoay bí mật) không xoá nhầm hàng của người khác; userId rỗng ném", async () => {
    const me = randomUUID();
    await track(sink(), { event: "stay.checked_in", orgId: A.orgId, userId: me, props: { guest_count: 1 } });
    expect(
      await forgetAnalyticsActor(t.worker, analyticsActorKey("khoa-khac-khoa-khac-khoa-khac-0123456789"), me),
    ).toBe(0);
    await expect(forgetAnalyticsActor(t.worker, KEY, "")).rejects.toThrow();
    expect(await forgetAnalyticsActor(t.worker, KEY, me)).toBe(1);
  });
});

describe("hạn 13 tháng (RET-19, job privacy.retention)", () => {
  const NOW = new Date(Date.now() - 1000);

  it("hằng số là 13 tháng", () => {
    expect(PRODUCT_EVENT_RETENTION_MONTHS).toBe(13);
  });

  it("quá mốc 1 ms bị xoá; ĐÚNG mốc và mới hơn còn giữ; chạy lại không làm gì thêm", async () => {
    const cut = (
      await sql<{ b: Date }>`select (${NOW}::timestamptz - make_interval(months => 13)) as b`.execute(
        t.worker,
      )
    ).rows[0]?.b as Date;
    const ids = { old: randomUUID(), exact: randomUUID(), fresh: randomUUID(), ancient: randomUUID() };
    const put = (id: string, at: Date) =>
      sql`insert into product_events (id, organization_id, event, props, occurred_at)
          values (${id}, ${A.orgId}, 'retention.probe', '{}'::jsonb, ${at.toISOString()})`.execute(t.admin);
    await put(ids.old, new Date(cut.getTime() - 1));
    await put(ids.exact, cut);
    await put(ids.fresh, new Date(cut.getTime() + 1));
    await put(ids.ancient, new Date("2020-01-01T00:00:00Z"));
    const alive = async () =>
      new Set(
        (
          await sql<{ id: string }>`select id from product_events where event = 'retention.probe'`.execute(
            t.admin,
          )
        ).rows.map((r) => r.id),
      );
    const stats = await purgePersonalData(t.worker, { now: NOW });
    expect(stats.productEvents).toBeGreaterThanOrEqual(2);
    expect(await alive()).toEqual(new Set([ids.exact, ids.fresh]));
    expect((await purgePersonalData(t.worker, { now: NOW })).productEvents).toBe(0);
  });

  it("mốc bị chặn bởi đồng hồ CSDL: now trong tương lai không xoá sự kiện còn hạn", async () => {
    const id = randomUUID();
    await sql`insert into product_events (id, organization_id, event, props, occurred_at)
              values (${id}, ${A.orgId}, 'retention.future', '{}'::jsonb, now() - interval '1 day')`.execute(
      t.admin,
    );
    await purgePersonalData(t.worker, { now: new Date(Date.now() + 5 * 365 * 86_400_000) });
    const r = await sql`select 1 from product_events where id = ${id}`.execute(t.admin);
    expect(r.rows).toHaveLength(1);
  });
});

describe("nối vào pipeline lệnh (command-route)", () => {
  let deps: HttpDeps;
  beforeAll(() => {
    deps = {
      db: t.runtime,
      getSession: async (h) => {
        const id = h.get("x-test-user");
        return id ? { user: { id, twoFactorEnabled: h.get("x-test-2fa") === "1" } } : null;
      },
      secureCookies: false,
      services: testServices(),
    };
  });

  const PAY: CommandDef<{ method: "cash" | "bank_transfer" }, { ok: true }> = {
    command: "payment.record",
    input: z.strictObject({ method: z.enum(["cash", "bank_transfer"]) }),
    run: async (ctx) => {
      await ctx.audit({ action: "test.pay", entityType: "test" });
      return { data: { ok: true } };
    },
  };
  const NOOP: CommandDef<Record<string, never>, { ok: true }> = {
    command: "member.invite",
    input: z.strictObject({}),
    run: async () => ({ data: { ok: true } }),
  };
  const req = (key: string, body: unknown) =>
    new Request("http://local.test/api/v1/x/y", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-test-user": A.ownerAuthUserId,
        "x-test-2fa": "1",
        "x-org-id": A.orgId,
      },
      body: JSON.stringify(body),
    });
  const probe = async () =>
    (
      await sql<{ n: string }>`
        select count(*)::text as n from product_events
        where organization_id = ${A.orgId} and event = 'payment.recorded' and props = '{"method": "bank_transfer"}'::jsonb`.execute(
        t.admin,
      )
    ).rows[0]?.n;

  it("lệnh commit → đúng một sự kiện; replay cùng Idempotency-Key không ghi thêm; lệnh bị từ chối không ghi", async () => {
    const before = Number(await probe());
    const key = randomUUID();
    expect((await handleCommand(PAY, req(key, { method: "bank_transfer" }), deps)).status).toBe(200);
    expect(Number(await probe())).toBe(before + 1);
    const replay = await handleCommand(PAY, req(key, { method: "bank_transfer" }), deps);
    expect(replay.status).toBe(200);
    expect(Number(await probe())).toBe(before + 1);
    const invalid = await handleCommand(PAY, req(randomUUID(), { method: "crypto" }), deps);
    expect(invalid.status).toBe(422);
    expect(Number(await probe())).toBe(before + 1);
  });

  it("lệnh không có trong bảng ánh xạ không ghi sự kiện", async () => {
    const before = await countAll();
    expect((await handleCommand(NOOP, req(randomUUID(), {}), deps)).status).toBe(200);
    expect(await countAll()).toBe(before);
  });

  it("ghi sự kiện hỏng (bảng không ghi được) không làm hỏng lệnh đã commit", async () => {
    const broken: HttpDeps = { ...deps, db: t.runtime };
    // Mô phỏng I/O lỗi bằng vai trò không có quyền: đổi tên bảng tạm thời.
    await sql`alter table product_events rename to product_events_off`.execute(t.admin);
    try {
      const res = await handleCommand(PAY, req(randomUUID(), { method: "cash" }), broken);
      expect(res.status).toBe(200);
    } finally {
      await sql`alter table product_events_off rename to product_events`.execute(t.admin);
    }
  });

  it("org.create (lệnh cấp người dùng) ghi organization.registered cho tổ chức mới, actor giả danh của người tạo", async () => {
    const user = await seedAuthUser(t.admin, `chu-${randomUUID()}@example.test`);
    const def = USER_COMMANDS["org.create"];
    if (!def) throw new Error("thiếu org.create");
    const res = await handleUserCommand(
      def,
      new Request("http://local.test/api/v1/org/create", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": randomUUID(), "x-test-user": user },
        body: JSON.stringify({ name: "Nhà nghỉ mới" }),
      }),
      deps,
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { organizationId: string } };
    const rows = await rowsOf(data.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe("organization.registered");
    expect(
      rows[0]?.actor_key?.equals(
        pseudonymizeActor(analyticsActorKey("khoa-thu-nghiem-khong-dung-o-production-0123456789"), user),
      ),
    ).toBe(true);
  });
});
