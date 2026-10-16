// PLAN đợt 3 T-212 — quét nhắc hạn (SPEC-notifications S-007, S-008, S-013, S-020; INV-G1, INV-G2, INV-G6).
// Worker không có ngữ cảnh tổ chức khi quét nên đọc qua các hàm SECURITY DEFINER phạm vi hẹp (cùng mẫu `app.leases_expiring`):
// chỉ trả id + số liệu cần để phát sự kiện outbox, không trả nội dung/PII; ghi vẫn làm trong ngữ cảnh từng tổ chức.
// - `app.invoices_overdue`: phiếu còn nợ (`open_amount > 0`) đã tới một mốc nhắc quá hạn mà CHƯA có sự kiện cho mốc đó. Ngày
//   tính theo ngày kinh doanh của cơ sở (múi giờ + giờ chốt); chỉ trong khung giờ gửi của cơ sở (mặc định 08:00–20:00,
//   đầu khung gồm, cuối khung loại). Mốc = offset lớn nhất ≤ số ngày quá hạn (bù được khi job lỡ một ngày, vẫn một nhắc/mốc).
// - `app.leases_expiring` (thay thế, cùng chữ ký): ưu tiên mốc của `notification_settings.lease_expiry_offsets_days` (nơi cấu hình
//   của F-011) → `properties.settings.lease_reminder_days` (cũ) → tham số mặc định. Trước đây cấu hình lưu được nhưng job bỏ qua.
// - `app.stay_notice_unconfigured`: cơ sở đang có khách `in_house` mà chưa cấu hình hạn thông báo lưu trú (S-020).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.invoices_overdue(p_now timestamptz, p_limit integer)
  RETURNS TABLE (organization_id uuid, property_id uuid, invoice_id uuid, due_on date, days_overdue integer, milestone integer,
                 business_date date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT i.organization_id, i.property_id, i.id, i.due_on, (t.bd - i.due_on)::int, m.milestone, t.bd
    FROM invoices i
    JOIN properties p ON p.organization_id = i.organization_id AND p.id = i.property_id
    LEFT JOIN notification_settings s ON s.organization_id = i.organization_id AND s.property_id = i.property_id
    CROSS JOIN LATERAL (SELECT (p_now AT TIME ZONE p.timezone) AS local_ts) l
    CROSS JOIN LATERAL (SELECT (l.local_ts - p.business_day_cutoff)::date AS bd) t
    CROSS JOIN LATERAL (SELECT max(x)::int AS milestone
                        FROM unnest(coalesce(s.overdue_reminder_offsets_days, ARRAY[1])) AS x
                        WHERE x >= 1 AND x <= (t.bd - i.due_on)) m
    WHERE i.open_amount > 0 AND i.due_on IS NOT NULL AND i.kind <> 'adjustment'
      AND p.archived_at IS NULL AND m.milestone IS NOT NULL
      AND l.local_ts::time >= coalesce(s.send_window_start, time '08:00')
      AND l.local_ts::time < coalesce(s.send_window_end, time '20:00')
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.organization_id = i.organization_id
                        AND o.dedupe_key = 'invoice.overdue:' || i.id::text || ':' || m.milestone::text)
    ORDER BY i.organization_id, i.due_on, i.id
    LIMIT least(greatest(p_limit, 1), 5000)
  $$;

CREATE OR REPLACE FUNCTION app.leases_expiring(p_now timestamptz, p_days integer[])
  RETURNS TABLE (organization_id uuid, property_id uuid, lease_id uuid, version_no integer, effective_to date, days_left integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT l.organization_id, l.property_id, l.id, v.version_no, v.effective_to,
           (v.effective_to - (p_now AT TIME ZONE p.timezone)::date)::int
    FROM leases l
    JOIN properties p ON p.organization_id = l.organization_id AND p.id = l.property_id
    LEFT JOIN notification_settings ns ON ns.organization_id = l.organization_id AND ns.property_id = l.property_id
    JOIN LATERAL (SELECT lv.version_no, lv.effective_to FROM lease_versions lv
                  WHERE lv.organization_id = l.organization_id AND lv.lease_id = l.id AND lv.signed_at IS NOT NULL
                  ORDER BY lv.version_no DESC LIMIT 1) v ON true
    WHERE l.status IN ('active','notice_given') AND v.effective_to IS NOT NULL
      AND (v.effective_to - (p_now AT TIME ZONE p.timezone)::date) = ANY (
        CASE WHEN ns.id IS NOT NULL THEN ns.lease_expiry_offsets_days
             WHEN jsonb_typeof(p.settings -> 'lease_reminder_days') = 'array'
             THEN ARRAY(SELECT x::int FROM jsonb_array_elements_text(p.settings -> 'lease_reminder_days') x
                        WHERE x ~ '^[0-9]{1,4}$')
             ELSE p_days END)
  $$;

CREATE FUNCTION app.stay_notice_unconfigured(p_now timestamptz)
  RETURNS TABLE (organization_id uuid, property_id uuid, business_date date, in_house integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT st.organization_id, st.property_id, ((p_now AT TIME ZONE p.timezone) - p.business_day_cutoff)::date, count(*)::int
    FROM stays st
    JOIN properties p ON p.organization_id = st.organization_id AND p.id = st.property_id
    LEFT JOIN notification_settings ns ON ns.organization_id = st.organization_id AND ns.property_id = st.property_id
    WHERE st.status = 'in_house' AND p.archived_at IS NULL
      AND (ns.stay_notice_deadline IS NULL OR ns.stay_notice_deadline = '{}'::jsonb)
    GROUP BY st.organization_id, st.property_id, p.timezone, p.business_day_cutoff
  $$;

REVOKE ALL ON FUNCTION app.invoices_overdue(timestamptz, integer), app.stay_notice_unconfigured(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invoices_overdue(timestamptz, integer), app.stay_notice_unconfigured(timestamptz) TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.stay_notice_unconfigured(timestamptz);
DROP FUNCTION IF EXISTS app.invoices_overdue(timestamptz, integer);
CREATE OR REPLACE FUNCTION app.leases_expiring(p_now timestamptz, p_days integer[])
  RETURNS TABLE (organization_id uuid, property_id uuid, lease_id uuid, version_no integer, effective_to date, days_left integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT l.organization_id, l.property_id, l.id, v.version_no, v.effective_to,
           (v.effective_to - (p_now AT TIME ZONE p.timezone)::date)::int
    FROM leases l
    JOIN properties p ON p.organization_id = l.organization_id AND p.id = l.property_id
    JOIN LATERAL (SELECT lv.version_no, lv.effective_to FROM lease_versions lv
                  WHERE lv.organization_id = l.organization_id AND lv.lease_id = l.id AND lv.signed_at IS NOT NULL
                  ORDER BY lv.version_no DESC LIMIT 1) v ON true
    WHERE l.status IN ('active','notice_given') AND v.effective_to IS NOT NULL
      AND (v.effective_to - (p_now AT TIME ZONE p.timezone)::date) = ANY (
        CASE WHEN jsonb_typeof(p.settings -> 'lease_reminder_days') = 'array'
             THEN ARRAY(SELECT x::int FROM jsonb_array_elements_text(p.settings -> 'lease_reminder_days') x
                        WHERE x ~ '^[0-9]{1,4}$')
             ELSE p_days END)
  $$;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
