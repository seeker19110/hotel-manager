// POST /api/v1/import/upload — tải file CSV/XLSX nguồn của lô nhập (multipart/form-data; SPEC-import mục 5). Route tĩnh này
// đứng trước `[module]/[command]` nên command JSON `import.*` còn lại vẫn đi qua route chung.
import { handleImportUpload, serverContext } from "@hm/app";
import { httpDeps } from "../../../../../lib/http-deps.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { storage, scanner } = serverContext();
  return handleImportUpload(req, { ...httpDeps(), storage, scanner });
}
