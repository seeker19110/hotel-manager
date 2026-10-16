// Consumer thông báo (SPEC-notifications; INV-G6): sự kiện outbox → thông báo trong app + delivery email, rồi worker gửi.
// - `dispatchNotificationEvent` (job `notify.dispatch`): chạy SAU commit của command (outbox chỉ được relay khi đã commit —
//   S-002). Tạo thông báo với `ON CONFLICT DO NOTHING` theo (tổ chức, dedupe_key, người nhận) nên xử lý hai lần = một (S-003).
// - `sendDueEmails` (job `notify.sendEmail`): nhận delivery tới hạn bằng `app.notification_claim` (SKIP LOCKED), đọc lại điều
//   kiện (đã tắt/phiếu đã tất toán — S-008/S-009), gọi `EmailSender` NGOÀI transaction với `idempotencyKey = delivery_id`,
//   rồi ghi kết quả bằng so-sánh-và-đặt (chỉ khi vẫn `sending` đúng lần thử đó). Tạm lỗi → retrying (backoff) → dead; vĩnh
//   viễn → failed ngay (S-004/S-005).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Logger } from "../logging/logger.ts";
import {
  type DeliveryErrorCode,
  EmailError,
  type EmailSender,
  hasEmailChannel,
  renderEmail,
  TemplateError,
} from "./email.ts";
import { signUnsubscribeToken } from "./token.ts";

export const NOTIFICATION_TYPES = [
  "account_security",
  "invoice_issued",
  "invoice_overdue",
  "lease_expiring",
  "stay_notice_due",
  "maintenance_status",
  "export_ready",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Loại bắt buộc: không tắt được (S-011). */
export const REQUIRED_TYPES: readonly NotificationType[] = ["account_security"];

/** Tối đa 6 lần gửi = 1 lần đầu + 5 lần thử lại (chờ 1 ph, 5 ph, 30 ph, 2 giờ, 6 giờ — SPEC Q-05); quá → dead. */
export const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21_600] as const;
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
const LOCK_SECONDS = 300;

/** Phần của OutboxJob mà consumer dùng (cấu trúc tương thích `OutboxJob` của apps/worker). */
export interface NotificationEvent {
  organization_id: string;
  outbox_id: string;
  event_type: string;
  payload: Record<string, unknown>;
}

export interface NotificationDraft {
  propertyId: string | null;
  recipientPersonId: string;
  type: NotificationType;
  severity?: "normal" | "urgent" | "overdue";
  title: string;
  body: string;
  link: string | null;
  dedupeKey: string;
  /** Không PII: dựng email tối thiểu. */
  params: Record<string, string>;
}

export interface CreatedNotification {
  notificationId: string;
  deliveryId: string | null;
  deliveryStatus: "queued" | "suppressed" | null;
}

export function formatVnd(n: number): string {
  return `${String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} đ`;
}

export function formatDay(d: string | null | undefined): string {
  return d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "";
}

function uuidOf(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/i.test(v)) throw new Error(`payload thiếu ${field}`);
  return v;
}

