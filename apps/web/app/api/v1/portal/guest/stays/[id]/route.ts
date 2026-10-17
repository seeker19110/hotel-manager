// GET /api/v1/portal/guest/stays/{id} — khách xem lượt ở + folio bằng liên kết (SPEC-portal S-016…S-020). Không phiên.
// IP để giới hạn tần suất: hop đầu của X-Forwarded-For do reverse proxy tự host đặt (ADR-0002); thiếu → địa chỉ chung.
import { handleGuestStay, serverContext } from "@hm/app";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = serverContext();
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return handleGuestStay(req, id, { db, clientIp });
}
