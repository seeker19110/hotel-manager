// Tự ghi tiền từ webhook đã xác minh (SPEC-ledger S-016; INV-F3, INV-F4, INV-F4b). Chạy trong WORKER (role app_worker,
// API-CONTRACT §3 "xử lý thật diễn ra trong worker") khi nhận sự kiện `bank_transaction.received`; pg-boss giao lại bao
// nhiêu lần cũng chỉ một hiệu lực: khoá tư vấn theo giao dịch + UNIQUE payments(bank_transaction_id) là hàng rào cuối.
// Chỉ tự ghi khi khớp ĐÚNG một phiếu và không vượt số còn; mọi trường hợp khác → break có người chịu trách nhiệm.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { type Kysely, sql, type Transaction } from "kysely";
import { BREAK_OPENED, defaultAssignee, openBreak } from "../ledger/bank-inbox.ts";
import { postEntry } from "../ledger/ledger.ts";
import { currentTraceparent } from "../logging/index.ts";
import { candidateInvoices, loadBankTxn, suggestFor } from "./matching.ts";

export type AutoApplyResult =
  | { outcome: "applied"; paymentId: string; invoiceId: string }
  | { outcome: "break"; breakId: string; reason: string }
  | { outcome: "skipped"; why: "not_found" | "already_paid" | "in_queue" | "not_verified" };

async function workerAudit(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
  action: string,
  entityType: string,
  entityId: string,
  after: unknown,
  correlationId: string,
): Promise<void> {
  await sql`
    insert into audit_events (id, organization_id, property_id, actor_type, action, entity_type, entity_id, after, correlation_id)
    values (${randomUUID()}, ${orgId}, ${propertyId}, 'worker', ${action}, ${entityType}, ${entityId},
            ${JSON.stringify(after)}::jsonb, ${correlationId})`.execute(trx);
}

async function outbox(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, string | number | null>,
  correlationId: string,
): Promise<void> {
  await sql`
    insert into outbox (id, organization_id, property_id, event_type, aggregate_type, aggregate_id, payload, correlation_id,
                        dedupe_key, traceparent)
    values (${randomUUID()}, ${orgId}, ${propertyId}, ${eventType}, ${aggregateType}, ${aggregateId},
            ${JSON.stringify(payload)}::jsonb, ${correlationId}, ${`${eventType}:${aggregateId}`}, ${currentTraceparent()})
    on conflict do nothing`.execute(trx);
}

