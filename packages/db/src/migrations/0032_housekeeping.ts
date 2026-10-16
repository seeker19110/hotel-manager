// PLAN đợt 3 T-209 — việc buồng phòng (ERD `tasks`; SPEC-housekeeping-maintenance S-001…S-011, S-020, S-022; INV-G1).
// - `tasks`: một việc dọn đang mở mỗi phòng (unique một phần, S-002); mỗi nguồn (loại, id) tạo tối đa một việc (không tạo trùng khi
//   sự kiện chạy lại); nguồn thêm khi trùng việc đang mở ghi vào `extra_sources`.
// - Vòng đời kiểm ở CSDL (trigger `app.task_guard`) khớp `taskMachine` (domain) + chuyển `done → assigned` (nghiệm thu không đạt,
//   Q-05); quyền nghiệm thu (owner/manager; lễ tân khi `properties.settings.front_desk_can_inspect`) và tách quyền người làm/người
//   nghiệm thu (`properties.settings.separate_task_verification`, mặc định bật — Q-03) cũng kiểm ở trigger (phòng thủ hai lớp).
// - RLS: owner/manager/lễ tân đọc-ghi trong phạm vi cơ sở; buồng phòng đọc việc của cơ sở mình, chỉ nhận việc chưa giao hoặc cập
//   nhật việc được giao cho mình; vai trò khác không thấy hàng nào. Bảng không có cột tiền/khách/giấy tờ (S-020).
// - `app.housekeeping_arrivals`: giờ khách đến dự kiến hôm nay theo phòng (SECURITY DEFINER, chỉ trả mã phòng + giờ — buồng phòng
//   không đọc được `stays`/`reservations`).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.actor_membership_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.actor_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION app.actor_membership_id() TO app_runtime, app_worker;

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
  done_by uuid,
  done_at timestamptz,
  verified_by uuid,
  verified_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_tasks_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_tasks_unit FOREIGN KEY (organization_id, property_id, unit_id)
    REFERENCES units (organization_id, property_id, id),
  CONSTRAINT fk_tasks_assignee FOREIGN KEY (organization_id, assignee_membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_tasks_done_by FOREIGN KEY (organization_id, done_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_tasks_verified_by FOREIGN KEY (organization_id, verified_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_tasks_source CHECK (source_type = 'manual' OR source_id IS NOT NULL),
  CONSTRAINT ck_tasks_assignee CHECK (status IN ('open','cancelled') OR assignee_membership_id IS NOT NULL),
  CONSTRAINT ck_tasks_done CHECK (status NOT IN ('done','verified') OR (done_by IS NOT NULL AND done_at IS NOT NULL)),
  CONSTRAINT ck_tasks_verified CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)),
  CONSTRAINT ck_tasks_cancel CHECK (status <> 'cancelled' OR (cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) >= 1))
);
-- Không tạo việc dọn trùng cho một phòng (S-002) và không tạo hai việc cho cùng một nguồn (sự kiện chạy lại).
CREATE UNIQUE INDEX uq_tasks_open_cleaning ON tasks (organization_id, unit_id)
  WHERE kind = 'cleaning' AND status IN ('open','assigned','in_progress');
