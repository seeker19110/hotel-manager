// PLAN đợt 7 T-610 (DB-MODEL-004, D-035) — index cho 52 khoá ngoại "nhóm A" (cột người thao tác: created_by, approved_by, assignee…).
// Trước đây nhóm A là ngoại lệ có lý do ở `schema-guards.baseline.json` (persons/memberships không bị xoá cứng, bảng ghi nhỏ). Nay bỏ
// ngoại lệ: mọi khoá ngoại của schema public đều có index hỗ trợ (rào `schema-guards.db.test.ts`: FK thiếu index = 0, không danh sách
// ngoại lệ) — xoá/ẩn danh một membership/person không phải quét tuần tự các bảng con, và tra ngược "việc của người này" dùng index.
// - Dạng index: `(organization_id, X)` như 0048/0051 (khoá ngoại ghép (organization_id, X) ⇒ index mở đầu bằng organization_id phủ FK);
//   cột X cho phép NULL ⇒ index một phần `WHERE X IS NOT NULL` (nhỏ hơn; vẫn phục vụ kiểm tra FK khi xoá cha và tra `X = $1`).
// - Không trùng index sẵn có: danh sách là đúng 52 FK còn thiếu index sau 0048/0051 (đối chiếu catalog khi viết); rào "không index
//   ixfk_* thừa" và "không hai index cùng tiền tố" ở `schema-guards.db.test.ts` kiểm bằng catalog.
// - Khoá bảng (RK-021): CREATE INDEX thường chặn ghi bảng đó trong lúc xây. Như 0048/0051: `lock_timeout` 5 s (cục bộ transaction, trả
//   lại giá trị cũ) — thà thất bại và rollback sạch còn hơn xếp hàng chặn ghi. Bảng pilot còn nhỏ; khi dữ liệu lớn: chạy ngoài giờ cao
//   điểm (runbook deploy-rollback), index tạo CONCURRENTLY ngoài migrator.
// - Down: DROP INDEX IF EXISTS đúng các index này (danh sách cố định trong tệp, không dò catalog).
// - Tên index `ixfk_<bảng>_<cột>`: dài nhất 49 ký tự, dưới giới hạn 63 của Postgres.
import { type Kysely, sql } from "kysely";

/** [bảng, cột người thao tác, cột cho phép NULL]. */
export const INDEXES: readonly (readonly [string, string, boolean])[] = [
  ["allocations", "created_by", true],
  ["approval_requests", "approved_by", true],
  ["approval_requests", "requested_by", false],
  ["audit_events", "actor_person_id", true],
  ["billing_periods", "issued_by", true],
  ["blocks", "approved_by", true],
  ["blocks", "requested_by", false],
  ["charges", "created_by", true],
  ["charges", "voided_by", true],
  ["exceptions", "resolved_by", true],
  ["files", "uploaded_by", true],
  ["guest_access_links", "created_by", false],
  ["guest_access_links", "revoked_by", true],
  ["handovers", "staff_confirmed_by", true],
  ["import_batches", "confirmed_by", true],
  ["import_batches", "uploaded_by", false],
  ["invitations", "invited_by", false],
  ["invoices", "created_by", true],
  ["journal_entries", "created_by", true],
  ["lease_settlements", "approved_by", true],
  ["lease_settlements", "prepared_by", false],
  ["lease_versions", "created_by", true],
  ["leases", "created_by", true],
  ["meter_events", "approved_by", false],
  ["meter_readings", "approved_by", true],
  ["meter_readings", "entered_by", true],
  ["notification_settings", "updated_by", false],
  ["payment_allocations", "allocated_by", true],
  ["payment_claims", "handled_by", true],
  ["payments", "confirmed_by", true],
  ["payments", "recorded_by", true],
  ["payments", "reversed_by", true],
  ["period_locks", "locked_by", false],
  ["period_locks", "released_by", true],
  ["rate_plans", "created_by", true],
  ["reconciliation_breaks", "assignee", false],
  ["reconciliation_breaks", "resolved_by", true],
  ["reservations", "created_by", false],
  ["residence_notices", "exported_by", true],
  ["residence_notices", "submitted_by", true],
  ["service_prices", "created_by", true],
  ["shift_discrepancies", "resolved_by", true],
  ["shift_discrepancies", "responsible_membership_id", false],
  ["shifts", "closed_by", true],
  ["shifts", "handed_to", true],
  ["stays", "checked_in_by", true],
  ["stays", "checked_out_by", true],
  ["tasks", "created_by", true],
  ["tasks", "done_by", true],
  ["tasks", "verified_by", true],
  ["work_orders", "done_by", true],
  ["work_orders", "verified_by", true],
];

const indexName = (table: string, column: string) => `ixfk_${table}_${column}`;

export function upSql(): string {
  return INDEXES.map(
    ([t, c, nullable]) =>
      `CREATE INDEX ${indexName(t, c)} ON ${t} (organization_id, ${c})${nullable ? ` WHERE ${c} IS NOT NULL` : ""};`,
  ).join("\n");
}

export function downSql(): string {
  return INDEXES.map(([t, c]) => `DROP INDEX IF EXISTS ${indexName(t, c)};`).join("\n");
}

async function withLockTimeout(db: Kysely<unknown>, body: string): Promise<void> {
  const prev =
    (await sql<{ v: string }>`select current_setting('lock_timeout') as v`.execute(db)).rows[0]?.v ?? "0";
  await sql`select set_config('lock_timeout', '5s', true)`.execute(db);
  await sql.raw(body).execute(db);
  await sql`select set_config('lock_timeout', ${prev}, true)`.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await withLockTimeout(db, upSql());
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withLockTimeout(db, downSql());
}
