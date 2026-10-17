// PLAN đợt 3 T-224 — việc treo đợt 2 (SPEC-import mục 10 hạn giữ; SPEC-access-and-property S-020; D-020).
// - Hạn giữ: file có `delete_after` ≤ hôm nay ⇒ worker xoá object rồi đánh dấu `files.status = 'deleted'` (+ deleted_at);
//   dòng nhập của lô đã commit/huỷ quá 30 ngày (ngày theo múi giờ cơ sở) ⇒ `raw = '{}'`, `data = NULL` (trigger
//   `import_row_guard` đã cho phép đúng thao tác này). Hàm SECURITY DEFINER phạm vi hẹp, chỉ app_worker gọi.
// - Cơ sở đang chọn: `memberships.selected_property_id` (chỉ để chọn, KHÔNG phải quyền — mọi request vẫn resolveActor);
//   ghi qua `app.select_property` kiểm cơ sở trong phạm vi của chính actor.
import { type Kysely, sql } from "kysely";

const UP = `
ALTER TABLE files DROP CONSTRAINT files_status_check;
ALTER TABLE files ADD CONSTRAINT files_status_check CHECK (status IN ('pending_scan','ready','rejected','deleted'));
ALTER TABLE files ADD COLUMN deleted_at timestamptz;
ALTER TABLE files ADD CONSTRAINT ck_files_deleted CHECK ((status = 'deleted') = (deleted_at IS NOT NULL));
CREATE INDEX ix_files_delete_after ON files (delete_after) WHERE status = 'ready' AND delete_after IS NOT NULL;

CREATE FUNCTION app.files_due_for_deletion(p_today date, p_limit integer)
  RETURNS TABLE (id uuid, organization_id uuid, storage_key text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT f.id, f.organization_id, f.storage_key FROM files f
    WHERE f.status = 'ready' AND f.delete_after IS NOT NULL AND f.delete_after <= p_today
    ORDER BY f.delete_after, f.id
    LIMIT least(greatest(p_limit, 1), 1000)
  $$;
CREATE FUNCTION app.mark_file_deleted(p_id uuid, p_today date) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH x AS (
      UPDATE files SET status = 'deleted', deleted_at = now(), version = version + 1
      WHERE id = p_id AND status = 'ready' AND delete_after IS NOT NULL AND delete_after <= p_today
      RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM x)
  $$;
CREATE FUNCTION app.purge_import_rows(p_now timestamptz, p_days integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT b.organization_id, b.id FROM import_batches b
      JOIN properties p ON p.organization_id = b.organization_id AND p.id = b.property_id
      WHERE b.status IN ('committed','cancelled')
        AND (coalesce(b.committed_at, b.cancelled_at) AT TIME ZONE p.timezone)::date + p_days <= (p_now AT TIME ZONE p.timezone)::date
    ), x AS (
      UPDATE import_rows r SET raw = '{}'::jsonb, data = NULL
      FROM due WHERE r.organization_id = due.organization_id AND r.batch_id = due.id
        AND (r.raw <> '{}'::jsonb OR r.data IS NOT NULL)
      RETURNING 1)
    SELECT count(*)::int FROM x
  $$;
REVOKE ALL ON FUNCTION app.files_due_for_deletion(date, integer), app.mark_file_deleted(uuid, date),
  app.purge_import_rows(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.files_due_for_deletion(date, integer), app.mark_file_deleted(uuid, date),
  app.purge_import_rows(timestamptz, integer) TO app_worker;

ALTER TABLE memberships ADD COLUMN selected_property_id uuid;
ALTER TABLE memberships ADD CONSTRAINT fk_memberships_selected_property FOREIGN KEY (organization_id, selected_property_id)
  REFERENCES properties (organization_id, id);
CREATE FUNCTION app.select_property(p_property uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_property IS NOT NULL AND NOT app.actor_can_see_property(p_property) THEN RETURN false; END IF;
  UPDATE memberships SET selected_property_id = p_property
   WHERE id = nullif(current_setting('app.actor_id', true), '')::uuid AND organization_id = app.current_org()
     AND status = 'active' AND selected_property_id IS DISTINCT FROM p_property;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.select_property(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.select_property(uuid) TO app_runtime;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.select_property(uuid);
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS fk_memberships_selected_property;
ALTER TABLE memberships DROP COLUMN IF EXISTS selected_property_id;
DROP FUNCTION IF EXISTS app.purge_import_rows(timestamptz, integer);
DROP FUNCTION IF EXISTS app.mark_file_deleted(uuid, date);
DROP FUNCTION IF EXISTS app.files_due_for_deletion(date, integer);
DROP INDEX IF EXISTS ix_files_delete_after;
ALTER TABLE files DROP CONSTRAINT ck_files_deleted;
-- File đã xoá object: không còn nội dung để quay về 'ready' — giữ dấu vết bằng 'rejected' + lý do.
UPDATE files SET status = 'rejected', reject_reason = 'deleted_by_retention' WHERE status = 'deleted';
ALTER TABLE files DROP COLUMN deleted_at;
ALTER TABLE files DROP CONSTRAINT files_status_check;
ALTER TABLE files ADD CONSTRAINT files_status_check CHECK (status IN ('pending_scan','ready','rejected'));
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
