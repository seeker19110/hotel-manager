// PLAN đợt 3 T-211 — thông báo (ERD `notifications`, `notification_deliveries`, `notification_preferences`,
// `notification_settings`; SPEC-notifications S-001…S-012, S-017…S-019; INV-G1, INV-G6).
// - Thông báo trong app: người nhận chỉ đọc/đánh dấu đã đọc của mình (RLS theo `app.actor_person_id()`); worker ghi trong
//   ngữ cảnh tổ chức (không actor), sau khi relay outbox đã COMMIT.
// - Lần gửi email (`notification_deliveries`): worker nhận bằng hàm SECURITY DEFINER phạm vi hẹp `app.notification_claim`
//   (SKIP LOCKED, đặt `sending` + khoá hạn) nên hai worker không nhận trùng; `sending` quá hạn khoá được nhận lại.
// - Lịch sử gửi theo quyền: `owner` toàn tổ chức, `manager` trong phạm vi cơ sở, vai trò khác không thấy (hàm đọc + policy).
// - Huỷ đăng ký từ email: hàm SECURITY DEFINER chỉ đổi đúng một (người, loại, email) sang `opted_out` + audit; runtime
//   không có quyền ghi preferences của người khác.
import { type Kysely, sql } from "kysely";

const TYPES = `'account_security','invoice_issued','invoice_overdue','lease_expiring','stay_notice_due','maintenance_status','export_ready'`;

