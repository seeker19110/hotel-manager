// Định dạng hiển thị (chỉ dùng ở Server Component để HTML server/client không lệch nhau).
// Tiền/ngày đi qua Intl ở @hm/domain (XC-I18N-003) — không ghép chuỗi tay.
// Nhãn mã (trạng thái, loại…) lấy từ tệp tài nguyên (XC-I18N-001, D-103) nhưng module này được cả client component import
// (vnd/day) ⇒ KHÔNG import giá trị catalog (D-098): mỗi hàm nhãn nhận `m` — server truyền `messagesFor("tiền.tố.", …)`, client
// nhận `m` qua prop/`useMessages()`. Mã lạ trả nguyên mã để lỗi dữ liệu hiện ra thay vì trống.
import { formatDate, formatMonth, formatVnd, formatVndUnitPrice } from "@hm/app/format";
import type { MessageKey } from "./i18n.ts";
import { tm } from "./i18n-format.ts";

export const vnd = (n: number) => formatVnd(n);

/** Đơn giá (có thể lẻ, ADR-0003). */
export const vndUnitPrice = (n: number) => formatVndUnitPrice(n);

/** `YYYY-MM-DD` → `dd/mm/yyyy` (theo vi-VN). Rỗng → "—"; dạng lạ giữ nguyên để lỗi dữ liệu hiện ra thay vì làm sập trang. */
export const day = (d: string | null | undefined) => {
  if (!d) return "—";
  try {
    return formatDate(d);
  } catch {
    return d;
  }
};

/** `YYYY-MM-DD` → `mm/yyyy` (kỳ thu). Dạng lạ giữ nguyên. */
export const month = (d: string) => {
  try {
    return formatMonth(d);
  } catch {
    return d;
  }
};

/**
 * Phần catalog có các khoá bắt đầu bằng tiền tố `P`. Viết bằng `Record` (không dùng `Messages<P>` của lib/i18n.ts): TypeScript so
 * hai thể hiện của cùng một alias generic theo tham số kiểu nên `Messages<"a." | "b.">` không gán được cho `Messages<"a.">` — trang
 * gom nhiều nhóm nhãn vào một `messagesFor(…)` cần gán được.
 */
type LabelMessages<P extends string> = Readonly<Record<Extract<MessageKey, `${P}${string}`>, string>>;

/** Nhãn của `code` theo bảng `labels`; mã không có trong bảng → `fallback` (mặc định chính mã). */
function pick(labels: Readonly<Record<string, string>>, code: string, fallback: string = code): string {
  return Object.hasOwn(labels, code) ? (labels[code] as string) : fallback;
}

export const leaseStatusLabel = (m: LabelMessages<"label.lease_status.">, status: string) =>
  pick(
    {
      draft: tm(m, "label.lease_status.draft"),
      pending_signature: tm(m, "label.lease_status.pending_signature"),
      signed_awaiting_handover: tm(m, "label.lease_status.signed_awaiting_handover"),
      active: tm(m, "label.lease_status.active"),
      notice_given: tm(m, "label.lease_status.notice_given"),
      settling: tm(m, "label.lease_status.settling"),
      closed: tm(m, "label.lease_status.closed"),
      cancelled: tm(m, "label.lease_status.cancelled"),
    },
    status,
  );

export const periodStatusLabel = (m: LabelMessages<"label.period_status.">, status: string) =>
  pick(
    {
      draft: tm(m, "label.period_status.draft"),
      reviewing: tm(m, "label.period_status.reviewing"),
      issued: tm(m, "label.period_status.issued"),
      locked: tm(m, "label.period_status.locked"),
    },
    status,
  );

/** Nhãn loại công tơ; `undefined` khi mã lạ (nơi gọi tự quyết dùng mã thô hay viết thường). */
export const meterLabel = (m: LabelMessages<"label.meter.">, kind: string): string | undefined => {
  const labels: Readonly<Record<string, string>> = {
    electric: tm(m, "label.meter.electric"),
    water: tm(m, "label.meter.water"),
  };
  return Object.hasOwn(labels, kind) ? labels[kind] : undefined;
};

