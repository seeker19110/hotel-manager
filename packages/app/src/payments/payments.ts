// Thanh toán và phân bổ (PLAN đợt 2 T-105; SPEC-ledger S-001…S-010, S-025…S-029; INV-F2, INV-F3, INV-F3b, INV-F4b, INV-G4).
// Bút toán (DOMAIN-MODEL §5): xác nhận thu  Nợ CASH|BANK / Có CUSTOMER_CREDIT (người trả);
//                            phân bổ       Nợ CUSTOMER_CREDIT (người trả) / Có AR (phiếu);
//                            đảo           bút toán ngược có reverses_entry_id, bản gốc giữ nguyên.
// Phần chưa phân bổ của một khoản thu nằm ở CUSTOMER_CREDIT của người trả (trả thừa, S-007).
import { randomUUID } from "node:crypto";
import { authorize } from "@hm/domain";
import { sql, type Transaction } from "kysely";
import { bankTxnHash } from "../ledger/bank-inbox.ts";
import { postEntry, reverseEntry } from "../ledger/ledger.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";
import { openShiftOf } from "../shifts/shifts.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PaymentMethod = "cash" | "bank_transfer";

function assertMoney(n: number, field: string): void {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CommandError("VALIDATION_FAILED", 422, `${field} phải là số nguyên đồng dương`);
  }
}

async function businessDate(trx: Transaction<unknown>, orgId: string, propertyId: string): Promise<string> {
  const r = await sql<{ d: string }>`select app.business_date(${orgId}, ${propertyId})::text as d`.execute(
    trx,
  );
  const d = r.rows[0]?.d;
  if (!d) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  return d;
}

/** Dòng giao dịch ngân hàng nhập tay (mã giao dịch trên sao kê) — quy về `bank_transactions` (INV-F4b). */
export interface ManualBankTxn {
  ref: string;
  occurredAt: string;
  description?: string;
}

async function upsertManualBankTxn(
  ctx: CommandContext,
  input: { propertyId: string; receivingAccountId: string; amount: number; txn: ManualBankTxn },
): Promise<string> {
  const ref = input.txn.ref.trim();
  if (!ref || ref.length > 100)
    throw new CommandError("VALIDATION_FAILED", 422, "Mã giao dịch ngân hàng không hợp lệ");
  const occurred = new Date(input.txn.occurredAt);
  if (Number.isNaN(occurred.getTime()))
    throw new CommandError("VALIDATION_FAILED", 422, "Thời điểm giao dịch không hợp lệ");
  // Cùng dấu vân tay với webhook/sao kê (bankTxnHash) để nguồn sau nhận ra cùng giao dịch (S-029).
  const rawHash = bankTxnHash(ref, input.amount);
  await sql`
    insert into bank_transactions (id, organization_id, property_id, receiving_account_id, bank_txn_ref, amount, occurred_at,
                                   description, first_source, raw_hash)
    values (${randomUUID()}, ${ctx.actor.orgId}, ${input.propertyId}, ${input.receivingAccountId}, ${ref}, ${input.amount},
            ${occurred.toISOString()}, ${input.txn.description ?? null}, 'manual', ${rawHash})
    on conflict (receiving_account_id, bank_txn_ref) do nothing`.execute(ctx.trx);
  const r = await sql<{ id: string; amount: string; property_id: string }>`
    select id, amount, property_id from bank_transactions
    where organization_id = ${ctx.actor.orgId} and receiving_account_id = ${input.receivingAccountId} and bank_txn_ref = ${ref}`.execute(
    ctx.trx,
  );
  const row = r.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy giao dịch ngân hàng");
  if (Number(row.amount) !== input.amount || row.property_id !== input.propertyId) {
    throw new CommandError(
      "VALIDATION_FAILED",
      422,
      "Số tiền/cơ sở không khớp giao dịch ngân hàng đã ghi nhận",
    );
  }
  return row.id;
}

