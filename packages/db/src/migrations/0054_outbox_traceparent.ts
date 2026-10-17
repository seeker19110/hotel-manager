// PLAN đợt 6 T-501 (BASE-ERR-006, SEC-LOG-001): job worker nối tiếp trace của request đã sinh ra nó.
// - `outbox.traceparent`: W3C `traceparent` (level 1: `00-<trace-id>-<span-id>-<flags>`) của span đang chạy lúc ghi sự kiện;
//   NULL = ghi ngoài request/job (hàng cũ, script). CSDL chặn dạng sai (không chữ hoa, không trace-id/span-id toàn 0, cờ chỉ
//   `00`/`01`) để một đường ghi khác cũng không lọt chuỗi tuỳ ý vào log của job.
// - `app.outbox_claim` trả thêm cột đó (đổi kiểu trả về ⇒ phải DROP rồi CREATE; cấp lại quyền như 0003). Phần còn lại của hàm
//   giữ nguyên định nghĩa của 0047 (lease 60 giây, SKIP LOCKED).
// - Expand-only: cột nullable, không giá trị mặc định ⇒ ADD COLUMN không ghi lại bảng; bản ứng dụng cũ vẫn INSERT được (cột NULL)
//   và đọc `outbox_claim` bằng `select *` không vỡ khi có thêm cột.
import { type Kysely, sql } from "kysely";

const UP = `
ALTER TABLE outbox ADD COLUMN traceparent text;
ALTER TABLE outbox ADD CONSTRAINT ck_outbox_traceparent CHECK (
  traceparent IS NULL
  OR (traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$'
      AND traceparent !~ '^00-0{32}-'
      AND traceparent !~ '^00-[0-9a-f]{32}-0{16}-'));

DROP FUNCTION app.outbox_claim(integer);
CREATE FUNCTION app.outbox_claim(p_limit integer)
  RETURNS TABLE (id uuid, organization_id uuid, event_type text, aggregate_id uuid, payload jsonb, correlation_id text,
                 traceparent text)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH c AS (
      SELECT o.id FROM outbox o WHERE o.published_at IS NULL AND o.available_at <= now()
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
REVOKE ALL ON FUNCTION app.outbox_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_claim(integer) TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.outbox_claim(integer);
-- Khôi phục đúng định nghĩa của 0047 trước khi bỏ cột mà hàm mới dùng.
CREATE FUNCTION app.outbox_claim(p_limit integer)
  RETURNS TABLE (id uuid, organization_id uuid, event_type text, aggregate_id uuid, payload jsonb, correlation_id text)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH c AS (
      SELECT o.id FROM outbox o WHERE o.published_at IS NULL AND o.available_at <= now()
      ORDER BY o.created_at, o.id
      LIMIT least(greatest(p_limit, 1), 1000)
      FOR UPDATE SKIP LOCKED),
    u AS (
      UPDATE outbox o SET available_at = now() + interval '60 seconds'
      FROM c WHERE o.id = c.id
      RETURNING o.id, o.organization_id, o.event_type, o.aggregate_id, o.payload, o.correlation_id, o.created_at)
    SELECT u.id, u.organization_id, u.event_type, u.aggregate_id, u.payload, u.correlation_id
    FROM u ORDER BY u.created_at, u.id
  $$;
REVOKE ALL ON FUNCTION app.outbox_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_claim(integer) TO app_worker;
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS ck_outbox_traceparent;
ALTER TABLE outbox DROP COLUMN IF EXISTS traceparent;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
