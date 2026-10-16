// PLAN đợt 3 T-209 — lễ tân trả phòng phân bổ ứng trước của chính booking vào folio (SPEC-reservation-stay S-017, S-026).
// RLS `payments_write` chỉ cho lễ tân sửa khoản mình ghi; ứng trước thường do quản lý/kế toán xác nhận. Policy hẹp: lễ tân
// chỉ UPDATE khoản ĐÃ xác nhận gắn booking và phải giữ `confirmed` (không xác nhận/đảo hộ). Trigger `payment_guard` đã khoá
// mọi trường cố định, CHECK + bộ đếm giữ INV-F2 — thay đổi còn lại thực tế chỉ là `allocated_total`.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE POLICY payments_checkout_allocate ON payments FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() = 'front_desk' AND app.actor_can_see_property(property_id)
         AND reservation_id IS NOT NULL AND status = 'confirmed' AND purpose = 'receivable')
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() = 'front_desk' AND app.actor_can_see_property(property_id)
              AND reservation_id IS NOT NULL AND status = 'confirmed' AND purpose = 'receivable');
`;

const DOWN = `DROP POLICY IF EXISTS payments_checkout_allocate ON payments;`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
