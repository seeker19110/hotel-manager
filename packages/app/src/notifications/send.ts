// `notify.sendEmail` (SPEC-notifications S-001, S-003…S-005, S-008, S-009, S-012; ERD `notification_deliveries`).
// 1. Nhận lô qua `app.claim_due_deliveries` (SKIP LOCKED, ≤ perOrg mỗi tổ chức mỗi lượt — rate limit Q-05; `sending` quá hạn
//    khoá → `retrying`, hết lượt → `dead`). Nhận = `sending` + attempts + 1.
// 2. Trong ngữ cảnh tổ chức: kiểm lại trước khi gửi — người nhận tắt loại này → `suppressed OPTED_OUT`; chưa có email →
//    `NO_ADDRESS`; nhắc quá hạn mà phiếu đã tất toán → `SETTLED` (đọc lại số dư, S-008); lỗi mẫu → `failed TEMPLATE_ERROR`.
// 3. Gửi NGOÀI transaction (không giữ khoá/kết nối khi gọi mạng); khoá idempotency = id lần gửi (S-003).
// 4. Ghi kết quả có điều kiện `status = 'sending' AND locked_until = <lúc nhận>` (mã rào của lần nhận, 0037: worker chậm quá
//    hạn khoá bị nhận lại thì không ghi đè lần nhận mới — kể cả sau gửi lại thủ công đặt attempts = 0; ghi 0 hàng ⇒
//    `stale`, không đếm/log như kết quả; `sending` quá hạn về `retrying` có chờ lùi): `sent` · lỗi vĩnh viễn → `failed RECIPIENT_INVALID` (không thử lại) ·
//    lỗi tạm → `retrying` sau 1 ph, 5 ph, 30 ph, 2 giờ, 6 giờ (Q-05: 1 lần đầu + 5 lần thử lại) → lần 6 lỗi ⇒ `dead`.
// Log chỉ có email đã che (`a***@example.com`).
import { withTenant } from "@hm/db";
import { type Kysely, sql, type Transaction } from "kysely";
import { EmailSendError, type EmailSender } from "./email.ts";
import { unsubscribeUrl } from "./preferences.ts";
import { maskEmail, type NotificationType, REQUIRED_TYPES, render, TemplateError } from "./templates.ts";

/** Khoảng chờ trước lần thử lại thứ n (phút) — Q-05. */
export const RETRY_BACKOFF_MINUTES = [1, 5, 30, 120, 360] as const;
/** Lần gửi đầu + 5 lần thử lại. */
export const MAX_ATTEMPTS = RETRY_BACKOFF_MINUTES.length + 1;

export interface SendStats {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
  dead: number;
  suppressed: number;
  /** Kết quả về muộn của lần nhận đã bị nhận lại (không ghi). */
  stale: number;
}

export type SendLog = (event: string, fields: Record<string, unknown>) => void;

interface Row {
  notification_id: string;
  recipient_person_id: string;
  type: NotificationType;
  vars: Record<string, unknown>;
  email: string | null;
  opted_out: boolean;
}

type Outcome =
  | { kind: "suppressed"; reason: "OPTED_OUT" | "NO_ADDRESS" | "SETTLED" }
  | { kind: "failed"; code: "TEMPLATE_ERROR" }
  | { kind: "send"; to: string; subject: string; text: string };

async function prepare(
  workerDb: Kysely<unknown>,
  orgId: string,
  deliveryId: string,
  fence: Date,
  opts: { baseUrl?: string; unsubscribeKey?: Buffer; now: Date },
): Promise<Outcome | null> {
  return withTenant(workerDb, { orgId }, async (trx) => {
    const r = await sql<Row>`
      select n.id as notification_id, n.recipient_person_id, n.type, n.vars, p.email,
             exists (select 1 from notification_preferences np
                     where np.organization_id = n.organization_id and np.person_id = n.recipient_person_id
                       and np.type = n.type and np.channel = 'email' and np.state = 'opted_out') as opted_out
      from notification_deliveries d
      join notifications n on n.organization_id = d.organization_id and n.id = d.notification_id
      join persons p on p.organization_id = n.organization_id and p.id = n.recipient_person_id
      where d.organization_id = ${orgId} and d.id = ${deliveryId} and d.status = 'sending' and d.locked_until = ${fence}`.execute(
      trx,
    );
    const row = r.rows[0];
    if (!row) return null;
    let out: Outcome;
    if (row.opted_out && !REQUIRED_TYPES.has(row.type)) out = { kind: "suppressed", reason: "OPTED_OUT" };
    else if (!row.email) out = { kind: "suppressed", reason: "NO_ADDRESS" };
    else if (row.type === "invoice_overdue" && (await settled(trx, orgId, row.vars.invoiceId)))
      out = { kind: "suppressed", reason: "SETTLED" };
    else {
      try {
        const m = render(row.type, row.vars, {
          ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
          // Liên kết huỷ đăng ký có hạn (S-010) — chỉ khi có khoá ký và địa chỉ gốc; loại bắt buộc không có liên kết.
          ...(opts.baseUrl && opts.unsubscribeKey
            ? {
                unsubscribeUrl: unsubscribeUrl(
                  opts.baseUrl,
                  opts.unsubscribeKey,
                  { orgId, personId: row.recipient_person_id, type: row.type },
                  opts.now,
                ),
              }
            : {}),
        });
        out = { kind: "send", to: row.email, subject: m.emailSubject, text: m.emailText };
      } catch (err) {
        if (!(err instanceof TemplateError)) throw err;
        out = { kind: "failed", code: "TEMPLATE_ERROR" };
      }
    }
    if (out.kind === "suppressed") {
      await sql`update notification_deliveries set status = 'suppressed', suppressed_reason = ${out.reason}, locked_until = null
                where organization_id = ${orgId} and id = ${deliveryId} and status = 'sending' and locked_until = ${fence}`.execute(
        trx,
      );
    } else if (out.kind === "failed") {
      await sql`update notification_deliveries set status = 'failed', last_error_code = ${out.code}, locked_until = null
                where organization_id = ${orgId} and id = ${deliveryId} and status = 'sending' and locked_until = ${fence}`.execute(
        trx,
      );
    }
    return out;
  });
}

