// GET /api/ready — CSDL + kho object + máy quét (200 sẵn sàng / 503 chưa; 503 `draining` ngay khi nhận SIGTERM — lib/shutdown.ts). `/api/health` chỉ nói tiến trình còn sống.
import { handleReady, serverContext } from "@hm/app";
import { isDraining } from "../../../lib/shutdown.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { db, services } = serverContext();
  return handleReady({ draining: isDraining, db, storage: services.storage, scanner: services.scanner });
}
