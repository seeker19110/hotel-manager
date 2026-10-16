// Chốt kỳ sổ, điều chỉnh sau phát hành và báo cáo tài chính (PLAN đợt 2 T-108; SPEC-ledger S-022…S-024, S-032; INV-F6,
// INV-G4). Kỳ khoá theo `business_date` của cơ sở: khoá tới ngày D ⇒ mọi chứng từ ngày ≤ D bị CSDL từ chối (PERIOD_LOCKED);
// sửa số sau khoá chỉ bằng chứng từ điều chỉnh ghi vào kỳ đang mở, tham chiếu phiếu gốc, có người khác duyệt.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize, generateMemoRef } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import { assertPropertyInOrg } from "../access/scope.ts";
import { type ApprovalRow, registerApprovalExecutor, requestApproval } from "../approvals/approvals.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";
import { postEntry } from "./ledger.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(d: string, field: string): void {
  const t = new Date(`${d}T00:00:00Z`);
  if (!DATE.test(d) || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) {
    throw new CommandError("VALIDATION_FAILED", 422, `${field} không hợp lệ (YYYY-MM-DD)`);
  }
}

function requireReason(reason: string | undefined, what: string): string {
  const r = reason?.trim() ?? "";
  if (!r) throw new CommandError("VALIDATION_FAILED", 422, `${what} cần lý do`);
  if (r.length > 1000) throw new CommandError("VALIDATION_FAILED", 422, "Lý do quá dài");
  return r;
}

async function businessToday(trx: Transaction<unknown>, orgId: string, propertyId: string): Promise<string> {
  const r = await sql<{
    d: string | null;
  }>`select app.business_date(${orgId}, ${propertyId})::text as d`.execute(trx);
  const d = r.rows[0]?.d;
  if (!d) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  return d;
}

async function lockedThrough(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
): Promise<string | null> {
  const r = await sql<{
    d: string | null;
  }>`select app.locked_through(${orgId}, ${propertyId})::text as d`.execute(trx);
  return r.rows[0]?.d ?? null;
}

