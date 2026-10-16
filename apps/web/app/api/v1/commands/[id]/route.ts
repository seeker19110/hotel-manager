// GET /api/v1/commands/{command_id} — tra kết quả command khi client hết thời gian chờ (API-CONTRACT §1, SPEC-pwa S-010).
import { handleCommandStatus } from "@hm/app";
import { httpDeps } from "../../../../../lib/http-deps.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCommandStatus(id, req, httpDeps());
}
