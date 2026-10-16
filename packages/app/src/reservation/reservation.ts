// Booking khách sạn (PLAN đợt 3 T-204; SPEC-reservation-stay §5 `reservation.*`, S-003…S-011, Q-04, Q-10; SPEC-inventory S-018;
// ERD `reservations`, `reservation_items`, `stays`; DOMAIN-MODEL §4). Mọi lệnh chạy trong pipeline (idempotency, audit, outbox).
// - Bất biến ở CSDL (migration 0025): bảng chuyển trạng thái, chứng cứ xác nhận (INV-F3), snapshot giá đêm (INV-G3), nhả hold ⇒
//   `held → expired` đúng một lần (INV-I3), chồng phòng (INV-I1, EXCLUDE ở `allocations`). Code chỉ phối hợp và dịch lỗi.
// - Tồn qua `inventory.ts` (`createHold`, `confirmHold`, `resizeAllocation`, `deactivateAllocationsOf`), tiền qua `payments`/`deposits`
//   (không ghi sổ trực tiếp): ứng trước = `payments` mục đích `receivable` (Có CUSTOMER_CREDIT), cọc bảo đảm = `deposit.receive`.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { AuthzError, authorize, bookingMachine, type NightlyRate, type Quote } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import { approvalRequired, registerApprovalExecutor } from "../approvals/approvals.ts";
import { receiveDeposit } from "../deposits/deposits.ts";
import {
  alternativeUnits,
  confirmHold,
  createHold,
  deactivateAllocationsOf,
  type Interval,
  resizeAllocation,
} from "../inventory/inventory.ts";
import { confirmPayment, type ManualBankTxn, recordPayment } from "../payments/payments.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";
import { assertDate, quoteRoomType } from "./rates.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+?[0-9 .()-]{6,20}$/;

/** Số đêm tối đa một booking ngắn hạn (SPEC Q-10, quyết ở T-204): dài hơn → hợp đồng. */
export const MAX_BOOKING_NIGHTS = 30;
/** Số phòng tối đa một booking (pilot dùng 1; lược đồ cho phép nhiều dòng — F-013). */
export const MAX_ROOMS_PER_BOOKING = 10;
const MAX_FEE = Number.MAX_SAFE_INTEGER;

export interface NightSnapshot {
  business_date: string;
  amount: number;
  day_kind?: "weekday" | "weekend";
  rate_plan_id?: string | null;
}

export interface ReservationItemView {
  id: string;
  unit_id: string;
  room_type_id: string;
  arrival_date: string;
  departure_date: string;
  nights: number;
  guests: number;
  nightly_prices: NightSnapshot[];
  room_total: number;
  stay_id: string | null;
  stay_status: string | null;
}

export interface ReservationView {
  id: string;
  number: string;
  property_id: string;
  status: string;
  source: string;
  booker_person_id: string;
  policy: Record<string, unknown>;
  cancel_reason: string | null;
  cancelled_at: string | null;
  confirmed_at: string | null;
  confirmation_payment_id: string | null;
  confirmed_without_payment: boolean;
  room_total: number;
  items: ReservationItemView[];
}

export interface ReservationRow {
  id: string;
  property_id: string;
  number: string;
  status: string;
  source: string;
  booker_person_id: string;
}

