// Review T-011…T-014: RLS lớp 4 cho dữ liệu nhạy cảm — giấy tờ (và file giấy tờ) chỉ thấy trong PHẠM VI CƠ SỞ của
// người thao tác, không chỉ theo vai trò; bảng `files` mặc định TỪ CHỐI loại chủ chưa khai báo quyền đọc (thêm loại
// mới = migration mới mở đúng vai trò cần). Phòng thủ hai lớp cùng authorize() ở app (TM-06; SPEC-access phạm vi).
import { type Kysely, sql } from "kysely";

const UP = `
-- Người thao tác (app.actor_id) được phép với cơ sở p: membership còn hiệu lực trong tổ chức hiện tại và
-- (all_properties hoặc có property_scopes cho p). p NULL (giấy tờ chưa gắn cơ sở) → chỉ người có mọi cơ sở.
CREATE FUNCTION app.actor_can_see_property(p uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.id = nullif(current_setting('app.actor_id', true), '')::uuid
        AND m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
        AND m.status = 'active'
        AND (m.all_properties
             OR (p IS NOT NULL AND EXISTS (
                   SELECT 1 FROM property_scopes ps
                   WHERE ps.organization_id = m.organization_id AND ps.membership_id = m.id AND ps.property_id = p))))
  $$;
REVOKE ALL ON FUNCTION app.actor_can_see_property(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.actor_can_see_property(uuid) TO app_runtime, app_worker;

DROP POLICY tenant_isolation ON files;
CREATE POLICY tenant_isolation ON files
  USING (organization_id = app.current_org() AND CASE
           WHEN owner_type = 'identity_document'
             THEN app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)
           WHEN owner_type IN ('work_order','handover','meter_reading','task') THEN true
           ELSE false
         END)
  WITH CHECK (organization_id = app.current_org());

DROP POLICY tenant_isolation ON identity_documents;
CREATE POLICY tenant_isolation ON identity_documents
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
         AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk')
              AND app.actor_can_see_property(property_id));
`;

const DOWN = `
DROP POLICY tenant_isolation ON identity_documents;
CREATE POLICY tenant_isolation ON identity_documents
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk'))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk'));
DROP POLICY tenant_isolation ON files;
CREATE POLICY tenant_isolation ON files
  USING (organization_id = app.current_org()
         AND (owner_type <> 'identity_document' OR app.actor_role() IN ('owner','manager','front_desk')))
  WITH CHECK (organization_id = app.current_org());
DROP FUNCTION app.actor_can_see_property(uuid);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
