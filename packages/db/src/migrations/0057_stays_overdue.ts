// PLAN đợt 7 T-604 (SPEC-inventory-allocation S-017, INV-I4): job `inventory.detectOverdue` phát hiện lượt ở quá giờ trả
// chưa check-out. Đọc xuyên tổ chức qua hàm SECURITY DEFINER phạm vi hẹp (như `app.leases_overstaying`, 0016); worker ghi
// ngoại lệ trong ngữ cảnh từng tổ chức. Allocation KHÔNG bị đụng tới (không tự kết thúc lượt ở).
// Chỉ xét allocation CUỐI của lượt ở: sau `moveAllocation` allocation cũ thu về [lo, at) vẫn active — không phải phòng đang ở.
// Ngưỡng quá hạn (Q-03): `properties.overstay_grace_minutes` (ERD §properties; mặc định 60, CHECK >= 0) cộng vào giờ trả dự kiến.
import { type Kysely, sql } from "kysely";

// Job quét xuyên tổ chức mỗi lần chạy: không có index chỉ-in_house thì phải duyệt toàn bộ `stays` (`ix_stays_status` dẫn bằng cột
// tổ chức), và allocation của lượt ở tra theo nguồn nên cần index nguồn (chỉ allocation đang hiệu lực — bảng lịch sử lớn dần).
const UP = `
CREATE INDEX ix_stays_in_house ON stays (organization_id, property_id) WHERE status = 'in_house';
CREATE INDEX ix_allocations_active_source ON allocations (organization_id, source_id)
  WHERE active AND source_id IS NOT NULL;
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
      AND upper(a.during) + make_interval(mins => p.overstay_grace_minutes) <= p_now
      AND NOT EXISTS (SELECT 1 FROM allocations l WHERE l.organization_id = a.organization_id AND l.source_type = 'stay'
                        AND l.source_id = a.source_id AND l.active AND l.kind = 'stay' AND l.id <> a.id
                        AND lower(l.during) >= upper(a.during))
  $$;
REVOKE ALL ON FUNCTION app.stays_overdue(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.stays_overdue(timestamptz) TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.stays_overdue(timestamptz);
DROP INDEX IF EXISTS ix_allocations_active_source;
DROP INDEX IF EXISTS ix_stays_in_house;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
