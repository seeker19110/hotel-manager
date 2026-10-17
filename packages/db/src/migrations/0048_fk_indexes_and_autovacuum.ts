// PLAN đợt 5 T-408 (DB-MODEL-004, DB-PERF-002/008): index cho khoá ngoại nền + tham số autovacuum riêng cho bảng ghi nhiều.
// - Index: 58 index cho khoá ngoại chưa có index hỗ trợ (nền ratchet `packages/testkit/src/schema-guards.baseline.json`, nhóm B "FK composite
//   tra ngược cha → con" và các cột "việc của người này" nóng của nhóm A) — cột đầu luôn `organization_id` (RLS lọc theo tổ chức).
//   KHÔNG tạo index trùng/thừa: FK đã được index sẵn có phục vụ (index `(organization_id, X…)` hoặc một phần `WHERE X IS NOT NULL` trên
//   chính cột FK) thì bỏ qua — rào `schema-guards.db.test.ts` ("không index ixfk_* nào thừa") tự xác định bằng catalog; mỗi index thừa
//   tốn ghi/bộ nhớ/VACUUM mà không đổi kế hoạch truy vấn.
//   FK ghép `(organization_id, property_id, X)`: index chỉ là `(organization_id, X)` — `property_id` do cha `X` quyết định nên đủ cho kiểm
//   tra FK, còn truy vấn ứng dụng tra theo `X` (không kèm `property_id`) dùng được index; thứ tự `(organization_id, property_id, X)` bắt
//   Index Cond nhưng phải quét cả dải tổ chức vì Postgres 17 không có skip scan (bằng chứng: EXPLAIN folio ở `db-perf.db.test.ts`).
//   Nhóm còn lại giữ trong nền kèm lý do (cột người thao tác ít chọn lọc, tham chiếu một chiều tới file/phê duyệt/bút toán, khoá tổ chức
//   đơn). Tên `ixfk_<bảng>_<cột>` (không trùng index sẵn có). Bảng pilot còn nhỏ nên CREATE INDEX thường (khoá ghi ngắn); khi dữ liệu lớn
//   tạo bằng CONCURRENTLY ngoài migrator.
// - Khoá bảng (RK-021): CREATE INDEX thường chặn ghi bảng đích; migrator Kysely chạy cả lượt trong MỘT transaction nên `SET LOCAL lock_timeout`
//   có hiệu lực tới hết transaction — đặt 5 s để thà thất bại (rollback sạch, thử lại) còn hơn xếp hàng sau giao dịch dài rồi chặn ghi của
//   mọi người; hàm `up` trả giá trị cũ để migration sau không bị ảnh hưởng. Chạy ngoài giờ cao điểm (runbook deploy-rollback).
// - Autovacuum: bảng ghi/xoá nhiều (outbox, idempotency_keys, notification_deliveries, notifications, inbox) dọn sớm hơn mặc định
//   (20% → 2%) để hàng chết không kéo dài quét claim; bảng chỉ thêm (audit_events, journal_lines) kích hoạt theo số hàng chèn (PG13+)
//   để cập nhật visibility map/thống kê kịp cho index-only scan.
// - Down: xoá đúng các index đã thêm, trả tham số autovacuum về mặc định.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE INDEX ixfk_approval_requests_property_id ON approval_requests (organization_id, property_id);
CREATE INDEX ixfk_blocks_work_order_id ON blocks (organization_id, work_order_id);
CREATE INDEX ixfk_charges_lease_id ON charges (organization_id, lease_id);
CREATE INDEX ixfk_charges_lease_version_id ON charges (organization_id, lease_version_id);
CREATE INDEX ixfk_charges_service_id ON charges (organization_id, service_id);
CREATE INDEX ixfk_deposits_payer_person_id ON deposits (organization_id, payer_person_id);
CREATE INDEX ixfk_export_jobs_property_id ON export_jobs (organization_id, property_id);
CREATE INDEX ixfk_files_property_id ON files (organization_id, property_id);
CREATE INDEX ixfk_guest_access_links_reservation_id ON guest_access_links (organization_id, reservation_id);
CREATE INDEX ixfk_identity_documents_property_id ON identity_documents (organization_id, property_id);
CREATE INDEX ixfk_import_external_refs_batch_id ON import_external_refs (organization_id, batch_id);
CREATE INDEX ixfk_invitations_membership_id ON invitations (organization_id, membership_id);
CREATE INDEX ixfk_invitations_person_id ON invitations (organization_id, person_id);
CREATE INDEX ixfk_invoices_adjusts_invoice_id ON invoices (organization_id, adjusts_invoice_id);
CREATE INDEX ixfk_invoices_billing_period_id ON invoices (organization_id, billing_period_id);
CREATE INDEX ixfk_invoices_lease_id ON invoices (organization_id, lease_id);
CREATE INDEX ixfk_invoices_stay_id ON invoices (organization_id, stay_id);
CREATE INDEX ixfk_journal_lines_deposit_id ON journal_lines (organization_id, deposit_id);
CREATE INDEX ixfk_journal_lines_invoice_line_id ON journal_lines (organization_id, invoice_line_id);
CREATE INDEX ixfk_journal_lines_person_id ON journal_lines (organization_id, person_id);
CREATE INDEX ixfk_journal_lines_receiving_account_id ON journal_lines (organization_id, receiving_account_id);
CREATE INDEX ixfk_journal_lines_shift_id ON journal_lines (organization_id, shift_id);
CREATE INDEX ixfk_lease_occupants_person_id ON lease_occupants (organization_id, person_id);
CREATE INDEX ixfk_lease_occupants_lease_id ON lease_occupants (organization_id, lease_id);
CREATE INDEX ixfk_lease_settlements_fee_invoice_id ON lease_settlements (organization_id, fee_invoice_id);
CREATE INDEX ixfk_leases_representative_person_id ON leases (organization_id, representative_person_id);
CREATE INDEX ixfk_memberships_person_id ON memberships (organization_id, person_id);
CREATE INDEX ixfk_memberships_selected_property_id ON memberships (organization_id, selected_property_id);
CREATE INDEX ixfk_meter_events_new_meter_id ON meter_events (organization_id, new_meter_id);
CREATE INDEX ixfk_meter_readings_handover_id ON meter_readings (organization_id, handover_id);
CREATE INDEX ixfk_meter_readings_billing_period_id ON meter_readings (organization_id, billing_period_id);
CREATE INDEX ixfk_meters_unit_id ON meters (organization_id, unit_id);
CREATE INDEX ixfk_notification_deliveries_property_id ON notification_deliveries (organization_id, property_id);
CREATE INDEX ixfk_notifications_property_id ON notifications (organization_id, property_id);
CREATE INDEX ixfk_outbox_property_id ON outbox (organization_id, property_id);
CREATE INDEX ixfk_payment_claims_matched_payment_id ON payment_claims (organization_id, matched_payment_id);
CREATE INDEX ixfk_payment_claims_person_id ON payment_claims (organization_id, person_id);
CREATE INDEX ixfk_payment_claims_invoice_id ON payment_claims (organization_id, invoice_id);
CREATE INDEX ixfk_payments_deposit_id ON payments (organization_id, deposit_id);
CREATE INDEX ixfk_payments_receiving_account_id ON payments (organization_id, receiving_account_id);
CREATE INDEX ixfk_period_locks_property_id ON period_locks (organization_id, property_id);
CREATE INDEX ixfk_receiving_accounts_property_id ON receiving_accounts (organization_id, property_id);
CREATE INDEX ixfk_reconciliation_breaks_bank_transaction_id ON reconciliation_breaks (organization_id, bank_transaction_id);
CREATE INDEX ixfk_reconciliation_breaks_resolved_payment_id ON reconciliation_breaks (organization_id, resolved_payment_id);
CREATE INDEX ixfk_reservation_items_allocation_id ON reservation_items (organization_id, allocation_id);
CREATE INDEX ixfk_reservation_items_room_type_id ON reservation_items (organization_id, room_type_id);
CREATE INDEX ixfk_reservations_booker_person_id ON reservations (organization_id, booker_person_id);
CREATE INDEX ixfk_shifts_opened_by ON shifts (organization_id, opened_by);
CREATE INDEX ixfk_stays_debtor_person_id ON stays (organization_id, debtor_person_id);
CREATE INDEX ixfk_stays_primary_guest_person_id ON stays (organization_id, primary_guest_person_id);
CREATE INDEX ixfk_tasks_assignee_membership_id ON tasks (organization_id, assignee_membership_id);
CREATE INDEX ixfk_tasks_unit_id ON tasks (organization_id, unit_id);
CREATE INDEX ixfk_units_parent_unit_id ON units (organization_id, parent_unit_id);
CREATE INDEX ixfk_units_room_type_id ON units (organization_id, room_type_id);
CREATE INDEX ixfk_work_orders_assignee_membership_id ON work_orders (organization_id, assignee_membership_id);
CREATE INDEX ixfk_work_orders_block_id ON work_orders (organization_id, block_id);
CREATE INDEX ixfk_work_orders_unit_id ON work_orders (organization_id, unit_id);
CREATE INDEX ixfk_work_orders_reporter_membership_id ON work_orders (organization_id, reporter_membership_id);

