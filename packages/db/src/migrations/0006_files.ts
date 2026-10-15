// T-011 — file riêng tư + giấy tờ nhận dạng (ERD files, identity_documents; TM-06, TM-07; kế hoạch §15–§16).
// RLS lớp 3 (vai trò) cho dữ liệu nhạy cảm: chỉ owner/manager/front_desk đọc giấy tờ — buồng phòng/kỹ thuật/kế toán
// không thấy hàng nào kể cả khi truy vấn thẳng (phòng thủ hai lớp cùng authorize() ở app).
import { type Kysely, sql } from "kysely";

const UP = `
-- Vai trò của người đang thao tác (app.actor_id = membership id, đặt bởi withTenant). Không có → NULL.
CREATE FUNCTION app.actor_role() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT m.role FROM memberships m
    WHERE m.id = nullif(current_setting('app.actor_id', true), '')::uuid
      AND m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
      AND m.status = 'active'
  $$;
REVOKE ALL ON FUNCTION app.actor_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.actor_role() TO app_runtime, app_worker;

CREATE TABLE files (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid,
  owner_type text NOT NULL CHECK (owner_type IN ('work_order','handover','meter_reading','identity_document','residence_notice',
    'payment_claim','lease_settlement','import_batch','export_job','task')),
  owner_id uuid,
  mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf','text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending_scan' CHECK (status IN ('pending_scan','ready','rejected')),
  storage_key text NOT NULL,
  exif_stripped boolean NOT NULL DEFAULT false,
  uploaded_by uuid,
  scanned_at timestamptz,
  reject_reason text,
  delete_after date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_files_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_files_key UNIQUE (storage_key),
  CONSTRAINT uq_files_org_key UNIQUE (organization_id, storage_key),
  CONSTRAINT fk_files_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_files_uploaded_by FOREIGN KEY (organization_id, uploaded_by) REFERENCES memberships (organization_id, id),
  -- Khoá object luôn có tiền tố tổ chức (IND-SAAS-003).
  CONSTRAINT ck_files_key_prefix CHECK (starts_with(storage_key, organization_id::text || '/')),
  CONSTRAINT ck_files_exif CHECK (status <> 'ready' OR mime NOT LIKE 'image/%' OR exif_stripped),
  CONSTRAINT ck_files_rejected CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);
CREATE INDEX ix_files_owner ON files (organization_id, owner_type, owner_id);
CREATE TRIGGER trg_files_updated BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE identity_documents (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid,
  person_id uuid NOT NULL,
  doc_type text NOT NULL CHECK (doc_type IN ('cccd','passport','other')),
  doc_number text CHECK (doc_number IS NULL OR length(btrim(doc_number)) BETWEEN 5 AND 30),
  doc_number_masked text GENERATED ALWAYS AS (repeat('*', greatest(length(doc_number) - 4, 0)) || right(doc_number, 4)) STORED,
  file_id uuid,
  retention_until date,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_identity_documents_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_identity_documents_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_identity_documents_person FOREIGN KEY (organization_id, person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT fk_identity_documents_file FOREIGN KEY (organization_id, file_id) REFERENCES files (organization_id, id),
  -- Ẩn danh (INV-G7): xoá số và ảnh, giữ tombstone.
  CONSTRAINT ck_identity_documents_number CHECK (anonymized_at IS NOT NULL OR doc_number IS NOT NULL),
  CONSTRAINT ck_identity_documents_anonymized CHECK (anonymized_at IS NULL OR (doc_number IS NULL AND file_id IS NULL))
);
CREATE INDEX ix_identity_documents_person ON identity_documents (organization_id, person_id);
CREATE TRIGGER trg_identity_documents_updated BEFORE UPDATE ON identity_documents FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_documents FORCE ROW LEVEL SECURITY;
-- files: tenant + file giấy tờ chỉ cho vai trò đọc giấy tờ.
CREATE POLICY tenant_isolation ON files
  USING (organization_id = app.current_org()
         AND (owner_type <> 'identity_document' OR app.actor_role() IN ('owner','manager','front_desk')))
  WITH CHECK (organization_id = app.current_org());
-- identity_documents: tenant + vai trò (SPEC-access 5.3 "Đọc identity_documents"; tenant đọc phần mình thuộc đợt portal).
CREATE POLICY tenant_isolation ON identity_documents
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk'))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk'));

GRANT SELECT, INSERT, UPDATE ON files, identity_documents TO app_runtime;
`;

const DOWN = `
DROP TABLE IF EXISTS identity_documents, files;
DROP FUNCTION IF EXISTS app.actor_role();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
