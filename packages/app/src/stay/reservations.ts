// Booking khách sạn (SPEC-reservation-stay S-003…S-011, S-025; DOMAIN-MODEL §4). Mọi chuyển trạng thái khoá hàng booking
// (FOR UPDATE) rồi kiểm bảng chuyển (`bookingMachine`); CSDL có trigger chuyển trạng thái làm hàng rào cuối. Phòng do
// allocation giữ (EXCLUDE — INV-I1); hold → stay đổi trong một UPDATE (không khe hở). Ứng trước vào CUSTOMER_CREDIT, cọc vào
// DEPOSIT_LIAB — không bao giờ thành doanh thu khi huỷ/no-show (INV-F5).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import {
  authorize,
  bookingMachine,
  generateMemoRef,
  grantFor,
  isMatrixRole,
  type NightPrice,
  nightsOf,
  repriceForDates,
} from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import { approvalRequired, registerApprovalExecutor } from "../approvals/approvals.ts";
import { receiveDeposit } from "../deposits/deposits.ts";
import { confirmHold, createHold, type Interval } from "../inventory/inventory.ts";
import { postEntry } from "../ledger/ledger.ts";
import { confirmPayment, type ManualBankTxn, recordPayment } from "../payments/payments.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";
import { loadRates, quoteIn, quoteProblem, staySettings } from "./rates.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BookingStatus = (typeof bookingMachine.states)[number];

export interface BookerInput {
  personId?: string;
  fullName?: string;
  phone?: string;
  email?: string;
}

function fieldError(path: string, code: string, message: string): CommandError {
  return new CommandError("VALIDATION_FAILED", 422, message, {
    extensions: { errors: [{ path, field: path, code }] },
  });
}

