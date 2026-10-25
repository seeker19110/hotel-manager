// Truy cập hỗ trợ có thời hạn (F-015; T-2313, D-122; IND-SAAS-009, CMP-AUDIT-002; TM-12).
// - `support.grantAccess` (owner — `support.grant`): cấp cho đúng một nhân viên hỗ trợ NỀN TẢNG (`platform_support_users`, tra theo email
//   đã xác minh qua `app.platform_support_lookup`), có lý do (1…500 ký tự) và hạn 1…72 giờ (CHECK ở CSDL: ≤ granted_at + 72 giờ).
//   Tạo membership `platform_support` (valid_to = hạn; phạm vi = mọi cơ sở chưa lưu trữ lúc cấp) + hàng `support_grants` + audit
//   `support.access_granted` + outbox + sự kiện bảo mật — cùng transaction. Người đó đang là thành viên khác của tổ chức, hoặc đang có
//   truy cập hỗ trợ còn hạn ⇒ 409; hai lần cấp song song cho cùng người ⇒ khoá advisory theo (tổ chức, người) — bên sau thấy bên trước.
// - `support.revokeAccess` (owner): thu hồi một bước — đặt `revoked_at/by` (trigger cho đặt đúng một lần) + membership `revoked` ⇒
//   request kế tiếp của hỗ trợ không còn actor (404). Đã thu hồi ⇒ 409.
// - `support.listGrants` (vai trò có `audit.read`): danh sách grant (đang hiệu lực/đã hết hạn/đã thu hồi, trạng thái tính theo giờ CSDL).
// - `recordSupportAccess`: mỗi lần hỗ trợ MỞ một trang/gọi một truy vấn ⇒ một dòng audit `support.accessed` (`actor_type =
//   platform_support`, `support_grant_id`, lý do của grant, IP/UA) — chủ tổ chức thấy ở /nhat-ky (lọc "Hỗ trợ nền tảng").
// Quyền đọc của hỗ trợ: `SUPPORT_READ_ACTIONS` (domain); mọi lệnh ghi bị pipeline từ chối; CSDL chặn ghi (migration 0071).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../actor-core/index.ts";
import { t } from "../i18n.ts";
import { auditSource, type SecurityClient } from "../logging/index.ts";
import { type CommandContext, CommandError, fieldError } from "../pipeline/index.ts";
import { authorizeOrAudit } from "./denied.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trần thời hạn truy cập hỗ trợ (giờ) — trùng CHECK `ck_support_grants_ttl` của CSDL (D-122). */
export const SUPPORT_GRANT_MAX_HOURS = 72;
/** Lý do mặc định (mã) khi chủ thu hồi một bước không ghi lý do. */
export const SUPPORT_REVOKE_DEFAULT_REASON = "revoked_by_owner";

function cleanReason(reason: string): string {
  const r = reason.normalize("NFC").trim();
  if (!r || r.length > 500) throw fieldError("reason", "REQUIRED", t("support.reason_invalid"));
  return r;
}

