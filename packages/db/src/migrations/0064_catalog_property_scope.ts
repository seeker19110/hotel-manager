// AUD-DATA-001/002 (T-1302, D-079): RLS theo CƠ SỞ cho bảng danh mục `properties`, `floors`, `room_types`, `units`.
// Trước: chỉ `tenant_isolation` theo organization_id ⇒ người thuê đọc toàn bộ phòng/cơ sở của tổ chức, nhân viên chỉ gán cơ sở A
// đọc/ghi được cơ sở B (phạm vi cơ sở chỉ kiểm ở app — trái AGENTS §9 "không thay constraint DB bằng kiểm tra ở app").
// Cách sửa: policy RESTRICTIVE (AND với policy hiện có) cho `app_runtime`:
//   · không có actor (worker, đăng nhập, ngữ cảnh hệ thống)  → không đổi;
//   · tenant/guest                                             → chỉ ĐỌC cơ sở mình thuê (đại diện hoặc người ở primary/co_tenant), không ghi;
//   · nhân viên                                                → `app.actor_can_see_property(cơ sở)` (mọi cơ sở hoặc property_scopes).
// Hiệu năng (review #101: kiểm từng dòng bằng hàm SECURITY DEFINER chậm ~350 lần trên 500 phòng): policy so `cột IN (SELECT
// app.visible_property_ids())` — hàm trả TẬP cơ sở nhìn thấy (vài dòng), planner đánh giá một lần cho cả câu lệnh (hashed subplan).
// `app_worker` không đổi (job nền không có actor người).
// Giới hạn đã biết: một CÂU LỆNH duy nhất vừa chèn `properties` vừa chèn bảng con (CTE) bị chặn, vì hàm STABLE dùng snapshot của câu
// lệnh và chưa thấy cơ sở vừa chèn; app chèn từng câu riêng (property.ts), đừng viết onboarding bằng CTE. `portal_no_insert` là lớp
// đỡ thứ hai (WITH CHECK của `property_scope` đã chặn tenant/guest).
import { type Kysely, sql } from "kysely";

const TABLES: ReadonlyArray<[table: string, col: string]> = [
  ["properties", "id"],
  ["floors", "property_id"],
  ["room_types", "property_id"],
  ["units", "property_id"],
];

const NO_ACTOR = `(SELECT nullif(current_setting('app.actor_id', true), '')) IS NULL`;
const PORTAL = `coalesce((SELECT app.actor_role()) IN ('tenant','guest'), false)`;

const UP = `
CREATE FUNCTION app.visible_property_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT p.id FROM properties p
    WHERE p.organization_id = app.current_org()
      AND CASE
        WHEN app.actor_role() IN ('tenant','guest') THEN
          app.actor_role() = 'tenant' AND app.actor_person_id() IS NOT NULL AND EXISTS (
            SELECT 1 FROM leases l
            WHERE l.organization_id = p.organization_id AND l.property_id = p.id
              AND l.status IN ('pending_signature','signed_awaiting_handover','active','notice_given','settling','closed')
              AND (l.representative_person_id = app.actor_person_id()
                   OR EXISTS (SELECT 1 FROM lease_occupants o
                              WHERE o.organization_id = l.organization_id AND o.lease_id = l.id
                                AND o.person_id = app.actor_person_id() AND o.role IN ('primary','co_tenant'))))
        ELSE app.actor_can_see_property(p.id)
      END
  $$;
REVOKE ALL ON FUNCTION app.visible_property_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.visible_property_ids() TO app_runtime;

-- Kiểm TỪNG DÒNG cho WITH CHECK (ghi, hiếm): hàng đang chèn chưa nằm trong bảng nên dạng tập ở trên không thấy nó (INSERT properties).
CREATE FUNCTION app.property_writable(p uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT nullif(current_setting('app.actor_id', true), '') IS NULL
           OR (coalesce(app.actor_role() NOT IN ('tenant','guest'), false) AND app.actor_can_see_property(p))
  $$;
REVOKE ALL ON FUNCTION app.property_writable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.property_writable(uuid) TO app_runtime;

${TABLES.map(
  ([t, c]) => `CREATE POLICY property_scope ON ${t} AS RESTRICTIVE FOR ALL TO app_runtime
  USING (${NO_ACTOR} OR ${c} IN (SELECT app.visible_property_ids())${
    // INSERT/UPDATE … RETURNING phải thấy hàng mới: với `properties` (hàng mới chưa có trong tập) thêm nhánh kiểm từng dòng của nhân viên.
    t === "properties" ? " OR app.property_writable(id)" : ""
  })
  WITH CHECK (app.property_writable(${c}));
CREATE POLICY portal_no_insert ON ${t} AS RESTRICTIVE FOR INSERT TO app_runtime WITH CHECK (NOT ${PORTAL});
CREATE POLICY portal_no_update ON ${t} AS RESTRICTIVE FOR UPDATE TO app_runtime USING (NOT ${PORTAL}) WITH CHECK (NOT ${PORTAL});
CREATE POLICY portal_no_delete ON ${t} AS RESTRICTIVE FOR DELETE TO app_runtime USING (NOT ${PORTAL});`,
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
DROP FUNCTION IF EXISTS app.property_writable(uuid);
DROP FUNCTION IF EXISTS app.visible_property_ids();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
