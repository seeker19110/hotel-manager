// T-012 — dữ liệu giả cho diễn tập sao lưu/PITR (scripts/db-backup-restore-check.sh). Chạy thẳng bằng `node` (bỏ kiểu TS).
//   node packages/testkit/src/backup-fixture.ts prepare <adminUrl> <db>   → role + migrate + 1 tổ chức giả; in {orgId, propertyId, personId}
//   node packages/testkit/src/backup-fixture.ts write <url> <orgId> <propertyId> <personId> <n> → n bút toán cân (1 transaction)
//   node packages/testkit/src/backup-fixture.ts summary <url>              → JSON số dòng + Σ Nợ/Có + số policy RLS
// Ghi bằng superuser của cluster tạm (không chịu RLS); không có dữ liệu thật.
import { randomInt, randomUUID } from "node:crypto";
import { migrateToLatest } from "@hm/db";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { bootstrapRoles } from "./bootstrap.ts";
import { seedOrg } from "./factory.ts";

function open(url: string): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 2 }) }),
  });
}

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function prepare(adminUrl: string, dbName: string): Promise<unknown> {
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) throw new Error(`tên DB không hợp lệ: ${dbName}`);
  const admin = open(adminUrl);
  try {
    await bootstrapRoles(admin);
    await sql.raw(`CREATE DATABASE ${dbName}`).execute(admin);
  } finally {
    await admin.destroy();
  }
  const db = open(withDb(adminUrl, dbName));
  try {
    await migrateToLatest(db);
    const org = await seedOrg(db, "Diễn tập sao lưu (giả)", "rental");
    return { orgId: org.orgId, propertyId: org.propertyId, personId: org.ownerPersonId };
  } finally {
    await db.destroy();
  }
}

/** n bút toán `invoice_issued` (Nợ AR / Có REV_ROOM) trong một transaction — trigger cân kiểm lúc commit. */
async function write(
  url: string,
  orgId: string,
  propertyId: string,
  personId: string,
  n: number,
): Promise<unknown> {
  if (!Number.isInteger(n) || n < 1) throw new Error(`n không hợp lệ: ${n}`);
  const db = open(url);
  try {
    await db.transaction().execute(async (trx) => {
      for (let i = 0; i < n; i++) {
        const entryId = randomUUID();
        const invoiceId = randomUUID();
        const amount = BigInt(randomInt(1, 50_000)) * 1000n;
        await sql`
          insert into journal_entries (id, organization_id, property_id, entry_type, business_date, source_doc_type, source_doc_id)
          values (${entryId}, ${orgId}, ${propertyId}, 'invoice_issued', current_date, 'invoice', ${invoiceId})`.execute(
          trx,
        );
        await sql`
          insert into journal_lines (id, organization_id, property_id, entry_id, line_no, account, debit, credit, person_id, invoice_id)
          values (${randomUUID()}, ${orgId}, ${propertyId}, ${entryId}, 1, 'AR', ${amount.toString()}, 0, ${personId}, ${invoiceId}),
                 (${randomUUID()}, ${orgId}, ${propertyId}, ${entryId}, 2, 'REV_ROOM', 0, ${amount.toString()}, null, ${invoiceId})`.execute(
          trx,
        );
      }
    });
    return { written: n };
  } finally {
    await db.destroy();
  }
}

async function summary(url: string): Promise<unknown> {
  const db = open(url);
  try {
    const r = await sql<Record<string, string>>`
      select (select count(*) from organizations)::text as organizations,
             (select count(*) from journal_entries)::text as journal_entries,
             (select count(*) from journal_lines)::text as journal_lines,
             (select coalesce(sum(debit), 0) from journal_lines)::text as sum_debit,
             (select coalesce(sum(credit), 0) from journal_lines)::text as sum_credit,
             (select count(*) from pg_policies where schemaname = 'public')::text as rls_policies,
             (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity)::text as rls_forced_tables`.execute(
      db,
    );
    return r.rows[0];
  } finally {
    await db.destroy();
  }
}

const [cmd, ...args] = process.argv.slice(2);
const run: Record<string, () => Promise<unknown>> = {
  prepare: () => prepare(args[0] ?? "", args[1] ?? ""),
  write: () => write(args[0] ?? "", args[1] ?? "", args[2] ?? "", args[3] ?? "", Number(args[4])),
  summary: () => summary(args[0] ?? ""),
};
const fn = cmd ? run[cmd] : undefined;
if (!fn) {
  console.error("dùng: backup-fixture.ts prepare|write|summary …");
  process.exit(2);
}
console.log(JSON.stringify(await fn()));
