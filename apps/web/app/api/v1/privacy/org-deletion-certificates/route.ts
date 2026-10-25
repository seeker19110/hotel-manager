// GET /api/v1/privacy/org-deletion-certificates — chứng nhận xoá tổ chức của CHÍNH người đã yêu cầu xoá (T-2312, D-121): danh sách, hoặc
// `?id=` tải tệp JSON nguyên văn đã băm. Xử lý ở `handleOrgDeletionCertificatesGet` (packages/app/src/http/org-deletion-route.ts).
import { handleOrgDeletionCertificatesGet, withHttpMetrics } from "@hm/app";
import { httpDeps } from "../../../../../lib/http-deps.ts";

export const dynamic = "force-dynamic";

export const GET = withHttpMetrics("/api/v1/privacy/org-deletion-certificates", (req: Request) =>
  handleOrgDeletionCertificatesGet(req, httpDeps()),
);
