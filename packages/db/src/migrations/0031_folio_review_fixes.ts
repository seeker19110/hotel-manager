// Sửa phát hiện review độc lập đợt 3 (T-206/T-208/T-201). Chỉ THÊM/THAY hàm; không sửa migration đã có.
//
// 1) `app.bump_payment_allocated(org, payment, delta)` (0027) nhận delta tuỳ ý: lễ tân F có thể đẩy `allocated_total` của khoản thu
//    do người khác ghi lên số bất kỳ ≤ amount mà không có phân bổ nào ⇒ check-out sau đó đòi nhầm tiền. Thay bằng
//    `app.sync_payment_allocated(org, payment)`: KHÔNG nhận số tiền, tự tính lại `allocated_total = Σ payment_allocations.amount` còn
//    hiệu lực (`reversed_at IS NULL`) dưới khoá hàng (giữ kiểm tổ chức/vai trò/cơ sở, search_path). Một nguồn sự thật = bảng phân bổ;
//    người gọi không có cách nào đặt giá trị khác Σ thật. (Chọn hàm đồng bộ thay vì trigger trên `payment_allocations` vì auto-apply
//    và reversePayment đang tự cộng/trừ bộ đếm — trigger sẽ cộng đôi; hàm chỉ đổi đường phân bổ hệ thống của check-out.)
// 2) Ứng trước đầu kỳ của booking nhập (T-208 `recordOpeningAdvance`: Nợ OPENING_BALANCE / Có CUSTOMER_CREDIT, không có `payments`) chưa
//    gắn booking nên check-out không dùng được. Thêm `journal_entries.reservation_id` (chỉ cho bút toán `opening_balance`, bất biến vì
//    sổ append-only) làm khoá liên kết, và `payment_allocations.opening_advance_entry_id` để phân bổ khoản đó vào phiếu folio
//    (Nợ CUSTOMER_CREDIT / Có AR) có dòng phân bổ truy vết được. Trigger `app.opening_allocation_guard` giữ INV-F2 ở CSDL: Σ phân bổ
//    còn hiệu lực của một bút toán ứng trước không vượt số Có CUSTOMER_CREDIT của chính nó (khoá tư vấn theo bút toán).
// 3) 0023 `app.check_property_in_use` kiểm EXISTS không khoá: đổi múi giờ/giờ chốt song song với tạo allocation/chứng từ đầu tiên có thể
//    cùng commit. Chứng từ (allocations, journal_entries, invoices, payments) nay lấy khoá tư vấn CHIA SẺ theo cơ sở lúc INSERT; trigger
//    đổi giờ lấy khoá ĐỘC QUYỀN cùng khoá trước khi kiểm EXISTS ⇒ hai bên tuần tự hoá (bên đổi giờ chờ chứng từ commit rồi thấy nó và
//    nhận PROPERTY_IN_USE; hoặc chứng từ chờ bên đổi giờ commit). Dùng khoá tư vấn chứ không `FOR SHARE` hàng `properties`: hàng này bị
//    `app.next_number` UPDATE trong hầu hết lệnh, hai giao dịch cùng giữ SHARE rồi cùng nâng lên UPDATE sẽ deadlock.
import { type Kysely, sql } from "kysely";

