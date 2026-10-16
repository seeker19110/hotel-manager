// PLAN đợt 3 T-215 — nhắc theo lịch (SPEC-notifications S-007, S-008, S-013…S-016, S-020, S-021). Job quét theo TỪNG tổ
// chức (§7 "Cách ly"): mỗi hàm SECURITY DEFINER nhận `p_org` và chỉ trả hàng của tổ chức đó, đủ cột để tạo thông báo —
// không trả PII ngoài id người nhận. Ngày/giờ theo `properties.timezone`, lưu UTC.
import { type Kysely, sql } from "kysely";

const UP = `
-- Tổ chức đang hoạt động (worker lặp từng tổ chức).
CREATE FUNCTION app.reminder_orgs() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT id FROM organizations WHERE status = 'active' ORDER BY id
  $$;

-- S-007: phiếu thu kỳ còn nợ có (ngày địa phương − hạn) thuộc lịch nhắc (mặc định 1, 3, 7) và đang trong khung giờ gửi.
CREATE FUNCTION app.overdue_candidates(p_org uuid, p_now timestamptz)
  RETURNS TABLE (property_id uuid, property_name text, invoice_id uuid, payer_person_id uuid, open_amount bigint, due_on date,
                 period_start date, business_date date, local_date date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT i.property_id, p.name, i.id, i.payer_person_id, (i.total - i.allocated_total)::bigint, i.due_on, bp.period_start,
           i.business_date, (p_now AT TIME ZONE p.timezone)::date
    FROM invoices i
    JOIN properties p ON p.organization_id = i.organization_id AND p.id = i.property_id
    LEFT JOIN notification_settings ns ON ns.organization_id = i.organization_id AND ns.property_id = i.property_id
    LEFT JOIN billing_periods bp ON bp.organization_id = i.organization_id AND bp.id = i.billing_period_id
    WHERE i.organization_id = p_org AND i.lease_id IS NOT NULL AND i.kind IN ('periodic','fee') AND i.due_on IS NOT NULL
      AND i.total > i.allocated_total
      AND ((p_now AT TIME ZONE p.timezone)::date - i.due_on) = ANY (coalesce(ns.overdue_reminder_offsets_days, '{1,3,7}'))
      AND (p_now AT TIME ZONE p.timezone)::time >= coalesce(ns.send_window_start, '08:00')
      AND (p_now AT TIME ZONE p.timezone)::time < coalesce(ns.send_window_end, '20:00')
  $$;

-- S-013: hợp đồng hiệu lực mà phiên bản ĐÃ KÝ mới nhất kết thúc sau đúng một mốc (mặc định 30, 7) ngày — đã gia hạn thì
-- phiên bản mới có ngày kết thúc mới nên mốc cũ tự hết khớp.
CREATE FUNCTION app.lease_expiry_candidates(p_org uuid, p_now timestamptz)
  RETURNS TABLE (property_id uuid, property_name text, lease_id uuid, version_no integer, unit_code text, effective_to date,
                 days_left integer, representative_person_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT l.property_id, p.name, l.id, v.version_no, u.code, v.effective_to,
           (v.effective_to - (p_now AT TIME ZONE p.timezone)::date)::int, l.representative_person_id
    FROM leases l
    JOIN properties p ON p.organization_id = l.organization_id AND p.id = l.property_id
    JOIN units u ON u.organization_id = l.organization_id AND u.id = l.unit_id
    LEFT JOIN notification_settings ns ON ns.organization_id = l.organization_id AND ns.property_id = l.property_id
    JOIN LATERAL (SELECT lv.version_no, lv.effective_to FROM lease_versions lv
                  WHERE lv.organization_id = l.organization_id AND lv.lease_id = l.id AND lv.signed_at IS NOT NULL
                  ORDER BY lv.version_no DESC LIMIT 1) v ON true
    WHERE l.organization_id = p_org AND l.status IN ('active','notice_given') AND v.effective_to IS NOT NULL
      AND (v.effective_to - (p_now AT TIME ZONE p.timezone)::date) = ANY (coalesce(ns.lease_expiry_offsets_days, '{30,7}'))
  $$;

-- Người nhận nội bộ của một cơ sở theo vai trò (thành viên đang hoạt động, có phạm vi cơ sở).
CREATE FUNCTION app.property_staff(p_org uuid, p_property uuid, p_roles text[]) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT DISTINCT m.person_id FROM memberships m
    WHERE m.organization_id = p_org AND m.status = 'active' AND m.role = ANY (p_roles)
      AND (m.all_properties OR EXISTS (SELECT 1 FROM property_scopes ps WHERE ps.organization_id = m.organization_id
                                         AND ps.membership_id = m.id AND ps.property_id = p_property))
  $$;

-- S-014…S-016, S-021: thông báo lưu trú chưa nộp của khách đang ở / đã ở, có hạn. Mức: normal (trước hạn > 30 phút),
-- urgent (≤ 30 phút trước hạn), overdue (đã qua hạn). S-020: cơ sở có thông báo chờ mà chưa cấu hình hạn → hàng
-- notice_id NULL, level 'config_missing' (mỗi cơ sở một hàng).
CREATE FUNCTION app.stay_notice_candidates(p_org uuid, p_now timestamptz)
  RETURNS TABLE (property_id uuid, property_name text, notice_id uuid, unit_code text, due_at timestamptz, due_at_local text,
                 level text, business_date date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT rn.property_id, p.name, rn.id, u.code, rn.due_at,
           to_char(rn.due_at AT TIME ZONE p.timezone, 'HH24:MI DD/MM/YYYY'),
           CASE WHEN p_now >= rn.due_at THEN 'overdue'
                WHEN p_now >= rn.due_at - interval '30 minutes' THEN 'urgent' ELSE 'normal' END,
           app.business_date(p_org, rn.property_id, p_now)
    FROM residence_notices rn
    JOIN properties p ON p.organization_id = rn.organization_id AND p.id = rn.property_id
    JOIN stays s ON s.organization_id = rn.organization_id AND s.id = rn.stay_id
    JOIN units u ON u.organization_id = s.organization_id AND u.id = s.unit_id
    WHERE rn.organization_id = p_org AND rn.status IN ('pending','exported') AND rn.due_at IS NOT NULL
      AND s.status IN ('in_house','checked_out')
    UNION ALL
    SELECT p.id, p.name, NULL::uuid, NULL::text, NULL::timestamptz, NULL::text, 'config_missing',
           app.business_date(p_org, p.id, p_now)
    FROM properties p
    LEFT JOIN notification_settings ns ON ns.organization_id = p.organization_id AND ns.property_id = p.id
    WHERE p.organization_id = p_org AND ns.stay_notice_deadline IS NULL
      AND EXISTS (SELECT 1 FROM residence_notices rn WHERE rn.organization_id = p.organization_id AND rn.property_id = p.id
                    AND rn.status = 'pending' AND rn.due_at IS NULL)
  $$;

REVOKE ALL ON FUNCTION app.reminder_orgs(), app.overdue_candidates(uuid, timestamptz),
  app.lease_expiry_candidates(uuid, timestamptz), app.property_staff(uuid, uuid, text[]),
  app.stay_notice_candidates(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reminder_orgs(), app.overdue_candidates(uuid, timestamptz),
  app.lease_expiry_candidates(uuid, timestamptz), app.property_staff(uuid, uuid, text[]),
  app.stay_notice_candidates(uuid, timestamptz) TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.stay_notice_candidates(uuid, timestamptz);
DROP FUNCTION IF EXISTS app.property_staff(uuid, uuid, text[]);
DROP FUNCTION IF EXISTS app.lease_expiry_candidates(uuid, timestamptz);
DROP FUNCTION IF EXISTS app.overdue_candidates(uuid, timestamptz);
DROP FUNCTION IF EXISTS app.reminder_orgs();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
