// Gợi ý ghép giao dịch ngân hàng ↔ phiếu theo mã tham chiếu (SPEC-ledger S-020). Quy tắc ở @hm/domain `classifyBankTxn`;
// đây chỉ đọc dữ liệu (RLS theo người gọi: người dùng chỉ thấy phiếu trong phạm vi; worker thấy cả tổ chức).
import { type CandidateInvoice, classifyBankTxn, type MatchSuggestion, memoCandidates } from "@hm/domain";
import { sql, type Transaction } from "kysely";

export interface BankTxnRow {
  id: string;
  property_id: string;
  receiving_account_id: string;
  bank_txn_ref: string;
  amount: string;
  occurred_at: Date;
  description: string | null;
}

export interface CandidateRow {
  id: string;
  property_id: string;
  number: string;
  memo_ref: string;
  open_amount: string;
  payer_person_id: string;
}

export async function loadBankTxn(
  trx: Transaction<unknown>,
  orgId: string,
  id: string,
): Promise<BankTxnRow | undefined> {
  const r = await sql<BankTxnRow>`
    select id, property_id, receiving_account_id, bank_txn_ref, amount, occurred_at, description
    from bank_transactions where organization_id = ${orgId} and id = ${id}`.execute(trx);
  return r.rows[0];
}

/** Phiếu có mã tham chiếu xuất hiện trong nội dung CK; hạn sớm trước. `lock` → FOR UPDATE theo id (chống phân bổ đua). */
export async function candidateInvoices(
  trx: Transaction<unknown>,
  orgId: string,
  description: string | null,
  lock = false,
): Promise<CandidateRow[]> {
  const cands = memoCandidates(description ?? "");
  if (cands.length === 0) return [];
  if (lock) {
    await sql`select id from invoices where organization_id = ${orgId} and memo_ref = any(${cands}::text[])
              order by id for update`.execute(trx);
  }
  const r = await sql<CandidateRow>`
    select id, property_id, number, memo_ref, open_amount, payer_person_id from invoices
    where organization_id = ${orgId} and memo_ref = any(${cands}::text[])
    order by due_on nulls last, business_date, number, id`.execute(trx);
  return r.rows;
}

export function suggestFor(bt: BankTxnRow, invoices: readonly CandidateRow[]): MatchSuggestion {
  const cands: CandidateInvoice[] = invoices.map((i) => ({
    id: i.id,
    open: Number(i.open_amount),
    sameProperty: i.property_id === bt.property_id,
  }));
  return classifyBankTxn(Number(bt.amount), cands);
}
