// PLAN đợt 8 T-709 (OPS-COST-004): ngân sách email theo ngày/tổ chức — circuit breaker chi phí cho đường gửi qua relay trả phí.
// - Bảng `email_budget_days` (tổ chức, ngày UTC): `used` (lượt gọi nhà cung cấp đã được cấp), `throttled`/`stopped` (số lần hoãn vì
//   bóp/dừng — nguồn cho metric), `level` (mức cảnh báo cao nhất đã ghi trong ngày: 0 chưa · 1 ≥ warn · 2 ≥ bóp · 3 hết ngân sách).
//   Ngày tính theo UTC: ngân sách là chi phí hệ thống (nhà cung cấp tính hạn mức theo ngày UTC), tổ chức có nhiều cơ sở khác múi giờ
//   và `business_date` là khái niệm của cơ sở, không của tổ chức.
// - `app.email_budget_take(...)`: lấy khoá hàng (INSERT … ON CONFLICT DO NOTHING rồi SELECT … FOR UPDATE) ⇒ hai worker/hai kết nối
//   cùng gọi được tuần tự hoá theo (tổ chức, ngày): tổng `used` KHÔNG BAO GIỜ vượt ngân sách. Quyết định:
//     used ≥ ngân sách              ⇒ 'stopped'   (mọi loại — kể cả bắt buộc; không tăng used)
//     used ≥ p_throttle_pct % và loại KHÔNG bắt buộc ⇒ 'throttled' (không tăng used)
//     còn lại                        ⇒ 'send' (used + 1); `crossed` = true khi lượt này đưa `level` lên mức mới (cảnh báo MỘT lần/mức/ngày).
//   Lượt bị hoãn không tăng `used` nên bảng không phình theo hàng đợi tồn.
// - Bảng có `organization_id` nên bật RLS + FORCE như mọi bảng tổ chức; KHÔNG cấp quyền trực tiếp cho app_runtime/app_worker —
//   chỉ đi qua hàm SECURITY DEFINER (chủ hàm bỏ qua RLS, như `app.claim_due_deliveries`).
// - `app.email_budget_metrics(now, budget)`: số liệu tổng hợp toàn hệ thống (không nhãn tổ chức) cho /api/metrics.
// - Dọn dần: mỗi lần gọi xoá tối đa 50 hàng cũ hơn 90 ngày.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE email_budget_days (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  day date NOT NULL,
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  throttled integer NOT NULL DEFAULT 0 CHECK (throttled >= 0),
  stopped integer NOT NULL DEFAULT 0 CHECK (stopped >= 0),
  level smallint NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 3),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, day)
);
CREATE INDEX ix_email_budget_days_day ON email_budget_days (day);
ALTER TABLE email_budget_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_budget_days FORCE ROW LEVEL SECURITY;
CREATE POLICY email_budget_days_org ON email_budget_days FOR ALL
  USING (organization_id = app.current_org()) WITH CHECK (organization_id = app.current_org());
REVOKE ALL ON email_budget_days FROM PUBLIC;

CREATE FUNCTION app.email_budget_take(p_org uuid, p_now timestamptz, p_budget integer, p_warn_pct integer,
                                      p_throttle_pct integer, p_required boolean)
  RETURNS TABLE (decision text, used integer, level integer, crossed boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d date := (p_now AT TIME ZONE 'UTC')::date;
  r email_budget_days%ROWTYPE;
  n integer;
  lv integer;
BEGIN
  IF p_budget IS NULL OR p_budget < 1 OR p_warn_pct IS NULL OR p_throttle_pct IS NULL
     OR p_warn_pct < 1 OR p_throttle_pct < p_warn_pct OR p_throttle_pct > 100 THEN
    RAISE EXCEPTION 'email_budget_take: tham số ngân sách không hợp lệ' USING ERRCODE = '22023';
  END IF;
  INSERT INTO email_budget_days (organization_id, day) VALUES (p_org, d) ON CONFLICT (organization_id, day) DO NOTHING;
  SELECT * INTO r FROM email_budget_days b WHERE b.organization_id = p_org AND b.day = d FOR UPDATE;
  IF r.used >= p_budget THEN
    UPDATE email_budget_days b SET stopped = b.stopped + 1, updated_at = p_now WHERE b.organization_id = p_org AND b.day = d;
    RETURN QUERY SELECT 'stopped'::text, r.used, r.level::integer, false;
    RETURN;
  END IF;
  IF NOT p_required AND r.used::bigint * 100 >= p_throttle_pct::bigint * p_budget THEN
    UPDATE email_budget_days b SET throttled = b.throttled + 1, updated_at = p_now WHERE b.organization_id = p_org AND b.day = d;
    RETURN QUERY SELECT 'throttled'::text, r.used, r.level::integer, false;
    RETURN;
  END IF;
  n := r.used + 1;
  lv := CASE WHEN n >= p_budget THEN 3
             WHEN n::bigint * 100 >= p_throttle_pct::bigint * p_budget THEN 2
             WHEN n::bigint * 100 >= p_warn_pct::bigint * p_budget THEN 1
             ELSE 0 END;
  UPDATE email_budget_days b SET used = n, level = greatest(b.level, lv), updated_at = p_now
   WHERE b.organization_id = p_org AND b.day = d;
  DELETE FROM email_budget_days x WHERE x.ctid IN (
    SELECT y.ctid FROM email_budget_days y WHERE y.day < d - 90 LIMIT 50 FOR UPDATE SKIP LOCKED);
  RETURN QUERY SELECT 'send'::text, n, greatest(r.level::integer, lv), lv > r.level;
END $$;
REVOKE ALL ON FUNCTION app.email_budget_take(uuid, timestamptz, integer, integer, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_budget_take(uuid, timestamptz, integer, integer, integer, boolean) TO app_worker;

CREATE FUNCTION app.email_budget_metrics(p_now timestamptz, p_budget integer)
  RETURNS TABLE (name text, labels jsonb, value double precision)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT 'hm_email_budget_used_ratio'::text, '{}'::jsonb,
           coalesce((SELECT max(b.used) FROM email_budget_days b WHERE b.day = (p_now AT TIME ZONE 'UTC')::date), 0)::double precision
             / greatest(p_budget, 1)
    UNION ALL
    SELECT 'hm_email_budget_throttled_total'::text, '{}'::jsonb, coalesce(sum(b.throttled), 0)::double precision FROM email_budget_days b
    UNION ALL
    SELECT 'hm_email_budget_stopped_total'::text, '{}'::jsonb, coalesce(sum(b.stopped), 0)::double precision FROM email_budget_days b
  $$;
REVOKE ALL ON FUNCTION app.email_budget_metrics(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_budget_metrics(timestamptz, integer) TO app_runtime, app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.email_budget_metrics(timestamptz, integer);
DROP FUNCTION IF EXISTS app.email_budget_take(uuid, timestamptz, integer, integer, integer, boolean);
DROP TABLE IF EXISTS email_budget_days;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
