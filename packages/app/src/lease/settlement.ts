// Báo trả + thanh lý hợp đồng (PLAN đợt 2 T-111; SPEC-lease S-016…S-019, S-021, S-025; INV-F5, INV-F1, INV-G4).
// Cọc không tự trừ: lập quyết toán chưa có bút toán; khi người khác người lập duyệt, MỘT transaction ghi theo thứ tự
// (1) phiếu phí phát sinh (Nợ AR / Có REV_FEE) → (2) khấu trừ cọc (Nợ DEPOSIT_LIAB / Có AR, ≤ AR còn mở của phiếu liên kết
// kể cả phiếu phí) → (3) hoàn phần còn lại (Nợ DEPOSIT_LIAB / Có CASH|BANK). Đóng hợp đồng chỉ sau khi duyệt.
import { randomUUID } from "node:crypto";
import { authorize, generateMemoRef } from "@hm/domain";
import { sql } from "kysely";
import { postEntry } from "../ledger/ledger.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";
import { openShiftOf } from "../shifts/shifts.ts";
import { type LeaseStatus, leaseAllocations, leaseInterval, lockLease, transition } from "./lease.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX = Number.MAX_SAFE_INTEGER;

export interface SettlementFee {
  amount: number;
  reason: string;
  fileIds?: readonly string[];
}

export interface SettlementDeduction {
  /** Phiếu liên kết hợp đồng; bỏ trống = phiếu phí phát sinh của chính quyết toán này. */
  invoiceId?: string | null;
  amount: number;
  reason: string;
}

/** Khấu trừ mặc định (S-021): min(cọc, AR còn mở + phí), trả phiếu cũ trước rồi tới phiếu phí. Thuần — dễ kiểm. */
export function defaultDeductions(
  deposit: number,
  openInvoices: readonly { id: string; open: number }[],
  feesTotal: number,
): { invoiceId: string | null; amount: number }[] {
  let left = deposit;
  const out: { invoiceId: string | null; amount: number }[] = [];
  for (const i of openInvoices) {
    const a = Math.min(i.open, left);
    if (a > 0) out.push({ invoiceId: i.id, amount: a });
    left -= a;
  }
  const f = Math.min(feesTotal, left);
  if (f > 0) out.push({ invoiceId: null, amount: f });
  return out;
}

async function businessDate(ctx: CommandContext, propertyId: string): Promise<string> {
  const r = await sql<{
    d: string;
  }>`select app.business_date(${ctx.actor.orgId}, ${propertyId})::text as d`.execute(ctx.trx);
  return r.rows[0]?.d as string;
}

