// AUD-DATA-001/002 (T-1302, D-079): RLS theo CƠ SỞ cho bảng danh mục `properties`, `floors`, `room_types`, `units`.
// Trước: chỉ `tenant_isolation` theo organization_id ⇒ người thuê đọc toàn bộ phòng/cơ sở của tổ chức, nhân viên chỉ gán cơ sở A
// đọc/ghi được cơ sở B (phạm vi cơ sở chỉ kiểm ở app — trái AGENTS §9 "không thay constraint DB bằng kiểm tra ở app").
// Cách sửa: policy RESTRICTIVE (AND với policy hiện có), cho SELECT/INSERT/UPDATE/DELETE của `app_runtime`:
//   · không có actor (worker, đăng nhập, ngữ cảnh hệ thống)  → không đổi;
//   · tenant/guest                                             → chỉ ĐỌC cơ sở mình thuê (đại diện hoặc người ở primary/co_tenant), không ghi;
//   · nhân viên                                                → `app.actor_can_see_property(cơ sở)` (mọi cơ sở hoặc property_scopes).
// `app_worker` không đổi (job nền không có actor người).
import { type Kysely, sql } from "kysely";

const TABLES: ReadonlyArray<[table: string, col: string]> = [
  ["properties", "id"],
  ["floors", "property_id"],
  ["room_types", "property_id"],
  ["units", "property_id"],
];

const UP = `
CREATE FUNCTION app.property_visible(p uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT CASE
      WHEN nullif(current_setting('app.actor_id', true), '') IS NULL THEN true
      WHEN app.actor_role() IN ('tenant','guest') THEN app.actor_role() = 'tenant' AND app.actor_person_id() IS NOT NULL AND EXISTS (
        SELECT 1 FROM leases l
        WHERE l.organization_id = app.current_org() AND l.property_id = p
          AND l.status IN ('signed_awaiting_handover','active','notice_given','settling','closed')
          AND (l.representative_person_id = app.actor_person_id()
               OR EXISTS (SELECT 1 FROM lease_occupants o
                          WHERE o.organization_id = l.organization_id AND o.lease_id = l.id AND o.person_id = app.actor_person_id()
                            AND o.role IN ('primary','co_tenant'))))
      ELSE app.actor_can_see_property(p)
    END
  $$;
REVOKE ALL ON FUNCTION app.property_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.property_visible(uuid) TO app_runtime;

${TABLES.map(
  ([t, c]) => `CREATE POLICY property_scope ON ${t} AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.property_visible(${c})) WITH CHECK (app.property_visible(${c}));
CREATE POLICY portal_no_insert ON ${t} AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (NOT coalesce(app.actor_role() IN ('tenant','guest'), false));
CREATE POLICY portal_no_update ON ${t} AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (NOT coalesce(app.actor_role() IN ('tenant','guest'), false)) WITH CHECK (NOT coalesce(app.actor_role() IN ('tenant','guest'), false));
CREATE POLICY portal_no_delete ON ${t} AS RESTRICTIVE FOR DELETE TO app_runtime
  USING (NOT coalesce(app.actor_role() IN ('tenant','guest'), false));`,
).join("\n")}
`;

const DOWN = `
${TABLES.map(
  ([t]) =>
    `DROP POLICY IF EXISTS property_scope ON ${t};
DROP POLICY IF EXISTS portal_no_insert ON ${t};
DROP POLICY IF EXISTS portal_no_update ON ${t};
DROP POLICY IF EXISTS portal_no_delete ON ${t};`,
).join("\n")}
DROP FUNCTION IF EXISTS app.property_visible(uuid);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
