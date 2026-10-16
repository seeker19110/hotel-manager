// GET /api/ready — CSDL + kho object + máy quét (200 sẵn sàng / 503 chưa). `/api/health` chỉ nói tiến trình còn sống.
import { handleReady, serverContext } from "@hm/app";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { db, services } = serverContext();
  return handleReady({ db, storage: services.storage, scanner: services.scanner });
}