export interface ItemRow {
  id: string;
  unit_id: string;
  room_type_id: string;
  arrival_date: string;
  departure_date: string;
  guests: number;
  nightly_prices: NightSnapshot[];
  room_total: string;
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

// ---------- đọc/khoá ----------

/** Đọc (RLS) → kiểm quyền → khoá hàng: không đọc được (khác tổ chức, buồng phòng) ⇒ 404; thiếu quyền ghi ⇒ 403 trước khi giữ khoá. */
export async function lockReservation(ctx: CommandContext, reservationId: string): Promise<ReservationRow> {
  if (!UUID.test(reservationId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy booking");
  const read = (lock: boolean) =>
    sql<ReservationRow>`
      select id, property_id, number, status, source, booker_person_id from reservations
      where organization_id = ${ctx.actor.orgId} and id = ${reservationId} ${lock ? sql`for update` : sql``}`.execute(
      ctx.trx,
    );
  const seen = (await read(false)).rows[0];
  if (!seen) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy booking");
  authorize(ctx.actor, "reservation.manage", { propertyId: seen.property_id });
  const row = (await read(true)).rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy booking");
  return row;
}

/** Dòng phòng theo `unit_id` tăng dần (thứ tự khoá phòng thống nhất, không deadlock giữa hai booking nhiều phòng). */
export async function loadItems(
  ctx: CommandContext,
  reservationId: string,
  lock = false,
): Promise<ItemRow[]> {
  const r = await sql<ItemRow>`
    select id, unit_id, room_type_id, arrival_date::text, departure_date::text, guests, nightly_prices, room_total::text
    from reservation_items where organization_id = ${ctx.actor.orgId} and reservation_id = ${reservationId}
    order by unit_id, id ${lock ? sql`for update` : sql``}`.execute(ctx.trx);
  return r.rows;
}

export async function loadStays(ctx: CommandContext, itemIds: readonly string[], lock = false) {
  if (itemIds.length === 0) return [];
  const r = await sql<{ id: string; reservation_item_id: string; status: string }>`
    select id, reservation_item_id, status from stays
    where organization_id = ${ctx.actor.orgId} and reservation_item_id = any(${itemIds as string[]}::uuid[])
    order by id ${lock ? sql`for update` : sql``}`.execute(ctx.trx);
  return r.rows;
}

interface PropertyConfig {
  confirmWithoutPayment: boolean;
}

async function propertyConfig(ctx: CommandContext, propertyId: string): Promise<PropertyConfig> {
  const r = await sql<{ w: boolean }>`
    select coalesce(settings #>> '{reservation,confirm_without_payment}', 'false') = 'true' as w
    from properties where organization_id = ${ctx.actor.orgId} and id = ${propertyId}`.execute(ctx.trx);
  return { confirmWithoutPayment: r.rows[0]?.w ?? false };
}

/**
 * Khoảng allocation của một lượt ở: [ngày đến + giờ nhận phòng, ngày đi + giờ trả phòng) theo giờ địa phương của cơ sở, đổi sang
 * UTC (SPEC §4; S-003: 20/10 14:00 → 22/10 12:00 giờ VN = [07:00Z, 05:00Z)). Cơ sở chưa cấu hình giờ nhận/trả → 422.
 */
export async function stayInterval(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
  arrivalDate: string,
  departureDate: string,
): Promise<Interval> {
  const r = await sql<{ s: Date | null; e: Date | null }>`
    select ((${arrivalDate}::date + p.check_in_time) at time zone p.timezone) as s,
           ((${departureDate}::date + p.check_out_time) at time zone p.timezone) as e
    from properties p where p.organization_id = ${orgId} and p.id = ${propertyId}`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  if (!row.s || !row.e) {
    throw fieldError("property_id", "CHECK_TIMES_MISSING", "Cơ sở chưa cấu hình giờ nhận/trả phòng");
  }
  return { start: new Date(row.s), end: new Date(row.e) };
}

export async function businessDateAt(ctx: CommandContext, propertyId: string, at: Date): Promise<string> {
  const r = await sql<{ d: string }>`
    select app.business_date(${ctx.actor.orgId}, ${propertyId}, ${at}::timestamptz)::text as d`.execute(
    ctx.trx,
  );
  return r.rows[0]?.d as string;
}

export function snapshotOf(q: Quote): NightSnapshot[] {
  return q.nights.map((n) => ({
    business_date: n.businessDate,
    amount: n.amount,
    day_kind: n.dayKind,
    rate_plan_id: n.ratePlanId ?? null,
  }));
}

function toRates(nights: readonly NightSnapshot[]): NightlyRate[] {
  return nights.map((n) => ({
    businessDate: n.business_date,
    amount: n.amount,
    ...(n.rate_plan_id ? { ratePlanId: n.rate_plan_id } : {}),
  }));
}

export function transitionError(from: string, to: string, message: string): CommandError {
  return new CommandError("INVALID_TRANSITION", 409, message, { extensions: { from, to } });
}

/** Lỗi theo `bookingMachine` (DOMAIN-MODEL §4) — cùng bảng với trigger CSDL; từ chối được audit bởi pipeline. */
export function assertBooking(from: string, to: Parameters<typeof bookingMachine.canTransition>[1]): void {
  bookingMachine.assertTransition(from as Parameters<typeof bookingMachine.canTransition>[0], to);
}

// ---------- view ----------

async function readView(
  trx: Transaction<unknown>,
  orgId: string,
  reservationId: string,
): Promise<ReservationView | null> {
  const r = await sql<{
    id: string;
    number: string;
    property_id: string;
    status: string;
    source: string;
    booker_person_id: string;
    policy_snapshot: Record<string, unknown>;
    cancel_reason: string | null;
    cancelled_at: Date | null;
    confirmed_at: Date | null;
    confirmation_payment_id: string | null;
    confirmed_without_payment: boolean;
  }>`
    select id, number, property_id, status, source, booker_person_id, policy_snapshot, cancel_reason, cancelled_at, confirmed_at,
           confirmation_payment_id, confirmed_without_payment
    from reservations where organization_id = ${orgId} and id = ${reservationId}`.execute(trx);
  const res = r.rows[0];
  if (!res) return null;
  const items = await sql<ItemRow & { nights: number; stay_id: string | null; stay_status: string | null }>`
    select i.id, i.unit_id, i.room_type_id, i.arrival_date::text, i.departure_date::text, i.nights, i.guests, i.nightly_prices,
           i.room_total::text, s.id as stay_id, s.status as stay_status
    from reservation_items i
    left join stays s on s.organization_id = i.organization_id and s.reservation_item_id = i.id
    where i.organization_id = ${orgId} and i.reservation_id = ${reservationId}
    order by i.unit_id, i.id`.execute(trx);
  const views = items.rows.map((i) => ({
    id: i.id,
    unit_id: i.unit_id,
    room_type_id: i.room_type_id,
    arrival_date: i.arrival_date,
    departure_date: i.departure_date,
    nights: i.nights,
    guests: i.guests,
    nightly_prices: i.nightly_prices,
    room_total: Number(i.room_total),
    stay_id: i.stay_id,
    stay_status: i.stay_status,
  }));
  return {
    id: res.id,
    number: res.number,
    property_id: res.property_id,
    status: res.status,
    source: res.source,
    booker_person_id: res.booker_person_id,
    policy: res.policy_snapshot,
    cancel_reason: res.cancel_reason,
    cancelled_at: iso(res.cancelled_at),
    confirmed_at: iso(res.confirmed_at),
    confirmation_payment_id: res.confirmation_payment_id,
    confirmed_without_payment: res.confirmed_without_payment,
    room_total: views.reduce((s, i) => s + i.room_total, 0),
    items: views,
  };
}

export async function mustView(ctx: CommandContext, reservationId: string): Promise<ReservationView> {
  const v = await readView(ctx.trx, ctx.actor.orgId, reservationId);
  if (!v) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy booking");
  return v;
}

/** `reservation.get` (query): RLS quyết ai đọc được (buồng phòng/bảo trì không đọc; khác tổ chức) ⇒ 404 (S-025). */
export async function getReservation(
  db: Kysely<unknown>,
  actor: Actor,
  reservationId: string,
): Promise<ReservationView & { booker: { id: string; full_name: string; phone: string | null } | null }> {
  if (!UUID.test(reservationId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy booking");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const v = await readView(trx, actor.orgId, reservationId);
    if (!v) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy booking");
    const p = await sql<{ id: string; full_name: string; phone: string | null }>`
      select id, full_name, phone from persons where organization_id = ${actor.orgId} and id = ${v.booker_person_id}`.execute(
      trx,
    );
    return { ...v, booker: p.rows[0] ?? null };
  });
}

export interface ReservationListItem {
  id: string;
  number: string;
  status: string;
  source: string;
  booker_person_id: string;
  arrival_date: string;
  departure_date: string;
  guests: number;
  room_total: number;
  unit_ids: string[];
}

const LIST_MAX = 200;
export const RESERVATION_STATUSES = [
  "draft",
  "held",
  "confirmed",
  "in_house",
  "checked_out",
  "cancelled",
  "no_show",
  "expired",
] as const;

/**
 * `reservation.list` (query): theo cơ sở, khoảng ngày (booking có đêm chồng `[from, to)`) và trạng thái; keyset theo (ngày đến, id).
 * Quyền đọc khách (`calendar.read_guests`): chủ/quản lý/lễ tân/kế toán; buồng phòng → 403.
 */
export async function listReservations(
  db: Kysely<unknown>,
  actor: Actor,
  input: {
    propertyId: string;
    from?: string;
    to?: string;
    statuses?: readonly string[];
    limit?: number;
    cursor?: string;
  },
): Promise<{ items: ReservationListItem[]; next_cursor: string | null }> {
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  authorize(actor, "calendar.read_guests", { propertyId: input.propertyId });
  if (input.from) assertDate(input.from, "from");
  if (input.to) assertDate(input.to, "to");
  if (input.from && input.to && input.to <= input.from)
    throw fieldError("to", "RANGE_INVALID", "to phải sau from");
  const limit = Math.min(Math.max(input.limit ?? 50, 1), LIST_MAX);
  for (const s of input.statuses ?? []) {
    if (!(RESERVATION_STATUSES as readonly string[]).includes(s))
      throw fieldError("status", "INVALID", `Trạng thái không hợp lệ: ${s}`);
  }
  let after: [string, string] | null = null;
  if (input.cursor) {
    try {
      const c = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as unknown;
      if (
        !Array.isArray(c) ||
        typeof c[0] !== "string" ||
        typeof c[1] !== "string" ||
        !UUID.test(c[1]) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(c[0])
      )
        throw new Error("cursor");
      after = [c[0], c[1]];
    } catch {
      throw fieldError("cursor", "INVALID", "cursor không hợp lệ");
    }
  }
  const statuses = input.statuses && input.statuses.length > 0 ? [...input.statuses] : null;
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    // Cơ sở của tổ chức khác (hoặc không có) ⇒ 404, không trả danh sách rỗng gây hiểu nhầm.
    const prop = await sql<{ id: string }>`
      select id from properties where organization_id = ${actor.orgId} and id = ${input.propertyId}`.execute(
      trx,
    );
    if (!prop.rows[0]) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
    const r = await sql<{
      id: string;
      number: string;
      status: string;
      source: string;
      booker_person_id: string;
      arrival: string;
      departure: string;
      guests: string;
      room_total: string;
      unit_ids: string[];
    }>`
      with b as (
        select r.id, r.number, r.status, r.source, r.booker_person_id, min(i.arrival_date) as arrival,
               max(i.departure_date) as departure, sum(i.guests) as guests, sum(i.room_total) as room_total,
               array_agg(i.unit_id order by i.unit_id) as unit_ids
        from reservations r
        join reservation_items i on i.organization_id = r.organization_id and i.reservation_id = r.id
        where r.organization_id = ${actor.orgId} and r.property_id = ${input.propertyId}
          and (${statuses}::text[] is null or r.status = any(${statuses}::text[]))
        group by r.id
      )
      select id, number, status, source, booker_person_id, arrival::text, departure::text, guests::text, room_total::text, unit_ids
      from b
      where (${input.from ?? null}::date is null or departure > ${input.from ?? null}::date)
        and (${input.to ?? null}::date is null or arrival < ${input.to ?? null}::date)
        and (${after?.[0] ?? null}::date is null or (arrival, id) > (${after?.[0] ?? null}::date, ${after?.[1] ?? null}::uuid))
      order by arrival, id
      limit ${limit + 1}`.execute(trx);
    const page = r.rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((x) => ({
        id: x.id,
        number: x.number,
        status: x.status,
        source: x.source,
        booker_person_id: x.booker_person_id,
        arrival_date: x.arrival,
        departure_date: x.departure,
        guests: Number(x.guests),
        room_total: Number(x.room_total),
        unit_ids: x.unit_ids,
      })),
      next_cursor:
        r.rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.arrival, last.id])).toString("base64url")
          : null,
    };
  });
}

