// PLAN đợt 2 T-109 — hợp đồng thuê (ERD `leases`, `lease_versions`, `lease_occupants`, `services`; SPEC-lease S-001…S-004,
// S-008…S-010, S-020, S-022…S-024; DOMAIN-MODEL §4 vòng đời hợp đồng; INV-G4, INV-I1).
// - Vòng đời hợp đồng kiểm ở CSDL (trigger) như ở domain (`leaseMachine`); điều khoản bất biến sau ký (lease_versions).
// - Đúng một người đại diện đang hiệu lực = `leases.representative_person_id` (constraint trigger deferred).
// - Giữ chỗ hợp đồng được để mở cuối (hợp đồng không thời hạn) — nới CHECK của 0004 cho `hold` nguồn `lease`.
// - `persons` là PII: buồng phòng/bảo trì/người thuê không đọc hồ sơ người khác (SPEC-lease §4, S-009).
// - FK `deposits.lease_id`, `invoices.lease_id` → `leases` (đã hẹn ở 0010/0011).
// - `services` (danh mục dịch vụ) tạo ở đây vì điều khoản hợp đồng tham chiếu; đơn giá hiệu lực (`service_prices`) ở T-112.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.actor_person_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT m.person_id FROM memberships m
    WHERE m.id = nullif(current_setting('app.actor_id', true), '')::uuid
      AND m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
      AND m.status = 'active'
  $$;
REVOKE ALL ON FUNCTION app.actor_person_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.actor_person_id() TO app_runtime, app_worker;

-- PII: đọc hồ sơ người theo vai trò. Ngữ cảnh hệ thống (không actor: worker, webhook) vẫn đọc trong tổ chức.
DROP POLICY tenant_isolation ON persons;
CREATE POLICY persons_read ON persons FOR SELECT
  USING (organization_id = app.current_org() AND (
    nullif(current_setting('app.actor_id', true), '') IS NULL
    OR app.actor_role() IN ('owner','manager','front_desk','accountant')
    OR id = app.actor_person_id()));
CREATE POLICY persons_insert ON persons FOR INSERT WITH CHECK (organization_id = app.current_org());
CREATE POLICY persons_update ON persons FOR UPDATE
  USING (organization_id = app.current_org()) WITH CHECK (organization_id = app.current_org());
CREATE POLICY persons_delete ON persons FOR DELETE USING (organization_id = app.current_org());

CREATE TABLE services (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 30),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('fixed_per_unit','per_person','metered','one_time')),
  revenue_account text NOT NULL CHECK (revenue_account IN ('REV_ROOM','REV_UTIL','REV_SERVICE','REV_FEE')),
  meter_kind text CHECK (meter_kind IN ('electric','water')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_services_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT fk_services_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT ck_services_meter CHECK ((kind = 'metered') = (meter_kind IS NOT NULL))
);
CREATE UNIQUE INDEX uq_services_code ON services (organization_id, property_id, lower(code)) WHERE archived_at IS NULL;
CREATE TRIGGER trg_services_updated BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE leases (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  number text NOT NULL CHECK (length(btrim(number)) >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_signature','signed_awaiting_handover','active',
                                                         'notice_given','settling','closed','cancelled')),
  signed_on date,
  billing_start_on date NOT NULL,
  planned_move_out_on date,
  moved_out_on date,
  representative_person_id uuid NOT NULL,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 1000),
  created_by uuid,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_leases_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_leases_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT uq_leases_number UNIQUE (organization_id, property_id, number),
  CONSTRAINT fk_leases_unit FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id),
  CONSTRAINT fk_leases_representative FOREIGN KEY (organization_id, representative_person_id)
    REFERENCES persons (organization_id, id),
  CONSTRAINT fk_leases_created_by FOREIGN KEY (organization_id, created_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_leases_signed CHECK (status NOT IN ('signed_awaiting_handover','active','notice_given','settling','closed')
    OR signed_on IS NOT NULL),
  CONSTRAINT ck_leases_moved_out CHECK (moved_out_on IS NULL OR status IN ('settling','closed')),
  CONSTRAINT ck_leases_cancel CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL))
);
CREATE INDEX ix_leases_unit ON leases (organization_id, unit_id, status);
CREATE TRIGGER trg_leases_updated BEFORE UPDATE ON leases FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Vòng đời (khớp leaseMachine) + mốc đã ký không đổi.
CREATE FUNCTION app.lease_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed text[];
BEGIN
  IF NEW.unit_id <> OLD.unit_id OR NEW.number <> OLD.number OR NEW.property_id <> OLD.property_id THEN
    RAISE EXCEPTION 'hợp đồng %: không đổi phòng/số', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF OLD.status NOT IN ('draft','pending_signature') AND (NEW.representative_person_id <> OLD.representative_person_id
       OR NEW.billing_start_on <> OLD.billing_start_on OR NEW.signed_on IS DISTINCT FROM OLD.signed_on) THEN
    RAISE EXCEPTION 'hợp đồng % đã ký: không sửa người đại diện/mốc ngày — lập phụ lục', OLD.id
      USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF NEW.status <> OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'draft' THEN ARRAY['pending_signature','cancelled']
      WHEN 'pending_signature' THEN ARRAY['signed_awaiting_handover','cancelled']
      WHEN 'signed_awaiting_handover' THEN ARRAY['active','cancelled']
      WHEN 'active' THEN ARRAY['notice_given','settling']
      WHEN 'notice_given' THEN ARRAY['settling']
      WHEN 'settling' THEN ARRAY['closed']
      ELSE ARRAY[]::text[] END;
    IF NOT NEW.status = ANY (allowed) THEN
      RAISE EXCEPTION 'hợp đồng %: không thể chuyển % → %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation', HINT = 'INVALID_TRANSITION';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_leases_guard BEFORE UPDATE ON leases FOR EACH ROW EXECUTE FUNCTION app.lease_guard();
