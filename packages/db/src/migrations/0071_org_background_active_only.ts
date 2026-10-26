// D-126 (T-2312; migration 0070 đã có `organizations.status = 'pending_deletion'`) — tổ chức chờ xoá NGỪNG xử lý nền và liên kết khách:
// - Các hàm SECURITY DEFINER mà job worker dùng để CHỌN việc xuyên tổ chức chỉ lấy tổ chức `status = 'active'`: nhả hold/booking hết hạn,
//   kỳ thu định kỳ, hợp đồng sắp hết/quá hạn, lưu trú quá hạn, break đối soát quá SLA, lô gửi thông báo (`claim_due_deliveries`).
//   (`reminder_orgs` đã lọc `active` từ 0036.) `ledger_drift` cố ý giữ nguyên: chỉ cảnh báo toàn vẹn sổ cái, không xử lý dữ liệu.
// - `app.outbox_claim` (relay): hàng của tổ chức không active KHÔNG được lấy — nằm lại `outbox` (không mất; phát tiếp sau khi huỷ yêu cầu
//   xoá, hoặc bị purge cùng tổ chức) — NGOẠI LỆ `export.requested` để xuất dữ liệu trong thời gian giữ vẫn chạy (D-125).
// - `app.resolve_guest_link`: tổ chức không active ⇒ không trả hàng nào ⇒ app trả y như token không tồn tại (404 link_invalid, tính vào
//   giới hạn đoán token) — không lộ trạng thái; `guest_stay_view` đi qua hàm này nên cũng không trả dữ liệu. Huỷ yêu cầu xoá ⇒ link dùng lại được.
// Không đổi chữ ký/kiểu trả về/quyền (CREATE OR REPLACE giữ GRANT). Job export, tenancy.purge, privacy.dsar, privacy.retention,
// exports.expire, import.retention, events.retention dùng hàm khác — không đụng. DOWN: khôi phục đúng định nghĩa trước đó.
import { type Kysely, sql } from "kysely";

/** Điều kiện "tổ chức của cột `col` đang active" — rỗng khi dựng DOWN. */
type Active = (col: string) => string;
const active: Active = (col) =>
  `AND EXISTS (SELECT 1 FROM organizations og WHERE og.id = ${col} AND og.status = 'active')`;
const none: Active = () => "";

const DEF = "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS";

