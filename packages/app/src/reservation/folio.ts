// Folio và trả phòng (PLAN đợt 3 T-206; SPEC-reservation-stay §5 `stay.postCharge`/`voidCharge`/`checkOut`/`getFolio`, S-017…S-020,
// S-022…S-024, S-026, S-027; ERD §5.5; INV-F1, INV-F2, INV-F3b, INV-F5, INV-F6, INV-G3, INV-G4). Mọi lệnh chạy trong pipeline
// (idempotency, audit, outbox) — một Idempotency-Key ⇒ một kết quả (một phiếu, một payment, một biên nhận).
// - Folio = khung nhìn trên `charges` (tiền phòng ghi lúc check-in — T-205/D-009; dịch vụ/phụ thu ghi bằng `stay.postCharge`) và
//   `payment_allocations`. Check-out PHÁT HÀNH phiếu `invoices kind='folio'` (stay_id) + dòng phiếu từ chính các `charges` (không ghi hai
//   lần: `charges` đã lên phiếu thì bất biến — `app.charge_guard`; lượt ở đã có phiếu thì không thêm khoản — 0027), bút toán
//   Nợ AR / Có REV_ROOM|REV_SERVICE|REV_FEE ghi ngày kinh doanh của giờ trả phòng (kỳ đã khoá ⇒ PERIOD_LOCKED).
// - Tiền: ứng trước (`payments.reservation_id`, CUSTOMER_CREDIT → AR) và khoản thu trong lệnh (ghi → xác nhận → phân bổ bằng đúng
//   các hàm của `payments`, nên INV-F3b "lễ tân chỉ xác nhận tiền mặt MÌNH nhận trong ca mở" và INV-F2 "phân bổ không vượt" giữ
//   nguyên). Còn nợ ⇒ OUTSTANDING_BALANCE trừ khi người có quyền cho nợ (owner/manager) cho phép kèm người nợ + hạn trả; lỗi bất kỳ ⇒
//   cả lệnh rollback (không có phiếu/payment/check-out nửa vời).
// - Cọc bảo đảm KHÔNG trừ vào folio (INV-F5): hiển thị riêng; hoàn nguyên số trong hạn mức người thao tác (lễ tân ≤ 2.000.000 đ, chỉ
//   khi check-out) hoặc lập yêu cầu duyệt; khấu trừ luôn cần người thứ hai (deposit.requestDeduction/approval).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { AuthzError, authorize, stayMachine } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../access/actor.ts";
import { registerApprovalExecutor, requestApproval } from "../approvals/approvals.ts";
import { uniqueMemoRef } from "../billing/billing.ts";
import { refundDepositInline, requestDepositRefund } from "../deposits/deposits.ts";
import { openCleaningTask } from "../housekeeping/cleaning.ts";
import { resizeAllocation } from "../inventory/inventory.ts";
import { postEntry } from "../ledger/ledger.ts";
import {
  allocatePayment,
  confirmPayment,
  customerCredit,
  type ManualBankTxn,
  recordPayment,
} from "../payments/payments.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";
import { openShiftOf } from "../shifts/shifts.ts";
import { allocateOpeningAdvance, openingAdvancesOf } from "./opening-advance.ts";
import { assertDate } from "./rates.ts";
import { businessDateAt, loadItems, loadStays, lockReservation, transitionError } from "./reservation.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trần số tiền một khoản dịch vụ/phụ thu (đồng) — chống nhập nhầm thừa số 0; tổng folio vẫn ≤ 2^53. */
export const MAX_CHARGE_AMOUNT = 1_000_000_000_000;
export const MAX_CHARGE_QUANTITY = 1000;
export const MAX_CHECKOUT_PAYMENTS = 5;
/**
 * Hạn trả tối đa (ngày, kể từ ngày kinh doanh check-out) của khoản nợ cho phép lúc trả phòng. Nợ lưu trú ngắn hạn mà hạn 2099 là nợ
 * không bao giờ đòi: giới hạn buộc gia hạn/ghi nhận lại có người duyệt thay vì cho khoản nợ vô thời hạn; 30 ngày = một kỳ công nợ.
 */
export const MAX_DEBT_TERM_DAYS = 30;

const REVENUE_OF = { service: "REV_SERVICE", fee: "REV_FEE" } as const;
export type ManualChargeKind = keyof typeof REVENUE_OF;

// ---------- đọc ----------

interface StayHead {
  id: string;
  status: string;
  property_id: string;
  unit_id: string;
  reservation_id: string;
  arrival_date: string;
  checked_in_at: Date | null;
}

