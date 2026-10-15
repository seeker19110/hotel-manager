// Ngữ cảnh tổ chức của phiên web (API-CONTRACT §1; SPEC-access-and-property S-020). Cookie/header chỉ để CHỌN trong
// số tổ chức người dùng có membership — mọi request vẫn tra membership (resolveActor), không tin ID client gửi.
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";
import { listMyOrganizations, type MyOrganization, type Role } from "./actor.ts";

export const ORG_HEADER = "x-org-id";

/**
 * Tên cookie chọn tổ chức. HTTPS → tiền tố `__Host-` (trình duyệt buộc Secure, Path=/, không Domain — chống ghi đè từ
 * subdomain); HTTP cục bộ/E2E không đặt được `__Host-` nên dùng tên thường.
 */
export function orgCookieName(secure: boolean): string {
  return secure ? "__Host-hm_org" : "hm_org";
}

/** Tổ chức được chọn nếu người dùng thật sự là thành viên còn hiệu lực; không thì null. */
export async function selectOrganization(
  db: Kysely<unknown>,
  authUserId: string,
  orgId: string,
): Promise<MyOrganization | null> {
  const mine = await listMyOrganizations(db, authUserId);
  return mine.find((o) => o.organizationId === orgId) ?? null;
}

/** Header `X-Org-Id` (API) ưu tiên hơn cookie (trang web). */
export function requestedOrgId(
  headerValue: string | null | undefined,
  cookieValue: string | null | undefined,
) {
  return headerValue?.trim() || cookieValue?.trim() || null;
}

export interface OrgContext {
  organization: { id: string; name: string };
  role: Role;
  /** Cơ sở đang chọn: theo yêu cầu, hoặc cơ sở duy nhất trong phạm vi; null nếu chưa chọn. */
  property: { id: string; name: string } | null;
  /** Các cơ sở trong phạm vi của membership (để UI cho chọn). */
  properties: { id: string; name: string }[];
}

/**
 * Ngữ cảnh {tổ chức, cơ sở, vai trò} cho `session.switchOrganization` (SPEC-access-and-property S-020). Không phải
 * thành viên, hoặc cơ sở yêu cầu ngoài phạm vi → null (route trả 404, không phân biệt).
 */
export async function organizationContext(
  db: Kysely<unknown>,
  authUserId: string,
  orgId: string,
  propertyId?: string | null,
): Promise<OrgContext | null> {
  const org = await selectOrganization(db, authUserId, orgId);
  if (!org) return null;
  const properties = await withTenant(db, { orgId, actorId: org.membershipId }, async (trx) => {
    const r = await sql<{ id: string; name: string }>`
      select p.id, p.name from properties p
      join memberships m on m.organization_id = p.organization_id and m.id = ${org.membershipId}
      where p.organization_id = ${orgId} and p.archived_at is null
        and (m.all_properties or exists (
          select 1 from property_scopes ps
          where ps.organization_id = m.organization_id and ps.membership_id = m.id and ps.property_id = p.id))
      order by p.name`.execute(trx);
    return r.rows;
  });
  let property: OrgContext["property"] = null;
  if (propertyId) {
    property = properties.find((p) => p.id === propertyId) ?? null;
    if (!property) return null;
  } else if (properties.length === 1) {
    property = properties[0] ?? null;
  }
  return {
    organization: { id: org.organizationId, name: org.organizationName },
    role: org.role,
    property,
    properties,
  };
}
