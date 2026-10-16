// PLAN đợt 2 T-108 — chốt kỳ sổ (ERD `period_locks`; SPEC-ledger S-022, S-023, S-032; INV-F6, INV-G4) và điều chỉnh phiếu.
// 1) `period_locks`: khoá mọi `business_date` ≤ `locked_through` của cơ sở; mở khoá chỉ điền cột `released_*` một lần
//    (không xoá dòng). Trigger BEFORE INSERT trên `journal_entries`, `payments` từ chối ghi vào kỳ đã khoá (PERIOD_LOCKED);
//    `charges` (T-113) gắn cùng trigger khi có bảng.
// 2) Điều chỉnh sau phát hành = phiếu `kind='adjustment'` tham chiếu phiếu gốc (ERD §invoices, PLAN đợt 2 mục 7.3):
//    phiếu gốc giữ nguyên `total`, chỉ cộng dồn `adjusted_total` (≤ 0); số còn phải thu là cột sinh `open_amount` — một
//    công thức duy nhất cho phân bổ, khấu trừ cọc, đối soát, QR.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE period_locks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  locked_through date NOT NULL,
  locked_by uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  released_by uuid,
  released_at timestamptz,
  release_reason text CHECK (release_reason IS NULL OR length(btrim(release_reason)) BETWEEN 1 AND 1000),
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_period_locks_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_period_locks_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_period_locks_locked_by FOREIGN KEY (organization_id, locked_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_period_locks_released_by FOREIGN KEY (organization_id, released_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_period_locks_release CHECK ((released_at IS NULL) = (released_by IS NULL)
    AND (released_at IS NULL) = (release_reason IS NULL))
);
CREATE INDEX ix_period_locks_effective ON period_locks (organization_id, property_id, locked_through) WHERE released_at IS NULL;

-- Mỗi dòng mở khoá đúng một lần; không sửa gì khác, không xoá.
CREATE FUNCTION app.period_lock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_at IS NOT NULL
     OR NEW.released_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['released_by','released_at','release_reason'])
        <> (to_jsonb(OLD) - ARRAY['released_by','released_at','release_reason']) THEN
    RAISE EXCEPTION 'khoá kỳ %: chỉ mở khoá một lần, không sửa', OLD.id USING ERRCODE = 'check_violation', HINT = 'INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_period_locks_guard BEFORE UPDATE ON period_locks FOR EACH ROW EXECUTE FUNCTION app.period_lock_guard();
CREATE TRIGGER trg_period_locks_no_delete BEFORE DELETE OR TRUNCATE ON period_locks FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_mutation();

-- Ngày khoá hiệu lực của cơ sở (NULL = chưa khoá). Đọc theo ngữ cảnh tổ chức: policy SELECT của period_locks mở cho mọi
-- vai trò trong tổ chức (ngày khoá không nhạy cảm) để hàng rào áp cả với lễ tân/worker.
CREATE FUNCTION app.locked_through(p_org uuid, p_property uuid) RETURNS date LANGUAGE sql STABLE AS $$
  SELECT max(locked_through) FROM period_locks
  WHERE organization_id = p_org AND property_id = p_property AND released_at IS NULL
$$;
GRANT EXECUTE ON FUNCTION app.locked_through(uuid, uuid) TO app_runtime, app_worker;

CREATE FUNCTION app.check_period_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lt date := app.locked_through(NEW.organization_id, NEW.property_id);
BEGIN
  IF lt IS NOT NULL AND NEW.business_date <= lt THEN
    RAISE EXCEPTION 'kỳ đã khoá tới % (ngày kinh doanh %)', lt, NEW.business_date
      USING ERRCODE = 'check_violation', HINT = 'PERIOD_LOCKED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_journal_entries_period BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION app.check_period_open();
CREATE TRIGGER trg_payments_period BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION app.check_period_open();

ALTER TABLE period_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE period_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY period_locks_read ON period_locks FOR SELECT USING (organization_id = app.current_org());
CREATE POLICY period_locks_lock ON period_locks FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant')
              AND app.actor_can_see_property(property_id)
              AND locked_by = nullif(current_setting('app.actor_id', true), '')::uuid AND released_at IS NULL);
CREATE POLICY period_locks_unlock ON period_locks FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() = 'owner' AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND released_by = nullif(current_setting('app.actor_id', true), '')::uuid);
GRANT SELECT ON period_locks TO app_runtime, app_worker;
GRANT INSERT ON period_locks TO app_runtime;
GRANT UPDATE (released_by, released_at, release_reason) ON period_locks TO app_runtime;

-- 2) Điều chỉnh phiếu.
ALTER TABLE invoices ADD COLUMN adjusted_total bigint NOT NULL DEFAULT 0 CHECK (adjusted_total <= 0);
ALTER TABLE invoices ADD COLUMN open_amount bigint
  GENERATED ALWAYS AS (greatest(total + adjusted_total, 0) - allocated_total) STORED;
ALTER TABLE invoices DROP CONSTRAINT ck_invoices_allocated;
ALTER TABLE invoices ADD CONSTRAINT ck_invoices_allocated
  CHECK (allocated_total >= 0 AND allocated_total <= greatest(total + adjusted_total, 0));
CREATE OR REPLACE FUNCTION app.invoice_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['allocated_total','adjusted_total','open_amount','updated_at','version'])
     <> (to_jsonb(OLD) - ARRAY['allocated_total','adjusted_total','open_amount','updated_at','version']) THEN
    RAISE EXCEPTION 'phiếu % đã phát hành — không sửa được; dùng phiếu điều chỉnh (INV-G4)', OLD.id
      USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  -- Điều chỉnh chỉ cộng dồn giảm (≤ 0), không hoàn tác bằng UPDATE.
  IF NEW.adjusted_total > OLD.adjusted_total THEN
    RAISE EXCEPTION 'phiếu %: điều chỉnh chỉ cộng dồn', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
DROP INDEX IF EXISTS ix_invoices_open;
CREATE INDEX ix_invoices_open ON invoices (organization_id, property_id) WHERE open_amount > 0;
`;

const DOWN = `
DROP INDEX IF EXISTS ix_invoices_open;
CREATE INDEX ix_invoices_open ON invoices (organization_id, property_id) WHERE allocated_total < total;
CREATE OR REPLACE FUNCTION app.invoice_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['allocated_total','updated_at','version']) <> (to_jsonb(OLD) - ARRAY['allocated_total','updated_at','version']) THEN
    RAISE EXCEPTION 'phiếu % đã phát hành — không sửa được; dùng phiếu điều chỉnh (INV-G4)', OLD.id
      USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE invoices DROP CONSTRAINT ck_invoices_allocated;
ALTER TABLE invoices ADD CONSTRAINT ck_invoices_allocated CHECK (allocated_total >= 0 AND allocated_total <= greatest(total, 0));
ALTER TABLE invoices DROP COLUMN open_amount;
ALTER TABLE invoices DROP COLUMN adjusted_total;
DROP TRIGGER IF EXISTS trg_payments_period ON payments;
DROP TRIGGER IF EXISTS trg_journal_entries_period ON journal_entries;
DROP FUNCTION IF EXISTS app.check_period_open();
DROP FUNCTION IF EXISTS app.locked_through(uuid, uuid);
DROP TABLE IF EXISTS period_locks;
DROP FUNCTION IF EXISTS app.period_lock_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
