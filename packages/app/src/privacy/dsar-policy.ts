// Hạn trả lời yêu cầu quyền chủ thể (DSAR) theo vùng — MỘT nơi (PLAN T-2311; CMP-VN-007, CMP-INTL-007; D-123). Đổi hạn = đổi
// bảng dưới (CHECK `region` của `dsar_requests` — migration 0069 — phải khớp danh sách vùng; test DB kiểm).
// Nguồn (ghi ngày kiểm 2026-10-25; KHÔNG phải tư vấn pháp lý, chờ pháp lý chốt):
// - VN: xoá 3 ngày, truy cập 10 ngày, hạn chế 3 ngày — (chưa xác minh, nguồn thứ cấp): lấy cách hiểu CHẶT nhất trong các nguồn thứ
//   cấp hiện có về Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 và văn bản hướng dẫn; chưa đối chiếu bản gốc.
// - EU (GDPR Art. 12(3)) và UK (UK GDPR Art. 12(3)): 1 tháng — tính 30 ngày (chặt hơn tháng 31 ngày).
// - CA (CCPA/CPRA, Cal. Civ. Code §1798.130): 45 ngày.
// - SG (PDPA — đề xuất "càng sớm càng hợp lý", thực hành 30 ngày) và TH (PDPA Thái Lan s.30 — 30 ngày): 30 ngày.
// Tất cả là NGÀY LỊCH tính từ lúc nhận (`requested_at` do CSDL đặt); hạn = mốc tuyệt đối `due_at` (UTC).
import { MS_PER_DAY } from "@hm/domain";

export const DSAR_TYPES = ["access", "delete", "restrict"] as const;
export type DsarType = (typeof DSAR_TYPES)[number];

export const DSAR_REGIONS = ["VN", "EU", "UK", "CA", "SG", "TH"] as const;
export type DsarRegion = (typeof DSAR_REGIONS)[number];

/** Số ngày lịch tối đa để hoàn tất yêu cầu, theo vùng và loại. */
export const DSAR_DAYS: Readonly<Record<DsarRegion, Readonly<Record<DsarType, number>>>> = {
  VN: { access: 10, delete: 3, restrict: 3 },
  EU: { access: 30, delete: 30, restrict: 30 },
  UK: { access: 30, delete: 30, restrict: 30 },
  CA: { access: 45, delete: 45, restrict: 45 },
  SG: { access: 30, delete: 30, restrict: 30 },
  TH: { access: 30, delete: 30, restrict: 30 },
};

/**
 * Vùng áp dụng khi tài khoản chưa có thông tin vùng: dịch vụ vận hành tại VN (PROJECT §1). Tài khoản/tổ chức chưa lưu quốc gia —
 * khi có, chọn vùng theo đó (câu hỏi mở T-2311).
 */
export const DSAR_DEFAULT_REGION: DsarRegion = "VN";

/** Phiên được tạo trong chừng này giây coi như vừa xác thực lại (cùng ngưỡng xuất dữ liệu — SPEC Q-06). */
export const DSAR_REAUTH_MAX_AGE_SECONDS = 300;
/** Gói dữ liệu truy cập tải được trong (giờ) sau khi xong; quá hạn worker xoá object. CSDL chặn trên 7 ngày. */
export const DSAR_ACCESS_TTL_HOURS = 72;
/** Yêu cầu `processing` quá chừng này phút coi như worker chết giữa chừng — lượt sau nhận lại. */
export const DSAR_STALE_MINUTES = 15;
/** Tối đa số lần tạo yêu cầu mỗi giờ mỗi tài khoản (chống lạm dụng; gửi lại yêu cầu đang mở không tính thêm hàng). */
export const DSAR_REQUESTS_PER_HOUR = 10;
/** Tối đa số lần nhập lại mật khẩu sai trong 15 phút mỗi tài khoản trước khi trả 429. */
export const DSAR_PASSWORD_ATTEMPTS_PER_15_MIN = 5;

export const isDsarRegion = (v: string): v is DsarRegion => (DSAR_REGIONS as readonly string[]).includes(v);

/** Số ngày lịch của (vùng, loại). */
export function dsarDays(region: DsarRegion, type: DsarType): number {
  return DSAR_DAYS[region][type];
}

/** Hạn tuyệt đối cho yêu cầu nhận lúc `requestedAt` (cộng đúng N × 24 giờ — UTC, không phụ thuộc múi giờ máy). */
export function dsarDueAt(requestedAt: Date, region: DsarRegion, type: DsarType): Date {
  return new Date(requestedAt.getTime() + dsarDays(region, type) * MS_PER_DAY);
}
