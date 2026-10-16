// Logger dùng chung của tiến trình (web/worker) cho mã không nhận logger qua tham số (pipeline, sự kiện bảo mật).
// `serverContext()` đặt logger đã cấu hình (mức, dịch vụ); trước đó/ở test dùng logger mặc định ghi ra stdout.
import { createLogger, type Logger, type LogLevel } from "./logger.ts";

const LEVELS = ["debug", "info", "warn", "error"] as const;

function defaultLevel(): LogLevel {
  const fromEnv = process.env.LOG_LEVEL;
  const level = LEVELS.find((l) => l === fromEnv);
  if (level) return level;
  return process.env.NODE_ENV === "test" ? "error" : "info";
}

let current: Logger | undefined;

export function appLogger(): Logger {
  // Mặc định: stdout; mức `LOG_LEVEL` nếu đặt, riêng NODE_ENV=test chỉ ghi `error` (test cần bắt log thì `setAppLogger`).
  current ??= createLogger({ level: defaultLevel() });
  return current;
}

/** Đặt logger của tiến trình; `undefined` = về mặc định (test dùng để bắt log rồi trả lại). */
export function setAppLogger(logger: Logger | undefined): void {
  current = logger;
}
