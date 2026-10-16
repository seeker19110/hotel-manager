// PLAN đợt 3 T-219 — hạn giữ dữ liệu (review đợt 2 🟠3; SPEC-import mục 4/10; ERD files.delete_after, import_rows.raw/data; INV-G7).
// Worker KHÔNG có quyền đọc `files`/`import_rows` (RLS cần actor owner/manager) nên job đi qua 3 hàm SECURITY DEFINER phạm vi
// hẹp (cùng mẫu `app.expire_holds`): chỉ trả/đổi đúng hàng quá hạn, không nhận id/tổ chức tuỳ ý từ ngoài.
// - `files.deleted_at`: đã xoá object ở storage; hàng `files` giữ lại làm dấu vết (storage_key, sha256), không cấp URL nữa.
// - Hàng đã nhận bằng FOR UPDATE SKIP LOCKED: hai job chạy song song không xử lý trùng một file/lô.
import { type Kysely, sql } from "kysely";

const UP = `
ALTER TABLE files ADD COLUMN deleted_at timestamptz;
ALTER TABLE files ADD CONSTRAINT ck_files_deleted CHECK (deleted_at IS NULL OR delete_after IS NOT NULL);
CREATE INDEX ix_files_retention_due ON files (delete_after) WHERE deleted_at IS NULL AND delete_after IS NOT NULL;

-- Nhận tối đa p_limit file quá hạn (delete_after <= p_today, chưa xoá) và KHOÁ chúng đến hết transaction của người gọi.
CREATE FUNCTION app.retention_claim_files(p_today date, p_limit integer)
  RETURNS TABLE (file_id uuid, org_id uuid, storage_key text)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT f.id, f.organization_id, f.storage_key FROM files f
    WHERE f.deleted_at IS NULL AND f.delete_after IS NOT NULL AND f.delete_after <= p_today
    ORDER BY f.delete_after, f.id
    LIMIT least(greatest(p_limit, 1), 1000)
    FOR UPDATE SKIP LOCKED
  $$;

-- Đánh dấu đã xoá object (gọi SAU khi storage xác nhận xoá/404) + audit; false nếu đã đánh dấu hoặc chưa tới hạn.
CREATE FUNCTION app.retention_mark_file_deleted(p_file uuid, p_today date, p_now timestamptz, p_correlation text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  UPDATE files SET deleted_at = p_now
   WHERE id = p_file AND deleted_at IS NULL AND delete_after IS NOT NULL AND delete_after <= p_today
   RETURNING organization_id, property_id, owner_type INTO r;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO audit_events (id, organization_id, property_id, actor_type, action, entity_type, entity_id, correlation_id, after)
  VALUES (gen_random_uuid(), r.organization_id, r.property_id, 'worker', 'file.retention_deleted', 'file', p_file,
          p_correlation, jsonb_build_object('owner_type', r.owner_type));
  RETURN true;
END $$;

-- Làm rỗng PII của dòng nhập (raw → '{}', data → NULL) cho lô đã committed/cancelled từ p_before trở về trước.
-- Giữ nguyên số dòng, external_id, row_hash, action, errors, target_id và tổng của lô (đối soát/audit).
CREATE FUNCTION app.retention_scrub_import_rows(p_before timestamptz, p_batch_limit integer, p_now timestamptz, p_correlation text)
  RETURNS TABLE (o_batch_id uuid, o_org_id uuid, o_rows integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b record; n integer;
BEGIN
  FOR b IN
    SELECT ib.id, ib.organization_id, ib.property_id FROM import_batches ib
    WHERE ib.status IN ('committed','cancelled') AND coalesce(ib.committed_at, ib.cancelled_at) <= p_before
      AND EXISTS (SELECT 1 FROM import_rows r WHERE r.organization_id = ib.organization_id AND r.batch_id = ib.id
                  AND (r.raw <> '{}'::jsonb OR r.data IS NOT NULL))
    ORDER BY coalesce(ib.committed_at, ib.cancelled_at), ib.id
    LIMIT least(greatest(p_batch_limit, 1), 500)
    FOR UPDATE OF ib SKIP LOCKED
  LOOP
    UPDATE import_rows r SET raw = '{}'::jsonb, data = NULL
     WHERE r.organization_id = b.organization_id AND r.batch_id = b.id AND (r.raw <> '{}'::jsonb OR r.data IS NOT NULL);
    GET DIAGNOSTICS n = ROW_COUNT;
    -- Job khác vừa làm rỗng lô này (snapshot của vòng lặp cũ hơn): không ghi audit/kết quả trùng.
    IF n = 0 THEN CONTINUE; END IF;
    INSERT INTO audit_events (id, organization_id, property_id, actor_type, action, entity_type, entity_id, correlation_id, after)
    VALUES (gen_random_uuid(), b.organization_id, b.property_id, 'worker', 'import_batch.rows_purged', 'import_batch', b.id,
            p_correlation, jsonb_build_object('rows', n));
    o_batch_id := b.id; o_org_id := b.organization_id; o_rows := n;
    RETURN NEXT;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION app.retention_claim_files(date, integer), app.retention_mark_file_deleted(uuid, date, timestamptz, text),
  app.retention_scrub_import_rows(timestamptz, integer, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.retention_claim_files(date, integer), app.retention_mark_file_deleted(uuid, date, timestamptz, text),
  app.retention_scrub_import_rows(timestamptz, integer, timestamptz, text) TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.retention_scrub_import_rows(timestamptz, integer, timestamptz, text);
DROP FUNCTION IF EXISTS app.retention_mark_file_deleted(uuid, date, timestamptz, text);
DROP FUNCTION IF EXISTS app.retention_claim_files(date, integer);
DROP INDEX IF EXISTS ix_files_retention_due;
ALTER TABLE files DROP CONSTRAINT IF EXISTS ck_files_deleted;
ALTER TABLE files DROP COLUMN IF EXISTS deleted_at;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
