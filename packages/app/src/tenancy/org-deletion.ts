// Vòng đời xoá TỔ CHỨC (PLAN T-2312; IND-SAAS-006, UX-CONTENT-005; D-125) trên migration 0070.
// - Yêu cầu (`requestOrgDeletion`): chỉ owner active, xác thực lại như DSAR (`isRecentReauth` — phiên ≤ 5 phút hoặc vừa nhập đúng
//   mật khẩu; lớp HTTP quyết mốc). Tổ chức ⇒ `pending_deletion`, hạn purge = +30 ngày (CSDL đặt, CHECK giữ ≥ 30 ngày). Idempotent:
//   đã chờ xoá ⇒ trả trạng thái hiện có. Trong thời gian giữ, `resolveActor` khoá mọi truy cập trừ xuất dữ liệu + trạng thái/huỷ.
// - Huỷ (`cancelOrgDeletion`): một bước, chỉ owner; tổ chức về `active` ngay.
// - Purge (`purgeDueOrganizations`, job `tenancy.purge`): tổ chức tới hạn theo đồng hồ CSDL ⇒ lấy khoá object (`<org>/…`), xoá object
//   TRƯỚC rồi mới gọi `app.purge_organization` (xoá mọi bảng theo tổ chức + chứng nhận). Lỗi kho ⇒ bỏ qua tổ chức đó, lượt sau thử
//   lại; một tổ chức lỗi không chặn tổ chức khác. TẮT mặc định khi NODE_ENV=production (grant `data_delete hard_delete=false` trong
//   PLAN) — `orgPurgeEnabled`.
// - Chứng nhận (`listOrgDeletionCertificates`): chỉ người yêu cầu đọc (RLS theo `app.user_id`), còn sau khi tổ chức đã bị xoá.
import { withTenant, withUserContext } from "@hm/db";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../actor-core/index.ts";
import type { ObjectStorage } from "../files/index.ts";
import { isRecentReauth } from "../privacy/index.ts";

/** Số ngày giữ trước khi purge — CSDL (0070) đặt `deletion_due_at = now() + 30 ngày` và CHECK ≥ 30 ngày; test khớp hằng này. */
export const ORG_DELETION_GRACE_DAYS = 30;

export type OrgDeletionErrorCode = "FORBIDDEN" | "REAUTH_REQUIRED";

export class OrgDeletionError extends Error {
  readonly code: OrgDeletionErrorCode;
  constructor(code: OrgDeletionErrorCode) {
    super(code);
    this.name = "OrgDeletionError";
    this.code = code;
  }
}

export interface OrgDeletionStatus {
  organizationId: string;
  organizationName: string;
  status: "active" | "suspended" | "pending_deletion";
  requestedAt: Date | null;
  dueAt: Date | null;
  /** Người đang xem chính là người đã yêu cầu xoá. */
  requestedByMe: boolean;
}

const tenantOf = (actor: Actor) => ({ orgId: actor.orgId, actorId: actor.membershipId });

/** Trạng thái vòng đời của tổ chức trong ngữ cảnh `actor` (gọi với actor đã resolve bằng `allowPendingDeletion`). */
export async function orgDeletionStatus(db: Kysely<unknown>, actor: Actor): Promise<OrgDeletionStatus> {
  const r = await withTenant(db, tenantOf(actor), (trx) =>
    sql<{
      id: string;
      name: string;
      status: OrgDeletionStatus["status"];
      deletion_requested_at: Date | null;
      deletion_due_at: Date | null;
      deletion_requested_by: string | null;
    }>`
      select id, name, status, deletion_requested_at, deletion_due_at, deletion_requested_by
      from organizations where id = ${actor.orgId}`.execute(trx),
  );
  const o = r.rows[0];
  if (!o) throw new OrgDeletionError("FORBIDDEN");
  return {
    organizationId: o.id,
    organizationName: o.name,
    status: o.status,
    requestedAt: o.deletion_requested_at,
    dueAt: o.deletion_due_at,
    requestedByMe: o.deletion_requested_by === actor.authUserId,
  };
}

export interface RequestOrgDeletionInput {
  /** Lần xác thực lại gần nhất (phiên mới tạo hoặc vừa nhập đúng mật khẩu). */
  reauthenticatedAt: Date | null | undefined;
  correlationId: string;
  now?: Date;
}

export interface RequestOrgDeletionResult {
  status: "created" | "existing";
  requestedAt: Date;
  dueAt: Date;
}

