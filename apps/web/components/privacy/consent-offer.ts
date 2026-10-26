// Ô đồng ý không bắt buộc ở form đăng ký/nhận lời mời (T-2310): văn bản do trang server dựng từ danh mục mục đích (`@hm/app/privacy`).
import type { ConsentUnsavedText } from "./consent-unsaved-notice.tsx";
import { type ConsentChannel, postConsent } from "./post-consent.ts";

/** Tham số truy vấn báo trang đích (sau đăng ký) hiện `ConsentUnsavedNotice`. */
export const CONSENT_UNSAVED_PARAM = "dong_y_chua_luu";

export interface ConsentOffer {
  purpose: string;
  version: string;
  label: string;
  hint: string;
  /** Thông báo không chặn khi tick mà ghi thất bại. */
  unsaved: ConsentUnsavedText;
}

/**
 * Ghi đồng ý sau khi người dùng TỰ tick và đã có phiên. Lỗi (mạng, 409 phiên bản mới) không ném: không ghi = mặc định không đồng ý —
 * an toàn; trả false để form hiện `ConsentUnsavedNotice` (không im lặng). Trả true khi server đã ghi/giữ nguyên đồng ý.
 */
export async function offerConsent(offer: ConsentOffer, channel: ConsentChannel): Promise<boolean> {
  try {
    return (await postConsent({ purpose: offer.purpose, granted: true, channel, version: offer.version })).ok;
  } catch {
    return false;
  }
}
