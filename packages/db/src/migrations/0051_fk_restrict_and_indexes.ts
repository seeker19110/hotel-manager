// PLAN đợt 6 T-503 (DB-MODEL-004, D-035) — hành động ON DELETE tường minh cho mọi khoá ngoại + index cho khoá ngoại còn thiếu.
// - ON DELETE: 241 khoá ngoại ở schema public đang dùng mặc định NO ACTION (không ghi trong DDL, không trì hoãn) đổi sang
//   `ON DELETE RESTRICT`. Với khoá không DEFERRABLE, RESTRICT và NO ACTION chỉ khác khi khoá trì hoãn được ⇒ hành vi giữ nguyên
//   (xoá cha còn con vẫn bị chặn ngay, cùng mã lỗi 23503); khác biệt là hành động nay nằm tường minh trong catalog
//   (`pg_constraint.confdeltype = 'r'`) để rào máy kiểm.
//   KHÔNG đổi: khoá DEFERRABLE (`fk_blocks_work_order`, `fk_work_orders_block` — vòng tham chiếu block ↔ work_order dựa vào kiểm cuối
//   transaction; RESTRICT không trì hoãn được nên sẽ phá luồng) ⇒ giữ NO ACTION, ngoại lệ có lý do ở `schema-guards.db.test.ts`;
//   khoá CASCADE/RESTRICT sẵn có cũng giữ. Giữ nguyên tên ràng buộc (mã app/test dò theo tên). Danh sách cố định trong tệp (không
//   sinh từ catalog lúc chạy) để `down` chỉ hoàn nguyên đúng các khoá này dù migration sau có thêm khoá RESTRICT khác.
// - Index: 20 khoá ngoại "nhóm D" của nền ratchet (tham chiếu một chiều tới file/bút toán/hộp thư/phiếu đối soát…) nay có index
//   `(organization_id, X)`; cột X cho phép NULL ⇒ index một phần `WHERE X IS NOT NULL` (nhỏ, vẫn phục vụ kiểm tra FK khi xoá cha
//   và tra ngược `X = $1`). Nhóm A (cột người thao tác: created_by, approved_by…) KHÔNG thêm index — ngoại lệ có lý do ở nền
//   `schema-guards.baseline.json` (persons/memberships không bị xoá cứng, bảng con ghi nhỏ; thêm khi EXPLAIN cho thấy cần). Không
//   trùng index của 0048: rào `schema-guards.db.test.ts` ("không index ixfk_* nào thừa") kiểm bằng catalog.
// - Khoá bảng (RK-021): ALTER TABLE … DROP/ADD CONSTRAINT lấy khoá mạnh trên bảng con và quét kiểm lại; CREATE INDEX thường chặn
//   ghi. Như 0048: `lock_timeout` 5 s (cục bộ transaction, trả lại giá trị cũ) — thà thất bại và rollback sạch còn hơn xếp hàng chặn
//   ghi. Bảng pilot còn nhỏ; khi dữ liệu lớn: chạy ngoài giờ cao điểm (runbook deploy-rollback), index tạo CONCURRENTLY ngoài migrator.
// - `app.db_health_metrics()` (DB-PERF-004/008): số liệu sức khoẻ CSDL cho `/api/metrics` — kết nối đang mở (`pg_stat_database.numbackends`)
//   so với `max_connections`, tuổi XID/multixact của CSDL (`age(datfrozenxid)`, `mxid_age(datminmxid)`; wraparound ở 2^31) và hàng chết
//   theo bảng (`pg_stat_user_tables`). SECURITY DEFINER như `app.metrics_snapshot` (0046): runtime không cần quyền đọc catalog thống
//   kê; CHỈ số tổng hợp toàn hệ thống, nhãn duy nhất là tên bảng (không phải dữ liệu tổ chức/người).
// - Down: trả 241 khoá về NO ACTION (như trước), xoá đúng các index đã thêm, xoá hàm metric.
import { type Kysely, sql } from "kysely";

