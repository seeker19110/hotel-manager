// PLAN đợt 3 T-216 — người thuê vào portal (SPEC-portal S-005, S-012…S-015; D-005, D-011, D-016).
// - `app.otp_sign_in_allowed(email)`: chỉ tài khoản mà MỌI membership còn hiệu lực đều là `tenant` (≥ 1) mới đăng nhập
//   bằng OTP email — nhân viên luôn qua mật khẩu + TOTP (chặn lách MFA). Chỉ trả boolean, không lộ gì khác.
// - Hợp đồng chuyển `closed` → membership `tenant` của người đại diện (không còn hợp đồng hiệu lực nào khác ở tổ chức)
//   chỉ còn xem lại tới `now + organizations.settings.tenant_readonly_days` (mặc định 30 — Q-04); hết hạn ⇒ 404 (S-015).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.otp_sign_in_allowed(p_email text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
      SELECT 1 FROM auth."user" u
      WHERE u.email = lower(btrim(p_email))
        AND EXISTS (SELECT 1 FROM memberships m WHERE m.auth_user_id = u.id AND m.role = 'tenant' AND m.status = 'active'
                      AND m.valid_from <= now() AND (m.valid_to IS NULL OR m.valid_to > now()))
        AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.auth_user_id = u.id AND m.role <> 'tenant'
                          AND m.status IN ('invited','active','suspended')))
  $$;
REVOKE ALL ON FUNCTION app.otp_sign_in_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.otp_sign_in_allowed(text) TO app_runtime;

CREATE FUNCTION app.tenant_access_on_lease_close() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE days integer;
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    SELECT coalesce((o.settings ->> 'tenant_readonly_days')::int, 30) INTO days FROM organizations o WHERE o.id = NEW.organization_id;
    UPDATE memberships m SET valid_to = now() + make_interval(days => greatest(days, 0)), version = m.version + 1
     WHERE m.organization_id = NEW.organization_id AND m.person_id = NEW.representative_person_id AND m.role = 'tenant'
       AND m.status = 'active' AND (m.valid_to IS NULL OR m.valid_to > now() + make_interval(days => greatest(days, 0)))
       AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.organization_id = NEW.organization_id AND l.id <> NEW.id
                         AND l.representative_person_id = NEW.representative_person_id
                         AND l.status IN ('signed_awaiting_handover','active','notice_given','settling'));
  ELSIF NEW.status IN ('signed_awaiting_handover','active','notice_given','settling')
        AND OLD.status NOT IN ('signed_awaiting_handover','active','notice_given','settling') THEN
    -- Hợp đồng mới có hiệu lực ⇒ bỏ hạn chỉ-đọc đã đặt khi hợp đồng cũ đóng (review lát 4); quyền đã thu hồi giữ nguyên.
    UPDATE memberships m SET valid_to = NULL, version = m.version + 1
     WHERE m.organization_id = NEW.organization_id AND m.person_id = NEW.representative_person_id AND m.role = 'tenant'
       AND m.status = 'active' AND m.valid_to IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_leases_tenant_access AFTER UPDATE OF status ON leases FOR EACH ROW
  EXECUTE FUNCTION app.tenant_access_on_lease_close();
`;

const DOWN = `
DROP TRIGGER IF EXISTS trg_leases_tenant_access ON leases;
DROP FUNCTION IF EXISTS app.tenant_access_on_lease_close();
DROP FUNCTION IF EXISTS app.otp_sign_in_allowed(text);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
