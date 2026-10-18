import { tmpdir } from "node:os";
import { join } from "node:path";

// Dữ liệu giả dùng chung giữa seed (e2e/server.ts) và test — người/tổ chức giả, không dữ liệu thật (kế hoạch §12).
export const SMOKE_USER = {
  email: "buong.phong@example.test",
  // Mật khẩu giả của DB E2E tạm (ghép lúc chạy để máy quét bí mật không nhầm là khoá thật).
  password: ["e2e", "mat", "khau", "gia"].join("-"),
  name: "Buồng phòng (giả)",
};
export const ORG_MAIN = "Khách sạn Hoa Sen (giả)";
export const ORG_OTHER = "Nhà trọ Cúc (giả)";
/** Cơ sở được giao cho SMOKE_USER ở ORG_MAIN và phòng của nó; cơ sở 2 không được giao. */
export const MAIN_PROPERTY = `${ORG_MAIN} — CS1`;
export const MAIN_ROOMS = ["101", "102", "103"];
export const OTHER_PROPERTY = `${ORG_MAIN} — CS2`;
export const OTHER_ROOMS = ["201", "202"];

/** Vòng tháng nhà trọ (T-117): chủ trọ giả có TOTP, một phòng có hợp đồng chờ ký, công tơ điện 1.250 / nước 30. */
export const RENTAL_OWNER = {
  email: "chu.tro@example.test",
  password: ["e2e", "chu", "tro", "gia"].join("-"),
  name: "Chủ trọ (giả)",
};
export const ORG_RENTAL = "Nhà trọ Mai (giả)";
export const RENTAL_PROPERTY = `${ORG_RENTAL} — CS1`;
export const RENTAL_UNIT = "101";
export const RENTAL_TENANT = "Người thuê A (giả)";

/** Portal người thuê (T-219): tổ chức giả có người thuê An (OTP email), Bình (để thử truy cập chéo), lượt ở của khách. */
export const ORG_PORTAL = "Nhà trọ Hoa Sen (giả)";
export const ORG_PORTAL_2 = "Nhà trọ Lan (giả)";
export const PORTAL_TENANT = { email: "an.nguoi.thue@example.test", name: "An (giả)", phone: "0100000011" };
export const PORTAL_OTHER_TENANT = { email: "binh.nguoi.thue@example.test", name: "Bình (giả)" };
export const PORTAL_UNIT = "P101";
export const PORTAL_BANK_ACCOUNT = "0123456789";
/** Mã tham chiếu cố định của phiếu An (hiện ở nội dung chuyển khoản). */
export const PORTAL_MEMO = "HME2EAN001";
/** Khách lẻ: SĐT người đặt kết thúc bằng 5678; token giả (ghép lúc chạy để máy quét bí mật không nhầm là khoá thật). */
export const GUEST_STAY_ID = "5a5a5a5a-0000-4000-8000-0000000000a1";
export const GUEST_PHONE_LAST4 = "5678";
export const GUEST_TOKEN = ["e2e", "khach", "hop", "le"].join("-").padEnd(43, "x");
export const GUEST_TOKEN_EXPIRED = ["e2e", "khach", "het", "han"].join("-").padEnd(43, "y");
export const GUEST_TOKEN_REVOKED = ["e2e", "khach", "thu", "hoi"].join("-").padEnd(43, "z");
/** Tên file hộp thư giả (SMTP_URL fake://file) — nơi server ghi mã OTP cho test đọc. */
export const outboxFile = (port: number) => join(tmpdir(), `hm-e2e-${port}-outbox.jsonl`);
/** Nơi seed ghi liên kết huỷ đăng ký ký số (cần khoá của server) cho test đọc. */
export const unsubFile = (port: number) => join(tmpdir(), `hm-e2e-${port}-unsub.txt`);

/** Khách sạn (T-223): chủ có TOTP, buồng phòng đăng nhập mật khẩu; phòng 101–103 đã dọn + kiểm, giá 600.000/700.000 đ. */
export const ORG_HOTEL = "Khách sạn Biển (giả)";
export const HOTEL_OWNER = {
  email: "chu.khach.san@example.test",
  password: ["e2e", "chu", "khach", "san"].join("-"),
  name: "Chủ khách sạn (giả)",
};
export const HOTEL_HK = {
  email: "buong.phong.ks@example.test",
  password: ["e2e", "buong", "phong", "ks"].join("-"),
  name: "Buồng phòng KS (giả)",
};
export const HOTEL_ROOMS = ["101", "102", "103"];
export const HOTEL_WEEKDAY_PRICE = 600_000;
export const HOTEL_WEEKEND_PRICE = 700_000;
/** Tiêu đề thông báo mẫu seed sẵn cho chủ khách sạn (chuông có số chưa đọc ngay khi đăng nhập). */
export const HOTEL_NOTIFICATION_TITLE = "Phiếu sự cố mẫu đã được giao";

/** JPEG tối thiểu hợp lệ (dùng chung E2E tải ảnh: portal, sự cố khách sạn). */
export const JPEG = Buffer.from([
  0xff,
  0xd8,
  0xff,
  0xe0,
  0,
  16,
  ...Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"),
  0xff,
  0xda,
  0,
  8,
  1,
  1,
  0,
  0,
  0x3f,
  0,
  0x12,
  0x34,
  0xff,
  0xd9,
]);

/** Lời mời nhân viên (T-605): token dẫn xuất từ khoá của server nên seed ghi vào file cho test đọc (không đoán được từ ngoài). */
export const INVITEE = {
  email: "nhan.vien.moi@example.test",
  name: "Nhân viên mới (giả)",
  password: ["e2e", "nhan", "vien", "moi"].join("-"),
};
export const INVITEE_EXPIRED_EMAIL = "het.han@example.test";
export const INVITEE_OTHER_EMAIL = "danh.cho.nguoi.khac@example.test";
/** File JSON `{ valid, expired, other }` — token lời mời của ORG_HOTEL. */
export const inviteTokensFile = (port: number) => join(tmpdir(), `hm-e2e-${port}-invites.json`);

/** Nhân viên buồng phòng ORG_HOTEL dùng làm ĐÍCH của màn Thành viên (đổi vai/cơ sở, thu hồi phiên) — không dùng cho spec khác. */
export const STAFF_TARGET = {
  email: "nv.dich@example.test",
  name: "Nhân viên đích (giả)",
  password: ["e2e", "nv", "dich", "gia"].join("-"),
};

/**
 * Cổng của server mà project đang chạy: mỗi project (mobile, desktop) có server + CSDL seed riêng (playwright.config.ts) vì các
 * luồng E2E ghi dữ liệu một lần (đăng ký, nhận lời mời, thu tiền…) — tệp tạm của seed khoá theo cổng này.
 */
export function portOf(baseURL: string | undefined): number {
  const port = Number(new URL(baseURL ?? "http://invalid.test").port);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`baseURL không có cổng: ${String(baseURL)}`);
  return port;
}
