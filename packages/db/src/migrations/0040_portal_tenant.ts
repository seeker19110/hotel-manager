// PLAN đợt 3 T-217 — portal người thuê (SPEC-portal S-001…S-011, S-021; ERD `payment_claims`; INV-F3).
// - Policy đọc riêng vai trò `tenant` (cộng thêm vào policy nhân viên; chặn đọc nội bộ đã có ở 0039):
//   phiếu mà mình là người trả (của hợp đồng; kỳ thu chỉ khi `issued`/`locked`), dòng phiếu + phân bổ của các phiếu đó,
//   cọc của hợp đồng mình đứng tên, công tơ của phòng mình thuê, chỉ số ĐÃ DUYỆT trong khoảng [bắt đầu tính tiền, ngày trả phòng] của từng hợp đồng.
// - `payment_claims` ("Tôi đã chuyển"): người thuê ghi/đọc của chính mình; KHÔNG sinh payments/bút toán (INV-F3); một
//   claim mỗi Idempotency-Key; nhân viên có quyền thu đọc/xử lý trong phạm vi cơ sở.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.billing_period_published(p_org uuid, p_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (SELECT 1 FROM billing_periods WHERE organization_id = p_org AND id = p_id AND status IN ('issued','locked'))
  $$;
-- Công tơ của phòng thuộc hợp đồng người thuê (actor) đứng tên + khoảng ngày của TỪNG hợp đồng đó: từ ngày bắt đầu tính
-- tiền đến ngày trả phòng thực tế (hợp đồng đã trả phòng mà thiếu ngày trả ⇒ khoảng rỗng — đóng an toàn). Không gộp
-- min() trên nhiều hợp đồng: người thuê cũ không được thấy chỉ số của người thuê sau ở cùng phòng (review lát 4).
CREATE FUNCTION app.tenant_meters() RETURNS TABLE (meter_id uuid, since date, until date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT m.id, l.billing_start_on,
           CASE WHEN l.status IN ('settling','closed') THEN coalesce(l.moved_out_on, l.billing_start_on - 1) END
    FROM meters m
    JOIN leases l ON l.organization_id = m.organization_id AND l.unit_id = m.unit_id
    WHERE m.organization_id = app.current_org() AND app.actor_role() = 'tenant'
      AND l.representative_person_id = app.actor_person_id()
      AND l.status IN ('signed_awaiting_handover','active','notice_given','settling','closed')
  $$;
REVOKE ALL ON FUNCTION app.billing_period_published(uuid, uuid), app.tenant_meters() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.billing_period_published(uuid, uuid), app.tenant_meters() TO app_runtime;

CREATE POLICY invoices_tenant_read ON invoices FOR SELECT TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() = 'tenant' AND payer_person_id = app.actor_person_id()
         AND lease_id IS NOT NULL AND kind IN ('periodic','fee','opening_balance','adjustment')
         AND (billing_period_id IS NULL OR app.billing_period_published(organization_id, billing_period_id)));
CREATE POLICY billing_periods_tenant_read ON billing_periods FOR SELECT TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() = 'tenant' AND status IN ('issued','locked') AND EXISTS (
           SELECT 1 FROM invoices i WHERE i.organization_id = billing_periods.organization_id AND i.billing_period_id = billing_periods.id));
CREATE POLICY invoice_lines_tenant_read ON invoice_lines FOR SELECT TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() = 'tenant' AND EXISTS (
           SELECT 1 FROM invoices i WHERE i.organization_id = invoice_lines.organization_id AND i.id = invoice_lines.invoice_id));
CREATE POLICY payment_allocations_tenant_read ON payment_allocations FOR SELECT TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() = 'tenant' AND EXISTS (
           SELECT 1 FROM invoices i WHERE i.organization_id = payment_allocations.organization_id AND i.id = payment_allocations.invoice_id));
CREATE POLICY deposits_tenant_read ON deposits FOR SELECT TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() = 'tenant' AND lease_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM leases l WHERE l.organization_id = deposits.organization_id AND l.id = deposits.lease_id));
CREATE POLICY meters_tenant_read ON meters FOR SELECT TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() = 'tenant' AND id IN (SELECT meter_id FROM app.tenant_meters()));
CREATE POLICY meter_readings_tenant_read ON meter_readings FOR SELECT TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() = 'tenant' AND status = 'approved'
         AND EXISTS (SELECT 1 FROM app.tenant_meters() tm WHERE tm.meter_id = meter_readings.meter_id AND meter_readings.read_on >= tm.since
                     AND (tm.until IS NULL OR meter_readings.read_on <= tm.until)));