CREATE UNIQUE INDEX uq_tasks_source ON tasks (organization_id, kind, source_type, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX ix_tasks_list ON tasks (organization_id, property_id, status);
CREATE INDEX ix_tasks_unit ON tasks (organization_id, unit_id, created_at DESC, id DESC);
CREATE INDEX ix_tasks_assignee ON tasks (organization_id, assignee_membership_id) WHERE assignee_membership_id IS NOT NULL;
CREATE TRIGGER trg_tasks_updated BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Vòng đời việc (khớp taskMachine + done → assigned khi nghiệm thu không đạt) và quyền theo vai trò. Ngữ cảnh hệ thống (không
-- actor) chỉ được chuyển trạng thái không cần thẩm quyền; nghiệm thu luôn cần người có thẩm quyền.
CREATE FUNCTION app.task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_role text := app.actor_role();
  v_me uuid := app.actor_membership_id();
  v_settings jsonb;
  v_can_verify boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'việc mới phải ở open, không phải %', NEW.status USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.organization_id, NEW.property_id, NEW.unit_id, NEW.kind, NEW.source_type, NEW.source_id)
     IS DISTINCT FROM (OLD.organization_id, OLD.property_id, OLD.unit_id, OLD.kind, OLD.source_type, OLD.source_id) THEN
    RAISE EXCEPTION 'phòng/loại/nguồn của việc không đổi được' USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF OLD.status IN ('verified','cancelled') THEN
    RAISE EXCEPTION 'việc đã % không đổi được', OLD.status USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'open' AND NEW.status IN ('assigned','cancelled'))
         OR (OLD.status = 'assigned' AND NEW.status IN ('in_progress','cancelled'))
         OR (OLD.status = 'in_progress' AND NEW.status IN ('done','cancelled'))
         OR (OLD.status = 'done' AND NEW.status IN ('verified','assigned'))) THEN
      RAISE EXCEPTION 'không thể chuyển việc từ % sang %', OLD.status, NEW.status
        USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
    END IF;
    IF v_role = 'housekeeping' AND NOT ((OLD.status = 'open' AND NEW.status = 'assigned')
                                     OR (OLD.status = 'assigned' AND NEW.status = 'in_progress')
                                     OR (OLD.status = 'in_progress' AND NEW.status = 'done')) THEN
      RAISE EXCEPTION 'buồng phòng chỉ nhận/bắt đầu/hoàn tất việc của mình' USING ERRCODE = '42501', HINT = 'FORBIDDEN';
    END IF;
    IF NEW.status = 'cancelled' AND v_role IS NOT NULL AND v_role NOT IN ('owner','manager','front_desk') THEN
      RAISE EXCEPTION 'không có quyền huỷ việc' USING ERRCODE = '42501', HINT = 'FORBIDDEN';
    END IF;
    IF OLD.status = 'done' THEN
      -- Nghiệm thu (đạt hoặc không đạt): owner/manager, hoặc lễ tân khi cơ sở bật.
      SELECT settings INTO v_settings FROM properties WHERE organization_id = NEW.organization_id AND id = NEW.property_id;
      v_can_verify := coalesce(v_role IN ('owner','manager')
                               OR (v_role = 'front_desk' AND coalesce(v_settings ->> 'front_desk_can_inspect', 'false') = 'true'),
                               false);
      IF NOT v_can_verify THEN
        RAISE EXCEPTION 'không có quyền nghiệm thu' USING ERRCODE = '42501', HINT = 'FORBIDDEN';
      END IF;
      IF NEW.status = 'verified' THEN
        IF NEW.verified_by IS DISTINCT FROM v_me THEN
          RAISE EXCEPTION 'người nghiệm thu phải là người thao tác' USING ERRCODE = '42501', HINT = 'FORBIDDEN';
        END IF;
        IF coalesce(v_settings ->> 'separate_task_verification', 'true') <> 'false' AND NEW.verified_by = OLD.done_by THEN
          RAISE EXCEPTION 'người làm không tự nghiệm thu' USING ERRCODE = '42501', HINT = 'SELF_APPROVAL_FORBIDDEN';
        END IF;
      END IF;
    END IF;
  ELSE
    IF NEW.assignee_membership_id IS DISTINCT FROM OLD.assignee_membership_id THEN
      IF OLD.status NOT IN ('open','assigned') THEN
        RAISE EXCEPTION 'chỉ đổi người nhận khi việc chưa bắt đầu' USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
      END IF;
      IF v_role = 'housekeeping' THEN
        RAISE EXCEPTION 'buồng phòng không giao việc cho người khác' USING ERRCODE = '42501', HINT = 'FORBIDDEN';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_tasks_guard BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION app.task_guard();

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_read ON tasks FOR SELECT TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk','housekeeping')
         AND app.actor_can_see_property(property_id));
CREATE POLICY tasks_insert ON tasks FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
              AND app.actor_can_see_property(property_id) AND status = 'open');
CREATE POLICY tasks_update_staff ON tasks FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
              AND app.actor_can_see_property(property_id));
-- Buồng phòng: nhận việc chưa giao hoặc cập nhật việc được giao cho mình; không chuyển cho người khác.
CREATE POLICY tasks_update_housekeeping ON tasks FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() = 'housekeeping' AND app.actor_can_see_property(property_id)
         AND (assignee_membership_id = app.actor_membership_id() OR (assignee_membership_id IS NULL AND status = 'open')))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() = 'housekeeping'
              AND assignee_membership_id = app.actor_membership_id());
GRANT SELECT, INSERT, UPDATE ON tasks TO app_runtime;

-- Giờ khách đến dự kiến hôm nay (ngày kinh doanh của cơ sở) của cơ sở theo phòng, từ lượt ở \`expected\`. Chỉ trả (phòng, giờ): không tên khách,
-- không tiền. Vai trò đọc được \`tasks\` trong phạm vi cơ sở mới gọi được.
CREATE FUNCTION app.housekeeping_arrivals(p_property uuid, p_now timestamptz)
  RETURNS TABLE (unit_id uuid, arrival_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT a.unit_id, min(lower(a.during))
    FROM allocations a
    JOIN stays s ON s.organization_id = a.organization_id AND s.id = a.source_id
    WHERE app.actor_role() IN ('owner','manager','front_desk','housekeeping')
      AND app.actor_can_see_property(p_property)
      AND a.organization_id = app.current_org() AND a.property_id = p_property
      AND a.active AND a.kind = 'stay' AND a.source_type = 'stay'
      AND s.status = 'expected'
      AND app.business_date(a.organization_id, a.property_id, lower(a.during))
          = app.business_date(a.organization_id, a.property_id, p_now)
    GROUP BY a.unit_id
  $$;
REVOKE ALL ON FUNCTION app.housekeeping_arrivals(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.housekeeping_arrivals(uuid, timestamptz) TO app_runtime;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.housekeeping_arrivals(uuid, timestamptz);
DROP TABLE IF EXISTS tasks;
DROP FUNCTION IF EXISTS app.task_guard();
DROP FUNCTION IF EXISTS app.actor_membership_id();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
