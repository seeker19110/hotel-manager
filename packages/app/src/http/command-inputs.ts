// Schema đầu vào của các command mà FORM ở trình duyệt gửi — MỘT nguồn cho cả hai phía (FE-FORM-001): `registry.ts` dùng
// đúng các schema này làm `input` của lệnh (server validate lại mọi request), còn form (`apps/web/components/command/`, qua
// `@hm/app/command-inputs`) kiểm cùng schema trước khi gửi để báo lỗi theo ô sớm. Module này CHỈ import `zod` và
// `./form-rules.ts` (thuần) — không import mã server (CSDL, S3, xác thực) nên vào bundle trình duyệt được; có test chặn
// import lạ (`command-inputs.test.ts`) và quét bundle `.next/static`. Phía client chỉ để báo lỗi sớm, không phải ranh giới tin cậy.
// Câu lỗi form lấy từ catalog con `packages/app/messages/form.vi.json` (D-106): CHỈ câu form, cùng định dạng catalog chính —
// KHÔNG import `../i18n.ts`/`messages/vi.json` (catalog server, D-098: không nhân bản catalog lớn vào bundle trình duyệt).
// `scripts/i18n-check.mjs` kiểm catalog con (mô tả, cú pháp, tham số) và mọi lời gọi `formText` (khoá có thật, đúng tham số).
import { z } from "zod";
import formMessages from "../../messages/form.vi.json" with { type: "json" };
import { MONEY_MAX, nfcDeep } from "./form-rules.ts";

export type FormMessageKey = keyof typeof formMessages;

/**
 * Câu form theo khoá, thay `{ten}` bằng tham số MỘT lượt; tham số thiếu giữ nguyên `{ten}` — cùng hành vi `format` của
 * `../i18n.ts` (sao lại vì không được import module đó; `scripts/i18n.test.mjs` so hai bản trên cùng bộ ca).
 */
export function formText(
  key: FormMessageKey,
  params: Readonly<Record<string, string | number>> = {},
): string {
  return formMessages[key].message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

export const uuid = z.uuid();
export const money = z.number().int().nonnegative().max(MONEY_MAX);
export const positiveMoney = z.number().int().positive().max(MONEY_MAX);
export const bankTxn = z.strictObject({
  ref: z.string().trim().min(1).max(100),
  occurred_at: z.iso.datetime({ offset: true }),
  description: z.string().max(500).optional(),
});
export const isoDate = z.iso.date();
export const guest = z.strictObject({
  person_id: uuid.optional(),
  full_name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().min(6).max(20).optional(),
  email: z.email().max(320).optional(),
  doc_type: z.enum(["cccd", "passport", "other"]),
  doc_number: z.string().trim().min(5).max(40),
  nationality: z.string().trim().length(2).optional(),
});

/** Giờ trong ngày dạng HH:MM (00:00–23:59) — `business_day_cutoff`, giờ nhận/trả phòng (SPEC-access S-002). */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, formText("form.clock_time"));
/** Tên hiển thị: không ký tự NUL (Postgres từ chối byte 0x00 trong text ⇒ sẽ thành 500 nếu lọt vào CSDL). */
const displayName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !v.includes("\u0000"), { message: formText("form.no_control_chars") });
const propertyName = displayName;
const propertyTemplate = z.enum(["rental", "hotel", "mixed"]);
const timezoneName = z.string().trim().min(1).max(64);

const memberRole = z.enum(["owner", "manager", "front_desk", "accountant", "housekeeping", "maintenance"]);
/** Hạn mức tiền của thành viên (bigint đồng ≥ 0; 0 = mọi khoản cần duyệt). */
const memberLimits = z.strictObject({
  discount: money.optional(),
  refund: money.optional(),
  price_override: money.optional(),
});

