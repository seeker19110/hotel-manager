// T-010 — lõi sổ tiền: receiving_accounts, journal_entries/journal_lines (INV-F1, INV-G4), inbox (INV-F4),
// bank_transactions (INV-F4b). Nguồn: ERD.md, DOMAIN-MODEL §5. Phiếu/payment/phân bổ thuộc đợt 2.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE receiving_accounts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid,
  bank_code text NOT NULL CHECK (bank_code ~ '^[0-9A-Z]{3,10}$'),
  account_number_masked text NOT NULL,
  account_number text NOT NULL CHECK (account_number ~ '^[0-9]{4,30}$'),
  account_name text NOT NULL CHECK (length(btrim(account_name)) BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_receiving_accounts_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_receiving_accounts_number UNIQUE (organization_id, bank_code, account_number),
  CONSTRAINT fk_receiving_accounts_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id)
);
CREATE TRIGGER trg_receiving_accounts_updated BEFORE UPDATE ON receiving_accounts FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  property_id uuid NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('invoice_issued','payment_confirmed','payment_allocated','deposit_received',
    'deposit_deducted','deposit_refunded','credit_refunded','adjustment','reversal','opening_balance')),
  business_date date NOT NULL,
  source_doc_type text NOT NULL CHECK (source_doc_type IN ('invoice','payment','payment_allocation','deposit','lease_settlement',
    'approval_request','shift_discrepancy','import_batch')),
  source_doc_id uuid NOT NULL,
  reverses_entry_id uuid,
  memo text,
  created_by uuid,
  command_id uuid,
  currency char(3) NOT NULL DEFAULT 'VND',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_journal_entries_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT uq_journal_entries_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_journal_entries_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_journal_entries_reverses FOREIGN KEY (organization_id, reverses_entry_id) REFERENCES journal_entries (organization_id, id),
  CONSTRAINT fk_journal_entries_created_by FOREIGN KEY (organization_id, created_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_journal_entries_reversal CHECK ((entry_type = 'reversal') = (reverses_entry_id IS NOT NULL))
);
-- Mỗi bút toán chỉ được đảo một lần.
CREATE UNIQUE INDEX uq_journal_entries_reversed_once ON journal_entries (organization_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX ix_journal_entries_date ON journal_entries (organization_id, property_id, business_date);
CREATE INDEX ix_journal_entries_source ON journal_entries (organization_id, source_doc_type, source_doc_id);

CREATE TABLE journal_lines (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  property_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no >= 1),
  account text NOT NULL CHECK (account IN ('CASH','BANK','AR','DEPOSIT_LIAB','CUSTOMER_CREDIT','REV_ROOM','REV_UTIL','REV_SERVICE',
    'REV_FEE','DISCOUNT','OPENING_BALANCE')),
  debit bigint NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
  person_id uuid,
  receiving_account_id uuid,
  shift_id uuid,
  invoice_id uuid,
  invoice_line_id uuid,
  deposit_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_journal_lines_no UNIQUE (organization_id, entry_id, line_no),
  CONSTRAINT fk_journal_lines_entry FOREIGN KEY (organization_id, property_id, entry_id)
    REFERENCES journal_entries (organization_id, property_id, id),
  CONSTRAINT fk_journal_lines_person FOREIGN KEY (organization_id, person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT fk_journal_lines_receiving_account FOREIGN KEY (organization_id, receiving_account_id)
    REFERENCES receiving_accounts (organization_id, id),
  CONSTRAINT ck_journal_lines_one_side CHECK ((debit > 0) <> (credit > 0)),
  CONSTRAINT ck_journal_lines_credit_person CHECK (account <> 'CUSTOMER_CREDIT' OR person_id IS NOT NULL),
  CONSTRAINT ck_journal_lines_bank CHECK (account <> 'BANK' OR receiving_account_id IS NOT NULL),
  CONSTRAINT ck_journal_lines_cash CHECK (account <> 'CASH' OR shift_id IS NOT NULL),
  CONSTRAINT ck_journal_lines_deposit CHECK (account <> 'DEPOSIT_LIAB' OR deposit_id IS NOT NULL),
  CONSTRAINT ck_journal_lines_ar CHECK (account <> 'AR' OR invoice_id IS NOT NULL)
);
CREATE INDEX ix_journal_lines_account ON journal_lines (organization_id, account, property_id);
CREATE INDEX ix_journal_lines_invoice ON journal_lines (organization_id, invoice_id) WHERE invoice_id IS NOT NULL;

-- INV-F1: mỗi bút toán có ≥ 2 dòng và Σ Nợ = Σ Có — kiểm lúc COMMIT (cho phép chèn từng dòng trong transaction).
CREATE FUNCTION app.check_entry_balanced() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint; n integer; e uuid;
BEGIN
  IF TG_TABLE_NAME = 'journal_lines' THEN e := NEW.entry_id; ELSE e := NEW.id; END IF;
  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0), count(*) INTO d, c, n FROM journal_lines WHERE entry_id = e;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'bút toán % lệch hoặc thiếu dòng (Nợ %, Có %, % dòng)', e, d, c, n
      USING ERRCODE = '23514', HINT = 'LEDGER_UNBALANCED';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_entry_balanced();
