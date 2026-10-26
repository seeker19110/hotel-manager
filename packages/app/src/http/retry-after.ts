// `Retry-After` cho MỌI phản hồi 429 của app (T-401, BE-REL-006; RFC 6585 §4, RFC 9110 §10.2.3). Một nơi duy nhất để rào
// `retry-after.test.ts` kiểm: không có 429 nào ra khỏi app mà thiếu header.

/** Khi nơi tạo 429 không biết chính xác thời điểm hết giới hạn (cửa sổ cố định tối đa 1 phút): đợi trọn một phút. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 86_400;

/** Số giây hợp lệ cho `Retry-After` (số nguyên ≥ 1); không hợp lệ ⇒ mặc định. */
export function retryAfterSeconds(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 1
    ? Math.ceil(Math.min(n, MAX_RETRY_AFTER_SECONDS))
    : DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * Bảo đảm phản hồi 429 có `Retry-After` (số giây). Phản hồi khác trả nguyên. Dùng cho đường không do app dựng (Better Auth
 * đặt `X-Retry-After` — chuyển sang tên chuẩn), phản hồi đã có `Retry-After` hợp lệ (≤ 1 ngày) giữ nguyên.
 * `fallbackSeconds` là toàn bộ cửa sổ giới hạn của đường dẫn: header riêng của thư viện vượt cửa sổ hoặc không hợp lệ
 * phải trở về cửa sổ đó (AUD-SEC-006: lastRequest int8 dạng chuỗi có thể bị nối chuỗi khi tính số giây).
 */
export function withRetryAfter(res: Response, fallbackSeconds = DEFAULT_RETRY_AFTER_SECONDS): Response {
  if (res.status !== 429) return res;
  const has = res.headers.get("retry-after");
  const headerSeconds = Number(has);
  if (
    has !== null &&
    Number.isFinite(headerSeconds) &&
    headerSeconds >= 1 &&
    headerSeconds <= MAX_RETRY_AFTER_SECONDS
  )
    return res;
  const headers = new Headers(res.headers);
  const fallback = retryAfterSeconds(fallbackSeconds);
  const librarySeconds = Number(res.headers.get("x-retry-after"));
  const seconds =
    Number.isFinite(librarySeconds) && librarySeconds >= 1 && librarySeconds <= fallback
      ? Math.ceil(librarySeconds)
      : fallback;
  headers.set("retry-after", String(seconds));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