/** Schema đầu vào theo tên lệnh (`<module>.<command>`) của các lệnh có form ở web. */
export const COMMAND_INPUTS = {
  "billing.createPeriod": z.strictObject({
    property_id: uuid,
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  }),
  "billing.issuePeriod": z.strictObject({
    billing_period_id: uuid,
    preview_hash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  "billing.returnToDraft": z.strictObject({
    billing_period_id: uuid,
    reason: z.string().trim().min(1).max(500),
  }),
  "billing.submitForReview": z.strictObject({ billing_period_id: uuid }),
  "deposit.receive": z
    .strictObject({
      property_id: uuid,
      lease_id: uuid.optional(),
      reservation_id: uuid.optional(),
      payer_person_id: uuid,
      amount: positiveMoney,
      method: z.enum(["cash", "bank_transfer"]),
      receiving_account_id: uuid.optional(),
      bank_txn: bankTxn.optional(),
    })
    .refine((i) => Boolean(i.lease_id) !== Boolean(i.reservation_id), {
      message: formText("form.deposit_target"),
    }),
  "housekeeping.cancelTask": z.strictObject({ task_id: uuid, reason: z.string().trim().min(1).max(1000) }),
  "housekeeping.claimTask": z.strictObject({ task_id: uuid }),
  "housekeeping.completeTask": z.strictObject({ task_id: uuid, note: z.string().max(2000).optional() }),
  "housekeeping.createTask": z.strictObject({
    unit_id: uuid,
    kind: z.enum(["cleaning", "inspection"]),
    priority: z.enum(["normal", "high", "urgent"]).optional(),
    note: z.string().max(2000).optional(),
  }),
  "housekeeping.startTask": z.strictObject({ task_id: uuid }),
  "housekeeping.verifyTask": z.strictObject({
    task_id: uuid,
    result: z.enum(["pass", "fail"]),
    reason: z.string().trim().max(1000).optional(),
  }),
  "inventory.setUnitAvailability": z.strictObject({
    unit_id: uuid,
    availability: z.enum(["active", "out_of_service"]),
    reason: z.string().trim().max(1000).optional(),
  }),
  "lease.activate": z.strictObject({ lease_id: uuid }),
  "lease.giveNotice": z.strictObject({ lease_id: uuid, planned_move_out_on: isoDate }),
  "lease.prepareSettlement": z.strictObject({
    lease_id: uuid,
    fees: z
      .array(
        z.strictObject({
          amount: positiveMoney,
          reason: z.string().max(500),
          file_ids: z.array(uuid).max(20).optional(),
        }),
      )
      .max(20),
    deductions: z
      .array(
        z.strictObject({
          invoice_id: uuid.nullable().optional(),
          amount: positiveMoney,
          reason: z.string().max(500),
        }),
      )
      .max(50)
      .optional(),
  }),
  "lease.recordHandover": z.strictObject({
    lease_id: uuid,
    kind: z.enum(["move_in", "move_out"]),
    handed_over_on: isoDate,
    readings: z.strictObject({
      electric: z.number().nonnegative().optional(),
      water: z.number().nonnegative().optional(),
    }),
    assets: z
      .array(
        z.strictObject({
          name: z.string().max(100),
          quantity: z.number().int(),
          condition: z.string().max(200),
          file_ids: z.array(uuid).max(20).optional(),
        }),
      )
      .max(50),
    keys_count: z.number().int().min(0).max(100),
    photo_file_ids: z.array(uuid).max(20),
    note: z.string().max(2000).optional(),
    tenant_confirmation: z.strictObject({ method: z.enum(["in_person", "portal"]) }).optional(),
  }),
  "lease.sign": z.strictObject({ lease_id: uuid, signer_person_id: uuid, signed_on: isoDate.optional() }),
  "lease.submitForSignature": z.strictObject({ lease_id: uuid }),
  "maintenance.assignWorkOrder": z.strictObject({ work_order_id: uuid, assignee_membership_id: uuid }),
  "maintenance.cancelWorkOrder": z.strictObject({
    work_order_id: uuid,
    reason: z.string().trim().min(1).max(1000),
  }),
  "maintenance.completeWorkOrder": z.strictObject({
    work_order_id: uuid,
    note: z.string().max(2000).optional(),
    file_ids: z.array(uuid).max(5).default([]),
  }),
  "maintenance.createWorkOrder": z.strictObject({
    unit_id: uuid,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000),
    severity: z.enum(["low", "medium", "high", "critical"]),
    file_ids: z.array(uuid).max(5).default([]),
  }),
  "maintenance.startWorkOrder": z.strictObject({ work_order_id: uuid }),
  "maintenance.verifyWorkOrder": z.strictObject({ work_order_id: uuid }),
  "meter.recordReading": z.strictObject({
    meter_id: uuid,
    billing_period_id: uuid,
    value: z.number().nonnegative(),
    read_on: isoDate.optional(),
    photo_file_id: uuid.optional(),
    base_version: z.number().int().positive().optional(),
  }),
  "notifications.markAllRead": z.strictObject({}),
  "notifications.markRead": z.strictObject({ notification_id: uuid }),
  "member.acceptInvitation": z.strictObject({ token: z.string().min(1).max(200) }),
  "member.invite": z.strictObject({
    email: z.email().max(320),
    role: memberRole,
    property_ids: z.array(uuid).max(50).default([]),
    limits: memberLimits.default({}),
  }),
  "member.updateRole": z.strictObject({
    membership_id: uuid,
    role: memberRole,
    property_ids: z.array(uuid).max(50).optional(),
    reason: z.string().trim().min(1).max(500),
  }),
  "member.updateScope": z.strictObject({
    membership_id: uuid,
    property_ids: z.array(uuid).max(50),
    all_properties: z.boolean().optional(),
    reason: z.string().trim().min(1).max(500),
  }),
  "session.revokeAll": z.strictObject({ membership_id: uuid.optional() }),
  "org.create": z.strictObject({ name: displayName }),
  "payment.collectCash": z.strictObject({ invoice_id: uuid, amount: positiveMoney }),
  "payment.confirm": z.strictObject({
    payment_id: uuid,
    evidence: z
      .strictObject({ bank_transaction_id: uuid.optional(), bank_txn: bankTxn.optional() })
      .optional(),
  }),
  "portal.createRequest": z.strictObject({
    unit_id: uuid,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000),
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
    file_ids: z.array(uuid).max(5).optional(),
  }),
  "portal.submitPaymentClaim": z.strictObject({
    invoice_id: uuid,
    amount: z.number().int(),
    reference_code: z.string().trim().max(100).optional(),
    proof_file_id: uuid.optional(),
  }),
  "property.create": z.strictObject({
    name: propertyName,
    template: propertyTemplate,
    timezone: timezoneName.optional(),
    business_day_cutoff: clockTime.optional(),
    check_in_time: clockTime.optional(),
    check_out_time: clockTime.optional(),
  }),
  "property.update": z
    .strictObject({
      property_id: uuid,
      name: propertyName.optional(),
      template: propertyTemplate.optional(),
      timezone: timezoneName.optional(),
      business_day_cutoff: clockTime.optional(),
      check_in_time: clockTime.nullable().optional(),
      check_out_time: clockTime.nullable().optional(),
    })
    .refine((i) => Object.keys(i).some((k) => k !== "property_id"), {
      message: formText("form.update_needs_field"),
    }),
  "reconciliation.resolveBreak": z.strictObject({
    break_id: uuid,
    resolution: z.string().trim().min(1).max(1000),
  }),
  "reservation.cancel": z.strictObject({
    reservation_id: uuid,
    reason: z.string().trim().min(1).max(1000),
    cancellation_fee: money.optional(),
  }),
  "reservation.confirm": z.strictObject({
    reservation_id: uuid,
    payment: z
      .strictObject({
        amount: positiveMoney,
        method: z.enum(["cash", "bank_transfer"]),
        kind: z.enum(["advance", "security_deposit"]),
        receiving_account_id: uuid.optional(),
        bank_txn: bankTxn.optional(),
      })
      .optional(),
  }),
  "reservation.hold": z.strictObject({ reservation_id: uuid }),
  "reservation.markNoShow": z.strictObject({
    reservation_id: uuid,
    reason: z.string().trim().min(1).max(1000),
  }),
  "reservation.create": z.strictObject({
    unit_id: uuid,
    arrival_date: isoDate,
    departure_date: isoDate,
    guests: z.number().int().min(1).max(50),
    source: z.literal("direct"),
    booker: z.union([
      z.strictObject({ person_id: uuid }),
      z.strictObject({
        full_name: z.string().trim().min(1).max(200),
        phone: z.string().trim().min(6).max(20),
        email: z.email().max(320).optional(),
      }),
    ]),
  }),
  "shift.open": z.strictObject({ property_id: uuid, opening_cash: money }),
  "stay.checkIn": z.strictObject({ reservation_id: uuid, guests: z.array(guest).min(1).max(50) }),
  "stay.checkOut": z.strictObject({
    stay_id: uuid,
    payments: z
      .array(
        z.strictObject({
          method: z.enum(["cash", "bank_transfer"]),
          amount: positiveMoney,
          receiving_account_id: uuid.optional(),
          bank_txn: bankTxn.optional(),
        }),
      )
      .max(10)
      .optional(),
    allow_balance: z
      .strictObject({ approval_request_id: uuid.optional(), debtor_person_id: uuid, due_date: isoDate })
      .optional(),
    deposit_refund: z
      .strictObject({
        amount: positiveMoney,
        method: z.enum(["cash", "bank_transfer"]),
        receiving_account_id: uuid.optional(),
      })
      .optional(),
    deposit_deduction: z
      .strictObject({ amount: positiveMoney, reason: z.string().trim().min(1).max(1000) })
      .optional(),
  }),
  "stay.markNoticeSubmitted": z.strictObject({
    notice_id: uuid,
    submitted_at: z.iso.datetime({ offset: true }),
    channel: z.enum(["in_person", "online", "other"]),
    evidence_file_id: uuid.optional(),
  }),
  "stay.postCharge": z.strictObject({
    stay_id: uuid,
    kind: z.enum(["service", "fee", "discount"]),
    description: z.string().trim().min(1).max(500),
    quantity: z.number().int().min(1).max(1000).default(1),
    unit_price: positiveMoney,
  }),
  "stay.voidCharge": z.strictObject({ charge_id: uuid, reason: z.string().trim().min(1).max(1000) }),
  "stay.walkIn": z.strictObject({
    unit_id: uuid,
    departure_date: isoDate,
    guests: z.array(guest).min(1).max(50),
  }),
  // SPEC-access-and-property S-005/S-006 (`unit.manage`). Tầng/loại phòng theo sức chứa tự tạo nếu chưa có (units.ts).
  "unit.archive": z.strictObject({ unit_id: uuid }),
  "unit.create": z.strictObject({
    property_id: uuid,
    floor: z.string().trim().min(1).max(100),
    code: z.string().trim().min(1).max(20),
    capacity: z.number().int().min(1).max(50),
    /** V1 chỉ bán nguyên phòng (S-005): `bed` → 422 VALIDATION_FAILED ở trường `kind`. */
    kind: z.literal("whole").optional(),
    /** V1 chưa có phòng con/giường: giá trị khác null bị `createUnit` từ chối 422 ở trường `parent_unit_id`. */
    parent_unit_id: uuid.nullable().optional(),
  }),
} as const;

