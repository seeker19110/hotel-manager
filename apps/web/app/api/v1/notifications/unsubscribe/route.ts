// GET /api/v1/notifications/unsubscribe?token=… — huỷ đăng ký từ liên kết email (SPEC-notifications S-010). Không phiên.
import { handleUnsubscribe, serverContext } from "@hm/app";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { db, config, log } = serverContext();
  return handleUnsubscribe(req, {
    db,
    secret: config.NOTIFICATION_TOKEN_SECRET,
    onUnexpectedError: (err, correlationId) =>
      log.error("lỗi không dự kiến", {
        correlation_id: correlationId,
        err: err instanceof Error ? err.message : String(err),
      }),
  });
}
