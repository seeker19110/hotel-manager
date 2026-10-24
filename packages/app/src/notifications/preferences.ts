// PLAN đợt 3 T-214 — tuỳ chọn, hộp thông báo, lịch sử gửi, cấu hình (SPEC-notifications S-009…S-011, S-017…S-019).
// - Người nhận chỉ đọc/đánh dấu thông báo của mình (RLS; của người khác ⇒ 404, S-017).
// - Loại bắt buộc không tắt được ⇒ 422 PREFERENCE_REQUIRED (S-011; CSDL cũng chặn).
// - Huỷ đăng ký từ email không đăng nhập: token HMAC-SHA256 (khoá dẫn xuất HKDF từ BETTER_AUTH_SECRET, nhãn riêng) gắn tổ
//   chức + người + loại + hạn; sai chữ ký ⇒ 404, hết hạn ⇒ 410 LINK_EXPIRED; dùng lại ⇒ cùng kết quả (S-010).
// - Lịch sử gửi + gửi lại: owner toàn tổ chức, manager trong phạm vi (ma trận "Cấu hình thông báo"); vai trò khác ⇒ 403
//   (S-018). Gửi lại chỉ với `failed`/`dead` ⇒ `queued`, attempts về 0 (S-019); khác ⇒ 409 DELIVERY_NOT_RETRYABLE.
import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize, daysToMs, epochSeconds, secondsToMs } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../access/index.ts";
import { assertPersonInOrg, assertPropertyInOrg } from "../access/index.ts";
import { t as msg } from "../i18n.ts";
import { type CommandContext, CommandError } from "../pipeline/index.ts";
import {
  type DeliveryStatus,
  deliveryStatusLabel,
  NOTIFICATION_TYPES,
  type NotificationType,
  REQUIRED_TYPES,
} from "./templates.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Hạn liên kết huỷ đăng ký trong email. */
export const UNSUBSCRIBE_TTL_DAYS = 30;

function fieldError(path: string, code: string, message: string): CommandError {
  return new CommandError("VALIDATION_FAILED", 422, message, {
    extensions: { errors: [{ path, field: path, code }] },
  });
}

function isType(t: unknown): t is NotificationType {
  return typeof t === "string" && (NOTIFICATION_TYPES as readonly string[]).includes(t);
}

// ——— Hộp thông báo (S-017) ———

export interface NotificationItem {
  id: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: Date;
  readAt: Date | null;
}

/** `notifications.listMine` (query): thông báo của chính người dùng, mới nhất trước, kèm số chưa đọc. */
export async function listMyNotifications(
  db: Kysely<unknown>,
  actor: Actor,
  input: { limit?: number; before?: Date } = {},
): Promise<{ items: NotificationItem[]; unreadCount: number }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      id: string;
      type: string;
      severity: string;
      title: string;
      body: string;
      link: string | null;
      created_at: Date;
      read_at: Date | null;
    }>`
      select id, type, severity, title, body, link, created_at, read_at from notifications
      where organization_id = ${actor.orgId} and recipient_person_id = ${actor.personId}
        ${input.before ? sql`and created_at < ${input.before}` : sql``}
      order by created_at desc, id desc limit ${limit}`.execute(trx);
    const c = await sql<{ n: number }>`
      select count(*)::int as n from notifications
      where organization_id = ${actor.orgId} and recipient_person_id = ${actor.personId} and read_at is null`.execute(
      trx,
    );
    return {
      items: r.rows.map((x) => ({
        id: x.id,
        type: x.type,
        severity: x.severity,
        title: x.title,
        body: x.body,
        link: x.link,
        createdAt: x.created_at,
        readAt: x.read_at,
      })),
      unreadCount: c.rows[0]?.n ?? 0,
    };
  });
}

