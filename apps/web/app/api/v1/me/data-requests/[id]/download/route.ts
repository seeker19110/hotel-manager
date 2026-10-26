// GET /api/v1/me/data-requests/{id}/download — tải gói JSON dữ liệu của chính mình (T-2311, D-123): phiên + RLS theo người dùng trong
// `handleDownloadDataRequest`; 303 tới URL ký ≤ 5 phút.
import { handleDownloadDataRequest, withHttpMetrics } from "@hm/app";
import { dataRequestDeps } from "../../../../../../../lib/http-deps.ts";

export const dynamic = "force-dynamic";

export const GET = withHttpMetrics(
  "/api/v1/me/data-requests/[id]/download",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    handleDownloadDataRequest(req, dataRequestDeps(), (await ctx.params).id),
);
