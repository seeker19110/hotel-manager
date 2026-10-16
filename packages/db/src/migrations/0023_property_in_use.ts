// PLAN đợt 3 T-201 — đổi múi giờ/giờ chốt ngày khi cơ sở đã có dữ liệu (SPEC-access S-023, INV-G2; ERD `properties`
// "Ràng buộc đặc biệt"): ngày kinh doanh của mọi chứng từ/allocation đã lưu tính theo hai cột này, đổi giữa chừng làm
// lệch ngày kinh doanh và đêm lưu trú. Trigger chạy dưới quyền chủ bảng để thấy mọi hàng (không phụ thuộc RLS người gọi).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.check_property_in_use() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.timezone IS DISTINCT FROM OLD.timezone OR NEW.business_day_cutoff IS DISTINCT FROM OLD.business_day_cutoff)
     AND (EXISTS (SELECT 1 FROM allocations a WHERE a.organization_id = OLD.organization_id AND a.property_id = OLD.id)
          OR EXISTS (SELECT 1 FROM journal_entries j WHERE j.organization_id = OLD.organization_id AND j.property_id = OLD.id)
          OR EXISTS (SELECT 1 FROM invoices i WHERE i.organization_id = OLD.organization_id AND i.property_id = OLD.id)
          OR EXISTS (SELECT 1 FROM payments p WHERE p.organization_id = OLD.organization_id AND p.property_id = OLD.id))
  THEN
    RAISE EXCEPTION 'cơ sở % đã có giao dịch, không đổi múi giờ/giờ chốt ngày', OLD.id
      USING ERRCODE = '55000', HINT = 'PROPERTY_IN_USE';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.check_property_in_use() FROM PUBLIC;

CREATE TRIGGER trg_properties_in_use BEFORE UPDATE OF timezone, business_day_cutoff ON properties
  FOR EACH ROW EXECUTE FUNCTION app.check_property_in_use();
`;

const DOWN = `
DROP TRIGGER IF EXISTS trg_properties_in_use ON properties;
DROP FUNCTION IF EXISTS app.check_property_in_use();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
