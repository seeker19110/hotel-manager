// Helper retry chung (ARC-RES-002, DB-TX-002, BE-REL-003, BE-JOB-003): lùi mũ + jitter (mặc định "full jitter" kiểu AWS
// Builders' Library), trần số lần, trần tổng thời gian, CHỈ thử lại lỗi được phân loại là tạm thời. Nguồn ngẫu nhiên, đồng hồ
// và hàm chờ tiêm được để test xác định. Không phụ thuộc Postgres: phân loại lỗi CSDL ở `isTransientTxError`.

export interface RetryPolicy {
  /** Tổng số lần chạy, KỂ CẢ lần đầu (≥ 1). `1` = không thử lại. */
  maxAttempts: number;
  /** Nền của lùi mũ (ms): trần của lần chờ thứ n là `base · 2^(n-1)`. */
  baseDelayMs: number;
  /** Trần MỘT lần chờ (ms), kể cả khi gợi ý `retryAfterMs` đòi lâu hơn. */
  maxDelayMs: number;
  /** Trần TỔNG từ lúc bắt đầu tới khi kết thúc, gồm thời gian chạy và chờ (ms): chờ xong không đủ thời gian thử nữa ⇒ bỏ cuộc. */
  maxElapsedMs: number;
  /**
   * Phần tối thiểu của trần mũ được giữ lại, ∈ [0, 1]. `0` (mặc định) = full jitter: chờ ∈ [0, trần]. `0.5` = chờ ∈ [0,5·trần, trần].
   */
  minJitterRatio?: number;
}

/** Nguồn bất định tiêm cho test. */
export interface RetryDeps {
  /** ∈ [0, 1). */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Đồng hồ đơn điệu hoặc epoch, ms. */
  now?: () => number;
}

/** Phán quyết phân loại: `false` = lỗi vĩnh viễn (không thử lại); `true` = tạm thời; đối tượng = tạm thời + chờ tối thiểu (Retry-After). */
export type RetryVerdict = boolean | { retryAfterMs: number };

export interface RetryInfo {
  /** Lần vừa lỗi (1 = lần đầu). */
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface RetryOptions extends RetryDeps {
  policy: RetryPolicy;
  /** Phân loại lỗi. Không có = không lỗi nào được thử lại (an toàn mặc định). */
  classify?: (error: unknown) => RetryVerdict;
  onRetry?: (info: RetryInfo) => void;
  /** Biến lỗi cuối thành lỗi ném ra khi hết lượt/hết thời gian; mặc định ném nguyên lỗi cuối. */
  giveUp?: (lastError: unknown, reason: "attempts" | "budget") => unknown;
}

export interface AttemptContext {
  /** Lần chạy hiện tại, bắt đầu từ 1. */
  attempt: number;
  /** Thời gian còn lại trong trần tổng (ms), ≥ 0 — để cắt timeout từng lần gọi. */
  remainingMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function validate(p: RetryPolicy): void {
  const bad = (m: string) => {
    throw new RangeError(`RetryPolicy không hợp lệ: ${m}`);
  };
  if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 1) bad("maxAttempts phải là số nguyên ≥ 1");
  for (const k of ["baseDelayMs", "maxDelayMs", "maxElapsedMs"] as const) {
    if (!Number.isFinite(p[k]) || p[k] < 0) bad(`${k} phải là số hữu hạn ≥ 0`);
  }
  if (p.minJitterRatio !== undefined && !(p.minJitterRatio >= 0 && p.minJitterRatio <= 1)) {
    bad("minJitterRatio phải ∈ [0, 1]");
  }
}

/**
 * Thời gian chờ (ms) sau lần lỗi thứ `failedAttempt` (1 = lần đầu): trần = `min(maxDelayMs, base · 2^(n-1))`, nhân hệ số jitter
 * `min + random · (1 - min)`. Luôn ∈ [0, maxDelayMs].
 */
export function backoffDelayMs(
  failedAttempt: number,
  policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs" | "minJitterRatio">,
  random: () => number = Math.random,
): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1));
  const min = policy.minJitterRatio ?? 0;
  const r = Math.min(Math.max(random(), 0), 1);
  return exp * (min + r * (1 - min));
}

