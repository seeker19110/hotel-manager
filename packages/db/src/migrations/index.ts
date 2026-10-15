// Danh sách migration theo thứ tự (tên = khoá sắp xếp). Thêm migration mới = thêm file + một dòng ở đây.
// Migration đã áp trên môi trường chung KHÔNG được sửa (AGENTS.md §4) — sửa sai bằng migration mới.
import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_tenancy.ts";
import * as m0002 from "./0002_auth.ts";

export const migrations: Record<string, Migration> = {
  "0001_tenancy": m0001,
  "0002_auth": m0002,
};