CREATE TRIGGER trg_leases_no_delete BEFORE DELETE OR TRUNCATE ON leases FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

CREATE TABLE lease_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  kind text NOT NULL CHECK (kind IN ('original','appendix')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  effective_from date NOT NULL,
  effective_to date,
  rent_amount bigint NOT NULL CHECK (rent_amount >= 0),
  billing_cycle text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly')),
  deposit_amount bigint NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  services jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(services) = 'array'),
  terms_snapshot jsonb,
  terms_hash text CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
  signed_at timestamptz,
  created_by uuid,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_lease_versions_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT uq_lease_versions_no UNIQUE (organization_id, lease_id, version_no),
  CONSTRAINT fk_lease_versions_lease FOREIGN KEY (organization_id, property_id, lease_id)
    REFERENCES leases (organization_id, property_id, id),
  CONSTRAINT fk_lease_versions_created_by FOREIGN KEY (organization_id, created_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_lease_versions_range CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ck_lease_versions_signed CHECK ((signed_at IS NULL) = (terms_hash IS NULL)
    AND (signed_at IS NULL) = (terms_snapshot IS NULL)),
  CONSTRAINT ex_lease_versions_no_overlap EXCLUDE USING gist (organization_id WITH =, lease_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&)
);
CREATE TRIGGER trg_lease_versions_updated BEFORE UPDATE ON lease_versions FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
-- Bất biến sau ký (INV-G4): chỉ được đóng băng (đặt signed_at/terms_*) một lần; sau đó không UPDATE/DELETE.
CREATE FUNCTION app.lease_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
CREATE TRIGGER trg_lease_versions_guard BEFORE UPDATE OR DELETE ON lease_versions FOR EACH ROW
  EXECUTE FUNCTION app.lease_version_guard();

CREATE TABLE lease_occupants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  person_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('primary','co_tenant','occupant')),
  is_representative boolean NOT NULL DEFAULT false,
  from_on date NOT NULL,
  to_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_lease_occupants_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_lease_occupants_lease FOREIGN KEY (organization_id, property_id, lease_id)
    REFERENCES leases (organization_id, property_id, id),
  CONSTRAINT fk_lease_occupants_person FOREIGN KEY (organization_id, person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT ck_lease_occupants_range CHECK (to_on IS NULL OR to_on >= from_on),
  CONSTRAINT ck_lease_occupants_rep CHECK (NOT is_representative OR role = 'primary')
);
CREATE UNIQUE INDEX uq_lease_occupants_rep ON lease_occupants (organization_id, lease_id)
  WHERE is_representative AND to_on IS NULL;
CREATE UNIQUE INDEX uq_lease_occupants_person ON lease_occupants (organization_id, lease_id, person_id) WHERE to_on IS NULL;
CREATE TRIGGER trg_lease_occupants_updated BEFORE UPDATE ON lease_occupants FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
-- Người ở rời đi: chỉ đặt to_on (một lần), không xoá dòng, không đổi người/vai trò.
CREATE FUNCTION app.lease_occupant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.to_on IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['to_on','updated_at','version']) <> (to_jsonb(OLD) - ARRAY['to_on','updated_at','version']) THEN
    RAISE EXCEPTION 'người ở %: chỉ được đặt ngày rời đi một lần', OLD.id USING ERRCODE = 'check_violation', HINT = 'INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lease_occupants_guard BEFORE UPDATE ON lease_occupants FOR EACH ROW EXECUTE FUNCTION app.lease_occupant_guard();
CREATE TRIGGER trg_lease_occupants_no_delete BEFORE DELETE OR TRUNCATE ON lease_occupants FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_mutation();

