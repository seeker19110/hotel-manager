// Vòng đời xoá tổ chức (T-2312; IND-SAAS-006, UX-CONTENT-005; D-121; migration 0072).
//  - `org.requestDeletion` (command, chỉ owner — ma trận `org.delete`): xác thực lại ≤ 5 phút (như exports), gõ lại ĐÚNG tên tổ chức ⇒
//    tổ chức chờ xoá 30 ngày (`deletion_due_at` = yêu cầu + 30 ngày, CHECK ở CSDL). Trong 30 ngày: chỉ đọc + xuất — pipeline chặn mọi lệnh
//    ghi khác bằng 423 ORG_PENDING_DELETION (`pipeline/command.ts`).
//  - `org.cancelDeletion` (command, chỉ owner): MỘT bước, không xác thực lại/gõ lại (huỷ không khó hơn đăng ký — UX-CONTENT-005). Đã tới
//    mốc purge ⇒ 409, không khôi phục nửa vời.
//  - Worker `tenancy.org_purge` (`processOrgPurges`): tổ chức tới hạn ⇒ xoá object theo tiền tố `<org>/` (trừ object mà bảng giữ tham
//    chiếu) rồi `app.org_purge_execute` (một transaction mỗi tổ chức): xoá/ẩn danh theo `app.org_purge_plan()`, ghi chứng nhận + audit.
//  - Chứng nhận: owner đã yêu cầu xoá đọc lại qua `app.org_deletion_my_certificates()` (theo người dùng của PHIÊN, không theo tổ chức —
//    tổ chức đã không còn thành viên nào).
import { withTenant } from "@hm/db";
import { authorize, MS_PER_MINUTE, secondsToMs } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../actor-core/index.ts";
import type { ObjectStorage } from "../files/index.ts";
import { t } from "../i18n.ts";
import { type CommandContext, CommandError } from "../pipeline/index.ts";

/** Thời gian giữ trước khi purge (công bố ở trang Xoá tổ chức, DPA, retention-policy RET-19). */
export const ORG_DELETION_GRACE_DAYS = 30;
/** Xác thực lại: như xuất dữ liệu (exports) và xoá tài khoản (DSAR). */
export const ORG_DELETION_REAUTH_MAX_AGE_SECONDS = 300;
/** Số tổ chức tối đa mỗi lượt job (mỗi tổ chức một transaction). */
export const ORG_PURGE_BATCH = 10;
const CLOCK_SKEW_MS = MS_PER_MINUTE;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OrgDeletionStatus {
  state: "active" | "pending";
  requestedAt: Date | null;
  dueAt: Date | null;
}

function assertRecentAuth(actor: Actor, now: Date): void {
  const at = actor.authenticatedAt?.getTime();
  if (
    at === undefined ||
    Number.isNaN(at) ||
    now.getTime() - at > secondsToMs(ORG_DELETION_REAUTH_MAX_AGE_SECONDS) ||
    at > now.getTime() + CLOCK_SKEW_MS
  )
    throw new CommandError("REAUTH_REQUIRED", 401, t("tenancy.org_deletion.reauth_required"));
}

const norm = (s: string) => s.normalize("NFC").trim();

/** Trạng thái xoá của tổ chức của actor (mọi vai trò đọc được — banner ở mọi trang). */
export async function orgDeletionStatus(db: Kysely<unknown>, actor: Actor): Promise<OrgDeletionStatus> {
  return withTenant(db, { orgId: actor.orgId }, async (trx) => {
    const r = await sql<{ requested_at: Date | null; due_at: Date | null }>`
      select deletion_requested_at as requested_at, deletion_due_at as due_at from organizations
      where id = ${actor.orgId}`.execute(trx);
    const row = r.rows[0];
    return row?.requested_at
      ? { state: "pending", requestedAt: row.requested_at, dueAt: row.due_at }
      : { state: "active", requestedAt: null, dueAt: null };
  });
}

/** `org.requestDeletion`: owner + xác thực lại ≤ 5 phút + gõ lại đúng tên tổ chức. */
export async function requestOrgDeletion(
  ctx: CommandContext,
  input: { confirmName: string; now?: Date },
): Promise<{ state: "pending"; requestedAt: string; dueAt: string }> {
  const now = input.now ?? new Date();
  authorize(ctx.actor, "org.delete");
  assertRecentAuth(ctx.actor, now);
  const orgId = ctx.actor.orgId;
  const cur = await sql<{ name: string; requested_at: Date | null }>`
    select name, deletion_requested_at as requested_at from organizations where id = ${orgId} for update`.execute(
    ctx.trx,
  );
  const org = cur.rows[0];
  if (!org) throw new CommandError("NOT_FOUND", 404, t("http.organization_not_found"));
  if (norm(input.confirmName) !== norm(org.name))
    throw new CommandError("CONFIRMATION_MISMATCH", 422, t("tenancy.org_deletion.confirmation_mismatch"));
  if (org.requested_at)
    throw new CommandError("ORG_PENDING_DELETION", 423, t("pipeline.org_pending_deletion"));
  const upd = await sql<{ requested_at: Date; due_at: Date }>`
    update organizations
    set deletion_requested_at = ${now}, deletion_due_at = ${now}::timestamptz + make_interval(days => ${ORG_DELETION_GRACE_DAYS}),
        deletion_requested_by = ${ctx.actor.authUserId}, version = version + 1
    where id = ${orgId}
    returning deletion_requested_at as requested_at, deletion_due_at as due_at`.execute(ctx.trx);
  const row = upd.rows[0] as { requested_at: Date; due_at: Date };
  await ctx.audit({
    action: "organization.deletion_requested",
    entityType: "organization",
    entityId: orgId,
    after: { due_at: row.due_at.toISOString() },
  });
  return { state: "pending", requestedAt: row.requested_at.toISOString(), dueAt: row.due_at.toISOString() };
}

