// Truy cập hỗ trợ CHỈ ĐỌC (PLAN T-2313; D-128; IND-SAAS-009, TM-12). Không impersonation: người hỗ trợ có tài khoản riêng, được owner
// CẤP qua lời mời email (vai `platform_support`) kèm lý do bắt buộc và hạn (mặc định 24 giờ, tối đa 72 giờ — CHECK ở CSDL, 0072).
// - Cấp (`member.grantSupportAccess`): chỉ owner; hạn tính từ lúc cấp (`invitations.expires_at`), khi nhận lời mời membership mang
//   `valid_to` = hạn đó + lý do. Hết hạn = `valid_to <= now()` theo đồng hồ CSDL (resolveActor) — không cần job.
// - Thu hồi (`member.revokeSupportAccess`): chỉ owner, MỘT bước: lời mời chưa nhận ⇒ `revoked`; đã nhận ⇒ membership `revoked`
//   (request kế tiếp của support bị từ chối vì quyền tra lại mỗi request). Lặp lại ⇒ trả trạng thái hiện tại (idempotent).
// - Chỉ đọc: pipeline/route chặn mọi lệnh ghi (`supportWriteDenied`), RLS 0072 chặn ghi ở CSDL, `authorize` chỉ cho SUPPORT_READ.
// - Minh bạch: mỗi lần support mở trang/gọi query ⇒ một `audit_events` `support.accessed` (actor_type `platform_support`, lý do của
//   lời cấp, nguồn IP/UA) — owner/manager thấy trong /nhat-ky; mọi trang của tổ chức hiện biểu ngữ khi đang có truy cập hỗ trợ.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { AuthzError, authorize } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../actor-core/index.ts";
import { t } from "../i18n.ts";
import { auditSource, type SecurityClient } from "../logging/index.ts";
import { type CommandContext, CommandError, fieldError } from "../pipeline/index.ts";
import { authorizeOrAudit } from "./denied.ts";
import { hashInvitationToken, invitationToken, normalizeEmail } from "./invitations.ts";

export const SUPPORT_ROLE = "platform_support";
export const SUPPORT_TTL_DEFAULT_HOURS = 24;
export const SUPPORT_TTL_MAX_HOURS = 72;
export const SUPPORT_REASON_MAX = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isSupport = (actor: Pick<Actor, "role">): boolean => actor.role === SUPPORT_ROLE;

function ownerOnly(ctx: CommandContext, action: string, entityId?: string): void {
  authorizeOrAudit(
    () => {
      // Ma trận: "Mời/thu hồi owner/manager/accountant" = chỉ owner; truy cập hỗ trợ cùng mức (D-128: owner cấp).
      authorize(ctx.actor, "member.invite_senior");
      if (ctx.actor.role !== "owner") throw new AuthzError("FORBIDDEN", t("access.support_owner_only"));
    },
    { action, entityType: "invitation", ...(entityId ? { entityId } : {}) },
  );
}

export interface GrantSupportInput {
  email: string;
  reason: string;
  ttlHours?: number | undefined;
}

