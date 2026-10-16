// PLAN đợt 3 T-207 — thông báo lưu trú (SPEC-reservation-stay S-028…S-030, Q-13; SPEC-notifications S-014…S-016, S-020, S-021; ERD
// `residence_notices`; INV-G1, INV-G2, INV-G6). Hệ thống chỉ xuất file + ghi dấu vết, KHÔNG gửi cho cơ quan nhà nước.
// - `residence_notices`: một dòng mỗi lượt ở (unique stay), chỉ đi tiến `pending → exported → submitted`; `submitted` là cuối (bất biến);
//   không có DELETE. `due_at` NULL khi cơ sở chưa cấu hình hạn (không có mặc định cứng — Q-13). Không chứa PII (tên/số giấy tờ ở nơi khác).
// - RLS: owner/manager/lễ tân trong phạm vi cơ sở đọc/ghi; buồng phòng/bảo trì/kế toán không thấy hàng nào; ngữ cảnh hệ thống (không
//   actor, worker) đọc theo tổ chức. `files` loại `residence_notice` mở bằng POLICY BỔ SUNG (không thay `tenant_isolation`) cho đúng ba vai trò.
// - `app.residence_notice_due_at`: tính hạn theo cấu hình `notification_settings.stay_notice_deadline` + `properties.timezone` (SECURITY
//   DEFINER vì lễ tân không đọc được `notification_settings`; chỉ trả một mốc thời gian, chỉ cho tổ chức hiện tại).
//   Quy tắc (giá trị là CẤU HÌNH, nguồn pháp lý [T] chưa đối chiếu bản gốc):
//     • khách nước ngoài + `foreign_guest_hours`  → giờ đến + N giờ (S-015: 14:00 + 12 giờ = 02:00 hôm sau);
//     • giờ đến < `late_arrival_after` (mặc định = `before_time`) → `before_time` cùng ngày địa phương (S-014);
//     • giờ đến ≥ `late_arrival_after` → `late_deadline_time` HÔM SAU (S-015: 23:40 → 08:00 hôm sau; 23:00 đúng giờ tính là "sau");
//     • giờ đến trước `late_deadline_time` (đêm qua nửa đêm, vd 01:30) → `late_deadline_time` CÙNG ngày (cách hiểu chặt hơn — SPEC hở);
//     • thiếu thông số cần cho nhánh áp dụng, hoặc giá trị hỏng → NULL (coi như chưa cấu hình, không làm hỏng check-in).
// - Hai hàm đọc `notification_settings` (bảng tạo ở 0040, sau migration này) viết bằng plpgsql nên thân hàm chỉ được kiểm khi chạy.
// - `app.residence_notice_template`: mẫu file xuất của cơ sở cho owner/manager/lễ tân (đọc qua hàm vì RLS `notification_settings` chỉ cho owner/manager).
// - `app.residence_notices_due`: job nhắc (worker, xuyên tổ chức) nhận các thông báo `pending`/`exported` có `due_at` kèm GIAI ĐOẠN nhắc
//   mới nhất chưa có sự kiện: `due` (nhắc đầu) → `urgent` (còn ≤ p_urgent_minutes) → `overdue` (mỗi ngày kinh doanh một lần).
//   Chỉ trả id + giai đoạn + ngày; dedupe theo outbox.dedupe_key nên chạy lại/song song không phát trùng; `submitted` không bao giờ được chọn.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE residence_notices (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  stay_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','exported','submitted')),
  is_foreign boolean NOT NULL DEFAULT false,
  due_at timestamptz,
  exported_at timestamptz,
  exported_by uuid,
  export_file_id uuid,
  submitted_at timestamptz,
  submitted_by uuid,
  channel text CHECK (channel IN ('in_person','online','other')),
  evidence_file_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_residence_notices_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_residence_notices_stay UNIQUE (organization_id, stay_id),
  CONSTRAINT fk_residence_notices_stay FOREIGN KEY (organization_id, property_id, stay_id)
    REFERENCES stays (organization_id, property_id, id),
  CONSTRAINT fk_residence_notices_exported_by FOREIGN KEY (organization_id, exported_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_residence_notices_submitted_by FOREIGN KEY (organization_id, submitted_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_residence_notices_export_file FOREIGN KEY (organization_id, export_file_id) REFERENCES files (organization_id, id),
  CONSTRAINT fk_residence_notices_evidence_file FOREIGN KEY (organization_id, evidence_file_id) REFERENCES files (organization_id, id),
  CONSTRAINT ck_residence_notices_exported
    CHECK ((exported_at IS NULL) = (exported_by IS NULL) AND (exported_at IS NULL) = (export_file_id IS NULL)),
  CONSTRAINT ck_residence_notices_status_exported CHECK (status = 'pending' OR status = 'submitted' OR exported_at IS NOT NULL),
  CONSTRAINT ck_residence_notices_submitted
    CHECK (status <> 'submitted' OR (submitted_at IS NOT NULL AND submitted_by IS NOT NULL AND channel IS NOT NULL)),
  CONSTRAINT ck_residence_notices_not_submitted
    CHECK (status = 'submitted' OR (submitted_at IS NULL AND submitted_by IS NULL AND channel IS NULL AND evidence_file_id IS NULL))
);
CREATE INDEX ix_residence_notices_due ON residence_notices (organization_id, property_id, status, due_at);
CREATE TRIGGER trg_residence_notices_updated BEFORE UPDATE ON residence_notices
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_residence_notices_no_delete BEFORE DELETE OR TRUNCATE ON residence_notices
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- Chỉ đi tiến; đã nộp thì bất biến; định danh không đổi.
CREATE FUNCTION app.residence_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rank_old integer; rank_new integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'thông báo lưu trú mới phải ở pending, không phải %', NEW.status
        USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.property_id, NEW.stay_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.property_id, OLD.stay_id, OLD.created_at) THEN
    RAISE EXCEPTION 'thông báo lưu trú %: không sửa định danh', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF OLD.status = 'submitted' AND
     (NEW.status, NEW.is_foreign, NEW.due_at, NEW.exported_at, NEW.exported_by, NEW.export_file_id, NEW.submitted_at,
      NEW.submitted_by, NEW.channel, NEW.evidence_file_id)
     IS DISTINCT FROM
     (OLD.status, OLD.is_foreign, OLD.due_at, OLD.exported_at, OLD.exported_by, OLD.export_file_id, OLD.submitted_at,
      OLD.submitted_by, OLD.channel, OLD.evidence_file_id) THEN
    RAISE EXCEPTION 'thông báo lưu trú % đã đánh dấu đã thông báo, không sửa', OLD.id
      USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  rank_old := CASE OLD.status WHEN 'pending' THEN 0 WHEN 'exported' THEN 1 ELSE 2 END;
  rank_new := CASE NEW.status WHEN 'pending' THEN 0 WHEN 'exported' THEN 1 ELSE 2 END;
  IF rank_new < rank_old THEN
    RAISE EXCEPTION 'thông báo lưu trú %: không lùi trạng thái từ % về %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_residence_notices_guard BEFORE INSERT OR UPDATE ON residence_notices
  FOR EACH ROW EXECUTE FUNCTION app.residence_notice_guard();

