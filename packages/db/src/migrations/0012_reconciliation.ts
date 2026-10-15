// PLAN đợt 2 T-107 — đối soát (SPEC-ledger S-015…S-021, S-029, S-030; ERD `reconciliation_breaks`; INV-F3, INV-F4, INV-F4b).
// 1) Thanh toán do HỆ THỐNG ghi (`source = 'bank_auto'`): chỉ từ giao dịch ngân hàng có webhook đã xác minh chữ ký, khớp đúng
//    một phiếu (S-016). Không có người lập/xác nhận ⇒ `recorded_by`/`confirmed_by` NULL (như `files.uploaded_by` NULL khi hệ
//    thống sinh); chứng cứ vẫn bắt buộc. Chỉ role `app_worker` ghi được loại này (policy riêng), web runtime không.
// 2) Hàng chờ khoản bất thường `reconciliation_breaks`: luôn có người chịu trách nhiệm, không tự đóng, đóng phải có lý do.
import { type Kysely, sql } from "kysely";

const UP = `
-- 1) Thanh toán do hệ thống ghi.
ALTER TABLE payments ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','bank_auto'));
ALTER TABLE payments ALTER COLUMN recorded_by DROP NOT NULL;
ALTER TABLE payments ADD CONSTRAINT ck_payments_source CHECK ((source = 'bank_auto') = (recorded_by IS NULL)
  AND (source <> 'bank_auto' OR (method = 'bank_transfer' AND purpose = 'receivable' AND bank_transaction_id IS NOT NULL
                                 AND confirmed_by IS NULL)));
ALTER TABLE payments DROP CONSTRAINT ck_payments_confirmed;
ALTER TABLE payments ADD CONSTRAINT ck_payments_confirmed CHECK (status = 'pending' OR (
  (confirmed_by IS NOT NULL OR source = 'bank_auto') AND confirmed_at IS NOT NULL
  AND evidence_kind IS NOT NULL AND evidence_id IS NOT NULL));

-- Hàng rào cuối INV-F3 cho đường tự động: giao dịch phải có ít nhất một sự kiện webhook đã xác minh chữ ký.
CREATE FUNCTION app.check_bank_auto_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'bank_auto' AND NOT EXISTS (
       SELECT 1 FROM inbox i
       WHERE i.organization_id = NEW.organization_id AND i.bank_transaction_id = NEW.bank_transaction_id
         AND i.signature_verified AND i.provider <> 'statement_csv') THEN
    RAISE EXCEPTION 'thanh toán tự động % thiếu webhook đã xác minh', NEW.id
      USING ERRCODE = 'check_violation', HINT = 'EVIDENCE_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payments_bank_auto BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION app.check_bank_auto_payment();

-- Nguồn ghi bất biến (thêm 'source' vào danh sách cột cố định của 0010).
CREATE OR REPLACE FUNCTION app.payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed text[] := ARRAY['method','purpose','amount','currency','receiving_account_id','payer_person_id','deposit_id',
                        'shift_id','property_id','recorded_by','business_date','organization_id','id','created_at','source'];
  k text;
BEGIN
  FOREACH k IN ARRAY fixed LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION 'thanh toán %: không sửa % (INV-G4)', OLD.id, k USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
    END IF;
  END LOOP;
  IF OLD.status = 'reversed'
     OR (OLD.status = 'confirmed' AND NEW.status NOT IN ('confirmed','reversed'))
     OR (OLD.status = 'pending' AND NEW.status = 'reversed')
     OR (OLD.status <> 'pending' AND (NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
         OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id OR NEW.bank_transaction_id IS DISTINCT FROM OLD.bank_transaction_id
         OR NEW.receipt_no IS DISTINCT FROM OLD.receipt_no)) THEN
    RAISE EXCEPTION 'thanh toán %: không thể chuyển % → %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', HINT = 'INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END $$;

-- Phân bổ không người lập chỉ thuộc thanh toán tự động.
ALTER TABLE payment_allocations ALTER COLUMN allocated_by DROP NOT NULL;
CREATE FUNCTION app.check_allocation_by() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.allocated_by IS NULL AND NOT EXISTS (
       SELECT 1 FROM payments p WHERE p.organization_id = NEW.organization_id AND p.id = NEW.payment_id
         AND p.source = 'bank_auto') THEN
    RAISE EXCEPTION 'phân bổ % thiếu người lập', NEW.id USING ERRCODE = 'not_null_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payment_allocations_by BEFORE INSERT ON payment_allocations FOR EACH ROW
  EXECUTE FUNCTION app.check_allocation_by();

-- 2) Hàng chờ khoản bất thường.
CREATE TABLE reconciliation_breaks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  inbox_id uuid,
  bank_transaction_id uuid,
  reason text NOT NULL CHECK (reason IN ('WRONG_REFERENCE','COMBINED','OVERPAID','THIRD_PARTY_PAYER','UNMATCHED','HASH_MISMATCH')),
  assignee uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  detail jsonb CHECK (detail IS NULL OR jsonb_typeof(detail) = 'object'),
  resolution text CHECK (resolution IS NULL OR length(btrim(resolution)) BETWEEN 1 AND 1000),
  resolved_by uuid,
  resolved_at timestamptz,
  resolved_payment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_reconciliation_breaks_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_reconciliation_breaks_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_reconciliation_breaks_inbox FOREIGN KEY (organization_id, inbox_id) REFERENCES inbox (organization_id, id),
  CONSTRAINT fk_reconciliation_breaks_bank_txn FOREIGN KEY (organization_id, bank_transaction_id)
    REFERENCES bank_transactions (organization_id, id),
  CONSTRAINT fk_reconciliation_breaks_assignee FOREIGN KEY (organization_id, assignee) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_reconciliation_breaks_resolved_by FOREIGN KEY (organization_id, resolved_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_reconciliation_breaks_payment FOREIGN KEY (organization_id, property_id, resolved_payment_id)
    REFERENCES payments (organization_id, property_id, id),
  CONSTRAINT ck_reconciliation_breaks_subject CHECK (num_nonnulls(inbox_id, bank_transaction_id) >= 1),
  CONSTRAINT ck_reconciliation_breaks_resolved CHECK (status = 'open'
    OR (resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)),
  CONSTRAINT ck_reconciliation_breaks_open CHECK (status = 'resolved'
    OR (resolution IS NULL AND resolved_by IS NULL AND resolved_at IS NULL AND resolved_payment_id IS NULL))
);
CREATE UNIQUE INDEX uq_reconciliation_breaks_open_txn ON reconciliation_breaks (organization_id, bank_transaction_id, reason)
  WHERE status = 'open' AND bank_transaction_id IS NOT NULL;
-- Sự kiện webhook trùng mã khác nội dung gửi lại nhiều lần → một break đang mở (báo động không nhân bản).
CREATE UNIQUE INDEX uq_reconciliation_breaks_open_inbox ON reconciliation_breaks (organization_id, inbox_id, reason)
  WHERE status = 'open' AND inbox_id IS NOT NULL AND bank_transaction_id IS NULL;
CREATE INDEX ix_reconciliation_breaks_status ON reconciliation_breaks (organization_id, property_id, status);
CREATE TRIGGER trg_reconciliation_breaks_updated BEFORE UPDATE ON reconciliation_breaks FOR EACH ROW
  EXECUTE FUNCTION app.set_updated_at();
-- Chỉ một chuyển trạng thái open → resolved (không mở lại, không sửa sau khi đóng). Lý do chỉ được đổi lúc đóng và chỉ
-- thành THIRD_PARTY_PAYER (S-021: người khác trả hộ — lý do gốc giữ trong detail.original_reason).
CREATE FUNCTION app.reconciliation_break_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'open' OR NEW.status <> 'resolved'
     OR (to_jsonb(NEW) - ARRAY['status','resolution','resolved_by','resolved_at','resolved_payment_id','reason','detail',
                               'updated_at','version'])
        <> (to_jsonb(OLD) - ARRAY['status','resolution','resolved_by','resolved_at','resolved_payment_id','reason','detail',
                                  'updated_at','version'])
     OR (NEW.reason <> OLD.reason AND NEW.reason <> 'THIRD_PARTY_PAYER') THEN
    RAISE EXCEPTION 'break %: chỉ đóng một lần, có lý do', OLD.id USING ERRCODE = 'check_violation', HINT = 'INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_reconciliation_breaks_guard BEFORE UPDATE ON reconciliation_breaks FOR EACH ROW
  EXECUTE FUNCTION app.reconciliation_break_guard();
CREATE TRIGGER trg_reconciliation_breaks_no_delete BEFORE DELETE OR TRUNCATE ON reconciliation_breaks FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_mutation();

ALTER TABLE reconciliation_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_breaks FORCE ROW LEVEL SECURITY;
-- Người: vai trò được xác nhận chuyển khoản (owner/manager/accountant, ma trận "payment.confirm_transfer") trong phạm vi.
CREATE POLICY breaks_staff ON reconciliation_breaks TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant')
         AND app.actor_can_see_property(property_id));
-- Hệ thống (webhook → worker; báo động HASH_MISMATCH): chỉ trong tổ chức đang đặt ngữ cảnh.
CREATE POLICY breaks_system ON reconciliation_breaks FOR SELECT TO app_worker USING (organization_id = app.current_org());
CREATE POLICY breaks_system_insert ON reconciliation_breaks FOR INSERT TO app_worker
  WITH CHECK (organization_id = app.current_org() AND status = 'open');
-- Webhook vào (runtime, KHÔNG có actor): chỉ mở/đọc break báo động HASH_MISMATCH của tổ chức đang đặt ngữ cảnh.
CREATE POLICY breaks_ingest_insert ON reconciliation_breaks FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_org() AND status = 'open' AND reason = 'HASH_MISMATCH'
              AND nullif(current_setting('app.actor_id', true), '') IS NULL);
CREATE POLICY breaks_ingest_read ON reconciliation_breaks FOR SELECT TO app_runtime
  USING (organization_id = app.current_org() AND reason = 'HASH_MISMATCH'
         AND nullif(current_setting('app.actor_id', true), '') IS NULL);
GRANT SELECT, INSERT, UPDATE ON reconciliation_breaks TO app_runtime;
GRANT SELECT, INSERT ON reconciliation_breaks TO app_worker;

-- 3) Quyền của worker cho đường tự động (S-016). Policy cũ của các bảng này đòi người dùng (actor) nên worker không lọt.
CREATE POLICY payments_system_read ON payments FOR SELECT TO app_worker USING (organization_id = app.current_org());
CREATE POLICY payments_system_insert ON payments FOR INSERT TO app_worker
  WITH CHECK (organization_id = app.current_org() AND source = 'bank_auto');
CREATE POLICY payments_system_update ON payments FOR UPDATE TO app_worker
  USING (organization_id = app.current_org() AND source = 'bank_auto')
  WITH CHECK (organization_id = app.current_org() AND source = 'bank_auto');
CREATE POLICY allocations_system ON payment_allocations FOR SELECT TO app_worker USING (organization_id = app.current_org());
CREATE POLICY allocations_system_insert ON payment_allocations FOR INSERT TO app_worker
  WITH CHECK (organization_id = app.current_org() AND allocated_by IS NULL);
CREATE POLICY invoices_system ON invoices FOR SELECT TO app_worker USING (organization_id = app.current_org());
CREATE POLICY invoices_system_update ON invoices FOR UPDATE TO app_worker
  USING (organization_id = app.current_org()) WITH CHECK (organization_id = app.current_org());
GRANT SELECT, INSERT, UPDATE ON payments TO app_worker;
GRANT SELECT, INSERT ON payment_allocations TO app_worker;
GRANT SELECT, UPDATE ON invoices TO app_worker;
GRANT SELECT ON receiving_accounts TO app_worker;
`;

