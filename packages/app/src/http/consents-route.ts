// GET/POST /api/v1/privacy/consents (T-2310, D-119): trạng thái đồng ý của CHÍNH người đăng nhập và bật/tắt một mục đích MỘT bước
// (CMP-RIGHTS-004: rút cùng số bước như cấp). Chủ thể luôn là người dùng của phiên (không nhận id từ thân request); RLS 0068 chặn thêm ở
// CSDL. Kiểm Origin (CSRF) nằm ở proxy chung cho mọi `/api/`. Rút `service_core` → 409 (rút mục đích bắt buộc = xoá tài khoản, T-2311).
import { z } from "zod";
import { t } from "../i18n.ts";
import { toProblem } from "../pipeline/index.ts";
import {
  CONSENT_POLICY_VERSION,
  CONSENT_PURPOSES,
  ConsentError,
  currentConsents,
  grantConsent,
  isRequiredPurpose,
  withdrawConsent,
} from "../privacy/index.ts";
import {
  correlationOf,
  type HttpDeps,
  json,
  outdatedClientProblem,
  problemResponse,
  simpleProblem,
  UNAUTHENTICATED_TITLE,
  validationProblem,
} from "./command-route.ts";

/** Kênh client được khai khi ghi qua API (đăng ký đi qua Better Auth — kênh `register`/`invitation` ghi ở hook đăng ký). */
export const consentChangeInput = z.strictObject({
  purpose: z.enum(CONSENT_PURPOSES),
  action: z.enum(["grant", "withdraw"]),
  channel: z.enum(["invitation", "portal", "settings"]),
});

type Deps = Pick<HttpDeps, "db" | "getSession" | "minClientVersion" | "onUnexpectedError">;

async function body(deps: Deps, userId: string, correlationId: string): Promise<Response> {
  const cur = await currentConsents(deps.db, userId);
  return json(
    {
      policy_version: CONSENT_POLICY_VERSION,
      consents: CONSENT_PURPOSES.map((purpose) => ({
        purpose,
        required: isRequiredPurpose(purpose),
        granted: cur[purpose]?.granted === true,
        policy_version: cur[purpose]?.policyVersion ?? null,
        channel: cur[purpose]?.channel ?? null,
        recorded_at: cur[purpose]?.recordedAt.toISOString() ?? null,
      })),
    },
    200,
    correlationId,
  );
}

function unexpected(deps: Deps, err: unknown, correlationId: string): Response {
  deps.onUnexpectedError?.(err, correlationId);
  return problemResponse(toProblem(err, correlationId), correlationId);
}

export async function handleConsentsGet(req: Request, deps: Deps): Promise<Response> {
  const correlationId = correlationOf(req);
  try {
    const session = await deps.getSession(req.headers);
    if (!session) return simpleProblem("UNAUTHENTICATED", 401, UNAUTHENTICATED_TITLE, correlationId);
    return await body(deps, session.user.id, correlationId);
  } catch (err) {
    return unexpected(deps, err, correlationId);
  }
}

export async function handleConsentsPost(req: Request, deps: Deps): Promise<Response> {
  const correlationId = correlationOf(req);
  const outdated = outdatedClientProblem(req, deps as HttpDeps, correlationId);
  if (outdated) return outdated;
  try {
    const session = await deps.getSession(req.headers);
    if (!session) return simpleProblem("UNAUTHENTICATED", 401, UNAUTHENTICATED_TITLE, correlationId);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return simpleProblem("MALFORMED_REQUEST", 400, t("http.body_not_json"), correlationId);
    }
    const parsed = consentChangeInput.safeParse(raw);
    if (!parsed.success) return validationProblem(parsed.error, correlationId);
    const input = { subjectId: session.user.id, purpose: parsed.data.purpose, channel: parsed.data.channel };
    try {
      if (parsed.data.action === "grant") await grantConsent(deps.db, input);
      else await withdrawConsent(deps.db, input);
    } catch (err) {
      if (err instanceof ConsentError && err.code === "CONSENT_WITHDRAW_REQUIRES_DELETION")
        return simpleProblem(err.code, 409, t("privacy.withdraw_requires_deletion"), correlationId);
      throw err;
    }
    return await body(deps, session.user.id, correlationId);
  } catch (err) {
    return unexpected(deps, err, correlationId);
  }
}
