// PLAN đợt 2 T-104 — ca quầy tối thiểu (ERD `shifts`, `shift_discrepancies`; SPEC-ledger "Ca quầy tối thiểu",
// S-027/S-028/S-034/S-035; INV-F3b, INV-F6). Tiền mặt dự kiến tính từ sổ phụ (dòng CASH gắn shift_id), không nhập tay.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE shifts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  opened_by uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_cash bigint NOT NULL CHECK (opening_cash >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','handed_over')),
  expected_cash bigint,
  counted_cash bigint CHECK (counted_cash >= 0),
  closed_by uuid,
  closed_at timestamptz,
  handed_to uuid,
  received_cash bigint CHECK (received_cash >= 0),
  received_at timestamptz,
  previous_shift_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_shifts_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_shifts_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT fk_shifts_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_shifts_opened_by FOREIGN KEY (organization_id, opened_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_shifts_closed_by FOREIGN KEY (organization_id, closed_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_shifts_handed_to FOREIGN KEY (organization_id, handed_to) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_shifts_previous FOREIGN KEY (organization_id, previous_shift_id) REFERENCES shifts (organization_id, id),
  CONSTRAINT ck_shifts_closed CHECK (status = 'open' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL
                                     AND counted_cash IS NOT NULL AND expected_cash IS NOT NULL)),
  CONSTRAINT ck_shifts_handover_self CHECK (handed_to IS NULL OR handed_to <> opened_by),
  CONSTRAINT ck_shifts_handed_over CHECK (status <> 'handed_over' OR (handed_to IS NOT NULL AND received_cash IS NOT NULL
                                          AND received_at IS NOT NULL))
);
-- Tối đa một ca đang mở mỗi nhân viên (SHIFT_ALREADY_OPEN).
CREATE UNIQUE INDEX uq_shifts_one_open ON shifts (organization_id, opened_by) WHERE status = 'open';
CREATE INDEX ix_shifts_status ON shifts (organization_id, property_id, status);
CREATE TRIGGER trg_shifts_updated BEFORE UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- INV-F6: sau khi đóng chỉ được ghi cột bàn giao (closed → handed_over); số đầu ca/đếm/dự kiến bất biến.
CREATE FUNCTION app.shift_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'handed_over'
     OR (OLD.status = 'closed' AND (NEW.status NOT IN ('closed','handed_over')
         OR NEW.opening_cash <> OLD.opening_cash OR NEW.counted_cash IS DISTINCT FROM OLD.counted_cash
         OR NEW.expected_cash IS DISTINCT FROM OLD.expected_cash OR NEW.closed_by IS DISTINCT FROM OLD.closed_by
         OR NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.opened_by <> OLD.opened_by))
     OR (OLD.status = 'open' AND (NEW.opening_cash <> OLD.opening_cash OR NEW.opened_by <> OLD.opened_by)) THEN
    RAISE EXCEPTION 'ca % đã chốt — không sửa được (INV-F6)', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_shifts_guard BEFORE UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION app.shift_guard();
CREATE TRIGGER trg_shifts_no_delete BEFORE DELETE OR TRUNCATE ON shifts FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

CREATE TABLE shift_discrepancies (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('close','handover')),
  amount bigint NOT NULL CHECK (amount <> 0),
  responsible_membership_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by uuid,
  resolved_at timestamptz,
  adjustment_entry_id uuid,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_shift_discrepancies_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_shift_discrepancies_kind UNIQUE (organization_id, shift_id, kind),
  CONSTRAINT fk_shift_discrepancies_shift FOREIGN KEY (organization_id, property_id, shift_id)
    REFERENCES shifts (organization_id, property_id, id),
  CONSTRAINT fk_shift_discrepancies_responsible FOREIGN KEY (organization_id, responsible_membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_shift_discrepancies_resolved_by FOREIGN KEY (organization_id, resolved_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_shift_discrepancies_entry FOREIGN KEY (organization_id, adjustment_entry_id) REFERENCES journal_entries (organization_id, id),
  CONSTRAINT ck_shift_discrepancies_resolved CHECK (status = 'open' OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL)),
  CONSTRAINT ck_shift_discrepancies_not_self CHECK (resolved_by IS NULL OR resolved_by <> responsible_membership_id)
);
CREATE TRIGGER trg_shift_discrepancies_updated BEFORE UPDATE ON shift_discrepancies FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_shift_discrepancies_no_delete BEFORE DELETE OR TRUNCATE ON shift_discrepancies
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- Dòng CASH của sổ phụ gắn đúng ca có thật (ERD journal_lines.shift_id).
ALTER TABLE journal_lines ADD CONSTRAINT fk_journal_lines_shift FOREIGN KEY (organization_id, shift_id)
  REFERENCES shifts (organization_id, id);

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts FORCE ROW LEVEL SECURITY;
ALTER TABLE shift_discrepancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_discrepancies FORCE ROW LEVEL SECURITY;
-- Đọc: lễ tân thấy ca trong phạm vi cơ sở (để SPEC-ledger S-034 trả 403 khi đóng ca người khác, không phải 404);
-- owner/manager/accountant cũng vậy. Ghi: chỉ chủ ca, người được giao ca, hoặc owner/manager/accountant trong phạm vi.
CREATE POLICY shifts_read ON shifts FOR SELECT
  USING (organization_id = app.current_org()
         AND (opened_by = nullif(current_setting('app.actor_id', true), '')::uuid
              OR handed_to = nullif(current_setting('app.actor_id', true), '')::uuid
              OR (app.actor_role() IN ('owner','manager','accountant','front_desk') AND app.actor_can_see_property(property_id))));
CREATE POLICY shifts_open ON shifts FOR INSERT
  WITH CHECK (organization_id = app.current_org() AND opened_by = nullif(current_setting('app.actor_id', true), '')::uuid);
CREATE POLICY shifts_write ON shifts FOR UPDATE
  USING (organization_id = app.current_org()
         AND (opened_by = nullif(current_setting('app.actor_id', true), '')::uuid
              OR handed_to = nullif(current_setting('app.actor_id', true), '')::uuid
              OR (app.actor_role() IN ('owner','manager','accountant') AND app.actor_can_see_property(property_id))))
  WITH CHECK (organization_id = app.current_org()
         AND (opened_by = nullif(current_setting('app.actor_id', true), '')::uuid
              OR handed_to = nullif(current_setting('app.actor_id', true), '')::uuid
              OR (app.actor_role() IN ('owner','manager','accountant') AND app.actor_can_see_property(property_id))));
CREATE POLICY tenant_isolation ON shift_discrepancies
  USING (organization_id = app.current_org()
         AND (responsible_membership_id = nullif(current_setting('app.actor_id', true), '')::uuid
              OR (app.actor_role() IN ('owner','manager','accountant') AND app.actor_can_see_property(property_id))))
  WITH CHECK (organization_id = app.current_org());
GRANT SELECT, INSERT, UPDATE ON shifts, shift_discrepancies TO app_runtime;
`;

const DOWN = `
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS fk_journal_lines_shift;
DROP TABLE IF EXISTS shift_discrepancies, shifts;
DROP FUNCTION IF EXISTS app.shift_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
