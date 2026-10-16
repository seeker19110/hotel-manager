// File riêng tư (SPEC-housekeeping-maintenance, ERD files; TM-06, TM-07; ADR-0002).
// Tải lên: kiểm kích thước → nhận dạng magic bytes theo allowlist của loại chủ → bỏ EXIF → quét mã độc → ghi object
// (khoá có tiền tố tổ chức) → hàng `files`. Đọc: kiểm quyền TRƯỚC, rồi mới cấp URL ký ≤ 5 phút.

import { createHash, randomUUID } from "node:crypto";
import { authorize } from "@hm/domain";
import { sql } from "kysely";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";
import { ScannerUnavailableError } from "./clamd.ts";
import {
  CorruptFileError,
  type DetectedMime,
  detectMime,
  type MalwareScanner,
  stripImageMetadata,
} from "./inspect.ts";
import { MAX_SIGNED_URL_SECONDS, type ObjectStorage } from "./storage.ts";

export type FileOwnerType =
  | "work_order"
  | "handover"
  | "meter_reading"
  | "identity_document"
  | "task"
  | "residence_notice"
  | "payment_claim";

const IMAGES: readonly DetectedMime[] = ["image/jpeg", "image/png", "image/webp"];
const ALLOW: Readonly<Record<FileOwnerType, readonly DetectedMime[]>> = {
  work_order: IMAGES,
  handover: IMAGES,
  meter_reading: IMAGES,
  task: IMAGES,
  identity_document: [...IMAGES, "application/pdf"],
  // Ảnh/PDF bằng chứng đã thông báo lưu trú (SPEC-reservation-stay S-029).
  residence_notice: [...IMAGES, "application/pdf"],
  // Ảnh/PDF chuyển khoản người thuê đính kèm "Tôi đã chuyển" (SPEC-portal Q-07) — không đủ để xác nhận thu (INV-F3).
  payment_claim: [...IMAGES, "application/pdf"],
};
/** 10 MB/ảnh (đề xuất SPEC-housekeeping Q, chờ PO). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface FileDeps {
  storage: ObjectStorage;
  scanner: MalwareScanner;
}

/** Quét bắt buộc: máy quét lỗi/không trả lời → 503, file không được ghi, không bao giờ coi là sạch (D-003). */
async function scanOrFail(deps: FileDeps, bytes: Uint8Array) {
  try {
    return await deps.scanner.scan(bytes);
  } catch (err) {
    if (err instanceof ScannerUnavailableError)
      throw new CommandError(
        "SERVICE_UNAVAILABLE",
        503,
        "Chưa kiểm tra được an toàn của file, vui lòng thử lại sau",
      );
    throw err;
  }
}

const UPLOAD_ACTION: Partial<Record<FileOwnerType, "identity.read" | "residence_notice.manage">> = {
  identity_document: "identity.read",
  residence_notice: "residence_notice.manage",
};

export async function uploadFile(
  ctx: CommandContext,
  deps: FileDeps,
  input: { ownerType: FileOwnerType; ownerId?: string; propertyId: string; bytes: Uint8Array },
): Promise<{ fileId: string; status: "ready" | "rejected"; mime: DetectedMime }> {
  if (ctx.actor.role === "tenant") {
    // Người thuê (portal, SPEC-portal S-008/S-010): chỉ ảnh sự cố/báo chuyển, chỉ cho cơ sở có hợp đồng mình đứng tên
    // (CSDL cũng chặn — 0038 `portal_files`).
    if (input.ownerType !== "work_order" && input.ownerType !== "payment_claim")
      throw new CommandError("FORBIDDEN", 403, "Bạn không có quyền tải loại file này");
    const own = await sql<{ ok: boolean }>`
      select ${input.propertyId}::uuid in (select app.tenant_property_ids()) as ok`.execute(ctx.trx);
    if (!own.rows[0]?.ok) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  } else {
    authorize(ctx.actor, UPLOAD_ACTION[input.ownerType] ?? "work_order.create", {
      propertyId: input.propertyId,
    });
  }
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
  const scan = await scanOrFail(deps, input.bytes);
  const status = scan.clean ? "ready" : "rejected";
  // Hàng trước, object sau: lỗi ràng buộc (cơ sở không tồn tại…) dừng trước khi có object. Object ghi rồi mà
  // transaction không commit (lỗi sau đó, lỗi commit, thử lại 40001) → xoá object, không để ảnh mồ côi (INV-G7).
  await sql`
    insert into files (id, organization_id, property_id, owner_type, owner_id, mime, size_bytes, sha256, status, storage_key,
                       exif_stripped, uploaded_by, scanned_at, reject_reason)
    values (${id}, ${ctx.actor.orgId}, ${input.propertyId}, ${input.ownerType}, ${input.ownerId ?? null}, ${mime}, ${content.byteLength},
            ${sha256}, ${status}, ${key}, ${mime.startsWith("image/")}, ${ctx.actor.membershipId}, now(),
            ${scan.clean ? null : scan.reason})`.execute(ctx.trx);
  // File nhiễm KHÔNG được lưu nội dung; chỉ giữ metadata để truy vết.
  if (scan.clean) {
    ctx.onRollback(() => deps.storage.delete(key));
    await deps.storage.put(key, content, mime);
  }
  await ctx.audit({
    action: scan.clean ? "file.uploaded" : "file.rejected",
    entityType: "file",
    entityId: id,
    propertyId: input.propertyId,
    after: { owner_type: input.ownerType, mime, size_bytes: content.byteLength },
  });
  return { fileId: id, status, mime };
}

