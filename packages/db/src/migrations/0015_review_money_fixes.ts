// Sửa theo review độc lập lát tiền (T-104…T-108), phát hiện R5: chênh lệch ca sửa được ở tầng CSDL.
// `shift_discrepancies`: số tiền/ca/loại bất biến; đóng một lần; chỉ owner/manager ghi (SPEC-ledger mục 4: "manager/owner xử
// lý; accountant đọc"); người chịu trách nhiệm chỉ đọc. Ghi khi đóng ca/nhận bàn giao vẫn qua INSERT.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.shift_discrepancy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'resolved'
     OR (to_jsonb(NEW) - ARRAY['responsible_membership_id','status','resolved_by','resolved_at','adjustment_entry_id',
                               'resolution_note','updated_at','version'])
        <> (to_jsonb(OLD) - ARRAY['responsible_membership_id','status','resolved_by','resolved_at','adjustment_entry_id',
                                  'resolution_note','updated_at','version']) THEN
    RAISE EXCEPTION 'chênh lệch ca %: không sửa số tiền/ca; đã xử lý thì bất biến', OLD.id
      USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_shift_discrepancies_guard BEFORE UPDATE ON shift_discrepancies FOR EACH ROW
  EXECUTE FUNCTION app.shift_discrepancy_guard();

DROP POLICY tenant_isolation ON shift_discrepancies;
CREATE POLICY discrepancies_read ON shift_discrepancies FOR SELECT
  USING (organization_id = app.current_org()
         AND (responsible_membership_id = nullif(current_setting('app.actor_id', true), '')::uuid
              OR (app.actor_role() IN ('owner','manager','accountant') AND app.actor_can_see_property(property_id))));
CREATE POLICY discrepancies_insert ON shift_discrepancies FOR INSERT
  WITH CHECK (organization_id = app.current_org() AND status = 'open');
CREATE POLICY discrepancies_update ON shift_discrepancies FOR UPDATE
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org());
`;

const DOWN = `
DROP POLICY IF EXISTS discrepancies_update ON shift_discrepancies;
DROP POLICY IF EXISTS discrepancies_insert ON shift_discrepancies;
DROP POLICY IF EXISTS discrepancies_read ON shift_discrepancies;
CREATE POLICY tenant_isolation ON shift_discrepancies
  USING (organization_id = app.current_org()
         AND (responsible_membership_id = nullif(current_setting('app.actor_id', true), '')::uuid
              OR (app.actor_role() IN ('owner','manager','accountant') AND app.actor_can_see_property(property_id))))
  WITH CHECK (organization_id = app.current_org());
DROP TRIGGER IF EXISTS trg_shift_discrepancies_guard ON shift_discrepancies;
DROP FUNCTION IF EXISTS app.shift_discrepancy_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
