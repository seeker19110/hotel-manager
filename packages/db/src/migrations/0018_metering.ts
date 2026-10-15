// PLAN đợt 2 T-112 — dịch vụ và công tơ (ERD `service_prices`, `meter_events`, `billing_periods`; SPEC-metering-billing
// S-005…S-010, S-017). `billing_periods` tạo ở đây vì chỉ số kỳ thuộc về kỳ (FK); vòng đời kỳ (duyệt/phát hành/khoá) ở T-114.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE billing_periods (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewing','issued','locked')),
  preview_hash text CHECK (preview_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz,
  issued_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_billing_periods_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT uq_billing_periods_start UNIQUE (organization_id, property_id, period_start),
  CONSTRAINT fk_billing_periods_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_billing_periods_issued_by FOREIGN KEY (organization_id, issued_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_billing_periods_range CHECK (period_end >= period_start),
  CONSTRAINT ck_billing_periods_issued CHECK ((status IN ('issued','locked')) = (issued_at IS NOT NULL)),
  CONSTRAINT ex_billing_periods_no_overlap EXCLUDE USING gist (organization_id WITH =, property_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&)
);
CREATE TRIGGER trg_billing_periods_updated BEFORE UPDATE ON billing_periods FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
ALTER TABLE meter_readings ADD CONSTRAINT fk_meter_readings_period FOREIGN KEY (organization_id, property_id, billing_period_id)
  REFERENCES billing_periods (organization_id, property_id, id);
ALTER TABLE invoices ADD CONSTRAINT fk_invoices_billing_period FOREIGN KEY (organization_id, property_id, billing_period_id)
  REFERENCES billing_periods (organization_id, property_id, id);

-- Chỉ số kỳ: kỳ đã phát hành/khoá thì không ghi/sửa (PERIOD_ISSUED, SPEC-metering S-011).
CREATE FUNCTION app.meter_reading_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; pid uuid;
BEGIN
  pid := CASE WHEN TG_OP = 'DELETE' THEN OLD.billing_period_id ELSE NEW.billing_period_id END;
  IF TG_OP <> 'INSERT' AND OLD.billing_period_id IS NOT NULL THEN
    SELECT status INTO st FROM billing_periods WHERE organization_id = OLD.organization_id AND id = OLD.billing_period_id;
    IF st IN ('issued','locked') THEN
      RAISE EXCEPTION 'chỉ số thuộc kỳ đã phát hành' USING ERRCODE = '55000', HINT = 'PERIOD_ISSUED';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND pid IS NOT NULL THEN
    SELECT status INTO st FROM billing_periods WHERE organization_id = NEW.organization_id AND id = pid;
    IF st IN ('issued','locked') THEN
      RAISE EXCEPTION 'kỳ đã phát hành — không ghi chỉ số' USING ERRCODE = '55000', HINT = 'PERIOD_ISSUED';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_meter_readings_period BEFORE INSERT OR UPDATE OR DELETE ON meter_readings FOR EACH ROW
  EXECUTE FUNCTION app.meter_reading_period_guard();

CREATE TABLE service_prices (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  service_id uuid NOT NULL,
  unit_price numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  effective_from date NOT NULL,
  effective_to date,
  basis_note text CHECK (basis_note IS NULL OR length(basis_note) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_service_prices_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_service_prices_service FOREIGN KEY (organization_id, property_id, service_id)
    REFERENCES services (organization_id, property_id, id),
  CONSTRAINT fk_service_prices_created_by FOREIGN KEY (organization_id, created_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_service_prices_range CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ex_service_prices_no_overlap EXCLUDE USING gist (organization_id WITH =, service_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&)
);
CREATE TRIGGER trg_service_prices_updated BEFORE UPDATE ON service_prices FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE meter_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  meter_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('replacement')),
  occurred_on date NOT NULL,
  old_final_value numeric(14,3) NOT NULL CHECK (old_final_value >= 0),
  new_meter_id uuid NOT NULL,
  new_initial_value numeric(14,3) NOT NULL CHECK (new_initial_value >= 0),
  old_photo_file_id uuid,
  new_photo_file_id uuid,
  approved_by uuid NOT NULL,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_meter_events_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_meter_events_meter UNIQUE (organization_id, meter_id),
  CONSTRAINT fk_meter_events_meter FOREIGN KEY (organization_id, property_id, meter_id) REFERENCES meters (organization_id, property_id, id),
  CONSTRAINT fk_meter_events_new FOREIGN KEY (organization_id, property_id, new_meter_id)
    REFERENCES meters (organization_id, property_id, id),
  CONSTRAINT fk_meter_events_old_photo FOREIGN KEY (organization_id, old_photo_file_id) REFERENCES files (organization_id, id),
  CONSTRAINT fk_meter_events_new_photo FOREIGN KEY (organization_id, new_photo_file_id) REFERENCES files (organization_id, id),
  CONSTRAINT fk_meter_events_approved_by FOREIGN KEY (organization_id, approved_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_meter_events_new CHECK (new_meter_id <> meter_id)
);
CREATE TRIGGER trg_meter_events_append_only BEFORE UPDATE OR DELETE ON meter_events FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
ALTER TABLE meter_readings ADD CONSTRAINT fk_meter_readings_photo FOREIGN KEY (organization_id, photo_file_id)
  REFERENCES files (organization_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_periods','service_prices','meter_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
CREATE POLICY billing_periods_read ON billing_periods FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR (app.actor_role() IN ('owner','manager','accountant','front_desk','maintenance')
             AND app.actor_can_see_property(property_id))));
CREATE POLICY billing_periods_write ON billing_periods FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant')
              AND app.actor_can_see_property(property_id));
CREATE POLICY billing_periods_system ON billing_periods FOR INSERT TO app_worker WITH CHECK (organization_id = app.current_org());
CREATE POLICY service_prices_read ON service_prices FOR SELECT USING (organization_id = app.current_org());
CREATE POLICY service_prices_write ON service_prices FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
              AND app.actor_can_see_property(property_id));
CREATE POLICY meter_events_read ON meter_events FOR SELECT
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk','accountant','maintenance')
         AND app.actor_can_see_property(property_id));
CREATE POLICY meter_events_write ON meter_events FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
              AND app.actor_can_see_property(property_id));
GRANT SELECT, INSERT, UPDATE ON billing_periods, service_prices TO app_runtime;
GRANT SELECT, INSERT ON meter_events TO app_runtime;
GRANT SELECT, INSERT ON billing_periods TO app_worker;
GRANT SELECT ON service_prices, meter_events TO app_worker;
`;

const DOWN = `
ALTER TABLE meter_readings DROP CONSTRAINT IF EXISTS fk_meter_readings_photo;
DROP TABLE IF EXISTS meter_events, service_prices;
DROP TRIGGER IF EXISTS trg_meter_readings_period ON meter_readings;
DROP FUNCTION IF EXISTS app.meter_reading_period_guard();
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS fk_invoices_billing_period;
ALTER TABLE meter_readings DROP CONSTRAINT IF EXISTS fk_meter_readings_period;
DROP TABLE IF EXISTS billing_periods;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
