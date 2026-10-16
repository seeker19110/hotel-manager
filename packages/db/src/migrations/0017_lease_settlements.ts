// PLAN đợt 2 T-111 — báo trả + thanh lý (ERD `lease_settlements`; SPEC-lease S-016…S-019, S-021, S-025; INV-F5, INV-G4).
// - Quyết toán: lập (prepared, sửa được) → duyệt (approved, bất biến); người duyệt ≠ người lập (CHECK).
// - Hợp đồng chỉ `closed` khi có quyết toán đã duyệt (SETTLEMENT_REQUIRED) — kiểm ở lệnh và trigger.
// - Lễ tân lập biên bản trả phòng nên được chuyển hợp đồng sang `settling` (trigger vòng đời vẫn chặn chuyển sai bảng).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE lease_settlements (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','approved')),
  outstanding_ar bigint NOT NULL CHECK (outstanding_ar >= 0),
  deposit_balance bigint NOT NULL CHECK (deposit_balance >= 0),
  fees jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(fees) = 'array'),
  deductions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(deductions) = 'array'),
  refund_amount bigint NOT NULL CHECK (refund_amount >= 0),
  prepared_by uuid NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  approval_request_id uuid,
  fee_invoice_id uuid,
  refund_method text CHECK (refund_method IN ('cash','bank_transfer')),
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_lease_settlements_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_lease_settlements_lease UNIQUE (organization_id, lease_id),
  CONSTRAINT fk_lease_settlements_lease FOREIGN KEY (organization_id, property_id, lease_id)
    REFERENCES leases (organization_id, property_id, id),
  CONSTRAINT fk_lease_settlements_prepared_by FOREIGN KEY (organization_id, prepared_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_lease_settlements_approved_by FOREIGN KEY (organization_id, approved_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_lease_settlements_approval FOREIGN KEY (organization_id, approval_request_id)
    REFERENCES approval_requests (organization_id, id),
  CONSTRAINT fk_lease_settlements_fee_invoice FOREIGN KEY (organization_id, property_id, fee_invoice_id)
    REFERENCES invoices (organization_id, property_id, id),
  CONSTRAINT ck_lease_settlements_approved CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT ck_lease_settlements_not_self CHECK (approved_by IS NULL OR approved_by <> prepared_by),
  CONSTRAINT ck_lease_settlements_refund CHECK (refund_amount <= deposit_balance)
);
CREATE TRIGGER trg_lease_settlements_updated BEFORE UPDATE ON lease_settlements FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE FUNCTION app.lease_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'approved' THEN
    RAISE EXCEPTION 'quyết toán % đã duyệt — không sửa/xoá', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lease_settlements_guard BEFORE UPDATE OR DELETE ON lease_settlements FOR EACH ROW
  EXECUTE FUNCTION app.lease_settlement_guard();

-- Đóng hợp đồng cần quyết toán đã duyệt (S-018).
CREATE FUNCTION app.lease_close_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status = 'settling' AND NOT EXISTS (
       SELECT 1 FROM lease_settlements s WHERE s.organization_id = NEW.organization_id AND s.lease_id = NEW.id
         AND s.status = 'approved') THEN
    RAISE EXCEPTION 'hợp đồng %: cần duyệt quyết toán trước khi đóng', NEW.id
      USING ERRCODE = 'check_violation', HINT = 'SETTLEMENT_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_leases_close BEFORE UPDATE OF status ON leases FOR EACH ROW EXECUTE FUNCTION app.lease_close_guard();

ALTER TABLE lease_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY lease_settlements_read ON lease_settlements FOR SELECT
  USING (organization_id = app.current_org() AND (
    (app.actor_role() IN ('owner','manager','accountant') AND app.actor_can_see_property(property_id))
    OR (app.actor_role() = 'tenant' AND EXISTS (SELECT 1 FROM leases l WHERE l.organization_id = lease_settlements.organization_id
          AND l.id = lease_settlements.lease_id))));
CREATE POLICY lease_settlements_write ON lease_settlements FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant')
              AND app.actor_can_see_property(property_id));
GRANT SELECT, INSERT, UPDATE ON lease_settlements TO app_runtime;

DROP POLICY leases_update ON leases;
CREATE POLICY leases_update ON leases FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_can_see_property(property_id));
`;

const DOWN = `
DROP POLICY leases_update ON leases;
CREATE POLICY leases_update ON leases FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_can_see_property(property_id));
DROP TRIGGER IF EXISTS trg_leases_close ON leases;
DROP FUNCTION IF EXISTS app.lease_close_guard();
DROP TABLE IF EXISTS lease_settlements;
DROP FUNCTION IF EXISTS app.lease_settlement_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
