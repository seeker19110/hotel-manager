// PLAN đợt 6 T-504 (BE-REL-006): bộ đếm giới hạn tần suất dùng chung giữa các instance — cho route KHÔNG đi qua hạn mức lệnh
// của pipeline (tải file/nhập liệu, webhook ngân hàng). Cửa sổ cố định: `window_start` = đầu cửa sổ làm tròn theo giây Unix.
// - Bảng `rate_limit_counters` toàn cục (khoá `scope` + `subject`, KHÔNG chứa PII: subject là id thành viên/tổ chức hoặc tên
//   nhà cung cấp); thu hồi mọi quyền, chỉ đi qua hàm SECURITY DEFINER (như `guest_link_rate`, 0041).
// - `app.rate_limit_hit(scope, subject, limit, window_seconds, now)`: lấy khoá advisory (transaction) theo (scope, subject) rồi
//   mới đọc-so-sánh-tăng ⇒ hai kết nối/hai instance cùng gọi không bao giờ cùng thấy "còn chỗ" cho lượt cuối. Lượt bị từ chối
//   KHÔNG tăng bộ đếm (bảng không phình theo kẻ spam). Trả `retry_after` = số giây tới hết cửa sổ (≥ 1).
// - Dọn dần: mỗi lần gọi xoá tối đa 50 hàng cửa sổ đã kết thúc > 1 ngày (cửa sổ tối đa 1 ngày).
// Giới hạn đã biết của cửa sổ cố định: sát ranh giới cửa sổ có thể lọt tới 2 × hạn mức trong thời gian ngắn — chấp nhận được
// cho mục tiêu chống lạm dụng/tải (không phải hạn mức thương mại).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE rate_limit_counters (
  scope text NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 64),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits >= 0),
  PRIMARY KEY (scope, subject, window_start)
);
CREATE INDEX ix_rate_limit_counters_window ON rate_limit_counters (window_start);
REVOKE ALL ON rate_limit_counters FROM PUBLIC;

CREATE FUNCTION app.rate_limit_hit(p_scope text, p_subject text, p_limit integer, p_window_seconds integer,
                                   p_now timestamptz DEFAULT now())
  RETURNS TABLE (allowed boolean, used integer, retry_after integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  w_secs integer := least(greatest(p_window_seconds, 1), 86400);
  w_start timestamptz := to_timestamp(floor(extract(epoch FROM p_now) / w_secs) * w_secs);
  n integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'rate_limit_hit: p_limit phải >= 1' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rate_limit:' || p_scope || ':' || p_subject, 0));
  SELECT c.hits INTO n FROM rate_limit_counters c
   WHERE c.scope = p_scope AND c.subject = p_subject AND c.window_start = w_start;
  n := coalesce(n, 0);
  IF n >= p_limit THEN
    RETURN QUERY SELECT false, n,
      greatest(1, ceil(extract(epoch FROM w_start + w_secs * interval '1 second' - p_now))::integer);
    RETURN;
  END IF;
  INSERT INTO rate_limit_counters AS c (scope, subject, window_start, hits) VALUES (p_scope, p_subject, w_start, 1)
  ON CONFLICT (scope, subject, window_start) DO UPDATE SET hits = c.hits + 1
  RETURNING c.hits INTO n;
  DELETE FROM rate_limit_counters d WHERE d.ctid IN (
    SELECT x.ctid FROM rate_limit_counters x WHERE x.window_start < p_now - interval '1 day' LIMIT 50
    FOR UPDATE SKIP LOCKED);
  RETURN QUERY SELECT true, n, 0;
END $$;
REVOKE ALL ON FUNCTION app.rate_limit_hit(text, text, integer, integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rate_limit_hit(text, text, integer, integer, timestamptz) TO app_runtime;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.rate_limit_hit(text, text, integer, integer, timestamptz);
DROP TABLE IF EXISTS rate_limit_counters;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