// ---------- reservation.create ----------

export interface CreateReservationInput {
  booker: { personId: string } | { fullName: string; phone: string };
  /** Pilot: một phòng; lược đồ cho phép tới `MAX_ROOMS_PER_BOOKING` (chung ngày đến/đi). */
  rooms: readonly { unitId: string; guests: number }[];
  arrivalDate: string;
  departureDate: string;
  /**
   * Giá đã chốt với khách theo đêm (import chuyển đổi — SPEC-import S-009): đêm có ở đây giữ NGUYÊN giá làm ảnh chụp (INV-G3),
   * không tra bảng giá; đêm thiếu vẫn tra bảng giá. Chỉ đường đã kiểm quyền riêng (import.commit) mới truyền.
   */
  nightlyRates?: readonly NightlyRate[];
}

/**
 * `reservation.create` (S-003, S-014, Q-10): tạo booking `draft` + dòng phòng với ảnh chụp giá từng đêm (INV-G3). Chưa giữ phòng
 * (`reservation.hold`). Kiểm: quyền ở cơ sở của phòng, sức chứa (422 CAPACITY_EXCEEDED), ngày đi > ngày đến, tối đa
 * `MAX_BOOKING_NIGHTS` đêm, mọi đêm có giá (422 RATE_NOT_CONFIGURED). Người đặt: người có sẵn hoặc tạo mới (họ tên + SĐT — Q-08).
 */
