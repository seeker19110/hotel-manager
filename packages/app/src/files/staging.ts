// Dòng staging của file — đưa quét mã độc + ghi object RA NGOÀI transaction lệnh (PLAN đợt 4 T-303; DB-TX-003, ARC-INT-003;
// D-025). Trình tự cho mọi luồng ghi file:
//   1. PREPARE (ngoài transaction lệnh): kiểm quyền/định dạng → `stageFile` (transaction NGẮN chèn dòng `files` ở
//      `pending_scan`, `delete_after` = hôm nay (giờ VN) + 2 ngày) → quét + `storage.put` KHÔNG giữ kết nối CSDL nào.
//   2. COMMIT (trong transaction lệnh): `finalizeStaged` chuyển dòng sang `ready`/`rejected` — chỉ I/O CSDL.
// Object mồ côi: lệnh lỗi (nghiệp vụ, 40001 hết lượt thử, sập tiến trình) giữa hai bước để lại object + dòng `pending_scan`;
// job hạn giữ `runRetention` (app.files_due_for_deletion/mark_file_deleted, migration 0047) xoá object rồi đánh dấu `deleted`
// khi `delete_after` tới hạn — không cần quét bucket. Không xoá bù ngay khi lệnh lỗi: pipeline thử lại cùng handler (40001) với
// cùng object đã ghi.
// Idempotent theo Idempotency-Key: id/khoá object suy từ (tổ chức, người, phạm vi, key) nên gửi lại cùng key ghi đè đúng object
// đó (PUT theo key) và, nếu dòng đã `ready`/`rejected`, bỏ qua quét + put.
import { createHash } from "node:crypto";
import { withTenant } from "@hm/db";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/index.ts";
import { CommandError } from "../pipeline/index.ts";

/** Hạn (ngày, giờ VN) của dòng staging — dư để lượt quét/ghi chậm hoặc replay không bị job hạn giữ xoá giữa chừng. */
export const STAGING_TTL_DAYS = 2;

/** UUID (phiên bản 5 kiểu băm SHA-256) tất định theo (tổ chức, người, phạm vi, Idempotency-Key). */
export function stagedId(orgId: string, membershipId: string, scope: string, idempotencyKey: string): string {
  const h = createHash("sha256")
    .update(`hm-staged-file-v1\n${orgId}\n${membershipId}\n${scope}\n${idempotencyKey.toLowerCase()}`)
    .digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Khoá object luôn có tiền tố tổ chức (IND-SAAS-003, ck_files_key_prefix). */
export const stagedKey = (orgId: string, ownerType: string, id: string): string =>
  `${orgId}/${ownerType}/${id}`;

export interface StageSpec {
  id: string;
  ownerType: string;
  ownerId: string | null;
  propertyId: string | null;
  mime: string;
  size: number;
  sha256: string;
  exifStripped: boolean;
}

export interface StageResult {
  /** `new`: vừa tạo · `pending`: dòng staging cũ chưa chốt (lượt trước lỗi/đang chạy) · `done`: đã `ready`/`rejected`. */
  state: "new" | "pending" | "done";
  status: "pending_scan" | "ready" | "rejected";
  rejectReason: string | null;
  key: string;
}

const conflict = (msg: string) => new CommandError("IDEMPOTENCY_CONFLICT", 409, msg);

/** Chèn dòng staging bằng transaction ngắn trong ngữ cảnh người dùng (RLS: chỉ chính người tạo — migration 0047). */
export async function stageFile(db: Kysely<unknown>, actor: Actor, spec: StageSpec): Promise<StageResult> {
  const key = stagedKey(actor.orgId, spec.ownerType, spec.id);
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
    stageInTrx(trx, actor, spec, key),
  ).catch((err: unknown) => {
    // Cơ sở không tồn tại (FK) — cùng kết quả với đường cũ: không phải lỗi máy chủ.
    if ((err as { code?: string }).code === "23503")
      throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
    throw err;
  });
}