/**
 * Cộng jitter LÊN (không bao giờ sớm hơn mốc đã hứa): `baseMs · (1 + ratio · random)` ∈ [baseMs, baseMs · (1 + ratio)].
 * Dùng cho lịch cố định theo giờ/phút (vd. lịch gửi lại email) để nhiều việc không dồn cùng một thời điểm.
 */
export function spreadDelayMs(baseMs: number, ratio: number, random: () => number = Math.random): number {
  if (!Number.isFinite(baseMs) || baseMs < 0) throw new RangeError("baseMs phải là số hữu hạn ≥ 0");
  if (!Number.isFinite(ratio) || ratio < 0) throw new RangeError("ratio phải là số hữu hạn ≥ 0");
  const r = Math.min(Math.max(random(), 0), 1);
  return baseMs * (1 + ratio * r);
}

/**
 * Chạy `fn`, thử lại lỗi tạm thời theo `policy`. `fn` phải ĐẢO ĐƯỢC/lũy đẳng (mỗi lần chạy lại từ đầu). Lỗi vĩnh viễn ném ngay,
 * không chờ. Hết `maxAttempts` hoặc chờ xong không còn đủ thời gian trong `maxElapsedMs` ⇒ ném lỗi cuối (hoặc `giveUp(...)`).
 */
export async function retryAsync<T>(fn: (c: AttemptContext) => Promise<T>, opts: RetryOptions): Promise<T> {
  const { policy } = opts;
  validate(policy);
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + policy.maxElapsedMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn({ attempt, remainingMs: Math.max(0, deadline - now()) });
    } catch (err) {
      const verdict = opts.classify?.(err) ?? false;
      if (verdict === false) throw err;
      const giveUp = (reason: "attempts" | "budget") => (opts.giveUp ? opts.giveUp(err, reason) : err);
      if (attempt >= policy.maxAttempts) throw giveUp("attempts");
      let delay = backoffDelayMs(attempt, policy, random);
      if (typeof verdict === "object")
        delay = Math.min(Math.max(delay, verdict.retryAfterMs), policy.maxDelayMs);
      // Chờ xong còn chưa đủ thời gian cho một lần nữa ⇒ dừng luôn, không ngủ vô ích.
      if (deadline - now() <= delay) throw giveUp("budget");
      opts.onRetry?.({ attempt, delayMs: delay, error: err });
      await sleep(delay);
    }
  }
}

/** Mã SQLSTATE thử lại được cho transaction: serialization_failure, deadlock_detected (PostgreSQL §13.2.3). */
export const TRANSIENT_TX_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01"]);

/** SQLSTATE của lỗi (ở chính nó hoặc `cause`), hoặc undefined. */
export function sqlState(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 3; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Lỗi transaction tạm thời (40001/40P01): chạy lại TOÀN BỘ transaction là đúng. Mọi lỗi khác là vĩnh viễn. */
export function isTransientTxError(err: unknown): boolean {
  const s = sqlState(err);
  return s !== undefined && TRANSIENT_TX_SQLSTATES.has(s);
}

/** Mặc định cho transaction phía request: 3 lần (BE-REL-003), chờ ≤ 250 ms, tổng ≤ 3 s — người dùng đang đợi. */
export const REQUEST_TX_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 25,
  maxDelayMs: 250,
  maxElapsedMs: 3_000,
};

/** Mặc định cho transaction phía worker/job: kiên nhẫn hơn, vẫn có trần (5 lần, ≤ 2 s mỗi lần chờ, tổng ≤ 15 s). */
export const WORKER_TX_RETRY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 50,
  maxDelayMs: 2_000,
  maxElapsedMs: 15_000,
};
