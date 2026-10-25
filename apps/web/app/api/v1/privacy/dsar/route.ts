// GET/POST /api/v1/privacy/dsar — quyền chủ thể dữ liệu của CHÍNH người đăng nhập (T-2311, D-120): xuất dữ liệu cá nhân, xoá tài khoản,
// hạn chế xử lý. Xử lý ở `handleDsarGet/Post` (packages/app/src/http/dsar-route.ts): chủ thể = phiên, schema strict, xác thực lại ≤ 5 phút
// cho xuất/xoá; Origin kiểm ở proxy chung.
import { handleDsarGet, handleDsarPost, withHttpMetrics } from "@hm/app";
import { httpDeps } from "../../../../../lib/http-deps.ts";

export const dynamic = "force-dynamic";

export const GET = withHttpMetrics("/api/v1/privacy/dsar", (req: Request) => handleDsarGet(req, httpDeps()));
export const POST = withHttpMetrics("/api/v1/privacy/dsar", (req: Request) =>
  handleDsarPost(req, httpDeps()),
);
