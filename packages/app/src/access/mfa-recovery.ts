// Khôi phục MFA khi thành viên mất thiết bị (PLAN đợt 2 T-116; SPEC-access-and-property Q-08 — chủ dự án duyệt 2026-10-15).
// - Owner KHÁC đặt lại MFA của thành viên trong tổ chức: xoá bí mật TOTP + mã dự phòng, tắt cờ 2FA, thu hồi mọi phiên ⇒ người
//   đó phải đăng nhập lại và đăng ký MFA mới (vai trò bắt buộc MFA bị chặn `MFA_REQUIRED` tới khi xong). Có lý do + audit.
// - Không tự đặt lại của mình. Owner duy nhất mất thiết bị ⇒ hỗ trợ nền tảng có xác minh danh tính (F-015, ngoài đợt 2).
// - Tài khoản đăng nhập dùng chung nhiều tổ chức: owner tổ chức này KHÔNG được hạ bảo mật của tổ chức khác ⇒ chuyển hỗ trợ.
import { authorize } from "@hm/domain";
import { sql } from "kysely";
import { type CommandContext, CommandError, fieldError } from "../pipeline/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `member.resetMfa`: chỉ owner (`member.change_role`), không cho chính mình, có lý do. */
export async function resetMemberMfa(
  ctx: CommandContext,
  input: { membershipId: string; reason: string },
): Promise<{ membershipId: string; sessionsRevoked: number }> {
  authorize(ctx.actor, "member.change_role", {});
  if (input.membershipId === ctx.actor.membershipId) {
    const owners = await sql<{ n: number }>`
      select count(*)::int as n from memberships where organization_id = ${ctx.actor.orgId} and role = 'owner'
        and status = 'active' and id <> ${ctx.actor.membershipId}`.execute(ctx.trx);
    const sole = (owners.rows[0]?.n ?? 0) === 0;
    throw new CommandError(
      "FORBIDDEN",
      403,
      sole
        ? "Bạn là owner duy nhất — liên hệ hỗ trợ nền tảng để xác minh danh tính và khôi phục."
        : "Không tự đặt lại xác thực hai lớp của mình — nhờ một owner khác.",
      { extensions: { items: [{ recovery: sole ? "platform_support" : "another_owner" }] } },
    );
  }
  if (!UUID.test(input.membershipId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy thành viên");
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw fieldError("reason", "REQUIRED", "Cần lý do (≤ 500 ký tự)");
  const m = await sql<{ auth_user_id: string | null; role: string; status: string }>`
    select auth_user_id, role, status from memberships where organization_id = ${ctx.actor.orgId} and id = ${input.membershipId}
    for update`.execute(ctx.trx);
  const target = m.rows[0];
  if (!target || target.status === "revoked")
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy thành viên");
  if (!target.auth_user_id)
    throw new CommandError("INVALID_TRANSITION", 409, "Thành viên chưa có tài khoản đăng nhập");
  // Mọi membership chưa thu hồi ở tổ chức khác (kể cả tạm khoá/chưa hiệu lực) — review lát 4 🟢4.
  const elsewhere = await sql<{ n: number }>`
    select app.memberships_elsewhere(${target.auth_user_id}::uuid, ${ctx.actor.orgId}::uuid) as n`.execute(
    ctx.trx,
  );
  if ((elsewhere.rows[0]?.n ?? 0) > 0) {
    throw new CommandError(
      "FORBIDDEN",
      403,
      "Tài khoản này còn dùng ở tổ chức khác — liên hệ hỗ trợ nền tảng để khôi phục.",
      { extensions: { items: [{ recovery: "platform_support" }] } },
    );
  }
  await sql`delete from auth."twoFactor" where "userId" = ${target.auth_user_id}::uuid`.execute(ctx.trx);
  await sql`update auth."user" set "twoFactorEnabled" = false, "updatedAt" = now() where id = ${target.auth_user_id}::uuid`.execute(
    ctx.trx,
  );
  const s = await sql`delete from auth."session" where "userId" = ${target.auth_user_id}::uuid`.execute(
    ctx.trx,
  );
  const sessionsRevoked = Number(s.numAffectedRows ?? 0);
  await ctx.audit({
    action: "member.mfa_reset",
    entityType: "membership",
    entityId: input.membershipId,
    reason,
    after: { role: target.role, sessions_revoked: sessionsRevoked },
  });
  // Báo cho chính người đó (kênh gửi do module thông báo — chưa gửi ra ngoài ở đợt 2).
  await ctx.emit({
    eventType: "member.mfa_reset",
    aggregateType: "membership",
    aggregateId: input.membershipId,
    payload: { membership_id: input.membershipId, by_membership_id: ctx.actor.membershipId },
  });
  ctx.security({ event: "member.mfa_reset", target: { type: "membership", id: input.membershipId } });
  return { membershipId: input.membershipId, sessionsRevoked };
}
