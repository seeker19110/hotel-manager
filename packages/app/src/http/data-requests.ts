// /api/v1/me/data-requests — yêu cầu quyền chủ thể của CHÍNH người đang đăng nhập (PLAN T-2311; CMP-RIGHTS-007, STD-PRIV-004; D-123).
// - Không ngữ cảnh tổ chức: yêu cầu thuộc tài khoản. `userId` CHỈ lấy từ phiên Better Auth đã xác minh ở server; RLS của
//   `dsar_requests` (app.user_id) chặn đọc/ghi hàng của người khác dù handler có lỗi.
// - GET: các yêu cầu (mới → cũ) + trạng thái hạn chế xử lý.
// - POST `{ type, password? }` (schema strict): access/restrict ⇒ chỉ cần phiên; delete ⇒ xác thực lại: phiên tạo ≤ 5 phút HOẶC
//   `password` đúng (Better Auth `verifyPassword` — tài khoản người thuê không có mật khẩu thì đăng nhập lại bằng OTP để có phiên
//   mới). Thiếu ⇒ 401 REAUTH_REQUIRED (mã dùng chung của API-CONTRACT §2; `reason` = `reauth_required` | `invalid_password`). Thử
//   mật khẩu ≤ 5 lần/15 phút/tài khoản (429). Còn là owner duy nhất ⇒ 409 LAST_OWNER. Tạo mới ⇒ 202; đã có yêu cầu mở cùng loại
//   (hoặc đã hạn chế) ⇒ 200 trả yêu cầu đó (idempotent theo trạng thái — không cần Idempotency-Key). CSRF: kiểm Origin ở proxy.ts.
// - GET `/{id}/download`: 303 tới URL ký (≤ 5 phút) của gói JSON; chưa xong 409 EXPORT_NOT_READY; hết hạn 410 LINK_EXPIRED; không
//   phải của mình/không phải yêu cầu truy cập ⇒ 404 (không phân biệt).
import { minutesToSeconds, SECONDS_PER_MINUTE } from "@hm/domain";
import { z } from "zod";
import { t } from "../i18n.ts";
import { emitSecurity, requestClient } from "../logging/index.ts";
import { rateLimitHit } from "../pipeline/index.ts";
import {
  createDsarRequest,
  DSAR_PASSWORD_ATTEMPTS_PER_15_MIN,
  DSAR_TYPES,
  DsarError,
  type DsarRequest,
  dsarDownloadUrl,
  dsarOverview,
} from "../privacy/index.ts";
import { correlationOf, type HttpDeps, json, simpleProblem, validationProblem } from "./command-route.ts";

