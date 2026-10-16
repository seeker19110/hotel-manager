// PLAN đợt 3 T-220 — đọc nhật ký audit theo quyền ở tầng CSDL (SPEC-audit-reporting S-004; INV-G6; D-017).
// `audit_events` trước đây đọc được bởi mọi vai trò trong tổ chức (chỉ `tenant_isolation`); thêm policy RESTRICTIVE cho
// `app_runtime` khi có actor:
// - owner: toàn tổ chức;
// - manager: sự kiện của cơ sở trong phạm vi; sự kiện cấp tổ chức (property_id null) chỉ khi chính họ thực hiện;
// - accountant: chỉ nhóm sự kiện tiền, trong phạm vi cơ sở (cấp tổ chức: nhóm tiền);
// - vai trò khác: không thấy dòng nào (app trả 403 trước khi truy vấn).
// Ngữ cảnh hệ thống (không actor — worker/test) giữ như cũ. Ghi (INSERT) không đổi: policy chỉ FOR SELECT, lệnh ghi audit
// không dùng RETURNING/ON CONFLICT.
import { type Kysely, sql } from "kysely";

/** Tiền tố `action` thuộc nhóm tiền (kế toán xem được). Đồng bộ với `AUDIT_MONEY_GROUPS` ở packages/app/src/audit. */
export const AUDIT_MONEY_GROUPS = [
  "payment",
  "payment_claim",
  "invoice",
  "deposit",
  "period",
  "billing",
  "ledger",
  "reconciliation",
  "shift",
  "folio",
] as const;

const UP = `
CREATE POLICY audit_read_by_role ON audit_events AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (
    nullif(current_setting('app.actor_id', true), '') IS NULL
    OR app.actor_role() = 'owner'
    OR (app.actor_role() = 'manager' AND CASE WHEN property_id IS NULL THEN actor_person_id = app.actor_person_id()
                                              ELSE app.actor_can_see_property(property_id) END)
    OR (app.actor_role() = 'accountant'
        AND split_part(action, '.', 1) = ANY (ARRAY[${AUDIT_MONEY_GROUPS.map((g) => `'${g}'`).join(",")}])
        AND (property_id IS NULL OR app.actor_can_see_property(property_id)))
  );
CREATE INDEX ix_audit_org_action_time ON audit_events (organization_id, action, occurred_at DESC, id DESC);
`;

const DOWN = `
DROP INDEX IF EXISTS ix_audit_org_action_time;
DROP POLICY IF EXISTS audit_read_by_role ON audit_events;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
