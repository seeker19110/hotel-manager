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

// ── Dữ liệu cá nhân và bảng còn lại (T-2308; STD-PRIV-005, D-116) — job `privacy.retention` (`personal.ts`), hàm của migration 0066.
// TRẠNG THÁI: ĐỀ XUẤT của kỹ thuật, CHỜ DPIA/pháp lý duyệt — đổi số ở đây (MỘT nguồn), bảng RET ở retention-policy.md đổi theo.

/** Thông báo trong ứng dụng: xoá 180 ngày sau lúc tạo (khi không còn lần gửi nào bám vào). */
export const NOTIFICATION_RETENTION_DAYS = 180;
/** Nhịp worker (`worker_heartbeats`): xoá tên không cập nhật 30 ngày (worker đã bỏ/đổi tên). */
export const WORKER_HEARTBEAT_STALE_DAYS = 30;
/** Phiên đăng nhập Better Auth (`auth.session`): xoá 30 ngày sau `expiresAt`. */
export const AUTH_SESSION_GRACE_DAYS = 30;
/** Mã xác minh Better Auth (`auth.verification`): xoá 1 ngày sau `expiresAt`. */
export const AUTH_VERIFICATION_GRACE_DAYS = 1;
/** Link khách (`guest_access_links`): xoá 90 ngày sau khi hết hạn hoặc bị thu hồi (mốc sớm hơn). */
export const GUEST_LINK_GRACE_DAYS = 90;
/**
 * Inbox ngân hàng thô (chứng từ tiền): giữ 10 năm tính từ hết năm chứa lúc nhận (Luật Kế toán 88/2015 Đ.41, chưa xác minh bản gốc — cách hiểu chặt;
 * năm tài chính khác năm dương lịch: chưa xác minh), rồi chỉ làm rỗng `raw` — không xoá dòng (FK RESTRICT từ sổ tiền).
 * Hàm CSDL có sàn 10 năm: số nhỏ hơn ở đây không có tác dụng.
 */
export const INBOX_RAW_RETENTION_YEARS = 10;
/** Giấy tờ nhận dạng: ẩn danh 12 tháng sau khi quan hệ lưu trú/thuê CUỐI của người đó kết thúc. */
export const IDENTITY_DOCUMENT_RETENTION_MONTHS = 12;
/** Hồ sơ người (`persons`): ẩn danh 10 năm sau quan hệ tiền/thuê/lưu trú cuối (giữ dòng làm tombstone cho sổ tiền). */
export const PERSON_RETENTION_YEARS = 10;
