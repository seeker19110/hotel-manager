// GET /api/metrics — Prometheus text, chỉ nội bộ (Bearer token dẫn xuất; RUNBOOK §Quan sát). PLAN đợt 3 T-225.
import { handleMetrics, serverContext, withHttpMetrics } from "@hm/app";

export const dynamic = "force-dynamic";

export const GET = withHttpMetrics("/api/metrics", async (req: Request) => {
  const { db, config } = serverContext();
  return handleMetrics(req, { db, secret: config.BETTER_AUTH_SECRET });
});
