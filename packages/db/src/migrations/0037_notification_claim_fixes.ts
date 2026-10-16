// Review PR #10 — `app.claim_due_deliveries` (SPEC-notifications S-003, S-004; Q-05):
// - `sending` quá hạn khoá được trả về `retrying` với CHỜ LÙI theo số lần đã thử (1/5/30/120/360 phút, như `send.ts`),
//   không nhận lại ngay trong cùng lượt (worker cũ có thể vẫn đang gửi). `send.ts` ghi kết quả có điều kiện
//   `attempts = <lúc nhận>` nên worker cũ không ghi đè lần nhận mới.
// - Chọn theo TỪNG tổ chức trước (tổ chức có hàng đến hạn → tối đa p_per_org hàng, SKIP LOCKED) rồi xếp vòng tròn theo thứ
//   hạng trong tổ chức và mới cắt p_limit: một tổ chức tồn đọng nhiều không chiếm hết lô của tổ chức khác (bản 0034 cắt
//   p_limit × 4 hàng sớm nhất toàn hệ thống trước khi chia theo tổ chức).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE INDEX ix_notification_deliveries_org_due ON notification_deliveries (organization_id, next_attempt_at, id)
  WHERE status IN ('queued','retrying');

CREATE OR REPLACE FUNCTION app.claim_due_deliveries(p_now timestamptz, p_limit integer, p_per_org integer, p_lock_seconds integer,
                                                    p_max_attempts integer)
  RETURNS TABLE (id uuid, organization_id uuid, attempts integer)
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
    SELECT DISTINCT d.organization_id FROM notification_deliveries d
     WHERE d.status IN ('queued','retrying') AND d.next_attempt_at <= p_now
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
         locked_until = p_now + make_interval(secs => greatest(p_lock_seconds, 1))
    FROM picked p WHERE d.id = p.id
  RETURNING d.id, d.organization_id, d.attempts;
END $$;
`;

const DOWN = `
CREATE OR REPLACE FUNCTION app.claim_due_deliveries(p_now timestamptz, p_limit integer, p_per_org integer, p_lock_seconds integer,
                                                    p_max_attempts integer)
  RETURNS TABLE (id uuid, organization_id uuid, attempts integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE notification_deliveries d
     SET status = CASE WHEN d.attempts >= p_max_attempts THEN 'dead' ELSE 'retrying' END,
         next_attempt_at = CASE WHEN d.attempts >= p_max_attempts THEN d.next_attempt_at ELSE p_now END,
         locked_until = NULL, last_error_code = 'PROVIDER_TEMPORARY'
   WHERE d.status = 'sending' AND d.locked_until < p_now;
  RETURN QUERY
  WITH locked AS (
    SELECT d.id, d.organization_id, d.next_attempt_at FROM notification_deliveries d
     WHERE d.status IN ('queued','retrying') AND d.next_attempt_at <= p_now
     ORDER BY d.next_attempt_at, d.id
     LIMIT least(greatest(p_limit, 1), 1000) * 4
     FOR UPDATE SKIP LOCKED
  ), ranked AS (
    SELECT l.id, row_number() OVER (PARTITION BY l.organization_id ORDER BY l.next_attempt_at, l.id) AS rn, l.next_attempt_at
      FROM locked l
  ), picked AS (
    SELECT r.id FROM ranked r WHERE r.rn <= greatest(p_per_org, 1)
     ORDER BY r.next_attempt_at, r.id LIMIT least(greatest(p_limit, 1), 1000)
  )
  UPDATE notification_deliveries d
     SET status = 'sending', attempts = d.attempts + 1,
         locked_until = p_now + make_interval(secs => greatest(p_lock_seconds, 1))
    FROM picked p WHERE d.id = p.id
  RETURNING d.id, d.organization_id, d.attempts;
END $$;
DROP INDEX IF EXISTS ix_notification_deliveries_org_due;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