export interface FieldIssue {
  /** Đường dẫn trường kiểu `a.b.0.c` ("" = lỗi cấp thân/đối tượng). */
  field: string;
  message: string;
}

/** Câu tiếng Việt cho một lỗi zod — không in `input` thô (có thể là dữ liệu cá nhân). */
function issueText(i: z.core.$ZodIssue): string {
  switch (i.code) {
    case "invalid_type":
      return i.input === undefined ? formText("form.required") : formText("form.wrong_type");
    case "too_small":
      return i.origin === "string"
        ? i.minimum === 1
          ? formText("form.required")
          : formText("form.min_chars", { min: String(i.minimum) })
        : i.origin === "array"
          ? formText("form.min_items", { min: String(i.minimum) })
          : i.inclusive
            ? formText("form.min_inclusive", { min: String(i.minimum) })
            : formText("form.min_exclusive", { min: String(i.minimum) });
    case "too_big":
      return i.origin === "string"
        ? formText("form.max_chars", { max: String(i.maximum) })
        : i.origin === "array"
          ? formText("form.max_items", { max: String(i.maximum) })
          : formText("form.max_inclusive", { max: String(i.maximum) });
    case "invalid_format":
      return i.format === "email" ? formText("form.email_invalid") : formText("form.format_invalid");
    case "invalid_value":
      return formText("form.not_in_options");
    case "unrecognized_keys":
      return formText("form.unknown_field");
    default:
      return formText("form.invalid");
  }
}

