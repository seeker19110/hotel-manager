// PLAN đợt 2 T-102 — yêu cầu duyệt có hạn mức (ERD `approval_requests`; INV-F5, INV-F6, INV-G6; SPEC-access S-017,
// SPEC-ledger S-014/S-033). Người duyệt ≠ người lập ở CẢ CSDL; trạng thái kết thúc (executed/rejected/cancelled) bất biến.
// RLS: người lập thấy yêu cầu của mình; owner/manager/lễ tân thấy yêu cầu trong phạm vi cơ sở (để duyệt); kế toán thấy
// (money.read, đối soát) nhưng chỉ lập, không duyệt — app trả 403 như SPEC-ledger S-033; vai trò khác không thấy. Hạn mức so số tiền do authorize() ở app kiểm (APPROVAL_LIMIT_EXCEEDED).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE approval_requests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid,
  kind text NOT NULL CHECK (kind IN ('deposit_deduction','deposit_refund','credit_refund','adjustment','reversal','discount',
    'cancellation_fee','allow_balance','period_unlock','lease_settlement')),
  amount bigint CHECK (amount >= 0),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 1),
  subject_type text,
  subject_id uuid,
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  requested_by uuid NOT NULL,
  approved_by uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed','cancelled')),
  decided_at timestamptz,
  decision_note text,
  executed_at timestamptz,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_approval_requests_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_approval_requests_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_approval_requests_requested_by FOREIGN KEY (organization_id, requested_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_approval_requests_approved_by FOREIGN KEY (organization_id, approved_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_approval_requests_not_self CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT ck_approval_requests_decided CHECK (status IN ('pending','cancelled') OR (approved_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT ck_approval_requests_executed CHECK ((status = 'executed') = (executed_at IS NOT NULL))
);
CREATE INDEX ix_approval_requests_pending ON approval_requests (organization_id, status) WHERE status = 'pending';
CREATE INDEX ix_approval_requests_subject ON approval_requests (organization_id, subject_type, subject_id);
CREATE TRIGGER trg_approval_requests_updated BEFORE UPDATE ON approval_requests FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Trạng thái kết thúc bất biến; chỉ pending → approved|rejected|cancelled|executed và approved → executed.
CREATE FUNCTION app.approval_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('executed','rejected','cancelled')
     OR (OLD.status = 'approved' AND NEW.status NOT IN ('approved','executed'))
     OR NEW.requested_by <> OLD.requested_by OR NEW.kind <> OLD.kind
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.payload <> OLD.payload THEN
    RAISE EXCEPTION 'approval_requests: không thể chuyển % → % hoặc sửa nội dung yêu cầu', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', HINT = 'INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_approval_requests_transition BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION app.approval_transition();
CREATE TRIGGER trg_approval_requests_no_delete BEFORE DELETE OR TRUNCATE ON approval_requests
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_requests
  USING (organization_id = app.current_org()
         AND (requested_by = nullif(current_setting('app.actor_id', true), '')::uuid
              OR (app.actor_role() IN ('owner','manager','front_desk','accountant') AND app.actor_can_see_property(property_id))))
  WITH CHECK (organization_id = app.current_org()
         AND (requested_by = nullif(current_setting('app.actor_id', true), '')::uuid
              OR (app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id))));
GRANT SELECT, INSERT, UPDATE ON approval_requests TO app_runtime;
`;

const DOWN = `
DROP TABLE IF EXISTS approval_requests;
DROP FUNCTION IF EXISTS app.approval_transition();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
