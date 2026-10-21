// AUD-DATA-003/004 (T-1603): RLS theo VAI TRÒ cho đường ghi hồ sơ người và tiền.
// Trước: `persons_insert`/`persons_update` chỉ kiểm organization_id; `payments_record`/`payments_write` cho người ghi nhận ở MỌI vai
// (chỉ cần phạm vi cơ sở); `discrepancies_insert` chỉ kiểm tổ chức + status ⇒ ở tầng CSDL housekeeping/maintenance/tenant/guest vẫn
// ghi được hồ sơ người, phiếu thu, chênh lệch ca (vai trò chỉ kiểm ở app — trái AGENTS §9).
// Cách sửa: chỉ THÊM policy RESTRICTIVE (AND với policy hiện có) cho `app_runtime`, theo mẫu 0064:
//   · không có actor (worker, đăng nhập, ngữ cảnh hệ thống)                    → không đổi;
//   · `persons` INSERT: owner/manager/front_desk; UPDATE: + accountant (D-090) (đường ghi thật: lease.createPerson/import = owner/manager;
//     check-in, đặt phòng, mời người thuê = owner/manager/front_desk; `lockPerson` SELECT … FOR UPDATE của phân bổ/hoàn ứng trước
//     = accountant — FOR UPDATE cần USING của policy UPDATE). Ngoại lệ bootstrap: `org.create`/`member.acceptInvitation` đặt
//     app.actor_id = membership SẼ tạo (chưa tồn tại) rồi chèn person trước membership ⇒ cho phép khi membership của actor
//     CHƯA tồn tại; membership tồn tại nhưng không active (đình chỉ/thu hồi) ⇒ chặn;
//   · `payments` INSERT/UPDATE: owner/manager/front_desk/accountant (ma trận `payment.record`); policy permissive hiện có vẫn
//     hẹp thêm (người ghi nhận, phạm vi cơ sở, `payments_checkout_allocate`);
//   · `shift_discrepancies` INSERT: owner/manager/front_desk/accountant (`shift.open_close`/`shift.handover`).
// `app_worker` không đổi (job nền không có actor người; policy riêng `payments_system_*`).
// Hàm vai trò bọc `(SELECT …)` ⇒ planner đánh giá một lần cho cả câu lệnh (initplan), không gọi từng dòng.
import { type Kysely, sql } from "kysely";

const NO_ACTOR = `(SELECT nullif(current_setting('app.actor_id', true), '')) IS NULL`;
const STAFF_WRITE = `coalesce((SELECT app.actor_role()) IN ('owner','manager','front_desk','accountant'), false)`;
const MONEY = `(${NO_ACTOR} OR ${STAFF_WRITE})`;
// D-090: INSERT `persons` chỉ owner/manager/front_desk (accountant không có đường tạo hồ sơ người); UPDATE (gồm SELECT … FOR
// UPDATE của `lockPerson`) thêm accountant. Cả hai giữ ngoại lệ bootstrap (membership của actor chưa tồn tại).
const personFn = (name: string, roles: string) => `CREATE FUNCTION app.${name}() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT nullif(current_setting('app.actor_id', true), '') IS NULL
           OR coalesce(app.actor_role() IN (${roles}), false)
           OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.id = nullif(current_setting('app.actor_id', true), '')::uuid)
  $$;
REVOKE ALL ON FUNCTION app.${name}() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.${name}() TO app_runtime;`;
const PERSON_INSERT = `(SELECT app.actor_may_insert_person())`;
const PERSON_UPDATE = `(SELECT app.actor_may_update_person())`;

const UP = `
${personFn("actor_may_insert_person", "'owner','manager','front_desk'")}
${personFn("actor_may_update_person", "'owner','manager','front_desk','accountant'")}

CREATE POLICY persons_role_insert ON persons AS RESTRICTIVE FOR INSERT TO app_runtime WITH CHECK (${PERSON_INSERT});
CREATE POLICY persons_role_update ON persons AS RESTRICTIVE FOR UPDATE TO app_runtime USING (${PERSON_UPDATE}) WITH CHECK (${PERSON_UPDATE});
CREATE POLICY payments_role_insert ON payments AS RESTRICTIVE FOR INSERT TO app_runtime WITH CHECK ${MONEY};
CREATE POLICY payments_role_update ON payments AS RESTRICTIVE FOR UPDATE TO app_runtime USING ${MONEY} WITH CHECK ${MONEY};
CREATE POLICY discrepancies_role_insert ON shift_discrepancies AS RESTRICTIVE FOR INSERT TO app_runtime WITH CHECK ${MONEY};
`;

const DOWN = `
DROP POLICY IF EXISTS discrepancies_role_insert ON shift_discrepancies;
DROP POLICY IF EXISTS payments_role_update ON payments;
DROP POLICY IF EXISTS payments_role_insert ON payments;
DROP POLICY IF EXISTS persons_role_update ON persons;
DROP POLICY IF EXISTS persons_role_insert ON persons;
DROP FUNCTION IF EXISTS app.actor_may_update_person();
DROP FUNCTION IF EXISTS app.actor_may_insert_person();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
