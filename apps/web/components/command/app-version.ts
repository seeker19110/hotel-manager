// Phiên bản bản build mà TRANG này được render từ (SPEC-pwa S-009): layout gốc ghi `<meta name="hm-app-version">`; mọi command từ
// trình duyệt gửi kèm `X-App-Version`. Tab mở từ lâu giữ phiên bản cũ ⇒ server đã nâng mức tối thiểu thì trả 426 CLIENT_OUTDATED.
import { CLIENT_VERSION_HEADER } from "@hm/app/client-version";

export const APP_VERSION_META = "hm-app-version";
export const CLIENT_OUTDATED_CODE = "CLIENT_OUTDATED";
export const CLIENT_OUTDATED_TEXT = "Ứng dụng cần cập nhật để tiếp tục.";

/** Header phiên bản từ thẻ meta; không có meta (trang lỗi dựng sớm) ⇒ không gửi header. */
export function appVersionHeaders(
  doc: Pick<Document, "querySelector"> | undefined = globalThis.document,
): Record<string, string> {
  const content = doc?.querySelector<HTMLMetaElement>(`meta[name="${APP_VERSION_META}"]`)?.content?.trim();
  return content ? { [CLIENT_VERSION_HEADER]: content } : {};
}
