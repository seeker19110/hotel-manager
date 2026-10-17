// Lời mời nhân viên (SPEC-access S-007, S-008, S-021; ERD `invitations`; Q-05: hạn 7 ngày, dùng một lần, gắn email).
// - Token 256 bit dẫn xuất tất định: HMAC(khoá, id lời mời). CSDL chỉ giữ băm SHA-256 của token; token KHÔNG nằm ở outbox, log,
//   audit hay phản hồi API — worker dựng lại khi gửi email (`sendInvitationEmail`). Người cầm token + đăng nhập đúng email mới nhận được.
// - Một (email, vai trò) chỉ một lời mời đang chờ (unique một phần). Lời mời quá hạn tự đóng khi mời lại cùng email/vai trò.
// - Quyền: owner mời mọi vai trò; manager chỉ front_desk/housekeeping/maintenance, trong phạm vi cơ sở và hạn mức của chính mình
//   (không trao nhiều hơn mình có). Bị từ chối ⇒ 403 + audit `member.invite_denied` (S-018).
import { createHash, createHmac, hkdfSync, randomUUID } from "node:crypto";
import { withTenantRetry } from "@hm/db";
import { AuthzError, authorize, effectiveLimit } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import { type CommandContext, CommandError, fieldError } from "../pipeline/index.ts";
import { authorizeOrAudit } from "./denied.ts";

export const INVITATION_TTL_DAYS = 7;
export const INVITE_ROLES = [
  "owner",
  "manager",
  "front_desk",
  "accountant",
  "housekeeping",
  "maintenance",
] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];
const SENIOR: ReadonlySet<string> = new Set(["owner", "manager", "accountant"]);
/** Vai trò có thể có phạm vi "mọi cơ sở" (ck_memberships_all_properties). */
export const ALL_PROPERTIES_ROLES: ReadonlySet<string> = new Set(["owner", "accountant"]);
export const LIMIT_KEYS = ["discount", "refund", "price_override"] as const;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

export const ROLE_LABEL: Readonly<Record<string, string>> = {
  owner: "chủ sở hữu",
  manager: "quản lý",
  front_desk: "lễ tân",
  accountant: "kế toán",
  housekeeping: "buồng phòng",
  maintenance: "kỹ thuật",
};

/** Khoá dẫn xuất token lời mời: HKDF-SHA256 từ bí mật phiên với nhãn riêng. Xoay `BETTER_AUTH_SECRET` ⇒ lời mời đang chờ mất hiệu lực. */
export function invitationKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "hm-invitation-v1", 32));
}

/** Token (43 ký tự base64url) của một lời mời. */
export function invitationToken(key: Buffer, invitationId: string): string {
  return createHmac("sha256", key).update(`invitation\0${invitationId.toLowerCase()}`).digest("base64url");
}

export function hashInvitationToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return e.length <= 320 && EMAIL.test(e) ? e : null;
}

export interface InviteInput {
  email: string;
  role: InviteRole;
  propertyIds: readonly string[];
  limits: { [K in (typeof LIMIT_KEYS)[number]]?: number | undefined };
}

