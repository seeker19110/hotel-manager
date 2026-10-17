// Thông báo lưu trú — nghĩa vụ của CƠ SỞ (SPEC-reservation-stay S-028…S-030, Q-13; SPEC-notifications S-014…S-021). Hệ thống
// chỉ xuất file theo mẫu cơ sở cấu hình và ghi dấu vết; KHÔNG tự nộp cho cơ quan nhà nước. File chỉ gồm đúng các trường mẫu
// yêu cầu (không ảnh giấy tờ, SĐT, ghi chú nội bộ, số tiền), riêng tư, link ký ≤ 5 phút, tự xoá sau hạn ngắn.
import { createHash } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize, toCsv } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import {
  commitGeneratedFile,
  getFileUrl,
  type PreparedGenerated,
  prepareGeneratedFile,
  storeGeneratedFile,
  type TabularMime,
} from "../files/files.ts";
import { revealDocNumber } from "../identity/identity.ts";
import { writeXlsx } from "../import/xlsx.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";
import type { AppServices } from "../server/services.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trường được phép đưa vào file — danh sách đóng; mẫu chỉ chọn trong đây (không SĐT, ảnh, ghi chú, tiền). */
export const NOTICE_FIELDS = {
  full_name: "Họ và tên",
  nationality: "Quốc tịch",
  doc_type: "Loại giấy tờ",
  doc_number: "Số giấy tờ",
  check_in_date: "Ngày đến",
  check_in_time: "Giờ đến",
  expected_departure_date: "Ngày đi dự kiến",
  unit_code: "Phòng",
  property_name: "Cơ sở lưu trú",
} as const;
export type NoticeField = keyof typeof NOTICE_FIELDS;

export interface NoticeTemplate {
  format: "csv" | "xlsx";
  fields: NoticeField[];
  labels: Partial<Record<NoticeField, string>>;
}

/** Đọc mẫu cơ sở; thiếu/sai → null (→ NOTICE_TEMPLATE_MISSING, không đoán mẫu). */
export function parseNoticeTemplate(v: unknown): NoticeTemplate | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const format = o.format === "xlsx" ? "xlsx" : o.format === "csv" ? "csv" : null;
  if (!format || !Array.isArray(o.fields) || o.fields.length < 1 || o.fields.length > 20) return null;
  if (!o.fields.every((f) => typeof f === "string" && Object.hasOwn(NOTICE_FIELDS, f))) return null;
  if (new Set(o.fields).size !== o.fields.length) return null;
  const labels: Partial<Record<NoticeField, string>> = {};
  if (o.labels && typeof o.labels === "object" && !Array.isArray(o.labels)) {
    for (const [k, l] of Object.entries(o.labels as Record<string, unknown>)) {
      if (Object.hasOwn(NOTICE_FIELDS, k) && typeof l === "string" && l.trim().length > 0 && l.length <= 100)
        labels[k as NoticeField] = l.trim();
    }
  }
  return { format, fields: o.fields as NoticeField[], labels };
}

const DOC_LABEL: Record<string, string> = { cccd: "CCCD", passport: "Hộ chiếu", other: "Khác" };

interface NoticeRow {
  id: string;
  property_id: string;
  stay_id: string;
  status: "pending" | "exported" | "submitted";
}

