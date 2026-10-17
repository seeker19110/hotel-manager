// PLAN đợt 7 T-605 (SPEC-access-and-property S-007, S-008, S-010, S-023).
// - `PROPERTY_IN_USE` (INV-G2): trigger chặn đổi `timezone`/`business_day_cutoff` khi cơ sở đã có allocation hoặc chứng từ — ở CSDL,
//   nên mọi đường ghi (lệnh, script, SQL tay) đều bị chặn, không chỉ `property.update`. Khoá hàng cơ sở TRƯỚC khi đếm: INSERT
//   allocation/chứng từ đồng thời giữ KEY SHARE trên hàng cơ sở (FK) nên phải chờ ta xong rồi thấy múi giờ mới, hoặc ta chờ nó
//   commit rồi thấy dữ liệu của nó.
// - `app.invitation_by_token(hash)`: tra lời mời theo băm token TRƯỚC khi có ngữ cảnh tổ chức (người nhận chưa là thành viên);
//   phạm vi hẹp, chỉ trả cột cần, không trả token/băm (như `app.list_my_organizations`, 0002).
// - `auth.revoked_session`: dấu vết phiên bị thu hồi (chỉ BĂM của token phiên) để request kế tiếp nhận 401 SESSION_REVOKED thay vì
//   UNAUTHENTICATED chung chung (S-010). Phiên bị xoá khỏi `auth.session` ngay lúc thu hồi; dấu vết hết hạn cùng hạn của phiên.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.check_property_not_in_use() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM properties WHERE organization_id = OLD.organization_id AND id = OLD.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM allocations WHERE organization_id = OLD.organization_id AND property_id = OLD.id)
     OR EXISTS (SELECT 1 FROM reservations WHERE organization_id = OLD.organization_id AND property_id = OLD.id)
     OR EXISTS (SELECT 1 FROM stays WHERE organization_id = OLD.organization_id AND property_id = OLD.id)
     OR EXISTS (SELECT 1 FROM leases WHERE organization_id = OLD.organization_id AND property_id = OLD.id)
     OR EXISTS (SELECT 1 FROM invoices WHERE organization_id = OLD.organization_id AND property_id = OLD.id)
     OR EXISTS (SELECT 1 FROM payments WHERE organization_id = OLD.organization_id AND property_id = OLD.id)
     OR EXISTS (SELECT 1 FROM deposits WHERE organization_id = OLD.organization_id AND property_id = OLD.id)
     OR EXISTS (SELECT 1 FROM journal_entries WHERE organization_id = OLD.organization_id AND property_id = OLD.id)
     OR EXISTS (SELECT 1 FROM shifts WHERE organization_id = OLD.organization_id AND property_id = OLD.id)
     OR EXISTS (SELECT 1 FROM billing_periods WHERE organization_id = OLD.organization_id AND property_id = OLD.id)
  THEN
    RAISE EXCEPTION 'cơ sở % đã có giao dịch — không đổi múi giờ hoặc giờ chốt ngày', OLD.id
      USING ERRCODE = '23514', HINT = 'PROPERTY_IN_USE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_properties_in_use BEFORE UPDATE OF timezone, business_day_cutoff ON properties
  FOR EACH ROW
  WHEN (OLD.timezone IS DISTINCT FROM NEW.timezone OR OLD.business_day_cutoff IS DISTINCT FROM NEW.business_day_cutoff)
  EXECUTE FUNCTION app.check_property_not_in_use();

CREATE FUNCTION app.invitation_by_token(p_token_hash bytea)
  RETURNS TABLE (organization_id uuid, id uuid, email text, status text, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT i.organization_id, i.id, i.email, i.status, i.expires_at FROM invitations i WHERE i.token_hash = p_token_hash
  $$;
REVOKE ALL ON FUNCTION app.invitation_by_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invitation_by_token(bytea) TO app_runtime;

CREATE TABLE auth.revoked_session (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX ix_revoked_session_user ON auth.revoked_session (user_id);
CREATE INDEX ix_revoked_session_expires ON auth.revoked_session (expires_at);
GRANT SELECT, INSERT, DELETE ON auth.revoked_session TO app_runtime;
`;

const DOWN = `
DROP TABLE IF EXISTS auth.revoked_session;
DROP FUNCTION IF EXISTS app.invitation_by_token(bytea);
DROP TRIGGER IF EXISTS trg_properties_in_use ON properties;
DROP FUNCTION IF EXISTS app.check_property_not_in_use();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
