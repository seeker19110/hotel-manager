// Endpoint của Better Auth (đăng nhập, phiên, 2FA) — ADR-0002.
import { serverContext, withRetryAfter } from "@hm/app";

export const dynamic = "force-dynamic";

// Better Auth tự trả 429 (giới hạn theo IP) với `X-Retry-After`; chuẩn hoá thành `Retry-After` (BE-REL-006).
async function handle(req: Request): Promise<Response> {
  return withRetryAfter(await serverContext().auth.handler(req));
}

export { handle as GET, handle as POST };
