// Bộ kiểm cách ly tenant DÙNG CHUNG (PLAN T-007): tự liệt kê MỌI bảng có organization_id (kể cả bảng thêm sau),
// trong ngữ cảnh tổ chức A chỉ được thấy hàng của A. Bảng mới không cần viết test riêng mới được che phủ.
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";

export async function tenantTables(admin: Kysely<unknown>): Promise<string[]> {
  const r = await sql<{ t: string }>`
    select table_name as t from information_schema.columns
    where table_schema = 'public' and column_name = 'organization_id'
    order by table_name`.execute(admin);
  return r.rows.map((x) => x.t);
}

/** Trả danh sách vi phạm: bảng mà ngữ cảnh `orgId` nhìn thấy hàng của tổ chức khác. Rỗng = đạt. */
export async function findIsolationLeaks(
  admin: Kysely<unknown>,
  runtime: Kysely<unknown>,
  orgId: string,
): Promise<string[]> {
  const leaks: string[] = [];
  for (const table of await tenantTables(admin)) {
    let n = 0;
    try {
      n = await withTenant(runtime, { orgId }, async (trx) => {
        const r = await sql<{ n: number }>`
          select count(*)::int as n from ${sql.table(table)} where organization_id <> ${orgId}::uuid`.execute(
          trx,
        );
        return r.rows[0]?.n ?? 0;
      });
    } catch (err) {
      // Role không được cấp SELECT (vd app_runtime chỉ INSERT outbox) thì không thể đọc chéo — đạt.
      if ((err as { code?: string }).code !== "42501") throw err;
    }
    if (n > 0) leaks.push(`${table}: thấy ${n} hàng của tổ chức khác`);
  }
  return leaks;
}
