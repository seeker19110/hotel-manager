// Review lát buồng phòng/sự cố (T-211/T-212).
// R3: việc dọn cũ `done` không đạt khi phòng đã có việc dọn mới (S-002) → đóng việc cũ (`done → cancelled`), chỉ được khi
// thật sự có việc dọn khác đang mở trên phòng (CSDL kiểm, không tin app).
// R5: người thuê chung (co_tenant) đang ở không báo được sự cố vì RLS `leases_tenant_read` chỉ
// cho người đại diện thấy hợp đồng. Hàm SECURITY DEFINER hẹp trả đúng một boolean: actor (người thuê) có đang thuê phòng này
// không — hợp đồng active/notice_given, là người đại diện hoặc người ở primary/co_tenant chưa rời (to_on trống hoặc ≥ hôm nay
// theo giờ cơ sở). Không lộ hợp đồng/người ở khác.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.tenant_rents_unit(p_unit uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT app.actor_role() = 'tenant' AND app.actor_person_id() IS NOT NULL AND EXISTS (
      SELECT 1 FROM leases l JOIN properties p ON p.organization_id = l.organization_id AND p.id = l.property_id
      WHERE l.organization_id = app.current_org() AND l.unit_id = p_unit AND l.status IN ('active','notice_given')
        AND (l.representative_person_id = app.actor_person_id()
             OR EXISTS (SELECT 1 FROM lease_occupants o
                        WHERE o.organization_id = l.organization_id AND o.lease_id = l.id AND o.person_id = app.actor_person_id()
                          AND o.role IN ('primary','co_tenant')
                          AND (o.to_on IS NULL OR o.to_on >= (now() AT TIME ZONE p.timezone)::date))))
  $$;
REVOKE ALL ON FUNCTION app.tenant_rents_unit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_rents_unit(uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION app.task_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('verified','cancelled') THEN
    RAISE EXCEPTION 'việc % đã kết thúc', OLD.id USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('assigned','cancelled'))
    OR (OLD.status = 'assigned' AND NEW.status IN ('in_progress','cancelled','assigned'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('done','cancelled'))
    OR (OLD.status = 'done' AND NEW.status IN ('verified','assigned'))
    OR (OLD.status = 'done' AND NEW.status = 'cancelled' AND OLD.kind = 'cleaning' AND EXISTS (
          SELECT 1 FROM tasks t WHERE t.organization_id = OLD.organization_id AND t.unit_id = OLD.unit_id AND t.kind = 'cleaning'
            AND t.id <> OLD.id AND t.status IN ('open','assigned','in_progress')))) THEN
    RAISE EXCEPTION 'việc %: không chuyển % → %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  IF NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'việc %: không đổi phòng/loại việc', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.tenant_rents_unit(uuid);
CREATE OR REPLACE FUNCTION app.task_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('verified','cancelled') THEN
    RAISE EXCEPTION 'việc % đã kết thúc', OLD.id USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('assigned','cancelled'))
    OR (OLD.status = 'assigned' AND NEW.status IN ('in_progress','cancelled','assigned'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('done','cancelled'))
    OR (OLD.status = 'done' AND NEW.status IN ('verified','assigned'))) THEN
    RAISE EXCEPTION 'việc %: không chuyển % → %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  IF NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'việc %: không đổi phòng/loại việc', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