ALTER TABLE outbox SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 200, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE idempotency_keys SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 200, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE notification_deliveries SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 200, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE notifications SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 200, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE inbox SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 200, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE audit_events SET (autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_vacuum_insert_threshold = 5000, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE journal_lines SET (autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_vacuum_insert_threshold = 5000, autovacuum_analyze_scale_factor = 0.02);
`;

const DOWN = `
ALTER TABLE outbox RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, autovacuum_analyze_scale_factor);
ALTER TABLE idempotency_keys RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, autovacuum_analyze_scale_factor);
ALTER TABLE notification_deliveries RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, autovacuum_analyze_scale_factor);
ALTER TABLE notifications RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, autovacuum_analyze_scale_factor);
ALTER TABLE inbox RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, autovacuum_analyze_scale_factor);
ALTER TABLE audit_events RESET (autovacuum_vacuum_insert_scale_factor, autovacuum_vacuum_insert_threshold, autovacuum_analyze_scale_factor);
ALTER TABLE journal_lines RESET (autovacuum_vacuum_insert_scale_factor, autovacuum_vacuum_insert_threshold, autovacuum_analyze_scale_factor);

DROP INDEX IF EXISTS ixfk_approval_requests_property_id;
DROP INDEX IF EXISTS ixfk_blocks_work_order_id;
DROP INDEX IF EXISTS ixfk_charges_lease_id;
DROP INDEX IF EXISTS ixfk_charges_lease_version_id;
DROP INDEX IF EXISTS ixfk_charges_service_id;
DROP INDEX IF EXISTS ixfk_deposits_payer_person_id;
DROP INDEX IF EXISTS ixfk_export_jobs_property_id;
DROP INDEX IF EXISTS ixfk_files_property_id;
DROP INDEX IF EXISTS ixfk_guest_access_links_reservation_id;
DROP INDEX IF EXISTS ixfk_identity_documents_property_id;
DROP INDEX IF EXISTS ixfk_import_external_refs_batch_id;
DROP INDEX IF EXISTS ixfk_invitations_membership_id;
DROP INDEX IF EXISTS ixfk_invitations_person_id;
DROP INDEX IF EXISTS ixfk_invoices_adjusts_invoice_id;
DROP INDEX IF EXISTS ixfk_invoices_billing_period_id;
DROP INDEX IF EXISTS ixfk_invoices_lease_id;
DROP INDEX IF EXISTS ixfk_invoices_stay_id;
DROP INDEX IF EXISTS ixfk_journal_lines_deposit_id;
DROP INDEX IF EXISTS ixfk_journal_lines_invoice_line_id;
DROP INDEX IF EXISTS ixfk_journal_lines_person_id;
DROP INDEX IF EXISTS ixfk_journal_lines_receiving_account_id;
DROP INDEX IF EXISTS ixfk_journal_lines_shift_id;
DROP INDEX IF EXISTS ixfk_lease_occupants_person_id;
DROP INDEX IF EXISTS ixfk_lease_occupants_lease_id;
DROP INDEX IF EXISTS ixfk_lease_settlements_fee_invoice_id;
DROP INDEX IF EXISTS ixfk_leases_representative_person_id;
DROP INDEX IF EXISTS ixfk_memberships_person_id;
DROP INDEX IF EXISTS ixfk_memberships_selected_property_id;
DROP INDEX IF EXISTS ixfk_meter_events_new_meter_id;
DROP INDEX IF EXISTS ixfk_meter_readings_handover_id;
DROP INDEX IF EXISTS ixfk_meter_readings_billing_period_id;
DROP INDEX IF EXISTS ixfk_meters_unit_id;
DROP INDEX IF EXISTS ixfk_notification_deliveries_property_id;
DROP INDEX IF EXISTS ixfk_notifications_property_id;
DROP INDEX IF EXISTS ixfk_outbox_property_id;
DROP INDEX IF EXISTS ixfk_payment_claims_matched_payment_id;
DROP INDEX IF EXISTS ixfk_payment_claims_person_id;
DROP INDEX IF EXISTS ixfk_payment_claims_invoice_id;
DROP INDEX IF EXISTS ixfk_payments_deposit_id;
DROP INDEX IF EXISTS ixfk_payments_receiving_account_id;
DROP INDEX IF EXISTS ixfk_period_locks_property_id;
DROP INDEX IF EXISTS ixfk_receiving_accounts_property_id;
DROP INDEX IF EXISTS ixfk_reconciliation_breaks_bank_transaction_id;
DROP INDEX IF EXISTS ixfk_reconciliation_breaks_resolved_payment_id;
DROP INDEX IF EXISTS ixfk_reservation_items_allocation_id;
DROP INDEX IF EXISTS ixfk_reservation_items_room_type_id;
DROP INDEX IF EXISTS ixfk_reservations_booker_person_id;
DROP INDEX IF EXISTS ixfk_shifts_opened_by;
DROP INDEX IF EXISTS ixfk_stays_debtor_person_id;
DROP INDEX IF EXISTS ixfk_stays_primary_guest_person_id;
DROP INDEX IF EXISTS ixfk_tasks_assignee_membership_id;
DROP INDEX IF EXISTS ixfk_tasks_unit_id;
DROP INDEX IF EXISTS ixfk_units_parent_unit_id;
DROP INDEX IF EXISTS ixfk_units_room_type_id;
DROP INDEX IF EXISTS ixfk_work_orders_assignee_membership_id;
DROP INDEX IF EXISTS ixfk_work_orders_block_id;
DROP INDEX IF EXISTS ixfk_work_orders_unit_id;
DROP INDEX IF EXISTS ixfk_work_orders_reporter_membership_id;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  const prev =
    (await sql<{ v: string }>`select current_setting('lock_timeout') as v`.execute(db)).rows[0]?.v ?? "0";
  await sql`select set_config('lock_timeout', '5s', true)`.execute(db);
  await sql.raw(UP).execute(db);
  await sql`select set_config('lock_timeout', ${prev}, true)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
