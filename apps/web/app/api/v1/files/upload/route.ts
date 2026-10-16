// POST /api/v1/files/upload — tải ảnh sự cố / chứng từ chuyển khoản (SPEC-portal S-008, Q-07). Thân = byte của file.
import { handleFileUpload } from "@hm/app";
import { httpDeps } from "../../../../../lib/http-deps.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleFileUpload(req, httpDeps());
}
