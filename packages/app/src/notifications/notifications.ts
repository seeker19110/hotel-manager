// Lệnh/query thông báo (SPEC-notifications §5; S-006, S-009…S-011, S-017…S-019).
// - Người dùng chỉ thấy/đánh dấu thông báo của mình (RLS theo `app.actor_person_id()`; của người khác → NOT_FOUND).
// - Loại bắt buộc không tắt được (PREFERENCE_REQUIRED) — kiểm ở app TRƯỚC khi ghi gì (không đổi một phần) và ở CHECK DB.
// - Lịch sử gửi: chỉ owner/manager (housekeeping… → FORBIDDEN); manager chỉ cơ sở trong phạm vi (hàm DB lọc theo scope).
// - Huỷ đăng ký bằng token HMAC: không cần đăng nhập, kết quả giống nhau dù người nhận có tồn tại hay không.

import { withTenant } from "@hm/db";
import { AuthzError, authorize, parseNoticeTemplate } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../access/actor.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";
import { backfillNoticeDeadlines } from "../reservation/residence.ts";
import {
  DELIVERY_ERROR_LABEL,
  DELIVERY_STATUS_LABEL,
  NOTIFICATION_TYPES,
  type NotificationType,
  REQUIRED_TYPES,
  SUPPRESSED_LABEL,
} from "./dispatch.ts";
import { hasEmailChannel } from "./email.ts";
import { verifyUnsubscribeToken } from "./token.ts";

const MANAGER_ROLES = new Set(["owner", "manager"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TYPE_LABEL: Readonly<Record<NotificationType, string>> = {
  account_security: "bảo mật tài khoản",
  invoice_issued: "phiếu thu mới",
  invoice_overdue: "nhắc quá hạn",
  lease_expiring: "hợp đồng sắp hết hạn",
  stay_notice_due: "hạn thông báo lưu trú",
  maintenance_status: "cập nhật sự cố",
  export_ready: "tệp xuất sẵn sàng",
};

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id])).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [unknown, unknown];
    if (typeof at === "string" && typeof id === "string" && UUID.test(id) && !Number.isNaN(Date.parse(at))) {
      return { at, id };
    }
  } catch {
    /* rơi xuống lỗi bên dưới */
  }
  throw new CommandError("VALIDATION_FAILED", 422, "Con trỏ phân trang không hợp lệ");
}

export interface NotificationItem {
  id: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export interface MineList {
  items: NotificationItem[];
  unread_count: number;
  next_cursor: string | null;
}

/** `notifications.listMine`: thông báo trong app của chính mình, mới nhất trước, phân trang con trỏ + đếm chưa đọc. */
export async function listMine(
  db: Kysely<unknown>,
  actor: Actor,
  input: { limit?: number; cursor?: string; unreadOnly?: boolean },
): Promise<MineList> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const cur = decodeCursor(input.cursor);
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const rows = await sql<NotificationItem & { created_at_raw: string }>`
      select n.id, n.type, n.severity, n.title, n.body, n.link, n.read_at::text as read_at,
             n.created_at::text as created_at, n.created_at::text as created_at_raw
      from notifications n
      where n.organization_id = ${actor.orgId} and n.recipient_person_id = ${actor.personId}
        and (${input.unreadOnly ?? false}::boolean = false or n.read_at is null)
        and (${cur?.at ?? null}::timestamptz is null or (n.created_at, n.id) < (${cur?.at ?? null}::timestamptz, ${cur?.id ?? null}::uuid))
      order by n.created_at desc, n.id desc
      limit ${limit + 1}`.execute(trx);
    const unread = await sql<{ n: number }>`
      select count(*)::int as n from notifications
      where organization_id = ${actor.orgId} and recipient_person_id = ${actor.personId} and read_at is null`.execute(
      trx,
    );
    const page = rows.rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(({ created_at_raw: _raw, ...x }) => x),
      unread_count: unread.rows[0]?.n ?? 0,
      next_cursor: rows.rows.length > limit && last ? encodeCursor(last.created_at_raw, last.id) : null,
    };
  });
}

/** `notifications.markRead`: của người khác/không có → NOT_FOUND (S-017); đánh dấu lại là vô hại. */
export async function markRead(
  ctx: CommandContext,
  notificationId: string,
): Promise<{ notificationId: string }> {
  const r = await sql`
    update notifications set read_at = coalesce(read_at, now())
    where organization_id = ${ctx.actor.orgId} and id = ${notificationId} and recipient_person_id = ${ctx.actor.personId}`.execute(
    ctx.trx,
  );
  if (Number(r.numAffectedRows ?? 0) !== 1)
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu.");
  return { notificationId };
}