const build = (a: Active) => `
CREATE OR REPLACE FUNCTION app.expire_holds(p_now timestamptz, p_limit integer)
  RETURNS TABLE (allocation_id uuid, organization_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT a.id FROM allocations a
      WHERE a.active AND a.kind = 'hold' AND a.expires_at <= p_now ${a("a.organization_id")}
      ORDER BY a.expires_at, a.id
      LIMIT least(greatest(p_limit, 1), 10000)
      FOR UPDATE SKIP LOCKED
    )
    UPDATE allocations a SET active = false, deactivated_at = p_now, deactivated_reason = 'expired'
    FROM due WHERE a.id = due.id AND a.active
    RETURNING a.id, a.organization_id
  $$;

CREATE OR REPLACE FUNCTION app.due_held_reservations(p_now timestamptz, p_limit integer)
  RETURNS TABLE (reservation_id uuid, organization_id uuid)
  ${DEF} $$
    SELECT r.id, r.organization_id FROM reservations r
    JOIN reservation_items i ON i.organization_id = r.organization_id AND i.reservation_id = r.id
    LEFT JOIN allocations a ON a.organization_id = i.organization_id AND a.id = i.allocation_id
    WHERE r.status = 'held' AND (a.id IS NULL OR NOT a.active OR a.expires_at <= p_now) ${a("r.organization_id")}
    ORDER BY r.held_until, r.id
    LIMIT least(greatest(p_limit, 1), 10000)
  $$;

CREATE OR REPLACE FUNCTION app.properties_due_period(p_now timestamptz)
  RETURNS TABLE (organization_id uuid, property_id uuid, period_start date, period_end date)
  ${DEF} $$
    SELECT p.organization_id, p.id, m.s, (m.s + interval '1 month' - interval '1 day')::date
    FROM properties p
    CROSS JOIN LATERAL (SELECT date_trunc('month', (p_now AT TIME ZONE p.timezone))::date AS s) m
    WHERE p.template IN ('rental','mixed') AND p.archived_at IS NULL ${a("p.organization_id")}
      AND NOT EXISTS (SELECT 1 FROM billing_periods b WHERE b.organization_id = p.organization_id AND b.property_id = p.id
                        AND b.period_start = m.s)
  $$;

CREATE OR REPLACE FUNCTION app.leases_expiring(p_now timestamptz, p_days integer[])
  RETURNS TABLE (organization_id uuid, property_id uuid, lease_id uuid, version_no integer, effective_to date, days_left integer)
  ${DEF} $$
    SELECT l.organization_id, l.property_id, l.id, v.version_no, v.effective_to,
           (v.effective_to - (p_now AT TIME ZONE p.timezone)::date)::int
    FROM leases l
    JOIN properties p ON p.organization_id = l.organization_id AND p.id = l.property_id
    JOIN LATERAL (SELECT lv.version_no, lv.effective_to FROM lease_versions lv
                  WHERE lv.organization_id = l.organization_id AND lv.lease_id = l.id AND lv.signed_at IS NOT NULL
                  ORDER BY lv.version_no DESC LIMIT 1) v ON true
    WHERE l.status IN ('active','notice_given') AND v.effective_to IS NOT NULL ${a("l.organization_id")}
      AND (v.effective_to - (p_now AT TIME ZONE p.timezone)::date) = ANY (
        CASE WHEN jsonb_typeof(p.settings -> 'lease_reminder_days') = 'array'
             THEN ARRAY(SELECT x::int FROM jsonb_array_elements_text(p.settings -> 'lease_reminder_days') x
                        WHERE x ~ '^[0-9]{1,4}$')
             ELSE p_days END)
  $$;

CREATE OR REPLACE FUNCTION app.leases_overstaying(p_now timestamptz)
  RETURNS TABLE (organization_id uuid, property_id uuid, lease_id uuid, allocation_id uuid, related_allocation_id uuid)
  ${DEF} $$
    SELECT l.organization_id, l.property_id, l.id, a.id,
           (SELECT o.id FROM allocations o WHERE o.organization_id = a.organization_id AND o.unit_id = a.unit_id AND o.active
              AND o.id <> a.id AND lower(o.during) >= upper(a.during) ORDER BY lower(o.during), o.id LIMIT 1)
    FROM leases l
    JOIN properties p ON p.organization_id = l.organization_id AND p.id = l.property_id
    JOIN LATERAL (SELECT lv.effective_to FROM lease_versions lv
                  WHERE lv.organization_id = l.organization_id AND lv.lease_id = l.id AND lv.signed_at IS NOT NULL
                  ORDER BY lv.version_no DESC LIMIT 1) v ON true
    JOIN allocations a ON a.organization_id = l.organization_id AND a.source_type = 'lease' AND a.source_id = l.id
                      AND a.active AND a.kind = 'lease'
    WHERE l.status IN ('active','notice_given') AND v.effective_to IS NOT NULL ${a("l.organization_id")}
      AND v.effective_to < (p_now AT TIME ZONE p.timezone)::date
      AND NOT EXISTS (SELECT 1 FROM handovers h WHERE h.organization_id = l.organization_id AND h.lease_id = l.id
                        AND h.kind = 'move_out' AND h.confirmed_at IS NOT NULL)
  $$;

CREATE OR REPLACE FUNCTION app.stays_overdue(p_now timestamptz)
  RETURNS TABLE (organization_id uuid, property_id uuid, stay_id uuid, allocation_id uuid, related_allocation_id uuid)
  ${DEF} $$
    SELECT s.organization_id, s.property_id, s.id, a.id,
           (SELECT o.id FROM allocations o WHERE o.organization_id = a.organization_id AND o.unit_id = a.unit_id AND o.active AND o.kind IN ('stay', 'lease')
              AND o.id <> a.id AND lower(o.during) >= upper(a.during) ORDER BY lower(o.during), o.id LIMIT 1)
    FROM stays s
    JOIN properties p ON p.organization_id = s.organization_id AND p.id = s.property_id
    JOIN allocations a ON a.organization_id = s.organization_id AND a.source_type = 'stay' AND a.source_id = s.id
                      AND a.active AND a.kind = 'stay'
    WHERE s.status = 'in_house' AND NOT upper_inf(a.during) ${a("s.organization_id")}
      AND upper(a.during) + make_interval(mins => p.overstay_grace_minutes) <= p_now
      AND NOT EXISTS (SELECT 1 FROM allocations l WHERE l.organization_id = a.organization_id AND l.source_type = 'stay'
                        AND l.source_id = a.source_id AND l.active AND l.kind = 'stay' AND l.id <> a.id
                        AND lower(l.during) >= upper(a.during))
  $$;

CREATE OR REPLACE FUNCTION app.reconciliation_breaks_overdue(p_now timestamptz, p_sla_hours integer, p_limit integer)
  RETURNS TABLE (organization_id uuid, property_id uuid, break_id uuid, assignee uuid, reason text, age_hours integer)
  ${DEF} $$
    SELECT b.organization_id, b.property_id, b.id, b.assignee, b.reason,
           floor(extract(epoch FROM p_now - b.created_at) / extract(epoch FROM interval '1 hour'))::integer
    FROM reconciliation_breaks b
    WHERE b.status = 'open' AND b.created_at <= p_now - make_interval(hours => greatest(p_sla_hours, 0)) ${a("b.organization_id")}
    ORDER BY b.created_at, b.id
    LIMIT least(greatest(p_limit, 1), 5000)
  $$;

CREATE OR REPLACE FUNCTION app.claim_due_deliveries(p_now timestamptz, p_limit integer, p_per_org integer, p_lock_seconds integer,
                                         p_max_attempts integer)
  RETURNS TABLE (id uuid, organization_id uuid, attempts integer, locked_until timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE notification_deliveries d
     SET status = CASE WHEN d.attempts >= p_max_attempts THEN 'dead' ELSE 'retrying' END,
         next_attempt_at = CASE WHEN d.attempts >= p_max_attempts THEN d.next_attempt_at
                                ELSE p_now + make_interval(mins => (ARRAY[1,5,30,120,360])[least(greatest(d.attempts, 1), 5)]) END,
         locked_until = NULL, last_error_code = 'PROVIDER_TEMPORARY'
   WHERE d.status = 'sending' AND d.locked_until < p_now;
  RETURN QUERY
  WITH due_orgs AS (
    SELECT d.organization_id FROM notification_deliveries d
     WHERE d.status IN ('queued','retrying') AND d.next_attempt_at <= p_now ${a("d.organization_id")}
     GROUP BY d.organization_id
     ORDER BY min(d.next_attempt_at), d.organization_id
     LIMIT least(greatest(p_limit, 1), 1000)
  ), locked AS (
    SELECT x.id, x.organization_id, x.next_attempt_at
      FROM due_orgs o
      CROSS JOIN LATERAL (
        SELECT d.id, d.organization_id, d.next_attempt_at FROM notification_deliveries d
         WHERE d.organization_id = o.organization_id AND d.status IN ('queued','retrying') AND d.next_attempt_at <= p_now
         ORDER BY d.next_attempt_at, d.id
         LIMIT greatest(p_per_org, 1)
         FOR UPDATE SKIP LOCKED
      ) x
  ), ranked AS (
    SELECT l.id, l.next_attempt_at,
           row_number() OVER (PARTITION BY l.organization_id ORDER BY l.next_attempt_at, l.id) AS rn
      FROM locked l
  ), picked AS (
    SELECT r.id FROM ranked r ORDER BY r.rn, r.next_attempt_at, r.id LIMIT least(greatest(p_limit, 1), 1000)
  )
  UPDATE notification_deliveries d
     SET status = 'sending', attempts = d.attempts + 1,
         locked_until = date_trunc('milliseconds', p_now) + make_interval(secs => greatest(p_lock_seconds, 1))
    FROM picked p WHERE d.id = p.id
  RETURNING d.id, d.organization_id, d.attempts, d.locked_until;
END $$;
`;

