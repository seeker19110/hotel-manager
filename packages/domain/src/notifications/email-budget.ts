// Ngưỡng ngân sách email theo ngày/tổ chức (OPS-COST-004; PLAN đợt 8 T-709). Hằng có tên trong mã (không biến môi trường) — đổi qua
// PR có review. Đặt ở domain (thuần) để cả `notifications` (bên gửi) lẫn `observability` (tầng nền, đọc metric) dùng chung mà không
// import chéo tầng. Cách dùng/đếm: packages/app/src/notifications/budget.ts, migration 0063.

/**
 * Số lượt gọi nhà cung cấp email tối đa mỗi tổ chức mỗi ngày UTC. Một tổ chức nhỏ (≤ 100 phòng) phát hành kỳ thu + nhắc nợ + lời mời
 * dùng vài trăm thư/ngày; 1.000 là trần chống chạy hoang (vòng lặp lỗi, tổ chức bị lạm dụng), không phải hạn mức thương mại.
 */
export const EMAIL_DAILY_BUDGET_PER_ORG = 1000;
/** % ngân sách bắt đầu cảnh báo (log + metric, một lần/ngày/tổ chức). */
export const EMAIL_BUDGET_WARN_PCT = 80;
/** % ngân sách bắt đầu bóp: chỉ loại bắt buộc/giao dịch, hoãn loại còn lại. */
export const EMAIL_BUDGET_THROTTLE_PCT = 90;