export async function markAllRead(ctx: CommandContext): Promise<{ marked: number }> {
  const r = await sql`
    update notifications set read_at = now()
    where organization_id = ${ctx.actor.orgId} and recipient_person_id = ${ctx.actor.personId} and read_at is null`.execute(
    ctx.trx,
  );
  return { marked: Number(r.numAffectedRows ?? 0) };
}

export interface PreferenceItem {
  type: NotificationType;
  channel: "email";
  state: "opted_in" | "opted_out";
  required: boolean;
}

/** `notifications.getPreferences`: mọi loại có email; chưa có hàng = `opted_in` (thông báo giao dịch, không phải tiếp thị). */
export async function getPreferences(db: Kysely<unknown>, actor: Actor): Promise<PreferenceItem[]> {
  const rows = await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
    sql<{ type: string; state: "opted_in" | "opted_out" }>`
      select type, state from notification_preferences
      where organization_id = ${actor.orgId} and person_id = ${actor.personId} and channel = 'email'`.execute(
      trx,
    ),
  );
  const by = new Map(rows.rows.map((r) => [r.type, r.state] as const));
  return NOTIFICATION_TYPES.filter(hasEmailChannel).map((type) => ({
    type,
    channel: "email" as const,
    state: by.get(type) ?? "opted_in",
    required: REQUIRED_TYPES.includes(type),
  }));
}

export interface PreferenceChange {
  type: NotificationType;
  state: "opted_in" | "opted_out";
}

/** `notifications.updatePreferences`: cả yêu cầu bị từ chối (422, không đổi gì) nếu có loại bắt buộc bị tắt (S-011). */
export async function updatePreferences(
  ctx: CommandContext,
  changes: readonly PreferenceChange[],
): Promise<{ changed: number }> {
  for (const c of changes) {
    if (c.state === "opted_out" && REQUIRED_TYPES.includes(c.type)) {
      throw new CommandError(
        "PREFERENCE_REQUIRED",
        422,
        "Loại thông báo này cần thiết cho tài khoản và không tắt được.",
      );
    }
    if (!hasEmailChannel(c.type)) {
      throw new CommandError("VALIDATION_FAILED", 422, "Loại thông báo này không có kênh email");
    }
  }
  const unique = new Map(changes.map((c) => [c.type, c.state] as const));
  let changed = 0;
  for (const [type, state] of unique) {
    const r = await sql<{ id: string }>`
      insert into notification_preferences (id, organization_id, person_id, type, channel, state, source)
      values (gen_random_uuid(), ${ctx.actor.orgId}, ${ctx.actor.personId}, ${type}, 'email', ${state}, 'user')
      on conflict (organization_id, person_id, type, channel)
      do update set state = excluded.state, changed_at = now(), source = 'user'
        where notification_preferences.state <> excluded.state
      returning id`.execute(ctx.trx);
    const id = r.rows[0]?.id;
    if (!id) continue;
    changed++;
    await ctx.audit({
      action: "notification.preference_changed",
      entityType: "notification_preference",
      entityId: id,
      after: { type, channel: "email", state, source: "user" },
    });
  }
  return { changed };
}

