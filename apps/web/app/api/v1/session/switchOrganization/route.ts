// POST /api/v1/session/switchOrganization — `session.switchOrganization` (SPEC-access-and-property S-020, API-CONTRACT §1).
// Toàn bộ xử lý (phiên, Idempotency-Key, schema strict, membership, cookie ngữ cảnh) ở `handleSwitchOrganization`.
import { handleSwitchOrganization, withHttpMetrics } from "@hm/app";
import { httpDeps } from "../../../../../lib/http-deps.ts";

export const dynamic = "force-dynamic";

export const POST = withHttpMetrics("/api/v1/session/switchOrganization", (req: Request) =>
  handleSwitchOrganization(req, httpDeps()),
);
