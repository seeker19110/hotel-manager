// PLAN đợt 2 T-114 — vòng đời kỳ thu (ERD `billing_periods`, `charges`; SPEC-metering-billing S-002…S-004, S-011…S-015;
// DOMAIN-MODEL §4; INV-F1, INV-F6, INV-G3, INV-G4).
// - Kỳ: draft → reviewing → issued → locked; reviewing → draft; locked → issued (chỉ cùng lúc mở khoá sổ).
// - MỘT cơ chế khoá: `status='locked'` ⇔ có `period_locks` hiệu lực phủ `period_end` (constraint trigger deferred).
// - `charges`: snapshot dòng phải thu; bất biến khi đã có dòng phiếu trỏ tới; ghi vào kỳ đã khoá ⇒ PERIOD_LOCKED.
// - Job tạo kỳ theo tháng dương lịch của cơ sở (giờ địa phương), chạy lại không trùng (UNIQUE period_start).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.billing_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
  IF NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end OR NEW.property_id <> OLD.property_id THEN
    RAISE EXCEPTION 'kỳ thu %: không đổi khoảng ngày', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF NEW.status <> OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'draft' THEN ARRAY['reviewing']
      WHEN 'reviewing' THEN ARRAY['draft','issued']
      WHEN 'issued' THEN ARRAY['locked']
      WHEN 'locked' THEN ARRAY['issued']
      ELSE ARRAY[]::text[] END;
    IF NOT NEW.status = ANY (allowed) THEN
      RAISE EXCEPTION 'kỳ thu %: không thể chuyển % → %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation', HINT = 'INVALID_TRANSITION';
    END IF;
  END IF;
  -- Phát hành theo thứ tự tháng (lượng tiêu thụ lùi về chỉ số đã duyệt gần nhất ⇒ ngược thứ tự là tính trùng).
  IF NEW.status = 'issued' AND OLD.status = 'reviewing' AND EXISTS (SELECT 1 FROM billing_periods b
       WHERE b.organization_id = NEW.organization_id AND b.property_id = NEW.property_id AND b.period_start < NEW.period_start
         AND b.status IN ('draft','reviewing')) THEN
    RAISE EXCEPTION 'kỳ thu %: còn kỳ trước chưa phát hành', OLD.id USING ERRCODE = 'check_violation', HINT = 'INVALID_TRANSITION';
  END IF;
  IF OLD.status IN ('issued','locked') AND (NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
       OR NEW.preview_hash IS DISTINCT FROM OLD.preview_hash) THEN
    RAISE EXCEPTION 'kỳ thu % đã phát hành', OLD.id USING ERRCODE = '55000', HINT = 'PERIOD_ISSUED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_billing_periods_guard BEFORE UPDATE ON billing_periods FOR EACH ROW EXECUTE FUNCTION app.billing_period_guard();
CREATE TRIGGER trg_billing_periods_no_delete BEFORE DELETE OR TRUNCATE ON billing_periods FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_mutation();

CREATE FUNCTION app.check_billing_period_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lt date := app.locked_through(NEW.organization_id, NEW.property_id);
BEGIN
  IF NEW.status = 'locked' AND NOT (lt IS NOT NULL AND lt >= NEW.period_end) THEN
    RAISE EXCEPTION 'kỳ thu % khoá nhưng sổ chưa khoá tới %', NEW.id, NEW.period_end
      USING ERRCODE = 'check_violation', HINT = 'INVALID_TRANSITION';
  END IF;
  IF NEW.status IN ('issued','draft','reviewing') AND lt IS NOT NULL AND lt >= NEW.period_end THEN
    RAISE EXCEPTION 'kỳ thu % nằm trong khoảng sổ đã khoá nhưng không ở trạng thái locked', NEW.id
      USING ERRCODE = 'check_violation', HINT = 'INVALID_TRANSITION';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_billing_periods_lock AFTER INSERT OR UPDATE ON billing_periods DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_billing_period_lock();

