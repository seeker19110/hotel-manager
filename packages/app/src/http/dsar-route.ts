// /api/v1/privacy/dsar — quyền chủ thể dữ liệu của CHÍNH người đăng nhập (T-2311; STD-PRIV-004, CMP-RIGHTS-007, CMP-VN-007; D-120).
// Chủ thể luôn là người dùng của PHIÊN (không nhận id từ thân request); RLS 0069 chặn thêm ở CSDL. Origin (CSRF) kiểm ở proxy chung.
//  - GET:  trạng thái — hạn chế xử lý, owner duy nhất ở bao nhiêu tổ chức (xoá bị chặn), lịch sử yêu cầu.
//  - POST `{action:"access"}`: xuất JSON (tệp tải về) — xác thực lại ≤ 5 phút (401 REAUTH_REQUIRED).
//  - POST `{action:"delete", confirm_email}`: xác thực lại; 422 email không khớp; 409 SOLE_OWNER; 202 (phiên đã thu hồi).
//  - POST `{action:"restrict", active}`: bật/tắt hạn chế xử lý một bước.
import { z } from "zod";
import { pseudonymizeActor } from "../analytics/index.ts";
import { t } from "../i18n.ts";
import { emitSecurity, requestClient } from "../logging/index.ts";
import { toProblem } from "../pipeline/index.ts";
import {
  DsarError,
  dsarStatus,
  exportPersonalData,
  requestAccountDeletion,
  setProcessingRestriction,
} from "../privacy/index.ts";
import {
  correlationOf,
  type HttpDeps,
  type HttpSession,
  json,
  outdatedClientProblem,
  problemResponse,
  simpleProblem,
  UNAUTHENTICATED_TITLE,
  validationProblem,
} from "./command-route.ts";

export const dsarInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("access") }),
  z.strictObject({ action: z.literal("delete"), confirm_email: z.string().min(1).max(320) }),
  z.strictObject({ action: z.literal("restrict"), active: z.boolean() }),
]);

type Deps = Pick<HttpDeps, "db" | "getSession" | "minClientVersion" | "onUnexpectedError"> & {
  services: Pick<HttpDeps["services"], "analyticsKey">;
};

const authAt = (s: HttpSession): Date | undefined =>
  s.session?.createdAt ? new Date(s.session.createdAt) : undefined;

function failure(
  req: Request,
  deps: Deps,
  err: unknown,
  userId: string | null,
  correlationId: string,
): Response {
  if (err instanceof DsarError) {
    emitSecurity({
      event: err.code === "REAUTH_REQUIRED" ? "auth.reauth_required" : "privacy.dsar_requested",
      outcome: "denied",
      actor: { authUserId: userId },
      reason: err.code,
      client: requestClient(req.headers),
      correlationId,
    });
    return simpleProblem(
      err.code,
      err.status,
      err.message,
      correlationId,
      err.code === "SOLE_OWNER" ? { sole_owner_orgs: err.soleOwnerOrgs } : {},
    );
  }
  deps.onUnexpectedError?.(err, correlationId);
  return problemResponse(toProblem(err, correlationId), correlationId);
}

function accepted(req: Request, userId: string, kind: string, id: string | null, correlationId: string) {
  emitSecurity({
    event: "privacy.dsar_requested",
    outcome: "success",
    actor: { authUserId: userId },
    target: { type: "dsar_request", id },
    reason: kind,
    client: requestClient(req.headers),
    correlationId,
  });
}

/** Khung chung: client cũ (426, chỉ POST) → phiên (401) → xử lý; lỗi DsarError → problem đúng mã. */
async function withSession(
  req: Request,
  deps: Deps,
  write: boolean,
  fn: (session: HttpSession, correlationId: string) => Promise<Response>,
): Promise<Response> {
  const correlationId = correlationOf(req);
  if (write) {
    const outdated = outdatedClientProblem(req, deps as HttpDeps, correlationId);
    if (outdated) return outdated;
  }
  let userId: string | null = null;
  try {
    const session = await deps.getSession(req.headers);
    if (!session) return simpleProblem("UNAUTHENTICATED", 401, UNAUTHENTICATED_TITLE, correlationId);
    userId = session.user.id;
    return await fn(session, correlationId);
  } catch (err) {
    return failure(req, deps, err, userId, correlationId);
  }
}

export function handleDsarGet(req: Request, deps: Deps): Promise<Response> {
  return withSession(req, deps, false, async (session, correlationId) => {
    const s = await dsarStatus(deps.db, session.user.id);
    return json(
      {
        restricted: s.restricted,
        sole_owner_orgs: s.soleOwnerOrgs,
        requests: s.requests.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          region: r.region,
          received_at: r.receivedAt.toISOString(),
          due_at: r.dueAt.toISOString(),
          completed_at: r.completedAt?.toISOString() ?? null,
        })),
      },
      200,
      correlationId,
    );
  });
}

export function handleDsarPost(req: Request, deps: Deps): Promise<Response> {
  return withSession(req, deps, true, async (session, correlationId) => {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return simpleProblem("MALFORMED_REQUEST", 400, t("http.body_not_json"), correlationId);
    }
    const parsed = dsarInput.safeParse(raw);
    if (!parsed.success) return validationProblem(parsed.error, correlationId);
    const userId = session.user.id;
    const input = parsed.data;
    if (input.action === "access") {
      const data = await exportPersonalData(deps.db, {
        userId,
        authenticatedAt: authAt(session),
        analyticsActor: pseudonymizeActor(deps.services.analyticsKey, userId),
      });
      accepted(req, userId, "access", data.request.id, correlationId);
      return new Response(`${JSON.stringify(data, null, 2)}\n`, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="du-lieu-ca-nhan-${data.generated_at.slice(0, 10)}.json"`,
          "cache-control": "no-store",
          "x-correlation-id": correlationId,
        },
      });
    }
    if (input.action === "delete") {
      const r = await requestAccountDeletion(deps.db, {
        userId,
        authenticatedAt: authAt(session),
        confirmEmail: input.confirm_email,
      });
      accepted(req, userId, "delete", r.requestId, correlationId);
      // Không gắn Clear-Site-Data ở đây: xoá storage gỡ service worker ⇒ PWA tải lại trang ngay và người dùng mất thông báo "đã nhận
      // yêu cầu". Phiên đã bị thu hồi ở CSDL (cookie cũ ⇒ 401 SESSION_REVOKED); cache trang riêng tư là no-store.
      return json(
        { request_id: r.requestId, status: "received", due_at: r.dueAt.toISOString() },
        202,
        correlationId,
      );
    }
    const r = await setProcessingRestriction(deps.db, { userId, active: input.active });
    if (r.changed) accepted(req, userId, "restrict", r.requestId, correlationId);
    return json({ restricted: r.active, changed: r.changed }, 200, correlationId);
  });
}
