// Thông báo KHÔNG chặn khi người dùng đã tick đồng ý ở form đăng ký/nhận lời mời nhưng ghi lựa chọn thất bại (mạng, 409 văn bản mới…):
// không ghi = mặc định không đồng ý (an toàn), nhưng người dùng phải biết để chọn lại ở trang Quyền riêng tư (T-2310). Khuôn banner
// trạng thái sẵn có (`banner banner--warn`, role="status" — như banner mất mạng của pwa-shell).
export interface ConsentUnsavedText {
  text: string;
  link: string;
}

export function ConsentUnsavedNotice({ text, link }: ConsentUnsavedText) {
  return (
    <div className="banner banner--warn" role="status" aria-live="polite" data-testid="consent-unsaved">
      <span>{text}</span>
      <a href="/quyen-rieng-tu">{link}</a>
    </div>
  );
}