export async function grantSupportAccess(
  ctx: CommandContext,
  key: Buffer,
  input: GrantSupportInput,
): Promise<{ invitationId: string; expiresAt: string }> {
  ownerOnly(ctx, "support.grant_denied");
  const reason = input.reason.trim();
  if (!reason || reason.length > SUPPORT_REASON_MAX)
    throw fieldError("reason", "required", t("access.support_reason_required"));
  const ttl = input.ttlHours ?? SUPPORT_TTL_DEFAULT_HOURS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > SUPPORT_TTL_MAX_HOURS)
    throw fieldError("ttl_hours", "invalid", t("access.support_ttl_invalid", { max: SUPPORT_TTL_MAX_HOURS }));
  const email = normalizeEmail(input.email);
  if (!email) throw fieldError("email", "invalid", t("portal.email_invalid"));

  const member = await sql<{ id: string }>`
    select m.id from memberships m join auth."user" u on u.id = m.auth_user_id
    where m.organization_id = ${ctx.actor.orgId} and lower(btrim(u.email)) = ${email}
      and m.status in ('invited','active','suspended') and (m.valid_to is null or m.valid_to > now())`.execute(
    ctx.trx,
  );
  if (member.rows[0])
    throw new CommandError("DUPLICATE", 409, t("access.email_already_member"), {
      extensions: { errors: [{ path: "email", field: "email", code: "member_exists" }] },
    });
  await sql`update invitations set status = 'expired'
            where organization_id = ${ctx.actor.orgId} and lower(email) = ${email} and role = ${SUPPORT_ROLE}
              and status = 'pending' and expires_at <= now()`.execute(ctx.trx);
  const invitationId = randomUUID();
  // Unique một phần (email, vai trò, pending) chặn hai lời cấp song song cho cùng email ⇒ 23505 → 409 ở dưới.
  const ins = await sql<{ expires_at: Date }>`
    insert into invitations (id, organization_id, email, role, token_hash, expires_at, invited_by, support_reason)
    values (${invitationId}, ${ctx.actor.orgId}, ${email}, ${SUPPORT_ROLE}, ${hashInvitationToken(invitationToken(key, invitationId))},
            now() + make_interval(hours => ${ttl}), ${ctx.actor.membershipId}, ${reason})
    on conflict (organization_id, lower(email), role) where status = 'pending' do nothing
    returning expires_at`.execute(ctx.trx);
  const row = ins.rows[0];
  if (!row)
    throw new CommandError("DUPLICATE", 409, t("access.invitation_pending"), {
      extensions: { errors: [{ path: "email", field: "email", code: "pending_invitation" }] },
    });
  const expiresAt = row.expires_at.toISOString();
  await ctx.audit({
    action: "support.access_granted",
    entityType: "invitation",
    entityId: invitationId,
    after: { role: SUPPORT_ROLE, ttl_hours: ttl, expires_at: expiresAt },
    reason,
  });
  await ctx.emit({
    eventType: "member.invited",
    aggregateType: "invitation",
    aggregateId: invitationId,
    payload: { invitation_id: invitationId },
  });
  ctx.security({ event: "support.access_granted", target: { type: "invitation", id: invitationId } });
  return { invitationId, expiresAt };
}

export async function revokeSupportAccess(
  ctx: CommandContext,
  input: { invitationId: string },
): Promise<{ invitationId: string; status: "revoked" }> {
  ownerOnly(ctx, "support.revoke_denied", UUID.test(input.invitationId) ? input.invitationId : undefined);
  const notFound = () => new CommandError("NOT_FOUND", 404, t("access.support_not_found"));
  if (!UUID.test(input.invitationId)) throw notFound();
  const r = await sql<{ status: string; membership_id: string | null }>`
    select status, membership_id from invitations
    where organization_id = ${ctx.actor.orgId} and id = ${input.invitationId} and role = ${SUPPORT_ROLE}
    for update`.execute(ctx.trx);
  const inv = r.rows[0];
  if (!inv) throw notFound();
  let changed = false;
  if (inv.status === "pending") {
    await sql`update invitations set status = 'revoked'
              where organization_id = ${ctx.actor.orgId} and id = ${input.invitationId}`.execute(ctx.trx);
    changed = true;
  } else if (inv.membership_id) {
    const m = await sql<{ id: string }>`
      update memberships set status = 'revoked', revoked_at = now(), updated_at = now(), version = version + 1
      where organization_id = ${ctx.actor.orgId} and id = ${inv.membership_id} and role = ${SUPPORT_ROLE}
        and status in ('invited','active','suspended')
      returning id`.execute(ctx.trx);
    changed = m.rows.length > 0;
  }
  if (changed) {
    await ctx.audit({
      action: "support.access_revoked",
      entityType: "invitation",
      entityId: input.invitationId,
      after: { membership_id: inv.membership_id },
    });
    ctx.security({ event: "support.access_revoked", target: { type: "invitation", id: input.invitationId } });
  }
  return { invitationId: input.invitationId, status: "revoked" };
}

