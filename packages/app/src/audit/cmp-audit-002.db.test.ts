// CMP-AUDIT-002 (T-2313; NĐ 333/2026 Đ.22–23; PCI DSS v4.0.1 Req. 10): MỖI hành động nhạy cảm trong phạm vi app sinh một dòng
// `audit_events` đủ trường who / what / target / when (UTC) / where (ip/ua) / result / reason. Duyệt: đăng nhập (người dùng thường +
// hỗ trợ nền tảng), đổi quyền thành viên (thành công + lần thử bị từ chối), xuất dữ liệu (yêu cầu + tải), cấp/thu hồi truy cập hỗ
// trợ, hành động của hỗ trợ (xem dữ liệu, lệnh ghi bị từ chối). Ngoài phạm vi app (ghi ở báo cáo T-2313): triển khai (CI/CD),
// DSAR (module privacy — task khác), cấu hình hạ tầng.
// Append-only của bảng có test riêng (pipeline/audit-source); ở đây kiểm thêm: dòng đã ghi không sửa/xoá được.
import { randomUUID } from "node:crypto";
import { seedAuthUser, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { resolveActor } from "../access/actor.ts";
import { updateMemberRole } from "../access/members.ts";
import { grantSupportAccess, recordSupportAccess, revokeSupportAccess } from "../access/support.ts";
import { createAuthEvents } from "../auth/auth-events.ts";
import { downloadExport, requestExport, runExportJob } from "../exports/exports.ts";
import { ObjectStorage } from "../files/storage.ts";
import { type CommandContext, executeCommand } from "../pipeline/command.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";

let h: Hotel;
let pool: pg.Pool;
let storage: ObjectStorage;
const CLIENT = { ip: "203.0.113.77", userAgent: "Mozilla/5.0 CmpAudit/1.0" };
const IP_CUT = "203.0.113.0";

interface Row {
  occurred_at_utc: string;
  actor_type: string;
  actor_person_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  after: Record<string, unknown> | null;
  source_ip: string | null;
  user_agent: string | null;
  outcome: string;
  reason: string | null;
  support_grant_id: string | null;
}

/** Chạy một lệnh qua pipeline thật với IP/UA của request. */
async function run<T>(actor: Actor, fn: (ctx: CommandContext) => Promise<T>, correlationId = randomUUID()) {
  const r = await executeCommand(
    h.t.runtime,
    actor,
    {
      command: "test.command",
      idempotencyKey: randomUUID(),
      payload: { n: randomUUID() },
      correlationId,
      client: CLIENT,
    },
    async (ctx) => ({ data: await fn(ctx) }),
  );
  return { r, correlationId };
}

async function rows(where: ReturnType<typeof sql>): Promise<Row[]> {
  return (
    await sql<Row>`
      select to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at_utc, actor_type,
             actor_person_id, action, entity_type, entity_id, after, source_ip, user_agent, outcome, reason, support_grant_id
      from audit_events where organization_id = ${h.org.orgId} and ${where} order by created_at, id`.execute(
      h.t.admin,
    )
  ).rows;
}

/** Đủ 7 trường của CMP-AUDIT-002; `when` là tức thời UTC trong khoảng [t0, bây giờ]. */
function expectComplete(r: Row | undefined, t0: Date, extra: Partial<Row> = {}): void {
  expect(r, "phải có dòng audit").toBeDefined();
  if (!r) return;
  // who
  expect(["user", "platform_support"]).toContain(r.actor_type);
  expect(r.actor_person_id).toMatch(/^[0-9a-f-]{36}$/);
  // what
  expect(r.action).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
  // target: loại + mã (hoặc tài nguyên đã xem với `support.accessed`)
  expect(r.entity_type.length).toBeGreaterThan(0);
  expect(r.entity_id ?? (r.after?.resource as string | undefined)).toBeTruthy();
  // when (UTC)
  expect(r.occurred_at_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  const at = Date.parse(r.occurred_at_utc);
  expect(at).toBeGreaterThanOrEqual(t0.getTime() - 1_000);
  expect(at).toBeLessThanOrEqual(Date.now() + 1_000);
  // where
  expect(r.source_ip).toBe(IP_CUT);
  expect(r.user_agent).toBe(CLIENT.userAgent);
  // result
  expect(["success", "denied"]).toContain(r.outcome);
  // reason
  expect(r.reason?.trim().length ?? 0).toBeGreaterThan(0);
  // hỗ trợ ⇒ có tham chiếu grant; người khác ⇒ không
  if (r.actor_type === "platform_support") expect(r.support_grant_id).toMatch(/^[0-9a-f-]{36}$/);
  else expect(r.support_grant_id).toBeNull();
  expect(r).toMatchObject(extra);
}

let supportUid: string;
let supportEmail: string;

beforeAll(async () => {
  h = await seedHotel();
  pool = new pg.Pool({ connectionString: h.t.runtimeUrl, max: 2 });
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  supportEmail = `ho.tro+${randomUUID().slice(0, 8)}@example.test`;
  supportUid = await seedAuthUser(h.t.admin, supportEmail);
  await sql`insert into platform_support_users (auth_user_id) values (${supportUid})`.execute(h.t.admin);
});
afterAll(async () => {
  await pool?.end();
  await h?.t.drop();
});

describe("CMP-AUDIT-002 — mỗi hành động nhạy cảm sinh sự kiện đủ trường", () => {
  it("đăng nhập (auth.login) của người dùng tổ chức", async () => {
    const t0 = new Date();
    const correlationId = `login-${randomUUID()}`;
    await createAuthEvents(pool).record({
      event: "auth.login",
      outcome: "success",
      userId: h.owner.authUserId,
      reason: "password",
      client: CLIENT,
      correlationId,
      audit: true,
    });
    const [r] = await rows(sql`correlation_id = ${correlationId}`);
    expectComplete(r, t0, {
      action: "auth.login",
      actor_type: "user",
      actor_person_id: h.owner.personId,
      entity_type: "membership",
      entity_id: h.owner.membershipId,
      outcome: "success",
      reason: "password",
    });
  });

  it("đổi quyền thành viên: thành công (member.role_changed, lý do người nhập) và lần thử bị từ chối (command.denied)", async () => {
    const t0 = new Date();
    const ok = await run(h.owner, (ctx) =>
      updateMemberRole(ctx, {
        membershipId: h.frontDesk2.membershipId,
        role: "housekeeping",
        reason: "Đổi ca làm",
      }),
    );
    expect(ok.r.status).toBe("committed");
    const [changed] = await rows(
      sql`correlation_id = ${ok.correlationId} and action = 'member.role_changed'`,
    );
    expectComplete(changed, t0, {
      actor_person_id: h.owner.personId,
      entity_type: "membership",
      entity_id: h.frontDesk2.membershipId,
      outcome: "success",
      reason: "Đổi ca làm",
    });
    const no = await run(h.manager, (ctx) =>
      updateMemberRole(ctx, { membershipId: h.frontDesk.membershipId, role: "owner", reason: "tự nâng" }),
    );
    expect(no.r.status).toBe("failed");
    const denied = await rows(sql`correlation_id = ${no.correlationId}`);
    expectComplete(
      denied.find((x) => x.action === "member.role_change_denied"),
      t0,
      { actor_person_id: h.manager.personId, entity_id: h.frontDesk.membershipId, reason: "FORBIDDEN" },
    );
    expect(denied.find((x) => x.action === "command.denied")).toMatchObject({
      outcome: "denied",
      reason: "FORBIDDEN",
    });
  });

  it("xuất dữ liệu: yêu cầu (export.requested) và tải (export.downloaded) — lý do = loại dữ liệu xuất", async () => {
    const t0 = new Date();
    const owner = { ...h.owner, authenticatedAt: new Date() };
    const req = await run(owner, (ctx) => requestExport(ctx, { kind: "receivables", format: "csv" }));
    expect(req.r.status).toBe("committed");
    const exportId = (req.r.status === "committed" ? req.r.data : { exportId: "" }).exportId;
    const deps = { db: h.t.runtime, workerDb: h.t.worker, storage };
    expect(await runExportJob(deps, { organization_id: h.org.orgId, payload: { export_id: exportId } })).toBe(
      "ready",
    );
    const dl = await run(owner, (ctx) => downloadExport(ctx, deps, { exportId }));
    expect(dl.r.status).toBe("committed");
    for (const [action, correlationId] of [
      ["export.requested", req.correlationId],
      ["export.downloaded", dl.correlationId],
    ] as const) {
      const [r] = await rows(sql`correlation_id = ${correlationId} and action = ${action}`);
      expectComplete(r, t0, {
        actor_person_id: h.owner.personId,
        entity_type: "export_job",
        entity_id: exportId,
        outcome: "success",
        reason: "export:receivables",
      });
    }
  });

  it("cấp/thu hồi truy cập hỗ trợ + mọi hành động của hỗ trợ (đăng nhập, xem dữ liệu, lệnh ghi bị từ chối) có grant + lý do", async () => {
    const t0 = new Date();
    const g = await run(h.owner, (ctx) =>
      grantSupportAccess(ctx, { email: supportEmail, hours: 2, reason: "Ticket #7: lỗi hiển thị lịch" }),
    );
    expect(g.r.status).toBe("committed");
    const grantId = (g.r.status === "committed" ? g.r.data : { grantId: "" }).grantId;
    const [granted] = await rows(
      sql`correlation_id = ${g.correlationId} and action = 'support.access_granted'`,
    );
    expectComplete(granted, t0, {
      actor_type: "user",
      actor_person_id: h.owner.personId,
      entity_type: "support_grant",
      entity_id: grantId,
      reason: "Ticket #7: lỗi hiển thị lịch",
    });

    const support = await resolveActor(h.t.runtime, {
      authUserId: supportUid,
      orgId: h.org.orgId,
      twoFactorEnabled: true,
    });
    // Hỗ trợ đăng nhập ⇒ ghi ở tổ chức đang cấp quyền với nguồn platform_support + grant.
    const loginCorr = `login-${randomUUID()}`;
    await createAuthEvents(pool).record({
      event: "auth.login",
      outcome: "success",
      userId: supportUid,
      reason: "mfa",
      client: CLIENT,
      correlationId: loginCorr,
      audit: true,
    });
    const [login] = await rows(sql`correlation_id = ${loginCorr}`);
    expectComplete(login, t0, {
      action: "auth.login",
      actor_type: "platform_support",
      actor_person_id: support.personId,
      support_grant_id: grantId,
      reason: "mfa",
    });

    const viewCorr = `view-${randomUUID()}`;
    await recordSupportAccess(h.t.runtime, support, {
      resource: "inventory.getCalendar",
      client: CLIENT,
      correlationId: viewCorr,
    });
    const [view] = await rows(sql`correlation_id = ${viewCorr}`);
    expectComplete(view, t0, {
      action: "support.accessed",
      actor_type: "platform_support",
      support_grant_id: grantId,
      reason: "Ticket #7: lỗi hiển thị lịch",
      outcome: "success",
    });
    expect(view?.after).toEqual({ resource: "inventory.getCalendar" });

    const write = await run(support, async () => ({ wrote: true }));
    expect(write.r).toMatchObject({ status: "failed", httpStatus: 403 });
    const [deniedRow] = await rows(sql`correlation_id = ${write.correlationId}`);
    // Lệnh bị từ chối: target = tên lệnh (entity_type), không có id; mọi trường khác đủ.
    expect(deniedRow).toMatchObject({
      action: "command.denied",
      actor_type: "platform_support",
      actor_person_id: support.personId,
      entity_type: "test.command",
      support_grant_id: grantId,
      source_ip: IP_CUT,
      user_agent: CLIENT.userAgent,
      outcome: "denied",
      reason: "FORBIDDEN",
    });

    const rv = await run(h.owner, (ctx) =>
      revokeSupportAccess(ctx, { grantId, reason: "Đã xử lý xong ticket #7" }),
    );
    expect(rv.r.status).toBe("committed");
    const [revoked] = await rows(
      sql`correlation_id = ${rv.correlationId} and action = 'support.access_revoked'`,
    );
    expectComplete(revoked, t0, {
      actor_person_id: h.owner.personId,
      entity_type: "support_grant",
      entity_id: grantId,
      reason: "Đã xử lý xong ticket #7",
    });
  });

  it("dòng audit đã ghi không sửa/xoá được (append-only) — kể cả cột tham chiếu grant", async () => {
    await expect(sql`update audit_events set support_grant_id = null`.execute(h.t.admin)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`delete from audit_events`.execute(h.t.admin)).rejects.toThrow(/append-only/);
  });
});
