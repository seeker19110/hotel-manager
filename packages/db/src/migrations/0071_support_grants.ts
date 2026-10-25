// T-2313 (IND-SAAS-009, CMP-AUDIT-002; D-122; TM-12) — truy cập hỗ trợ có lý do + thời hạn, do CHỦ tổ chức cấp/thu hồi.
// - `platform_support_users`: danh bạ nhân viên hỗ trợ của NỀN TẢNG (toàn hệ thống, không thuộc tổ chức — ngoại lệ `organization_id`
//   có lý do ở schema-guards). Xoá tài khoản nhân viên hỗ trợ: gỡ khỏi danh bạ trước (FK RESTRICT như `memberships.auth_user_id`). Chỉ người vận hành ghi (SQL
//   trực tiếp, không có UI/quyền app). App chỉ tra qua `app.platform_support_lookup(email)` (SECURITY DEFINER) ⇒ chủ tổ chức chỉ cấp
//   được cho đúng nhân viên hỗ trợ (email đã xác minh), không cấp cho tài khoản bất kỳ, và không dò được tài khoản thường qua email.
// - `support_grants`: mỗi lần cấp = một hàng (lý do NOT NULL; `expires_at` ≤ `granted_at` + 72 giờ — CHECK) gắn với MỘT membership
//   `platform_support` (membership có `valid_to` = `expires_at`; thu hồi ⇒ membership `revoked`). Trigger: người được cấp phải là
//   membership `platform_support`, người cấp/thu hồi phải là owner đang hoạt động; sau khi tạo chỉ được ĐẶT thu hồi đúng một lần
//   (không sửa lý do/hạn, không xoá). RLS theo tổ chức (FORCE) + RESTRICTIVE cho app_runtime: đọc = owner/manager/accountant hoặc
//   chính người được cấp hoặc ngữ cảnh hệ thống (không actor — `resolveActor`); ghi = owner.
// - `audit_events.support_grant_id`: tham chiếu grant của mọi dòng do hỗ trợ thực hiện; CHECK hai chiều: `actor_type =
//   'platform_support'` ⇔ có `support_grant_id` (dòng của hỗ trợ không thể thiếu tham chiếu; dòng của người khác không gắn grant).
//   Thêm cột nullable không mặc định ⇒ không ghi lại bảng; trigger append-only giữ nguyên.
// - Chỉ ĐỌC ở tầng CSDL: policy RESTRICTIVE `support_read_only` (INSERT/UPDATE/DELETE, TO app_runtime) trên MỌI bảng có
//   `organization_id` (và `organizations`) tại lúc migrate — actor có vai trò `platform_support` không ghi được gì, trừ
//   `audit_events`/`idempotency_keys`/`outbox` (pipeline ghi lần bị từ chối + audit của chính hành động hỗ trợ). Bảng thêm ở migration
//   SAU cần thêm policy này (ghi rõ trong ADR/PR của bảng đó). Không actor/vai trò khác ⇒ không đổi.
// - Down: gỡ policy, cột/ràng buộc audit, bảng, hàm. Dữ liệu grant mất (audit_events giữ, chỉ mất cột tham chiếu).
import { type Kysely, sql } from "kysely";

/** Bảng mà actor `platform_support` vẫn được GHI (lần bị từ chối + audit của chính hành động hỗ trợ). */
export const SUPPORT_WRITABLE = ["audit_events", "idempotency_keys", "outbox"] as const;

const NOT_SUPPORT = `((SELECT app.actor_role()) IS DISTINCT FROM 'platform_support')`;
/** Cùng biểu thức dạng chuỗi SQL (tham số của `format()` trong khối DO). */
const NOT_SUPPORT_LITERAL = `'${NOT_SUPPORT.replaceAll("'", "''")}'`;

