// PLAN đợt 4 T-301/T-303 (D-024, D-025).
// - Schema `pgboss` tạo sẵn, thuộc `app_worker`: pg-boss chạy bằng vai trò worker (NOBYPASSRLS) mà không cần `CREATE` trên
//   CSDL (quyền đó cho phép tạo schema tuỳ ý). Worker khởi động pg-boss với `createSchema: false`; bảng của pg-boss tự dựng
//   bên trong schema này. Chạy bằng vai trò owner, cần `app_worker` đã tồn tại (bootstrap-roles.sql chạy trước migrate).
// - Dòng staging của file (`status = 'pending_scan'`): đường tải lên/xuất ghi dòng này trong transaction ngắn, quét + ghi
//   object NGOÀI transaction (DB-TX-003), rồi transaction lệnh chuyển sang `ready`/`rejected`. Lệnh lỗi/sập tiến trình để lại
//   object mồ côi CÓ dòng `pending_scan` + `delete_after` ⇒ job hạn giữ (`app.files_due_for_deletion`/`mark_file_deleted`,
//   nay bao cả `pending_scan`) xoá object rồi đánh dấu `deleted`.
// - Outbox: cột `available_at` (lùi lần thử kế tiếp). `app.outbox_mark` đặt backoff khi có lỗi (gửi lỗi hoặc `no_consumer`:
//   sự kiện chưa có consumer ở worker này, review lát 7 🟠2/D-026) nên `app.outbox_claim` (cũ nhất trước) không kẹt đầu hàng
//   vì một hàng chưa xử lý được; hàng vẫn `published_at IS NULL` ⇒ worker khác (có consumer) hoặc lần triển khai sau nhận được.
// - Claim ngắn (T-401, ARC-INT-003/DB-TX-003): `app.outbox_claim` KHÔNG giữ khoá qua lúc gọi pg-boss nữa — nó đặt lease
//   (`available_at = now() + 60 giây`) cho hàng lấy được rồi relay COMMIT ngay, sau đó mới `boss.send` (job id = outbox.id,
//   khoá chính (name, id) của pg-boss ⇒ gửi lại không tạo job thứ hai) và `app.outbox_mark`. Sập giữa chừng ⇒ hết lease thì
//   hàng được claim lại; gửi lại là no-op ở pg-boss.
// - Hạn mức lệnh theo tổ chức (T-401, IND-SAAS-008): index `ix_idempotency_org_time (organization_id, created_at DESC)` cho
//   truy vấn đếm lệnh trong 60 giây gần nhất của pipeline (không thêm bảng).
// - `app.dead_letter_jobs()` (T-401, BE-JOB-004): số job còn nằm trong queue `outbox.dead_letter` (chưa xử lý/redrive) cho
//   metric `hm_dead_letter_jobs`. Hàm riêng (không sửa `app.metrics_snapshot` của 0046) để không đè lên thay đổi khác của hàm đó.
// - RLS: dòng staging chỉ chính người tạo (`uploaded_by = app.actor_id`) được tạo/sửa (policy RESTRICTIVE theo từng lệnh),
//   người khác trong tổ chức chỉ đọc được metadata theo policy sẵn có.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION app_worker;

DROP INDEX ix_files_delete_after;
CREATE INDEX ix_files_delete_after ON files (delete_after)
  WHERE status IN ('ready', 'pending_scan') AND delete_after IS NOT NULL;

