// Ngữ cảnh tổ chức của phiên web (API-CONTRACT §1; SPEC-access-and-property S-020). Cookie/header chỉ để CHỌN trong
// số tổ chức người dùng có membership — mọi request vẫn tra membership (resolveActor), không tin ID client gửi.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";
import { hashPayload } from "../pipeline/command.ts";
import { listMyOrganizations, type MyOrganization, type Role } from "./actor.ts";

export const ORG_HEADER = "x-org-id";
/** Ngữ cảnh tổ chức mà trang web đang hiển thị (SPEC-portal S-013) — khác tổ chức của request ⇒ 409 CONTEXT_CHANGED. */
export const ORG_CONTEXT_HEADER = "x-org-context";

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
  } else {
    // Cơ sở đã chọn lần trước (T-224) — chỉ dùng nếu vẫn trong phạm vi hiện tại; không phải quyền.
    const saved = await withTenant(db, { orgId, actorId: org.membershipId }, (trx) =>
      sql<{ id: string | null }>`
        select selected_property_id as id from memberships where organization_id = ${orgId} and id = ${org.membershipId}`.execute(
        trx,
      ),
    );
    const id = saved.rows[0]?.id;
    property = (id && properties.find((p) => p.id === id)) || null;
  }
  return {
    organization: { id: org.organizationId, name: org.organizationName },
    role: org.role,
    property,
    properties,
  };
}

const SWITCH_COMMAND = "session.switchOrganization";

export type SwitchResult =
  | { kind: "committed"; context: OrgContext; replayed: boolean }
  | { kind: "not_found" }
  | { kind: "conflict" };

/**
 * `session.switchOrganization` với idempotency đúng API-CONTRACT §1: key đã dùng (trong bất kỳ tổ chức nào của chính
 * người dùng) + cùng payload → trả kết quả cũ; khác payload → IDEMPOTENCY_CONFLICT. Kết quả lưu ở `idempotency_keys`
 * của tổ chức đích nên `GET /commands/{id}` (ngữ cảnh tổ chức đó) tra được. Không thành viên / cơ sở ngoài phạm vi →
 * not_found (không lưu, giống lệnh không tồn tại).
 */
export async function switchOrganization(
  db: Kysely<unknown>,
  authUserId: string,
  input: { key: string; organizationId: string; propertyId: string | null; correlationId: string },
): Promise<SwitchResult> {
  const key = input.key.toLowerCase();
  const hash = hashPayload(SWITCH_COMMAND, {
    organization_id: input.organizationId,
    property_id: input.propertyId,
  });
  const mine = await listMyOrganizations(db, authUserId);

  const lookup = async (org: MyOrganization) =>
    withTenant(db, { orgId: org.organizationId, actorId: org.membershipId }, async (trx) => {
      const r = await sql<{
        request_hash: Buffer;
        response: { data?: { context?: OrgContext } } | null;
        mine: boolean;
      }>`
        select k.request_hash, k.response, (k.actor_person_id = m.person_id) as mine
        from idempotency_keys k join memberships m on m.organization_id = k.organization_id and m.id = ${org.membershipId}
        where k.organization_id = ${org.organizationId} and k.key = ${key}`.execute(trx);
      return r.rows[0];
    });
  const replayOrConflict = (row: NonNullable<Awaited<ReturnType<typeof lookup>>>): SwitchResult => {
    const context = row.response?.data?.context;
    if (!row.mine || !Buffer.from(row.request_hash).equals(hash) || !context) return { kind: "conflict" };
    return { kind: "committed", context, replayed: true };
  };

  for (const org of mine) {
    const row = await lookup(org);
    if (row) return replayOrConflict(row);
  }

  const target = mine.find((o) => o.organizationId === input.organizationId);
  if (!target) return { kind: "not_found" };
  const context = await organizationContext(db, authUserId, input.organizationId, input.propertyId);
  if (!context) return { kind: "not_found" };

  const inserted = await withTenant(
    db,
    { orgId: target.organizationId, actorId: target.membershipId },
    async (trx) => {
      const r = await sql<{ id: string }>`
      insert into idempotency_keys (id, organization_id, key, command, actor_person_id, request_hash, correlation_id,
                                    status, http_status, response, completed_at)
      select ${randomUUID()}, ${target.organizationId}, ${key}, ${SWITCH_COMMAND}, m.person_id, ${hash}, ${input.correlationId},
             'committed', 200, ${JSON.stringify({ data: { context } })}::jsonb, now()
      from memberships m where m.organization_id = ${target.organizationId} and m.id = ${target.membershipId}
      on conflict (organization_id, key) do nothing
      returning id`.execute(trx);
      // Lưu cơ sở vừa chọn (cùng transaction với kết quả idempotency) — lần đăng nhập/chuyển sau mặc định về cơ sở này.
      if (r.rows.length > 0 && input.propertyId)
        await sql`select app.select_property(${input.propertyId}::uuid)`.execute(trx);
      return r.rows.length > 0;
    },
  );
  if (!inserted) {
    // Hai request cùng key chạy song song: bên thua đọc lại kết quả của bên thắng.
    const row = await lookup(target);
    return row ? replayOrConflict(row) : { kind: "conflict" };
  }
  return { kind: "committed", context, replayed: false };
}