/** Tuần tự hoá chốt/mở khoá của một cơ sở. */
async function lockProperty(trx: Transaction<unknown>, propertyId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`period:${propertyId}`}, 0))`.execute(trx);
}

/** `ledger.lockPeriod` (S-032): owner/manager/kế toán; chỉ khoá ngày đã qua; khoá tiến, không lùi (lùi = mở khoá). */
export async function lockPeriod(
  ctx: CommandContext,
  input: { propertyId: string; lockedThrough: string; reason: string },
): Promise<{ periodLockId: string; lockedThrough: string }> {
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  authorize(ctx.actor, "period.lock", { propertyId: input.propertyId });
  assertDate(input.lockedThrough, "Ngày khoá");
  const reason = requireReason(input.reason, "Chốt kỳ");
  await lockProperty(ctx.trx, input.propertyId);
  const today = await businessToday(ctx.trx, ctx.actor.orgId, input.propertyId);
  if (input.lockedThrough >= today) {
    throw new CommandError("VALIDATION_FAILED", 422, `Chỉ khoá ngày kinh doanh đã qua (hôm nay ${today})`);
  }
  const current = await lockedThrough(ctx.trx, ctx.actor.orgId, input.propertyId);
  if (current && current >= input.lockedThrough) {
    throw new CommandError("INVALID_TRANSITION", 409, `Kỳ đã khoá tới ${current}`);
  }
  // Một cơ chế khoá (SPEC-metering mục 5): kỳ thu trong khoảng khoá phải đã phát hành, rồi chuyển sang `locked`.
  const open = await sql<{ n: number }>`
    select count(*)::int as n from billing_periods
    where organization_id = ${ctx.actor.orgId} and property_id = ${input.propertyId} and period_end <= ${input.lockedThrough}::date
      and status in ('draft','reviewing')`.execute(ctx.trx);
  if ((open.rows[0]?.n ?? 0) > 0) {
    throw new CommandError("INVALID_TRANSITION", 409, "Còn kỳ thu chưa phát hành trong khoảng khoá");
  }
  const id = randomUUID();
  await sql`
    insert into period_locks (id, organization_id, property_id, locked_through, locked_by, reason, command_id)
    values (${id}, ${ctx.actor.orgId}, ${input.propertyId}, ${input.lockedThrough}::date, ${ctx.actor.membershipId}, ${reason},
            ${ctx.commandId})`.execute(ctx.trx);
  await sql`
    update billing_periods set status = 'locked', version = version + 1
    where organization_id = ${ctx.actor.orgId} and property_id = ${input.propertyId} and status = 'issued'
      and period_end <= ${input.lockedThrough}::date`.execute(ctx.trx);
  await ctx.audit({
    action: "period.locked",
    entityType: "period_lock",
    entityId: id,
    propertyId: input.propertyId,
    before: { locked_through: current },
    after: { locked_through: input.lockedThrough },
    reason,
  });
  await ctx.emit({
    eventType: "period.locked",
    aggregateType: "period_lock",
    aggregateId: id,
    propertyId: input.propertyId,
    payload: { period_lock_id: id, locked_through: input.lockedThrough },
  });
  return { periodLockId: id, lockedThrough: input.lockedThrough };
}

/**
 * `ledger.unlockPeriod` (S-023): chỉ owner, bắt buộc lý do. Mở khoá từ ngày `from`: mọi khoá hiệu lực có `locked_through ≥ from`
 * được điền `released_*` (không xoá dòng). Không có gì để mở → INVALID_TRANSITION. Chứng từ đã phát hành vẫn bất biến.
 */
export async function unlockPeriod(
  ctx: CommandContext,
  input: { propertyId: string; from: string; reason: string },
): Promise<{ releasedIds: string[]; lockedThrough: string | null }> {
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  authorize(ctx.actor, "period.unlock", { propertyId: input.propertyId });
  const reason = requireReason(input.reason, "Mở khoá kỳ");
  assertDate(input.from, "Ngày bắt đầu mở khoá");
  await lockProperty(ctx.trx, input.propertyId);
  const released = await sql<{ id: string; locked_through: string }>`
    update period_locks set released_by = ${ctx.actor.membershipId}, released_at = now(), release_reason = ${reason}
    where organization_id = ${ctx.actor.orgId} and property_id = ${input.propertyId} and released_at is null
      and locked_through >= ${input.from}::date
    returning id, locked_through::text`.execute(ctx.trx);
  if (released.rows.length === 0) throw new CommandError("INVALID_TRANSITION", 409, "Kỳ này không đang khoá");
  const after = await lockedThrough(ctx.trx, ctx.actor.orgId, input.propertyId);
  await sql`
    update billing_periods set status = 'issued', version = version + 1
    where organization_id = ${ctx.actor.orgId} and property_id = ${input.propertyId} and status = 'locked'
      and (${after}::date is null or period_end > ${after}::date)`.execute(ctx.trx);
  await ctx.audit({
    action: "period.unlocked",
    entityType: "property",
    entityId: input.propertyId,
    propertyId: input.propertyId,
    before: {
      locked_through: released.rows
        .map((r) => r.locked_through)
        .sort()
        .at(-1),
    },
    after: { locked_through: after, released: released.rows.map((r) => r.id) },
    reason,
  });
  await ctx.emit({
    eventType: "period.unlocked",
    aggregateType: "property",
    aggregateId: input.propertyId,
    propertyId: input.propertyId,
    payload: { locked_through: after },
  });
  return { releasedIds: released.rows.map((r) => r.id), lockedThrough: after };
}

interface InvoiceForAdjust {
  id: string;
  property_id: string;
  kind: string;
  number: string;
  payer_person_id: string;
  open_amount: string;
}

async function readInvoice(ctx: CommandContext, invoiceId: string, lock: boolean): Promise<InvoiceForAdjust> {
  if (!UUID.test(invoiceId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
  const r = await sql<InvoiceForAdjust>`
    select id, property_id, kind, number, payer_person_id, open_amount from invoices
    where organization_id = ${ctx.actor.orgId} and id = ${invoiceId} ${lock ? sql`for update` : sql``}`.execute(
    ctx.trx,
  );
  const inv = r.rows[0];
  if (!inv) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
  return inv;
}

function checkAdjustment(inv: InvoiceForAdjust, amount: number): void {
  if (inv.kind === "adjustment")
    throw new CommandError("VALIDATION_FAILED", 422, "Không điều chỉnh một phiếu điều chỉnh");
  if (amount > Number(inv.open_amount)) {
    throw new CommandError(
      "OVER_ALLOCATION",
      409,
      `Điều chỉnh ${amount} vượt số còn phải thu ${inv.open_amount} (đã thu thì hoàn qua credit.requestRefund)`,
    );
  }
}

/**
 * `ledger.issueAdjustment` (S-022): đề nghị GIẢM số phải thu của phiếu gốc (giảm trừ, có lý do). Chỉ tạo yêu cầu duyệt
 * (`adjustment`, hạn mức "Phân bổ tiền, điều chỉnh có lý do"); bút toán Nợ DISCOUNT / Có AR ghi vào kỳ đang mở khi người
 * khác người lập duyệt. Tăng tiền không đi đường này — phát hành phiếu phí mới (SPEC-metering-billing).
 */
export async function issueAdjustment(
  ctx: CommandContext,
  input: { invoiceId: string; amount: number; reason: string },
): Promise<{ approvalRequestId: string }> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new CommandError("VALIDATION_FAILED", 422, "Số tiền giảm phải là số nguyên đồng dương");
  }
  const reason = requireReason(input.reason, "Điều chỉnh");
  const inv = await readInvoice(ctx, input.invoiceId, false);
  checkAdjustment(inv, input.amount);
  return requestApproval(ctx, {
    kind: "adjustment",
    amount: input.amount,
    reason,
    propertyId: inv.property_id,
    subjectType: "invoice",
    subjectId: inv.id,
    payload: {},
  });
}

let registered = false;

export function registerPeriodCloseExecutors(): void {
  if (registered) return;
  registered = true;
  registerApprovalExecutor("adjustment", {
    context: async () => ({ atCheckout: false }),
    async execute(ctx, req: ApprovalRow) {
      const amount = req.amount as number;
      const inv = await readInvoice(ctx, req.subjectId as string, true);
      checkAdjustment(inv, amount);
      const businessDate = await businessToday(ctx.trx, ctx.actor.orgId, inv.property_id);
      const n = await sql<{ n: string }>`
        select app.next_number(${ctx.actor.orgId}, ${inv.property_id}, 'adjustment')::text as n`.execute(
        ctx.trx,
      );
      const number = `DC-${String(n.rows[0]?.n).padStart(6, "0")}`;
      let memoRef = generateMemoRef();
      for (let i = 0; i < 5; i++) {
        const used =
          await sql`select 1 from invoices where organization_id = ${ctx.actor.orgId} and memo_ref = ${memoRef}`.execute(
            ctx.trx,
          );
        if (used.rows.length === 0) break;
        memoRef = generateMemoRef();
      }
      const adjId = randomUUID();
      const lineId = randomUUID();
      await sql`
        insert into invoices (id, organization_id, property_id, kind, adjusts_invoice_id, number, memo_ref, payer_person_id,
                              business_date, total, created_by, command_id)
        values (${adjId}, ${ctx.actor.orgId}, ${inv.property_id}, 'adjustment', ${inv.id}, ${number}, ${memoRef},
                ${inv.payer_person_id}, ${businessDate}::date, ${-amount}, ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(
        ctx.trx,
      );
      await sql`
        insert into invoice_lines (id, organization_id, property_id, invoice_id, line_no, kind, description, revenue_account,
                                   quantity, unit_price, amount, rounding_rule, formula_version)
        values (${lineId}, ${ctx.actor.orgId}, ${inv.property_id}, ${adjId}, 1, 'discount',
                ${`Giảm trừ phiếu ${inv.number}: ${req.reason}`.slice(0, 500)}, 'DISCOUNT', 1, ${-amount}, ${-amount},
                'HALF_UP_1', 1)`.execute(ctx.trx);
      const entryId = await postEntry(ctx.trx, {
        orgId: ctx.actor.orgId,
        propertyId: inv.property_id,
        entryType: "adjustment",
        businessDate,
        sourceDocType: "invoice",
        sourceDocId: adjId,
        createdBy: ctx.actor.membershipId,
        commandId: ctx.commandId,
        memo: req.reason,
        lines: [
          { account: "DISCOUNT", debit: amount, credit: 0, invoiceId: adjId, invoiceLineId: lineId },
          { account: "AR", debit: 0, credit: amount, invoiceId: inv.id, personId: inv.payer_person_id },
        ],
      });
      await sql`update invoices set adjusted_total = adjusted_total - ${amount}, version = version + 1
                where organization_id = ${ctx.actor.orgId} and id = ${inv.id}`.execute(ctx.trx);
      await ctx.audit({
        action: "invoice.adjusted",
        entityType: "invoice",
        entityId: inv.id,
        propertyId: inv.property_id,
        after: { adjustment_invoice_id: adjId, number, amount: -amount, entry_id: entryId },
        reason: req.reason,
      });
      return { adjustmentInvoiceId: adjId, number, entryId };
    },
  });
}

