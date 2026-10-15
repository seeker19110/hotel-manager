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
};
