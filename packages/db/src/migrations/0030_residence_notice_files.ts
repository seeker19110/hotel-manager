// PLAN đợt 3 T-210 — file thông báo lưu trú (file xuất theo mẫu + bằng chứng đã nộp): chỉ owner/manager/lễ tân trong phạm vi
// cơ sở (SPEC-reservation-stay S-028, S-029). `files` mặc định từ chối loại chưa khai báo (0007) — mở đúng loại này.
import { type Kysely, sql } from "kysely";

const POLICY = (extra: string) => `
DROP POLICY tenant_isolation ON files;
CREATE POLICY tenant_isolation ON files
  USING (organization_id = app.current_org() AND CASE
           WHEN owner_type = 'identity_document'
             THEN app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)
           WHEN owner_type IN ('work_order','handover','meter_reading','task') THEN true
           WHEN owner_type = 'import_batch'
             THEN app.actor_role() IN ('owner','manager') AND app.actor_can_see_property(property_id)
           ${extra}
           ELSE false
         END)
  WITH CHECK (organization_id = app.current_org());
`;

const UP = POLICY(`WHEN owner_type = 'residence_notice'
             THEN app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)`);
const DOWN = POLICY("");

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
