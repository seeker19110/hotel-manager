// Logger dùng chung của tiến trình (web/worker) cho mã không nhận logger qua tham số (pipeline, sự kiện bảo mật).
// `serverContext()` đặt logger đã cấu hình (mức, dịch vụ); trước đó/ở test dùng logger mặc định ghi ra stdout.
import { createLogger, type Logger } from "./logger.ts";

let current: Logger | undefined;

export function appLogger(): Logger {
  current ??= createLogger({});
  return current;
}

/** Đặt logger của tiến trình; `undefined` = về mặc định (test dùng để bắt log rồi trả lại). */
export function setAppLogger(logger: Logger | undefined): void {
  current = logger;
}
