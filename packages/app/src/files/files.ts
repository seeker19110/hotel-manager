// File riêng tư (SPEC-housekeeping-maintenance, ERD files; TM-06, TM-07; ADR-0002).
// Tải lên: kiểm kích thước → nhận dạng magic bytes theo allowlist của loại chủ → bỏ EXIF → quét mã độc → ghi object
// (khoá có tiền tố tổ chức) → hàng `files`. Đọc: kiểm quyền TRƯỚC, rồi mới cấp URL ký ≤ 5 phút.

import { createHash, randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { type Action, authorize, mibToBytes } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/index.ts";
import { t } from "../i18n.ts";
import { type CommandContext, CommandError } from "../pipeline/index.ts";
import { ScannerUnavailableError } from "./clamd.ts";
import {
  CorruptFileError,
  type DetectedMime,
  detectMime,
  type MalwareScanner,
  stripImageMetadata,
} from "./inspect.ts";
import { finalizeStaged, stagedId, stageFile } from "./staging.ts";
import { MAX_SIGNED_URL_SECONDS, type ObjectStorage } from "./storage.ts";

export type FileOwnerType =
  | "work_order"
  | "handover"
  | "meter_reading"
  | "identity_document"
  | "task"
  | "residence_notice"
  | "payment_claim"
  | "lease_settlement";

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
  // Ảnh chứng cứ phí thanh lý (SPEC-lease: lập quyết toán `fees[].fileIds`) — chỉ ảnh, không PDF.
  lease_settlement: IMAGES,
};
/** 10 MB/ảnh (đề xuất SPEC-housekeeping Q, chờ PO). */
export const MAX_FILE_BYTES = mibToBytes(10);

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
      throw new CommandError("SERVICE_UNAVAILABLE", 503, t("files.scanner_unavailable"));
    throw err;
  }
}

/**
 * Quyền ghi theo loại chủ (nhân viên) — allowlist, MẶC ĐỊNH TỪ CHỐI: loại không khai ở đây (handover, meter_reading, task,
 * payment_claim — loại sau chỉ người thuê tải qua cổng) không có đường tải lên của nhân viên.
 */
const UPLOAD_ACTION: Partial<Record<FileOwnerType, Action>> = {
  work_order: "work_order.create",
  identity_document: "identity.read",
  residence_notice: "residence_notice.manage",
  // Cùng quyền lập quyết toán (`lease.prepare_settlement`): người không lập được quyết toán không có lý do tải ảnh phí.
  lease_settlement: "lease.prepare_settlement",
};

export interface UploadInput {
  ownerType: FileOwnerType;
  ownerId?: string;
  propertyId: string;
  bytes: Uint8Array;
}

/** Kiểm quyền tải lên (vai trò + cơ sở của người thuê). Chạy ở bước prepare (transaction ngắn) VÀ lại trong lệnh. */
async function assertUploadAllowed(
  trx: Transaction<unknown>,
  actor: Actor,
  input: UploadInput,
): Promise<void> {
  if (actor.role === "tenant") {
    // Người thuê (portal, SPEC-portal S-008/S-010): chỉ ảnh sự cố/báo chuyển, chỉ cho cơ sở có hợp đồng mình đứng tên
    // (CSDL cũng chặn — 0038 `portal_files`).
    if (input.ownerType !== "work_order" && input.ownerType !== "payment_claim")
      throw new CommandError("FORBIDDEN", 403, t("files.upload_forbidden"));
    const own = await sql<{ ok: boolean }>`
      select ${input.propertyId}::uuid in (select app.tenant_property_ids()) as ok`.execute(trx);
    if (!own.rows[0]?.ok) throw new CommandError("NOT_FOUND", 404, t("common.property_not_found"));
  } else {
    const action = UPLOAD_ACTION[input.ownerType];
    if (!action) throw new CommandError("FORBIDDEN", 403, t("files.upload_forbidden"));
    authorize(actor, action, { propertyId: input.propertyId });
  }
}

/** Kích thước → magic bytes theo allowlist → bỏ EXIF. Thuần CPU, không I/O. */
function inspectUpload(input: UploadInput): { mime: DetectedMime; content: Uint8Array } {
  if (input.bytes.byteLength === 0) throw new CommandError("VALIDATION_FAILED", 422, t("files.empty"));
  if (input.bytes.byteLength > MAX_FILE_BYTES)
    throw new CommandError("FILE_TOO_LARGE", 413, t("http.file_too_large"));
  const mime = detectMime(input.bytes);
  if (!mime || !ALLOW[input.ownerType].includes(mime)) {
    throw new CommandError("FILE_TYPE_NOT_ALLOWED", 415, t("files.type_not_allowed"));
  }
  try {
    return { mime, content: stripImageMetadata(input.bytes, mime) };
  } catch (err) {
    if (err instanceof CorruptFileError)
      throw new CommandError("FILE_TYPE_NOT_ALLOWED", 415, t("files.image_corrupt"));
    throw err;
  }
}

