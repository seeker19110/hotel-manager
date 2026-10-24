// Bộ lọc/id của truy vấn phải THUỘC tổ chức của người gọi (D-030): id lạ → 404 NOT_FOUND như mọi chỗ khác (không "200 rỗng",
// người dùng không nhầm "không có dữ liệu" với "sai cơ sở"). `authorize` chỉ kiểm phạm vi cơ sở của actor, không kiểm tồn tại.
import { type Kysely, sql, type Transaction } from "kysely";
import { t } from "../i18n.ts";
import { CommandError } from "../pipeline/index.ts";

type Db = Kysely<unknown> | Transaction<unknown>;

const notFound = () => new CommandError("NOT_FOUND", 404, t("common.not_found_data"));

export async function assertPropertyInOrg(db: Db, orgId: string, propertyId: string): Promise<void> {
  const r = await sql<{ id: string }>`
    select id from properties where organization_id = ${orgId} and id = ${propertyId}`.execute(db);
  if (!r.rows[0]) throw notFound();
}

export async function assertPersonInOrg(db: Db, orgId: string, personId: string): Promise<void> {
  const r = await sql<{ id: string }>`
    select id from persons where organization_id = ${orgId} and id = ${personId}`.execute(db);
  if (!r.rows[0]) throw notFound();
}