export async function createReservation(
  ctx: CommandContext,
  input: CreateReservationInput,
): Promise<ReservationView> {
  if (input.rooms.length < 1 || input.rooms.length > MAX_ROOMS_PER_BOOKING)
    throw fieldError("rooms", "COUNT", `Một booking có 1–${MAX_ROOMS_PER_BOOKING} phòng`);
  const unitIds = input.rooms.map((r) => r.unitId);
  if (unitIds.some((u) => !UUID.test(u))) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  if (new Set(unitIds).size !== unitIds.length)
    throw fieldError("rooms", "DUPLICATE_UNIT", "Mỗi phòng chỉ một dòng trong booking");
  for (const r of input.rooms) {
    if (!Number.isInteger(r.guests) || r.guests < 1 || r.guests > 1000)
      throw fieldError("guests", "INVALID", "Số khách là số nguyên ≥ 1");
  }
  const units = await sql<{
    id: string;
    property_id: string;
    room_type_id: string | null;
    capacity: number | null;
  }>`
    select u.id, u.property_id, u.room_type_id, rt.capacity
    from units u left join room_types rt on rt.organization_id = u.organization_id and rt.id = u.room_type_id
    where u.organization_id = ${ctx.actor.orgId} and u.id = any(${unitIds}::uuid[]) and u.archived_at is null`.execute(
    ctx.trx,
  );
  const byId = new Map(units.rows.map((u) => [u.id, u]));
  const propertyId = units.rows[0]?.property_id;
  if (!propertyId || units.rows.length !== unitIds.length)
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  authorize(ctx.actor, "reservation.manage", { propertyId });
  if (units.rows.some((u) => u.property_id !== propertyId))
    throw fieldError("rooms", "MIXED_PROPERTY", "Mọi phòng của một booking cùng một cơ sở");

  // Booking thuộc phòng đã có loại phòng; sức chứa kiểm ở bước booking (S-014).
  const lines = input.rooms.map((r) => {
    const u = byId.get(r.unitId);
    if (!u?.room_type_id || u.capacity === null)
      throw fieldError("rooms", "UNIT_NO_ROOM_TYPE", "Phòng chưa gán loại phòng nên không báo giá được");
    if (r.guests > u.capacity) {
      throw new CommandError("CAPACITY_EXCEEDED", 422, "Số khách vượt sức chứa của phòng.", {
        extensions: { errors: [{ path: "guests", field: "guests", code: "CAPACITY_EXCEEDED" }] },
      });
    }
    return { unitId: r.unitId, guests: r.guests, roomTypeId: u.room_type_id };
  });
  const priced: { quote: Quote; line: (typeof lines)[number] }[] = [];
  for (const line of lines) {
    const quote = await quoteRoomType(ctx.trx, {
      orgId: ctx.actor.orgId,
      roomTypeId: line.roomTypeId,
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      maxNights: MAX_BOOKING_NIGHTS,
      ...(input.nightlyRates ? { nightlyRates: input.nightlyRates } : {}),
    });
    priced.push({ quote, line });
  }
  // Có giờ nhận/trả phòng thì mới giữ phòng được: báo sớm ở bước tạo.
  await stayInterval(ctx.trx, ctx.actor.orgId, propertyId, input.arrivalDate, input.departureDate);

  let bookerId: string;
  if ("personId" in input.booker) {
    bookerId = input.booker.personId;
    if (!UUID.test(bookerId)) throw fieldError("booker.person_id", "INVALID", "Người đặt không hợp lệ");
    const p = await sql<{ id: string }>`
      select id from persons where organization_id = ${ctx.actor.orgId} and id = ${bookerId} and anonymized_at is null`.execute(
      ctx.trx,
    );
    if (!p.rows[0]) throw fieldError("booker.person_id", "NOT_FOUND", "Không tìm thấy người đặt");
  } else {
    const fullName = input.booker.fullName.trim();
    const phone = input.booker.phone.trim();
    if (fullName.length < 1 || fullName.length > 200)
      throw fieldError("booker.full_name", "INVALID", "Họ tên 1–200 ký tự");
    if (!PHONE.test(phone)) throw fieldError("booker.phone", "INVALID", "Số điện thoại không hợp lệ");
    bookerId = randomUUID();
    await sql`insert into persons (id, organization_id, full_name, phone)
              values (${bookerId}, ${ctx.actor.orgId}, ${fullName}, ${phone})`.execute(ctx.trx);
    await ctx.audit({ action: "person.created", entityType: "person", entityId: bookerId, propertyId });
  }

  const n = await sql<{
    n: string;
  }>`select app.next_number(${ctx.actor.orgId}, ${propertyId}, 'reservation')::text as n`.execute(ctx.trx);
  const number = `R-${n.rows[0]?.n}`;
  const id = randomUUID();
  // Điều kiện huỷ đang áp dụng (Q-04): không phạt tự động; phí nhập tay có lý do, trong hạn mức người thao tác.
  const policy = { cancellation: { automatic_fee: 0, manual_fee: "within_limit_with_reason" } };
  await sql`
    insert into reservations (id, organization_id, property_id, number, status, source, booker_person_id, policy_snapshot, created_by)
    values (${id}, ${ctx.actor.orgId}, ${propertyId}, ${number}, 'draft', 'direct', ${bookerId}, ${JSON.stringify(policy)}::jsonb,
            ${ctx.actor.membershipId})`.execute(ctx.trx);
  for (const { quote, line } of priced) {
    await sql`
      insert into reservation_items (id, organization_id, property_id, reservation_id, unit_id, room_type_id, arrival_date,
                                     departure_date, guests, nightly_prices, room_total)
      values (${randomUUID()}, ${ctx.actor.orgId}, ${propertyId}, ${id}, ${line.unitId}, ${line.roomTypeId},
              ${input.arrivalDate}::date, ${input.departureDate}::date, ${line.guests}, ${JSON.stringify(snapshotOf(quote))}::jsonb,
              ${quote.total})`.execute(ctx.trx);
  }
  await ctx.audit({
    action: "reservation.created",
    entityType: "reservation",
    entityId: id,
    propertyId,
    after: {
      number,
      arrival_date: input.arrivalDate,
      departure_date: input.departureDate,
      rooms: lines.length,
      room_total: priced.reduce((s, p) => s + p.quote.total, 0),
    },
  });
  return mustView(ctx, id);
}

// ---------- reservation.hold ----------

/**
 * `reservation.hold` (S-003, S-004): `draft → held` — mỗi dòng phòng gọi `inventory.createHold` (allocation `hold`, nguồn
 * `reservation_item`, TTL `properties.hold_ttl_minutes`). Phòng bận ⇒ 409 ROOM_UNAVAILABLE kèm `alternatives` (EXCLUDE ở
 * CSDL quyết người thắng khi hai lễ tân giữ cùng lúc); phòng ngừng khai thác ⇒ UNIT_OUT_OF_SERVICE. Lỗi bất kỳ ⇒ không giữ gì.
 */
