// Chuỗi người dùng thấy của packages/app (thông điệp lỗi API, …) lấy từ tệp tài nguyên riêng (XC-I18N-001, D-104):
// `packages/app/messages/<locale>.json`, khoá → `{ message, description }` — cùng định dạng với apps/web/messages nhưng là catalog
// riêng vì packages/app không được phụ thuộc apps/web (ADR-0001). Nguồn là `vi`; `message` theo tập con ICU `{ten}`.
// `scripts/i18n-check.mjs` kiểm catalog này như catalog web (khoá, mô tả, cú pháp, HTML lạ) và mọi lời gọi `t()` import
// từ module này (khoá có trong catalog, đúng tập tham số). Mã lỗi/status/cấu trúc problem+json KHÔNG đi qua đây — chỉ câu chữ.
// CHỈ dùng ở server: module import cả catalog; module mà trình duyệt nạp (`http/command-inputs.ts`, `http/security.ts`, …) không
// được import nó (i18n-check chặn module client của apps/web chạm tệp này qua `@hm/app/…`).
import vi from "../messages/vi.json" with { type: "json" };

export type AppMessageKey = keyof typeof vi;

/**
 * Thay `{ten}` bằng tham số, MỘT lượt (giá trị chứa `{x}` không bị thay tiếp); tham số thiếu giữ nguyên `{ten}`. Cùng hành vi với
 * `format` của apps/web/lib/i18n-format.ts — sao lại thay vì import (ranh giới gói); `scripts/i18n.test.mjs` so hai bản trên
 * cùng bộ ca để không lệch.
 */
export function format(message: string, params: Readonly<Record<string, string | number>> = {}): string {
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

/** Chuỗi theo khoá, thay `{ten}` bằng tham số. Khoá không có trong nguồn là lỗi biên dịch (AppMessageKey). */
export function t(key: AppMessageKey, params: Readonly<Record<string, string | number>> = {}): string {
  return format(vi[key].message, params);
}