/**
 * Trước khi dùng một giao dịch ngân hàng làm chứng cứ: cùng khoá tư vấn với đối soát/worker (`bank_txn:<id>`) để người và
 * máy không đua; giao dịch đang lệch nội dung giữa các nguồn (break HASH_MISMATCH mở) thì không ghi tiền (review 🟢10).
 */
async function guardBankTxn(ctx: CommandContext, bankTransactionId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`bank_txn:${bankTransactionId}`}, 0))`.execute(
    ctx.trx,
  );
  const broken = await sql<{ id: string }>`
    select id from reconciliation_breaks
    where organization_id = ${ctx.actor.orgId} and bank_transaction_id = ${bankTransactionId} and status = 'open'
      and reason = 'HASH_MISMATCH'`.execute(ctx.trx);
  if (broken.rows.length > 0) {
    throw new CommandError(
      "INVALID_TRANSITION",
      409,
      "Giao dịch đang lệch nội dung giữa các nguồn — xử lý đối soát trước",
    );
  }
}

async function assertBankTxnUnused(ctx: CommandContext, bankTransactionId: string): Promise<void> {
  await guardBankTxn(ctx, bankTransactionId);
  const used = await sql<{ id: string }>`
    select id from payments where organization_id = ${ctx.actor.orgId} and bank_transaction_id = ${bankTransactionId}`.execute(
    ctx.trx,
  );
  const existing = used.rows[0]?.id;
  if (existing) {
    throw new CommandError("BANK_TRANSACTION_ALREADY_USED", 409, "Giao dịch ngân hàng này đã được ghi nhận", {
      extensions: { payment_id: existing },
    });
  }
}

export interface RecordPaymentInput {
  propertyId: string;
  method: PaymentMethod;
  amount: number;
  payerPersonId: string;
  receivingAccountId?: string;
  bankTxn?: ManualBankTxn;
  /** Dùng nội bộ (deposit.receive, T-106). */
  purpose?: "receivable" | "deposit";
  depositId?: string;
}

/** `payment.record`: ghi khoản thu `pending` (chưa ghi sổ). */
export async function recordPayment(
  ctx: CommandContext,
  input: RecordPaymentInput,
): Promise<{ paymentId: string }> {
  assertMoney(input.amount, "Số tiền");
  authorize(ctx.actor, input.purpose === "deposit" ? "deposit.receive" : "payment.record", {
    propertyId: input.propertyId,
  });
  if (!UUID.test(input.payerPersonId))
    throw new CommandError("VALIDATION_FAILED", 422, "Người trả không hợp lệ");
  let shiftId: string | null = null;
  let receivingAccountId: string | null = null;
  let bankTransactionId: string | null = null;
  if (input.method === "cash") {
    if (input.receivingAccountId || input.bankTxn) {
      throw new CommandError(
        "VALIDATION_FAILED",
        422,
        "Tiền mặt không kèm tài khoản nhận/giao dịch ngân hàng",
      );
    }
    shiftId = await openShiftOf(ctx.trx, ctx.actor.orgId, ctx.actor.membershipId, input.propertyId);
    if (!shiftId) throw new CommandError("SHIFT_NOT_OPEN", 409, "Mở ca trước khi nhận tiền mặt");
  } else {
    if (!input.receivingAccountId || !UUID.test(input.receivingAccountId)) {
      throw new CommandError("VALIDATION_FAILED", 422, "Chuyển khoản cần tài khoản nhận");
    }
    receivingAccountId = input.receivingAccountId;
    if (input.bankTxn) {
      bankTransactionId = await upsertManualBankTxn(ctx, {
        propertyId: input.propertyId,
        receivingAccountId,
        amount: input.amount,
        txn: input.bankTxn,
      });
      await assertBankTxnUnused(ctx, bankTransactionId);
    }
  }
  const id = randomUUID();
  await sql`
    insert into payments (id, organization_id, property_id, method, purpose, amount, receiving_account_id, payer_person_id,
                          deposit_id, shift_id, bank_transaction_id, business_date, recorded_by, command_id)
    values (${id}, ${ctx.actor.orgId}, ${input.propertyId}, ${input.method}, ${input.purpose ?? "receivable"}, ${input.amount},
            ${receivingAccountId}, ${input.payerPersonId}, ${input.depositId ?? null}, ${shiftId}, ${bankTransactionId},
            ${await businessDate(ctx.trx, ctx.actor.orgId, input.propertyId)}::date, ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(
    ctx.trx,
  );
  await ctx.audit({
    action: "payment.recorded",
    entityType: "payment",
    entityId: id,
    propertyId: input.propertyId,
    after: { method: input.method, amount: input.amount, purpose: input.purpose ?? "receivable" },
  });
  return { paymentId: id };
}

