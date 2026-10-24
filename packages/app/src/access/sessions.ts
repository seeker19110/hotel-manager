// Thu hồi phiên (SPEC-access S-010, ADR-0002): phiên của Better Auth nằm trong cùng Postgres nên xoá hàng `auth.session` có hiệu lực
// ngay ở request kế tiếp. Để request mang cookie phiên đã thu hồi nhận `401 SESSION_REVOKED` (thay vì UNAUTHENTICATED chung), mỗi phiên
// bị thu hồi để lại dấu vết `auth.revoked_session` (chỉ BĂM SHA-256 của token phiên, hết hạn cùng phiên). Đăng nhập lại sinh token mới nên
// không dính dấu vết cũ.
import { createHash } from "node:crypto";
import { AuthzError, authorize } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import { t } from "../i18n.ts";
import { type CommandContext, CommandError } from "../pipeline/index.ts";
import { authorizeOrAudit } from "./denied.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Vai trò mà manager được thu hồi phiên (khớp "Mời/thu hồi front_desk/housekeeping/maintenance", ma trận 5.3). */
const MANAGER_REVOKABLE: ReadonlySet<string> = new Set(["front_desk", "housekeeping", "maintenance"]);

/** Thu hồi MỌI phiên của người dùng (cả phiên hiện tại): ghi dấu vết rồi xoá. Trả số phiên đã thu hồi. */
export async function revokeUserSessions(trx: Transaction<unknown>, userId: string): Promise<number> {
  await sql`delete from auth.revoked_session where expires_at < now()`.execute(trx);
  await sql`
    insert into auth.revoked_session (token_hash, user_id, expires_at)
    select sha256(convert_to(token, 'UTF8')), "userId", "expiresAt" from auth."session" where "userId" = ${userId}::uuid
    on conflict (token_hash) do nothing`.execute(trx);
  const r = await sql`delete from auth."session" where "userId" = ${userId}::uuid`.execute(trx);
  return Number(r.numAffectedRows ?? 0);
}

/** Token phiên (không chữ ký) từ cookie đã ký của Better Auth (`<token>.<chữ ký>`, có thể đã URL-encode); không có → null. */
export function sessionTokenFromCookie(cookieHeader: string | null, cookieName: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== cookieName) continue;
    let raw: string;
    try {
      raw = decodeURIComponent(v.join("="));
    } catch {
      return null;
    }
    const dot = raw.lastIndexOf(".");
    return dot > 0 ? raw.slice(0, dot) : null;
  }
  return null;
}

/** Request mang cookie của một phiên ĐÃ BỊ THU HỒI (còn dấu vết)? Gọi khi `getSession` trả null để chọn 401 SESSION_REVOKED. */
export async function isSessionRevoked(
  db: Kysely<unknown>,
  cookieName: string,
  headers: Headers,
): Promise<boolean> {
  const token = sessionTokenFromCookie(headers.get("cookie"), cookieName);
  if (!token) return false;
  const hash = createHash("sha256").update(token, "utf8").digest();
  const r = await sql<{ one: number }>`
    select 1 as one from auth.revoked_session where token_hash = ${hash} and expires_at > now()`.execute(db);
  return r.rows.length > 0;
}

/**
 * `session.revokeAll`: thu hồi mọi phiên của CHÍNH MÌNH (không gửi `membership_id`, hoặc đúng membership của mình) hay của thành
 * viên khác. Người khác: owner (mọi nhân viên) hoặc manager (chỉ nhân viên cấp thấp có chung cơ sở); phiên là của tài khoản đăng nhập
 * nên tài khoản còn dùng ở tổ chức khác thì KHÔNG thu hồi từ đây (không gây tác dụng chéo tổ chức — cùng nguyên tắc `member.resetMfa`).
 */
export async function revokeAllSessions(
  ctx: CommandContext,
  input: { membershipId?: string },
): Promise<{ membershipId: string; revokedCount: number }> {
  const self =
    input.membershipId === undefined || input.membershipId.toLowerCase() === ctx.actor.membershipId;
  const denied = {
    action: "session.revoke_denied",
    entityType: "membership",
    ...(input.membershipId && UUID.test(input.membershipId)
      ? { entityId: input.membershipId.toLowerCase() }
      : {}),
  };
  let userId = ctx.actor.authUserId;
  let membershipId = ctx.actor.membershipId;
  if (!self) {
    const id = input.membershipId as string;
    authorizeOrAudit(() => authorize(ctx.actor, "session.revoke_other", {}), denied);
    if (!UUID.test(id)) throw new CommandError("NOT_FOUND", 404, t("access.member_not_found"));
    const m = await sql<{ auth_user_id: string | null; role: string; shared: boolean }>`
      select m.auth_user_id, m.role,
             (m.all_properties or exists (select 1 from property_scopes ps
                where ps.organization_id = m.organization_id and ps.membership_id = m.id
                  and (${ctx.actor.allProperties} or ps.property_id = any(${ctx.actor.propertyIds}::uuid[])))) as shared
      from memberships m where m.organization_id = ${ctx.actor.orgId} and m.id = ${id}`.execute(ctx.trx);
    const target = m.rows[0];
    if (!target) throw new CommandError("NOT_FOUND", 404, t("access.member_not_found"));
    if (ctx.actor.role === "manager") {
      if (!target.shared) throw new CommandError("NOT_FOUND", 404, t("access.member_not_found"));
      authorizeOrAudit(() => {
        if (!MANAGER_REVOKABLE.has(target.role))
          throw new AuthzError("FORBIDDEN", t("access.sessions_revoke_manager_scope"));
      }, denied);
    }
    if (!target.auth_user_id) throw new CommandError("INVALID_TRANSITION", 409, t("access.member_no_login"));
    const elsewhere = await sql<{ n: number }>`
      select app.memberships_elsewhere(${target.auth_user_id}::uuid, ${ctx.actor.orgId}::uuid) as n`.execute(
      ctx.trx,
    );
    if ((elsewhere.rows[0]?.n ?? 0) > 0)
      throw new CommandError("FORBIDDEN", 403, t("access.sessions_revoke_shared_account"), {
        extensions: { items: [{ recovery: "self_or_platform_support" }] },
      });
    userId = target.auth_user_id;
    membershipId = id.toLowerCase();
  }
  const revokedCount = await revokeUserSessions(ctx.trx, userId);
  await ctx.audit({
    action: "session.revoked",
    entityType: "membership",
    entityId: membershipId,
    after: { revoked_count: revokedCount, self },
  });
  await ctx.emit({
    eventType: "session.revoked",
    aggregateType: "membership",
    aggregateId: membershipId,
    payload: { membership_id: membershipId, revoked_count: revokedCount },
  });
  ctx.security({ event: "session.revoked", target: { type: "membership", id: membershipId } });
  return { membershipId, revokedCount };
}
