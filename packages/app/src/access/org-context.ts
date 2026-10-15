// Ngữ cảnh tổ chức của phiên web (API-CONTRACT §1; SPEC-access-and-property S-020). Cookie/header chỉ để CHỌN trong
// số tổ chức người dùng có membership — mọi request vẫn tra membership (resolveActor), không tin ID client gửi.
import type { Kysely } from "kysely";
import { listMyOrganizations, type MyOrganization } from "./actor.ts";

export const ORG_COOKIE = "hm_org";
export const ORG_HEADER = "x-org-id";

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
