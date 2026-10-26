// Phụ thuộc HTTP của route handler (CSDL, phiên Better Auth, cookie an toàn) lấy từ ngữ cảnh server dùng chung.
import {
  type DataRequestDeps,
  type HttpDeps,
  isSessionRevoked,
  type OrgDeletionDeps,
  reportUnexpectedError,
  serverContext,
} from "@hm/app";
import { MIN_CLIENT_VERSION } from "./app-version.ts";

export function httpDeps(): HttpDeps {
  const { db, auth, config, log, services } = serverContext();
  return {
    db,
    getSession: async (headers) => {
      const s = await auth.api.getSession({ headers });
      return s
        ? {
            user: { id: s.user.id, twoFactorEnabled: s.user.twoFactorEnabled },
            session: { createdAt: s.session.createdAt },
          }
        : null;
    },
    // Tên cookie phiên do Better Auth quyết (tiền tố `__Host-` ở https): lấy từ ngữ cảnh của nó, không tự đoán.
    isSessionRevoked: async (headers) =>
      isSessionRevoked(db, (await auth.$context).authCookies.sessionToken.name, headers),
    verifyPassword: async (headers, password) => {
      try {
        const r = await auth.api.verifyPassword({ body: { password }, headers });
        return r.status === true;
      } catch (e) {
        // APIError của Better Auth (mật khẩu sai, không có mật khẩu, phiên không hợp lệ) có `statusCode` ⇒ chưa xác thực lại được.
        // Lỗi khác (CSDL…) ném tiếp ⇒ 500, không báo nhầm thành "sai mật khẩu".
        if (typeof (e as { statusCode?: unknown }).statusCode === "number") return false;
        throw e;
      }
    },
    minClientVersion: MIN_CLIENT_VERSION,
    secureCookies: config.APP_BASE_URL.startsWith("https://"),
    services,
    // Ghi loại, thông điệp, stack, cause + correlation_id (đã che bí mật/PII) — xem logging/unexpected.ts.
    onUnexpectedError: (err, correlationId) => reportUnexpectedError(log, err, correlationId),
  };
}

/**
 * Phụ thuộc của `/api/v1/me/data-requests` (T-2311) và mọi route xác thực lại: `httpDeps` đã kèm kiểm mật khẩu của người trong phiên
 * bằng Better Auth `verifyPassword` (endpoint chỉ gọi từ server, đọc phiên từ header) — sai/không có mật khẩu (người thuê đăng
 * nhập OTP) ⇒ false.
 */
export function dataRequestDeps(): DataRequestDeps {
  return httpDeps();
}

/** Phụ thuộc của `/api/v1/organization/deletion` (T-2312, D-125): cùng một hàm kiểm mật khẩu như DSAR và lệnh `reauth` (D-129). */
export function orgDeletionDeps(): OrgDeletionDeps {
  return httpDeps();
}