/** Owner yêu cầu xoá tổ chức. Không phải owner ⇒ FORBIDDEN; thiếu xác thực lại ⇒ REAUTH_REQUIRED. */
export async function requestOrgDeletion(
  db: Kysely<unknown>,
  actor: Actor,
  input: RequestOrgDeletionInput,
): Promise<RequestOrgDeletionResult> {
  if (actor.role !== "owner") throw new OrgDeletionError("FORBIDDEN");
  if (!isRecentReauth(input.reauthenticatedAt, input.now ?? new Date()))
    throw new OrgDeletionError("REAUTH_REQUIRED");
  const r = await withTenant(db, tenantOf(actor), (trx) =>
    sql<{ status: string; requested_at: Date; due_at: Date; created: boolean }>`
      select * from app.org_request_deletion(${input.correlationId})`.execute(trx),
  );
  const row = r.rows[0];
  if (!row) throw new OrgDeletionError("FORBIDDEN");
  return { status: row.created ? "created" : "existing", requestedAt: row.requested_at, dueAt: row.due_at };
}

/** Owner huỷ yêu cầu xoá (một bước). Trả false khi tổ chức không đang chờ xoá. */
export async function cancelOrgDeletion(
  db: Kysely<unknown>,
  actor: Actor,
  input: { correlationId: string },
): Promise<boolean> {
  if (actor.role !== "owner") throw new OrgDeletionError("FORBIDDEN");
  const r = await withTenant(db, tenantOf(actor), (trx) =>
    sql<{ ok: boolean }>`select app.org_cancel_deletion(${input.correlationId}) as ok`.execute(trx),
  );
  return r.rows[0]?.ok === true;
}

export interface OrgDeletionCertificate {
  id: string;
  organizationId: string;
  requestedAt: Date;
  dueAt: Date;
  purgedAt: Date;
  counts: Record<string, number>;
  totalRows: number;
  objectsDeleted: number;
  digest: string;
}

/** Chứng nhận xoá tổ chức mà CHÍNH người dùng đã yêu cầu (mới → cũ). */
export async function listOrgDeletionCertificates(
  db: Kysely<unknown>,
  userId: string,
): Promise<OrgDeletionCertificate[]> {
  return withUserContext(db, userId, async (trx) => {
    const r = await sql<{
      id: string;
      deleted_organization_id: string;
      requested_at: Date;
      due_at: Date;
      purged_at: Date;
      counts: Record<string, number>;
      total_rows: string;
      objects_deleted: number;
      digest: string;
    }>`
      select id, deleted_organization_id, requested_at, due_at, purged_at, counts, total_rows::text, objects_deleted, digest
      from org_deletion_certificates where requested_by = ${userId}::uuid
      order by purged_at desc, id desc limit 50`.execute(trx);
    return r.rows.map((c) => ({
      id: c.id,
      organizationId: c.deleted_organization_id,
      requestedAt: c.requested_at,
      dueAt: c.due_at,
      purgedAt: c.purged_at,
      counts: c.counts,
      totalRows: Number(c.total_rows),
      objectsDeleted: c.objects_deleted,
      digest: c.digest,
    }));
  });
}

/** Job purge mặc định: TẮT ở production (cần người + grant `data_delete hard_delete=true` — RUNBOOK), bật ở dev/test. */
export function orgPurgeEnabled(nodeEnv: string | undefined, override?: boolean): boolean {
  if (override !== undefined) return override;
  return nodeEnv !== "production";
}

export interface OrgPurgeDeps {
  storage: Pick<ObjectStorage, "delete">;
  now?: Date;
  limit?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface OrgPurgeResult {
  due: number;
  purged: number;
  failed: number;
  objectsDeleted: number;
}

/** Một lượt job `tenancy.purge`: purge các tổ chức đã quá hạn giữ (app_worker). */
export async function purgeDueOrganizations(
  workerDb: Kysely<unknown>,
  deps: OrgPurgeDeps,
): Promise<OrgPurgeResult> {
  const now = deps.now ?? new Date();
  const out: OrgPurgeResult = { due: 0, purged: 0, failed: 0, objectsDeleted: 0 };
  const due = await sql<{ id: string }>`
    select id from app.org_purge_due(${now}, ${deps.limit ?? 10})`.execute(workerDb);
  out.due = due.rows.length;
  for (const org of due.rows) {
    try {
      const keys = await sql<{ storage_key: string }>`
        select storage_key from app.org_purge_file_keys(${org.id}::uuid)`.execute(workerDb);
      // Hai pha như DSAR: object TRƯỚC (xoá thiếu object = lỗi ⇒ dừng tổ chức này, giữ hàng `files` để lượt sau thử lại).
      for (const k of keys.rows) await deps.storage.delete(k.storage_key);
      const r = await sql<{ res: { certificate_id: string; total_rows: number } | null }>`
        select app.purge_organization(${org.id}::uuid) as res`.execute(workerDb);
      const res = r.rows[0]?.res;
      if (res) {
        out.purged += 1;
        out.objectsDeleted += keys.rows.length;
        deps.log?.("tenancy.purged", {
          organization_id: org.id,
          certificate_id: res.certificate_id,
          total_rows: res.total_rows,
          objects_deleted: keys.rows.length,
        });
      }
    } catch (error) {
      out.failed += 1;
      deps.log?.("tenancy.purge_failed", { organization_id: org.id, error });
    }
  }
  if (out.due > 0) deps.log?.("tenancy.purge_run", { ...out });
  return out;
}