/**
 * Kiểm `body` bằng ĐÚNG schema `input` của lệnh server (`path` dạng `module/command`, như đường dẫn gọi API).
 * Trả danh sách lỗi theo trường (rỗng = hợp lệ). Lệnh chưa có trong danh mục → `null` (không kiểm được phía client;
 * server vẫn kiểm). Trả `null` thay vì "hợp lệ" để test bắt được form gọi lệnh chưa đăng ký.
 */
export function checkCommandInput(path: string, body: unknown): FieldIssue[] | null {
  const name = path.replace("/", ".");
  if (!Object.hasOwn(COMMAND_INPUTS, name)) return null;
  const schema = (COMMAND_INPUTS as Record<string, z.ZodType>)[name];
  if (!schema) return null;
  // Cùng thứ tự với server (command-route): NFC rồi mới kiểm, để chuỗi gõ kiểu tổ hợp không bị chặn sai độ dài.
  const r = schema.safeParse(nfcDeep(body));
  if (r.success) return [];
  // Mỗi trường một thông báo (lỗi đầu tiên) — người dùng sửa từng ô một, không cần chồng nhiều câu.
  const out = new Map<string, FieldIssue>();
  for (const i of r.error.issues) {
    const field = i.path.map(String).join(".");
    if (!out.has(field)) out.set(field, { field, message: issueText(i) });
  }
  return [...out.values()];
}
