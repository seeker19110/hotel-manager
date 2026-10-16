// Trả phòng (SPEC-reservation-stay S-017, S-019, S-020, S-023, S-026, S-027; INV-F1…F5, INV-F3b; DOMAIN-MODEL §5). MỘT
// transaction: phát hành folio từ các khoản chưa lên phiếu (Nợ AR / Có REV_*, giảm giá Nợ DISCOUNT) → phân bổ ứng trước của
// chính booking → thu tiền tại quầy (tiền mặt: lễ tân tự xác nhận khoản mình nhận trong ca đang mở) → còn nợ thì chỉ trả phòng
// khi có người có thẩm quyền cho nợ (người nợ + hạn) hoặc khấu trừ cọc đang chờ duyệt → hoàn cọc theo hạn mức → stay/booking
// `checked_out`, allocation kết thúc ở giờ trả thực, phòng `dirty` + việc dọn. Lỗi ở bước nào ⇒ không ghi gì.
import { randomUUID } from "node:crypto";
import { authorize, generateMemoRef, grantFor, isMatrixRole } from "@hm/domain";
import { sql } from "kysely";
import { registerApprovalExecutor } from "../approvals/approvals.ts";
import { refundDepositAtCheckout, requestDeduction } from "../deposits/deposits.ts";
import { createCleaningTask } from "../housekeeping/tasks.ts";
import { postEntry } from "../ledger/ledger.ts";
import {
  allocatePayment,
  confirmPayment,
  type ManualBankTxn,
  type PaymentRow,
  recordPayment,
} from "../payments/payments.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";
import { openShiftOf } from "../shifts/shifts.ts";
import { readStay } from "./folio.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CheckoutPayment {
  method: "cash" | "bank_transfer";
  amount: number;
  receivingAccountId?: string;
  bankTxn?: ManualBankTxn;
}

export interface CheckoutInput {
  stayId: string;
  payments?: readonly CheckoutPayment[];
  /** Cho nợ (S-019): người nợ + hạn trả; lễ tân cần yêu cầu duyệt `allow_balance` đã được quản lý duyệt. */
  allowBalance?: { approvalRequestId?: string; debtorPersonId: string; dueDate: string };
  /** Hoàn cọc bảo đảm cho chính khách (S-027 a/b) — chỉ khi folio đã thu đủ. */
  depositRefund?: { amount: number; method: "cash" | "bank_transfer"; receivingAccountId?: string };
  /** Khấu trừ cọc vào nợ còn lại (S-027 c): luôn lập yêu cầu duyệt, người duyệt khác người lập (INV-F5). */
  depositDeduction?: { amount: number; reason: string };
  now?: Date;
}

export interface CheckoutResult {
  stayId: string;
  invoiceId: string;
  total: number;
  balance: number;
  payments: { paymentId: string; status: "pending" | "confirmed"; receiptNo: string | null }[];
  depositRefundStatus: "done" | "pending_approval" | null;
  depositRefundApprovalId: string | null;
  deductionApprovalId: string | null;
}

function fieldError(path: string, code: string, message: string): CommandError {
  return new CommandError("VALIDATION_FAILED", 422, message, {
    extensions: { errors: [{ path, field: path, code }] },
  });
}

interface ChargeRow {
  id: string;
  kind: "room" | "service" | "fee" | "discount";
  revenue_account: "REV_ROOM" | "REV_SERVICE" | "REV_FEE" | "DISCOUNT";
  description: string;
  quantity: string;
  unit_price: string;
  amount: string;
}