/** Tạo thông báo + delivery email (nếu loại có email) trong transaction của người gọi. `created=false` = trùng dedupe. */
export async function createNotification(
  trx: Transaction<unknown>,
  orgId: string,
  d: NotificationDraft,
  now: Date,
): Promise<CreatedNotification | null> {
  const id = randomUUID();
  const ins = await sql<{ id: string }>`
    insert into notifications (id, organization_id, property_id, recipient_person_id, type, severity, title, body, link, params,
                               dedupe_key)
    values (${id}, ${orgId}, ${d.propertyId}, ${d.recipientPersonId}, ${d.type}, ${d.severity ?? "normal"}, ${d.title}, ${d.body},
            ${d.link}, ${JSON.stringify(d.params)}::jsonb, ${d.dedupeKey})
    on conflict (organization_id, dedupe_key, recipient_person_id) do nothing
    returning id`.execute(trx);
  if (!ins.rows[0]) return null;
  if (!hasEmailChannel(d.type)) return { notificationId: id, deliveryId: null, deliveryStatus: null };

  const who = await sql<{ email: string | null; state: string | null }>`
    select p.email, pref.state
    from persons p
    left join notification_preferences pref on pref.organization_id = p.organization_id and pref.person_id = p.id
         and pref.type = ${d.type} and pref.channel = 'email'
    where p.organization_id = ${orgId} and p.id = ${d.recipientPersonId}`.execute(trx);
  const row = who.rows[0];
  const reason = !row?.email?.trim() ? "NO_ADDRESS" : row.state === "opted_out" ? "OPTED_OUT" : null;
  const deliveryId = randomUUID();
  await sql`
    insert into notification_deliveries (id, organization_id, property_id, notification_id, channel, status, suppressed_reason,
                                         next_attempt_at)
    values (${deliveryId}, ${orgId}, ${d.propertyId}, ${id}, 'email', ${reason ? "suppressed" : "queued"}, ${reason},
            ${reason ? null : now})`.execute(trx);
  return { notificationId: id, deliveryId, deliveryStatus: reason ? "suppressed" : "queued" };
}

type Mapper = (
  trx: Transaction<unknown>,
  orgId: string,
  e: NotificationEvent,
) => Promise<NotificationDraft[]>;

interface InvoiceRow {
  id: string;
  property_id: string;
  payer_person_id: string;
  number: string;
  total: string;
  open_amount: string;
  due_on: string | null;
  business_date: string;
  period_start: string | null;
  property_name: string;
}

async function loadInvoice(
  trx: Transaction<unknown>,
  orgId: string,
  invoiceId: string,
): Promise<InvoiceRow | undefined> {
  const r = await sql<InvoiceRow>`
    select i.id, i.property_id, i.payer_person_id, i.number, i.total::text, i.open_amount::text, i.due_on::text,
           i.business_date::text, bp.period_start::text, pr.name as property_name
    from invoices i
    join properties pr on pr.organization_id = i.organization_id and pr.id = i.property_id
    left join billing_periods bp on bp.organization_id = i.organization_id and bp.id = i.billing_period_id
    where i.organization_id = ${orgId} and i.id = ${invoiceId}`.execute(trx);
  return r.rows[0];
}

const periodLabel = (i: InvoiceRow) => {
  const d = i.period_start ?? i.business_date;
  return `${d.slice(5, 7)}/${d.slice(0, 4)}`;
};

const invoiceParams = (i: InvoiceRow): Record<string, string> => ({
  property_name: i.property_name,
  invoice_id: i.id,
  period_label: periodLabel(i),
  due_date: formatDay(i.due_on) || "ghi trên phiếu",
});

