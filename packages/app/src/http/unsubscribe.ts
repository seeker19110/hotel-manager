// POST /api/v1/notifications/unsubscribe (SPEC-notifications S-010): không phiên, xác thực bằng token ký có hạn trong email.
// Chỉ POST (trình quét liên kết trong email hay tự GET — không được đổi tuỳ chọn khi chỉ mở link); trang `/huy-dang-ky`
// (T-219) hiện nút xác nhận rồi POST. Lỗi theo problem+json; token không bao giờ ghi log.
import type { Kysely } from "kysely";
import { unsubscribe, unsubscribeKey } from "../notifications/preferences.ts";
import { CommandError } from "../pipeline/index.ts";
import { correlationOf, json, simpleProblem } from "./command-route.ts";

export async function handleUnsubscribe(
  req: Request,
  deps: { db: Kysely<unknown>; secret: string },
): Promise<Response> {
  const correlationId = correlationOf(req);
  let token: unknown;
  try {
    token = ((await req.json()) as { token?: unknown }).token;
  } catch {
    return simpleProblem("MALFORMED_REQUEST", 400, "Yêu cầu không hợp lệ.", correlationId);
  }
  if (typeof token !== "string" || token.length < 10 || token.length > 512)
    return simpleProblem("MALFORMED_REQUEST", 400, "Yêu cầu không hợp lệ.", correlationId);
  try {
    const r = await unsubscribe(deps.db, unsubscribeKey(deps.secret), { token, correlationId });
    return json({ data: { type: r.type, message: r.message } }, 200, correlationId);
  } catch (err) {
    if (err instanceof CommandError)
      return simpleProblem(err.code, err.status, err.message, correlationId, err.extensions);
    throw err;
  }
}
