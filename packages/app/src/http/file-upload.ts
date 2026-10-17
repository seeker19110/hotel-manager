// POST /api/v1/files/upload?owner_type=work_order|payment_claim|lease_settlement&property_id=<uuid> — tải ảnh/PDF (SPEC-portal S-008, Q-07).
// Thân yêu cầu là BYTE của file (không multipart), `Idempotency-Key` bắt buộc (tải lại cùng key → cùng fileId, không hai file).
// Giới hạn tần suất theo thành viên/tổ chức (rate-limit.ts) → 429 + Retry-After.
// Kiểm kích thước ngay khi đọc luồng (không nạp quá giới hạn vào bộ nhớ), phần còn lại do `uploadFile` (magic bytes, EXIF,
// quét mã độc, quyền theo cơ sở). Quét + ghi object chạy NGOÀI transaction lệnh (staging.ts). Phản hồi problem+json như mọi command.

import { createHash } from "node:crypto";
import {
  type FileOwnerType,
  MAX_FILE_BYTES,
  prepareUpload,
  settle,
  unwrap,
  uploadFile,
} from "../files/index.ts";
import { requestClient } from "../logging/index.ts";
import { executeCommand, toProblem } from "../pipeline/index.ts";
import {
  actorFromRequest,
  correlationOf,
  type HttpDeps,
  json,
  outdatedClientProblem,
  problemResponse,
  rejectInput,
  simpleProblem,
} from "./command-route.ts";
import {
  enforceActorRateLimit,
  FILE_UPLOAD_PER_MEMBER_PER_MINUTE,
  FILE_UPLOAD_PER_ORG_PER_MINUTE,
} from "./rate-limit.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_TYPES: readonly FileOwnerType[] = ["work_order", "payment_claim", "lease_settlement"];

/** Đọc thân tối đa `limit` byte; vượt → null (đã dừng đọc). */
export async function readCapped(req: Request, limit: number): Promise<Uint8Array | null> {
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
    // Client quá cũ (S-009): 426 trước phiên/đọc thân, như lệnh thường.
    const outdated = outdatedClientProblem(req, deps, correlationId);
    if (outdated) return outdated;
    const actor = await actorFromRequest(req, deps, correlationId);
    if (actor instanceof Response) return actor;
    const q = new URL(req.url).searchParams;
    const ownerType = q.get("owner_type") as FileOwnerType | null;
    const propertyId = q.get("property_id") ?? "";
    const endpoint = { type: "endpoint", id: "/api/v1/files/upload" };
    if (!ownerType || !OWNER_TYPES.includes(ownerType) || !UUID.test(propertyId)) {
      rejectInput(req, correlationId, "input.validation_failed", actor, endpoint, "VALIDATION_FAILED");
      return simpleProblem("VALIDATION_FAILED", 422, "Dữ liệu không hợp lệ", correlationId, {
        errors: [{ path: "owner_type", field: "owner_type", code: "invalid" }],
      });
    }
    const key = req.headers.get("idempotency-key") ?? "";
    if (!UUID.test(key))
      return simpleProblem("MALFORMED_REQUEST", 400, "Thiếu hoặc sai Idempotency-Key (UUID)", correlationId);
    // Giới hạn tần suất TRƯỚC khi đọc thân/quét/ghi object (BE-REL-006): bộ đếm trong Postgres, đúng khi nhiều instance.
    const limited = await enforceActorRateLimit(deps.db, actor, req, correlationId, {
      scope: "file_upload",
      perMember: deps.uploadRateLimit?.perMember ?? FILE_UPLOAD_PER_MEMBER_PER_MINUTE,
      perOrg: deps.uploadRateLimit?.perOrg ?? FILE_UPLOAD_PER_ORG_PER_MINUTE,
    });
    if (limited) return limited;
    const bytes = await readCapped(req, MAX_FILE_BYTES);
    if (!bytes) {
      rejectInput(req, correlationId, "file.upload_rejected", actor, endpoint, "FILE_TOO_LARGE");
      return simpleProblem("FILE_TOO_LARGE", 413, "File vượt dung lượng cho phép", correlationId);
    }
    const input = { ownerType, propertyId: propertyId.toLowerCase(), bytes };
    // Quét + ghi object NGOÀI transaction lệnh (T-303). Lỗi của bước này được ném lại trong handler để pipeline vẫn ghi
    // kết quả `failed` + audit `denied` như khi chạy trong transaction.
    const prepared = await settle(() => prepareUpload(deps.db, deps.services, actor, input, key));
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
        client: requestClient(req.headers),
      },
      async (ctx) => ({
        data: await uploadFile(ctx, deps.services, { ...input, prepared: unwrap(prepared) }),
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
