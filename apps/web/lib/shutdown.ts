// Dừng êm tiến trình web (T-402; ARC-RES-009, BE-REL-004). `next start` tự đăng ký SIGTERM (next/dist/server/lib/start-server.js,
// trừ khi đặt NEXT_MANUAL_SIG_HANDLE): đóng cổng nghe NGAY, chờ request đang chạy xong rồi `process.exit(143)`. Như vậy
// (1) bộ cân bằng tải không có khoảng thời gian thấy `/api/ready` = 503 trước khi cổng đóng, (2) mã thoát 143 ≠ 0. Module này
// BỌC handler đó thay vì thay thế (không tự dựng lại việc đóng server):
//   1. SIGTERM ⇒ đặt cờ `draining` ⇒ `/api/ready` trả 503 ngay; server vẫn nhận và phục vụ request bình thường
//      trong `DRAIN_NOTICE_MS` để bộ cân bằng tải kịp rút instance khỏi vòng;
//   2. hết thời gian báo ⇒ gọi handler gốc của Next: đóng cổng nghe, chờ request đang chạy;
//   3. Next gọi `process.exit(143)` ⇒ đổi thành 0 (dừng có chủ đích là thành công);
//   4. quá `SHUTDOWN_DEADLINE_MS` kể từ SIGTERM mà còn request chạy ⇒ log `web.shutdown_timeout` rồi thoát 0 (việc dở của
//      request đó mất; không thể chờ vô hạn dưới `stop_grace_period` (xem `STOP_GRACE_PERIOD_SECONDS`));
//   5. tín hiệu SIGTERM lần hai ⇒ thoát ngay mã 1.
// Cờ nằm ở `globalThis` (Symbol.for) vì instrumentation và route handler có thể là hai bản module riêng trong bundle.

/** Thời gian vẫn phục vụ bình thường (chỉ `/api/ready` trả 503) trước khi đóng cổng nghe. */
export const DRAIN_NOTICE_MS = 5_000;
/**
 * `stop_grace_period` (`terminationGracePeriodSeconds`) của web ≥ 40 giây — MỘT giá trị cho cả web và worker
 * (deploy/web.Dockerfile, deploy/worker.Dockerfile, RUNBOOK §8): hạn chót + biên dự phòng để tiến trình tự thoát trước SIGKILL.
 * Test `shutdown.test.ts` giữ các nơi này khớp nhau.
 */
export const STOP_GRACE_PERIOD_SECONDS = 40;
/** Hạn chót kể từ SIGTERM tới khi thoát (gồm `DRAIN_NOTICE_MS`); phải nhỏ hơn `STOP_GRACE_PERIOD_SECONDS` ít nhất 10 giây. */
export const SHUTDOWN_DEADLINE_MS = 25_000;

const DRAINING = Symbol.for("hm.web.draining");
const INSTALLED = Symbol.for("hm.web.shutdown_installed");
type Flags = { [DRAINING]?: boolean; [INSTALLED]?: boolean };
const flags = (): Flags => globalThis as unknown as Flags;

/** Đang dừng: `/api/ready` phải trả 503. */
export function isDraining(): boolean {
  return flags()[DRAINING] === true;
}

/** Chỉ cho test: đặt lại cờ. */
export function resetShutdownForTest(): void {
  flags()[DRAINING] = false;
  flags()[INSTALLED] = false;
}

type SignalListener = (signal: NodeJS.Signals) => void;

/** Phần của `process` mà module dùng — tiêm được để test không chạm tiến trình thật. */
export interface ProcessLike {
  listeners(event: "SIGTERM"): ((...args: never[]) => unknown)[];
  off(event: "SIGTERM", listener: SignalListener): unknown;
  on(event: "SIGTERM", listener: SignalListener): unknown;
  once(event: "exit", listener: () => void): unknown;
  exit(code?: number): unknown;
  exitCode?: number | string | null | undefined;
}

export interface ShutdownOptions {
  noticeMs: number;
  deadlineMs: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

function defaultLog(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ level: "warn", msg: event, ...fields })}\n`);
}

/**
 * Cài handler SIGTERM (idempotent). Gọi MỘT lần trong `register()` của instrumentation, SAU khi Next đã đăng ký handler của nó.
 */
export function installShutdownHandler(
  proc: ProcessLike = process,
  opts: Partial<ShutdownOptions> = {},
): void {
  if (flags()[INSTALLED]) return;
  flags()[INSTALLED] = true;
  const o: ShutdownOptions = {
    noticeMs: DRAIN_NOTICE_MS,
    deadlineMs: SHUTDOWN_DEADLINE_MS,
    log: defaultLog,
    ...opts,
  };
  const inherited = proc.listeners("SIGTERM") as SignalListener[];
  for (const l of inherited) proc.off("SIGTERM", l);
  let started = false;
  proc.on("SIGTERM", (signal) => {
    if (started) {
      o.log("web.shutdown_forced");
      proc.exit(1);
      return;
    }
    started = true;
    flags()[DRAINING] = true;
    o.log("web.shutdown_started", { notice_ms: o.noticeMs, deadline_ms: o.deadlineMs });
    // Next kết thúc bằng exit(128 + 15); dừng có chủ đích là mã 0. `exit` chạy trước `reallyExit` nên sửa được mã.
    proc.once("exit", () => {
      if (proc.exitCode === 143) proc.exitCode = 0;
    });
    setTimeout(() => {
      o.log("web.shutdown_timeout");
      proc.exit(0);
    }, o.deadlineMs).unref();
    setTimeout(() => {
      if (inherited.length === 0) {
        // Không có handler của Next (NEXT_MANUAL_SIG_HANDLE): không còn gì để chờ ở đây.
        o.log("web.shutdown_no_server_handler");
        proc.exit(0);
        return;
      }
      for (const l of inherited) l(signal);
    }, o.noticeMs);
  });
}
