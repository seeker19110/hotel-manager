// PLAN đợt 3 T-212 — phiếu sự cố/sửa chữa (ERD `work_orders`; SPEC-housekeeping-maintenance S-012…S-019, S-021). Cùng vòng
// đời phiếu việc; ảnh là `files` owner_type `work_order` (chỉ `ready` mới gắn); block tham chiếu vòng `blocks.work_order_id`.
// Không có cột tiền/khách. Người thuê (portal) chỉ thấy phiếu mình báo.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE work_orders (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','in_progress','done','verified','cancelled')),
  source text NOT NULL CHECK (source IN ('staff','tenant')),
  reporter_membership_id uuid,
  reporter_person_id uuid,
  assignee_membership_id uuid,
  block_id uuid,
  resolution_note text CHECK (resolution_note IS NULL OR length(resolution_note) <= 2000),
  done_by uuid,
  done_at timestamptz,
  verified_by uuid,
  verified_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_work_orders_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_work_orders_unit FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id),
  CONSTRAINT fk_work_orders_reporter_m FOREIGN KEY (organization_id, reporter_membership_id) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_work_orders_reporter_p FOREIGN KEY (organization_id, reporter_person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT fk_work_orders_assignee FOREIGN KEY (organization_id, assignee_membership_id) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_work_orders_done_by FOREIGN KEY (organization_id, done_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_work_orders_verified_by FOREIGN KEY (organization_id, verified_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_work_orders_block FOREIGN KEY (organization_id, block_id) REFERENCES blocks (organization_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_work_orders_reporter CHECK (num_nonnulls(reporter_membership_id, reporter_person_id) = 1
    AND (source <> 'tenant' OR reporter_person_id IS NOT NULL)),
  CONSTRAINT ck_work_orders_assigned CHECK (status NOT IN ('assigned','in_progress','done') OR assignee_membership_id IS NOT NULL),
  CONSTRAINT ck_work_orders_done CHECK (status NOT IN ('done','verified') OR (done_by IS NOT NULL AND done_at IS NOT NULL)),
  CONSTRAINT ck_work_orders_verified CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)),
  CONSTRAINT ck_work_orders_cancelled CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
CREATE INDEX ix_work_orders_status ON work_orders (organization_id, property_id, status);
CREATE INDEX ix_work_orders_reporter ON work_orders (organization_id, reporter_person_id) WHERE reporter_person_id IS NOT NULL;
CREATE TRIGGER trg_work_orders_updated BEFORE UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE FUNCTION app.work_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('verified','cancelled') THEN
    RAISE EXCEPTION 'phiếu % đã kết thúc', OLD.id USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('assigned','cancelled'))
    OR (OLD.status = 'assigned' AND NEW.status IN ('in_progress','cancelled','assigned'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('done','cancelled'))
    OR (OLD.status = 'done' AND NEW.status IN ('verified','assigned'))) THEN
    RAISE EXCEPTION 'phiếu %: không chuyển % → %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  IF NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.reporter_membership_id IS DISTINCT FROM OLD.reporter_membership_id
     OR NEW.reporter_person_id IS DISTINCT FROM OLD.reporter_person_id THEN
    RAISE EXCEPTION 'phiếu %: không đổi phòng/người báo', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_work_orders_transition BEFORE UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION app.work_order_transition();
ALTER TABLE blocks ADD CONSTRAINT fk_blocks_work_order FOREIGN KEY (organization_id, work_order_id)
  REFERENCES work_orders (organization_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY work_orders_read ON work_orders FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR (app.actor_role() IN ('owner','manager','front_desk','housekeeping','maintenance') AND app.actor_can_see_property(property_id))
         OR (app.actor_role() = 'tenant' AND reporter_person_id = app.actor_person_id())));
CREATE POLICY work_orders_insert ON work_orders FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_org() AND (
    (app.actor_role() IN ('owner','manager','front_desk','housekeeping','maintenance') AND app.actor_can_see_property(property_id)
     AND reporter_membership_id = nullif(current_setting('app.actor_id', true), '')::uuid)
    OR (app.actor_role() = 'tenant' AND source = 'tenant' AND reporter_person_id = app.actor_person_id())));
CREATE POLICY work_orders_update ON work_orders FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_can_see_property(property_id) AND (
           app.actor_role() IN ('owner','manager')
           OR (app.actor_role() = 'maintenance' AND assignee_membership_id = nullif(current_setting('app.actor_id', true), '')::uuid)))
  WITH CHECK (organization_id = app.current_org() AND app.actor_can_see_property(property_id) AND (
           app.actor_role() IN ('owner','manager')
           OR (app.actor_role() = 'maintenance' AND assignee_membership_id = nullif(current_setting('app.actor_id', true), '')::uuid)));
GRANT SELECT, INSERT, UPDATE ON work_orders TO app_runtime;
GRANT SELECT ON work_orders TO app_worker;
`;

const DOWN = `
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS fk_blocks_work_order;
DROP TABLE IF EXISTS work_orders;
DROP FUNCTION IF EXISTS app.work_order_transition();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
