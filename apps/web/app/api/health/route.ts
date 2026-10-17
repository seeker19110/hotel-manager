// GET /api/health — liveness TĨNH (OPS-OBS-006): không gọi CSDL/kho/máy quét/cấu hình. Chọn bản nhận tải dùng `/api/ready`.
import { handleHealth, withHttpMetrics } from "@hm/app";

export const dynamic = "force-dynamic";

export const GET = withHttpMetrics("/api/health", () => handleHealth());
