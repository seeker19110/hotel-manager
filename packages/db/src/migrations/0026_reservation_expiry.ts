// PLAN đợt 3 T-206 — job hết hạn giữ phòng của booking (SPEC-reservation-stay S-007, INV-I3): liệt kê xuyên tổ chức qua hàm
// SECURITY DEFINER phạm vi hẹp (chỉ id + tổ chức, không dữ liệu khách); cập nhật trạng thái chạy trong ngữ cảnh từng tổ chức.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.due_held_reservations(p_now timestamptz, p_limit integer)
  RETURNS TABLE (reservation_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT r.id, r.organization_id FROM reservations r
    JOIN reservation_items i ON i.organization_id = r.organization_id AND i.reservation_id = r.id
    LEFT JOIN allocations a ON a.organization_id = i.organization_id AND a.id = i.allocation_id
    WHERE r.status = 'held' AND (a.id IS NULL OR NOT a.active OR a.expires_at <= p_now)
    ORDER BY r.held_until, r.id
    LIMIT least(greatest(p_limit, 1), 10000)
  $$;
REVOKE ALL ON FUNCTION app.due_held_reservations(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_held_reservations(timestamptz, integer) TO app_worker;
-- Nhả allocation của booking hết hạn (policy tenant_isolation của allocations đã giới hạn theo tổ chức).
GRANT UPDATE ON allocations TO app_worker;
`;

const DOWN = `
REVOKE UPDATE ON allocations FROM app_worker;
DROP FUNCTION IF EXISTS app.due_held_reservations(timestamptz, integer);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