/** `notifications.markRead`: thông báo không thuộc người dùng ⇒ 404, không đổi gì (S-017). */
export async function markRead(ctx: CommandContext, input: { notificationId: string }) {
  if (!UUID.test(input.notificationId))
    throw new CommandError("NOT_FOUND", 404, msg("common.not_found_data"));
  const r = await sql<{ id: string }>`
    update notifications set read_at = coalesce(read_at, now())
    where organization_id = ${ctx.actor.orgId} and id = ${input.notificationId} and recipient_person_id = ${ctx.actor.personId}
    returning id`.execute(ctx.trx);
  if (!r.rows[0]) throw new CommandError("NOT_FOUND", 404, msg("common.not_found_data"));
  return { notificationId: input.notificationId, read: true as const };
}

/** `notifications.markAllRead`. */
export async function markAllRead(ctx: CommandContext) {
  const r = await sql`
    update notifications set read_at = now()
    where organization_id = ${ctx.actor.orgId} and recipient_person_id = ${ctx.actor.personId} and read_at is null`.execute(
    ctx.trx,
  );
  return { updated: Number(r.numAffectedRows ?? 0) };
}

// ——— Tuỳ chọn (S-009, S-011) ———

export interface PreferenceView {
  type: NotificationType;
  channel: "email";
  state: "opted_in" | "opted_out";
  required: boolean;
}

/** `notifications.getPreferences` (query): mọi loại × email; chưa có hàng = nhận (thông báo giao dịch, D-015). */
export async function getPreferences(db: Kysely<unknown>, actor: Actor): Promise<PreferenceView[]> {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{ type: string; state: "opted_in" | "opted_out" }>`
      select type, state from notification_preferences
      where organization_id = ${actor.orgId} and person_id = ${actor.personId} and channel = 'email'`.execute(
      trx,
    );
    const by = new Map(r.rows.map((x) => [x.type, x.state]));
    return NOTIFICATION_TYPES.map((type) => ({
      type,
      channel: "email" as const,
      state: REQUIRED_TYPES.has(type) ? "opted_in" : (by.get(type) ?? "opted_in"),
      required: REQUIRED_TYPES.has(type),
    }));
  });
}

/** `notifications.updatePreferences`: đổi lựa chọn email của chính mình theo loại; audit khi thật sự đổi. */
export async function updatePreference(
  ctx: CommandContext,
  input: { type: string; state: "opted_in" | "opted_out" },
): Promise<PreferenceView> {
  if (!isType(input.type)) throw fieldError("type", "invalid", msg("notify.pref.type_invalid"));
  if (input.state !== "opted_in" && input.state !== "opted_out")
    throw fieldError("state", "invalid", msg("notify.pref.state_invalid"));
  if (REQUIRED_TYPES.has(input.type) && input.state === "opted_out")
    throw new CommandError("PREFERENCE_REQUIRED", 422, msg("notify.pref.required_type"));
  const prev = await sql<{ state: string }>`
    select state from notification_preferences
    where organization_id = ${ctx.actor.orgId} and person_id = ${ctx.actor.personId} and type = ${input.type}
      and channel = 'email' for update`.execute(ctx.trx);
  const before = prev.rows[0]?.state ?? "opted_in";
  await sql`
    insert into notification_preferences (id, organization_id, person_id, type, channel, state, source)
    values (${randomUUID()}, ${ctx.actor.orgId}, ${ctx.actor.personId}, ${input.type}, 'email', ${input.state}, 'user')
    on conflict (organization_id, person_id, type, channel)
      do update set state = excluded.state, source = 'user', changed_at = now()`.execute(ctx.trx);
  if (before !== input.state) {
    await ctx.audit({
      action: "notification.preference_changed",
      entityType: "person",
      entityId: ctx.actor.personId,
      before: { type: input.type, channel: "email", state: before },
      after: { type: input.type, channel: "email", state: input.state, source: "user" },
    });
  }
  return { type: input.type, channel: "email", state: input.state, required: REQUIRED_TYPES.has(input.type) };
}

// ——— Huỷ đăng ký từ email (S-010) ———

