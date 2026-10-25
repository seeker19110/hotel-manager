// Xác định "người đang thao tác" cho mỗi request (ARCHITECTURE bước 2, SPEC-access-and-property).
// Quyền KHÔNG lấy từ token: tra `memberships` mỗi lần, nên thu hồi có hiệu lực ngay ở request kế tiếp.
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";
import { AccessError, type Actor, type Role } from "../actor-core/index.ts";
import { t } from "../i18n.ts";

// Kiểu Actor/Role và AccessError nằm ở `actor-core` (module nền, tránh vòng access<->pipeline); xuất lại để giữ đường import cũ.
export { AccessError, type AccessErrorCode, type Actor, type Role } from "../actor-core/index.ts";

/** Vai trò có quyền tiền/quản trị bắt buộc MFA (kế hoạch §16; access Q-06 — chủ dự án duyệt 2026-10-15). */
// `platform_support` (F-015): đọc dữ liệu của tổ chức khác ⇒ luôn bắt MFA.
const MFA_ROLES: ReadonlySet<Role> = new Set([
  "owner",
  "manager",
  "accountant",
  "front_desk",
  "platform_support",
]);

export function requiresMfa(role: Role, limits: Readonly<Record<string, number>>): boolean {
  return MFA_ROLES.has(role) || Object.values(limits).some((v) => typeof v === "number" && v > 0);
}

export interface MyOrganization {
  organizationId: string;
  organizationName: string;
  membershipId: string;
  role: Role;
}

export async function listMyOrganizations(
  db: Kysely<unknown>,
  authUserId: string,
): Promise<MyOrganization[]> {
  // Tenant chưa chứng minh email không thấy tổ chức nào (cùng điều kiện với resolveActor — AUD-SEC-001, D-081).
  const r = await sql<{
    organization_id: string;
    organization_name: string;
    membership_id: string;
    role: Role;
  }>`
    select o.* from app.list_my_organizations(${authUserId}::uuid) o
    where o.role <> 'tenant' or exists (select 1 from auth."user" u where u.id = ${authUserId}::uuid and u."emailVerified")`.execute(
    db,
  );
  return r.rows.map((x) => ({
    organizationId: x.organization_id,
    organizationName: x.organization_name,
    membershipId: x.membership_id,
    role: x.role,
  }));
}

/**
 * Membership còn hiệu lực của người dùng trong tổ chức được chọn; không có → NOT_FOUND (không phân biệt
 * "không tồn tại" với "không phải thành viên" — API-CONTRACT §2). Thiếu MFA khi bắt buộc → MFA_REQUIRED.
 */
export async function resolveActor(
  db: Kysely<unknown>,
  input: {
    authUserId: string | null | undefined;
    orgId: string;
    twoFactorEnabled: boolean;
    authenticatedAt?: Date | undefined;
  },
): Promise<Actor> {
  if (!input.authUserId) throw new AccessError("UNAUTHENTICATED", t("http.unauthenticated"));
  const authUserId = input.authUserId;
  const UUID = /^[0-9a-f-]{36}$/i;
  if (!UUID.test(input.orgId)) throw new AccessError("NOT_FOUND", t("http.organization_not_found"));

  // AUD-SEC-001 (D-081): quyền người thuê chỉ có hiệu lực khi email đã được chứng minh (OTP gửi tới hộp thư). Đăng ký mật khẩu không
  // xác minh email, nên kẻ lập tài khoản trước bằng email nạn nhân không dùng được lời mời dành cho nạn nhân (`u."emailVerified"` bên dưới).
  // F-015 (D-122): hỗ trợ nền tảng chỉ là actor khi có truy cập hỗ trợ CÒN HIỆU LỰC (chưa thu hồi, chưa hết hạn — giờ CSDL).
  const row = await withTenant(db, { orgId: input.orgId }, async (trx) => {
    const r = await sql<{
      id: string;
      person_id: string;
      role: Role;
      all_properties: boolean;
      limits: Record<string, number>;
      role_limits: Record<string, number> | null;
      property_ids: string[] | null;
      grant_id: string | null;
      grant_reason: string | null;
      grant_expires_at: Date | null;
    }>`
      select m.id, m.person_id, m.role, m.all_properties, m.limits,
             o.settings -> 'role_limits' -> m.role as role_limits,
             array_remove(array_agg(ps.property_id), null)::text[] as property_ids,
             g.id as grant_id, g.reason as grant_reason, g.expires_at as grant_expires_at
      from memberships m
      join organizations o on o.id = m.organization_id
      join auth."user" u on u.id = m.auth_user_id
      left join property_scopes ps on ps.membership_id = m.id and ps.organization_id = m.organization_id
      left join support_grants g on g.organization_id = m.organization_id and g.grantee_membership_id = m.id
        and g.revoked_at is null and g.expires_at > now()
      where m.auth_user_id = ${authUserId}::uuid and m.status = 'active'
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and (m.role <> 'tenant' or u."emailVerified")
        and (m.role <> 'platform_support' or g.id is not null)
      group by m.id, o.settings, g.id`.execute(trx);
    return r.rows[0];
  });
  if (!row) throw new AccessError("NOT_FOUND", t("http.organization_not_found"));

  // Hạn mức 3 tầng (ERD 7.1 #9): mặc định trong mã (DEFAULT_LIMITS, authorize) < theo vai trò của tổ chức
  // (`organizations.settings.role_limits.<role>`) < ghi đè của membership (`memberships.limits`).
  const roleLimits = row.role_limits && typeof row.role_limits === "object" ? row.role_limits : {};
  const limits: Record<string, number> = { ...roleLimits, ...row.limits };
  const actor: Actor = {
    authUserId,
    orgId: input.orgId,
    membershipId: row.id,
    personId: row.person_id,
    role: row.role,
    allProperties: row.all_properties,
    propertyIds: row.property_ids ?? [],
    limits,
    mfaRequired: requiresMfa(row.role, limits),
    ...(input.authenticatedAt ? { authenticatedAt: input.authenticatedAt } : {}),
    ...(row.role === "platform_support" && row.grant_id && row.grant_reason && row.grant_expires_at
      ? { supportGrant: { id: row.grant_id, reason: row.grant_reason, expiresAt: row.grant_expires_at } }
      : {}),
  };
  if (actor.mfaRequired && !input.twoFactorEnabled) {
    throw new AccessError("MFA_REQUIRED", t("access.mfa_required"));
  }
  return actor;
}
