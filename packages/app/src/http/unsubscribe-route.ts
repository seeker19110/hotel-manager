// GET /api/v1/notifications/unsubscribe?token=… — huỷ đăng ký từ liên kết email (SPEC-notifications S-010). Không phiên:
// xác thực bằng token HMAC có hạn. Chỉ GET (liên kết trong email); POST cùng-origin guard của proxy sẽ chặn nên không hỗ trợ.
// Lỗi: token giả → 404 NOT_FOUND (không lộ gì); hết hạn → 410 LINK_EXPIRED.
import type { Kysely } from "kysely";
import { unsubscribeByToken } from "../notifications/notifications.ts";
import { toProblem } from "../pipeline/problem.ts";
import { correlationOf, json, problemResponse, simpleProblem } from "./command-route.ts";

export interface UnsubscribeDeps {
  db: Kysely<unknown>;
  /** NOTIFICATION_TOKEN_SECRET; không đặt → tính năng tắt (404). */
  secret: string | undefined;
  now?: () => Date;
  onUnexpectedError?(err: unknown, correlationId: string): void;
}

export async function handleUnsubscribe(req: Request, deps: UnsubscribeDeps): Promise<Response> {
  const correlationId = correlationOf(req);
  if (!deps.secret) return simpleProblem("NOT_FOUND", 404, "Không tìm thấy dữ liệu.", correlationId);
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!token) return simpleProblem("NOT_FOUND", 404, "Không tìm thấy dữ liệu.", correlationId);
  try {
    const r = await unsubscribeByToken(
      deps.db,
      deps.secret,
      token,
      (deps.now ?? (() => new Date()))(),
      correlationId,
    );
    return json(
      {
        data: {
          status: "unsubscribed",
          type: r.type,
          message: `Bạn sẽ không nhận email ${r.typeLabel} từ ${r.organizationName} nữa.`,
        },
      },
      200,
      correlationId,
    );
  } catch (err) {
    const p = toProblem(err, correlationId);
    if (p.status < 500) return problemResponse(p, correlationId);
    deps.onUnexpectedError?.(err, correlationId);
    return problemResponse(p, correlationId);
  }
}