export interface DeliveryItem {
  id: string;
  notification_id: string;
  property_id: string | null;
  type: string;
  recipient_person_id: string;
  channel: string;
  status: string;
  /** Nhãn hiển thị trung thực (S-006): `queued` = "Đang chờ gửi", chỉ `sent` mới là "Đã chuyển cho nhà cung cấp email". */
  status_label: string;
  detail: string | null;
  attempts: number;
  next_attempt_at: string | null;
  last_error_code: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface DeliveryList {
  items: DeliveryItem[];
  next_cursor: string | null;
}

function requireManagerRole(actor: Actor): void {
  if (!MANAGER_ROLES.has(actor.role)) {
    throw new CommandError("FORBIDDEN", 403, "Bạn không có quyền thực hiện thao tác này.");
  }
}

/** `notifications.listDeliveries` (S-018): owner toàn tổ chức; manager theo cơ sở; vai trò khác → 403. */
export async function listDeliveries(
  db: Kysely<unknown>,
  actor: Actor,
  input: { status?: string; type?: string; recipientPersonId?: string; limit?: number; cursor?: string },
): Promise<DeliveryList> {
  requireManagerRole(actor);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const cur = decodeCursor(input.cursor);
  const rows = await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
    sql<{
      id: string;
      property_id: string | null;
      notification_id: string;
      type: string;
      recipient_person_id: string;
      channel: string;
      status: string;
      suppressed_reason: string | null;
      attempts: number;
      next_attempt_at: string | null;
      last_error_code: string | null;
      sent_at: string | null;
      created_at: string;
    }>`
      select id, property_id, notification_id, type, recipient_person_id, channel, status, suppressed_reason, attempts,
             next_attempt_at::text, last_error_code, sent_at::text, created_at::text
      from app.list_notification_deliveries(${input.status ?? null}, ${input.type ?? null}, ${input.recipientPersonId ?? null}::uuid,
                                            ${limit + 1}, ${cur?.at ?? null}::timestamptz, ${cur?.id ?? null}::uuid)`.execute(
      trx,
    ),
  );
  const page = rows.rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      notification_id: r.notification_id,
      property_id: r.property_id,
      type: r.type,
      recipient_person_id: r.recipient_person_id,
      channel: r.channel,
      status: r.status,
      status_label: DELIVERY_STATUS_LABEL[r.status] ?? r.status,
      detail: r.suppressed_reason
        ? (SUPPRESSED_LABEL[r.suppressed_reason] ?? r.suppressed_reason)
        : r.last_error_code
          ? (DELIVERY_ERROR_LABEL[r.last_error_code] ?? r.last_error_code)
          : null,
      attempts: r.attempts,
      next_attempt_at: r.next_attempt_at,
      last_error_code: r.last_error_code,
      sent_at: r.sent_at,
      created_at: r.created_at,
    })),
    next_cursor: rows.rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

/** `notifications.retryDelivery` (S-019): `dead`/`failed` → `queued`, đặt lại số lần thử, audit người thao tác. */
export async function retryDelivery(
  ctx: CommandContext,
  deliveryId: string,
): Promise<{ deliveryId: string; status: "queued" }> {
  requireManagerRole(ctx.actor);
  const found = await sql<{ status: string; property_id: string | null; attempts: number }>`
    select status, property_id, attempts from notification_deliveries
    where organization_id = ${ctx.actor.orgId} and id = ${deliveryId}`.execute(ctx.trx);
  const d = found.rows[0];
  if (!d) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu.");
  if (d.status !== "dead" && d.status !== "failed") {
    throw new CommandError("DELIVERY_NOT_RETRYABLE", 409, "Thông báo này không cần gửi lại.");
  }
  // Không dùng FOR UPDATE ở SELECT: policy UPDATE chỉ thấy hàng dead/failed. UPDATE có điều kiện trạng thái là rào chống đua.
  const upd = await sql`
    update notification_deliveries
       set status = 'queued', attempts = 0, next_attempt_at = now(), locked_until = null, last_error_code = null
     where organization_id = ${ctx.actor.orgId} and id = ${deliveryId} and status in ('dead','failed')`.execute(
    ctx.trx,
  );
  if (Number(upd.numAffectedRows ?? 0) !== 1) {
    throw new CommandError("DELIVERY_NOT_RETRYABLE", 409, "Thông báo này không cần gửi lại.");
  }
  await ctx.audit({
    action: "notification.delivery_retried",
    entityType: "notification_delivery",
    entityId: deliveryId,
    ...(d.property_id ? { propertyId: d.property_id } : {}),
    before: { status: d.status, attempts: d.attempts },
    after: { status: "queued", attempts: 0 },
  });
  return { deliveryId, status: "queued" };
}

export interface SettingsInput {
  propertyId: string;
  overdueReminderOffsetsDays?: number[];
  leaseExpiryOffsetsDays?: number[];
  /** `null` = xoá cấu hình (chưa cấu hình ⇒ không nhắc, có cảnh báo — S-020). */
  stayNoticeDeadline?: Record<string, string | number> | null;
  /**
   * Mẫu file thông báo lưu trú `{ columns, foreign_columns?, required? }` (trường trong danh mục của domain; T-207). `null` = xoá mẫu
   * (xuất file → `NOTICE_TEMPLATE_MISSING`). Nguồn mẫu của cơ quan chưa xác minh (Q-13) nên không có mẫu mặc định.
   */
  residenceNoticeTemplate?: Record<string, unknown> | null;
  sendWindowStart?: string;
  sendWindowEnd?: string;
}

