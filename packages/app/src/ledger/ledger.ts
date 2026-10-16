// Sổ phụ cân bằng (DOMAIN-MODEL §5): ghi bút toán append-only; đảo bằng bút toán ngược (một lần).
import { randomUUID } from "node:crypto";
import { type Account, assertBalanced } from "@hm/domain";
import { sql, type Transaction } from "kysely";
import { CommandError } from "../pipeline/problem.ts";

export type EntryType =
  | "invoice_issued"
  | "payment_confirmed"
  | "payment_allocated"
  | "deposit_received"
  | "deposit_deducted"
  | "deposit_refunded"
  | "credit_refunded"
  | "adjustment"
  | "reversal"
  | "opening_balance";

export interface LedgerLine {
  account: Account;
  debit: number;
  credit: number;
  personId?: string;
  receivingAccountId?: string;
  shiftId?: string;
  invoiceId?: string;
  invoiceLineId?: string;
  depositId?: string;
}

export interface EntryInput {
  orgId: string;
  propertyId: string;
  entryType: EntryType;
  businessDate: string;
  sourceDocType: string;
  sourceDocId: string;
  lines: readonly LedgerLine[];
  createdBy?: string;
  commandId?: string;
  memo?: string;
  reversesEntryId?: string;
}

export async function postEntry(trx: Transaction<unknown>, e: EntryInput): Promise<string> {
  assertBalanced(e.lines);
  const id = randomUUID();
  await sql`
    insert into journal_entries (id, organization_id, property_id, entry_type, business_date, source_doc_type, source_doc_id,
                                 reverses_entry_id, memo, created_by, command_id)
    values (${id}, ${e.orgId}, ${e.propertyId}, ${e.entryType}, ${e.businessDate}::date, ${e.sourceDocType}, ${e.sourceDocId},
            ${e.reversesEntryId ?? null}, ${e.memo ?? null}, ${e.createdBy ?? null}, ${e.commandId ?? null})`.execute(
    trx,
  );
  let n = 0;
  for (const l of e.lines) {
    n++;
    await sql`
      insert into journal_lines (id, organization_id, property_id, entry_id, line_no, account, debit, credit, person_id,
                                 receiving_account_id, shift_id, invoice_id, invoice_line_id, deposit_id)
      values (${randomUUID()}, ${e.orgId}, ${e.propertyId}, ${id}, ${n}, ${l.account}, ${l.debit}, ${l.credit}, ${l.personId ?? null},
              ${l.receivingAccountId ?? null}, ${l.shiftId ?? null}, ${l.invoiceId ?? null}, ${l.invoiceLineId ?? null},
              ${l.depositId ?? null})`.execute(trx);
  }
  return id;
}

/** Đảo bút toán: dòng ngược Nợ/Có, cùng chiều phân tích; mỗi bút toán chỉ đảo được một lần (INVALID_TRANSITION). */
export async function reverseEntry(
  trx: Transaction<unknown>,
  input: {
    orgId: string;
    entryId: string;
    businessDate: string;
    reason: string;
    createdBy?: string;
    commandId?: string;
    /** Dòng CASH của bút toán đảo vào ca này (ca gốc đã đóng thì không ghi vào ca đã chốt — INV-F6). */
    cashShiftId?: string;
  },
): Promise<string> {
  const head = await sql<{
    property_id: string;
    entry_type: string;
    source_doc_type: string;
    source_doc_id: string;
  }>`
    select property_id, entry_type, source_doc_type, source_doc_id from journal_entries where organization_id = ${input.orgId} and id = ${input.entryId}`.execute(
    trx,
  );
  const h = head.rows[0];
  if (!h) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy bút toán");
  if (h.entry_type === "reversal")
    throw new CommandError("INVALID_TRANSITION", 409, "Không đảo một bút toán đảo");
  const lines = await sql<{
    account: Account;
    debit: string;
    credit: string;
    person_id: string | null;
    receiving_account_id: string | null;
    shift_id: string | null;
    invoice_id: string | null;
    invoice_line_id: string | null;
    deposit_id: string | null;
  }>`select account, debit, credit, person_id, receiving_account_id, shift_id, invoice_id, invoice_line_id, deposit_id
     from journal_lines where organization_id = ${input.orgId} and entry_id = ${input.entryId} order by line_no`.execute(
    trx,
  );
  try {
    await sql`savepoint reverse_entry`.execute(trx);
    return await postEntry(trx, {
      orgId: input.orgId,
      propertyId: h.property_id,
      entryType: "reversal",
      businessDate: input.businessDate,
      // Bút toán đảo giữ chứng từ nguồn của bản gốc (truy vết cùng một chứng từ).
      sourceDocType: h.source_doc_type,
      sourceDocId: h.source_doc_id,
      reversesEntryId: input.entryId,
      memo: input.reason,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.commandId ? { commandId: input.commandId } : {}),
      lines: lines.rows.map((l) => ({
        account: l.account,
        debit: Number(l.credit),
        credit: Number(l.debit),
        ...(l.person_id ? { personId: l.person_id } : {}),
        ...(l.receiving_account_id ? { receivingAccountId: l.receiving_account_id } : {}),
        ...(l.account === "CASH" && input.cashShiftId
          ? { shiftId: input.cashShiftId }
          : l.shift_id
            ? { shiftId: l.shift_id }
            : {}),
        ...(l.invoice_id ? { invoiceId: l.invoice_id } : {}),
        ...(l.invoice_line_id ? { invoiceLineId: l.invoice_line_id } : {}),
        ...(l.deposit_id ? { depositId: l.deposit_id } : {}),
      })),
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505")
      throw new CommandError("INVALID_TRANSITION", 409, "Bút toán đã được đảo");
    throw err;
  }
}

/** Số dư tài khoản theo chiều (vd AR theo phiếu): Nợ − Có. */
export async function balance(
  trx: Transaction<unknown>,
  q: { orgId: string; account: Account; invoiceId?: string; personId?: string; depositId?: string },
): Promise<number> {
  const r = await sql<{ b: string }>`
    select coalesce(sum(debit - credit), 0)::text as b from journal_lines
    where organization_id = ${q.orgId} and account = ${q.account}
      and (${q.invoiceId ?? null}::uuid is null or invoice_id = ${q.invoiceId ?? null}::uuid)
      and (${q.personId ?? null}::uuid is null or person_id = ${q.personId ?? null}::uuid)
      and (${q.depositId ?? null}::uuid is null or deposit_id = ${q.depositId ?? null}::uuid)`.execute(trx);
  return Number(r.rows[0]?.b ?? 0);
}
