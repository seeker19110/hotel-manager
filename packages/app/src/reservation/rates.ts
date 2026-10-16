// Bảng giá phòng và báo giá lưu trú (PLAN đợt 3 T-203; SPEC-reservation-stay §5 `rate.set`, `reservation.quote`, S-001, S-002,
// S-021; ERD `rate_plans`). Engine báo giá thuần ở `@hm/domain` (`quoteStay`) — ở đây chỉ đọc/ghi bảng và ánh xạ lỗi.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import {
  authorize,
  DEFAULT_WEEKEND_NIGHTS,
  type NightlyRate,
  type Quote,
  quoteStay,
  RateError,
  type RatePlan,
} from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Trần giá một đêm: số nguyên an toàn của JS (khớp CHECK của cột bigint). */
const MAX_PRICE = Number.MAX_SAFE_INTEGER;
/** Ngày hiệu lực hợp lý (chặn nhập nhầm năm). */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

export function assertDate(d: string, field: string): void {
  const t = new Date(`${d}T00:00:00Z`);
  if (!DATE.test(d) || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) {
    throw fieldError(field, "INVALID_DATE", `${field}: ngày không hợp lệ (YYYY-MM-DD)`);
  }
}

function assertPrice(v: number, field: string): void {
  if (!Number.isSafeInteger(v) || v <= 0 || v > MAX_PRICE) {
    throw fieldError(field, "INVALID", `${field}: giá một đêm là số nguyên đồng > 0`);
  }
}

/** Tập đêm cuối tuần: 1..7 số nguyên 0..6 (0 = Chủ nhật), không trùng — cùng luật với CHECK ở CSDL. */
function assertWeekendNights(w: readonly number[]): void {
  if (
    w.length < 1 ||
    w.length > 7 ||
    w.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
    new Set(w).size !== w.length
  ) {
    throw fieldError(
      "weekend_nights",
      "INVALID",
      "weekend_nights: 1–7 số nguyên không trùng trong 0..6 (0 = Chủ nhật … 6 = thứ Bảy)",
    );
  }
}

interface PlanRow {
  id: string;
  weekday_price: string;
  weekend_price: string;
  weekend_nights: number[];
  effective_from: string;
  effective_to: string | null;
}

function toRatePlan(r: PlanRow): RatePlan {
  return {
    id: r.id,
    weekdayPrice: Number(r.weekday_price),
    weekendPrice: Number(r.weekend_price),
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    weekendNights: r.weekend_nights,
  };
}

// ---------- rate.set ----------

export interface SetRatePlanInput {
  roomTypeId: string;
  weekdayPrice: number;
  weekendPrice: number;
  /** Ngày kinh doanh bắt đầu áp giá mới. */
  effectiveFrom: string;
  /** Bỏ trống → kế thừa tập đêm cuối tuần của bản gần nhất, chưa có bản nào thì `{5,6}` (Q-03, D-006). */
  weekendNights?: readonly number[];
  /** Thời điểm hiện tại (kiểm thử); mặc định đồng hồ máy. */
  now?: Date;
}

/**
 * `rate.set`: owner đặt giá cho một loại phòng từ ngày X. Một transaction: đóng bản đang mở (`effective_to = X − 1`) rồi thêm bản
 * mới mở cuối. Lịch sử chỉ nối thêm (bản cũ không bị sửa giá — INV-G3; booking đã giữ dùng snapshot nên không bị ảnh hưởng, S-021).
 *
 * Quy tắc khi đã có bản giá (SPEC không nói rõ — chọn cách chặt, 422 `effective_from`):
 *  - `NOT_AFTER_CURRENT`: X phải SAU ngày bắt đầu của bản gần nhất (không chèn vào giữa lịch sử, không ghi đè bản đã lập);
 *  - `IN_THE_PAST`: X không được trước ngày kinh doanh hiện tại của cơ sở (không đổi giá hồi tố các đêm đã qua).
 * Loại phòng chưa có bản nào: X tuỳ ý (lập bản đầu).
 */
