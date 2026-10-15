// Endpoint của Better Auth (đăng nhập, phiên, 2FA) — ADR-0002.
import { serverContext } from "@hm/app";

export const dynamic = "force-dynamic";

function handle(req: Request): Promise<Response> {
  return serverContext().auth.handler(req);
}

export { handle as GET, handle as POST };