export type TabularMime = "text/csv" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * File nguồn dạng bảng (CSV/XLSX) của lô nhập (SPEC-import mục 4): riêng tư, khoá có tiền tố tổ chức, quét mã độc; không
 * phải ảnh nên không bỏ EXIF. Người gọi kiểm quyền (`import.prepare`) và nhận dạng định dạng trước. Nhiễm ⇒ 415, không lưu.
 */
export async function storeTabularFile(
  ctx: CommandContext,
  deps: FileDeps,
  input: { ownerId: string; propertyId: string; bytes: Uint8Array; mime: TabularMime },
): Promise<{ fileId: string; sha256: string }> {
  const scan = await scanOrFail(deps, input.bytes);
  if (!scan.clean) throw new CommandError("FILE_TYPE_NOT_ALLOWED", 415, "File bị từ chối khi quét an toàn");
  const id = randomUUID();
  const key = `${ctx.actor.orgId}/import_batch/${id}`;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  await sql`
    insert into files (id, organization_id, property_id, owner_type, owner_id, mime, size_bytes, sha256, status, storage_key,
                       uploaded_by, scanned_at)
    values (${id}, ${ctx.actor.orgId}, ${input.propertyId}, 'import_batch', ${input.ownerId}, ${input.mime},
            ${input.bytes.byteLength}, ${sha256}, 'ready', ${key}, ${ctx.actor.membershipId}, now())`.execute(
    ctx.trx,
  );
  ctx.onRollback(() => deps.storage.delete(key));
  await deps.storage.put(key, input.bytes, input.mime);
  return { fileId: id, sha256 };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Quyền đọc theo loại chủ — allowlist; loại chưa khai báo (export_job…) bị từ chối. */
const READ_ACTION: Readonly<
  Record<string, "identity.read" | "calendar.read_status" | "residence_notice.manage" | "money.read">
> = {
  payment_claim: "money.read",
  identity_document: "identity.read",
  residence_notice: "residence_notice.manage",
  work_order: "calendar.read_status",
  handover: "calendar.read_status",
  meter_reading: "calendar.read_status",
  task: "calendar.read_status",
};

/** URL ký cho file — chỉ sau khi kiểm quyền; không thấy (khác tổ chức, ngoài phạm vi, không đủ vai trò) → NOT_FOUND. */
export async function getFileUrl(
  ctx: CommandContext,
  deps: FileDeps,
  fileId: string,
): Promise<{ url: string; expiresIn: number }> {
  if (!UUID.test(fileId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy file");
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
  const action = f ? READ_ACTION[f.owner_type] : undefined;
  if (f?.status !== "ready" || !action) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy file");
  try {
    // Người thuê: RLS `portal_files` (0038) đã chỉ để lộ file của chính mình/chỉ số mình được xem — không có phạm vi
    // cơ sở để kiểm thêm; vai trò khác kiểm theo ma trận.
    if (ctx.actor.role !== "tenant")
      authorize(ctx.actor, action, {
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

/**
 * File do hệ thống SINH (không phải người dùng tải lên — vd file thông báo lưu trú, file xuất): riêng tư, khoá có tiền tố tổ
 * chức, hạn xoá `deleteAfterDays`; người gọi đã kiểm quyền. Không qua máy quét (nội dung do chính ứng dụng tạo).
 */
export async function storeGeneratedFile(
  ctx: CommandContext,
  deps: Pick<FileDeps, "storage">,
  input: {
    ownerType: "residence_notice" | "export_job";
    ownerId: string;
    propertyId: string | null;
    bytes: Uint8Array;
    mime: TabularMime;
    deleteAfterDays: number;
  },
): Promise<{ fileId: string }> {
  const id = randomUUID();
  const key = `${ctx.actor.orgId}/${input.ownerType}/${id}`;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  await sql`
    insert into files (id, organization_id, property_id, owner_type, owner_id, mime, size_bytes, sha256, status, storage_key,
                       uploaded_by, scanned_at, delete_after)
    values (${id}, ${ctx.actor.orgId}, ${input.propertyId}, ${input.ownerType}, ${input.ownerId}, ${input.mime},
            ${input.bytes.byteLength}, ${sha256}, 'ready', ${key}, ${ctx.actor.membershipId}, now(),
            current_date + ${input.deleteAfterDays}::int)`.execute(ctx.trx);
  ctx.onRollback(() => deps.storage.delete(key));
  await deps.storage.put(key, input.bytes, input.mime);
  return { fileId: id };
}
