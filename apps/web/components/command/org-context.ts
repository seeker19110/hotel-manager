// Ngữ cảnh tổ chức mà trang đang hiển thị (SPEC-portal S-013): server render `<meta name="hm-org-context" content="<orgId>">`
// (lib/page.tsx, lib/portal-page.tsx); mọi lời gọi API từ trình duyệt gửi kèm header `X-Org-Context`. Tab khác đã chuyển tổ
// chức ⇒ server trả 409 CONTEXT_CHANGED, UI báo tải lại và KHÔNG gửi lại.
export const ORG_CONTEXT_META = "hm-org-context";
export const ORG_CONTEXT_HEADER = "x-org-context";
export const CONTEXT_CHANGED_CODE = "CONTEXT_CHANGED";
export const CONTEXT_CHANGED_TEXT = "Bạn vừa đổi tổ chức ở tab khác — tải lại trang";

/** Header ngữ cảnh từ thẻ meta của trang; không có meta (trang chưa chọn tổ chức) → không gửi header. */
export function orgContextHeaders(
  doc: Pick<Document, "querySelector"> | undefined = globalThis.document,
): Record<string, string> {
  const content = doc?.querySelector<HTMLMetaElement>(`meta[name="${ORG_CONTEXT_META}"]`)?.content?.trim();
  return content ? { [ORG_CONTEXT_HEADER]: content } : {};
}
