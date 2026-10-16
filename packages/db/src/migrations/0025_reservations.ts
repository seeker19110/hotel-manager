// PLAN đợt 3 T-204 — booking: `reservations`, `reservation_items`, `stays` (ERD §3.4; SPEC-reservation-stay S-003…S-011;
// DOMAIN-MODEL §4; INV-F3, INV-G3, INV-I3, INV-G1).
// - Vòng đời booking/lượt ở kiểm ở CSDL (trigger) như bảng chuyển ở `@hm/domain` (`bookingMachine`, `stayMachine`): chuyển ngoài
//   bảng → 23514 + HINT INVALID_TRANSITION; trạng thái cuối (`checked_out`, `cancelled`, `no_show`, `expired`) bất biến.
// - Xác nhận booking cần chứng cứ tiền (INV-F3): `held → confirmed` chỉ khi có `confirmation_payment_id` trỏ khoản thu đã
//   `confirmed` (payments tự đòi chứng cứ), hoặc cơ sở cho phép xác nhận không tiền (`confirmed_without_payment`, Q-05).
// - `reservation_items.nightly_prices` là ảnh chụp giá từng đêm (INV-G3): cấu trúc kiểm ở CSDL (đủ mọi đêm liên tiếp từ ngày đến,
//   số nguyên đồng, Σ = `room_total`); đổi ngày chỉ được giữ nguyên giá của đêm đã chốt.
// - Hold của booking hết hạn (allocation `hold` nguồn `reservation_item` bị nhả vì `expired`) → booking `held → expired` đúng một
//   lần, bằng trigger trên `allocations` (mọi đường nhả: worker, dọn khi giữ phòng khác, xác nhận quá hạn).
// - FK đã hẹn từ trước: `deposits.reservation_id` (0011), `charges.stay_id` (0020), `invoices.stay_id` (0010) → bảng mới.
import { type Kysely, sql } from "kysely";

