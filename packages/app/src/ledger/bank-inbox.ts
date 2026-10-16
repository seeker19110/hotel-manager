// Tiền vào tài khoản ngân hàng (INV-F3, INV-F4, INV-F4b; API-CONTRACT §3; TM-04).
// Mọi nguồn (webhook, sao kê, nhập tay kèm sao kê) → inbox (chống trùng theo nguồn) → bank_transactions (chống trùng
// theo GIAO DỊCH NGÂN HÀNG). Ghép/ghi tiền từ bank_transaction: `reconciliation/` (T-107).

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { withTenant } from "@hm/db";
import type { BreakReason } from "@hm/domain";
import { msToSecondsExact } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import { canonicalJson } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";

export interface BankEvent {
  provider: string;
  /** receiving_account_id (tham số `{account}` của URL webhook). */
  account: string;
  providerEventId: string;
  raw: Record<string, unknown>;
  signatureVerified: boolean;
  source: "webhook" | "statement" | "manual";
  txn: { ref: string; amount: number; occurredAt: Date; description?: string; balanceAfter?: number };
}

export interface IngestResult {
  inboxId: string;
  bankTransactionId: string;
  /** Sự kiện này đã nhận trước đó (cùng nguồn, cùng event id, cùng nội dung). */
  duplicateEvent: boolean;
  /** Giao dịch ngân hàng đã có từ nguồn khác/trước đó — không tạo tiền mới. */
  existingTransaction: boolean;
}

