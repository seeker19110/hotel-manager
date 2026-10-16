// Cổng gửi email (ADR-0002: adapter `EmailSender`; dev/CI dùng `FakeEmailSender`). Adapter SMTP/nhà cung cấp THẬT chưa
// có — chọn nhà cung cấp là điểm dừng của chủ dự án (SPEC-notifications Q-01); sẽ cài đặt cùng interface này.
// Mẫu email tối thiểu (S-012, TM-14): chỉ tên cơ sở, nhãn kỳ/hạn, liên kết portal yêu cầu đăng nhập, liên kết huỷ đăng ký;
// KHÔNG số tiền (Q-03), không CCCD/SĐT/nội dung hợp đồng.

export type EmailErrorKind = "TEMPORARY" | "PERMANENT";
/** Mã lỗi lưu ở `notification_deliveries.last_error_code`. */
export type DeliveryErrorCode = "RECIPIENT_INVALID" | "PROVIDER_TEMPORARY" | "TEMPLATE_ERROR";

export class EmailError extends Error {
  readonly kind: EmailErrorKind;
  readonly code: DeliveryErrorCode;
  constructor(kind: EmailErrorKind, code: DeliveryErrorCode, message: string) {
    super(message);
    this.name = "EmailError";
    this.kind = kind;
    this.code = code;
  }
}

export interface EmailMessage {
  to: string;
  /** Tên mẫu = loại thông báo. */
  template: string;
  vars: Readonly<Record<string, string>>;
  /** = `delivery_id`: nhà cung cấp dùng để không gửi trùng khi ta gửi lại (S-003). */
  idempotencyKey: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export interface RenderedEmail {
  subject: string;
  text: string;
}

interface Template {
  required: readonly string[];
  subject(v: Readonly<Record<string, string>>): string;
  lines(v: Readonly<Record<string, string>>): string[];
}

const generic = (subject: string): Template => ({
  required: ["propertyName", "summary", "portalUrl"],
  subject: (v) => `${subject} — ${v.propertyName}`,
  lines: (v) => [`${v.summary}`, `Xem chi tiết (cần đăng nhập): ${v.portalUrl}`],
});

export const EMAIL_TEMPLATES: Readonly<Record<string, Template>> = {
  invoice_issued: {
    required: ["propertyName", "periodLabel", "dueDate", "portalUrl"],
    subject: (v) => `Phiếu thu kỳ ${v.periodLabel} — ${v.propertyName}`,
    lines: (v) => [
      `${v.propertyName} đã phát hành phiếu thu kỳ ${v.periodLabel}.`,
      `Hạn thanh toán: ${v.dueDate}.`,
      `Xem phiếu (cần đăng nhập): ${v.portalUrl}`,
    ],
  },
  invoice_overdue: {
    required: ["propertyName", "periodLabel", "dueDate", "portalUrl"],
    subject: (v) => `Nhắc phiếu thu kỳ ${v.periodLabel} đã quá hạn — ${v.propertyName}`,
    lines: (v) => [
      `Phiếu thu kỳ ${v.periodLabel} của ${v.propertyName} đã quá hạn (hạn ${v.dueDate}).`,
      `Xem phiếu (cần đăng nhập): ${v.portalUrl}`,
    ],
  },
  lease_expiring: {
    required: ["propertyName", "endDate", "portalUrl"],
    subject: (v) => `Hợp đồng sắp hết hạn — ${v.propertyName}`,
    lines: (v) => [
      `Hợp đồng thuê tại ${v.propertyName} sẽ kết thúc ngày ${v.endDate}.`,
      `Xem chi tiết (cần đăng nhập): ${v.portalUrl}`,
    ],
  },
  account_security: generic("Thông báo tài khoản"),
  maintenance_status: generic("Cập nhật sự cố"),
  export_ready: generic("Tệp xuất dữ liệu đã sẵn sàng"),
};

/** Loại có kênh email (stay_notice_due chỉ trong app — SPEC §4). */
export function hasEmailChannel(type: string): boolean {
  return Object.hasOwn(EMAIL_TEMPLATES, type);
}

/** Thiếu mẫu/biến → TemplateError (delivery `failed` TEMPLATE_ERROR, không gửi email rỗng). */
export function renderEmail(template: string, vars: Readonly<Record<string, string>>): RenderedEmail {
  const t = Object.hasOwn(EMAIL_TEMPLATES, template) ? EMAIL_TEMPLATES[template] : undefined;
  if (!t) throw new TemplateError(`Không có mẫu email "${template}"`);
  for (const k of t.required) {
    const v = vars[k];
    if (typeof v !== "string" || v.trim() === "")
      throw new TemplateError(`Mẫu "${template}" thiếu biến ${k}`);
  }
  const lines = t.lines(vars);
  if (vars.unsubscribeUrl) {
    lines.push("", `Không muốn nhận email loại này nữa? Huỷ đăng ký: ${vars.unsubscribeUrl}`);
  }
  return { subject: t.subject(vars), text: lines.join("\n") };
}

export interface SentEmail extends EmailMessage {
  providerMessageId: string;
  rendered: RenderedEmail;
}

export type FakeBehavior = "ok" | "temporary" | "permanent";

/**
 * Hộp thư bộ nhớ cho dev/CI. Cấu hình được lỗi tạm thời/vĩnh viễn; nhận lại cùng `idempotencyKey` thì trả đúng
 * `providerMessageId` cũ và KHÔNG thêm thư (mô phỏng khử trùng của nhà cung cấp).
 */
export class FakeEmailSender implements EmailSender {
  readonly mailbox: SentEmail[] = [];
  /** Số lần `send` được gọi (kể cả lỗi/trùng) — để test retry. */
  calls = 0;
  behavior: FakeBehavior = "ok";
  /** Độ trễ giả (ms) trước khi trả lời — để test song song. */
  latencyMs = 0;
  private readonly byKey = new Map<string, string>();

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    this.calls++;
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (this.behavior === "temporary") {
      throw new EmailError("TEMPORARY", "PROVIDER_TEMPORARY", "nhà cung cấp tạm lỗi (giả)");
    }
    if (this.behavior === "permanent" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to)) {
      throw new EmailError("PERMANENT", "RECIPIENT_INVALID", "địa chỉ không hợp lệ (giả)");
    }
    const seen = this.byKey.get(message.idempotencyKey);
    if (seen) return { providerMessageId: seen };
    const rendered = renderEmail(message.template, message.vars);
    const providerMessageId = `fake-${this.mailbox.length + 1}-${message.idempotencyKey.slice(0, 8)}`;
    this.byKey.set(message.idempotencyKey, providerMessageId);
    this.mailbox.push({ ...message, providerMessageId, rendered });
    return { providerMessageId };
  }

  clear(): void {
    this.mailbox.length = 0;
    this.byKey.clear();
    this.calls = 0;
  }
}
