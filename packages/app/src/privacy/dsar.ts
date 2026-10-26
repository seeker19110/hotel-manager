// Quyền của chủ thể với TÀI KHOẢN (PLAN T-2311; STD-PRIV-004, CMP-VN-007, CMP-INTL-007, CMP-RIGHTS-007, CMP-PRIV-005; D-123) trên
// `dsar_requests` + `processing_restrictions` (migration 0069, RLS theo ngữ cảnh NGƯỜI DÙNG `app.user_id`).
// - Tạo yêu cầu (`createDsarRequest`): truy cập/xoá vào hàng đợi `verified` (danh tính = phiên đã xác minh ở server); hạn chế bật cờ
//   NGAY trong cùng transaction và đóng `completed`. Idempotent: MỘT yêu cầu mở cùng loại mỗi tài khoản (khoá advisory theo (người,
//   loại) + index unique một phần) — gửi lại trả yêu cầu đang mở; đã hạn chế rồi thì trả yêu cầu đã bật cờ. Xoá đòi xác thực lại:
//   `reauthenticatedAt` (phiên tạo ≤ 5 phút, hoặc vừa nhập đúng mật khẩu — lớp HTTP quyết) — thiếu/quá hạn ⇒ REAUTH_REQUIRED; còn là
//   owner active duy nhất của tổ chức nào ⇒ LAST_OWNER (chuyển quyền hoặc xoá tổ chức trước — T-2312). Tạo mới ≤ 10 lần/giờ/tài khoản.
// - Worker (`processDsarRequests`, job `privacy.dsar`): nhận việc qua `app.dsar_claim` (SKIP LOCKED; việc treo quá 15 phút được nhận
//   lại); truy cập = gói JSON từ `app.dsar_export_data` ghi vào kho object riêng tư (`dsar/<tài khoản>/<yêu cầu>.json`, hạn tải 72 giờ)
//   rồi chốt — thông báo là trạng thái trên trang Quyền riêng tư (email báo cần ngân sách email theo tổ chức — OPS-COST-004 — mà
//   tài khoản có thể không thuộc tổ chức nào: chưa gửi, câu hỏi mở T-2311); xoá = `app.dsar_erase_account` (một transaction — xem migration 0069) với ghi chú phần
//   giữ lại + căn cứ; cuối lượt dọn gói hết hạn (xoá object TRƯỚC, gỡ khoá SAU). Một yêu cầu lỗi không chặn yêu cầu khác.
// - Tải gói (`dsarDownloadUrl`): chỉ chính chủ (RLS), URL ký ≤ 5 phút và không quá hạn tải.
// - Bộ kiểm đồng ý analytics đọc cờ hạn chế qua `hasProcessingRestriction` (privacy/consent.ts).
import { randomUUID } from "node:crypto";
import { withUserContext } from "@hm/db";
import { MS_PER_HOUR, MS_PER_MINUTE, msToSeconds, SECONDS_PER_HOUR, secondsToMs } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import { MAX_SIGNED_URL_SECONDS, type ObjectStorage } from "../files/index.ts";
import { t } from "../i18n.ts";
import { rateLimitHit } from "../pipeline/index.ts";
import {
  DSAR_ACCESS_TTL_HOURS,
  DSAR_DEFAULT_REGION,
  DSAR_REAUTH_MAX_AGE_SECONDS,
  DSAR_REQUESTS_PER_HOUR,
  DSAR_STALE_MINUTES,
  type DsarRegion,
  type DsarType,
  dsarDays,
} from "./dsar-policy.ts";

export const DSAR_STATUSES = ["received", "verified", "processing", "completed", "rejected"] as const;
export type DsarStatus = (typeof DSAR_STATUSES)[number];
const OPEN: readonly DsarStatus[] = ["received", "verified", "processing"];

export interface DsarRequest {
  id: string;
  type: DsarType;
  status: DsarStatus;
  region: DsarRegion;
  requestedAt: Date;
  dueAt: Date;
  completedAt: Date | null;
  /** Số đếm/mã lý do (không PII) — null khi chưa xong. */
  resultSummary: Record<string, unknown> | null;
  /** Phần dữ liệu còn giữ sau khi xoá + căn cứ. */
  legalRetentionNote: string | null;
  /** Gói truy cập còn tải được tới lúc này (null = không có/đã hết hạn). */
  resultExpiresAt: Date | null;
}

export type DsarErrorCode =
  | "REAUTH_REQUIRED"
  | "LAST_OWNER"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "EXPORT_NOT_READY"
  | "LINK_EXPIRED";