/** Phát hành folio (kind `folio`, một phiếu mỗi lượt ở) từ các khoản chưa huỷ và chưa lên phiếu. */
async function issueFolio(
  ctx: CommandContext,
  stay: { id: string; property_id: string },
  payerPersonId: string,
  day: string,
  dueOn: string,
): Promise<{ invoiceId: string; total: number }> {
  const ch = await sql<ChargeRow>`
    select c.id, c.kind, c.revenue_account, c.description, c.quantity::text, c.unit_price::text, c.amount::text
    from charges c
    where c.organization_id = ${ctx.actor.orgId} and c.stay_id = ${stay.id} and c.voided_at is null
      and not exists (select 1 from invoice_lines il where il.organization_id = c.organization_id and il.charge_id = c.id)
    order by c.business_date, c.created_at
    for update of c`.execute(ctx.trx);
  const total = ch.rows.reduce((s, c) => s + Number(c.amount), 0);
  if (total < 0) throw fieldError("charges", "negative_total", "Tổng folio âm — kiểm tra lại giảm giá");
  const invoiceId = randomUUID();
  const n = await sql<{
    n: string;
  }>`select app.next_number(${ctx.actor.orgId}, ${stay.property_id}, 'invoice')::text as n`.execute(ctx.trx);
  await sql`
    insert into invoices (id, organization_id, property_id, kind, stay_id, number, memo_ref, payer_person_id, business_date, due_on,
                          total, created_by, command_id)
    values (${invoiceId}, ${ctx.actor.orgId}, ${stay.property_id}, 'folio', ${stay.id}, ${`HD-${String(n.rows[0]?.n).padStart(6, "0")}`},
            ${generateMemoRef()}, ${payerPersonId}, ${day}::date, ${dueOn}::date, ${total}, ${ctx.actor.membershipId},
            ${ctx.commandId})`.execute(ctx.trx);
  const lines: {
    account: "REV_ROOM" | "REV_SERVICE" | "REV_FEE" | "DISCOUNT";
    debit: number;
    credit: number;
    invoiceId: string;
    invoiceLineId: string;
  }[] = [];
  for (const [i, c] of ch.rows.entries()) {
    const lineId = randomUUID();
    const amount = Number(c.amount);
    await sql`
      insert into invoice_lines (id, organization_id, property_id, invoice_id, charge_id, line_no, kind, description, revenue_account,
                                 quantity, unit_price, amount, rounding_rule, formula_version)
      values (${lineId}, ${ctx.actor.orgId}, ${stay.property_id}, ${invoiceId}, ${c.id}, ${i + 1}, ${c.kind}, ${c.description},
              ${c.revenue_account}, ${c.quantity}::numeric, ${c.unit_price}::numeric, ${amount}, 'HALF_UP_1', 1)`.execute(
      ctx.trx,
    );
    if (amount === 0) continue;
    lines.push(
      amount > 0
        ? { account: c.revenue_account, debit: 0, credit: amount, invoiceId, invoiceLineId: lineId }
        : { account: "DISCOUNT", debit: -amount, credit: 0, invoiceId, invoiceLineId: lineId },
    );
  }
  if (total > 0 || lines.length > 0) {
    await postEntry(ctx.trx, {
      orgId: ctx.actor.orgId,
      propertyId: stay.property_id,
      entryType: "invoice_issued",
      businessDate: day,
      sourceDocType: "invoice",
      sourceDocId: invoiceId,
      createdBy: ctx.actor.membershipId,
      commandId: ctx.commandId,
      lines: [{ account: "AR", debit: total, credit: 0, invoiceId, personId: payerPersonId }, ...lines],
    });
  }
  return { invoiceId, total };
}

async function openAmount(ctx: CommandContext, invoiceId: string): Promise<number> {
  const r = await sql<{ o: string }>`
    select open_amount::text as o from invoices where organization_id = ${ctx.actor.orgId} and id = ${invoiceId}`.execute(
    ctx.trx,
  );
  return Number(r.rows[0]?.o ?? 0);
}

/** Phân bổ một khoản đã xác nhận của chính booking vào folio — dưới quyền trả phòng, hàng rào số tiền giữ nguyên. */
async function allocateToFolio(
  ctx: CommandContext,
  paymentId: string,
  invoiceId: string,
  propertyId: string,
  amount: number,
  now: Date | undefined,
): Promise<void> {
  if (amount <= 0) return;
  await allocatePayment(
    ctx,
    { paymentId, allocations: [{ invoiceId, amount }] },
    {
      authorizeRow: (row: PaymentRow) => {
        if (row.property_id !== propertyId)
          throw new CommandError("NOT_FOUND", 404, "Không tìm thấy thanh toán");
        authorize(ctx.actor, "reservation.manage", { propertyId });
      },
      ...(now ? { now } : {}),
    },
  );
}

function canGrant(
  ctx: CommandContext,
  action: "stay.checkout_with_debt" | "payment.confirm_transfer",
): boolean {
  return isMatrixRole(ctx.actor.role) && grantFor(action, ctx.actor.role) === "yes";
}