export async function applyBankTransaction(
  workerDb: Kysely<unknown>,
  orgId: string,
  bankTransactionId: string,
): Promise<AutoApplyResult> {
  const correlationId = `job:bank_auto:${bankTransactionId}`;
  return withTenant(workerDb, { orgId }, async (trx): Promise<AutoApplyResult> => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`bank_txn:${bankTransactionId}`}, 0))`.execute(
      trx,
    );
    const bt = await loadBankTxn(trx, orgId, bankTransactionId);
    if (!bt) return { outcome: "skipped", why: "not_found" };
    const state = await sql<{ paid: boolean; queued: boolean; verified: boolean }>`
      select exists (select 1 from payments where organization_id = ${orgId} and bank_transaction_id = ${bt.id}) as paid,
             exists (select 1 from reconciliation_breaks where organization_id = ${orgId} and bank_transaction_id = ${bt.id}
                     and status = 'open') as queued,
             exists (select 1 from inbox where organization_id = ${orgId} and bank_transaction_id = ${bt.id}
                     and signature_verified and provider <> 'statement_csv') as verified`.execute(trx);
    const s = state.rows[0] as { paid: boolean; queued: boolean; verified: boolean };
    if (s.paid) return { outcome: "skipped", why: "already_paid" };
    if (s.queued) return { outcome: "skipped", why: "in_queue" };
    if (!s.verified) return { outcome: "skipped", why: "not_verified" };

    const invoices = await candidateInvoices(trx, orgId, bt.description, true);
    const suggestion = suggestFor(bt, invoices);
    const amount = Number(bt.amount);
    if (suggestion.status === "break" || suggestion.allocations.length !== 1) {
      const reason = suggestion.reason ?? "UNMATCHED";
      const assignee = await defaultAssignee(trx, orgId, bt.property_id, ["accountant", "manager"]);
      const { breakId } = await openBreak(trx, {
        orgId,
        propertyId: bt.property_id,
        bankTransactionId: bt.id,
        reason,
        assignee,
        detail: { amount, suggested_credit: suggestion.credit, candidates: invoices.length },
      });
      await workerAudit(
        trx,
        orgId,
        bt.property_id,
        "reconciliation.break_opened",
        "reconciliation_break",
        breakId,
        { reason, bank_transaction_id: bt.id, assignee },
        correlationId,
      );
      await outbox(
        trx,
        orgId,
        bt.property_id,
        BREAK_OPENED,
        "reconciliation_break",
        breakId,
        { break_id: breakId, reason, assignee },
        correlationId,
      );
      return { outcome: "break", breakId, reason };
    }

    const alloc = suggestion.allocations[0] as { invoiceId: string; amount: number };
    const inv = invoices.find((i) => i.id === alloc.invoiceId) as (typeof invoices)[number];
    const paymentId = randomUUID();
    const bd = await sql<{
      d: string;
    }>`select app.business_date(${orgId}, ${bt.property_id})::text as d`.execute(trx);
    const businessDate = (bd.rows[0] as { d: string }).d;
    await sql`
      insert into payments (id, organization_id, property_id, method, purpose, status, amount, receiving_account_id,
                            payer_person_id, bank_transaction_id, evidence_kind, evidence_id, business_date, source,
                            confirmed_at)
      values (${paymentId}, ${orgId}, ${bt.property_id}, 'bank_transfer', 'receivable', 'confirmed', ${amount},
              ${bt.receiving_account_id}, ${inv.payer_person_id}, ${bt.id}, 'bank_transaction', ${bt.id},
              ${businessDate}::date, 'bank_auto', now())`.execute(trx);
    const confirmEntry = await postEntry(trx, {
      orgId,
      propertyId: bt.property_id,
      entryType: "payment_confirmed",
      businessDate,
      sourceDocType: "payment",
      sourceDocId: paymentId,
      lines: [
        { account: "BANK", debit: amount, credit: 0, receivingAccountId: bt.receiving_account_id },
        { account: "CUSTOMER_CREDIT", debit: 0, credit: amount, personId: inv.payer_person_id },
      ],
    });
    const allocEntry = await postEntry(trx, {
      orgId,
      propertyId: bt.property_id,
      entryType: "payment_allocated",
      businessDate,
      sourceDocType: "payment_allocation",
      sourceDocId: paymentId,
      lines: [
        { account: "CUSTOMER_CREDIT", debit: alloc.amount, credit: 0, personId: inv.payer_person_id },
        { account: "AR", debit: 0, credit: alloc.amount, invoiceId: inv.id, personId: inv.payer_person_id },
      ],
    });
    await sql`
      insert into payment_allocations (id, organization_id, property_id, payment_id, invoice_id, amount, entry_id)
      values (${randomUUID()}, ${orgId}, ${bt.property_id}, ${paymentId}, ${inv.id}, ${alloc.amount}, ${allocEntry})`.execute(
      trx,
    );
    await sql`update invoices set allocated_total = allocated_total + ${alloc.amount}, version = version + 1
              where organization_id = ${orgId} and id = ${inv.id}`.execute(trx);
    await sql`update payments set allocated_total = allocated_total + ${alloc.amount}, version = version + 1
              where organization_id = ${orgId} and id = ${paymentId}`.execute(trx);
    await workerAudit(
      trx,
      orgId,
      bt.property_id,
      "payment.auto_confirmed",
      "payment",
      paymentId,
      {
        bank_transaction_id: bt.id,
        invoice_id: inv.id,
        amount,
        entry_id: confirmEntry,
        allocation_entry_id: allocEntry,
      },
      correlationId,
    );
    await outbox(
      trx,
      orgId,
      bt.property_id,
      "payment.confirmed",
      "payment",
      paymentId,
      { payment_id: paymentId, amount, method: "bank_transfer" },
      correlationId,
    );
    return { outcome: "applied", paymentId, invoiceId: inv.id };
  });
}
