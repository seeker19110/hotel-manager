// PLAN đợt 3 T-206 — folio và trả phòng (SPEC-reservation-stay S-017…S-020, S-022…S-024, S-026, S-027; ERD `payments`, `invoices`,
// `charges`; INV-F1, INV-F2, INV-F3b, INV-G4). Chỉ THÊM (không đổi bảng/trigger đã có):
// - `payments.reservation_id`: ứng trước (purpose `receivable`) gắn đúng booking để check-out chỉ phân bổ ứng trước CỦA booking đó
//   (CUSTOMER_CREDIT tính theo người, không theo booking — không có cột này thì folio A có thể ăn tiền ứng trước của booking B).
//   Bất biến sau khi ghi; cọc (`deposit`) đã gắn booking qua `deposits.reservation_id` nên không dùng cột này.
// - `uq_invoices_folio_stay`: mỗi lượt ở đúng một phiếu folio (check-out hai lần không sinh hai phiếu, kể cả khi code quên kiểm).
// - `uq_charges_stay_manual_command`: một lệnh ghi tối đa một khoản dịch vụ/phí tay cho lượt ở (không ghi hai lần khi retry — S-018).
// - `trg_charges_stay_folio`: lượt ở đã có phiếu folio ⇒ không thêm `charges` mới (phiếu bất biến, S-023; sửa bằng phiếu điều chỉnh).
// - `app.lock_payment_row` / `app.bump_payment_allocated` (SECURITY DEFINER, kiểm vai trò + cơ sở): check-out do lễ tân thực hiện phân
//   bổ ứng trước do người khác nhận; RLS `payments_write` chỉ cho lễ tân sửa khoản MÌNH ghi, nên việc khoá hàng và cộng bộ đếm
//   `allocated_total` đi qua hai hàm này (chỉ bộ đếm, nội dung tiền vẫn bất biến nhờ `app.payment_guard`).
import { type Kysely, sql } from "kysely";

const UP = `
ALTER TABLE payments ADD COLUMN reservation_id uuid;
ALTER TABLE payments ADD CONSTRAINT fk_payments_reservation FOREIGN KEY (organization_id, property_id, reservation_id)
  REFERENCES reservations (organization_id, property_id, id);
ALTER TABLE payments ADD CONSTRAINT ck_payments_reservation CHECK (reservation_id IS NULL OR purpose = 'receivable');
CREATE INDEX ix_payments_reservation ON payments (organization_id, reservation_id) WHERE reservation_id IS NOT NULL;

CREATE FUNCTION app.payment_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reservation_id IS DISTINCT FROM OLD.reservation_id THEN
    RAISE EXCEPTION 'thanh toán %: không đổi booking gắn kèm (INV-G4)', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payments_reservation_guard BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION app.payment_reservation_guard();

CREATE UNIQUE INDEX uq_invoices_folio_stay ON invoices (organization_id, stay_id) WHERE kind = 'folio';

CREATE UNIQUE INDEX uq_charges_stay_manual_command ON charges (organization_id, command_id)
  WHERE source_type = 'stay' AND kind IN ('service', 'fee', 'discount') AND command_id IS NOT NULL;

CREATE FUNCTION app.charge_stay_folio_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stay_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM invoices i WHERE i.organization_id = NEW.organization_id AND i.stay_id = NEW.stay_id AND i.kind = 'folio') THEN
    RAISE EXCEPTION 'lượt ở % đã có phiếu folio — không thêm khoản phải thu (INV-G4)', NEW.stay_id
      USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_charges_stay_folio BEFORE INSERT ON charges FOR EACH ROW EXECUTE FUNCTION app.charge_stay_folio_guard();

-- Người gọi phải là vai trò tiền trong phạm vi cơ sở của khoản thu (cùng điều kiện đọc của \`payments_read\`).
CREATE FUNCTION app.lock_payment_row(p_org uuid, p_payment uuid) RETURNS void
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
END $$;
REVOKE ALL ON FUNCTION app.lock_payment_row(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_payment_row(uuid, uuid) TO app_runtime;

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

const DOWN = `
DROP FUNCTION IF EXISTS app.bump_payment_allocated(uuid, uuid, bigint);
DROP FUNCTION IF EXISTS app.lock_payment_row(uuid, uuid);
DROP TRIGGER IF EXISTS trg_charges_stay_folio ON charges;
DROP FUNCTION IF EXISTS app.charge_stay_folio_guard();
DROP INDEX IF EXISTS uq_charges_stay_manual_command;
DROP INDEX IF EXISTS uq_invoices_folio_stay;
DROP TRIGGER IF EXISTS trg_payments_reservation_guard ON payments;
DROP FUNCTION IF EXISTS app.payment_reservation_guard();
DROP INDEX IF EXISTS ix_payments_reservation;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS ck_payments_reservation;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS fk_payments_reservation;
ALTER TABLE payments DROP COLUMN IF EXISTS reservation_id;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
