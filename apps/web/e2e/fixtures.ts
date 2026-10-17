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
export const PORTAL_TENANT = { email: "an.nguoi.thue@example.test", name: "An (giả)", phone: "0900000011" };
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
