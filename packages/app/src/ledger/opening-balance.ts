// Số dư đầu kỳ từ lô nhập chuyển đổi (SPEC-import S-011, S-012; DOMAIN-MODEL §5; INV-F1). Nợ cũ = phiếu `opening_balance`
// + Nợ AR / Có OPENING_BALANCE (không có REV_* ⇒ không bịa doanh thu); cọc đang giữ = `deposits` + Nợ OPENING_BALANCE / Có
// DEPOSIT_LIAB (không CASH/BANK). Ghi ngày kinh doanh = ngày mốc chuyển đổi; kỳ đã khoá ⇒ PERIOD_LOCKED (trigger sổ).
import { randomUUID } from "node:crypto";
import { authorize, generateMemoRef } from "@hm/domain";
import { sql } from "kysely";
import { t } from "../i18n.ts";
import { type CommandContext, CommandError } from "../pipeline/index.ts";
import { postEntry } from "./ledger.ts";

interface LeaseRef {
  id: string;
  status: string;
  property_id: string;
  representative_person_id: string;
}

async function leaseOf(ctx: CommandContext, leaseId: string): Promise<LeaseRef> {
  const r = await sql<LeaseRef>`
    select id, status, property_id, representative_person_id from leases
    where organization_id = ${ctx.actor.orgId} and id = ${leaseId}`.execute(ctx.trx);
  const l = r.rows[0];
  if (!l) throw new CommandError("NOT_FOUND", 404, t("lease.not_found"));
  authorize(ctx.actor, "import.commit", { propertyId: l.property_id });
  // Số dư chuyển đổi chỉ cho hợp đồng còn hiệu lực (review lát 4 🟢5): hợp đồng đã đóng/huỷ đã quyết toán xong.
  if (!["active", "notice_given", "settling"].includes(l.status)) {
    throw new CommandError("INVALID_TRANSITION", 409, t("ledger.opening_lease_inactive"), {
      extensions: { from: l.status },
    });
  }
  return l;
}

/** Nợ đầu kỳ của hợp đồng (S-011): một phiếu `opening_balance` một dòng "Số dư đầu kỳ". */
export async function recordOpeningDebt(
  ctx: CommandContext,
  input: { leaseId: string; amount: number; businessDate: string; note?: string; sourceId: string },
): Promise<{ invoiceId: string; journalEntryId: string }> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw new CommandError("VALIDATION_FAILED", 422, t("ledger.opening_debt_invalid"));
  const l = await leaseOf(ctx, input.leaseId);
  const invoiceId = randomUUID();
  const n = await sql<{
    n: string;
  }>`select app.next_number(${ctx.actor.orgId}, ${l.property_id}, 'opening')::text as n`.execute(ctx.trx);
  await sql`
    insert into invoices (id, organization_id, property_id, kind, lease_id, number, memo_ref, payer_person_id, business_date, total,
                          created_by, command_id)
    values (${invoiceId}, ${ctx.actor.orgId}, ${l.property_id}, 'opening_balance', ${l.id}, ${`SDK-${String(n.rows[0]?.n).padStart(6, "0")}`},
            ${generateMemoRef()}, ${l.representative_person_id}, ${input.businessDate}::date, ${input.amount},
            ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(ctx.trx);
  const lineId = randomUUID();
  await sql`
    insert into invoice_lines (id, organization_id, property_id, invoice_id, line_no, kind, description, revenue_account, quantity,
                               unit_price, amount, rounding_rule, formula_version)
    values (${lineId}, ${ctx.actor.orgId}, ${l.property_id}, ${invoiceId}, 1, 'opening_balance',
            ${input.note ? t("ledger.opening_line_description_note", { note: input.note }) : t("ledger.opening_line_description")}, 'OPENING_BALANCE', 1, ${input.amount}, ${input.amount},
            'HALF_UP_1', 1)`.execute(ctx.trx);
  const journalEntryId = await postEntry(ctx.trx, {
    orgId: ctx.actor.orgId,
    propertyId: l.property_id,
    entryType: "opening_balance",
    businessDate: input.businessDate,
    sourceDocType: "invoice",
    sourceDocId: invoiceId,
    createdBy: ctx.actor.membershipId,
    commandId: ctx.commandId,
    lines: [
      {
        account: "AR",
        debit: input.amount,
        credit: 0,
        invoiceId,
        invoiceLineId: lineId,
        personId: l.representative_person_id,
      },
      { account: "OPENING_BALANCE", debit: 0, credit: input.amount, invoiceId, invoiceLineId: lineId },
    ],
  });
  await ctx.audit({
    action: "ledger.opening_debt",
    entityType: "invoice",
    entityId: invoiceId,
    propertyId: l.property_id,
    after: {
      lease_id: l.id,
      amount: input.amount,
      business_date: input.businessDate,
      import_row: input.sourceId,
    },
  });
  return { invoiceId, journalEntryId };
}

/** Cọc đang giữ khi chuyển đổi (S-012): mỗi hợp đồng một hàng cọc; đã có cọc ⇒ 409. */
export async function recordOpeningDeposit(
  ctx: CommandContext,
  input: { leaseId: string; amount: number; businessDate: string; sourceId: string },
): Promise<{ depositId: string; journalEntryId: string }> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw new CommandError("VALIDATION_FAILED", 422, t("ledger.opening_deposit_invalid"));
  const l = await leaseOf(ctx, input.leaseId);
  const depositId = randomUUID();
  await sql`
    insert into deposits (id, organization_id, property_id, lease_id, payer_person_id, amount)
    values (${depositId}, ${ctx.actor.orgId}, ${l.property_id}, ${l.id}, ${l.representative_person_id}, ${input.amount})`.execute(
    ctx.trx,
  );
  const journalEntryId = await postEntry(ctx.trx, {
    orgId: ctx.actor.orgId,
    propertyId: l.property_id,
    entryType: "opening_balance",
    businessDate: input.businessDate,
    sourceDocType: "deposit",
    sourceDocId: depositId,
    createdBy: ctx.actor.membershipId,
    commandId: ctx.commandId,
    lines: [
      { account: "OPENING_BALANCE", debit: input.amount, credit: 0, depositId },
      {
        account: "DEPOSIT_LIAB",
        debit: 0,
        credit: input.amount,
        depositId,
        personId: l.representative_person_id,
      },
    ],
  });
  await ctx.audit({
    action: "ledger.opening_deposit",
    entityType: "deposit",
    entityId: depositId,
    propertyId: l.property_id,
    after: {
      lease_id: l.id,
      amount: input.amount,
      business_date: input.businessDate,
      import_row: input.sourceId,
    },
  });
  return { depositId, journalEntryId };
}