const DOWN = `
REVOKE SELECT ON receiving_accounts FROM app_worker;
REVOKE SELECT, UPDATE ON invoices FROM app_worker;
REVOKE SELECT, INSERT ON payment_allocations FROM app_worker;
REVOKE SELECT, INSERT, UPDATE ON payments FROM app_worker;
DROP POLICY IF EXISTS invoices_system_update ON invoices;
DROP POLICY IF EXISTS invoices_system ON invoices;
DROP POLICY IF EXISTS allocations_system_insert ON payment_allocations;
DROP POLICY IF EXISTS allocations_system ON payment_allocations;
DROP POLICY IF EXISTS payments_system_update ON payments;
DROP POLICY IF EXISTS payments_system_insert ON payments;
DROP POLICY IF EXISTS payments_system_read ON payments;
DROP TABLE IF EXISTS reconciliation_breaks;
DROP FUNCTION IF EXISTS app.reconciliation_break_guard();
DROP TRIGGER IF EXISTS trg_payment_allocations_by ON payment_allocations;
DROP FUNCTION IF EXISTS app.check_allocation_by();
DROP TRIGGER IF EXISTS trg_payments_bank_auto ON payments;
DROP FUNCTION IF EXISTS app.check_bank_auto_payment();
-- Chỉ lùi được khi chưa có thanh toán/phân bổ tự động (NOT NULL thất bại nếu có — không mất dữ liệu âm thầm).
ALTER TABLE payment_allocations ALTER COLUMN allocated_by SET NOT NULL;
ALTER TABLE payments DROP CONSTRAINT ck_payments_confirmed;
ALTER TABLE payments ADD CONSTRAINT ck_payments_confirmed CHECK (status = 'pending' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
    AND evidence_kind IS NOT NULL AND evidence_id IS NOT NULL));
ALTER TABLE payments DROP CONSTRAINT ck_payments_source;
ALTER TABLE payments ALTER COLUMN recorded_by SET NOT NULL;
ALTER TABLE payments DROP COLUMN source;
CREATE OR REPLACE FUNCTION app.payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed text[] := ARRAY['method','purpose','amount','currency','receiving_account_id','payer_person_id','deposit_id',
                        'shift_id','property_id','recorded_by','business_date','organization_id','id','created_at'];
  k text;
BEGIN
  FOREACH k IN ARRAY fixed LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION 'thanh toán %: không sửa % (INV-G4)', OLD.id, k USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
    END IF;
  END LOOP;
  IF OLD.status = 'reversed'
     OR (OLD.status = 'confirmed' AND NEW.status NOT IN ('confirmed','reversed'))
     OR (OLD.status = 'pending' AND NEW.status = 'reversed')
     OR (OLD.status <> 'pending' AND (NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
         OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id OR NEW.bank_transaction_id IS DISTINCT FROM OLD.bank_transaction_id
         OR NEW.receipt_no IS DISTINCT FROM OLD.receipt_no)) THEN
    RAISE EXCEPTION 'thanh toán %: không thể chuyển % → %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', HINT = 'INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