/** `lease.giveNotice` (S-016): active → notice_given, ghi ngày dự kiến trả; allocation chưa đổi. */
export async function giveNotice(
  ctx: CommandContext,
  input: { leaseId: string; plannedMoveOutOn: string },
): Promise<{ status: LeaseStatus }> {
  const lease = await lockLease(ctx, input.leaseId, "lease.manage");
  transition(lease, "notice_given");
  if (!DATE.test(input.plannedMoveOutOn) || Number.isNaN(Date.parse(input.plannedMoveOutOn))) {
    throw fieldError("planned_move_out_on", "INVALID_DATE", "Ngày dự kiến trả không hợp lệ");
  }
  await sql`update leases set status = 'notice_given', planned_move_out_on = ${input.plannedMoveOutOn}::date, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${lease.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "lease.notice_given",
    entityType: "lease",
    entityId: lease.id,
    propertyId: lease.property_id,
    before: { status: lease.status },
    after: { status: "notice_given", planned_move_out_on: input.plannedMoveOutOn },
  });
  return { status: "notice_given" };
}

interface LinkedInvoice {
  id: string;
  number: string;
  open: number;
}

async function linkedOpenInvoices(
  ctx: CommandContext,
  leaseId: string,
  lock: boolean,
): Promise<LinkedInvoice[]> {
  const r = await sql<{ id: string; number: string; open_amount: string }>`
    select id, number, open_amount from invoices
    where organization_id = ${ctx.actor.orgId} and lease_id = ${leaseId} and open_amount > 0
    order by due_on nulls last, business_date, number, id ${lock ? sql`for update` : sql``}`.execute(ctx.trx);
  return r.rows.map((x) => ({ id: x.id, number: x.number, open: Number(x.open_amount) }));
}

async function depositOf(ctx: CommandContext, leaseId: string, lock: boolean) {
  const r = await sql<{ id: string; balance: string }>`
    select id, balance from deposits where organization_id = ${ctx.actor.orgId} and lease_id = ${leaseId}
    ${lock ? sql`for update` : sql``}`.execute(ctx.trx);
  const d = r.rows[0];
  return d ? { id: d.id, balance: Number(d.balance) } : null;
}

export interface SettlementSummary {
  settlementId: string;
  outstandingAr: number;
  depositBalance: number;
  feesTotal: number;
  deductionsTotal: number;
  refundAmount: number;
  /** Nợ còn lại sau thanh lý = nợ + phí − khấu trừ. */
  debtAfter: number;
}

/**
 * `lease.prepareSettlement` (S-017, S-021, S-025): bảng quyết toán — chưa có bút toán. Khấu trừ mỗi phiếu ≤ AR còn mở của
 * phiếu đó (phiếu phí: ≤ tổng phí), Σ ≤ cọc còn giữ; lập lại khi còn `prepared` thì thay bản cũ.
 */
export async function prepareSettlement(
  ctx: CommandContext,
  input: { leaseId: string; fees: readonly SettlementFee[]; deductions?: readonly SettlementDeduction[] },
): Promise<SettlementSummary> {
  if (!UUID.test(input.leaseId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy hợp đồng");
  const l = await sql<{ id: string; property_id: string; status: LeaseStatus }>`
    select id, property_id, status from leases where organization_id = ${ctx.actor.orgId} and id = ${input.leaseId}`.execute(
    ctx.trx,
  );
  const lease = l.rows[0];
  if (!lease) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy hợp đồng");
  const authz = authorize(ctx.actor, "lease.prepare_settlement", { propertyId: lease.property_id });
  if (!["yes", "request"].includes(authz.grant))
    throw new CommandError("FORBIDDEN", 403, "Không có quyền lập quyết toán");
  const moveOut =
    await sql`select 1 from handovers where organization_id = ${ctx.actor.orgId} and lease_id = ${lease.id}
                            and kind = 'move_out' and confirmed_at is not null`.execute(ctx.trx);
  if (moveOut.rows.length === 0)
    throw new CommandError("HANDOVER_REQUIRED", 409, "Cần biên bản bàn giao trả phòng trước.");
  if (lease.status !== "settling") {
    throw new CommandError("INVALID_TRANSITION", 409, "Chỉ lập quyết toán khi hợp đồng đang thanh lý", {
      extensions: { from: lease.status },
    });
  }
  if (input.fees.length > 20) throw fieldError("fees", "TOO_MANY", "Tối đa 20 khoản phí");
  const fileIds: string[] = [];
  input.fees.forEach((f, i) => {
    if (!Number.isSafeInteger(f.amount) || f.amount <= 0)
      throw fieldError(`fees[${i}].amount`, "INVALID", "Phí là số nguyên đồng dương");
    if (!f.reason.trim() || f.reason.length > 500)
      throw fieldError(`fees[${i}].reason`, "REQUIRED", "Phí cần lý do (≤ 500 ký tự)");
    for (const [j, id] of (f.fileIds ?? []).entries()) {
      if (!UUID.test(id)) throw fieldError(`fees[${i}].file_ids[${j}]`, "INVALID", "Ảnh không hợp lệ");
      fileIds.push(id);
    }
  });
  if (fileIds.length > 0) {
    const f = await sql<{ id: string }>`
      select id from files where organization_id = ${ctx.actor.orgId} and owner_type in ('lease_settlement','handover')
        and id = any(${fileIds}::uuid[])`.execute(ctx.trx);
    if (f.rows.length !== new Set(fileIds).size)
      throw fieldError("fees", "FILE_NOT_FOUND", "Ảnh chứng cứ không tồn tại");
  }
  const feesTotal = input.fees.reduce((s, f) => s + f.amount, 0);
  if (feesTotal > MAX) throw fieldError("fees", "TOO_LARGE", "Tổng phí quá lớn");
  const deposit = await depositOf(ctx, lease.id, false);
  const depositBalance = deposit?.balance ?? 0;
  const invoices = await linkedOpenInvoices(ctx, lease.id, false);
  const outstandingAr = invoices.reduce((s, i) => s + i.open, 0);

  const deductions: { invoiceId: string | null; amount: number; reason: string }[] = input.deductions
    ? input.deductions.map((d) => ({ invoiceId: d.invoiceId ?? null, amount: d.amount, reason: d.reason }))
    : defaultDeductions(depositBalance, invoices, feesTotal).map((d) => ({
        ...d,
        reason: "Đối trừ cọc khi thanh lý",
      }));
  const perInvoice = new Map<string, number>();
  let feeDeducted = 0;
  let total = 0;
  deductions.forEach((d, i) => {
    const field = `deductions[${i}].amount`;
    if (!Number.isSafeInteger(d.amount) || d.amount <= 0)
      throw fieldError(field, "INVALID", "Khấu trừ là số nguyên đồng dương");
    if (!d.reason.trim()) throw fieldError(`deductions[${i}].reason`, "REQUIRED", "Khấu trừ cần lý do");
    total += d.amount;
    if (d.invoiceId === null) {
      feeDeducted += d.amount;
      if (feeDeducted > feesTotal) throw fieldError(field, "EXCEEDS_OPEN_AR", "Khấu trừ vượt phí phát sinh");
    } else {
      const inv = invoices.find((x) => x.id === d.invoiceId);
      if (!inv)
        throw fieldError(
          `deductions[${i}].invoice_id`,
          "NOT_LINKED",
          "Phiếu không thuộc hợp đồng hoặc đã tất toán",
        );
      const used = (perInvoice.get(inv.id) ?? 0) + d.amount;
      if (used > inv.open) {
        throw fieldError(
          field,
          "EXCEEDS_OPEN_AR",
          `Khấu trừ vượt AR còn mở ${inv.open} của phiếu ${inv.number}`,
        );
      }
      perInvoice.set(inv.id, used);
    }
    if (total > depositBalance)
      throw fieldError(field, "EXCEEDS_DEPOSIT", `Khấu trừ vượt cọc còn giữ ${depositBalance}`);
  });
  const refundAmount = depositBalance - total;
  const id = randomUUID();
  const fees = input.fees.map((f) => ({
    amount: f.amount,
    reason: f.reason.trim(),
    file_ids: f.fileIds ?? [],
  }));
  const ded = deductions.map((d) => ({ invoice_id: d.invoiceId, amount: d.amount, reason: d.reason.trim() }));
  const r = await sql<{ id: string }>`
    insert into lease_settlements (id, organization_id, property_id, lease_id, outstanding_ar, deposit_balance, fees, deductions,
                                   refund_amount, prepared_by, command_id)
    values (${id}, ${ctx.actor.orgId}, ${lease.property_id}, ${lease.id}, ${outstandingAr}, ${depositBalance},
            ${JSON.stringify(fees)}::jsonb, ${JSON.stringify(ded)}::jsonb, ${refundAmount}, ${ctx.actor.membershipId}, ${ctx.commandId})
    on conflict (organization_id, lease_id) do update
      set outstanding_ar = excluded.outstanding_ar, deposit_balance = excluded.deposit_balance, fees = excluded.fees,
          deductions = excluded.deductions, refund_amount = excluded.refund_amount, prepared_by = excluded.prepared_by,
          command_id = excluded.command_id, version = lease_settlements.version + 1
    returning id`.execute(ctx.trx);
  const settlementId = r.rows[0]?.id as string;
  const summary: SettlementSummary = {
    settlementId,
    outstandingAr,
    depositBalance,
    feesTotal,
    deductionsTotal: total,
    refundAmount,
    debtAfter: outstandingAr + feesTotal - total,
  };
  await ctx.audit({
    action: "lease.settlement_prepared",
    entityType: "lease_settlement",
    entityId: settlementId,
    propertyId: lease.property_id,
    after: summary,
  });
  return summary;
}

interface SettlementRow {
  id: string;
  property_id: string;
  lease_id: string;
  status: string;
  deposit_balance: string;
  fees: { amount: number; reason: string }[];
  deductions: { invoice_id: string | null; amount: number; reason: string }[];
  refund_amount: string;
  prepared_by: string;
}

/**
 * `lease.approveSettlement` (S-017, S-019): người duyệt ≠ người lập; hạn mức theo vai trò cho khoản lớn nhất (khấu trừ/hoàn).
 * Kiểm lại cọc và AR dưới khoá — số liệu đã đổi kể từ lúc lập ⇒ INVALID_TRANSITION (lập lại).
 */
export async function approveSettlement(
  ctx: CommandContext,
  input: {
    settlementId: string;
    refund?: { method: "cash" } | { method: "bank_transfer"; receivingAccountId: string };
  },
): Promise<{ feeInvoiceId: string | null; deductionEntryId: string | null; refundEntryId: string | null }> {
  if (!UUID.test(input.settlementId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy quyết toán");
  const read = (lock: boolean) =>
    sql<SettlementRow>`
      select id, property_id, lease_id, status, deposit_balance, fees, deductions, refund_amount, prepared_by
      from lease_settlements where organization_id = ${ctx.actor.orgId} and id = ${input.settlementId}
      ${lock ? sql`for update` : sql``}`.execute(ctx.trx);
  const seen = (await read(false)).rows[0];
  if (!seen) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy quyết toán");
  const deductionsTotal = seen.deductions.reduce((s, d) => s + d.amount, 0);
  const authz = authorize(ctx.actor, "lease.approve_settlement", {
    propertyId: seen.property_id,
    amount: Math.max(deductionsTotal, Number(seen.refund_amount)),
  });
  if (authz.grant !== "yes" && authz.grant !== "limit")
    throw new CommandError("FORBIDDEN", 403, "Không có quyền duyệt quyết toán");
  if (seen.prepared_by === ctx.actor.membershipId) {
    throw new CommandError("SELF_APPROVAL_FORBIDDEN", 403, "Bạn không thể tự duyệt chứng từ mình lập.");
  }
  const s = (await read(true)).rows[0] as SettlementRow;
  if (s.status !== "prepared") throw new CommandError("INVALID_TRANSITION", 409, "Quyết toán đã duyệt");
  const lease = await lockLease(ctx, s.lease_id, "lease.manage");
  if (lease.status !== "settling") {
    throw new CommandError("INVALID_TRANSITION", 409, "Hợp đồng không ở trạng thái thanh lý", {
      extensions: { from: lease.status },
    });
  }
  const deposit = await depositOf(ctx, lease.id, true);
  const invoices = await linkedOpenInvoices(ctx, lease.id, true);
  const stale = () =>
    new CommandError("INVALID_TRANSITION", 409, "Số liệu cọc/công nợ đã đổi từ lúc lập — lập lại quyết toán");
  if ((deposit?.balance ?? 0) !== Number(s.deposit_balance)) throw stale();
  const used = new Map<string, number>();
  for (const d of s.deductions) {
    if (d.invoice_id === null) continue;
    const inv = invoices.find((x) => x.id === d.invoice_id);
    const u = (used.get(d.invoice_id) ?? 0) + d.amount;
    if (!inv || u > inv.open) throw stale();
    used.set(d.invoice_id, u);
  }
  const refundAmount = Number(s.refund_amount);
  const day = await businessDate(ctx, lease.property_id);
  const rep = await sql<{ representative_person_id: string }>`
    select representative_person_id from leases where organization_id = ${ctx.actor.orgId} and id = ${lease.id}`.execute(
    ctx.trx,
  );
  const payer = rep.rows[0]?.representative_person_id as string;

  // (1) Phiếu phí phát sinh.
  let feeInvoiceId: string | null = null;
  const feesTotal = s.fees.reduce((sum, f) => sum + f.amount, 0);
  if (feesTotal > 0) {
    feeInvoiceId = randomUUID();
    const n = await sql<{
      n: string;
    }>`select app.next_number(${ctx.actor.orgId}, ${lease.property_id}, 'invoice')::text as n`.execute(
      ctx.trx,
    );
    const number = `PTT-${String(n.rows[0]?.n).padStart(6, "0")}`;
    await sql`
      insert into invoices (id, organization_id, property_id, kind, lease_id, number, memo_ref, payer_person_id, business_date,
                            total, created_by, command_id)
      values (${feeInvoiceId}, ${ctx.actor.orgId}, ${lease.property_id}, 'fee', ${lease.id}, ${number}, ${generateMemoRef()},
              ${payer}, ${day}::date, ${feesTotal}, ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(
      ctx.trx,
    );
    const lines: {
      account: "REV_FEE";
      debit: number;
      credit: number;
      invoiceId: string;
      invoiceLineId: string;
    }[] = [];
    for (const [i, f] of s.fees.entries()) {
      const lineId = randomUUID();
      await sql`
        insert into invoice_lines (id, organization_id, property_id, invoice_id, line_no, kind, description, revenue_account,
                                   quantity, unit_price, amount, rounding_rule, formula_version)
        values (${lineId}, ${ctx.actor.orgId}, ${lease.property_id}, ${feeInvoiceId}, ${i + 1}, 'fee', ${f.reason}, 'REV_FEE',
                1, ${f.amount}, ${f.amount}, 'HALF_UP_1', 1)`.execute(ctx.trx);
      lines.push({
        account: "REV_FEE",
        debit: 0,
        credit: f.amount,
        invoiceId: feeInvoiceId,
        invoiceLineId: lineId,
      });
    }
    await postEntry(ctx.trx, {
      orgId: ctx.actor.orgId,
      propertyId: lease.property_id,
      entryType: "invoice_issued",
      businessDate: day,
      sourceDocType: "invoice",
      sourceDocId: feeInvoiceId,
      createdBy: ctx.actor.membershipId,
      commandId: ctx.commandId,
      lines: [
        { account: "AR", debit: feesTotal, credit: 0, invoiceId: feeInvoiceId, personId: payer },
        ...lines,
      ],
    });
  }

  // (2) Khấu trừ cọc vào AR của phiếu liên kết (kể cả phiếu phí vừa phát hành).
  let deductionEntryId: string | null = null;
  if (deductionsTotal > 0) {
    if (!deposit) throw stale();
    const targets = new Map<string, number>();
    for (const d of s.deductions) {
      const inv = d.invoice_id ?? feeInvoiceId;
      if (!inv) throw stale();
      targets.set(inv, (targets.get(inv) ?? 0) + d.amount);
    }
    deductionEntryId = await postEntry(ctx.trx, {
      orgId: ctx.actor.orgId,
      propertyId: lease.property_id,
      entryType: "deposit_deducted",
      businessDate: day,
      sourceDocType: "lease_settlement",
      sourceDocId: s.id,
      createdBy: ctx.actor.membershipId,
      commandId: ctx.commandId,
      lines: [
        { account: "DEPOSIT_LIAB", debit: deductionsTotal, credit: 0, depositId: deposit.id },
        ...[...targets].map(([invoiceId, amount]) => ({
          account: "AR" as const,
          debit: 0,
          credit: amount,
          invoiceId,
          personId: payer,
        })),
      ],
    });
    for (const [invoiceId, amount] of targets) {
      await sql`
        insert into payment_allocations (id, organization_id, property_id, deposit_id, invoice_id, amount, allocated_by, entry_id,
                                         command_id)
        values (${randomUUID()}, ${ctx.actor.orgId}, ${lease.property_id}, ${deposit.id}, ${invoiceId}, ${amount},
                ${ctx.actor.membershipId}, ${deductionEntryId}, ${ctx.commandId})`.execute(ctx.trx);
      await sql`update invoices set allocated_total = allocated_total + ${amount}, version = version + 1
                where organization_id = ${ctx.actor.orgId} and id = ${invoiceId}`.execute(ctx.trx);
    }
    await sql`update deposits set deducted_total = deducted_total + ${deductionsTotal}, version = version + 1
              where organization_id = ${ctx.actor.orgId} and id = ${deposit.id}`.execute(ctx.trx);
  }

  // (3) Hoàn phần còn lại.
  let refundEntryId: string | null = null;
  if (refundAmount > 0) {
    if (!deposit) throw stale();
    if (!input.refund)
      throw fieldError("refund.method", "REQUIRED", "Chọn cách hoàn cọc (tiền mặt/chuyển khoản)");
    let payout:
      | { account: "CASH"; debit: 0; credit: number; shiftId: string }
      | {
          account: "BANK";
          debit: 0;
          credit: number;
          receivingAccountId: string;
        };
    if (input.refund.method === "cash") {
      const shiftId = await openShiftOf(ctx.trx, ctx.actor.orgId, ctx.actor.membershipId, lease.property_id);
      if (!shiftId) throw new CommandError("SHIFT_NOT_OPEN", 409, "Mở ca trước khi chi tiền mặt");
      payout = { account: "CASH", debit: 0, credit: refundAmount, shiftId };
    } else {
      const acct = input.refund.receivingAccountId;
      const ok = UUID.test(acct)
        ? await sql`select 1 from receiving_accounts where organization_id = ${ctx.actor.orgId} and id = ${acct}
                     and property_id = ${lease.property_id} and active`.execute(ctx.trx)
        : { rows: [] };
      if (ok.rows.length === 0)
        throw fieldError("refund.receiving_account_id", "NOT_FOUND", "Tài khoản chi không thuộc cơ sở");
      payout = { account: "BANK", debit: 0, credit: refundAmount, receivingAccountId: acct };
    }
    refundEntryId = await postEntry(ctx.trx, {
      orgId: ctx.actor.orgId,
      propertyId: lease.property_id,
      entryType: "deposit_refunded",
      businessDate: day,
      sourceDocType: "lease_settlement",
      sourceDocId: s.id,
      createdBy: ctx.actor.membershipId,
      commandId: ctx.commandId,
      lines: [{ account: "DEPOSIT_LIAB", debit: refundAmount, credit: 0, depositId: deposit.id }, payout],
    });
    await sql`update deposits set refunded_total = refunded_total + ${refundAmount}, version = version + 1
              where organization_id = ${ctx.actor.orgId} and id = ${deposit.id}`.execute(ctx.trx);
  }

  await sql`
    update lease_settlements set status = 'approved', approved_by = ${ctx.actor.membershipId}, approved_at = now(),
           fee_invoice_id = ${feeInvoiceId}, refund_method = ${refundAmount > 0 ? (input.refund?.method ?? null) : null},
           version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${s.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "lease.settlement_approved",
    entityType: "lease_settlement",
    entityId: s.id,
    propertyId: lease.property_id,
    after: { fee_invoice_id: feeInvoiceId, deductions: deductionsTotal, refund: refundAmount },
  });
  await ctx.emit({
    eventType: "lease.settled",
    aggregateType: "lease",
    aggregateId: lease.id,
    propertyId: lease.property_id,
    payload: { lease_id: lease.id, settlement_id: s.id, refund_amount: refundAmount },
  });
  return { feeInvoiceId, deductionEntryId, refundEntryId };
}

/**
 * `lease.close` (S-017, S-018): settling → closed khi quyết toán đã duyệt (SETTLEMENT_REQUIRED); allocation kết thúc lúc
 * 00:00 giờ cơ sở của ngày sau ngày thực trả. Ở quá hạn (trả sau hạn) không kéo dài allocation đè lên lịch người khác —
 * đã có ngoại lệ LEASE_OVERSTAY.
 */
export async function closeLease(
  ctx: CommandContext,
  input: { leaseId: string },
): Promise<{ status: LeaseStatus }> {
  const lease = await lockLease(ctx, input.leaseId, "lease.manage");
  authorize(ctx.actor, "lease.approve_settlement", { propertyId: lease.property_id, amount: 0 });
  transition(lease, "closed");
  const s =
    await sql`select 1 from lease_settlements where organization_id = ${ctx.actor.orgId} and lease_id = ${lease.id}
                      and status = 'approved'`.execute(ctx.trx);
  if (s.rows.length === 0)
    throw new CommandError("SETTLEMENT_REQUIRED", 409, "Cần duyệt quyết toán trước khi đóng hợp đồng.");
  const m = await sql<{ moved_out_on: string }>`
    select moved_out_on::text from leases where organization_id = ${ctx.actor.orgId} and id = ${lease.id}`.execute(
    ctx.trx,
  );
  const movedOut = m.rows[0]?.moved_out_on as string;
  const end = (await leaseInterval(ctx.trx, ctx.actor.orgId, lease.property_id, movedOut, movedOut))
    .end as Date;
  const alloc = (await leaseAllocations(ctx, lease.id)).find((a) => a.active && a.kind === "lease");
  if (alloc) {
    await sql`
      update allocations set during = tstzrange(lower(during), least(coalesce(upper(during), ${end}), ${end}), '[)')
      where organization_id = ${ctx.actor.orgId} and id = ${alloc.id} and lower(during) < ${end}`.execute(
      ctx.trx,
    );
  }
  await sql`update leases set status = 'closed', version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${lease.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "lease.closed",
    entityType: "lease",
    entityId: lease.id,
    propertyId: lease.property_id,
    before: { status: lease.status },
    after: { status: "closed", moved_out_on: movedOut },
  });
  await ctx.emit({
    eventType: "lease.closed",
    aggregateType: "lease",
    aggregateId: lease.id,
    propertyId: lease.property_id,
    payload: { lease_id: lease.id },
  });
  return { status: "closed" };
}
