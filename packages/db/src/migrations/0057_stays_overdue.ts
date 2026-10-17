// PLAN đợt 7 T-604 (SPEC-inventory-allocation S-017, INV-I4): job `inventory.detectOverdue` phát hiện lượt ở quá giờ trả
// chưa check-out. Đọc xuyên tổ chức qua hàm SECURITY DEFINER phạm vi hẹp (như `app.leases_overstaying`, 0016); worker ghi
// ngoại lệ trong ngữ cảnh từng tổ chức. Allocation KHÔNG bị đụng tới (không tự kết thúc lượt ở).
// Ngưỡng quá hạn (Q-03): mặc định 60 phút sau giờ trả dự kiến; cơ sở đổi bằng `properties.settings.stay_overstay_grace_minutes`
// (số nguyên 0–1440, giá trị khác bị bỏ qua và dùng mặc định).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.stays_overdue(p_now timestamptz)
  RETURNS TABLE (organization_id uuid, property_id uuid, stay_id uuid, allocation_id uuid, related_allocation_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT s.organization_id, s.property_id, s.id, a.id,
           (SELECT o.id FROM allocations o WHERE o.organization_id = a.organization_id AND o.unit_id = a.unit_id AND o.active
              AND o.id <> a.id AND lower(o.during) >= upper(a.during) ORDER BY lower(o.during), o.id LIMIT 1)
    FROM stays s
    JOIN properties p ON p.organization_id = s.organization_id AND p.id = s.property_id
    JOIN allocations a ON a.organization_id = s.organization_id AND a.source_type = 'stay' AND a.source_id = s.id
                      AND a.active AND a.kind = 'stay'
    WHERE s.status = 'in_house' AND NOT upper_inf(a.during)
      AND upper(a.during) + make_interval(mins =>
            CASE WHEN (p.settings ->> 'stay_overstay_grace_minutes') ~ '^[0-9]{1,4}$'
                      AND (p.settings ->> 'stay_overstay_grace_minutes')::int <= 1440
                 THEN (p.settings ->> 'stay_overstay_grace_minutes')::int ELSE 60 END) <= p_now
  $$;
REVOKE ALL ON FUNCTION app.stays_overdue(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.stays_overdue(timestamptz) TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.stays_overdue(timestamptz);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
