// GET/POST /api/v1/me/consents — đồng ý theo mục đích của CHÍNH người đang đăng nhập (PLAN T-2310; CMP-RIGHTS-001/004; D-122).
// - Không ngữ cảnh tổ chức: đồng ý là của tài khoản. `userId` CHỈ lấy từ phiên Better Auth đã xác minh ở server; RLS của
//   `consent_records` (app.user_id) chặn đọc/ghi hàng của người khác dù handler có lỗi.
// - CSRF: POST đi qua kiểm Origin của proxy.ts như mọi `/api/` (TM-09). Không cần Idempotency-Key: thao tác là "đặt trạng thái"
//   và idempotent theo trạng thái (gửi lại cùng lựa chọn ⇒ `unchanged`, không thêm hàng).
// - GET trả trạng thái từng mục đích + toàn bộ lịch sử; `?download=1` ⇒ cùng nội dung dạng tệp JSON tải về (xuất cho chủ thể).
// - POST `{ purpose, granted, channel, policy_version? }` (schema strict): `granted=true` ⇒ cho, `false` ⇒ rút — cùng một bước như
//   nhau (CMP-RIGHTS-004). `policy_version` khác bản hiện hành ⇒ 409 VERSION_CONFLICT (client tải lại văn bản mới).
import { z } from "zod";
import { t } from "../i18n.ts";
import {
  CONSENT_CHANNELS,
  CONSENT_PURPOSES,
  ConsentError,
  type ConsentRecord,
  consentHistory,
  consentOverview,
  grantConsent,
  withdrawConsent,
} from "../privacy/index.ts";
import { correlationOf, type HttpDeps, json, simpleProblem, validationProblem } from "./command-route.ts";

export const setConsentInput = z.strictObject({
  purpose: z.enum(CONSENT_PURPOSES),
  granted: z.boolean(),
  channel: z.enum(CONSENT_CHANNELS),
  policy_version: z.string().max(20).optional(),
});

type ConsentDeps = Pick<HttpDeps, "db" | "getSession" | "isSessionRevoked">;

const recordJson = (r: ConsentRecord | null) =>
  r && {
    id: r.id,
    purpose: r.purpose,
    action: r.action,
    policy_version: r.policyVersion,
    channel: r.channel,
    ui_snapshot_hash: r.uiSnapshotHash,
    recorded_at: r.recordedAt.toISOString(),
  };

async function sessionUser(
  req: Request,
  deps: ConsentDeps,
  correlationId: string,
): Promise<string | Response> {
  const session = await deps.getSession(req.headers);
  if (session) return session.user.id;
  const revoked = deps.isSessionRevoked ? await deps.isSessionRevoked(req.headers) : false;
  return revoked
    ? simpleProblem("SESSION_REVOKED", 401, t("http.session_revoked"), correlationId)
    : simpleProblem("UNAUTHENTICATED", 401, t("http.unauthenticated"), correlationId);
}

export async function handleGetConsents(req: Request, deps: ConsentDeps): Promise<Response> {
  const correlationId = correlationOf(req);
  const userId = await sessionUser(req, deps, correlationId);
  if (userId instanceof Response) return userId;
  const [overview, history] = await Promise.all([
    consentOverview(deps.db, userId),
    consentHistory(deps.db, userId),
  ]);
  const body = {
    purposes: overview.map((p) => ({
      id: p.id,
      requires_consent: p.requiresConsent,
      legal_basis_code: p.legalBasisCode,
      version: p.version,
      granted: p.granted,
      outdated: p.outdated,
      last: recordJson(p.last),
    })),
    history: history.map(recordJson),
  };
  const res = json(body, 200, correlationId);
  if (new URL(req.url).searchParams.get("download") === "1")
    res.headers.set("content-disposition", 'attachment; filename="lich-su-dong-y.json"');
  return res;
}

export async function handleSetConsent(req: Request, deps: ConsentDeps): Promise<Response> {
  const correlationId = correlationOf(req);
  const userId = await sessionUser(req, deps, correlationId);
  if (userId instanceof Response) return userId;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return simpleProblem("MALFORMED_REQUEST", 400, t("http.body_not_json"), correlationId);
  }
  const parsed = setConsentInput.safeParse(raw);
  if (!parsed.success) return validationProblem(parsed.error, correlationId);
  const { purpose, granted, channel, policy_version } = parsed.data;
  try {
    const r = granted
      ? await grantConsent(deps.db, userId, {
          purpose,
          channel,
          ...(policy_version !== undefined ? { policyVersion: policy_version } : {}),
        })
      : await withdrawConsent(deps.db, userId, { purpose, channel });
    return json(
      { data: { status: r.status, purpose, granted: r.granted, record: recordJson(r.record) } },
      200,
      correlationId,
    );
  } catch (err) {
    if (err instanceof ConsentError)
      return simpleProblem("VERSION_CONFLICT", 409, t("privacy.policy_outdated"), correlationId, {
        current_version: err.currentVersion,
      });
    throw err;
  }
}
