// T-2404/D-134: uuid[] không có FK. Giữ KEY SHARE tới cuối transaction cho từng người ở kèm, như FK tới persons:
// worker 0066 dùng FOR UPDATE … SKIP LOCKED nên bỏ qua check-in chưa commit; sau commit snapshot mới thấy quan hệ mở.
// Thứ tự UUID cố định giảm deadlock giữa hai array. Invoker + điều kiện organization_id giữ RLS/quyền của người gọi.
// recordIdentityDocument khoá người TRƯỚC khi đọc giấy tờ, đóng cả khe worker thắng trước trigger của stays.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.lock_stay_additional_guests() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
  v_anonymized_at timestamptz;
BEGIN
  -- Closed stays add no open relation; allow checkout of guests anonymized under the retention policy.
  IF TG_OP = 'UPDATE' AND NEW.organization_id = OLD.organization_id
     AND NEW.additional_guest_person_ids IS NOT DISTINCT FROM OLD.additional_guest_person_ids
     AND NEW.status NOT IN ('expected', 'in_house') THEN
    RETURN NEW;
  END IF;
  FOR v_id IN SELECT DISTINCT x.id FROM unnest(NEW.additional_guest_person_ids) x(id) ORDER BY x.id LOOP
    SELECT p.anonymized_at INTO v_anonymized_at FROM persons p
      WHERE p.organization_id = NEW.organization_id AND p.id = v_id
      FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'additional guest must belong to the stay organization'
        USING ERRCODE = '23503', CONSTRAINT = 'fk_stays_additional_guests';
    END IF;
    IF NEW.status IN ('expected', 'in_house') AND v_anonymized_at IS NOT NULL THEN
      RAISE EXCEPTION 'additional guest has been anonymized'
        USING ERRCODE = '23514', CONSTRAINT = 'ck_stays_additional_guests_active';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.lock_stay_additional_guests() FROM PUBLIC;
CREATE TRIGGER trg_stays_additional_guests BEFORE INSERT OR UPDATE OF organization_id, additional_guest_person_ids, status
  ON stays FOR EACH ROW EXECUTE FUNCTION app.lock_stay_additional_guests();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  const previous =
    (await sql<{ v: string }>`select current_setting('lock_timeout') as v`.execute(db)).rows[0]?.v ?? "0";
  await sql`select set_config('lock_timeout', '5s', true)`.execute(db);
  await sql.raw(UP).execute(db);
  await sql`select set_config('lock_timeout', ${previous}, true)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger if exists trg_stays_additional_guests on stays`.execute(db);
  await sql`drop function if exists app.lock_stay_additional_guests()`.execute(db);
}
