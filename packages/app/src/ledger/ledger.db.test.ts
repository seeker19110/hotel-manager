// T-010 — lõi sổ tiền trên Postgres thật: INV-F1 (cân bằng, kiểm lúc commit), INV-G4 (append-only), đảo một lần,
// ví dụ kế hoạch qua bút toán; INV-F4/F4b (100 lần cùng payload → 1 inbox, 1 giao dịch; webhook + sao kê → 1 giao dịch);
// chữ ký webhook (TM-04).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedLease, seedOrg, type TestDb } from "@hm/testkit";
import { sql, type Transaction } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestBankEvent, signSim, verifySimSignature } from "./bank-inbox.ts";
import { balance, postEntry, reverseEntry } from "./ledger.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let accountA: string;

const tenant = <T>(fn: (trx: Transaction<unknown>) => Promise<T>) =>
  withTenant(t.runtime, { orgId: A.orgId }, fn);

/** Hàng phiếu thật (FK journal_lines.invoice_id từ migration 0010) — test tự ghi bút toán AR của phiếu. */
async function invoiceRow(total: number): Promise<string> {
  const id = randomUUID();
  await t.admin.transaction().execute(async (trx) => {
    await sql`insert into invoices (id, organization_id, property_id, kind, number, memo_ref, payer_person_id, business_date, total)
              values (${id}, ${A.orgId}, ${A.propertyId}, 'fee', ${`L-${id.slice(0, 8)}`},
                      ${`HM${id.replaceAll("-", "").slice(0, 10).toUpperCase()}`}, ${A.ownerPersonId}, current_date, ${total})`.execute(
      trx,
    );
    await sql`insert into invoice_lines (id, organization_id, property_id, invoice_id, line_no, kind, description, revenue_account,
                                         quantity, unit_price, amount, rounding_rule, formula_version)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${id}, 1, 'fee', 'Phí (giả)', 'REV_FEE', 1, ${total},
                      ${total}, 'HALF_UP_1', 1)`.execute(trx);
  });
  return id;
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ sổ tiền", "rental");
  B = await seedOrg(t.admin, "Tổ chức khác");
  accountA = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${accountA}, ${A.orgId}, ${A.propertyId}, '970436', '****6789', '0123456789', 'NGUYEN VAN A')`.execute(
    t.admin,
  );
});

afterAll(async () => {
  await t.drop();
});

describe("INV-F1 — bút toán cân bằng", () => {
  it("ví dụ trọ: phát hành 3.580.000, nhận 2.000.000 chuyển khoản, phân bổ → AR phiếu còn 1.580.000; cọc riêng 3.000.000", async () => {
    const invoice = await invoiceRow(3_580_000);
    const payer = A.ownerPersonId;
    // Cọc thật (FK journal_lines.deposit_id từ migration 0011).
    const deposit = randomUUID();
    const { leaseId } = await seedLease(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      representativePersonId: A.ownerPersonId,
    });
    await sql`insert into deposits (id, organization_id, property_id, lease_id, payer_person_id)
              values (${deposit}, ${A.orgId}, ${A.propertyId}, ${leaseId}, ${A.ownerPersonId})`.execute(
      t.admin,
    );
    // Dòng CASH phải gắn một ca có thật (FK từ migration 0009).
    const shift = randomUUID();
    await sql`insert into shifts (id, organization_id, property_id, opened_by, opening_cash)
              values (${shift}, ${A.orgId}, ${A.propertyId}, ${A.ownerMembershipId}, 0)`.execute(t.admin);
    await tenant(async (trx) => {
      const base = { orgId: A.orgId, propertyId: A.propertyId, businessDate: "2026-11-01" };
      await postEntry(trx, {
        ...base,
        entryType: "invoice_issued",
        sourceDocType: "invoice",
        sourceDocId: invoice,
        lines: [
          { account: "AR", debit: 3_580_000, credit: 0, invoiceId: invoice, personId: payer },
          { account: "REV_ROOM", debit: 0, credit: 3_000_000 },
          { account: "REV_UTIL", debit: 0, credit: 480_000 },
          { account: "REV_FEE", debit: 0, credit: 100_000 },
        ],
      });
      await postEntry(trx, {
        ...base,
        entryType: "payment_confirmed",
        sourceDocType: "payment",
        sourceDocId: randomUUID(),
        lines: [
          { account: "BANK", debit: 2_000_000, credit: 0, receivingAccountId: accountA },
          { account: "CUSTOMER_CREDIT", debit: 0, credit: 2_000_000, personId: payer },
        ],
      });
      await postEntry(trx, {
        ...base,
        entryType: "payment_allocated",
        sourceDocType: "payment_allocation",
        sourceDocId: randomUUID(),
        lines: [
          { account: "CUSTOMER_CREDIT", debit: 2_000_000, credit: 0, personId: payer },
          { account: "AR", debit: 0, credit: 2_000_000, invoiceId: invoice },
        ],
      });
      await postEntry(trx, {
        ...base,
        entryType: "deposit_received",
        sourceDocType: "deposit",
        sourceDocId: deposit,
        lines: [
          { account: "CASH", debit: 3_000_000, credit: 0, shiftId: shift },
          { account: "DEPOSIT_LIAB", debit: 0, credit: 3_000_000, depositId: deposit },
        ],
      });
    });
    const [ar, credit, dep, rev] = await tenant(async (trx) => [
      await balance(trx, { orgId: A.orgId, account: "AR", invoiceId: invoice }),
      await balance(trx, { orgId: A.orgId, account: "CUSTOMER_CREDIT", personId: payer }),
      await balance(trx, { orgId: A.orgId, account: "DEPOSIT_LIAB", depositId: deposit }),
      await balance(trx, { orgId: A.orgId, account: "REV_ROOM" }),
    ]);
    expect(ar).toBe(1_580_000);
    expect(credit).toBe(0);
    expect(dep).toBe(-3_000_000); // nợ phải trả: số dư Có — cọc KHÔNG vào doanh thu
    expect(rev).toBe(-3_000_000);
  });

  it("ví dụ khách sạn: 1.430.000 với ứng trước 500.000 đã phân bổ → còn 930.000", async () => {
    const folio = await invoiceRow(1_430_000);
    const guest = A.ownerPersonId;
    await tenant(async (trx) => {
      const base = { orgId: A.orgId, propertyId: A.propertyId, businessDate: "2026-11-02" };
      await postEntry(trx, {
        ...base,
        entryType: "invoice_issued",
        sourceDocType: "invoice",
        sourceDocId: folio,
        lines: [
          { account: "AR", debit: 1_430_000, credit: 0, invoiceId: folio },
          { account: "REV_ROOM", debit: 0, credit: 1_200_000 },
          { account: "REV_SERVICE", debit: 0, credit: 80_000 },
          { account: "REV_FEE", debit: 0, credit: 150_000 },
        ],
      });
      await postEntry(trx, {
        ...base,
        entryType: "payment_allocated",
        sourceDocType: "payment_allocation",
        sourceDocId: randomUUID(),
        lines: [
          { account: "CUSTOMER_CREDIT", debit: 500_000, credit: 0, personId: guest },
          { account: "AR", debit: 0, credit: 500_000, invoiceId: folio },
        ],
      });
    });
    expect(await tenant((trx) => balance(trx, { orgId: A.orgId, account: "AR", invoiceId: folio }))).toBe(
      930_000,
    );
  });

  it("bút toán lệch bị CSDL từ chối lúc commit — kể cả owner chèn trực tiếp, bỏ qua kiểm ở app", async () => {
    const entry = randomUUID();
    const inv = await invoiceRow(100);
    await expect(
      t.admin.transaction().execute(async (trx) => {
        await sql`insert into journal_entries (id, organization_id, property_id, entry_type, business_date, source_doc_type, source_doc_id)
                  values (${entry}, ${A.orgId}, ${A.propertyId}, 'adjustment', '2026-11-03', 'approval_request', ${randomUUID()})`.execute(
          trx,
        );
        await sql`insert into journal_lines (id, organization_id, property_id, entry_id, line_no, account, debit, credit, invoice_id)
                  values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${entry}, 1, 'AR', 100, 0, ${inv})`.execute(
          trx,
        );
        await sql`insert into journal_lines (id, organization_id, property_id, entry_id, line_no, account, debit, credit)
                  values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${entry}, 2, 'REV_FEE', 0, 99)`.execute(
          trx,
        );
      }),
    ).rejects.toThrow(/lệch/);
    await expect(
      t.admin.transaction().execute(async (trx) => {
        await sql`insert into journal_entries (id, organization_id, property_id, entry_type, business_date, source_doc_type, source_doc_id)
                  values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, 'adjustment', '2026-11-03', 'approval_request', ${randomUUID()})`.execute(
          trx,
        );
      }),
    ).rejects.toThrow(/thiếu dòng/);
  });

  it("dòng 0 đ hoặc hai phía, tiền mặt thiếu ca, AR thiếu phiếu → CHECK từ chối", async () => {
    const lineInsert = (extra: string) =>
      t.admin.transaction().execute(async (trx) => {
        const entry = randomUUID();
        await sql`insert into journal_entries (id, organization_id, property_id, entry_type, business_date, source_doc_type, source_doc_id)
                  values (${entry}, ${A.orgId}, ${A.propertyId}, 'adjustment', '2026-11-03', 'approval_request', ${randomUUID()})`.execute(
          trx,
        );
        await sql
          .raw(`insert into journal_lines (id, organization_id, property_id, entry_id, line_no, account, debit, credit)
                       values ('${randomUUID()}', '${A.orgId}', '${A.propertyId}', '${entry}', 1, ${extra})`)
          .execute(trx);
      });
    await expect(lineInsert(`'REV_FEE', 0, 0`)).rejects.toThrow(/ck_journal_lines_one_side/);
    await expect(lineInsert(`'REV_FEE', 5, 5`)).rejects.toThrow(/ck_journal_lines_one_side/);
    await expect(lineInsert(`'CASH', 5, 0`)).rejects.toThrow(/ck_journal_lines_cash/);
    await expect(lineInsert(`'AR', 5, 0`)).rejects.toThrow(/ck_journal_lines_ar/);
  });
});

describe("INV-G4 — append-only và đảo một lần", () => {
  it("UPDATE/DELETE/TRUNCATE sổ bị chặn (cả owner); app_runtime không có quyền UPDATE", async () => {
    await expect(sql`update journal_lines set debit = debit + 1`.execute(t.admin)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`delete from journal_entries`.execute(t.admin)).rejects.toThrow(/append-only/);
    await expect(sql`truncate journal_lines`.execute(t.admin)).rejects.toThrow(/append-only/);
    await expect(tenant((trx) => sql`update journal_lines set credit = 1`.execute(trx))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("đảo bút toán: số dư về 0; đảo lần hai → INVALID_TRANSITION", async () => {
    const invoice = await invoiceRow(250_000);
    const entryId = await tenant((trx) =>
      postEntry(trx, {
        orgId: A.orgId,
        propertyId: A.propertyId,
        businessDate: "2026-11-04",
        entryType: "invoice_issued",
        sourceDocType: "invoice",
        sourceDocId: invoice,
        lines: [
          { account: "AR", debit: 250_000, credit: 0, invoiceId: invoice },
          { account: "REV_FEE", debit: 0, credit: 250_000 },
        ],
      }),
    );
    await tenant((trx) =>
      reverseEntry(trx, { orgId: A.orgId, entryId, businessDate: "2026-11-05", reason: "Lập nhầm" }),
    );
    expect(await tenant((trx) => balance(trx, { orgId: A.orgId, account: "AR", invoiceId: invoice }))).toBe(
      0,
    );
    await expect(
      tenant((trx) =>
        reverseEntry(trx, { orgId: A.orgId, entryId, businessDate: "2026-11-05", reason: "Lần hai" }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
});

describe("INV-F4/F4b — tiền vào không trùng", () => {
  const event = (id: string, ref: string, amount = 2_000_000) => ({
    provider: "sim",
    account: accountA,
    providerEventId: id,
    raw: { id, ref, amount, content: "HM INV-001" },
    signatureVerified: true,
    source: "webhook" as const,
    txn: { ref, amount, occurredAt: new Date("2026-11-01T03:00:00Z"), description: "HM INV-001" },
  });

  it("100 lần cùng payload song song → 1 inbox, 1 bank_transaction", async () => {
    const ev = event("evt-100", "FT26305001");
    const results = await Promise.all(Array.from({ length: 100 }, () => ingestBankEvent(t.runtime, ev)));
    expect(new Set(results.map((r) => r.bankTransactionId)).size).toBe(1);
    const c = await sql<{ i: number; b: number }>`
      select (select count(*) from inbox where provider_event_id = 'evt-100')::int as i,
             (select count(*) from bank_transactions where bank_txn_ref = 'FT26305001')::int as b`.execute(
      t.admin,
    );
    expect(c.rows[0]).toEqual({ i: 1, b: 1 });
  });

  it("webhook rồi sao kê cùng giao dịch → 2 inbox (khác nguồn) nhưng 1 bank_transaction", async () => {
    const w = await ingestBankEvent(t.runtime, event("evt-w1", "FT26305002"));
    const s = await ingestBankEvent(t.runtime, {
      ...event("stmt-line-17", "FT26305002"),
      provider: "statement_csv",
      source: "statement",
    });
    expect(s.bankTransactionId).toBe(w.bankTransactionId);
    expect(s).toMatchObject({ existingTransaction: true, duplicateEvent: false });
    const c = await sql<{
      n: number;
    }>`select count(*)::int as n from bank_transactions where bank_txn_ref = 'FT26305002'`.execute(t.admin);
    expect(c.rows[0]?.n).toBe(1);
  });

  it("cùng event id khác nội dung → INBOX_HASH_MISMATCH, không ghi tiền mới", async () => {
    await ingestBankEvent(t.runtime, event("evt-h", "FT26305003"));
    await expect(ingestBankEvent(t.runtime, event("evt-h", "FT26305003", 9_999_000))).rejects.toMatchObject({
      code: "INBOX_HASH_MISMATCH",
      status: 409,
    });
    const c = await sql<{
      n: number;
    }>`select count(*)::int as n from bank_transactions where bank_txn_ref = 'FT26305003'`.execute(t.admin);
    expect(c.rows[0]?.n).toBe(1);
  });

  it("cùng mã giao dịch ngân hàng từ nguồn khác mà số tiền khác → INBOX_HASH_MISMATCH", async () => {
    await ingestBankEvent(t.runtime, event("evt-x", "FT26305004"));
    await expect(
      ingestBankEvent(t.runtime, {
        ...event("stmt-x", "FT26305004", 1_000_000),
        provider: "statement_csv",
        source: "statement",
      }),
    ).rejects.toMatchObject({ code: "INBOX_HASH_MISMATCH" });
  });

  it("tài khoản nhận không tồn tại → NOT_FOUND; số tiền không nguyên → VALIDATION_FAILED", async () => {
    await expect(
      ingestBankEvent(t.runtime, { ...event("evt-n", "FT1"), account: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ingestBankEvent(t.runtime, event("evt-f", "FT2", 10.5))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("tổ chức B không thấy giao dịch/inbox của A", async () => {
    const r = await withTenant(t.runtime, { orgId: B.orgId }, (trx) =>
      sql<{
        n: number;
      }>`select (select count(*) from bank_transactions) + (select count(*) from inbox) as n`.execute(trx),
    );
    expect(Number(r.rows[0]?.n)).toBe(0);
  });

  it("bank_transactions append-only", async () => {
    await expect(sql`update bank_transactions set amount = 1`.execute(t.admin)).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("chữ ký webhook sim (TM-04)", () => {
  const secret = "bi-mat-webhook-thu-nghiem-32-ky-tu!!";
  const body = JSON.stringify({ id: "evt-1", amount: 2_000_000 });
  const now = new Date("2026-11-01T03:00:00Z");
  const ts = String(Math.floor(now.getTime() / 1000));

  it("chữ ký đúng, trong hạn → hợp lệ", () => {
    expect(() =>
      verifySimSignature({ secret, body, timestamp: ts, signature: signSim(secret, ts, body), now }),
    ).not.toThrow();
  });

  it.each([
    ["sai chữ ký", { signature: "0".repeat(64) }],
    ["sửa body", { body: body.replace("2000000", "9000000") }],
    ["quá hạn 10 phút (phát lại)", { now: new Date(now.getTime() + 600_000) }],
    ["chữ ký rỗng", { signature: "" }],
  ])("%s → WEBHOOK_SIGNATURE_INVALID 401", (_n, patch) => {
    const input = { secret, body, timestamp: ts, signature: signSim(secret, ts, body), now, ...patch };
    expect(() => verifySimSignature(input)).toThrowError(
      expect.objectContaining({ code: "WEBHOOK_SIGNATURE_INVALID", status: 401 }),
    );
  });
});
