// `member.updateRole` / `member.updateScope` (SPEC-access S-018, S-019, S-022; ma trận 5.3 "Đổi vai trò, phạm vi, hạn mức": chỉ owner).
// - Không tự nâng quyền: manager/lễ tân… gọi ⇒ 403 + audit `member.role_change_denied`/`member.scope_change_denied` (lần thử bị từ chối).
// - Owner cuối cùng không tự hạ vai: khoá các hàng owner active theo id tăng dần rồi đếm ⇒ 409 LAST_OWNER (trigger deferred ở CSDL là lớp
//   thứ hai, bắt cả đường ghi khác). Hai owner hạ nhau song song: bên sau thấy owner kia đã hạ ⇒ LAST_OWNER.
// - Mỗi thay đổi = đúng một audit_events (trước/sau, lý do) + một outbox + sự kiện bảo mật (SEC-LOG-001), cùng transaction (S-022).
// - Quyền có hiệu lực ở request kế tiếp (quyền tra từ `memberships` mỗi request — không sửa token).
import { authorize } from "@hm/domain";
import { sql } from "kysely";
import { t as msg } from "../i18n.ts";
import { type CommandContext, CommandError, fieldError } from "../pipeline/index.ts";
import { authorizeOrAudit } from "./denied.ts";
import { ALL_PROPERTIES_ROLES, type InviteRole } from "./invitations.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Vai trò nhân viên (đổi được); tenant do cổng người thuê quản, platform_support là quyền tạm thời của nền tảng. */
const STAFF: ReadonlySet<string> = new Set([
  "owner",
  "manager",
  "front_desk",
  "accountant",
  "housekeeping",
  "maintenance",
]);

interface Target {
  id: string;
  role: string;
  status: string;
  all_properties: boolean;
  property_ids: string[];
}

function cleanReason(reason: string): string {
  const r = reason.trim();
  if (!r || r.length > 500) throw fieldError("reason", "REQUIRED", msg("access.reason_required_500"));
  return r;
}

/** Khoá hàng owner active (theo id tăng dần — tránh deadlock) + hàng đích, đọc đích kèm phạm vi. */
async function lockTarget(
  ctx: CommandContext,
  membershipId: string,
): Promise<{ target: Target; otherOwners: number }> {
  if (!UUID.test(membershipId)) throw new CommandError("NOT_FOUND", 404, msg("access.member_not_found"));
  const locked = await sql<{ id: string; role: string; status: string }>`
    select id, role, status from memberships
    where organization_id = ${ctx.actor.orgId} and ((role = 'owner' and status = 'active') or id = ${membershipId})
    order by id for update`.execute(ctx.trx);
  const t = locked.rows.find((r) => r.id === membershipId.toLowerCase());
  if (!t || t.status === "revoked") throw new CommandError("NOT_FOUND", 404, msg("access.member_not_found"));
  if (!STAFF.has(t.role)) throw new CommandError("INVALID_TRANSITION", 409, msg("access.members_staff_only"));
  const sc = await sql<{ all_properties: boolean; property_ids: string[] }>`
    select m.all_properties,
           coalesce(array_agg(ps.property_id order by ps.property_id) filter (where ps.property_id is not null), '{}')::text[] as property_ids
    from memberships m
    left join property_scopes ps on ps.organization_id = m.organization_id and ps.membership_id = m.id
    where m.organization_id = ${ctx.actor.orgId} and m.id = ${membershipId} group by m.id`.execute(ctx.trx);
  return {
    target: {
      ...t,
      all_properties: sc.rows[0]?.all_properties ?? false,
      property_ids: sc.rows[0]?.property_ids ?? [],
    },
    otherOwners: locked.rows.filter((r) => r.role === "owner" && r.status === "active" && r.id !== t.id)
      .length,
  };
}

async function assertPropertiesExist(ctx: CommandContext, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const r = await sql<{ n: number }>`
    select count(*)::int as n from properties
    where organization_id = ${ctx.actor.orgId} and id = any(${ids}::uuid[]) and archived_at is null`.execute(
    ctx.trx,
  );
  if ((r.rows[0]?.n ?? 0) !== ids.length)
    throw new CommandError("NOT_FOUND", 404, msg("common.property_not_found"));
}

