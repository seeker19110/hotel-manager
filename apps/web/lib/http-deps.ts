// Phụ thuộc HTTP của route handler (CSDL, phiên Better Auth, cookie an toàn) lấy từ ngữ cảnh server dùng chung.
import { type HttpDeps, serverContext } from "@hm/app";

export function httpDeps(): HttpDeps {
  const { db, auth, config, log, services } = serverContext();
  return {
    db,
    getSession: async (headers) => {
      const s = await auth.api.getSession({ headers });
      return s ? { user: { id: s.user.id, twoFactorEnabled: s.user.twoFactorEnabled } } : null;
    },
    secureCookies: config.APP_BASE_URL.startsWith("https://"),
    services,
    onUnexpectedError: (err, correlationId) =>
      log.error("lỗi không dự kiến", {
        correlation_id: correlationId,
        err: err instanceof Error ? err.message : String(err),
      }),
  };
}