export async function grantSupportAccess(
  ctx: CommandContext,
  input: { email: string; hours: number; reason: string },
): Promise<{ grantId: string; membershipId: string; expiresAt: string }> {
  authorizeOrAudit(() => authorize(ctx.actor, "support.grant"), {
    action: "support.grant_denied",
    entityType: "support_grant",
    after: { hours: input.hours },
  });
  if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > SUPPORT_GRANT_MAX_HOURS)
    throw fieldError("hours", "out_of_range", t("support.hours_invalid", { max: SUPPORT_GRANT_MAX_HOURS }));
  const reason = cleanReason(input.reason);
  const orgId = ctx.actor.orgId;

  const found = await sql<{ auth_user_id: string; full_name: string; email: string }>`
    select auth_user_id, full_name, email from app.platform_support_lookup(${input.email})`.execute(ctx.trx);
  const user = found.rows[0];
  if (!user) throw fieldError("email", "not_platform_support", t("support.grantee_not_found"));

  // Hai lần cấp song song cho cùng người: tuần tự hoá theo (tổ chức, người) — bên sau thấy membership bên trước vừa tạo.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`support-grant:${orgId}:${user.auth_user_id}`}, 0))`.execute(
    ctx.trx,
  );
  const existing = await sql<{ id: string; role: string; person_id: string; live: boolean }>`
    select id, role, person_id, (valid_to is null or valid_to > now()) as live from memberships
    where organization_id = ${orgId} and auth_user_id = ${user.auth_user_id} and status <> 'revoked'
    for update`.execute(ctx.trx);
  for (const m of existing.rows) {
    if (m.role !== "platform_support")
      throw new CommandError("INVALID_TRANSITION", 409, t("support.grantee_is_member"));
    if (m.live) throw new CommandError("INVALID_TRANSITION", 409, t("support.grant_active"));
  }
  // Membership hỗ trợ đã hết hạn còn ở trạng thái active ⇒ đóng hẳn trước khi cấp lần mới (unique membership theo người dùng).
  if (existing.rows.length > 0)
    await sql`update memberships set status = 'revoked', revoked_at = now()
              where organization_id = ${orgId} and id = any(${existing.rows.map((m) => m.id)}::uuid[])`.execute(
      ctx.trx,
    );

  const prior = await sql<{ person_id: string }>`
    select person_id from memberships
    where organization_id = ${orgId} and auth_user_id = ${user.auth_user_id} and role = 'platform_support'
    order by created_at desc, id desc limit 1`.execute(ctx.trx);
  let personId = prior.rows[0]?.person_id;
  if (!personId) {
    personId = randomUUID();
    await sql`insert into persons (id, organization_id, full_name, email)
              values (${personId}, ${orgId}, ${user.full_name.trim().slice(0, 200) || user.email}, ${user.email})`.execute(
      ctx.trx,
    );
  }

  const membershipId = randomUUID();
  const grantId = randomUUID();
  const exp = await sql<{ expires_at: Date }>`
    select now() + make_interval(hours => ${input.hours}) as expires_at`.execute(ctx.trx);
  const expiresAt = exp.rows[0]?.expires_at as Date;
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, valid_to)
            values (${membershipId}, ${orgId}, ${user.auth_user_id}, ${personId}, 'platform_support', ${expiresAt})`.execute(
    ctx.trx,
  );
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            select gen_random_uuid(), p.organization_id, ${membershipId}, p.id from properties p
            where p.organization_id = ${orgId} and p.archived_at is null`.execute(ctx.trx);
  await sql`insert into support_grants (id, organization_id, grantee_membership_id, granted_by, reason, expires_at)
            values (${grantId}, ${orgId}, ${membershipId}, ${ctx.actor.membershipId}, ${reason}, ${expiresAt})`.execute(
    ctx.trx,
  );
  await ctx.audit({
    action: "support.access_granted",
    entityType: "support_grant",
    entityId: grantId,
    after: { grantee_membership_id: membershipId, hours: input.hours, expires_at: expiresAt.toISOString() },
    reason,
  });
  await ctx.emit({
    eventType: "support.access_granted",
    aggregateType: "support_grant",
    aggregateId: grantId,
    payload: { support_grant_id: grantId, membership_id: membershipId },
  });
  ctx.security({ event: "support.access_granted", target: { type: "support_grant", id: grantId } });
  return { grantId, membershipId, expiresAt: expiresAt.toISOString() };
}

export async function revokeSupportAccess(
  ctx: CommandContext,
  input: { grantId: string; reason?: string },
): Promise<{ grantId: string; revokedAt: string }> {
  authorizeOrAudit(() => authorize(ctx.actor, "support.grant"), {
    action: "support.revoke_denied",
    entityType: "support_grant",
    ...(UUID.test(input.grantId) ? { entityId: input.grantId.toLowerCase() } : {}),
  });
  const reason =
    input.reason === undefined || input.reason.trim() === ""
      ? SUPPORT_REVOKE_DEFAULT_REASON
      : cleanReason(input.reason);
  if (!UUID.test(input.grantId)) throw new CommandError("NOT_FOUND", 404, t("support.grant_not_found"));
  const orgId = ctx.actor.orgId;
  const r = await sql<{ id: string; grantee_membership_id: string; revoked_at: Date | null; live: boolean }>`
    select id, grantee_membership_id, revoked_at, (expires_at > now()) as live from support_grants
    where organization_id = ${orgId} and id = ${input.grantId} for update`.execute(ctx.trx);
  const g = r.rows[0];
  if (!g) throw new CommandError("NOT_FOUND", 404, t("support.grant_not_found"));
  if (g.revoked_at) throw new CommandError("INVALID_TRANSITION", 409, t("support.grant_already_revoked"));
  const done = await sql<{ revoked_at: Date }>`
    update support_grants set revoked_at = now(), revoked_by = ${ctx.actor.membershipId}
    where organization_id = ${orgId} and id = ${g.id} returning revoked_at`.execute(ctx.trx);
  await sql`update memberships set status = 'revoked', revoked_at = now()
            where organization_id = ${orgId} and id = ${g.grantee_membership_id} and status <> 'revoked'`.execute(
    ctx.trx,
  );
  const revokedAt = done.rows[0]?.revoked_at as Date;
  await ctx.audit({
    action: "support.access_revoked",
    entityType: "support_grant",
    entityId: g.id,
    before: { status: g.live ? "active" : "expired" },
    after: { status: "revoked", revoked_at: revokedAt.toISOString() },
    reason,
  });
  await ctx.emit({
    eventType: "support.access_revoked",
    aggregateType: "support_grant",
    aggregateId: g.id,
    payload: { support_grant_id: g.id, membership_id: g.grantee_membership_id },
  });
  ctx.security({ event: "support.access_revoked", target: { type: "support_grant", id: g.id } });
  return { grantId: g.id, revokedAt: revokedAt.toISOString() };
}

export interface SupportGrantRow {
  grantId: string;
  granteeName: string | null;
  granteeEmail: string | null;
  grantedByName: string | null;
  revokedByName: string | null;
  reason: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
}