/** Khoá ký token huỷ đăng ký: HKDF-SHA256 từ bí mật phiên với nhãn riêng (không dùng thẳng BETTER_AUTH_SECRET). */
export function unsubscribeKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "hm-unsubscribe-v1", 32));
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signUnsubscribe(
  key: Buffer,
  input: { orgId: string; personId: string; type: NotificationType; expiresAt: Date },
): string {
  const payload = `${input.orgId}.${input.personId}.${input.type}.${epochSeconds(input.expiresAt)}`;
  return `${b64(payload)}.${b64(createHmac("sha256", key).update(payload).digest())}`;
}

/** Liên kết huỷ đăng ký cho email (worker gọi khi render). */
export function unsubscribeUrl(
  baseUrl: string,
  key: Buffer,
  input: { orgId: string; personId: string; type: NotificationType },
  now: Date = new Date(),
): string {
  const token = signUnsubscribe(key, {
    ...input,
    expiresAt: new Date(now.getTime() + daysToMs(UNSUBSCRIBE_TTL_DAYS)),
  });
  return `${baseUrl.replace(/\/$/, "")}/huy-dang-ky?t=${token}`;
}

function verifyUnsubscribe(key: Buffer, token: string, now: Date) {
  const notFound = () => new CommandError("NOT_FOUND", 404, msg("notify.unsubscribe.link_invalid"));
  const parts = token.split(".");
  if (parts.length !== 2 || token.length > 512) throw notFound();
  const payload = Buffer.from(parts[0] as string, "base64url").toString("utf8");
  const sig = Buffer.from(parts[1] as string, "base64url");
  const expected = createHmac("sha256", key).update(payload).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) throw notFound();
  const [orgId, personId, type, exp] = payload.split(".");
  if (
    !orgId ||
    !UUID.test(orgId) ||
    !personId ||
    !UUID.test(personId) ||
    !isType(type) ||
    !/^\d+$/.test(exp ?? "")
  )
    throw notFound();
  if (secondsToMs(Number(exp)) <= now.getTime())
    throw new CommandError("LINK_EXPIRED", 410, msg("notify.unsubscribe.link_expired"));
  return { orgId, personId, type };
}

const TYPE_LABEL: Readonly<Record<NotificationType, string>> = {
  account_security: msg("notify.unsubscribe.type.account_security"),
  invoice_issued: msg("notify.unsubscribe.type.invoice_issued"),
  invoice_overdue: msg("notify.unsubscribe.type.invoice_overdue"),
  lease_expiring: msg("notify.unsubscribe.type.lease_expiring"),
  stay_notice_due: msg("notify.unsubscribe.type.stay_notice_due"),
  maintenance_status: msg("notify.unsubscribe.type.maintenance_status"),
  export_ready: msg("notify.unsubscribe.type.export_ready"),
};

/** `notifications.unsubscribe` (không đăng nhập): đặt `opted_out` cho đúng loại của đúng người; idempotent. */
export async function unsubscribe(
  db: Kysely<unknown>,
  key: Buffer,
  input: { token: string; correlationId: string; now?: Date },
): Promise<{ type: NotificationType; message: string; changed: boolean }> {
  const t = verifyUnsubscribe(key, input.token, input.now ?? new Date());
  if (REQUIRED_TYPES.has(t.type))
    throw new CommandError("PREFERENCE_REQUIRED", 422, msg("notify.pref.required_type"));
  const r = await sql<{ organization_name: string; changed: boolean }>`
    select * from app.unsubscribe_email(${t.orgId}::uuid, ${t.personId}::uuid, ${t.type}, ${input.correlationId})`.execute(
    db,
  );
  const row = r.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, msg("notify.unsubscribe.link_invalid"));
  return {
    type: t.type,
    changed: row.changed,
    message: msg("notify.unsubscribe.done", { type: TYPE_LABEL[t.type], org: row.organization_name }),
  };
}

// ——— Lịch sử gửi + gửi lại (S-006, S-018, S-019) ———