/** Ánh xạ sự kiện outbox → thông báo. Thêm loại sự kiện = thêm một mục (payload chỉ có id; nội dung đọc lại từ sổ/DB). */
export const EVENT_MAPPERS: Readonly<Record<string, Mapper>> = {
  "invoice.issued": async (trx, orgId, e) => {
    const inv = await loadInvoice(trx, orgId, uuidOf(e.payload.invoice_id, "invoice_id"));
    if (!inv) return [];
    return [
      {
        propertyId: inv.property_id,
        recipientPersonId: inv.payer_person_id,
        type: "invoice_issued",
        title: `Phiếu thu kỳ ${periodLabel(inv)}`,
        body: `Phiếu ${inv.number}: ${formatVnd(Number(inv.total))}, hạn ${formatDay(inv.due_on) || "ghi trên phiếu"}.`,
        link: `/hoa-don/${inv.id}`,
        dedupeKey: `invoice_issued:${inv.id}`,
        params: invoiceParams(inv),
      },
    ];
  },
  // Do job `reminder.scanOverdue` (reminders.ts) phát; payload { invoice_id, business_date, milestone, days_overdue }.
  "invoice.overdue": async (trx, orgId, e) => {
    const inv = await loadInvoice(trx, orgId, uuidOf(e.payload.invoice_id, "invoice_id"));
    const day = typeof e.payload.business_date === "string" ? e.payload.business_date : null;
    if (!inv || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    const balance = Number(inv.open_amount);
    if (balance <= 0) return [];
    return [
      {
        propertyId: inv.property_id,
        recipientPersonId: inv.payer_person_id,
        type: "invoice_overdue",
        severity: "overdue",
        title: `Phiếu thu kỳ ${periodLabel(inv)} đã quá hạn`,
        body: `Phiếu ${inv.number} còn nợ ${formatVnd(balance)}, hạn ${formatDay(inv.due_on) || "ghi trên phiếu"}.`,
        link: `/hoa-don/${inv.id}`,
        dedupeKey: `invoice_overdue:${inv.id}:${day}`,
        params: invoiceParams(inv),
      },
    ];
  },
  // Do `remindExpiring` (lease/jobs.ts) phát; gửi cho owner/manager trong phạm vi cơ sở của hợp đồng.
  "lease.expiring": async (trx, orgId, e) => {
    const leaseId = uuidOf(e.payload.lease_id, "lease_id");
    const versionNo = Number(e.payload.version_no);
    const daysLeft = Number(e.payload.days_left);
    const effectiveTo = typeof e.payload.effective_to === "string" ? e.payload.effective_to : null;
    if (!Number.isInteger(versionNo) || !Number.isInteger(daysLeft) || !effectiveTo) return [];
    const lease = await sql<{ property_id: string; number: string; property_name: string }>`
      select l.property_id, l.number, pr.name as property_name
      from leases l join properties pr on pr.organization_id = l.organization_id and pr.id = l.property_id
      where l.organization_id = ${orgId} and l.id = ${leaseId}`.execute(trx);
    const l = lease.rows[0];
    if (!l) return [];
    const staff = await propertyManagers(trx, orgId, l.property_id);
    return staff.map((personId) => ({
      propertyId: l.property_id,
      recipientPersonId: personId,
      type: "lease_expiring" as const,
      severity: daysLeft <= 7 ? ("urgent" as const) : ("normal" as const),
      title: "Hợp đồng sắp hết hạn",
      body: `Hợp đồng ${l.number} kết thúc ngày ${formatDay(effectiveTo)} (còn ${daysLeft} ngày).`,
      link: `/hop-dong/${leaseId}`,
      dedupeKey: `lease_expiring:${leaseId}:${versionNo}:${daysLeft}`,
      params: { property_name: l.property_name, end_date: formatDay(effectiveTo) },
    }));
  },
  // Do `scanStayNoticeConfig` (S-020) phát; payload { property_id, business_date }. Chỉ trong app (D-010), gửi owner/manager.
  "stay_notice.unconfigured": async (trx, orgId, e) => {
    const propertyId = uuidOf(e.payload.property_id, "property_id");
    const day = typeof e.payload.business_date === "string" ? e.payload.business_date : null;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    const pr = await sql<{ name: string }>`
      select name from properties where organization_id = ${orgId} and id = ${propertyId}`.execute(trx);
    const name = pr.rows[0]?.name;
    if (name === undefined) return [];
    const staff = await propertyManagers(trx, orgId, propertyId);
    return staff.map((personId) => ({
      propertyId,
      recipientPersonId: personId,
      type: "stay_notice_due" as const,
      title: "Chưa cấu hình hạn thông báo lưu trú",
      body: `Cơ sở ${name} đang có khách lưu trú nhưng chưa cấu hình hạn thông báo lưu trú nên hệ thống chưa nhắc hạn. Vào cấu hình thông báo để nhập hạn.`,
      link: "/cai-dat/thong-bao",
      dedupeKey: `stay_notice_unconfigured:${propertyId}:${day}`,
      params: { property_name: name },
    }));
  },
  // Do `scanResidenceNotices` (reminders.ts) phát; payload { notice_id, phase: due|urgent|overdue, business_date }. Chỉ trong app (D-010),
  // gửi owner/manager/lễ tân của cơ sở (S-014). Đọc lại trạng thái ở đây: đã `submitted` (hoặc không còn hạn) ⇒ không tạo gì (S-016).
  "stay_notice.reminder": async (trx, orgId, e) => {
    const noticeId = uuidOf(e.payload.notice_id, "notice_id");
    const phase = e.payload.phase;
    const day = typeof e.payload.business_date === "string" ? e.payload.business_date : null;
    if (phase !== "due" && phase !== "urgent" && phase !== "overdue") return [];
    if (phase === "overdue" && (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day))) return [];
    const r = await sql<{
      property_id: string;
      stay_id: string;
      status: string;
      unit_code: string;
      property_name: string;
      due_local: string | null;
    }>`
      select n.property_id, n.stay_id, n.status, u.code as unit_code, pr.name as property_name,
             to_char(n.due_at at time zone pr.timezone, 'HH24:MI DD/MM/YYYY') as due_local
      from residence_notices n
      join stays s on s.organization_id = n.organization_id and s.id = n.stay_id
      join units u on u.organization_id = s.organization_id and u.id = s.unit_id
      join properties pr on pr.organization_id = n.organization_id and pr.id = n.property_id
      where n.organization_id = ${orgId} and n.id = ${noticeId}`.execute(trx);
    const n = r.rows[0];
    if (!n || n.status === "submitted" || !n.due_local) return [];
    const staff = await propertyManagers(trx, orgId, n.property_id, NOTICE_ROLES);
    const [title, body, severity, key] =
      phase === "overdue"
        ? ([
            `Quá hạn: phòng ${n.unit_code} chưa đánh dấu đã thông báo lưu trú`,
            `Phòng ${n.unit_code} (hạn ${n.due_local}) chưa được đánh dấu đã thông báo lưu trú. Xuất file, thông báo rồi đánh dấu đã thông báo.`,
            "overdue",
            `stay_notice_overdue:${noticeId}:${day}`,
          ] as const)
        : phase === "urgent"
          ? ([
              `Khẩn: phòng ${n.unit_code} còn ít phút để thông báo lưu trú`,
              `Phòng ${n.unit_code}: cần thông báo lưu trú trước ${n.due_local}. Hệ thống không tự gửi — hãy xuất file và đánh dấu đã thông báo.`,
              "urgent",
              `stay_notice_urgent:${noticeId}`,
            ] as const)
          : ([
              `Phòng ${n.unit_code}: cần thông báo lưu trú trước ${n.due_local}`,
              `Phòng ${n.unit_code}: cần thông báo lưu trú trước ${n.due_local}. Hệ thống không tự gửi — hãy xuất file và đánh dấu đã thông báo.`,
              "normal",
              `stay_notice_due:${noticeId}`,
            ] as const);
    return staff.map((personId) => ({
      propertyId: n.property_id,
      recipientPersonId: personId,
      type: "stay_notice_due" as const,
      severity,
      title,
      body,
      link: `/luu-tru/${n.stay_id}/thong-bao`,
      dedupeKey: key,
      params: { property_name: n.property_name },
    }));
  },
};

