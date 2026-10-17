// GET /api/version — `app.getVersion` (SPEC-pwa §5): phiên bản build + phiên bản client tối thiểu. Công khai, không dữ liệu người dùng.
import { withHttpMetrics } from "@hm/app";
import { APP_VERSION, MIN_CLIENT_VERSION } from "../../../lib/app-version.ts";

export const dynamic = "force-dynamic";

export const GET = withHttpMetrics("/api/version", () =>
  Response.json(
    { version: APP_VERSION, min_client_version: MIN_CLIENT_VERSION },
    { headers: { "cache-control": "no-store" } },
  ),
);
