// POST /api/v1/webhooks/{provider}/{account} (API-CONTRACT §3; SPEC-ledger S-016…S-018, S-030). Không có phiên người dùng:
// xác thực bằng chữ ký HMAC + timestamp của nhà cung cấp. Chỉ adapter mô phỏng `sim` (adapter ngân hàng thật: F-016).
// Ghi inbox + bank_transactions rồi trả 2xx ngay; tự ghép/ghi tiền chạy trong worker (`bank_transaction.received`).
import { kibToBytes } from "@hm/domain";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ingestBankEvent, parseWebhookSecrets, verifySimSignature } from "../ledger/index.ts";
import { rateLimited, toProblem } from "../pipeline/index.ts";
import {
  correlationOf,
  json,
  problemResponse,
  rejectInput,
  simpleProblem,
  validationProblem,
} from "./command-route.ts";
import {
  rateLimitHit,
  WEBHOOK_BAD_SIGNATURE_PER_MINUTE,
  WEBHOOK_PER_ACCOUNT_PER_MINUTE,
} from "./rate-limit.ts";

export interface WebhookDeps {
  db: Kysely<unknown>;
  /**
   * Khoá HMAC của adapter `sim`: một khoá hoặc danh sách phân tách dấu phẩy (xoay khoá không gián đoạn — thử từng khoá);
   * không đặt/rỗng → adapter tắt (404).
   */
  simSecret: string | undefined;
  /** Đếm/ghi cảnh báo chữ ký sai (S-017) — không kèm nội dung. */
  onRejected?(reason: "signature", correlationId: string): void;
  onUnexpectedError?(err: unknown, correlationId: string): void;
  /** Ghi đè hạn mức/phút (chỉ test): theo tài khoản đã xác thực · chữ ký sai theo nhà cung cấp. */
  rateLimit?: { perAccount?: number; badSignature?: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const WEBHOOK_MAX_BYTES = kibToBytes(64);
/** Đích của sự kiện bảo mật webhook: mẫu route, KHÔNG kèm mã tài khoản (đường dẫn thật). */
const WEBHOOK_TARGET = { type: "endpoint", id: "/api/v1/webhooks/{provider}/{account}" };

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

function tooMany(retryAfter: number, correlationId: string): Response {
  return problemResponse(
    toProblem(rateLimited("Webhook gửi quá nhanh. Thử lại sau.", retryAfter), correlationId),
    correlationId,
  );
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
  // `account` là đoạn đường dẫn do kẻ gọi chọn: phải là UUID TRƯỚC khi đi tiếp (khoá bộ đếm, truy vấn) — chuỗi lạ/NUL từng làm
  // Postgres lỗi → 500 (BASE-SEC-001). Không phải UUID ⇒ không thể là tài khoản nhận nào: 404, không lộ gì.
  if (!UUID.test(account))
    return simpleProblem("NOT_FOUND", 404, "Không tìm thấy tài khoản nhận", correlationId);
  // Danh sách khoá sai dạng (cấu hình đã bị schema chặn từ lúc khởi động) ⇒ đóng: coi như adapter tắt, không chấp nhận gì.
  let secrets: string[];
  try {
    secrets = parseWebhookSecrets(deps.simSecret);
  } catch {
    secrets = [];
  }
  if (secrets.length === 0)
    return simpleProblem("NOT_FOUND", 404, "Không có nhà cung cấp này", correlationId);
  try {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > WEBHOOK_MAX_BYTES)
      return simpleProblem("VALIDATION_FAILED", 422, "Payload quá lớn", correlationId);
    const body = await readCapped(req, WEBHOOK_MAX_BYTES);
    if (body === null) return simpleProblem("VALIDATION_FAILED", 422, "Payload quá lớn", correlationId);
    try {
      verifySimSignature({
        secret: secrets,
        account,
        body,
        timestamp: req.headers.get("x-hm-timestamp") ?? "",
        signature: req.headers.get("x-hm-signature") ?? "",
      });
    } catch (err) {
      deps.onRejected?.("signature", correlationId);
      // Chữ ký sai quá nhiều (dò khoá/xả tải) → 429 thay cho 401. Đếm theo nhà cung cấp, KHÔNG theo `account` (kẻ gọi tự chọn,
      // sẽ làm bảng phình), và chỉ ảnh hưởng yêu cầu chữ ký sai — webhook hợp lệ không bao giờ bị chặn bởi bộ đếm này.
      const bad = await rateLimitHit(deps.db, {
        scope: "webhook_bad_signature",
        subject: provider,
        limit: deps.rateLimit?.badSignature ?? WEBHOOK_BAD_SIGNATURE_PER_MINUTE,
      });
      if (!bad.allowed) return tooMany(bad.retryAfter, correlationId);
      return problemResponse(toProblem(err, correlationId), correlationId);
    }
    // Đã xác thực chữ ký ⇒ `account` đáng tin (HMAC gắn tài khoản): giới hạn theo (nhà cung cấp, tài khoản) trước khi ghi inbox.
    const rate = await rateLimitHit(deps.db, {
      scope: "webhook",
      subject: `${provider}:${account}`.slice(0, 200),
      limit: deps.rateLimit?.perAccount ?? WEBHOOK_PER_ACCOUNT_PER_MINUTE,
    });
    if (!rate.allowed) return tooMany(rate.retryAfter, correlationId);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(body);
    } catch {
      rejectInput(req, correlationId, "input.deserialize_failed", null, WEBHOOK_TARGET, "MALFORMED_REQUEST");
      return simpleProblem("MALFORMED_REQUEST", 400, "Body không phải JSON", correlationId);
    }
    const parsed = simPayload.safeParse(parsedJson);
    if (!parsed.success) {
      rejectInput(req, correlationId, "input.validation_failed", null, WEBHOOK_TARGET, "VALIDATION_FAILED");
      return validationProblem(parsed.error, correlationId);
    }
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
