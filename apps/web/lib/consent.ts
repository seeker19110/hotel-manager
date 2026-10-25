// Ô đồng ý analytics cho form đăng ký/nhận lời mời (T-2310, D-122) — chỉ dùng ở Server Component: văn bản đã dịch lấy từ danh mục
// mục đích của server (`@hm/app/privacy`, cùng nguồn với băm `ui_snapshot_hash`) kèm phiên bản để client gửi lại khi tick.
import { analyticsConsentView } from "@hm/app/privacy";
import type { ConsentOffer } from "../components/privacy/consent-offer.ts";

export function analyticsConsentOffer(): ConsentOffer {
  const v = analyticsConsentView();
  return {
    purpose: v.id,
    version: v.version,
    label: v.checkbox ?? v.title,
    hint: `${v.description} ${v.data}`,
  };
}