/** Người đặt: dùng người có sẵn trong tổ chức, hoặc tạo hồ sơ tối thiểu (họ tên + SĐT bắt buộc). */
export async function resolveBooker(ctx: CommandContext, b: BookerInput, path = "booker"): Promise<string> {
  if (b.personId) {
    if (!UUID.test(b.personId)) throw fieldError(`${path}.person_id`, "invalid", "Người đặt không hợp lệ");
    const r = await sql<{ id: string }>`
      select id from persons where organization_id = ${ctx.actor.orgId} and id = ${b.personId} and anonymized_at is null`.execute(
      ctx.trx,
    );
    if (!r.rows[0]) throw fieldError(`${path}.person_id`, "not_found", "Không tìm thấy người đặt");
    return b.personId;
  }
  const fullName = b.fullName?.trim() ?? "";
  if (fullName.length < 1 || fullName.length > 200)
    throw fieldError(`${path}.full_name`, "required", "Họ tên 1–200 ký tự");
  const phone = b.phone?.trim() ?? "";
  if (!/^\+?[0-9 .()-]{6,20}$/.test(phone))
    throw fieldError(`${path}.phone`, "invalid", "Số điện thoại không hợp lệ");
  const email = b.email?.trim().toLowerCase() || null;
  if (email !== null && !/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email))
    throw fieldError(`${path}.email`, "invalid", "Email không hợp lệ");
  const id = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, phone, email)
            values (${id}, ${ctx.actor.orgId}, ${fullName}, ${phone}, ${email})`.execute(ctx.trx);
  await ctx.audit({ action: "person.created", entityType: "person", entityId: id });
  return id;
}

export interface ReservationRow {
  id: string;
  property_id: string;
  number: string;
  status: BookingStatus;
  source: "direct" | "walk_in";
  booker_person_id: string;
  item_id: string;
  unit_id: string;
  room_type_id: string;
  arrival_date: string;
  departure_date: string;
  guests: number;
  nightly_prices: NightPrice[];
  room_total: string;
  allocation_id: string | null;
  stay_id: string | null;
  stay_status: string | null;
}

/** Đọc booking + dòng phòng + lượt ở; `lock` khoá hàng booking (mọi chuyển trạng thái đi qua đây). */
export async function readReservation(
  trx: Transaction<unknown>,
  actor: Actor,
  reservationId: string,
  lock: boolean,
): Promise<ReservationRow> {
  if (!UUID.test(reservationId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy đặt phòng");
  if (lock) {
    await sql`select 1 from reservations where organization_id = ${actor.orgId} and id = ${reservationId} for update`.execute(
      trx,
    );
  }
  const r = await sql<ReservationRow>`
    select r.id, r.property_id, r.number, r.status, r.source, r.booker_person_id, i.id as item_id, i.unit_id, i.room_type_id,
           i.arrival_date::text, i.departure_date::text, i.guests, i.nightly_prices, i.room_total::text, i.allocation_id,
           s.id as stay_id, s.status as stay_status
    from reservations r
    join reservation_items i on i.organization_id = r.organization_id and i.reservation_id = r.id
    left join stays s on s.organization_id = i.organization_id and s.reservation_item_id = i.id
    where r.organization_id = ${actor.orgId} and r.id = ${reservationId}`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy đặt phòng");
  // Ngoài phạm vi cơ sở → 404 (không lộ việc tồn tại); vai trò không có quyền đặt phòng → 403.
  if (!actor.allProperties && !actor.propertyIds.includes(row.property_id))
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy đặt phòng");
  return row;
}

/** Khoảng allocation UTC của một booking: giờ nhận ngày đến → giờ trả ngày đi, theo múi giờ cơ sở (S-003). */
export async function stayInterval(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
  arrivalDate: string,
  departureDate: string,
): Promise<Interval> {
  const s = await staySettings(trx, orgId, propertyId);
  const r = await sql<{ s: Date; e: Date }>`
    select ((${arrivalDate}::date + ${s.checkInTime}::time)::timestamp at time zone ${s.timezone}) as s,
           ((${departureDate}::date + ${s.checkOutTime}::time)::timestamp at time zone ${s.timezone}) as e`.execute(
    trx,
  );
  const row = r.rows[0] as { s: Date; e: Date };
  return { start: row.s, end: row.e };
}

function transition(from: BookingStatus, to: BookingStatus): void {
  bookingMachine.assertTransition(from, to);
}

export interface CreateReservationInput {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  guests: number;
  source: "direct";
  booker: BookerInput;
}

/** `reservation.create` (S-003): booking `draft` + dòng phòng có snapshot giá từng đêm và chính sách đang áp dụng. */
export async function createReservation(
  ctx: CommandContext,
  input: CreateReservationInput,
): Promise<{ reservationId: string; number: string; roomTotal: number; nightlyPrices: NightPrice[] }> {
  const q = await quoteIn(ctx.trx, ctx.actor, {
    unitId: input.unitId,
    arrivalDate: input.arrivalDate,
    departureDate: input.departureDate,
    guests: input.guests,
  });
  const booker = await resolveBooker(ctx, input.booker);
  const id = randomUUID();
  const n = await sql<{
    n: string;
  }>`select app.next_number(${ctx.actor.orgId}, ${q.propertyId}, 'reservation')::text as n`.execute(ctx.trx);
  const number = `R-${n.rows[0]?.n}`;
  await sql`
    insert into reservations (id, organization_id, property_id, number, status, source, booker_person_id, policy_snapshot,
                              created_by, command_id)
    values (${id}, ${ctx.actor.orgId}, ${q.propertyId}, ${number}, 'draft', ${input.source}, ${booker},
            ${JSON.stringify(q.policy)}::jsonb, ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(
    ctx.trx,
  );
  await sql`
    insert into reservation_items (id, organization_id, property_id, reservation_id, unit_id, room_type_id, arrival_date,
                                   departure_date, guests, nightly_prices, room_total)
    values (${randomUUID()}, ${ctx.actor.orgId}, ${q.propertyId}, ${id}, ${input.unitId}, ${q.roomTypeId}, ${input.arrivalDate}::date,
            ${input.departureDate}::date, ${input.guests}, ${JSON.stringify(q.nightlyPrices)}::jsonb, ${q.roomTotal})`.execute(
    ctx.trx,
  );
  await ctx.audit({
    action: "reservation.created",
    entityType: "reservation",
    entityId: id,
    propertyId: q.propertyId,
    after: { number, status: "draft", room_total: q.roomTotal, nights: q.nights },
  });
  return { reservationId: id, number, roomTotal: q.roomTotal, nightlyPrices: q.nightlyPrices };
}

/** Phòng cùng loại còn trống trong khoảng (gợi ý khi ROOM_UNAVAILABLE — S-004). */
async function suggestions(
  trx: Transaction<unknown>,
  orgId: string,
  row: ReservationRow,
  during: Interval,
  now: Date,
) {
  const r = await sql<{ unit_id: string; code: string }>`
    select u.id as unit_id, u.code from units u
    where u.organization_id = ${orgId} and u.property_id = ${row.property_id} and u.room_type_id = ${row.room_type_id}
      and u.id <> ${row.unit_id} and u.archived_at is null and u.availability = 'active'
      and not exists (select 1 from allocations a where a.organization_id = u.organization_id and a.unit_id = u.id and a.active
                        and (a.kind <> 'hold' or a.expires_at > ${now})
                        and a.during && tstzrange(${during.start}, ${during.end}, '[)'))
    order by u.code limit 5`.execute(trx);
  return r.rows;
}

