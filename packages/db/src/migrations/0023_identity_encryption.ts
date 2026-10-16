// T-202 (D-004) — số giấy tờ mã hoá tầng app: CSDL chỉ giữ ciphertext AES-256-GCM, khoá dùng, blind index HMAC và 4 ký
// tự cuối để hiển thị. Không có số rõ trong bảng, bản sao lưu, WAL hay log truy vấn. Chưa có dữ liệu thật: nếu còn hàng
// mang số rõ thì DỪNG (cần script mã hoá lại có khoá — không làm được bằng SQL), không âm thầm mất dữ liệu.
import { type Kysely, sql } from "kysely";

const UP = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM identity_documents WHERE doc_number IS NOT NULL) THEN
    RAISE EXCEPTION 'identity_documents còn số giấy tờ rõ: chạy script mã hoá lại (có HM_PII_KEYS) trước migration 0023';
  END IF;
END $$;
ALTER TABLE identity_documents DROP CONSTRAINT ck_identity_documents_number;
ALTER TABLE identity_documents DROP CONSTRAINT ck_identity_documents_anonymized;
ALTER TABLE identity_documents DROP COLUMN doc_number_masked;
ALTER TABLE identity_documents DROP COLUMN doc_number;
ALTER TABLE identity_documents
  ADD COLUMN doc_number_enc bytea CHECK (doc_number_enc IS NULL OR octet_length(doc_number_enc) BETWEEN 30 AND 200),
  ADD COLUMN doc_number_key_id smallint CHECK (doc_number_key_id IS NULL OR doc_number_key_id BETWEEN 1 AND 255),
  ADD COLUMN doc_number_hash bytea CHECK (doc_number_hash IS NULL OR octet_length(doc_number_hash) = 32),
  ADD COLUMN doc_number_last4 text CHECK (doc_number_last4 IS NULL OR doc_number_last4 ~ '^[0-9A-Z]{1,4}$'),
  ADD COLUMN nationality char(2) CHECK (nationality IS NULL OR nationality ~ '^[A-Z]{2}$'),
  -- Đủ bộ khi chưa ẩn danh; ẩn danh (INV-G7) xoá số, băm, 4 số cuối và ảnh, giữ tombstone.
  ADD CONSTRAINT ck_identity_documents_number CHECK (
    anonymized_at IS NOT NULL
    OR (doc_number_enc IS NOT NULL AND doc_number_key_id IS NOT NULL AND doc_number_hash IS NOT NULL
        AND doc_number_last4 IS NOT NULL)),
  ADD CONSTRAINT ck_identity_documents_anonymized CHECK (
    anonymized_at IS NULL
    OR (doc_number_enc IS NULL AND doc_number_key_id IS NULL AND doc_number_hash IS NULL AND doc_number_last4 IS NULL
        AND file_id IS NULL)),
  -- Khoá trong ciphertext (byte đầu) phải khớp cột key_id: không ghi lệch định dạng.
  ADD CONSTRAINT ck_identity_documents_key_byte CHECK (
    doc_number_enc IS NULL OR get_byte(doc_number_enc, 0) = doc_number_key_id);
CREATE INDEX ix_identity_documents_hash ON identity_documents (organization_id, doc_type, doc_number_hash)
  WHERE doc_number_hash IS NOT NULL;
`;

const DOWN = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM identity_documents WHERE doc_number_enc IS NOT NULL) THEN
    RAISE EXCEPTION 'identity_documents có số mã hoá: giải mã bằng script (có khoá) trước khi lùi migration 0023';
  END IF;
END $$;
DROP INDEX IF EXISTS ix_identity_documents_hash;
ALTER TABLE identity_documents DROP CONSTRAINT ck_identity_documents_key_byte;
ALTER TABLE identity_documents DROP CONSTRAINT ck_identity_documents_anonymized;
ALTER TABLE identity_documents DROP CONSTRAINT ck_identity_documents_number;
ALTER TABLE identity_documents DROP COLUMN nationality, DROP COLUMN doc_number_last4, DROP COLUMN doc_number_hash,
  DROP COLUMN doc_number_key_id, DROP COLUMN doc_number_enc;
ALTER TABLE identity_documents
  ADD COLUMN doc_number text CHECK (doc_number IS NULL OR length(btrim(doc_number)) BETWEEN 5 AND 30),
  ADD COLUMN doc_number_masked text GENERATED ALWAYS AS (repeat('*', greatest(length(doc_number) - 4, 0)) || right(doc_number, 4)) STORED,
  ADD CONSTRAINT ck_identity_documents_number CHECK (anonymized_at IS NOT NULL OR doc_number IS NOT NULL),
  ADD CONSTRAINT ck_identity_documents_anonymized CHECK (anonymized_at IS NULL OR (doc_number IS NULL AND file_id IS NULL));
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
