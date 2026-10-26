// T-2313 (D-128; IND-SAAS-009, CMP-AUDIT-002, TM-12) — truy cập hỗ trợ CHỈ ĐỌC do owner cấp + "từ đâu" cho audit ghi trong CSDL.
// Vai trò dùng lại `platform_support` (DOMAIN-MODEL §6, đã có trong CHECK `memberships.role` và `audit_events.actor_type` từ 0001/0003).
// - Lời mời hỗ trợ (`invitations.role = 'platform_support'`): BẮT BUỘC `support_reason` (1–500 ký tự sau khi bỏ khoảng trắng), hạn
//   `expires_at` ≤ `created_at` + 72 giờ (cửa sổ truy cập tính từ lúc owner CẤP, không từ lúc nhận), không phạm vi/hạn mức riêng.
//   Vai trò khác: `support_reason` phải NULL.
// - Membership hỗ trợ: `valid_to` bắt buộc và ≤ `valid_from` + 72 giờ, `support_reason` bắt buộc (sao từ lời mời). Hết hiệu lực khi
//   `valid_to <= now()` — kiểm ở chỗ xác định membership còn hiệu lực (`resolveActor`, `app.list_my_organizations`), theo đồng hồ CSDL,
//   không cần job. `all_properties` được phép cho vai này (xem toàn tổ chức, chỉ đọc).
// - Chỉ đọc ở tầng CSDL (lớp 2, sau chặn ở pipeline/route): policy RESTRICTIVE `support_ro_{ins,upd,del}` trên MỌI bảng `public` bật RLS
//   cho `app_runtime`: actor là membership `platform_support` (bất kể trạng thái/hạn) ⇒ không INSERT/UPDATE/DELETE. Ngoại lệ có lý do:
//   `audit_events` (ghi sự kiện truy cập/bị từ chối của chính support), `idempotency_keys` + `outbox` + `invitations` (lệnh nhận lời mời
//   chạy với actor = membership vừa tạo trong cùng transaction). Test `support-access.db.test.ts` đỏ nếu bảng RLS mới thiếu policy.
// - Audit "từ đâu" cho dòng ghi bằng SQL (hàm CSDL như `app.org_request_deletion`, insert trực tiếp trong lệnh): trigger BEFORE INSERT
//   điền `source_ip`/`user_agent` còn NULL từ GUC giao dịch `app.source_ip`/`app.user_agent` (app đặt bằng `set_config(..., true)`
//   từ `auditSource` — đã cắt IP, làm sạch UA; CHECK 0049 vẫn chặn giá trị sai).
// DOWN: gỡ policy/hàm/trigger, khôi phục CHECK cũ (membership/lời mời hỗ trợ còn sót bị thu hồi/đóng trước để CHECK cũ hợp lệ).
import { type Kysely, sql } from "kysely";

const UP = `
ALTER TABLE invitations DROP CONSTRAINT invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('owner','manager','front_desk','accountant','housekeeping','maintenance','tenant','platform_support'));
ALTER TABLE invitations ADD COLUMN support_reason text;
ALTER TABLE invitations ADD CONSTRAINT ck_invitations_support CHECK (
  CASE WHEN role = 'platform_support'
    THEN support_reason IS NOT NULL AND char_length(btrim(support_reason)) BETWEEN 1 AND 500
         AND expires_at <= created_at + interval '72 hours' AND property_ids = '{}' AND limits = '{}'::jsonb
    ELSE support_reason IS NULL END);

ALTER TABLE memberships ADD COLUMN support_reason text;
ALTER TABLE memberships DROP CONSTRAINT ck_memberships_support_temporary;
ALTER TABLE memberships ADD CONSTRAINT ck_memberships_support_temporary CHECK (
  CASE WHEN role = 'platform_support'
    THEN valid_to IS NOT NULL AND valid_to <= valid_from + interval '72 hours'
         AND support_reason IS NOT NULL AND char_length(btrim(support_reason)) BETWEEN 1 AND 500
    ELSE support_reason IS NULL END);
ALTER TABLE memberships DROP CONSTRAINT ck_memberships_all_properties;
ALTER TABLE memberships ADD CONSTRAINT ck_memberships_all_properties
  CHECK (NOT all_properties OR role IN ('owner','accountant','platform_support'));

CREATE FUNCTION app.actor_not_support() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT NOT EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.id = nullif(current_setting('app.actor_id', true), '')::uuid AND m.role = 'platform_support')
  $$;
REVOKE ALL ON FUNCTION app.actor_not_support() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.actor_not_support() TO app_runtime;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relrowsecurity
             AND c.relname NOT IN ('audit_events','idempotency_keys','outbox','invitations')
           ORDER BY c.relname
  LOOP
    EXECUTE format('CREATE POLICY support_ro_ins ON %I AS RESTRICTIVE FOR INSERT TO app_runtime WITH CHECK ((SELECT app.actor_not_support()))', r.relname);
    EXECUTE format('CREATE POLICY support_ro_upd ON %I AS RESTRICTIVE FOR UPDATE TO app_runtime USING ((SELECT app.actor_not_support())) WITH CHECK ((SELECT app.actor_not_support()))', r.relname);
    EXECUTE format('CREATE POLICY support_ro_del ON %I AS RESTRICTIVE FOR DELETE TO app_runtime USING ((SELECT app.actor_not_support()))', r.relname);
  END LOOP;
END $$;

CREATE FUNCTION app.audit_source_from_context() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_ip IS NULL THEN NEW.source_ip := nullif(current_setting('app.source_ip', true), ''); END IF;
  IF NEW.user_agent IS NULL THEN NEW.user_agent := nullif(current_setting('app.user_agent', true), ''); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_events_source_from_context BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_source_from_context();
`;

const DOWN = `
DROP TRIGGER IF EXISTS audit_events_source_from_context ON audit_events;
DROP FUNCTION IF EXISTS app.audit_source_from_context();
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT tablename FROM pg_policies
           WHERE schemaname = 'public' AND policyname IN ('support_ro_ins','support_ro_upd','support_ro_del')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS support_ro_ins ON %I', r.tablename);
    EXECUTE format('DROP POLICY IF EXISTS support_ro_upd ON %I', r.tablename);
    EXECUTE format('DROP POLICY IF EXISTS support_ro_del ON %I', r.tablename);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS app.actor_not_support();

UPDATE invitations SET status = 'revoked' WHERE role = 'platform_support' AND status = 'pending';
UPDATE memberships SET status = 'revoked', revoked_at = coalesce(revoked_at, now()), all_properties = false
  WHERE role = 'platform_support';
ALTER TABLE memberships DROP CONSTRAINT ck_memberships_all_properties;
ALTER TABLE memberships ADD CONSTRAINT ck_memberships_all_properties
  CHECK (NOT all_properties OR role IN ('owner','accountant'));
ALTER TABLE memberships DROP CONSTRAINT ck_memberships_support_temporary;
ALTER TABLE memberships DROP COLUMN support_reason;
ALTER TABLE memberships ADD CONSTRAINT ck_memberships_support_temporary
  CHECK (role <> 'platform_support' OR valid_to IS NOT NULL);

ALTER TABLE invitations DROP CONSTRAINT ck_invitations_support;
ALTER TABLE invitations DROP COLUMN support_reason;
ALTER TABLE invitations DROP CONSTRAINT invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('owner','manager','front_desk','accountant','housekeeping','maintenance','tenant')) NOT VALID;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
