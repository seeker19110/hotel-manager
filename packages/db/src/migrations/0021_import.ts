// PLAN đợt 2 T-115 — import dữ liệu chuyển đổi (ERD `import_batches`, `import_rows`, `import_external_refs`; SPEC-import;
// DOMAIN-MODEL §7; INV-G4, INV-G5, INV-F1).
// - Lô: uploaded → validated → confirmed → committed; huỷ từ mọi trạng thái chưa commit; confirmed → validated khi commit lỗi
//   ràng buộc (CONFLICT_AT_COMMIT) hoặc khi kiểm lại; `committed`/`cancelled` bất biến.
// - Chống nhập lặp: UNIQUE (organization_id, property_id, kind, external_id) ở `import_external_refs` (nội dung khác ⇒ lỗi dòng).
// - File nguồn: `files.owner_type='import_batch'` chỉ owner/manager trong phạm vi cơ sở đọc được.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE import_batches (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('units','leases','meter_readings','opening_balances','reservations')),
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','validated','confirmed','committed','cancelled')),
  file_id uuid NOT NULL,
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_format text NOT NULL CHECK (file_format IN ('csv','xlsx')),
  header jsonb NOT NULL CHECK (jsonb_typeof(header) = 'array'),
  expected_totals jsonb CHECK (expected_totals IS NULL OR jsonb_typeof(expected_totals) = 'object'),
  actual_totals jsonb CHECK (actual_totals IS NULL OR jsonb_typeof(actual_totals) = 'object'),
  cutoff_on date CHECK (kind NOT IN ('opening_balances','meter_readings','leases') OR cutoff_on IS NOT NULL),
  uploaded_by uuid NOT NULL,
  confirmed_by uuid,
  confirmed_at timestamptz,
  committed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_import_batches_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_import_batches_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT fk_import_batches_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_import_batches_file FOREIGN KEY (organization_id, file_id) REFERENCES files (organization_id, id),
  CONSTRAINT fk_import_batches_uploaded_by FOREIGN KEY (organization_id, uploaded_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_import_batches_confirmed_by FOREIGN KEY (organization_id, confirmed_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_import_batches_confirmed CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)),
  CONSTRAINT ck_import_batches_confirm_status CHECK (status NOT IN ('confirmed','committed') OR confirmed_by IS NOT NULL),
  CONSTRAINT ck_import_batches_committed CHECK ((status = 'committed') = (committed_at IS NOT NULL)),
  CONSTRAINT ck_import_batches_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX ix_import_batches_status ON import_batches (organization_id, property_id, status);
CREATE TRIGGER trg_import_batches_updated BEFORE UPDATE ON import_batches FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE FUNCTION app.import_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lô nhập % không xoá được', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF OLD.status IN ('committed','cancelled') THEN
    RAISE EXCEPTION 'lô nhập % đã %', OLD.id, OLD.status USING ERRCODE = 'check_violation', HINT = 'INVALID_TRANSITION';
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.property_id <> OLD.property_id OR NEW.file_id <> OLD.file_id
     OR NEW.file_sha256 <> OLD.file_sha256 OR NEW.uploaded_by <> OLD.uploaded_by OR NEW.cutoff_on IS DISTINCT FROM OLD.cutoff_on
     OR NEW.header <> OLD.header THEN
    RAISE EXCEPTION 'lô nhập %: không đổi nguồn', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF NEW.status <> OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'uploaded' THEN ARRAY['validated','cancelled']
      WHEN 'validated' THEN ARRAY['validated','confirmed','cancelled']
      WHEN 'confirmed' THEN ARRAY['validated','committed','cancelled']
      ELSE ARRAY[]::text[] END;
    IF NOT NEW.status = ANY (allowed) THEN
      RAISE EXCEPTION 'lô nhập %: không thể chuyển % → %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation', HINT = 'INVALID_TRANSITION';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_import_batches_guard BEFORE UPDATE OR DELETE ON import_batches FOR EACH ROW
  EXECUTE FUNCTION app.import_batch_guard();