export async function holdReservation(
  ctx: CommandContext,
  input: { reservationId: string; now?: Date },
): Promise<{
  reservation_id: string;
  status: "held";
  allocation_id: string;
  expires_at: string;
  holds: { item_id: string; allocation_id: string; expires_at: string }[];
}> {
  const now = input.now ?? new Date();
  const res = await lockReservation(ctx, input.reservationId);
  assertBooking(res.status, "held");
  const items = await loadItems(ctx, res.id);
  const holds: { item_id: string; allocation_id: string; expires_at: Date }[] = [];
  for (const item of items) {
    const during = await stayInterval(
      ctx.trx,
      ctx.actor.orgId,
      res.property_id,
      item.arrival_date,
      item.departure_date,
    );
    const h = await createHold(ctx, {
      unitId: item.unit_id,
      during,
      sourceType: "reservation_item",
      sourceId: item.id,
      now,
    });
    holds.push({ item_id: item.id, allocation_id: h.allocationId, expires_at: h.expiresAt });
  }
  await sql`update reservations set status = 'held' where organization_id = ${ctx.actor.orgId} and id = ${res.id}`.execute(
    ctx.trx,
  );
  const first = holds[0] as (typeof holds)[number];
  await ctx.audit({
    action: "reservation.held",
    entityType: "reservation",
    entityId: res.id,
    propertyId: res.property_id,
    before: { status: res.status },
    after: { status: "held", expires_at: first.expires_at.toISOString() },
  });
  await ctx.emit({
    eventType: "reservation.held",
    aggregateType: "reservation",
    aggregateId: res.id,
    propertyId: res.property_id,
    payload: { reservation_id: res.id },
  });
  return {
    reservation_id: res.id,
    status: "held",
    allocation_id: first.allocation_id,
    expires_at: first.expires_at.toISOString(),
    holds: holds.map((h) => ({ ...h, expires_at: h.expires_at.toISOString() })),
  };
}

// ---------- reservation.confirm ----------

export interface BookingPaymentInput {
  /** `advance` = ứng trước (Có CUSTOMER_CREDIT); `security_deposit` = cọc bảo đảm (Có DEPOSIT_LIAB, INV-F5). */
  kind: "advance" | "security_deposit";
  method: "cash" | "bank_transfer";
  amount: number;
  /** Chuyển khoản: tài khoản nhận + dòng sao kê (hoặc giao dịch ngân hàng đã có) làm chứng cứ (INV-F3, INV-F4b). */
  receivingAccountId?: string;
  bankTxn?: ManualBankTxn;
  bankTransactionId?: string;
}

function holdExpired(
  ctx: CommandContext,
  res: ReservationRow,
  holdIds: readonly string[],
  now: Date,
): CommandError {
  const { orgId, personId, membershipId } = ctx.actor;
  const ids = { commandId: ctx.commandId, correlationId: ctx.correlationId };
  return new CommandError("HOLD_EXPIRED", 409, "Thời gian giữ phòng đã hết. Vui lòng giữ lại.", {
    // Transaction nghiệp vụ đã rollback: ghi `held → expired` và nhả hold ở transaction riêng, đúng một lần cho mỗi
    // Idempotency-Key (S-007); chuyển trạng thái bảo vệ bằng WHERE status = 'held' nên lần gọi khác key cũng chỉ một lần.
    persist: async (trx) => {
      const flipped = await sql<{ id: string }>`
        update reservations set status = 'expired' where organization_id = ${orgId} and id = ${res.id} and status = 'held'
        returning id`.execute(trx);
      if (holdIds.length > 0) {
        await sql`
          update allocations set active = false, deactivated_at = ${now}, deactivated_reason = 'expired'
          where organization_id = ${orgId} and id = any(${holdIds as string[]}::uuid[]) and active and kind = 'hold'`.execute(
          trx,
        );
      }
      if (flipped.rows[0]) {
        await sql`
          insert into audit_events (id, organization_id, property_id, actor_type, actor_person_id, action, entity_type, entity_id,
                                    before, after, correlation_id, command_id, outcome)
          values (${randomUUID()}, ${orgId}, ${res.property_id}, 'user', ${personId}, 'reservation.expired', 'reservation', ${res.id},
                  ${JSON.stringify({ status: "held" })}::jsonb, ${JSON.stringify({ status: "expired", by_membership: membershipId })}::jsonb,
                  ${ids.correlationId}, ${ids.commandId}, 'success')`.execute(trx);
      }
      return {};
    },
  });
}

export async function takeBookingPayment(
  ctx: CommandContext,
  res: ReservationRow,
  p: BookingPaymentInput,
): Promise<{ paymentId: string; depositId: string | null }> {
  if (!Number.isSafeInteger(p.amount) || p.amount <= 0)
    throw fieldError("payment.amount", "INVALID", "Số tiền ứng trước/cọc là số nguyên đồng > 0");
  const common = {
    propertyId: res.property_id,
    method: p.method,
    amount: p.amount,
    payerPersonId: res.booker_person_id,
    ...(p.receivingAccountId ? { receivingAccountId: p.receivingAccountId } : {}),
    ...(p.bankTxn ? { bankTxn: p.bankTxn } : {}),
  };
  let paymentId: string;
  let depositId: string | null = null;
  if (p.kind === "security_deposit") {
    const d = await receiveDeposit(ctx, { ...common, reservationId: res.id });
    paymentId = d.paymentId;
    depositId = d.depositId;
  } else {
    // Ứng trước gắn đúng booking: check-out (T-206) chỉ phân bổ ứng trước của chính booking vào folio.
    paymentId = (await recordPayment(ctx, { ...common, reservationId: res.id })).paymentId;
  }
  // Xác nhận có chứng cứ (INV-F3): chuyển khoản thiếu sao kê/giao dịch ⇒ 422 EVIDENCE_REQUIRED, cả lệnh rollback (không còn khoản
  // `pending` mồ côi); tiền mặt chỉ người nhận trong ca đang mở (INV-F3b). Quyền xác nhận theo ma trận của payments.
  await confirmPayment(ctx, {
    paymentId,
    ...(p.bankTransactionId ? { evidence: { bankTransactionId: p.bankTransactionId } } : {}),
  });
  return { paymentId, depositId };
}

/**
 * `reservation.confirm` (S-005, S-006, S-007): `held → confirmed` khi hold còn hạn. Cần ứng trước/cọc ĐÃ xác nhận có chứng cứ — hoặc
 * cơ sở bật `properties.settings.reservation.confirm_without_payment` (Q-05; mặc định tắt). "Khách bấm đã chuyển" không đủ. Một
 * transaction: khoản thu (nếu có) → lượt ở `expected` cho mỗi dòng phòng → allocation `hold → stay` (UPDATE một câu, không khe hở;
 * `source_id` = lượt ở, `expires_at` NULL) → booking `confirmed`. Hold quá hạn ⇒ 409 HOLD_EXPIRED, booking `expired` đúng một lần, phòng nhả.
 */