const NOTICE_ROLES = ["owner", "manager", "front_desk"] as const;

/** Người đang hoạt động trong phạm vi cơ sở theo vai trò (mặc định owner/manager — người nhận thông báo vận hành). */
async function propertyManagers(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
  roles: readonly string[] = ["owner", "manager"],
): Promise<string[]> {
  const staff = await sql<{ person_id: string }>`
    select distinct m.person_id from memberships m
    where m.organization_id = ${orgId} and m.status = 'active' and m.role = any(${[...roles]}::text[])
      and (m.all_properties or exists (select 1 from property_scopes ps
           where ps.organization_id = m.organization_id and ps.membership_id = m.id and ps.property_id = ${propertyId}))`.execute(
    trx,
  );
  return staff.rows.map((s) => s.person_id);
}

export const NOTIFICATION_EVENT_TYPES = Object.keys(EVENT_MAPPERS);

export interface DispatchResult {
  created: number;
  duplicates: number;
}

/**
 * Handler `notify.dispatch` cho một sự kiện outbox (idempotent — pg-boss có thể giao lại). Sự kiện lạ → không làm gì.
 * Ném lỗi (DB tạm lỗi) để pg-boss retry; không để mất thông báo.
 */
export async function dispatchNotificationEvent(
  workerDb: Kysely<unknown>,
  event: NotificationEvent,
  now: Date = new Date(),
): Promise<DispatchResult> {
  const map = Object.hasOwn(EVENT_MAPPERS, event.event_type) ? EVENT_MAPPERS[event.event_type] : undefined;
  if (!map) return { created: 0, duplicates: 0 };
  return withTenant(workerDb, { orgId: event.organization_id }, async (trx) => {
    let created = 0;
    let duplicates = 0;
    for (const d of await map(trx, event.organization_id, event)) {
      const r = await createNotification(trx, event.organization_id, d, now);
      if (r) created++;
      else duplicates++;
    }
    return { created, duplicates };
  });
}