/** Kết quả ghi trong một transaction có sẵn: lệch nội dung KHÔNG ném lỗi để người gọi mở break rồi commit. */
export type IngestOutcome =
  | ({ kind: "ok" } & IngestResult)
  | {
      kind: "hash_mismatch";
      /** `inbox`: cùng event id khác nội dung (INV-F4) · `transaction`: cùng mã giao dịch ngân hàng khác số tiền (INV-F4b). */
      scope: "inbox" | "transaction";
      inboxId: string;
      bankTransactionId: string | null;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Dấu vân tay của MỘT giao dịch ngân hàng, giống nhau ở mọi nguồn (webhook/sao kê/nhập tay): chỉ mã + số tiền. Thời điểm
 * không vào vì nguồn khác nhau ghi độ chính xác khác nhau (sao kê chỉ có ngày) — lệch giờ không phải giao dịch khác.
 */
export function bankTxnHash(ref: string, amount: number): string {
  return sha256(canonicalJson({ amount, ref }));
}

export interface AccountOwner {
  orgId: string;
  propertyId: string;
}

export async function receivingAccountOwner(db: Kysely<unknown>, account: string): Promise<AccountOwner> {
  if (!UUID.test(account)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy tài khoản nhận");
  const owner = await sql<{ organization_id: string; property_id: string | null }>`
    select * from app.receiving_account_owner(${account}::uuid)`.execute(db);
  const o = owner.rows[0];
  if (!o) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy tài khoản nhận");
  if (!o.property_id) throw new CommandError("VALIDATION_FAILED", 422, "Tài khoản nhận chưa gắn cơ sở");
  return { orgId: o.organization_id, propertyId: o.property_id };
}

/** inbox (chống trùng theo nguồn, INV-F4) → bank_transactions (chống trùng theo giao dịch, INV-F4b), trong `trx` có sẵn. */
export async function ingestInTx(
  trx: Transaction<unknown>,
  o: AccountOwner,
  ev: BankEvent,
): Promise<IngestOutcome> {
  if (!Number.isSafeInteger(ev.txn.amount) || ev.txn.amount <= 0) {
    throw new CommandError("VALIDATION_FAILED", 422, "Số tiền giao dịch phải là số nguyên đồng dương");
  }
  const payloadHash = sha256(canonicalJson(ev.raw));
  const txnHash = bankTxnHash(ev.txn.ref, ev.txn.amount);

  const ins = await sql<{ id: string }>`
    insert into inbox (id, organization_id, provider, account, provider_event_id, payload_hash, raw, signature_verified)
    values (${randomUUID()}, ${o.orgId}, ${ev.provider}, ${ev.account}, ${ev.providerEventId}, ${payloadHash},
            ${JSON.stringify(ev.raw)}::jsonb, ${ev.signatureVerified})
    on conflict (provider, account, provider_event_id) do nothing returning id`.execute(trx);
  let inboxId = ins.rows[0]?.id;
  let duplicateEvent = false;
  if (!inboxId) {
    const prev = await sql<{ id: string; payload_hash: string; bank_transaction_id: string | null }>`
      select id, payload_hash, bank_transaction_id from inbox
      where provider = ${ev.provider} and account = ${ev.account} and provider_event_id = ${ev.providerEventId}`.execute(
      trx,
    );
    const p = prev.rows[0] as { id: string; payload_hash: string; bank_transaction_id: string | null };
    if (p.payload_hash !== payloadHash) {
      return {
        kind: "hash_mismatch",
        scope: "inbox",
        inboxId: p.id,
        bankTransactionId: p.bank_transaction_id,
      };
    }
    inboxId = p.id;
    duplicateEvent = true;
    if (p.bank_transaction_id) {
      return {
        kind: "ok",
        inboxId,
        bankTransactionId: p.bank_transaction_id,
        duplicateEvent,
        existingTransaction: true,
      };
    }
  }

  const bt = await sql<{ id: string }>`
    insert into bank_transactions (id, organization_id, property_id, receiving_account_id, bank_txn_ref, amount, occurred_at,
                                   description, balance_after, first_source, raw_hash, inbox_id)
    values (${randomUUID()}, ${o.orgId}, ${o.propertyId}, ${ev.account}, ${ev.txn.ref}, ${ev.txn.amount}, ${ev.txn.occurredAt},
            ${ev.txn.description ?? null}, ${ev.txn.balanceAfter ?? null}, ${ev.source}, ${txnHash}, ${inboxId})
    on conflict (receiving_account_id, bank_txn_ref) do nothing returning id`.execute(trx);
  let bankTransactionId = bt.rows[0]?.id;
  let existingTransaction = false;
  if (!bankTransactionId) {
    const prev = await sql<{ id: string; raw_hash: string }>`
      select id, raw_hash from bank_transactions where receiving_account_id = ${ev.account} and bank_txn_ref = ${ev.txn.ref}`.execute(
      trx,
    );
    const p = prev.rows[0] as { id: string; raw_hash: string };
    if (p.raw_hash !== txnHash) {
      await sql`update inbox set process_status = 'broken', process_error = 'HASH_MISMATCH', processed_at = now()
                where id = ${inboxId} and bank_transaction_id is null`.execute(trx);
      return { kind: "hash_mismatch", scope: "transaction", inboxId, bankTransactionId: p.id };
    }
    bankTransactionId = p.id;
    existingTransaction = true;
  }
  await sql`update inbox set bank_transaction_id = ${bankTransactionId}, process_status = 'processed', processed_at = now(),
                             process_error = null
            where id = ${inboxId} and bank_transaction_id is null`.execute(trx);
  return { kind: "ok", inboxId, bankTransactionId, duplicateEvent, existingTransaction };
}

/**
 * Người chịu trách nhiệm mặc định của break (ERD: không break vô chủ): theo thứ tự vai trò, người còn hiệu lực thấy được
 * cơ sở; owner luôn là chốt cuối (tổ chức luôn còn ≥ 1 owner — LAST_OWNER).
 */
export async function defaultAssignee(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
  roles: readonly ("owner" | "accountant" | "manager")[],
): Promise<string> {
  const r = await sql<{ id: string }>`
    select m.id from memberships m
    where m.organization_id = ${orgId} and m.status = 'active' and m.role = any(${[...roles, "owner"]}::text[])
      and (m.role = 'owner' or m.all_properties or exists (
            select 1 from property_scopes ps
            where ps.organization_id = m.organization_id and ps.membership_id = m.id and ps.property_id = ${propertyId}))
    order by array_position(${[...roles, "owner"]}::text[], m.role), m.id
    limit 1`.execute(trx);
  const id = r.rows[0]?.id;
  if (!id) throw new Error("Tổ chức không còn owner hoạt động");
  return id;
}

export interface OpenBreakInput {
  orgId: string;
  propertyId: string;
  inboxId?: string | null;
  bankTransactionId?: string | null;
  reason: BreakReason;
  assignee: string;
  detail?: Record<string, string | number | boolean | null>;
}

/** Mở break (idempotent: đã có break mở cùng giao dịch/sự kiện + lý do → trả id cũ). */
export async function openBreak(
  trx: Transaction<unknown>,
  b: OpenBreakInput,
): Promise<{ breakId: string; created: boolean }> {
  const ins = await sql<{ id: string }>`
    insert into reconciliation_breaks (id, organization_id, property_id, inbox_id, bank_transaction_id, reason, assignee, detail)
    values (${randomUUID()}, ${b.orgId}, ${b.propertyId}, ${b.inboxId ?? null}, ${b.bankTransactionId ?? null}, ${b.reason},
            ${b.assignee}, ${b.detail ? JSON.stringify(b.detail) : null}::jsonb)
    on conflict do nothing returning id`.execute(trx);
  if (ins.rows[0]) return { breakId: ins.rows[0].id, created: true };
  const prev = await sql<{ id: string }>`
    select id from reconciliation_breaks
    where organization_id = ${b.orgId} and status = 'open' and reason = ${b.reason}
      and ${b.bankTransactionId ? sql`bank_transaction_id = ${b.bankTransactionId}` : sql`bank_transaction_id is null and inbox_id = ${b.inboxId ?? null}`}`.execute(
    trx,
  );
  return { breakId: (prev.rows[0] as { id: string }).id, created: false };
}

/** Sự kiện cho worker tự ghép (S-016) — chỉ id, không PII. */
export const BANK_TXN_RECEIVED = "bank_transaction.received";
export const BREAK_OPENED = "reconciliation.break_opened";

async function systemEvent(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, string | number | boolean | null>,
): Promise<void> {
  await sql`
    insert into outbox (id, organization_id, property_id, event_type, aggregate_type, aggregate_id, payload, correlation_id,
                        dedupe_key)
    values (${randomUUID()}, ${orgId}, ${propertyId}, ${eventType}, ${aggregateType}, ${aggregateId},
            ${JSON.stringify(payload)}::jsonb, ${`sys:${eventType}:${aggregateId}`}, ${`${eventType}:${aggregateId}`})
    on conflict do nothing`.execute(trx);
}

/** Báo động lệch nội dung (S-018, S-030 ca 3): break HASH_MISMATCH giao owner + sự kiện báo động; không ghi tiền. */
export async function openHashMismatchBreak(
  trx: Transaction<unknown>,
  o: AccountOwner,
  m: Extract<IngestOutcome, { kind: "hash_mismatch" }>,
  detail: Record<string, string | number | boolean | null>,
): Promise<string> {
  const assignee = await defaultAssignee(trx, o.orgId, o.propertyId, []);
  const { breakId, created } = await openBreak(trx, {
    orgId: o.orgId,
    propertyId: o.propertyId,
    inboxId: m.inboxId,
    bankTransactionId: m.bankTransactionId,
    reason: "HASH_MISMATCH",
    assignee,
    detail: { scope: m.scope, ...detail },
  });
  if (created) {
    await systemEvent(trx, o.orgId, o.propertyId, BREAK_OPENED, "reconciliation_break", breakId, {
      break_id: breakId,
      reason: "HASH_MISMATCH",
      assignee,
    });
  }
  return breakId;
}

/**
 * Webhook/nguồn ngoài không có người dùng (API-CONTRACT §3): ghi inbox + bank_transactions rồi trả ngay; webhook đã xác minh
 * chữ ký phát `bank_transaction.received` cho worker tự ghép (S-016). Lệch nội dung → break HASH_MISMATCH được COMMIT,
 * rồi mới ném 409 INBOX_HASH_MISMATCH.
 */
export async function ingestBankEvent(db: Kysely<unknown>, ev: BankEvent): Promise<IngestResult> {
  const o = await receivingAccountOwner(db, ev.account);
  const outcome = await withTenant(db, { orgId: o.orgId }, async (trx) => {
    const r = await ingestInTx(trx, o, ev);
    if (r.kind === "hash_mismatch") {
      await openHashMismatchBreak(trx, o, r, { provider: ev.provider, amount: ev.txn.amount });
      return r;
    }
    if (ev.source === "webhook" && ev.signatureVerified && !r.duplicateEvent) {
      await systemEvent(
        trx,
        o.orgId,
        o.propertyId,
        BANK_TXN_RECEIVED,
        "bank_transaction",
        r.bankTransactionId,
        {
          bank_transaction_id: r.bankTransactionId,
          inbox_id: r.inboxId,
        },
      );
    }
    return r;
  });
  if (outcome.kind === "hash_mismatch") {
    throw new CommandError(
      "INBOX_HASH_MISMATCH",
      409,
      outcome.scope === "inbox"
        ? "Sự kiện trùng mã nhưng nội dung khác — không ghi tiền, cần đối soát"
        : "Cùng mã giao dịch ngân hàng nhưng số tiền khác — không ghi tiền, cần đối soát",
    );
  }
  const { kind: _k, ...result } = outcome;
  return result;
}

/**
 * Chữ ký webhook của adapter mô phỏng `sim` (API-CONTRACT §3): HMAC-SHA256(secret, `${timestamp}.${account}.${body}`), hex
 * — gắn tài khoản nhận trong URL để không phát lại cùng body sang tài khoản/tổ chức khác (review lát tiền R8).
 * Lệch giờ quá `toleranceSeconds` → từ chối (chống phát lại). Sai → WEBHOOK_SIGNATURE_INVALID (401), KHÔNG ghi inbox.
 */
export function verifySimSignature(input: {
  secret: string;
  account: string;
  body: string;
  timestamp: string;
  signature: string;
  now?: Date;
  toleranceSeconds?: number;
}): void {
  const ts = Number(input.timestamp);
  const now = msToSecondsExact((input.now ?? new Date()).getTime());
  if (!Number.isInteger(ts) || Math.abs(now - ts) > (input.toleranceSeconds ?? 300)) {
    throw new CommandError("WEBHOOK_SIGNATURE_INVALID", 401, "Chữ ký webhook không hợp lệ hoặc đã quá hạn");
  }
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.account}.${input.body}`)
    .digest();
  const given = /^[0-9a-f]{64}$/i.test(input.signature)
    ? Buffer.from(input.signature, "hex")
    : Buffer.alloc(0);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new CommandError("WEBHOOK_SIGNATURE_INVALID", 401, "Chữ ký webhook không hợp lệ hoặc đã quá hạn");
  }
}

export function signSim(secret: string, timestamp: string, body: string, account: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${account}.${body}`).digest("hex");
}
