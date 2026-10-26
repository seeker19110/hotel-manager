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
// - Nhật ký (D-128 "owner/manager thấy"): sự kiện của support (`actor_type = 'platform_support'`, cấp tổ chức — property_id NULL)
//   manager cũng đọc được: `audit_read_by_role` (0042) thêm nhánh đó cho manager; nhánh khác giữ nguyên.
// - Hàm RLS theo actor (`app.actor_role` 0006, `app.actor_person_id` 0014, `app.actor_can_see_property` 0007) chỉ coi membership
//   `active` CÒN HẠN (`valid_to IS NULL OR valid_to > now()`) — membership hỗ trợ/người thuê hết hạn vẫn `active` (không cần job),
//   nên GUC actor còn đặt cũng không mở được dữ liệu. Phần còn lại của ba hàm giữ nguyên.
// DOWN: gỡ policy/hàm/trigger, khôi phục CHECK cũ (membership/lời mời hỗ trợ còn sót bị thu hồi/đóng trước để CHECK cũ hợp lệ).
import { type Kysely, sql } from "kysely";
import { AUDIT_MONEY_GROUPS } from "./0042_audit_read_scope.ts";

const moneyGroupsSql = AUDIT_MONEY_GROUPS.map((g) => `'${g}'`).join(",");

/** Ba hàm actor của RLS; `live` = thêm điều kiện còn hạn của 0072 (DOWN dựng lại bản cũ với `live = false`). */
const actorFunctions = (live: boolean) => {
  const until = (indent: string) => (live ? `\n${indent}AND (m.valid_to IS NULL OR m.valid_to > now())` : "");
  return `
CREATE OR REPLACE FUNCTION app.actor_role() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT m.role FROM memberships m
    WHERE m.id = nullif(current_setting('app.actor_id', true), '')::uuid
      AND m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
      AND m.status = 'active'${until("      ")}
  $$;
CREATE OR REPLACE FUNCTION app.actor_person_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT m.person_id FROM memberships m
    WHERE m.id = nullif(current_setting('app.actor_id', true), '')::uuid
      AND m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
      AND m.status = 'active'${until("      ")}
  $$;
CREATE OR REPLACE FUNCTION app.actor_can_see_property(p uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.id = nullif(current_setting('app.actor_id', true), '')::uuid
        AND m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
        AND m.status = 'active'${until("        ")}
        AND (m.all_properties
             OR (p IS NOT NULL AND EXISTS (
                   SELECT 1 FROM property_scopes ps
                   WHERE ps.organization_id = m.organization_id AND ps.membership_id = m.id AND ps.property_id = p))))
  $$;
`;
};

/** `audit_read_by_role` (0042); `supportForManager` = nhánh thêm ở 0072 cho sự kiện cấp tổ chức của support. */
const auditReadPolicy = (supportForManager: boolean) => `
DROP POLICY audit_read_by_role ON audit_events;
CREATE POLICY audit_read_by_role ON audit_events AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (
    nullif(current_setting('app.actor_id', true), '') IS NULL
    OR app.actor_role() = 'owner'
    OR (app.actor_role() = 'manager' AND CASE WHEN property_id IS NULL THEN actor_person_id = app.actor_person_id()${
      supportForManager ? " OR actor_type = 'platform_support'" : ""
    }
                                              ELSE app.actor_can_see_property(property_id) END)
    OR (app.actor_role() = 'accountant'
        AND split_part(action, '.', 1) = ANY (ARRAY[${moneyGroupsSql}])
        AND (property_id IS NULL OR app.actor_can_see_property(property_id)))
  );
`;

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
${actorFunctions(true)}
${auditReadPolicy(true)}
`;

const DOWN = `
${auditReadPolicy(false)}
${actorFunctions(false)}
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
