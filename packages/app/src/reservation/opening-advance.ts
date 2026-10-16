// Ứng trước đầu kỳ của booking nhập (T-208 `recordOpeningAdvance`, SPEC-import S-009) dùng lúc check-out (T-206, S-017).
// Khoản này KHÔNG có dòng `payments`: chỉ là bút toán Nợ OPENING_BALANCE / Có CUSTOMER_CREDIT (người đặt) mang `reservation_id` (0031).
// Số còn lại = Σ Có CUSTOMER_CREDIT của bút toán − Σ `payment_allocations` còn hiệu lực trỏ tới nó (`opening_advance_entry_id`) — suy ra từ
// sổ + bảng phân bổ, không có bộ đếm riêng để lệch. Chỉ dùng ứng trước GẮN ĐÚNG booking (không lấy credit chung của người đặt: có thể lẫn
// booking khác). Phân bổ = Nợ CUSTOMER_CREDIT (người đặt) / Có AR (phiếu), cùng dạng với phân bổ khoản thu (INV-F2: không vượt số còn
// của ứng trước, của số dư CUSTOMER_CREDIT thật — có thể đã hoàn —, của phiếu; CSDL chặn thêm ở `app.opening_allocation_guard`).
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { postEntry } from "../ledger/ledger.ts";
import { customerCredit, lockPerson } from "../payments/payments.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";
import { businessDateAt } from "./reservation.ts";

export interface OpeningAdvance {
  entryId: string;
  /** Số ứng trước còn chưa phân bổ (đồng, > 0). */
  remaining: number;
}

/** Ứng trước đầu kỳ còn lại của một booking, cũ trước. Bút toán đã bị đảo thì không còn là tiền khách đang có. */
export async function openingAdvancesOf(
  trx: Transaction<unknown>,
  orgId: string,
  reservationId: string,
): Promise<OpeningAdvance[]> {
  const r = await sql<{ entry_id: string; remaining: string }>`
    select j.id as entry_id,
           (sum(l.credit) - coalesce((select sum(a.amount) from payment_allocations a
                                       where a.organization_id = j.organization_id and a.opening_advance_entry_id = j.id
                                         and a.reversed_at is null), 0))::text as remaining
    from journal_entries j
    join journal_lines l on l.organization_id = j.organization_id and l.entry_id = j.id and l.account = 'CUSTOMER_CREDIT'
    where j.organization_id = ${orgId} and j.reservation_id = ${reservationId} and j.entry_type = 'opening_balance'
      and not exists (select 1 from journal_entries rv where rv.organization_id = j.organization_id and rv.reverses_entry_id = j.id)
    group by j.id, j.organization_id, j.created_at
    order by j.created_at, j.id`.execute(trx);
  return r.rows
    .map((x) => ({ entryId: x.entry_id, remaining: Number(x.remaining) }))
    .filter((x) => x.remaining > 0);
}

/**
 * Phân bổ `amount` của một ứng trước đầu kỳ vào phiếu `invoiceId`. Gọi trong lệnh check-out đã giữ khoá booking (hai check-out cùng
 * booking tuần tự hoá), khoá người đặt như `allocatePayment` (cùng mutex với lệnh hoàn credit).
 */
export async function allocateOpeningAdvance(
  ctx: CommandContext,
  input: {
    entryId: string;
    invoiceId: string;
    amount: number;
    bookerPersonId: string;
    propertyId: string;
    at: Date;
  },
): Promise<{ entryId: string; allocationId: string }> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw new CommandError("VALIDATION_FAILED", 422, "Số tiền phân bổ phải là số nguyên đồng dương");
  const orgId = ctx.actor.orgId;
  await lockPerson(ctx.trx, orgId, input.bookerPersonId);
  const credit = await customerCredit(ctx.trx, orgId, input.bookerPersonId, input.propertyId);
  if (input.amount > credit)
    throw new CommandError(
      "OVER_ALLOCATION",
      409,
      `Phân bổ ${input.amount} vượt số dư khách ${credit} (đã hoàn một phần?)`,
    );
  const inv = await sql<{ property_id: string; open_amount: string; payer_person_id: string }>`
    select property_id, open_amount::text, payer_person_id from invoices
    where organization_id = ${orgId} and id = ${input.invoiceId} for update`.execute(ctx.trx);
  const i = inv.rows[0];
  if (!i || i.property_id !== input.propertyId)
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
  if (input.amount > Number(i.open_amount))
    throw new CommandError(
      "OVER_ALLOCATION",
      409,
      `Phân bổ ${input.amount} vượt số còn ${i.open_amount} của phiếu`,
    );
  const journalEntryId = await postEntry(ctx.trx, {
    orgId,
    propertyId: input.propertyId,
    entryType: "payment_allocated",
    businessDate: await businessDateAt(ctx, input.propertyId, input.at),
    sourceDocType: "payment_allocation",
    sourceDocId: input.entryId,
    createdBy: ctx.actor.membershipId,
    commandId: ctx.commandId,
    lines: [
      { account: "CUSTOMER_CREDIT", debit: input.amount, credit: 0, personId: input.bookerPersonId },
      {
        account: "AR",
        debit: 0,
        credit: input.amount,
        invoiceId: input.invoiceId,
        personId: i.payer_person_id,
      },
    ],
  });
  const allocationId = randomUUID();
  await sql`
    insert into payment_allocations (id, organization_id, property_id, opening_advance_entry_id, invoice_id, amount, allocated_by,
                                     entry_id, command_id)
    values (${allocationId}, ${orgId}, ${input.propertyId}, ${input.entryId}, ${input.invoiceId}, ${input.amount},
            ${ctx.actor.membershipId}, ${journalEntryId}, ${ctx.commandId})`.execute(ctx.trx);
  await sql`
    update invoices set allocated_total = allocated_total + ${input.amount}, version = version + 1
    where organization_id = ${orgId} and id = ${input.invoiceId}`.execute(ctx.trx);
  await ctx.audit({
    action: "payment.allocated",
    entityType: "journal_entry",
    entityId: input.entryId,
    propertyId: input.propertyId,
    after: {
      opening_advance_entry_id: input.entryId,
      allocations: [{ invoice_id: input.invoiceId, amount: input.amount }],
      entry_id: journalEntryId,
    },
  });
  return { entryId: journalEntryId, allocationId };
}
