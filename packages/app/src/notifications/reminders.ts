// PLAN đợt 3 T-215 — nhắc theo lịch (SPEC-notifications S-007, S-008, S-013…S-016, S-020, S-021). Worker gọi định kỳ
// (T-225: quá hạn/hợp đồng hằng giờ trong khung gửi, lưu trú 15 phút). Quét theo TỪNG tổ chức qua hàm hẹp (0036); chạy lại
// không lặp nhờ khoá dedupe của `notifications` (theo ngày địa phương / mốc / mức).
// - Quá hạn: còn nợ thật lúc quét; đã tất toán thì không còn là ứng viên (S-008 "ngày sau không nhắc"); số dư được đọc
//   LẠI lúc gửi (`send.ts` → suppressed SETTLED).
// - Hợp đồng: quản lý/owner cơ sở + người đại diện nhận cùng mốc (Q-06); đã gia hạn ⇒ phiên bản mới, mốc cũ hết khớp.
// - Lưu trú: nhắc trong app cho lễ tân/quản lý (không tự gửi gì cho cơ quan nhà nước): một lần khi có hạn, "Khẩn" khi còn
//   ≤ 30 phút, "Quá hạn" mỗi ngày kinh doanh tới khi đánh dấu đã nộp; chưa cấu hình hạn ⇒ cảnh báo cấu hình cho
//   owner/manager mỗi ngày tối đa 1 lần (S-020).
import { withTenantRetry } from "@hm/db";
import { type Kysely, sql } from "kysely";
import { createNotification, type NewNotification } from "./dispatch.ts";
import { TemplateError } from "./templates.ts";

export type ReminderLog = (event: string, fields: Record<string, unknown>) => void;
const noLog: ReminderLog = () => {};

export interface ReminderStats {
  overdue: number;
  leaseExpiring: number;
  stayNotice: number;
}

async function orgs(workerDb: Kysely<unknown>): Promise<string[]> {
  const r = await sql<{ id: string }>`select reminder_orgs as id from app.reminder_orgs()`.execute(workerDb);
  return r.rows.map((x) => x.id);
}

/**
 * Chạy `fn` cho từng tổ chức; lỗi của một tổ chức không chặn tổ chức khác (review PR #10). Hết lượt mà có lỗi ⇒ ném
 * AggregateError để job bị đánh dấu lỗi và chạy lại (khoá dedupe giữ cho tổ chức đã xong không bị nhắc lặp).
 */