export interface SendConfig {
  /** APP_BASE_URL — gốc của liên kết portal/huỷ đăng ký. */
  baseUrl: string;
  /** Khoá ký token huỷ đăng ký (≥ 32 byte). */
  tokenSecret: string;
}

export interface SendOptions {
  now?: () => Date;
  limit?: number;
  log?: Logger;
  /** Ghi metric (vd `notification_dead_total` — S-004). */
  onMetric?: (name: "notification_dead_total", labels: { type: string }) => void;
}

export interface SendSummary {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
  dead: number;
  suppressed: number;
  skipped: number;
}

interface Loaded {
  type: string;
  notificationId: string;
  title: string;
  link: string | null;
  params: Record<string, string>;
  personId: string;
  propertyId: string | null;
  email: string | null;
  prefState: string | null;
  propertyName: string | null;
  invoiceBalance: number | null;
}

type Outcome =
  | { kind: "suppress"; reason: "NO_ADDRESS" | "OPTED_OUT" | "SETTLED" }
  | { kind: "fail"; code: DeliveryErrorCode }
  | { kind: "send"; to: string; template: string; vars: Record<string, string> };

/** Quyết định gửi/chặn/lỗi từ dữ liệu đọc lại (thuần, test được). */
function decide(l: Loaded, cfg: SendConfig, orgId: string, now: Date): Outcome {
  if (!l.email?.trim()) return { kind: "suppress", reason: "NO_ADDRESS" };
  if (l.prefState === "opted_out") return { kind: "suppress", reason: "OPTED_OUT" };
  if (l.type === "invoice_overdue" && l.invoiceBalance !== null && l.invoiceBalance <= 0) {
    return { kind: "suppress", reason: "SETTLED" };
  }
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const vars: Record<string, string> = {
    propertyName: l.params.property_name ?? l.propertyName ?? "",
    periodLabel: l.params.period_label ?? "",
    dueDate: l.params.due_date ?? "",
    endDate: l.params.end_date ?? "",
    summary: l.title,
    portalUrl: `${base}${l.link ?? "/"}`,
  };
  if (!REQUIRED_TYPES.includes(l.type as NotificationType)) {
    const token = signUnsubscribeToken(cfg.tokenSecret, { orgId, personId: l.personId, type: l.type }, now);
    vars.unsubscribeUrl = `${base}/api/v1/notifications/unsubscribe?token=${token}`;
  }
  return { kind: "send", to: l.email, template: l.type, vars };
}

export async function sendDueEmails(
  workerDb: Kysely<unknown>,
  sender: EmailSender,
  cfg: SendConfig,
  opts: SendOptions = {},
): Promise<SendSummary> {
  const clock = opts.now ?? (() => new Date());
  const summary: SendSummary = {
    claimed: 0,
    sent: 0,
    retrying: 0,
    failed: 0,
    dead: 0,
    suppressed: 0,
    skipped: 0,
  };
  const claimed = await sql<{ delivery_id: string; org_id: string; attempts: number }>`
    select * from app.notification_claim(${clock()}, ${opts.limit ?? 50}, ${LOCK_SECONDS})`.execute(workerDb);
  summary.claimed = claimed.rows.length;
  for (const c of claimed.rows) {
    await processOne(
      workerDb,
      sender,
      cfg,
      opts,
      clock,
      c.org_id,
      c.delivery_id,
      Number(c.attempts),
      summary,
    );
  }
  return summary;
}