async function writeScopes(ctx: CommandContext, membershipId: string, ids: readonly string[]): Promise<void> {
  await sql`delete from property_scopes where organization_id = ${ctx.actor.orgId} and membership_id = ${membershipId}
              and not (property_id = any(${ids}::uuid[]))`.execute(ctx.trx);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            select gen_random_uuid(), ${ctx.actor.orgId}, ${membershipId}, p from unnest(${ids}::uuid[]) as p
            on conflict (organization_id, membership_id, property_id) do nothing`.execute(ctx.trx);
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export async function updateMemberRole(
  ctx: CommandContext,
  input: { membershipId: string; role: InviteRole; propertyIds?: readonly string[]; reason: string },
): Promise<{ membershipId: string; role: string; changed: boolean }> {
  authorizeOrAudit(() => authorize(ctx.actor, "member.change_role", {}), {
    action: "member.role_change_denied",
    entityType: "membership",
    ...(UUID.test(input.membershipId) ? { entityId: input.membershipId.toLowerCase() } : {}),
    after: { requested_role: input.role, ...(input.propertyIds ? { property_ids: input.propertyIds } : {}) },
  });
  const reason = cleanReason(input.reason);
  const requested = input.propertyIds
    ? [...new Set(input.propertyIds.map((p) => p.toLowerCase()))].sort()
    : undefined;
  const { target, otherOwners } = await lockTarget(ctx, input.membershipId);

  if (target.role === "owner" && target.status === "active" && input.role !== "owner" && otherOwners === 0)
    throw new CommandError("LAST_OWNER", 409, msg("access.last_owner"));

  // Phạm vi sau khi đổi vai: owner luôn mọi cơ sở; kế toán mặc định mọi cơ sở (Q-09); vai trò cấp cơ sở cần danh sách cơ sở.
  let all: boolean;
  let ids: string[];
  if (input.role === "owner") {
    if (requested && requested.length > 0)
      throw fieldError("property_ids", "not_allowed", msg("access.owner_all_properties"));
    all = true;
    ids = [];
  } else if (requested !== undefined && requested.length > 0) {
    all = false;
    ids = requested;
  } else if (
    ALL_PROPERTIES_ROLES.has(input.role) &&
    (target.all_properties || target.property_ids.length === 0)
  ) {
    all = true;
    ids = [];
  } else if (
    !ALL_PROPERTIES_ROLES.has(input.role) &&
    (target.all_properties || target.property_ids.length === 0)
  ) {
    throw fieldError("property_ids", "required", msg("access.role_needs_property"));
  } else {
    all = false;
    ids = target.property_ids;
  }
  if (input.role === target.role && all === target.all_properties && same(ids, target.property_ids))
    return { membershipId: target.id, role: target.role, changed: false };
  await assertPropertiesExist(ctx, ids);

  await sql`update memberships set role = ${input.role}, all_properties = ${all}
            where organization_id = ${ctx.actor.orgId} and id = ${target.id}`.execute(ctx.trx);
  await writeScopes(ctx, target.id, ids);
  await ctx.audit({
    action: "member.role_changed",
    entityType: "membership",
    entityId: target.id,
    before: { role: target.role, all_properties: target.all_properties, property_ids: target.property_ids },
    after: { role: input.role, all_properties: all, property_ids: ids },
    reason,
  });
  await ctx.emit({
    eventType: "member.role_changed",
    aggregateType: "membership",
    aggregateId: target.id,
    payload: { membership_id: target.id },
  });
  ctx.security({
    event: "member.role_changed",
    target: { type: "membership", id: target.id },
    reason: input.role,
  });
  return { membershipId: target.id, role: input.role, changed: true };
}

export async function updateMemberScope(
  ctx: CommandContext,
  input: { membershipId: string; propertyIds: readonly string[]; allProperties?: boolean; reason: string },
): Promise<{ membershipId: string; allProperties: boolean; propertyIds: string[]; changed: boolean }> {
  authorizeOrAudit(() => authorize(ctx.actor, "member.change_role", {}), {
    action: "member.scope_change_denied",
    entityType: "membership",
    ...(UUID.test(input.membershipId) ? { entityId: input.membershipId.toLowerCase() } : {}),
    after: { property_ids: input.propertyIds, all_properties: input.allProperties ?? false },
  });
  const reason = cleanReason(input.reason);
  const ids = [...new Set(input.propertyIds.map((p) => p.toLowerCase()))].sort();
  const all = input.allProperties === true;
  const { target } = await lockTarget(ctx, input.membershipId);
  if (target.role === "owner")
    throw fieldError("membership_id", "owner_all_properties", msg("access.owner_all_properties"));
  if (all && !ALL_PROPERTIES_ROLES.has(target.role))
    throw fieldError("all_properties", "not_allowed", msg("access.all_properties_accountant_only"));
  if (all && ids.length > 0)
    throw fieldError("property_ids", "not_allowed", msg("access.all_properties_no_list"));
  if (!all && ids.length === 0) throw fieldError("property_ids", "required", msg("access.property_required"));
  if (all === target.all_properties && same(ids, target.property_ids))
    return { membershipId: target.id, allProperties: all, propertyIds: ids, changed: false };
  await assertPropertiesExist(ctx, ids);

  await sql`update memberships set all_properties = ${all} where organization_id = ${ctx.actor.orgId} and id = ${target.id}`.execute(
    ctx.trx,
  );
  await writeScopes(ctx, target.id, ids);
  await ctx.audit({
    action: "member.scope_changed",
    entityType: "membership",
    entityId: target.id,
    before: { all_properties: target.all_properties, property_ids: target.property_ids },
    after: { all_properties: all, property_ids: ids },
    reason,
  });
  await ctx.emit({
    eventType: "member.scope_changed",
    aggregateType: "membership",
    aggregateId: target.id,
    payload: { membership_id: target.id },
  });
  ctx.security({ event: "member.scope_changed", target: { type: "membership", id: target.id } });
  return { membershipId: target.id, allProperties: all, propertyIds: ids, changed: true };
}
