// Định dạng hiển thị (chỉ dùng ở Server Component để HTML server/client không lệch nhau).
export const vnd = (n: number) => `${new Intl.NumberFormat("vi-VN").format(n)} đ`;

/** `YYYY-MM-DD` → `dd/mm/yyyy`. */
export const day = (d: string | null | undefined) =>
  d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—";

/** `YYYY-MM-DD` → `mm/yyyy` (kỳ thu). */
export const month = (d: string) => `${d.slice(5, 7)}/${d.slice(0, 4)}`;

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
