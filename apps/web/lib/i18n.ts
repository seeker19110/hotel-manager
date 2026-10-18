// Chuỗi người dùng thấy lấy từ tệp tài nguyên (XC-I18N-001, D-073): `apps/web/messages/<locale>.json`, khoá → `{ message, description }`.
// Nguồn là `vi`; `message` theo cú pháp ICU, tham số `{ten}`. `scripts/i18n-check.mjs` kiểm khoá/cú pháp/tham số/HTML (XC-I18N-009);
// `scripts/i18n-literals.mjs` chặn chuỗi viết thẳng mới (ratchet). Chưa cần plural/select nên chỉ thay tham số đơn.
import vi from "../messages/vi.json" with { type: "json" };

export type MessageKey = keyof typeof vi;

/** Chuỗi theo khoá, thay `{ten}` bằng tham số. Khoá không có trong nguồn là lỗi biên dịch (MessageKey). */
export function t(key: MessageKey, params: Readonly<Record<string, string | number>> = {}): string {
  return vi[key].message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

/** Như `t` nhưng khoá dựng động (vd `role.${code}`): khoá lạ trả `fallback` thay vì ném lỗi. */
export function tOr(key: string, fallback: string): string {
  return Object.hasOwn(vi, key) ? t(key as MessageKey) : fallback;
}
