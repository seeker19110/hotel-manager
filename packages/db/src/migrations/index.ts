// Danh sách migration theo thứ tự (tên = khoá sắp xếp). Thêm migration mới = thêm file + một dòng ở đây.
// Migration đã áp trên môi trường chung KHÔNG được sửa (AGENTS.md §4) — sửa sai bằng migration mới.
import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_tenancy.ts";
import * as m0002 from "./0002_auth.ts";
import * as m0003 from "./0003_command_pipeline.ts";
import * as m0004 from "./0004_inventory.ts";
import * as m0005 from "./0005_ledger_core.ts";
import * as m0006 from "./0006_files.ts";
import * as m0007 from "./0007_file_scope_rls.ts";
import * as m0008 from "./0008_approvals.ts";
import * as m0009 from "./0009_shifts.ts";
import * as m0010 from "./0010_payments.ts";
import * as m0011 from "./0011_deposits.ts";
import * as m0012 from "./0012_reconciliation.ts";
import * as m0013 from "./0013_period_close.ts";
import * as m0014 from "./0014_leases.ts";
import * as m0015 from "./0015_review_money_fixes.ts";
import * as m0016 from "./0016_handovers.ts";
import * as m0017 from "./0017_lease_settlements.ts";
import * as m0018 from "./0018_metering.ts";
import * as m0019 from "./0019_review_lease_fixes.ts";
import * as m0020 from "./0020_billing.ts";
import * as m0021 from "./0021_import.ts";
import * as m0022 from "./0022_mfa_recovery_scope.ts";
import * as m0023 from "./0023_identity_encryption.ts";
import * as m0024 from "./0024_rate_plans.ts";
import * as m0025 from "./0025_reservations.ts";
import * as m0026 from "./0026_reservation_expiry.ts";
import * as m0027 from "./0027_residence_notices.ts";
import * as m0028 from "./0028_tasks_checkout.ts";
import * as m0029 from "./0029_checkout_allocation_policy.ts";
import * as m0030 from "./0030_residence_notice_files.ts";
import * as m0031 from "./0031_unit_arrivals.ts";
import * as m0032 from "./0032_work_orders.ts";
import * as m0033 from "./0033_hk_maintenance_review_fixes.ts";
import * as m0034 from "./0034_notifications.ts";
import * as m0035 from "./0035_notification_preferences.ts";
import * as m0036 from "./0036_reminders.ts";
import * as m0037 from "./0037_notification_claim_fixes.ts";
import * as m0038 from "./0038_portal_access.ts";
import * as m0039 from "./0039_tenant_rls_hardening.ts";
import * as m0040 from "./0040_portal_tenant.ts";
import * as m0041 from "./0041_guest_links.ts";
import * as m0042 from "./0042_audit_read_scope.ts";
import * as m0043 from "./0043_export_jobs.ts";
import * as m0044 from "./0044_lease_supersede.ts";
import * as m0045 from "./0045_retention_and_selection.ts";
import * as m0046 from "./0046_observability.ts";
import * as m0047 from "./0047_worker_schema_and_file_staging.ts";
import * as m0048 from "./0048_fk_indexes_and_autovacuum.ts";
import * as m0049 from "./0049_audit_source.ts";
import * as m0050 from "./0050_reconciliation_daily.ts";
import * as m0051 from "./0051_fk_restrict_and_indexes.ts";
import * as m0052 from "./0052_files_settlement_read.ts";
import * as m0053 from "./0053_rate_limit_counters.ts";
import * as m0054 from "./0054_outbox_traceparent.ts";
import * as m0056 from "./0056_event_table_retention.ts";
import * as m0060 from "./0060_fk_operator_indexes.ts";
import * as m0061 from "./0061_stays_overdue.ts";
import * as m0062 from "./0062_access_property.ts";
import * as m0063 from "./0063_email_budget.ts";
import * as m0064 from "./0064_catalog_property_scope.ts";
import * as m0065 from "./0065_role_write_policies.ts";
import * as m0066 from "./0066_personal_data_retention.ts";
import * as m0067 from "./0067_product_events.ts";
import * as m0068 from "./0068_consent_records.ts";
import * as m0069 from "./0069_dsar_requests.ts";
import * as m0070 from "./0070_org_deletion.ts";
import * as m0071 from "./0071_org_background_active_only.ts";
import * as m0072 from "./0072_support_access.ts";

export const migrations: Record<string, Migration> = {
  "0001_tenancy": m0001,
  "0002_auth": m0002,
  "0003_command_pipeline": m0003,
  "0004_inventory": m0004,
  "0005_ledger_core": m0005,
  "0006_files": m0006,
  "0007_file_scope_rls": m0007,
  "0008_approvals": m0008,
  "0009_shifts": m0009,
  "0010_payments": m0010,
  "0011_deposits": m0011,
  "0012_reconciliation": m0012,
  "0013_period_close": m0013,
  "0014_leases": m0014,
  "0015_review_money_fixes": m0015,
  "0016_handovers": m0016,
  "0017_lease_settlements": m0017,
  "0018_metering": m0018,
  "0019_review_lease_fixes": m0019,
  "0020_billing": m0020,
  "0021_import": m0021,
  "0022_mfa_recovery_scope": m0022,
  "0023_identity_encryption": m0023,
  "0024_rate_plans": m0024,
  "0025_reservations": m0025,
  "0026_reservation_expiry": m0026,
  "0027_residence_notices": m0027,
  "0028_tasks_checkout": m0028,
  "0029_checkout_allocation_policy": m0029,
  "0030_residence_notice_files": m0030,
  "0031_unit_arrivals": m0031,
  "0032_work_orders": m0032,
  "0033_hk_maintenance_review_fixes": m0033,
  "0034_notifications": m0034,
  "0035_notification_preferences": m0035,
  "0036_reminders": m0036,
  "0037_notification_claim_fixes": m0037,
  "0038_portal_access": m0038,
  "0039_tenant_rls_hardening": m0039,
  "0040_portal_tenant": m0040,
  "0041_guest_links": m0041,
  "0042_audit_read_scope": m0042,
  "0043_export_jobs": m0043,
  "0044_lease_supersede": m0044,
  "0045_retention_and_selection": m0045,
  "0046_observability": m0046,
  "0047_worker_schema_and_file_staging": m0047,
  "0048_fk_indexes_and_autovacuum": m0048,
  "0049_audit_source": m0049,
  "0050_reconciliation_daily": m0050,
  "0051_fk_restrict_and_indexes": m0051,
  "0052_files_settlement_read": m0052,
  "0053_rate_limit_counters": m0053,
  "0054_outbox_traceparent": m0054,
  "0056_event_table_retention": m0056,
  "0060_fk_operator_indexes": m0060,
  "0061_stays_overdue": m0061,
  "0062_access_property": m0062,
  "0063_email_budget": m0063,
  "0064_catalog_property_scope": m0064,
  "0065_role_write_policies": m0065,
  "0066_personal_data_retention": m0066,
  "0067_product_events": m0067,
  "0068_consent_records": m0068,
  "0069_dsar_requests": m0069,
  "0070_org_deletion": m0070,
  "0071_org_background_active_only": m0071,
  "0072_support_access": m0072,
};
