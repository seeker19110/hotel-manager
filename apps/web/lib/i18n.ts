// Chuỗi người dùng thấy lấy từ tệp tài nguyên (XC-I18N-001, D-073): `apps/web/messages/<locale>.json`, khoá → `{ message, description }`.
// Nguồn là `vi`; `message` theo cú pháp ICU, tham số `{ten}`. `scripts/i18n-check.mjs` kiểm khoá/cú pháp/tham số/HTML (XC-I18N-009);
// `scripts/i18n-literals.mjs` chặn chuỗi viết thẳng mới (ratchet). Chưa cần plural/select nên chỉ thay tham số đơn.
// CHỈ dùng ở server (D-098): module này import cả catalog — client component nhận `m={messagesFor("…")}` và gọi `tm()` của
// lib/i18n-format.ts; phía client chỉ được `import type { Messages }` (test `scripts/i18n.test.mjs` chặn import giá trị).
import vi from "../messages/vi.json" with { type: "json" };
import { format } from "./i18n-format.ts";

export type MessageKey = keyof typeof vi;

/** Phần catalog gồm các khoá bắt đầu bằng một trong các tiền tố `P` (vd `"booking.hold."`), khoá → message. */
export type Messages<P extends string> = {
  readonly [K in MessageKey as K extends `${P}${string}` ? K : never]: string;
};

/** Chuỗi theo khoá, thay `{ten}` bằng tham số. Khoá không có trong nguồn là lỗi biên dịch (MessageKey). */
export function t(key: MessageKey, params: Readonly<Record<string, string | number>> = {}): string {
  return format(vi[key].message, params);
}

/** Như `t` nhưng khoá dựng động (vd `role.${code}`): khoá lạ trả `fallback` thay vì ném lỗi. */
export function tOr(key: string, fallback: string): string {
  return Object.hasOwn(vi, key) ? t(key as MessageKey) : fallback;
}

/**
 * Message (chưa thay tham số) của mọi khoá bắt đầu bằng một trong các tiền tố — truyền xuống client component làm prop `m`
 * (chỉ phần này vào payload RSC, không cả catalog). Tiền tố rỗng/không có khoá nào là lỗi lập trình → ném lỗi (chuỗi lỗi cho dev, không hiện cho người dùng).
 */
export function messagesFor<const P extends readonly [string, ...string[]]>(
  ...prefixes: P
): Messages<P[number]> {
  const out: Record<string, string> = {};
  for (const p of prefixes) {
    const keys = (Object.keys(vi) as MessageKey[]).filter((k) => k.startsWith(p));
    if (p === "" || keys.length === 0) throw new Error(`messagesFor: no message key with prefix "${p}"`);
    for (const k of keys) out[k] = vi[k].message;
  }
  return out as Messages<P[number]>;
}
