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
