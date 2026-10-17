// Helper CHỈ cho test (*.db.test.ts): đo session `idle in transaction` của vai trò ứng dụng từ ngoài (T-303, DB-TX-003).
import { type Kysely, sql } from "kysely";

/** Số session app_runtime/app_worker của DB `dbName` đang `idle in transaction`. */
export async function idleInTransaction(admin: Kysely<unknown>, dbName: string): Promise<number> {
  const r = await sql<{ n: number }>`
    select count(*)::int as n from pg_stat_activity
    where datname = ${dbName} and usename in ('app_runtime', 'app_worker') and state = 'idle in transaction'`.execute(
    admin,
  );
  return r.rows[0]?.n ?? -1;
}

/** Chờ `ms` và lấy mẫu mỗi 25 ms; trả số `idle in transaction` lớn nhất thấy được trong cửa sổ đó. */
export async function probeIdleDuring(admin: Kysely<unknown>, dbName: string, ms: number): Promise<number> {
  let max = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    max = Math.max(max, await idleInTransaction(admin, dbName));
    await new Promise((r) => setTimeout(r, 25));
  }
  return max;
}
