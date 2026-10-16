// PLAN đợt 2 T-106 — cọc (ERD `deposits`; INV-F5, DOMAIN-MODEL §1 "Cọc ≠ Ứng trước"). FK lease_id/reservation_id thêm khi
// có bảng `leases` (T-109) / `reservations` (đợt 3).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE deposits (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  lease_id uuid,
  reservation_id uuid,
  payer_person_id uuid NOT NULL,
  amount bigint NOT NULL DEFAULT 0 CHECK (amount >= 0),
  deducted_total bigint NOT NULL DEFAULT 0 CHECK (deducted_total >= 0),
  refunded_total bigint NOT NULL DEFAULT 0 CHECK (refunded_total >= 0),
  balance bigint GENERATED ALWAYS AS (amount - deducted_total - refunded_total) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_deposits_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_deposits_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT fk_deposits_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_deposits_payer FOREIGN KEY (organization_id, payer_person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT ck_deposits_subject CHECK (num_nonnulls(lease_id, reservation_id) = 1),
  -- Không hoàn/khấu trừ vượt số đang giữ (REFUND_EXCEEDS_BALANCE ở app; đây là hàng rào cuối).
  CONSTRAINT ck_deposits_balance CHECK (amount - deducted_total - refunded_total >= 0)
);
CREATE UNIQUE INDEX uq_deposits_lease ON deposits (organization_id, lease_id) WHERE lease_id IS NOT NULL;
CREATE UNIQUE INDEX uq_deposits_reservation ON deposits (organization_id, reservation_id) WHERE reservation_id IS NOT NULL;
CREATE TRIGGER trg_deposits_updated BEFORE UPDATE ON deposits FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
-- Chỉ bộ đếm đổi (mọi thay đổi số dư đi kèm bút toán); đối tượng/người cọc bất biến.
CREATE FUNCTION app.deposit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['amount','deducted_total','refunded_total','balance','updated_at','version'])
     <> (to_jsonb(OLD) - ARRAY['amount','deducted_total','refunded_total','balance','updated_at','version']) THEN
    RAISE EXCEPTION 'cọc %: không sửa đối tượng/người cọc', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_deposits_guard BEFORE UPDATE ON deposits FOR EACH ROW EXECUTE FUNCTION app.deposit_guard();
CREATE TRIGGER trg_deposits_no_delete BEFORE DELETE OR TRUNCATE ON deposits FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

ALTER TABLE payments ADD CONSTRAINT fk_payments_deposit FOREIGN KEY (organization_id, property_id, deposit_id)
  REFERENCES deposits (organization_id, property_id, id);
ALTER TABLE payment_allocations ADD CONSTRAINT fk_payment_allocations_deposit FOREIGN KEY (organization_id, property_id, deposit_id)
  REFERENCES deposits (organization_id, property_id, id);
ALTER TABLE journal_lines ADD CONSTRAINT fk_journal_lines_deposit FOREIGN KEY (organization_id, deposit_id)
  REFERENCES deposits (organization_id, id);

ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deposits
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant','front_desk')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant','front_desk')
         AND app.actor_can_see_property(property_id));
GRANT SELECT, INSERT, UPDATE ON deposits TO app_runtime;
`;

const DOWN = `
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS fk_journal_lines_deposit;
ALTER TABLE payment_allocations DROP CONSTRAINT IF EXISTS fk_payment_allocations_deposit;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS fk_payments_deposit;
DROP TABLE IF EXISTS deposits;
DROP FUNCTION IF EXISTS app.deposit_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
