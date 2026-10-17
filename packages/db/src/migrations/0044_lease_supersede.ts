// PLAN đợt 3 T-224 — phụ lục cho hợp đồng không thời hạn (SPEC-lease S-027; D-007; INV-G4 ngoại lệ có kiểm soát).
// - `superseded_on`: đặt MỘT lần (NULL → ngày) khi phụ lục thay phiên bản KHÔNG thời hạn (`effective_to IS NULL`); điều
//   khoản + `terms_hash` không đổi. Phiên bản có `effective_to` xác định không dùng cột này (S-011/S-012).
// - `effective_until` (cột sinh) = ngày cuối hiệu lực thực = least(effective_to, superseded_on − 1) — billing/công tơ và
//   EXCLUDE chống chồng phiên bản dùng cột này.
// - Trigger bất biến sau ký: ngoại lệ duy nhất là đặt superseded_on từ NULL (mọi cột khác giữ nguyên); đặt lần hai, xoá về
//   NULL hay sửa cột khác ⇒ DOCUMENT_IMMUTABLE.
import { type Kysely, sql } from "kysely";

const GUARD_OLD = `
CREATE OR REPLACE FUNCTION app.lease_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'điều khoản hợp đồng (phiên bản %) đã ký — lập phụ lục', OLD.version_no
      USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.lease_id <> OLD.lease_id OR NEW.version_no <> OLD.version_no OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'phiên bản %: không đổi khoá', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;`;

const UP = `
ALTER TABLE lease_versions ADD COLUMN superseded_on date;
ALTER TABLE lease_versions ADD CONSTRAINT ck_lease_versions_superseded
  CHECK (superseded_on IS NULL OR (effective_to IS NULL AND superseded_on > effective_from));
-- least() bỏ qua NULL: không thời hạn + chưa bị thay ⇒ NULL (mở); có hạn ⇒ effective_to; bị thay ⇒ superseded_on − 1.
ALTER TABLE lease_versions ADD COLUMN effective_until date GENERATED ALWAYS AS (least(effective_to, superseded_on - 1)) STORED;
ALTER TABLE lease_versions DROP CONSTRAINT ex_lease_versions_no_overlap;
ALTER TABLE lease_versions ADD CONSTRAINT ex_lease_versions_no_overlap EXCLUDE USING gist (organization_id WITH =, lease_id WITH =,
  daterange(effective_from, effective_until, '[]') WITH &&);

CREATE OR REPLACE FUNCTION app.lease_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL THEN
    -- D-007: ngoại lệ duy nhất — đặt superseded_on từ NULL đúng một lần, không đổi gì khác.
    IF TG_OP = 'UPDATE' AND OLD.superseded_on IS NULL AND NEW.superseded_on IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['superseded_on','effective_until','updated_at','version'])
         = (to_jsonb(OLD) - ARRAY['superseded_on','effective_until','updated_at','version']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'điều khoản hợp đồng (phiên bản %) đã ký — lập phụ lục', OLD.version_no
      USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.lease_id <> OLD.lease_id OR NEW.version_no <> OLD.version_no OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'phiên bản %: không đổi khoá', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF NEW.superseded_on IS DISTINCT FROM OLD.superseded_on THEN
    RAISE EXCEPTION 'phiên bản %: superseded_on chỉ đặt cho phiên bản đã ký', OLD.id
      USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
`;

// Down: phiên bản không thời hạn đã bị thay phải "đóng" lại bằng effective_to = superseded_on − 1 TRƯỚC khi bỏ cột — nếu không,
// dựng lại EXCLUDE trên (effective_from, effective_to) thấy v1 và phụ lục cùng mở ⇒ 23P01. Trigger bất biến chặn UPDATE hàng đã ký,
// nên chỉ tắt đúng trigger đó quanh một câu UPDATE hẹp (hàng có superseded_on), cùng transaction của migration.
// (`terms_snapshot`/`terms_hash` — bản ký — không đổi; chỉ cột hiệu lực suy ra được.)
const DOWN = `
${GUARD_OLD}
ALTER TABLE lease_versions DROP CONSTRAINT ex_lease_versions_no_overlap;
ALTER TABLE lease_versions DROP CONSTRAINT ck_lease_versions_superseded;
ALTER TABLE lease_versions DISABLE TRIGGER trg_lease_versions_guard;
UPDATE lease_versions SET effective_to = superseded_on - 1 WHERE superseded_on IS NOT NULL;
ALTER TABLE lease_versions ENABLE TRIGGER trg_lease_versions_guard;
ALTER TABLE lease_versions DROP COLUMN effective_until;
ALTER TABLE lease_versions DROP COLUMN superseded_on;
ALTER TABLE lease_versions ADD CONSTRAINT ex_lease_versions_no_overlap EXCLUDE USING gist (organization_id WITH =, lease_id WITH =,
  daterange(effective_from, effective_to, '[]') WITH &&);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
