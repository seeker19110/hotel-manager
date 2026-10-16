// PLAN đợt 3 T-214 — tuỳ chọn + lịch sử gửi (SPEC-notifications S-009…S-011, S-017…S-019).
// - Owner/manager (theo cơ sở) đọc được thông báo để xem lịch sử gửi; hộp thông báo `listMine` vẫn lọc theo người nhận.
// - Gửi lại thủ công (S-019): owner/manager trong phạm vi cơ sở chỉ được đổi các cột vòng đời của lần gửi; trigger
//   `notification_delivery_transition` (0034) chỉ cho `failed/dead → queued`.
// - Huỷ đăng ký từ email (S-010) không đăng nhập: app kiểm token HMAC có hạn rồi gọi hàm SECURITY DEFINER hẹp — CHỈ đặt
//   `opted_out` (không bao giờ bật lại), từ chối loại bắt buộc, ghi audit cùng transaction.
import { type Kysely, sql } from "kysely";

const UP = `
-- Lịch sử gửi (S-006, S-018) cần biết loại/người nhận của thông báo: owner toàn tổ chức, manager theo cơ sở được đọc.
CREATE POLICY notifications_staff_read ON notifications FOR SELECT TO app_runtime
  USING (organization_id = app.current_org() AND (app.actor_role() = 'owner'
         OR (app.actor_role() = 'manager' AND property_id IS NOT NULL AND app.actor_can_see_property(property_id))));
CREATE POLICY notification_deliveries_manual_retry ON notification_deliveries FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND (app.actor_role() = 'owner'
         OR (app.actor_role() = 'manager' AND property_id IS NOT NULL AND app.actor_can_see_property(property_id))))
  WITH CHECK (organization_id = app.current_org() AND (app.actor_role() = 'owner'
         OR (app.actor_role() = 'manager' AND property_id IS NOT NULL AND app.actor_can_see_property(property_id))));
GRANT UPDATE (status, attempts, next_attempt_at, last_error_code, locked_until) ON notification_deliveries TO app_runtime;

CREATE FUNCTION app.unsubscribe_email(p_org uuid, p_person uuid, p_type text, p_correlation text)
  RETURNS TABLE (organization_name text, changed boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prev text;
BEGIN
  IF p_type = 'account_security' THEN
    RAISE EXCEPTION 'loại bắt buộc' USING ERRCODE = '23514', HINT = 'PREFERENCE_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM persons WHERE organization_id = p_org AND id = p_person) THEN
    RETURN;
  END IF;
  SELECT state INTO prev FROM notification_preferences
   WHERE organization_id = p_org AND person_id = p_person AND type = p_type AND channel = 'email' FOR UPDATE;
  INSERT INTO notification_preferences (id, organization_id, person_id, type, channel, state, source)
  VALUES (gen_random_uuid(), p_org, p_person, p_type, 'email', 'opted_out', 'email_link')
  ON CONFLICT (organization_id, person_id, type, channel)
    DO UPDATE SET state = 'opted_out', source = 'email_link', changed_at = now()
    WHERE notification_preferences.state <> 'opted_out';
  IF prev IS DISTINCT FROM 'opted_out' THEN
    INSERT INTO audit_events (id, organization_id, actor_type, actor_person_id, action, entity_type, entity_id, before, after,
                              correlation_id)
    VALUES (gen_random_uuid(), p_org, 'user', p_person, 'notification.preference_changed', 'person', p_person,
            jsonb_build_object('type', p_type, 'channel', 'email', 'state', coalesce(prev, 'opted_in')),
            jsonb_build_object('type', p_type, 'channel', 'email', 'state', 'opted_out', 'source', 'email_link'),
            p_correlation);
  END IF;
  RETURN QUERY SELECT o.name, prev IS DISTINCT FROM 'opted_out' FROM organizations o WHERE o.id = p_org;
END $$;
REVOKE ALL ON FUNCTION app.unsubscribe_email(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.unsubscribe_email(uuid, uuid, text, text) TO app_runtime;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.unsubscribe_email(uuid, uuid, text, text);
REVOKE UPDATE (status, attempts, next_attempt_at, last_error_code, locked_until) ON notification_deliveries FROM app_runtime;
DROP POLICY IF EXISTS notification_deliveries_manual_retry ON notification_deliveries;
DROP POLICY IF EXISTS notifications_staff_read ON notifications;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