CREATE TABLE payment_claims (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  person_id uuid NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  reference_code text NOT NULL CHECK (length(btrim(reference_code)) BETWEEN 1 AND 100),
  proof_file_id uuid,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','matched','rejected')),
  command_id uuid NOT NULL,
  matched_payment_id uuid,
  handled_by uuid,
  handled_at timestamptz,
  reject_reason text CHECK (reject_reason IS NULL OR length(btrim(reject_reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_payment_claims_command UNIQUE (organization_id, command_id),
  CONSTRAINT fk_payment_claims_invoice FOREIGN KEY (organization_id, property_id, invoice_id)
    REFERENCES invoices (organization_id, property_id, id),
  CONSTRAINT fk_payment_claims_person FOREIGN KEY (organization_id, person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT fk_payment_claims_file FOREIGN KEY (organization_id, proof_file_id) REFERENCES files (organization_id, id),
  CONSTRAINT fk_payment_claims_payment FOREIGN KEY (organization_id, matched_payment_id) REFERENCES payments (organization_id, id),
  CONSTRAINT fk_payment_claims_handled_by FOREIGN KEY (organization_id, handled_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_payment_claims_matched CHECK (status <> 'matched' OR matched_payment_id IS NOT NULL),
  CONSTRAINT ck_payment_claims_handled CHECK ((status = 'submitted') = (handled_at IS NULL)),
  CONSTRAINT ck_payment_claims_rejected CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);
CREATE INDEX ix_payment_claims_queue ON payment_claims (organization_id, property_id, status);
CREATE TRIGGER trg_payment_claims_updated BEFORE UPDATE ON payment_claims FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
-- Chỉ xử lý một lần: submitted → matched | rejected; các cột người báo/số tiền bất biến.
CREATE FUNCTION app.payment_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'submitted' THEN
    RAISE EXCEPTION 'báo chuyển % đã xử lý', OLD.id USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','matched_payment_id','handled_by','handled_at','reject_reason','updated_at','version'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','matched_payment_id','handled_by','handled_at','reject_reason','updated_at','version']) THEN
    RAISE EXCEPTION 'báo chuyển %: không đổi nội dung đã báo', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payment_claims_guard BEFORE UPDATE ON payment_claims FOR EACH ROW EXECUTE FUNCTION app.payment_claim_guard();

ALTER TABLE payment_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_claims_read ON payment_claims FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR (app.actor_role() = 'tenant' AND person_id = app.actor_person_id())
         OR (app.actor_role() IN ('owner','manager','accountant','front_desk') AND app.actor_can_see_property(property_id))));
CREATE POLICY payment_claims_tenant_insert ON payment_claims FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() = 'tenant' AND person_id = app.actor_person_id()
              AND status = 'submitted' AND EXISTS (SELECT 1 FROM invoices i WHERE i.organization_id = payment_claims.organization_id
                                                   AND i.id = payment_claims.invoice_id AND i.property_id = payment_claims.property_id));
CREATE POLICY payment_claims_staff_update ON payment_claims FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant','front_desk')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant','front_desk')
              AND app.actor_can_see_property(property_id));
GRANT SELECT, INSERT, UPDATE ON payment_claims TO app_runtime;
GRANT SELECT ON payment_claims TO app_worker;

-- Ảnh/PDF chứng từ báo chuyển (Q-07): nhân viên có quyền tiền trong phạm vi + chính người thuê tải lên (mẫu 0030).
DROP POLICY tenant_isolation ON files;
CREATE POLICY tenant_isolation ON files
  USING (organization_id = app.current_org() AND CASE
           WHEN owner_type = 'identity_document'
             THEN app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)
           WHEN owner_type IN ('work_order','handover','meter_reading','task') THEN true
           WHEN owner_type = 'import_batch'
             THEN app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id)
           WHEN owner_type = 'residence_notice'
             THEN app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)
           WHEN owner_type = 'payment_claim'
             THEN (app.actor_role() IN ('owner','manager','accountant','front_desk') AND app.actor_can_see_property(property_id))
                  OR (app.actor_role() = 'tenant' AND uploaded_by = nullif(current_setting('app.actor_id', true), '')::uuid)
           ELSE false
         END)
  WITH CHECK (organization_id = app.current_org());
`;

const DOWN = `
DROP POLICY tenant_isolation ON files;
CREATE POLICY tenant_isolation ON files
  USING (organization_id = app.current_org() AND CASE
           WHEN owner_type = 'identity_document'
             THEN app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)
           WHEN owner_type IN ('work_order','handover','meter_reading','task') THEN true
           WHEN owner_type = 'import_batch'
             THEN app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id)
           WHEN owner_type = 'residence_notice'
             THEN app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)
           ELSE false
         END)
  WITH CHECK (organization_id = app.current_org());
DROP TABLE IF EXISTS payment_claims;
DROP FUNCTION IF EXISTS app.payment_claim_guard();
DROP POLICY IF EXISTS meter_readings_tenant_read ON meter_readings;
DROP POLICY IF EXISTS meters_tenant_read ON meters;
DROP POLICY IF EXISTS deposits_tenant_read ON deposits;
DROP POLICY IF EXISTS payment_allocations_tenant_read ON payment_allocations;
DROP POLICY IF EXISTS invoice_lines_tenant_read ON invoice_lines;
DROP POLICY IF EXISTS invoices_tenant_read ON invoices;
DROP POLICY IF EXISTS billing_periods_tenant_read ON billing_periods;
DROP FUNCTION IF EXISTS app.tenant_meters();
DROP FUNCTION IF EXISTS app.billing_period_published(uuid, uuid);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
