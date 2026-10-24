// Chuỗi người dùng thấy của packages/domain (thông điệp AuthzError/TransitionError ra API, mô tả dòng phiếu, từ vựng đọc số tiền
// bằng chữ, lỗi đọc sao kê…) lấy từ tệp tài nguyên riêng (XC-I18N-001, D-107): `packages/domain/messages/<locale>.json`, khoá →
// `{ message, description }` — cùng định dạng catalog của apps/web và packages/app, nhưng là catalog riêng vì packages/domain không
// phụ thuộc gói nào khác (ADR-0001). Thuần: chỉ import JSON, không I/O. Nguồn là `vi`; `message` theo tập con ICU `{ten}`.
// `scripts/i18n-check.mjs` kiểm catalog này (khoá, mô tả, cú pháp, HTML lạ) và mọi lời gọi `t()` import từ module này.
// CHỈ dùng ở mã chạy trên server: module mà trình duyệt nạp (`format/intl.ts`, qua apps/web/lib/format.ts) không được import nó —
// dùng catalog con `messages/format.vi.json` (D-106); i18n-check chặn module client của apps/web chạm tệp này.
import vi from "../messages/vi.json" with { type: "json" };

export type DomainMessageKey = keyof typeof vi;

/**
 * Thay `{ten}` bằng tham số, MỘT lượt (giá trị chứa `{x}` không bị thay tiếp); tham số thiếu giữ nguyên `{ten}`. Cùng hành vi với
 * `format` của apps/web/lib/i18n-format.ts và packages/app/src/i18n.ts — sao lại thay vì import (ranh giới gói);
 * `scripts/i18n.test.mjs` so các bản trên cùng bộ ca để không lệch.
 */
export function format(message: string, params: Readonly<Record<string, string | number>> = {}): string {
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

/** Chuỗi theo khoá, thay `{ten}` bằng tham số. Khoá không có trong nguồn là lỗi biên dịch (DomainMessageKey). */
export function t(key: DomainMessageKey, params: Readonly<Record<string, string | number>> = {}): string {
  return format(vi[key].message, params);
}