/** `support.listGrants`: 100 grant gần nhất của tổ chức (owner/manager/kế toán — như xem audit). */
export async function listSupportGrants(db: Kysely<unknown>, actor: Actor): Promise<SupportGrantRow[]> {
  authorize(actor, "audit.read");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      id: string;
      grantee_name: string | null;
      grantee_email: string | null;
      granted_by_name: string | null;
      revoked_by_name: string | null;
      reason: string;
      granted_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
      status: SupportGrantRow["status"];
    }>`
      select g.id, pg.full_name as grantee_name, pg.email as grantee_email, pb.full_name as granted_by_name,
             pr.full_name as revoked_by_name, g.reason, g.granted_at, g.expires_at, g.revoked_at,
             case when g.revoked_at is not null then 'revoked' when g.expires_at <= now() then 'expired' else 'active' end as status
      from support_grants g
      join memberships mg on mg.organization_id = g.organization_id and mg.id = g.grantee_membership_id
      left join persons pg on pg.organization_id = mg.organization_id and pg.id = mg.person_id
      join memberships mb on mb.organization_id = g.organization_id and mb.id = g.granted_by
      left join persons pb on pb.organization_id = mb.organization_id and pb.id = mb.person_id
      left join memberships mr on mr.organization_id = g.organization_id and mr.id = g.revoked_by
      left join persons pr on pr.organization_id = mr.organization_id and pr.id = mr.person_id
      where g.organization_id = ${actor.orgId}
      order by g.granted_at desc, g.id desc
      limit 100`.execute(trx);
    return r.rows.map((x) => ({
      grantId: x.id,
      granteeName: x.grantee_name,
      granteeEmail: x.grantee_email,
      grantedByName: x.granted_by_name,
      revokedByName: x.revoked_by_name,
      reason: x.reason,
      grantedAt: x.granted_at.toISOString(),
      expiresAt: x.expires_at.toISOString(),
      revokedAt: x.revoked_at?.toISOString() ?? null,
      status: x.status,
    }));
  });
}

/**
 * Ghi một dòng audit `support.accessed` cho lần hỗ trợ mở trang/gọi truy vấn (actor không phải hỗ trợ ⇒ không làm gì). Ghi ở
 * transaction riêng TRƯỚC khi trả dữ liệu; lỗi ghi ⇒ ném (không trả dữ liệu mà không để lại dấu vết).
 */
export async function recordSupportAccess(
  db: Kysely<unknown>,
  actor: Actor,
  input: { resource: string; client?: SecurityClient | null; correlationId?: string | undefined },
): Promise<void> {
  if (actor.role !== "platform_support") return;
  const grant = actor.supportGrant;
  if (!grant) throw new CommandError("FORBIDDEN", 403, t("pipeline.support_read_only"));
  const src = auditSource(input.client ?? null);
  const resource = input.resource.normalize("NFC").slice(0, 200);
  await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
    sql`
      insert into audit_events (id, organization_id, actor_type, actor_person_id, action, entity_type, entity_id, after, reason,
                                correlation_id, outcome, source_ip, user_agent, support_grant_id)
      values (${randomUUID()}, ${actor.orgId}, 'platform_support', ${actor.personId}, 'support.accessed', 'route', null,
              ${JSON.stringify({ resource })}::jsonb, ${grant.reason}, ${input.correlationId ?? `support:${randomUUID()}`},
              'success', ${src.sourceIp}, ${src.userAgent}, ${grant.id})`.execute(trx),
  );
}

/**
 * Trang SSR mà hỗ trợ nền tảng được mở (D-122/D-126: phạm vi đọc chỉ `calendar.read_status`). Trang SSR đọc dữ liệu bằng hàm đọc
 * thẳng (không qua `runQuery`) ⇒ khung trang phải chặn ở đây; mở rộng danh sách là thay đổi có chủ đích (SPEC + test + TM-12).
 */
export const SUPPORT_PAGES: readonly string[] = ["/lich-phong"];

/**
 * Cổng trang SSR cho hỗ trợ nền tảng: actor không phải hỗ trợ ⇒ `not_support` (không làm gì); trang ngoài `SUPPORT_PAGES` ⇒
 * `forbidden` (không đọc gì, không ghi gì); trang được phép ⇒ ghi `support.accessed` TRƯỚC khi render — lỗi ghi ⇒ ném (fail-closed).
 */
export async function supportPageAccess(
  db: Kysely<unknown>,
  actor: Actor,
  input: { page: string; client?: SecurityClient | null; correlationId?: string | undefined },
): Promise<"not_support" | "forbidden" | "allowed"> {
  if (actor.role !== "platform_support") return "not_support";
  if (!SUPPORT_PAGES.includes(input.page)) return "forbidden";
  await recordSupportAccess(db, actor, {
    resource: `page:${input.page}`,
    client: input.client ?? null,
    correlationId: input.correlationId,
  });
  return "allowed";
}
