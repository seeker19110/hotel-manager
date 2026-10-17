// PLAN đợt 5 T-406 (IND-FIN-006, OPS-OBS-003): đối soát hằng ngày — hàm đọc xuyên tổ chức phạm vi hẹp cho worker + số liệu cho /api/metrics.
// - `app.reconciliation_breaks_overdue(p_now, p_sla_hours, p_limit)`: chênh lệch đối soát ĐANG MỞ quá hạn xử lý (SLA) — job
//   worker đọc xuyên tổ chức qua hàm (không mở BYPASSRLS/policy xuyên tổ chức), rồi ghi audit trong ngữ cảnh từng tổ chức.
// - `app.ledger_drift()`: tổ chức mà Σ nợ ≠ Σ có trên sổ cái (số dư dẫn xuất lệch tổng posting). Bút toán đã bị trigger chặn mất
//   cân bằng (LEDGER_UNBALANCED) nên kết quả phải rỗng; hàm là lưới thứ hai phát hiện trôi do sửa tay/lỗi nền tảng.
// - `app.reconciliation_metrics(p_now)`: `hm_reconciliation_breaks_open` (gauge) + tuổi break mở cũ nhất — tách khỏi
//   `app.metrics_snapshot` (0046) để không đè hàm đó. CHỈ số tổng hợp toàn hệ thống, không nhãn tổ chức/cơ sở/người.
// Không đổi bảng; down xoá ba hàm.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.reconciliation_breaks_overdue(p_now timestamptz, p_sla_hours integer, p_limit integer)
  RETURNS TABLE (organization_id uuid, property_id uuid, break_id uuid, assignee uuid, reason text, age_hours integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT b.organization_id, b.property_id, b.id, b.assignee, b.reason,
           floor(extract(epoch FROM p_now - b.created_at) / extract(epoch FROM interval '1 hour'))::integer
    FROM reconciliation_breaks b
    WHERE b.status = 'open' AND b.created_at <= p_now - make_interval(hours => greatest(p_sla_hours, 0))
    ORDER BY b.created_at, b.id
    LIMIT least(greatest(p_limit, 1), 5000)
  $$;
REVOKE ALL ON FUNCTION app.reconciliation_breaks_overdue(timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reconciliation_breaks_overdue(timestamptz, integer, integer) TO app_worker;

CREATE FUNCTION app.ledger_drift()
  RETURNS TABLE (organization_id uuid, debit_total bigint, credit_total bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT l.organization_id, sum(l.debit)::bigint, sum(l.credit)::bigint
    FROM journal_lines l
    GROUP BY l.organization_id
    HAVING sum(l.debit) <> sum(l.credit)
  $$;
REVOKE ALL ON FUNCTION app.ledger_drift() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ledger_drift() TO app_worker;

CREATE FUNCTION app.reconciliation_metrics(p_now timestamptz)
  RETURNS TABLE (name text, labels jsonb, value double precision)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT 'hm_reconciliation_breaks_open'::text, '{}'::jsonb, count(*)::double precision
    FROM reconciliation_breaks WHERE status = 'open';
  RETURN QUERY SELECT 'hm_reconciliation_breaks_oldest_open_age_seconds'::text, '{}'::jsonb,
    coalesce(max(extract(epoch FROM p_now - created_at)), 0)::double precision
    FROM reconciliation_breaks WHERE status = 'open';
END $$;
REVOKE ALL ON FUNCTION app.reconciliation_metrics(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reconciliation_metrics(timestamptz) TO app_runtime, app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.reconciliation_metrics(timestamptz);
DROP FUNCTION IF EXISTS app.ledger_drift();
DROP FUNCTION IF EXISTS app.reconciliation_breaks_overdue(timestamptz, integer, integer);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