ALTER TABLE residence_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE residence_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY residence_notices_read ON residence_notices FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR (app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id))));
CREATE POLICY residence_notices_write ON residence_notices FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
              AND app.actor_can_see_property(property_id));
GRANT SELECT, INSERT, UPDATE ON residence_notices TO app_runtime;
GRANT SELECT ON residence_notices TO app_worker;

-- File xuất/bằng chứng của thông báo lưu trú: policy bổ sung (OR với tenant_isolation) — không đụng policy gốc của \`files\`.
CREATE POLICY files_residence_notice ON files FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND owner_type = 'residence_notice'
         AND app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org());

CREATE FUNCTION app.residence_notice_due_at(p_property uuid, p_checked_in timestamptz, p_foreign boolean)
  RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cfg jsonb; tz text; lt timestamp; ld date; t time;
  before_t time; late_after time; late_until time; due timestamptz;
BEGIN
  SELECT ns.stay_notice_deadline, p.timezone INTO cfg, tz
  FROM properties p
  LEFT JOIN notification_settings ns ON ns.organization_id = p.organization_id AND ns.property_id = p.id
  WHERE p.organization_id = app.current_org() AND p.id = p_property;
  IF cfg IS NULL OR cfg = '{}'::jsonb THEN RETURN NULL; END IF;
  IF p_foreign AND cfg ? 'foreign_guest_hours' THEN
    RETURN p_checked_in + make_interval(hours => (cfg ->> 'foreign_guest_hours')::integer);
  END IF;
  before_t := (cfg ->> 'before_time')::time;
  IF before_t IS NULL THEN RETURN NULL; END IF;
  late_after := coalesce((cfg ->> 'late_arrival_after')::time, before_t);
  late_until := (cfg ->> 'late_deadline_time')::time;
  lt := p_checked_in AT TIME ZONE tz;
  ld := lt::date;
  t := lt::time;
  IF t >= late_after THEN
    IF late_until IS NULL THEN RETURN NULL; END IF;
    RETURN ((ld + 1) + late_until) AT TIME ZONE tz;
  END IF;
  IF late_until IS NOT NULL AND late_until < late_after AND t < late_until THEN
    RETURN (ld + late_until) AT TIME ZONE tz;
  END IF;
  due := (ld + before_t) AT TIME ZONE tz;
  RETURN greatest(due, p_checked_in);
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

CREATE FUNCTION app.residence_notice_template(p_property uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE tpl jsonb;
BEGIN
  IF app.actor_role() IS NULL OR app.actor_role() NOT IN ('owner','manager','front_desk')
     OR NOT app.actor_can_see_property(p_property) THEN
    RETURN NULL;
  END IF;
  SELECT ns.residence_notice_template INTO tpl FROM notification_settings ns
  WHERE ns.organization_id = app.current_org() AND ns.property_id = p_property;
  RETURN tpl;
END $$;

CREATE FUNCTION app.residence_notices_due(p_now timestamptz, p_urgent_minutes integer, p_limit integer)
  RETURNS TABLE (organization_id uuid, property_id uuid, notice_id uuid, stay_id uuid, due_at timestamptz, phase text,
                 business_date date, dedupe_key text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT n.organization_id, n.property_id, n.id, n.stay_id, n.due_at, ph.phase, t.bd, k.key
    FROM residence_notices n
    JOIN properties p ON p.organization_id = n.organization_id AND p.id = n.property_id
    CROSS JOIN LATERAL (SELECT ((p_now AT TIME ZONE p.timezone) - p.business_day_cutoff)::date AS bd) t
    CROSS JOIN LATERAL (SELECT CASE WHEN p_now >= n.due_at THEN 'overdue'
                                    WHEN p_now >= n.due_at - make_interval(mins => greatest(p_urgent_minutes, 0)) THEN 'urgent'
                                    ELSE 'due' END AS phase) ph
    CROSS JOIN LATERAL (SELECT CASE ph.phase WHEN 'overdue' THEN 'stay_notice.overdue:' || n.id::text || ':' || t.bd::text
                                             ELSE 'stay_notice.' || ph.phase || ':' || n.id::text END AS key) k
    WHERE n.status IN ('pending','exported') AND n.due_at IS NOT NULL AND p.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.organization_id = n.organization_id AND o.dedupe_key = k.key)
    ORDER BY n.due_at, n.id
    LIMIT least(greatest(p_limit, 1), 5000)
  $$;

REVOKE ALL ON FUNCTION app.residence_notice_due_at(uuid, timestamptz, boolean), app.residence_notice_template(uuid),
  app.residence_notices_due(timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.residence_notice_due_at(uuid, timestamptz, boolean), app.residence_notice_template(uuid)
  TO app_runtime;
GRANT EXECUTE ON FUNCTION app.residence_notices_due(timestamptz, integer, integer) TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.residence_notices_due(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.residence_notice_template(uuid);
DROP FUNCTION IF EXISTS app.residence_notice_due_at(uuid, timestamptz, boolean);
DROP POLICY IF EXISTS files_residence_notice ON files;
DROP TABLE IF EXISTS residence_notices;
DROP FUNCTION IF EXISTS app.residence_notice_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