/** Lỗi nghiệp vụ của yêu cầu quyền chủ thể (lớp HTTP đổi sang problem+json theo `code`). */
export class DsarError extends Error {
  readonly code: DsarErrorCode;
  readonly retryAfter: number | undefined;
  constructor(code: DsarErrorCode, retryAfter?: number) {
    super(code);
    this.name = "DsarError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

interface Row {
  id: string;
  type: DsarType;
  status: DsarStatus;
  region: DsarRegion;
  requested_at: Date;
  due_at: Date;
  completed_at: Date | null;
  result_summary: Record<string, unknown> | null;
  legal_retention_note: string | null;
  result_file_key: string | null;
  result_expires_at: Date | null;
}

const COLUMNS = sql.raw(
  "id, type, status, region, requested_at, due_at, completed_at, result_summary, legal_retention_note, result_file_key, result_expires_at",
);

const toRequest = (r: Row): DsarRequest => ({
  id: r.id,
  type: r.type,
  status: r.status,
  region: r.region,
  requestedAt: r.requested_at,
  dueAt: r.due_at,
  completedAt: r.completed_at,
  resultSummary: r.result_summary,
  legalRetentionNote: r.legal_retention_note,
  resultExpiresAt: r.result_file_key ? r.result_expires_at : null,
});

/** Xác thực lại còn hiệu lực: trong `DSAR_REAUTH_MAX_AGE_SECONDS` và không ở tương lai quá 1 phút (lệch đồng hồ). */
export function isRecentReauth(at: Date | null | undefined, now: Date): boolean {
  if (!at || Number.isNaN(at.getTime())) return false;
  const age = now.getTime() - at.getTime();
  return age <= secondsToMs(DSAR_REAUTH_MAX_AGE_SECONDS) && age >= -MS_PER_MINUTE;
}

export interface CreateDsarInput {
  type: DsarType;
  /** Mặc định `DSAR_DEFAULT_REGION`. */
  region?: DsarRegion;
  /** Lần xác thực lại gần nhất (phiên mới tạo hoặc vừa nhập đúng mật khẩu) — bắt buộc cho `delete`. */
  reauthenticatedAt?: Date | null;
  now?: Date;
}

export interface CreateDsarResult {
  status: "created" | "existing";
  request: DsarRequest;
}

/** Cờ hạn chế xử lý của tài khoản — `trx` PHẢI đang có ngữ cảnh người dùng đó (RLS). */
export async function hasProcessingRestriction(
  trx: Kysely<unknown> | Transaction<unknown>,
  userId: string,
): Promise<boolean> {
  const r = await sql<{ one: number }>`
    select 1 as one from processing_restrictions where subject_user_id = ${userId}::uuid`.execute(trx);
  return r.rows.length > 0;
}

/**
 * Tạo yêu cầu quyền chủ thể cho CHÍNH người dùng `userId` (lấy từ phiên đã xác minh ở server). Ném `DsarError` khi thiếu xác thực
 * lại (xoá), còn là owner duy nhất (xoá) hoặc vượt hạn mức tạo mới.
 */
export async function createDsarRequest(
  db: Kysely<unknown>,
  userId: string,
  input: CreateDsarInput,
): Promise<CreateDsarResult> {
  const now = input.now ?? new Date();
  const region = input.region ?? DSAR_DEFAULT_REGION;
  if (input.type === "delete" && !isRecentReauth(input.reauthenticatedAt, now))
    throw new DsarError("REAUTH_REQUIRED");
  return withUserContext(db, userId, async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`dsar:${userId}:${input.type}`}, 0))`.execute(
      trx,
    );
    const open = await sql<Row>`
      select ${COLUMNS} from dsar_requests
      where subject_user_id = ${userId}::uuid and type = ${input.type} and status in ('received', 'verified', 'processing')
      limit 1`.execute(trx);
    if (open.rows[0]) return { status: "existing", request: toRequest(open.rows[0]) };
    if (input.type === "restrict" && (await hasProcessingRestriction(trx, userId))) {
      const done = await sql<Row>`
        select ${COLUMNS} from dsar_requests d
        where d.id = (select request_id from processing_restrictions where subject_user_id = ${userId}::uuid)`.execute(
        trx,
      );
      if (done.rows[0]) return { status: "existing", request: toRequest(done.rows[0]) };
    }
    if (input.type === "delete") {
      const sole = await sql<{ n: number }>`select app.dsar_sole_owner_orgs() as n`.execute(trx);
      if ((sole.rows[0]?.n ?? 0) > 0) throw new DsarError("LAST_OWNER");
    }
    const rate = await rateLimitHit(trx as unknown as Kysely<unknown>, {
      scope: "dsar.request",
      subject: userId,
      limit: DSAR_REQUESTS_PER_HOUR,
      windowSeconds: SECONDS_PER_HOUR,
    });
    if (!rate.allowed) throw new DsarError("RATE_LIMITED", rate.retryAfter);
    const id = randomUUID();
    const days = dsarDays(region, input.type);
    const restrict = input.type === "restrict";
    const r = await sql<Row>`
      insert into dsar_requests (id, subject_user_id, type, status, region, due_at, verified_at, completed_at, result_summary)
      values (${id}, ${userId}::uuid, ${input.type}, ${restrict ? "completed" : "verified"}, ${region},
              now() + make_interval(days => ${days}::int), now(), ${restrict ? sql`now()` : null},
              ${restrict ? JSON.stringify({ restricted: true }) : null}::jsonb)
      returning ${COLUMNS}`.execute(trx);
    if (restrict)
      await sql`insert into processing_restrictions (subject_user_id, request_id) values (${userId}::uuid, ${id})`.execute(
        trx,
      );
    return { status: "created", request: toRequest(r.rows[0] as Row) };
  });
}

export interface DsarOverview {
  requests: DsarRequest[];
  /** Đang hạn chế xử lý từ lúc này (null = không). */
  restrictedAt: Date | null;
}

/** Yêu cầu của chính người dùng (mới → cũ) + trạng thái hạn chế xử lý. */
export async function dsarOverview(db: Kysely<unknown>, userId: string): Promise<DsarOverview> {
  return withUserContext(db, userId, async (trx) => {
    const r = await sql<Row>`
      select ${COLUMNS} from dsar_requests where subject_user_id = ${userId}::uuid
      order by requested_at desc, id desc limit 50`.execute(trx);
    const x = await sql<{ restricted_at: Date }>`
      select restricted_at from processing_restrictions where subject_user_id = ${userId}::uuid`.execute(trx);
    return { requests: r.rows.map(toRequest), restrictedAt: x.rows[0]?.restricted_at ?? null };
  });
}

/**
 * Tài khoản có đăng nhập bằng mật khẩu không (giao diện chọn cách xác thực lại khi xoá: nhập lại mật khẩu, hay đăng nhập lại bằng
 * OTP như người thuê). Chỉ đọc sự tồn tại — không đọc băm.
 */
export async function accountHasPassword(db: Kysely<unknown>, userId: string): Promise<boolean> {
  const r = await sql<{ one: number }>`
    select 1 as one from auth.account
    where "userId" = ${userId}::uuid and "providerId" = 'credential' and password is not null limit 1`.execute(
    db,
  );
  return r.rows.length > 0;
}

/** URL ký để tải gói dữ liệu truy cập của CHÍNH người dùng (≤ 5 phút, không quá hạn tải). */
export async function dsarDownloadUrl(
  db: Kysely<unknown>,
  storage: Pick<ObjectStorage, "signedGetUrl">,
  userId: string,
  requestId: string,
  now: Date = new Date(),
): Promise<{ url: string; expiresIn: number }> {
  const row = await withUserContext(db, userId, async (trx) => {
    const r = await sql<Row>`
      select ${COLUMNS} from dsar_requests where id = ${requestId}::uuid and subject_user_id = ${userId}::uuid`.execute(
      trx,
    );
    return r.rows[0];
  });
  if (row?.type !== "access") throw new DsarError("NOT_FOUND");
  if (row.status !== "completed") throw new DsarError("EXPORT_NOT_READY");
  if (!row.result_file_key || !row.result_expires_at || row.result_expires_at.getTime() <= now.getTime())
    throw new DsarError("LINK_EXPIRED");
  const left = Math.floor(msToSeconds(row.result_expires_at.getTime() - now.getTime()));
  const expiresIn = Math.max(1, Math.min(MAX_SIGNED_URL_SECONDS, left));
  return { url: await storage.signedGetUrl(row.result_file_key, expiresIn), expiresIn };
}

// ───────────────────────────── Worker ─────────────────────────────

export interface DsarWorkerDeps {
  storage: Pick<ObjectStorage, "put" | "delete">;
  now?: Date;
  limit?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface DsarRunResult {
  accessCompleted: number;
  deleted: number;
  rejected: number;
  failed: number;
  expired: number;
}

interface Claimed {
  id: string;
  subject_user_id: string;
  type: "access" | "delete";
}

export const dsarObjectKey = (userId: string, requestId: string): string =>
  `dsar/${userId}/${requestId}.json`;

const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

async function runAccess(workerDb: Kysely<unknown>, deps: DsarWorkerDeps, job: Claimed, now: Date) {
  const r = await sql<{ data: Record<string, unknown> | null }>`
    select app.dsar_export_data(${job.id}::uuid) as data`.execute(workerDb);
  const data = r.rows[0]?.data;
  if (!data) return "skipped" as const;
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
  const key = dsarObjectKey(job.subject_user_id, job.id);
  await deps.storage.put(key, bytes, "application/json");
  const summary = {
    bytes: bytes.byteLength,
    memberships: count(data.memberships),
    consent_records: count(data.consent_records),
    sessions: count(data.sessions),
    product_events: count(data.product_events),
  };
  const expiresAt = new Date(now.getTime() + DSAR_ACCESS_TTL_HOURS * MS_PER_HOUR);
  const done = await sql<{ ok: boolean }>`
    select app.dsar_complete_access(${job.id}::uuid, ${key}, ${expiresAt}, ${JSON.stringify(summary)}::jsonb) as ok`.execute(
    workerDb,
  );
  if (!done.rows[0]?.ok) {
    // Yêu cầu đã bị đóng trong lúc dựng gói (vd tài khoản vừa bị xoá): không để object mồ côi.
    await deps.storage.delete(key);
    return "skipped" as const;
  }
  return "completed" as const;
}

async function runErase(workerDb: Kysely<unknown>, job: Claimed) {
  const r = await sql<{ res: { status?: string } | null }>`
    select app.dsar_erase_account(${job.id}::uuid, ${t("privacy.dsar.retention_note")}) as res`.execute(
    workerDb,
  );
  return r.rows[0]?.res?.status ?? "skipped";
}

/** Dọn gói truy cập hết hạn: xoá object rồi mới gỡ khoá (lỗi kho ⇒ khoá còn, lượt sau thử lại). Trả số gói đã dọn. */
export async function expireDsarResults(
  workerDb: Kysely<unknown>,
  deps: Pick<DsarWorkerDeps, "storage" | "now" | "log">,
): Promise<number> {
  const now = deps.now ?? new Date();
  const due = await sql<{ id: string; result_file_key: string }>`
    select id, result_file_key from app.dsar_due_results(${now}, 500)`.execute(workerDb);
  let n = 0;
  for (const d of due.rows) {
    try {
      await deps.storage.delete(d.result_file_key);
      const r = await sql<{ ok: boolean }>`
        select app.dsar_clear_result(${d.id}::uuid, ${d.result_file_key}) as ok`.execute(workerDb);
      if (r.rows[0]?.ok) n += 1;
    } catch (error) {
      deps.log?.("dsar.expire_failed", { request_id: d.id, error });
    }
  }
  return n;
}

/** Một lượt job `privacy.dsar`: xử lý yêu cầu truy cập/xoá đến hạn rồi dọn gói hết hạn. */
export async function processDsarRequests(
  workerDb: Kysely<unknown>,
  deps: DsarWorkerDeps,
): Promise<DsarRunResult> {
  const now = deps.now ?? new Date();
  const out: DsarRunResult = { accessCompleted: 0, deleted: 0, rejected: 0, failed: 0, expired: 0 };
  const claimed = await sql<Claimed>`
    select id, subject_user_id, type from app.dsar_claim(${now}, ${DSAR_STALE_MINUTES}, ${deps.limit ?? 20})`.execute(
    workerDb,
  );
  for (const job of claimed.rows) {
    try {
      if (job.type === "access") {
        if ((await runAccess(workerDb, deps, job, now)) === "completed") out.accessCompleted += 1;
      } else {
        const status = await runErase(workerDb, job);
        if (status === "completed") out.deleted += 1;
        else if (status === "rejected") out.rejected += 1;
      }
    } catch (error) {
      // Giữ `processing`: lượt sau (quá DSAR_STALE_MINUTES) nhận lại; metric quá hạn báo nếu kéo dài.
      out.failed += 1;
      deps.log?.("dsar.request_failed", { request_id: job.id, type: job.type, error });
    }
  }
  // Mốc dọn lấy SAU khi xử lý (gói vừa bị xoá tài khoản làm hết hạn trong lượt này được dọn ngay); test cố định `deps.now`.
  out.expired = await expireDsarResults(workerDb, { ...deps, now: deps.now ?? new Date() });
  if (out.accessCompleted + out.deleted + out.rejected + out.failed + out.expired > 0)
    deps.log?.("dsar.run", { ...out });
  return out;
}

export const isOpenStatus = (s: DsarStatus): boolean => OPEN.includes(s);