/** `reservation.hold` (S-003, S-004): draft → held, allocation `hold` có hạn; phòng bận → ROOM_UNAVAILABLE kèm gợi ý. */
export async function holdReservation(
  ctx: CommandContext,
  input: { reservationId: string; now?: Date },
): Promise<{ allocationId: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const row = await readReservation(ctx.trx, ctx.actor, input.reservationId, true);
  authorize(ctx.actor, "reservation.manage", { propertyId: row.property_id });
  transition(row.status, "held");
  const s = await staySettings(ctx.trx, ctx.actor.orgId, row.property_id);
  const during = await stayInterval(
    ctx.trx,
    ctx.actor.orgId,
    row.property_id,
    row.arrival_date,
    row.departure_date,
  );
  let hold: { allocationId: string; expiresAt: Date };
  try {
    hold = await createHold(ctx, {
      unitId: row.unit_id,
      during,
      ttlMinutes: s.holdTtlMinutes,
      sourceType: "reservation_item",
      sourceId: row.item_id,
      now,
    });
  } catch (e) {
    if (e instanceof CommandError && e.code === "ROOM_UNAVAILABLE") {
      const items = await suggestions(ctx.trx, ctx.actor.orgId, row, during, now);
      throw new CommandError(
        "ROOM_UNAVAILABLE",
        409,
        "Phòng đã có người giữ trong thời gian này. Xem phòng gợi ý.",
        {
          extensions: { items },
        },
      );
    }
    throw e;
  }
  await sql`update reservation_items set allocation_id = ${hold.allocationId}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${row.item_id}`.execute(ctx.trx);
  await sql`update reservations set status = 'held', held_until = ${hold.expiresAt}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${row.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "reservation.held",
    entityType: "reservation",
    entityId: row.id,
    propertyId: row.property_id,
    before: { status: row.status },
    after: { status: "held", expires_at: hold.expiresAt.toISOString() },
  });
  await ctx.emit({
    eventType: "reservation.held",
    aggregateType: "reservation",
    aggregateId: row.id,
    propertyId: row.property_id,
    payload: { reservation_id: row.id },
  });
  return hold;
}

export interface BookingPaymentInput {
  amount: number;
  method: "cash" | "bank_transfer";
  /** `advance` = ứng trước (CUSTOMER_CREDIT, trừ vào folio khi check-out); `security_deposit` = cọc bảo đảm (DEPOSIT_LIAB). */
  kind: "advance" | "security_deposit";
  receivingAccountId?: string;
  /** Chứng cứ chuyển khoản (dòng sao kê) — không có thì khoản thu `pending` (S-006, INV-F3). */
  bankTxn?: ManualBankTxn;
}

function canConfirm(actor: Actor, method: "cash" | "bank_transfer"): boolean {
  if (!isMatrixRole(actor.role)) return false;
  const g = grantFor(method === "cash" ? "payment.confirm_cash" : "payment.confirm_transfer", actor.role);
  return g !== "no";
}

/**
 * Ghi khoản tiền của booking: tiền mặt người nhận tự xác nhận trong ca mở của mình (INV-F3b); chuyển khoản chỉ xác nhận
 * khi có giao dịch ngân hàng làm chứng cứ VÀ người thao tác có quyền xác nhận — còn lại để `pending` cho người có quyền.
 */
export async function recordBookingPayment(
  ctx: CommandContext,
  row: Pick<ReservationRow, "id" | "property_id" | "booker_person_id">,
  p: BookingPaymentInput,
): Promise<{
  paymentId: string;
  status: "pending" | "confirmed";
  depositId: string | null;
  receiptNo: string | null;
}> {
  const common = {
    propertyId: row.property_id,
    method: p.method,
    amount: p.amount,
    payerPersonId: row.booker_person_id,
    ...(p.receivingAccountId ? { receivingAccountId: p.receivingAccountId } : {}),
    ...(p.bankTxn ? { bankTxn: p.bankTxn } : {}),
  };
  let paymentId: string;
  let depositId: string | null = null;
  if (p.kind === "security_deposit") {
    const d = await receiveDeposit(ctx, { ...common, reservationId: row.id });
    paymentId = d.paymentId;
    depositId = d.depositId;
  } else {
    paymentId = (await recordPayment(ctx, { ...common, reservationId: row.id })).paymentId;
  }
  const hasEvidence = p.method === "cash" || Boolean(p.bankTxn);
  if (!hasEvidence || !canConfirm(ctx.actor, p.method))
    return { paymentId, status: "pending", depositId, receiptNo: null };
  const c = await confirmPayment(ctx, { paymentId });
  return { paymentId, status: "confirmed", depositId, receiptNo: c.receiptNo };
}

/** Lỗi HOLD_EXPIRED kèm ghi `held → expired` đúng một lần ở transaction riêng (lệnh chính đã rollback — S-007). */
function holdExpired(ctx: CommandContext, row: ReservationRow): CommandError {
  const orgId = ctx.actor.orgId;
  return new CommandError("HOLD_EXPIRED", 409, "Thời gian giữ phòng đã hết. Vui lòng giữ lại.", {
    persist: async (trx) => {
      const r = await sql<{ id: string }>`
        update reservations set status = 'expired', version = version + 1
        where organization_id = ${orgId} and id = ${row.id} and status = 'held' returning id`.execute(trx);
      if (r.rows[0] && row.allocation_id) {
        await sql`update allocations set active = false, deactivated_at = now(), deactivated_reason = 'expired'
                  where organization_id = ${orgId} and id = ${row.allocation_id} and active and kind = 'hold'`.execute(
          trx,
        );
      }
      if (r.rows[0]) {
        // INV-I3: hết hạn giữ = một sự kiện có audit (như job worker), kể cả khi phát hiện lúc xác nhận/đổi ngày.
        await sql`insert into audit_events (id, organization_id, property_id, actor_type, actor_person_id, action, entity_type,
                                            entity_id, before, after, correlation_id)
                  values (${randomUUID()}, ${orgId}, ${row.property_id}, 'user', ${ctx.actor.personId}, 'reservation.expired',
                          'reservation', ${row.id}, '{"status":"held"}'::jsonb, '{"status":"expired"}'::jsonb,
                          ${ctx.correlationId})`.execute(trx);
      }
      return {};
    },
  });
}

/**
 * `reservation.confirm` (S-005…S-007): held → confirmed, tạo stay `expected`, allocation hold → stay cùng UPDATE (không khe
 * hở), kèm ứng trước/cọc nếu có. Hold hết hạn → HOLD_EXPIRED, booking `expired`, phòng nhả.
 */
export async function confirmReservation(
  ctx: CommandContext,
  input: { reservationId: string; payment?: BookingPaymentInput; now?: Date },
): Promise<{
  status: "confirmed";
  stayId: string;
  payment: {
    paymentId: string;
    status: "pending" | "confirmed";
    depositId: string | null;
    receiptNo: string | null;
  } | null;
}> {
  const now = input.now ?? new Date();
  const row = await readReservation(ctx.trx, ctx.actor, input.reservationId, true);
  authorize(ctx.actor, "reservation.manage", { propertyId: row.property_id });
  transition(row.status, "confirmed");
  if (!row.allocation_id) throw holdExpired(ctx, row);
  const a = await sql<{ active: boolean; expires_at: Date | null }>`
    select active, expires_at from allocations where organization_id = ${ctx.actor.orgId} and id = ${row.allocation_id} for update`.execute(
    ctx.trx,
  );
  const alloc = a.rows[0];
  if (!alloc?.active || (alloc.expires_at && alloc.expires_at.getTime() <= now.getTime()))
    throw holdExpired(ctx, row);
  const s = await staySettings(ctx.trx, ctx.actor.orgId, row.property_id);
  if (!input.payment && !s.confirmWithoutPayment)
    throw fieldError("payment", "required", "Cơ sở yêu cầu ứng trước/cọc khi xác nhận");
  await confirmHold(ctx, row.allocation_id, "stay", now);
  const stayId = randomUUID();
  await sql`
    insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id)
    values (${stayId}, ${ctx.actor.orgId}, ${row.property_id}, ${row.item_id}, ${row.unit_id}, 'expected', ${row.booker_person_id})`.execute(
    ctx.trx,
  );
  await sql`update allocations set source_type = 'stay', source_id = ${stayId}
            where organization_id = ${ctx.actor.orgId} and id = ${row.allocation_id}`.execute(ctx.trx);
  await sql`update reservations set status = 'confirmed', confirmed_at = ${now}, held_until = null, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${row.id}`.execute(ctx.trx);
  const payment = input.payment ? await recordBookingPayment(ctx, row, input.payment) : null;
  // Cơ sở bắt buộc tiền khi xác nhận (S-006): khoản "khách báo đã chuyển" chưa có chứng cứ không đủ — rollback, booking giữ `held`.
  if (!s.confirmWithoutPayment && payment?.status !== "confirmed")
    throw fieldError(
      "payment",
      "unconfirmed",
      "Cơ sở yêu cầu khoản thu đã xác nhận (tiền mặt hoặc chuyển khoản có chứng cứ) khi xác nhận booking",
    );
  await ctx.audit({
    action: "reservation.confirmed",
    entityType: "reservation",
    entityId: row.id,
    propertyId: row.property_id,
    before: { status: row.status },
    after: { status: "confirmed", stay_id: stayId, payment_status: payment?.status ?? null },
  });
  await ctx.emit({
    eventType: "reservation.confirmed",
    aggregateType: "reservation",
    aggregateId: row.id,
    propertyId: row.property_id,
    payload: { reservation_id: row.id, stay_id: stayId },
  });
  return { status: "confirmed", stayId, payment };
}

/** Nhả allocation của booking (hold hoặc stay chưa ở) tại thời điểm `at` với lý do. */
async function releaseAllocation(ctx: CommandContext, row: ReservationRow, at: Date): Promise<void> {
  if (!row.allocation_id) return;
  await sql`update allocations set active = false, deactivated_at = ${at}, deactivated_reason = 'cancelled'
            where organization_id = ${ctx.actor.orgId} and id = ${row.allocation_id} and active`.execute(
    ctx.trx,
  );
}

async function businessDateAt(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
  at: Date,
): Promise<string> {
  const r = await sql<{
    d: string;
  }>`select app.business_date(${orgId}, ${propertyId}, ${at})::text as d`.execute(trx);
  return r.rows[0]?.d as string;
}

/**
 * Phí huỷ (S-009): phiếu phí phát hành ngay (Nợ AR / Có REV_FEE) cho lượt ở đã xác nhận; trong hạn mức đổi giá của người
 * thao tác (vượt → APPROVAL_LIMIT_EXCEEDED). Ứng trước/cọc KHÔNG tự trừ — người có quyền quyết định sau (INV-F5).
 */
async function issueCancellationFee(
  ctx: CommandContext,
  row: ReservationRow,
  stayId: string,
  fee: number,
  reason: string,
  at: Date,
  approved: boolean,
): Promise<string> {
  if (!approved) {
    try {
      authorize(ctx.actor, "reservation.override_price", { propertyId: row.property_id, amount: fee });
    } catch (e) {
      if ((e as { code?: string }).code !== "APPROVAL_LIMIT_EXCEEDED") throw e;
      // Vượt hạn mức: lập yêu cầu duyệt `cancellation_fee`; người duyệt huỷ booking kèm đúng phí đó (executor).
      throw approvalRequired(
        ctx.actor,
        {
          kind: "cancellation_fee",
          amount: fee,
          reason,
          propertyId: row.property_id,
          subjectType: "reservation",
          subjectId: row.id,
        },
        "Phí huỷ vượt hạn mức — đã gửi yêu cầu duyệt",
      );
    }
  }
  const day = await businessDateAt(ctx.trx, ctx.actor.orgId, row.property_id, at);
  const chargeId = randomUUID();
  await sql`
    insert into charges (id, organization_id, property_id, source_type, stay_id, kind, revenue_account, description,
                         business_date, quantity, unit_price, amount, created_by, command_id)
    values (${chargeId}, ${ctx.actor.orgId}, ${row.property_id}, 'stay', ${stayId}, 'fee', 'REV_FEE',
            ${`Phí huỷ ${row.number}: ${reason}`.slice(0, 500)}, ${day}::date, 1, ${fee}, ${fee}, ${ctx.actor.membershipId},
            ${ctx.commandId})`.execute(ctx.trx);
  const invoiceId = randomUUID();
  const n = await sql<{
    n: string;
  }>`select app.next_number(${ctx.actor.orgId}, ${row.property_id}, 'invoice')::text as n`.execute(ctx.trx);
  await sql`
    insert into invoices (id, organization_id, property_id, kind, stay_id, number, memo_ref, payer_person_id, business_date,
                          total, created_by, command_id)
    values (${invoiceId}, ${ctx.actor.orgId}, ${row.property_id}, 'fee', ${stayId}, ${`PTT-${String(n.rows[0]?.n).padStart(6, "0")}`},
            ${generateMemoRef()}, ${row.booker_person_id}, ${day}::date, ${fee}, ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(
    ctx.trx,
  );
  const lineId = randomUUID();
  await sql`
    insert into invoice_lines (id, organization_id, property_id, invoice_id, charge_id, line_no, kind, description, revenue_account,
                               quantity, unit_price, amount, rounding_rule, formula_version)
    values (${lineId}, ${ctx.actor.orgId}, ${row.property_id}, ${invoiceId}, ${chargeId}, 1, 'fee', ${`Phí huỷ ${row.number}`},
            'REV_FEE', 1, ${fee}, ${fee}, 'HALF_UP_1', 1)`.execute(ctx.trx);
  await postEntry(ctx.trx, {
    orgId: ctx.actor.orgId,
    propertyId: row.property_id,
    entryType: "invoice_issued",
    businessDate: day,
    sourceDocType: "invoice",
    sourceDocId: invoiceId,
    createdBy: ctx.actor.membershipId,
    commandId: ctx.commandId,
    lines: [
      { account: "AR", debit: fee, credit: 0, invoiceId, personId: row.booker_person_id },
      { account: "REV_FEE", debit: 0, credit: fee, invoiceId, invoiceLineId: lineId },
    ],
  });
  return invoiceId;
}

