// `notify.dispatch` (SPEC-notifications S-001…S-003; INV-G6): worker nhận sự kiện outbox (đã commit — outbox chỉ có hàng sau
// COMMIT nên rollback ⇒ không thông báo, S-002) → tạo `notifications` trong app + `notification_deliveries` email `queued`.
// Dedupe bằng unique `(organization_id, dedupe_key, recipient_person_id)` + `(notification_id, channel)`: sự kiện giao lại
// không tạo bản thứ hai (S-003). Payload outbox chỉ có id; nội dung đọc lại từ CSDL trong ngữ cảnh đúng tổ chức.
import { randomUUID } from "node:crypto";
import { withTenantRetry } from "@hm/db";
import { type Kysely, sql, type Transaction } from "kysely";
import { t } from "../i18n.ts";
import { type NotificationType, render, TemplateError, type Vars } from "./templates.ts";

export interface DispatchJob {
  organization_id: string;
  outbox_id: string;
  event_type: string;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
}

export interface NewNotification {
  propertyId: string | null;
  recipientPersonId: string;
  type: NotificationType;
  severity?: "normal" | "urgent" | "overdue";
  vars: Vars;
  dedupeKey: string;
  email?: boolean;
}

/**
 * Ghi một thông báo (+ lần gửi email) nếu chưa có theo khoá dedupe. Trả id thông báo mới, hoặc null khi đã có. Nội dung
 * trong app render ngay (lỗi mẫu ⇒ ném — không lưu thông báo rỗng); email render lúc gửi (TEMPLATE_ERROR ⇒ `failed`).
 */
export async function createNotification(
  trx: Transaction<unknown>,
  orgId: string,
  n: NewNotification,
  opts: { now: Date; sourceOutboxId?: string },
): Promise<string | null> {
  const r = render(n.type, n.vars);
  const id = randomUUID();
  const ins = await sql<{ id: string }>`
    insert into notifications (id, organization_id, property_id, recipient_person_id, type, severity, title, body, link, vars,
                               dedupe_key, source_outbox_id)
    values (${id}, ${orgId}, ${n.propertyId}, ${n.recipientPersonId}, ${n.type}, ${n.severity ?? "normal"}, ${r.title}, ${r.body},
            ${r.link}, ${JSON.stringify(n.vars)}::jsonb, ${n.dedupeKey}, ${opts.sourceOutboxId ?? null})
    on conflict (organization_id, dedupe_key, recipient_person_id) do nothing
    returning id`.execute(trx);
  if (!ins.rows[0]) return null;
  if (n.email !== false) {
    await sql`
      insert into notification_deliveries (id, organization_id, property_id, notification_id, channel, status, next_attempt_at)
      values (${randomUUID()}, ${orgId}, ${n.propertyId}, ${id}, 'email', 'queued', ${opts.now})
      on conflict (organization_id, notification_id, channel) do nothing`.execute(trx);
  }
  return id;
}

/** Phiếu thu kỳ (hợp đồng) phát hành → người trả (S-001). Folio khách lẻ không gửi (khách không có portal). */
async function invoiceIssued(trx: Transaction<unknown>, job: DispatchJob, now: Date): Promise<number> {
  const invoiceId = job.payload.invoice_id;
  if (typeof invoiceId !== "string") throw new Error(t("notify.error.payload_missing_invoice"));
  const r = await sql<{
    property_id: string;
    payer_person_id: string;
    total: string;
    due_on: string | null;
    business_date: string;
    property_name: string;
    period_start: string | null;
  }>`
    select i.property_id, i.payer_person_id, i.total::text, i.due_on::text, i.business_date::text, p.name as property_name,
           bp.period_start::text
    from invoices i
    join properties p on p.organization_id = i.organization_id and p.id = i.property_id
    left join billing_periods bp on bp.organization_id = i.organization_id and bp.id = i.billing_period_id
    where i.organization_id = ${job.organization_id} and i.id = ${invoiceId} and i.lease_id is not null
      and i.kind in ('periodic','fee')`.execute(trx);
  const inv = r.rows[0];
  if (!inv) return 0;
  const month = (inv.period_start ?? inv.business_date).slice(0, 7);
  const id = await createNotification(
    trx,
    job.organization_id,
    {
      propertyId: inv.property_id,
      recipientPersonId: inv.payer_person_id,
      type: "invoice_issued",
      vars: {
        propertyName: inv.property_name,
        period: `${month.slice(5, 7)}/${month.slice(0, 4)}`,
        dueOn: inv.due_on ?? inv.business_date,
        amount: Number(inv.total),
        invoiceId,
      },
      dedupeKey: `invoice_issued:${invoiceId}`,
    },
    { now, sourceOutboxId: job.outbox_id },
  );
  return id ? 1 : 0;
}

/** Phiếu sự cố do người thuê báo đổi trạng thái → báo người báo (loại `maintenance_status`). */
async function workOrderStatus(trx: Transaction<unknown>, job: DispatchJob, now: Date): Promise<number> {
  const woId = job.payload.work_order_id;
  const status = job.payload.status;
  if (typeof woId !== "string" || typeof status !== "string")
    throw new Error(t("notify.error.payload_missing_work_order"));
  if (!["assigned", "done", "verified", "cancelled"].includes(status)) return 0;
  const r = await sql<{
    property_id: string;
    reporter_person_id: string | null;
    unit_code: string;
    property_name: string;
  }>`
    select w.property_id, w.reporter_person_id, u.code as unit_code, p.name as property_name
    from work_orders w
    join units u on u.organization_id = w.organization_id and u.id = w.unit_id
    join properties p on p.organization_id = w.organization_id and p.id = w.property_id
    where w.organization_id = ${job.organization_id} and w.id = ${woId} and w.source = 'tenant'`.execute(trx);
  const wo = r.rows[0];
  if (!wo?.reporter_person_id) return 0;
  const id = await createNotification(
    trx,
    job.organization_id,
    {
      propertyId: wo.property_id,
      recipientPersonId: wo.reporter_person_id,
      type: "maintenance_status",
      vars: { propertyName: wo.property_name, unitCode: wo.unit_code, status, workOrderId: woId },
      dedupeKey: `maintenance_status:${woId}:${status}`,
    },
    { now, sourceOutboxId: job.outbox_id },
  );
  return id ? 1 : 0;
}

