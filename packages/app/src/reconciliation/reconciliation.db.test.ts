// PLAN đợt 2 T-107 — QR và đối soát trên Postgres thật (SPEC-ledger S-015…S-021, S-029, S-030; INV-F3, INV-F4, INV-F4b).
import { randomUUID } from "node:crypto";
import { crc16CcittFalse } from "@hm/domain";
import {
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedIssuedInvoice,
  seedOrg,
  type TestDb,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { handleWebhook } from "../http/webhook-route.ts";
import { signSim } from "../ledger/bank-inbox.ts";
import { balance } from "../ledger/ledger.ts";
import { confirmPayment, customerCredit, recordPayment, reversePayment } from "../payments/payments.ts";
import { executeCommand } from "../pipeline/command.ts";
import { applyBankTransaction } from "./auto-apply.ts";
import {
  confirmMatch,
  getTransferInfo,
  type ImportRowResult,
  importStatement,
  previewMatches,
  resolveBreak,
} from "./reconciliation.ts";

const SECRET = "sim-secret-chi-dung-trong-test-0123456789";
let t: TestDb;
let A: SeededOrg;
let owner: Actor;
let K: Actor;
let F: Actor;
let HK: Actor;
let B1: string;
const rejected: string[] = [];

async function member(role: string): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${membership}, ${A.orgId}, ${user}, ${person}, ${role}, ${role === "accountant"})`.execute(
    t.admin,
  );
  if (role !== "accountant") {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${A.orgId}, ${membership}, ${A.propertyId})`.execute(t.admin);
  }
  return resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
}