/** Kết quả bước prepare: object đã nằm trong kho (nếu sạch), dòng `files` đang `pending_scan` chờ lệnh chốt. */
export interface PreparedUpload {
  fileId: string;
  mime: DetectedMime;
  size: number;
  status: "ready" | "rejected";
  rejectReason: string | null;
  ownerType: FileOwnerType;
  propertyId: string;
}

/**
 * Bước chuẩn bị NGOÀI transaction lệnh (T-303): kiểm quyền (transaction ngắn) → định dạng → dòng staging → quét → ghi object.
 * Trong lúc quét/ghi không có kết nối CSDL nào bị giữ. Gọi trước `executeCommand`; truyền kết quả vào `uploadFile`.
 */
export async function prepareUpload(
  db: Kysely<unknown>,
  deps: FileDeps,
  actor: Actor,
  input: UploadInput,
  idempotencyKey: string,
): Promise<PreparedUpload> {
  await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
    assertUploadAllowed(trx, actor, input),
  );
  const { mime, content } = inspectUpload(input);
  const id = stagedId(actor.orgId, actor.membershipId, `file.upload:${input.ownerType}`, idempotencyKey);
  const base = {
    fileId: id,
    mime,
    size: content.byteLength,
    ownerType: input.ownerType,
    propertyId: input.propertyId,
  };
  const staged = await stageFile(db, actor, {
    id,
    ownerType: input.ownerType,
    ownerId: input.ownerId ?? null,
    propertyId: input.propertyId,
    mime,
    size: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    exifStripped: mime.startsWith("image/"),
  });
  if (staged.state === "done" && staged.status !== "pending_scan")
    return { ...base, status: staged.status, rejectReason: staged.rejectReason };
  const scan = await scanOrFail(deps, input.bytes);
  // File nhiễm KHÔNG được lưu nội dung; chỉ giữ metadata để truy vết.
  if (scan.clean) await deps.storage.put(staged.key, content, mime);
  return {
    ...base,
    status: scan.clean ? "ready" : "rejected",
    rejectReason: scan.clean ? null : scan.reason,
  };
}

/**
 * Sự kiện bảo mật của một lần tải file (SEC-LOG-001 "upload"): `file.uploaded` khi vào `ready`, `file.upload_rejected` (denied)
 * khi quét an toàn từ chối (hàng `rejected` vẫn được giữ để truy vết). Chỉ phát SAU commit; không ghi tên file/nội dung/lý do tự do.
 */
function securityOfUpload(ctx: CommandContext, fileId: string, status: "ready" | "rejected"): void {
  ctx.security(
    status === "ready"
      ? { event: "file.uploaded", target: { type: "file", id: fileId } }
      : {
          event: "file.upload_rejected",
          outcome: "denied",
          target: { type: "file", id: fileId },
          reason: "SCAN_REJECTED",
        },
  );
}

