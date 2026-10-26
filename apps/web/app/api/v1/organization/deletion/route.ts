// GET/POST/DELETE /api/v1/organization/deletion — trạng thái, yêu cầu (owner, xác thực lại) và huỷ (owner, một bước) xoá tổ chức
// đang chọn (T-2312, D-125). Toàn bộ xử lý (phiên, membership, schema strict, xác thực lại) ở `handle*OrgDeletion`; kiểm Origin cho
// POST/DELETE ở proxy.ts.
import {
  handleCancelOrgDeletion,
  handleGetOrgDeletion,
  handleRequestOrgDeletion,
  withHttpMetrics,
} from "@hm/app";
import { orgDeletionDeps } from "../../../../../lib/http-deps.ts";

export const dynamic = "force-dynamic";

export const GET = withHttpMetrics("/api/v1/organization/deletion", (req: Request) =>
  handleGetOrgDeletion(req, orgDeletionDeps()),
);
export const POST = withHttpMetrics("/api/v1/organization/deletion", (req: Request) =>
  handleRequestOrgDeletion(req, orgDeletionDeps()),
);
export const DELETE = withHttpMetrics("/api/v1/organization/deletion", (req: Request) =>
  handleCancelOrgDeletion(req, orgDeletionDeps()),
);
