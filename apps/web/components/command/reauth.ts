// Cầu nối giữa `useCommand` và hộp đăng nhập lại (SPEC-pwa S-013): lệnh gặp 401 UNAUTHENTICATED gọi `requestReauth()`; hộp thoại
// toàn cục (ReauthDialog trong PwaShell) đăng ký handler. Trả true = đã đăng nhập lại (gửi lại cùng command_id), false = bỏ qua.
export const UNAUTHENTICATED_TEXT = "Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.";

type Handler = () => Promise<boolean>;
let handler: Handler | null = null;

export function setReauthHandler(h: Handler | null): void {
  handler = h;
}

/** Chưa có hộp thoại (trang dựng ngoài PwaShell) ⇒ về trang đăng nhập như trước. */
export function requestReauth(): Promise<boolean> {
  if (!handler) {
    window.location.assign("/dang-nhap");
    return Promise.resolve(false);
  }
  return handler();
}
