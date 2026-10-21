// GET /api/v1/me (API-CONTRACT §4): người dùng hiện tại + tổ chức của họ. Không lộ dữ liệu khi chưa đăng nhập. Lỗi 401 theo
// cùng khuôn mọi route (AUD-XFEAT-004): problem+json có `correlation_id` và header `x-correlation-id` để người dùng báo mã tra cứu.
import { correlationOf, json, simpleProblem, UNAUTHENTICATED_TITLE } from "./command-route.ts";

export interface MeUser {
  id: string;
  email: string;
  name: string;
  twoFactorEnabled?: boolean | null | undefined;
}

export interface MeDeps {
  getUser(headers: Headers): Promise<MeUser | null>;
  listOrganizations(userId: string): Promise<unknown>;
}

export async function handleMe(req: Request, deps: MeDeps): Promise<Response> {
  const correlationId = correlationOf(req);
  const user = await deps.getUser(req.headers);
  if (!user) return simpleProblem("UNAUTHENTICATED", 401, UNAUTHENTICATED_TITLE, correlationId);
  const organizations = await deps.listOrganizations(user.id);
  return json(
    {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        twoFactorEnabled: Boolean(user.twoFactorEnabled),
      },
      organizations,
    },
    200,
    correlationId,
  );
}
