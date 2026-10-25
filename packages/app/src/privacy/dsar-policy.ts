// Hạn trả lời yêu cầu của chủ thể dữ liệu (DSAR) theo VÙNG (CMP-INTL-007, CMP-VN-007; D-120). Cấu hình trong repo — đổi số ở đây, có
// review; không biến môi trường. Số GIỜ (không "tháng"): một tháng lịch có thể 28–31 ngày, lấy 30 ngày (≤ 1 tháng) là cách hiểu chặt.
//
// Nguồn (đọc 2026-10-25, BLUEPRINT CMP-INTL-007/CMP-VN-007):
//  - EU (GDPR Art. 12(3)) / UK (UK GDPR Art. 12(3)): 1 tháng ⇒ 30 ngày.
//  - CA (CCPA §1798.130): 45 ngày.
//  - SG (PDPA s.21) / TH (PDPA): 30 ngày.
//  - VN (Luật 91/2025/QH15, NĐ 356/2025/NĐ-CP): (chưa xác minh) số ngày theo từng quyền — BLUEPRINT ghi "thường 72 giờ cho xoá/rút đồng
//    ý"; D-120 chọn mặc định CHẶT: 72 giờ cho MỌI loại (truy cập/xoá/hạn chế) tới khi pháp lý chốt số điều.
// Vùng không biết/không khai ⇒ `DEFAULT` = vùng CHẶT NHẤT theo từng loại (nhỏ nhất trong bảng) — ứng dụng chưa lưu vùng của người dùng
// nên mọi yêu cầu hiện dùng DEFAULT; client KHÔNG được chọn vùng (chọn vùng dễ dãi hơn sẽ kéo dài hạn).
import { HOURS_PER_DAY, hoursToMs } from "@hm/domain";

export const DSAR_KINDS = ["access", "delete", "restrict"] as const;
export type DsarKind = (typeof DSAR_KINDS)[number];

const DAY_H = HOURS_PER_DAY;

/** Hạn (giờ) theo vùng + loại yêu cầu. */
export const DSAR_HOURS: Readonly<Record<string, Readonly<Record<DsarKind, number>>>> = {
  VN: { access: 72, delete: 72, restrict: 72 }, // (chưa xác minh) NĐ 356/2025 — mặc định chặt
  EU: { access: 30 * DAY_H, delete: 30 * DAY_H, restrict: 30 * DAY_H },
  UK: { access: 30 * DAY_H, delete: 30 * DAY_H, restrict: 30 * DAY_H },
  CA: { access: 45 * DAY_H, delete: 45 * DAY_H, restrict: 45 * DAY_H },
  SG: { access: 30 * DAY_H, delete: 30 * DAY_H, restrict: 30 * DAY_H },
  TH: { access: 30 * DAY_H, delete: 30 * DAY_H, restrict: 30 * DAY_H },
};

/** Vùng mặc định = chặt nhất theo từng loại. */
export const DSAR_DEFAULT_REGION = "DEFAULT";

export function dsarHours(kind: DsarKind, region: string = DSAR_DEFAULT_REGION): number {
  const row = DSAR_HOURS[region];
  if (row) return row[kind];
  return Math.min(...Object.values(DSAR_HOURS).map((r) => r[kind]));
}

/** `dsar_days` của BLUEPRINT (CMP-INTL-007): số ngày (có thể lẻ — 72 giờ = 3). */
export function dsarDays(kind: DsarKind, region: string = DSAR_DEFAULT_REGION): number {
  return dsarHours(kind, region) / DAY_H;
}

/** Chuẩn hoá vùng: mã có trong bảng ⇒ giữ; còn lại (rỗng, lạ, chữ thường) ⇒ DEFAULT. */
export function normalizeDsarRegion(region: string | null | undefined): string {
  const r = (region ?? "").trim().toUpperCase();
  return Object.hasOwn(DSAR_HOURS, r) ? r : DSAR_DEFAULT_REGION;
}

/** Hạn trả lời = lúc nhận + hạn theo vùng/loại. */
export function dsarDueAt(kind: DsarKind, receivedAt: Date, region: string = DSAR_DEFAULT_REGION): Date {
  return new Date(receivedAt.getTime() + hoursToMs(dsarHours(kind, normalizeDsarRegion(region))));
}
