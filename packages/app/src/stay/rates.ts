// Loại phòng, bảng giá và báo giá khách sạn (SPEC-reservation-stay S-001, S-002, S-014, S-021; ERD `rate_plans`). Giá tính
// bằng hàm thuần `@hm/domain` (đêm theo ngày kinh doanh, cuối tuần theo tham số cơ sở); app chỉ đọc dữ liệu và kiểm quyền.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import {
  authorize,
  maxNightsSetting,
  type NightPrice,
  nightsOf,
  priceNights,
  QuoteRuleError,
  type RateVersion,
  sumNights,
  weekendNightsSetting,
} from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/index.ts";
import { type CommandContext, CommandError } from "../pipeline/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StaySettings {
  propertyId: string;
  template: string;
  timezone: string;
  checkInTime: string;
  checkOutTime: string;
  weekendNights: readonly number[];
  maxNights: number;
  holdTtlMinutes: number;
  requireInspected: boolean;
  confirmWithoutPayment: boolean;
}

/** Tham số lưu trú của cơ sở (PLAN đợt 3 bảng quyết định: nhận 14:00 / trả 12:00 khi chưa đặt). */
export async function staySettings(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
): Promise<StaySettings> {
  if (!UUID.test(propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  const r = await sql<{
    template: string;
    timezone: string;
    check_in: string | null;
    check_out: string | null;
    hold_ttl_minutes: number;
    require_inspected: boolean;
    settings: Record<string, unknown>;
  }>`
    select template, timezone, check_in_time::text as check_in, check_out_time::text as check_out, hold_ttl_minutes,
           require_inspected, settings
    from properties where organization_id = ${orgId} and id = ${propertyId} and archived_at is null`.execute(
    trx,
  );
  const p = r.rows[0];
  if (!p) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  return {
    propertyId,
    template: p.template,
    timezone: p.timezone,
    checkInTime: (p.check_in ?? "14:00:00").slice(0, 8),
    checkOutTime: (p.check_out ?? "12:00:00").slice(0, 8),
    weekendNights: weekendNightsSetting(p.settings.weekend_nights),
    maxNights: maxNightsSetting(p.settings.max_nights),
    holdTtlMinutes: p.hold_ttl_minutes,
    requireInspected: p.require_inspected,
    confirmWithoutPayment: p.settings.confirm_without_payment !== false,
  };
}

/** Chính sách đang áp dụng, snapshot vào booking (Q-04: không phạt tự động; phí huỷ nhập tay trong hạn mức). */
export function currentPolicy(s: StaySettings) {
  return {
    cancellation: "no_automatic_penalty",
    cancellation_fee: "manual_within_limit",
    advance_and_deposit_not_revenue: true,
    check_in_time: s.checkInTime.slice(0, 5),
    check_out_time: s.checkOutTime.slice(0, 5),
    weekend_nights: [...s.weekendNights],
  } as const;
}

function validation(path: string, code: string, message: string): CommandError {
  return new CommandError("VALIDATION_FAILED", 422, message, {
    extensions: { errors: [{ path, field: path, code }] },
  });
}

/** Dịch lỗi quy tắc giá thuần sang mã API. */
export function quoteProblem(e: unknown): never {
  if (e instanceof QuoteRuleError) {
    const d = e.detail;
    if (d.code === "RATE_NOT_CONFIGURED")
      throw new CommandError("RATE_NOT_CONFIGURED", 422, "Chưa cấu hình giá cho loại phòng này", {
        extensions: { items: [{ business_date: d.businessDate }] },
      });
    if (d.code === "MAX_NIGHTS_EXCEEDED")
      throw validation("departure_date", "max_nights", `Tối đa ${d.maxNights} đêm cho một booking`);
    throw validation(
      "departure_date",
      d.reason,
      d.reason === "invalid_date" ? "Ngày không hợp lệ" : "Ngày đi phải sau ngày đến",
    );
  }
  throw e;
}

export async function loadRates(
  trx: Transaction<unknown>,
  orgId: string,
  roomTypeId: string,
): Promise<RateVersion[]> {
  const r = await sql<{ f: string; t: string | null; wd: string; we: string }>`
    select effective_from::text as f, effective_to::text as t, weekday_price::text as wd, weekend_price::text as we
    from rate_plans where organization_id = ${orgId} and room_type_id = ${roomTypeId} order by effective_from`.execute(
    trx,
  );
  return r.rows.map((x) => ({
    effectiveFrom: x.f,
    effectiveTo: x.t,
    weekdayPrice: Number(x.wd),
    weekendPrice: Number(x.we),
  }));
}

interface RoomTypeRow {
  id: string;
  property_id: string;
  capacity: number;
}

async function roomTypeOf(
  trx: Transaction<unknown>,
  orgId: string,
  by: { roomTypeId?: string; unitId?: string },
): Promise<RoomTypeRow & { unit_id: string | null }> {
  const id = by.unitId ?? by.roomTypeId;
  if (!id || !UUID.test(id)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng/loại phòng");
  const r = by.unitId
    ? await sql<RoomTypeRow & { unit_id: string | null }>`
        select rt.id, rt.property_id, rt.capacity, u.id as unit_id from units u
        join room_types rt on rt.organization_id = u.organization_id and rt.id = u.room_type_id
        where u.organization_id = ${orgId} and u.id = ${by.unitId} and u.archived_at is null`.execute(trx)
    : await sql<RoomTypeRow & { unit_id: string | null }>`
        select id, property_id, capacity, null::uuid as unit_id from room_types
        where organization_id = ${orgId} and id = ${by.roomTypeId} and archived_at is null`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng/loại phòng");
  return row;
}

export function assertCapacity(guests: number, capacity: number): void {
  if (!Number.isInteger(guests) || guests < 1) throw validation("guests", "too_small", "Số khách phải ≥ 1");
  if (guests > capacity)
    throw new CommandError("CAPACITY_EXCEEDED", 422, "Số khách vượt sức chứa của phòng", {
      extensions: { items: [{ capacity }] },
    });
}

export interface Quote {
  roomTypeId: string;
  propertyId: string;
  nights: number;
  nightlyPrices: NightPrice[];
  roomTotal: number;
  policy: ReturnType<typeof currentPolicy>;
}

/** Báo giá trong một transaction có sẵn (dùng lại khi tạo booking: cùng phép tính, cùng snapshot). */
export async function quoteIn(
  trx: Transaction<unknown>,
  actor: Actor,
  input: { roomTypeId?: string; unitId?: string; arrivalDate: string; departureDate: string; guests: number },
): Promise<Quote & { unitId: string | null; capacity: number }> {
  const rt = await roomTypeOf(trx, actor.orgId, input);
  authorize(actor, "reservation.manage", { propertyId: rt.property_id });
  assertCapacity(input.guests, rt.capacity);
  const s = await staySettings(trx, actor.orgId, rt.property_id);
  try {
    const nightlyPrices = priceNights(
      nightsOf(input.arrivalDate, input.departureDate, s.maxNights),
      await loadRates(trx, actor.orgId, rt.id),
      s.weekendNights,
    );
    return {
      roomTypeId: rt.id,
      propertyId: rt.property_id,
      unitId: rt.unit_id,
      capacity: rt.capacity,
      nights: nightlyPrices.length,
      nightlyPrices,
      roomTotal: sumNights(nightlyPrices),
      policy: currentPolicy(s),
    };
  } catch (e) {
    return quoteProblem(e);
  }
}

/** `reservation.quote` (query, S-001/S-002/S-014). */
export async function quote(
  db: Kysely<unknown>,
  actor: Actor,
  input: { roomTypeId?: string; unitId?: string; arrivalDate: string; departureDate: string; guests: number },
): Promise<Quote> {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const { unitId: _u, capacity: _c, ...q } = await quoteIn(trx, actor, input);
    return q;
  });
}

/** `room_type.create` — owner (ma trận "Loại phòng, bảng giá"). Mã trùng trong cơ sở → 422. */
export async function createRoomType(
  ctx: CommandContext,
  input: { propertyId: string; code: string; name: string; capacity: number },
): Promise<{ roomTypeId: string }> {
  authorize(ctx.actor, "pricing.manage", { propertyId: input.propertyId });
  await staySettings(ctx.trx, ctx.actor.orgId, input.propertyId);
  const id = randomUUID();
  try {
    await sql`savepoint room_type_insert`.execute(ctx.trx);
    await sql`
      insert into room_types (id, organization_id, property_id, code, name, capacity)
      values (${id}, ${ctx.actor.orgId}, ${input.propertyId}, ${input.code.trim()}, ${input.name.trim()}, ${input.capacity})`.execute(
      ctx.trx,
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw validation("code", "duplicate", "Mã loại phòng đã có trong cơ sở");
    throw e;
  }
  await ctx.audit({
    action: "room_type.created",
    entityType: "room_type",
    entityId: id,
    propertyId: input.propertyId,
    after: { code: input.code, capacity: input.capacity },
  });
  return { roomTypeId: id };
}

/** `room_type.update` — đổi tên/sức chứa (không đổi booking đã có: sức chứa kiểm lúc tạo/check-in). */
export async function updateRoomType(
  ctx: CommandContext,
  input: { roomTypeId: string; name?: string; capacity?: number },
): Promise<{ roomTypeId: string }> {
  const rt = await roomTypeOf(ctx.trx, ctx.actor.orgId, { roomTypeId: input.roomTypeId });
  authorize(ctx.actor, "pricing.manage", { propertyId: rt.property_id });
  const before = await sql<{ name: string; capacity: number }>`
    select name, capacity from room_types where organization_id = ${ctx.actor.orgId} and id = ${rt.id} for update`.execute(
    ctx.trx,
  );
  await sql`
    update room_types set name = coalesce(${input.name?.trim() ?? null}, name),
                          capacity = coalesce(${input.capacity ?? null}::int, capacity), version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${rt.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "room_type.updated",
    entityType: "room_type",
    entityId: rt.id,
    propertyId: rt.property_id,
    before: before.rows[0],
    after: { name: input.name, capacity: input.capacity },
  });
  return { roomTypeId: rt.id };
}

/**
 * `rate.set` (owner): giá áp từ `effective_from` (mặc định hôm nay theo ngày kinh doanh). Bản đang mở bắt đầu trước ngày đó
 * → đóng ở ngày trước rồi thêm bản mới (giữ lịch sử); cùng ngày bắt đầu → sửa giá bản đó; lùi về trước bản đang mở → 422.
 * Booking đã giữ không đổi (snapshot — S-021).
 */
export async function setRate(
  ctx: CommandContext,
  input: { roomTypeId: string; weekdayPrice: number; weekendPrice: number; effectiveFrom?: string },
): Promise<{ ratePlanId: string; effectiveFrom: string }> {
  const rt = await roomTypeOf(ctx.trx, ctx.actor.orgId, { roomTypeId: input.roomTypeId });
  authorize(ctx.actor, "pricing.manage", { propertyId: rt.property_id });
  for (const [k, v] of [
    ["weekday_price", input.weekdayPrice],
    ["weekend_price", input.weekendPrice],
  ] as const) {
    if (!Number.isSafeInteger(v) || v <= 0)
      throw validation(k, "positive_integer", "Giá phải là số nguyên đồng > 0");
  }
  const today = await sql<{
    d: string;
  }>`select app.business_date(${ctx.actor.orgId}, ${rt.property_id})::text as d`.execute(ctx.trx);
  const from = input.effectiveFrom ?? (today.rows[0]?.d as string);
  const open = await sql<{ id: string; f: string; wd: string; we: string }>`
    select id, effective_from::text as f, weekday_price::text as wd, weekend_price::text as we from rate_plans
    where organization_id = ${ctx.actor.orgId} and room_type_id = ${rt.id} and effective_to is null for update`.execute(
    ctx.trx,
  );
  const cur = open.rows[0];
  let id: string;
  if (cur && cur.f === from) {
    id = cur.id;
    await sql`update rate_plans set weekday_price = ${input.weekdayPrice}, weekend_price = ${input.weekendPrice},
                     version = version + 1 where organization_id = ${ctx.actor.orgId} and id = ${cur.id}`.execute(
      ctx.trx,
    );
  } else {
    if (cur && cur.f > from)
      throw validation(
        "effective_from",
        "before_current",
        "Ngày hiệu lực phải sau ngày bắt đầu của bảng giá hiện hành",
      );
    if (cur) {
      await sql`update rate_plans set effective_to = ${from}::date - 1, version = version + 1
                where organization_id = ${ctx.actor.orgId} and id = ${cur.id}`.execute(ctx.trx);
    }
    id = randomUUID();
    await sql`
      insert into rate_plans (id, organization_id, property_id, room_type_id, weekday_price, weekend_price, effective_from, created_by)
      values (${id}, ${ctx.actor.orgId}, ${rt.property_id}, ${rt.id}, ${input.weekdayPrice}, ${input.weekendPrice}, ${from}::date,
              ${ctx.actor.membershipId})`.execute(ctx.trx);
  }
  await ctx.audit({
    action: "rate.set",
    entityType: "rate_plan",
    entityId: id,
    propertyId: rt.property_id,
    ...(cur
      ? { before: { weekday_price: Number(cur.wd), weekend_price: Number(cur.we), effective_from: cur.f } }
      : {}),
    after: { weekday_price: input.weekdayPrice, weekend_price: input.weekendPrice, effective_from: from },
  });
  return { ratePlanId: id, effectiveFrom: from };
}
