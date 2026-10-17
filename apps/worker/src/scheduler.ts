// Lịch định kỳ của worker (PLAN đợt 4 T-301; ARC-RES-009, BE-REL-004). Vòng lặp trong tiến trình có `AbortSignal` thay vì cron
// pg-boss: relay outbox cần nhịp vài giây (cron chỉ tới phút) và mọi job ở đây đã an toàn khi nhiều worker chạy song song
// (SKIP LOCKED / khoá dedupe / idempotent) nên không cần "đúng một nơi chạy".
// Mỗi job chạy TUẦN TỰ với chính nó (không chồng lượt); lỗi một lượt chỉ ghi log rồi chờ lượt sau, không làm sập worker.
import type { Logger } from "@hm/app";

export interface ScheduledJob {
  name: string;
  /** Khoảng giữa hai lượt (tính từ lúc lượt trước KẾT THÚC), ms. */
  everyMs: number;
  /** Chờ trước lượt đầu (ms); mặc định 0 = chạy ngay khi khởi động. */
  initialDelayMs?: number;
  run: () => Promise<unknown>;
}

export interface Scheduler {
  /** Resolve khi mọi vòng đã dừng (lượt đang chạy xong hẳn). */
  readonly stopped: Promise<void>;
}

/** Chờ `ms` hoặc tới khi `signal` huỷ — resolve ở cả hai trường hợp, luôn dọn timer. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener("abort", done, { once: true });
  });
}

/** ±10% để nhiều worker không đồng loạt gõ CSDL cùng giây. */
function jitter(ms: number): number {
  return ms * (0.9 + Math.random() * 0.2);
}

export function startScheduler(
  jobs: readonly ScheduledJob[],
  opts: { signal: AbortSignal; log: Logger },
): Scheduler {
  const { signal, log } = opts;
  const loops = jobs.map(async (job) => {
    if (job.initialDelayMs) await abortableSleep(job.initialDelayMs, signal);
    while (!signal.aborted) {
      const t0 = Date.now();
      try {
        const result = await job.run();
        log.debug("job.done", { job: job.name, ms: Date.now() - t0, result });
      } catch (err) {
        log.error("job.failed", { job: job.name, ms: Date.now() - t0, error: err });
      }
      await abortableSleep(jitter(job.everyMs), signal);
    }
  });
  return { stopped: Promise.all(loops).then(() => undefined) };
}