registerPeriodCloseExecutors();

export interface FinancialSummary {
  property_id: string;
  from: string;
  to: string;
  locked_through: string | null;
  /** Doanh thu theo tài khoản (Có − Nợ) phát sinh trong kỳ; giảm trừ tách riêng. */
  revenue: { by_account: Record<string, number>; discounts: number; net: number };
  /** Tiền thực thu trong kỳ (CASH/BANK, đã trừ khoản đảo): thanh toán và cọc tách dòng; tiền chi hoàn tách dòng. */
  cash_flow: { payments_received: number; deposits_received: number; refunds_paid: number };
  /** Số dư tới hết ngày `to`. */
  balances: { receivables: number; deposits_held: number; customer_credit: number };
  /** Công nợ theo phiếu (khớp tổng `balances.receivables`). */
  receivables: { invoice_id: string; number: string; payer_person_id: string; balance: number }[];
}

/** `report.financialSummary` (S-024): mọi số đọc từ sổ phụ (journal_lines) — một nguồn sự thật. */
export async function financialSummary(
  db: Kysely<unknown>,
  actor: Actor,
  input: { propertyId: string; from: string; to: string },
): Promise<FinancialSummary> {
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  assertDate(input.from, "Từ ngày");
  assertDate(input.to, "Đến ngày");
  if (input.from > input.to) throw new CommandError("VALIDATION_FAILED", 422, "Từ ngày phải ≤ đến ngày");
  authorize(actor, "money.read", { propertyId: input.propertyId });
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    await assertPropertyInOrg(trx, actor.orgId, input.propertyId);
    const flows = await sql<{ account: string; kind: string; dr: string; cr: string }>`
      select l.account,
             case when e.entry_type = 'reversal' then coalesce(o.entry_type, 'reversal') else e.entry_type end as kind,
             sum(l.debit)::text as dr, sum(l.credit)::text as cr
      from journal_lines l
      join journal_entries e on e.organization_id = l.organization_id and e.id = l.entry_id
      left join journal_entries o on o.organization_id = e.organization_id and o.id = e.reverses_entry_id
      where l.organization_id = ${actor.orgId} and l.property_id = ${input.propertyId}
        and e.business_date between ${input.from}::date and ${input.to}::date
      group by 1, 2`.execute(trx);
    const byAccount: Record<string, number> = {};
    let discounts = 0;
    const cash = { payments_received: 0, deposits_received: 0, refunds_paid: 0 };
    for (const f of flows.rows) {
      const dr = Number(f.dr);
      const cr = Number(f.cr);
      if (f.account.startsWith("REV_")) byAccount[f.account] = (byAccount[f.account] ?? 0) + cr - dr;
      if (f.account === "DISCOUNT") discounts += dr - cr;
      if (f.account === "CASH" || f.account === "BANK") {
        if (f.kind === "payment_confirmed") cash.payments_received += dr - cr;
        else if (f.kind === "deposit_received") cash.deposits_received += dr - cr;
        else if (f.kind === "deposit_refunded" || f.kind === "credit_refunded") cash.refunds_paid += cr - dr;
      }
    }
    const bal = await sql<{ account: string; bal: string }>`
      select l.account, sum(l.debit - l.credit)::text as bal
      from journal_lines l join journal_entries e on e.organization_id = l.organization_id and e.id = l.entry_id
      where l.organization_id = ${actor.orgId} and l.property_id = ${input.propertyId} and e.business_date <= ${input.to}::date
        and l.account in ('AR','DEPOSIT_LIAB','CUSTOMER_CREDIT')
      group by 1`.execute(trx);
    const b = Object.fromEntries(bal.rows.map((r) => [r.account, Number(r.bal)]));
    const recv = await sql<{ invoice_id: string; number: string; payer_person_id: string; balance: string }>`
      select l.invoice_id, i.number, i.payer_person_id, sum(l.debit - l.credit)::text as balance
      from journal_lines l
      join journal_entries e on e.organization_id = l.organization_id and e.id = l.entry_id
      join invoices i on i.organization_id = l.organization_id and i.id = l.invoice_id
      where l.organization_id = ${actor.orgId} and l.property_id = ${input.propertyId} and l.account = 'AR'
        and e.business_date <= ${input.to}::date
      group by 1, 2, 3 having sum(l.debit - l.credit) <> 0
      order by i.number`.execute(trx);
    const revenueTotal = Object.values(byAccount).reduce((s, v) => s + v, 0);
    return {
      property_id: input.propertyId,
      from: input.from,
      to: input.to,
      locked_through: await lockedThrough(trx, actor.orgId, input.propertyId),
      revenue: { by_account: byAccount, discounts, net: revenueTotal - discounts },
      cash_flow: cash,
      balances: {
        receivables: b.AR ?? 0,
        deposits_held: 0 - (b.DEPOSIT_LIAB ?? 0) || 0,
        customer_credit: 0 - (b.CUSTOMER_CREDIT ?? 0) || 0,
      },
      receivables: recv.rows.map((r) => ({
        invoice_id: r.invoice_id,
        number: r.number,
        payer_person_id: r.payer_person_id,
        balance: Number(r.balance),
      })),
    };
  });
}