CREATE CONSTRAINT TRIGGER trg_journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_entry_balanced();

-- Append-only (INV-G4).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['journal_entries','journal_lines'] LOOP
    EXECUTE format('CREATE TRIGGER trg_%1$s_append_only BEFORE UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_no_truncate BEFORE TRUNCATE ON %1$I FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END $$;

CREATE TABLE inbox (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  account text NOT NULL,
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  raw jsonb NOT NULL,
  signature_verified boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  process_status text NOT NULL DEFAULT 'pending' CHECK (process_status IN ('pending','processed','broken','ignored')),
  processed_at timestamptz,
  process_error text,
  bank_transaction_id uuid,
  CONSTRAINT uq_inbox_event UNIQUE (provider, account, provider_event_id),
  CONSTRAINT uq_inbox_org_id UNIQUE (organization_id, id)
);
CREATE INDEX ix_inbox_pending ON inbox (process_status, received_at) WHERE process_status = 'pending';

-- Nội dung inbox bất biến; chỉ cột xử lý được đổi.
CREATE FUNCTION app.inbox_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider OR NEW.account IS DISTINCT FROM OLD.account
     OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.raw IS DISTINCT FROM OLD.raw OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'nội dung inbox % không được sửa', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF OLD.bank_transaction_id IS NOT NULL AND NEW.bank_transaction_id IS DISTINCT FROM OLD.bank_transaction_id THEN
    RAISE EXCEPTION 'inbox % đã gắn giao dịch ngân hàng', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_inbox_immutable BEFORE UPDATE ON inbox FOR EACH ROW EXECUTE FUNCTION app.inbox_immutable();
CREATE TRIGGER trg_inbox_no_delete BEFORE DELETE ON inbox FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

CREATE TABLE bank_transactions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  property_id uuid NOT NULL,
  receiving_account_id uuid NOT NULL,
  bank_txn_ref text NOT NULL CHECK (length(bank_txn_ref) BETWEEN 1 AND 100),
  ref_derived boolean NOT NULL DEFAULT false,
  amount bigint NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'VND',
  occurred_at timestamptz NOT NULL,
  description text,
  balance_after bigint,
  first_source text NOT NULL CHECK (first_source IN ('webhook','statement','manual')),
  raw_hash text NOT NULL CHECK (raw_hash ~ '^[0-9a-f]{64}$'),
  inbox_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- INV-F4b: một giao dịch ngân hàng = một hàng, dù đến từ webhook, sao kê hay nhập tay.
  CONSTRAINT uq_bank_transactions_ref UNIQUE (receiving_account_id, bank_txn_ref),
  CONSTRAINT uq_bank_transactions_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_bank_transactions_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_bank_transactions_account FOREIGN KEY (organization_id, receiving_account_id)
    REFERENCES receiving_accounts (organization_id, id),
  CONSTRAINT fk_bank_transactions_inbox FOREIGN KEY (organization_id, inbox_id) REFERENCES inbox (organization_id, id)
);
CREATE INDEX ix_bank_transactions_time ON bank_transactions (organization_id, property_id, occurred_at);
CREATE TRIGGER trg_bank_transactions_append_only BEFORE UPDATE OR DELETE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER trg_bank_transactions_no_truncate BEFORE TRUNCATE ON bank_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
ALTER TABLE inbox ADD CONSTRAINT fk_inbox_bank_transaction FOREIGN KEY (organization_id, bank_transaction_id)
  REFERENCES bank_transactions (organization_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['receiving_accounts','journal_entries','journal_lines','inbox','bank_transactions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = app.current_org()) '
                   'WITH CHECK (organization_id = app.current_org())', t);
  END LOOP;
END $$;

-- Webhook đến KHÔNG có ngữ cảnh tổ chức: tra chủ của tài khoản nhận (id toàn cục trong URL) qua hàm phạm vi hẹp.
CREATE FUNCTION app.receiving_account_owner(p_id uuid)
  RETURNS TABLE (organization_id uuid, property_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT r.organization_id, r.property_id FROM receiving_accounts r WHERE r.id = p_id AND r.active
  $$;
REVOKE ALL ON FUNCTION app.receiving_account_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.receiving_account_owner(uuid) TO app_runtime, app_worker;

GRANT SELECT, INSERT, UPDATE ON receiving_accounts TO app_runtime;
GRANT SELECT, INSERT ON journal_entries, journal_lines, bank_transactions TO app_runtime, app_worker;
GRANT SELECT, INSERT ON inbox TO app_runtime, app_worker;
GRANT UPDATE (process_status, processed_at, process_error, bank_transaction_id) ON inbox TO app_runtime, app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.receiving_account_owner(uuid);
ALTER TABLE IF EXISTS inbox DROP CONSTRAINT IF EXISTS fk_inbox_bank_transaction;
DROP TABLE IF EXISTS bank_transactions, inbox, journal_lines, journal_entries, receiving_accounts;
DROP FUNCTION IF EXISTS app.inbox_immutable();
DROP FUNCTION IF EXISTS app.check_entry_balanced();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
