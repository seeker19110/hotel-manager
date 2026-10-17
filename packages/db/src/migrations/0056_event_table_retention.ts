// PLAN đợt 6 T-505 (XC-GREEN-007, ARC-RES-009): dọn bảng sự kiện theo chính sách hạn giữ (docs/ops/retention-policy.md).
// Worker (`app_worker`) KHÔNG có quyền DELETE trực tiếp trên outbox/notification_deliveries và policy `worker_cleanup` của
// idempotency_keys không dùng được khi không có ngữ cảnh tổ chức (RLS lọc theo `app.current_org()`), nên mỗi bảng có MỘT hàm
// SECURITY DEFINER phạm vi hẹp, chỉ app_worker gọi — như `app.purge_import_rows` (0045):
//   - `app.purge_outbox(p_now, p_days, p_limit)`: hàng outbox ĐÃ PHÁT (`published_at` không null) quá `p_days` ngày. Hàng chưa
//     phát không bao giờ bị xoá (kể cả cũ, kể cả `no_consumer`).
//   - `app.purge_idempotency_keys(p_now, p_limit)`: khoá idempotency đã hết hạn (`expires_at` < mốc).
//   - `app.purge_notification_deliveries(p_now, p_done_days, p_failed_days, p_limit)`: lần gửi đã xong (`sent`, `suppressed`) quá
//     `p_done_days` ngày; `failed`/`dead` (còn chờ người thử lại) quá `p_failed_days` ngày; hàng `queued`/`sending`/`retrying` giữ.
// Chung: (1) mốc so sánh bị chặn trên bởi đồng hồ CSDL (`least(p_now, now())`) — đồng hồ worker lệch về tương lai không xoá được
// hàng chưa tới hạn; (2) số ngày tối thiểu 1 (cấu hình sai thành 0/âm không xoá sạch bảng); (3) xoá theo LÔ `p_limit` (1…5000,
// SKIP LOCKED) để mỗi lượt ngắn, không giữ khoá lâu — worker lặp tới khi hết; (4) so sánh nghiêm ngặt "<": hàng đúng mốc còn giữ.
// - Index riêng cho truy vấn dọn (phần có điều kiện, không phình theo hàng chưa xong): `ix_outbox_published_at`,
//   `ix_notification_deliveries_done`. `idempotency_keys` đã có `ix_idempotency_expires` (0003).
// - Khoá bảng: CREATE INDEX thường chặn ghi bảng đích ngắn; `lock_timeout` 5 s như 0048 (thà thất bại rồi thử lại còn hơn xếp hàng).
// - Down: xoá hàm và index; không có dữ liệu để khôi phục (hàng đã xoá là hàng quá hạn giữ).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE INDEX ix_outbox_published_at ON outbox (published_at) WHERE published_at IS NOT NULL;
CREATE INDEX ix_notification_deliveries_done ON notification_deliveries (updated_at)
  WHERE status IN ('sent','suppressed','failed','dead');

CREATE FUNCTION app.purge_outbox(p_now timestamptz, p_days integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT o.id FROM outbox o
      WHERE o.published_at IS NOT NULL
        AND o.published_at < least(p_now, now()) - make_interval(days => greatest(p_days, 1))
      ORDER BY o.published_at, o.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM outbox o USING due WHERE o.id = due.id RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

CREATE FUNCTION app.purge_idempotency_keys(p_now timestamptz, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT k.id FROM idempotency_keys k
      WHERE k.expires_at < least(p_now, now())
      ORDER BY k.expires_at, k.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM idempotency_keys k USING due WHERE k.id = due.id RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

CREATE FUNCTION app.purge_notification_deliveries(p_now timestamptz, p_done_days integer, p_failed_days integer, p_limit integer)
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT d.id FROM notification_deliveries d
      WHERE (d.status IN ('sent','suppressed')
             AND d.updated_at < least(p_now, now()) - make_interval(days => greatest(p_done_days, 1)))
         OR (d.status IN ('failed','dead')
             AND d.updated_at < least(p_now, now()) - make_interval(days => greatest(p_failed_days, 1)))
      ORDER BY d.updated_at, d.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM notification_deliveries d USING due WHERE d.id = due.id RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

REVOKE ALL ON FUNCTION app.purge_outbox(timestamptz, integer, integer), app.purge_idempotency_keys(timestamptz, integer),
  app.purge_notification_deliveries(timestamptz, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_outbox(timestamptz, integer, integer), app.purge_idempotency_keys(timestamptz, integer),
  app.purge_notification_deliveries(timestamptz, integer, integer, integer) TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.purge_notification_deliveries(timestamptz, integer, integer, integer);
DROP FUNCTION IF EXISTS app.purge_idempotency_keys(timestamptz, integer);
DROP FUNCTION IF EXISTS app.purge_outbox(timestamptz, integer, integer);
DROP INDEX IF EXISTS ix_notification_deliveries_done;
DROP INDEX IF EXISTS ix_outbox_published_at;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  const prev =
    (await sql<{ v: string }>`select current_setting('lock_timeout') as v`.execute(db)).rows[0]?.v ?? "0";
  await sql`select set_config('lock_timeout', '5s', true)`.execute(db);
  await sql.raw(UP).execute(db);
  await sql`select set_config('lock_timeout', ${prev}, true)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