const UP = `
CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid,
  recipient_person_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN (${TYPES})),
  severity text NOT NULL DEFAULT 'normal' CHECK (severity IN ('normal','urgent','overdue')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) <= 2000),
  link text CHECK (link IS NULL OR link ~ '^/[^/\\\\]'),
  -- Tham số không PII (id, nhãn kỳ thu, hạn…) để dựng email tối thiểu mà không đọc lại nội dung trong app.
  params jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 300),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notifications_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_notifications_dedupe UNIQUE (organization_id, dedupe_key, recipient_person_id),
  CONSTRAINT fk_notifications_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_notifications_recipient FOREIGN KEY (organization_id, recipient_person_id) REFERENCES persons (organization_id, id)
);
CREATE INDEX ix_notifications_recipient ON notifications (organization_id, recipient_person_id, read_at);
CREATE INDEX ix_notifications_list ON notifications (organization_id, recipient_person_id, created_at DESC, id DESC);

-- Loại M (chỉ read_at): mọi cột khác bất biến; đã đọc thì không về chưa đọc.
CREATE FUNCTION app.notification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at')
     OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
    RAISE EXCEPTION 'thông báo chỉ đổi được read_at (một lần)' USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_notifications_guard BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION app.notification_guard();

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid,
  notification_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','sent','retrying','failed','dead','suppressed')),
  suppressed_reason text CHECK (suppressed_reason IN ('NO_ADDRESS','OPTED_OUT','SETTLED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  locked_until timestamptz,
  provider_message_id text,
  last_error_code text CHECK (last_error_code IN ('RECIPIENT_INVALID','PROVIDER_TEMPORARY','TEMPLATE_ERROR')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_deliveries_channel UNIQUE (organization_id, notification_id, channel),
  CONSTRAINT fk_deliveries_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_deliveries_notification FOREIGN KEY (organization_id, notification_id)
    REFERENCES notifications (organization_id, id),
  CONSTRAINT ck_deliveries_suppressed CHECK ((status = 'suppressed') = (suppressed_reason IS NOT NULL)),
  CONSTRAINT ck_deliveries_sent CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX ix_deliveries_due ON notification_deliveries (next_attempt_at) WHERE status IN ('queued','retrying');
CREATE INDEX ix_deliveries_sending ON notification_deliveries (locked_until) WHERE status = 'sending';
CREATE INDEX ix_deliveries_list ON notification_deliveries (organization_id, property_id, created_at DESC, id DESC);
CREATE TRIGGER trg_deliveries_updated BEFORE UPDATE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE notification_preferences (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  person_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN (${TYPES})),
  channel text NOT NULL CHECK (channel IN ('email')),
  state text NOT NULL CHECK (state IN ('opted_in','opted_out')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('user','email_link','system')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notification_preferences UNIQUE (organization_id, person_id, type, channel),
  CONSTRAINT fk_preferences_person FOREIGN KEY (organization_id, person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT ck_preferences_required CHECK (NOT (state = 'opted_out' AND type = 'account_security'))
);

CREATE TABLE notification_settings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  overdue_reminder_offsets_days integer[] NOT NULL DEFAULT '{1}'
    CHECK (cardinality(overdue_reminder_offsets_days) BETWEEN 1 AND 10
           AND 0 <= ALL (overdue_reminder_offsets_days) AND 365 >= ALL (overdue_reminder_offsets_days)),
  lease_expiry_offsets_days integer[] NOT NULL DEFAULT '{30,7,0}'
    CHECK (cardinality(lease_expiry_offsets_days) BETWEEN 1 AND 10
           AND 0 <= ALL (lease_expiry_offsets_days) AND 365 >= ALL (lease_expiry_offsets_days)),
  stay_notice_deadline jsonb CHECK (stay_notice_deadline IS NULL OR jsonb_typeof(stay_notice_deadline) = 'object'),
  residence_notice_template jsonb CHECK (residence_notice_template IS NULL OR jsonb_typeof(residence_notice_template) = 'object'),
  send_window_start time NOT NULL DEFAULT '08:00',
  send_window_end time NOT NULL DEFAULT '20:00',
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_notification_settings UNIQUE (organization_id, property_id),
  CONSTRAINT fk_settings_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_settings_updated_by FOREIGN KEY (organization_id, updated_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_settings_window CHECK (send_window_end > send_window_start)
);
CREATE TRIGGER trg_notification_settings_updated BEFORE UPDATE ON notification_settings
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- RLS lớp 1 + lớp theo chủ thể/vai trò (ERD "RLS/quyền đặc biệt").
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_recipient_read ON notifications FOR SELECT TO app_runtime
  USING (organization_id = app.current_org() AND recipient_person_id = app.actor_person_id());
CREATE POLICY notifications_recipient_mark ON notifications FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND recipient_person_id = app.actor_person_id())
  WITH CHECK (organization_id = app.current_org() AND recipient_person_id = app.actor_person_id());
CREATE POLICY notifications_worker ON notifications FOR ALL TO app_worker
  USING (organization_id = app.current_org()) WITH CHECK (organization_id = app.current_org());
GRANT SELECT ON notifications TO app_runtime;
GRANT UPDATE (read_at) ON notifications TO app_runtime;
GRANT SELECT, INSERT ON notifications TO app_worker;

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY deliveries_manager_read ON notification_deliveries FOR SELECT TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
         AND app.actor_can_see_property(property_id));
-- Gửi lại thủ công: chỉ hàng dead/failed và chỉ về queued (S-019).
CREATE POLICY deliveries_manager_retry ON notification_deliveries FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
         AND app.actor_can_see_property(property_id) AND status IN ('dead','failed'))
  WITH CHECK (organization_id = app.current_org() AND status = 'queued');
CREATE POLICY deliveries_worker ON notification_deliveries FOR ALL TO app_worker
  USING (organization_id = app.current_org()) WITH CHECK (organization_id = app.current_org());
GRANT SELECT ON notification_deliveries TO app_runtime;
GRANT UPDATE (status, attempts, next_attempt_at, locked_until, last_error_code) ON notification_deliveries TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON notification_deliveries TO app_worker;

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY preferences_own ON notification_preferences FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND person_id = app.actor_person_id())
  WITH CHECK (organization_id = app.current_org() AND person_id = app.actor_person_id());
CREATE POLICY preferences_worker_read ON notification_preferences FOR SELECT TO app_worker
  USING (organization_id = app.current_org());
GRANT SELECT, INSERT, UPDATE ON notification_preferences TO app_runtime;
GRANT SELECT ON notification_preferences TO app_worker;

ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY settings_manager ON notification_settings FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager')
              AND app.actor_can_see_property(property_id));
CREATE POLICY settings_worker_read ON notification_settings FOR SELECT TO app_worker
  USING (organization_id = app.current_org());
GRANT SELECT, INSERT, UPDATE ON notification_settings TO app_runtime;
GRANT SELECT ON notification_settings TO app_worker;

-- Nhận các lần gửi tới hạn của MỌI tổ chức: queued/retrying đến hạn, hoặc sending đã quá hạn khoá (worker chết giữa chừng).
-- FOR UPDATE SKIP LOCKED + đặt 'sending' trong cùng câu lệnh ⇒ hai worker không nhận trùng; mỗi lần nhận tăng attempts.
CREATE FUNCTION app.notification_claim(p_now timestamptz, p_limit integer, p_lock_seconds integer)
  RETURNS TABLE (delivery_id uuid, org_id uuid, attempts integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT d.id FROM notification_deliveries d
      WHERE (d.status IN ('queued','retrying') AND d.next_attempt_at <= p_now)
         OR (d.status = 'sending' AND d.locked_until < p_now)
      ORDER BY d.next_attempt_at NULLS FIRST, d.id
      LIMIT least(greatest(p_limit, 1), 500)
      FOR UPDATE SKIP LOCKED)
    UPDATE notification_deliveries d
       SET status = 'sending', attempts = d.attempts + 1,
           locked_until = p_now + make_interval(secs => greatest(p_lock_seconds, 10))
      FROM due WHERE d.id = due.id
    RETURNING d.id, d.organization_id, d.attempts
  $$;

-- Lịch sử gửi theo quyền (S-018): owner toàn tổ chức, manager trong phạm vi cơ sở; vai trò khác không có hàng.
-- Trả metadata (loại, người nhận, trạng thái) — KHÔNG trả tiêu đề/nội dung thông báo.
CREATE FUNCTION app.list_notification_deliveries(p_status text, p_type text, p_recipient uuid, p_limit integer,
                                                 p_before_at timestamptz, p_before_id uuid)
  RETURNS TABLE (id uuid, property_id uuid, notification_id uuid, type text, recipient_person_id uuid, channel text,
                 status text, suppressed_reason text, attempts integer, next_attempt_at timestamptz,
                 last_error_code text, provider_message_id text, sent_at timestamptz, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT d.id, d.property_id, d.notification_id, n.type, n.recipient_person_id, d.channel, d.status, d.suppressed_reason,
           d.attempts, d.next_attempt_at, d.last_error_code, d.provider_message_id, d.sent_at, d.created_at
    FROM notification_deliveries d
    JOIN notifications n ON n.organization_id = d.organization_id AND n.id = d.notification_id
    WHERE d.organization_id = app.current_org()
      AND app.actor_role() IN ('owner','manager')
      AND app.actor_can_see_property(d.property_id)
      AND (p_status IS NULL OR d.status = p_status)
      AND (p_type IS NULL OR n.type = p_type)
      AND (p_recipient IS NULL OR n.recipient_person_id = p_recipient)
      AND (p_before_at IS NULL OR (d.created_at, d.id) < (p_before_at, p_before_id))
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT least(greatest(p_limit, 1), 200)
  $$;

-- Huỷ đăng ký từ liên kết email (S-010): chỉ đúng (người, loại, email) → opted_out, kèm audit. Trả 'changed'/'unchanged';
-- người không tồn tại cũng 'unchanged' (không lộ tồn tại tài khoản). Loại bắt buộc → PREFERENCE_REQUIRED.
CREATE FUNCTION app.notification_unsubscribe(p_org uuid, p_person uuid, p_type text, p_correlation text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_type = 'account_security' THEN
    RAISE EXCEPTION 'loại thông báo bắt buộc không tắt được' USING ERRCODE = 'check_violation', HINT = 'PREFERENCE_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM persons WHERE organization_id = p_org AND id = p_person) THEN
    RETURN 'unchanged';
  END IF;
  INSERT INTO notification_preferences (id, organization_id, person_id, type, channel, state, source)
  VALUES (gen_random_uuid(), p_org, p_person, p_type, 'email', 'opted_out', 'email_link')
  ON CONFLICT (organization_id, person_id, type, channel)
  DO UPDATE SET state = 'opted_out', changed_at = now(), source = 'email_link'
    WHERE notification_preferences.state <> 'opted_out'
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN 'unchanged'; END IF;
  INSERT INTO audit_events (id, organization_id, actor_type, actor_person_id, action, entity_type, entity_id, after, correlation_id)
  VALUES (gen_random_uuid(), p_org, 'user', p_person, 'notification.preference_changed', 'notification_preference', v_id,
          jsonb_build_object('type', p_type, 'channel', 'email', 'state', 'opted_out', 'source', 'email_link'), p_correlation);
  RETURN 'changed';
END $$;

REVOKE ALL ON FUNCTION app.notification_claim(timestamptz, integer, integer),
  app.list_notification_deliveries(text, text, uuid, integer, timestamptz, uuid),
  app.notification_unsubscribe(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notification_claim(timestamptz, integer, integer) TO app_worker;
GRANT EXECUTE ON FUNCTION app.list_notification_deliveries(text, text, uuid, integer, timestamptz, uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION app.notification_unsubscribe(uuid, uuid, text, text) TO app_runtime;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.notification_unsubscribe(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS app.list_notification_deliveries(text, text, uuid, integer, timestamptz, uuid);
DROP FUNCTION IF EXISTS app.notification_claim(timestamptz, integer, integer);
DROP TABLE IF EXISTS notification_settings, notification_preferences, notification_deliveries, notifications;
DROP FUNCTION IF EXISTS app.notification_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
