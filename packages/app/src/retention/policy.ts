// Chính sách hạn giữ bảng sự kiện (PLAN đợt 6 T-505; XC-GREEN-007). MỘT nguồn số liệu: job dọn (`events.ts`) đọc từ đây;
// bảng tài liệu `docs/ops/retention-policy.md` được test (`scripts/process-docs.test.mjs`) giữ khớp với các hằng này.
// TRẠNG THÁI: ĐỀ XUẤT của kỹ thuật — hạn giữ dữ liệu cá nhân chốt cùng DPIA/pháp lý (docs/privacy/data-map.yaml).

/** Outbox đã phát: giữ 90 ngày để điều tra/đối chiếu, dài hơn mọi cửa sổ `dedupe_key` đang dùng (nhắc hợp đồng ≤ 30 ngày). */
export const OUTBOX_PUBLISHED_RETENTION_DAYS = 90;
/** Lần gửi thông báo đã xong (`sent`, `suppressed`): giữ 90 ngày. */
export const DELIVERY_DONE_RETENTION_DAYS = 90;
/** Lần gửi `failed`/`dead` (chờ người thử lại): giữ lâu hơn để còn xử lý — 180 ngày không động tới. */
export const DELIVERY_FAILED_RETENTION_DAYS = 180;
/** Khoá idempotency: xoá ngay khi quá `expires_at` (mặc định 7 ngày sau lúc tạo, migration 0003) — không thêm thời gian ân hạn. */
export const IDEMPOTENCY_GRACE_DAYS = 0;
/** Kích thước một lô xoá (hàm CSDL kẹp 1…5000). */
export const PURGE_BATCH = 1000;
/** Một lượt job xoá tối đa chừng này lô mỗi bảng rồi nhường (tồn đọng lớn được dọn dần qua các lượt, không độc chiếm). */
export const PURGE_MAX_ROUNDS = 20;

// ── Hạn lưu dữ liệu cá nhân/vận hành còn lại (PLAN T-2308; STD-PRIV-005; D-116 — mặc định chặt, CHỜ pháp lý chốt) ──
// Job `privacy.retention` (`personal.ts`, migration 0066). Đổi hạn = đổi một dòng ở đây (bảng tài liệu được test giữ khớp).
/** Thông báo trong app: xoá sau 180 ngày kể từ lúc tạo (khi không còn lần gửi nào chờ). */
export const NOTIFICATION_RETENTION_DAYS = 180;
/** Nhịp worker không cập nhật 30 ngày (tiến trình đã bỏ/đổi tên) thì xoá. */
export const WORKER_HEARTBEAT_RETENTION_DAYS = 30;
/** Phiên đăng nhập (`auth."session"`): xoá 30 ngày sau `expiresAt`. */
export const AUTH_SESSION_RETENTION_DAYS = 30;
/** Mã xác minh/OTP (`auth."verification"`): xoá 1 ngày sau `expiresAt`. */
export const AUTH_VERIFICATION_RETENTION_DAYS = 1;
/** Liên kết khách: xoá 90 ngày sau lúc hết hạn hoặc bị thu hồi (mốc sớm hơn). */
export const GUEST_LINK_RETENTION_DAYS = 90;
/** Giấy tờ nhận dạng: ẩn danh 12 tháng sau khi kết thúc lưu trú/thuê cuối của người đó (tháng lịch, không phải 365 ngày). */
export const IDENTITY_DOCUMENT_RETENTION_MONTHS = 12;
/** Hồ sơ người (`persons`): ẩn danh 10 năm (120 tháng lịch) sau quan hệ tiền/thuê/lưu trú cuối — giữ id để đối chiếu chứng từ. */
export const PERSON_RETENTION_MONTHS = 120;
/**
 * `inbox` (chứng từ ngân hàng thô): giữ 10 năm. CHƯA có job — bảng chưa có hàng nào tới hạn trước 10 năm kể từ khi chạy thật;
 * viết job (xoá/ẩn danh theo `received_at`) trước mốc đó (docs/ops/retention-policy.md).
 */
export const INBOX_RETENTION_MONTHS = 120;
