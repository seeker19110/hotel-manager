// POST /api/v1/webhooks/{provider}/{account} — tiền vào từ nhà cung cấp (API-CONTRACT §3). Không phiên, xác thực bằng chữ ký.
import { handleWebhook, serverContext, withHttpMetrics } from "@hm/app";

export const dynamic = "force-dynamic";

export const POST = withHttpMetrics("/api/v1/webhooks/{provider}/{account}", handle);

async function handle(req: Request, { params }: { params: Promise<{ provider: string; account: string }> }) {
  const { provider, account } = await params;
  const { db, config, log } = serverContext();
  return handleWebhook(provider, account, req, {
    db,
    simSecret: config.SIM_WEBHOOK_SECRET,
    onRejected: (reason, correlationId) =>
      log.warn("webhook bị từ chối", { correlation_id: correlationId, reason, provider }),
    onUnexpectedError: (err, correlationId) =>
      log.error("lỗi không dự kiến", {
        correlation_id: correlationId,
        err: err instanceof Error ? err.message : String(err),
      }),
  });
}
