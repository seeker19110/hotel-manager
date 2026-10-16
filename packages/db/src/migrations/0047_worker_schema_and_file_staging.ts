// PLAN đợt 4 T-301/T-303 (D-024, D-025).
// - Schema `pgboss` tạo sẵn, thuộc `app_worker`: pg-boss chạy bằng vai trò worker (NOBYPASSRLS) mà không cần `CREATE` trên
//   CSDL (quyền đó cho phép tạo schema tuỳ ý). Worker khởi động pg-boss với `createSchema: false`; bảng của pg-boss tự dựng
//   bên trong schema này. Chạy bằng vai trò owner, cần `app_worker` đã tồn tại (bootstrap-roles.sql chạy trước migrate).
// - Dòng staging của file (`status = 'pending_scan'`): đường tải lên/xuất ghi dòng này trong transaction ngắn, quét + ghi
//   object NGOÀI transaction (DB-TX-003), rồi transaction lệnh chuyển sang `ready`/`rejected`. Lệnh lỗi/sập tiến trình để lại
//   object mồ côi CÓ dòng `pending_scan` + `delete_after` ⇒ job hạn giữ (`app.files_due_for_deletion`/`mark_file_deleted`,
//   nay bao cả `pending_scan`) xoá object rồi đánh dấu `deleted`.
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

CREATE POLICY files_staging_insert ON files AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (status <> 'pending_scan' OR uploaded_by = nullif(current_setting('app.actor_id', true), '')::uuid);
CREATE POLICY files_staging_update ON files AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (status <> 'pending_scan' OR uploaded_by = nullif(current_setting('app.actor_id', true), '')::uuid);
`;

const DOWN = `
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
