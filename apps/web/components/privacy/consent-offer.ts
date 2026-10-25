// Ô đồng ý không bắt buộc ở form đăng ký/nhận lời mời (T-2310): văn bản do trang server dựng từ danh mục mục đích (`@hm/app/privacy`).
import { type ConsentChannel, postConsent } from "./post-consent.ts";

export interface ConsentOffer {
  purpose: string;
  version: string;
  label: string;
  hint: string;
}

/**
 * Ghi đồng ý sau khi người dùng TỰ tick và đã có phiên. Lỗi (mạng, 409 phiên bản mới) bị nuốt có chủ ý: không ghi = mặc định không
 * đồng ý — an toàn; người dùng chọn lại ở trang Quyền riêng tư. Trả true khi server đã ghi/giữ nguyên đồng ý.
 */
export async function offerConsent(offer: ConsentOffer, channel: ConsentChannel): Promise<boolean> {
  try {
    return (await postConsent({ purpose: offer.purpose, granted: true, channel, version: offer.version })).ok;
  } catch {
    return false;
  }
}
