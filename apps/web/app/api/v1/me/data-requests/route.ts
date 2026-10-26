// GET/POST /api/v1/me/data-requests — yêu cầu quyền chủ thể của chính người đăng nhập (T-2311, D-123). Toàn bộ xử lý (phiên, schema
// strict, xác thực lại khi xoá, RLS theo người dùng) ở `handleListDataRequests`/`handleCreateDataRequest`; kiểm Origin cho POST ở proxy.ts.
import { handleCreateDataRequest, handleListDataRequests, withHttpMetrics } from "@hm/app";
import { dataRequestDeps } from "../../../../../lib/http-deps.ts";

export const dynamic = "force-dynamic";

export const GET = withHttpMetrics("/api/v1/me/data-requests", (req: Request) =>
  handleListDataRequests(req, dataRequestDeps()),
);
export const POST = withHttpMetrics("/api/v1/me/data-requests", (req: Request) =>
  handleCreateDataRequest(req, dataRequestDeps()),
);
