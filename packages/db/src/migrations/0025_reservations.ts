// PLAN đợt 3 T-205 — đặt phòng và lượt ở (ERD `reservations`, `reservation_items`, `stays`; SPEC-reservation-stay S-003…S-011,
// S-025; DOMAIN-MODEL §4). Vòng đời kiểm ở app (bảng chuyển) + CSDL (CHECK trạng thái/thời điểm); chồng phòng do allocation
// (EXCLUDE — INV-I1). Ứng trước gắn booking qua `payments.reservation_id` (folio và check-out phân bổ đúng khoản — INV-F5).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE reservations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  number text NOT NULL CHECK (number ~ '^R-[0-9]{1,12}$'),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','held','confirmed','in_house','checked_out','cancelled','no_show','expired')),
  source text NOT NULL CHECK (source IN ('direct','walk_in')),
  booker_person_id uuid NOT NULL,
  policy_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  held_until timestamptz,
  confirmed_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 1000),
  cancelled_at timestamptz,
  created_by uuid NOT NULL,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_reservations_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_reservations_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT uq_reservations_number UNIQUE (organization_id, property_id, number),
  CONSTRAINT fk_reservations_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_reservations_booker FOREIGN KEY (organization_id, booker_person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT fk_reservations_created_by FOREIGN KEY (organization_id, created_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_reservations_cancel CHECK (status NOT IN ('cancelled','no_show') OR (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL)),
  CONSTRAINT ck_reservations_walk_in CHECK (source <> 'walk_in' OR status IN ('in_house','checked_out')),
  CONSTRAINT ck_reservations_held CHECK (status <> 'held' OR held_until IS NOT NULL)
);
CREATE INDEX ix_reservations_status ON reservations (organization_id, property_id, status);
CREATE TRIGGER trg_reservations_updated BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE reservation_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  room_type_id uuid NOT NULL,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  nights integer GENERATED ALWAYS AS (departure_date - arrival_date) STORED,
  guests integer NOT NULL DEFAULT 1 CHECK (guests BETWEEN 1 AND 50),
  nightly_prices jsonb NOT NULL CHECK (jsonb_typeof(nightly_prices) = 'array' AND jsonb_array_length(nightly_prices) >= 1),
  room_total bigint NOT NULL CHECK (room_total >= 0),
  allocation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_reservation_items_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_reservation_items_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT fk_reservation_items_reservation FOREIGN KEY (organization_id, property_id, reservation_id)
    REFERENCES reservations (organization_id, property_id, id),
  CONSTRAINT fk_reservation_items_unit FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id),
  CONSTRAINT fk_reservation_items_room_type FOREIGN KEY (organization_id, property_id, room_type_id)
    REFERENCES room_types (organization_id, property_id, id),
  CONSTRAINT fk_reservation_items_allocation FOREIGN KEY (organization_id, allocation_id) REFERENCES allocations (organization_id, id),
  CONSTRAINT ck_reservation_items_dates CHECK (departure_date > arrival_date),
  -- Số đêm của snapshot giá = số đêm của khoảng (giá từng đêm không lệch ngày).
  CONSTRAINT ck_reservation_items_prices CHECK (jsonb_array_length(nightly_prices) = departure_date - arrival_date)
);
-- Pilot: một dòng phòng mỗi booking (mở rộng nhóm/đoàn ở F-013 = bỏ index này).
CREATE UNIQUE INDEX uq_reservation_items_one_per_booking ON reservation_items (organization_id, reservation_id);
CREATE INDEX ix_reservation_items_unit ON reservation_items (organization_id, unit_id, arrival_date);
CREATE TRIGGER trg_reservation_items_updated BEFORE UPDATE ON reservation_items FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE stays (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  reservation_item_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','in_house','checked_out','cancelled','no_show')),
  primary_guest_person_id uuid NOT NULL,
  additional_guest_person_ids uuid[] NOT NULL DEFAULT '{}',
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  checked_in_by uuid,
  checked_out_by uuid,
  debtor_person_id uuid,
  debt_due_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_stays_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_stays_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT uq_stays_item UNIQUE (organization_id, reservation_item_id),
  CONSTRAINT fk_stays_item FOREIGN KEY (organization_id, property_id, reservation_item_id)
    REFERENCES reservation_items (organization_id, property_id, id),
  CONSTRAINT fk_stays_unit FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id),
  CONSTRAINT fk_stays_guest FOREIGN KEY (organization_id, primary_guest_person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT fk_stays_debtor FOREIGN KEY (organization_id, debtor_person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT fk_stays_checked_in_by FOREIGN KEY (organization_id, checked_in_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_stays_checked_out_by FOREIGN KEY (organization_id, checked_out_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_stays_in CHECK (status NOT IN ('in_house','checked_out') OR checked_in_at IS NOT NULL),
  CONSTRAINT ck_stays_out CHECK (status <> 'checked_out' OR checked_out_at IS NOT NULL),
  CONSTRAINT ck_stays_out_after_in CHECK (checked_out_at IS NULL OR checked_in_at IS NULL OR checked_out_at >= checked_in_at),
  CONSTRAINT ck_stays_debt CHECK ((debtor_person_id IS NULL) = (debt_due_date IS NULL))
);
CREATE INDEX ix_stays_unit ON stays (organization_id, unit_id, status);
CREATE INDEX ix_stays_status ON stays (organization_id, property_id, status);
CREATE TRIGGER trg_stays_updated BEFORE UPDATE ON stays FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Vòng đời chỉ đi tiến theo DOMAIN-MODEL §4 (hàng rào cuối, app kiểm trước bằng bảng chuyển).
CREATE FUNCTION app.reservation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('held','cancelled'))
    OR (OLD.status = 'held' AND NEW.status IN ('confirmed','expired','cancelled'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('in_house','cancelled','no_show'))
    OR (OLD.status = 'in_house' AND NEW.status = 'checked_out')) THEN
    RAISE EXCEPTION 'booking %: không chuyển % → %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  IF NEW.booker_person_id IS DISTINCT FROM OLD.booker_person_id OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.number IS DISTINCT FROM OLD.number OR NEW.property_id IS DISTINCT FROM OLD.property_id THEN
    RAISE EXCEPTION 'booking %: không sửa người đặt/nguồn/số', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_reservations_transition BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION app.reservation_transition();

CREATE FUNCTION app.stay_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'expected' AND NEW.status IN ('in_house','cancelled','no_show'))
    OR (OLD.status = 'in_house' AND NEW.status = 'checked_out')) THEN
    RAISE EXCEPTION 'lượt ở %: không chuyển % → %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  -- Lượt ở đã kết thúc bất biến (dấu vết lưu trú).
  IF OLD.status IN ('checked_out','cancelled','no_show') THEN
    RAISE EXCEPTION 'lượt ở % đã kết thúc', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_stays_transition BEFORE UPDATE ON stays FOR EACH ROW EXECUTE FUNCTION app.stay_transition();