// ——— Khách sạn + vận hành (T-223) ———
/** Cộng `n` ngày vào `YYYY-MM-DD` (UTC, không lệch múi giờ). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → "Thứ ba 21/10/2026". */
export const weekdayDay = (m: LabelMessages<"label.weekday.">, d: string) => {
  const weekday = [
    tm(m, "label.weekday.0"),
    tm(m, "label.weekday.1"),
    tm(m, "label.weekday.2"),
    tm(m, "label.weekday.3"),
    tm(m, "label.weekday.4"),
    tm(m, "label.weekday.5"),
    tm(m, "label.weekday.6"),
  ];
  return `${weekday[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${day(d)}`;
};

/** Múi giờ mặc định của cơ sở (`properties.timezone` mặc định — DOMAIN-MODEL INV-G2). */
export const DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh";

/**
 * Thời điểm theo múi giờ CỦA CƠ SỞ: "14:05 16/10/2026". Múi giờ bắt buộc (AUD-XFEAT-003): trước đây mặc định ngầm VN nên
 * cơ sở đặt múi giờ khác hiển thị sai giờ — typecheck nay bắt mọi chỗ quên truyền.
 */
export const dateTime = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone }).format(d);

/** NGÀY (dd/mm/yyyy) của một thời điểm theo múi giờ cho trước — không cắt chuỗi ISO (đó là ngày UTC, lệch sau 17:00 giờ VN). */
export const dateInZone = (d: Date, timeZone: string) =>
  day(
    new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(
      new Date(d),
    ),
  );

/** Múi giờ chung của các cơ sở trong phạm vi (thông báo cấp tổ chức); các cơ sở khác múi giờ nhau ⇒ mặc định. */
export function commonTimeZone(properties: readonly { timezone: string }[]): string {
  const zones = new Set(properties.map((p) => p.timezone));
  return zones.size === 1 ? ([...zones][0] as string) : DEFAULT_TIME_ZONE;
}

/** Số đo (chỉ công tơ…) theo kiểu Việt Nam: 1.350 — dùng thay `new Intl.NumberFormat` rải rác (AUD-XFEAT-005). */
export const decimal = (n: number) => new Intl.NumberFormat("vi-VN").format(n);

export const bookingStatusLabel = (m: LabelMessages<"label.booking_status.">, status: string) =>
  pick(
    {
      draft: tm(m, "label.booking_status.draft"),
      held: tm(m, "label.booking_status.held"),
      confirmed: tm(m, "label.booking_status.confirmed"),
      in_house: tm(m, "label.booking_status.in_house"),
      checked_out: tm(m, "label.booking_status.checked_out"),
      cancelled: tm(m, "label.booking_status.cancelled"),
      no_show: tm(m, "label.booking_status.no_show"),
      expired: tm(m, "label.booking_status.expired"),
    },
    status,
  );

export const hkStatusLabel = (m: LabelMessages<"rooms.hk." | "label.hk_status.">, status: string) =>
  pick(
    {
      dirty: tm(m, "rooms.hk.dirty"),
      assigned: tm(m, "rooms.hk.assigned"),
      cleaning: tm(m, "rooms.hk.cleaning"),
      clean: tm(m, "label.hk_status.clean"),
      inspected: tm(m, "label.hk_status.inspected"),
    },
    status,
  );

export const taskStatusLabel = (m: LabelMessages<"label.task_status.">, status: string) =>
  pick(
    {
      open: tm(m, "label.task_status.open"),
      assigned: tm(m, "label.task_status.assigned"),
      in_progress: tm(m, "label.task_status.in_progress"),
      done: tm(m, "label.task_status.done"),
      verified: tm(m, "label.task_status.verified"),
      cancelled: tm(m, "label.task_status.cancelled"),
    },
    status,
  );

export const taskKindLabel = (m: LabelMessages<"housekeeping.list.create.kind_">, kind: string) =>
  pick(
    {
      cleaning: tm(m, "housekeeping.list.create.kind_cleaning"),
      inspection: tm(m, "housekeeping.list.create.kind_inspection"),
    },
    kind,
  );

