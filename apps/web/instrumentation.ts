// Next.js 16 `instrumentation.ts` (PLAN đợt 4 T-301; BASE-CFG-002, FE-BUILD-005): validate biến môi trường NGAY khi server
// khởi động, không đợi request đầu tiên. Thiếu/sai biến → `register()` ném ConfigError (chỉ tên biến + lý do, không giá trị)
// nên tiến trình không lên được thay vì trả 500 lúc có người dùng. `next build` không gọi register (build không cần env).
// Cài handler SIGTERM dừng êm (lib/shutdown.ts). Chỉ chạy ở runtime Node.js: runtime edge không có `process.env` đầy đủ và không dùng cấu hình này.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadConfig } = await import("@hm/app/config");
  loadConfig(process.env);
  // Dừng êm (T-402): SIGTERM ⇒ `/api/ready` 503, chờ request đang chạy, thoát 0 — xem lib/shutdown.ts.
  const { installShutdownHandler } = await import("./lib/shutdown.ts");
  installShutdownHandler();
}
