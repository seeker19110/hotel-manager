// Danh sách migration theo thứ tự (tên = khoá sắp xếp). Thêm migration mới = thêm file + một dòng ở đây.
// Migration đã áp trên môi trường chung KHÔNG được sửa (AGENTS.md §4) — sửa sai bằng migration mới.
import type { Migration } from "kysely/migration";

export const migrations: Record<string, Migration> = {};