CREATE TABLE charges (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('billing_period','stay','lease')),
  billing_period_id uuid,
  stay_id uuid,
  lease_id uuid,
  lease_version_id uuid,
  service_id uuid,
  kind text NOT NULL CHECK (kind IN ('room','utility','service','fee','discount')),
  revenue_account text NOT NULL CHECK (revenue_account IN ('REV_ROOM','REV_UTIL','REV_SERVICE','REV_FEE','DISCOUNT')),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  business_date date NOT NULL,
  period_from date,
  period_to date,
  quantity numeric(18,4) NOT NULL DEFAULT 1,
  unit_price numeric(18,4) NOT NULL,
  denominator integer CHECK (denominator IS NULL OR denominator BETWEEN 1 AND 31),
  amount bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'VND',
  rounding_rule text NOT NULL DEFAULT 'HALF_UP_1' CHECK (rounding_rule IN ('HALF_UP_1','HALF_UP_1000')),
  formula_version integer NOT NULL DEFAULT 1 CHECK (formula_version >= 1),
  tax_profile_id uuid,
  reading_ids uuid[],
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  created_by uuid,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_charges_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT uq_charges_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_charges_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_charges_period FOREIGN KEY (organization_id, property_id, billing_period_id)
    REFERENCES billing_periods (organization_id, property_id, id),
  CONSTRAINT fk_charges_lease FOREIGN KEY (organization_id, property_id, lease_id) REFERENCES leases (organization_id, property_id, id),
  CONSTRAINT fk_charges_lease_version FOREIGN KEY (organization_id, property_id, lease_version_id)
    REFERENCES lease_versions (organization_id, property_id, id),
  CONSTRAINT fk_charges_service FOREIGN KEY (organization_id, property_id, service_id) REFERENCES services (organization_id, property_id, id),
  CONSTRAINT fk_charges_voided_by FOREIGN KEY (organization_id, voided_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_charges_created_by FOREIGN KEY (organization_id, created_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_charges_period CHECK (period_to IS NULL OR period_from IS NULL OR period_to >= period_from),
  CONSTRAINT ck_charges_amount CHECK ((kind = 'discount' AND amount <= 0) OR (kind <> 'discount' AND amount >= 0)),
  CONSTRAINT ck_charges_source CHECK (num_nonnulls(billing_period_id, stay_id, lease_id) >= 1
    AND (source_type <> 'billing_period' OR (billing_period_id IS NOT NULL AND lease_id IS NOT NULL))
    AND (source_type <> 'stay' OR stay_id IS NOT NULL)
    AND (source_type <> 'lease' OR lease_id IS NOT NULL)),
  CONSTRAINT ck_charges_void CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);
CREATE INDEX ix_charges_period ON charges (organization_id, billing_period_id);
CREATE TRIGGER trg_charges_period BEFORE INSERT ON charges FOR EACH ROW EXECUTE FUNCTION app.check_period_open();
ALTER TABLE invoice_lines ADD CONSTRAINT fk_invoice_lines_charge FOREIGN KEY (organization_id, charge_id) REFERENCES charges (organization_id, id);
-- Charge đã lên phiếu thì bất biến (INV-G4); chưa lên phiếu chỉ được huỷ có lý do.
CREATE FUNCTION app.charge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR EXISTS (SELECT 1 FROM invoice_lines il WHERE il.organization_id = OLD.organization_id AND il.charge_id = OLD.id)
     OR (to_jsonb(NEW) - ARRAY['voided_at','voided_by','void_reason']) <> (to_jsonb(OLD) - ARRAY['voided_at','voided_by','void_reason']) THEN
    RAISE EXCEPTION 'khoản phải thu % đã lên phiếu hoặc chỉ được huỷ', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_charges_guard BEFORE UPDATE OR DELETE ON charges FOR EACH ROW EXECUTE FUNCTION app.charge_guard();

ALTER TABLE charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE charges FORCE ROW LEVEL SECURITY;
CREATE POLICY charges_read ON charges FOR SELECT
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant','front_desk')
         AND app.actor_can_see_property(property_id));
CREATE POLICY charges_write ON charges FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant','front_desk')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant','front_desk')
              AND app.actor_can_see_property(property_id));
GRANT SELECT, INSERT, UPDATE ON charges TO app_runtime;

-- Kế toán phát hành kỳ (ma trận billing.issue) ⇒ duyệt chỉ số kỳ: chỉ được chuyển sang approved, không sửa giá trị.
CREATE POLICY meter_readings_approve ON meter_readings FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() = 'accountant' AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() = 'accountant' AND app.actor_can_see_property(property_id)
              AND status = 'approved');
CREATE FUNCTION app.meter_reading_accountant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.actor_role() = 'accountant' AND ((to_jsonb(NEW) - ARRAY['status','approved_by','version','updated_at'])
       <> (to_jsonb(OLD) - ARRAY['status','approved_by','version','updated_at']) OR NEW.status <> 'approved') THEN
    RAISE EXCEPTION 'kế toán chỉ duyệt chỉ số, không sửa' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_meter_readings_accountant BEFORE UPDATE ON meter_readings FOR EACH ROW
  EXECUTE FUNCTION app.meter_reading_accountant_guard();

-- Job tạo kỳ: cơ sở cho thuê chưa có kỳ của tháng hiện tại (giờ địa phương).
CREATE FUNCTION app.properties_due_period(p_now timestamptz)
  RETURNS TABLE (organization_id uuid, property_id uuid, period_start date, period_end date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT p.organization_id, p.id, m.s, (m.s + interval '1 month' - interval '1 day')::date
    FROM properties p
    CROSS JOIN LATERAL (SELECT date_trunc('month', (p_now AT TIME ZONE p.timezone))::date AS s) m
    WHERE p.template IN ('rental','mixed') AND p.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM billing_periods b WHERE b.organization_id = p.organization_id AND b.property_id = p.id
                        AND b.period_start = m.s)
  $$;
REVOKE ALL ON FUNCTION app.properties_due_period(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.properties_due_period(timestamptz) TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.properties_due_period(timestamptz);
DROP TRIGGER IF EXISTS trg_meter_readings_accountant ON meter_readings;
DROP FUNCTION IF EXISTS app.meter_reading_accountant_guard();
DROP POLICY IF EXISTS meter_readings_approve ON meter_readings;
ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS fk_invoice_lines_charge;
DROP TABLE IF EXISTS charges;
DROP FUNCTION IF EXISTS app.charge_guard();
DROP TRIGGER IF EXISTS trg_billing_periods_lock ON billing_periods;
DROP FUNCTION IF EXISTS app.check_billing_period_lock();
DROP TRIGGER IF EXISTS trg_billing_periods_no_delete ON billing_periods;
DROP TRIGGER IF EXISTS trg_billing_periods_guard ON billing_periods;
DROP FUNCTION IF EXISTS app.billing_period_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
