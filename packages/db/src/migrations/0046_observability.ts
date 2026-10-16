// PLAN đợt 3 T-225 — quan sát/vận hành (ARCHITECTURE "Quan sát tối thiểu"; BASE-OBS-*; D-021).
// - `worker_heartbeats`: mỗi tiến trình worker ghi nhịp (tên tiến trình, thời điểm) — không phải dữ liệu tổ chức.
// - `app.metrics_snapshot()`: CHỈ số tổng hợp toàn hệ thống (không nhãn tổ chức/cơ sở/người) cho `/api/metrics`:
//   outbox chưa phát + tuổi hàng cũ nhất + số đang lỗi, lần gửi email theo trạng thái (`notification_dead_total`), job xuất
//   theo trạng thái, hold hết hạn/đang giữ, job pg-boss `failed` (nếu có schema pgboss), tuổi nhịp worker.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE worker_heartbeats (
  name text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  beat_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_heartbeats FORCE ROW LEVEL SECURITY;
-- Không policy cho app_runtime ⇒ runtime không đọc/ghi trực tiếp; worker ghi qua hàm.
CREATE FUNCTION app.worker_heartbeat(p_name text, p_now timestamptz) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    INSERT INTO worker_heartbeats (name, beat_at, started_at) VALUES (p_name, p_now, p_now)
    ON CONFLICT (name) DO UPDATE SET beat_at = excluded.beat_at
  $$;
REVOKE ALL ON FUNCTION app.worker_heartbeat(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_heartbeat(text, timestamptz) TO app_worker;

CREATE FUNCTION app.metrics_snapshot(p_now timestamptz)
  RETURNS TABLE (name text, labels jsonb, value double precision)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE failed bigint;
BEGIN
  RETURN QUERY SELECT 'hm_outbox_unpublished'::text, '{}'::jsonb, count(*)::double precision
    FROM outbox WHERE published_at IS NULL;
  RETURN QUERY SELECT 'hm_outbox_oldest_unpublished_age_seconds'::text, '{}'::jsonb,
    coalesce(extract(epoch FROM p_now - min(created_at)), 0)::double precision FROM outbox WHERE published_at IS NULL;
  RETURN QUERY SELECT 'hm_outbox_failing'::text, '{}'::jsonb, count(*)::double precision
    FROM outbox WHERE published_at IS NULL AND attempts > 0;
  RETURN QUERY SELECT 'notification_dead_total'::text, '{}'::jsonb, count(*)::double precision
    FROM notification_deliveries WHERE status = 'dead';
  RETURN QUERY SELECT 'hm_notification_deliveries'::text, jsonb_build_object('status', s.status), coalesce(c.n, 0)::double precision
    FROM unnest(ARRAY['queued','sending','sent','retrying','failed','dead','suppressed']) s(status)
    LEFT JOIN (SELECT d.status, count(*) AS n FROM notification_deliveries d GROUP BY d.status) c ON c.status = s.status;
  RETURN QUERY SELECT 'hm_export_jobs'::text, jsonb_build_object('status', s.status), coalesce(c.n, 0)::double precision
    FROM unnest(ARRAY['queued','running','ready','failed','expired']) s(status)
    LEFT JOIN (SELECT e.status, count(*) AS n FROM export_jobs e GROUP BY e.status) c ON c.status = s.status;
  RETURN QUERY SELECT 'hm_holds_expired_total'::text, '{}'::jsonb, count(*)::double precision
    FROM allocations WHERE kind = 'hold' AND deactivated_reason = 'expired';
  RETURN QUERY SELECT 'hm_holds_active'::text, '{}'::jsonb, count(*)::double precision
    FROM allocations WHERE kind = 'hold' AND active;
  IF to_regclass('pgboss.job') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM pgboss.job WHERE state = ''failed''' INTO failed;
    RETURN QUERY SELECT 'hm_jobs_failed'::text, '{}'::jsonb, failed::double precision;
  END IF;
  RETURN QUERY SELECT 'hm_worker_heartbeat_age_seconds'::text, jsonb_build_object('worker', w.name),
    extract(epoch FROM p_now - w.beat_at)::double precision FROM worker_heartbeats w;
END $$;
REVOKE ALL ON FUNCTION app.metrics_snapshot(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.metrics_snapshot(timestamptz) TO app_runtime, app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.metrics_snapshot(timestamptz);
DROP FUNCTION IF EXISTS app.worker_heartbeat(text, timestamptz);
DROP TABLE IF EXISTS worker_heartbeats;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