/**
 * `reservation.cancel` (S-009, S-010): draft/held/confirmed → cancelled; stay `expected → cancelled`; phòng nhả tại lúc
 * commit; ứng trước/cọc giữ nguyên (không REV_*). Phí huỷ > 0 chỉ khi đã xác nhận.
 */
export async function cancelReservation(
  ctx: CommandContext,
  input: { reservationId: string; reason: string; cancellationFee?: number; now?: Date },
  opts: { approvedFee?: boolean } = {},
): Promise<{ status: "cancelled"; feeInvoiceId: string | null }> {
  const now = input.now ?? new Date();
  const row = await readReservation(ctx.trx, ctx.actor, input.reservationId, true);
  authorize(ctx.actor, "reservation.manage", { propertyId: row.property_id });
  transition(row.status, "cancelled");
  const reason = input.reason.trim();
  if (reason.length < 1) throw fieldError("reason", "required", "Cần lý do huỷ");
  const fee = input.cancellationFee ?? 0;
  if (!Number.isSafeInteger(fee) || fee < 0)
    throw fieldError("cancellation_fee", "invalid", "Phí huỷ là số nguyên ≥ 0");
  if (fee > 0 && !row.stay_id)
    throw fieldError("cancellation_fee", "not_confirmed", "Chỉ thu phí huỷ với booking đã xác nhận");
  await releaseAllocation(ctx, row, now);
  if (row.stay_id) {
    await sql`update stays set status = 'cancelled', version = version + 1
              where organization_id = ${ctx.actor.orgId} and id = ${row.stay_id}`.execute(ctx.trx);
  }
  await sql`update reservations set status = 'cancelled', cancel_reason = ${reason}, cancelled_at = ${now}, held_until = null,
                   version = version + 1 where organization_id = ${ctx.actor.orgId} and id = ${row.id}`.execute(
    ctx.trx,
  );
  const feeInvoiceId =
    fee > 0
      ? await issueCancellationFee(
          ctx,
          row,
          row.stay_id as string,
          fee,
          reason,
          now,
          opts.approvedFee === true,
        )
      : null;
  await ctx.audit({
    action: "reservation.cancelled",
    entityType: "reservation",
    entityId: row.id,
    propertyId: row.property_id,
    before: { status: row.status },
    after: { status: "cancelled", cancellation_fee: fee },
    reason,
  });
  await ctx.emit({
    eventType: "reservation.cancelled",
    aggregateType: "reservation",
    aggregateId: row.id,
    propertyId: row.property_id,
    payload: { reservation_id: row.id },
  });
  return { status: "cancelled", feeInvoiceId };
}

