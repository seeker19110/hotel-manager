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
import * as m0037 from "./0037_portal_access.ts";
import * as m0038 from "./0038_tenant_rls_hardening.ts";
import * as m0039 from "./0039_portal_tenant.ts";

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
  "0037_portal_access": m0037,
  "0038_tenant_rls_hardening": m0038,
  "0039_portal_tenant": m0039,
};
