// Sửa theo review độc lập lát hợp đồng (T-109…T-111):
// - 🟠6: chỉ số của biên bản bàn giao đã xác nhận bất biến (chỉ số đầu kỳ dùng tính tiền — INV-G4).
// - 🟢8: cấu hình mốc nhắc sai kiểu của một cơ sở không làm hỏng job của mọi tổ chức.
// - 🟢9: lễ tân chỉ được chuyển hợp đồng sang `settling` (bàn giao trả), không sửa gì khác.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.handover_reading_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.handover_id IS NOT NULL AND EXISTS (SELECT 1 FROM handovers h WHERE h.organization_id = OLD.organization_id
       AND h.id = OLD.handover_id AND h.confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'chỉ số của biên bản bàn giao đã xác nhận — không sửa/xoá' USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_meter_readings_handover BEFORE UPDATE OR DELETE ON meter_readings FOR EACH ROW
  EXECUTE FUNCTION app.handover_reading_guard();

CREATE OR REPLACE FUNCTION app.leases_expiring(p_now timestamptz, p_days integer[])
  RETURNS TABLE (organization_id uuid, property_id uuid, lease_id uuid, version_no integer, effective_to date, days_left integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT l.organization_id, l.property_id, l.id, v.version_no, v.effective_to,
           (v.effective_to - (p_now AT TIME ZONE p.timezone)::date)::int
    FROM leases l
    JOIN properties p ON p.organization_id = l.organization_id AND p.id = l.property_id
    JOIN LATERAL (SELECT lv.version_no, lv.effective_to FROM lease_versions lv
                  WHERE lv.organization_id = l.organization_id AND lv.lease_id = l.id AND lv.signed_at IS NOT NULL
                  ORDER BY lv.version_no DESC LIMIT 1) v ON true
    WHERE l.status IN ('active','notice_given') AND v.effective_to IS NOT NULL
      AND (v.effective_to - (p_now AT TIME ZONE p.timezone)::date) = ANY (
        CASE WHEN jsonb_typeof(p.settings -> 'lease_reminder_days') = 'array'
             THEN ARRAY(SELECT x::int FROM jsonb_array_elements_text(p.settings -> 'lease_reminder_days') x
                        WHERE x ~ '^[0-9]{1,4}$')
             ELSE p_days END)
  $$;

CREATE FUNCTION app.lease_front_desk_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.actor_role() = 'front_desk' AND (
       NEW.status <> 'settling' OR OLD.status NOT IN ('active','notice_given')
       OR (to_jsonb(NEW) - ARRAY['status','moved_out_on','updated_at','version'])
          <> (to_jsonb(OLD) - ARRAY['status','moved_out_on','updated_at','version'])) THEN
    RAISE EXCEPTION 'lễ tân chỉ ghi nhận trả phòng (chuyển sang thanh lý)' USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_leases_front_desk BEFORE UPDATE ON leases FOR EACH ROW EXECUTE FUNCTION app.lease_front_desk_guard();
`;

const DOWN = `
DROP TRIGGER IF EXISTS trg_leases_front_desk ON leases;
DROP FUNCTION IF EXISTS app.lease_front_desk_guard();
DROP TRIGGER IF EXISTS trg_meter_readings_handover ON meter_readings;
DROP FUNCTION IF EXISTS app.handover_reading_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
