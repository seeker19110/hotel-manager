// PLAN đợt 3 T-216 — mời/thu hồi người thuê vào portal (SPEC-portal S-012…S-015; D-016).
// - `portal.inviteTenant`: người đứng hợp đồng (đại diện hoặc người thuê chung đang ở) của hợp đồng còn hiệu lực trong phạm
//   vi người mời → tài khoản auth theo email (không mật khẩu; đăng nhập bằng OTP) + membership `tenant` gắn `person_id`.
//   Không tính quota nhân viên (vai trò `tenant`). Mời lại cùng người + cùng email ⇒ cùng kết quả (idempotent).
// - `portal.revokeTenantAccess`: membership `revoked` — request kế tiếp của người thuê nhận 404 (resolveActor).
// - Lời mời đến người thuê qua kênh thông báo (outbox `portal.tenant_invited` → `account_security`, bắt buộc).
import { randomUUID } from "node:crypto";
import { authorize } from "@hm/domain";
import { sql } from "kysely";
import { type CommandContext, CommandError } from "../pipeline/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

function fieldError(path: string, code: string, message: string): CommandError {
  return new CommandError("VALIDATION_FAILED", 422, message, {
    extensions: { errors: [{ path, field: path, code }] },
  });
}

/** Cơ sở của hợp đồng còn hiệu lực mà người này đứng tên (đại diện / người thuê chung chưa rời) — trong phạm vi actor.
 *  "Chưa rời" so `to_on` với ngày địa phương của CƠ SỞ (`properties.timezone`), không phải `current_date` của phiên
 *  CSDL (UTC) — AUD-XFEAT-002. */
async function tenantProperties(ctx: CommandContext, personId: string): Promise<string[]> {
  const r = await sql<{ property_id: string }>`
    select distinct l.property_id from leases l
    join properties p on p.organization_id = l.organization_id and p.id = l.property_id
    where l.organization_id = ${ctx.actor.orgId} and l.status in ('signed_awaiting_handover','active','notice_given','settling')
      and (l.representative_person_id = ${personId}
           or exists (select 1 from lease_occupants o where o.organization_id = l.organization_id and o.lease_id = l.id
                        and o.person_id = ${personId} and o.role in ('primary','co_tenant')
                        and (o.to_on is null or o.to_on >= (now() at time zone p.timezone)::date)))`.execute(
    ctx.trx,
  );
  return r.rows
    .map((x) => x.property_id)
    .filter((p) => ctx.actor.allProperties || ctx.actor.propertyIds.includes(p));
}

/** `portal.inviteTenant` (S-014). */
export async function inviteTenant(
  ctx: CommandContext,
  input: { personId: string; email: string },
): Promise<{ membershipId: string; created: boolean }> {
  if (!UUID.test(input.personId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy người thuê");
  const props = await tenantProperties(ctx, input.personId);
  if (props.length === 0) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy người thuê");
  authorize(ctx.actor, "portal.invite_tenant", { propertyId: props[0] as string });
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 320) throw fieldError("email", "invalid", "Email không hợp lệ");
  const p = await sql<{ full_name: string }>`
    select full_name from persons where organization_id = ${ctx.actor.orgId} and id = ${input.personId}
      and anonymized_at is null for update`.execute(ctx.trx);
  if (!p.rows[0]) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy người thuê");

  const existingUser = await sql<{ id: string }>`select id from auth."user" where email = ${email}`.execute(
    ctx.trx,
  );
  let userId = existingUser.rows[0]?.id;
  if (userId) {
    const m = await sql<{ id: string; role: string; person_id: string }>`
      select id, role, person_id from memberships where organization_id = ${ctx.actor.orgId} and auth_user_id = ${userId}
        and status in ('invited','active','suspended')`.execute(ctx.trx);
    const cur = m.rows[0];
    if (cur?.role === "tenant" && cur.person_id === input.personId)
      return { membershipId: cur.id, created: false };
    if (cur)
      throw new CommandError("DUPLICATE", 409, "Email này đã gắn với tài khoản khác trong tổ chức", {
        extensions: { errors: [{ path: "email", field: "email", code: "taken" }] },
      });
  }
  const other = await sql<{ id: string }>`
    select id from memberships where organization_id = ${ctx.actor.orgId} and person_id = ${input.personId}
      and status in ('invited','active','suspended')`.execute(ctx.trx);
  if (other.rows[0])
    throw new CommandError(
      "DUPLICATE",
      409,
      "Người này đã có quyền truy cập với email khác — thu hồi trước khi mời lại",
      {
        extensions: { errors: [{ path: "person_id", field: "person_id", code: "taken" }] },
      },
    );
  if (!userId) {
    userId = randomUUID();
    await sql`insert into auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
              values (${userId}, ${p.rows[0].full_name}, ${email}, false, now(), now())`.execute(ctx.trx);
  }
  await sql`update persons set email = ${email}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${input.personId} and email is distinct from ${email}`.execute(
    ctx.trx,
  );
  const membershipId = randomUUID();
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, status)
            values (${membershipId}, ${ctx.actor.orgId}, ${userId}, ${input.personId}, 'tenant', 'active')`.execute(
    ctx.trx,
  );
  await ctx.audit({
    action: "portal.tenant_invited",
    entityType: "membership",
    entityId: membershipId,
    propertyId: props[0] as string,
    after: { role: "tenant", person_id: input.personId },
  });
  await ctx.emit({
    eventType: "portal.tenant_invited",
    aggregateType: "membership",
    aggregateId: membershipId,
    propertyId: props[0] as string,
    payload: { membership_id: membershipId, person_id: input.personId },
  });
  // Cấp quyền truy cập portal (vai `tenant`) — đối xứng với `portal.tenant_access_revoked`; chỉ id, không email.
  ctx.security({ event: "portal.tenant_access_granted", target: { type: "membership", id: membershipId } });
  return { membershipId, created: true };
}

/** `portal.revokeTenantAccess` (S-015). */
export async function revokeTenantAccess(
  ctx: CommandContext,
  input: { membershipId: string; reason?: string },
) {
  if (!UUID.test(input.membershipId))
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy quyền truy cập");
  const m = await sql<{ person_id: string; status: string }>`
    select person_id, status from memberships where organization_id = ${ctx.actor.orgId} and id = ${input.membershipId}
      and role = 'tenant' for update`.execute(ctx.trx);
  const row = m.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy quyền truy cập");
  // Owner thu hồi mọi người thuê; quản lý/lễ tân chỉ người thuê có hợp đồng trong phạm vi của mình.
  const props = await tenantProperties(ctx, row.person_id);
  if (ctx.actor.role === "owner") authorize(ctx.actor, "portal.invite_tenant", {});
  else if (props[0]) authorize(ctx.actor, "portal.invite_tenant", { propertyId: props[0] });
  else throw new CommandError("NOT_FOUND", 404, "Không tìm thấy quyền truy cập");
  if (row.status === "revoked") return { membershipId: input.membershipId, status: "revoked" as const };
  await sql`update memberships set status = 'revoked', revoked_at = now(), version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${input.membershipId}`.execute(ctx.trx);
  await ctx.audit({
    action: "portal.tenant_access_revoked",
    entityType: "membership",
    entityId: input.membershipId,
    before: { status: row.status },
    after: { status: "revoked" },
    ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 500) } : {}),
  });
  ctx.security({
    event: "portal.tenant_access_revoked",
    target: { type: "membership", id: input.membershipId },
  });
  return { membershipId: input.membershipId, status: "revoked" as const };
}
