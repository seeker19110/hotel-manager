// `fetch` phía trình duyệt LUÔN có hạn (T-402; BASE-ERR-004, ARC-RES-009): mạng treo không được làm nút "đang gửi" mãi.
// Mọi lời gọi trong `components/` và `app/` đi qua `timedFetch` (rào `fetch-timeout.test.ts` quét mã nguồn). Hết hạn ⇒ promise bị
// từ chối bằng `TimeoutError` — nơi gọi xử lý như mất mạng (use-command tra lại kết quả theo Idempotency-Key, không gửi lại mù).

import { minutesToMs } from "@hm/app/units";

/** Hạn mặc định cho một lời gọi API thường (ms): đủ cho mạng di động chậm, ngắn hơn hạn chót của server. */
export const FETCH_TIMEOUT_MS = 15_000;
/** Hạn cho tải ảnh/file lên (ms): thân yêu cầu lớn, mạng di động. */
export const UPLOAD_TIMEOUT_MS = minutesToMs(1);

/** `fetch` có `AbortSignal.timeout`; nếu nơi gọi cũng truyền `signal` thì huỷ khi MỘT trong hai kích hoạt. */
export function timedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}
