// Đối soát (PLAN đợt 2 T-107; SPEC-ledger S-015, S-019…S-021, S-029, S-030). Người có quyền xác nhận chuyển khoản
// (ma trận "payment.confirm_transfer": owner/manager/accountant) nhập sao kê, xem gợi ý, xác nhận ghép, đóng break.
// Không dòng nào ghi tiền trước khi người có quyền bấm xác nhận (ERD reconciliation_breaks).
import { createHash, randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import {
  authorize,
  bankBin,
  buildVietQr,
  type MatchSuggestion,
  mapStatement,
  parseCsv,
  STATEMENT_MAX_BYTES,
  type StatementMapping,
} from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import { ingestInTx, openBreak, openHashMismatchBreak } from "../ledger/bank-inbox.ts";
import {
  type AllocationInput,
  allocatePayment,
  confirmPayment,
  recordPayment,
} from "../payments/payments.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";
import { candidateInvoices, loadBankTxn, suggestFor } from "./matching.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function receivingAccount(
  trx: Transaction<unknown>,
  orgId: string,
  id: string,
): Promise<{
  id: string;
  property_id: string | null;
  bank_code: string;
  account_number: string;
  account_name: string;
}> {
  if (!UUID.test(id)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy tài khoản nhận");
  const r = await sql<{
    id: string;
    property_id: string | null;
    bank_code: string;
    account_number: string;
    account_name: string;
  }>`
    select id, property_id, bank_code, account_number, account_name from receiving_accounts
    where organization_id = ${orgId} and id = ${id} and active`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy tài khoản nhận");
  return row;
}

/** Khoá tư vấn theo giao dịch — cùng khoá với worker tự ghép (auto-apply.ts) nên người và máy không ghi trùng. */
async function lockBankTxn(trx: Transaction<unknown>, id: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`bank_txn:${id}`}, 0))`.execute(trx);
}

export interface ImportStatementInput {
  receivingAccountId: string;
  csv: string;
  mapping: StatementMapping;
}

export type ImportRowStatus = "new" | "duplicate" | "hash_mismatch" | "skipped" | "invalid";

export interface ImportRowResult {
  line: number;
  status: ImportRowStatus;
  bank_transaction_id?: string;
  suggestion?: MatchSuggestion;
  break_id?: string;
  error?: string;
}

/**
 * `reconciliation.importStatement` (S-019): mỗi dòng tiền vào → inbox (`statement_csv`, mã sự kiện = mã giao dịch ngân hàng
 * hoặc hash ngày+số tiền+nội dung+số dư) → bank_transactions (trùng giao dịch từ nguồn khác = "đã nhập", S-029/S-030).
 * Dòng mới không khớp đúng một phiếu → break do người nhập chịu trách nhiệm (S-020). Không ghi tiền.
 */
export async function importStatement(
  ctx: CommandContext,
  input: ImportStatementInput,
): Promise<{ rows: ImportRowResult[]; counts: Record<ImportRowStatus, number> }> {
  const acct = await receivingAccount(ctx.trx, ctx.actor.orgId, input.receivingAccountId);
  if (!acct.property_id) throw new CommandError("VALIDATION_FAILED", 422, "Tài khoản nhận chưa gắn cơ sở");
  const propertyId = acct.property_id;
  authorize(ctx.actor, "payment.confirm_transfer", { propertyId });
  if (Buffer.byteLength(input.csv, "utf8") > STATEMENT_MAX_BYTES) {
    throw new CommandError("FILE_TOO_LARGE", 413, "File sao kê vượt 2 MB — tách thành nhiều file");
  }
  let parsed: ReturnType<typeof mapStatement>;
  try {
    parsed = mapStatement(parseCsv(input.csv), input.mapping);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    if (e.message.startsWith("Tối đa")) throw new CommandError("FILE_TOO_LARGE", 413, e.message);
    throw new CommandError("VALIDATION_FAILED", 422, e.message);
  }
  const owner = { orgId: ctx.actor.orgId, propertyId };
  const rows: ImportRowResult[] = [];
  for (const r of parsed) {
    if (r.kind === "skipped") {
      rows.push({ line: r.line, status: "skipped", error: r.why === "outflow" ? "Tiền ra" : "Số tiền 0" });
      continue;
    }
    if (r.kind === "invalid") {
      rows.push({ line: r.line, status: "invalid", error: r.error });
      continue;
    }
    const occurredAt = r.occurredAt.toISOString();
    const eventId =
      r.ref ??
      `h:${sha256(`${occurredAt}|${r.amount}|${r.description}|${r.balanceAfter ?? ""}`).slice(0, 40)}`;
    const raw = {
      ref: r.ref,
      amount: r.amount,
      occurred_at: occurredAt,
      description: r.description,
      balance_after: r.balanceAfter,
    };
    const outcome = await ingestInTx(ctx.trx, owner, {
      provider: "statement_csv",
      account: acct.id,
      providerEventId: eventId,
      raw,
      signatureVerified: false,
      source: "statement",
      txn: {
        ref: eventId,
        amount: r.amount,
        occurredAt: r.occurredAt,
        description: r.description,
        ...(r.balanceAfter === null ? {} : { balanceAfter: r.balanceAfter }),
      },
    });
    if (outcome.kind === "hash_mismatch") {
      const breakId = await openHashMismatchBreak(ctx.trx, owner, outcome, {
        provider: "statement_csv",
        amount: r.amount,
        line: r.line,
      });
      rows.push({ line: r.line, status: "hash_mismatch", break_id: breakId });
      continue;
    }
    if (outcome.duplicateEvent || outcome.existingTransaction) {
      rows.push({ line: r.line, status: "duplicate", bank_transaction_id: outcome.bankTransactionId });
      continue;
    }
    const bt = await loadBankTxn(ctx.trx, ctx.actor.orgId, outcome.bankTransactionId);
    if (!bt) throw new Error("bank_transaction vừa ghi không đọc lại được");
    const suggestion = suggestFor(bt, await candidateInvoices(ctx.trx, ctx.actor.orgId, bt.description));
    const row: ImportRowResult = { line: r.line, status: "new", bank_transaction_id: bt.id, suggestion };
    if (suggestion.status === "break" && suggestion.reason) {
      row.break_id = (
        await openBreak(ctx.trx, {
          orgId: ctx.actor.orgId,
          propertyId,
          bankTransactionId: bt.id,
          reason: suggestion.reason,
          assignee: ctx.actor.membershipId,
          detail: { amount: r.amount, suggested_credit: suggestion.credit, line: r.line },
        })
      ).breakId;
    }
    rows.push(row);
  }
  const counts = { new: 0, duplicate: 0, hash_mismatch: 0, skipped: 0, invalid: 0 };
  for (const r of rows) counts[r.status]++;
  await ctx.audit({
    action: "reconciliation.statement_imported",
    entityType: "receiving_account",
    entityId: acct.id,
    propertyId,
    after: counts,
  });
  return { rows, counts };
}

export interface PreviewItem {
  bank_transaction_id: string;
  bank_txn_ref: string;
  amount: number;
  occurred_at: string;
  description: string | null;
  suggestion: MatchSuggestion;
  candidates: { invoice_id: string; number: string; open: number }[];
  open_breaks: { break_id: string; reason: string; assignee: string }[];
}

/** `reconciliation.previewMatches` (S-020): giao dịch chưa thành payment của cơ sở + gợi ý + break đang mở. Chỉ đọc. */
export async function previewMatches(
  db: Kysely<unknown>,
  actor: Actor,
  input: { propertyId: string; receivingAccountId?: string; limit?: number },
): Promise<PreviewItem[]> {
  authorize(actor, "payment.confirm_transfer", { propertyId: input.propertyId });
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const bts = await sql<{
      id: string;
      property_id: string;
      receiving_account_id: string;
      bank_txn_ref: string;
      amount: string;
      occurred_at: Date;
      description: string | null;
    }>`
      select b.id, b.property_id, b.receiving_account_id, b.bank_txn_ref, b.amount, b.occurred_at, b.description
      from bank_transactions b
      where b.organization_id = ${actor.orgId} and b.property_id = ${input.propertyId}
        ${input.receivingAccountId ? sql`and b.receiving_account_id = ${input.receivingAccountId}` : sql``}
        and not exists (select 1 from payments p where p.organization_id = b.organization_id and p.bank_transaction_id = b.id)
      order by b.occurred_at desc, b.id
      limit ${Math.min(Math.max(input.limit ?? 100, 1), 500)}`.execute(trx);
    const out: PreviewItem[] = [];
    for (const bt of bts.rows) {
      const invoices = await candidateInvoices(trx, actor.orgId, bt.description);
      const breaks = await sql<{ id: string; reason: string; assignee: string }>`
        select id, reason, assignee from reconciliation_breaks
        where organization_id = ${actor.orgId} and bank_transaction_id = ${bt.id} and status = 'open' order by created_at`.execute(
        trx,
      );
      out.push({
        bank_transaction_id: bt.id,
        bank_txn_ref: bt.bank_txn_ref,
        amount: Number(bt.amount),
        occurred_at: new Date(bt.occurred_at).toISOString(),
        description: bt.description,
        suggestion: suggestFor(bt, invoices),
        candidates: invoices.map((i) => ({
          invoice_id: i.id,
          number: i.number,
          open: Number(i.open_amount),
        })),
        open_breaks: breaks.rows.map((b) => ({ break_id: b.id, reason: b.reason, assignee: b.assignee })),
      });
    }
    return out;
  });
}

async function resolveOpenBreaks(
  ctx: CommandContext,
  bankTransactionId: string,
  r: { resolution: string; paymentId: string | null; thirdParty: boolean },
): Promise<string[]> {
  const res = await sql<{ id: string }>`
    update reconciliation_breaks
    set status = 'resolved', resolution = ${r.resolution}, resolved_by = ${ctx.actor.membershipId}, resolved_at = now(),
        resolved_payment_id = ${r.paymentId},
        reason = case when ${r.thirdParty}::boolean then 'THIRD_PARTY_PAYER' else reason end,
        detail = coalesce(detail, '{}'::jsonb) || jsonb_build_object('original_reason', reason),
        version = version + 1
    where organization_id = ${ctx.actor.orgId} and bank_transaction_id = ${bankTransactionId} and status = 'open'
      and reason <> 'HASH_MISMATCH'
    returning id`.execute(ctx.trx);
  return res.rows.map((x) => x.id);
}

export interface ConfirmMatchInput {
  bankTransactionId: string;
  allocations: readonly AllocationInput[];
  /** Bắt buộc khi không phân bổ (toàn bộ vào CUSTOMER_CREDIT của người này); mặc định người trả của phiếu đầu tiên. */
  payerPersonId?: string;
  /** S-021: người khác trả hộ — break được đóng với lý do THIRD_PARTY_PAYER, cần ghi chú. */
  thirdPartyPayer?: boolean;
  note?: string;
}

/**
 * `reconciliation.confirmMatch` (S-020, S-021): từ một giao dịch ngân hàng đã nhập → thanh toán `confirmed` (chứng cứ = giao
 * dịch đó, INV-F3) + phân bổ; phần không phân bổ nằm ở CUSTOMER_CREDIT của người trả (OVERPAID). Một giao dịch một payment
 * (INV-F4b). Break HASH_MISMATCH còn mở → không ghi tiền.
 */
export async function confirmMatch(
  ctx: CommandContext,
  input: ConfirmMatchInput,
): Promise<{
  paymentId: string;
  allocationEntryId: string | null;
  unallocated: number;
  resolvedBreakIds: string[];
}> {
  if (!UUID.test(input.bankTransactionId))
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy giao dịch");
  const note = input.note?.trim() ?? "";
  if (input.thirdPartyPayer && !note) {
    throw new CommandError("VALIDATION_FAILED", 422, "Người khác trả hộ cần ghi chú");
  }
  const bt = await loadBankTxn(ctx.trx, ctx.actor.orgId, input.bankTransactionId);
  if (!bt) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy giao dịch ngân hàng");
  authorize(ctx.actor, "payment.confirm_transfer", { propertyId: bt.property_id });
  await lockBankTxn(ctx.trx, bt.id);
  const blocking = await sql<{ id: string }>`
    select id from reconciliation_breaks
    where organization_id = ${ctx.actor.orgId} and bank_transaction_id = ${bt.id} and status = 'open'
      and reason = 'HASH_MISMATCH'`.execute(ctx.trx);
  if (blocking.rows.length > 0) {
    throw new CommandError(
      "INVALID_TRANSITION",
      409,
      "Giao dịch đang lệch nội dung giữa các nguồn — xử lý break trước",
    );
  }
  let payer = input.payerPersonId;
  if (!payer && input.allocations.length > 0) {
    const first = input.allocations[0] as AllocationInput;
    if (!UUID.test(first.invoiceId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
    const r = await sql<{ payer_person_id: string }>`
      select payer_person_id from invoices where organization_id = ${ctx.actor.orgId} and id = ${first.invoiceId}`.execute(
      ctx.trx,
    );
    payer = r.rows[0]?.payer_person_id;
    if (!payer) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
  }
  if (!payer) throw new CommandError("VALIDATION_FAILED", 422, "Cần người trả khi không phân bổ vào phiếu");

  const { paymentId } = await recordPayment(ctx, {
    propertyId: bt.property_id,
    method: "bank_transfer",
    amount: Number(bt.amount),
    payerPersonId: payer,
    receivingAccountId: bt.receiving_account_id,
  });
  await confirmPayment(ctx, { paymentId, evidence: { bankTransactionId: bt.id } });
  let allocationEntryId: string | null = null;
  let unallocated = Number(bt.amount);
  if (input.allocations.length > 0) {
    const a = await allocatePayment(ctx, { paymentId, allocations: input.allocations });
    allocationEntryId = a.entryId;
    unallocated = a.unallocated;
  }
  const resolution = note || "Xác nhận ghép từ sao kê";
  const resolvedBreakIds = await resolveOpenBreaks(ctx, bt.id, {
    resolution,
    paymentId,
    thirdParty: input.thirdPartyPayer === true,
  });
  if (input.thirdPartyPayer && resolvedBreakIds.length === 0) {
    // Dòng khớp mã nhưng người trả là bên thứ ba: vẫn để lại dấu vết lý do (không có break mở để đóng).
    const id = randomUUID();
    await sql`
      insert into reconciliation_breaks (id, organization_id, property_id, bank_transaction_id, reason, assignee, status,
                                         resolution, resolved_by, resolved_at, resolved_payment_id)
      values (${id}, ${ctx.actor.orgId}, ${bt.property_id}, ${bt.id}, 'THIRD_PARTY_PAYER', ${ctx.actor.membershipId},
              'resolved', ${resolution}, ${ctx.actor.membershipId}, now(), ${paymentId})`.execute(ctx.trx);
    resolvedBreakIds.push(id);
  }
  await ctx.audit({
    action: "reconciliation.matched",
    entityType: "bank_transaction",
    entityId: bt.id,
    propertyId: bt.property_id,
    after: {
      payment_id: paymentId,
      allocations: input.allocations.map((x) => ({ invoice_id: x.invoiceId, amount: x.amount })),
      unallocated,
      third_party_payer: input.thirdPartyPayer === true,
      resolved_breaks: resolvedBreakIds,
    },
    reason: resolution,
  });
  return { paymentId, allocationEntryId, unallocated, resolvedBreakIds };
}

/** `reconciliation.resolveBreak`: đóng break không ghi tiền (vd đã đối chiếu ngân hàng, HASH_MISMATCH là lỗi nguồn) — bắt buộc lý do. */
export async function resolveBreak(
  ctx: CommandContext,
  input: { breakId: string; resolution: string },
): Promise<{ breakId: string }> {
  if (!UUID.test(input.breakId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy khoản bất thường");
  const resolution = input.resolution.trim();
  if (!resolution) throw new CommandError("VALIDATION_FAILED", 422, "Cần lý do đóng");
  const seen = await sql<{ property_id: string }>`
    select property_id from reconciliation_breaks where organization_id = ${ctx.actor.orgId} and id = ${input.breakId}`.execute(
    ctx.trx,
  );
  const b = seen.rows[0];
  if (!b) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy khoản bất thường");
  authorize(ctx.actor, "payment.confirm_transfer", { propertyId: b.property_id });
  const locked = await sql<{ status: string; reason: string }>`
    select status, reason from reconciliation_breaks where organization_id = ${ctx.actor.orgId} and id = ${input.breakId}
    for update`.execute(ctx.trx);
  const row = locked.rows[0] as { status: string; reason: string };
  if (row.status !== "open") throw new CommandError("INVALID_TRANSITION", 409, "Khoản bất thường đã đóng");
  await sql`
    update reconciliation_breaks set status = 'resolved', resolution = ${resolution}, resolved_by = ${ctx.actor.membershipId},
           resolved_at = now(), version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${input.breakId}`.execute(ctx.trx);
  await ctx.audit({
    action: "reconciliation.break_resolved",
    entityType: "reconciliation_break",
    entityId: input.breakId,
    propertyId: b.property_id,
    before: { status: "open", reason: row.reason },
    after: { status: "resolved" },
    reason: resolution,
  });
  return { breakId: input.breakId };
}

export interface TransferInfo {
  invoice_id: string;
  number: string;
  amount_due: number;
  memo_ref: string;
  transfer_content: string;
  account: { bank_code: string; bank_bin: string | null; account_number: string; account_name: string };
  /** Chuỗi VietQR (EMVCo); null khi đã trả đủ hoặc ngân hàng chưa có BIN đã xác minh. */
  qr_payload: string | null;
  notice: string;
}

/**
 * `payment.getTransferInfo` (S-015): số TK, số tiền còn, nội dung CK = mã tham chiếu, chuỗi QR. Chỉ là THÔNG TIN — không
 * đổi trạng thái phiếu (xác nhận chỉ qua chứng cứ: webhook đã xác minh hoặc sao kê). Người thuê/khách xem phiếu của mình ở
 * cổng người thuê (SPEC-portal); đây là đường của nhân viên có quyền xem tiền.
 */
export async function getTransferInfo(
  db: Kysely<unknown>,
  actor: Actor,
  input: { invoiceId: string; receivingAccountId?: string },
): Promise<TransferInfo> {
  if (!UUID.test(input.invoiceId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const inv = await sql<{
      id: string;
      property_id: string;
      number: string;
      memo_ref: string;
      open_amount: string;
    }>`
      select id, property_id, number, memo_ref, open_amount from invoices
      where organization_id = ${actor.orgId} and id = ${input.invoiceId}`.execute(trx);
    const i = inv.rows[0];
    if (!i) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
    authorize(actor, "money.read", { propertyId: i.property_id });
    let acct: Awaited<ReturnType<typeof receivingAccount>>;
    if (input.receivingAccountId) {
      acct = await receivingAccount(trx, actor.orgId, input.receivingAccountId);
      if (acct.property_id !== i.property_id)
        throw new CommandError("NOT_FOUND", 404, "Không tìm thấy tài khoản nhận");
    } else {
      const r = await sql<{ id: string }>`
        select id from receiving_accounts
        where organization_id = ${actor.orgId} and property_id = ${i.property_id} and active order by id limit 2`.execute(
        trx,
      );
      if (r.rows.length === 0) throw new CommandError("NOT_FOUND", 404, "Cơ sở chưa có tài khoản nhận");
      if (r.rows.length > 1)
        throw new CommandError("VALIDATION_FAILED", 422, "Cơ sở có nhiều tài khoản nhận — chọn một");
      acct = await receivingAccount(trx, actor.orgId, (r.rows[0] as { id: string }).id);
    }
    const due = Number(i.open_amount);
    const bin = bankBin(acct.bank_code);
    let qr: string | null = null;
    if (bin && due > 0) {
      try {
        qr = buildVietQr({ bin, accountNumber: acct.account_number, amount: due, memo: i.memo_ref });
      } catch (e) {
        // Số TK/mã ngoài dạng QR hỗ trợ: vẫn trả thông tin chuyển khoản để người trả tự nhập.
        if (!(e instanceof RangeError)) throw e;
      }
    }
    return {
      invoice_id: i.id,
      number: i.number,
      amount_due: due,
      memo_ref: i.memo_ref,
      transfer_content: i.memo_ref,
      account: {
        bank_code: acct.bank_code,
        bank_bin: bin,
        account_number: acct.account_number,
        account_name: acct.account_name,
      },
      qr_payload: qr,
      notice: "Thông tin chuyển khoản — phiếu chỉ được ghi nhận đã trả khi có chứng cứ từ ngân hàng.",
    };
  });
}
