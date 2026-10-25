// GET/POST /api/v1/privacy/consents — đồng ý theo mục đích của CHÍNH người đăng nhập (T-2310, D-119). Xử lý ở `handleConsentsGet/Post`
// (packages/app/src/http/consents-route.ts): chủ thể = phiên, schema strict, rút `service_core` → 409; Origin kiểm ở proxy chung.
import { handleConsentsGet, handleConsentsPost, withHttpMetrics } from "@hm/app";
import { httpDeps } from "../../../../../lib/http-deps.ts";

export const dynamic = "force-dynamic";

export const GET = withHttpMetrics("/api/v1/privacy/consents", (req: Request) =>
  handleConsentsGet(req, httpDeps()),
);
export const POST = withHttpMetrics("/api/v1/privacy/consents", (req: Request) =>
  handleConsentsPost(req, httpDeps()),
);
