// POST /api/v1/import/upload — tải file nguồn của lô nhập (multipart; SPEC-import S-001…S-003, PLAN đợt 3 T-224).
import { handleImportUpload, withHttpMetrics } from "@hm/app";
import { httpDeps } from "../../../../../lib/http-deps.ts";

export const dynamic = "force-dynamic";

export const POST = withHttpMetrics("/api/v1/import/upload", (req: Request) =>
  handleImportUpload(req, httpDeps()),
);