async function person(name: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${id}, ${A.orgId}, ${name})`.execute(
    t.admin,
  );
  return id;
}

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3], key = randomUUID()) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "reconciliation.test", idempotencyKey: key, payload: { key }, correlationId: "c-recon" },
    fn,
  );
}

async function ok<T>(p: Promise<Awaited<ReturnType<typeof run<T>>>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

async function fails(p: Promise<{ status: string; problem?: unknown }>) {
  const r = await p;
  if (r.status !== "failed") throw new Error("lẽ ra thất bại");
  return r.problem as { code: string; status: number; payment_id?: string };
}

const invoice = (payer: string, amount: number, memoRef?: string) =>
  seedIssuedInvoice(t.admin, {
    orgId: A.orgId,
    propertyId: A.propertyId,
    payerPersonId: payer,
    lines: [{ amount }],
    ...(memoRef ? { memoRef } : {}),
  });

const ref = (p = "FT") => `${p}${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

function webhookRequest(
  body: Record<string, unknown>,
  opts: { badSig?: boolean; ts?: number; signedFor?: string } = {},
): Request {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = opts.badSig ? "0".repeat(64) : signSim(SECRET, ts, raw, opts.signedFor ?? B1);
  return new Request(`http://localhost/api/v1/webhooks/sim/${B1}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hm-timestamp": ts, "x-hm-signature": sig },
    body: raw,
  });
}

const webhook = (req: Request, account = B1) =>
  handleWebhook("sim", account, req, {
    db: t.runtime,
    simSecret: SECRET,
    onRejected: (reason) => void rejected.push(reason),
  });

const simEvent = (eventId: string, bankRef: string, amount: number, description: string) => ({
  event_id: eventId,
  bank_txn_ref: bankRef,
  amount,
  occurred_at: "2026-10-15T03:00:00Z",
  description,
});

const csv = (...rows: [string, string, string, string][]) =>
  ["Ngày,Mã GD,Nội dung,Số tiền", ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
const MAPPING = { date: "Ngày", ref: "Mã GD", description: "Nội dung", amount: "Số tiền" };

const importCsv = (actor: Actor, text: string) =>
  run(actor, async (ctx) => ({
    data: await importStatement(ctx, { receivingAccountId: B1, csv: text, mapping: MAPPING }),
  }));

async function btId(bankRef: string): Promise<string> {
  const r = await sql<{ id: string }>`
    select id from bank_transactions where receiving_account_id = ${B1} and bank_txn_ref = ${bankRef}`.execute(
    t.admin,
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`không có giao dịch ${bankRef}`);
  return id;
}

async function paymentsOf(bankTransactionId: string) {
  const r = await sql<{
    id: string;
    status: string;
    source: string;
    recorded_by: string | null;
    confirmed_by: string | null;
  }>`
    select id, status, source, recorded_by, confirmed_by from payments where bank_transaction_id = ${bankTransactionId}`.execute(
    t.admin,
  );
  return r.rows;
}

const remaining = async (invoiceId: string) => {
  const r = await sql<{
    r: string;
  }>`select (total - allocated_total)::text as r from invoices where id = ${invoiceId}`.execute(t.admin);
  return Number(r.rows[0]?.r);
};
const credit = (p: string) => t.admin.transaction().execute((trx) => customerCredit(trx, A.orgId, p));

async function breaksOf(bankTransactionId: string) {
  const r = await sql<{
    id: string;
    reason: string;
    status: string;
    assignee: string;
    resolved_payment_id: string | null;
    detail: Record<string, unknown> | null;
  }>`
    select id, reason, status, assignee, resolved_payment_id, detail from reconciliation_breaks
    where bank_transaction_id = ${bankTransactionId} order by created_at`.execute(t.admin);
  return r.rows;
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ đối soát", "rental");
  owner = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  K = await member("accountant");
  F = await member("front_desk");
  HK = await member("housekeeping");
  B1 = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${B1}, ${A.orgId}, ${A.propertyId}, 'VCB', '****5600', '1017595600', 'NGUYEN VAN A')`.execute(
    t.admin,
  );
});

afterAll(async () => {
  await t.drop();
});

describe("S-015 QR chỉ là thông tin chuyển tiền", () => {
  it("số TK, số còn, nội dung CK = mã tham chiếu, chuỗi VietQR hợp lệ; phiếu không đổi", async () => {
    const payer = await person("Người thuê QR");
    const I1 = await invoice(payer, 1_580_000, "HM7Q4K2P");
    const info = await getTransferInfo(t.runtime, K, { invoiceId: I1.invoiceId });
    expect(info).toMatchObject({
      amount_due: 1_580_000,
      memo_ref: "HM7Q4K2P",
      transfer_content: "HM7Q4K2P",
      account: {
        bank_code: "VCB",
        bank_bin: "970436",
        account_number: "1017595600",
        account_name: "NGUYEN VAN A",
      },
    });
    const qr = info.qr_payload as string;
    expect(qr).toContain("0006970436011010175956000208QRIBFTTA");
    expect(qr).toContain("54071580000");
    expect(qr).toContain("0808HM7Q4K2P");
    expect(qr.slice(-4)).toBe(crc16CcittFalse(qr.slice(0, -4)));
    expect(await remaining(I1.invoiceId)).toBe(1_580_000);
    // Lễ tân xem được tiền; buồng phòng không đọc được phiếu (RLS → 404).
    await expect(getTransferInfo(t.runtime, F, { invoiceId: I1.invoiceId })).resolves.toMatchObject({
      amount_due: 1_580_000,
    });
    await expect(getTransferInfo(t.runtime, HK, { invoiceId: I1.invoiceId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getTransferInfo(t.runtime, K, { invoiceId: randomUUID() })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("S-016…S-018 webhook mô phỏng", () => {
  it("S-016: 100 lần cùng payload song song = 1 inbox, 1 giao dịch, 1 thanh toán confirmed, 1 phân bổ; I1 = 0", async () => {
    const payer = await person("Người thuê webhook");
    const I1 = await invoice(payer, 1_580_000);
    const bankRef = ref("SIM");
    const body = simEvent(`E1-${bankRef}`, bankRef, 1_580_000, `CK tien phong ${I1.memoRef}`);
    const responses = await Promise.all(Array.from({ length: 100 }, () => webhook(webhookRequest(body))));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as { duplicate: boolean }[];
    expect(bodies.filter((b) => !b.duplicate)).toHaveLength(1);
    expect(bodies.filter((b) => b.duplicate)).toHaveLength(99);

    const id = await btId(bankRef);
    const c = await sql<{ i: number; o: number }>`
      select (select count(*) from inbox where provider = 'sim' and provider_event_id = ${body.event_id})::int as i,
             (select count(*) from outbox where event_type = 'bank_transaction.received' and aggregate_id = ${id})::int as o`.execute(
      t.admin,
    );
    expect(c.rows[0]).toEqual({ i: 1, o: 1 });
    expect(await paymentsOf(id)).toHaveLength(0); // web chỉ ghi nhận; ghi tiền ở worker

    // pg-boss có thể giao lại: 5 lần song song trong worker → đúng 1 hiệu lực.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => applyBankTransaction(t.worker, A.orgId, id)),
    );
    expect(results.filter((r) => r.outcome === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "skipped")).toHaveLength(4);
    const ps = await paymentsOf(id);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({
      status: "confirmed",
      source: "bank_auto",
      recorded_by: null,
      confirmed_by: null,
    });
    const alloc = await sql<{ n: number; s: string }>`
      select count(*)::int as n, sum(amount)::text as s from payment_allocations where payment_id = ${ps[0]?.id}`.execute(
      t.admin,
    );
    expect(alloc.rows[0]).toEqual({ n: 1, s: "1580000" });
    expect(await remaining(I1.invoiceId)).toBe(0);
    expect(await credit(payer)).toBe(0);
    expect(
      await t.admin
        .transaction()
        .execute((trx) => balance(trx, { orgId: A.orgId, account: "AR", invoiceId: I1.invoiceId })),
    ).toBe(0);
    const audit = await sql<{ actor_type: string }>`
      select actor_type from audit_events where action = 'payment.auto_confirmed' and entity_id = ${ps[0]?.id}`.execute(
      t.admin,
    );
    expect(audit.rows).toEqual([{ actor_type: "worker" }]);
  });

  it("S-016 (đảo): kế toán đảo được thanh toán tự động — phân bổ và thu đều có bút toán ngược", async () => {
    const payer = await person("Người thuê đảo");
    const I = await invoice(payer, 300_000);
    const bankRef = ref("SIM");
    await webhook(webhookRequest(simEvent(`E-${bankRef}`, bankRef, 300_000, I.memoRef)));
    const id = await btId(bankRef);
    const applied = await applyBankTransaction(t.worker, A.orgId, id);
    if (applied.outcome !== "applied") throw new Error(JSON.stringify(applied));
    await ok(
      run(K, async (ctx) => ({
        data: await reversePayment(ctx, { paymentId: applied.paymentId, reason: "Ngân hàng hoàn" }),
      })),
    );
    expect(await remaining(I.invoiceId)).toBe(300_000);
    expect((await paymentsOf(id))[0]?.status).toBe("reversed");
  });

  it("S-017: chữ ký sai hoặc quá hạn → 401, không ghi inbox, có đếm từ chối", async () => {
    const before = rejected.length;
    const bankRef = ref("SIM");
    const body = simEvent(`E-bad-${bankRef}`, bankRef, 100_000, "x");
    const bad = await webhook(webhookRequest(body, { badSig: true }));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID" });
    const old = await webhook(webhookRequest(body, { ts: Math.floor(Date.now() / 1000) - 3600 }));
    expect(old.status).toBe(401);
    // Chữ ký đúng nhưng ký cho tài khoản khác (phát lại sang tài khoản/tổ chức khác) → 401 (review R8).
    const replay = await webhook(webhookRequest(body, { signedFor: randomUUID() }));
    expect(replay.status).toBe(401);
    expect(rejected.length - before).toBe(3);
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from inbox where provider_event_id = ${body.event_id}`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(0);
    // Không phải provider sim / thiếu bí mật → 404 (adapter tắt).
    const off = await handleWebhook("sim", B1, webhookRequest(body), { db: t.runtime, simSecret: undefined });
    expect(off.status).toBe(404);
    expect(
      (await handleWebhook("vcb", B1, webhookRequest(body), { db: t.runtime, simSecret: SECRET })).status,
    ).toBe(404);
  });

  it("S-018: trùng event id khác số tiền → 409 INBOX_HASH_MISMATCH + break HASH_MISMATCH giao owner, không ghi tiền; gửi lại không nhân break", async () => {
    const bankRef = ref("SIM");
    const body = simEvent(`E-h-${bankRef}`, bankRef, 1_580_000, "khong ma");
    expect((await webhook(webhookRequest(body))).status).toBe(200);
    for (let i = 0; i < 2; i++) {
      const r = await webhook(webhookRequest({ ...body, amount: 1_580_001 }));
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ code: "INBOX_HASH_MISMATCH" });
    }
    const id = await btId(bankRef);
    const b = await breaksOf(id);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ reason: "HASH_MISMATCH", status: "open", assignee: A.ownerMembershipId });
    const alarm = await sql<{ n: number }>`
      select count(*)::int as n from outbox where event_type = 'reconciliation.break_opened' and aggregate_id = ${b[0]?.id}`.execute(
      t.admin,
    );
    expect(alarm.rows[0]?.n).toBe(1);
    const bt = await sql<{ amount: string }>`select amount from bank_transactions where id = ${id}`.execute(
      t.admin,
    );
    expect(bt.rows[0]?.amount).toBe("1580000");
    expect(await paymentsOf(id)).toHaveLength(0);
  });

  it("webhook không khớp đúng một phiếu → worker mở break cho kế toán, không ghi tiền", async () => {
    const payer = await person("Người thuê thừa");
    const I = await invoice(payer, 100_000);
    const cases = [
      { amount: 500_000, description: "tien phong", reason: "WRONG_REFERENCE" },
      { amount: 150_000, description: `tra ${I.memoRef}`, reason: "OVERPAID" },
    ];
    for (const c of cases) {
      const bankRef = ref("SIM");
      await webhook(webhookRequest(simEvent(`E-${bankRef}`, bankRef, c.amount, c.description)));
      const id = await btId(bankRef);
      const r = await applyBankTransaction(t.worker, A.orgId, id);
      expect(r).toMatchObject({ outcome: "break", reason: c.reason });
      expect(await paymentsOf(id)).toHaveLength(0);
      const b = await breaksOf(id);
      expect(b).toHaveLength(1);
      expect(b[0]?.assignee).toBe(K.membershipId);
      expect(await applyBankTransaction(t.worker, A.orgId, id)).toEqual({
        outcome: "skipped",
        why: "in_queue",
      });
    }
    expect(await remaining(I.invoiceId)).toBe(100_000);
  });
});

describe("S-019…S-021 sao kê", () => {
  it("S-019: file 5 dòng, 2 dòng đã nhập → 3 mới, 2 đã nhập; dòng không mã dùng hash; nhập lại cả file → toàn bộ đã nhập", async () => {
    const r1 = ref();
    const r2 = ref();
    const r3 = ref();
    const r4 = ref();
    const first = await ok(
      importCsv(K, csv(["01/10/2026", r1, "a", "100.000"], ["01/10/2026", r2, "b", "200.000"])),
    );
    expect(first.counts).toMatchObject({ new: 2, duplicate: 0 });
    const file = csv(
      ["01/10/2026", r1, "a", "100.000"],
      ["01/10/2026", r2, "b", "200.000"],
      ["02/10/2026", r3, "c", "300.000"],
      ["02/10/2026", r4, "d", "400.000"],
      ["03/10/2026 08:15", "", `khong ma ${r4}`, "500.000"],
    );
    const second = await ok(importCsv(K, file));
    expect(second.counts).toMatchObject({ new: 3, duplicate: 2, invalid: 0 });
    expect(second.rows.map((r: ImportRowResult) => r.status)).toEqual([
      "duplicate",
      "duplicate",
      "new",
      "new",
      "new",
    ]);
    const inbox = await sql<{ provider_event_id: string }>`
      select provider_event_id from inbox where provider = 'statement_csv' and account = ${B1}
        and provider_event_id not like 'FT%' and raw->>'description' = ${`khong ma ${r4}`}`.execute(t.admin);
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0]?.provider_event_id).toMatch(/^h:[0-9a-f]{40}$/);
    const again = await ok(importCsv(K, file));
    expect(again.counts).toMatchObject({ new: 0, duplicate: 5 });
    const pays = await sql<{ n: number }>`
      select count(*)::int as n from payments p join bank_transactions b on b.id = p.bank_transaction_id
      where b.bank_txn_ref = any(${[r1, r2, r3, r4]}::text[])`.execute(t.admin);
    expect(pays.rows[0]?.n).toBe(0);
  });

  it("S-019 (quyền, đầu vào): lễ tân không nhập sao kê/xem gợi ý; ánh xạ sai → 422", async () => {
    expect(await fails(importCsv(F, csv(["01/10/2026", ref(), "a", "1"])))).toMatchObject({ status: 403 });
    await expect(previewMatches(t.runtime, F, { propertyId: A.propertyId })).rejects.toMatchObject({
      status: 403,
    });
    const badMap = await fails(
      run(K, async (ctx) => ({
        data: await importStatement(ctx, {
          receivingAccountId: B1,
          csv: csv(["01/10/2026", ref(), "a", "1"]),
          mapping: { date: "Không có cột", description: "Nội dung", amount: "Số tiền" },
        }),
      })),
    );
    expect(badMap).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    const big = await fails(importCsv(K, csv(["01/10/2026", ref(), "đ".repeat(1_100_000), "1"])));
    expect(big).toMatchObject({ code: "FILE_TOO_LARGE", status: 413 });
  });

  it("S-020/S-021: (a) khớp, (b) WRONG_REFERENCE, (c) COMBINED, (d) OVERPAID — không ghi tiền trước khi xác nhận; trả hộ đóng break", async () => {
    const L1 = await person("Người thuê L1");
    const L2 = await person("Người thuê L2");
    const I1 = await invoice(L1, 1_580_000);
    const I2 = await invoice(L2, 930_000);
    const I3 = await invoice(L1, 500_000);
    const [ra, rb, rc, rd] = [ref(), ref(), ref(), ref()];
    const res = await ok(
      importCsv(
        K,
        csv(
          ["05/10/2026", ra, `TT ${I1.memoRef}`, "1.580.000"],
          ["05/10/2026", rb, "tien phong", "500.000"],
          ["05/10/2026", rc, `${I1.memoRef} va ${I2.memoRef}`, "2.510.000"],
          ["05/10/2026", rd, `phong ${I1.memoRef}`, "2.000.000"],
        ),
      ),
    );
    const rows = res.rows as ImportRowResult[];
    expect(rows.map((r) => [r.status, r.suggestion?.status, r.suggestion?.reason])).toEqual([
      ["new", "match", null],
      ["new", "break", "WRONG_REFERENCE"],
      ["new", "break", "COMBINED"],
      ["new", "break", "OVERPAID"],
    ]);
    expect(rows[0]?.break_id).toBeUndefined();
    expect(rows[3]?.suggestion).toMatchObject({
      allocations: [{ invoiceId: I1.invoiceId, amount: 1_580_000 }],
      credit: 420_000,
    });
    const ids = await Promise.all([ra, rb, rc, rd].map(btId));
    const money = await sql<{ p: number; j: number }>`
      select (select count(*) from payments where bank_transaction_id = any(${ids}::uuid[]))::int as p,
             (select count(*) from journal_lines where receiving_account_id = ${B1}
                and entry_id in (select id from journal_entries where source_doc_id = any(${ids}::uuid[])))::int as j`.execute(
      t.admin,
    );
    expect(money.rows[0]).toEqual({ p: 0, j: 0 });
    const preview = await previewMatches(t.runtime, K, {
      propertyId: A.propertyId,
      receivingAccountId: B1,
      limit: 500,
    });
    const byId = new Map(preview.map((p) => [p.bank_transaction_id, p]));
    expect(byId.get(ids[1] as string)?.open_breaks.map((b) => b.reason)).toEqual(["WRONG_REFERENCE"]);
    expect(byId.get(ids[2] as string)?.suggestion.reason).toBe("COMBINED");
    expect(byId.get(ids[0] as string)?.open_breaks).toEqual([]);

    // S-021: (b) gán cho phiếu của L1, người khác trả hộ, có ghi chú.
    const noNote = await fails(
      run(K, async (ctx) => ({
        data: await confirmMatch(ctx, {
          bankTransactionId: ids[1] as string,
          allocations: [{ invoiceId: I3.invoiceId, amount: 500_000 }],
          thirdPartyPayer: true,
        }),
      })),
    );
    expect(noNote).toMatchObject({ code: "VALIDATION_FAILED" });
    const m = await ok(
      run(K, async (ctx) => ({
        data: await confirmMatch(ctx, {
          bankTransactionId: ids[1] as string,
          allocations: [{ invoiceId: I3.invoiceId, amount: 500_000 }],
          thirdPartyPayer: true,
          note: "Mẹ của L1 chuyển hộ",
        }),
      })),
    );
    expect(m.unallocated).toBe(0);
    expect(await remaining(I3.invoiceId)).toBe(0);
    const p = await sql<{ status: string; evidence_kind: string; evidence_id: string; recorded_by: string }>`
      select status, evidence_kind, evidence_id, recorded_by from payments where id = ${m.paymentId}`.execute(
      t.admin,
    );
    expect(p.rows[0]).toEqual({
      status: "confirmed",
      evidence_kind: "bank_transaction",
      evidence_id: ids[1],
      recorded_by: K.membershipId,
    });
    const b = await breaksOf(ids[1] as string);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      reason: "THIRD_PARTY_PAYER",
      status: "resolved",
      resolved_payment_id: m.paymentId,
      detail: expect.objectContaining({ original_reason: "WRONG_REFERENCE" }),
    });
    const audit = await sql<{ reason: string }>`
      select reason from audit_events where action = 'reconciliation.matched' and entity_id = ${ids[1]}`.execute(
      t.admin,
    );
    expect(audit.rows).toEqual([{ reason: "Mẹ của L1 chuyển hộ" }]);

    // (d) trả thừa: 1.580.000 vào I1 + 420.000 vào CUSTOMER_CREDIT của L1.
    const d = await ok(
      run(K, async (ctx) => ({
        data: await confirmMatch(ctx, {
          bankTransactionId: ids[3] as string,
          allocations: [{ invoiceId: I1.invoiceId, amount: 1_580_000 }],
        }),
      })),
    );
    expect(d.unallocated).toBe(420_000);
    expect(await remaining(I1.invoiceId)).toBe(0);
    expect(await credit(L1)).toBe(420_000);
    expect((await breaksOf(ids[3] as string))[0]).toMatchObject({ reason: "OVERPAID", status: "resolved" });

    // Một giao dịch một payment (INV-F4b): xác nhận lại → 409 kèm payment_id.
    const again = await fails(
      run(K, async (ctx) => ({
        data: await confirmMatch(ctx, {
          bankTransactionId: ids[3] as string,
          allocations: [],
          payerPersonId: L1,
        }),
      })),
    );
    expect(again).toMatchObject({
      code: "BANK_TRANSACTION_ALREADY_USED",
      status: 409,
      payment_id: d.paymentId,
    });
    // Lễ tân không xác nhận ghép.
    const fd = await fails(
      run(F, async (ctx) => ({
        data: await confirmMatch(ctx, {
          bankTransactionId: ids[2] as string,
          allocations: [],
          payerPersonId: L1,
        }),
      })),
    );
    expect(fd.status).toBe(403);
  });
});

describe("S-029/S-030 một giao dịch ngân hàng = một payment (INV-F4b)", () => {
  it("S-029: nhập tay kèm FT rồi import cùng sao kê → dòng đó 'đã nhập', không payment/credit thứ hai; record lặp → 409", async () => {
    const payer = await person("Người thuê S-029");
    const I1 = await invoice(payer, 3_580_000);
    const ft = ref();
    const { paymentId } = await ok(
      run(K, async (ctx) => ({
        data: await recordPayment(ctx, {
          propertyId: A.propertyId,
          method: "bank_transfer",
          amount: 2_000_000,
          payerPersonId: payer,
          receivingAccountId: B1,
          bankTxn: { ref: ft, occurredAt: "2026-10-15T09:41:00+07:00" },
        }),
      })),
    );
    await ok(run(K, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) })));
    const res = await ok(
      importCsv(
        K,
        csv(
          ["15/10/2026", ft, `TT ${I1.memoRef}`, "2.000.000"],
          ["15/10/2026", ref(), "x", "1.000"],
          ["15/10/2026", ref(), "y", "2.000"],
        ),
      ),
    );
    expect(res.counts).toMatchObject({ duplicate: 1, new: 2, hash_mismatch: 0 });
    expect(await paymentsOf(await btId(ft))).toHaveLength(1);
    expect(await credit(payer)).toBe(2_000_000);
    const dup = await fails(
      run(K, async (ctx) => ({
        data: await recordPayment(ctx, {
          propertyId: A.propertyId,
          method: "bank_transfer",
          amount: 2_000_000,
          payerPersonId: payer,
          receivingAccountId: B1,
          bankTxn: { ref: ft, occurredAt: "2026-10-15T02:41:00Z" },
        }),
      })),
    );
    expect(dup).toMatchObject({ code: "BANK_TRANSACTION_ALREADY_USED", payment_id: paymentId });
  });

  it("S-030: webhook rồi sao kê; sao kê rồi webhook; cùng mã khác số tiền → HASH_MISMATCH", async () => {
    const payer = await person("Người thuê S-030");
    const I2 = await invoice(payer, 500_000);
    const I3 = await invoice(payer, 700_000);
    const sim2 = ref("SIM");
    const sim3 = ref("SIM");
    // Ca 1: webhook E2 đã xử lý → sao kê cùng giao dịch = "đã nhập", vẫn 1 payment.
    await webhook(webhookRequest(simEvent(`E2-${sim2}`, sim2, 500_000, I2.memoRef)));
    const id2 = await btId(sim2);
    expect((await applyBankTransaction(t.worker, A.orgId, id2)).outcome).toBe("applied");
    const c1 = await ok(importCsv(K, csv(["15/10/2026", sim2, I2.memoRef, "500.000"])));
    expect(c1.counts).toMatchObject({ duplicate: 1, new: 0 });
    expect(await paymentsOf(id2)).toHaveLength(1);

    // Ca 2: sao kê SIM00003 trước, webhook E3 sau → 200, inbox gắn vào giao dịch có sẵn; tổng 1 payment.
    const c2 = await ok(importCsv(K, csv(["15/10/2026", sim3, I3.memoRef, "700.000"])));
    expect(c2.counts).toMatchObject({ new: 1 });
    const id3 = await btId(sim3);
    const w = await webhook(webhookRequest(simEvent(`E3-${sim3}`, sim3, 700_000, I3.memoRef)));
    expect(w.status).toBe(200);
    expect(await w.json()).toMatchObject({ duplicate: true });
    const inbox = await sql<{ bank_transaction_id: string }>`
      select bank_transaction_id from inbox where provider = 'sim' and provider_event_id = ${`E3-${sim3}`}`.execute(
      t.admin,
    );
    expect(inbox.rows[0]?.bank_transaction_id).toBe(id3);
    await applyBankTransaction(t.worker, A.orgId, id3);
    await applyBankTransaction(t.worker, A.orgId, id3);
    expect(await paymentsOf(id3)).toHaveLength(1);
    expect(await remaining(I3.invoiceId)).toBe(0);

    // Ca 3: dòng sao kê cùng mã SIM00002 nhưng 600.000 → break HASH_MISMATCH, không ghi tiền; chặn xác nhận ghép.
    const c3 = await ok(importCsv(K, csv(["15/10/2026", sim2, "lech", "600.000"])));
    expect(c3.counts).toMatchObject({ hash_mismatch: 1 });
    const hm = (await breaksOf(id2)).filter((b) => b.reason === "HASH_MISMATCH");
    expect(hm).toHaveLength(1);
    expect(hm[0]).toMatchObject({ status: "open", assignee: A.ownerMembershipId });
    expect(await paymentsOf(id2)).toHaveLength(1);
  });
});

describe("hàng rào CSDL và đóng break", () => {
  it("web runtime không ghi được thanh toán tự động; worker không ghi khi thiếu webhook đã xác minh", async () => {
    const payer = await person("Người thuê rào");
    const Ix = await invoice(payer, 10_000);
    const r = ref();
    await ok(importCsv(K, csv(["15/10/2026", r, Ix.memoRef, "10.000"]))); // khớp → không vào hàng chờ
    const id = await btId(r); // chỉ có sao kê
    const w = ref("SIM");
    await webhook(webhookRequest(simEvent(`E-${w}`, w, 10_000, "khong ma")));
    const verified = await btId(w); // có webhook đã xác minh
    const insert = (db: typeof t.runtime, recordedBy: string | null, bt = verified) =>
      db.transaction().execute(async (trx) => {
        await sql`select set_config('app.org_id', ${A.orgId}, true)`.execute(trx);
        if (recordedBy) await sql`select set_config('app.actor_id', ${recordedBy}, true)`.execute(trx);
        await sql`
          insert into payments (id, organization_id, property_id, method, purpose, status, amount, receiving_account_id,
                                payer_person_id, bank_transaction_id, evidence_kind, evidence_id, business_date, source,
                                confirmed_at, recorded_by)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, 'bank_transfer', 'receivable', 'confirmed', 10000, ${B1},
                  ${payer}, ${bt}, 'bank_transaction', ${bt}, current_date, 'bank_auto', now(), ${recordedBy})`.execute(
          trx,
        );
      });
    await expect(insert(t.runtime, null)).rejects.toMatchObject({ code: "42501" }); // RLS
    await expect(insert(t.runtime, K.membershipId)).rejects.toThrow(); // CHECK nguồn/người lập
    await expect(insert(t.worker, null, id)).rejects.toMatchObject({ hint: "EVIDENCE_REQUIRED" });
    expect(await applyBankTransaction(t.worker, A.orgId, id)).toEqual({
      outcome: "skipped",
      why: "not_verified",
    });
    expect(await paymentsOf(id)).toHaveLength(0);
    expect(await paymentsOf(verified)).toHaveLength(0);
  });

  it("đóng break bắt buộc lý do, chỉ một lần; HASH_MISMATCH chặn xác nhận ghép tới khi đóng", async () => {
    const payer = await person("Người thuê break");
    const I = await invoice(payer, 50_000);
    const r = ref();
    await ok(importCsv(K, csv(["15/10/2026", r, I.memoRef, "50.000"])));
    await ok(importCsv(K, csv(["15/10/2026", r, I.memoRef, "60.000"])));
    const id = await btId(r);
    const [hm] = await breaksOf(id);
    const blocked = await fails(
      run(K, async (ctx) => ({
        data: await confirmMatch(ctx, {
          bankTransactionId: id,
          allocations: [{ invoiceId: I.invoiceId, amount: 50_000 }],
        }),
      })),
    );
    expect(blocked).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
    const empty = await fails(
      run(K, async (ctx) => ({
        data: await resolveBreak(ctx, { breakId: hm?.id as string, resolution: "  " }),
      })),
    );
    expect(empty).toMatchObject({ code: "VALIDATION_FAILED" });
    await ok(
      run(owner, async (ctx) => ({
        data: await resolveBreak(ctx, {
          breakId: hm?.id as string,
          resolution: "Đã gọi ngân hàng: 50.000 là đúng",
        }),
      })),
    );
    const twice = await fails(
      run(K, async (ctx) => ({
        data: await resolveBreak(ctx, { breakId: hm?.id as string, resolution: "lại" }),
      })),
    );
    expect(twice).toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(
      sql`update reconciliation_breaks set status = 'open', resolution = null, resolved_by = null, resolved_at = null
          where id = ${hm?.id}`.execute(t.admin),
    ).rejects.toMatchObject({ hint: "INVALID_TRANSITION" });
    await ok(
      run(K, async (ctx) => ({
        data: await confirmMatch(ctx, {
          bankTransactionId: id,
          allocations: [{ invoiceId: I.invoiceId, amount: 50_000 }],
        }),
      })),
    );
    expect(await remaining(I.invoiceId)).toBe(0);
  });
});