export interface SettingsView {
  property_id: string;
  overdue_reminder_offsets_days: number[];
  lease_expiry_offsets_days: number[];
  stay_notice_deadline: Record<string, unknown> | null;
  residence_notice_template: Record<string, unknown> | null;
  send_window_start: string;
  send_window_end: string;
  configured: boolean;
}

const DEFAULT_SETTINGS = {
  overdue: [1],
  lease: [30, 7, 0],
  start: "08:00",
  end: "20:00",
};

/** `notifications.getSettings`: chưa có hàng → mặc định của ERD, `stay_notice_deadline = null` (không có mặc định cứng — Q-08). */
export async function getSettings(
  db: Kysely<unknown>,
  actor: Actor,
  propertyId: string,
): Promise<SettingsView> {
  try {
    authorize(actor, "notification.configure", { propertyId });
  } catch (err) {
    if (err instanceof AuthzError) throw new CommandError(err.code, err.status, err.message);
    throw err;
  }
  const r = await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
    sql<{
      overdue_reminder_offsets_days: number[];
      lease_expiry_offsets_days: number[];
      stay_notice_deadline: Record<string, unknown> | null;
      residence_notice_template: Record<string, unknown> | null;
      send_window_start: string;
      send_window_end: string;
    }>`
      select overdue_reminder_offsets_days, lease_expiry_offsets_days, stay_notice_deadline, residence_notice_template,
             to_char(send_window_start, 'HH24:MI') as send_window_start, to_char(send_window_end, 'HH24:MI') as send_window_end
      from notification_settings where organization_id = ${actor.orgId} and property_id = ${propertyId}`.execute(
      trx,
    ),
  );
  const row = r.rows[0];
  return {
    property_id: propertyId,
    overdue_reminder_offsets_days: row?.overdue_reminder_offsets_days ?? DEFAULT_SETTINGS.overdue,
    lease_expiry_offsets_days: row?.lease_expiry_offsets_days ?? DEFAULT_SETTINGS.lease,
    stay_notice_deadline: row?.stay_notice_deadline ?? null,
    residence_notice_template: row?.residence_notice_template ?? null,
    send_window_start: row?.send_window_start ?? DEFAULT_SETTINGS.start,
    send_window_end: row?.send_window_end ?? DEFAULT_SETTINGS.end,
    configured: Boolean(row),
  };
}