const UP = `
-- Ảnh chụp giá đêm hợp lệ: mảng gồm đúng (ngày đi − ngày đến) phần tử, phần tử thứ i có business_date = ngày đến + i, amount là số
-- nguyên đồng 0..2^53-1, và Σ amount = room_total. Trả false (không ném lỗi) với mọi dữ liệu sai cấu trúc.
CREATE FUNCTION app.valid_nightly_prices(p jsonb, p_arrival date, p_departure date, p_total bigint) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  e jsonb;
  i integer := 0;
  s numeric := 0;
  amt numeric;
BEGIN
  IF p IS NULL OR p_arrival IS NULL OR p_departure IS NULL OR p_total IS NULL OR jsonb_typeof(p) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p) <> p_departure - p_arrival THEN RETURN false; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p) LOOP
    IF jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'business_date') <> 'string' OR jsonb_typeof(e -> 'amount') <> 'number' THEN
      RETURN false;
    END IF;
    IF (e ->> 'business_date') <> to_char(p_arrival + i, 'YYYY-MM-DD') THEN RETURN false; END IF;
    IF (e ->> 'amount') !~ '^[0-9]{1,16}$' THEN RETURN false; END IF;
    amt := (e ->> 'amount')::numeric;
    IF amt > 9007199254740991 THEN RETURN false; END IF;
    s := s + amt;
    i := i + 1;
  END LOOP;
  RETURN s = p_total;
END $$;

CREATE TABLE reservations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  number text NOT NULL CHECK (length(btrim(number)) >= 1),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','held','confirmed','in_house','checked_out','cancelled','no_show','expired')),
  source text NOT NULL CHECK (source IN ('direct','walk_in')),
  booker_person_id uuid NOT NULL,
  policy_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  cancel_reason text,
  cancelled_at timestamptz,
  confirmed_at timestamptz,
  confirmation_payment_id uuid,
  confirmed_without_payment boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_reservations_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT uq_reservations_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_reservations_number UNIQUE (organization_id, property_id, number),
  CONSTRAINT fk_reservations_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_reservations_booker FOREIGN KEY (organization_id, booker_person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT fk_reservations_created_by FOREIGN KEY (organization_id, created_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_reservations_payment FOREIGN KEY (organization_id, property_id, confirmation_payment_id)
    REFERENCES payments (organization_id, property_id, id),
  CONSTRAINT ck_reservations_cancel_reason CHECK (status NOT IN ('cancelled','no_show')
    OR (cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) >= 1 AND cancelled_at IS NOT NULL)),
  CONSTRAINT ck_reservations_confirmation CHECK (NOT (confirmed_without_payment AND confirmation_payment_id IS NOT NULL))
);
CREATE INDEX ix_reservations_status ON reservations (organization_id, property_id, status);
CREATE TRIGGER trg_reservations_updated BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_reservations_no_delete BEFORE DELETE OR TRUNCATE ON reservations FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- Bảng chuyển trạng thái booking (khớp bookingMachine) + hàng rào chứng cứ khi xác nhận (INV-F3). SECURITY DEFINER: đọc \`payments\`
-- không phụ thuộc RLS của người gọi (lễ tân chỉ thấy khoản mình ghi).
CREATE FUNCTION app.reservation_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Chỉ \`draft\` (booking thường) hoặc \`in_house\` (walk-in một command); không chèn thẳng trạng thái giữa chừng.
    IF NOT ((NEW.source = 'walk_in' AND NEW.status = 'in_house') OR (NEW.source = 'direct' AND NEW.status = 'draft')) THEN
      RAISE EXCEPTION 'booking mới phải ở draft (direct) hoặc in_house (walk_in), không phải % / %', NEW.status, NEW.source
        USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.property_id, NEW.number, NEW.source, NEW.booker_person_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.property_id, OLD.number, OLD.source, OLD.booker_person_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'booking %: không sửa định danh/người đặt/nguồn', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF OLD.status IN ('checked_out','cancelled','no_show','expired') THEN
    -- Trạng thái cuối: bất biến toàn bộ (kể cả lý do huỷ, chứng cứ xác nhận).
    IF (to_jsonb(NEW) - ARRAY['updated_at','version']) <> (to_jsonb(OLD) - ARRAY['updated_at','version']) THEN
      RAISE EXCEPTION 'booking % đã ở trạng thái cuối (%)', OLD.id, OLD.status USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status THEN
    ok := CASE OLD.status
      WHEN 'draft' THEN NEW.status IN ('held','cancelled')
      WHEN 'held' THEN NEW.status IN ('confirmed','expired','cancelled')
      WHEN 'confirmed' THEN NEW.status IN ('in_house','cancelled','no_show')
      WHEN 'in_house' THEN NEW.status IN ('checked_out')
      ELSE false END;
    IF NOT ok THEN
      RAISE EXCEPTION 'booking %: không thể chuyển từ % sang %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
    END IF;
  END IF;
  IF OLD.status = 'held' AND NEW.status = 'confirmed' THEN
    IF NEW.confirmed_at IS NULL THEN
      RAISE EXCEPTION 'xác nhận booking % thiếu confirmed_at', OLD.id USING ERRCODE = '23514', HINT = 'VALIDATION_FAILED';
    END IF;
    IF NOT NEW.confirmed_without_payment AND NOT EXISTS (
         SELECT 1 FROM payments p
         WHERE p.organization_id = NEW.organization_id AND p.property_id = NEW.property_id
           AND p.id = NEW.confirmation_payment_id AND p.status = 'confirmed') THEN
      RAISE EXCEPTION 'xác nhận booking % cần ứng trước/cọc đã xác nhận có chứng cứ (INV-F3)', OLD.id
        USING ERRCODE = '23514', HINT = 'EVIDENCE_REQUIRED';
    END IF;
  ELSIF (NEW.confirmed_at, NEW.confirmation_payment_id, NEW.confirmed_without_payment)
        IS DISTINCT FROM (OLD.confirmed_at, OLD.confirmation_payment_id, OLD.confirmed_without_payment) THEN
    RAISE EXCEPTION 'booking %: chứng cứ xác nhận chỉ ghi lúc held → confirmed', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_reservations_guard BEFORE INSERT OR UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION app.reservation_guard();

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
  guests integer NOT NULL DEFAULT 1 CHECK (guests >= 1),
  nightly_prices jsonb NOT NULL,
  room_total bigint NOT NULL CHECK (room_total >= 0 AND room_total <= 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_reservation_items_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT fk_reservation_items_reservation FOREIGN KEY (organization_id, property_id, reservation_id)
    REFERENCES reservations (organization_id, property_id, id),
  CONSTRAINT fk_reservation_items_unit FOREIGN KEY (organization_id, property_id, unit_id)
    REFERENCES units (organization_id, property_id, id),
  CONSTRAINT fk_reservation_items_room_type FOREIGN KEY (organization_id, property_id, room_type_id)
    REFERENCES room_types (organization_id, property_id, id),
  CONSTRAINT ck_reservation_items_dates CHECK (departure_date > arrival_date),
  CONSTRAINT ck_reservation_items_nightly CHECK (app.valid_nightly_prices(nightly_prices, arrival_date, departure_date, room_total))
);
CREATE INDEX ix_reservation_items_unit ON reservation_items (organization_id, unit_id, arrival_date);
CREATE INDEX ix_reservation_items_reservation ON reservation_items (organization_id, property_id, reservation_id);
CREATE TRIGGER trg_reservation_items_updated BEFORE UPDATE ON reservation_items FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_reservation_items_no_delete BEFORE DELETE OR TRUNCATE ON reservation_items FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- INV-G3: loại phòng và định danh bất biến; booking ở trạng thái cuối đóng băng cả dòng; đêm có ở cả bản cũ và mới giữ NGUYÊN giá
-- (đổi ngày chỉ thêm đêm mới theo giá hiện hành hoặc bớt đêm — S-008, Q-06).
CREATE FUNCTION app.reservation_item_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE st text;
BEGIN
  IF (NEW.id, NEW.organization_id, NEW.property_id, NEW.reservation_id, NEW.room_type_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.property_id, OLD.reservation_id, OLD.room_type_id, OLD.created_at) THEN
    RAISE EXCEPTION 'dòng phòng %: không sửa định danh/loại phòng', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  SELECT r.status INTO st FROM reservations r WHERE r.organization_id = OLD.organization_id AND r.id = OLD.reservation_id;
  IF st IN ('checked_out','cancelled','no_show','expired')
     AND (to_jsonb(NEW) - ARRAY['updated_at','version']) <> (to_jsonb(OLD) - ARRAY['updated_at','version']) THEN
    RAISE EXCEPTION 'dòng phòng % thuộc booking đã đóng (%)', OLD.id, st USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF EXISTS (
       SELECT 1 FROM jsonb_array_elements(OLD.nightly_prices) o
       JOIN jsonb_array_elements(NEW.nightly_prices) n ON n ->> 'business_date' = o ->> 'business_date'
       WHERE (n ->> 'amount')::numeric <> (o ->> 'amount')::numeric) THEN
    RAISE EXCEPTION 'dòng phòng %: đêm đã chốt giá không được đổi giá (snapshot, INV-G3)', OLD.id
      USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_reservation_items_guard BEFORE UPDATE ON reservation_items FOR EACH ROW EXECUTE FUNCTION app.reservation_item_guard();

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
  debtor_person_id uuid,
  debt_due_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_stays_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT uq_stays_item UNIQUE (organization_id, reservation_item_id),
  CONSTRAINT fk_stays_item FOREIGN KEY (organization_id, property_id, reservation_item_id)
    REFERENCES reservation_items (organization_id, property_id, id),
  CONSTRAINT fk_stays_unit FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id),
  CONSTRAINT fk_stays_primary_guest FOREIGN KEY (organization_id, primary_guest_person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT fk_stays_debtor FOREIGN KEY (organization_id, debtor_person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT ck_stays_checkout_after_checkin CHECK (checked_out_at IS NULL OR checked_in_at IS NULL OR checked_out_at >= checked_in_at),
  CONSTRAINT ck_stays_debt CHECK ((debtor_person_id IS NULL) = (debt_due_date IS NULL)),
  CONSTRAINT ck_stays_checked_in CHECK (status NOT IN ('in_house','checked_out') OR checked_in_at IS NOT NULL),
  CONSTRAINT ck_stays_checked_out CHECK (status <> 'checked_out' OR checked_out_at IS NOT NULL)
);
CREATE INDEX ix_stays_unit_status ON stays (organization_id, unit_id, status);
CREATE TRIGGER trg_stays_updated BEFORE UPDATE ON stays FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_stays_no_delete BEFORE DELETE OR TRUNCATE ON stays FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- Bảng chuyển trạng thái lượt ở (khớp stayMachine); \`no_show\`/\`cancelled\`/\`checked_out\` không có đường quay lại (S-011: không check-in từ no_show).
CREATE FUNCTION app.stay_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('expected','in_house') THEN
      RAISE EXCEPTION 'lượt ở mới phải ở expected (booking) hoặc in_house (walk-in), không phải %', NEW.status
        USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.property_id, NEW.reservation_item_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.property_id, OLD.reservation_item_id, OLD.created_at) THEN
    RAISE EXCEPTION 'lượt ở %: không sửa định danh/dòng phòng', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF NEW.status <> OLD.status THEN
    ok := CASE OLD.status
      WHEN 'expected' THEN NEW.status IN ('in_house','cancelled','no_show')
      WHEN 'in_house' THEN NEW.status IN ('checked_out')
      ELSE false END;
    IF NOT ok THEN
      RAISE EXCEPTION 'lượt ở %: không thể chuyển từ % sang %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_stays_guard BEFORE INSERT OR UPDATE ON stays FOR EACH ROW EXECUTE FUNCTION app.stay_guard();

-- INV-I3: hold của booking hết hạn (bất kỳ đường nhả nào) ⇒ booking \`held → expired\` đúng một lần (WHERE status = 'held').
CREATE FUNCTION app.expire_reservation_on_hold_expiry() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE reservations r SET status = 'expired'
  FROM reservation_items i
  WHERE i.organization_id = NEW.organization_id AND i.id = NEW.source_id
    AND r.organization_id = i.organization_id AND r.property_id = i.property_id AND r.id = i.reservation_id
    AND r.status = 'held';
  RETURN NULL;
END $$;
CREATE TRIGGER trg_allocations_reservation_expiry AFTER UPDATE OF active ON allocations
  FOR EACH ROW WHEN (OLD.active AND NOT NEW.active AND NEW.kind = 'hold' AND NEW.source_type = 'reservation_item'
                     AND NEW.deactivated_reason = 'expired')
  EXECUTE FUNCTION app.expire_reservation_on_hold_expiry();

-- RLS: owner/manager/lễ tân ghi; kế toán chỉ đọc (đối soát); buồng phòng/bảo trì không đọc (khách, tiền). Ngữ cảnh hệ thống (không
-- actor: worker) đọc theo tổ chức. Phạm vi cơ sở theo membership.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reservations','reservation_items','stays'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR SELECT
      USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
             OR (app.actor_role() IN ('owner','manager','front_desk','accountant') AND app.actor_can_see_property(property_id))))$p$,
      t || '_read', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR ALL TO app_runtime
      USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
             AND app.actor_can_see_property(property_id))
      WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
                  AND app.actor_can_see_property(property_id))$p$, t || '_write', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_runtime', t);
    EXECUTE format('GRANT SELECT ON %I TO app_worker', t);
  END LOOP;
END $$;

-- FK đã hẹn từ các migration trước.
ALTER TABLE deposits ADD CONSTRAINT fk_deposits_reservation FOREIGN KEY (organization_id, property_id, reservation_id)
  REFERENCES reservations (organization_id, property_id, id);
ALTER TABLE charges ADD CONSTRAINT fk_charges_stay FOREIGN KEY (organization_id, property_id, stay_id)
  REFERENCES stays (organization_id, property_id, id);
ALTER TABLE invoices ADD CONSTRAINT fk_invoices_stay FOREIGN KEY (organization_id, property_id, stay_id)
  REFERENCES stays (organization_id, property_id, id);
`;

const DOWN = `
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS fk_invoices_stay;
ALTER TABLE charges DROP CONSTRAINT IF EXISTS fk_charges_stay;
ALTER TABLE deposits DROP CONSTRAINT IF EXISTS fk_deposits_reservation;
DROP TRIGGER IF EXISTS trg_allocations_reservation_expiry ON allocations;
DROP FUNCTION IF EXISTS app.expire_reservation_on_hold_expiry();
DROP TABLE IF EXISTS stays;
DROP FUNCTION IF EXISTS app.stay_guard();
DROP TABLE IF EXISTS reservation_items;
DROP FUNCTION IF EXISTS app.reservation_item_guard();
DROP TABLE IF EXISTS reservations;
DROP FUNCTION IF EXISTS app.reservation_guard();
DROP FUNCTION IF EXISTS app.valid_nightly_prices(jsonb, date, date, bigint);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
