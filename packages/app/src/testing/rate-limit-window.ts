// Chỉ dùng cho test DB: giữ chuỗi gọi now() trong cùng cửa sổ cố định, không sửa đồng hồ hoặc bộ đếm sản phẩm.
import { MS_PER_MINUTE, secondsToMs } from "@hm/domain";

export const RATE_LIMIT_WINDOW_MS = MS_PER_MINUTE;
const EDGE_MARGIN_MS = secondsToMs(5);

/** Test gọi nhiều request thật trong < 5 s: sát cuối phút thì chờ qua ranh giới trước khi bắt đầu. */
export function msUntilSafeWindow(nowMs: number): number {
  const left = RATE_LIMIT_WINDOW_MS - (nowMs % RATE_LIMIT_WINDOW_MS);
  return left < EDGE_MARGIN_MS ? left + 50 : 0;
}

export async function waitForSafeRateLimitWindow(): Promise<void> {
  const wait = msUntilSafeWindow(Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
