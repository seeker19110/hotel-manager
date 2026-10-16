// Kênh email (SPEC-notifications §5, D-010): interface `EmailSender` + bản giả `FakeEmailSender` cho dev/CI. Adapter SMTP
// thật (nodemailer, requireTLS) chờ chủ dự án duyệt giấy phép MIT-0 — cùng interface và contract test.
// Adapter phân loại lỗi: `temporary` (5xx, timeout, mất kết nối → thử lại có backoff) / `permanent` (địa chỉ không hợp lệ,
// 5.1.x → không thử lại). `idempotencyKey` = id lần gửi: gửi lại cùng khoá không tạo email thứ hai (S-003).

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}

export type EmailErrorKind = "temporary" | "permanent";

export class EmailSendError extends Error {
  readonly kind: EmailErrorKind;
  constructor(kind: EmailErrorKind, message: string) {
    super(message);
    this.name = "EmailSendError";
    this.kind = kind;
  }
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}

/** Bản giả: ghi vào bộ nhớ, giữ đúng một email mỗi `idempotencyKey`; `failWith` mô phỏng lỗi nhà cung cấp. */
export class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  readonly attempts: EmailMessage[] = [];
  private readonly byKey = new Map<string, string>();
  failWith: ((m: EmailMessage) => EmailSendError | null) | null = null;

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    this.attempts.push(message);
    const err = this.failWith?.(message);
    if (err) throw err;
    const known = this.byKey.get(message.idempotencyKey);
    if (known) return { providerMessageId: known };
    const id = `fake-${this.byKey.size + 1}`;
    this.byKey.set(message.idempotencyKey, id);
    this.sent.push(message);
    return { providerMessageId: id };
  }
}