export interface DeliveryView {
  id: string;
  notificationId: string;
  type: string;
  recipientPersonId: string;
  propertyId: string | null;
  status: DeliveryStatus;
  statusLabel: string;
  suppressedReason: string | null;
  attempts: number;
  lastErrorCode: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

/** `notifications.listDeliveries` (query): owner toàn tổ chức, manager theo cơ sở (RLS), vai trò khác 403. */
export async function listDeliveries(
  db: Kysely<unknown>,
  actor: Actor,
  input: { propertyId?: string; status?: DeliveryStatus; recipientPersonId?: string; type?: string } = {},
): Promise<DeliveryView[]> {
  if (input.propertyId !== undefined && !UUID.test(input.propertyId))
    throw new CommandError("NOT_FOUND", 404, msg("common.not_found_data"));
  authorize(actor, "notification.configure", input.propertyId ? { propertyId: input.propertyId } : {});
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    if (input.propertyId) await assertPropertyInOrg(trx, actor.orgId, input.propertyId);
    // Người nhận lạ (hoặc không phải uuid) → 404, không lọc im lặng thành rỗng.
    if (input.recipientPersonId !== undefined) {
      if (!UUID.test(input.recipientPersonId))
        throw new CommandError("NOT_FOUND", 404, msg("common.not_found_data"));
      await assertPersonInOrg(trx, actor.orgId, input.recipientPersonId);
    }
    const r = await sql<{
      id: string;
      notification_id: string;
      type: string;
      recipient_person_id: string;
      property_id: string | null;
      status: DeliveryStatus;
      suppressed_reason: string | null;
      attempts: number;
      last_error_code: string | null;
      sent_at: Date | null;
      created_at: Date;
    }>`
      select d.id, d.notification_id, n.type, n.recipient_person_id, d.property_id, d.status, d.suppressed_reason, d.attempts,
             d.last_error_code, d.sent_at, d.created_at
      from notification_deliveries d join notifications n on n.organization_id = d.organization_id and n.id = d.notification_id
      where d.organization_id = ${actor.orgId}
        ${input.propertyId ? sql`and d.property_id = ${input.propertyId}` : sql``}
        ${input.status ? sql`and d.status = ${input.status}` : sql``}
        ${input.recipientPersonId && UUID.test(input.recipientPersonId) ? sql`and n.recipient_person_id = ${input.recipientPersonId}` : sql``}
        ${input.type ? sql`and n.type = ${input.type}` : sql``}
      order by d.created_at desc, d.id desc limit 200`.execute(trx);
    return r.rows.map((x) => ({
      id: x.id,
      notificationId: x.notification_id,
      type: x.type,
      recipientPersonId: x.recipient_person_id,
      propertyId: x.property_id,
      status: x.status,
      statusLabel: deliveryStatusLabel(x.status, x.suppressed_reason),
      suppressedReason: x.suppressed_reason,
      attempts: x.attempts,
      lastErrorCode: x.last_error_code,
      sentAt: x.sent_at,
      createdAt: x.created_at,
    }));
  });
}