const UP = `
-- (1) Bộ đếm allocated_total tự suy ra từ phân bổ thật.
DROP FUNCTION app.bump_payment_allocated(uuid, uuid, bigint);

CREATE FUNCTION app.sync_payment_allocated(p_org uuid, p_payment uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pr uuid;
BEGIN
  IF p_org IS DISTINCT FROM app.current_org() THEN
    RAISE EXCEPTION 'sai ngữ cảnh tổ chức' USING ERRCODE = '42501';
  END IF;
  SELECT property_id INTO pr FROM payments WHERE organization_id = p_org AND id = p_payment;
  IF pr IS NULL OR NOT (app.actor_role() IN ('owner','manager','accountant','front_desk') AND app.actor_can_see_property(pr)) THEN
    RAISE EXCEPTION 'không có quyền với khoản thu này' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM payments WHERE organization_id = p_org AND id = p_payment FOR UPDATE;
  UPDATE payments p SET version = p.version + 1,
         allocated_total = coalesce((SELECT sum(a.amount) FROM payment_allocations a
                                      WHERE a.organization_id = p_org AND a.payment_id = p_payment AND a.reversed_at IS NULL), 0)
   WHERE p.organization_id = p_org AND p.id = p_payment
     AND p.allocated_total IS DISTINCT FROM coalesce((SELECT sum(a.amount) FROM payment_allocations a
                                      WHERE a.organization_id = p_org AND a.payment_id = p_payment AND a.reversed_at IS NULL), 0);
END $$;
REVOKE ALL ON FUNCTION app.sync_payment_allocated(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.sync_payment_allocated(uuid, uuid) TO app_runtime;

-- (2) Ứng trước đầu kỳ gắn đúng booking.
ALTER TABLE journal_entries ADD COLUMN reservation_id uuid;
ALTER TABLE journal_entries ADD CONSTRAINT fk_journal_entries_reservation FOREIGN KEY (organization_id, property_id, reservation_id)
  REFERENCES reservations (organization_id, property_id, id);
ALTER TABLE journal_entries ADD CONSTRAINT ck_journal_entries_reservation
  CHECK (reservation_id IS NULL OR entry_type = 'opening_balance');
CREATE INDEX ix_journal_entries_reservation ON journal_entries (organization_id, reservation_id) WHERE reservation_id IS NOT NULL;

ALTER TABLE payment_allocations ADD COLUMN opening_advance_entry_id uuid;
ALTER TABLE payment_allocations ADD CONSTRAINT fk_payment_allocations_opening FOREIGN KEY (organization_id, opening_advance_entry_id)
  REFERENCES journal_entries (organization_id, id);
ALTER TABLE payment_allocations DROP CONSTRAINT ck_payment_allocations_source;
ALTER TABLE payment_allocations ADD CONSTRAINT ck_payment_allocations_source CHECK (
  (num_nonnulls(payment_id, deposit_id) = 1 AND opening_advance_entry_id IS NULL)
  OR (num_nonnulls(payment_id, deposit_id) = 0 AND opening_advance_entry_id IS NOT NULL));
CREATE INDEX ix_payment_allocations_opening ON payment_allocations (organization_id, opening_advance_entry_id)
  WHERE opening_advance_entry_id IS NOT NULL;

CREATE FUNCTION app.opening_allocation_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE head record; funded bigint; used bigint;
BEGIN
  IF NEW.opening_advance_entry_id IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('opening_advance:' || NEW.opening_advance_entry_id::text, 0));
  SELECT j.entry_type, j.reservation_id, j.property_id INTO head
    FROM journal_entries j WHERE j.organization_id = NEW.organization_id AND j.id = NEW.opening_advance_entry_id;
  IF NOT FOUND OR head.entry_type <> 'opening_balance' OR head.reservation_id IS NULL OR head.property_id <> NEW.property_id THEN
    RAISE EXCEPTION 'phân bổ %: không phải bút toán ứng trước đầu kỳ của một booking', NEW.id
      USING ERRCODE = 'check_violation', HINT = 'VALIDATION_FAILED';
  END IF;
  SELECT coalesce(sum(l.credit), 0) INTO funded FROM journal_lines l
   WHERE l.organization_id = NEW.organization_id AND l.entry_id = NEW.opening_advance_entry_id AND l.account = 'CUSTOMER_CREDIT';
  SELECT coalesce(sum(a.amount), 0) INTO used FROM payment_allocations a
   WHERE a.organization_id = NEW.organization_id AND a.opening_advance_entry_id = NEW.opening_advance_entry_id AND a.reversed_at IS NULL;
  IF used + NEW.amount > funded THEN
    RAISE EXCEPTION 'phân bổ % vượt ứng trước đầu kỳ còn lại (INV-F2)', NEW.id
      USING ERRCODE = 'check_violation', HINT = 'OVER_ALLOCATION';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.opening_allocation_guard() FROM PUBLIC;
CREATE TRIGGER trg_payment_allocations_opening BEFORE INSERT ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION app.opening_allocation_guard();

-- (3) Tuần tự hoá đổi giờ chốt/múi giờ với chứng từ đầu tiên của cơ sở.
CREATE FUNCTION app.property_use_lock_key(p_org uuid, p_property uuid) RETURNS bigint
  LANGUAGE sql IMMUTABLE AS $$ SELECT hashtextextended('property_use:' || p_org::text || ':' || p_property::text, 0) $$;

CREATE FUNCTION app.lock_property_in_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(app.property_use_lock_key(NEW.organization_id, NEW.property_id));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_allocations_property_use BEFORE INSERT ON allocations
  FOR EACH ROW EXECUTE FUNCTION app.lock_property_in_use();
CREATE TRIGGER trg_journal_entries_property_use BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.lock_property_in_use();
CREATE TRIGGER trg_invoices_property_use BEFORE INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION app.lock_property_in_use();
CREATE TRIGGER trg_payments_property_use BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION app.lock_property_in_use();

CREATE OR REPLACE FUNCTION app.check_property_in_use() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.timezone IS DISTINCT FROM OLD.timezone OR NEW.business_day_cutoff IS DISTINCT FROM OLD.business_day_cutoff) THEN
    -- Chờ mọi giao dịch đang tạo chứng từ cho cơ sở này commit rồi mới kiểm (mỗi câu lệnh plpgsql đọc snapshot mới).
    PERFORM pg_advisory_xact_lock(app.property_use_lock_key(OLD.organization_id, OLD.id));
    IF EXISTS (SELECT 1 FROM allocations a WHERE a.organization_id = OLD.organization_id AND a.property_id = OLD.id)
       OR EXISTS (SELECT 1 FROM journal_entries j WHERE j.organization_id = OLD.organization_id AND j.property_id = OLD.id)
       OR EXISTS (SELECT 1 FROM invoices i WHERE i.organization_id = OLD.organization_id AND i.property_id = OLD.id)
       OR EXISTS (SELECT 1 FROM payments p WHERE p.organization_id = OLD.organization_id AND p.property_id = OLD.id)
    THEN
      RAISE EXCEPTION 'cơ sở % đã có giao dịch, không đổi múi giờ/giờ chốt ngày', OLD.id
        USING ERRCODE = '55000', HINT = 'PROPERTY_IN_USE';
    END IF;
  END IF;
  RETURN NEW;
END $$;
`;