async function processOne(
  workerDb: Kysely<unknown>,
  sender: EmailSender,
  cfg: SendConfig,
  opts: SendOptions,
  clock: () => Date,
  orgId: string,
  deliveryId: string,
  attempts: number,
  summary: SendSummary,
): Promise<void> {
  const log = opts.log?.child({ delivery_id: deliveryId, organization_id: orgId });
  const prep = await withTenant(workerDb, { orgId }, async (trx) => {
    const r = await sql<{
      type: string;
      notification_id: string;
      title: string;
      link: string | null;
      params: Record<string, string>;
      person_id: string;
      property_id: string | null;
      email: string | null;
      pref_state: string | null;
      property_name: string | null;
      invoice_balance: string | null;
    }>`
      select n.type, n.id as notification_id, n.title, n.link, n.params, n.recipient_person_id as person_id, d.property_id,
             p.email, pref.state as pref_state, pr.name as property_name,
             (select i.open_amount::text from invoices i
               where i.organization_id = n.organization_id and n.params ->> 'invoice_id' is not null
                 and i.id = (n.params ->> 'invoice_id')::uuid) as invoice_balance
      from notification_deliveries d
      join notifications n on n.organization_id = d.organization_id and n.id = d.notification_id
      join persons p on p.organization_id = n.organization_id and p.id = n.recipient_person_id
      left join notification_preferences pref on pref.organization_id = n.organization_id and pref.person_id = n.recipient_person_id
           and pref.type = n.type and pref.channel = d.channel
      left join properties pr on pr.organization_id = d.organization_id and pr.id = d.property_id
      where d.organization_id = ${orgId} and d.id = ${deliveryId} and d.status = 'sending' and d.attempts = ${attempts}`.execute(
      trx,
    );
    const row = r.rows[0];
    if (!row) return "skip" as const;
    const loaded: Loaded = {
      type: row.type,
      notificationId: row.notification_id,
      title: row.title,
      link: row.link,
      params: row.params,
      personId: row.person_id,
      propertyId: row.property_id,
      email: row.email,
      prefState: row.pref_state,
      propertyName: row.property_name,
      invoiceBalance: row.invoice_balance === null ? null : Number(row.invoice_balance),
    };
    let outcome: Outcome;
    try {
      outcome = decide(loaded, cfg, orgId, clock());
      if (outcome.kind === "send") renderEmail(outcome.template, outcome.vars);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      outcome = { kind: "fail", code: "TEMPLATE_ERROR" };
    }
    if (outcome.kind === "suppress") {
      await finalize(trx, orgId, deliveryId, attempts, {
        status: "suppressed",
        suppressedReason: outcome.reason,
      });
      summary.suppressed++;
      log?.info("notification.suppressed", { reason: outcome.reason, type: loaded.type });
      return "done" as const;
    }
    if (outcome.kind === "fail") {
      await finalize(trx, orgId, deliveryId, attempts, { status: "failed", errorCode: outcome.code });
      summary.failed++;
      log?.warn("notification.failed", { code: outcome.code, type: loaded.type });
      return "done" as const;
    }
    return { outcome, type: loaded.type, propertyId: loaded.propertyId };
  });
  if (prep === "skip") summary.skipped++;
  if (prep === "skip" || prep === "done") return;

  const { outcome, type } = prep;
  try {
    const res = await sender.send({
      to: outcome.to,
      template: outcome.template,
      vars: outcome.vars,
      idempotencyKey: deliveryId,
    });
    const ok = await withTenant(workerDb, { orgId }, (trx) =>
      finalize(trx, orgId, deliveryId, attempts, {
        status: "sent",
        providerMessageId: res.providerMessageId,
        sentAt: clock(),
      }),
    );
    if (ok) summary.sent++;
    log?.info("notification.sent", { type, to: outcome.to });
  } catch (err) {
    const permanent = err instanceof EmailError && err.kind === "PERMANENT";
    const code: DeliveryErrorCode = err instanceof EmailError ? err.code : "PROVIDER_TEMPORARY";
    await withTenant(workerDb, { orgId }, async (trx) => {
      if (permanent) {
        if (await finalize(trx, orgId, deliveryId, attempts, { status: "failed", errorCode: code }))
          summary.failed++;
      } else if (attempts >= MAX_ATTEMPTS) {
        if (await finalize(trx, orgId, deliveryId, attempts, { status: "dead", errorCode: code })) {
          summary.dead++;
          await sql`
            insert into audit_events (id, organization_id, property_id, actor_type, action, entity_type, entity_id, after, correlation_id)
            values (${randomUUID()}, ${orgId}, ${prep.propertyId}, 'worker', 'notification.delivery_dead', 'notification_delivery',
                    ${deliveryId}, ${JSON.stringify({ type, attempts, error_code: code })}::jsonb, ${`job:notify.sendEmail:${deliveryId}`})`.execute(
            trx,
          );
          opts.onMetric?.("notification_dead_total", { type });
          log?.error("notification.dead", { type, attempts, code });
        }
      } else {
        const wait = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length) - 1] ?? 60;
        const next = new Date(clock().getTime() + wait * 1000);
        if (
          await finalize(trx, orgId, deliveryId, attempts, {
            status: "retrying",
            errorCode: code,
            nextAttemptAt: next,
          })
        ) {
          summary.retrying++;
          log?.warn("notification.retrying", { type, attempts, code });
        }
      }
    });
  }
}