export async function confirmReservation(
  ctx: CommandContext,
  input: {
    reservationId: string;
    payment?: BookingPaymentInput;
    now?: Date;
    /**
     * Xác nhận không kèm khoản thu dù cơ sở chưa bật `confirm_without_payment`: CHỈ cho import chuyển đổi (SPEC-import S-009) —
     * tiền đã thu ở sổ cũ, ghi bằng số dư đầu kỳ (Nợ OPENING_BALANCE / Có CUSTOMER_CREDIT), không bịa khoản thu ở hệ thống mới.
     */
    imported?: boolean;
  },
): Promise<{
  reservation_id: string;
  status: "confirmed";
  stay_id: string;
  stay_ids: string[];
  payment_id: string | null;
  deposit_id: string | null;
  confirmed_without_payment: boolean;
}> {
  const now = input.now ?? new Date();
  const res = await lockReservation(ctx, input.reservationId);
  // `expired` do worker/dọn hold đã đặt trước: vẫn báo HOLD_EXPIRED (đúng nguyên nhân) thay vì INVALID_TRANSITION.
  if (res.status === "expired")
    throw new CommandError("HOLD_EXPIRED", 409, "Thời gian giữ phòng đã hết. Vui lòng giữ lại.");
  assertBooking(res.status, "confirmed");
  const items = await loadItems(ctx, res.id, true);
  const holds = await sql<{ id: string; source_id: string; expires_at: Date }>`
    select id, source_id, expires_at from allocations
    where organization_id = ${ctx.actor.orgId} and source_type = 'reservation_item' and kind = 'hold' and active
      and source_id = any(${items.map((i) => i.id)}::uuid[])
    order by id for update`.execute(ctx.trx);
  if (holds.rows.length !== items.length || holds.rows.some((h) => h.expires_at.getTime() <= now.getTime())) {
    throw holdExpired(
      ctx,
      res,
      holds.rows.map((h) => h.id),
      now,
    );
  }
  const cfg = await propertyConfig(ctx, res.property_id);
  if (!input.payment && !cfg.confirmWithoutPayment && !input.imported) {
    throw new CommandError(
      "EVIDENCE_REQUIRED",
      422,
      "Cần ứng trước hoặc cọc có chứng cứ để xác nhận booking (INV-F3).",
    );
  }
  const paid = input.payment ? await takeBookingPayment(ctx, res, input.payment) : null;

  const stayIds: string[] = [];
  for (const item of items) {
    const stayId = randomUUID();
    await sql`
      insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id)
      values (${stayId}, ${ctx.actor.orgId}, ${res.property_id}, ${item.id}, ${item.unit_id}, 'expected', ${res.booker_person_id})`.execute(
      ctx.trx,
    );
    const hold = holds.rows.find((h) => h.source_id === item.id) as (typeof holds.rows)[number];
    await confirmHold(ctx, hold.id, "stay", now, undefined, { type: "stay", id: stayId });
    stayIds.push(stayId);
  }
  await sql`
    update reservations set status = 'confirmed', confirmed_at = ${now}, confirmation_payment_id = ${paid?.paymentId ?? null},
           confirmed_without_payment = ${paid === null}
    where organization_id = ${ctx.actor.orgId} and id = ${res.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "reservation.confirmed",
    entityType: "reservation",
    entityId: res.id,
    propertyId: res.property_id,
    before: { status: "held" },
    after: {
      status: "confirmed",
      stay_ids: stayIds,
      payment_id: paid?.paymentId ?? null,
      payment_kind: input.payment?.kind ?? null,
      amount: input.payment?.amount ?? null,
      without_payment: paid === null,
      ...(input.imported ? { imported: true } : {}),
    },
  });
  await ctx.emit({
    eventType: "reservation.confirmed",
    aggregateType: "reservation",
    aggregateId: res.id,
    propertyId: res.property_id,
    payload: {
      reservation_id: res.id,
      with_payment: paid !== null,
      ...(input.imported ? { imported: true } : {}),
    },
  });
  return {
    reservation_id: res.id,
    status: "confirmed",
    stay_id: stayIds[0] as string,
    stay_ids: stayIds,
    payment_id: paid?.paymentId ?? null,
    deposit_id: paid?.depositId ?? null,
    confirmed_without_payment: paid === null,
  };
}

// ---------- reservation.changeDates ----------

export interface ChangeDatesResult {
  reservation_id: string;
  preview_only: boolean;
  old_total: number;
  new_total: number;
  /** Chênh lệch tiền phòng (mới − cũ); đêm cũ giữ giá snapshot, đêm mới giá hiện hành (Q-06). */
  price_diff: number;
  /** Preview: phòng có trống cho khoảng mới (không đổi gì). Lưu thật luôn `true` (không thì đã 409). */
  available: boolean;
  alternatives: { unit_id: string; code: string }[];
  nights: NightSnapshot[];
  reservation: ReservationView;
}

/**
 * `reservation.changeDates` (S-008): đổi ngày nguyên tử — dòng phòng (ngày, snapshot, tổng) và allocation cùng transaction.
 * Đêm có ở cả hai khoảng giữ giá snapshot (DB cũng chặn đổi), đêm mới lấy giá hiện hành. Phòng bận ⇒ 409 ROOM_UNAVAILABLE và
 * booking/allocation KHÔNG đổi. `previewOnly` chỉ trả chênh lệch và khả năng còn phòng.
 */
export async function changeReservationDates(
  ctx: CommandContext,
  input: {
    reservationId: string;
    arrivalDate: string;
    departureDate: string;
    previewOnly?: boolean;
    now?: Date;
  },
): Promise<ChangeDatesResult> {
  const now = input.now ?? new Date();
  assertDate(input.arrivalDate, "arrival_date");
  assertDate(input.departureDate, "departure_date");
  const res = await lockReservation(ctx, input.reservationId);
  if (!["draft", "held", "confirmed"].includes(res.status)) {
    throw transitionError(res.status, res.status, "Chỉ đổi ngày booking chưa nhận phòng");
  }
  const items = await loadItems(ctx, res.id, true);
  if (items.every((i) => i.arrival_date === input.arrivalDate && i.departure_date === input.departureDate)) {
    throw fieldError("arrival_date", "UNCHANGED", "Ngày đến/đi không đổi");
  }
  const stays =
    res.status === "confirmed"
      ? await loadStays(
          ctx,
          items.map((i) => i.id),
          true,
        )
      : [];
  const interval = await stayInterval(
    ctx.trx,
    ctx.actor.orgId,
    res.property_id,
    input.arrivalDate,
    input.departureDate,
  );

  const plan = [];
  for (const item of items) {
    const quote = await quoteRoomType(ctx.trx, {
      orgId: ctx.actor.orgId,
      roomTypeId: item.room_type_id,
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      nightlyRates: toRates(item.nightly_prices),
      maxNights: MAX_BOOKING_NIGHTS,
    });
    plan.push({ item, quote });
  }
  const oldTotal = items.reduce((s, i) => s + Number(i.room_total), 0);
  const newTotal = plan.reduce((s, p) => s + p.quote.total, 0);

  // Allocation đang giữ phòng cho từng dòng: hold (draft không có) hoặc stay (đã xác nhận).
  const allocationOf = async (item: ItemRow): Promise<string | null> => {
    if (res.status === "draft") return null;
    const sourceType = res.status === "held" ? "reservation_item" : "stay";
    const sourceId =
      res.status === "held" ? item.id : stays.find((s) => s.reservation_item_id === item.id)?.id;
    if (!sourceId) return null;
    const a = await sql<{ id: string }>`
      select id from allocations where organization_id = ${ctx.actor.orgId} and source_type = ${sourceType}
        and source_id = ${sourceId} and active order by created_at desc limit 1`.execute(ctx.trx);
    return a.rows[0]?.id ?? null;
  };

  if (input.previewOnly) {
    let available = true;
    let alternatives: { unit_id: string; code: string }[] = [];
    const range = `[${interval.start.toISOString()},${(interval.end as Date).toISOString()})`;
    for (const { item } of plan) {
      const own = await allocationOf(item);
      const busy = await sql<{ id: string }>`
        select id from allocations
        where organization_id = ${ctx.actor.orgId} and unit_id = ${item.unit_id} and active
          and (${own}::uuid is null or id <> ${own}::uuid) and during && ${range}::tstzrange
          and (kind <> 'hold' or expires_at > ${now}) limit 1`.execute(ctx.trx);
      if (busy.rows[0]) {
        available = false;
        alternatives = await alternativeUnits(ctx.trx, ctx.actor.orgId, item.unit_id, range, now);
        break;
      }
    }
    return {
      reservation_id: res.id,
      preview_only: true,
      old_total: oldTotal,
      new_total: newTotal,
      price_diff: newTotal - oldTotal,
      available,
      alternatives,
      nights: plan.flatMap((p) => snapshotOf(p.quote)),
      reservation: await mustView(ctx, res.id),
    };
  }

  for (const { item, quote } of plan) {
    const allocationId = await allocationOf(item);
    if (res.status !== "draft") {
      if (!allocationId)
        throw new CommandError("HOLD_EXPIRED", 409, "Thời gian giữ phòng đã hết. Vui lòng giữ lại.");
      await resizeAllocation(ctx, {
        allocationId,
        start: interval.start,
        end: interval.end as Date,
        now,
      });
    }
    await sql`
      update reservation_items set arrival_date = ${input.arrivalDate}::date, departure_date = ${input.departureDate}::date,
             nightly_prices = ${JSON.stringify(snapshotOf(quote))}::jsonb, room_total = ${quote.total}
      where organization_id = ${ctx.actor.orgId} and id = ${item.id}`.execute(ctx.trx);
  }
  await ctx.audit({
    action: "reservation.dates_changed",
    entityType: "reservation",
    entityId: res.id,
    propertyId: res.property_id,
    before: {
      arrival_date: items[0]?.arrival_date,
      departure_date: items[0]?.departure_date,
      room_total: oldTotal,
    },
    after: { arrival_date: input.arrivalDate, departure_date: input.departureDate, room_total: newTotal },
  });
  return {
    reservation_id: res.id,
    preview_only: false,
    old_total: oldTotal,
    new_total: newTotal,
    price_diff: newTotal - oldTotal,
    available: true,
    alternatives: [],
    nights: plan.flatMap((p) => snapshotOf(p.quote)),
    reservation: await mustView(ctx, res.id),
  };
}

// ---------- reservation.cancel ----------

function assertReason(reason: string): string {
  const r = reason.trim();
  if (r.length < 1 || r.length > 1000) throw fieldError("reason", "REQUIRED", "Cần ghi lý do (1–1000 ký tự)");
  return r;
}

/**
 * `reservation.cancel` (S-009, S-010, Q-04): nhả phòng tại thời điểm commit, lượt ở `expected → cancelled`; KHÔNG phạt tự động,
 * KHÔNG động tới sổ — ứng trước (`CUSTOMER_CREDIT`) và cọc (`DEPOSIT_LIAB`) giữ nguyên chờ hoàn có duyệt (INV-F5), không có `REV_*`.
 * Phí huỷ (> 0, chỉ khi đã có lượt ở) nhập tay: trong hạn mức `reservation.override_price` thì tạo `charges` loại phí (REV_FEE khi
 * phát hành folio, T-206); vượt ⇒ 403 APPROVAL_LIMIT_EXCEEDED kèm yêu cầu duyệt `cancellation_fee` (duyệt xong thì huỷ chạy).
 */
export async function cancelReservation(
  ctx: CommandContext,
  input: {
    reservationId: string;
    reason: string;
    cancellationFee?: number;
    feeApproved?: boolean;
    now?: Date;
  },
): Promise<{
  reservation_id: string;
  status: "cancelled";
  cancellation_fee: number;
  charge_id: string | null;
}> {
  const now = input.now ?? new Date();
  const res = await lockReservation(ctx, input.reservationId);
  assertBooking(res.status, "cancelled");
  const reason = assertReason(input.reason);
  const fee = input.cancellationFee ?? 0;
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > MAX_FEE)
    throw fieldError("cancellation_fee", "INVALID", "Phí huỷ là số nguyên đồng ≥ 0");
  const items = await loadItems(ctx, res.id, true);
  const stays = await loadStays(
    ctx,
    items.map((i) => i.id),
    true,
  );
  if (fee > 0) {
    if (stays.length === 0)
      throw fieldError("cancellation_fee", "NO_STAY", "Chỉ tính phí huỷ khi booking đã xác nhận");
    if (!input.feeApproved) {
      try {
        authorize(ctx.actor, "reservation.override_price", { propertyId: res.property_id, amount: fee });
      } catch (e) {
        if (e instanceof AuthzError && e.code === "APPROVAL_LIMIT_EXCEEDED") {
          throw approvalRequired(
            ctx.actor,
            {
              kind: "cancellation_fee",
              amount: fee,
              reason,
              propertyId: res.property_id,
              subjectType: "reservation",
              subjectId: res.id,
              payload: { reservation_id: res.id },
            },
            "Phí huỷ vượt hạn mức của bạn. Đã gửi yêu cầu duyệt.",
          );
        }
        throw e;
      }
    }
  }
  await sql`
    update reservations set status = 'cancelled', cancel_reason = ${reason}, cancelled_at = ${now}
    where organization_id = ${ctx.actor.orgId} and id = ${res.id}`.execute(ctx.trx);
  await sql`
    update stays set status = 'cancelled'
    where organization_id = ${ctx.actor.orgId} and status = 'expected' and id = any(${stays.map((s) => s.id)}::uuid[])`.execute(
    ctx.trx,
  );
  // Hold (draft/held: nguồn dòng phòng) và allocation `stay` (confirmed: nguồn lượt ở) — `active=false` cùng transaction.
  await deactivateAllocationsOf(ctx, {
    sourceType: "reservation_item",
    sourceIds: items.map((i) => i.id),
    now,
  });
  await deactivateAllocationsOf(ctx, { sourceType: "stay", sourceIds: stays.map((s) => s.id), now });

  let chargeId: string | null = null;
  if (fee > 0) {
    chargeId = randomUUID();
    const stay = stays[0] as (typeof stays)[number];
    await sql`
      insert into charges (id, organization_id, property_id, source_type, stay_id, kind, revenue_account, description, business_date,
                           quantity, unit_price, amount, created_by, command_id)
      values (${chargeId}, ${ctx.actor.orgId}, ${res.property_id}, 'stay', ${stay.id}, 'fee', 'REV_FEE',
              ${`Phí huỷ đặt phòng ${res.number}`}, ${await businessDateAt(ctx, res.property_id, now)}::date, 1, ${fee}, ${fee},
              ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(ctx.trx);
  }
  await ctx.audit({
    action: "reservation.cancelled",
    entityType: "reservation",
    entityId: res.id,
    propertyId: res.property_id,
    before: { status: res.status },
    after: { status: "cancelled", cancellation_fee: fee, charge_id: chargeId },
    reason,
  });
  await ctx.emit({
    eventType: "reservation.cancelled",
    aggregateType: "reservation",
    aggregateId: res.id,
    propertyId: res.property_id,
    payload: { reservation_id: res.id, cancellation_fee: fee },
  });
  return { reservation_id: res.id, status: "cancelled", cancellation_fee: fee, charge_id: chargeId };
}

