// PLAN đợt 3 T-209 — check-out: việc dọn tạo CÙNG transaction (SPEC-reservation-stay S-020, SPEC-housekeeping S-001/S-002)
// nên bảng `tasks` (ERD) tạo ở đây; vòng đời giao/nhận/nghiệm thu ở T-211. Cho nợ khi trả phòng dùng đúng một lần một yêu cầu
// duyệt `allow_balance` (unique trên stays).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cleaning','inspection')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','in_progress','done','verified','cancelled')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','urgent')),
  assignee_membership_id uuid,
  source_type text NOT NULL CHECK (source_type IN ('stay','move','work_order','lease','manual')),
  source_id uuid,
  extra_sources jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(extra_sources) = 'array'),
  note text CHECK (note IS NULL OR length(note) <= 2000),
  due_at timestamptz,
  started_at timestamptz,
  done_by uuid,
  done_at timestamptz,
  verified_by uuid,
  verified_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 1000),
  previous_housekeeping_status text CHECK (previous_housekeeping_status IN ('dirty','assigned','cleaning','clean','inspected')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_tasks_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_tasks_unit FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id),
  CONSTRAINT fk_tasks_assignee FOREIGN KEY (organization_id, assignee_membership_id) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_tasks_done_by FOREIGN KEY (organization_id, done_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_tasks_verified_by FOREIGN KEY (organization_id, verified_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_tasks_created_by FOREIGN KEY (organization_id, created_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_tasks_assigned CHECK (status NOT IN ('assigned','in_progress','done') OR assignee_membership_id IS NOT NULL),
  CONSTRAINT ck_tasks_done CHECK (status NOT IN ('done','verified') OR (done_by IS NOT NULL AND done_at IS NOT NULL)),
  CONSTRAINT ck_tasks_verified CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)),
  CONSTRAINT ck_tasks_cancelled CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
-- Không tạo việc dọn trùng cho một phòng (SPEC-housekeeping S-002).
CREATE UNIQUE INDEX uq_tasks_open_cleaning ON tasks (organization_id, unit_id)
  WHERE kind = 'cleaning' AND status IN ('open','assigned','in_progress');
CREATE INDEX ix_tasks_status ON tasks (organization_id, property_id, status);
CREATE TRIGGER trg_tasks_updated BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
-- Vòng đời (DOMAIN-MODEL §4 + Q-05 nghiệm thu không đạt: done → assigned); việc đã kết thúc bất biến.
CREATE FUNCTION app.task_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('verified','cancelled') THEN
    RAISE EXCEPTION 'việc % đã kết thúc', OLD.id USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('assigned','cancelled'))
    OR (OLD.status = 'assigned' AND NEW.status IN ('in_progress','cancelled','assigned'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('done','cancelled'))
    OR (OLD.status = 'done' AND NEW.status IN ('verified','assigned'))) THEN
    RAISE EXCEPTION 'việc %: không chuyển % → %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  IF NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'việc %: không đổi phòng/loại việc', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_tasks_transition BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION app.task_transition();

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
-- Đọc: nhân viên vận hành trong phạm vi cơ sở (không có cột tiền/khách). Ghi: owner/manager/lễ tân (tạo khi check-out,
-- giao việc), buồng phòng (chỉ việc giao cho mình hoặc tự nhận việc open — kiểm thêm ở command).
CREATE POLICY tasks_read ON tasks FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR (app.actor_role() IN ('owner','manager','front_desk','housekeeping','maintenance') AND app.actor_can_see_property(property_id))));
CREATE POLICY tasks_insert ON tasks FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk','housekeeping','maintenance')
              AND app.actor_can_see_property(property_id));
CREATE POLICY tasks_update ON tasks FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_can_see_property(property_id) AND (
           app.actor_role() IN ('owner','manager','front_desk')
           OR (app.actor_role() = 'housekeeping' AND (assignee_membership_id = nullif(current_setting('app.actor_id', true), '')::uuid OR status = 'open'))))
  WITH CHECK (organization_id = app.current_org() AND app.actor_can_see_property(property_id) AND (
           app.actor_role() IN ('owner','manager','front_desk')
           OR (app.actor_role() = 'housekeeping' AND assignee_membership_id = nullif(current_setting('app.actor_id', true), '')::uuid)));
GRANT SELECT, INSERT, UPDATE ON tasks TO app_runtime;
GRANT SELECT ON tasks TO app_worker;

ALTER TABLE stays ADD COLUMN allow_balance_approval_id uuid;
ALTER TABLE stays ADD CONSTRAINT fk_stays_allow_balance FOREIGN KEY (organization_id, allow_balance_approval_id)
  REFERENCES approval_requests (organization_id, id);
CREATE UNIQUE INDEX uq_stays_allow_balance ON stays (organization_id, allow_balance_approval_id)
  WHERE allow_balance_approval_id IS NOT NULL;
`;

const DOWN = `
DROP INDEX IF EXISTS uq_stays_allow_balance;
ALTER TABLE stays DROP CONSTRAINT IF EXISTS fk_stays_allow_balance;
ALTER TABLE stays DROP COLUMN IF EXISTS allow_balance_approval_id;
DROP TABLE IF EXISTS tasks;
DROP FUNCTION IF EXISTS app.task_transition();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
