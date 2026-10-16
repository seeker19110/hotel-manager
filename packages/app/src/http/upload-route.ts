// POST /api/v1/import/upload (multipart/form-data) — SPEC-import S-002, S-015, mục 5/6; TM-07. Command `import.upload` cần
// byte file nên không đi qua `handleCommand` (JSON); các bước kiểm giữ cùng thứ tự: phiên (401) → ngữ cảnh tổ chức (409) →
// membership/MFA → quyền `import.prepare` (403) → Idempotency-Key (400) → khung multipart + kích thước (400/413) → trường (422)
// → nhận dạng nội dung, quét, lưu (415/422) trong command pipeline (idempotency, audit).
// Thân yêu cầu đọc theo luồng có TRẦN: vượt trần là huỷ luồng ngay, không nạp vô hạn vào bộ nhớ.
import { createHash } from "node:crypto";
import { authorize } from "@hm/domain";
import { z } from "zod";
import type { Actor } from "../access/actor.ts";
import type { MalwareScanner } from "../files/inspect.ts";
import type { ObjectStorage } from "../files/storage.ts";
import { IMPORT_LIMITS, uploadBatch } from "../import/import.ts";
import { executeCommand } from "../pipeline/command.ts";
import { toProblem } from "../pipeline/problem.ts";
import {
  actorFromRequest,
  correlationOf,
  type HttpDeps,
  json,
  problemResponse,
  simpleProblem,
  validationProblem,
} from "./command-route.ts";

export interface UploadDeps extends HttpDeps {
  storage: ObjectStorage;
  scanner: MalwareScanner;
}

/** Trần thân yêu cầu = file tối đa + phần dư cho ranh giới multipart và các trường văn bản. */
export const UPLOAD_MAX_BODY_BYTES = IMPORT_LIMITS.bytes + 64 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = new Set(["property_id", "kind", "cutoff_on", "file"]);
const fields = z.strictObject({
  property_id: z.uuid(),
  kind: z.string().trim().min(1).max(40),
  cutoff_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** Bọc luồng thân yêu cầu: quá `max` byte → luồng lỗi (đóng nguồn), `formData()` sau đó bị từ chối. */
function capBody(body: ReadableStream<Uint8Array>, max: number) {
  let seen = 0;
  const state = { exceeded: false };
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          state.exceeded = true;
          controller.error(new Error("body quá lớn"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream, state };
}

const tooLarge = (cid: string) =>
  simpleProblem("FILE_TOO_LARGE", 413, "File quá lớn. Tách thành nhiều file.", cid);

async function readForm(req: Request): Promise<FormData | "too_large" | "malformed"> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType) || !req.body) return "malformed";
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > UPLOAD_MAX_BODY_BYTES) return "too_large";
  const { stream, state } = capBody(req.body, UPLOAD_MAX_BODY_BYTES);
  try {
    return await new Response(stream, { headers: { "content-type": contentType } }).formData();
  } catch {
    return state.exceeded ? "too_large" : "malformed";
  }
}

export async function handleImportUpload(req: Request, deps: UploadDeps): Promise<Response> {
  const cid = correlationOf(req);
  try {
    const actor: Actor | Response = await actorFromRequest(req, deps, cid);
    if (actor instanceof Response) return actor;
    try {
      authorize(actor, "import.prepare"); // vai trò chưa đủ → 403 trước khi đọc thân yêu cầu
    } catch (err) {
      return problemResponse(toProblem(err, cid), cid);
    }
    const key = req.headers.get("idempotency-key") ?? "";
    if (!UUID.test(key))
      return simpleProblem("MALFORMED_REQUEST", 400, "Thiếu hoặc sai Idempotency-Key (UUID)", cid);

    const form = await readForm(req);
    if (form === "too_large") return tooLarge(cid);
    if (form === "malformed")
      return simpleProblem("MALFORMED_REQUEST", 400, "Thân yêu cầu phải là multipart/form-data hợp lệ", cid);
    for (const k of form.keys()) {
      if (!FIELDS.has(k))
        return simpleProblem("VALIDATION_FAILED", 422, "Dữ liệu không hợp lệ", cid, {
          errors: [{ path: k, field: k, code: "unrecognized_keys" }],
        });
    }
    const text = (k: string): string | undefined => {
      const v = form.get(k);
      return typeof v === "string" ? v : undefined;
    };
    const parsed = fields.safeParse({
      property_id: text("property_id"),
      kind: text("kind"),
      ...(text("cutoff_on") ? { cutoff_on: text("cutoff_on") } : {}),
    });
    if (!parsed.success) return validationProblem(parsed.error, cid);
    const file = form.get("file");
    if (typeof file === "string" || file === null || form.getAll("file").length !== 1) {
      return simpleProblem("VALIDATION_FAILED", 422, "Dữ liệu không hợp lệ", cid, {
        errors: [{ path: "file", field: "file", code: "REQUIRED" }],
      });
    }
    if (file.size > IMPORT_LIMITS.bytes) return tooLarge(cid);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { property_id, kind, cutoff_on } = parsed.data;
    const result = await executeCommand(
      deps.db,
      actor,
      {
        command: "import.upload",
        idempotencyKey: key,
        payload: {
          property_id,
          kind,
          cutoff_on: cutoff_on ?? null,
          file_sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        correlationId: cid,
      },
      async (ctx) => {
        const r = await uploadBatch(ctx, deps, {
          propertyId: property_id,
          kind,
          bytes,
          ...(cutoff_on === undefined ? {} : { cutoffOn: cutoff_on }),
        });
        return {
          data: { batch_id: r.batchId, file_id: r.fileId, rows: r.rows, status: "uploaded" as const },
          httpStatus: 201,
        };
      },
    );
    if (result.status === "committed") {
      return json(
        { command_id: result.commandId, status: "committed", data: result.data },
        result.httpStatus,
        cid,
      );
    }
    return problemResponse(result.problem, cid);
  } catch (err) {
    const p = toProblem(err, cid);
    if (p.status >= 500) deps.onUnexpectedError?.(err, cid);
    return problemResponse(p, cid);
  }
}
