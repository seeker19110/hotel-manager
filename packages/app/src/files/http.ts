// POST /api/v1/files/upload?owner_type=work_order|payment_claim&property_id=<uuid> — tải ảnh/PDF (SPEC-portal S-008, Q-07).
// Thân yêu cầu là BYTE của file (không multipart), `Idempotency-Key` bắt buộc (tải lại cùng key → cùng fileId, không hai file).
// Kiểm kích thước ngay khi đọc luồng (không nạp quá giới hạn vào bộ nhớ), phần còn lại do `uploadFile` (magic bytes, EXIF,
// quét mã độc, quyền theo cơ sở). Phản hồi problem+json như mọi command.

import { createHash } from "node:crypto";
import {
  actorFromRequest,
  correlationOf,
  type HttpDeps,
  json,
  problemResponse,
  simpleProblem,
} from "../http/command-route.ts";
import { executeCommand } from "../pipeline/command.ts";
import { toProblem } from "../pipeline/problem.ts";
import { type FileOwnerType, MAX_FILE_BYTES, uploadFile } from "./files.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_TYPES: readonly FileOwnerType[] = ["work_order", "payment_claim"];

/** Đọc thân tối đa `limit` byte; vượt → null (đã dừng đọc). */
async function readCapped(req: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function handleFileUpload(req: Request, deps: HttpDeps): Promise<Response> {
  const correlationId = correlationOf(req);
  try {
    const actor = await actorFromRequest(req, deps, correlationId);
    if (actor instanceof Response) return actor;
    const q = new URL(req.url).searchParams;
    const ownerType = q.get("owner_type") as FileOwnerType | null;
    const propertyId = q.get("property_id") ?? "";
    if (!ownerType || !OWNER_TYPES.includes(ownerType) || !UUID.test(propertyId))
      return simpleProblem("VALIDATION_FAILED", 422, "Dữ liệu không hợp lệ", correlationId, {
        errors: [{ path: "owner_type", field: "owner_type", code: "invalid" }],
      });
    const key = req.headers.get("idempotency-key") ?? "";
    if (!UUID.test(key))
      return simpleProblem("MALFORMED_REQUEST", 400, "Thiếu hoặc sai Idempotency-Key (UUID)", correlationId);
    const bytes = await readCapped(req, MAX_FILE_BYTES);
    if (!bytes) return simpleProblem("FILE_TOO_LARGE", 413, "File vượt dung lượng cho phép", correlationId);
    const result = await executeCommand(
      deps.db,
      actor,
      {
        command: "files.upload",
        idempotencyKey: key,
        payload: {
          owner_type: ownerType,
          property_id: propertyId,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        correlationId,
      },
      async (ctx) => ({
        data: await uploadFile(ctx, deps.services, {
          ownerType,
          propertyId: propertyId.toLowerCase(),
          bytes,
        }),
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
    if (p.status < 500) return problemResponse(p, correlationId);
    deps.onUnexpectedError?.(err, correlationId);
    return problemResponse(p, correlationId);
  }
}