/**
 * `reservation.markNoShow` (S-011, Q-07): chỉ sau giờ chốt ngày của ngày đến (ngày kinh doanh hiện tại > ngày đến); booking
 * và stay `no_show` cùng transaction; phòng nhả; tiền giữ nguyên chờ quyết định có duyệt.
 */
export async function markNoShow(
  ctx: CommandContext,
  input: { reservationId: string; reason: string; now?: Date },
): Promise<{ status: "no_show" }> {
  const now = input.now ?? new Date();
  const row = await readReservation(ctx.trx, ctx.actor, input.reservationId, true);
  authorize(ctx.actor, "reservation.manage", { propertyId: row.property_id });
  transition(row.status, "no_show");
  const reason = input.reason.trim();
  if (reason.length < 1) throw fieldError("reason", "required", "Cần lý do");
  const today = await businessDateAt(ctx.trx, ctx.actor.orgId, row.property_id, now);
  if (today <= row.arrival_date) {
    throw new CommandError("INVALID_TRANSITION", 409, "Chỉ đánh dấu không đến sau giờ chốt của ngày đến", {
      extensions: { from: row.status, to: "no_show" },
    });
  }
  await releaseAllocation(ctx, row, now);
  await sql`update stays set status = 'no_show', version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${row.stay_id}`.execute(ctx.trx);
  await sql`update reservations set status = 'no_show', cancel_reason = ${reason}, cancelled_at = ${now}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${row.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "reservation.no_show",
    entityType: "reservation",
    entityId: row.id,
    propertyId: row.property_id,
    before: { status: row.status },
    after: { status: "no_show" },
    reason,
  });
  await ctx.emit({
    eventType: "reservation.no_show",
    aggregateType: "reservation",
    aggregateId: row.id,
    propertyId: row.property_id,
    payload: { reservation_id: row.id },
  });
  return { status: "no_show" };
}

export interface ReservationView {
  id: string;
  number: string;
  propertyId: string;
  status: BookingStatus;
  source: string;
  bookerPersonId: string;
  unitId: string;
  roomTypeId: string;
  arrivalDate: string;
  departureDate: string;
  nights: number;
  guests: number;
  nightlyPrices: NightPrice[];
  roomTotal: number;
  stayId: string | null;
  stayStatus: string | null;
}

export function viewOf(r: ReservationRow): ReservationView {
  return {
    id: r.id,
    number: r.number,
    propertyId: r.property_id,
    status: r.status,
    source: r.source,
    bookerPersonId: r.booker_person_id,
    unitId: r.unit_id,
    roomTypeId: r.room_type_id,
    arrivalDate: r.arrival_date,
    departureDate: r.departure_date,
    nights: r.nightly_prices.length,
    guests: r.guests,
    nightlyPrices: r.nightly_prices,
    roomTotal: Number(r.room_total),
    stayId: r.stay_id,
    stayStatus: r.stay_status,
  };
}

/** `reservation.get` (query, S-025): buồng phòng/kỹ thuật, ngoài phạm vi, khác tổ chức → 404. */
export async function getReservation(
  db: Kysely<unknown>,
  actor: Actor,
  reservationId: string,
): Promise<ReservationView> {
  if (!["owner", "manager", "front_desk", "accountant"].includes(actor.role))
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy đặt phòng");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) =>
    viewOf(await readReservation(trx, actor, reservationId, false)),
  );
}

/**
 * `reservation.changeDates` (S-008, Q-06): xem trước chênh lệch (đêm cũ giữ snapshot, đêm mới giá hiện hành) rồi lưu nguyên
 * tử — allocation đổi khoảng trong cùng transaction; phòng bận → ROOM_UNAVAILABLE, booking và allocation không đổi.
 * Pilot: booking draft/held/confirmed (lượt đang ở đổi ngày đi thuộc F-013).
 */
export async function changeDates(
  ctx: CommandContext,
  input: {
    reservationId: string;
    arrivalDate: string;
    departureDate: string;
    previewOnly: boolean;
    now?: Date;
  },
): Promise<{ previewOnly: boolean; priceDiff: number; roomTotal: number; nightlyPrices: NightPrice[] }> {
  const now = input.now ?? new Date();
  const row = await readReservation(ctx.trx, ctx.actor, input.reservationId, true);
  authorize(ctx.actor, "reservation.manage", { propertyId: row.property_id });
  if (!["draft", "held", "confirmed"].includes(row.status)) {
    throw new CommandError("INVALID_TRANSITION", 409, "Chỉ đổi ngày booking chưa nhận phòng", {
      extensions: { from: row.status, to: row.status },
    });
  }
  const s = await staySettings(ctx.trx, ctx.actor.orgId, row.property_id);
  let repriced: { prices: NightPrice[]; total: number; diff: number };
  try {
    repriced = repriceForDates(
      row.nightly_prices,
      nightsOf(input.arrivalDate, input.departureDate, s.maxNights),
      await loadRates(ctx.trx, ctx.actor.orgId, row.room_type_id),
      s.weekendNights,
    );
  } catch (e) {
    return quoteProblem(e);
  }
  const result = {
    previewOnly: input.previewOnly,
    priceDiff: repriced.diff,
    roomTotal: repriced.total,
    nightlyPrices: repriced.prices,
  };
  if (input.previewOnly) return result;
  if (row.allocation_id && row.status !== "draft") {
    const during = await stayInterval(
      ctx.trx,
      ctx.actor.orgId,
      row.property_id,
      input.arrivalDate,
      input.departureDate,
    );
    const a = await sql<{ active: boolean; kind: string; expires_at: Date | null }>`
      select active, kind, expires_at from allocations where organization_id = ${ctx.actor.orgId} and id = ${row.allocation_id}
      for update`.execute(ctx.trx);
    const alloc = a.rows[0];
    if (!alloc?.active || (alloc.kind === "hold" && (alloc.expires_at as Date).getTime() <= now.getTime()))
      throw holdExpired(ctx, row);
    try {
      await sql`savepoint change_dates`.execute(ctx.trx);
      await sql`update allocations set during = tstzrange(${during.start}, ${during.end}, '[)')
                where organization_id = ${ctx.actor.orgId} and id = ${row.allocation_id}`.execute(ctx.trx);
    } catch (e) {
      if ((e as { code?: string }).code === "23P01")
        throw new CommandError(
          "ROOM_UNAVAILABLE",
          409,
          "Phòng đã có người giữ trong thời gian mới. Booking không đổi.",
        );
      throw e;
    }
  }
  await sql`
    update reservation_items set arrival_date = ${input.arrivalDate}::date, departure_date = ${input.departureDate}::date,
           nightly_prices = ${JSON.stringify(repriced.prices)}::jsonb, room_total = ${repriced.total}, version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${row.item_id}`.execute(ctx.trx);
  await sql`update reservations set version = version + 1 where organization_id = ${ctx.actor.orgId} and id = ${row.id}`.execute(
    ctx.trx,
  );
  await ctx.audit({
    action: "reservation.dates_changed",
    entityType: "reservation",
    entityId: row.id,
    propertyId: row.property_id,
    before: {
      arrival_date: row.arrival_date,
      departure_date: row.departure_date,
      room_total: Number(row.room_total),
    },
    after: {
      arrival_date: input.arrivalDate,
      departure_date: input.departureDate,
      room_total: repriced.total,
    },
  });
  return result;
}

/** `reservation.list` (query): booking của cơ sở có ngày ở giao khoảng [from, to), lọc trạng thái; tối đa 200 dòng. */
export async function listReservations(
  db: Kysely<unknown>,
  actor: Actor,
  input: { propertyId: string; from: string; to: string; status?: BookingStatus },
): Promise<ReservationView[]> {
  if (!["owner", "manager", "front_desk", "accountant"].includes(actor.role) || !UUID.test(input.propertyId))
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  if (!actor.allProperties && !actor.propertyIds.includes(input.propertyId))
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  if (input.to <= input.from) throw fieldError("to", "invalid_range", "Khoảng ngày không hợp lệ");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const p = await sql<{ id: string }>`
      select id from properties where organization_id = ${actor.orgId} and id = ${input.propertyId}`.execute(
      trx,
    );
    if (!p.rows[0]) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
    const r = await sql<ReservationRow>`
      select r.id, r.property_id, r.number, r.status, r.source, r.booker_person_id, i.id as item_id, i.unit_id, i.room_type_id,
             i.arrival_date::text, i.departure_date::text, i.guests, i.nightly_prices, i.room_total::text, i.allocation_id,
             s.id as stay_id, s.status as stay_status
      from reservations r
      join reservation_items i on i.organization_id = r.organization_id and i.reservation_id = r.id
      left join stays s on s.organization_id = i.organization_id and s.reservation_item_id = i.id
      where r.organization_id = ${actor.orgId} and r.property_id = ${input.propertyId}
        and i.arrival_date < ${input.to}::date and i.departure_date > ${input.from}::date
        ${input.status ? sql`and r.status = ${input.status}` : sql``}
      order by i.arrival_date, r.number limit 200`.execute(trx);
    return r.rows.map(viewOf);
  });
}

let registered = false;
/** Duyệt `cancellation_fee` (vượt hạn mức) = huỷ booking kèm đúng phí đã duyệt (S-009). */
export function registerReservationExecutors(): void {
  if (registered) return;
  registered = true;
  registerApprovalExecutor("cancellation_fee", {
    async execute(ctx, req) {
      if (req.subjectType !== "reservation" || !req.subjectId || req.amount === null)
        throw new CommandError("VALIDATION_FAILED", 422, "Yêu cầu phí huỷ thiếu booking/số tiền");
      return cancelReservation(
        ctx,
        { reservationId: req.subjectId, reason: req.reason, cancellationFee: req.amount },
        { approvedFee: true },
      );
    },
  });
}

registerReservationExecutors();
