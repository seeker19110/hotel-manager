// PLAN đợt 3 T-213 — thông báo trong app + lần gửi email (ERD `notifications`, `notification_deliveries`,
// `notification_preferences`; SPEC-notifications S-001…S-006, S-012). Worker sinh thông báo từ outbox SAU commit (INV-G6);
// dedupe bằng unique; lần gửi có vòng đời trong CSDL (trigger) và được nhận theo lô qua hàm SECURITY DEFINER hẹp
// (FOR UPDATE SKIP LOCKED, giới hạn mỗi tổ chức mỗi lượt — rate limit Q-05). `sending` quá hạn khoá → `retrying`.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid,
  recipient_person_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('account_security','invoice_issued','invoice_overdue','lease_expiring','stay_notice_due',
                                     'maintenance_status','export_ready')),
  severity text NOT NULL DEFAULT 'normal' CHECK (severity IN ('normal','urgent','overdue')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  link text CHECK (link IS NULL OR link ~ '^/[A-Za-z0-9/_?=&.-]*$'),
  vars jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(vars) = 'object'),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 300),
  source_outbox_id uuid,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notifications_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_notifications_dedupe UNIQUE (organization_id, dedupe_key, recipient_person_id),
  CONSTRAINT fk_notifications_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_notifications_recipient FOREIGN KEY (organization_id, recipient_person_id) REFERENCES persons (organization_id, id)
);
CREATE INDEX ix_notifications_recipient ON notifications (organization_id, recipient_person_id, read_at);
-- Chỉ \`read_at\` đổi được (loại M); đánh dấu đã đọc không lùi.
CREATE FUNCTION app.notification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at') THEN
    RAISE EXCEPTION 'thông báo % chỉ đổi read_at', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    NEW.read_at := OLD.read_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_notifications_guard BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION app.notification_guard();

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid,
  notification_id uuid NOT NULL,
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','retrying','failed','dead','suppressed')),
  suppressed_reason text CHECK (suppressed_reason IN ('NO_ADDRESS','OPTED_OUT','SETTLED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  locked_until timestamptz,
  provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 300),
  last_error_code text CHECK (last_error_code IN ('RECIPIENT_INVALID','PROVIDER_TEMPORARY','TEMPLATE_ERROR')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notification_deliveries_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_notification_deliveries_channel UNIQUE (organization_id, notification_id, channel),
  CONSTRAINT fk_notification_deliveries_notification FOREIGN KEY (organization_id, notification_id)
    REFERENCES notifications (organization_id, id),
  CONSTRAINT fk_notification_deliveries_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT ck_notification_deliveries_suppressed CHECK ((status = 'suppressed') = (suppressed_reason IS NOT NULL)),
  CONSTRAINT ck_notification_deliveries_sent CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT ck_notification_deliveries_sending CHECK (status <> 'sending' OR locked_until IS NOT NULL),
  CONSTRAINT ck_notification_deliveries_due CHECK (status NOT IN ('queued','retrying') OR next_attempt_at IS NOT NULL)
);
CREATE INDEX ix_notification_deliveries_due ON notification_deliveries (next_attempt_at) WHERE status IN ('queued','retrying');
CREATE INDEX ix_notification_deliveries_sending ON notification_deliveries (locked_until) WHERE status = 'sending';
CREATE TRIGGER trg_notification_deliveries_updated BEFORE UPDATE ON notification_deliveries FOR EACH ROW
  EXECUTE FUNCTION app.set_updated_at();
CREATE FUNCTION app.notification_delivery_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.notification_id IS DISTINCT FROM OLD.notification_id OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'lần gửi %: không đổi thông báo/kênh', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status IN ('queued','retrying') AND NEW.status IN ('sending','suppressed'))
    OR (OLD.status = 'sending' AND NEW.status IN ('sent','retrying','failed','dead','suppressed'))
    OR (OLD.status IN ('failed','dead') AND NEW.status = 'queued')) THEN
    RAISE EXCEPTION 'lần gửi %: không chuyển % → %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_notification_deliveries_transition BEFORE UPDATE ON notification_deliveries FOR EACH ROW
  EXECUTE FUNCTION app.notification_delivery_transition();

CREATE TABLE notification_preferences (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  person_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('account_security','invoice_issued','invoice_overdue','lease_expiring','stay_notice_due',
                                     'maintenance_status','export_ready')),
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  state text NOT NULL CHECK (state IN ('opted_in','opted_out')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('user','email_link','system')),
  CONSTRAINT uq_notification_preferences UNIQUE (organization_id, person_id, type, channel),
  CONSTRAINT fk_notification_preferences_person FOREIGN KEY (organization_id, person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT ck_notification_preferences_required CHECK (NOT (state = 'opted_out' AND type = 'account_security'))
);

-- Nhận lô lần gửi đến hạn (mọi tổ chức): trả \`sending\` quá hạn khoá về \`retrying\` (hết lượt → \`dead\`), rồi nhận tối đa
-- p_limit lần gửi, mỗi tổ chức tối đa p_per_org (rate limit), đặt \`sending\` + khoá p_lock_seconds, attempts + 1.
CREATE FUNCTION app.claim_due_deliveries(p_now timestamptz, p_limit integer, p_per_org integer, p_lock_seconds integer,
                                         p_max_attempts integer)
  RETURNS TABLE (id uuid, organization_id uuid, attempts integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE notification_deliveries d
     SET status = CASE WHEN d.attempts >= p_max_attempts THEN 'dead' ELSE 'retrying' END,
         next_attempt_at = CASE WHEN d.attempts >= p_max_attempts THEN d.next_attempt_at ELSE p_now END,
         locked_until = NULL, last_error_code = 'PROVIDER_TEMPORARY'
   WHERE d.status = 'sending' AND d.locked_until < p_now;
  RETURN QUERY
  WITH locked AS (
    SELECT d.id, d.organization_id, d.next_attempt_at FROM notification_deliveries d
     WHERE d.status IN ('queued','retrying') AND d.next_attempt_at <= p_now
     ORDER BY d.next_attempt_at, d.id
     LIMIT least(greatest(p_limit, 1), 1000) * 4
     FOR UPDATE SKIP LOCKED
  ), ranked AS (
    SELECT l.id, row_number() OVER (PARTITION BY l.organization_id ORDER BY l.next_attempt_at, l.id) AS rn, l.next_attempt_at
      FROM locked l
  ), picked AS (
    SELECT r.id FROM ranked r WHERE r.rn <= greatest(p_per_org, 1)
     ORDER BY r.next_attempt_at, r.id LIMIT least(greatest(p_limit, 1), 1000)
  )
  UPDATE notification_deliveries d
     SET status = 'sending', attempts = d.attempts + 1,
         locked_until = p_now + make_interval(secs => greatest(p_lock_seconds, 1))
    FROM picked p WHERE d.id = p.id
  RETURNING d.id, d.organization_id, d.attempts;
END $$;
REVOKE ALL ON FUNCTION app.claim_due_deliveries(timestamptz, integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_due_deliveries(timestamptz, integer, integer, integer, integer) TO app_worker;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_read ON notifications FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR recipient_person_id = app.actor_person_id()));
CREATE POLICY notifications_mark_read ON notifications FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND recipient_person_id = app.actor_person_id())
  WITH CHECK (organization_id = app.current_org() AND recipient_person_id = app.actor_person_id());
CREATE POLICY notifications_worker_insert ON notifications FOR INSERT TO app_worker
  WITH CHECK (organization_id = app.current_org());
GRANT SELECT ON notifications TO app_runtime;
GRANT UPDATE (read_at) ON notifications TO app_runtime;
GRANT SELECT, INSERT ON notifications TO app_worker;

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_deliveries_read ON notification_deliveries FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR app.actor_role() = 'owner'
         OR (app.actor_role() = 'manager' AND property_id IS NOT NULL AND app.actor_can_see_property(property_id))));
CREATE POLICY notification_deliveries_worker_insert ON notification_deliveries FOR INSERT TO app_worker
  WITH CHECK (organization_id = app.current_org());
CREATE POLICY notification_deliveries_worker_update ON notification_deliveries FOR UPDATE TO app_worker
  USING (organization_id = app.current_org()) WITH CHECK (organization_id = app.current_org());
GRANT SELECT ON notification_deliveries TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON notification_deliveries TO app_worker;

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_preferences_read ON notification_preferences FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR person_id = app.actor_person_id()));
CREATE POLICY notification_preferences_own_insert ON notification_preferences FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_org() AND person_id = app.actor_person_id());
CREATE POLICY notification_preferences_own_update ON notification_preferences FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND person_id = app.actor_person_id())
  WITH CHECK (organization_id = app.current_org() AND person_id = app.actor_person_id());
GRANT SELECT, INSERT, UPDATE ON notification_preferences TO app_runtime;
GRANT SELECT ON notification_preferences TO app_worker;
GRANT SELECT ON invoices, billing_periods, units TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.claim_due_deliveries(timestamptz, integer, integer, integer, integer);
DROP TABLE IF EXISTS notification_preferences, notification_deliveries, notifications;
DROP FUNCTION IF EXISTS app.notification_delivery_transition();
DROP FUNCTION IF EXISTS app.notification_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
