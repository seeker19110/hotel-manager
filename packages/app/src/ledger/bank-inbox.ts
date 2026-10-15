// Tiền vào tài khoản ngân hàng (INV-F3, INV-F4, INV-F4b; API-CONTRACT §3; TM-04).
// Mọi nguồn (webhook, sao kê, nhập tay kèm sao kê) → inbox (chống trùng theo nguồn) → bank_transactions (chống trùng
// theo GIAO DỊCH NGÂN HÀNG). Payment/phân bổ từ bank_transaction thuộc đợt 2 (SPEC-ledger-payments).
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";
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

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function ingestBankEvent(db: Kysely<unknown>, ev: BankEvent): Promise<IngestResult> {
  if (!Number.isSafeInteger(ev.txn.amount) || ev.txn.amount <= 0) {
    throw new CommandError("VALIDATION_FAILED", 422, "Số tiền giao dịch phải là số nguyên đồng dương");
  }
  const owner = await sql<{ organization_id: string; property_id: string | null }>`
    select * from app.receiving_account_owner(${ev.account}::uuid)`.execute(db);
  const o = owner.rows[0];
  if (!o) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy tài khoản nhận");
  if (!o.property_id) throw new CommandError("VALIDATION_FAILED", 422, "Tài khoản nhận chưa gắn cơ sở");
  const propertyId = o.property_id;
  const payloadHash = sha256(canonicalJson(ev.raw));
  const txnHash = sha256(
    canonicalJson({ amount: ev.txn.amount, occurredAt: ev.txn.occurredAt.toISOString(), ref: ev.txn.ref }),
  );

  return withTenant(db, { orgId: o.organization_id }, async (trx) => {
    // 1) inbox theo nguồn (INV-F4).
    const ins = await sql<{ id: string }>`
      insert into inbox (id, organization_id, provider, account, provider_event_id, payload_hash, raw, signature_verified)
      values (${randomUUID()}, ${o.organization_id}, ${ev.provider}, ${ev.account}, ${ev.providerEventId}, ${payloadHash},
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
        throw new CommandError(
          "INBOX_HASH_MISMATCH",
          409,
          "Sự kiện trùng mã nhưng nội dung khác — không ghi tiền, cần đối soát",
        );
      }
      inboxId = p.id;
      duplicateEvent = true;
      if (p.bank_transaction_id) {
        return {
          inboxId,
          bankTransactionId: p.bank_transaction_id,
          duplicateEvent,
          existingTransaction: true,
        };
      }
    }

    // 2) bank_transactions theo giao dịch ngân hàng (INV-F4b) — xuyên nguồn.
    const bt = await sql<{ id: string }>`
      insert into bank_transactions (id, organization_id, property_id, receiving_account_id, bank_txn_ref, amount, occurred_at,
                                     description, balance_after, first_source, raw_hash, inbox_id)
      values (${randomUUID()}, ${o.organization_id}, ${propertyId}, ${ev.account}, ${ev.txn.ref}, ${ev.txn.amount}, ${ev.txn.occurredAt},
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
        throw new CommandError(
          "INBOX_HASH_MISMATCH",
          409,
          "Cùng mã giao dịch ngân hàng nhưng số tiền/thời điểm khác — cần đối soát",
        );
      }
      bankTransactionId = p.id;
      existingTransaction = true;
    }
    await sql`update inbox set bank_transaction_id = ${bankTransactionId}, process_status = 'processed', processed_at = now()
              where id = ${inboxId} and bank_transaction_id is null`.execute(trx);
    return { inboxId, bankTransactionId, duplicateEvent, existingTransaction };
  });
}

/**
 * Chữ ký webhook của adapter mô phỏng `sim` (API-CONTRACT §3): HMAC-SHA256(secret, `${timestamp}.${body}`), hex.
 * Lệch giờ quá `toleranceSeconds` → từ chối (chống phát lại). Sai → WEBHOOK_SIGNATURE_INVALID (401), KHÔNG ghi inbox.
 */
export function verifySimSignature(input: {
  secret: string;
  body: string;
  timestamp: string;
  signature: string;
  now?: Date;
  toleranceSeconds?: number;
}): void {
  const ts = Number(input.timestamp);
  const now = (input.now ?? new Date()).getTime() / 1000;
  if (!Number.isInteger(ts) || Math.abs(now - ts) > (input.toleranceSeconds ?? 300)) {
    throw new CommandError("WEBHOOK_SIGNATURE_INVALID", 401, "Chữ ký webhook không hợp lệ hoặc đã quá hạn");
  }
  const expected = createHmac("sha256", input.secret).update(`${input.timestamp}.${input.body}`).digest();
  const given = /^[0-9a-f]{64}$/i.test(input.signature)
    ? Buffer.from(input.signature, "hex")
    : Buffer.alloc(0);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new CommandError("WEBHOOK_SIGNATURE_INVALID", 401, "Chữ ký webhook không hợp lệ hoặc đã quá hạn");
  }
}

export function signSim(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}