export async function inviteMember(
  ctx: CommandContext,
  key: Buffer,
  input: InviteInput,
): Promise<{ invitationId: string; expiresAt: string }> {
  const propertyIds = [...new Set(input.propertyIds.map((p) => p.toLowerCase()))];
  const denied = {
    action: "member.invite_denied",
    entityType: "invitation",
    after: { role: input.role, property_ids: propertyIds, limits: input.limits },
  };
  authorizeOrAudit(() => {
    authorize(ctx.actor, SENIOR.has(input.role) ? "member.invite_senior" : "member.invite_staff", {});
    for (const p of propertyIds) authorize(ctx.actor, "member.invite_staff", { propertyId: p });
    // Không trao nhiều hơn mình có: manager (không phải owner) bị chặn trần theo hạn mức hiệu lực của chính mình.
    if (ctx.actor.role !== "owner") {
      for (const k of LIMIT_KEYS) {
        const v = input.limits[k];
        if (v !== undefined && v > effectiveLimit(ctx.actor, k))
          throw new AuthzError("FORBIDDEN", "Không được trao hạn mức vượt hạn mức của chính bạn");
      }
    }
  }, denied);

  const email = normalizeEmail(input.email);
  if (!email) throw fieldError("email", "invalid", "Email không hợp lệ");
  if (input.role === "owner" && propertyIds.length > 0)
    throw fieldError("property_ids", "not_allowed", "Chủ sở hữu luôn có mọi cơ sở");
  if (!ALL_PROPERTIES_ROLES.has(input.role) && propertyIds.length === 0)
    throw fieldError("property_ids", "required", "Vai trò này cần chọn ít nhất một cơ sở");
  if (propertyIds.length > 0) {
    const found = await sql<{ n: number }>`
      select count(*)::int as n from properties
      where organization_id = ${ctx.actor.orgId} and id = any(${propertyIds}::uuid[]) and archived_at is null`.execute(
      ctx.trx,
    );
    if ((found.rows[0]?.n ?? 0) !== propertyIds.length)
      throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  }

  // Đã là thành viên (còn hiệu lực/tạm khoá) của tổ chức này ⇒ không mời lại.
  const member = await sql<{ id: string }>`
    select m.id from memberships m join auth."user" u on u.id = m.auth_user_id
    where m.organization_id = ${ctx.actor.orgId} and lower(btrim(u.email)) = ${email}
      and m.status in ('invited','active','suspended')`.execute(ctx.trx);
  if (member.rows[0])
    throw new CommandError("DUPLICATE", 409, "Email này đã là thành viên của tổ chức", {
      extensions: { errors: [{ path: "email", field: "email", code: "member_exists" }] },
    });
  // Lời mời đang chờ đã quá hạn thì đóng (giải phóng unique một phần); còn hạn ⇒ trùng.
  await sql`update invitations set status = 'expired'
            where organization_id = ${ctx.actor.orgId} and lower(email) = ${email} and role = ${input.role}
              and status = 'pending' and expires_at <= now()`.execute(ctx.trx);
  const pending = await sql<{ id: string }>`
    select id from invitations where organization_id = ${ctx.actor.orgId} and lower(email) = ${email} and role = ${input.role}
      and status = 'pending'`.execute(ctx.trx);
  if (pending.rows[0])
    throw new CommandError("DUPLICATE", 409, "Đã có lời mời đang chờ cho email và vai trò này", {
      extensions: { errors: [{ path: "email", field: "email", code: "pending_invitation" }] },
    });

  const invitationId = randomUUID();
  const hash = hashInvitationToken(invitationToken(key, invitationId));
  const ins = await sql<{ expires_at: Date }>`
    insert into invitations (id, organization_id, email, role, property_ids, limits, token_hash, expires_at, invited_by)
    values (${invitationId}, ${ctx.actor.orgId}, ${email}, ${input.role}, ${propertyIds}::uuid[],
            ${JSON.stringify(input.limits)}::jsonb, ${hash}, now() + make_interval(days => ${INVITATION_TTL_DAYS}),
            ${ctx.actor.membershipId})
    returning expires_at`.execute(ctx.trx);
  const expiresAt = (ins.rows[0] as { expires_at: Date }).expires_at.toISOString();
  await ctx.audit({
    action: "member.invited",
    entityType: "invitation",
    entityId: invitationId,
    after: { role: input.role, property_ids: propertyIds, limits: input.limits, expires_at: expiresAt },
  });
  await ctx.emit({
    eventType: "member.invited",
    aggregateType: "invitation",
    aggregateId: invitationId,
    payload: { invitation_id: invitationId },
  });
  ctx.security({ event: "member.invited", target: { type: "invitation", id: invitationId } });
  return { invitationId, expiresAt };
}

// ——— Gửi email (worker; consumer của outbox `member.invited`) ———

export interface InvitationMail {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}

/**
 * Dựng email lời mời cho một lời mời còn hiệu lực (đọc trong ngữ cảnh đúng tổ chức). Trả null khi không còn gì để gửi (đã dùng, thu hồi,
 * quá hạn, hoặc không còn). Token đi trong FRAGMENT (`#token=`) nên không vào nhật ký máy chủ/referrer.
 */
export async function buildInvitationMail(
  workerDb: Kysely<unknown>,
  job: { organization_id: string; payload: Record<string, unknown> },
  opts: { key: Buffer; baseUrl: string },
): Promise<InvitationMail | null> {
  const id = job.payload.invitation_id;
  if (typeof id !== "string") throw new Error("payload thiếu invitation_id");
  const r = await withTenantRetry(workerDb, { orgId: job.organization_id }, (trx) =>
    sql<{ email: string; role: string; org_name: string; ok: boolean }>`
      select i.email, i.role, o.name as org_name, (i.status = 'pending' and i.expires_at > now()) as ok
      from invitations i join organizations o on o.id = i.organization_id
      where i.organization_id = ${job.organization_id} and i.id = ${id}`.execute(trx),
  );
  const row = r.rows[0];
  if (!row?.ok) return null;
  const link = `${opts.baseUrl.replace(/\/+$/, "")}/loi-moi#token=${invitationToken(opts.key, id)}`;
  const role = ROLE_LABEL[row.role] ?? row.role;
  const org = row.org_name
    .replace(/\p{Cc}+/gu, " ")
    .trim()
    .slice(0, 200);
  return {
    to: row.email,
    subject: `${org} mời bạn tham gia với vai trò ${role}`,
    text: [
      `${org} mời bạn tham gia quản lý với vai trò ${role}.`,
      "",
      `Mở liên kết sau và đăng nhập bằng đúng email này để chấp nhận (liên kết dùng một lần, hết hạn sau ${INVITATION_TTL_DAYS} ngày):`,
      link,
      "",
      "Nếu bạn không biết lời mời này, hãy bỏ qua email.",
    ].join("\n"),
    idempotencyKey: id,
  };
}