export const priorityLabel = (m: LabelMessages<"housekeeping.list.create.priority_">, priority: string) =>
  pick(
    {
      normal: tm(m, "housekeeping.list.create.priority_normal"),
      high: tm(m, "housekeeping.list.create.priority_high"),
      urgent: tm(m, "housekeeping.list.create.priority_urgent"),
    },
    priority,
  );

export const workOrderStatusLabel = (m: LabelMessages<"label.work_order_status.">, status: string) =>
  pick(
    {
      open: tm(m, "label.work_order_status.open"),
      assigned: tm(m, "label.work_order_status.assigned"),
      in_progress: tm(m, "label.work_order_status.in_progress"),
      done: tm(m, "label.work_order_status.done"),
      verified: tm(m, "label.work_order_status.verified"),
      cancelled: tm(m, "label.work_order_status.cancelled"),
    },
    status,
  );

/** Nhãn mức độ sự cố; `undefined` khi mã lạ (nơi gọi viết thường nhãn, mã lạ giữ nguyên). */
export const severityLabel = (
  m: LabelMessages<"incident_form.severity.">,
  severity: string,
): string | undefined => {
  const labels: Readonly<Record<string, string>> = {
    low: tm(m, "incident_form.severity.low"),
    medium: tm(m, "incident_form.severity.medium"),
    high: tm(m, "incident_form.severity.high"),
    critical: tm(m, "incident_form.severity.critical"),
  };
  return Object.hasOwn(labels, severity) ? labels[severity] : undefined;
};

export const noticeStatusLabel = (m: LabelMessages<"label.notice_status.">, status: string) =>
  pick(
    {
      pending: tm(m, "label.notice_status.pending"),
      exported: tm(m, "label.notice_status.exported"),
      submitted: tm(m, "label.notice_status.submitted"),
    },
    status,
  );

export const chargeKindLabel = (m: LabelMessages<"label.charge_kind." | "stay.add.kind_">, kind: string) =>
  pick(
    {
      room: tm(m, "label.charge_kind.room"),
      service: tm(m, "stay.add.kind_service"),
      fee: tm(m, "stay.add.kind_fee"),
      discount: tm(m, "stay.add.kind_discount"),
    },
    kind,
  );

export const paymentMethodLabel = (m: LabelMessages<"label.payment_method.">, method: string) =>
  pick(
    {
      cash: tm(m, "label.payment_method.cash"),
      bank_transfer: tm(m, "label.payment_method.bank_transfer"),
    },
    method,
  );

export const paymentStatusLabel = (m: LabelMessages<"label.payment_status.">, status: string) =>
  pick(
    {
      pending: tm(m, "label.payment_status.pending"),
      confirmed: tm(m, "label.payment_status.confirmed"),
      rejected: tm(m, "label.payment_status.rejected"),
      reversed: tm(m, "label.payment_status.reversed"),
    },
    status,
  );

export const stayStatusLabel = (
  m: LabelMessages<"label.stay_status." | "guest_stay.status.">,
  status: string,
) =>
  pick(
    {
      expected: tm(m, "label.stay_status.expected"),
      in_house: tm(m, "guest_stay.status.in_house"),
      checked_out: tm(m, "guest_stay.status.checked_out"),
      cancelled: tm(m, "guest_stay.status.cancelled"),
      no_show: tm(m, "guest_stay.status.no_show"),
    },
    status,
  );

/**
 * Tên đầy đủ của thẻ "Hôm nay" (liên kết đọc được riêng lẻ — SPEC-audit-reporting §5): "Khách đến hôm nay: 3". Thẻ không có
 * tên đầy đủ riêng → `fallback` (tên ngắn của thẻ).
 */
export const cardLabel = (m: LabelMessages<"today_list.title.">, key: string, fallback: string) =>
  pick(
    {
      arrivals: tm(m, "today_list.title.arrivals"),
      departures: tm(m, "today_list.title.departures"),
    },
    key,
    fallback,
  );
