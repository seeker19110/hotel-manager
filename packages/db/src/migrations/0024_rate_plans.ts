// PLAN đợt 3 T-203 — bảng giá phòng khách sạn (ERD §3.4 `rate_plans`; SPEC-reservation-stay S-001, S-002, S-021; INV-G3).
// - Một bản giá = giá đêm thường/cuối tuần của MỘT loại phòng trong khoảng hiệu lực `[effective_from, effective_to]` (gồm hai đầu,
//   NULL = không thời hạn). EXCLUDE chặn hai bản chồng hiệu lực; chỉ một bản mở cuối mỗi loại phòng.
// - `weekend_nights` (D-006): các thứ tính là đêm cuối tuần, 0 = Chủ nhật … 6 = thứ Bảy (khớp `weekdayOf` của engine báo giá).
// - Lịch sử bất biến: bản đã lập chỉ được ĐÓNG (đặt `effective_to`), không sửa giá/hiệu lực; đổi giá = bản mới (`rate.set`).
// - RLS: đọc theo phạm vi cơ sở (owner/manager/front_desk); ghi chỉ owner (SPEC-access 5.3 `pricing.manage`).
import { type Kysely, sql } from "kysely";

const UP = `
-- Tập đêm cuối tuần hợp lệ: mảng 1 chiều, 1..7 phần tử, không NULL, mỗi phần tử 0..6, không trùng. CHECK không dùng được
-- truy vấn con nên đặt trong hàm IMMUTABLE.
CREATE FUNCTION app.valid_weekend_nights(w smallint[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
    SELECT w IS NOT NULL AND array_ndims(w) = 1 AND cardinality(w) BETWEEN 1 AND 7
       AND NOT EXISTS (SELECT 1 FROM unnest(w) AS x WHERE x IS NULL OR x NOT BETWEEN 0 AND 6)
       AND cardinality(w) = (SELECT count(DISTINCT x) FROM unnest(w) AS x)
  $$;

CREATE TABLE rate_plans (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  room_type_id uuid NOT NULL,
  -- Số nguyên đồng, trần 2^53-1 để đọc ra số JS không mất chính xác.
  weekday_price bigint NOT NULL CHECK (weekday_price > 0 AND weekday_price <= 9007199254740991),
  weekend_price bigint NOT NULL CHECK (weekend_price > 0 AND weekend_price <= 9007199254740991),
  weekend_nights smallint[] NOT NULL DEFAULT '{5,6}' CONSTRAINT ck_rate_plans_weekend_nights CHECK (app.valid_weekend_nights(weekend_nights)),
  currency char(3) NOT NULL DEFAULT 'VND' CHECK (currency = upper(currency)),
  effective_from date NOT NULL,
  effective_to date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_rate_plans_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_rate_plans_room_type FOREIGN KEY (organization_id, property_id, room_type_id)
    REFERENCES room_types (organization_id, property_id, id),
  CONSTRAINT fk_rate_plans_created_by FOREIGN KEY (organization_id, created_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_rate_plans_range CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ex_rate_plans_no_overlap EXCLUDE USING gist (organization_id WITH =, room_type_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&)
);
CREATE UNIQUE INDEX uq_rate_plans_open ON rate_plans (organization_id, room_type_id) WHERE effective_to IS NULL;
CREATE TRIGGER trg_rate_plans_updated BEFORE UPDATE ON rate_plans FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Lịch sử giá bất biến: chỉ cho ĐÓNG bản đang mở (effective_to: NULL → ngày); mọi cột khác giữ nguyên.
CREATE FUNCTION app.rate_plan_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.organization_id, NEW.property_id, NEW.room_type_id, NEW.weekday_price, NEW.weekend_price, NEW.weekend_nights,
      NEW.currency, NEW.effective_from, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.property_id, OLD.room_type_id, OLD.weekday_price, OLD.weekend_price, OLD.weekend_nights,
      OLD.currency, OLD.effective_from, OLD.created_by, OLD.created_at)
     OR (NEW.effective_to IS DISTINCT FROM OLD.effective_to AND OLD.effective_to IS NOT NULL) THEN
    RAISE EXCEPTION 'bản giá đã lập chỉ được đóng (effective_to), không sửa — đặt bản giá mới'
      USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_rate_plans_guard BEFORE UPDATE ON rate_plans FOR EACH ROW EXECUTE FUNCTION app.rate_plan_guard();

ALTER TABLE rate_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_plans_read ON rate_plans FOR SELECT
  USING (organization_id = app.current_org() AND (nullif(current_setting('app.actor_id', true), '') IS NULL
         OR (app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id))));
CREATE POLICY rate_plans_write ON rate_plans FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() = 'owner' AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() = 'owner' AND app.actor_can_see_property(property_id));
GRANT SELECT, INSERT, UPDATE ON rate_plans TO app_runtime;
GRANT SELECT ON rate_plans TO app_worker;
`;

const DOWN = `
DROP TABLE IF EXISTS rate_plans;
DROP FUNCTION IF EXISTS app.rate_plan_guard();
DROP FUNCTION IF EXISTS app.valid_weekend_nights(smallint[]);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
