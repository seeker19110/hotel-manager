// PLAN đợt 5 T-408 (DB-MODEL-004, DB-PERF-002/008): index cho khoá ngoại nền + tham số autovacuum riêng cho bảng ghi nhiều.
// - Index: 88 khoá ngoại chưa có index hỗ trợ (nền ratchet `packages/testkit/src/schema-guards.baseline.json`, nhóm B "FK composite
//   tra ngược cha → con" và các cột "việc của người này" nóng của nhóm A) — cột đầu luôn `organization_id` (RLS lọc theo tổ chức).
//   Nhóm còn lại giữ trong nền kèm lý do (cột người thao tác ít chọn lọc, tham chiếu một chiều tới file/phê duyệt/bút toán, khoá tổ chức
//   đơn). Tên `ixfk_<bảng>_<cột>` (không trùng index sẵn có). Bảng pilot còn nhỏ nên CREATE INDEX thường (khoá ghi ngắn); khi dữ liệu lớn
//   tạo bằng CONCURRENTLY ngoài migrator.
// - Autovacuum: bảng ghi/xoá nhiều (outbox, idempotency_keys, notification_deliveries, notifications, inbox) dọn sớm hơn mặc định
//   (20% → 2%) để hàng chết không kéo dài quét claim; bảng chỉ thêm (audit_events, journal_lines) kích hoạt theo số hàng chèn (PG13+)
//   để cập nhật visibility map/thống kê kịp cho index-only scan.
// - Down: xoá đúng các index đã thêm, trả tham số autovacuum về mặc định.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE INDEX ixfk_approval_requests_property_id ON approval_requests (organization_id, property_id);
CREATE INDEX ixfk_blocks_work_order_id ON blocks (organization_id, work_order_id);
CREATE INDEX ixfk_charges_property_id_billing_period_id ON charges (organization_id, property_id, billing_period_id);
CREATE INDEX ixfk_charges_property_id_lease_id ON charges (organization_id, property_id, lease_id);
CREATE INDEX ixfk_charges_property_id_lease_version_id ON charges (organization_id, property_id, lease_version_id);
CREATE INDEX ixfk_charges_property_id_service_id ON charges (organization_id, property_id, service_id);
CREATE INDEX ixfk_charges_property_id_stay_id ON charges (organization_id, property_id, stay_id);
CREATE INDEX ixfk_deposits_payer_person_id ON deposits (organization_id, payer_person_id);
CREATE INDEX ixfk_deposits_property_id_lease_id ON deposits (organization_id, property_id, lease_id);
CREATE INDEX ixfk_deposits_reservation_id ON deposits (organization_id, reservation_id);
CREATE INDEX ixfk_export_jobs_property_id ON export_jobs (organization_id, property_id);
CREATE INDEX ixfk_files_property_id ON files (organization_id, property_id);
CREATE INDEX ixfk_guest_access_links_property_id_reservation_id ON guest_access_links (organization_id, property_id, reservation_id);
CREATE INDEX ixfk_guest_access_links_property_id_stay_id ON guest_access_links (organization_id, property_id, stay_id);
CREATE INDEX ixfk_handovers_property_id_lease_id ON handovers (organization_id, property_id, lease_id);
CREATE INDEX ixfk_identity_documents_property_id ON identity_documents (organization_id, property_id);
CREATE INDEX ixfk_import_external_refs_property_id_batch_id ON import_external_refs (organization_id, property_id, batch_id);
CREATE INDEX ixfk_import_rows_property_id_batch_id ON import_rows (organization_id, property_id, batch_id);
CREATE INDEX ixfk_invitations_membership_id ON invitations (organization_id, membership_id);
CREATE INDEX ixfk_invitations_person_id ON invitations (organization_id, person_id);
CREATE INDEX ixfk_invoice_lines_property_id_invoice_id ON invoice_lines (organization_id, property_id, invoice_id);
CREATE INDEX ixfk_invoices_adjusts_invoice_id ON invoices (organization_id, adjusts_invoice_id);
CREATE INDEX ixfk_invoices_property_id_billing_period_id ON invoices (organization_id, property_id, billing_period_id);
CREATE INDEX ixfk_invoices_property_id_lease_id ON invoices (organization_id, property_id, lease_id);
CREATE INDEX ixfk_invoices_property_id_stay_id ON invoices (organization_id, property_id, stay_id);
CREATE INDEX ixfk_journal_lines_deposit_id ON journal_lines (organization_id, deposit_id);
CREATE INDEX ixfk_journal_lines_invoice_id ON journal_lines (organization_id, invoice_id);
CREATE INDEX ixfk_journal_lines_invoice_line_id ON journal_lines (organization_id, invoice_line_id);
CREATE INDEX ixfk_journal_lines_person_id ON journal_lines (organization_id, person_id);
CREATE INDEX ixfk_journal_lines_property_id_entry_id ON journal_lines (organization_id, property_id, entry_id);
CREATE INDEX ixfk_journal_lines_receiving_account_id ON journal_lines (organization_id, receiving_account_id);
CREATE INDEX ixfk_journal_lines_shift_id ON journal_lines (organization_id, shift_id);
CREATE INDEX ixfk_lease_occupants_person_id ON lease_occupants (organization_id, person_id);
CREATE INDEX ixfk_lease_occupants_property_id_lease_id ON lease_occupants (organization_id, property_id, lease_id);
CREATE INDEX ixfk_lease_settlements_property_id_fee_invoice_id ON lease_settlements (organization_id, property_id, fee_invoice_id);
CREATE INDEX ixfk_lease_settlements_property_id_lease_id ON lease_settlements (organization_id, property_id, lease_id);
CREATE INDEX ixfk_lease_versions_property_id_lease_id ON lease_versions (organization_id, property_id, lease_id);
CREATE INDEX ixfk_leases_property_id_unit_id ON leases (organization_id, property_id, unit_id);
CREATE INDEX ixfk_leases_representative_person_id ON leases (organization_id, representative_person_id);
CREATE INDEX ixfk_memberships_person_id ON memberships (organization_id, person_id);
CREATE INDEX ixfk_memberships_selected_property_id ON memberships (organization_id, selected_property_id);
CREATE INDEX ixfk_meter_events_property_id_meter_id ON meter_events (organization_id, property_id, meter_id);
CREATE INDEX ixfk_meter_events_property_id_new_meter_id ON meter_events (organization_id, property_id, new_meter_id);
CREATE INDEX ixfk_meter_readings_handover_id ON meter_readings (organization_id, handover_id);
CREATE INDEX ixfk_meter_readings_property_id_billing_period_id ON meter_readings (organization_id, property_id, billing_period_id);
CREATE INDEX ixfk_meter_readings_property_id_meter_id ON meter_readings (organization_id, property_id, meter_id);
CREATE INDEX ixfk_meters_property_id_unit_id ON meters (organization_id, property_id, unit_id);
CREATE INDEX ixfk_notification_deliveries_property_id ON notification_deliveries (organization_id, property_id);
CREATE INDEX ixfk_notifications_property_id ON notifications (organization_id, property_id);
CREATE INDEX ixfk_outbox_property_id ON outbox (organization_id, property_id);
CREATE INDEX ixfk_payment_allocations_property_id_deposit_id ON payment_allocations (organization_id, property_id, deposit_id);
CREATE INDEX ixfk_payment_allocations_property_id_invoice_id ON payment_allocations (organization_id, property_id, invoice_id);
CREATE INDEX ixfk_payment_allocations_property_id_payment_id ON payment_allocations (organization_id, property_id, payment_id);
CREATE INDEX ixfk_payment_claims_matched_payment_id ON payment_claims (organization_id, matched_payment_id);
CREATE INDEX ixfk_payment_claims_person_id ON payment_claims (organization_id, person_id);
CREATE INDEX ixfk_payment_claims_property_id_invoice_id ON payment_claims (organization_id, property_id, invoice_id);
CREATE INDEX ixfk_payments_bank_transaction_id ON payments (organization_id, bank_transaction_id);
CREATE INDEX ixfk_payments_property_id_deposit_id ON payments (organization_id, property_id, deposit_id);
CREATE INDEX ixfk_payments_property_id_shift_id ON payments (organization_id, property_id, shift_id);
CREATE INDEX ixfk_payments_receiving_account_id ON payments (organization_id, receiving_account_id);
CREATE INDEX ixfk_payments_reservation_id ON payments (organization_id, reservation_id);
CREATE INDEX ixfk_period_locks_property_id ON period_locks (organization_id, property_id);
CREATE INDEX ixfk_rate_plans_property_id_room_type_id ON rate_plans (organization_id, property_id, room_type_id);
CREATE INDEX ixfk_receiving_accounts_property_id ON receiving_accounts (organization_id, property_id);
CREATE INDEX ixfk_reconciliation_breaks_bank_transaction_id ON reconciliation_breaks (organization_id, bank_transaction_id);
CREATE INDEX ixfk_reconciliation_breaks_property_id_resolved_payment_id ON reconciliation_breaks (organization_id, property_id, resolved_payment_id);
CREATE INDEX ixfk_reservation_items_allocation_id ON reservation_items (organization_id, allocation_id);
CREATE INDEX ixfk_reservation_items_property_id_reservation_id ON reservation_items (organization_id, property_id, reservation_id);
CREATE INDEX ixfk_reservation_items_property_id_room_type_id ON reservation_items (organization_id, property_id, room_type_id);
CREATE INDEX ixfk_reservation_items_property_id_unit_id ON reservation_items (organization_id, property_id, unit_id);
CREATE INDEX ixfk_reservations_booker_person_id ON reservations (organization_id, booker_person_id);
CREATE INDEX ixfk_residence_notices_property_id_stay_id ON residence_notices (organization_id, property_id, stay_id);
CREATE INDEX ixfk_service_prices_property_id_service_id ON service_prices (organization_id, property_id, service_id);
CREATE INDEX ixfk_shift_discrepancies_property_id_shift_id ON shift_discrepancies (organization_id, property_id, shift_id);
CREATE INDEX ixfk_shifts_opened_by ON shifts (organization_id, opened_by);
CREATE INDEX ixfk_stays_debtor_person_id ON stays (organization_id, debtor_person_id);
CREATE INDEX ixfk_stays_primary_guest_person_id ON stays (organization_id, primary_guest_person_id);
CREATE INDEX ixfk_stays_property_id_reservation_item_id ON stays (organization_id, property_id, reservation_item_id);
CREATE INDEX ixfk_stays_property_id_unit_id ON stays (organization_id, property_id, unit_id);
CREATE INDEX ixfk_tasks_assignee_membership_id ON tasks (organization_id, assignee_membership_id);
CREATE INDEX ixfk_tasks_property_id_unit_id ON tasks (organization_id, property_id, unit_id);
CREATE INDEX ixfk_units_property_id_parent_unit_id ON units (organization_id, property_id, parent_unit_id);
CREATE INDEX ixfk_units_property_id_room_type_id ON units (organization_id, property_id, room_type_id);
CREATE INDEX ixfk_work_orders_assignee_membership_id ON work_orders (organization_id, assignee_membership_id);
CREATE INDEX ixfk_work_orders_block_id ON work_orders (organization_id, block_id);
CREATE INDEX ixfk_work_orders_property_id_unit_id ON work_orders (organization_id, property_id, unit_id);
CREATE INDEX ixfk_work_orders_reporter_membership_id ON work_orders (organization_id, reporter_membership_id);
CREATE INDEX ixfk_work_orders_reporter_person_id ON work_orders (organization_id, reporter_person_id);

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
DROP INDEX IF EXISTS ixfk_charges_property_id_billing_period_id;
DROP INDEX IF EXISTS ixfk_charges_property_id_lease_id;
DROP INDEX IF EXISTS ixfk_charges_property_id_lease_version_id;
DROP INDEX IF EXISTS ixfk_charges_property_id_service_id;
DROP INDEX IF EXISTS ixfk_charges_property_id_stay_id;
DROP INDEX IF EXISTS ixfk_deposits_payer_person_id;
DROP INDEX IF EXISTS ixfk_deposits_property_id_lease_id;
DROP INDEX IF EXISTS ixfk_deposits_reservation_id;
DROP INDEX IF EXISTS ixfk_export_jobs_property_id;
DROP INDEX IF EXISTS ixfk_files_property_id;
DROP INDEX IF EXISTS ixfk_guest_access_links_property_id_reservation_id;
DROP INDEX IF EXISTS ixfk_guest_access_links_property_id_stay_id;
DROP INDEX IF EXISTS ixfk_handovers_property_id_lease_id;
DROP INDEX IF EXISTS ixfk_identity_documents_property_id;
DROP INDEX IF EXISTS ixfk_import_external_refs_property_id_batch_id;
DROP INDEX IF EXISTS ixfk_import_rows_property_id_batch_id;
DROP INDEX IF EXISTS ixfk_invitations_membership_id;
DROP INDEX IF EXISTS ixfk_invitations_person_id;
DROP INDEX IF EXISTS ixfk_invoice_lines_property_id_invoice_id;
DROP INDEX IF EXISTS ixfk_invoices_adjusts_invoice_id;
DROP INDEX IF EXISTS ixfk_invoices_property_id_billing_period_id;
DROP INDEX IF EXISTS ixfk_invoices_property_id_lease_id;
DROP INDEX IF EXISTS ixfk_invoices_property_id_stay_id;
DROP INDEX IF EXISTS ixfk_journal_lines_deposit_id;
DROP INDEX IF EXISTS ixfk_journal_lines_invoice_id;
DROP INDEX IF EXISTS ixfk_journal_lines_invoice_line_id;
DROP INDEX IF EXISTS ixfk_journal_lines_person_id;
DROP INDEX IF EXISTS ixfk_journal_lines_property_id_entry_id;
DROP INDEX IF EXISTS ixfk_journal_lines_receiving_account_id;
DROP INDEX IF EXISTS ixfk_journal_lines_shift_id;
DROP INDEX IF EXISTS ixfk_lease_occupants_person_id;
DROP INDEX IF EXISTS ixfk_lease_occupants_property_id_lease_id;
DROP INDEX IF EXISTS ixfk_lease_settlements_property_id_fee_invoice_id;
DROP INDEX IF EXISTS ixfk_lease_settlements_property_id_lease_id;
DROP INDEX IF EXISTS ixfk_lease_versions_property_id_lease_id;
DROP INDEX IF EXISTS ixfk_leases_property_id_unit_id;
DROP INDEX IF EXISTS ixfk_leases_representative_person_id;
DROP INDEX IF EXISTS ixfk_memberships_person_id;
DROP INDEX IF EXISTS ixfk_memberships_selected_property_id;
DROP INDEX IF EXISTS ixfk_meter_events_property_id_meter_id;
DROP INDEX IF EXISTS ixfk_meter_events_property_id_new_meter_id;
DROP INDEX IF EXISTS ixfk_meter_readings_handover_id;
DROP INDEX IF EXISTS ixfk_meter_readings_property_id_billing_period_id;
DROP INDEX IF EXISTS ixfk_meter_readings_property_id_meter_id;
DROP INDEX IF EXISTS ixfk_meters_property_id_unit_id;
DROP INDEX IF EXISTS ixfk_notification_deliveries_property_id;
DROP INDEX IF EXISTS ixfk_notifications_property_id;
DROP INDEX IF EXISTS ixfk_outbox_property_id;
DROP INDEX IF EXISTS ixfk_payment_allocations_property_id_deposit_id;
DROP INDEX IF EXISTS ixfk_payment_allocations_property_id_invoice_id;
DROP INDEX IF EXISTS ixfk_payment_allocations_property_id_payment_id;
DROP INDEX IF EXISTS ixfk_payment_claims_matched_payment_id;
DROP INDEX IF EXISTS ixfk_payment_claims_person_id;
DROP INDEX IF EXISTS ixfk_payment_claims_property_id_invoice_id;
DROP INDEX IF EXISTS ixfk_payments_bank_transaction_id;
DROP INDEX IF EXISTS ixfk_payments_property_id_deposit_id;
DROP INDEX IF EXISTS ixfk_payments_property_id_shift_id;
DROP INDEX IF EXISTS ixfk_payments_receiving_account_id;
DROP INDEX IF EXISTS ixfk_payments_reservation_id;
DROP INDEX IF EXISTS ixfk_period_locks_property_id;
DROP INDEX IF EXISTS ixfk_rate_plans_property_id_room_type_id;
DROP INDEX IF EXISTS ixfk_receiving_accounts_property_id;
DROP INDEX IF EXISTS ixfk_reconciliation_breaks_bank_transaction_id;
DROP INDEX IF EXISTS ixfk_reconciliation_breaks_property_id_resolved_payment_id;
DROP INDEX IF EXISTS ixfk_reservation_items_allocation_id;
DROP INDEX IF EXISTS ixfk_reservation_items_property_id_reservation_id;
DROP INDEX IF EXISTS ixfk_reservation_items_property_id_room_type_id;
DROP INDEX IF EXISTS ixfk_reservation_items_property_id_unit_id;
DROP INDEX IF EXISTS ixfk_reservations_booker_person_id;
DROP INDEX IF EXISTS ixfk_residence_notices_property_id_stay_id;
DROP INDEX IF EXISTS ixfk_service_prices_property_id_service_id;
DROP INDEX IF EXISTS ixfk_shift_discrepancies_property_id_shift_id;
DROP INDEX IF EXISTS ixfk_shifts_opened_by;
DROP INDEX IF EXISTS ixfk_stays_debtor_person_id;
DROP INDEX IF EXISTS ixfk_stays_primary_guest_person_id;
DROP INDEX IF EXISTS ixfk_stays_property_id_reservation_item_id;
DROP INDEX IF EXISTS ixfk_stays_property_id_unit_id;
DROP INDEX IF EXISTS ixfk_tasks_assignee_membership_id;
DROP INDEX IF EXISTS ixfk_tasks_property_id_unit_id;
DROP INDEX IF EXISTS ixfk_units_property_id_parent_unit_id;
DROP INDEX IF EXISTS ixfk_units_property_id_room_type_id;
DROP INDEX IF EXISTS ixfk_work_orders_assignee_membership_id;
DROP INDEX IF EXISTS ixfk_work_orders_block_id;
DROP INDEX IF EXISTS ixfk_work_orders_property_id_unit_id;
DROP INDEX IF EXISTS ixfk_work_orders_reporter_membership_id;
DROP INDEX IF EXISTS ixfk_work_orders_reporter_person_id;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