interface PaymentRow {
  id: string;
  property_id: string;
  method: PaymentMethod;
  purpose: "receivable" | "deposit";
  status: "pending" | "confirmed" | "reversed";
  amount: string;
  allocated_total: string;
  receiving_account_id: string | null;
  payer_person_id: string;
  deposit_id: string | null;
  shift_id: string | null;
  bank_transaction_id: string | null;
  /** NULL: thanh toán hệ thống ghi từ webhook đã xác minh (source = bank_auto, T-107). */
  recorded_by: string | null;
  recorder_person_id: string | null;
  business_date: string;
}

/**
 * Đọc thanh toán (RLS: vai trò tiền thấy trong phạm vi), kiểm quyền bằng `check`, rồi mới khoá FOR UPDATE — người không có
 * quyền ghi nhận 403 đúng SPEC (S-028) thay vì 404, và chỉ người có quyền giữ khoá.
 */
export async function lockPayment(
  ctx: CommandContext,
  paymentId: string,
  check: (row: PaymentRow) => void = () => {},
): Promise<PaymentRow> {
  if (!UUID.test(paymentId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy thanh toán");
  const read = (lock: boolean) =>
    sql<PaymentRow>`
    select p.id, p.property_id, p.method, p.purpose, p.status, p.amount, p.allocated_total, p.receiving_account_id,
           p.payer_person_id, p.deposit_id, p.shift_id, p.bank_transaction_id, p.recorded_by, m.person_id as recorder_person_id,
           p.business_date::text as business_date
    from payments p left join memberships m on m.organization_id = p.organization_id and m.id = p.recorded_by
    where p.organization_id = ${ctx.actor.orgId} and p.id = ${paymentId}
    ${lock ? sql`for update of p` : sql``}`.execute(ctx.trx);
  const seen = (await read(false)).rows[0];
  if (!seen) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy thanh toán");
  check(seen);
  const row = (await read(true)).rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy thanh toán");
  return row;
}

/** Mutex theo chủ số dư CUSTOMER_CREDIT (phân bổ và hoàn cùng khoá). */
export async function lockPerson(trx: Transaction<unknown>, orgId: string, personId: string): Promise<void> {
  await sql`select id from persons where organization_id = ${orgId} and id = ${personId} for update`.execute(
    trx,
  );
}

/**
 * Ca còn mở — giữ khoá FOR SHARE tới hết transaction: đóng ca (FOR UPDATE) chờ lệnh ghi CASH này xong rồi mới tính tiền
 * dự kiến; ca vừa đóng thì điều kiện `status = 'open'` được đánh giá lại sau khi chờ ⇒ false (review lát tiền R3, INV-F6).
 */
async function shiftIsOpen(ctx: CommandContext, shiftId: string): Promise<boolean> {
  const r = await sql<{ id: string }>`
    select id from shifts where organization_id = ${ctx.actor.orgId} and id = ${shiftId} and status = 'open'
    for share`.execute(ctx.trx);
  return r.rows.length > 0;
}

export interface ConfirmEvidence {
  /** Chuyển khoản: giao dịch ngân hàng đã có (từ webhook/sao kê) hoặc dòng sao kê nhập tay. */
  bankTransactionId?: string;
  bankTxn?: ManualBankTxn;
}

/**
 * `payment.confirm` (INV-F3/F3b): tiền mặt — người nhận tự xác nhận trong ca đang mở (lễ tân chỉ khoản của mình) hoặc
 * owner/manager/kế toán; biên nhận do hệ thống đánh số. Chuyển khoản — bắt buộc giao dịch ngân hàng làm chứng cứ.
 */
export async function confirmPayment(
  ctx: CommandContext,
  input: { paymentId: string; evidence?: ConfirmEvidence },
): Promise<{ paymentId: string; receiptNo: string | null; entryId: string }> {
  const p = await lockPayment(ctx, input.paymentId, (row) =>
    row.method === "cash"
      ? authorize(ctx.actor, "payment.confirm_cash", {
          propertyId: row.property_id,
          ...(row.recorder_person_id ? { subjectPersonId: row.recorder_person_id } : {}),
        })
      : authorize(ctx.actor, "payment.confirm_transfer", { propertyId: row.property_id }),
  );
  if (p.status !== "pending") throw new CommandError("INVALID_TRANSITION", 409, `Thanh toán đã ${p.status}`);
  let receiptNo: string | null = null;
  let bankTransactionId = p.bank_transaction_id;
  let evidenceKind: "cash_receipt" | "bank_transaction";
  let evidenceId: string;
  if (p.method === "cash") {
    if (!p.shift_id || !(await shiftIsOpen(ctx, p.shift_id))) {
      throw new CommandError("SHIFT_NOT_OPEN", 409, "Ca nhận tiền đã đóng");
    }
    const n = await sql<{
      n: string;
    }>`select app.next_number(${ctx.actor.orgId}, ${p.property_id}, 'receipt')::text as n`.execute(ctx.trx);
    receiptNo = `PT-${String(n.rows[0]?.n).padStart(6, "0")}`;
    evidenceKind = "cash_receipt";
    evidenceId = p.id;
  } else {
    if (!bankTransactionId && input.evidence?.bankTxn) {
      bankTransactionId = await upsertManualBankTxn(ctx, {
        propertyId: p.property_id,
        receivingAccountId: p.receiving_account_id as string,
        amount: Number(p.amount),
        txn: input.evidence.bankTxn,
      });
    } else if (!bankTransactionId && input.evidence?.bankTransactionId) {
      if (!UUID.test(input.evidence.bankTransactionId))
        throw new CommandError("NOT_FOUND", 404, "Không tìm thấy giao dịch");
      const b = await sql<{ id: string; amount: string; receiving_account_id: string }>`
        select id, amount, receiving_account_id from bank_transactions
        where organization_id = ${ctx.actor.orgId} and id = ${input.evidence.bankTransactionId}`.execute(
        ctx.trx,
      );
      const row = b.rows[0];
      if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy giao dịch ngân hàng");
      if (Number(row.amount) !== Number(p.amount) || row.receiving_account_id !== p.receiving_account_id) {
        throw new CommandError(
          "VALIDATION_FAILED",
          422,
          "Giao dịch ngân hàng không khớp số tiền/tài khoản nhận",
        );
      }
      bankTransactionId = row.id;
    }
    if (!bankTransactionId) {
      throw new CommandError(
        "EVIDENCE_REQUIRED",
        422,
        "Cần chứng cứ: giao dịch trên sao kê/ngân hàng (INV-F3)",
      );
    }
    if (bankTransactionId !== p.bank_transaction_id) await assertBankTxnUnused(ctx, bankTransactionId);
    else await guardBankTxn(ctx, bankTransactionId);
    evidenceKind = "bank_transaction";
    evidenceId = bankTransactionId;
  }
  const entryId = await postEntry(ctx.trx, {
    orgId: ctx.actor.orgId,
    propertyId: p.property_id,
    entryType: p.purpose === "deposit" ? "deposit_received" : "payment_confirmed",
    // Ghi sổ theo ngày XÁC NHẬN (có chứng cứ): khoản ghi nhận hôm trước mà kỳ đã khoá vẫn xác nhận được (review R2).
    businessDate: await businessDate(ctx.trx, ctx.actor.orgId, p.property_id),
    // Nguồn luôn là chính khoản thu (một cọc có thể nhận nhiều lần; đảo tìm đúng bút toán của khoản này).
    sourceDocType: "payment",
    sourceDocId: p.id,
    createdBy: ctx.actor.membershipId,
    commandId: ctx.commandId,
    lines: [
      p.method === "cash"
        ? { account: "CASH", debit: Number(p.amount), credit: 0, shiftId: p.shift_id as string }
        : {
            account: "BANK",
            debit: Number(p.amount),
            credit: 0,
            receivingAccountId: p.receiving_account_id as string,
          },
      p.purpose === "deposit"
        ? { account: "DEPOSIT_LIAB", debit: 0, credit: Number(p.amount), depositId: p.deposit_id as string }
        : { account: "CUSTOMER_CREDIT", debit: 0, credit: Number(p.amount), personId: p.payer_person_id },
    ],
  });
  await sql`
    update payments set status = 'confirmed', confirmed_by = ${ctx.actor.membershipId}, confirmed_at = now(),
           evidence_kind = ${evidenceKind}, evidence_id = ${evidenceId}, bank_transaction_id = ${bankTransactionId},
           receipt_no = ${receiptNo}, version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${p.id}`.execute(ctx.trx);
  if (p.purpose === "deposit") {
    await sql`
      update deposits set amount = amount + ${Number(p.amount)}, version = version + 1
      where organization_id = ${ctx.actor.orgId} and id = ${p.deposit_id}`.execute(ctx.trx);
  }
  await ctx.audit({
    action: "payment.confirmed",
    entityType: "payment",
    entityId: p.id,
    propertyId: p.property_id,
    before: { status: "pending" },
    after: { status: "confirmed", evidence_kind: evidenceKind, receipt_no: receiptNo, entry_id: entryId },
  });
  await ctx.emit({
    eventType: "payment.confirmed",
    aggregateType: "payment",
    aggregateId: p.id,
    propertyId: p.property_id,
    payload: { payment_id: p.id, amount: Number(p.amount), method: p.method },
  });
  return { paymentId: p.id, receiptNo, entryId };
}

export interface AllocationInput {
  invoiceId: string;
  amount: number;
}

/**
 * `payment.allocate` (INV-F2): Σ phân bổ ≤ phần chưa phân bổ của khoản thu, mỗi phiếu ≤ số còn. Khoá thanh toán rồi
 * khoá các phiếu theo id tăng dần (không deadlock khi nhiều người phân bổ đồng thời); bộ đếm + CHECK ở CSDL là hàng rào
 * cuối.
 */
export async function allocatePayment(
  ctx: CommandContext,
  input: { paymentId: string; allocations: readonly AllocationInput[] },
): Promise<{ entryId: string; allocationIds: string[]; unallocated: number }> {
  if (input.allocations.length === 0)
    throw new CommandError("VALIDATION_FAILED", 422, "Cần ít nhất một dòng phân bổ");
  const seen = new Set<string>();
  for (const a of input.allocations) {
    if (!UUID.test(a.invoiceId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
    if (seen.has(a.invoiceId))
      throw new CommandError("VALIDATION_FAILED", 422, "Mỗi phiếu chỉ một dòng phân bổ");
    seen.add(a.invoiceId);
    assertMoney(a.amount, "Số tiền phân bổ");
  }
  const sum = input.allocations.reduce((s, a) => s + a.amount, 0);
  const p = await lockPayment(ctx, input.paymentId, (row) =>
    authorize(ctx.actor, "payment.allocate", { propertyId: row.property_id, amount: sum }),
  );
  if (p.status !== "confirmed" || p.purpose !== "receivable") {
    throw new CommandError("INVALID_TRANSITION", 409, "Chỉ phân bổ khoản thu đã xác nhận");
  }
  const remaining = Number(p.amount) - Number(p.allocated_total);
  if (sum > remaining) {
    throw new CommandError(
      "OVER_ALLOCATION",
      409,
      `Phân bổ ${sum} vượt số chưa phân bổ ${remaining} của khoản thu`,
    );
  }
  // Phần chưa phân bổ nằm ở CUSTOMER_CREDIT của người trả và có thể đã được hoàn (credit.requestRefund): kiểm số dư thật
  // dưới cùng mutex `persons` với lệnh hoàn, để không phân bổ tiền đã trả lại khách (review lát tiền R1).
  await lockPerson(ctx.trx, ctx.actor.orgId, p.payer_person_id);
  const credit = await customerCredit(ctx.trx, ctx.actor.orgId, p.payer_person_id, p.property_id);
  if (sum > credit) {
    throw new CommandError(
      "OVER_ALLOCATION",
      409,
      `Phân bổ ${sum} vượt số dư khách ${credit} (đã hoàn một phần?)`,
    );
  }
  const ids = [...seen].sort();
  const inv = await sql<{
    id: string;
    property_id: string;
    open_amount: string;
    payer_person_id: string;
  }>`
    select id, property_id, open_amount, payer_person_id from invoices
    where organization_id = ${ctx.actor.orgId} and id = any(${ids}::uuid[])
    order by id
    for update`.execute(ctx.trx);
  const byId = new Map(inv.rows.map((r) => [r.id, r]));
  for (const a of input.allocations) {
    const i = byId.get(a.invoiceId);
    if (!i || i.property_id !== p.property_id)
      throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
    const open = Number(i.open_amount);
    if (a.amount > open) {
      throw new CommandError("OVER_ALLOCATION", 409, `Phân bổ ${a.amount} vượt số còn ${open} của phiếu`);
    }
  }
  const entryId = await postEntry(ctx.trx, {
    orgId: ctx.actor.orgId,
    propertyId: p.property_id,
    entryType: "payment_allocated",
    businessDate: await businessDate(ctx.trx, ctx.actor.orgId, p.property_id),
    sourceDocType: "payment_allocation",
    sourceDocId: p.id,
    createdBy: ctx.actor.membershipId,
    commandId: ctx.commandId,
    lines: [
      { account: "CUSTOMER_CREDIT", debit: sum, credit: 0, personId: p.payer_person_id },
      ...input.allocations.map((a) => ({
        account: "AR" as const,
        debit: 0,
        credit: a.amount,
        invoiceId: a.invoiceId,
        personId: (byId.get(a.invoiceId) as { payer_person_id: string }).payer_person_id,
      })),
    ],
  });
  const allocationIds: string[] = [];
  for (const a of input.allocations) {
    const id = randomUUID();
    allocationIds.push(id);
    await sql`
      insert into payment_allocations (id, organization_id, property_id, payment_id, invoice_id, amount, allocated_by, entry_id,
                                       command_id)
      values (${id}, ${ctx.actor.orgId}, ${p.property_id}, ${p.id}, ${a.invoiceId}, ${a.amount}, ${ctx.actor.membershipId},
              ${entryId}, ${ctx.commandId})`.execute(ctx.trx);
    await sql`
      update invoices set allocated_total = allocated_total + ${a.amount}, version = version + 1
      where organization_id = ${ctx.actor.orgId} and id = ${a.invoiceId}`.execute(ctx.trx);
  }
  await sql`
    update payments set allocated_total = allocated_total + ${sum}, version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${p.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "payment.allocated",
    entityType: "payment",
    entityId: p.id,
    propertyId: p.property_id,
    after: {
      allocations: input.allocations.map((a) => ({ invoice_id: a.invoiceId, amount: a.amount })),
      entry_id: entryId,
    },
  });
  return { entryId, allocationIds, unallocated: remaining - sum };
}

/**
 * `payment.reverse` (S-010): đảo các phân bổ còn hiệu lực (Nợ AR / Có CUSTOMER_CREDIT) rồi đảo thu (Nợ CUSTOMER_CREDIT /
 * Có CASH|BANK); bản gốc giữ nguyên. Tiền mặt: dòng đảo vào ca gốc nếu còn mở, không thì ca đang mở của người đảo.
 */
export async function reversePayment(
  ctx: CommandContext,
  input: { paymentId: string; reason: string },
): Promise<{ reversalEntryIds: string[] }> {
  if (!input.reason.trim()) throw new CommandError("VALIDATION_FAILED", 422, "Cần lý do đảo");
  const p = await lockPayment(ctx, input.paymentId, (row) =>
    authorize(ctx.actor, "payment.allocate", { propertyId: row.property_id, amount: Number(row.amount) }),
  );
  if (p.status !== "confirmed")
    throw new CommandError("INVALID_TRANSITION", 409, `Không đảo thanh toán ${p.status}`);
  let cashShiftId: string | undefined;
  if (p.method === "cash") {
    cashShiftId =
      p.shift_id && (await shiftIsOpen(ctx, p.shift_id))
        ? p.shift_id
        : ((await openShiftOf(ctx.trx, ctx.actor.orgId, ctx.actor.membershipId, p.property_id)) ?? undefined);
    if (!cashShiftId)
      throw new CommandError("SHIFT_NOT_OPEN", 409, "Ca gốc đã đóng — mở ca để ghi khoản đảo tiền mặt");
  }
  const bd = await businessDate(ctx.trx, ctx.actor.orgId, p.property_id);
  const allocs = await sql<{ id: string; invoice_id: string; amount: string; entry_id: string }>`
    select id, invoice_id, amount, entry_id from payment_allocations
    where organization_id = ${ctx.actor.orgId} and payment_id = ${p.id} and reversed_at is null
    order by invoice_id`.execute(ctx.trx);
  const reversalEntryIds: string[] = [];
  const reversedEntries = new Map<string, string>();
  if (allocs.rows.length > 0) {
    await sql`
      select id from invoices where organization_id = ${ctx.actor.orgId}
        and id = any(${allocs.rows.map((a) => a.invoice_id)}::uuid[]) order by id for update`.execute(
      ctx.trx,
    );
  }
  for (const a of allocs.rows) {
    let rev = reversedEntries.get(a.entry_id);
    if (!rev) {
      rev = await reverseEntry(ctx.trx, {
        orgId: ctx.actor.orgId,
        entryId: a.entry_id,
        businessDate: bd,
        reason: input.reason,
        createdBy: ctx.actor.membershipId,
        commandId: ctx.commandId,
      });
      reversedEntries.set(a.entry_id, rev);
      reversalEntryIds.push(rev);
    }
    await sql`
      update payment_allocations set reversed_at = now(), reversal_entry_id = ${rev}
      where organization_id = ${ctx.actor.orgId} and id = ${a.id}`.execute(ctx.trx);
    await sql`
      update invoices set allocated_total = allocated_total - ${Number(a.amount)}, version = version + 1
      where organization_id = ${ctx.actor.orgId} and id = ${a.invoice_id}`.execute(ctx.trx);
  }
  const confirmEntry = await sql<{ id: string }>`
    select id from journal_entries
    where organization_id = ${ctx.actor.orgId} and source_doc_type = 'payment' and source_doc_id = ${p.id}
      and entry_type in ('payment_confirmed','deposit_received')`.execute(ctx.trx);
  const ce = confirmEntry.rows[0]?.id;
  if (!ce) throw new CommandError("INVALID_TRANSITION", 409, "Không tìm thấy bút toán thu để đảo");
  reversalEntryIds.push(
    await reverseEntry(ctx.trx, {
      orgId: ctx.actor.orgId,
      entryId: ce,
      businessDate: bd,
      reason: input.reason,
      createdBy: ctx.actor.membershipId,
      commandId: ctx.commandId,
      ...(cashShiftId ? { cashShiftId } : {}),
    }),
  );
  if (p.purpose === "deposit") {
    // Cọc đã khấu trừ/hoàn một phần thì không đảo được phần đó: CHECK balance >= 0 chặn (đảo khoản hoàn trước).
    await sql`
      update deposits set amount = amount - ${Number(p.amount)}, version = version + 1
      where organization_id = ${ctx.actor.orgId} and id = ${p.deposit_id}`.execute(ctx.trx);
  }
  await sql`
    update payments set status = 'reversed', allocated_total = 0, reversed_by = ${ctx.actor.membershipId}, reversed_at = now(),
           reverse_reason = ${input.reason.trim()}, version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${p.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "payment.reversed",
    entityType: "payment",
    entityId: p.id,
    propertyId: p.property_id,
    before: { status: "confirmed", allocated_total: Number(p.allocated_total) },
    after: { status: "reversed", reversal_entry_ids: reversalEntryIds },
    reason: input.reason,
  });
  return { reversalEntryIds };
}

/** Số dư CUSTOMER_CREDIT (ứng trước/trả thừa) của một người: Σ Có − Σ Nợ. */
export async function customerCredit(
  trx: Transaction<unknown>,
  orgId: string,
  personId: string,
  /** Chỉ số dư phát sinh ở cơ sở này (hoàn/phân bổ không lấy tiền của cơ sở khác). */
  propertyId?: string,
): Promise<number> {
  const r = await sql<{ b: string }>`
    select coalesce(sum(credit - debit), 0)::text as b from journal_lines
    where organization_id = ${orgId} and account = 'CUSTOMER_CREDIT' and person_id = ${personId}
      ${propertyId ? sql`and property_id = ${propertyId}` : sql``}`.execute(trx);
  return Number(r.rows[0]?.b ?? 0);
}

/**
 * `payment.collectCash` (PLAN đợt 2 T-117 — thao tác quầy): thu tiền mặt cho MỘT phiếu = `payment.record` (tiền mặt, ca đang
 * mở) → `payment.confirm` (số phiếu thu) → `payment.allocate` trong một transaction, qua đúng ba hàm trên nên mọi kiểm tra
 * (quyền từng bước, ca mở, hạn mức phân bổ, không vượt số còn phải thu) giữ nguyên; lỗi ở bước nào ⇒ không ghi gì.
 */
export async function collectCash(
  ctx: CommandContext,
  input: { invoiceId: string; amount: number },
): Promise<{ paymentId: string; receiptNo: string | null; unallocated: number }> {
  if (!UUID.test(input.invoiceId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
  const r = await sql<{ property_id: string; payer_person_id: string }>`
    select property_id, payer_person_id from invoices where organization_id = ${ctx.actor.orgId} and id = ${input.invoiceId}`.execute(
    ctx.trx,
  );
  const inv = r.rows[0];
  if (!inv) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
  const { paymentId } = await recordPayment(ctx, {
    propertyId: inv.property_id,
    method: "cash",
    amount: input.amount,
    payerPersonId: inv.payer_person_id,
  });
  const c = await confirmPayment(ctx, { paymentId });
  const a = await allocatePayment(ctx, {
    paymentId,
    allocations: [{ invoiceId: input.invoiceId, amount: input.amount }],
  });
  return { paymentId, receiptNo: c.receiptNo, unallocated: a.unallocated };
}
