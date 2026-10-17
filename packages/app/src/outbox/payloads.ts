// Schema payload job theo event_type (T-401, BE-JOB-007). Payload outbox chỉ mang id và tham số tối thiểu; worker validate
// khi NHẬN job (trước handler) nên payload sai (producer lệch phiên bản, dữ liệu hỏng) là lỗi VĨNH VIỄN: không retry,
// vào dead letter ngay (`isPermanentJobError` ở apps/worker/src/relay.ts). Chỉ module này biết dạng payload của từng loại.
import { z } from "zod";

/** Id dạng 8-4-4-4-12 (gồm cả UUID v4/v7 do app và Postgres sinh). */
const id = z.guid();

/**
 * Schema theo event_type của MỌI consumer có sẵn của worker. Dùng `looseObject`: khoá thừa (producer thêm trường nhưng
 * consumer chưa dùng) không làm hỏng job, nhưng khoá bắt buộc sai kiểu/thiếu thì có. Thêm consumer mới ⇒ thêm schema ở đây
 * (test `outbox-payloads.test.ts` chặn quên).
 */
export const OUTBOX_PAYLOAD_SCHEMAS = {
  "invoice.issued": z.looseObject({ invoice_id: id }),
  "work_order.status_changed": z.looseObject({ work_order_id: id, status: z.string().min(1).max(40) }),
  "portal.tenant_invited": z.looseObject({ membership_id: id, person_id: id }),
  "export.requested": z.looseObject({ export_id: id }),
  // T-605: email lời mời nhân viên (token dựng lại ở worker, không nằm trong payload).
  "member.invited": z.looseObject({ invitation_id: id }),
  "bank_transaction.received": z.looseObject({ bank_transaction_id: id }),
  // T-405: thông báo account_security cho chính người bị đặt lại MFA.
  "member.mfa_reset": z.looseObject({ membership_id: id, by_membership_id: id }),
  "member.password_changed": z.looseObject({ membership_id: id }),
  "member.mfa_disabled": z.looseObject({ membership_id: id }),
} as const satisfies Record<string, z.ZodType>;

/** Khoá không bao giờ được nằm trong payload job (BE-JOB-007: không bí mật, không dữ liệu serialize lệch phiên bản). */
export const FORBIDDEN_PAYLOAD_KEY = /pass(word|wd)|token|secret|api[_-]?key|credential/i;

/** Payload không hợp lệ: lỗi tất định — chạy lại không khỏi. `permanent` để relay đưa thẳng vào dead letter. */
export class InvalidJobPayloadError extends Error {
  readonly permanent = true as const;
  readonly eventType: string;
  constructor(eventType: string, message: string) {
    super(message);
    this.name = "InvalidJobPayloadError";
    this.eventType = eventType;
  }
}

/**
 * Validate payload của job `eventType`. Loại có schema ⇒ phải khớp; loại không có schema (consumer thêm ngoài danh sách,
 * thường là test) chỉ bị kiểm khoá cấm. Trả payload đã kiểm; ném `InvalidJobPayloadError` (thông điệp không kèm giá trị).
 */
export function parseOutboxPayload(eventType: string, payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new InvalidJobPayloadError(eventType, "payload không phải đối tượng");
  const bad = Object.keys(payload).find((k) => FORBIDDEN_PAYLOAD_KEY.test(k));
  if (bad !== undefined) throw new InvalidJobPayloadError(eventType, `payload chứa khoá cấm: ${bad}`);
  const schema = (OUTBOX_PAYLOAD_SCHEMAS as Record<string, z.ZodType | undefined>)[eventType];
  if (!schema) return payload as Record<string, unknown>;
  const r = schema.safeParse(payload);
  if (!r.success) {
    const where = r.error.issues.map((i) => i.path.join(".") || "(gốc)").join(", ");
    throw new InvalidJobPayloadError(eventType, `payload sai schema ở: ${where}`);
  }
  return payload as Record<string, unknown>;
}