export async function uploadFile(
  ctx: CommandContext,
  deps: FileDeps,
  input: UploadInput & {
    /** Từ `prepareUpload` (đường sản phẩm). Không có ⇒ đường cũ quét + ghi object NGAY TRONG transaction (chỉ cho test/gọi trực tiếp). */
    prepared?: PreparedUpload;
  },
): Promise<{ fileId: string; status: "ready" | "rejected"; mime: DetectedMime }> {
  await assertUploadAllowed(ctx.trx, ctx.actor, input);
  const p = input.prepared;
  if (p) {
    if (p.ownerType !== input.ownerType || p.propertyId !== input.propertyId)
      throw new Error(t("files.prepared_mismatch"));
    await finalizeStaged(ctx.trx, ctx.actor, p.fileId, {
      status: p.status,
      rejectReason: p.rejectReason,
      deleteAfterDays: null,
    });
    await ctx.audit({
      action: p.status === "ready" ? "file.uploaded" : "file.rejected",
      entityType: "file",
      entityId: p.fileId,
      propertyId: input.propertyId,
      after: { owner_type: input.ownerType, mime: p.mime, size_bytes: p.size },
    });
    securityOfUpload(ctx, p.fileId, p.status);
    return { fileId: p.fileId, status: p.status, mime: p.mime };
  }
  const { mime, content } = inspectUpload(input);
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
  securityOfUpload(ctx, id, status);
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
  if (!scan.clean) throw new CommandError("FILE_TYPE_NOT_ALLOWED", 415, t("files.scan_rejected"));
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

/** Kết quả prepare của file nguồn lô nhập: object đã ghi, dòng `files` còn `pending_scan` chờ lệnh `import.upload` chốt. */
export interface PreparedTabular {
  fileId: string;
  /** Id lô nhập dự kiến (cố định theo Idempotency-Key để dòng staging trỏ đúng lô). */
  batchId: string;
  sha256: string;
  size: number;
  mime: TabularMime;
}

/** Bước chuẩn bị NGOÀI transaction cho file CSV/XLSX (xem staging.ts). Máy quét báo nhiễm ⇒ 415, không ghi object. */
export async function prepareTabularFile(
  db: Kysely<unknown>,
  deps: FileDeps,
  actor: Actor,
  input: { propertyId: string; bytes: Uint8Array; mime: TabularMime },
  idempotencyKey: string,
): Promise<PreparedTabular> {
  const fileId = stagedId(actor.orgId, actor.membershipId, "import.file", idempotencyKey);
  const batchId = stagedId(actor.orgId, actor.membershipId, "import.batch", idempotencyKey);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const prepared: PreparedTabular = {
    fileId,
    batchId,
    sha256,
    size: input.bytes.byteLength,
    mime: input.mime,
  };
  const staged = await stageFile(db, actor, {
    id: fileId,
    ownerType: "import_batch",
    ownerId: batchId,
    propertyId: input.propertyId,
    mime: input.mime,
    size: input.bytes.byteLength,
    sha256,
    exifStripped: false,
  });
  if (staged.state === "done") return prepared;
  const scan = await scanOrFail(deps, input.bytes);
  if (!scan.clean) throw new CommandError("FILE_TYPE_NOT_ALLOWED", 415, t("files.scan_rejected"));
  await deps.storage.put(staged.key, input.bytes, input.mime);
  return prepared;
}

/** Chốt file nguồn đã chuẩn bị trong transaction lệnh (chỉ CSDL). */
export async function commitTabularFile(
  ctx: CommandContext,
  prepared: PreparedTabular,
): Promise<{ fileId: string; sha256: string }> {
  await finalizeStaged(ctx.trx, ctx.actor, prepared.fileId, { status: "ready", deleteAfterDays: null });
  return { fileId: prepared.fileId, sha256: prepared.sha256 };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Quyền đọc theo loại chủ — allowlist; loại chưa khai báo (export_job…) bị từ chối. */
const READ_ACTION: Readonly<
  Record<string, "identity.read" | "calendar.read_status" | "residence_notice.manage" | "money.read">
> = {
  payment_claim: "money.read",
  // Cùng quyền đọc quyết toán: CSDL (0052 `tenant_isolation`) chỉ trả hàng cho owner/manager/accountant trong phạm vi cơ sở.
  lease_settlement: "money.read",
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
  if (!UUID.test(fileId)) throw new CommandError("NOT_FOUND", 404, t("files.not_found"));
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
  if (f?.status !== "ready" || !action) throw new CommandError("NOT_FOUND", 404, t("files.not_found"));
  try {
    // Người thuê: RLS `portal_files` (0039) đã chỉ để lộ file của chính mình/chỉ số mình được xem — không có phạm vi
    // cơ sở để kiểm thêm; vai trò khác kiểm theo ma trận.
    if (ctx.actor.role !== "tenant")
      authorize(ctx.actor, action, {
        ...(f.property_id ? { propertyId: f.property_id } : {}),
      });
  } catch {
    // Không phân biệt "không có quyền" với "không tồn tại" (API-CONTRACT §2).
    throw new CommandError("NOT_FOUND", 404, t("files.not_found"));
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
            (now() at time zone 'UTC')::date + ${input.deleteAfterDays}::int)`.execute(ctx.trx);
  ctx.onRollback(() => deps.storage.delete(key));
  await deps.storage.put(key, input.bytes, input.mime);
  return { fileId: id };
}

export interface PreparedGenerated {
  fileId: string;
  /** Khoá object trong kho (có tiền tố tổ chức). */
  key: string;
  sha256: string;
  size: number;
  ownerType: "residence_notice" | "export_job";
  ownerId: string;
  propertyId: string | null;
}

/**
 * Bước chuẩn bị NGOÀI transaction cho file hệ thống sinh (thông báo lưu trú, bản xuất): dòng staging → ghi object.
 * `scope`/`idempotencyKey` quyết định id (Idempotency-Key của lệnh, hoặc id job với bản xuất) nên chạy lại ghi đè đúng object đó.
 */
export async function prepareGeneratedFile(
  db: Kysely<unknown>,
  deps: Pick<FileDeps, "storage">,
  actor: Actor,
  input: {
    ownerType: PreparedGenerated["ownerType"];
    ownerId: string;
    propertyId: string | null;
    bytes: Uint8Array;
    mime: string;
  },
  idempotencyKey: string,
): Promise<PreparedGenerated> {
  const fileId = stagedId(actor.orgId, actor.membershipId, `generated:${input.ownerType}`, idempotencyKey);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const staged = await stageFile(db, actor, {
    id: fileId,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    propertyId: input.propertyId,
    mime: input.mime,
    size: input.bytes.byteLength,
    sha256,
    exifStripped: false,
  });
  if (staged.state !== "done") await deps.storage.put(staged.key, input.bytes, input.mime);
  return {
    fileId,
    key: staged.key,
    sha256,
    size: input.bytes.byteLength,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    propertyId: input.propertyId,
  };
}

/** Chốt file sinh sẵn trong một transaction (của lệnh hoặc của job): `ready` + hạn xoá (`"keep"` giữ hạn staging). */
export async function commitGeneratedFile(
  trx: Transaction<unknown>,
  actor: Actor,
  prepared: PreparedGenerated,
  deleteAfterDays: number | "keep",
): Promise<{ fileId: string }> {
  await finalizeStaged(trx, actor, prepared.fileId, { status: "ready", deleteAfterDays });
  return { fileId: prepared.fileId };
}
