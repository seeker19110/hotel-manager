// GET /api/v1/me — người dùng hiện tại + tổ chức của họ (API-CONTRACT §4). Không lộ dữ liệu khi chưa đăng nhập.
import { handleMe, listMyOrganizations, serverContext, withHttpMetrics } from "@hm/app";

export const dynamic = "force-dynamic";

export const GET = withHttpMetrics("/api/v1/me", handle);

async function handle(req: Request): Promise<Response> {
  const { auth, db } = serverContext();
  return handleMe(req, {
    getUser: async (headers) => (await auth.api.getSession({ headers }))?.user ?? null,
    listOrganizations: (userId) => listMyOrganizations(db, userId),
  });
}