/** Cho nợ: owner/manager trực tiếp; lễ tân phải có yêu cầu `allow_balance` đã duyệt cho đúng lượt ở, đủ số, chưa dùng. */
async function assertAllowBalance(
  ctx: CommandContext,
  stayId: string,
  remaining: number,
  allow: NonNullable<CheckoutInput["allowBalance"]>,
): Promise<string | null> {
  if (!UUID.test(allow.debtorPersonId))
    throw fieldError("allow_balance.debtor_person_id", "required", "Cần người nợ");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(allow.dueDate))
    throw fieldError("allow_balance.due_date", "required", "Cần hạn trả");
  const p = await sql<{ id: string }>`
    select id from persons where organization_id = ${ctx.actor.orgId} and id = ${allow.debtorPersonId} and anonymized_at is null`.execute(
    ctx.trx,
  );
  if (!p.rows[0]) throw fieldError("allow_balance.debtor_person_id", "not_found", "Không tìm thấy người nợ");
  if (canGrant(ctx, "stay.checkout_with_debt")) return allow.approvalRequestId ?? null;
  if (!allow.approvalRequestId || !UUID.test(allow.approvalRequestId))
    throw new CommandError("OUTSTANDING_BALANCE", 409, "Khách còn nợ. Cần quản lý cho phép và hạn trả.", {
      extensions: { items: [{ balance: remaining }] },
    });
  const a = await sql<{ status: string; amount: string | null }>`
    select status, amount::text from approval_requests
    where organization_id = ${ctx.actor.orgId} and id = ${allow.approvalRequestId} and kind = 'allow_balance'
      and subject_type = 'stay' and subject_id = ${stayId} for update`.execute(ctx.trx);
  const row = a.rows[0];
  if (!row || row.status !== "executed" || row.amount === null || Number(row.amount) < remaining)
    throw new CommandError("OUTSTANDING_BALANCE", 409, "Khách còn nợ. Cần quản lý cho phép và hạn trả.", {
      extensions: { items: [{ balance: remaining }] },
    });
  return allow.approvalRequestId;
}