-- Liên kết tiền ↔ booking.
ALTER TABLE payments ADD COLUMN reservation_id uuid;
ALTER TABLE payments ADD CONSTRAINT fk_payments_reservation FOREIGN KEY (organization_id, reservation_id)
  REFERENCES reservations (organization_id, id);
CREATE INDEX ix_payments_reservation ON payments (organization_id, reservation_id) WHERE reservation_id IS NOT NULL;
CREATE FUNCTION app.payment_reservation_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reservation_id IS DISTINCT FROM OLD.reservation_id THEN
    RAISE EXCEPTION 'thanh toán %: không sửa reservation_id (INV-G4)', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payments_reservation_fixed BEFORE UPDATE OF reservation_id ON payments
  FOR EACH ROW EXECUTE FUNCTION app.payment_reservation_fixed();
ALTER TABLE deposits ADD CONSTRAINT fk_deposits_reservation FOREIGN KEY (organization_id, reservation_id)
  REFERENCES reservations (organization_id, id);
ALTER TABLE invoices ADD CONSTRAINT fk_invoices_stay FOREIGN KEY (organization_id, property_id, stay_id)
  REFERENCES stays (organization_id, property_id, id);
ALTER TABLE charges ADD CONSTRAINT fk_charges_stay FOREIGN KEY (organization_id, property_id, stay_id)
  REFERENCES stays (organization_id, property_id, id);
-- Không ghi phí phòng hai lần cho cùng đêm của một lượt ở (SPEC-reservation-stay §4, S-016).
CREATE UNIQUE INDEX uq_charges_stay_room_night ON charges (organization_id, stay_id, business_date)
  WHERE kind = 'room' AND stay_id IS NOT NULL AND voided_at IS NULL;
CREATE INDEX ix_charges_stay ON charges (organization_id, stay_id) WHERE stay_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reservations','reservation_items','stays'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- Đọc: vai trò lễ tân/quản lý/owner + kế toán (xem lịch có tên khách: "read"); buồng phòng/kỹ thuật không đọc (S-025).
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (organization_id = app.current_org() AND ('
      'nullif(current_setting(''app.actor_id'', true), '''') IS NULL '
      'OR (app.actor_role() IN (''owner'',''manager'',''front_desk'',''accountant'') AND app.actor_can_see_property(property_id))))',
      t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO app_runtime USING (organization_id = app.current_org() '
      'AND app.actor_role() IN (''owner'',''manager'',''front_desk'') AND app.actor_can_see_property(property_id)) '
      'WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN (''owner'',''manager'',''front_desk'') '
      'AND app.actor_can_see_property(property_id))', t || '_write', t);
    -- Worker (hết hạn giữ phòng): chỉ trong ngữ cảnh tổ chức đã đặt.
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO app_worker USING (organization_id = app.current_org()) '
      'WITH CHECK (organization_id = app.current_org())', t || '_system', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON reservations, reservation_items, stays TO app_runtime;
GRANT SELECT, UPDATE ON reservations, reservation_items, stays TO app_worker;
`;

const DOWN = `
DROP INDEX IF EXISTS ix_charges_stay;
DROP INDEX IF EXISTS uq_charges_stay_room_night;
ALTER TABLE charges DROP CONSTRAINT IF EXISTS fk_charges_stay;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS fk_invoices_stay;
ALTER TABLE deposits DROP CONSTRAINT IF EXISTS fk_deposits_reservation;
DROP TRIGGER IF EXISTS trg_payments_reservation_fixed ON payments;
DROP FUNCTION IF EXISTS app.payment_reservation_fixed();
ALTER TABLE payments DROP COLUMN IF EXISTS reservation_id;
DROP TABLE IF EXISTS stays, reservation_items, reservations;
DROP FUNCTION IF EXISTS app.stay_transition();
DROP FUNCTION IF EXISTS app.reservation_transition();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
