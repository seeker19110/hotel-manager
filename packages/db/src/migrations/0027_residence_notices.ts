// PLAN đợt 3 T-207 — dấu vết thông báo lưu trú + cấu hình thông báo theo cơ sở (ERD `residence_notices`,
// `notification_settings`; SPEC-reservation-stay S-012, S-028…S-030; SPEC-notifications Q-08). Hệ thống KHÔNG tự nộp cho cơ
// quan nhà nước: chỉ tạo `pending` khi khách nhận phòng, xuất file theo mẫu cơ sở, ghi dấu đã thông báo (T-210).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE notification_settings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  overdue_reminder_offsets_days integer[] NOT NULL DEFAULT '{1,3,7}',
  lease_expiry_offsets_days integer[] NOT NULL DEFAULT '{30,7}',
  stay_notice_deadline jsonb CHECK (stay_notice_deadline IS NULL OR jsonb_typeof(stay_notice_deadline) = 'object'),
  residence_notice_template jsonb CHECK (residence_notice_template IS NULL OR jsonb_typeof(residence_notice_template) = 'object'),
  send_window_start time NOT NULL DEFAULT '08:00',
  send_window_end time NOT NULL DEFAULT '20:00',
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_notification_settings_property UNIQUE (organization_id, property_id),
  CONSTRAINT fk_notification_settings_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_notification_settings_updated_by FOREIGN KEY (organization_id, updated_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_notification_settings_window CHECK (send_window_end > send_window_start),
  CONSTRAINT ck_notification_settings_offsets CHECK (0 <= ALL (overdue_reminder_offsets_days) AND 0 <= ALL (lease_expiry_offsets_days))
);
CREATE TRIGGER trg_notification_settings_updated BEFORE UPDATE ON notification_settings FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

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
  CONSTRAINT fk_residence_notices_stay FOREIGN KEY (organization_id, property_id, stay_id) REFERENCES stays (organization_id, property_id, id),
  CONSTRAINT fk_residence_notices_exported_by FOREIGN KEY (organization_id, exported_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_residence_notices_submitted_by FOREIGN KEY (organization_id, submitted_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_residence_notices_export_file FOREIGN KEY (organization_id, export_file_id) REFERENCES files (organization_id, id),
  CONSTRAINT fk_residence_notices_evidence FOREIGN KEY (organization_id, evidence_file_id) REFERENCES files (organization_id, id),
  CONSTRAINT ck_residence_notices_exported CHECK (status = 'pending' OR exported_at IS NOT NULL OR status = 'submitted'),
  CONSTRAINT ck_residence_notices_submitted CHECK (status <> 'submitted'
    OR (submitted_at IS NOT NULL AND submitted_by IS NOT NULL AND channel IS NOT NULL))
);
CREATE INDEX ix_residence_notices_due ON residence_notices (organization_id, property_id, status, due_at);
CREATE TRIGGER trg_residence_notices_updated BEFORE UPDATE ON residence_notices FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
-- Chỉ đi tiến pending → exported → submitted (pending → submitted được); đã submitted thì bất biến.
CREATE FUNCTION app.residence_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'submitted' OR (OLD.status = 'exported' AND NEW.status = 'pending')
     OR NEW.stay_id IS DISTINCT FROM OLD.stay_id OR NEW.is_foreign IS DISTINCT FROM OLD.is_foreign THEN
    RAISE EXCEPTION 'thông báo lưu trú %: không lùi trạng thái/không sửa sau khi đã thông báo', OLD.id
      USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_residence_notices_guard BEFORE UPDATE ON residence_notices FOR EACH ROW EXECUTE FUNCTION app.residence_notice_guard();
CREATE TRIGGER trg_residence_notices_no_delete BEFORE DELETE OR TRUNCATE ON residence_notices
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

ALTER TABLE residence_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE residence_notices FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_settings FORCE ROW LEVEL SECURITY;
-- Thông báo lưu trú: lễ tân/quản lý/owner; buồng phòng/kỹ thuật/kế toán không đọc (S-025, S-028). Worker đọc để nhắc.
CREATE POLICY residence_notices_read ON residence_notices FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR (app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id))));
CREATE POLICY residence_notices_write ON residence_notices FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
              AND app.actor_can_see_property(property_id));
CREATE POLICY notification_settings_read ON notification_settings FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR app.actor_can_see_property(property_id)));
CREATE POLICY notification_settings_write ON notification_settings FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
              AND app.actor_can_see_property(property_id));
GRANT SELECT, INSERT, UPDATE ON residence_notices, notification_settings TO app_runtime;
GRANT SELECT ON residence_notices, notification_settings TO app_worker;
`;

const DOWN = `
DROP TABLE IF EXISTS residence_notices, notification_settings;
DROP FUNCTION IF EXISTS app.residence_notice_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
