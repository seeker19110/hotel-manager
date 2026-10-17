// PLAN đợt 3 T-216 — chặn người thuê/khách đọc dữ liệu nội bộ khi họ đăng nhập được portal (SPEC-portal §4 "Kiểm ở
// packages/app VÀ RLS"; INV-G1). Rà `pg_policies`: nhiều bảng chỉ lọc `organization_id = app.current_org()` (đúng cho nhân
// viên, nhưng người thuê cùng tổ chức sẽ đọc được sổ cái, giao dịch ngân hàng, audit, kết quả lệnh của người khác, lịch
// phòng, ảnh bàn giao/công tơ/sự cố của người khác…).
// Cách sửa: policy RESTRICTIVE (AND với mọi policy hiện có) chỉ áp khi vai trò là `tenant`/`guest`; ngữ cảnh hệ thống
// (không actor) và nhân viên không đổi. Ghi của chính người thuê (audit, outbox, idempotency) vẫn được.
import { type Kysely, sql } from "kysely";

const PORTAL = `app.actor_role() IN ('tenant','guest')`;
/** Bảng người thuê/khách KHÔNG được đọc dòng nào. */
const DENY_READ = [
  "allocations",
  "blocks",
  "exceptions",
  "bank_transactions",
  "inbox",
  "invitations",
  "journal_entries",
  "journal_lines",
  "property_scopes",
  "outbox",
  "audit_events",
  "period_locks",
];

const UP = `
-- Cơ sở mà người thuê (đang actor) có hợp đồng — dùng cho các policy portal.
CREATE FUNCTION app.tenant_property_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT DISTINCT l.property_id FROM leases l
    WHERE l.organization_id = app.current_org() AND app.actor_role() = 'tenant'
      AND l.representative_person_id = app.actor_person_id()
      AND l.status IN ('signed_awaiting_handover','active','notice_given','settling','closed')
  $$;
REVOKE ALL ON FUNCTION app.tenant_property_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_property_ids() TO app_runtime;

${DENY_READ.map(
  (t) => `CREATE POLICY portal_deny_read ON ${t} AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (NOT coalesce(${PORTAL}, false));`,
).join("\n")}

-- Kết quả lệnh: người thuê chỉ thấy/cập nhật bản ghi idempotency của chính mình.
CREATE POLICY portal_own_idempotency ON idempotency_keys AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT coalesce(${PORTAL}, false) OR actor_person_id = app.actor_person_id())
  WITH CHECK (NOT coalesce(${PORTAL}, false) OR actor_person_id = app.actor_person_id());
-- Membership: chỉ của chính mình (không lộ danh sách nhân viên).
CREATE POLICY portal_own_membership ON memberships AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (NOT coalesce(${PORTAL}, false) OR person_id = app.actor_person_id());
-- Tài khoản nhận: chỉ của cơ sở có hợp đồng của người thuê (để hiện QR chuyển khoản).
CREATE POLICY portal_receiving_accounts ON receiving_accounts AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (NOT coalesce(${PORTAL}, false) OR (active AND property_id IN (SELECT app.tenant_property_ids())));

-- File: người thuê chỉ thấy file mình tải lên (ảnh sự cố/báo chuyển) và ảnh công tơ của chỉ số họ được xem;
-- không thấy ảnh bàn giao/công tơ/sự cố/việc dọn của người khác. Chỉ được tải lên loại của portal.
CREATE POLICY portal_files ON files AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT coalesce(${PORTAL}, false)
         OR (owner_type IN ('work_order','payment_claim') AND uploaded_by = nullif(current_setting('app.actor_id', true), '')::uuid)
         OR (owner_type = 'work_order' AND owner_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM work_orders w WHERE w.organization_id = files.organization_id AND w.id = files.owner_id))
         OR (owner_type = 'meter_reading' AND EXISTS (
               SELECT 1 FROM meter_readings r WHERE r.organization_id = files.organization_id AND r.photo_file_id = files.id)))
  WITH CHECK (NOT coalesce(${PORTAL}, false)
         OR (owner_type IN ('work_order','payment_claim') AND uploaded_by = nullif(current_setting('app.actor_id', true), '')::uuid));
`;

const DOWN = `
DROP POLICY IF EXISTS portal_files ON files;
DROP POLICY IF EXISTS portal_receiving_accounts ON receiving_accounts;
DROP POLICY IF EXISTS portal_own_membership ON memberships;
DROP POLICY IF EXISTS portal_own_idempotency ON idempotency_keys;
${DENY_READ.map((t) => `DROP POLICY IF EXISTS portal_deny_read ON ${t};`).join("\n")}
DROP FUNCTION IF EXISTS app.tenant_property_ids();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