export interface SupportAccessRow {
  invitationId: string;
  /** `pending` = chưa nhận lời mời; `active` = đang truy cập được. */
  state: "pending" | "active";
  /** Tên người hỗ trợ (khi đã nhận và vai trò người xem được đọc hồ sơ người) — không thì null. */
  name: string | null;
  /** Email chỉ trả cho owner (người cấp) — vai khác null (tối thiểu hoá PII). */
  email: string | null;
  /** Lý do chỉ trả cho owner/manager. */
  reason: string | null;
  until: Date;
}

/**
 * Truy cập hỗ trợ ĐANG hiệu lực của tổ chức (lời mời còn hạn chưa nhận + membership hỗ trợ active còn hạn) — cho biểu ngữ trên mọi
 * trang (mọi thành viên) và mục quản lý ở /nhat-ky (owner). Đồng hồ CSDL quyết "còn hạn".
 */
export async function listSupportAccess(db: Kysely<unknown>, actor: Actor): Promise<SupportAccessRow[]> {
  const r = await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
    sql<{
      id: string;
      state: "pending" | "active";
      name: string | null;
      email: string;
      reason: string;
      until: Date;
    }>`
      select i.id, 'pending' as state, null as name, i.email, i.support_reason as reason, i.expires_at as until
      from invitations i
      where i.organization_id = ${actor.orgId} and i.role = ${SUPPORT_ROLE} and i.status = 'pending' and i.expires_at > now()
      union all
      select i.id, 'active', p.full_name, i.email, m.support_reason, m.valid_to
      from invitations i
      join memberships m on m.organization_id = i.organization_id and m.id = i.membership_id
      left join persons p on p.organization_id = m.organization_id and p.id = m.person_id
      where i.organization_id = ${actor.orgId} and i.role = ${SUPPORT_ROLE} and i.status = 'accepted'
        and m.role = ${SUPPORT_ROLE} and m.status = 'active' and m.valid_from <= now() and m.valid_to > now()
      order by until, id
      limit 50`.execute(trx),
  );
  const owner = actor.role === "owner";
  const seesReason = owner || actor.role === "manager";
  return r.rows.map((x) => ({
    invitationId: x.id,
    state: x.state,
    name: x.name,
    email: owner ? x.email : null,
    reason: seesReason ? x.reason : null,
    until: x.until,
  }));
}

/** Truy vấn `member.listSupportAccess`: owner/manager (quản trị thành viên). */
export async function listSupportAccessQuery(db: Kysely<unknown>, actor: Actor): Promise<SupportAccessRow[]> {
  authorize(actor, "member.invite_staff");
  return listSupportAccess(db, actor);
}

/**
 * Ghi một lần truy cập của support (trang hoặc query) — `support.accessed`, lý do của lời cấp, nguồn IP/UA. Actor không phải
 * support ⇒ không làm gì. Lỗi ghi được ném lên: không ghi được dấu vết thì không phục vụ (mặc định an toàn).
 */
export async function recordSupportAccess(
  db: Kysely<unknown>,
  actor: Actor,
  access: { kind: "page" | "query"; name: string; client?: SecurityClient | null; correlationId?: string },
): Promise<void> {
  if (!isSupport(actor)) return;
  const src = auditSource(access.client);
  await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
    sql`
      insert into audit_events (id, organization_id, actor_type, actor_person_id, action, entity_type, after, reason,
                                correlation_id, outcome, source_ip, user_agent)
      values (${randomUUID()}, ${actor.orgId}, 'platform_support', ${actor.personId}, 'support.accessed', ${access.kind},
              ${JSON.stringify({ [access.kind]: access.name.slice(0, 200) })}::jsonb, ${actor.support?.reason ?? null},
              ${(access.correlationId ?? `support-${randomUUID()}`).slice(0, 200)}, 'success', ${src.sourceIp}, ${src.userAgent})`.execute(
      trx,
    ),
  );
}
