// Khoá tạm theo tài khoản sau N lần đăng nhập sai (access Q-07: 5 lần → 15 phút; tham số hoá).
import { createHash } from "node:crypto";
import type pg from "pg";

export interface LockoutPolicy {
  maxFailures: number;
  windowMinutes: number;
  lockMinutes: number;
}

export const DEFAULT_LOCKOUT: LockoutPolicy = { maxFailures: 5, windowMinutes: 15, lockMinutes: 15 };

export function emailHash(email: string): Buffer {
  return createHash("sha256").update(email.trim().toLowerCase()).digest();
}

/** `true` nếu tài khoản đang bị khoá tại thời điểm `now`. */
export async function isLocked(pool: pg.Pool, email: string, now: Date): Promise<boolean> {
  const r = await pool.query<{ locked: boolean }>(
    "select coalesce(locked_until > $2, false) as locked from auth.login_throttle where email_hash = $1",
    [emailHash(email), now],
  );
  return r.rows[0]?.locked ?? false;
}

/** Số giây còn bị khoá (0 nếu không khoá) — `Retry-After` của ACCOUNT_LOCKED. */
export async function lockRemainingSeconds(pool: pg.Pool, email: string, now: Date): Promise<number> {
  const r = await pool.query<{ secs: number | null }>(
    "select ceil(extract(epoch from locked_until - $2))::int as secs from auth.login_throttle where email_hash = $1 and locked_until > $2",
    [emailHash(email), now],
  );
  return Math.max(0, r.rows[0]?.secs ?? 0);
}

/** Ghi một lần sai; đủ ngưỡng trong cửa sổ → đặt locked_until. Một câu lệnh nguyên tử (an toàn khi song song). */
export async function recordFailure(
  pool: pg.Pool,
  email: string,
  now: Date,
  p: LockoutPolicy,
): Promise<void> {
  await pool.query(
    `insert into auth.login_throttle as t (email_hash, failures, window_started_at)
       values ($1, 1, $2)
     on conflict (email_hash) do update set
       failures = case when t.window_started_at < $2 - make_interval(mins => $3) then 1 else t.failures + 1 end,
       window_started_at = case when t.window_started_at < $2 - make_interval(mins => $3) then $2 else t.window_started_at end,
       locked_until = case
         when (case when t.window_started_at < $2 - make_interval(mins => $3) then 1 else t.failures + 1 end) >= $4
         then $2 + make_interval(mins => $5) else t.locked_until end`,
    [emailHash(email), now, p.windowMinutes, p.maxFailures, p.lockMinutes],
  );
}

export async function clearFailures(pool: pg.Pool, email: string): Promise<void> {
  await pool.query("delete from auth.login_throttle where email_hash = $1", [emailHash(email)]);
}
