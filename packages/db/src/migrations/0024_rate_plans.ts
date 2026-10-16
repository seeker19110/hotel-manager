// PLAN đợt 3 T-204 — bảng giá khách sạn theo loại phòng (ERD `rate_plans`; SPEC-reservation-stay S-001, S-002, S-021).
// Giá theo đêm ngày thường/cuối tuần, có hiệu lực theo ngày kinh doanh; không chồng hiệu lực (EXCLUDE); `rate.set` đóng bản
// cũ rồi thêm bản mới để giữ lịch sử. Booking đã giữ dùng snapshot giá, không đọc lại bảng này (INV-G3).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE rate_plans (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  room_type_id uuid NOT NULL,
  weekday_price bigint NOT NULL CHECK (weekday_price > 0),
  weekend_price bigint NOT NULL CHECK (weekend_price > 0),
  currency char(3) NOT NULL DEFAULT 'VND' CHECK (currency = 'VND'),
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

ALTER TABLE rate_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_plans FORCE ROW LEVEL SECURITY;
-- Đọc: vai trò báo giá/đặt phòng và kế toán trong phạm vi cơ sở; ghi: chỉ owner (ma trận "Loại phòng, bảng giá").
CREATE POLICY rate_plans_read ON rate_plans FOR SELECT
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk','accountant')
         AND app.actor_can_see_property(property_id));
CREATE POLICY rate_plans_write ON rate_plans FOR ALL TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() = 'owner')
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() = 'owner');
GRANT SELECT, INSERT, UPDATE ON rate_plans TO app_runtime;
GRANT SELECT ON rate_plans TO app_worker;
`;

const DOWN = `DROP TABLE IF EXISTS rate_plans;`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
