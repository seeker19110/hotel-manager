// T-2309 (PM-METRIC-003/005/006; D-118) — sự kiện sản phẩm TỰ HOST (không SDK/bên thứ ba): bảng `product_events` + hạn 13 tháng + ngắt liên kết.
// - Một hàng = một sự kiện đã qua `track()` (packages/app/src/analytics): `event` thuộc danh mục đóng, `props` chỉ enum/số/bool (app kiểm,
//   CSDL chặn thêm: `props` là object, ≤ 2 KB, tên sự kiện đúng quy ước `doi_tuong.hanh_dong`). KHÔNG PII, KHÔNG chuỗi tự do.
// - `actor_key` = HMAC-SHA256(userId) bằng khoá dẫn xuất HKDF từ bí mật đã có trong cấu hình (nhãn "analytics-actor") — giả danh, 32 byte; NULL
//   cho sự kiện hệ thống. `organization_id` GIỮ (RLS INV-G1, xoá/xuất theo tổ chức). Không có cột người dùng/email/IP/UA.
// - RLS bật + FORCE như mọi bảng tổ chức; chỉ INSERT (app_runtime, app_worker) và SELECT (app_runtime, vẫn chịu RLS). Không UPDATE/DELETE trực tiếp:
//   sự kiện là chỉ-thêm; xoá đi qua hai hàm SECURITY DEFINER phạm vi hẹp, CHỈ app_worker gọi (mẫu 0056/0066):
//     · `app.purge_product_events(p_now, p_months, p_limit)`: xoá sự kiện cũ hơn `p_months` tháng (RET-19; số tháng do worker truyền từ
//       `retention/policy.ts`, hàm chỉ có sàn 1); mốc bị chặn trên bởi đồng hồ CSDL (`least(p_now, now())`); theo LÔ (1…5000, SKIP LOCKED);
//       so sánh nghiêm ngặt "<" (hàng đúng mốc còn giữ).
//     · `app.forget_analytics_actor(p_actor)`: xoá MỌI sự kiện của một actor_key ở mọi tổ chức (người dùng thuộc nhiều tổ chức; RLS theo tổ chức
//       không cho app xoá xuyên tổ chức) — dùng khi xoá tài khoản (T-2311). Khoá giả danh lệch (xoay bí mật) thì không khớp hàng cũ: hàng đó
//       tự hết hạn theo RET-19.
// - Index: (organization_id, occurred_at) cho đọc theo tổ chức/kỳ + khoá ngoại; (occurred_at) cho dọn theo hạn; (actor_key) một phần cho "quên".
// - Down: gỡ hàm và bảng (dữ liệu phân tích mất — đúng mục đích; không bảng nào tham chiếu).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE product_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  event text NOT NULL CHECK (event ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$' AND length(event) <= 64),
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  actor_key bytea CHECK (actor_key IS NULL OR octet_length(actor_key) = 32),
  props jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(props) = 'object' AND pg_column_size(props) <= 2048),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_product_events_org_time ON product_events (organization_id, occurred_at);
CREATE INDEX ix_product_events_occurred ON product_events (occurred_at);
CREATE INDEX ix_product_events_actor ON product_events (actor_key) WHERE actor_key IS NOT NULL;
ALTER TABLE product_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_events FORCE ROW LEVEL SECURITY;
CREATE POLICY product_events_org ON product_events FOR ALL
  USING (organization_id = app.current_org()) WITH CHECK (organization_id = app.current_org());
REVOKE ALL ON product_events FROM PUBLIC;
GRANT SELECT, INSERT ON product_events TO app_runtime;
GRANT INSERT ON product_events TO app_worker;

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

CREATE FUNCTION app.forget_analytics_actor(p_actor bytea) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH x AS (
      DELETE FROM product_events e WHERE p_actor IS NOT NULL AND octet_length(p_actor) = 32 AND e.actor_key = p_actor RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

REVOKE ALL ON FUNCTION app.purge_product_events(timestamptz, integer, integer), app.forget_analytics_actor(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_product_events(timestamptz, integer, integer), app.forget_analytics_actor(bytea) TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.forget_analytics_actor(bytea);
DROP FUNCTION IF EXISTS app.purge_product_events(timestamptz, integer, integer);
DROP TABLE IF EXISTS product_events;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
