// PLAN đợt 6 T-503 — sửa RLS đọc bảng `files` cho owner_type `lease_settlement`.
// Lỗi: policy `tenant_isolation` (0043) không có nhánh cho `lease_settlement` ⇒ rơi vào `ELSE false`, nên ảnh chứng cứ phí thanh lý
//   (`lease/settlement.ts` kiểm file `owner_type in ('lease_settlement','handover')` khi lập quyết toán) không vai trò nào đọc được.
// Sửa: thêm nhánh theo ĐÚNG quyền đọc quyết toán của `lease_settlements_read` (0017, phía nhân viên): owner/manager/accountant trong
//   phạm vi cơ sở của file. Không mở rộng cho front_desk/housekeeping/maintenance (không đọc được quyết toán). Người thuê (cổng portal)
//   vẫn KHÔNG đọc: policy RESTRICTIVE `portal_files` (0039) chỉ cho owner_type work_order/payment_claim/meter_reading của họ — ảnh phí
//   phạt do nhân viên chụp không lộ ra portal (cần quyết định riêng nếu muốn cho người thuê xem bằng chứng phí).
// Chỉ đổi USING (đọc/sửa/xoá hàng sẵn có); WITH CHECK giữ nguyên `organization_id = app.current_org()` — quyền tải lên theo loại do ứng
//   dụng kiểm. Down khôi phục đúng policy của 0043.
import { type Kysely, sql } from "kysely";

const FILES_POLICY = (settlementBranch: boolean) => `
CREATE POLICY tenant_isolation ON files
  USING (organization_id = app.current_org() AND CASE
           WHEN owner_type = 'identity_document'
             THEN app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)
           WHEN owner_type IN ('work_order','handover','meter_reading','task') THEN true
           WHEN owner_type = 'import_batch'
             THEN app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id)
           WHEN owner_type = 'residence_notice'
             THEN app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)
           WHEN owner_type = 'payment_claim'
             THEN (app.actor_role() IN ('owner','manager','accountant','front_desk') AND app.actor_can_see_property(property_id))
                  OR (app.actor_role() = 'tenant' AND uploaded_by = nullif(current_setting('app.actor_id', true), '')::uuid)
           WHEN owner_type = 'export_job'
             THEN uploaded_by = nullif(current_setting('app.actor_id', true), '')::uuid
           ${
             settlementBranch
               ? `WHEN owner_type = 'lease_settlement'
             THEN app.actor_role() IN ('owner','manager','accountant') AND app.actor_can_see_property(property_id)`
               : ""
           }
           ELSE false
         END)
  WITH CHECK (organization_id = app.current_org());`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DROP POLICY tenant_isolation ON files;\n${FILES_POLICY(true)}`).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DROP POLICY tenant_isolation ON files;\n${FILES_POLICY(false)}`).execute(db);
}