/** Đọc lại số dư phiếu ngay lúc gửi (S-008): đã phân bổ đủ ⇒ không nhắc. */
async function settled(trx: Transaction<unknown>, orgId: string, invoiceId: unknown): Promise<boolean> {
  if (typeof invoiceId !== "string") return false;
  const r = await sql<{ open: string }>`
    select (total - allocated_total)::text as open from invoices where organization_id = ${orgId} and id = ${invoiceId}`.execute(
    trx,
  );
  return r.rows[0] !== undefined && Number(r.rows[0].open) <= 0;
}

/** Một lượt gửi: nhận lô đến hạn rồi xử lý từng lần gửi. Gọi định kỳ từ worker (T-225). */
export async function sendDueEmails(
  workerDb: Kysely<unknown>,
  sender: EmailSender,
  opts: {
    now?: Date;
    limit?: number;
    perOrg?: number;
    lockSeconds?: number;
    baseUrl?: string;
    unsubscribeKey?: Buffer;
    log?: SendLog;
  } = {},
): Promise<SendStats> {
  const now = opts.now ?? new Date();
  const log: SendLog = opts.log ?? (() => {});
  const stats: SendStats = { claimed: 0, sent: 0, retrying: 0, failed: 0, dead: 0, suppressed: 0, stale: 0 };
  const claimed = await sql<{ id: string; organization_id: string; attempts: number; locked_until: Date }>`
    select * from app.claim_due_deliveries(${now}, ${opts.limit ?? 50}, ${opts.perOrg ?? 10}, ${opts.lockSeconds ?? 120},
                                           ${MAX_ATTEMPTS})`.execute(workerDb);
  stats.claimed = claimed.rows.length;
  for (const c of claimed.rows) {
    const out = await prepare(workerDb, c.organization_id, c.id, c.locked_until, {
      now,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.unsubscribeKey ? { unsubscribeKey: opts.unsubscribeKey } : {}),
    });
    if (!out) continue;
    if (out.kind === "suppressed") {
      stats.suppressed += 1;
      log("notification.delivery_suppressed", { delivery_id: c.id, reason: out.reason });
      continue;
    }
    if (out.kind === "failed") {
      stats.failed += 1;
      log("notification.delivery_failed", { delivery_id: c.id, code: out.code });
      continue;
    }
    let result: { providerMessageId: string } | null = null;
    let error: EmailSendError | null = null;
    try {
      result = await sender.send({ to: out.to, subject: out.subject, text: out.text, idempotencyKey: c.id });
    } catch (err) {
      error =
        err instanceof EmailSendError ? err : new EmailSendError("temporary", String((err as Error).message));
    }
    const written = await withTenant(workerDb, { orgId: c.organization_id }, async (trx) => {
      const fence = sql`organization_id = ${c.organization_id} and id = ${c.id} and status = 'sending' and locked_until = ${c.locked_until}`;
      let r: { numAffectedRows?: bigint };
      if (result) {
        r =
          await sql`update notification_deliveries set status = 'sent', sent_at = ${now}, provider_message_id = ${result.providerMessageId},
                         locked_until = null, last_error_code = null
                  where ${fence}`.execute(trx);
      } else if (error?.kind === "permanent") {
        r =
          await sql`update notification_deliveries set status = 'failed', last_error_code = 'RECIPIENT_INVALID', locked_until = null
                  where ${fence}`.execute(trx);
      } else if (c.attempts >= MAX_ATTEMPTS) {
        r =
          await sql`update notification_deliveries set status = 'dead', last_error_code = 'PROVIDER_TEMPORARY', locked_until = null
                  where ${fence}`.execute(trx);
      } else {
        const wait: number = RETRY_BACKOFF_MINUTES[c.attempts - 1] ?? 360;
        r =
          await sql`update notification_deliveries set status = 'retrying', last_error_code = 'PROVIDER_TEMPORARY', locked_until = null,
                         next_attempt_at = ${new Date(now.getTime() + wait * 60_000)}
                  where ${fence}`.execute(trx);
      }
      return Number(r.numAffectedRows ?? 0) > 0;
    });
    const to = maskEmail(out.to);
    if (!written) {
      stats.stale += 1;
      log("notification.delivery_stale_result", { delivery_id: c.id, attempts: c.attempts });
    } else if (result) {
      stats.sent += 1;
      log("notification.delivery_sent", { delivery_id: c.id, to, attempts: c.attempts });
    } else if (error?.kind === "permanent") {
      stats.failed += 1;
      log("notification.delivery_failed", { delivery_id: c.id, to, code: "RECIPIENT_INVALID" });
    } else if (c.attempts >= MAX_ATTEMPTS) {
      stats.dead += 1;
      // Cảnh báo vận hành: metric `notification_dead_total` (T-225 xuất /api/metrics từ số hàng `dead`).
      log("notification.delivery_dead", {
        delivery_id: c.id,
        to,
        attempts: c.attempts,
        metric: "notification_dead_total",
      });
    } else {
      stats.retrying += 1;
      log("notification.delivery_retrying", { delivery_id: c.id, to, attempts: c.attempts });
    }
  }
  return stats;
}
