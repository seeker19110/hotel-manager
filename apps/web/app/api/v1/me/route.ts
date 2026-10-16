// GET /api/v1/me — người dùng hiện tại + tổ chức của họ (API-CONTRACT §4). Không lộ dữ liệu khi chưa đăng nhập.
import { listMyOrganizations, serverContext, withHttpMetrics } from "@hm/app";

export const dynamic = "force-dynamic";

export const GET = withHttpMetrics("/api/v1/me", handle);

async function handle(req: Request): Promise<Response> {
  const { auth, db } = serverContext();
  const s = await auth.api.getSession({ headers: req.headers });
  if (!s) {
    return Response.json(
      {
        type: "https://hotel-manager.invalid/errors/UNAUTHENTICATED",
        title: "Cần đăng nhập",
        status: 401,
        code: "UNAUTHENTICATED",
      },
      { status: 401, headers: { "content-type": "application/problem+json", "cache-control": "no-store" } },
    );
  }
  const organizations = await listMyOrganizations(db, s.user.id);
  return Response.json(
    {
      user: {
        id: s.user.id,
        email: s.user.email,
        name: s.user.name,
        twoFactorEnabled: Boolean(s.user.twoFactorEnabled),
      },
      organizations,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
