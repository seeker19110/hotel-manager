// Cọc và hoàn số dư khách (PLAN đợt 2 T-106; SPEC-ledger S-011…S-014, S-031, S-033; INV-F5, INV-F3b).
// - Nhận cọc đi qua `payments` (mục đích deposit) — xác nhận ghi Nợ CASH|BANK / Có DEPOSIT_LIAB (payments.ts).
// - Cọc KHÔNG tự trừ: khấu trừ/hoàn là yêu cầu duyệt (approvals.ts); executor kiểm lại số dư dưới khoá hàng cọc → hai lệnh
//   duyệt đồng thời chỉ một hiệu lực. Khấu trừ = `payment_allocations` có deposit_id (cùng hàng rào INV-F2 với thanh toán).
// - Hoàn CUSTOMER_CREDIT: khoá hàng `persons` của chủ số dư làm mutex trước khi kiểm số dư (không âm khi duyệt đồng thời).
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { type ApprovalRow, registerApprovalExecutor, requestApproval } from "../approvals/approvals.ts";
import { postEntry } from "../ledger/ledger.ts";
import { customerCredit, lockPerson, type ManualBankTxn, recordPayment } from "../payments/payments.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";
import { openShiftOf } from "../shifts/shifts.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertMoney(n: number, field: string): void {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CommandError("VALIDATION_FAILED", 422, `${field} phải là số nguyên đồng dương`);
  }
}

async function businessDate(trx: Transaction<unknown>, orgId: string, propertyId: string): Promise<string> {
  const r = await sql<{ d: string }>`select app.business_date(${orgId}, ${propertyId})::text as d`.execute(
    trx,
  );
  return r.rows[0]?.d as string;
}

export interface DepositSubject {
  leaseId?: string;
  reservationId?: string;
}

/**
 * `deposit.receive` (S-011): tạo (hoặc dùng) cọc của hợp đồng/đặt phòng và ghi khoản thu `pending` gắn cọc — chưa có bút
 * toán cho tới khi xác nhận (`payment.confirm`).
 */
export async function receiveDeposit(
  ctx: CommandContext,
  input: DepositSubject & {
    propertyId: string;
    payerPersonId: string;
    amount: number;
    method: "cash" | "bank_transfer";
    receivingAccountId?: string;
    bankTxn?: ManualBankTxn;
  },
): Promise<{ depositId: string; paymentId: string }> {
  assertMoney(input.amount, "Số tiền cọc");
  if ((input.leaseId ? 1 : 0) + (input.reservationId ? 1 : 0) !== 1) {
    throw new CommandError("VALIDATION_FAILED", 422, "Cọc gắn đúng một hợp đồng hoặc một đặt phòng");
  }
  const subjectId = (input.leaseId ?? input.reservationId) as string;
  if (!UUID.test(subjectId)) throw new CommandError("VALIDATION_FAILED", 422, "Đối tượng cọc không hợp lệ");
  const col = input.leaseId ? sql`lease_id` : sql`reservation_id`;
  await sql`
    insert into deposits (id, organization_id, property_id, ${col}, payer_person_id)
    values (${randomUUID()}, ${ctx.actor.orgId}, ${input.propertyId}, ${subjectId}, ${input.payerPersonId})
    on conflict do nothing`.execute(ctx.trx);
  const d = await sql<{ id: string; property_id: string; payer_person_id: string }>`
    select id, property_id, payer_person_id from deposits
    where organization_id = ${ctx.actor.orgId} and ${col} = ${subjectId}`.execute(ctx.trx);
  const dep = d.rows[0];
  if (!dep) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cọc");
  if (dep.property_id !== input.propertyId)
    throw new CommandError("VALIDATION_FAILED", 422, "Cọc thuộc cơ sở khác");
  const { paymentId } = await recordPayment(ctx, {
    propertyId: input.propertyId,
    method: input.method,
    amount: input.amount,
    payerPersonId: input.payerPersonId,
    purpose: "deposit",
    depositId: dep.id,
    ...(input.receivingAccountId ? { receivingAccountId: input.receivingAccountId } : {}),
    ...(input.bankTxn ? { bankTxn: input.bankTxn } : {}),
  });
  return { depositId: dep.id, paymentId };
}

interface DepositRow {
  id: string;
  property_id: string;
  lease_id: string | null;
  reservation_id: string | null;
  payer_person_id: string;
  balance: string;
}

