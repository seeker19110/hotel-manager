// Định dạng chuỗi dịch, KHÔNG import tệp tài nguyên (D-098): client component nhận đúng phần catalog cần dùng qua prop
// `m: Messages<"tiền.tố.">` (server dựng bằng `messagesFor` của lib/i18n.ts) rồi gọi `tm(m, "khoá", {…})` — catalog không bị
// nhân bản vào mỗi chunk JS. `scripts/i18n-check.mjs` kiểm `tm()` như `t()` (khoá viết thẳng có trong nguồn, đúng tập tham số).

/** Thay `{ten}` bằng tham số (một lượt); tham số thiếu giữ nguyên `{ten}`. Dùng chung cho `t()` (server) và `tm()` (client). */
export function format(message: string, params: Readonly<Record<string, string | number>> = {}): string {
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

/** Chuỗi theo khoá từ object message `m` đã truyền xuống; khoá không có trong `m` là lỗi biên dịch. */
export function tm<K extends string>(
  m: Readonly<Record<K, string>>,
  key: NoInfer<K>,
  params: Readonly<Record<string, string | number>> = {},
): string {
  return format(m[key], params);
}
