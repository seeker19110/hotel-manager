// GET/POST /api/v1/me/consents — đồng ý theo mục đích của chính người đang đăng nhập (T-2310, D-122). Toàn bộ xử lý (phiên, schema
// strict, RLS theo người dùng, xuất lịch sử) ở `handleGetConsents`/`handleSetConsent`; kiểm Origin cho POST ở proxy.ts.
import { handleGetConsents, handleSetConsent, withHttpMetrics } from "@hm/app";
import { httpDeps } from "../../../../../lib/http-deps.ts";

export const dynamic = "force-dynamic";

export const GET = withHttpMetrics("/api/v1/me/consents", (req: Request) =>
  handleGetConsents(req, httpDeps()),
);
export const POST = withHttpMetrics("/api/v1/me/consents", (req: Request) =>
  handleSetConsent(req, httpDeps()),
);
