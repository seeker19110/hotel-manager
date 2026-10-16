// PLAN đợt 3 T-205 — nhận phòng (SPEC-reservation-stay S-012…S-015; ERD `stays`, `charges`, `identity_documents`; INV-I1, INV-G1).
// Chỉ thêm chỉ mục duy nhất một phần (không đổi bảng/trigger đã có):
// - `uq_stays_unit_in_house`: một phòng chỉ có MỘT lượt ở `in_house` (hai lễ tân check-in cạnh tranh → một bên thua ở CSDL, kể cả khi
//   code quên kiểm; allocation `stay` của lượt quá hạn không còn chồng khoảng nên EXCLUDE đơn thuần không bắt được ca "còn khách cũ").
// - `uq_charges_stay_room_night`: mỗi đêm chỉ một khoản tiền phòng còn hiệu lực cho một lượt ở (SPEC §4: unique theo stay + business_date).
// - `uq_identity_documents_person_doc`: một người không có hai dòng cùng loại + số giấy tờ (ghi lại giấy tờ cũ thì tái dùng, không nhân bản PII).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE UNIQUE INDEX uq_stays_unit_in_house ON stays (organization_id, unit_id) WHERE status = 'in_house';
CREATE UNIQUE INDEX uq_charges_stay_room_night ON charges (organization_id, stay_id, business_date)
  WHERE kind = 'room' AND voided_at IS NULL AND stay_id IS NOT NULL;
CREATE UNIQUE INDEX uq_identity_documents_person_doc ON identity_documents (organization_id, person_id, doc_type, doc_number)
  WHERE doc_number IS NOT NULL;
`;

const DOWN = `
DROP INDEX IF EXISTS uq_identity_documents_person_doc;
DROP INDEX IF EXISTS uq_charges_stay_room_night;
DROP INDEX IF EXISTS uq_stays_unit_in_house;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
