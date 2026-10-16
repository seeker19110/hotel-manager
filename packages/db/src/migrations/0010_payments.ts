// PLAN đợt 2 T-105 — phiếu (schema), thanh toán, phân bổ (ERD `invoices`, `invoice_lines`, `payments`,
// `payment_allocations`; INV-F2, INV-F3, INV-F3b, INV-F4b, INV-G4). Logic phát hành phiếu ở T-114; ở đây chỉ schema +
// hàng rào CSDL. FK tới billing_periods/leases/stays/charges/lease_versions/deposits thêm ở migration tạo các bảng đó.
import { type Kysely, sql } from "kysely";

const UP = `
-- Ngày kinh doanh địa phương của cơ sở (giờ chốt ngày; SPEC-access Q-01): (giờ địa phương − giờ chốt)::date.
CREATE FUNCTION app.business_date(p_org uuid, p_property uuid, p_at timestamptz DEFAULT now()) RETURNS date
  LANGUAGE sql STABLE AS $$
    SELECT ((p_at AT TIME ZONE p.timezone) - p.business_day_cutoff)::date
    FROM properties p WHERE p.organization_id = p_org AND p.id = p_property
  $$;
GRANT EXECUTE ON FUNCTION app.business_date(uuid, uuid, timestamptz) TO app_runtime, app_worker;

-- Cấp số tăng dần theo cơ sở (properties.counters), khoá hàng cơ sở trong transaction gọi.
CREATE FUNCTION app.next_number(p_org uuid, p_property uuid, p_key text) RETURNS bigint
  LANGUAGE sql AS $$
    UPDATE properties
       SET counters = jsonb_set(counters, ARRAY[p_key], to_jsonb(coalesce((counters ->> p_key)::bigint, 0) + 1))
     WHERE organization_id = p_org AND id = p_property
    RETURNING (counters ->> p_key)::bigint
  $$;
GRANT EXECUTE ON FUNCTION app.next_number(uuid, uuid, text) TO app_runtime;

CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('periodic','folio','fee','opening_balance','adjustment')),
  billing_period_id uuid,
  lease_id uuid,
  stay_id uuid,
  adjusts_invoice_id uuid,
  number text NOT NULL CHECK (length(btrim(number)) >= 1),
  memo_ref text NOT NULL CHECK (memo_ref ~ '^[A-Z0-9]{6,16}$'),
  payer_person_id uuid NOT NULL,
  business_date date NOT NULL,
  due_on date,
  total bigint NOT NULL CHECK (total >= 0 OR kind = 'adjustment'),
  allocated_total bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'VND',
  tax_profile_id uuid,
  rounding_rule text NOT NULL DEFAULT 'HALF_UP_1' CHECK (rounding_rule IN ('HALF_UP_1','HALF_UP_1000')),
  formula_version integer NOT NULL DEFAULT 1,
  issued_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  command_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_invoices_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_invoices_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT uq_invoices_memo_ref UNIQUE (organization_id, memo_ref),
  CONSTRAINT uq_invoices_number UNIQUE (organization_id, property_id, number),
  CONSTRAINT fk_invoices_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_invoices_payer FOREIGN KEY (organization_id, payer_person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT fk_invoices_adjusts FOREIGN KEY (organization_id, adjusts_invoice_id) REFERENCES invoices (organization_id, id),
  CONSTRAINT fk_invoices_created_by FOREIGN KEY (organization_id, created_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_invoices_allocated CHECK (allocated_total >= 0 AND allocated_total <= greatest(total, 0)),
  CONSTRAINT ck_invoices_adjustment CHECK (kind <> 'adjustment' OR adjusts_invoice_id IS NOT NULL),
  CONSTRAINT ck_invoices_periodic CHECK (kind <> 'periodic' OR (billing_period_id IS NOT NULL AND lease_id IS NOT NULL)),
  CONSTRAINT ck_invoices_folio CHECK (kind <> 'folio' OR stay_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_invoices_periodic ON invoices (organization_id, billing_period_id, lease_id) WHERE kind = 'periodic';
CREATE INDEX ix_invoices_payer ON invoices (organization_id, payer_person_id);
CREATE INDEX ix_invoices_open ON invoices (organization_id, property_id) WHERE allocated_total < total;
CREATE TRIGGER trg_invoices_updated BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- INV-G4: phiếu chỉ sinh khi phát hành; sau đó chỉ bộ đếm phân bổ được đổi (sửa = phiếu điều chỉnh).
CREATE FUNCTION app.invoice_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['allocated_total','updated_at','version']) <> (to_jsonb(OLD) - ARRAY['allocated_total','updated_at','version']) THEN
    RAISE EXCEPTION 'phiếu % đã phát hành — không sửa được; dùng phiếu điều chỉnh (INV-G4)', OLD.id
      USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoices_immutable BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION app.invoice_immutable();
CREATE TRIGGER trg_invoices_no_delete BEFORE DELETE OR TRUNCATE ON invoices FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no >= 1),
  charge_id uuid,
  kind text NOT NULL CHECK (kind IN ('room','utility','service','fee','discount','opening_balance','adjustment')),
  description text NOT NULL CHECK (length(btrim(description)) >= 1),
  revenue_account text NOT NULL CHECK (revenue_account IN ('REV_ROOM','REV_UTIL','REV_SERVICE','REV_FEE','DISCOUNT','OPENING_BALANCE')),
  quantity numeric(18,4) NOT NULL,
  unit_price numeric(18,4) NOT NULL,
  amount bigint NOT NULL,
  rounding_rule text NOT NULL CHECK (rounding_rule IN ('HALF_UP_1','HALF_UP_1000')),
  formula_version integer NOT NULL,
  lease_version_id uuid,
  period_from date,
  period_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_invoice_lines_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_invoice_lines_no UNIQUE (organization_id, invoice_id, line_no),
  CONSTRAINT fk_invoice_lines_invoice FOREIGN KEY (organization_id, property_id, invoice_id)
    REFERENCES invoices (organization_id, property_id, id),
  CONSTRAINT ck_invoice_lines_period CHECK (period_from IS NULL OR period_to IS NULL OR period_to >= period_from)
);
CREATE INDEX ix_invoice_lines_charge ON invoice_lines (organization_id, charge_id);
CREATE TRIGGER trg_invoice_lines_append_only BEFORE UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER trg_invoice_lines_no_truncate BEFORE TRUNCATE ON invoice_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- INV-G3: tổng phiếu = Σ dòng và phiếu có ít nhất một dòng — kiểm lúc COMMIT (phiếu và dòng ghi cùng transaction).
CREATE FUNCTION app.check_invoice_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total bigint; v_sum bigint; v_n int; v_id uuid; v_org uuid;
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN v_id := NEW.id; ELSE v_id := NEW.invoice_id; END IF;
  v_org := NEW.organization_id;
  SELECT total INTO v_total FROM invoices WHERE organization_id = v_org AND id = v_id;
  SELECT coalesce(sum(amount), 0), count(*) INTO v_sum, v_n FROM invoice_lines WHERE organization_id = v_org AND invoice_id = v_id;
  IF v_n = 0 OR v_sum <> v_total THEN
    RAISE EXCEPTION 'phiếu %: tổng % ≠ Σ dòng % (% dòng)', v_id, v_total, v_sum, v_n
      USING ERRCODE = 'check_violation', HINT = 'VALIDATION_FAILED';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_invoices_total AFTER INSERT ON invoices DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_invoice_total();
CREATE CONSTRAINT TRIGGER trg_invoice_lines_total AFTER INSERT ON invoice_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_invoice_total();

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('cash','bank_transfer')),
  purpose text NOT NULL CHECK (purpose IN ('receivable','deposit')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','reversed')),
  amount bigint NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'VND',
  ledger_account text GENERATED ALWAYS AS (CASE method WHEN 'cash' THEN 'CASH' ELSE 'BANK' END) STORED,
  receiving_account_id uuid,
  payer_person_id uuid NOT NULL,
  deposit_id uuid,
  shift_id uuid,
  bank_transaction_id uuid,
  evidence_kind text CHECK (evidence_kind IN ('bank_transaction','inbox','file','cash_receipt')),
  evidence_id uuid,
  receipt_no text,
  business_date date NOT NULL,
  allocated_total bigint NOT NULL DEFAULT 0,
  recorded_by uuid NOT NULL,
  confirmed_by uuid,
  confirmed_at timestamptz,
  reversed_by uuid,
  reversed_at timestamptz,
  reverse_reason text,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_payments_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_payments_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT fk_payments_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_payments_payer FOREIGN KEY (organization_id, payer_person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT fk_payments_receiving_account FOREIGN KEY (organization_id, receiving_account_id)
    REFERENCES receiving_accounts (organization_id, id),
  CONSTRAINT fk_payments_shift FOREIGN KEY (organization_id, property_id, shift_id) REFERENCES shifts (organization_id, property_id, id),
  CONSTRAINT fk_payments_bank_transaction FOREIGN KEY (organization_id, bank_transaction_id)
    REFERENCES bank_transactions (organization_id, id),
  CONSTRAINT fk_payments_recorded_by FOREIGN KEY (organization_id, recorded_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_payments_confirmed_by FOREIGN KEY (organization_id, confirmed_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_payments_reversed_by FOREIGN KEY (organization_id, reversed_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_payments_allocated CHECK (allocated_total >= 0 AND allocated_total <= amount),
  CONSTRAINT ck_payments_deposit CHECK ((purpose = 'deposit') = (deposit_id IS NOT NULL)),
  CONSTRAINT ck_payments_cash CHECK (method <> 'cash'
    OR (shift_id IS NOT NULL AND bank_transaction_id IS NULL AND receiving_account_id IS NULL)),
  CONSTRAINT ck_payments_transfer CHECK (method <> 'bank_transfer' OR (shift_id IS NULL AND receiving_account_id IS NOT NULL)),
  CONSTRAINT ck_payments_transfer_evidence CHECK (NOT (method = 'bank_transfer' AND status IN ('confirmed','reversed'))
    OR bank_transaction_id IS NOT NULL),
  CONSTRAINT ck_payments_confirmed CHECK (status = 'pending' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
    AND evidence_kind IS NOT NULL AND evidence_id IS NOT NULL)),
  CONSTRAINT ck_payments_reversed CHECK ((status = 'reversed') = (reversed_at IS NOT NULL)),
  CONSTRAINT ck_payments_reversed_alloc CHECK (status <> 'reversed' OR allocated_total = 0)
);
-- INV-F4b: một giao dịch ngân hàng ⇒ một payment (webhook + sao kê + nhập tay).
CREATE UNIQUE INDEX uq_payments_bank_transaction ON payments (organization_id, bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX uq_payments_receipt_no ON payments (organization_id, property_id, receipt_no) WHERE receipt_no IS NOT NULL;
CREATE INDEX ix_payments_status ON payments (organization_id, property_id, status);
CREATE INDEX ix_payments_shift ON payments (organization_id, shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX ix_payments_payer ON payments (organization_id, payer_person_id);
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- INV-G4 cho tiền: pending → confirmed (điền xác nhận/chứng cứ) → reversed; nội dung tiền bất biến; chỉ bộ đếm phân bổ đổi.
CREATE FUNCTION app.payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER trg_payments_guard BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION app.payment_guard();
CREATE TRIGGER trg_payments_no_delete BEFORE DELETE OR TRUNCATE ON payments FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  payment_id uuid,
  deposit_id uuid,
  invoice_id uuid NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  allocated_by uuid NOT NULL,
  entry_id uuid NOT NULL,
  reversed_at timestamptz,
  reversal_entry_id uuid,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_allocations_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_payment_allocations_payment FOREIGN KEY (organization_id, property_id, payment_id)
    REFERENCES payments (organization_id, property_id, id),
  CONSTRAINT fk_payment_allocations_invoice FOREIGN KEY (organization_id, property_id, invoice_id)
    REFERENCES invoices (organization_id, property_id, id),
  CONSTRAINT fk_payment_allocations_by FOREIGN KEY (organization_id, allocated_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_payment_allocations_entry FOREIGN KEY (organization_id, entry_id) REFERENCES journal_entries (organization_id, id),
  CONSTRAINT fk_payment_allocations_reversal FOREIGN KEY (organization_id, reversal_entry_id) REFERENCES journal_entries (organization_id, id),
  CONSTRAINT ck_payment_allocations_source CHECK (num_nonnulls(payment_id, deposit_id) = 1),
  CONSTRAINT ck_payment_allocations_reversal CHECK ((reversed_at IS NULL) = (reversal_entry_id IS NULL))
);
CREATE INDEX ix_payment_allocations_payment ON payment_allocations (organization_id, payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX ix_payment_allocations_deposit ON payment_allocations (organization_id, deposit_id) WHERE deposit_id IS NOT NULL;
CREATE INDEX ix_payment_allocations_invoice ON payment_allocations (organization_id, invoice_id);
-- Chỉ cột đảo được điền một lần.
CREATE FUNCTION app.allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reversed_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['reversed_at','reversal_entry_id']) <> (to_jsonb(OLD) - ARRAY['reversed_at','reversal_entry_id']) THEN
    RAISE EXCEPTION 'phân bổ %: chỉ được đảo một lần, không sửa nội dung', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payment_allocations_guard BEFORE UPDATE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION app.allocation_guard();
CREATE TRIGGER trg_payment_allocations_no_delete BEFORE DELETE OR TRUNCATE ON payment_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- Sổ phụ: dòng AR/doanh thu gắn đúng phiếu/dòng phiếu có thật.
ALTER TABLE journal_lines ADD CONSTRAINT fk_journal_lines_invoice FOREIGN KEY (organization_id, invoice_id)
  REFERENCES invoices (organization_id, id);
ALTER TABLE journal_lines ADD CONSTRAINT fk_journal_lines_invoice_line FOREIGN KEY (organization_id, invoice_line_id)
  REFERENCES invoice_lines (organization_id, id);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations FORCE ROW LEVEL SECURITY;
-- Phiếu/phân bổ: vai trò tiền trong phạm vi cơ sở (người thuê đọc phiếu của mình — thêm cùng portal).
CREATE POLICY tenant_isolation ON invoices
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant','front_desk')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant','front_desk')
         AND app.actor_can_see_property(property_id));
CREATE POLICY tenant_isolation ON invoice_lines
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant','front_desk')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant','front_desk')
         AND app.actor_can_see_property(property_id));
CREATE POLICY tenant_isolation ON payment_allocations
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant','front_desk')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','accountant','front_desk')
         AND app.actor_can_see_property(property_id));
-- Thanh toán: đọc — vai trò tiền trong phạm vi (ma trận money.read: lễ tân "Có"); ghi — người ghi nhận hoặc
-- owner/manager/accountant trong phạm vi (lễ tân sửa khoản người khác → app trả 403 như SPEC-ledger S-028).
CREATE POLICY payments_read ON payments FOR SELECT
  USING (organization_id = app.current_org()
         AND (recorded_by = nullif(current_setting('app.actor_id', true), '')::uuid
              OR (app.actor_role() IN ('owner','manager','accountant','front_desk') AND app.actor_can_see_property(property_id))));
CREATE POLICY payments_record ON payments FOR INSERT
  WITH CHECK (organization_id = app.current_org() AND recorded_by = nullif(current_setting('app.actor_id', true), '')::uuid
              AND app.actor_can_see_property(property_id));
CREATE POLICY payments_write ON payments FOR UPDATE
  USING (organization_id = app.current_org()
         AND (recorded_by = nullif(current_setting('app.actor_id', true), '')::uuid
              OR (app.actor_role() IN ('owner','manager','accountant') AND app.actor_can_see_property(property_id))))
  WITH CHECK (organization_id = app.current_org()
         AND (recorded_by = nullif(current_setting('app.actor_id', true), '')::uuid
              OR (app.actor_role() IN ('owner','manager','accountant') AND app.actor_can_see_property(property_id))));
GRANT SELECT, INSERT, UPDATE ON invoices, payments, payment_allocations TO app_runtime;
GRANT SELECT, INSERT ON invoice_lines TO app_runtime;
`;

const DOWN = `
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS fk_journal_lines_invoice_line;
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS fk_journal_lines_invoice;
DROP TABLE IF EXISTS payment_allocations, payments, invoice_lines, invoices;
DROP FUNCTION IF EXISTS app.allocation_guard(), app.payment_guard(), app.check_invoice_total(), app.invoice_immutable(),
  app.next_number(uuid, uuid, text), app.business_date(uuid, uuid, timestamptz);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