CREATE TABLE import_rows (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  row_no integer NOT NULL CHECK (row_no >= 1),
  raw jsonb NOT NULL CHECK (jsonb_typeof(raw) = 'object'),
  external_id text CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 200),
  row_hash text CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  action text CHECK (action IN ('create','skip_unchanged','skip_empty','error')),
  errors jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(errors) = 'array'),
  data jsonb,
  target_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_import_rows_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_import_rows_no UNIQUE (organization_id, batch_id, row_no),
  CONSTRAINT fk_import_rows_batch FOREIGN KEY (organization_id, property_id, batch_id)
    REFERENCES import_batches (organization_id, property_id, id),
  CONSTRAINT ck_import_rows_errors CHECK (action IS NULL OR (action = 'error') = (jsonb_array_length(errors) > 0))
);
CREATE TRIGGER trg_import_rows_updated BEFORE UPDATE ON import_rows FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
-- Dòng của lô đã commit/huỷ bất biến (trừ xoá dữ liệu PII theo hạn giữ: raw/data → '{}'/NULL).
CREATE FUNCTION app.import_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM import_batches WHERE organization_id = OLD.organization_id AND id = OLD.batch_id;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dòng nhập không xoá được' USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF st IN ('committed','cancelled') AND ((to_jsonb(NEW) - ARRAY['raw','data','updated_at','version'])
       <> (to_jsonb(OLD) - ARRAY['raw','data','updated_at','version']) OR NEW.raw <> '{}'::jsonb OR NEW.data IS NOT NULL) THEN
    RAISE EXCEPTION 'lô nhập đã % — dòng bất biến', st USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_import_rows_guard BEFORE UPDATE OR DELETE ON import_rows FOR EACH ROW EXECUTE FUNCTION app.import_row_guard();

CREATE TABLE import_external_refs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('units','leases','meter_readings','opening_balances','reservations')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  target_id uuid NOT NULL,
  row_hash text NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Theo cơ sở (lệch ERD có chủ đích): mỗi cơ sở có sổ cũ riêng, hai cơ sở cùng chủ hay trùng mã như "U-001".
  CONSTRAINT uq_import_external_refs UNIQUE (organization_id, property_id, kind, external_id),
  CONSTRAINT fk_import_external_refs_batch FOREIGN KEY (organization_id, property_id, batch_id)
    REFERENCES import_batches (organization_id, property_id, id)
);
CREATE TRIGGER trg_import_external_refs_append_only BEFORE UPDATE OR DELETE ON import_external_refs
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE import_external_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_external_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY import_batches_access ON import_batches FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
              AND app.actor_can_see_property(property_id));
CREATE POLICY import_rows_access ON import_rows FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
              AND app.actor_can_see_property(property_id));
CREATE POLICY import_external_refs_access ON import_external_refs FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
              AND app.actor_can_see_property(property_id));
GRANT SELECT, INSERT, UPDATE ON import_batches, import_rows TO app_runtime;
GRANT SELECT, INSERT ON import_external_refs TO app_runtime;

-- File nguồn của lô nhập: owner/manager trong phạm vi cơ sở (trước đây loại này bị chặn đọc hoàn toàn).
DROP POLICY tenant_isolation ON files;
CREATE POLICY tenant_isolation ON files
  USING (organization_id = app.current_org() AND CASE
           WHEN owner_type = 'identity_document'
             THEN app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)
           WHEN owner_type IN ('work_order','handover','meter_reading','task') THEN true
           WHEN owner_type = 'import_batch'
             THEN app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id)
           ELSE false
         END)
  WITH CHECK (organization_id = app.current_org());
`;

const DOWN = `
DROP POLICY tenant_isolation ON files;
CREATE POLICY tenant_isolation ON files
  USING (organization_id = app.current_org() AND CASE
           WHEN owner_type = 'identity_document'
             THEN app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)
           WHEN owner_type IN ('work_order','handover','meter_reading','task') THEN true
           ELSE false
         END)
  WITH CHECK (organization_id = app.current_org());
DROP TABLE IF EXISTS import_external_refs;
DROP TABLE IF EXISTS import_rows;
DROP FUNCTION IF EXISTS app.import_row_guard();
DROP TABLE IF EXISTS import_batches;
DROP FUNCTION IF EXISTS app.import_batch_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
