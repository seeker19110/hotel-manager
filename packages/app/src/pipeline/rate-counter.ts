// Bộ đếm giới hạn tần suất trong Postgres (migration 0053, `app.rate_limit_hit`; BE-REL-006, IND-SAAS-008). Đặt ở `pipeline` để
// cả lớp HTTP (tải file, webhook) lẫn lệnh cấp người dùng (`access`, không đi qua hạn mức theo tổ chức) cùng dùng một cơ chế.
// Bộ đếm nằm ở CSDL nên đúng khi nhiều instance/pool; khoá advisory trong hàm SQL chặn hai kết nối cùng lọt lượt cuối.
// Gọi bằng `Transaction` thì lượt đếm cùng số phận với transaction (rollback ⇒ không tính).
import { type Kysely, sql } from "kysely";

export const RATE_WINDOW_SECONDS = 60;

export interface RateHit {
  scope: string;
  subject: string;
  limit: number;
  windowSeconds?: number;
  /** Chỉ test: giả lập thời gian. */
  now?: Date;
}

export type RateResult =
  | { allowed: true; used: number }
  | { allowed: false; used: number; retryAfter: number };

/** Ghi một lượt và cho biết còn trong hạn mức không. Lượt bị từ chối không tăng bộ đếm. */
export async function rateLimitHit(db: Kysely<unknown>, h: RateHit): Promise<RateResult> {
  const r = await sql<{ allowed: boolean; used: number; retry_after: number }>`
    select allowed, used, retry_after from app.rate_limit_hit(${h.scope}, ${h.subject}, ${h.limit},
      ${h.windowSeconds ?? RATE_WINDOW_SECONDS}, ${h.now ?? sql`now()`})`.execute(db);
  const row = r.rows[0];
  if (!row) throw new Error("app.rate_limit_hit không trả hàng");
  return row.allowed
    ? { allowed: true, used: row.used }
    : { allowed: false, used: row.used, retryAfter: Math.max(1, row.retry_after) };
}
