// PLAN đợt 3 T-215 — nhắc theo lịch (SPEC-notifications S-007, S-008, S-013…S-016, S-020, S-021). Worker gọi định kỳ
// (T-225: quá hạn/hợp đồng hằng giờ trong khung gửi, lưu trú 15 phút). Quét theo TỪNG tổ chức qua hàm hẹp (0036); chạy lại
// không lặp nhờ khoá dedupe của `notifications` (theo ngày địa phương / mốc / mức).
// - Quá hạn: còn nợ thật lúc quét; đã tất toán thì không còn là ứng viên (S-008 "ngày sau không nhắc"); số dư được đọc
//   LẠI lúc gửi (`send.ts` → suppressed SETTLED).
// - Hợp đồng: quản lý/owner cơ sở + người đại diện nhận cùng mốc (Q-06); đã gia hạn ⇒ phiên bản mới, mốc cũ hết khớp.
// - Lưu trú: nhắc trong app cho lễ tân/quản lý (không tự gửi gì cho cơ quan nhà nước): một lần khi có hạn, "Khẩn" khi còn
//   ≤ 30 phút, "Quá hạn" mỗi ngày kinh doanh tới khi đánh dấu đã nộp; chưa cấu hình hạn ⇒ cảnh báo cấu hình cho
//   owner/manager mỗi ngày tối đa 1 lần (S-020).
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";
import { createNotification, type NewNotification } from "./dispatch.ts";

export interface ReminderStats {
  overdue: number;
  leaseExpiring: number;
  stayNotice: number;
}

async function orgs(workerDb: Kysely<unknown>): Promise<string[]> {
  const r = await sql<{ id: string }>`select reminder_orgs as id from app.reminder_orgs()`.execute(workerDb);
  return r.rows.map((x) => x.id);
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
): Promise<number> {
  if (items.length === 0) return 0;
  return withTenant(workerDb, { orgId }, async (trx) => {
    let n = 0;
    for (const it of items) if (await createNotification(trx, orgId, it, { now })) n += 1;
    return n;
  });
}

const period = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** `reminder.scanOverdue` (S-007): một nhắc mỗi phiếu mỗi ngày địa phương theo lịch nhắc của cơ sở. */
export async function scanOverdue(workerDb: Kysely<unknown>, now: Date = new Date()): Promise<number> {
  let created = 0;
  for (const orgId of await orgs(workerDb)) {
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
    created += await createMany(
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
    );
  }
  return created;
}

/** `reminder.scanLeaseExpiry` (S-013): mốc 30/7 ngày (cấu hình), khoá dedupe theo hợp đồng + phiên bản + mốc. */
export async function scanLeaseExpiry(workerDb: Kysely<unknown>, now: Date = new Date()): Promise<number> {
  let created = 0;
  for (const orgId of await orgs(workerDb)) {
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
      const people = new Set([
        ...(await staff(workerDb, orgId, x.property_id, ["owner", "manager"])),
        x.representative_person_id,
      ]);
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
          },
          dedupeKey: `lease_expiring:${x.lease_id}:${x.version_no}:${x.days_left}`,
        });
    }
    created += await createMany(workerDb, orgId, items, now);
  }
  return created;
}

/** `reminder.scanStayNotice` (S-014…S-016, S-020, S-021). Chỉ trong app (nhân viên). */
export async function scanStayNotice(workerDb: Kysely<unknown>, now: Date = new Date()): Promise<number> {
  let created = 0;
  for (const orgId of await orgs(workerDb)) {
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
    created += await createMany(workerDb, orgId, items, now);
  }
  return created;
}

/** Một lượt quét đủ ba loại (worker gọi theo lịch). */
export async function runReminders(
  workerDb: Kysely<unknown>,
  now: Date = new Date(),
): Promise<ReminderStats> {
  return {
    overdue: await scanOverdue(workerDb, now),
    leaseExpiring: await scanLeaseExpiry(workerDb, now),
    stayNotice: await scanStayNotice(workerDb, now),
  };
}
