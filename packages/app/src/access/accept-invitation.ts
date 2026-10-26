// `member.acceptInvitation` (SPEC-access S-007, S-008): người nhận mở liên kết, đăng nhập ĐÚNG email được mời, gửi token.
// Mọi lý do không hợp lệ (không tìm thấy, đã dùng, quá hạn, thu hồi, sai email) đều trả cùng 410 INVITATION_INVALID — không phân biệt
// để không lộ trạng thái; lý do thật chỉ ở sự kiện bảo mật `invitation.rejected` (mã ngắn, không token/email).
// Kiểm + khoá hàng lời mời + tạo membership đều ở `bootstrap` của pipeline (cùng transaction với audit/outbox), nên hai lần chấp nhận
// song song chỉ một thắng; cùng Idempotency-Key gửi lại ⇒ replay đúng kết quả cũ.
import { sql } from "kysely";
import type { Actor, Role } from "../actor-core/index.ts";
import { t } from "../i18n.ts";
import { emitSecurity } from "../logging/index.ts";
import { CommandError, type CommandResult } from "../pipeline/index.ts";
import { hashInvitationToken } from "./invitations.ts";
import { deriveUuid, readAuthUser, runUserCommand, type UserCommandRequest } from "./provision.ts";

export interface AcceptedInvitation {
  membershipId: string;
  organizationId: string;
  role: string;
}

export async function acceptInvitation(
  req: UserCommandRequest,
  input: { token: string },
): Promise<CommandResult<AcceptedInvitation>> {
  const reject = (reason: string, orgId?: string) => {
    emitSecurity({
      event: "invitation.rejected",
      outcome: "denied",
      actor: { authUserId: req.userId, orgId: orgId ?? null },
      target: { type: "invitation" },
      reason,
      client: req.client ?? null,
      correlationId: req.correlationId,
    });
    return new CommandError("INVITATION_INVALID", 410, t("access.invitation_unavailable"));
  };

  const found = await sql<{ organization_id: string; id: string; role: string }>`
    select organization_id, id, role from app.invitation_by_token(${hashInvitationToken(input.token)})`.execute(
    req.db,
  );
  const inv = found.rows[0];
  if (!inv) throw reject("unknown_token");
  const orgId = inv.organization_id;
  const membershipId = deriveUuid("accept:membership", req.userId, req.key);
  const personId = deriveUuid("accept:person", req.userId, req.key);
  const actor: Actor = {
    authUserId: req.userId,
    orgId,
    membershipId,
    personId,
    role: inv.role as Role,
    allProperties: false,
    propertyIds: [],
    limits: {},
    mfaRequired: false,
  };
  return runUserCommand<AcceptedInvitation>(req, {
    command: "member.acceptInvitation",
    actor,
    bootstrap: async (trx) => {
      const r = await sql<{
        email: string;
        role: string;
        status: string;
        expired: boolean;
        property_ids: string[];
        limits: Record<string, number>;
        support_reason: string | null;
        expires_at: Date;
      }>`
        select email, role, status, (expires_at <= now()) as expired, property_ids::text[] as property_ids, limits,
               support_reason, expires_at
        from invitations where organization_id = ${orgId} and id = ${inv.id} for update`.execute(trx);
      const row = r.rows[0];
      if (!row) throw reject("unknown_token", orgId);
      if (row.status !== "pending") throw reject(`status_${row.status}`, orgId);
      if (row.expired) throw reject("expired", orgId);
      const user = await readAuthUser(trx, req.userId);
      if (!user || user.email !== row.email) throw reject("email_mismatch", orgId);
      const existing = await sql<{ id: string }>`
        select id from memberships where organization_id = ${orgId} and auth_user_id = ${req.userId}
          and status in ('invited','active','suspended')`.execute(trx);
      if (existing.rows[0]) throw new CommandError("DUPLICATE", 409, t("access.already_member"));
      const allProperties = row.property_ids.length === 0;
      await sql`insert into persons (id, organization_id, full_name, email)
                values (${personId}, ${orgId}, ${user.name.trim().slice(0, 200) || user.email}, ${user.email})`.execute(
        trx,
      );
      // Truy cập hỗ trợ (D-128): hiệu lực đến đúng hạn của lời cấp (tính từ lúc owner cấp), kèm lý do — CHECK 0072 giữ ≤ 72 giờ.
      const support = row.role === "platform_support";
      await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, status, limits, all_properties,
                                         valid_to, support_reason)
                values (${membershipId}, ${orgId}, ${req.userId}, ${personId}, ${row.role}, 'active',
                        ${JSON.stringify(row.limits)}::jsonb, ${allProperties},
                        ${support ? row.expires_at : null}, ${support ? row.support_reason : null})`.execute(
        trx,
      );
      for (const p of row.property_ids)
        await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
                  values (gen_random_uuid(), ${orgId}, ${membershipId}, ${p})`.execute(trx);
      // Token mời chỉ gửi tới hộp thư được mời và người nhận phải đăng nhập ĐÚNG email đó ⇒ nhận lời mời là bằng chứng sở hữu hộp thư
      // (đăng ký mật khẩu không xác minh email). Nhân viên nhờ vậy dùng được vai người thuê ở tổ chức khác (S-012; AUD-SEC-001, D-081).
      await sql`update auth."user" set "emailVerified" = true, "updatedAt" = now() where id = ${req.userId}`.execute(
        trx,
      );
      await sql`update invitations set status = 'accepted', accepted_at = now(), membership_id = ${membershipId},
                       person_id = ${personId}
                where organization_id = ${orgId} and id = ${inv.id}`.execute(trx);
    },
    handler: async (ctx) => {
      await ctx.audit({
        action: "member.accepted",
        entityType: "membership",
        entityId: membershipId,
        after: { role: inv.role, invitation_id: inv.id },
      });
      await ctx.emit({
        eventType: "member.accepted",
        aggregateType: "membership",
        aggregateId: membershipId,
        payload: { membership_id: membershipId, invitation_id: inv.id },
      });
      ctx.security({ event: "member.accepted", target: { type: "membership", id: membershipId } });
      return { data: { membershipId, organizationId: orgId, role: inv.role } };
    },
  });
}