async function readDeposit(ctx: CommandContext, depositId: string, lock: boolean): Promise<DepositRow> {
  if (!UUID.test(depositId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cọc");
  const r = await sql<DepositRow>`
    select id, property_id, lease_id, reservation_id, payer_person_id, balance from deposits
    where organization_id = ${ctx.actor.orgId} and id = ${depositId}
    ${lock ? sql`for update` : sql``}`.execute(ctx.trx);
  const row = r.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cọc");
  return row;
}

function refundsExceed(amount: number, balance: number, what: string): CommandError {
  return new CommandError("REFUND_EXCEEDS_BALANCE", 409, `${what} ${amount} vượt số còn ${balance}`);
}

interface OpenInvoice {
  id: string;
  property_id: string;
  lease_id: string | null;
  kind: string;
  /** Booking của lượt ở mà phiếu folio thuộc về (null với phiếu không phải folio). */
  stay_reservation_id: string | null;
  open: number;
  payer_person_id: string;
}

async function readInvoice(ctx: CommandContext, invoiceId: string, lock: boolean): Promise<OpenInvoice> {
  if (!UUID.test(invoiceId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
  const r = await sql<{
    id: string;
    property_id: string;
    lease_id: string | null;
    kind: string;
    stay_reservation_id: string | null;
    open: string;
    payer_person_id: string;
  }>`
    select v.id, v.property_id, v.lease_id, v.kind, v.open_amount::text as open, v.payer_person_id,
           (select ri.reservation_id from stays s
              join reservation_items ri on ri.organization_id = s.organization_id and ri.id = s.reservation_item_id
             where s.organization_id = v.organization_id and s.id = v.stay_id) as stay_reservation_id
    from invoices v
    where v.organization_id = ${ctx.actor.orgId} and v.id = ${invoiceId}
    ${lock ? sql`for update of v` : sql``}`.execute(ctx.trx);
  const row = r.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
  return { ...row, open: Number(row.open) };
}

/** Khấu trừ chỉ vào phiếu liên kết cùng hợp đồng/đối tượng của cọc và không vượt AR còn mở (INV-F5, lease S-025). */
function checkDeduction(dep: DepositRow, inv: OpenInvoice, amount: number): void {
  if (dep.lease_id === null) {
    // Cọc đặt phòng: chỉ khấu trừ vào phiếu folio của lượt ở thuộc CHÍNH booking có cọc (cọc của khách X không trả nợ của Y; review
    // R6, T-206).
    if (
      inv.property_id !== dep.property_id ||
      inv.kind !== "folio" ||
      inv.stay_reservation_id === null ||
      inv.stay_reservation_id !== dep.reservation_id
    ) {
      throw new CommandError(
        "VALIDATION_FAILED",
        422,
        "Cọc đặt phòng chỉ khấu trừ vào folio của chính đặt phòng",
      );
    }
  } else if (inv.property_id !== dep.property_id || inv.lease_id !== dep.lease_id) {
    throw new CommandError("VALIDATION_FAILED", 422, "Chỉ khấu trừ vào phiếu của chính hợp đồng có cọc");
  }
  if (amount > Number(dep.balance)) throw refundsExceed(amount, Number(dep.balance), "Khấu trừ");
  if (amount > inv.open)
    throw new CommandError("OVER_ALLOCATION", 409, `Khấu trừ ${amount} vượt AR còn mở ${inv.open}`);
}

/** `deposit.requestDeduction` (S-012): chưa có bút toán cho tới khi người khác người lập duyệt. */
export async function requestDeduction(
  ctx: CommandContext,
  input: { depositId: string; invoiceId: string; amount: number; reason: string },
): Promise<{ approvalRequestId: string }> {
  assertMoney(input.amount, "Số tiền khấu trừ");
  const dep = await readDeposit(ctx, input.depositId, false);
  checkDeduction(dep, await readInvoice(ctx, input.invoiceId, false), input.amount);
  return requestApproval(ctx, {
    kind: "deposit_deduction",
    amount: input.amount,
    reason: input.reason,
    propertyId: dep.property_id,
    subjectType: "deposit",
    subjectId: dep.id,
    payload: { invoice_id: input.invoiceId },
  });
}

export type RefundMethod = { method: "cash" } | { method: "bank_transfer"; receivingAccountId: string };

function refundPayload(m: RefundMethod): Record<string, unknown> {
  return m.method === "cash"
    ? { method: "cash" }
    : { method: "bank_transfer", receiving_account_id: m.receivingAccountId };
}

/** `deposit.requestRefund` (S-013): không vượt số còn giữ (REFUND_EXCEEDS_BALANCE). */
export async function requestDepositRefund(
  ctx: CommandContext,
  input: { depositId: string; amount: number; reason: string; refund: RefundMethod },
): Promise<{ approvalRequestId: string }> {
  assertMoney(input.amount, "Số tiền hoàn");
  const dep = await readDeposit(ctx, input.depositId, false);
  if (input.amount > Number(dep.balance)) throw refundsExceed(input.amount, Number(dep.balance), "Hoàn");
  return requestApproval(ctx, {
    kind: "deposit_refund",
    amount: input.amount,
    reason: input.reason,
    propertyId: dep.property_id,
    subjectType: "deposit",
    subjectId: dep.id,
    payload: refundPayload(input.refund),
  });
}

/** `credit.requestRefund` (S-031): hoàn số dư CUSTOMER_CREDIT (ứng trước/trả thừa) không vượt số dư. */
export async function requestCreditRefund(
  ctx: CommandContext,
  input: { personId: string; propertyId: string; amount: number; reason: string; refund: RefundMethod },
): Promise<{ approvalRequestId: string }> {
  assertMoney(input.amount, "Số tiền hoàn");
  if (!UUID.test(input.personId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy người");
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  // Số dư theo cơ sở được hoàn (review R7): không hoàn ở P1 tiền khách gửi ở P2.
  const bal = await customerCredit(ctx.trx, ctx.actor.orgId, input.personId, input.propertyId);
  if (input.amount > bal) throw refundsExceed(input.amount, bal, "Hoàn");
  return requestApproval(ctx, {
    kind: "credit_refund",
    amount: input.amount,
    reason: input.reason,
    propertyId: input.propertyId,
    subjectType: "person",
    subjectId: input.personId,
    payload: refundPayload(input.refund),
  });
}

/** Dòng chi tiền (Có CASH ca của người duyệt | Có BANK tài khoản nhận) cho hoàn. */
async function payoutLine(
  ctx: CommandContext,
  req: Pick<ApprovalRow, "propertyId" | "payload">,
  amount: number,
) {
  const propertyId = req.propertyId as string;
  if (req.payload.method === "cash") {
    const shiftId = await openShiftOf(ctx.trx, ctx.actor.orgId, ctx.actor.membershipId, propertyId);
    if (!shiftId) throw new CommandError("SHIFT_NOT_OPEN", 409, "Mở ca trước khi chi tiền mặt");
    return { account: "CASH" as const, debit: 0, credit: amount, shiftId };
  }
  const acct = req.payload.receiving_account_id;
  if (typeof acct !== "string" || !UUID.test(acct)) {
    throw new CommandError("VALIDATION_FAILED", 422, "Hoàn chuyển khoản cần tài khoản chi");
  }
  return { account: "BANK" as const, debit: 0, credit: amount, receivingAccountId: acct };
}

/** Cọc của một booking mà lượt ở đã trả phòng (hoàn cọc lúc/ngay sau check-out — hạn mức lễ tân chỉ áp ở đây, SPEC S-027). */
async function isCheckedOutBookingDeposit(ctx: CommandContext, depositId: string): Promise<boolean> {
  if (!UUID.test(depositId)) return false;
  const r = await sql<{ ok: boolean }>`
    select exists (
      select 1 from deposits d
      join reservation_items ri on ri.organization_id = d.organization_id and ri.reservation_id = d.reservation_id
      join stays s on s.organization_id = ri.organization_id and s.reservation_item_id = ri.id
      where d.organization_id = ${ctx.actor.orgId} and d.id = ${depositId} and s.status = 'checked_out') as ok`.execute(
    ctx.trx,
  );
  return r.rows[0]?.ok ?? false;
}

/**
 * Hoàn nguyên số cọc ngay trong lệnh check-out (SPEC S-027 a): Nợ DEPOSIT_LIAB / Có CASH (ca đang mở của người chi) hoặc BANK. Người gọi
 * (folio.ts) đã kiểm hạn mức `deposit.refund` + số còn giữ dưới khoá hàng cọc; ở đây chỉ ghi sổ + bộ đếm. Không bao giờ có `REV_*`.
 */
export async function refundDepositInline(
  ctx: CommandContext,
  input: { depositId: string; amount: number; refund: RefundMethod; businessDate: string },
): Promise<{ entryId: string }> {
  const dep = await readDeposit(ctx, input.depositId, true);
  if (input.amount > Number(dep.balance)) throw refundsExceed(input.amount, Number(dep.balance), "Hoàn");
  const payout = await payoutLine(
    ctx,
    { propertyId: dep.property_id, payload: refundPayload(input.refund) },
    input.amount,
  );
  const entryId = await postEntry(ctx.trx, {
    orgId: ctx.actor.orgId,
    propertyId: dep.property_id,
    entryType: "deposit_refunded",
    businessDate: input.businessDate,
    sourceDocType: "deposit",
    sourceDocId: dep.id,
    createdBy: ctx.actor.membershipId,
    commandId: ctx.commandId,
    lines: [{ account: "DEPOSIT_LIAB", debit: input.amount, credit: 0, depositId: dep.id }, payout],
  });
  await sql`update deposits set refunded_total = refunded_total + ${input.amount}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${dep.id}`.execute(ctx.trx);
  return { entryId };
}

let registered = false;

/** Đăng ký cách thực hiện các loại duyệt về cọc/số dư (gọi khi nạp module). */
export function registerDepositExecutors(): void {
  if (registered) return;
  registered = true;

  registerApprovalExecutor("deposit_deduction", {
    // Khấu trừ luôn cần người thứ hai có thẩm quyền; lễ tân không khấu trừ (chỉ hoàn nguyên số cọc khách sạn lúc check-out).
    context: async () => ({ atCheckout: false }),
    async execute(ctx, req) {
      const amount = req.amount as number;
      const dep = await readDeposit(ctx, req.subjectId as string, true);
      const inv = await readInvoice(ctx, String(req.payload.invoice_id), true);
      checkDeduction(dep, inv, amount);
      const entryId = await postEntry(ctx.trx, {
        orgId: ctx.actor.orgId,
        propertyId: dep.property_id,
        entryType: "deposit_deducted",
        businessDate: await businessDate(ctx.trx, ctx.actor.orgId, dep.property_id),
        sourceDocType: "approval_request",
        sourceDocId: req.id,
        createdBy: ctx.actor.membershipId,
        commandId: ctx.commandId,
        lines: [
          { account: "DEPOSIT_LIAB", debit: amount, credit: 0, depositId: dep.id },
          { account: "AR", debit: 0, credit: amount, invoiceId: inv.id, personId: inv.payer_person_id },
        ],
      });
      await sql`
        insert into payment_allocations (id, organization_id, property_id, deposit_id, invoice_id, amount, allocated_by, entry_id,
                                         command_id)
        values (${randomUUID()}, ${ctx.actor.orgId}, ${dep.property_id}, ${dep.id}, ${inv.id}, ${amount}, ${ctx.actor.membershipId},
                ${entryId}, ${ctx.commandId})`.execute(ctx.trx);
      await sql`update invoices set allocated_total = allocated_total + ${amount}, version = version + 1
                where organization_id = ${ctx.actor.orgId} and id = ${inv.id}`.execute(ctx.trx);
      await sql`update deposits set deducted_total = deducted_total + ${amount}, version = version + 1
                where organization_id = ${ctx.actor.orgId} and id = ${dep.id}`.execute(ctx.trx);
      return { entryId };
    },
  });

  registerApprovalExecutor("deposit_refund", {
    // "Đang check-out" suy ra từ CSDL, không tin client: cọc đặt phòng mà lượt ở của booking đã `checked_out` (T-206). Cọc hợp đồng
    // trọ không phải check-out khách sạn → lễ tân không duyệt.
    context: async (ctx, req) => ({
      atCheckout: await isCheckedOutBookingDeposit(ctx, req.subjectId as string),
    }),
    async execute(ctx, req) {
      const amount = req.amount as number;
      const dep = await readDeposit(ctx, req.subjectId as string, true);
      if (amount > Number(dep.balance)) throw refundsExceed(amount, Number(dep.balance), "Hoàn");
      const entryId = await postEntry(ctx.trx, {
        orgId: ctx.actor.orgId,
        propertyId: dep.property_id,
        entryType: "deposit_refunded",
        businessDate: await businessDate(ctx.trx, ctx.actor.orgId, dep.property_id),
        sourceDocType: "approval_request",
        sourceDocId: req.id,
        createdBy: ctx.actor.membershipId,
        commandId: ctx.commandId,
        lines: [
          { account: "DEPOSIT_LIAB", debit: amount, credit: 0, depositId: dep.id },
          await payoutLine(ctx, req, amount),
        ],
      });
      await sql`update deposits set refunded_total = refunded_total + ${amount}, version = version + 1
                where organization_id = ${ctx.actor.orgId} and id = ${dep.id}`.execute(ctx.trx);
      return { entryId };
    },
  });

  registerApprovalExecutor("credit_refund", {
    context: async () => ({ atCheckout: false }),
    async execute(ctx, req) {
      const amount = req.amount as number;
      const personId = req.subjectId as string;
      // Mutex theo chủ số dư: hai lệnh duyệt đồng thời không cùng thấy số dư cũ.
      await lockPerson(ctx.trx, ctx.actor.orgId, personId);
      const propertyId = req.propertyId as string;
      const bal = await customerCredit(ctx.trx, ctx.actor.orgId, personId, propertyId);
      if (amount > bal) throw refundsExceed(amount, bal, "Hoàn");
      const entryId = await postEntry(ctx.trx, {
        orgId: ctx.actor.orgId,
        propertyId,
        entryType: "credit_refunded",
        businessDate: await businessDate(ctx.trx, ctx.actor.orgId, propertyId),
        sourceDocType: "approval_request",
        sourceDocId: req.id,
        createdBy: ctx.actor.membershipId,
        commandId: ctx.commandId,
        lines: [
          { account: "CUSTOMER_CREDIT", debit: amount, credit: 0, personId },
          await payoutLine(ctx, req, amount),
        ],
      });
      return { entryId };
    },
  });
}

registerDepositExecutors();
