// PLAN đợt 2 T-110 — bàn giao + phụ lục (ERD `handovers`, `meters`, `meter_readings`; SPEC-lease S-005…S-007, S-011…S-015).
// - Công tơ và chỉ số tạo ở đây (tối thiểu) vì biên bản bàn giao bắt buộc đủ chỉ số và sinh `meter_readings` nguồn
//   `handover`; thay công tơ, cảnh báo bất thường, tuyến chốt theo tầng ở T-112; FK `billing_period_id` ở T-114.
// - Hợp đồng chỉ `active` khi có biên bản `move_in` đã xác nhận (HANDOVER_REQUIRED) — kiểm ở lệnh và ở trigger.
// - Job nhắc hết hạn / phát hiện ở quá hạn đọc xuyên tổ chức qua hàm SECURITY DEFINER phạm vi hẹp (như app.expire_holds).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE meters (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('electric','water')),
  serial text CHECK (serial IS NULL OR length(btrim(serial)) BETWEEN 1 AND 60),
  installed_on date NOT NULL,
  removed_on date,
  initial_value numeric(14,3) NOT NULL DEFAULT 0 CHECK (initial_value >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_meters_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT fk_meters_unit FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id),
  CONSTRAINT ck_meters_removed CHECK (removed_on IS NULL OR removed_on >= installed_on)
);
CREATE UNIQUE INDEX uq_meters_active ON meters (organization_id, unit_id, kind) WHERE removed_on IS NULL;
CREATE TRIGGER trg_meters_updated BEFORE UPDATE ON meters FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE meter_readings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  meter_id uuid NOT NULL,
  billing_period_id uuid,
  handover_id uuid,
  read_on date NOT NULL,
  value numeric(14,3) NOT NULL CHECK (value >= 0),
  photo_file_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  source text NOT NULL CHECK (source IN ('handover','period','replacement','import')),
  entered_by uuid,
  approved_by uuid,
  anomaly_note text,
  anomaly_acknowledged_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_meter_readings_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_meter_readings_meter FOREIGN KEY (organization_id, property_id, meter_id)
    REFERENCES meters (organization_id, property_id, id),
  CONSTRAINT fk_meter_readings_entered_by FOREIGN KEY (organization_id, entered_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_meter_readings_approved_by FOREIGN KEY (organization_id, approved_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_meter_readings_approved CHECK (status <> 'approved' OR approved_by IS NOT NULL OR source = 'import'),
  CONSTRAINT ck_meter_readings_handover CHECK ((source = 'handover') = (handover_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_meter_readings_period ON meter_readings (organization_id, meter_id, billing_period_id)
  WHERE billing_period_id IS NOT NULL AND source = 'period';
CREATE INDEX ix_meter_readings_meter ON meter_readings (organization_id, meter_id, read_on);
CREATE TRIGGER trg_meter_readings_updated BEFORE UPDATE ON meter_readings FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE handovers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('move_in','move_out')),
  handed_over_on date NOT NULL,
  assets jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(assets) = 'array'),
  keys_count integer NOT NULL DEFAULT 0 CHECK (keys_count BETWEEN 0 AND 100),
  photo_file_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(photo_file_ids) <= 20),
  note text CHECK (note IS NULL OR length(note) <= 2000),
  staff_confirmed_by uuid,
  confirmed_at timestamptz,
  confirmed_by_tenant_at timestamptz,
  confirmation_method text CHECK (confirmation_method IN ('in_person','portal','import')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  readings_pending boolean NOT NULL DEFAULT false,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_handovers_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_handovers_kind UNIQUE (organization_id, lease_id, kind),
  CONSTRAINT fk_handovers_lease FOREIGN KEY (organization_id, property_id, lease_id) REFERENCES leases (organization_id, property_id, id),
  CONSTRAINT fk_handovers_staff FOREIGN KEY (organization_id, staff_confirmed_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_handovers_confirmed CHECK ((staff_confirmed_by IS NULL) = (confirmed_at IS NULL)),
  CONSTRAINT ck_handovers_pending CHECK (NOT readings_pending OR source = 'import')
);
ALTER TABLE meter_readings ADD CONSTRAINT fk_meter_readings_handover FOREIGN KEY (organization_id, handover_id)
  REFERENCES handovers (organization_id, id);
CREATE TRIGGER trg_handovers_updated BEFORE UPDATE ON handovers FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
-- Bất biến sau xác nhận (INV-G4), trừ: bỏ cờ readings_pending (true → false), ghi nhận người thuê xác nhận (một lần).
CREATE FUNCTION app.handover_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'biên bản bàn giao không xoá được' USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF OLD.confirmed_at IS NOT NULL AND (
       (to_jsonb(NEW) - ARRAY['readings_pending','confirmed_by_tenant_at','confirmation_method','updated_at','version'])
         <> (to_jsonb(OLD) - ARRAY['readings_pending','confirmed_by_tenant_at','confirmation_method','updated_at','version'])
       OR (NEW.readings_pending AND NOT OLD.readings_pending)
       OR (OLD.confirmed_by_tenant_at IS NOT NULL AND NEW.confirmed_by_tenant_at IS DISTINCT FROM OLD.confirmed_by_tenant_at)) THEN
    RAISE EXCEPTION 'biên bản bàn giao % đã xác nhận — không sửa', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_handovers_guard BEFORE UPDATE OR DELETE ON handovers FOR EACH ROW EXECUTE FUNCTION app.handover_guard();

-- Kích hoạt hợp đồng cần biên bản nhận phòng đã xác nhận (DOMAIN-MODEL §4, SPEC-lease S-005).
CREATE FUNCTION app.lease_activation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Chỉ áp cho đúng bước signed_awaiting_handover → active; chuyển sai bảng để trg_leases_guard báo INVALID_TRANSITION.
  IF NEW.status = 'active' AND OLD.status = 'signed_awaiting_handover' AND NOT EXISTS (
       SELECT 1 FROM handovers h WHERE h.organization_id = NEW.organization_id AND h.lease_id = NEW.id
         AND h.kind = 'move_in' AND h.confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'hợp đồng %: cần biên bản bàn giao nhận phòng trước khi kích hoạt', NEW.id
      USING ERRCODE = 'check_violation', HINT = 'HANDOVER_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_leases_activation BEFORE UPDATE OF status ON leases FOR EACH ROW EXECUTE FUNCTION app.lease_activation_guard();

-- Job: hợp đồng còn hiệu lực có phiên bản cuối hết hạn đúng sau N ngày (ngày địa phương theo cơ sở); N lấy từ
-- properties.settings.lease_reminder_days nếu cơ sở cấu hình, không thì p_days (mặc định đề xuất 30/7/0).
CREATE FUNCTION app.leases_expiring(p_now timestamptz, p_days integer[])
  RETURNS TABLE (organization_id uuid, property_id uuid, lease_id uuid, version_no integer, effective_to date, days_left integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT l.organization_id, l.property_id, l.id, v.version_no, v.effective_to,
           (v.effective_to - (p_now AT TIME ZONE p.timezone)::date)::int
    FROM leases l
    JOIN properties p ON p.organization_id = l.organization_id AND p.id = l.property_id
    JOIN LATERAL (SELECT lv.version_no, lv.effective_to FROM lease_versions lv
                  WHERE lv.organization_id = l.organization_id AND lv.lease_id = l.id AND lv.signed_at IS NOT NULL
                  ORDER BY lv.version_no DESC LIMIT 1) v ON true
    WHERE l.status IN ('active','notice_given') AND v.effective_to IS NOT NULL
      AND (v.effective_to - (p_now AT TIME ZONE p.timezone)::date) = ANY (
        CASE WHEN jsonb_typeof(p.settings -> 'lease_reminder_days') = 'array'
             THEN ARRAY(SELECT x::int FROM jsonb_array_elements_text(p.settings -> 'lease_reminder_days') x)
             ELSE p_days END)
  $$;
-- Job: quá hạn chưa bàn giao trả (INV-I4 cho hợp đồng): allocation của hợp đồng + allocation khác của phòng bị đụng.
CREATE FUNCTION app.leases_overstaying(p_now timestamptz)
  RETURNS TABLE (organization_id uuid, property_id uuid, lease_id uuid, allocation_id uuid, related_allocation_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT l.organization_id, l.property_id, l.id, a.id,
           (SELECT o.id FROM allocations o WHERE o.organization_id = a.organization_id AND o.unit_id = a.unit_id AND o.active
              AND o.id <> a.id AND lower(o.during) >= upper(a.during) ORDER BY lower(o.during), o.id LIMIT 1)
    FROM leases l
    JOIN properties p ON p.organization_id = l.organization_id AND p.id = l.property_id
    JOIN LATERAL (SELECT lv.effective_to FROM lease_versions lv
                  WHERE lv.organization_id = l.organization_id AND lv.lease_id = l.id AND lv.signed_at IS NOT NULL
                  ORDER BY lv.version_no DESC LIMIT 1) v ON true
    JOIN allocations a ON a.organization_id = l.organization_id AND a.source_type = 'lease' AND a.source_id = l.id
                      AND a.active AND a.kind = 'lease'
    WHERE l.status IN ('active','notice_given') AND v.effective_to IS NOT NULL
      AND v.effective_to < (p_now AT TIME ZONE p.timezone)::date
      AND NOT EXISTS (SELECT 1 FROM handovers h WHERE h.organization_id = l.organization_id AND h.lease_id = l.id
                        AND h.kind = 'move_out' AND h.confirmed_at IS NOT NULL)
  $$;
REVOKE ALL ON FUNCTION app.leases_expiring(timestamptz, integer[]), app.leases_overstaying(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.leases_expiring(timestamptz, integer[]), app.leases_overstaying(timestamptz) TO app_worker;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['meters','meter_readings','handovers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
CREATE POLICY meters_read ON meters FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR (app.actor_role() IN ('owner','manager','front_desk','accountant','maintenance')
             AND app.actor_can_see_property(property_id))));
CREATE POLICY meters_write ON meters FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
              AND app.actor_can_see_property(property_id));
CREATE POLICY meter_readings_read ON meter_readings FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR (app.actor_role() IN ('owner','manager','front_desk','accountant','maintenance')
             AND app.actor_can_see_property(property_id))));
CREATE POLICY meter_readings_write ON meter_readings FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
              AND app.actor_can_see_property(property_id));
CREATE POLICY handovers_read ON handovers FOR SELECT
  USING (organization_id = app.current_org() AND EXISTS (SELECT 1 FROM leases l
         WHERE l.organization_id = handovers.organization_id AND l.id = handovers.lease_id));
CREATE POLICY handovers_write ON handovers FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
              AND app.actor_can_see_property(property_id));
GRANT SELECT, INSERT, UPDATE ON meters, meter_readings, handovers TO app_runtime;
GRANT SELECT ON meters, meter_readings, handovers TO app_worker;
-- Worker mở ngoại lệ LEASE_OVERSTAY (policy tenant_isolation của 0004 đã giới hạn theo tổ chức).
GRANT INSERT ON exceptions TO app_worker;
`;

const DOWN = `
REVOKE INSERT ON exceptions FROM app_worker;
DROP FUNCTION IF EXISTS app.leases_overstaying(timestamptz), app.leases_expiring(timestamptz, integer[]);
DROP TRIGGER IF EXISTS trg_leases_activation ON leases;
DROP FUNCTION IF EXISTS app.lease_activation_guard();
ALTER TABLE IF EXISTS meter_readings DROP CONSTRAINT IF EXISTS fk_meter_readings_handover;
DROP TABLE IF EXISTS handovers, meter_readings, meters;
DROP FUNCTION IF EXISTS app.handover_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
