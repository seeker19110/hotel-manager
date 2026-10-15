// Xác định "người đang thao tác" cho mỗi request (ARCHITECTURE bước 2, SPEC-access-and-property).
// Quyền KHÔNG lấy từ token: tra `memberships` mỗi lần, nên thu hồi có hiệu lực ngay ở request kế tiếp.
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";

export type Role =
  | "owner"
  | "manager"
  | "front_desk"
  | "accountant"
  | "housekeeping"
  | "maintenance"
  | "tenant"
  | "platform_support";

export interface Actor {
  authUserId: string;
  orgId: string;
  membershipId: string;
  personId: string;
  role: Role;
  allProperties: boolean;
  propertyIds: readonly string[];
  limits: Readonly<Record<string, number>>;
  mfaRequired: boolean;
}

export type AccessErrorCode = "UNAUTHENTICATED" | "NOT_FOUND" | "MFA_REQUIRED";

export class AccessError extends Error {
  readonly code: AccessErrorCode;
  readonly status: 401 | 403 | 404;
  constructor(code: AccessErrorCode, message: string) {
    super(message);
    this.name = "AccessError";
    this.code = code;
    this.status = code === "UNAUTHENTICATED" ? 401 : code === "NOT_FOUND" ? 404 : 403;
  }
}

/** Vai trò có quyền tiền/quản trị bắt buộc MFA (kế hoạch §16; access Q-06 — chủ dự án duyệt 2026-10-15). */
const MFA_ROLES: ReadonlySet<Role> = new Set(["owner", "manager", "accountant", "front_desk"]);

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
  const r = await sql<{
    organization_id: string;
    organization_name: string;
    membership_id: string;
    role: Role;
  }>`
    select * from app.list_my_organizations(${authUserId}::uuid)`.execute(db);
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
  input: { authUserId: string | null | undefined; orgId: string; twoFactorEnabled: boolean },
): Promise<Actor> {
  if (!input.authUserId) throw new AccessError("UNAUTHENTICATED", "Cần đăng nhập");
  const authUserId = input.authUserId;
  const UUID = /^[0-9a-f-]{36}$/i;
  if (!UUID.test(input.orgId)) throw new AccessError("NOT_FOUND", "Không tìm thấy tổ chức");

  const row = await withTenant(db, { orgId: input.orgId }, async (trx) => {
    const r = await sql<{
      id: string;
      person_id: string;
      role: Role;
      all_properties: boolean;
      limits: Record<string, number>;
      property_ids: string[] | null;
    }>`
      select m.id, m.person_id, m.role, m.all_properties, m.limits,
             array_remove(array_agg(ps.property_id), null)::text[] as property_ids
      from memberships m
      left join property_scopes ps on ps.membership_id = m.id and ps.organization_id = m.organization_id
      where m.auth_user_id = ${authUserId}::uuid and m.status = 'active'
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      group by m.id`.execute(trx);
    return r.rows[0];
  });
  if (!row) throw new AccessError("NOT_FOUND", "Không tìm thấy tổ chức");

  const actor: Actor = {
    authUserId,
    orgId: input.orgId,
    membershipId: row.id,
    personId: row.person_id,
    role: row.role,
    allProperties: row.all_properties,
    propertyIds: row.property_ids ?? [],
    limits: row.limits,
    mfaRequired: requiresMfa(row.role, row.limits),
  };
  if (actor.mfaRequired && !input.twoFactorEnabled) {
    throw new AccessError("MFA_REQUIRED", "Vai trò này cần bật xác thực hai lớp trước khi thao tác");
  }
  return actor;
}
