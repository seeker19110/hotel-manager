// POST /api/v1/import/upload — `import.upload` (SPEC-import S-001…S-003; PLAN đợt 3 T-224). Thân `multipart/form-data`:
// `file` (CSV/XLSX), `property_id`, `kind`, `cutoff_on?`; `Idempotency-Key` bắt buộc (tải lại cùng key → cùng lô).
// Đọc thân có trần (giới hạn file + phần đầu multipart) TRƯỚC khi phân tích — không nạp file quá lớn vào bộ nhớ; còn lại
// (nhận dạng định dạng, quét mã độc, quyền theo cơ sở, giới hạn dòng/ô) do `uploadBatch`.

import { createHash } from "node:crypto";
import { kibToBytes } from "@hm/domain";
import { settle, unwrap } from "../files/staging.ts";
import { IMPORT_LIMITS, prepareBatchUpload, uploadBatch } from "../import/import.ts";
import { executeCommand, toProblem } from "../pipeline/index.ts";
import {
  actorFromRequest,
  correlationOf,
  type HttpDeps,
  json,
  problemResponse,
  simpleProblem,
} from "./command-route.ts";
import { readCapped } from "./file-upload.ts";
import { normalizeUploadName } from "./normalize.ts";
import {
  enforceActorRateLimit,
  IMPORT_UPLOAD_PER_MEMBER_PER_MINUTE,
  IMPORT_UPLOAD_PER_ORG_PER_MINUTE,
} from "./rate-limit.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Phần đầu multipart (ranh giới, header từng phần, các trường chữ) được phép ngoài dung lượng file. */
const MULTIPART_OVERHEAD = kibToBytes(64);

const invalid = (field: string, correlationId: string) =>
  simpleProblem("VALIDATION_FAILED", 422, "Dữ liệu không hợp lệ", correlationId, {
    errors: [{ path: field, field, code: "invalid" }],
  });

export async function handleImportUpload(req: Request, deps: HttpDeps): Promise<Response> {
  const correlationId = correlationOf(req);
  try {
    const actor = await actorFromRequest(req, deps, correlationId);
    if (actor instanceof Response) return actor;
    const key = req.headers.get("idempotency-key") ?? "";
    if (!UUID.test(key))
      return simpleProblem("MALFORMED_REQUEST", 400, "Thiếu hoặc sai Idempotency-Key (UUID)", correlationId);
    const type = req.headers.get("content-type") ?? "";
    if (!/^multipart\/form-data;\s*boundary=/i.test(type))
      return simpleProblem("MALFORMED_REQUEST", 400, "Cần multipart/form-data", correlationId);
    // Giới hạn tần suất TRƯỚC khi đọc thân tới 10 MB + phân tích (BE-REL-006): bộ đếm trong Postgres.
    const limited = await enforceActorRateLimit(deps.db, actor, req, correlationId, {
      scope: "import_upload",
      perMember: deps.uploadRateLimit?.perMember ?? IMPORT_UPLOAD_PER_MEMBER_PER_MINUTE,
      perOrg: deps.uploadRateLimit?.perOrg ?? IMPORT_UPLOAD_PER_ORG_PER_MINUTE,
    });
    if (limited) return limited;
    const body = await readCapped(req, IMPORT_LIMITS.bytes + MULTIPART_OVERHEAD);
    if (!body)
      return simpleProblem("FILE_TOO_LARGE", 413, "File quá lớn. Tách thành nhiều file.", correlationId);
    let form: FormData;
    try {
      const copy = new ArrayBuffer(body.byteLength);
      new Uint8Array(copy).set(body);
      form = await new Response(copy, { headers: { "content-type": type } }).formData();
    } catch {
      return simpleProblem("MALFORMED_REQUEST", 400, "Thân multipart không hợp lệ", correlationId);
    }
    const file = form.get("file");
    const propertyId = form.get("property_id");
    const kind = form.get("kind");
    const cutoff = form.get("cutoff_on");
    if (!(file instanceof Blob)) return invalid("file", correlationId);
    if (typeof propertyId !== "string" || !UUID.test(propertyId))
      return invalid("property_id", correlationId);
    if (typeof kind !== "string" || kind.length > 40) return invalid("kind", correlationId);
    if (cutoff !== null && (typeof cutoff !== "string" || cutoff.length > 10))
      return invalid("cutoff_on", correlationId);
    if (file.size > IMPORT_LIMITS.bytes)
      return simpleProblem("FILE_TOO_LARGE", 413, "File quá lớn. Tách thành nhiều file.", correlationId);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const input = {
      propertyId: propertyId.toLowerCase(),
      kind,
      fileName: normalizeUploadName(file instanceof File ? file.name : ""),
      ...(typeof cutoff === "string" && cutoff ? { cutoffOn: cutoff } : {}),
      bytes,
    };
    // Quét + ghi object nguồn NGOÀI transaction lệnh (T-303); lỗi ném lại trong handler để pipeline ghi `failed`/`denied`.
    const prepared = await settle(() => prepareBatchUpload(deps.db, deps.services, actor, input, key));
    const result = await executeCommand(
      deps.db,
      actor,
      {
        command: "import.upload",
        idempotencyKey: key,
        payload: {
          property_id: propertyId.toLowerCase(),
          kind,
          cutoff_on: cutoff ?? null,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        correlationId,
      },
      async (ctx) => ({
        data: await uploadBatch(ctx, deps.services, { ...input, prepared: unwrap(prepared) }),
        httpStatus: 201,
      }),
    );
    if (result.status === "committed")
      return json(
        { command_id: result.commandId, status: "committed", data: result.data },
        result.httpStatus,
        correlationId,
      );
    return problemResponse(result.problem, correlationId);
  } catch (err) {
    const p = toProblem(err, correlationId);
    if (p.status >= 500) deps.onUnexpectedError?.(err, correlationId);
    return problemResponse(p, correlationId);
  }
}
