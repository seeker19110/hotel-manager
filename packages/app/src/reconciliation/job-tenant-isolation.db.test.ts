// Cách ly tổ chức ở đường job worker (SPEC-access S-013 d; INV-G1): job mang `organization_id` của A chỉ đọc/ghi hàng của A,
// kể cả khi payload trỏ tới id giao dịch của tổ chức B. Dùng chính hàm job `applyBankTransaction` với role `app_worker`.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBankTransaction } from "./auto-apply.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let txnA: string;
let txnB: string;

async function seedBankTxn(org: SeededOrg, ref: string): Promise<string> {
  const account = randomUUID();
  const id = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${account}, ${org.orgId}, ${org.propertyId}, 'VCB', '****5600', ${`10175956${ref}`}, 'NGUYEN VAN A')`.execute(
    t.admin,
  );
  await sql`insert into bank_transactions (id, organization_id, property_id, receiving_account_id, bank_txn_ref, amount, occurred_at,
                                           description, first_source, raw_hash)
            values (${id}, ${org.orgId}, ${org.propertyId}, ${account}, ${`FT${ref}`}, 500000, '2026-10-15T03:00:00Z',
                    'HMXXXX chuyen tien', 'manual', ${"a".repeat(64)})`.execute(t.admin);
  return id;
}

/** Số hàng "dấu vết" của job ở một tổ chức: thanh toán, điểm lệch đối soát, audit, outbox. */
async function traces(orgId: string) {
  const r = await sql<{ n: number }>`
    select ((select count(*) from payments where organization_id = ${orgId})
          + (select count(*) from reconciliation_breaks where organization_id = ${orgId})
          + (select count(*) from audit_events where organization_id = ${orgId})
          + (select count(*) from outbox where organization_id = ${orgId}))::int as n`.execute(t.admin);
  return r.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ A job");
  B = await seedOrg(t.admin, "Trọ B job");
  txnA = await seedBankTxn(A, "0001");
  txnB = await seedBankTxn(B, "0002");
});

afterAll(async () => {
  await t.drop();
});

describe("SPEC-access S-013 (d): job worker mang payload tổ chức A", () => {
  it("giao dịch của chính A được đọc (bị bỏ qua vì chưa có chữ ký xác minh); giao dịch của B → not_found, B không bị ghi gì", async () => {
    const before = { a: await traces(A.orgId), b: await traces(B.orgId) };
    expect(await applyBankTransaction(t.worker, A.orgId, txnA)).toEqual({
      outcome: "skipped",
      why: "not_verified",
    });
    expect(await applyBankTransaction(t.worker, A.orgId, txnB)).toEqual({
      outcome: "skipped",
      why: "not_found",
    });
    expect(await traces(B.orgId)).toBe(before.b);
    expect(await traces(A.orgId)).toBe(before.a);
  });

  it("role worker trong ngữ cảnh A không đọc/ghi được hàng của B kể cả truy vấn thẳng", async () => {
    const seen = await withTenant(t.worker, { orgId: A.orgId }, (trx) =>
      sql<{ n: number }>`select count(*)::int as n from bank_transactions where id = ${txnB}`.execute(trx),
    );
    expect(seen.rows[0]?.n).toBe(0);
    await expect(
      withTenant(t.worker, { orgId: A.orgId }, (trx) =>
        sql`insert into audit_events (id, organization_id, actor_type, action, entity_type, entity_id, correlation_id)
            values (${randomUUID()}, ${B.orgId}, 'worker', 'x.y', 'x', ${randomUUID()}, 'job:test')`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it("job mang org id không tồn tại → bỏ qua, không lỗi, không ghi", async () => {
    expect(await applyBankTransaction(t.worker, randomUUID(), txnA)).toEqual({
      outcome: "skipped",
      why: "not_found",
    });
  });
});
