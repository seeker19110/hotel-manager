// T-2313 (IND-SAAS-009; D-122) — màn nhật ký hoạt động trên Postgres thật: lọc khoảng thời gian UTC (biên [from, to)), người thực hiện,
// loại hành động, nguồn (hỗ trợ nền tảng — kèm lý do của grant); phân trang con trỏ ổn định khi trùng thời điểm; RLS theo tổ chức và
// vai trò (lễ tân/buồng phòng 403, tổ chức khác không thấy); xuất CSV nhật ký qua cơ chế exports (lọc giống màn, chống công thức).
import { randomUUID } from "node:crypto";
import { seedAuthUser, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { resolveActor } from "../access/actor.ts";
import { grantSupportAccess, recordSupportAccess } from "../access/support.ts";
import { downloadExport, requestExport, runExportJob } from "../exports/exports.ts";
import { ObjectStorage } from "../files/storage.ts";
import { codeOf, okAs, runAs } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { listAuditActions, listAuditActors, listEvents } from "./events.ts";

let h: Hotel;
let storage: ObjectStorage;
let support: Actor;
let grantId: string;
const fresh = (a: Actor): Actor => ({ ...a, authenticatedAt: new Date() });
const D1 = new Date("2026-10-01T00:00:00.000Z");
const D2 = new Date("2026-10-02T00:00:00.000Z");

async function event(
  at: string,
  action: string,
  actor: Actor | null,
  opts: { orgId?: string; reason?: string; propertyId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await sql`insert into audit_events (id, organization_id, property_id, occurred_at, actor_type, actor_person_id, action, entity_type,
                                      entity_id, reason, correlation_id, source_ip, user_agent)
            values (${id}, ${opts.orgId ?? h.org.orgId}, ${opts.propertyId ?? null}, ${at}::timestamptz,
                    ${actor ? "user" : "worker"}, ${actor?.personId ?? null}, ${action}, 'test', ${randomUUID()},
                    ${opts.reason ?? null}, 'seed', '203.0.113.0', 'Seed/1.0')`.execute(h.t.admin);
  return id;
}

const ids = (r: { items: { id: string }[] }) => r.items.map((x) => x.id);

beforeAll(async () => {
  h = await seedHotel();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  // Hỗ trợ nền tảng có grant còn hiệu lực + một lần xem dữ liệu.
  const email = `ho.tro+${randomUUID().slice(0, 8)}@example.test`;
  const uid = await seedAuthUser(h.t.admin, email);
  await sql`insert into platform_support_users (auth_user_id) values (${uid})`.execute(h.t.admin);
  const g = await okAs(h.t, h.owner, (ctx) =>
    grantSupportAccess(ctx, { email, hours: 3, reason: "Kiểm tra báo cáo theo yêu cầu chủ" }),
  );
  grantId = g.grantId;
  support = await resolveActor(h.t.runtime, { authUserId: uid, orgId: h.org.orgId, twoFactorEnabled: true });
  await recordSupportAccess(h.t.runtime, support, {
    resource: "inventory.listRooms",
    client: { ip: "192.0.2.10", userAgent: "Support/2" },
  });
});
afterAll(async () => {
  await h?.t.drop();
});

describe("lọc theo khoảng thời gian UTC — biên [from, to)", () => {
  it("đúng mốc from được lấy; đúng mốc to bị loại; múi giờ của phiên CSDL không ảnh hưởng", async () => {
    const e1 = await event("2026-10-01T00:00:00.000Z", "test.window", h.owner);
    const e2 = await event("2026-10-01T23:59:59.999999Z", "test.window", h.owner);
    const e3 = await event("2026-10-02T00:00:00.000Z", "test.window", h.owner);
    await event("2026-09-30T23:59:59.999999Z", "test.window", h.owner);
    const r = await listEvents(h.t.runtime, h.owner, { from: D1, to: D2, action: "test.window" });
    expect(ids(r)).toEqual([e2, e1]);
    expect(ids(r)).not.toContain(e3);
    // Ngày "2026-10-01" theo giờ VN (+07:00) là khoảng khác — màn lọc theo UTC nên dữ liệu giữ nguyên tức thời.
    expect(r.items[1]?.occurredAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("from > to, ngày không hợp lệ, nguồn lạ ⇒ 422", async () => {
    await expect(listEvents(h.t.runtime, h.owner, { from: D2, to: D1 })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(listEvents(h.t.runtime, h.owner, { from: new Date("x") })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(listEvents(h.t.runtime, h.owner, { actorType: "admin" as never })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("lọc theo người thực hiện / loại hành động / nguồn hỗ trợ", () => {
  it("người + hành động: chỉ đúng hàng khớp cả hai", async () => {
    const a = await event("2026-10-03T01:00:00Z", "test.who", h.owner);
    await event("2026-10-03T01:00:01Z", "test.who", h.manager);
    await event("2026-10-03T01:00:02Z", "test.other", h.owner);
    const r = await listEvents(h.t.runtime, h.owner, { actorPersonId: h.owner.personId, action: "test.who" });
    expect(ids(r)).toEqual([a]);
  });

  it("nguồn platform_support: chỉ hành động của hỗ trợ, có tham chiếu grant + lý do (tenant thấy rõ)", async () => {
    const r = await listEvents(h.t.runtime, h.owner, { actorType: "platform_support" });
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    for (const e of r.items) {
      expect(e.actorType).toBe("platform_support");
      expect(e.supportGrantId).toBe(grantId);
      expect(e.supportReason).toBe("Kiểm tra báo cáo theo yêu cầu chủ");
    }
    expect(r.items.map((e) => e.action)).toContain("support.accessed");
    // Quản lý (cũng là admin tổ chức) thấy được hành động hỗ trợ cấp tổ chức? — không: RLS 0042 chỉ cho quản lý thấy sự kiện cấp
    // tổ chức do chính họ làm; chủ là người cấp/thu hồi nên luôn thấy.
    const m = await listEvents(h.t.runtime, h.manager, { actorType: "platform_support" });
    expect(m.items).toEqual([]);
  });

  it("danh sách lựa chọn bộ lọc: hành động + người (kể cả hỗ trợ) theo quyền; kế toán chỉ nhóm tiền", async () => {
    await event("2026-10-03T02:00:00Z", "payment.recorded", h.owner);
    const acts = await listAuditActions(h.t.runtime, h.owner);
    expect(acts).toEqual(expect.arrayContaining(["support.accessed", "support.access_granted", "test.who"]));
    expect([...acts].sort()).toEqual(acts);
    const people = await listAuditActors(h.t.runtime, h.owner);
    expect(people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ personId: support.personId, actorType: "platform_support" }),
        expect.objectContaining({ personId: h.owner.personId }),
      ]),
    );
    const accActs = await listAuditActions(h.t.runtime, h.accountant);
    expect(accActs).toContain("payment.recorded");
    expect(accActs).not.toContain("test.who");
    await expect(listAuditActions(h.t.runtime, h.frontDesk)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listAuditActors(h.t.runtime, h.housekeeping)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("phân trang con trỏ", () => {
  it("120 sự kiện CÙNG thời điểm: duyệt hết bằng con trỏ, không lặp, không sót, đúng thứ tự (occurred_at, id) giảm dần", async () => {
    const at = "2026-10-04T05:00:00.123456Z";
    const want = new Set<string>();
    for (let i = 0; i < 120; i++) want.add(await event(at, "test.page", h.owner));
    const got: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await listEvents(h.t.runtime, h.owner, {
        action: "test.page",
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      got.push(...ids(r));
      cursor = r.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(got).toHaveLength(120);
    expect(new Set(got)).toEqual(want);
    expect(got).toEqual([...got].sort().reverse());
  });

  it("con trỏ hỏng ⇒ 422", async () => {
    await expect(listEvents(h.t.runtime, h.owner, { cursor: "khong-phai-con-tro" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("quyền + RLS", () => {
  it("lễ tân/buồng phòng ⇒ 403; tổ chức khác không thấy sự kiện của A (và ngược lại)", async () => {
    await expect(listEvents(h.t.runtime, h.frontDesk)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listEvents(h.t.runtime, h.housekeeping)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const bOnly = await event("2026-10-05T00:00:00Z", "test.cross", h.ownerOther, { orgId: h.other.orgId });
    const a = await listEvents(h.t.runtime, h.owner, { action: "test.cross" });
    expect(ids(a)).toEqual([]);
    const b = await listEvents(h.t.runtime, h.ownerOther, { action: "test.cross" });
    expect(ids(b)).toEqual([bOnly]);
    const bAll = await listEvents(h.t.runtime, h.ownerOther, { limit: 200 });
    expect(bAll.items.some((e) => e.supportGrantId === grantId)).toBe(false);
  });
});

describe("xuất CSV nhật ký qua exports (chỉ owner)", () => {
  const text = async (url: string) =>
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      new Uint8Array(await (await fetch(url)).arrayBuffer()),
    );

  it("bộ lọc giống màn (khoảng UTC + hành động + người) ⇒ file chỉ có hàng khớp; ô công thức được vô hiệu", async () => {
    await event("2026-10-06T10:00:00Z", "test.export", h.owner, { reason: '=HYPERLINK("http://x","bấm")' });
    await event("2026-10-06T11:00:00Z", "test.export", h.manager, { reason: "của quản lý" });
    await event("2026-10-07T00:00:00Z", "test.export", h.owner, { reason: "ngoài khoảng" });
    const owner = fresh(h.owner);
    const q = await okAs(h.t, owner, (ctx) =>
      requestExport(ctx, {
        kind: "audit",
        format: "csv",
        filters: {
          fromAt: "2026-10-06T00:00:00Z",
          toAt: "2026-10-07T00:00:00Z",
          action: "test.export",
          actorPersonId: h.owner.personId,
        },
      }),
    );
    const deps = { db: h.t.runtime, workerDb: h.t.worker, storage };
    expect(
      await runExportJob(deps, { organization_id: h.org.orgId, payload: { export_id: q.exportId } }),
    ).toBe("ready");
    const d = await okAs(h.t, owner, (ctx) => downloadExport(ctx, deps, { exportId: q.exportId }));
    const csv = await text(d.url);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2); // tiêu đề + đúng 1 hàng
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""bấm"")"`);
    expect(csv).not.toContain("của quản lý");
    expect(csv).not.toContain("ngoài khoảng");
    const job = await sql<{
      filters: Record<string, string>;
    }>`select filters from export_jobs where id = ${q.exportId}`.execute(h.t.admin);
    expect(job.rows[0]?.filters).toEqual({
      from_at: "2026-10-06T00:00:00.000Z",
      to_at: "2026-10-07T00:00:00.000Z",
      action: "test.export",
      actor_person_id: h.owner.personId,
    });
  });

  it("nguồn hỗ trợ: cột nguồn + mã grant — lý do có trong file", async () => {
    const owner = fresh(h.owner);
    const now = new Date();
    const q = await okAs(h.t, owner, (ctx) =>
      requestExport(ctx, {
        kind: "audit",
        format: "csv",
        filters: {
          fromAt: new Date(now.getTime() - 86_400_000).toISOString(),
          toAt: new Date(now.getTime() + 60_000).toISOString(),
          actorType: "platform_support",
        },
      }),
    );
    const deps = { db: h.t.runtime, workerDb: h.t.worker, storage };
    expect(
      await runExportJob(deps, { organization_id: h.org.orgId, payload: { export_id: q.exportId } }),
    ).toBe("ready");
    const d = await okAs(h.t, owner, (ctx) => downloadExport(ctx, deps, { exportId: q.exportId }));
    const csv = await text(d.url);
    expect(csv).toContain("support.accessed");
    expect(csv).toContain("platform_support");
    expect(csv).toContain(`${grantId} — Kiểm tra báo cáo theo yêu cầu chủ`);
  });

  it("từ chối: quản lý/kế toán ⇒ 403; from_at thiếu to_at / sai / ngược ⇒ 422; quá 366 ngày ⇒ REPORT_RANGE_TOO_LARGE", async () => {
    const f = { fromAt: "2026-10-01T00:00:00Z", toAt: "2026-10-02T00:00:00Z" };
    expect(
      await codeOf(
        runAs(h.t, fresh(h.manager), (ctx) =>
          requestExport(ctx, { kind: "audit", format: "csv", filters: f }),
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        runAs(h.t, fresh(h.accountant), (ctx) =>
          requestExport(ctx, { kind: "audit", format: "csv", filters: f }),
        ),
      ),
    ).toBe("FORBIDDEN");
    for (const filters of [
      { fromAt: "2026-10-01T00:00:00Z" },
      { fromAt: "x", toAt: "2026-10-02T00:00:00Z" },
      { fromAt: "2026-10-02T00:00:00Z", toAt: "2026-10-01T00:00:00Z" },
      { ...f, actorPersonId: "khong-phai-uuid" },
      { ...f, action: "DROP TABLE" },
      { ...f, actorType: "root" as never },
    ])
      expect(
        await codeOf(
          runAs(h.t, fresh(h.owner), (ctx) => requestExport(ctx, { kind: "audit", format: "csv", filters })),
        ),
      ).toBe("VALIDATION_FAILED");
    expect(
      await codeOf(
        runAs(h.t, fresh(h.owner), (ctx) =>
          requestExport(ctx, {
            kind: "audit",
            format: "csv",
            filters: { fromAt: "2025-01-01T00:00:00Z", toAt: "2026-01-03T00:00:00Z" },
          }),
        ),
      ),
    ).toBe("REPORT_RANGE_TOO_LARGE");
  });
});

describe("schema dùng chung của form xuất khớp danh mục server", () => {
  it("`exports.request` (command-inputs) liệt kê đúng EXPORT_KINDS và AUDIT_ACTOR_TYPES", async () => {
    const { COMMAND_INPUTS } = await import("../http/command-inputs.ts");
    const { EXPORT_KINDS } = await import("../exports/exports.ts");
    const { AUDIT_ACTOR_TYPES } = await import("./events.ts");
    const s = COMMAND_INPUTS["exports.request"];
    for (const kind of EXPORT_KINDS) expect(s.safeParse({ kind, format: "csv" }).success, kind).toBe(true);
    expect(s.safeParse({ kind: "org_full", format: "csv" }).success).toBe(false);
    for (const actor_type of AUDIT_ACTOR_TYPES)
      expect(s.safeParse({ kind: "audit", format: "csv", filters: { actor_type } }).success, actor_type).toBe(
        true,
      );
  });
});