/** `notifications.retryDelivery` (S-019): `failed`/`dead` → `queued`, attempts 0; có Idempotency-Key qua pipeline lệnh. */
export async function retryDelivery(ctx: CommandContext, input: { deliveryId: string; now?: Date }) {
  if (!UUID.test(input.deliveryId)) throw new CommandError("NOT_FOUND", 404, msg("common.not_found_data"));
  const r = await sql<{ status: DeliveryStatus; property_id: string | null; attempts: number }>`
    select status, property_id, attempts from notification_deliveries
    where organization_id = ${ctx.actor.orgId} and id = ${input.deliveryId}`.execute(ctx.trx);
  const d = r.rows[0];
  if (!d) {
    // Vai trò không có quyền thấy mọi lần gửi (RLS) → 403 rõ ràng theo S-018 thay vì 404.
    authorize(ctx.actor, "notification.configure", {});
    throw new CommandError("NOT_FOUND", 404, msg("common.not_found_data"));
  }
  authorize(ctx.actor, "notification.configure", d.property_id ? { propertyId: d.property_id } : {});
  if (d.status !== "failed" && d.status !== "dead")
    throw new CommandError("DELIVERY_NOT_RETRYABLE", 409, msg("notify.delivery.not_retryable"), {
      extensions: { from: d.status },
    });
  const u = await sql<{ id: string }>`
    update notification_deliveries set status = 'queued', attempts = 0, next_attempt_at = ${input.now ?? new Date()},
           last_error_code = null, locked_until = null
    where organization_id = ${ctx.actor.orgId} and id = ${input.deliveryId} and status in ('failed','dead')
    returning id`.execute(ctx.trx);
  if (!u.rows[0]) throw new CommandError("DELIVERY_NOT_RETRYABLE", 409, msg("notify.delivery.not_retryable"));
  await ctx.audit({
    action: "notification.delivery_retried",
    entityType: "notification_delivery",
    entityId: input.deliveryId,
    ...(d.property_id ? { propertyId: d.property_id } : {}),
    before: { status: d.status, attempts: d.attempts },
    after: { status: "queued", attempts: 0 },
  });
  return { deliveryId: input.deliveryId, status: "queued" as const };
}

// ——— Cấu hình cơ sở ———

export interface SettingsInput {
  propertyId: string;
  overdueReminderOffsetsDays?: number[];
  leaseExpiryOffsetsDays?: number[];
  stayNoticeDeadline?: {
    domestic_cutoff?: string;
    domestic_next_day_before?: string;
    foreign_hours?: number;
  } | null;
  sendWindowStart?: string;
  sendWindowEnd?: string;
}

function offsets(v: number[] | undefined, path: string): number[] | undefined {
  if (v === undefined) return undefined;
  if (
    !Array.isArray(v) ||
    v.length < 1 ||
    v.length > 10 ||
    !v.every((n) => Number.isInteger(n) && n >= 0 && n <= 365)
  )
    throw fieldError(path, "invalid", msg("notify.settings.offsets_invalid"));
  return [...new Set(v)].sort((a, b) => b - a);
}