/** `org.cancelDeletion`: một bước; chỉ khi còn trong 30 ngày (giờ CSDL). */
export async function cancelOrgDeletion(ctx: CommandContext): Promise<{ state: "active" }> {
  authorize(ctx.actor, "org.delete");
  const orgId = ctx.actor.orgId;
  const r = await sql<{ id: string; due_at: Date }>`
    with prev as (select id, deletion_due_at from organizations where id = ${orgId} for update)
    update organizations o
    set deletion_requested_at = null, deletion_due_at = null, deletion_requested_by = null, version = o.version + 1
    from prev
    where o.id = prev.id and prev.deletion_due_at is not null and prev.deletion_due_at > now() and o.deleted_at is null
    returning o.id, prev.deletion_due_at as due_at`.execute(ctx.trx);
  if (r.rows.length === 0)
    throw new CommandError("INVALID_TRANSITION", 409, t("tenancy.org_deletion.not_pending"));
  await ctx.audit({
    action: "organization.deletion_cancelled",
    entityType: "organization",
    entityId: orgId,
    before: { due_at: (r.rows[0] as { due_at: Date }).due_at.toISOString() },
  });
  return { state: "active" };
}

// ───────────────────────────── Purge (worker) ─────────────────────────────

export interface OrgPurgeResult {
  organizationId: string;
  certificate: Record<string, unknown> | null;
}

/** Danh sách khoá object theo tiền tố (ObjectStorage.listKeys) — tách để test/thay kho. */
export type OrgObjectStore = Pick<ObjectStorage, "listKeys" | "delete">;

/**
 * Purge MỘT tổ chức tới hạn. Thứ tự: object (ngoài CSDL, idempotent — 404 coi như đã xoá) → CSDL + chứng nhận (một transaction). Lỗi
 * giữa chừng: lượt sau làm lại từ đầu (object đã xoá không đếm lại — số trong chứng nhận là số xoá ở lượt hoàn tất, ghi rõ ở RUNBOOK).
 */
export async function purgeOrganization(
  workerDb: Kysely<unknown>,
  storage: OrgObjectStore | null,
  orgId: string,
  now: Date,
): Promise<OrgPurgeResult> {
  if (!UUID.test(orgId)) throw new Error("purgeOrganization: orgId is not a UUID");
  let deleted = 0;
  let retained = 0;
  if (storage) {
    const kept = await sql<{ storage_key: string }>`
      select storage_key from app.org_purge_kept_object_keys(${orgId}::uuid)`.execute(workerDb);
    const keep = new Set(kept.rows.map((r) => r.storage_key));
    for (const key of await storage.listKeys(`${orgId}/`)) {
      if (keep.has(key)) {
        retained++;
        continue;
      }
      await storage.delete(key);
      deleted++;
    }
  }
  const r = await sql<{ c: Record<string, unknown> | null }>`
    select app.org_purge_execute(${orgId}::uuid, ${now}, ${deleted}, ${retained}) as c`.execute(workerDb);
  return { organizationId: orgId, certificate: r.rows[0]?.c ?? null };
}

/** Job `tenancy.org_purge`: các tổ chức tới hạn (≤ ORG_PURGE_BATCH/lượt), mỗi tổ chức độc lập; lỗi một tổ chức không chặn tổ chức khác. */
export async function processOrgPurges(
  workerDb: Kysely<unknown>,
  storage: OrgObjectStore | null,
  opts: { now?: Date; limit?: number; log?: (event: string, fields: Record<string, unknown>) => void } = {},
): Promise<{ purged: number; failed: number }> {
  const now = opts.now ?? new Date();
  const due = await sql<{ organization_id: string }>`
    select organization_id from app.org_deletion_due(${now}, ${opts.limit ?? ORG_PURGE_BATCH})`.execute(
    workerDb,
  );
  let purged = 0;
  let failed = 0;
  for (const { organization_id } of due.rows) {
    try {
      const res = await purgeOrganization(workerDb, storage, organization_id, now);
      if (res.certificate) purged++;
      opts.log?.("org.purged", { organization_id });
    } catch (err) {
      failed++;
      opts.log?.("org.purge_failed", {
        organization_id,
        err: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return { purged, failed };
}

// ───────────────────────────── Chứng nhận ─────────────────────────────

export interface OrgDeletionCertificate {
  id: string;
  organizationId: string;
  requestedAt: Date;
  dueAt: Date;
  purgedAt: Date;
  /** Văn bản JSON đúng như đã băm — tải về nguyên văn. */
  content: string;
  contentSha256: string;
}

/** Chứng nhận xoá của các tổ chức mà CHÍNH người dùng này đã yêu cầu xoá (id người dùng của phiên đã xác minh). */
export async function myOrgDeletionCertificates(
  db: Kysely<unknown>,
  authUserId: string,
): Promise<OrgDeletionCertificate[]> {
  if (!UUID.test(authUserId)) return [];
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.auth_user_id', ${authUserId}, true)`.execute(trx);
    const r = await sql<{
      id: string;
      organization_id: string;
      requested_at: Date;
      due_at: Date;
      purged_at: Date;
      content: string;
      content_sha256: string;
    }>`select * from app.org_deletion_my_certificates()`.execute(trx);
    return r.rows.map((x) => ({
      id: x.id,
      organizationId: x.organization_id,
      requestedAt: x.requested_at,
      dueAt: x.due_at,
      purgedAt: x.purged_at,
      content: x.content,
      contentSha256: x.content_sha256,
    }));
  });
}
