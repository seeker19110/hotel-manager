// `Clear-Site-Data` khi đăng xuất (SPEC-pwa S-007): thiết bị dùng chung không được giữ cache/storage của người vừa đăng xuất.
// Chỉ gắn vào phản hồi THÀNH CÔNG của POST `/api/auth/sign-out` (đăng xuất lỗi thì phiên còn, không xoá gì của người dùng).
export const CLEAR_SITE_DATA = '"cache", "storage"';

/** Đường dẫn Better Auth của đăng xuất (mọi tiền tố `/api/auth`). */
const isSignOut = (req: Request): boolean =>
  req.method === "POST" && new URL(req.url).pathname.replace(/\/+$/, "").endsWith("/sign-out");

/** Phản hồi 2xx của đăng xuất ⇒ thêm `Clear-Site-Data: "cache", "storage"`; mọi trường hợp khác trả nguyên. */
export function withClearSiteData(req: Request, res: Response): Response {
  if (!isSignOut(req) || res.status < 200 || res.status >= 300) return res;
  const headers = new Headers(res.headers);
  headers.set("clear-site-data", CLEAR_SITE_DATA);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
