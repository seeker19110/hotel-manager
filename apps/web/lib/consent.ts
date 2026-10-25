// Văn bản đồng ý theo mục đích (T-2310, D-119) cho trang công khai (đăng ký, lời mời, đăng nhập người thuê, Bảo mật): chuỗi tĩnh của
// catalog packages/app — CÙNG nguồn với băm bằng chứng `ui_snapshot_hash` — không đọc dữ liệu người dùng (các trang này không phải
// "màn dữ liệu" của UX-STATE-001). Chỉ dùng ở Server Component; client nhận qua prop.
export { type ConsentDisplay, consentDisplays } from "@hm/app";