async function perOrg(
  workerDb: Kysely<unknown>,
  scan: string,
  log: ReminderLog,
  fn: (orgId: string) => Promise<number>,
): Promise<number> {
  let created = 0;
  const errors: unknown[] = [];
  for (const orgId of await orgs(workerDb)) {
    try {
      created += await fn(orgId);
    } catch (err) {
      errors.push(err);
      log("reminder.org_failed", {
        scan,
        org_id: orgId,
        error: (err as Error)?.name ?? "Error",
        // SQLSTATE của lỗi CSDL (không chứa dữ liệu) để phân biệt lỗi.
        code: (err as { code?: unknown })?.code ?? null,
      });
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `nhắc lịch lỗi ở ${errors.length} tổ chức`);
  return created;
}

async function staff(
  workerDb: Kysely<unknown>,
  orgId: string,
  propertyId: string,
  roles: string[],
): Promise<string[]> {
  const r = await sql<{ id: string }>`
    select property_staff as id from app.property_staff(${orgId}::uuid, ${propertyId}::uuid, ${roles}::text[])`.execute(
    workerDb,
  );
  return r.rows.map((x) => x.id);
}

async function createMany(
  workerDb: Kysely<unknown>,
  orgId: string,
  items: NewNotification[],
  now: Date,
  log: ReminderLog,
): Promise<number> {
  if (items.length === 0) return 0;
  return withTenantRetry(workerDb, { orgId }, async (trx) => {
    let n = 0;
    for (const it of items) {
      try {
        if (await createNotification(trx, orgId, it, { now })) n += 1;
      } catch (err) {
        // Lỗi mẫu xảy ra trước mọi câu ghi (render trước insert) ⇒ bỏ riêng mục đó, transaction còn dùng được.
        if (!(err instanceof TemplateError)) throw err;
        // Không kèm biến (có thể chứa dữ liệu người dùng) — chỉ loại + khoá dedupe để lần ra.
        log("notification.template_error", { type: it.type, dedupe_key: it.dedupeKey, reason: err.message });
      }
    }
    return n;
  });
}

const period = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** `reminder.scanOverdue` (S-007): một nhắc mỗi phiếu mỗi ngày địa phương theo lịch nhắc của cơ sở. */
export async function scanOverdue(
  workerDb: Kysely<unknown>,
  now: Date = new Date(),
  log: ReminderLog = noLog,
): Promise<number> {
  return perOrg(workerDb, "overdue", log, async (orgId) => {
    const r = await sql<{
      property_id: string;
      property_name: string;
      invoice_id: string;
      payer_person_id: string;
      open_amount: string;
      due_on: string;
      period_start: string | null;
      business_date: string;
      local_date: string;
    }>`
      select property_id, property_name, invoice_id, payer_person_id, open_amount::text, due_on::text, period_start::text,
             business_date::text, local_date::text
      from app.overdue_candidates(${orgId}::uuid, ${now})`.execute(workerDb);
    return createMany(
      workerDb,
      orgId,
      r.rows.map((x) => ({
        propertyId: x.property_id,
        recipientPersonId: x.payer_person_id,
        type: "invoice_overdue",
        severity: "overdue",
        vars: {
          propertyName: x.property_name,
          period: period(x.period_start ?? x.business_date),
          dueOn: x.due_on,
          amount: Number(x.open_amount),
          invoiceId: x.invoice_id,
        },
        dedupeKey: `invoice_overdue:${x.invoice_id}:${x.local_date}`,
      })),
      now,
      log,
    );
  });
}

/** `reminder.scanLeaseExpiry` (S-013): mốc 30/7 ngày (cấu hình), khoá dedupe theo hợp đồng + phiên bản + mốc. */
export async function scanLeaseExpiry(
  workerDb: Kysely<unknown>,
  now: Date = new Date(),
  log: ReminderLog = noLog,
): Promise<number> {
  return perOrg(workerDb, "lease_expiry", log, async (orgId) => {
    const r = await sql<{
      property_id: string;
      property_name: string;
      lease_id: string;
      version_no: number;
      unit_code: string;
      effective_to: string;
      days_left: number;
      representative_person_id: string;
    }>`
      select property_id, property_name, lease_id, version_no, unit_code, effective_to::text, days_left, representative_person_id
      from app.lease_expiry_candidates(${orgId}::uuid, ${now})`.execute(workerDb);
    const items: NewNotification[] = [];
    for (const x of r.rows) {
      const managers = await staff(workerDb, orgId, x.property_id, ["owner", "manager"]);
      const people = new Set([...managers, x.representative_person_id]);
      for (const person of people)
        items.push({
          propertyId: x.property_id,
          recipientPersonId: person,
          type: "lease_expiring",
          vars: {
            propertyName: x.property_name,
            unitCode: x.unit_code,
            endOn: x.effective_to,
            leaseId: x.lease_id,
            ...(managers.includes(person) ? {} : { audience: "tenant" }),
          },
          dedupeKey: `lease_expiring:${x.lease_id}:${x.version_no}:${x.days_left}`,
        });
    }
    return createMany(workerDb, orgId, items, now, log);
  });
}

/** `reminder.scanStayNotice` (S-014…S-016, S-020, S-021). Chỉ trong app (nhân viên). */
export async function scanStayNotice(
  workerDb: Kysely<unknown>,
  now: Date = new Date(),
  log: ReminderLog = noLog,
): Promise<number> {
  return perOrg(workerDb, "stay_notice", log, async (orgId) => {
    const r = await sql<{
      property_id: string;
      property_name: string;
      notice_id: string | null;
      unit_code: string | null;
      due_at_local: string | null;
      level: "normal" | "urgent" | "overdue" | "config_missing";
      business_date: string;
    }>`
      select property_id, property_name, notice_id, unit_code, due_at_local, level, business_date::text
      from app.stay_notice_candidates(${orgId}::uuid, ${now})`.execute(workerDb);
    const items: NewNotification[] = [];
    for (const x of r.rows) {
      if (x.level === "config_missing") {
        for (const person of await staff(workerDb, orgId, x.property_id, ["owner", "manager"]))
          items.push({
            propertyId: x.property_id,
            recipientPersonId: person,
            type: "stay_notice_due",
            vars: { propertyName: x.property_name, kind: "config_missing" },
            dedupeKey: `stay_notice_config_missing:${x.property_id}:${x.business_date}`,
            email: false,
          });
        continue;
      }
      const dedupeKey =
        x.level === "overdue"
          ? `stay_notice_overdue:${x.notice_id}:${x.business_date}`
          : x.level === "urgent"
            ? `stay_notice_urgent:${x.notice_id}`
            : `stay_notice_due:${x.notice_id}`;
      for (const person of await staff(workerDb, orgId, x.property_id, ["manager", "front_desk"]))
        items.push({
          propertyId: x.property_id,
          recipientPersonId: person,
          type: "stay_notice_due",
          severity: x.level,
          vars: {
            propertyName: x.property_name,
            unitCode: x.unit_code,
            dueAtLocal: x.due_at_local,
            noticeId: x.notice_id,
            severity: x.level,
          },
          dedupeKey,
          email: false,
        });
    }
    return createMany(workerDb, orgId, items, now, log);
  });
}

/**
 * Một lượt quét đủ ba loại (worker gọi theo lịch). Mỗi loại chạy bất kể loại trước lỗi (review PR #10: nhắc quá hạn lỗi
 * không được chặn thông báo lưu trú Khẩn); có lỗi ⇒ ném AggregateError sau khi chạy hết để job được chạy lại.
 */
export async function runReminders(
  workerDb: Kysely<unknown>,
  now: Date = new Date(),
  log: ReminderLog = noLog,
): Promise<ReminderStats> {
  const stats: ReminderStats = { overdue: 0, leaseExpiring: 0, stayNotice: 0 };
  const errors: unknown[] = [];
  const steps: [keyof ReminderStats, typeof scanOverdue][] = [
    ["overdue", scanOverdue],
    ["leaseExpiring", scanLeaseExpiry],
    ["stayNotice", scanStayNotice],
  ];
  for (const [key, scan] of steps) {
    try {
      stats[key] = await scan(workerDb, now, log);
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `nhắc lịch lỗi ở ${errors.length} loại quét`);
  return stats;
}
