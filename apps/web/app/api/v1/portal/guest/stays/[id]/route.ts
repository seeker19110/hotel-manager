// GET /api/v1/portal/guest/stays/{id} — khách xem lượt ở + folio bằng liên kết (SPEC-portal S-016…S-020). Không phiên.
// IP để giới hạn tần suất: hop phải nhất do proxy tin cậy duy nhất nối thêm (`forwardedClientIp`, RUNBOOK §9); thiếu → địa chỉ chung.
import { forwardedClientIp, handleGuestStay, serverContext } from "@hm/app";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = serverContext();
  const clientIp = forwardedClientIp(req.headers) ?? "unknown";
  return handleGuestStay(req, id, { db, clientIp });
}