/** Lời mời vào portal (SPEC-portal S-014) → `account_security` (bắt buộc, không tắt được). */
async function tenantInvited(trx: Transaction<unknown>, job: DispatchJob, now: Date): Promise<number> {
  const membershipId = job.payload.membership_id;
  const personId = job.payload.person_id;
  if (typeof membershipId !== "string" || typeof personId !== "string")
    throw new Error(t("notify.error.payload_missing_membership_person"));
  const o = await sql<{
    name: string;
  }>`select name from organizations where id = ${job.organization_id}`.execute(trx);
  const id = await createNotification(
    trx,
    job.organization_id,
    {
      propertyId: null,
      recipientPersonId: personId,
      type: "account_security",
      vars: {
        orgName: o.rows[0]?.name ?? t("notify.fallback_org"),
        action: t("notify.action.tenant_invited"),
        kind: "tenant_invited",
      },
      dedupeKey: `tenant_invited:${membershipId}`,
    },
    { now, sourceOutboxId: job.outbox_id },
  );
  return id ? 1 : 0;
}

/**
 * Sự kiện bảo mật của CHÍNH tài khoản (T-405) → `account_security` (bắt buộc, không tắt được) cho chủ membership:
 * MFA bị owner đặt lại (`member.mfa_reset`), đổi mật khẩu, tắt MFA. Báo để người dùng nhận ra thao tác không phải của mình.
 * Không đưa IP/UA/người thực hiện vào nội dung (S-012: không PII); dedupe theo outbox_id ⇒ giao lại không tạo bản thứ hai.
 */
const SECURITY_KIND: Readonly<Record<string, { kind: string; action: string }>> = {
  "member.mfa_reset": { kind: "mfa_reset", action: t("notify.action.mfa_reset") },
  "member.password_changed": { kind: "password_changed", action: t("notify.action.password_changed") },
  "member.mfa_disabled": { kind: "mfa_disabled", action: t("notify.action.mfa_disabled") },
};

async function accountSecurity(trx: Transaction<unknown>, job: DispatchJob, now: Date): Promise<number> {
  const membershipId = job.payload.membership_id;
  if (typeof membershipId !== "string") throw new Error(t("notify.error.payload_missing_membership"));
  const spec = SECURITY_KIND[job.event_type];
  if (!spec) return 0;
  const r = await sql<{ person_id: string; org_name: string }>`
    select m.person_id, o.name as org_name from memberships m join organizations o on o.id = m.organization_id
    where m.organization_id = ${job.organization_id} and m.id = ${membershipId}`.execute(trx);
  const m = r.rows[0];
  if (!m) return 0;
  const id = await createNotification(
    trx,
    job.organization_id,
    {
      propertyId: null,
      recipientPersonId: m.person_id,
      type: "account_security",
      vars: { orgName: m.org_name, action: spec.action, kind: spec.kind },
      dedupeKey: `${spec.kind}:${job.outbox_id}`,
    },
    { now, sourceOutboxId: job.outbox_id },
  );
  return id ? 1 : 0;
}

const HANDLERS: Readonly<
  Record<string, (trx: Transaction<unknown>, job: DispatchJob, now: Date) => Promise<number>>
> = {
  "invoice.issued": invoiceIssued,
  "work_order.status_changed": workOrderStatus,
  "portal.tenant_invited": tenantInvited,
  "member.mfa_reset": accountSecurity,
  "member.password_changed": accountSecurity,
  "member.mfa_disabled": accountSecurity,
};

/** Sự kiện outbox mà `notify.dispatch` xử lý (worker tạo queue + consumer cho từng loại). */
export const NOTIFY_EVENT_TYPES = Object.keys(HANDLERS);

/**
 * Xử lý một sự kiện trong ngữ cảnh tổ chức của chính hàng outbox (IND-SAAS-003). Trả số thông báo mới.
 * Lỗi mẫu (dữ liệu không render được) là lỗi tất định — chạy lại không khỏi — nên bỏ sự kiện đó, ghi log
 * `notification.template_error` (lý do chỉ nêu tên biến/ngày, logger che lại), thay vì để job lặp tới dead-letter.
 */
export async function dispatchNotification(
  workerDb: Kysely<unknown>,
  job: DispatchJob,
  now: Date = new Date(),
  log: (event: string, fields: Record<string, unknown>) => void = () => {},
): Promise<number> {
  const h = HANDLERS[job.event_type];
  if (!h) return 0;
  try {
    return await withTenantRetry(workerDb, { orgId: job.organization_id }, (trx) => h(trx, job, now));
  } catch (err) {
    if (!(err instanceof TemplateError)) throw err;
    log("notification.template_error", {
      outbox_id: job.outbox_id,
      event_type: job.event_type,
      reason: err.message,
    });
    return 0;
  }
}
