// GET /api/metrics — Prometheus text, chỉ nội bộ (Bearer token dẫn xuất; RUNBOOK §Quan sát). PLAN đợt 3 T-225.
import { handleMetrics, serverContext } from "@hm/app";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const { db, config } = serverContext();
  return handleMetrics(req, { db, secret: config.BETTER_AUTH_SECRET });
}
