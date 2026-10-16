// GET /api/ready — readiness: CSDL + kho object + máy quét, mỗi phụ thuộc có trần 3 giây (200 sẵn sàng / 503 chưa).
// `/api/health` chỉ nói tiến trình còn sống (OPS-OBS-006). Chỉ trả tên thành phần + ok/fail/timeout, không thông điệp lỗi.
// Cấu hình hỏng (không dựng được ngữ cảnh) cũng là "chưa sẵn sàng" ⇒ 503 chứ không phải 500 khó hiểu.
import { handleReady, serverContext, withHttpMetrics } from "@hm/app";

export const dynamic = "force-dynamic";

export const GET = withHttpMetrics("/api/ready", async () => {
  let ctx: ReturnType<typeof serverContext>;
  try {
    ctx = serverContext();
  } catch {
    return Response.json({ status: "not_ready" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  return handleReady({ db: ctx.db, storage: ctx.services.storage, scanner: ctx.services.scanner });
});