const DOWN = `
CREATE OR REPLACE FUNCTION app.check_property_in_use() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.timezone IS DISTINCT FROM OLD.timezone OR NEW.business_day_cutoff IS DISTINCT FROM OLD.business_day_cutoff)
     AND (EXISTS (SELECT 1 FROM allocations a WHERE a.organization_id = OLD.organization_id AND a.property_id = OLD.id)
          OR EXISTS (SELECT 1 FROM journal_entries j WHERE j.organization_id = OLD.organization_id AND j.property_id = OLD.id)
          OR EXISTS (SELECT 1 FROM invoices i WHERE i.organization_id = OLD.organization_id AND i.property_id = OLD.id)
          OR EXISTS (SELECT 1 FROM payments p WHERE p.organization_id = OLD.organization_id AND p.property_id = OLD.id))
  THEN
    RAISE EXCEPTION 'cơ sở % đã có giao dịch, không đổi múi giờ/giờ chốt ngày', OLD.id
      USING ERRCODE = '55000', HINT = 'PROPERTY_IN_USE';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_payments_property_use ON payments;
DROP TRIGGER IF EXISTS trg_invoices_property_use ON invoices;
DROP TRIGGER IF EXISTS trg_journal_entries_property_use ON journal_entries;
DROP TRIGGER IF EXISTS trg_allocations_property_use ON allocations;
DROP FUNCTION IF EXISTS app.lock_property_in_use();
DROP FUNCTION IF EXISTS app.property_use_lock_key(uuid, uuid);

DROP TRIGGER IF EXISTS trg_payment_allocations_opening ON payment_allocations;
DROP FUNCTION IF EXISTS app.opening_allocation_guard();
DROP INDEX IF EXISTS ix_payment_allocations_opening;
ALTER TABLE payment_allocations DROP CONSTRAINT IF EXISTS ck_payment_allocations_source;
ALTER TABLE payment_allocations ADD CONSTRAINT ck_payment_allocations_source CHECK (num_nonnulls(payment_id, deposit_id) = 1);
ALTER TABLE payment_allocations DROP CONSTRAINT IF EXISTS fk_payment_allocations_opening;
ALTER TABLE payment_allocations DROP COLUMN IF EXISTS opening_advance_entry_id;
DROP INDEX IF EXISTS ix_journal_entries_reservation;
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS ck_journal_entries_reservation;
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS fk_journal_entries_reservation;
ALTER TABLE journal_entries DROP COLUMN IF EXISTS reservation_id;

DROP FUNCTION IF EXISTS app.sync_payment_allocated(uuid, uuid);
CREATE FUNCTION app.bump_payment_allocated(p_org uuid, p_payment uuid, p_delta bigint) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pr uuid;
BEGIN
  IF p_org IS DISTINCT FROM app.current_org() THEN
    RAISE EXCEPTION 'sai ngữ cảnh tổ chức' USING ERRCODE = '42501';
  END IF;
  SELECT property_id INTO pr FROM payments WHERE organization_id = p_org AND id = p_payment;
  IF pr IS NULL OR NOT (app.actor_role() IN ('owner','manager','accountant','front_desk') AND app.actor_can_see_property(pr)) THEN
    RAISE EXCEPTION 'không có quyền với khoản thu này' USING ERRCODE = '42501';
  END IF;
  UPDATE payments SET allocated_total = allocated_total + p_delta, version = version + 1
   WHERE organization_id = p_org AND id = p_payment;
END $$;
REVOKE ALL ON FUNCTION app.bump_payment_allocated(uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bump_payment_allocated(uuid, uuid, bigint) TO app_runtime;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
