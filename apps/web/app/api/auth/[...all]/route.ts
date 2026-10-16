// Endpoint của Better Auth (đăng nhập, phiên, 2FA) — ADR-0002.
import { serverContext, withHttpMetrics } from "@hm/app";

export const dynamic = "force-dynamic";

function handle(req: Request): Promise<Response> {
  return serverContext().auth.handler(req);
}

// Mẫu route cố định (không lấy từ URL): các đường con của Better Auth gộp một nhãn.
const measured = withHttpMetrics("/api/auth/[...all]", handle);

export { measured as GET, measured as POST };
