// Next.js 16 `instrumentation.ts` (PLAN đợt 4 T-301; BASE-CFG-002, FE-BUILD-005): validate biến môi trường NGAY khi server
// khởi động, không đợi request đầu tiên. Thiếu/sai biến → `register()` ném ConfigError (chỉ tên biến + lý do, không giá trị)
// nên tiến trình không lên được thay vì trả 500 lúc có người dùng. `next build` không gọi register (build không cần env).
// Chỉ chạy ở runtime Node.js: runtime edge không có `process.env` đầy đủ và không dùng cấu hình này.
// Đợt 5 T-403: in cấu hình hiệu lực (đã che bí mật) một lần lúc khởi động — BASE-CFG-007, so với `docs/design/SECURE-DEFAULTS.md`;
// `onRequestError` ghi lỗi render/route chưa bắt (BASE-ERR-002) — trước đó chỉ lỗi trong command được ghi log.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadConfig, redactConfig } = await import("@hm/app/config");
  const { createLogger } = await import("@hm/app/logging");
  const config = loadConfig(process.env);
  // Chỉ để in cấu hình hiệu lực: logger của request do `serverContext()` đặt (cùng mức/dịch vụ).
  createLogger({ level: config.LOG_LEVEL, service: "hm-web", env: config.NODE_ENV }).info(
    "config.effective",
    {
      config: redactConfig(config),
    },
  );
}

/** Cấu trúc tối thiểu của đối số Next truyền cho `onRequestError` (không phụ thuộc kiểu của `next`). */
interface RequestInfo {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}
interface ErrorContext {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
  renderSource?: string;
}

export async function onRequestError(
  err: unknown,
  request: RequestInfo,
  context: ErrorContext,
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { appLogger, reportRequestError } = await import("@hm/app/logging");
  reportRequestError(appLogger(), err, request, context);
}