CREATE OR REPLACE FUNCTION app.files_due_for_deletion(p_today date, p_limit integer)
  RETURNS TABLE (id uuid, organization_id uuid, storage_key text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT f.id, f.organization_id, f.storage_key FROM files f
    WHERE f.status IN ('ready', 'pending_scan') AND f.delete_after IS NOT NULL AND f.delete_after <= p_today
    ORDER BY f.delete_after, f.id
    LIMIT least(greatest(p_limit, 1), 1000)
  $$;
CREATE OR REPLACE FUNCTION app.mark_file_deleted(p_id uuid, p_today date) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH x AS (
      UPDATE files SET status = 'deleted', deleted_at = now(), version = version + 1
      WHERE id = p_id AND status IN ('ready', 'pending_scan') AND delete_after IS NOT NULL AND delete_after <= p_today
      RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM x)
  $$;

ALTER TABLE outbox ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();

-- Lease 60 giây: đủ cho một lượt gửi (tối đa 1000 hàng, mỗi hàng một INSERT của pg-boss) mà sập tiến trình vẫn được nhận lại
-- nhanh; gửi trùng sau khi lease hết hạn vô hại vì job id = outbox.id.
CREATE OR REPLACE FUNCTION app.outbox_claim(p_limit integer)
  RETURNS TABLE (id uuid, organization_id uuid, event_type text, aggregate_id uuid, payload jsonb, correlation_id text)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH c AS (
      SELECT o.id FROM outbox o WHERE o.published_at IS NULL AND o.available_at <= now()
      ORDER BY o.created_at, o.id
      LIMIT least(greatest(p_limit, 1), 1000)
      FOR UPDATE SKIP LOCKED),
    u AS (
      UPDATE outbox o SET available_at = now() + interval '60 seconds'
      FROM c WHERE o.id = c.id
      RETURNING o.id, o.organization_id, o.event_type, o.aggregate_id, o.payload, o.correlation_id, o.created_at)
    SELECT u.id, u.organization_id, u.event_type, u.aggregate_id, u.payload, u.correlation_id
    FROM u ORDER BY u.created_at, u.id
  $$;
-- Lỗi ⇒ lần thử kế tiếp sau 5 s · 2^attempts (trần 5 phút); attempts ở vế phải là giá trị TRƯỚC khi tăng.
CREATE OR REPLACE FUNCTION app.outbox_mark(p_id uuid, p_error text)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE outbox SET attempts = attempts + 1,
           published_at = CASE WHEN p_error IS NULL THEN now() ELSE published_at END,
           last_error = left(p_error, 500),
           available_at = CASE WHEN p_error IS NULL THEN available_at
                               ELSE now() + least(interval '5 minutes', make_interval(secs => 5 * power(2, least(attempts, 6)))) END
    WHERE id = p_id AND published_at IS NULL
  $$;

CREATE INDEX ix_idempotency_org_time ON idempotency_keys (organization_id, created_at DESC);

CREATE FUNCTION app.dead_letter_jobs() RETURNS bigint
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n bigint;
BEGIN
  IF to_regclass('pgboss.job') IS NULL THEN RETURN 0; END IF;
  EXECUTE 'SELECT count(*) FROM pgboss.job WHERE name = ''outbox.dead_letter'' AND state IN (''created'', ''retry'', ''active'', ''failed'')' INTO n;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.dead_letter_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dead_letter_jobs() TO app_runtime, app_worker;

CREATE POLICY files_staging_insert ON files AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (status <> 'pending_scan' OR uploaded_by = nullif(current_setting('app.actor_id', true), '')::uuid);
CREATE POLICY files_staging_update ON files AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (status <> 'pending_scan' OR uploaded_by = nullif(current_setting('app.actor_id', true), '')::uuid);
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.dead_letter_jobs();
DROP INDEX IF EXISTS ix_idempotency_org_time;
-- Khôi phục đúng định nghĩa của 0003 trước khi bỏ cột mà hàm mới dùng.
CREATE OR REPLACE FUNCTION app.outbox_claim(p_limit integer)
  RETURNS TABLE (id uuid, organization_id uuid, event_type text, aggregate_id uuid, payload jsonb, correlation_id text)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT o.id, o.organization_id, o.event_type, o.aggregate_id, o.payload, o.correlation_id
    FROM outbox o WHERE o.published_at IS NULL
    ORDER BY o.created_at, o.id
    LIMIT least(greatest(p_limit, 1), 1000)
    FOR UPDATE SKIP LOCKED
  $$;
CREATE OR REPLACE FUNCTION app.outbox_mark(p_id uuid, p_error text)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE outbox SET attempts = attempts + 1,
           published_at = CASE WHEN p_error IS NULL THEN now() ELSE published_at END,
           last_error = left(p_error, 500)
    WHERE id = p_id AND published_at IS NULL
  $$;
ALTER TABLE outbox DROP COLUMN available_at;

DROP POLICY files_staging_update ON files;
DROP POLICY files_staging_insert ON files;

-- Khôi phục đúng định nghĩa của 0045. Dòng pending_scan còn lại (nếu có) không còn được job hạn giữ xử lý.
CREATE OR REPLACE FUNCTION app.files_due_for_deletion(p_today date, p_limit integer)
  RETURNS TABLE (id uuid, organization_id uuid, storage_key text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT f.id, f.organization_id, f.storage_key FROM files f
    WHERE f.status = 'ready' AND f.delete_after IS NOT NULL AND f.delete_after <= p_today
    ORDER BY f.delete_after, f.id
    LIMIT least(greatest(p_limit, 1), 1000)
  $$;
CREATE OR REPLACE FUNCTION app.mark_file_deleted(p_id uuid, p_today date) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH x AS (
      UPDATE files SET status = 'deleted', deleted_at = now(), version = version + 1
      WHERE id = p_id AND status = 'ready' AND delete_after IS NOT NULL AND delete_after <= p_today
      RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM x)
  $$;
DROP INDEX ix_files_delete_after;
CREATE INDEX ix_files_delete_after ON files (delete_after) WHERE status = 'ready' AND delete_after IS NOT NULL;

-- Không CASCADE có chủ đích: schema pgboss còn bảng (worker đã chạy) ⇒ down lỗi, người vận hành phải dừng worker và
-- quyết định có xoá hàng đợi hay không (mất job chưa xử lý). Schema rỗng thì xoá được.
DROP SCHEMA IF EXISTS pgboss;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