export const createDataRequestInput = z.strictObject({
  type: z.enum(DSAR_TYPES),
  password: z.string().min(1).max(256).optional(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kiểm mật khẩu của người dùng trong phiên (Better Auth `verifyPassword`); không có mật khẩu/sai ⇒ false. */
export type VerifyPassword = (headers: Headers, password: string) => Promise<boolean>;

export type DataRequestDeps = Pick<HttpDeps, "db" | "getSession" | "isSessionRevoked" | "services"> & {
  verifyPassword?: VerifyPassword;
  now?: () => Date;
};

export const downloadPath = (id: string) => `/api/v1/me/data-requests/${id}/download`;

export const requestJson = (r: DsarRequest) => ({
  id: r.id,
  type: r.type,
  status: r.status,
  region: r.region,
  requested_at: r.requestedAt.toISOString(),
  due_at: r.dueAt.toISOString(),
  completed_at: r.completedAt?.toISOString() ?? null,
  result_summary: r.resultSummary,
  legal_retention_note: r.legalRetentionNote,
  download_expires_at: r.resultExpiresAt?.toISOString() ?? null,
  download_url: r.resultExpiresAt ? downloadPath(r.id) : null,
});

async function sessionOf(
  req: Request,
  deps: DataRequestDeps,
  correlationId: string,
): Promise<{ userId: string; createdAt: Date | null } | Response> {
  const session = await deps.getSession(req.headers);
  if (session) {
    const c = session.session?.createdAt;
    return { userId: session.user.id, createdAt: c ? new Date(c) : null };
  }
  const revoked = deps.isSessionRevoked ? await deps.isSessionRevoked(req.headers) : false;
  return revoked
    ? simpleProblem("SESSION_REVOKED", 401, t("http.session_revoked"), correlationId)
    : simpleProblem("UNAUTHENTICATED", 401, t("http.unauthenticated"), correlationId);
}

function dsarProblem(err: DsarError, correlationId: string): Response {
  switch (err.code) {
    case "REAUTH_REQUIRED":
      return simpleProblem("REAUTH_REQUIRED", 401, t("privacy.dsar.reauth_required"), correlationId, {
        reason: "reauth_required",
      });
    case "LAST_OWNER":
      return simpleProblem("LAST_OWNER", 409, t("privacy.dsar.last_owner"), correlationId);
    case "RATE_LIMITED":
      return simpleProblem("RATE_LIMITED", 429, t("privacy.dsar.rate_limited"), correlationId, {
        retry_after: err.retryAfter ?? SECONDS_PER_MINUTE,
      });
    case "EXPORT_NOT_READY":
      return simpleProblem("EXPORT_NOT_READY", 409, t("privacy.dsar.not_ready"), correlationId);
    case "LINK_EXPIRED":
      return simpleProblem("LINK_EXPIRED", 410, t("privacy.dsar.link_expired"), correlationId);
    case "NOT_FOUND":
      return simpleProblem("NOT_FOUND", 404, t("common.not_found_data_dot"), correlationId);
  }
}

export async function handleListDataRequests(req: Request, deps: DataRequestDeps): Promise<Response> {
  const correlationId = correlationOf(req);
  const s = await sessionOf(req, deps, correlationId);
  if (s instanceof Response) return s;
  const o = await dsarOverview(deps.db, s.userId);
  return json(
    { requests: o.requests.map(requestJson), restricted_at: o.restrictedAt?.toISOString() ?? null },
    200,
    correlationId,
  );
}

export async function handleCreateDataRequest(req: Request, deps: DataRequestDeps): Promise<Response> {
  const correlationId = correlationOf(req);
  const s = await sessionOf(req, deps, correlationId);
  if (s instanceof Response) return s;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return simpleProblem("MALFORMED_REQUEST", 400, t("http.body_not_json"), correlationId);
  }
  const parsed = createDataRequestInput.safeParse(raw);
  if (!parsed.success) return validationProblem(parsed.error, correlationId);
  const { type, password } = parsed.data;
  const now = deps.now?.() ?? new Date();
  const actor = { authUserId: s.userId };
  const client = requestClient(req.headers);
  let reauthenticatedAt = s.createdAt;
  if (type === "delete" && password !== undefined) {
    const rate = await rateLimitHit(deps.db, {
      scope: "dsar.reauth",
      subject: s.userId,
      limit: DSAR_PASSWORD_ATTEMPTS_PER_15_MIN,
      windowSeconds: minutesToSeconds(15),
    });
    if (!rate.allowed) {
      emitSecurity({
        event: "rate_limit.exceeded",
        outcome: "denied",
        actor,
        target: { type: "route", id: "dsar.reauth" },
        reason: "RATE_LIMITED",
        client,
        correlationId,
      });
      return dsarProblem(new DsarError("RATE_LIMITED", rate.retryAfter), correlationId);
    }
    const ok = deps.verifyPassword ? await deps.verifyPassword(req.headers, password) : false;
    if (!ok) {
      emitSecurity({
        event: "auth.reauth_required",
        outcome: "denied",
        actor,
        target: { type: "dsar_request", id: null },
        reason: "invalid_password",
        client,
        correlationId,
      });
      return simpleProblem("REAUTH_REQUIRED", 401, t("privacy.dsar.password_invalid"), correlationId, {
        reason: "invalid_password",
      });
    }
    reauthenticatedAt = now;
  }
  try {
    const r = await createDsarRequest(deps.db, s.userId, { type, reauthenticatedAt, now });
    return json(
      { data: { status: r.status, request: requestJson(r.request) } },
      r.status === "created" ? 202 : 200,
      correlationId,
    );
  } catch (err) {
    if (err instanceof DsarError) {
      if (err.code === "REAUTH_REQUIRED")
        emitSecurity({
          event: "auth.reauth_required",
          outcome: "denied",
          actor,
          target: { type: "dsar_request", id: null },
          reason: "REAUTH_REQUIRED",
          client,
          correlationId,
        });
      return dsarProblem(err, correlationId);
    }
    throw err;
  }
}

export async function handleDownloadDataRequest(
  req: Request,
  deps: DataRequestDeps,
  id: string,
): Promise<Response> {
  const correlationId = correlationOf(req);
  const s = await sessionOf(req, deps, correlationId);
  if (s instanceof Response) return s;
  if (!UUID.test(id)) return dsarProblem(new DsarError("NOT_FOUND"), correlationId);
  try {
    const { url } = await dsarDownloadUrl(
      deps.db,
      deps.services.storage,
      s.userId,
      id.toLowerCase(),
      deps.now?.(),
    );
    return new Response(null, {
      status: 303,
      headers: { location: url, "cache-control": "no-store", "x-correlation-id": correlationId },
    });
  } catch (err) {
    if (err instanceof DsarError) return dsarProblem(err, correlationId);
    throw err;
  }
}