async function stageInTrx(
  trx: Transaction<unknown>,
  actor: Actor,
  spec: StageSpec,
  key: string,
): Promise<StageResult> {
  const ins = await sql<{ id: string }>`
      insert into files (id, organization_id, property_id, owner_type, owner_id, mime, size_bytes, sha256, status, storage_key,
                         exif_stripped, uploaded_by, delete_after)
      values (${spec.id}, ${actor.orgId}, ${spec.propertyId}, ${spec.ownerType}, ${spec.ownerId}, ${spec.mime}, ${spec.size},
              ${spec.sha256}, 'pending_scan', ${key}, ${spec.exifStripped}, ${actor.membershipId},
              (now() at time zone 'Asia/Ho_Chi_Minh')::date + ${STAGING_TTL_DAYS}::int)
      on conflict do nothing
      returning id`.execute(trx);
  if (ins.rows.length > 0) return { state: "new", status: "pending_scan", rejectReason: null, key };
  const r = await sql<{
    status: string;
    sha256: string;
    owner_type: string;
    owner_id: string | null;
    property_id: string | null;
    uploaded_by: string | null;
    storage_key: string;
    reject_reason: string | null;
    expired: boolean;
  }>`
      select status, sha256, owner_type, owner_id, property_id, uploaded_by, storage_key, reject_reason,
             coalesce(delete_after <= (now() at time zone 'Asia/Ho_Chi_Minh')::date, false) as expired
      from files
      where organization_id = ${actor.orgId} and id = ${spec.id}`.execute(trx);
  const f = r.rows[0];
  // Không thấy (RLS) hoặc khác người/nội dung/loại/cơ sở/chủ sở hữu ⇒ cùng khoá nhưng khác yêu cầu.
  if (
    !f ||
    f.uploaded_by !== actor.membershipId ||
    f.sha256 !== spec.sha256 ||
    f.owner_type !== spec.ownerType ||
    (f.owner_id ?? null) !== (spec.ownerId ?? null) ||
    (f.property_id ?? null) !== (spec.propertyId ?? null) ||
    f.storage_key !== key
  )
    throw conflict("Idempotency-Key đã dùng cho yêu cầu khác");
  if (f.status === "deleted") throw conflict("Idempotency-Key đã hết hạn, hãy tạo khoá mới");
  // Dòng chưa chốt tới/quá `delete_after` (hôm nay giờ VN, cùng phép so `<=` với app.files_due_for_deletion mà `runRetention`
  // dùng) có thể đang/sắp bị job hạn giữ xoá object ⇒ không chốt lại dòng đó.
  if (f.status === "pending_scan" && f.expired)
    throw conflict("Idempotency-Key đã hết hạn, hãy tạo khoá mới");
  if (f.status === "ready" || f.status === "rejected")
    return { state: "done", status: f.status, rejectReason: f.reject_reason, key };
  return { state: "pending", status: "pending_scan", rejectReason: null, key };
}

export interface Finalize {
  status: "ready" | "rejected";
  rejectReason?: string | null;
  /** Số ngày giữ kể từ hôm nay (CSDL); `null` = giữ vĩnh viễn (bỏ hạn staging); `"keep"` = giữ nguyên `delete_after`. */
  deleteAfterDays: number | null | "keep";
}

/** Chốt dòng staging trong transaction lệnh. Đã chốt đúng như vậy (lệnh chạy lại) ⇒ coi như xong; khác ⇒ 409. */
export async function finalizeStaged(
  trx: Transaction<unknown>,
  actor: Actor,
  id: string,
  to: Finalize,
): Promise<void> {
  const after =
    to.deleteAfterDays === "keep"
      ? sql`delete_after`
      : to.deleteAfterDays === null
        ? sql`null::date`
        : sql`current_date + ${to.deleteAfterDays}::int`;
  const u = await sql<{ id: string }>`
    update files set status = ${to.status}, scanned_at = now(), reject_reason = ${to.rejectReason ?? null},
                     delete_after = ${after}, version = version + 1
    where organization_id = ${actor.orgId} and id = ${id} and uploaded_by = ${actor.membershipId}
      and status = 'pending_scan'
    returning id`.execute(trx);
  if (u.rows.length > 0) return;
  const r = await sql<{ status: string }>`
    select status from files where organization_id = ${actor.orgId} and id = ${id} and uploaded_by = ${actor.membershipId}`.execute(
    trx,
  );
  if (r.rows[0]?.status !== to.status) throw conflict("File chuẩn bị không còn hiệu lực, hãy tải lại");
}

/** Chạy bước prepare ngoài transaction và giữ kết quả/lỗi để ném lại TRONG handler (giữ ghi `failed` + audit `denied`). */
export { type Settled, settle, unwrap } from "../pipeline/index.ts";