-- Đúng một người đại diện đang hiệu lực, trùng leases.representative_person_id (kiểm lúc COMMIT; trừ hợp đồng đã kết thúc).
CREATE FUNCTION app.check_lease_representative() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_lease uuid; v_org uuid; v_status text; v_rep uuid; v_n int; v_match int;
BEGIN
  v_org := NEW.organization_id;
  -- IF (không dùng CASE): plpgsql phân giải mọi trường trong biểu thức, leases không có lease_id.
  IF TG_TABLE_NAME = 'leases' THEN v_lease := NEW.id; ELSE v_lease := NEW.lease_id; END IF;
  SELECT status, representative_person_id INTO v_status, v_rep FROM leases WHERE organization_id = v_org AND id = v_lease;
  IF v_status IN ('closed','cancelled') THEN RETURN NULL; END IF;
  SELECT count(*), count(*) FILTER (WHERE person_id = v_rep) INTO v_n, v_match FROM lease_occupants
  WHERE organization_id = v_org AND lease_id = v_lease AND is_representative AND to_on IS NULL;
  IF v_n <> 1 OR v_match <> 1 THEN
    RAISE EXCEPTION 'hợp đồng %: cần đúng một người đại diện đang ở, trùng người đứng hợp đồng', v_lease
      USING ERRCODE = 'check_violation', HINT = 'VALIDATION_FAILED';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_leases_representative AFTER INSERT OR UPDATE ON leases DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_lease_representative();
CREATE CONSTRAINT TRIGGER trg_lease_occupants_representative AFTER INSERT OR UPDATE ON lease_occupants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_lease_representative();

-- Giữ chỗ hợp đồng không thời hạn được mở cuối (SPEC-lease S-023); hold khác vẫn phải có điểm cuối.
ALTER TABLE allocations DROP CONSTRAINT ck_allocations_open_end;
ALTER TABLE allocations ADD CONSTRAINT ck_allocations_open_end
  CHECK (NOT upper_inf(during) OR kind = 'lease' OR (kind = 'hold' AND source_type = 'lease'));

ALTER TABLE deposits ADD CONSTRAINT fk_deposits_lease FOREIGN KEY (organization_id, property_id, lease_id)
  REFERENCES leases (organization_id, property_id, id);
ALTER TABLE invoices ADD CONSTRAINT fk_invoices_lease FOREIGN KEY (organization_id, property_id, lease_id)
  REFERENCES leases (organization_id, property_id, id);

-- RLS: nhân viên theo vai trò + phạm vi; người thuê chỉ hợp đồng mình đứng tên (S-010); buồng phòng/bảo trì không đọc.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['services','leases','lease_versions','lease_occupants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
CREATE POLICY services_read ON services FOR SELECT USING (organization_id = app.current_org());
CREATE POLICY services_write ON services FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
              AND app.actor_can_see_property(property_id));

CREATE POLICY leases_staff_read ON leases FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR (app.actor_role() IN ('owner','manager','front_desk','accountant') AND app.actor_can_see_property(property_id))));
CREATE POLICY leases_tenant_read ON leases FOR SELECT
  USING (organization_id = app.current_org() AND app.actor_role() = 'tenant' AND representative_person_id = app.actor_person_id());
CREATE POLICY leases_write ON leases FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
              AND app.actor_can_see_property(property_id));
CREATE POLICY leases_update ON leases FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_can_see_property(property_id));

-- Bảng con: đọc theo hợp đồng đọc được (policy của leases áp trong truy vấn con); ghi owner/manager.
CREATE POLICY lease_versions_read ON lease_versions FOR SELECT
  USING (organization_id = app.current_org() AND EXISTS (SELECT 1 FROM leases l
         WHERE l.organization_id = lease_versions.organization_id AND l.id = lease_versions.lease_id));
CREATE POLICY lease_versions_write ON lease_versions FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
              AND app.actor_can_see_property(property_id));
CREATE POLICY lease_occupants_read ON lease_occupants FOR SELECT
  USING (organization_id = app.current_org() AND EXISTS (SELECT 1 FROM leases l
         WHERE l.organization_id = lease_occupants.organization_id AND l.id = lease_occupants.lease_id));
CREATE POLICY lease_occupants_write ON lease_occupants FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
              AND app.actor_can_see_property(property_id));

GRANT SELECT, INSERT, UPDATE ON services, leases, lease_versions, lease_occupants TO app_runtime;
GRANT SELECT ON services, leases, lease_versions, lease_occupants TO app_worker;
`;

const DOWN = `
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS fk_invoices_lease;
ALTER TABLE deposits DROP CONSTRAINT IF EXISTS fk_deposits_lease;
ALTER TABLE allocations DROP CONSTRAINT ck_allocations_open_end;
ALTER TABLE allocations ADD CONSTRAINT ck_allocations_open_end CHECK (NOT upper_inf(during) OR kind = 'lease');
DROP TABLE IF EXISTS lease_occupants, lease_versions, leases, services;
DROP FUNCTION IF EXISTS app.check_lease_representative(), app.lease_occupant_guard(), app.lease_version_guard(), app.lease_guard();
DROP POLICY IF EXISTS persons_read ON persons;
DROP POLICY IF EXISTS persons_insert ON persons;
DROP POLICY IF EXISTS persons_update ON persons;
DROP POLICY IF EXISTS persons_delete ON persons;
CREATE POLICY tenant_isolation ON persons USING (organization_id = app.current_org()) WITH CHECK (organization_id = app.current_org());
DROP FUNCTION IF EXISTS app.actor_person_id();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
