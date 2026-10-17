// Phụ thuộc HTTP của route handler (CSDL, phiên Better Auth, cookie an toàn) lấy từ ngữ cảnh server dùng chung.
import { type HttpDeps, reportUnexpectedError, serverContext } from "@hm/app";
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
    minClientVersion: MIN_CLIENT_VERSION,
    secureCookies: config.APP_BASE_URL.startsWith("https://"),
    services,
    // Ghi loại, thông điệp, stack, cause + correlation_id (đã che bí mật/PII) — xem logging/unexpected.ts.
    onUnexpectedError: (err, correlationId) => reportUnexpectedError(log, err, correlationId),
  };
}
