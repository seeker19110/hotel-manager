// Sửa theo review độc lập lát 4 (🟢4): khôi phục MFA phải biết tài khoản còn membership CHƯA THU HỒI ở tổ chức khác (kể cả
// `suspended`/`invited`/chưa tới `valid_from`) — `app.list_my_organizations` chỉ đếm membership đang hiệu lực. RLS che tổ
// chức khác nên dùng hàm SECURITY DEFINER hẹp: chỉ trả SỐ LƯỢNG, không lộ tổ chức nào.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.memberships_elsewhere(p_auth_user_id uuid, p_org uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT count(*)::int FROM memberships m
    WHERE m.auth_user_id = p_auth_user_id AND m.organization_id <> p_org AND m.status <> 'revoked'
  $$;
REVOKE ALL ON FUNCTION app.memberships_elsewhere(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.memberships_elsewhere(uuid, uuid) TO app_runtime;
`;

const DOWN = `DROP FUNCTION IF EXISTS app.memberships_elsewhere(uuid, uuid);`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