/** `notifications.updateSettings`: owner/manager trong phạm vi (ma trận "Cấu hình thông báo"); audit. */
export async function updateSettings(ctx: CommandContext, input: SettingsInput) {
  if (!UUID.test(input.propertyId))
    throw new CommandError("NOT_FOUND", 404, msg("common.property_not_found"));
  authorize(ctx.actor, "notification.configure", { propertyId: input.propertyId });
  const p = await sql<{ id: string }>`
    select id from properties where organization_id = ${ctx.actor.orgId} and id = ${input.propertyId}`.execute(
    ctx.trx,
  );
  if (!p.rows[0]) throw new CommandError("NOT_FOUND", 404, msg("common.property_not_found"));
  const overdue = offsets(input.overdueReminderOffsetsDays, "overdue_reminder_offsets_days");
  const lease = offsets(input.leaseExpiryOffsetsDays, "lease_expiry_offsets_days");
  let deadline: string | null | undefined;
  if (input.stayNoticeDeadline === null) deadline = null;
  else if (input.stayNoticeDeadline !== undefined) {
    const d = input.stayNoticeDeadline;
    const keys = Object.keys(d);
    if (keys.some((k) => !["domestic_cutoff", "domestic_next_day_before", "foreign_hours"].includes(k)))
      throw fieldError("stay_notice_deadline", "unknown_key", msg("notify.settings.deadline_unknown_key"));
    if (d.domestic_cutoff !== undefined && !HHMM.test(d.domestic_cutoff))
      throw fieldError(
        "stay_notice_deadline.domestic_cutoff",
        "invalid",
        msg("notify.settings.clock_format"),
      );
    if (d.domestic_next_day_before !== undefined && !HHMM.test(d.domestic_next_day_before))
      throw fieldError(
        "stay_notice_deadline.domestic_next_day_before",
        "invalid",
        msg("notify.settings.clock_format"),
      );
    if ((d.domestic_cutoff === undefined) !== (d.domestic_next_day_before === undefined))
      throw fieldError("stay_notice_deadline", "incomplete", msg("notify.settings.deadline_incomplete"));
    if (
      d.foreign_hours !== undefined &&
      !(Number.isInteger(d.foreign_hours) && d.foreign_hours >= 1 && d.foreign_hours <= 72)
    )
      throw fieldError("stay_notice_deadline.foreign_hours", "invalid", msg("notify.settings.foreign_hours"));
    if (keys.length === 0)
      throw fieldError("stay_notice_deadline", "empty", msg("notify.settings.deadline_empty"));
    deadline = JSON.stringify(d);
  }
  for (const [k, v] of [
    ["send_window_start", input.sendWindowStart],
    ["send_window_end", input.sendWindowEnd],
  ] as const)
    if (v !== undefined && !HHMM.test(v)) throw fieldError(k, "invalid", msg("notify.settings.clock_format"));
  const cur = await sql<{ send_window_start: string; send_window_end: string }>`
    select to_char(send_window_start, 'HH24:MI') as send_window_start, to_char(send_window_end, 'HH24:MI') as send_window_end
    from notification_settings where organization_id = ${ctx.actor.orgId} and property_id = ${input.propertyId} for update`.execute(
    ctx.trx,
  );
  const start = input.sendWindowStart ?? cur.rows[0]?.send_window_start ?? "08:00";
  const end = input.sendWindowEnd ?? cur.rows[0]?.send_window_end ?? "20:00";
  if (end <= start) throw fieldError("send_window_end", "invalid", msg("notify.settings.window_order"));
  await sql`
    insert into notification_settings (id, organization_id, property_id, overdue_reminder_offsets_days, lease_expiry_offsets_days,
                                       stay_notice_deadline, send_window_start, send_window_end, updated_by)
    values (${randomUUID()}, ${ctx.actor.orgId}, ${input.propertyId}, ${overdue ?? [1, 3, 7]}::int[], ${lease ?? [30, 7]}::int[],
            ${deadline ?? null}::jsonb, ${start}::time, ${end}::time, ${ctx.actor.membershipId})
    on conflict (organization_id, property_id) do update set
      overdue_reminder_offsets_days = ${overdue === undefined ? sql`notification_settings.overdue_reminder_offsets_days` : sql`excluded.overdue_reminder_offsets_days`},
      lease_expiry_offsets_days = ${lease === undefined ? sql`notification_settings.lease_expiry_offsets_days` : sql`excluded.lease_expiry_offsets_days`},
      stay_notice_deadline = ${deadline === undefined ? sql`notification_settings.stay_notice_deadline` : sql`excluded.stay_notice_deadline`},
      send_window_start = excluded.send_window_start, send_window_end = excluded.send_window_end,
      updated_by = excluded.updated_by, version = notification_settings.version + 1`.execute(ctx.trx);
  await ctx.audit({
    action: "notification.settings_updated",
    entityType: "notification_settings",
    entityId: input.propertyId,
    propertyId: input.propertyId,
    after: {
      ...(overdue ? { overdue_reminder_offsets_days: overdue } : {}),
      ...(lease ? { lease_expiry_offsets_days: lease } : {}),
      ...(deadline !== undefined
        ? { stay_notice_deadline: deadline === null ? null : JSON.parse(deadline) }
        : {}),
      send_window_start: start,
      send_window_end: end,
    },
  });
  // Đổi cấu hình (SEC-LOG-001): ghi MỘT dòng log bảo mật; giá trị trước/sau nằm ở audit_events, không vào log.
  ctx.security({
    event: "config.changed",
    target: { type: "notification_settings", id: input.propertyId },
    reason: "notification.settings_updated",
  });
  return { propertyId: input.propertyId, updated: true as const };
}