const OUTBOX = (pass: string) => `
CREATE OR REPLACE FUNCTION app.outbox_claim(p_limit integer)
  RETURNS TABLE (id uuid, organization_id uuid, event_type text, aggregate_id uuid, payload jsonb, correlation_id text,
                 traceparent text)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH c AS (
      SELECT o.id FROM outbox o WHERE o.published_at IS NULL AND o.available_at <= now()${pass}
      ORDER BY o.created_at, o.id
      LIMIT least(greatest(p_limit, 1), 1000)
      FOR UPDATE SKIP LOCKED),
    u AS (
      UPDATE outbox o SET available_at = now() + interval '60 seconds'
      FROM c WHERE o.id = c.id
      RETURNING o.id, o.organization_id, o.event_type, o.aggregate_id, o.payload, o.correlation_id, o.traceparent, o.created_at)
    SELECT u.id, u.organization_id, u.event_type, u.aggregate_id, u.payload, u.correlation_id, u.traceparent
    FROM u ORDER BY u.created_at, u.id
  $$;
`;

const GUEST = (a: Active) => `
CREATE OR REPLACE FUNCTION app.resolve_guest_link(p_hash bytea)
  RETURNS TABLE (id uuid, organization_id uuid, property_id uuid, stay_id uuid, reservation_id uuid, expires_at timestamptz,
                 revoked_at timestamptz, locked_at timestamptz, failed_attempts integer, phone_last4 text,
                 second_factor boolean)
  ${DEF} $$
    SELECT g.id, g.organization_id, g.property_id, coalesce(g.stay_id, s.id), coalesce(g.reservation_id, ri.reservation_id),
           g.expires_at, g.revoked_at, g.locked_at, g.failed_attempts,
           right(regexp_replace(coalesce(bp.phone, ''), '[^0-9]', '', 'g'), 4),
           coalesce((p.settings ->> 'guest_link_second_factor')::boolean, true)
    FROM guest_access_links g
    JOIN properties p ON p.organization_id = g.organization_id AND p.id = g.property_id
    LEFT JOIN stays s0 ON s0.organization_id = g.organization_id AND s0.id = g.stay_id
    LEFT JOIN reservation_items ri ON ri.organization_id = g.organization_id
         AND (ri.id = s0.reservation_item_id OR (g.reservation_id IS NOT NULL AND ri.reservation_id = g.reservation_id))
    LEFT JOIN stays s ON s.organization_id = ri.organization_id AND s.reservation_item_id = ri.id
    LEFT JOIN reservations r ON r.organization_id = ri.organization_id AND r.id = ri.reservation_id
    LEFT JOIN persons bp ON bp.organization_id = r.organization_id AND bp.id = r.booker_person_id
    WHERE g.token_hash = p_hash ${a("g.organization_id")}
    LIMIT 1
  $$;
`;

const UP = `${build(active)}
${OUTBOX(`
        AND (o.event_type = 'export.requested'
             OR EXISTS (SELECT 1 FROM organizations og WHERE og.id = o.organization_id AND og.status = 'active'))`)}
${GUEST(active)}`;

const DOWN = `${build(none)}
${OUTBOX("")}
${GUEST(none)}`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
