// Định dạng hiển thị (chỉ dùng ở Server Component để HTML server/client không lệch nhau).
// Tiền/ngày đi qua Intl ở @hm/domain (XC-I18N-003) — không ghép chuỗi tay.
import { formatDate, formatMonth, formatVnd, formatVndUnitPrice } from "@hm/app/format";

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

export const LEASE_STATUS: Record<string, string> = {
  draft: "Nháp",
  pending_signature: "Chờ ký",
  signed_awaiting_handover: "Đã ký — chờ bàn giao",
  active: "Đang thuê",
  notice_given: "Đã báo trả",
  settling: "Đang thanh lý",
  closed: "Đã đóng",
  cancelled: "Đã huỷ",
};

export const PERIOD_STATUS: Record<string, string> = {
  draft: "Nháp",
  reviewing: "Chờ phát hành",
  issued: "Đã phát hành",
  locked: "Đã khoá",
};

export const METER_LABEL: Record<string, string> = { electric: "Điện", water: "Nước" };

// ——— Khách sạn + vận hành (T-223) ———
/** Cộng `n` ngày vào `YYYY-MM-DD` (UTC, không lệch múi giờ). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WEEKDAY = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"] as const;
/** `YYYY-MM-DD` → "Thứ ba 21/10/2026". */
export const weekdayDay = (d: string) => `${WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${day(d)}`;

/** Múi giờ mặc định của cơ sở (`properties.timezone` mặc định — DOMAIN-MODEL INV-G2). */
export const DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh";

/**
 * Thời điểm theo múi giờ CỦA CƠ SỞ: "14:05 16/10/2026". Múi giờ bắt buộc (AUD-XFEAT-003): trước đây mặc định ngầm VN nên
 * cơ sở đặt múi giờ khác hiển thị sai giờ — typecheck nay bắt mọi chỗ quên truyền.
 */
export const dateTime = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone }).format(d);

/** Múi giờ chung của các cơ sở trong phạm vi (thông báo cấp tổ chức); các cơ sở khác múi giờ nhau ⇒ mặc định. */
export function commonTimeZone(properties: readonly { timezone: string }[]): string {
  const zones = new Set(properties.map((p) => p.timezone));
  return zones.size === 1 ? ([...zones][0] as string) : DEFAULT_TIME_ZONE;
}

/** Số đo (chỉ công tơ…) theo kiểu Việt Nam: 1.350 — dùng thay `new Intl.NumberFormat` rải rác (AUD-XFEAT-005). */
export const decimal = (n: number) => new Intl.NumberFormat("vi-VN").format(n);

export const BOOKING_STATUS: Record<string, string> = {
  draft: "Nháp",
  held: "Đang giữ phòng",
  confirmed: "Đã xác nhận",
  in_house: "Đang ở",
  checked_out: "Đã trả phòng",
  cancelled: "Đã huỷ",
  no_show: "Không đến",
  expired: "Hết hạn giữ",
};

export const HK_STATUS: Record<string, string> = {
  dirty: "Bẩn",
  assigned: "Đã giao dọn",
  cleaning: "Đang dọn",
  clean: "Sạch — chờ kiểm",
  inspected: "Đã kiểm — sẵn sàng",
};

export const TASK_STATUS: Record<string, string> = {
  open: "Chưa nhận",
  assigned: "Đã nhận",
  in_progress: "Đang làm",
  done: "Đã xong — chờ nghiệm thu",
  verified: "Đã nghiệm thu",
  cancelled: "Đã huỷ",
};
export const TASK_KIND: Record<string, string> = { cleaning: "Dọn phòng", inspection: "Kiểm tra phòng" };
export const PRIORITY: Record<string, string> = { normal: "Thường", high: "Ưu tiên", urgent: "Khẩn" };

export const WORK_ORDER_STATUS: Record<string, string> = {
  open: "Mới báo",
  assigned: "Đã giao",
  in_progress: "Đang sửa",
  done: "Đã sửa — chờ nghiệm thu",
  verified: "Đã nghiệm thu",
  cancelled: "Đã huỷ",
};
export const SEVERITY: Record<string, string> = {
  low: "Thấp",
  medium: "Trung bình",
  high: "Cao",
  critical: "Nghiêm trọng",
};

export const NOTICE_STATUS: Record<string, string> = {
  pending: "Chưa xuất",
  exported: "Đã xuất — chưa nộp",
  submitted: "Đã nộp",
};

export const CHARGE_KIND: Record<string, string> = {
  room: "Tiền phòng",
  service: "Dịch vụ",
  fee: "Phụ thu",
  discount: "Giảm giá",
};
export const PAYMENT_METHOD: Record<string, string> = { cash: "Tiền mặt", bank_transfer: "Chuyển khoản" };
export const PAYMENT_STATUS: Record<string, string> = {
  pending: "Chờ xác nhận",
  confirmed: "Đã xác nhận",
  rejected: "Từ chối",
  reversed: "Đã đảo",
};
export const STAY_STATUS: Record<string, string> = {
  expected: "Chờ nhận phòng",
  in_house: "Đang ở",
  checked_out: "Đã trả phòng",
  cancelled: "Đã huỷ",
  no_show: "Không đến",
};

/** Tên đầy đủ của thẻ "Hôm nay" (liên kết đọc được riêng lẻ — SPEC-audit-reporting §5): "Khách đến hôm nay: 3". */
export const CARD_LABEL: Record<string, string> = {
  arrivals: "Khách đến hôm nay",
  departures: "Khách đi hôm nay",
};