/** `stay.checkOut`. */
export async function checkOut(ctx: CommandContext, input: CheckoutInput): Promise<CheckoutResult> {
  const now = input.now ?? new Date();
  const stay = await readStay(ctx.trx, ctx.actor, input.stayId, true);
  authorize(ctx.actor, "reservation.manage", { propertyId: stay.property_id });
  if (stay.status !== "in_house") {
    throw new CommandError("INVALID_TRANSITION", 409, "Thao tác không hợp lệ với trạng thái hiện tại.", {
      extensions: { from: stay.status, to: "checked_out" },
    });
  }
  const dayRow = await sql<{ d: string }>`
    select app.business_date(${ctx.actor.orgId}, ${stay.property_id}, ${now})::text as d`.execute(ctx.trx);
  const day = dayRow.rows[0]?.d as string;
  const payer =
    input.allowBalance?.debtorPersonId && UUID.test(input.allowBalance.debtorPersonId)
      ? input.allowBalance.debtorPersonId
      : stay.booker_person_id;
  const { invoiceId, total } = await issueFolio(ctx, stay, payer, day, input.allowBalance?.dueDate ?? day);

  // (1) Ứng trước đã xác nhận của chính booking.
  const adv = await sql<{ id: string; free: string }>`
    select id, (amount - allocated_total)::text as free from payments
    where organization_id = ${ctx.actor.orgId} and reservation_id = ${stay.reservation_id} and purpose = 'receivable'
      and status = 'confirmed' and amount > allocated_total
    order by created_at, id`.execute(ctx.trx);
  for (const p of adv.rows) {
    const open = await openAmount(ctx, invoiceId);
    await allocateToFolio(ctx, p.id, invoiceId, stay.property_id, Math.min(Number(p.free), open), now);
  }

  // (2) Thu tại quầy.
  const paid: CheckoutResult["payments"] = [];
  for (const [i, p] of (input.payments ?? []).entries()) {
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0)
      throw fieldError(`payments.${i}.amount`, "invalid", "Số tiền > 0");
    if (
      p.method === "cash" &&
      !(await openShiftOf(ctx.trx, ctx.actor.orgId, ctx.actor.membershipId, stay.property_id))
    ) {
      // INV-F3b: chỉ xác nhận tiền mặt mình nhận trong ca đang mở của mình (S-026 a).
      throw new CommandError("FORBIDDEN", 403, "Mở ca trước khi nhận tiền mặt lúc trả phòng");
    }
    const { paymentId } = await recordPayment(ctx, {
      propertyId: stay.property_id,
      method: p.method,
      amount: p.amount,
      payerPersonId: payer,
      reservationId: stay.reservation_id,
      now,
      ...(p.receivingAccountId ? { receivingAccountId: p.receivingAccountId } : {}),
      ...(p.bankTxn ? { bankTxn: p.bankTxn } : {}),
    });
    const confirmable =
      p.method === "cash" || (Boolean(p.bankTxn) && canGrant(ctx, "payment.confirm_transfer"));
    if (!confirmable) {
      paid.push({ paymentId, status: "pending", receiptNo: null });
      continue;
    }
    const c = await confirmPayment(ctx, { paymentId, now });
    paid.push({ paymentId, status: "confirmed", receiptNo: c.receiptNo });
    await allocateToFolio(
      ctx,
      paymentId,
      invoiceId,
      stay.property_id,
      Math.min(p.amount, await openAmount(ctx, invoiceId)),
      now,
    );
  }

  // (3) Còn nợ: khấu trừ cọc chờ duyệt và/hoặc cho nợ có thẩm quyền.
  let balance = await openAmount(ctx, invoiceId);
  const dep = await sql<{ id: string; balance: string }>`
    select id, balance::text from deposits where organization_id = ${ctx.actor.orgId} and reservation_id = ${stay.reservation_id}`.execute(
    ctx.trx,
  );
  const deposit = dep.rows[0];
  let deductionApprovalId: string | null = null;
  let secured = 0;
  if (input.depositDeduction) {
    if (!deposit) throw fieldError("deposit_deduction", "no_deposit", "Booking không có cọc");
    const r = await requestDeduction(ctx, {
      depositId: deposit.id,
      invoiceId,
      amount: input.depositDeduction.amount,
      reason: input.depositDeduction.reason,
    });
    deductionApprovalId = r.approvalRequestId;
    secured = input.depositDeduction.amount;
  }
  const remaining = balance - secured;
  let allowBalanceApprovalId: string | null = null;
  let debtor: { personId: string; dueDate: string } | null = null;
  if (remaining > 0) {
    if (!input.allowBalance)
      throw new CommandError("OUTSTANDING_BALANCE", 409, "Khách còn nợ. Cần quản lý cho phép và hạn trả.", {
        extensions: { items: [{ balance: remaining }] },
      });
    allowBalanceApprovalId = await assertAllowBalance(ctx, stay.id, remaining, input.allowBalance);
    debtor = { personId: input.allowBalance.debtorPersonId, dueDate: input.allowBalance.dueDate };
  } else if (balance > 0) {
    debtor = { personId: payer, dueDate: day };
  }

  // (4) Hoàn cọc cho chính khách khi folio đã thu đủ.
  let depositRefundStatus: CheckoutResult["depositRefundStatus"] = null;
  let depositRefundApprovalId: string | null = null;
  if (input.depositRefund) {
    if (!deposit) throw fieldError("deposit_refund", "no_deposit", "Booking không có cọc");
    if (balance > 0 || deductionApprovalId)
      throw new CommandError("OUTSTANDING_BALANCE", 409, "Khách còn nợ — chỉ hoàn cọc khi folio đã thu đủ.", {
        extensions: { items: [{ balance }] },
      });
    const refund =
      input.depositRefund.method === "cash"
        ? ({ method: "cash" } as const)
        : ({
            method: "bank_transfer",
            receivingAccountId: input.depositRefund.receivingAccountId ?? "",
          } as const);
    const r = await refundDepositAtCheckout(ctx, {
      depositId: deposit.id,
      amount: input.depositRefund.amount,
      refund,
      stayId: stay.id,
      reason: "Hoàn cọc khi trả phòng",
      now,
    });
    depositRefundStatus = r.status;
    depositRefundApprovalId = r.status === "pending_approval" ? r.approvalRequestId : null;
  }

  // (5) Trạng thái, lịch phòng, buồng phòng.
  await sql`
    update stays set status = 'checked_out', checked_out_at = ${now}, checked_out_by = ${ctx.actor.membershipId},
           debtor_person_id = ${debtor?.personId ?? null}, debt_due_date = ${debtor?.dueDate ?? null}::date,
           allow_balance_approval_id = ${allowBalanceApprovalId}, version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${stay.id}`.execute(ctx.trx);
  await sql`update reservations set status = 'checked_out', version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${stay.reservation_id}`.execute(ctx.trx);
  const alloc = await sql<{ id: string; lo: Date; hi: Date | null }>`
    select a.id, lower(a.during) as lo, upper(a.during) as hi from allocations a
    join reservation_items i on i.organization_id = a.organization_id and i.allocation_id = a.id
    where a.organization_id = ${ctx.actor.orgId} and i.reservation_id = ${stay.reservation_id} and a.active for update of a`.execute(
    ctx.trx,
  );
  const a = alloc.rows[0];
  if (a) {
    if (now.getTime() <= a.lo.getTime()) {
      await sql`update allocations set active = false, deactivated_at = ${now}, deactivated_reason = 'ended'
                where organization_id = ${ctx.actor.orgId} and id = ${a.id}`.execute(ctx.trx);
    } else if (!a.hi || now.getTime() < a.hi.getTime()) {
      // Trả sớm: nhả phòng ngay. Trả muộn: KHÔNG kéo dài hồi tố — giờ thực lưu ở stays (S-020).
      await sql`update allocations set during = tstzrange(lower(during), ${now}, '[)')
                where organization_id = ${ctx.actor.orgId} and id = ${a.id}`.execute(ctx.trx);
    }
  }
  const unit = await sql<{
    unit_id: string;
  }>`select unit_id from stays where organization_id = ${ctx.actor.orgId} and id = ${stay.id}`.execute(
    ctx.trx,
  );
  await createCleaningTask(ctx, {
    propertyId: stay.property_id,
    unitId: unit.rows[0]?.unit_id as string,
    sourceType: "stay",
    sourceId: stay.id,
  });
  await ctx.audit({
    action: debtor ? "stay.checked_out_with_balance" : "stay.checked_out",
    entityType: "stay",
    entityId: stay.id,
    propertyId: stay.property_id,
    before: { status: "in_house" },
    after: {
      status: "checked_out",
      invoice_id: invoiceId,
      total,
      balance,
      deposit_refund: depositRefundStatus,
      deduction_approval_id: deductionApprovalId,
    },
  });
  await ctx.emit({
    eventType: "invoice.issued",
    aggregateType: "invoice",
    aggregateId: invoiceId,
    propertyId: stay.property_id,
    payload: { invoice_id: invoiceId, stay_id: stay.id },
  });
  await ctx.emit({
    eventType: "stay.checked_out",
    aggregateType: "stay",
    aggregateId: stay.id,
    propertyId: stay.property_id,
    payload: { stay_id: stay.id, with_balance: debtor !== null },
  });
  balance = await openAmount(ctx, invoiceId);
  return {
    stayId: stay.id,
    invoiceId,
    total,
    balance,
    payments: paid,
    depositRefundStatus,
    depositRefundApprovalId,
    deductionApprovalId,
  };
}

let registered = false;
/** Duyệt `allow_balance` = cấp phép cho nợ khi trả phòng; check-out tiêu thụ đúng một lần (unique trên stays). */
export function registerCheckoutExecutors(): void {
  if (registered) return;
  registered = true;
  registerApprovalExecutor("allow_balance", {
    async execute(ctx, req) {
      if (req.subjectType !== "stay" || !req.subjectId || req.amount === null)
        throw new CommandError("VALIDATION_FAILED", 422, "Yêu cầu cho nợ phải gắn lượt ở và số tiền");
      const s = await sql<{ status: string }>`
        select status from stays where organization_id = ${ctx.actor.orgId} and id = ${req.subjectId}`.execute(
        ctx.trx,
      );
      if (s.rows[0]?.status !== "in_house")
        throw new CommandError("INVALID_TRANSITION", 409, "Chỉ cho nợ lượt ở đang ở", {
          extensions: { from: s.rows[0]?.status ?? "none", to: "checked_out" },
        });
      return { granted: true };
    },
  });
}

registerCheckoutExecutors();