type FinalState =
  | { status: "sent"; providerMessageId: string; sentAt: Date }
  | { status: "suppressed"; suppressedReason: string }
  | { status: "failed" | "dead"; errorCode: DeliveryErrorCode }
  | { status: "retrying"; errorCode: DeliveryErrorCode; nextAttemptAt: Date };

/** So-sánh-và-đặt: chỉ ghi khi hàng vẫn `sending` đúng lần thử `attempts` (worker khác đã nhận lại thì bỏ qua). */
async function finalize(
  trx: Transaction<unknown>,
  orgId: string,
  deliveryId: string,
  attempts: number,
  s: FinalState,
): Promise<boolean> {
  const r = await sql`
    update notification_deliveries set
      status = ${s.status},
      locked_until = null,
      next_attempt_at = ${s.status === "retrying" ? s.nextAttemptAt : null},
      provider_message_id = ${s.status === "sent" ? s.providerMessageId : null},
      sent_at = ${s.status === "sent" ? s.sentAt : null},
      suppressed_reason = ${s.status === "suppressed" ? s.suppressedReason : null},
      last_error_code = ${"errorCode" in s ? s.errorCode : null}
    where organization_id = ${orgId} and id = ${deliveryId} and status = 'sending' and attempts = ${attempts}`.execute(
    trx,
  );
  return Number(r.numAffectedRows ?? 0) === 1;
}

/** Nhãn hiển thị trạng thái gửi (S-006): `queued` KHÔNG BAO GIỜ là "đã gửi". */
export const DELIVERY_STATUS_LABEL: Readonly<Record<string, string>> = {
  queued: "Đang chờ gửi",
  sending: "Đang gửi",
  retrying: "Nhà cung cấp tạm lỗi — đang thử lại",
  sent: "Đã chuyển cho nhà cung cấp email",
  failed: "Gửi thất bại — cần xử lý",
  dead: "Gửi thất bại — cần xử lý",
  suppressed: "Không gửi",
};

export const DELIVERY_ERROR_LABEL: Readonly<Record<string, string>> = {
  RECIPIENT_INVALID: "Địa chỉ email không hợp lệ",
  PROVIDER_TEMPORARY: "Nhà cung cấp tạm lỗi — đang thử lại",
  TEMPLATE_ERROR: "Lỗi mẫu nội dung",
};

export const SUPPRESSED_LABEL: Readonly<Record<string, string>> = {
  NO_ADDRESS: "Người nhận chưa có email",
  OPTED_OUT: "Người nhận đã tắt loại thông báo này",
  SETTLED: "Phiếu đã tất toán",
};