const UP = `
CREATE TABLE platform_support_users (
  auth_user_id uuid PRIMARY KEY REFERENCES auth."user" (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- RLS bật, không policy cho vai trò app (như worker_heartbeats): chỉ đọc qua hàm SECURITY DEFINER bên dưới.
ALTER TABLE platform_support_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_support_users FROM PUBLIC;

-- Tra nhân viên hỗ trợ theo email (đã xác minh). Không phải nhân viên hỗ trợ ⇒ không trả hàng (không phân biệt "không có tài khoản").
CREATE FUNCTION app.platform_support_lookup(p_email text)
  RETURNS TABLE (auth_user_id uuid, full_name text, email text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT u.id, u.name, lower(u.email) FROM auth."user" u
    JOIN platform_support_users s ON s.auth_user_id = u.id
    WHERE lower(u.email) = lower(btrim(p_email)) AND u."emailVerified"
  $$;
REVOKE ALL ON FUNCTION app.platform_support_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_support_lookup(text) TO app_runtime;

CREATE TABLE support_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  grantee_membership_id uuid NOT NULL,
  granted_by uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_support_grants_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_support_grants_membership UNIQUE (organization_id, grantee_membership_id),
  CONSTRAINT fk_support_grants_grantee FOREIGN KEY (organization_id, grantee_membership_id)
    REFERENCES memberships (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_support_grants_granted_by FOREIGN KEY (organization_id, granted_by)
    REFERENCES memberships (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_support_grants_revoked_by FOREIGN KEY (organization_id, revoked_by)
    REFERENCES memberships (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_support_grants_ttl CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '72 hours'),
  CONSTRAINT ck_support_grants_revoked CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT ck_support_grants_revoked_after CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE INDEX ix_support_grants_org_time ON support_grants (organization_id, granted_at DESC, id DESC);
CREATE INDEX ix_support_grants_granted_by ON support_grants (organization_id, granted_by);
CREATE INDEX ix_support_grants_revoked_by ON support_grants (organization_id, revoked_by) WHERE revoked_by IS NOT NULL;

CREATE FUNCTION app.check_support_grant() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = NEW.organization_id
                     AND m.id = NEW.grantee_membership_id AND m.role = 'platform_support') THEN
      RAISE EXCEPTION 'người được cấp phải là membership platform_support' USING ERRCODE = '23514', HINT = 'VALIDATION_FAILED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = NEW.organization_id
                     AND m.id = NEW.granted_by AND m.role = 'owner' AND m.status = 'active') THEN
      RAISE EXCEPTION 'chỉ owner đang hoạt động được cấp truy cập hỗ trợ' USING ERRCODE = '42501', HINT = 'FORBIDDEN';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR (NEW.id, NEW.organization_id, NEW.grantee_membership_id, NEW.granted_by, NEW.reason, NEW.granted_at, NEW.expires_at,
         NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.organization_id, OLD.grantee_membership_id, OLD.granted_by, OLD.reason, OLD.granted_at, OLD.expires_at,
         OLD.created_at) THEN
    RAISE EXCEPTION 'support_grants chỉ được đặt thu hồi đúng một lần' USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = NEW.organization_id
                   AND m.id = NEW.revoked_by AND m.role = 'owner' AND m.status = 'active') THEN
    RAISE EXCEPTION 'chỉ owner đang hoạt động được thu hồi truy cập hỗ trợ' USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_support_grants_check BEFORE INSERT OR UPDATE ON support_grants
  FOR EACH ROW EXECUTE FUNCTION app.check_support_grant();
CREATE TRIGGER trg_support_grants_no_delete BEFORE DELETE ON support_grants
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_grants
  USING (organization_id = app.current_org()) WITH CHECK (organization_id = app.current_org());
CREATE POLICY support_grants_read ON support_grants AS RESTRICTIVE FOR SELECT TO app_runtime
  USING ((SELECT nullif(current_setting('app.actor_id', true), '')) IS NULL
         OR coalesce((SELECT app.actor_role()) IN ('owner','manager','accountant'), false)
         OR grantee_membership_id = nullif(current_setting('app.actor_id', true), '')::uuid);
CREATE POLICY support_grants_owner_insert ON support_grants AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (coalesce((SELECT app.actor_role()) = 'owner', false));
CREATE POLICY support_grants_owner_update ON support_grants AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (coalesce((SELECT app.actor_role()) = 'owner', false))
  WITH CHECK (coalesce((SELECT app.actor_role()) = 'owner', false));
REVOKE ALL ON support_grants FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON support_grants TO app_runtime;

ALTER TABLE audit_events ADD COLUMN support_grant_id uuid;
ALTER TABLE audit_events
  ADD CONSTRAINT fk_audit_support_grant FOREIGN KEY (organization_id, support_grant_id)
    REFERENCES support_grants (organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_audit_support_grant CHECK ((actor_type = 'platform_support') = (support_grant_id IS NOT NULL));
CREATE INDEX ix_audit_support_grant ON audit_events (organization_id, support_grant_id) WHERE support_grant_id IS NOT NULL;

-- Chỉ đọc ở tầng CSDL cho actor platform_support.
CREATE POLICY support_read_only_update ON organizations AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING ${NOT_SUPPORT} WITH CHECK ${NOT_SUPPORT};
CREATE POLICY support_read_only_delete ON organizations AS RESTRICTIVE FOR DELETE TO app_runtime USING ${NOT_SUPPORT};
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
      AND c.relname NOT IN (${SUPPORT_WRITABLE.map((x) => `'${x}'`).join(",")})
    ORDER BY c.relname
  LOOP
    EXECUTE format('CREATE POLICY support_read_only_insert ON %I AS RESTRICTIVE FOR INSERT TO app_runtime WITH CHECK %s',
                   t, ${NOT_SUPPORT_LITERAL});
    EXECUTE format('CREATE POLICY support_read_only_update ON %I AS RESTRICTIVE FOR UPDATE TO app_runtime USING %s WITH CHECK %s',
                   t, ${NOT_SUPPORT_LITERAL}, ${NOT_SUPPORT_LITERAL});
    EXECUTE format('CREATE POLICY support_read_only_delete ON %I AS RESTRICTIVE FOR DELETE TO app_runtime USING %s',
                   t, ${NOT_SUPPORT_LITERAL});
  END LOOP;
END $$;
`;

const DOWN = `
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies
           WHERE schemaname = 'public' AND policyname IN ('support_read_only_insert','support_read_only_update','support_read_only_delete')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;
DROP INDEX IF EXISTS ix_audit_support_grant;
ALTER TABLE audit_events
  DROP CONSTRAINT IF EXISTS ck_audit_support_grant,
  DROP CONSTRAINT IF EXISTS fk_audit_support_grant;
ALTER TABLE audit_events DROP COLUMN IF EXISTS support_grant_id;
DROP TABLE IF EXISTS support_grants;
DROP FUNCTION IF EXISTS app.check_support_grant();
DROP FUNCTION IF EXISTS app.platform_support_lookup(text);
DROP TABLE IF EXISTS platform_support_users;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