/** Đọc lượt ở qua RLS (buồng phòng/tổ chức khác ⇒ không thấy ⇒ 404); `lock` giữ khoá hàng tới hết transaction. */
async function readStay(ctx: CommandContext, stayId: string, lock: boolean): Promise<StayHead> {
  if (!UUID.test(stayId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
  const r = await sql<StayHead>`
    select s.id, s.status, s.property_id, s.unit_id, i.reservation_id, i.arrival_date::text as arrival_date, s.checked_in_at
    from stays s join reservation_items i on i.organization_id = s.organization_id and i.id = s.reservation_item_id
    where s.organization_id = ${ctx.actor.orgId} and s.id = ${stayId}
    ${lock ? sql`for update of s` : sql``}`.execute(ctx.trx);
  const row = r.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
  return row;
}

async function lockedThrough(ctx: CommandContext, propertyId: string): Promise<string | null> {
  const r = await sql<{ d: string | null }>`
    select app.locked_through(${ctx.actor.orgId}, ${propertyId})::text as d`.execute(ctx.trx);
  return r.rows[0]?.d ?? null;
}

function periodLocked(through: string, businessDate: string): CommandError {
  return new CommandError(
    "PERIOD_LOCKED",
    409,
    `Kỳ đã khoá tới ${through} (ngày kinh doanh ${businessDate}). Hãy tạo điều chỉnh có duyệt.`,
  );
}

function assertAmount(n: number, field: string, max: number): void {
  if (!Number.isSafeInteger(n) || n <= 0 || n > max)
    throw fieldError(field, "INVALID", `${field} là số nguyên đồng > 0 (tối đa ${max})`);
}

// ---------- stay.postCharge ----------

export interface PostChargeResult {
  charge_id: string;
  stay_id: string;
  kind: ManualChargeKind;
  revenue_account: string;
  business_date: string;
  quantity: number;
  unit_price: number;
  amount: number;
}

/**
 * `stay.postCharge` (S-017, S-018, S-022): ghi dịch vụ (`REV_SERVICE`) hoặc phụ thu/phí nhập tay (`REV_FEE`) vào folio của lượt ở
 * `in_house`, ngày kinh doanh = hiện tại (hoặc `businessDate` trong [đêm đầu, hôm nay]). Một lệnh một khoản (chỉ mục 0027) và cùng
 * Idempotency-Key ⇒ cùng một `charges` (pipeline); hai key khác nhau = hai khoản hợp lệ, huỷ bằng `stay.voidCharge`. Ngày thuộc kỳ đã
 * khoá ⇒ `409 PERIOD_LOCKED` (chỉ điều chỉnh có duyệt). Giảm giá cần duyệt hạn mức — chưa hỗ trợ ở lệnh này.
 */
export async function postCharge(
  ctx: CommandContext,
  input: {
    stayId: string;
    kind: ManualChargeKind;
    description: string;
    quantity?: number;
    unitPrice: number;
    businessDate?: string;
    now?: Date;
  },
): Promise<PostChargeResult> {
  const now = input.now ?? new Date();
  const seen = await readStay(ctx, input.stayId, false);
  authorize(ctx.actor, "folio.post_charge", { propertyId: seen.property_id });
  if (!Object.hasOwn(REVENUE_OF, input.kind))
    throw fieldError(
      "kind",
      "UNSUPPORTED",
      "Loại khoản: service (dịch vụ) hoặc fee (phụ thu); giảm giá cần duyệt",
    );
  const description = input.description.trim();
  if (description.length < 1 || description.length > 500)
    throw fieldError("description", "INVALID", "Mô tả 1–500 ký tự");
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_CHARGE_QUANTITY)
    throw fieldError("quantity", "INVALID", `Số lượng là số nguyên 1–${MAX_CHARGE_QUANTITY}`);
  assertAmount(input.unitPrice, "unit_price", MAX_CHARGE_AMOUNT);
  const amount = quantity * input.unitPrice;
  assertAmount(amount, "amount", MAX_CHARGE_AMOUNT);

  const stay = await readStay(ctx, input.stayId, true);
  if (stay.status !== "in_house")
    throw transitionError(stay.status, "in_house", "Chỉ ghi phí cho lượt ở đang ở (in_house)");
  const today = await businessDateAt(ctx, stay.property_id, now);
  const date = input.businessDate ?? today;
  if (input.businessDate !== undefined) assertDate(date, "business_date");
  if (date > today) throw fieldError("business_date", "FUTURE", "Không ghi phí cho ngày chưa tới");
  if (date < stay.arrival_date)
    throw fieldError("business_date", "BEFORE_ARRIVAL", "Ngày ghi phí trước ngày đến của lượt ở");
  const through = await lockedThrough(ctx, stay.property_id);
  if (through !== null && date <= through) throw periodLocked(through, date);

  const chargeId = randomUUID();
  await sql`
    insert into charges (id, organization_id, property_id, source_type, stay_id, kind, revenue_account, description, business_date,
                         quantity, unit_price, amount, created_by, command_id)
    values (${chargeId}, ${ctx.actor.orgId}, ${stay.property_id}, 'stay', ${stay.id}, ${input.kind}, ${REVENUE_OF[input.kind]},
            ${description}, ${date}::date, ${quantity}, ${input.unitPrice}, ${amount}, ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(
    ctx.trx,
  );
  await ctx.audit({
    action: "stay.charge_posted",
    entityType: "charge",
    entityId: chargeId,
    propertyId: stay.property_id,
    after: {
      stay_id: stay.id,
      kind: input.kind,
      business_date: date,
      quantity,
      unit_price: input.unitPrice,
      amount,
    },
  });
  return {
    charge_id: chargeId,
    stay_id: stay.id,
    kind: input.kind,
    revenue_account: REVENUE_OF[input.kind],
    business_date: date,
    quantity,
    unit_price: input.unitPrice,
    amount,
  };
}

// ---------- stay.voidCharge ----------

/**
 * `stay.voidCharge` (S-018, S-022, S-023): huỷ khoản dịch vụ/phụ thu CHƯA lên phiếu, có lý do. Đã lên phiếu folio ⇒ `409
 * DOCUMENT_IMMUTABLE`; ngày thuộc kỳ đã khoá ⇒ `409 PERIOD_LOCKED`. Tiền phòng từng đêm không huỷ ở đây.
 */
export async function voidCharge(
  ctx: CommandContext,
  input: { chargeId: string; reason: string },
): Promise<{ charge_id: string; voided: true }> {
  if (!UUID.test(input.chargeId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy khoản phí");
  const r = await sql<{
    id: string;
    stay_id: string | null;
    property_id: string;
    kind: string;
    source_type: string;
    business_date: string;
    voided_at: Date | null;
    invoiced: boolean;
  }>`
    select c.id, c.stay_id, c.property_id, c.kind, c.source_type, c.business_date::text as business_date, c.voided_at,
           exists (select 1 from invoice_lines il where il.organization_id = c.organization_id and il.charge_id = c.id) as invoiced
    from charges c where c.organization_id = ${ctx.actor.orgId} and c.id = ${input.chargeId}`.execute(
    ctx.trx,
  );
  const c = r.rows[0];
  if (c?.source_type !== "stay" || !c.stay_id)
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy khoản phí");
  authorize(ctx.actor, "folio.post_charge", { propertyId: c.property_id });
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 1000)
    throw fieldError("reason", "REQUIRED", "Cần lý do huỷ (≤ 1000 ký tự)");
  if (c.kind !== "service" && c.kind !== "fee")
    throw fieldError(
      "charge_id",
      "NOT_VOIDABLE",
      "Chỉ huỷ khoản dịch vụ/phụ thu; tiền phòng đổi qua đổi ngày/điều chỉnh",
    );
  // Khoá lượt ở (cùng thứ tự với check-out: lượt ở) rồi đọc lại trạng thái phiếu/huỷ dưới khoá.
  await readStay(ctx, c.stay_id, true);
  const again = await sql<{ voided_at: Date | null; invoiced: boolean }>`
    select c.voided_at, exists (select 1 from invoice_lines il where il.organization_id = c.organization_id and il.charge_id = c.id) as invoiced
    from charges c where c.organization_id = ${ctx.actor.orgId} and c.id = ${c.id}`.execute(ctx.trx);
  const now = again.rows[0] as { voided_at: Date | null; invoiced: boolean };
  if (now.invoiced)
    throw new CommandError(
      "DOCUMENT_IMMUTABLE",
      409,
      "Phiếu đã phát hành, không sửa trực tiếp. Hãy tạo điều chỉnh.",
    );
  if (now.voided_at) throw transitionError("voided", "voided", "Khoản phí đã được huỷ");
  const through = await lockedThrough(ctx, c.property_id);
  if (through !== null && c.business_date <= through) throw periodLocked(through, c.business_date);
  await sql`
    update charges set voided_at = now(), voided_by = ${ctx.actor.membershipId}, void_reason = ${reason}
    where organization_id = ${ctx.actor.orgId} and id = ${c.id} and voided_at is null`.execute(ctx.trx);
  await ctx.audit({
    action: "stay.charge_voided",
    entityType: "charge",
    entityId: c.id,
    propertyId: c.property_id,
    before: { voided: false },
    after: { voided: true, stay_id: c.stay_id },
    reason,
  });
  return { charge_id: c.id, voided: true };
}

// ---------- stay.checkOut ----------

export interface CheckOutPaymentInput {
  method: "cash" | "bank_transfer";
  amount: number;
  /** Chuyển khoản: tài khoản nhận + dòng sao kê/giao dịch ngân hàng làm chứng cứ (INV-F3, INV-F4b). */
  receivingAccountId?: string;
  bankTxn?: ManualBankTxn;
  bankTransactionId?: string;
}

export interface AllowBalanceInput {
  /**
   * Yêu cầu duyệt `allow_balance` (subject = lượt ở) đã được owner/manager duyệt; bỏ trống nếu chính người gọi có quyền cho nợ.
   * Có duyệt ⇒ `debtorPersonId` và `dueDate` PHẢI đúng hai giá trị người duyệt đã thấy (payload yêu cầu).
   */
  approvalId?: string;
  /** Người nợ: người đặt hoặc khách lưu trú của chính lượt ở này. */
  debtorPersonId: string;
  /** Hạn trả (YYYY-MM-DD, ≥ ngày kinh doanh check-out và ≤ ngày đó + `MAX_DEBT_TERM_DAYS`). */
  dueDate: string;
}

export interface DepositRefundInput {
  amount: number;
  method: "cash" | "bank_transfer";
  receivingAccountId?: string;
  reason?: string;
}

export interface CheckOutResult {
  stay_id: string;
  reservation_id: string;
  unit_id: string;
  status: "checked_out";
  checked_out_at: string;
  business_date: string;
  invoice_id: string | null;
  invoice_number: string | null;
  /** Tổng folio (Σ charges còn hiệu lực). */
  folio_total: number;
  /** Ứng trước đã phân bổ vào folio (CUSTOMER_CREDIT → AR). */
  advance_applied: number;
  /** Tiền thu thêm trong lệnh (đã xác nhận + phân bổ). */
  paid: number;
  /** Còn phải thu sau check-out (0 nếu đã thu đủ). */
  balance: number;
  debtor_person_id: string | null;
  due_date: string | null;
  payments: { payment_id: string; method: string; amount: number; receipt_no: string | null }[];
  deposit_refund_status: "done" | "pending_approval" | null;
  deposit_refund_approval_id: string | null;
}

function outstanding(balance: number, why?: string): CommandError {
  return new CommandError(
    "OUTSTANDING_BALANCE",
    409,
    why ?? "Khách còn nợ. Cần quản lý cho phép và hạn trả.",
    { extensions: { items: [{ balance }] } },
  );
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Người nợ phải có thật VÀ liên quan lượt ở (người đặt hoặc khách lưu trú chính/đi cùng của chính lượt ở — không cho gán nợ cho
 * nhân viên/người lạ); hạn trả trong [ngày kinh doanh check-out, + `MAX_DEBT_TERM_DAYS`].
 */
async function assertDebtor(
  ctx: CommandContext,
  a: { debtorPersonId: string; dueDate: string },
  today: string,
  stayId: string,
  bookerPersonId: string,
): Promise<void> {
  if (!UUID.test(a.debtorPersonId ?? ""))
    throw fieldError("allow_balance.debtor_person_id", "REQUIRED", "Cần người nợ (persons)");
  if (!a.dueDate) throw fieldError("allow_balance.due_date", "REQUIRED", "Cần hạn trả");
  assertDate(a.dueDate, "allow_balance.due_date");
  if (a.dueDate < today)
    throw fieldError("allow_balance.due_date", "PAST", "Hạn trả không được trước ngày check-out");
  if (a.dueDate > addDays(today, MAX_DEBT_TERM_DAYS))
    throw fieldError(
      "allow_balance.due_date",
      "TOO_FAR",
      `Hạn trả tối đa ${MAX_DEBT_TERM_DAYS} ngày kể từ ngày check-out (${addDays(today, MAX_DEBT_TERM_DAYS)})`,
    );
  const p = await sql<{ related: boolean }>`
    select (p.id = ${bookerPersonId}
            or exists (select 1 from stays s where s.organization_id = p.organization_id and s.id = ${stayId}
                         and (s.primary_guest_person_id = p.id or p.id = any(s.additional_guest_person_ids)))) as related
    from persons p
    where p.organization_id = ${ctx.actor.orgId} and p.id = ${a.debtorPersonId} and p.anonymized_at is null`.execute(
    ctx.trx,
  );
  if (!p.rows[0]) throw fieldError("allow_balance.debtor_person_id", "NOT_FOUND", "Không tìm thấy người nợ");
  if (!p.rows[0].related)
    throw fieldError(
      "allow_balance.debtor_person_id",
      "NOT_RELATED",
      "Người nợ phải là người đặt hoặc khách lưu trú của lượt ở này",
    );
}

/**
 * Được phép cho nợ khi: chính người gọi có quyền `stay.checkout_with_debt` (owner/manager), hoặc có yêu cầu duyệt `allow_balance` của
 * CHÍNH lượt ở này, đã được người khác có thẩm quyền duyệt (`executed`) cho số tiền ≥ số nợ VÀ đúng người nợ + hạn trả ghi trong yêu cầu
 * (payload: `debtor_person_id` — mặc định người đặt, `due_date` bắt buộc). Người gọi không đổi được hai giá trị đó sau khi đã được duyệt.
 * Lễ tân tự lập yêu cầu rồi xin duyệt (S-019).
 */
async function assertMayLeaveBalance(
  ctx: CommandContext,
  a: AllowBalanceInput,
  stay: StayHead,
  balance: number,
  bookerPersonId: string,
): Promise<{ via: "authority" | "approval"; approvalId: string | null }> {
  try {
    authorize(ctx.actor, "stay.checkout_with_debt", { propertyId: stay.property_id });
    return { via: "authority", approvalId: null };
  } catch (e) {
    if (!(e instanceof AuthzError) || e.code !== "FORBIDDEN") throw e;
  }
  if (!a.approvalId || !UUID.test(a.approvalId))
    throw outstanding(
      balance,
      "Khách còn nợ. Cần quản lý duyệt cho nợ (approval_id) kèm người nợ và hạn trả.",
    );
  const r = await sql<{
    kind: string;
    status: string;
    amount: string | null;
    subject_type: string | null;
    subject_id: string | null;
    property_id: string | null;
    payload: Record<string, unknown>;
  }>`
    select kind, status, amount::text, subject_type, subject_id, property_id, payload from approval_requests
    where organization_id = ${ctx.actor.orgId} and id = ${a.approvalId}`.execute(ctx.trx);
  const q = r.rows[0];
  const valid =
    q !== undefined &&
    q.kind === "allow_balance" &&
    q.status === "executed" &&
    q.subject_type === "stay" &&
    q.subject_id === stay.id &&
    q.property_id === stay.property_id &&
    q.amount !== null &&
    Number(q.amount) >= balance;
  if (!valid)
    throw outstanding(balance, "Duyệt cho nợ không hợp lệ, chưa được duyệt hoặc không đủ số tiền còn nợ.");
  const approvedDebtor =
    typeof q.payload.debtor_person_id === "string" ? q.payload.debtor_person_id : bookerPersonId;
  const approvedDue = typeof q.payload.due_date === "string" ? q.payload.due_date : null;
  if (approvedDue === null)
    throw outstanding(
      balance,
      "Yêu cầu duyệt cho nợ thiếu hạn trả — lập lại yêu cầu kèm người nợ và hạn trả.",
    );
  if (a.debtorPersonId.toLowerCase() !== approvedDebtor.toLowerCase() || a.dueDate !== approvedDue)
    throw outstanding(
      balance,
      "Người nợ/hạn trả không khớp với yêu cầu đã được duyệt (người nợ và hạn trả không đổi được sau khi duyệt).",
    );
  return { via: "approval", approvalId: a.approvalId };
}

/**
 * `stay.requestAllowBalance` (S-019, qua `approval.request` kind `allow_balance`): lễ tân xin quản lý cho khách nợ lúc check-out. Người
 * nợ (mặc định người đặt) và hạn trả được kiểm ngay lúc lập và LƯU trong payload để người duyệt thấy đúng thứ mình duyệt; check-out
 * bắt buộc khớp hai giá trị này. Lượt ở phải đang ở; số tiền nợ > 0.
 */
export async function requestAllowBalance(
  ctx: CommandContext,
  input: {
    stayId: string;
    amount: number;
    reason: string;
    dueDate: string;
    debtorPersonId?: string;
    now?: Date;
  },
): Promise<{ approvalRequestId: string }> {
  const stay = await readStay(ctx, input.stayId, false);
  authorize(ctx.actor, "reservation.manage", { propertyId: stay.property_id });
  assertAmount(input.amount, "amount", MAX_CHARGE_AMOUNT);
  if (stay.status !== "in_house")
    throw transitionError(stay.status, "checked_out", "Chỉ xin cho nợ khi lượt ở đang ở (in_house)");
  const booker = await sql<{ booker_person_id: string }>`
    select booker_person_id from reservations where organization_id = ${ctx.actor.orgId} and id = ${stay.reservation_id}`.execute(
    ctx.trx,
  );
  const bookerId = booker.rows[0]?.booker_person_id as string;
  const debtorPersonId = input.debtorPersonId ?? bookerId;
  const today = await businessDateAt(ctx, stay.property_id, input.now ?? new Date());
  await assertDebtor(ctx, { debtorPersonId, dueDate: input.dueDate }, today, stay.id, bookerId);
  return requestApproval(ctx, {
    kind: "allow_balance",
    amount: input.amount,
    reason: input.reason,
    propertyId: stay.property_id,
    subjectType: "stay",
    subjectId: stay.id,
    payload: { debtor_person_id: debtorPersonId, due_date: input.dueDate },
  });
}

/**
 * `stay.checkOut` (S-017…S-020, S-022…S-024, S-026, S-027): MỘT transaction —
 * 1. khoá booking rồi lượt ở: hai người trả phòng cùng lúc ⇒ một bên thắng, bên kia `409 INVALID_TRANSITION`;
 * 2. phát hành phiếu folio từ `charges` (Nợ AR / Có REV_*), phân bổ ứng trước của booking, ghi → xác nhận → phân bổ các khoản thu
 *    kèm theo (tiền mặt: người nhận tự xác nhận trong ca của CHÍNH mình; không có ca ⇒ 403 FORBIDDEN, không ghi gì);
 * 3. còn nợ ⇒ `409 OUTSTANDING_BALANCE` (rollback cả lệnh) trừ khi được cho nợ (người nợ + hạn trả, S-019);
 * 4. hoàn cọc theo hạn mức (xong hoặc lập yêu cầu duyệt; không bao giờ qua `REV_*`), lượt ở `checked_out` (giờ UTC), booking
 *    `checked_out` khi mọi lượt ở đã xong, allocation kết thúc đúng giờ trả (trả muộn không kéo dài hồi tố), phòng `dirty`;
 * 5. mở việc dọn (`openCleaningTask`, housekeeping S-001) cùng transaction rồi phát outbox `stay.checked_out`.
 */
export async function checkOut(
  ctx: CommandContext,
  input: {
    stayId: string;
    payments?: readonly CheckOutPaymentInput[];
    allowBalance?: AllowBalanceInput;
    depositRefund?: DepositRefundInput;
    now?: Date;
  },
): Promise<CheckOutResult> {
  const now = input.now ?? new Date();
  const orgId = ctx.actor.orgId;
  const inPayments = input.payments ?? [];
  if (inPayments.length > MAX_CHECKOUT_PAYMENTS)
    throw fieldError("payments", "COUNT", `Tối đa ${MAX_CHECKOUT_PAYMENTS} khoản thu mỗi lần trả phòng`);
  for (const [i, p] of inPayments.entries()) {
    assertAmount(p.amount, `payments[${i}].amount`, MAX_CHARGE_AMOUNT);
    if (p.method !== "cash" && p.method !== "bank_transfer")
      throw fieldError(`payments[${i}].method`, "INVALID", "Phương thức: cash hoặc bank_transfer");
    if (p.method === "cash" && (p.receivingAccountId || p.bankTxn || p.bankTransactionId))
      throw fieldError(
        `payments[${i}]`,
        "CASH_NO_BANK",
        "Tiền mặt không kèm tài khoản nhận/giao dịch ngân hàng",
      );
  }
  if (input.depositRefund) {
    assertAmount(input.depositRefund.amount, "deposit_refund.amount", MAX_CHARGE_AMOUNT);
    if (input.depositRefund.method === "bank_transfer" && !input.depositRefund.receivingAccountId)
      throw fieldError(
        "deposit_refund.receiving_account_id",
        "REQUIRED",
        "Hoàn chuyển khoản cần tài khoản chi",
      );
  }

  // 1) khoá booking → lượt ở (thứ tự thống nhất với checkIn).
  const head = await readStay(ctx, input.stayId, false);
  const res = await lockReservation(ctx, head.reservation_id);
  const items = await loadItems(ctx, res.id, true);
  const stays = await loadStays(
    ctx,
    items.map((i) => i.id),
    true,
  );
  const target = stays.find((s) => s.id === head.id);
  if (!target) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
  if (target.status !== "in_house")
    throw transitionError(target.status, "checked_out", "Lượt ở chưa nhận phòng hoặc đã trả phòng");
  stayMachine.assertTransition("in_house", "checked_out");
  const stay = await readStay(ctx, head.id, false);
  if (stay.checked_in_at && now.getTime() < new Date(stay.checked_in_at).getTime())
    throw fieldError("now", "BEFORE_CHECK_IN", "Giờ trả phòng không thể trước giờ nhận phòng");
  const today = await businessDateAt(ctx, stay.property_id, now);

  // 2) folio từ charges còn hiệu lực.
  const charges = (
    await sql<{
      id: string;
      kind: "room" | "service" | "fee" | "discount";
      revenue_account: "REV_ROOM" | "REV_SERVICE" | "REV_FEE" | "DISCOUNT";
      description: string;
      quantity: string;
      unit_price: string;
      amount: string;
      rounding_rule: string;
      formula_version: number;
    }>`
      select id, kind, revenue_account, description, quantity::text, unit_price::text, amount::text, rounding_rule, formula_version
      from charges where organization_id = ${orgId} and stay_id = ${stay.id} and voided_at is null
      order by business_date, (kind = 'room') desc, created_at, id`.execute(ctx.trx)
  ).rows;
  const total = charges.reduce((s, c) => s + Number(c.amount), 0);
  if (!Number.isSafeInteger(total) || total < 0)
    throw new CommandError("VALIDATION_FAILED", 422, "Tổng folio không hợp lệ");

  // Ứng trước của CHÍNH booking còn chưa phân bổ, không vượt số dư CUSTOMER_CREDIT thật của người đặt (đã có thể được hoàn): khoản thu
  // `payments.reservation_id` và ứng trước đầu kỳ của booking nhập (bút toán mang `reservation_id`, 0031) — không lấy credit chung theo người.
  const advances = (
    await sql<{ id: string; remaining: string }>`
      select id, (amount - allocated_total)::text as remaining from payments
      where organization_id = ${orgId} and reservation_id = ${res.id} and purpose = 'receivable' and status = 'confirmed'
        and amount > allocated_total
      order by created_at, id`.execute(ctx.trx)
  ).rows;
  const openingAdvances = await openingAdvancesOf(ctx.trx, orgId, res.id);
  let creditLeft =
    advances.length + openingAdvances.length > 0
      ? await customerCredit(ctx.trx, orgId, res.booker_person_id, stay.property_id)
      : 0;
  let toCover = total;
  const advancePlan: ({ amount: number } & ({ paymentId: string } | { openingEntryId: string }))[] = [];
  for (const a of advances) {
    const take = Math.min(Number(a.remaining), toCover, Math.max(creditLeft, 0));
    if (take <= 0) continue;
    advancePlan.push({ paymentId: a.id, amount: take });
    toCover -= take;
    creditLeft -= take;
  }
  for (const a of openingAdvances) {
    const take = Math.min(a.remaining, toCover, Math.max(creditLeft, 0));
    if (take <= 0) continue;
    advancePlan.push({ openingEntryId: a.entryId, amount: take });
    toCover -= take;
    creditLeft -= take;
  }
  const advanceApplied = total - toCover;
  const paidNow = inPayments.reduce((s, p) => s + p.amount, 0);
  if (paidNow > toCover)
    throw fieldError(
      "payments",
      "OVERPAYMENT",
      `Số tiền thu ${paidNow} vượt số còn phải thu ${toCover}; không ghi thu thừa lúc trả phòng`,
    );
  const balance = toCover - paidNow;

  // Tiền mặt chỉ nhận trong ca đang mở của CHÍNH người gọi (INV-F3b): không có ca ⇒ 403, chưa ghi gì.
  if (inPayments.some((p) => p.method === "cash")) {
    const shift = await openShiftOf(ctx.trx, orgId, ctx.actor.membershipId, stay.property_id);
    if (!shift)
      throw new CommandError("FORBIDDEN", 403, "Bạn cần ca đang mở của chính mình để nhận tiền mặt.");
  }

  // 3) còn nợ ⇒ cần cho phép + người nợ + hạn trả.
  let debtor: { personId: string; dueDate: string } | null = null;
  let leftVia: { via: "authority" | "approval"; approvalId: string | null } | null = null;
  if (balance > 0) {
    if (!input.allowBalance) throw outstanding(balance);
    await assertDebtor(ctx, input.allowBalance, today, stay.id, res.booker_person_id);
    leftVia = await assertMayLeaveBalance(ctx, input.allowBalance, stay, balance, res.booker_person_id);
    debtor = { personId: input.allowBalance.debtorPersonId, dueDate: input.allowBalance.dueDate };
  }
  if (input.depositRefund && balance > 0)
    throw fieldError(
      "deposit_refund",
      "OUTSTANDING_BALANCE",
      "Còn nợ folio: không hoàn cọc; dùng khấu trừ cọc (cần người duyệt khác người lập)",
    );

  // Phát hành phiếu (bất biến): dòng phiếu = đúng các charges; Nợ AR / Có REV_* (Nợ DISCOUNT cho giảm giá).
  let invoiceId: string | null = null;
  let invoiceNumber: string | null = null;
  if (charges.length > 0) {
    invoiceId = randomUUID();
    const n = await sql<{
      n: string;
    }>`select app.next_number(${orgId}, ${stay.property_id}, 'invoice')::text as n`.execute(ctx.trx);
    invoiceNumber = `FO-${String(n.rows[0]?.n).padStart(6, "0")}`;
    const payerId = debtor?.personId ?? res.booker_person_id;
    await sql`
      insert into invoices (id, organization_id, property_id, kind, stay_id, number, memo_ref, payer_person_id, business_date, due_on,
                            total, rounding_rule, formula_version, created_by, command_id)
      values (${invoiceId}, ${orgId}, ${stay.property_id}, 'folio', ${stay.id}, ${invoiceNumber},
              ${await uniqueMemoRef(ctx.trx, orgId)}, ${payerId}, ${today}::date, ${debtor?.dueDate ?? null}::date, ${total},
              'HALF_UP_1', 1, ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(ctx.trx);
    const credits: {
      account: "REV_ROOM" | "REV_SERVICE" | "REV_FEE" | "DISCOUNT";
      debit: number;
      credit: number;
      invoiceId: string;
      invoiceLineId: string;
    }[] = [];
    for (const [i, c] of charges.entries()) {
      const lineId = randomUUID();
      await sql`
        insert into invoice_lines (id, organization_id, property_id, invoice_id, line_no, charge_id, kind, description, revenue_account,
                                   quantity, unit_price, amount, rounding_rule, formula_version)
        values (${lineId}, ${orgId}, ${stay.property_id}, ${invoiceId}, ${i + 1}, ${c.id}, ${c.kind}, ${c.description},
                ${c.revenue_account}, ${c.quantity}, ${c.unit_price}, ${c.amount}, ${c.rounding_rule}, ${c.formula_version})`.execute(
        ctx.trx,
      );
      const amount = Number(c.amount);
      if (amount > 0)
        credits.push({
          account: c.revenue_account,
          debit: 0,
          credit: amount,
          invoiceId,
          invoiceLineId: lineId,
        });
      else if (amount < 0)
        credits.push({ account: "DISCOUNT", debit: -amount, credit: 0, invoiceId, invoiceLineId: lineId });
    }
    if (credits.length > 0) {
      await postEntry(ctx.trx, {
        orgId,
        propertyId: stay.property_id,
        entryType: "invoice_issued",
        businessDate: today,
        sourceDocType: "invoice",
        sourceDocId: invoiceId,
        createdBy: ctx.actor.membershipId,
        commandId: ctx.commandId,
        lines: [
          ...(total > 0
            ? [{ account: "AR" as const, debit: total, credit: 0, invoiceId, personId: payerId }]
            : []),
          ...credits,
        ],
      });
    }
  }

  // Phân bổ ứng trước (hệ thống, kiểm INV-F2) rồi các khoản thu trong lệnh.
  if (invoiceId) {
    for (const a of advancePlan) {
      if ("paymentId" in a)
        await allocatePayment(
          ctx,
          { paymentId: a.paymentId, allocations: [{ invoiceId, amount: a.amount }], at: now },
          { system: true },
        );
      else
        await allocateOpeningAdvance(ctx, {
          entryId: a.openingEntryId,
          invoiceId,
          amount: a.amount,
          bookerPersonId: res.booker_person_id,
          propertyId: stay.property_id,
          at: now,
        });
    }
  }
  const paid: CheckOutResult["payments"] = [];
  for (const p of inPayments) {
    if (!invoiceId) throw fieldError("payments", "NO_FOLIO", "Lượt ở không có khoản phải thu để thu tiền");
    const rec = await recordPayment(ctx, {
      propertyId: stay.property_id,
      method: p.method,
      amount: p.amount,
      payerPersonId: res.booker_person_id,
      at: now,
      ...(p.receivingAccountId ? { receivingAccountId: p.receivingAccountId } : {}),
      ...(p.bankTxn ? { bankTxn: p.bankTxn } : {}),
    });
    const conf = await confirmPayment(ctx, {
      paymentId: rec.paymentId,
      at: now,
      ...(p.bankTransactionId ? { evidence: { bankTransactionId: p.bankTransactionId } } : {}),
    });
    await allocatePayment(
      ctx,
      { paymentId: rec.paymentId, allocations: [{ invoiceId, amount: p.amount }], at: now },
      { system: true },
    );
    paid.push({ payment_id: rec.paymentId, method: p.method, amount: p.amount, receipt_no: conf.receiptNo });
  }
  if (invoiceId) {
    const chk = await sql<{ open: string }>`
      select open_amount::text as open from invoices where organization_id = ${orgId} and id = ${invoiceId}`.execute(
      ctx.trx,
    );
    if (Number(chk.rows[0]?.open) !== balance)
      throw new Error(`Folio ${invoiceId}: còn ${chk.rows[0]?.open}, dự kiến ${balance}`);
  }

  // 4) hoàn cọc (nguyên số trong hạn mức hoặc lập yêu cầu duyệt).
  let refundStatus: CheckOutResult["deposit_refund_status"] = null;
  let refundApprovalId: string | null = null;
  if (input.depositRefund) {
    const r = await refundDeposit(ctx, {
      reservationId: res.id,
      stayId: stay.id,
      propertyId: stay.property_id,
      refund: input.depositRefund,
      businessDate: today,
    });
    refundStatus = r.status;
    refundApprovalId = r.approvalId;
  }

  // Lượt ở / booking / allocation / phòng.
  await sql`
    update stays set status = 'checked_out', checked_out_at = ${now},
           debtor_person_id = ${debtor?.personId ?? null}, debt_due_date = ${debtor?.dueDate ?? null}::date
    where organization_id = ${orgId} and id = ${stay.id} and status = 'in_house'`.execute(ctx.trx);
  const others = stays.filter(
    (s) => s.id !== stay.id && (s.status === "expected" || s.status === "in_house"),
  );
  if (others.length === 0) {
    await sql`update reservations set status = 'checked_out'
              where organization_id = ${orgId} and id = ${res.id} and status = 'in_house'`.execute(ctx.trx);
  }
  const al = await sql<{ id: string; lo: Date; hi: Date | null }>`
    select id, lower(during) as lo, upper(during) as hi from allocations
    where organization_id = ${orgId} and source_type = 'stay' and source_id = ${stay.id} and active and kind = 'stay'
    for update`.execute(ctx.trx);
  const alloc = al.rows[0];
  if (alloc?.hi && now.getTime() < new Date(alloc.hi).getTime()) {
    if (now.getTime() > new Date(alloc.lo).getTime()) {
      // Trả sớm: nhả phòng ngay. Trả muộn thì giữ nguyên (không kéo dài hồi tố; giờ thực lưu ở lượt ở).
      await resizeAllocation(ctx, { allocationId: alloc.id, end: now, now });
    } else {
      await sql`update allocations set active = false, deactivated_at = ${now}, deactivated_reason = 'ended'
                where organization_id = ${orgId} and id = ${alloc.id}`.execute(ctx.trx);
    }
  }
  await sql`update units set housekeeping_status = 'dirty' where organization_id = ${orgId} and id = ${stay.unit_id}`.execute(
    ctx.trx,
  );
  // Cùng transaction: một việc dọn `open` cho phòng (SPEC-housekeeping S-001); phòng đã có việc dọn đang mở thì chỉ ghi thêm nguồn (S-002).
  await openCleaningTask(ctx.trx, {
    orgId,
    propertyId: stay.property_id,
    unitId: stay.unit_id,
    source: { type: "stay", id: stay.id },
    now,
  });

  await ctx.audit({
    action: "stay.checked_out",
    entityType: "stay",
    entityId: stay.id,
    propertyId: stay.property_id,
    before: { status: "in_house" },
    after: {
      status: "checked_out",
      reservation_id: res.id,
      checked_out_at: now.toISOString(),
      business_date: today,
      invoice_id: invoiceId,
      folio_total: total,
      advance_applied: advanceApplied,
      paid: paidNow,
      balance,
      allow_balance: leftVia
        ? {
            via: leftVia.via,
            approval_id: leftVia.approvalId,
            debtor_person_id: debtor?.personId,
            due_date: debtor?.dueDate,
          }
        : null,
      deposit_refund_status: refundStatus,
    },
  });
  await ctx.emit({
    eventType: "stay.checked_out",
    aggregateType: "stay",
    aggregateId: stay.id,
    propertyId: stay.property_id,
    payload: {
      stay_id: stay.id,
      reservation_id: res.id,
      unit_id: stay.unit_id,
      invoice_id: invoiceId,
      checked_out_at: now.toISOString(),
      business_date: today,
      balance,
    },
  });
  return {
    stay_id: stay.id,
    reservation_id: res.id,
    unit_id: stay.unit_id,
    status: "checked_out",
    checked_out_at: now.toISOString(),
    business_date: today,
    invoice_id: invoiceId,
    invoice_number: invoiceNumber,
    folio_total: total,
    advance_applied: advanceApplied,
    paid: paidNow,
    balance,
    debtor_person_id: debtor?.personId ?? null,
    due_date: debtor?.dueDate ?? null,
    payments: paid,
    deposit_refund_status: refundStatus,
    deposit_refund_approval_id: refundApprovalId,
  };
}

/**
 * Hoàn cọc lúc check-out (S-027): nguyên số trong hạn mức `deposit.refund` của người thao tác (lễ tân ≤ 2.000.000 đ, CHỈ khi check-out
 * và phải hoàn nguyên số còn giữ) ⇒ ghi sổ ngay (`done`); vượt hạn mức ⇒ yêu cầu duyệt `pending` (cọc giữ nguyên ở DEPOSIT_LIAB).
 */
async function refundDeposit(
  ctx: CommandContext,
  p: {
    reservationId: string;
    stayId: string;
    propertyId: string;
    refund: DepositRefundInput;
    businessDate: string;
  },
): Promise<{ status: "done" | "pending_approval"; approvalId: string | null }> {
  const orgId = ctx.actor.orgId;
  const pending = await sql<{ n: number }>`
    select count(*)::int as n from stays s
    join reservation_items i on i.organization_id = s.organization_id and i.id = s.reservation_item_id
    where s.organization_id = ${orgId} and i.reservation_id = ${p.reservationId} and s.id <> ${p.stayId}
      and s.status in ('expected', 'in_house')`.execute(ctx.trx);
  if ((pending.rows[0]?.n ?? 0) > 0)
    throw fieldError(
      "deposit_refund",
      "OTHER_STAYS_OPEN",
      "Booking còn phòng chưa trả — hoàn cọc ở lần trả phòng cuối cùng",
    );
  const d = await sql<{ id: string; balance: string }>`
    select id, balance::text from deposits where organization_id = ${orgId} and reservation_id = ${p.reservationId}`.execute(
    ctx.trx,
  );
  const dep = d.rows[0];
  if (!dep) throw fieldError("deposit_refund", "NO_DEPOSIT", "Booking không có cọc bảo đảm");
  const balance = Number(dep.balance);
  if (p.refund.amount > balance)
    throw new CommandError(
      "REFUND_EXCEEDS_BALANCE",
      409,
      `Hoàn ${p.refund.amount} vượt số cọc còn giữ ${balance}`,
    );
  const method =
    p.refund.method === "cash"
      ? ({ method: "cash" } as const)
      : ({ method: "bank_transfer", receivingAccountId: p.refund.receivingAccountId as string } as const);
  try {
    authorize(ctx.actor, "deposit.refund", {
      propertyId: p.propertyId,
      amount: p.refund.amount,
      atCheckout: true,
    });
  } catch (e) {
    if (e instanceof AuthzError && e.code === "APPROVAL_LIMIT_EXCEEDED") {
      const req = await requestDepositRefund(ctx, {
        depositId: dep.id,
        amount: p.refund.amount,
        reason: p.refund.reason?.trim() || "Hoàn cọc khi trả phòng",
        refund: method,
      });
      return { status: "pending_approval", approvalId: req.approvalRequestId };
    }
    throw e;
  }
  // Lễ tân: hoàn nguyên số cọc còn giữ một bước (Q-14); hoàn một phần cần quản lý.
  if (ctx.actor.role === "front_desk" && p.refund.amount !== balance)
    throw new CommandError(
      "FORBIDDEN",
      403,
      "Lễ tân chỉ hoàn nguyên số cọc còn giữ. Hoàn một phần cần quản lý.",
    );
  await refundDepositInline(ctx, {
    depositId: dep.id,
    amount: p.refund.amount,
    refund: method,
    businessDate: p.businessDate,
  });
  return { status: "done", approvalId: null };
}

// ---------- duyệt cho nợ ----------

let registered = false;

/**
 * Duyệt `allow_balance` (SPEC S-019): bản thân việc duyệt không ghi sổ — chỉ xác nhận lượt ở còn đang ở; hiệu lực được TIÊU THỤ khi
 * `stay.checkOut` kiểm yêu cầu (đúng lượt ở, đã `executed`, số tiền ≥ số nợ, đúng người nợ + hạn trả trong payload). Lễ tân lập yêu cầu (`reservation.manage`), quản lý/owner duyệt
 * (`stay.checkout_with_debt`), người lập không tự duyệt (INV-F5).
 */
export function registerFolioExecutors(): void {
  if (registered) return;
  registered = true;
  registerApprovalExecutor("allow_balance", {
    async execute(ctx, req) {
      if (
        req.subjectType !== "stay" ||
        !req.subjectId ||
        !UUID.test(req.subjectId) ||
        req.amount === null ||
        req.amount <= 0
      )
        throw fieldError("subject_id", "INVALID", "Yêu cầu cho nợ cần lượt ở và số tiền nợ > 0");
      // Người duyệt phải thấy hạn trả (và người nợ nếu khác người đặt) trong yêu cầu: không duyệt "chay" (check-out sẽ đòi khớp).
      const due = req.payload.due_date;
      if (typeof due !== "string")
        throw fieldError("payload.due_date", "REQUIRED", "Yêu cầu cho nợ cần hạn trả");
      assertDate(due, "payload.due_date");
      const who = req.payload.debtor_person_id;
      if (who !== undefined && (typeof who !== "string" || !UUID.test(who)))
        throw fieldError("payload.debtor_person_id", "INVALID", "Người nợ không hợp lệ");
      const s = await sql<{ status: string }>`
        select status from stays where organization_id = ${ctx.actor.orgId} and id = ${req.subjectId} for share`.execute(
        ctx.trx,
      );
      const st = s.rows[0]?.status;
      if (!st) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
      if (st !== "in_house") throw transitionError(st, "checked_out", "Chỉ cho nợ khi lượt ở đang ở");
      return { stay_id: req.subjectId, amount: req.amount };
    },
  });
}
registerFolioExecutors();

// ---------- stay.getFolio (query) ----------

export interface FolioView {
  stay_id: string;
  stay_status: string;
  reservation_id: string;
  charges: {
    id: string;
    kind: string;
    description: string;
    business_date: string;
    quantity: number;
    unit_price: number;
    amount: number;
    voided: boolean;
  }[];
  /** Σ charges còn hiệu lực. */
  charges_total: number;
  invoice: {
    id: string;
    number: string;
    total: number;
    allocated_total: number;
    open_amount: number;
    due_on: string | null;
  } | null;
  /** `opening_advance_entry_id`: phân bổ từ ứng trước đầu kỳ của booking nhập (không có khoản thu `payments`). */
  allocations: {
    payment_id: string | null;
    deposit_id: string | null;
    opening_advance_entry_id: string | null;
    amount: number;
  }[];
  /** Ứng trước của booking chưa phân bổ (CUSTOMER_CREDIT): khoản thu ứng trước + ứng trước đầu kỳ của booking nhập. */
  advance_available: number;
  /** Còn phải thu: phiếu đã phát hành → `open_amount`; chưa → ước tính (charges − ứng trước dùng được). */
  balance: number;
  /** Cọc bảo đảm — luôn tách riêng, không trừ vào `balance` (INV-F5). */
  deposits: {
    id: string;
    amount: number;
    deducted_total: number;
    refunded_total: number;
    balance: number;
  }[];
}

/** `stay.getFolio` (S-025): RLS quyết ai đọc được (buồng phòng/tổ chức khác ⇒ 404); cần quyền xem tiền (`money.read`). */
export async function getFolio(db: Kysely<unknown>, actor: Actor, stayId: string): Promise<FolioView> {
  if (!UUID.test(stayId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const s = await sql<{ id: string; status: string; property_id: string; reservation_id: string }>`
      select s.id, s.status, s.property_id, i.reservation_id
      from stays s join reservation_items i on i.organization_id = s.organization_id and i.id = s.reservation_item_id
      where s.organization_id = ${actor.orgId} and s.id = ${stayId}`.execute(trx);
    const st = s.rows[0];
    if (!st) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
    authorize(actor, "money.read", { propertyId: st.property_id });
    const ch = await sql<{
      id: string;
      kind: string;
      description: string;
      business_date: string;
      quantity: string;
      unit_price: string;
      amount: string;
      voided_at: Date | null;
    }>`
      select id, kind, description, business_date::text, quantity::text, unit_price::text, amount::text, voided_at from charges
      where organization_id = ${actor.orgId} and stay_id = ${stayId}
      order by business_date, (kind = 'room') desc, created_at, id`.execute(trx);
    const inv = await sql<{
      id: string;
      number: string;
      total: string;
      allocated_total: string;
      open_amount: string;
      due_on: string | null;
    }>`
      select id, number, total::text, allocated_total::text, open_amount::text, due_on::text from invoices
      where organization_id = ${actor.orgId} and stay_id = ${stayId} and kind = 'folio'`.execute(trx);
    const invoice = inv.rows[0] ?? null;
    const allocs = invoice
      ? (
          await sql<{
            payment_id: string | null;
            deposit_id: string | null;
            opening_advance_entry_id: string | null;
            amount: string;
          }>`
            select payment_id, deposit_id, opening_advance_entry_id, amount::text from payment_allocations
            where organization_id = ${actor.orgId} and invoice_id = ${invoice.id} and reversed_at is null
            order by created_at, id`.execute(trx)
        ).rows
      : [];
    const adv = await sql<{ v: string }>`
      select coalesce(sum(amount - allocated_total), 0)::text as v from payments
      where organization_id = ${actor.orgId} and reservation_id = ${st.reservation_id} and purpose = 'receivable'
        and status = 'confirmed'`.execute(trx);
    const openingRemaining = (await openingAdvancesOf(trx, actor.orgId, st.reservation_id)).reduce(
      (n, a) => n + a.remaining,
      0,
    );
    const dep = await sql<{
      id: string;
      amount: string;
      deducted_total: string;
      refunded_total: string;
      balance: string;
    }>`
      select id, amount::text, deducted_total::text, refunded_total::text, balance::text from deposits
      where organization_id = ${actor.orgId} and reservation_id = ${st.reservation_id}`.execute(trx);
    const chargesTotal = ch.rows.filter((c) => !c.voided_at).reduce((n, c) => n + Number(c.amount), 0);
    const advanceAvailable = Number(adv.rows[0]?.v ?? 0) + openingRemaining;
    return {
      stay_id: st.id,
      stay_status: st.status,
      reservation_id: st.reservation_id,
      charges: ch.rows.map((c) => ({
        id: c.id,
        kind: c.kind,
        description: c.description,
        business_date: c.business_date,
        quantity: Number(c.quantity),
        unit_price: Number(c.unit_price),
        amount: Number(c.amount),
        voided: c.voided_at !== null,
      })),
      charges_total: chargesTotal,
      invoice: invoice
        ? {
            id: invoice.id,
            number: invoice.number,
            total: Number(invoice.total),
            allocated_total: Number(invoice.allocated_total),
            open_amount: Number(invoice.open_amount),
            due_on: invoice.due_on,
          }
        : null,
      allocations: allocs.map((a) => ({
        payment_id: a.payment_id,
        deposit_id: a.deposit_id,
        opening_advance_entry_id: a.opening_advance_entry_id,
        amount: Number(a.amount),
      })),
      advance_available: advanceAvailable,
      balance: invoice ? Number(invoice.open_amount) : Math.max(chargesTotal - advanceAvailable, 0),
      deposits: dep.rows.map((d) => ({
        id: d.id,
        amount: Number(d.amount),
        deducted_total: Number(d.deducted_total),
        refunded_total: Number(d.refunded_total),
        balance: Number(d.balance),
      })),
    };
  });
}