/** `notifications.updateSettings`: owner/manager trong phạm vi cơ sở (ma trận `notification.configure`); audit mọi thay đổi. */
export async function updateSettings(
  ctx: CommandContext,
  input: SettingsInput,
): Promise<{ propertyId: string }> {
  try {
    authorize(ctx.actor, "notification.configure", { propertyId: input.propertyId });
  } catch (err) {
    if (err instanceof AuthzError) throw new CommandError(err.code, err.status, err.message);
    throw err;
  }
  const start = input.sendWindowStart ?? DEFAULT_SETTINGS.start;
  const end = input.sendWindowEnd ?? DEFAULT_SETTINGS.end;
  if (end <= start) throw new CommandError("VALIDATION_FAILED", 422, "Thông tin chưa hợp lệ: khung giờ gửi.");
  const before = await sql<{ n: number }>`
    select count(*)::int as n from notification_settings
    where organization_id = ${ctx.actor.orgId} and property_id = ${input.propertyId}`.execute(ctx.trx);
  const exists = (before.rows[0]?.n ?? 0) > 0;
  const deadline = input.stayNoticeDeadline === undefined ? undefined : input.stayNoticeDeadline;
  const template = input.residenceNoticeTemplate;
  if (template !== undefined && template !== null && parseNoticeTemplate(template) === null)
    throw fieldError(
      "residence_notice_template",
      "INVALID",
      "Mẫu thông báo lưu trú không hợp lệ (cột ngoài danh mục, trùng cột hoặc thiếu cột)",
    );
  await sql`
    insert into notification_settings (id, organization_id, property_id, overdue_reminder_offsets_days, lease_expiry_offsets_days,
                                       stay_notice_deadline, residence_notice_template, send_window_start, send_window_end,
                                       updated_by)
    values (gen_random_uuid(), ${ctx.actor.orgId}, ${input.propertyId},
            ${input.overdueReminderOffsetsDays ?? DEFAULT_SETTINGS.overdue}::int[],
            ${input.leaseExpiryOffsetsDays ?? DEFAULT_SETTINGS.lease}::int[],
            ${deadline === undefined || deadline === null ? null : JSON.stringify(deadline)}::jsonb,
            ${template === undefined || template === null ? null : JSON.stringify(template)}::jsonb,
            ${start}::time, ${end}::time, ${ctx.actor.membershipId})
    on conflict (organization_id, property_id) do update set
      overdue_reminder_offsets_days = coalesce(${input.overdueReminderOffsetsDays ?? null}::int[], notification_settings.overdue_reminder_offsets_days),
      lease_expiry_offsets_days = coalesce(${input.leaseExpiryOffsetsDays ?? null}::int[], notification_settings.lease_expiry_offsets_days),
      stay_notice_deadline = case when ${deadline === undefined}::boolean then notification_settings.stay_notice_deadline
                                  else ${deadline === undefined || deadline === null ? null : JSON.stringify(deadline)}::jsonb end,
      residence_notice_template = case when ${template === undefined}::boolean then notification_settings.residence_notice_template
                                  else ${template === undefined || template === null ? null : JSON.stringify(template)}::jsonb end,
      send_window_start = coalesce(${input.sendWindowStart ?? null}::time, notification_settings.send_window_start),
      send_window_end = coalesce(${input.sendWindowEnd ?? null}::time, notification_settings.send_window_end),
      updated_by = ${ctx.actor.membershipId}`.execute(ctx.trx);
  // S-020: cơ sở cấu hình hạn SAU khi đã có khách → tính hạn bù cho thông báo lưu trú còn mở của các lượt đang ở (T-207).
  const backfilled =
    deadline !== undefined && deadline !== null
      ? await backfillNoticeDeadlines(ctx.trx, ctx.actor.orgId, input.propertyId)
      : 0;
  await ctx.audit({
    action: "notification.settings_updated",
    entityType: "notification_settings",
    propertyId: input.propertyId,
    after: {
      created: !exists,
      ...(input.overdueReminderOffsetsDays
        ? { overdue_reminder_offsets_days: input.overdueReminderOffsetsDays }
        : {}),
      ...(input.leaseExpiryOffsetsDays ? { lease_expiry_offsets_days: input.leaseExpiryOffsetsDays } : {}),
      ...(deadline !== undefined ? { stay_notice_deadline_configured: deadline !== null } : {}),
      ...(template !== undefined ? { residence_notice_template_configured: template !== null } : {}),
      ...(backfilled > 0 ? { residence_notice_due_backfilled: backfilled } : {}),
    },
  });
  return { propertyId: input.propertyId };
}

export interface UnsubscribeResult {
  type: NotificationType;
  /** Nhãn loại để trang xác nhận hiển thị ("nhắc quá hạn"). */
  typeLabel: string;
  organizationName: string;
  changed: boolean;
}

/**
 * Huỷ đăng ký bằng token (S-010): không cần đăng nhập. Chữ ký sai → NOT_FOUND (không phân biệt lý do); hết hạn → LINK_EXPIRED
 * (410); dùng lại → cùng kết quả (`changed=false`). Kết quả không phụ thuộc người nhận còn tồn tại hay không.
 */
export async function unsubscribeByToken(
  db: Kysely<unknown>,
  secret: string,
  token: string,
  now: Date,
  correlationId: string,
): Promise<UnsubscribeResult> {
  const v = verifyUnsubscribeToken(secret, token, now);
  if (v.status === "invalid") throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu.");
  if (v.status === "expired") {
    throw new CommandError(
      "LINK_EXPIRED",
      410,
      "Liên kết đã hết hạn. Vui lòng đổi tuỳ chọn trong mục Tài khoản.",
    );
  }
  const { orgId, personId, type } = v.claims;
  if (!(NOTIFICATION_TYPES as readonly string[]).includes(type)) {
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu.");
  }
  if (REQUIRED_TYPES.includes(type as NotificationType)) {
    throw new CommandError(
      "PREFERENCE_REQUIRED",
      422,
      "Loại thông báo này cần thiết cho tài khoản và không tắt được.",
    );
  }
  return withTenant(db, { orgId }, async (trx) => {
    const r = await sql<{ r: string }>`
      select app.notification_unsubscribe(${orgId}::uuid, ${personId}::uuid, ${type}, ${correlationId}) as r`.execute(
      trx,
    );
    const org = await sql<{ name: string }>`select name from organizations where id = ${orgId}`.execute(trx);
    return {
      type: type as NotificationType,
      typeLabel: TYPE_LABEL[type as NotificationType],
      organizationName: org.rows[0]?.name ?? "",
      changed: r.rows[0]?.r === "changed",
    };
  });
}
