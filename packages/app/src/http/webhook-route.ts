// POST /api/v1/webhooks/{provider}/{account} (API-CONTRACT §3; SPEC-ledger S-016…S-018, S-030). Không có phiên người dùng:
// xác thực bằng chữ ký HMAC + timestamp của nhà cung cấp. Chỉ adapter mô phỏng `sim` (adapter ngân hàng thật: F-016).
// Ghi inbox + bank_transactions rồi trả 2xx ngay; tự ghép/ghi tiền chạy trong worker (`bank_transaction.received`).
import type { Kysely } from "kysely";
import { z } from "zod";
import { ingestBankEvent, verifySimSignature } from "../ledger/bank-inbox.ts";
import { toProblem } from "../pipeline/problem.ts";
import { correlationOf, json, problemResponse, simpleProblem, validationProblem } from "./command-route.ts";

export interface WebhookDeps {
  db: Kysely<unknown>;
  /** Bí mật HMAC của adapter `sim`; không đặt → adapter tắt (404). */
  simSecret: string | undefined;
  /** Đếm/ghi cảnh báo chữ ký sai (S-017) — không kèm nội dung. */
  onRejected?(reason: "signature", correlationId: string): void;
  onUnexpectedError?(err: unknown, correlationId: string): void;
}

export const WEBHOOK_MAX_BYTES = 64 * 1024;

export const simPayload = z.strictObject({
  event_id: z.string().min(1).max(200),
  bank_txn_ref: z.string().trim().min(1).max(100),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  occurred_at: z.iso.datetime({ offset: true }),
  description: z.string().max(500).optional(),
  balance_after: z.number().int().max(Number.MAX_SAFE_INTEGER).optional(),
});

/** Đọc body tối đa `max` byte — không đọc hết payload khổng lồ khi thiếu/khai sai Content-Length (review 🟢11). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleWebhook(
  provider: string,
  account: string,
  req: Request,
  deps: WebhookDeps,
): Promise<Response> {
  const correlationId = correlationOf(req);
  if (provider !== "sim" || !deps.simSecret) {
    return simpleProblem("NOT_FOUND", 404, "Không có nhà cung cấp này", correlationId);
  }
  try {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > WEBHOOK_MAX_BYTES)
      return simpleProblem("VALIDATION_FAILED", 422, "Payload quá lớn", correlationId);
    const body = await readCapped(req, WEBHOOK_MAX_BYTES);
    if (body === null) return simpleProblem("VALIDATION_FAILED", 422, "Payload quá lớn", correlationId);
    try {
      verifySimSignature({
        secret: deps.simSecret,
        account,
        body,
        timestamp: req.headers.get("x-hm-timestamp") ?? "",
        signature: req.headers.get("x-hm-signature") ?? "",
      });
    } catch (err) {
      deps.onRejected?.("signature", correlationId);
      return problemResponse(toProblem(err, correlationId), correlationId);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(body);
    } catch {
      return simpleProblem("MALFORMED_REQUEST", 400, "Body không phải JSON", correlationId);
    }
    const parsed = simPayload.safeParse(parsedJson);
    if (!parsed.success) return validationProblem(parsed.error, correlationId);
    const p = parsed.data;
    const r = await ingestBankEvent(deps.db, {
      provider: "sim",
      account,
      providerEventId: p.event_id,
      raw: parsedJson as Record<string, unknown>,
      signatureVerified: true,
      source: "webhook",
      txn: {
        ref: p.bank_txn_ref,
        amount: p.amount,
        occurredAt: new Date(p.occurred_at),
        ...(p.description === undefined ? {} : { description: p.description }),
        ...(p.balance_after === undefined ? {} : { balanceAfter: p.balance_after }),
      },
    });
    return json({ received: true, duplicate: r.duplicateEvent || r.existingTransaction }, 200, correlationId);
  } catch (err) {
    const p = toProblem(err, correlationId);
    if (p.status < 500) return problemResponse(p, correlationId);
    deps.onUnexpectedError?.(err, correlationId);
    return problemResponse(p, correlationId);
  }
}
