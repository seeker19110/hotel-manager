// Quyết định dùng lại cookie phiên đã lưu từ phản hồi của `/api/auth/get-session` (thuần, test ở scripts/e2e-guards.test.mjs).
// 429 (giới hạn tần suất của Better Auth, mặc định 100/phút/IP — vòng lặp E2E dễ chạm) KHÔNG nói gì về phiên: tin bộ nhớ đệm
// (server chết ⇒ tệp phiên đã bị xoá khi tắt). Chỉ khi server trả 200 mà không có phiên (hoặc lỗi khác) mới đăng nhập lại.

/** `true` = giữ cookie đã lưu; `false` = đăng nhập lại. `body` là JSON đã parse của phản hồi 2xx. */
export function keepSavedSession(status: number, body: unknown): boolean {
  if (status === 429) return true;
  if (status < 200 || status >= 300) return false;
  return body !== null && body !== undefined;
}