let registered = false;

/** Duyệt yêu cầu `cancellation_fee` (vượt hạn mức): người duyệt (đã qua hạn mức) thực hiện huỷ kèm phí — đúng một lần. */
export function registerReservationExecutors(): void {
  if (registered) return;
  registered = true;
  registerApprovalExecutor("cancellation_fee", {
    async execute(ctx, req) {
      return cancelReservation(ctx, {
        reservationId: req.subjectId as string,
        reason: req.reason,
        cancellationFee: req.amount ?? 0,
        feeApproved: true,
      });
    },
  });
}
registerReservationExecutors();

// ---------- reservation.markNoShow ----------

/**
 * `reservation.markNoShow` (S-011, Q-07): thao tác tay, chỉ SAU ngày kinh doanh của ngày đến (qua giờ chốt ngày): trước đó ⇒
 * 409 INVALID_TRANSITION. Một transaction: booking `confirmed → no_show`, lượt ở `expected → no_show`, allocation nhả; ứng trước/cọc giữ
 * nguyên chờ quyết định có duyệt. Lượt ở `no_show` không còn là "khách sắp đến" và không check-in lại được (bảng chuyển).
 */
export async function markNoShow(
  ctx: CommandContext,
  input: { reservationId: string; reason: string; now?: Date },
): Promise<{ reservation_id: string; status: "no_show"; stay_ids: string[] }> {
  const now = input.now ?? new Date();
  const res = await lockReservation(ctx, input.reservationId);
  assertBooking(res.status, "no_show");
  const reason = assertReason(input.reason);
  const items = await loadItems(ctx, res.id, true);
  const stays = await loadStays(
    ctx,
    items.map((i) => i.id),
    true,
  );
  if (stays.length === 0 || stays.some((s) => s.status !== "expected"))
    throw transitionError(res.status, "no_show", "Chỉ đánh dấu no-show khi khách chưa nhận phòng");
  const arrival = items.map((i) => i.arrival_date).sort()[0] as string;
  const today = await businessDateAt(ctx, res.property_id, now);
  if (today <= arrival) {
    throw transitionError(res.status, "no_show", "Chưa qua ngày đến — chưa thể đánh dấu no-show");
  }
  await sql`
    update reservations set status = 'no_show', cancel_reason = ${reason}, cancelled_at = ${now}
    where organization_id = ${ctx.actor.orgId} and id = ${res.id}`.execute(ctx.trx);
  await sql`
    update stays set status = 'no_show' where organization_id = ${ctx.actor.orgId} and id = any(${stays.map((s) => s.id)}::uuid[])`.execute(
    ctx.trx,
  );
  await deactivateAllocationsOf(ctx, { sourceType: "stay", sourceIds: stays.map((s) => s.id), now });
  await ctx.audit({
    action: "reservation.no_show",
    entityType: "reservation",
    entityId: res.id,
    propertyId: res.property_id,
    before: { status: res.status },
    after: { status: "no_show", business_date: today },
    reason,
  });
  await ctx.emit({
    eventType: "reservation.no_show",
    aggregateType: "reservation",
    aggregateId: res.id,
    propertyId: res.property_id,
    payload: { reservation_id: res.id },
  });
  return { reservation_id: res.id, status: "no_show", stay_ids: stays.map((s) => s.id) };
}
