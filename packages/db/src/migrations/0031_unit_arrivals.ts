// PLAN đợt 3 T-211 — ưu tiên việc dọn "phòng có khách đến hôm nay" (SPEC-housekeeping S-003, Q-04) cho buồng phòng, vai trò
// KHÔNG đọc được `stays`/`reservations` (không thấy khách). Hàm SECURITY DEFINER phạm vi hẹp: chỉ trả phòng + giờ đến dự kiến
// của lượt ở `expected` có ngày đến = ngày cho trước, trong tổ chức hiện tại và cơ sở người gọi được thấy. Không tên/SĐT/tiền.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.unit_arrivals(p_property uuid, p_date date)
  RETURNS TABLE (unit_id uuid, arrival_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT s.unit_id, min(lower(a.during))
    FROM stays s
    JOIN reservation_items i ON i.organization_id = s.organization_id AND i.id = s.reservation_item_id
    JOIN allocations a ON a.organization_id = i.organization_id AND a.id = i.allocation_id AND a.active
    WHERE s.organization_id = app.current_org() AND s.property_id = p_property AND s.status = 'expected'
      AND i.arrival_date = p_date AND app.actor_can_see_property(p_property)
    GROUP BY s.unit_id
  $$;
REVOKE ALL ON FUNCTION app.unit_arrivals(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.unit_arrivals(uuid, date) TO app_runtime;
`;

const DOWN = `DROP FUNCTION IF EXISTS app.unit_arrivals(uuid, date);`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