async function readNotice(
  trx: Transaction<unknown>,
  actor: Actor,
  noticeId: string,
  lock: boolean,
): Promise<NoticeRow> {
  if (!UUID.test(noticeId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
  const r = await sql<NoticeRow>`
    select id, property_id, stay_id, status from residence_notices
    where organization_id = ${actor.orgId} and id = ${noticeId} ${lock ? sql`for update` : sql``}`.execute(
    trx,
  );
  const row = r.rows[0];
  if (!row || (!actor.allProperties && !actor.propertyIds.includes(row.property_id)))
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
  return row;
}

/** Vai trò không được làm thông báo lưu trú → 404 (không lộ dữ liệu khách — S-025, S-028). */
function authorizeNotice(actor: Actor, propertyId: string): void {
  try {
    authorize(actor, "residence_notice.manage", { propertyId });
  } catch {
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
  }
}

type NoticeSvc = Pick<AppServices, "pii" | "storage" | "scanner">;

interface BuiltNotice {
  notice: NoticeRow;
  format: "csv" | "xlsx";
  bytes: Uint8Array;
  mime: string;
  guests: number;
}

/** Đọc dữ liệu + dựng file thông báo — chỉ đọc CSDL, không I/O ngoài (dùng ở bước prepare VÀ trong lệnh). */
async function buildNoticeFile(
  trx: Transaction<unknown>,
  actor: Actor,
  svc: NoticeSvc,
  stayId: string,
  lock: boolean,
): Promise<BuiltNotice> {
  if (!UUID.test(stayId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
  const n = await sql<{ id: string }>`
    select id from residence_notices where organization_id = ${actor.orgId} and stay_id = ${stayId}`.execute(
    trx,
  );
  if (!n.rows[0]) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
  const notice = await readNotice(trx, actor, n.rows[0].id, lock);
  authorizeNotice(actor, notice.property_id);
  const cfg = await sql<{ t: unknown; tz: string; pname: string }>`
    select ns.residence_notice_template as t, p.timezone as tz, p.name as pname
    from properties p left join notification_settings ns on ns.organization_id = p.organization_id and ns.property_id = p.id
    where p.organization_id = ${actor.orgId} and p.id = ${notice.property_id}`.execute(trx);
  const c = cfg.rows[0] as { t: unknown; tz: string; pname: string };
  const tpl = parseNoticeTemplate(c.t);
  if (!tpl)
    throw new CommandError("NOTICE_TEMPLATE_MISSING", 409, "Cơ sở chưa cấu hình mẫu thông báo lưu trú.");
  const s = await sql<{
    persons: string[];
    in_date: string;
    in_time: string;
    departure: string;
    unit_code: string;
  }>`
    select array[s.primary_guest_person_id] || s.additional_guest_person_ids as persons,
           to_char(s.checked_in_at at time zone ${c.tz}, 'YYYY-MM-DD') as in_date,
           to_char(s.checked_in_at at time zone ${c.tz}, 'HH24:MI') as in_time,
           i.departure_date::text as departure, u.code as unit_code
    from stays s join reservation_items i on i.organization_id = s.organization_id and i.id = s.reservation_item_id
    join units u on u.organization_id = s.organization_id and u.id = s.unit_id
    where s.organization_id = ${actor.orgId} and s.id = ${notice.stay_id}`.execute(trx);
  const stay = s.rows[0];
  if (!stay) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
  const missing: { path: string; field: string; code: string }[] = [];
  const rows: (string | number)[][] = [tpl.fields.map((f) => tpl.labels[f] ?? NOTICE_FIELDS[f])];
  for (const [i, personId] of stay.persons.entries()) {
    const p = await sql<{
      full_name: string | null;
      nationality: string | null;
      doc_id: string | null;
      doc_type: string | null;
    }>`
      select pe.full_name, coalesce(d.nationality, pe.nationality) as nationality, d.id as doc_id, d.doc_type
      from persons pe
      left join lateral (select id, doc_type, nationality from identity_documents
                         where organization_id = pe.organization_id and person_id = pe.id and anonymized_at is null
                         order by created_at desc limit 1) d on true
      where pe.organization_id = ${actor.orgId} and pe.id = ${personId}`.execute(trx);
    const g = p.rows[0];
    const needsDoc = tpl.fields.includes("doc_number");
    const docNumber =
      needsDoc && g?.doc_id ? await revealDocNumber(trx, svc.pii, actor.orgId, g.doc_id) : null;
    const value: Record<NoticeField, string | null> = {
      full_name: g?.full_name ?? null,
      nationality: g?.nationality ?? null,
      doc_type: g?.doc_type ? (DOC_LABEL[g.doc_type] ?? g.doc_type) : null,
      doc_number: docNumber,
      check_in_date: stay.in_date,
      check_in_time: stay.in_time,
      expected_departure_date: stay.departure,
      unit_code: stay.unit_code,
      property_name: c.pname,
    };
    for (const f of tpl.fields) {
      if (value[f] === null || value[f] === "")
        missing.push({ path: `guests.${i}.${f}`, field: `guests.${i}.${f}`, code: "missing" });
    }
    rows.push(tpl.fields.map((f) => value[f] ?? ""));
  }
  if (missing.length > 0) {
    throw new CommandError("VALIDATION_FAILED", 422, "Thiếu thông tin mẫu thông báo lưu trú yêu cầu", {
      extensions: { errors: missing },
    });
  }
  const bytes =
    tpl.format === "csv"
      ? new TextEncoder().encode(toCsv(rows))
      : writeXlsx([{ name: "Thong bao luu tru", rows }]);
  return {
    notice,
    format: tpl.format,
    bytes,
    mime:
      tpl.format === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    guests: stay.persons.length,
  };
}

/**
 * Bước chuẩn bị NGOÀI transaction lệnh (T-303): dựng file trong transaction đọc ngắn rồi ghi object qua dòng staging
 * (files/staging.ts). Lỗi nghiệp vụ (thiếu mẫu, thiếu trường, không quyền) ném ra như trong lệnh.
 */
export async function prepareResidenceNotice(
  db: Kysely<unknown>,
  svc: NoticeSvc,
  actor: Actor,
  input: { stayId: string },
  idempotencyKey: string,
): Promise<PreparedGenerated> {
  const built = await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
    buildNoticeFile(trx, actor, svc, input.stayId, false),
  );
  return prepareGeneratedFile(
    db,
    svc,
    actor,
    {
      ownerType: "residence_notice",
      ownerId: built.notice.id,
      propertyId: built.notice.property_id,
      bytes: built.bytes,
      mime: built.mime,
    },
    idempotencyKey,
  );
}

/**
 * `stay.exportResidenceNotice` (S-028, S-030): sinh file theo mẫu; thiếu trường bắt buộc → 422 kèm danh sách; chưa có mẫu →
 * 409 NOTICE_TEMPLATE_MISSING. `pending → exported`; xuất lại được (mỗi lần một audit, giữ `exported`/`submitted`).
 */
export async function exportResidenceNotice(
  ctx: CommandContext,
  svc: NoticeSvc,
  input: {
    stayId: string;
    /** Từ `prepareResidenceNotice` (đường sản phẩm). Không có ⇒ đường cũ ghi object NGAY TRONG transaction. */
    prepared?: PreparedGenerated;
  },
): Promise<{ noticeId: string; status: string; fileId: string; url: string; expiresIn: number }> {
  const { notice, format, bytes, mime, guests } = await buildNoticeFile(
    ctx.trx,
    ctx.actor,
    svc,
    input.stayId,
    true,
  );
  let fileId: string;
  if (input.prepared) {
    // Dữ liệu đổi giữa bước chuẩn bị và lệnh ⇒ file đã ghi không còn đúng: bắt thử lại thay vì chốt file lệch.
    if (
      input.prepared.ownerId !== notice.id ||
      input.prepared.sha256 !== createHash("sha256").update(bytes).digest("hex")
    )
      throw new CommandError("VERSION_CONFLICT", 409, "Dữ liệu vừa thay đổi, vui lòng thử lại");
    ({ fileId } = await commitGeneratedFile(ctx.trx, ctx.actor, input.prepared, 1));
  } else {
    ({ fileId } = await storeGeneratedFile(ctx, svc, {
      ownerType: "residence_notice",
      ownerId: notice.id,
      propertyId: notice.property_id,
      bytes,
      mime: mime as TabularMime,
      deleteAfterDays: 1,
    }));
  }
  const status = notice.status === "pending" ? "exported" : notice.status;
  await sql`
    update residence_notices set status = ${status}, exported_at = now(), exported_by = ${ctx.actor.membershipId},
           export_file_id = ${fileId}, version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${notice.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "residence_notice.exported",
    entityType: "residence_notice",
    entityId: notice.id,
    propertyId: notice.property_id,
    before: { status: notice.status },
    after: { status, file_id: fileId, format, guests },
  });
  await ctx.emit({
    eventType: "stay.notice_exported",
    aggregateType: "residence_notice",
    aggregateId: notice.id,
    propertyId: notice.property_id,
    payload: { notice_id: notice.id },
  });
  const link = await getFileUrl(ctx, svc, fileId);
  return { noticeId: notice.id, status, fileId, url: link.url, expiresIn: link.expiresIn };
}

/**
 * `stay.markNoticeSubmitted` (S-029): ghi người/thời điểm/kênh (+ bằng chứng tuỳ chọn); hệ thống không gửi gì ra ngoài.
 * Đã `submitted` → INVALID_TRANSITION (gửi lại cùng key → cùng kết quả do pipeline); thời điểm ở tương lai → 422.
 */
export async function markNoticeSubmitted(
  ctx: CommandContext,
  input: {
    noticeId: string;
    submittedAt: Date;
    channel: "in_person" | "online" | "other";
    evidenceFileId?: string;
    now?: Date;
  },
): Promise<{ noticeId: string; status: "submitted" }> {
  const notice = await readNotice(ctx.trx, ctx.actor, input.noticeId, true);
  authorizeNotice(ctx.actor, notice.property_id);
  if (notice.status === "submitted")
    throw new CommandError("INVALID_TRANSITION", 409, "Thông báo lưu trú đã được đánh dấu", {
      extensions: { from: "submitted", to: "submitted" },
    });
  const now = input.now ?? new Date();
  if (Number.isNaN(input.submittedAt.getTime()) || input.submittedAt.getTime() > now.getTime() + 60_000)
    throw new CommandError("VALIDATION_FAILED", 422, "Thời điểm thông báo không được ở tương lai", {
      extensions: { errors: [{ path: "submitted_at", field: "submitted_at", code: "in_future" }] },
    });
  if (input.evidenceFileId) {
    const f = await sql<{ id: string }>`
      select id from files where organization_id = ${ctx.actor.orgId} and id = ${input.evidenceFileId}
        and owner_type = 'residence_notice' and status = 'ready' and property_id = ${notice.property_id}`.execute(
      ctx.trx,
    );
    if (!f.rows[0])
      throw new CommandError("VALIDATION_FAILED", 422, "File bằng chứng không hợp lệ", {
        extensions: { errors: [{ path: "evidence_file_id", field: "evidence_file_id", code: "invalid" }] },
      });
  }
  await sql`
    update residence_notices set status = 'submitted', submitted_at = ${input.submittedAt}, submitted_by = ${ctx.actor.membershipId},
           channel = ${input.channel}, evidence_file_id = ${input.evidenceFileId ?? null}, version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${notice.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "residence_notice.submitted",
    entityType: "residence_notice",
    entityId: notice.id,
    propertyId: notice.property_id,
    before: { status: notice.status },
    after: { status: "submitted", channel: input.channel, submitted_at: input.submittedAt.toISOString() },
  });
  await ctx.emit({
    eventType: "stay.notice_submitted",
    aggregateType: "residence_notice",
    aggregateId: notice.id,
    propertyId: notice.property_id,
    payload: { notice_id: notice.id },
  });
  return { noticeId: notice.id, status: "submitted" };
}

export interface NoticeListItem {
  id: string;
  stayId: string;
  unitCode: string;
  status: string;
  isForeign: boolean;
  dueAt: Date | null;
  overdue: boolean;
  exportedAt: Date | null;
  submittedAt: Date | null;
}

/** `stay.listNotices` (query): quá hạn chưa nộp lên đầu, rồi theo hạn; không trả tên/số giấy tờ (chỉ mở khi xuất). */
export async function listNotices(
  db: Kysely<unknown>,
  actor: Actor,
  input: { propertyId: string; status?: "pending" | "exported" | "submitted"; dueBefore?: Date; now?: Date },
): Promise<NoticeListItem[]> {
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
  authorizeNotice(actor, input.propertyId);
  const now = input.now ?? new Date();
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const p = await sql<{
      id: string;
    }>`select id from properties where organization_id = ${actor.orgId} and id = ${input.propertyId}`.execute(
      trx,
    );
    if (!p.rows[0]) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
    const r = await sql<{
      id: string;
      stay_id: string;
      unit_code: string;
      status: string;
      is_foreign: boolean;
      due_at: Date | null;
      exported_at: Date | null;
      submitted_at: Date | null;
      overdue: boolean;
    }>`
      select rn.id, rn.stay_id, u.code as unit_code, rn.status, rn.is_foreign, rn.due_at, rn.exported_at, rn.submitted_at,
             (rn.status <> 'submitted' and rn.due_at is not null and rn.due_at < ${now}) as overdue
      from residence_notices rn
      join stays s on s.organization_id = rn.organization_id and s.id = rn.stay_id
      join units u on u.organization_id = s.organization_id and u.id = s.unit_id
      where rn.organization_id = ${actor.orgId} and rn.property_id = ${input.propertyId}
        ${input.status ? sql`and rn.status = ${input.status}` : sql``}
        ${input.dueBefore ? sql`and rn.due_at < ${input.dueBefore}` : sql``}
      order by overdue desc, rn.due_at asc nulls last, rn.created_at
      limit 500`.execute(trx);
    return r.rows.map((x) => ({
      id: x.id,
      stayId: x.stay_id,
      unitCode: x.unit_code,
      status: x.status,
      isForeign: x.is_foreign,
      dueAt: x.due_at,
      overdue: x.overdue,
      exportedAt: x.exported_at,
      submittedAt: x.submitted_at,
    }));
  });
}