/** [bảng, tên ràng buộc, phần định nghĩa sau `FOREIGN KEY ` — từ `pg_get_constraintdef` lúc lập migration]. */
const FKS: readonly (readonly [table: string, name: string, def: string])[] = [
  [
    "allocations",
    "fk_allocations_created_by",
    "(organization_id, created_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "allocations",
    "fk_allocations_units",
    "(organization_id, property_id, unit_id) REFERENCES units(organization_id, property_id, id)",
  ],
  [
    "approval_requests",
    "approval_requests_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "approval_requests",
    "fk_approval_requests_approved_by",
    "(organization_id, approved_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "approval_requests",
    "fk_approval_requests_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "approval_requests",
    "fk_approval_requests_requested_by",
    "(organization_id, requested_by) REFERENCES memberships(organization_id, id)",
  ],
  ["audit_events", "audit_events_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "audit_events",
    "fk_audit_actor",
    "(organization_id, actor_person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "audit_events",
    "fk_audit_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "bank_transactions",
    "fk_bank_transactions_account",
    "(organization_id, receiving_account_id) REFERENCES receiving_accounts(organization_id, id)",
  ],
  [
    "bank_transactions",
    "fk_bank_transactions_inbox",
    "(organization_id, inbox_id) REFERENCES inbox(organization_id, id)",
  ],
  [
    "bank_transactions",
    "fk_bank_transactions_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "billing_periods",
    "billing_periods_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "billing_periods",
    "fk_billing_periods_issued_by",
    "(organization_id, issued_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "billing_periods",
    "fk_billing_periods_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "blocks",
    "fk_blocks_approved_by",
    "(organization_id, approved_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "blocks",
    "fk_blocks_requested_by",
    "(organization_id, requested_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "blocks",
    "fk_blocks_units",
    "(organization_id, property_id, unit_id) REFERENCES units(organization_id, property_id, id)",
  ],
  ["charges", "charges_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "charges",
    "fk_charges_created_by",
    "(organization_id, created_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "charges",
    "fk_charges_lease",
    "(organization_id, property_id, lease_id) REFERENCES leases(organization_id, property_id, id)",
  ],
  [
    "charges",
    "fk_charges_lease_version",
    "(organization_id, property_id, lease_version_id) REFERENCES lease_versions(organization_id, property_id, id)",
  ],
  [
    "charges",
    "fk_charges_period",
    "(organization_id, property_id, billing_period_id) REFERENCES billing_periods(organization_id, property_id, id)",
  ],
  [
    "charges",
    "fk_charges_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "charges",
    "fk_charges_service",
    "(organization_id, property_id, service_id) REFERENCES services(organization_id, property_id, id)",
  ],
  [
    "charges",
    "fk_charges_stay",
    "(organization_id, property_id, stay_id) REFERENCES stays(organization_id, property_id, id)",
  ],
  [
    "charges",
    "fk_charges_voided_by",
    "(organization_id, voided_by) REFERENCES memberships(organization_id, id)",
  ],
  ["deposits", "deposits_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "deposits",
    "fk_deposits_lease",
    "(organization_id, property_id, lease_id) REFERENCES leases(organization_id, property_id, id)",
  ],
  [
    "deposits",
    "fk_deposits_payer",
    "(organization_id, payer_person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "deposits",
    "fk_deposits_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "deposits",
    "fk_deposits_reservation",
    "(organization_id, reservation_id) REFERENCES reservations(organization_id, id)",
  ],
  [
    "exceptions",
    "fk_exceptions_allocation",
    "(organization_id, allocation_id) REFERENCES allocations(organization_id, id)",
  ],
  [
    "exceptions",
    "fk_exceptions_properties",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "exceptions",
    "fk_exceptions_related",
    "(organization_id, related_allocation_id) REFERENCES allocations(organization_id, id)",
  ],
  [
    "exceptions",
    "fk_exceptions_resolved_by",
    "(organization_id, resolved_by) REFERENCES memberships(organization_id, id)",
  ],
  ["export_jobs", "export_jobs_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "export_jobs",
    "fk_export_jobs_file",
    "(organization_id, file_key) REFERENCES files(organization_id, storage_key)",
  ],
  [
    "export_jobs",
    "fk_export_jobs_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "export_jobs",
    "fk_export_jobs_requested_by",
    "(organization_id, requested_by) REFERENCES memberships(organization_id, id)",
  ],
  ["files", "files_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  ["files", "fk_files_property", "(organization_id, property_id) REFERENCES properties(organization_id, id)"],
  [
    "files",
    "fk_files_uploaded_by",
    "(organization_id, uploaded_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "floors",
    "fk_floors_properties",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "guest_access_links",
    "fk_guest_links_created_by",
    "(organization_id, created_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "guest_access_links",
    "fk_guest_links_reservation",
    "(organization_id, property_id, reservation_id) REFERENCES reservations(organization_id, property_id, id)",
  ],
  [
    "guest_access_links",
    "fk_guest_links_revoked_by",
    "(organization_id, revoked_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "guest_access_links",
    "fk_guest_links_stay",
    "(organization_id, property_id, stay_id) REFERENCES stays(organization_id, property_id, id)",
  ],
  [
    "guest_access_links",
    "guest_access_links_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "handovers",
    "fk_handovers_lease",
    "(organization_id, property_id, lease_id) REFERENCES leases(organization_id, property_id, id)",
  ],
  [
    "handovers",
    "fk_handovers_staff",
    "(organization_id, staff_confirmed_by) REFERENCES memberships(organization_id, id)",
  ],
  ["handovers", "handovers_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "idempotency_keys",
    "fk_idempotency_actor",
    "(organization_id, actor_person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "idempotency_keys",
    "idempotency_keys_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "identity_documents",
    "fk_identity_documents_file",
    "(organization_id, file_id) REFERENCES files(organization_id, id)",
  ],
  [
    "identity_documents",
    "fk_identity_documents_person",
    "(organization_id, person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "identity_documents",
    "fk_identity_documents_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "identity_documents",
    "identity_documents_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "import_batches",
    "fk_import_batches_confirmed_by",
    "(organization_id, confirmed_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "import_batches",
    "fk_import_batches_file",
    "(organization_id, file_id) REFERENCES files(organization_id, id)",
  ],
  [
    "import_batches",
    "fk_import_batches_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "import_batches",
    "fk_import_batches_uploaded_by",
    "(organization_id, uploaded_by) REFERENCES memberships(organization_id, id)",
  ],
  ["import_batches", "import_batches_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "import_external_refs",
    "fk_import_external_refs_batch",
    "(organization_id, property_id, batch_id) REFERENCES import_batches(organization_id, property_id, id)",
  ],
  [
    "import_external_refs",
    "import_external_refs_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "import_rows",
    "fk_import_rows_batch",
    "(organization_id, property_id, batch_id) REFERENCES import_batches(organization_id, property_id, id)",
  ],
  ["import_rows", "import_rows_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "inbox",
    "fk_inbox_bank_transaction",
    "(organization_id, bank_transaction_id) REFERENCES bank_transactions(organization_id, id)",
  ],
  ["inbox", "inbox_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "invitations",
    "fk_invitations_invited_by",
    "(organization_id, invited_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "invitations",
    "fk_invitations_membership",
    "(organization_id, membership_id) REFERENCES memberships(organization_id, id)",
  ],
  [
    "invitations",
    "fk_invitations_person",
    "(organization_id, person_id) REFERENCES persons(organization_id, id)",
  ],
  ["invitations", "invitations_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "invoice_lines",
    "fk_invoice_lines_charge",
    "(organization_id, charge_id) REFERENCES charges(organization_id, id)",
  ],
  [
    "invoice_lines",
    "fk_invoice_lines_invoice",
    "(organization_id, property_id, invoice_id) REFERENCES invoices(organization_id, property_id, id)",
  ],
  ["invoice_lines", "invoice_lines_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "invoices",
    "fk_invoices_adjusts",
    "(organization_id, adjusts_invoice_id) REFERENCES invoices(organization_id, id)",
  ],
  [
    "invoices",
    "fk_invoices_billing_period",
    "(organization_id, property_id, billing_period_id) REFERENCES billing_periods(organization_id, property_id, id)",
  ],
  [
    "invoices",
    "fk_invoices_created_by",
    "(organization_id, created_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "invoices",
    "fk_invoices_lease",
    "(organization_id, property_id, lease_id) REFERENCES leases(organization_id, property_id, id)",
  ],
  [
    "invoices",
    "fk_invoices_payer",
    "(organization_id, payer_person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "invoices",
    "fk_invoices_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "invoices",
    "fk_invoices_stay",
    "(organization_id, property_id, stay_id) REFERENCES stays(organization_id, property_id, id)",
  ],
  ["invoices", "invoices_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "journal_entries",
    "fk_journal_entries_created_by",
    "(organization_id, created_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "journal_entries",
    "fk_journal_entries_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "journal_entries",
    "fk_journal_entries_reverses",
    "(organization_id, reverses_entry_id) REFERENCES journal_entries(organization_id, id)",
  ],
  [
    "journal_lines",
    "fk_journal_lines_deposit",
    "(organization_id, deposit_id) REFERENCES deposits(organization_id, id)",
  ],
  [
    "journal_lines",
    "fk_journal_lines_entry",
    "(organization_id, property_id, entry_id) REFERENCES journal_entries(organization_id, property_id, id)",
  ],
  [
    "journal_lines",
    "fk_journal_lines_invoice",
    "(organization_id, invoice_id) REFERENCES invoices(organization_id, id)",
  ],
  [
    "journal_lines",
    "fk_journal_lines_invoice_line",
    "(organization_id, invoice_line_id) REFERENCES invoice_lines(organization_id, id)",
  ],
  [
    "journal_lines",
    "fk_journal_lines_person",
    "(organization_id, person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "journal_lines",
    "fk_journal_lines_receiving_account",
    "(organization_id, receiving_account_id) REFERENCES receiving_accounts(organization_id, id)",
  ],
  [
    "journal_lines",
    "fk_journal_lines_shift",
    "(organization_id, shift_id) REFERENCES shifts(organization_id, id)",
  ],
  [
    "lease_occupants",
    "fk_lease_occupants_lease",
    "(organization_id, property_id, lease_id) REFERENCES leases(organization_id, property_id, id)",
  ],
  [
    "lease_occupants",
    "fk_lease_occupants_person",
    "(organization_id, person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "lease_occupants",
    "lease_occupants_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "lease_settlements",
    "fk_lease_settlements_approval",
    "(organization_id, approval_request_id) REFERENCES approval_requests(organization_id, id)",
  ],
  [
    "lease_settlements",
    "fk_lease_settlements_approved_by",
    "(organization_id, approved_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "lease_settlements",
    "fk_lease_settlements_fee_invoice",
    "(organization_id, property_id, fee_invoice_id) REFERENCES invoices(organization_id, property_id, id)",
  ],
  [
    "lease_settlements",
    "fk_lease_settlements_lease",
    "(organization_id, property_id, lease_id) REFERENCES leases(organization_id, property_id, id)",
  ],
  [
    "lease_settlements",
    "fk_lease_settlements_prepared_by",
    "(organization_id, prepared_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "lease_settlements",
    "lease_settlements_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "lease_versions",
    "fk_lease_versions_created_by",
    "(organization_id, created_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "lease_versions",
    "fk_lease_versions_lease",
    "(organization_id, property_id, lease_id) REFERENCES leases(organization_id, property_id, id)",
  ],
  ["lease_versions", "lease_versions_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "leases",
    "fk_leases_created_by",
    "(organization_id, created_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "leases",
    "fk_leases_representative",
    "(organization_id, representative_person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "leases",
    "fk_leases_unit",
    "(organization_id, property_id, unit_id) REFERENCES units(organization_id, property_id, id)",
  ],
  ["leases", "leases_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "memberships",
    "fk_memberships_persons",
    "(organization_id, person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "memberships",
    "fk_memberships_selected_property",
    "(organization_id, selected_property_id) REFERENCES properties(organization_id, id)",
  ],
  ["memberships", "memberships_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "meter_events",
    "fk_meter_events_approved_by",
    "(organization_id, approved_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "meter_events",
    "fk_meter_events_meter",
    "(organization_id, property_id, meter_id) REFERENCES meters(organization_id, property_id, id)",
  ],
  [
    "meter_events",
    "fk_meter_events_new",
    "(organization_id, property_id, new_meter_id) REFERENCES meters(organization_id, property_id, id)",
  ],
  [
    "meter_events",
    "fk_meter_events_new_photo",
    "(organization_id, new_photo_file_id) REFERENCES files(organization_id, id)",
  ],
  [
    "meter_events",
    "fk_meter_events_old_photo",
    "(organization_id, old_photo_file_id) REFERENCES files(organization_id, id)",
  ],
  ["meter_events", "meter_events_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "meter_readings",
    "fk_meter_readings_approved_by",
    "(organization_id, approved_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "meter_readings",
    "fk_meter_readings_entered_by",
    "(organization_id, entered_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "meter_readings",
    "fk_meter_readings_handover",
    "(organization_id, handover_id) REFERENCES handovers(organization_id, id)",
  ],
  [
    "meter_readings",
    "fk_meter_readings_meter",
    "(organization_id, property_id, meter_id) REFERENCES meters(organization_id, property_id, id)",
  ],
  [
    "meter_readings",
    "fk_meter_readings_period",
    "(organization_id, property_id, billing_period_id) REFERENCES billing_periods(organization_id, property_id, id)",
  ],
  [
    "meter_readings",
    "fk_meter_readings_photo",
    "(organization_id, photo_file_id) REFERENCES files(organization_id, id)",
  ],
  ["meter_readings", "meter_readings_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "meters",
    "fk_meters_unit",
    "(organization_id, property_id, unit_id) REFERENCES units(organization_id, property_id, id)",
  ],
  ["meters", "meters_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "notification_deliveries",
    "fk_notification_deliveries_notification",
    "(organization_id, notification_id) REFERENCES notifications(organization_id, id)",
  ],
  [
    "notification_deliveries",
    "fk_notification_deliveries_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "notification_deliveries",
    "notification_deliveries_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "notification_preferences",
    "fk_notification_preferences_person",
    "(organization_id, person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "notification_preferences",
    "notification_preferences_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "notification_settings",
    "fk_notification_settings_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "notification_settings",
    "fk_notification_settings_updated_by",
    "(organization_id, updated_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "notification_settings",
    "notification_settings_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "notifications",
    "fk_notifications_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "notifications",
    "fk_notifications_recipient",
    "(organization_id, recipient_person_id) REFERENCES persons(organization_id, id)",
  ],
  ["notifications", "notifications_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "outbox",
    "fk_outbox_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  ["outbox", "outbox_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "payment_allocations",
    "fk_payment_allocations_by",
    "(organization_id, allocated_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "payment_allocations",
    "fk_payment_allocations_deposit",
    "(organization_id, property_id, deposit_id) REFERENCES deposits(organization_id, property_id, id)",
  ],
  [
    "payment_allocations",
    "fk_payment_allocations_entry",
    "(organization_id, entry_id) REFERENCES journal_entries(organization_id, id)",
  ],
  [
    "payment_allocations",
    "fk_payment_allocations_invoice",
    "(organization_id, property_id, invoice_id) REFERENCES invoices(organization_id, property_id, id)",
  ],
  [
    "payment_allocations",
    "fk_payment_allocations_payment",
    "(organization_id, property_id, payment_id) REFERENCES payments(organization_id, property_id, id)",
  ],
  [
    "payment_allocations",
    "fk_payment_allocations_reversal",
    "(organization_id, reversal_entry_id) REFERENCES journal_entries(organization_id, id)",
  ],
  [
    "payment_allocations",
    "payment_allocations_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "payment_claims",
    "fk_payment_claims_file",
    "(organization_id, proof_file_id) REFERENCES files(organization_id, id)",
  ],
  [
    "payment_claims",
    "fk_payment_claims_handled_by",
    "(organization_id, handled_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "payment_claims",
    "fk_payment_claims_invoice",
    "(organization_id, property_id, invoice_id) REFERENCES invoices(organization_id, property_id, id)",
  ],
  [
    "payment_claims",
    "fk_payment_claims_payment",
    "(organization_id, matched_payment_id) REFERENCES payments(organization_id, id)",
  ],
  [
    "payment_claims",
    "fk_payment_claims_person",
    "(organization_id, person_id) REFERENCES persons(organization_id, id)",
  ],
  ["payment_claims", "payment_claims_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "payments",
    "fk_payments_bank_transaction",
    "(organization_id, bank_transaction_id) REFERENCES bank_transactions(organization_id, id)",
  ],
  [
    "payments",
    "fk_payments_confirmed_by",
    "(organization_id, confirmed_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "payments",
    "fk_payments_deposit",
    "(organization_id, property_id, deposit_id) REFERENCES deposits(organization_id, property_id, id)",
  ],
  [
    "payments",
    "fk_payments_payer",
    "(organization_id, payer_person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "payments",
    "fk_payments_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "payments",
    "fk_payments_receiving_account",
    "(organization_id, receiving_account_id) REFERENCES receiving_accounts(organization_id, id)",
  ],
  [
    "payments",
    "fk_payments_recorded_by",
    "(organization_id, recorded_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "payments",
    "fk_payments_reservation",
    "(organization_id, reservation_id) REFERENCES reservations(organization_id, id)",
  ],
  [
    "payments",
    "fk_payments_reversed_by",
    "(organization_id, reversed_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "payments",
    "fk_payments_shift",
    "(organization_id, property_id, shift_id) REFERENCES shifts(organization_id, property_id, id)",
  ],
  ["payments", "payments_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "period_locks",
    "fk_period_locks_locked_by",
    "(organization_id, locked_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "period_locks",
    "fk_period_locks_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "period_locks",
    "fk_period_locks_released_by",
    "(organization_id, released_by) REFERENCES memberships(organization_id, id)",
  ],
  ["period_locks", "period_locks_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  ["persons", "persons_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  ["properties", "properties_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "property_scopes",
    "fk_property_scopes_properties",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "rate_plans",
    "fk_rate_plans_created_by",
    "(organization_id, created_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "rate_plans",
    "fk_rate_plans_room_type",
    "(organization_id, property_id, room_type_id) REFERENCES room_types(organization_id, property_id, id)",
  ],
  ["rate_plans", "rate_plans_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "receiving_accounts",
    "fk_receiving_accounts_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "receiving_accounts",
    "receiving_accounts_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "reconciliation_breaks",
    "fk_reconciliation_breaks_assignee",
    "(organization_id, assignee) REFERENCES memberships(organization_id, id)",
  ],
  [
    "reconciliation_breaks",
    "fk_reconciliation_breaks_bank_txn",
    "(organization_id, bank_transaction_id) REFERENCES bank_transactions(organization_id, id)",
  ],
  [
    "reconciliation_breaks",
    "fk_reconciliation_breaks_inbox",
    "(organization_id, inbox_id) REFERENCES inbox(organization_id, id)",
  ],
  [
    "reconciliation_breaks",
    "fk_reconciliation_breaks_payment",
    "(organization_id, property_id, resolved_payment_id) REFERENCES payments(organization_id, property_id, id)",
  ],
  [
    "reconciliation_breaks",
    "fk_reconciliation_breaks_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "reconciliation_breaks",
    "fk_reconciliation_breaks_resolved_by",
    "(organization_id, resolved_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "reconciliation_breaks",
    "reconciliation_breaks_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "reservation_items",
    "fk_reservation_items_allocation",
    "(organization_id, allocation_id) REFERENCES allocations(organization_id, id)",
  ],
  [
    "reservation_items",
    "fk_reservation_items_reservation",
    "(organization_id, property_id, reservation_id) REFERENCES reservations(organization_id, property_id, id)",
  ],
  [
    "reservation_items",
    "fk_reservation_items_room_type",
    "(organization_id, property_id, room_type_id) REFERENCES room_types(organization_id, property_id, id)",
  ],
  [
    "reservation_items",
    "fk_reservation_items_unit",
    "(organization_id, property_id, unit_id) REFERENCES units(organization_id, property_id, id)",
  ],
  [
    "reservation_items",
    "reservation_items_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "reservations",
    "fk_reservations_booker",
    "(organization_id, booker_person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "reservations",
    "fk_reservations_created_by",
    "(organization_id, created_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "reservations",
    "fk_reservations_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  ["reservations", "reservations_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "residence_notices",
    "fk_residence_notices_evidence",
    "(organization_id, evidence_file_id) REFERENCES files(organization_id, id)",
  ],
  [
    "residence_notices",
    "fk_residence_notices_export_file",
    "(organization_id, export_file_id) REFERENCES files(organization_id, id)",
  ],
  [
    "residence_notices",
    "fk_residence_notices_exported_by",
    "(organization_id, exported_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "residence_notices",
    "fk_residence_notices_stay",
    "(organization_id, property_id, stay_id) REFERENCES stays(organization_id, property_id, id)",
  ],
  [
    "residence_notices",
    "fk_residence_notices_submitted_by",
    "(organization_id, submitted_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "residence_notices",
    "residence_notices_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "room_types",
    "fk_room_types_properties",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "service_prices",
    "fk_service_prices_created_by",
    "(organization_id, created_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "service_prices",
    "fk_service_prices_service",
    "(organization_id, property_id, service_id) REFERENCES services(organization_id, property_id, id)",
  ],
  ["service_prices", "service_prices_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "services",
    "fk_services_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  ["services", "services_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "shift_discrepancies",
    "fk_shift_discrepancies_entry",
    "(organization_id, adjustment_entry_id) REFERENCES journal_entries(organization_id, id)",
  ],
  [
    "shift_discrepancies",
    "fk_shift_discrepancies_resolved_by",
    "(organization_id, resolved_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "shift_discrepancies",
    "fk_shift_discrepancies_responsible",
    "(organization_id, responsible_membership_id) REFERENCES memberships(organization_id, id)",
  ],
  [
    "shift_discrepancies",
    "fk_shift_discrepancies_shift",
    "(organization_id, property_id, shift_id) REFERENCES shifts(organization_id, property_id, id)",
  ],
  [
    "shift_discrepancies",
    "shift_discrepancies_organization_id_fkey",
    "(organization_id) REFERENCES organizations(id)",
  ],
  [
    "shifts",
    "fk_shifts_closed_by",
    "(organization_id, closed_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "shifts",
    "fk_shifts_handed_to",
    "(organization_id, handed_to) REFERENCES memberships(organization_id, id)",
  ],
  [
    "shifts",
    "fk_shifts_opened_by",
    "(organization_id, opened_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "shifts",
    "fk_shifts_previous",
    "(organization_id, previous_shift_id) REFERENCES shifts(organization_id, id)",
  ],
  [
    "shifts",
    "fk_shifts_property",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  ["shifts", "shifts_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "stays",
    "fk_stays_allow_balance",
    "(organization_id, allow_balance_approval_id) REFERENCES approval_requests(organization_id, id)",
  ],
  [
    "stays",
    "fk_stays_checked_in_by",
    "(organization_id, checked_in_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "stays",
    "fk_stays_checked_out_by",
    "(organization_id, checked_out_by) REFERENCES memberships(organization_id, id)",
  ],
  ["stays", "fk_stays_debtor", "(organization_id, debtor_person_id) REFERENCES persons(organization_id, id)"],
  [
    "stays",
    "fk_stays_guest",
    "(organization_id, primary_guest_person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "stays",
    "fk_stays_item",
    "(organization_id, property_id, reservation_item_id) REFERENCES reservation_items(organization_id, property_id, id)",
  ],
  [
    "stays",
    "fk_stays_unit",
    "(organization_id, property_id, unit_id) REFERENCES units(organization_id, property_id, id)",
  ],
  ["stays", "stays_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "tasks",
    "fk_tasks_assignee",
    "(organization_id, assignee_membership_id) REFERENCES memberships(organization_id, id)",
  ],
  [
    "tasks",
    "fk_tasks_created_by",
    "(organization_id, created_by) REFERENCES memberships(organization_id, id)",
  ],
  ["tasks", "fk_tasks_done_by", "(organization_id, done_by) REFERENCES memberships(organization_id, id)"],
  [
    "tasks",
    "fk_tasks_unit",
    "(organization_id, property_id, unit_id) REFERENCES units(organization_id, property_id, id)",
  ],
  [
    "tasks",
    "fk_tasks_verified_by",
    "(organization_id, verified_by) REFERENCES memberships(organization_id, id)",
  ],
  ["tasks", "tasks_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
  [
    "units",
    "fk_units_floors",
    "(organization_id, property_id, floor_id) REFERENCES floors(organization_id, property_id, id)",
  ],
  [
    "units",
    "fk_units_parent",
    "(organization_id, property_id, parent_unit_id) REFERENCES units(organization_id, property_id, id)",
  ],
  [
    "units",
    "fk_units_properties",
    "(organization_id, property_id) REFERENCES properties(organization_id, id)",
  ],
  [
    "units",
    "fk_units_room_types",
    "(organization_id, property_id, room_type_id) REFERENCES room_types(organization_id, property_id, id)",
  ],
  [
    "work_orders",
    "fk_work_orders_assignee",
    "(organization_id, assignee_membership_id) REFERENCES memberships(organization_id, id)",
  ],
  [
    "work_orders",
    "fk_work_orders_done_by",
    "(organization_id, done_by) REFERENCES memberships(organization_id, id)",
  ],
  [
    "work_orders",
    "fk_work_orders_reporter_m",
    "(organization_id, reporter_membership_id) REFERENCES memberships(organization_id, id)",
  ],
  [
    "work_orders",
    "fk_work_orders_reporter_p",
    "(organization_id, reporter_person_id) REFERENCES persons(organization_id, id)",
  ],
  [
    "work_orders",
    "fk_work_orders_unit",
    "(organization_id, property_id, unit_id) REFERENCES units(organization_id, property_id, id)",
  ],
  [
    "work_orders",
    "fk_work_orders_verified_by",
    "(organization_id, verified_by) REFERENCES memberships(organization_id, id)",
  ],
  ["work_orders", "work_orders_organization_id_fkey", "(organization_id) REFERENCES organizations(id)"],
];

/** [bảng, cột X của khoá ngoại (organization_id, X), cột X cho phép NULL ⇒ index một phần]. */
const INDEXES: readonly (readonly [table: string, column: string, nullable: boolean])[] = [
  ["bank_transactions", "inbox_id", true],
  ["bank_transactions", "receiving_account_id", false],
  ["exceptions", "allocation_id", false],
  ["exceptions", "related_allocation_id", true],
  ["export_jobs", "file_key", true],
  ["identity_documents", "file_id", true],
  ["import_batches", "file_id", false],
  ["inbox", "bank_transaction_id", true],
  ["lease_settlements", "approval_request_id", true],
  ["meter_events", "new_photo_file_id", true],
  ["meter_events", "old_photo_file_id", true],
  ["meter_readings", "photo_file_id", true],
  ["payment_allocations", "entry_id", false],
  ["payment_allocations", "reversal_entry_id", true],
  ["payment_claims", "proof_file_id", true],
  ["reconciliation_breaks", "inbox_id", true],
  ["residence_notices", "evidence_file_id", true],
  ["residence_notices", "export_file_id", true],
  ["shift_discrepancies", "adjustment_entry_id", true],
  ["shifts", "previous_shift_id", true],
];

/** Hàm riêng (không sửa `app.metrics_snapshot` của 0046 — tránh đè thay đổi khác của hàm đó); ngưỡng cảnh báo ở `deploy/prometheus/alerts.yml`. */
const METRICS_UP = `
CREATE FUNCTION app.db_health_metrics()
  RETURNS TABLE (name text, labels jsonb, value double precision)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT 'hm_db_connections'::text, '{}'::jsonb, d.numbackends::double precision
    FROM pg_stat_database d WHERE d.datname = current_database();
  RETURN QUERY SELECT 'hm_db_max_connections'::text, '{}'::jsonb, current_setting('max_connections')::double precision;
  RETURN QUERY SELECT 'hm_db_xid_age'::text, '{}'::jsonb, age(d.datfrozenxid)::double precision
    FROM pg_database d WHERE d.datname = current_database();
  RETURN QUERY SELECT 'hm_db_multixact_age'::text, '{}'::jsonb, mxid_age(d.datminmxid)::double precision
    FROM pg_database d WHERE d.datname = current_database();
  RETURN QUERY SELECT 'hm_db_dead_tuples'::text, jsonb_build_object('table', s.relname::text), s.n_dead_tup::double precision
    FROM pg_stat_user_tables s WHERE s.schemaname = 'public';
  RETURN QUERY SELECT 'hm_db_dead_tuple_ratio'::text, jsonb_build_object('table', s.relname::text),
    CASE WHEN s.n_live_tup + s.n_dead_tup = 0 THEN 0 ELSE s.n_dead_tup::double precision / (s.n_live_tup + s.n_dead_tup) END
    FROM pg_stat_user_tables s WHERE s.schemaname = 'public';
END $$;
REVOKE ALL ON FUNCTION app.db_health_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.db_health_metrics() TO app_runtime, app_worker;
`;

const indexName = (table: string, column: string) => `ixfk_${table}_${column}`;

export function upSql(): string {
  const fk = FKS.map(
    ([t, n, d]) =>
      `ALTER TABLE ${t} DROP CONSTRAINT ${n}, ADD CONSTRAINT ${n} FOREIGN KEY ${d} ON DELETE RESTRICT;`,
  );
  const ix = INDEXES.map(
    ([t, c, nullable]) =>
      `CREATE INDEX ${indexName(t, c)} ON ${t} (organization_id, ${c})${nullable ? ` WHERE ${c} IS NOT NULL` : ""};`,
  );
  return [...fk, ...ix, METRICS_UP].join("\n");
}

export function downSql(): string {
  const ix = INDEXES.map(([t, c]) => `DROP INDEX IF EXISTS ${indexName(t, c)};`);
  const fk = FKS.map(
    ([t, n, d]) => `ALTER TABLE ${t} DROP CONSTRAINT ${n}, ADD CONSTRAINT ${n} FOREIGN KEY ${d};`,
  );
  return ["DROP FUNCTION IF EXISTS app.db_health_metrics();", ...ix, ...fk].join("\n");
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const prev =
    (await sql<{ v: string }>`select current_setting('lock_timeout') as v`.execute(db)).rows[0]?.v ?? "0";
  await sql`select set_config('lock_timeout', '5s', true)`.execute(db);
  await sql.raw(upSql()).execute(db);
  await sql`select set_config('lock_timeout', ${prev}, true)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const prev =
    (await sql<{ v: string }>`select current_setting('lock_timeout') as v`.execute(db)).rows[0]?.v ?? "0";
  await sql`select set_config('lock_timeout', '5s', true)`.execute(db);
  await sql.raw(downSql()).execute(db);
  await sql`select set_config('lock_timeout', ${prev}, true)`.execute(db);
}
