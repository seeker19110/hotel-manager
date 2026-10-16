// PLAN đợt 3 T-222 — xuất dữ liệu (SPEC-audit-reporting S-013…S-018; ERD `export_jobs`; D-019).
// - `export_jobs`: người yêu cầu tạo (`queued`), CHỈ worker đổi trạng thái (trigger vòng đời; app_runtime không có UPDATE);
//   chỉ người yêu cầu đọc được job của mình (RLS theo `requested_by = app.actor_id`), người khác ⇒ 0 hàng ⇒ 404.
// - File kết quả riêng tư: `files` thêm MIME `application/zip` (xuất toàn tổ chức) và nhánh policy `export_job` — chỉ chính
//   người yêu cầu (uploaded_by) thấy.
// - `app.expire_export_jobs`: worker chuyển `ready` quá hạn → `expired` cho mọi tổ chức (hàm hẹp, không BYPASSRLS).
import { type Kysely, sql } from "kysely";

const MIME_OLD = `'image/jpeg','image/png','image/webp','application/pdf','text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'`;

const FILES_POLICY = (exportBranch: boolean) => `
CREATE POLICY tenant_isolation ON files
  USING (organization_id = app.current_org() AND CASE
           WHEN owner_type = 'identity_document'
             THEN app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)
           WHEN owner_type IN ('work_order','handover','meter_reading','task') THEN true
           WHEN owner_type = 'import_batch'
             THEN app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id)
           WHEN owner_type = 'residence_notice'
             THEN app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)
           WHEN owner_type = 'payment_claim'
             THEN (app.actor_role() IN ('owner','manager','accountant','front_desk') AND app.actor_can_see_property(property_id))
                  OR (app.actor_role() = 'tenant' AND uploaded_by = nullif(current_setting('app.actor_id', true), '')::uuid)
           ${
             exportBranch
               ? `WHEN owner_type = 'export_job'
             THEN uploaded_by = nullif(current_setting('app.actor_id', true), '')::uuid`
               : ""
           }
           ELSE false
         END)
  WITH CHECK (organization_id = app.current_org());`;

const UP = `
CREATE TABLE export_jobs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid,
  requested_by uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receivables','collections','deposits','occupancy','audit','org_full')),
  format text NOT NULL CHECK (format IN ('csv','xlsx','zip')),
  filters jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(filters) = 'object'),
  scope_snapshot jsonb NOT NULL CHECK (jsonb_typeof(scope_snapshot) = 'object'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','expired')),
  file_key text,
  expires_at timestamptz,
  row_count bigint CHECK (row_count >= 0),
  failed_reason text CHECK (failed_reason IS NULL OR length(failed_reason) <= 200),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_export_jobs_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_export_jobs_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_export_jobs_requested_by FOREIGN KEY (organization_id, requested_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_export_jobs_file FOREIGN KEY (organization_id, file_key) REFERENCES files (organization_id, storage_key),
  CONSTRAINT ck_export_jobs_ready CHECK (status <> 'ready' OR (file_key IS NOT NULL AND expires_at IS NOT NULL AND completed_at IS NOT NULL)),
  CONSTRAINT ck_export_jobs_failed CHECK (status <> 'failed' OR failed_reason IS NOT NULL),
  CONSTRAINT ck_export_jobs_format CHECK ((kind = 'org_full') = (format = 'zip'))
);
CREATE INDEX ix_export_jobs_requester ON export_jobs (organization_id, requested_by, created_at DESC);
CREATE INDEX ix_export_jobs_ready_expiry ON export_jobs (expires_at) WHERE status = 'ready';
CREATE TRIGGER trg_export_jobs_updated BEFORE UPDATE ON export_jobs FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE FUNCTION app.export_job_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.format IS DISTINCT FROM OLD.format
     OR NEW.filters IS DISTINCT FROM OLD.filters OR NEW.scope_snapshot IS DISTINCT FROM OLD.scope_snapshot
     OR NEW.property_id IS DISTINCT FROM OLD.property_id THEN
    RAISE EXCEPTION 'export_jobs %: không đổi nội dung yêu cầu', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'queued' AND NEW.status IN ('running','failed'))
    OR (OLD.status = 'running' AND NEW.status IN ('ready','failed'))
    OR (OLD.status = 'ready' AND NEW.status = 'expired')) THEN
    RAISE EXCEPTION 'export_jobs %: không chuyển % → %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_export_jobs_transition BEFORE UPDATE ON export_jobs FOR EACH ROW
  EXECUTE FUNCTION app.export_job_transition();

ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY export_jobs_read ON export_jobs FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR requested_by = nullif(current_setting('app.actor_id', true), '')::uuid));
CREATE POLICY export_jobs_request ON export_jobs FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_org() AND status = 'queued'
              AND requested_by = nullif(current_setting('app.actor_id', true), '')::uuid);
CREATE POLICY export_jobs_worker_update ON export_jobs FOR UPDATE TO app_worker
  USING (organization_id = app.current_org()) WITH CHECK (organization_id = app.current_org());
GRANT SELECT, INSERT ON export_jobs TO app_runtime;
GRANT SELECT, UPDATE ON export_jobs TO app_worker;

CREATE FUNCTION app.expire_export_jobs(p_now timestamptz) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH x AS (UPDATE export_jobs SET status = 'expired' WHERE status = 'ready' AND expires_at <= p_now RETURNING 1)
    SELECT count(*)::int FROM x
  $$;
REVOKE ALL ON FUNCTION app.expire_export_jobs(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expire_export_jobs(timestamptz) TO app_worker;

ALTER TABLE files DROP CONSTRAINT files_mime_check;
ALTER TABLE files ADD CONSTRAINT files_mime_check CHECK (mime IN (${MIME_OLD}, 'application/zip'));
DROP POLICY tenant_isolation ON files;
${FILES_POLICY(true)}
`;

const DOWN = `
DROP POLICY tenant_isolation ON files;
${FILES_POLICY(false)}
DROP FUNCTION IF EXISTS app.expire_export_jobs(timestamptz);
DROP TABLE IF EXISTS export_jobs;
DROP FUNCTION IF EXISTS app.export_job_transition();
DELETE FROM files WHERE mime = 'application/zip';
ALTER TABLE files DROP CONSTRAINT files_mime_check;
ALTER TABLE files ADD CONSTRAINT files_mime_check CHECK (mime IN (${MIME_OLD}));
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
