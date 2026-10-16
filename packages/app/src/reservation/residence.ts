// Thông báo lưu trú (PLAN đợt 3 T-207; SPEC-reservation-stay S-028…S-030, Q-13; SPEC-notifications S-014…S-016, S-020, S-021;
// ERD `residence_notices`; INV-G1, INV-G2, INV-G6). Hệ thống CHỈ tạo dấu vết + xuất file để TẢI VỀ — không gửi gì tới cơ quan nhà nước.
// - Tạo `pending` ngay trong transaction check-in/walk-in (`createResidenceNotice`, gọi từ `stay.ts`): cùng transaction với việc stay
//   thành `in_house` (SPEC) nên không có khoảng "đã ở mà chưa có thông báo"; không tạo cho stay `no_show`/`cancelled` (không đi qua check-in).
// - `due_at` do hàm DB `app.residence_notice_due_at` tính theo cấu hình cơ sở + `properties.timezone` (INV-G2); chưa cấu hình → NULL (S-020),
//   `updateSettings` tính bù cho các lượt đang ở khi cơ sở cấu hình hạn sau đó (`backfillNoticeDeadlines`).
// - Mẫu file là cấu hình theo cơ sở (`notification_settings.residence_notice_template`), nguồn pháp lý/mẫu cơ quan (chưa xác minh — Q-13);
//   chỉ xuất trường trong danh mục (không SĐT/ảnh/tiền/ghi chú). File chứa SỐ GIẤY TỜ ĐẦY ĐỦ nên chỉ người có `residence_notice.manage` VÀ
//   `identity.read` (owner/manager/lễ tân trong phạm vi) xuất được; số đầy đủ KHÔNG vào audit/outbox/kết quả lệnh — chỉ nằm trong file riêng
//   tư (khoá có tiền tố tổ chức, URL ký ≤ 5 phút, tự xoá sau `RESIDENCE_EXPORT_RETENTION_DAYS`).
import { createHash, randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import {
  authorize,
  buildNoticeCsv,
  isForeignNationality,
  type NoticeGuest,
  parseNoticeTemplate,
} from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import type { FileDeps } from "../files/files.ts";
import { MAX_SIGNED_URL_SECONDS } from "../files/storage.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** File xuất tự xoá sau chừng này ngày (chứa số giấy tờ đầy đủ; xuất lại được bất cứ lúc nào khi lượt ở còn dữ liệu). */
export const RESIDENCE_EXPORT_RETENTION_DAYS = 30;
export const NOTICE_CHANNELS = ["in_person", "online", "other"] as const;
export type NoticeChannel = (typeof NOTICE_CHANNELS)[number];
export type NoticeStatus = "pending" | "exported" | "submitted";

const notFound = () => new CommandError("NOT_FOUND", 404, "Không tìm thấy thông báo lưu trú");

// ---------- tạo (trong check-in/walk-in) ----------

/**
 * Tạo `residence_notices` `pending` cho lượt ở vừa thành `in_house` (một dòng mỗi lượt — unique; gọi lại vô hại). `is_foreign` = có người
 * lưu trú nước ngoài; `due_at` theo cấu hình hạn của cơ sở (NULL nếu chưa cấu hình).
 */
export async function createResidenceNotice(
  ctx: CommandContext,
  input: { propertyId: string; stayId: string; isForeign: boolean; checkedInAt: Date },
): Promise<{ noticeId: string; dueAt: Date | null } | null> {
  const id = randomUUID();
  const r = await sql<{ id: string; due_at: Date | null }>`
    insert into residence_notices (id, organization_id, property_id, stay_id, is_foreign, due_at)
    values (${id}, ${ctx.actor.orgId}, ${input.propertyId}, ${input.stayId}, ${input.isForeign},
            app.residence_notice_due_at(${input.propertyId}, ${input.checkedInAt}, ${input.isForeign}))
    on conflict (organization_id, stay_id) do nothing
    returning id, due_at`.execute(ctx.trx);
  const row = r.rows[0];
  if (!row) return null;
  await ctx.audit({
    action: "residence_notice.created",
    entityType: "residence_notice",
    entityId: row.id,
    propertyId: input.propertyId,
    after: {
      status: "pending",
      stay_id: input.stayId,
      is_foreign: input.isForeign,
      due_at: row.due_at ? new Date(row.due_at).toISOString() : null,
    },
  });
  return { noticeId: row.id, dueAt: row.due_at ? new Date(row.due_at) : null };
}

/**
 * Cơ sở cấu hình hạn SAU khi đã có khách (S-020): tính `due_at` cho thông báo còn mở của các lượt đang ở mà chưa có hạn. Chỉ lượt `in_house`
 * (khớp định nghĩa cảnh báo "chưa cấu hình"), không động tới thông báo đã có hạn hay đã nộp. Trả số dòng đã cập nhật.
 */
export async function backfillNoticeDeadlines(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
): Promise<number> {
  const r = await sql`
    update residence_notices n set due_at = d.due
    from (select rn.id, app.residence_notice_due_at(rn.property_id, s.checked_in_at, rn.is_foreign) as due
          from residence_notices rn join stays s on s.organization_id = rn.organization_id and s.id = rn.stay_id
          where rn.organization_id = ${orgId} and rn.property_id = ${propertyId} and rn.status in ('pending','exported')
            and rn.due_at is null and s.status = 'in_house' and s.checked_in_at is not null) d
    where n.organization_id = ${orgId} and n.id = d.id and d.due is not null`.execute(trx);
  return Number(r.numAffectedRows ?? 0);
}

// ---------- stay.exportResidenceNotice ----------

interface NoticeRow {
  id: string;
  property_id: string;
  stay_id: string;
  status: NoticeStatus;
  is_foreign: boolean;
  due_at: Date | null;
  stay_status: string;
  primary_guest_person_id: string;
  additional_guest_person_ids: string[];
  unit_code: string;
  checked_in_local: string | null;
  departure_date: string | null;
}

export interface ExportResult {
  notice_id: string;
  stay_id: string;
  status: NoticeStatus;
  file_id: string;
  filename: string;
  /** URL ký ≤ 5 phút (chỉ để tải về). Lưu kèm kết quả lệnh nhưng hết hạn nhanh; cần link mới thì xuất lại. */
  url: string;
  expires_in: number;
  guests: number;
  is_foreign: boolean;
  /** `true` khi lần xuất này không phải lần đầu (trạng thái `exported` giữ nguyên). */
  re_export: boolean;
}

/**
 * `stay.exportResidenceNotice` (S-028, S-030): sinh CSV theo mẫu cơ sở, lưu file riêng tư, ghi `exported_at/by/file` (đi tiến
 * `pending → exported`; xuất lại giữ `exported`, mỗi lần một audit; đã `submitted` vẫn xuất được để lưu hồ sơ nhưng không đổi dòng).
 * Lỗi: không thấy/buồng phòng/khác tổ chức/lượt ở không có thông báo → 404; chưa cấu hình mẫu → 409 `NOTICE_TEMPLATE_MISSING`;
 * thiếu trường bắt buộc của mẫu → 422 kèm `errors[]` (`guests[i].<trường>`), không tạo file.
 */
export async function exportResidenceNotice(
  ctx: CommandContext,
  deps: Pick<FileDeps, "storage">,
  input: { stayId: string; now?: Date },
): Promise<ExportResult> {
  const now = input.now ?? new Date();
  if (!UUID.test(input.stayId)) throw notFound();
  const found = await sql<NoticeRow>`
    select n.id, n.property_id, n.stay_id, n.status, n.is_foreign, n.due_at, s.status as stay_status, s.primary_guest_person_id,
           s.additional_guest_person_ids, u.code as unit_code,
           to_char(s.checked_in_at at time zone p.timezone, 'YYYY-MM-DD HH24:MI') as checked_in_local,
           i.departure_date::text as departure_date
    from residence_notices n
    join stays s on s.organization_id = n.organization_id and s.id = n.stay_id
    join units u on u.organization_id = s.organization_id and u.id = s.unit_id
    join reservation_items i on i.organization_id = s.organization_id and i.id = s.reservation_item_id
    join properties p on p.organization_id = n.organization_id and p.id = n.property_id
    where n.organization_id = ${ctx.actor.orgId} and n.stay_id = ${input.stayId}
    for update of n`.execute(ctx.trx);
  const n = found.rows[0];
  // RLS: buồng phòng/bảo trì/kế toán không thấy hàng nào ⇒ 404 (S-025, S-028).
  if (!n) throw notFound();
  authorize(ctx.actor, "residence_notice.manage", { propertyId: n.property_id });
  authorize(ctx.actor, "identity.read", { propertyId: n.property_id });

  const tpl = await sql<{
    tpl: unknown;
  }>`select app.residence_notice_template(${n.property_id}) as tpl`.execute(ctx.trx);
  const template = parseNoticeTemplate(tpl.rows[0]?.tpl ?? null);
  if (!template)
    throw new CommandError("NOTICE_TEMPLATE_MISSING", 409, "Cơ sở chưa cấu hình mẫu thông báo lưu trú.");

  const ids = [n.primary_guest_person_id, ...n.additional_guest_person_ids];
  const people = await sql<{ id: string; full_name: string; nationality: string | null }>`
    select id, full_name, nationality from persons
    where organization_id = ${ctx.actor.orgId} and id = any(${ids}::uuid[])`.execute(ctx.trx);
  const docs = await sql<{ person_id: string; doc_type: "cccd" | "passport" | "other"; doc_number: string }>`
    select person_id, doc_type, doc_number from identity_documents
    where organization_id = ${ctx.actor.orgId} and person_id = any(${ids}::uuid[]) and anonymized_at is null
      and doc_number is not null
    order by created_at desc, id`.execute(ctx.trx);
  const guests: NoticeGuest[] = ids.flatMap((pid) => {
    const p = people.rows.find((x) => x.id === pid);
    if (!p) return [];
    const nat = p.nationality?.trim() || null;
    const mine = docs.rows.filter((d) => d.person_id === pid);
    const doc =
      (isForeignNationality(nat) ? mine.find((d) => d.doc_type === "passport") : undefined) ?? mine[0];
    return [
      {
        fullName: p.full_name ?? "",
        nationality: nat,
        docType: doc?.doc_type ?? null,
        docNumber: doc?.doc_number ?? null,
      },
    ];
  });

  const built = buildNoticeCsv(
    template,
    {
      unitCode: n.unit_code,
      checkedInLocal: n.checked_in_local ?? "",
      departureDate: n.departure_date,
      isForeign: n.is_foreign,
    },
    guests,
  );
  if (built.missing.length > 0) {
    throw new CommandError("VALIDATION_FAILED", 422, "Thiếu trường bắt buộc của mẫu thông báo lưu trú.", {
      extensions: {
        errors: built.missing.map((m) => ({ path: m.path, field: m.path, code: "REQUIRED" })),
      },
    });
  }

  const bytes = new TextEncoder().encode(built.csv);
  const fileId = randomUUID();
  const key = `${ctx.actor.orgId}/residence_notice/${fileId}`;
  await sql`
    insert into files (id, organization_id, property_id, owner_type, owner_id, mime, size_bytes, sha256, status, storage_key,
                       uploaded_by, scanned_at, delete_after)
    values (${fileId}, ${ctx.actor.orgId}, ${n.property_id}, 'residence_notice', ${n.id}, 'text/csv', ${bytes.byteLength},
            ${createHash("sha256").update(bytes).digest("hex")}, 'ready', ${key}, ${ctx.actor.membershipId}, ${now},
            (${now}::timestamptz at time zone 'utc')::date + ${RESIDENCE_EXPORT_RETENTION_DAYS}::int)`.execute(
    ctx.trx,
  );
  // Object ghi trước commit: lệnh không commit được thì xoá object (không để file PII mồ côi).
  ctx.onRollback(() => deps.storage.delete(key));
  await deps.storage.put(key, bytes, "text/csv");

  const reExport = n.status !== "pending";
  if (n.status !== "submitted") {
    await sql`
      update residence_notices set status = 'exported', exported_at = ${now}, exported_by = ${ctx.actor.membershipId},
             export_file_id = ${fileId}
      where organization_id = ${ctx.actor.orgId} and id = ${n.id} and status in ('pending','exported')`.execute(
      ctx.trx,
    );
  }
  const status: NoticeStatus = n.status === "submitted" ? "submitted" : "exported";
  // Audit KHÔNG chứa số giấy tờ/tên: chỉ id file, số người, tên cột.
  await ctx.audit({
    action: "residence_notice.exported",
    entityType: "residence_notice",
    entityId: n.id,
    propertyId: n.property_id,
    before: { status: n.status },
    after: {
      status,
      stay_id: n.stay_id,
      file_id: fileId,
      guests: guests.length,
      columns: built.columns,
      is_foreign: n.is_foreign,
      re_export: reExport,
    },
  });
  const url = await deps.storage.signedGetUrl(key, MAX_SIGNED_URL_SECONDS);
  return {
    notice_id: n.id,
    stay_id: n.stay_id,
    status,
    file_id: fileId,
    filename: `thong-bao-luu-tru-${n.unit_code}-${(n.checked_in_local ?? "").slice(0, 10)}.csv`,
    url,
    expires_in: MAX_SIGNED_URL_SECONDS,
    guests: guests.length,
    is_foreign: n.is_foreign,
    re_export: reExport,
  };
}

// ---------- stay.markNoticeSubmitted ----------

export interface NoticeView {
  notice_id: string;
  stay_id: string;
  status: NoticeStatus;
  is_foreign: boolean;
  due_at: string | null;
  exported_at: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  channel: NoticeChannel | null;
  has_evidence: boolean;
}

/**
 * `stay.markNoticeSubmitted` (S-029): `pending`/`exported` → `submitted` (người gửi = người thao tác). Hệ thống không gửi gì cho cơ quan nhà
 * nước. Đã `submitted` → 409 `INVALID_TRANSITION` (cùng Idempotency-Key thì pipeline trả lại kết quả cũ); `submitted_at` ở tương lai →
 * 422; kênh ngoài `in_person|online|other` → 422. File bằng chứng (nếu có) phải là file `residence_notice` sẵn sàng của cùng cơ sở.
 * Nộp sau hạn vẫn hợp lệ (audit ghi `after_due`); từ đây job nhắc dừng.
 */
export async function markNoticeSubmitted(
  ctx: CommandContext,
  input: { noticeId: string; submittedAt: Date; channel: string; evidenceFileId?: string; now?: Date },
): Promise<NoticeView> {
  const now = input.now ?? new Date();
  if (!UUID.test(input.noticeId)) throw notFound();
  const r = await sql<{
    id: string;
    property_id: string;
    stay_id: string;
    status: NoticeStatus;
    due_at: Date | null;
  }>`
    select id, property_id, stay_id, status, due_at from residence_notices
    where organization_id = ${ctx.actor.orgId} and id = ${input.noticeId} for update`.execute(ctx.trx);
  const n = r.rows[0];
  if (!n) throw notFound();
  authorize(ctx.actor, "residence_notice.manage", { propertyId: n.property_id });
  if (!(NOTICE_CHANNELS as readonly string[]).includes(input.channel))
    throw fieldError("channel", "INVALID", "Kênh thông báo: in_person, online hoặc other");
  if (Number.isNaN(input.submittedAt.getTime()))
    throw fieldError("submitted_at", "INVALID", "Thời điểm thông báo không hợp lệ");
  if (input.submittedAt.getTime() > now.getTime())
    throw fieldError("submitted_at", "IN_FUTURE", "Thời điểm thông báo không được ở tương lai");
  if (n.status === "submitted")
    throw new CommandError("INVALID_TRANSITION", 409, "Thông báo lưu trú đã được đánh dấu đã thông báo.", {
      extensions: { from: "submitted", to: "submitted" },
    });
  if (input.evidenceFileId !== undefined) {
    const f = UUID.test(input.evidenceFileId)
      ? await sql`
          select 1 from files
          where organization_id = ${ctx.actor.orgId} and id = ${input.evidenceFileId} and owner_type = 'residence_notice'
            and status = 'ready' and deleted_at is null and property_id = ${n.property_id}
            and (owner_id is null or owner_id = ${n.id})`.execute(ctx.trx)
      : { rows: [] };
    if (f.rows.length === 0)
      throw fieldError("evidence_file_id", "NOT_FOUND", "Không tìm thấy file bằng chứng hợp lệ");
  }
  const upd = await sql<{
    stay_id: string;
    is_foreign: boolean;
    exported_at: Date | null;
    channel: NoticeChannel;
    submitted_at: Date;
    evidence_file_id: string | null;
  }>`
    update residence_notices set status = 'submitted', submitted_at = ${input.submittedAt},
           submitted_by = ${ctx.actor.membershipId}, channel = ${input.channel},
           evidence_file_id = ${input.evidenceFileId ?? null}
    where organization_id = ${ctx.actor.orgId} and id = ${n.id} and status in ('pending','exported')
    returning stay_id, is_foreign, exported_at, channel, submitted_at, evidence_file_id`.execute(ctx.trx);
  const u = upd.rows[0];
  if (!u)
    throw new CommandError("INVALID_TRANSITION", 409, "Thông báo lưu trú đã được đánh dấu đã thông báo.");
  const afterDue = n.due_at !== null && input.submittedAt.getTime() > new Date(n.due_at).getTime();
  await ctx.audit({
    action: "residence_notice.submitted",
    entityType: "residence_notice",
    entityId: n.id,
    propertyId: n.property_id,
    before: { status: n.status },
    after: {
      status: "submitted",
      stay_id: n.stay_id,
      submitted_at: input.submittedAt.toISOString(),
      channel: input.channel,
      evidence: input.evidenceFileId !== undefined,
      after_due: afterDue,
    },
  });
  return {
    notice_id: n.id,
    stay_id: n.stay_id,
    status: "submitted",
    is_foreign: u.is_foreign,
    due_at: n.due_at ? new Date(n.due_at).toISOString() : null,
    exported_at: u.exported_at ? new Date(u.exported_at).toISOString() : null,
    submitted_at: new Date(u.submitted_at).toISOString(),
    submitted_by: ctx.actor.membershipId,
    channel: u.channel,
    has_evidence: u.evidence_file_id !== null,
  };
}

// ---------- stay.listNotices (query) ----------

export interface NoticeListItem {
  notice_id: string;
  stay_id: string;
  unit_code: string;
  status: NoticeStatus;
  is_foreign: boolean;
  due_at: string | null;
  /** Còn mở (`pending`/`exported`) và đã qua hạn tại thời điểm hỏi. */
  overdue: boolean;
  exported_at: string | null;
  submitted_at: string | null;
}

export const MAX_NOTICE_LIST = 200;

/**
 * `stay.listNotices`: thông báo của một cơ sở, lọc theo trạng thái và `due_before` (≤ mốc). Thứ tự: quá hạn nổi lên đầu (hạn cũ nhất
 * trước), rồi sắp tới hạn, rồi chưa có hạn, cuối cùng đã nộp. Vai trò không đọc được (buồng phòng…) → 404 (RLS); ngoài phạm vi → 404.
 */
export async function listNotices(
  db: Kysely<unknown>,
  actor: Actor,
  input: { propertyId: string; status?: NoticeStatus; dueBefore?: Date; limit?: number; now?: Date },
): Promise<{ items: NoticeListItem[] }> {
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), MAX_NOTICE_LIST);
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    try {
      authorize(actor, "residence_notice.manage", { propertyId: input.propertyId });
    } catch (err) {
      // Vai trò không có quyền: không lộ sự tồn tại dữ liệu (cùng 404 như RLS).
      if ((err as { code?: string }).code === "FORBIDDEN") throw notFound();
      throw err;
    }
    const rows = await sql<{
      id: string;
      stay_id: string;
      unit_code: string;
      status: NoticeStatus;
      is_foreign: boolean;
      due_at: Date | null;
      exported_at: Date | null;
      submitted_at: Date | null;
    }>`
      select n.id, n.stay_id, u.code as unit_code, n.status, n.is_foreign, n.due_at, n.exported_at, n.submitted_at
      from residence_notices n
      join stays s on s.organization_id = n.organization_id and s.id = n.stay_id
      join units u on u.organization_id = s.organization_id and u.id = s.unit_id
      where n.organization_id = ${actor.orgId} and n.property_id = ${input.propertyId}
        and (${input.status ?? null}::text is null or n.status = ${input.status ?? null})
        and (${input.dueBefore ?? null}::timestamptz is null or n.due_at <= ${input.dueBefore ?? null})
      order by (n.status = 'submitted'),
               (n.due_at is not null and n.due_at <= ${now}) desc,
               n.due_at nulls last, n.created_at, n.id
      limit ${limit}`.execute(trx);
    return {
      items: rows.rows.map((r) => ({
        notice_id: r.id,
        stay_id: r.stay_id,
        unit_code: r.unit_code,
        status: r.status,
        is_foreign: r.is_foreign,
        due_at: r.due_at ? new Date(r.due_at).toISOString() : null,
        overdue:
          r.status !== "submitted" && r.due_at !== null && new Date(r.due_at).getTime() <= now.getTime(),
        exported_at: r.exported_at ? new Date(r.exported_at).toISOString() : null,
        submitted_at: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
      })),
    };
  });
}
