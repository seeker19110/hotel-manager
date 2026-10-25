// PLAN T-2309 (PM-METRIC-003/005/006; D-118) — analytics sản phẩm tự host: bảng `product_events` + hạn lưu + ngắt liên kết người.
// Chỉ ghi qua `track()` của packages/app/src/analytics (schema allowlist MỘT nơi, cấm PII, mặc định không ghi tới khi có đồng ý —
// T-2310 nối `consent_records`). Bảng chỉ chứa ID nội bộ (uuid), enum, số: không tên/email/SĐT/IP/ghi chú.
// - `product_events`: (tổ chức, cơ sở tuỳ chọn, tên `doi_tuong.hanh_dong`, phiên bản schema, props jsonb dạng object, người thao tác
//   tuỳ chọn, thời điểm xảy ra). `actor_user_id` là id `auth."user"` KHÔNG có khoá ngoại: sự kiện không được chặn việc xoá tài khoản
//   và việc ngắt liên kết do hàm riêng làm (xem dưới); `property_id` có khoá ngoại ghép như `audit_events`.
// - RLS bật + FORCE, policy theo tổ chức (`app.current_org()`). `app_runtime` chỉ được INSERT (không SELECT/UPDATE/DELETE: bảng là
//   nguồn số đo cho vận hành sản phẩm, tenant không cần đọc thô; đọc tổng hợp sau này đi qua hàm riêng). Bảng không append-only
//   bằng trigger vì hai hàm dưới đây (xoá quá hạn, ngắt liên kết) phải sửa/xoá hàng.
// - `app.purge_product_events(p_now, p_months, p_limit)`: xoá sự kiện `occurred_at` quá `p_months` tháng LỊCH (13 tháng ở
//   `PRODUCT_EVENTS_RETENTION_MONTHS`). Cùng khuôn 0056/0066: SECURITY DEFINER, chỉ `app_worker` gọi; mốc bị chặn trên bởi đồng hồ CSDL
//   (`least(p_now, now())`); tối thiểu 1 tháng; theo lô `p_limit` (1…5000, SKIP LOCKED); so sánh nghiêm ngặt "<" (đúng mốc còn giữ).
// - `app.unlink_product_events_actor(p_user_id)`: đặt `actor_user_id` = NULL cho mọi sự kiện của tài khoản (mọi tổ chức) — gọi khi xoá
//   tài khoản (T-2311). Chỉ `app_worker` gọi (hàm xuyên tổ chức: không cấp cho `app_runtime` để request thường không ngắt được
//   liên kết của người khác); trả số hàng đã đổi, chạy lại trả 0.
// - Index: khoá ngoại có index dẫn đầu bằng cột FK; `ix_product_events_name_time` cho truy vấn M-01/M-03/M-05; `ix_product_events_occurred`
//   cho dọn; `ix_product_events_actor` (một phần: còn liên kết) cho ngắt liên kết. Bảng mới, rỗng ⇒ CREATE INDEX không chặn ai.
// - Down: xoá hàm rồi bảng (dữ liệu analytics có thể dựng lại bằng đo mới; không có dữ liệu nghiệp vụ).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE product_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  property_id uuid,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  props jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(props) = 'object'),
  actor_user_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_product_events_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX ix_product_events_property_time ON product_events (organization_id, property_id, occurred_at);
CREATE INDEX ix_product_events_name_time ON product_events (organization_id, name, occurred_at);
CREATE INDEX ix_product_events_occurred ON product_events (occurred_at);
CREATE INDEX ix_product_events_actor ON product_events (actor_user_id) WHERE actor_user_id IS NOT NULL;

ALTER TABLE product_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_events FORCE ROW LEVEL SECURITY;
CREATE POLICY product_events_org ON product_events FOR ALL
  USING (organization_id = app.current_org()) WITH CHECK (organization_id = app.current_org());
REVOKE ALL ON product_events FROM PUBLIC;
GRANT INSERT ON product_events TO app_runtime;

CREATE FUNCTION app.purge_product_events(p_now timestamptz, p_months integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT e.id FROM product_events e
      WHERE e.occurred_at < least(p_now, now()) - make_interval(months => greatest(p_months, 1))
      ORDER BY e.occurred_at, e.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM product_events e USING due WHERE e.id = due.id RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

CREATE FUNCTION app.unlink_product_events_actor(p_user_id uuid) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH x AS (
      UPDATE product_events e SET actor_user_id = NULL
      WHERE p_user_id IS NOT NULL AND e.actor_user_id = p_user_id
      RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

REVOKE ALL ON FUNCTION app.purge_product_events(timestamptz, integer, integer), app.unlink_product_events_actor(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_product_events(timestamptz, integer, integer), app.unlink_product_events_actor(uuid) TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.unlink_product_events_actor(uuid);
DROP FUNCTION IF EXISTS app.purge_product_events(timestamptz, integer, integer);
DROP TABLE IF EXISTS product_events;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