export async function setRatePlan(
  ctx: CommandContext,
  input: SetRatePlanInput,
): Promise<{ ratePlanId: string; closedRatePlanId: string | null }> {
  if (!UUID.test(input.roomTypeId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy loại phòng");
  // Khoá hàng loại phòng: hai `rate.set` cùng loại phòng chạy lần lượt, không đóng/mở chéo nhau.
  const rt = await sql<{ property_id: string }>`
    select property_id from room_types
    where organization_id = ${ctx.actor.orgId} and id = ${input.roomTypeId} and archived_at is null
    for no key update`.execute(ctx.trx);
  const roomType = rt.rows[0];
  if (!roomType) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy loại phòng");
  authorize(ctx.actor, "pricing.manage", { propertyId: roomType.property_id });

  assertDate(input.effectiveFrom, "effective_from");
  const year = Number(input.effectiveFrom.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw fieldError("effective_from", "OUT_OF_RANGE", `effective_from: năm trong ${MIN_YEAR}..${MAX_YEAR}`);
  }
  assertPrice(input.weekdayPrice, "weekday_price");
  assertPrice(input.weekendPrice, "weekend_price");
  if (input.weekendNights) assertWeekendNights(input.weekendNights);

  const latestRes = await sql<PlanRow>`
    select id, weekday_price::text, weekend_price::text, weekend_nights, effective_from::text, effective_to::text
    from rate_plans where organization_id = ${ctx.actor.orgId} and room_type_id = ${input.roomTypeId}
    order by effective_from desc limit 1`.execute(ctx.trx);
  const latest = latestRes.rows[0];

  if (latest) {
    if (input.effectiveFrom <= latest.effective_from) {
      throw fieldError(
        "effective_from",
        "NOT_AFTER_CURRENT",
        `Ngày hiệu lực phải sau ngày bắt đầu của bản giá gần nhất (${latest.effective_from})`,
      );
    }
    const today = await sql<{ d: string }>`
      select app.business_date(${ctx.actor.orgId}, ${roomType.property_id}, ${input.now ?? new Date()}::timestamptz)::text as d`.execute(
      ctx.trx,
    );
    const businessToday = today.rows[0]?.d;
    if (businessToday && input.effectiveFrom < businessToday) {
      throw fieldError(
        "effective_from",
        "IN_THE_PAST",
        `Không đổi giá hồi tố: ngày hiệu lực phải từ ngày kinh doanh hiện tại (${businessToday}) trở đi`,
      );
    }
  }

  const weekendNights = [...(input.weekendNights ?? latest?.weekend_nights ?? DEFAULT_WEEKEND_NIGHTS)].sort(
    (a, b) => a - b,
  );

  let closedId: string | null = null;
  if (latest && latest.effective_to === null) {
    await sql`
      update rate_plans set effective_to = ${input.effectiveFrom}::date - 1
      where organization_id = ${ctx.actor.orgId} and id = ${latest.id} and effective_to is null`.execute(
      ctx.trx,
    );
    closedId = latest.id;
  }

  const id = randomUUID();
  try {
    await sql`savepoint set_rate`.execute(ctx.trx);
    await sql`
      insert into rate_plans (id, organization_id, property_id, room_type_id, weekday_price, weekend_price, weekend_nights,
                              effective_from, created_by)
      values (${id}, ${ctx.actor.orgId}, ${roomType.property_id}, ${input.roomTypeId}, ${input.weekdayPrice}, ${input.weekendPrice},
              ${weekendNights}::smallint[], ${input.effectiveFrom}::date, ${ctx.actor.membershipId})`.execute(
      ctx.trx,
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23P01")
      throw fieldError("effective_from", "OVERLAP", "Trùng hiệu lực với bản giá khác của loại phòng");
    throw e;
  }
  await ctx.audit({
    action: "rate_plan.set",
    entityType: "rate_plan",
    entityId: id,
    propertyId: roomType.property_id,
    before: latest
      ? {
          rate_plan_id: latest.id,
          weekday_price: Number(latest.weekday_price),
          weekend_price: Number(latest.weekend_price),
          effective_from: latest.effective_from,
        }
      : null,
    after: {
      room_type_id: input.roomTypeId,
      weekday_price: input.weekdayPrice,
      weekend_price: input.weekendPrice,
      weekend_nights: weekendNights,
      effective_from: input.effectiveFrom,
      closed_rate_plan_id: closedId,
    },
  });
  return { ratePlanId: id, closedRatePlanId: closedId };
}

// ---------- báo giá ----------

/** Bản giá của một loại phòng có hiệu lực chồng khoảng đêm `[arrival, departure)`. */
export async function loadRatePlans(
  trx: Transaction<unknown>,
  orgId: string,
  roomTypeId: string,
  arrivalDate: string,
  departureDate: string,
): Promise<RatePlan[]> {
  const r = await sql<PlanRow>`
    select id, weekday_price::text, weekend_price::text, weekend_nights, effective_from::text, effective_to::text
    from rate_plans
    where organization_id = ${orgId} and room_type_id = ${roomTypeId}
      and effective_from < ${departureDate}::date and (effective_to is null or effective_to >= ${arrivalDate}::date)
    order by effective_from`.execute(trx);
  return r.rows.map(toRatePlan);
}

const RATE_FIELD: Record<RateError["reason"], string> = {
  INVALID_DATE: "arrival_date",
  DEPARTURE_NOT_AFTER_ARRIVAL: "departure_date",
  STAY_TOO_LONG: "departure_date",
  NO_RATE_FOR_NIGHT: "room_type_id",
  AMBIGUOUS_RATE: "room_type_id",
  INVALID_RATE_PLAN: "room_type_id",
  INVALID_WEEKEND_NIGHTS: "room_type_id",
  INVALID_LIMIT: "max_nights",
};

/**
 * Lỗi engine → lỗi API: đêm không có giá = 422 `RATE_NOT_CONFIGURED` (SPEC-reservation §6); còn lại 422 `VALIDATION_FAILED`
 * kèm trường sai (ngày đi ≤ ngày đến → `departure_date`).
 */
export function rateErrorToCommandError(e: RateError): CommandError {
  if (e.reason === "NO_RATE_FOR_NIGHT") {
    return new CommandError("RATE_NOT_CONFIGURED", 422, "Chưa cấu hình giá cho loại phòng này.", {
      extensions: { errors: [{ path: "room_type_id", field: "room_type_id", code: e.reason }] },
    });
  }
  return fieldError(RATE_FIELD[e.reason], e.reason, e.message);
}

export interface QuoteRoomTypeInput {
  orgId: string;
  roomTypeId: string;
  arrivalDate: string;
  departureDate: string;
  /** Giá đã chốt theo đêm (snapshot booking): đêm nào có ở đây giữ nguyên, đêm khác tra bảng giá (S-008, S-021). */
  nightlyRates?: readonly NightlyRate[];
  maxNights?: number;
}

/**
 * Báo giá một loại phòng trong transaction của bên gọi (dùng lại cho `reservation.create`/đổi ngày — T-204). KHÔNG kiểm
 * quyền: bên gọi đã `authorize`. Lỗi engine → `CommandError` 422.
 */
export async function quoteRoomType(trx: Transaction<unknown>, input: QuoteRoomTypeInput): Promise<Quote> {
  assertDate(input.arrivalDate, "arrival_date");
  assertDate(input.departureDate, "departure_date");
  // Ngày đi ≤ ngày đến báo lỗi trước khi đọc bảng giá.
  const plans =
    input.departureDate > input.arrivalDate
      ? await loadRatePlans(trx, input.orgId, input.roomTypeId, input.arrivalDate, input.departureDate)
      : [];
  try {
    return quoteStay({
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      ratePlans: plans,
      ...(input.nightlyRates ? { nightlyRates: input.nightlyRates } : {}),
      ...(input.maxNights === undefined ? {} : { maxNights: input.maxNights }),
    });
  } catch (e) {
    if (e instanceof RateError) throw rateErrorToCommandError(e);
    throw e;
  }
}

export interface QuoteView {
  room_type_id: string;
  property_id: string;
  arrival_date: string;
  departure_date: string;
  /** Số đêm. */
  nights: number;
  /** Giá từng đêm (ảnh chụp để lưu `reservation_items.nightly_prices`). */
  nightly_prices: {
    business_date: string;
    day_kind: "weekday" | "weekend";
    amount: number;
    rate_plan_id: string | null;
  }[];
  /** Σ giá các đêm (đồng). */
  room_total: number;
  currency: "VND";
}

/**
 * `reservation.quote` (query): báo giá theo loại phòng và ngày đến/đi (ngày kinh doanh của đêm đầu / ngày đi). Quyền
 * `reservation.manage` (owner/manager/front_desk) trong phạm vi cơ sở; loại phòng của tổ chức khác → 404.
 */
export async function quoteReservation(
  db: Kysely<unknown>,
  actor: Actor,
  input: { roomTypeId: string; arrivalDate: string; departureDate: string },
): Promise<QuoteView> {
  if (!UUID.test(input.roomTypeId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy loại phòng");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const rt = await sql<{ property_id: string }>`
      select property_id from room_types
      where organization_id = ${actor.orgId} and id = ${input.roomTypeId} and archived_at is null`.execute(
      trx,
    );
    const roomType = rt.rows[0];
    if (!roomType) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy loại phòng");
    authorize(actor, "reservation.manage", { propertyId: roomType.property_id });
    const q = await quoteRoomType(trx, {
      orgId: actor.orgId,
      roomTypeId: input.roomTypeId,
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
    });
    return {
      room_type_id: input.roomTypeId,
      property_id: roomType.property_id,
      arrival_date: q.arrivalDate,
      departure_date: q.departureDate,
      nights: q.nightCount,
      nightly_prices: q.nights.map((n) => ({
        business_date: n.businessDate,
        day_kind: n.dayKind,
        amount: n.amount,
        rate_plan_id: n.ratePlanId ?? null,
      })),
      room_total: q.total,
      currency: "VND",
    };
  });
}
