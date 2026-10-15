// File riêng tư (SPEC-housekeeping-maintenance, ERD files; TM-06, TM-07; ADR-0002).
// Tải lên: kiểm kích thước → nhận dạng magic bytes theo allowlist của loại chủ → bỏ EXIF → quét mã độc → ghi object
// (khoá có tiền tố tổ chức) → hàng `files`. Đọc: kiểm quyền TRƯỚC, rồi mới cấp URL ký ≤ 5 phút.
import { createHash, randomUUID } from "node:crypto";
import { authorize } from "@hm/domain";
import { sql } from "kysely";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";
import {
  CorruptFileError,
  type DetectedMime,
  detectMime,
  type MalwareScanner,
  stripImageMetadata,
} from "./inspect.ts";
import { MAX_SIGNED_URL_SECONDS, type ObjectStorage } from "./storage.ts";

export type FileOwnerType = "work_order" | "handover" | "meter_reading" | "identity_document" | "task";

const IMAGES: readonly DetectedMime[] = ["image/jpeg", "image/png", "image/webp"];
const ALLOW: Readonly<Record<FileOwnerType, readonly DetectedMime[]>> = {
  work_order: IMAGES,
  handover: IMAGES,
  meter_reading: IMAGES,
  task: IMAGES,
  identity_document: [...IMAGES, "application/pdf"],
};
/** 10 MB/ảnh (đề xuất SPEC-housekeeping Q, chờ PO). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface FileDeps {
  storage: ObjectStorage;
  scanner: MalwareScanner;
}

export async function uploadFile(
  ctx: CommandContext,
  deps: FileDeps,
  input: { ownerType: FileOwnerType; ownerId?: string; propertyId: string; bytes: Uint8Array },
): Promise<{ fileId: string; status: "ready" | "rejected"; mime: DetectedMime }> {
  authorize(ctx.actor, input.ownerType === "identity_document" ? "identity.read" : "work_order.create", {
    propertyId: input.propertyId,
  });
  if (input.bytes.byteLength === 0) throw new CommandError("VALIDATION_FAILED", 422, "File rỗng");
  if (input.bytes.byteLength > MAX_FILE_BYTES)
    throw new CommandError("FILE_TOO_LARGE", 413, "File vượt dung lượng cho phép");
  const mime = detectMime(input.bytes);
  if (!mime || !ALLOW[input.ownerType].includes(mime)) {
    throw new CommandError("FILE_TYPE_NOT_ALLOWED", 415, "Định dạng file không được phép");
  }
  let content: Uint8Array;
  try {
    content = stripImageMetadata(input.bytes, mime);
  } catch (err) {
    if (err instanceof CorruptFileError)
      throw new CommandError("FILE_TYPE_NOT_ALLOWED", 415, "File ảnh hỏng hoặc giả mạo");
    throw err;
  }
  const id = randomUUID();
  const key = `${ctx.actor.orgId}/${input.ownerType}/${id}`;
  const sha256 = createHash("sha256").update(content).digest("hex");
  const scan = await deps.scanner.scan(input.bytes);
  const status = scan.clean ? "ready" : "rejected";
  // File nhiễm KHÔNG được lưu nội dung; chỉ giữ metadata để truy vết.
  if (scan.clean) await deps.storage.put(key, content, mime);
  await sql`
    insert into files (id, organization_id, property_id, owner_type, owner_id, mime, size_bytes, sha256, status, storage_key,
                       exif_stripped, uploaded_by, scanned_at, reject_reason)
    values (${id}, ${ctx.actor.orgId}, ${input.propertyId}, ${input.ownerType}, ${input.ownerId ?? null}, ${mime}, ${content.byteLength},
            ${sha256}, ${status}, ${key}, ${mime.startsWith("image/")}, ${ctx.actor.membershipId}, now(),
            ${scan.clean ? null : scan.reason})`.execute(ctx.trx);
  await ctx.audit({
    action: scan.clean ? "file.uploaded" : "file.rejected",
    entityType: "file",
    entityId: id,
    propertyId: input.propertyId,
    after: { owner_type: input.ownerType, mime, size_bytes: content.byteLength },
  });
  return { fileId: id, status, mime };
}

/** URL ký cho file — chỉ sau khi kiểm quyền; không thấy (khác tổ chức, ngoài phạm vi, không đủ vai trò) → NOT_FOUND. */
export async function getFileUrl(
  ctx: CommandContext,
  deps: FileDeps,
  fileId: string,
): Promise<{ url: string; expiresIn: number }> {
  const r = await sql<{
    owner_type: string;
    property_id: string | null;
    status: string;
    storage_key: string;
  }>`
    select owner_type, property_id, status, storage_key from files where organization_id = ${ctx.actor.orgId} and id = ${fileId}`.execute(
    ctx.trx,
  );
  const f = r.rows[0];
  if (f?.status !== "ready") throw new CommandError("NOT_FOUND", 404, "Không tìm thấy file");
  try {
    authorize(ctx.actor, f.owner_type === "identity_document" ? "identity.read" : "calendar.read_status", {
      ...(f.property_id ? { propertyId: f.property_id } : {}),
    });
  } catch {
    // Không phân biệt "không có quyền" với "không tồn tại" (API-CONTRACT §2).
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy file");
  }
  return {
    url: await deps.storage.signedGetUrl(f.storage_key, MAX_SIGNED_URL_SECONDS),
    expiresIn: MAX_SIGNED_URL_SECONDS,
  };
}
