// Nhận phòng (SPEC-reservation-stay S-012…S-016, S-030; Q-08, Q-11, Q-13 — D-002/D-004). Một transaction: khoá booking → kiểm
// phòng sẵn sàng/không còn khách → ghi khách + giấy tờ (số mã hoá) → phí phòng mỗi đêm (unique stay + ngày kinh doanh) →
// `residence_notices` pending (hạn theo cấu hình cơ sở, không mặc định cứng) → stay/booking `in_house`. Walk-in: một command
// khởi tạo thẳng `in_house`, không qua draft/held/confirmed/expected.
import { randomUUID } from "node:crypto";
import {
  authorize,
  type NightPrice,
  nightsOf,
  parseStayNoticeDeadline,
  priceNights,
  stayMachine,
  stayNoticeDueLocal,
  sumNights,
} from "@hm/domain";
import { sql, type Transaction } from "kysely";
import type { PiiCipher } from "../crypto/index.ts";
import { type DocType, recordIdentityDocument } from "../identity/index.ts";
import { confirmHold, createHold } from "../inventory/index.ts";
import { type CommandContext, CommandError } from "../pipeline/index.ts";
import { assertCapacity, loadRates, quoteProblem, staySettings } from "./rates.ts";
import { readReservation, resolveBooker } from "./reservations.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GuestInput {
  personId?: string;
  fullName?: string;
  phone?: string;
  email?: string;
  docType: DocType;
  docNumber: string;
  /** ISO 3166-1 alpha-2; khác "VN" = khách nước ngoài (bắt buộc hộ chiếu). */
  nationality?: string;
}

function fieldError(path: string, code: string, message: string): CommandError {
  return new CommandError("VALIDATION_FAILED", 422, message, {
    extensions: { errors: [{ path, field: path, code }] },
  });
}

/** Phòng sẵn sàng (S-013): bẩn/đang dọn → ROOM_NOT_READY; `clean` chưa kiểm chỉ được khi cơ sở không bắt buộc kiểm. */
async function assertRoomReady(
  ctx: CommandContext,
  unitId: string,
  requireInspected: boolean,
  exceptStayId: string | null,
): Promise<void> {
  const u = await sql<{ housekeeping_status: string; availability: string }>`
    select housekeeping_status, availability from units where organization_id = ${ctx.actor.orgId} and id = ${unitId} for update`.execute(
    ctx.trx,
  );
  const unit = u.rows[0];
  if (!unit) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  const occupied = await sql<{ id: string }>`
    select id from stays where organization_id = ${ctx.actor.orgId} and unit_id = ${unitId} and status = 'in_house'
      ${exceptStayId ? sql`and id <> ${exceptStayId}` : sql``} limit 1`.execute(ctx.trx);
  if (occupied.rows[0]) throw new CommandError("ROOM_OCCUPIED", 409, "Phòng vẫn còn khách chưa trả.");
  if (unit.availability !== "active")
    throw new CommandError("UNIT_OUT_OF_SERVICE", 409, "Phòng đang ngừng khai thác");
  const ready =
    unit.housekeeping_status === "inspected" || (!requireInspected && unit.housekeeping_status === "clean");
  if (!ready)
    throw new CommandError("ROOM_NOT_READY", 409, "Phòng chưa dọn xong, chưa thể nhận khách.", {
      extensions: { items: [{ housekeeping_status: unit.housekeeping_status }] },
    });
}

interface RecordedGuests {
  primaryPersonId: string;
  additionalPersonIds: string[];
  isForeign: boolean;
}

/** Ghi khách (Q-08): mọi khách cần họ tên + giấy tờ; khách chính cần SĐT; nước ngoài cần quốc tịch + hộ chiếu. */
async function recordGuests(
  ctx: CommandContext,
  pii: PiiCipher,
  propertyId: string,
  guests: readonly GuestInput[],
  fallbackPrimary: string | null,
): Promise<RecordedGuests> {
  if (guests.length < 1) throw fieldError("guests", "required", "Cần thông tin ít nhất một khách");
  const ids: string[] = [];
  let isForeign = false;
  for (const [i, g] of guests.entries()) {
    const path = `guests.${i}`;
    const given = g.nationality?.trim().toUpperCase() || null;
    if (given !== null && !/^[A-Z]{2}$/.test(given))
      throw fieldError(`${path}.nationality`, "invalid", "Quốc tịch phải là mã ISO 2 chữ cái");
    let personId: string;
    if (g.personId) {
      personId = await resolveBooker(ctx, { personId: g.personId }, path);
    } else if (i === 0 && fallbackPrimary && !g.fullName) {
      personId = fallbackPrimary;
    } else {
      if (!g.fullName?.trim()) throw fieldError(`${path}.full_name`, "required", "Cần họ tên khách");
      if (i === 0 && !g.phone?.trim())
        throw fieldError(`${path}.phone`, "required", "Khách chính cần số điện thoại");
      personId = g.phone?.trim()
        ? await resolveBooker(
            ctx,
            { fullName: g.fullName, phone: g.phone, ...(g.email ? { email: g.email } : {}) },
            path,
          )
        : await createGuestWithoutPhone(ctx, g.fullName, path);
    }
    // Không gửi quốc tịch → dùng giá trị đã lưu của người đó; chỉ người chưa có mới mặc định VN (không ghi đè khách nước
    // ngoài thành VN — sai hạn thông báo lưu trú).
    const stored = await sql<{ nationality: string | null }>`
      select nationality from persons where organization_id = ${ctx.actor.orgId} and id = ${personId}`.execute(
      ctx.trx,
    );
    const nationality = given ?? stored.rows[0]?.nationality ?? "VN";
    if (nationality !== "VN") {
      isForeign = true;
      if (g.docType !== "passport")
        throw fieldError(`${path}.doc_type`, "passport_required", "Khách nước ngoài cần hộ chiếu");
    }
    if (nationality !== stored.rows[0]?.nationality)
      await sql`update persons set nationality = ${nationality}, version = version + 1
                where organization_id = ${ctx.actor.orgId} and id = ${personId}`.execute(ctx.trx);
    await recordIdentityDocument(
      ctx,
      pii,
      { personId, propertyId, docType: g.docType, docNumber: g.docNumber, nationality },
      `${path}.doc_number`,
    );
    if (ids.includes(personId)) throw fieldError(`${path}.person_id`, "duplicate", "Khách bị lặp");
    ids.push(personId);
  }
  return { primaryPersonId: ids[0] as string, additionalPersonIds: ids.slice(1), isForeign };
}

async function createGuestWithoutPhone(ctx: CommandContext, fullName: string, path: string): Promise<string> {
  const name = fullName.trim();
  if (name.length > 200) throw fieldError(`${path}.full_name`, "too_long", "Họ tên tối đa 200 ký tự");
  const id = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${id}, ${ctx.actor.orgId}, ${name})`.execute(
    ctx.trx,
  );
  await ctx.audit({ action: "person.created", entityType: "person", entityId: id });
  return id;
}

/** Phí phòng mỗi đêm theo snapshot (Q-11): unique (stay, business_date) ở CSDL — không ghi một đêm hai lần (S-016). */
async function postRoomCharges(
  ctx: CommandContext,
  propertyId: string,
  stayId: string,
  unitCode: string,
  prices: readonly NightPrice[],
): Promise<void> {
  for (const p of prices) {
    await sql`
      insert into charges (id, organization_id, property_id, source_type, stay_id, kind, revenue_account, description,
                           business_date, quantity, unit_price, amount, created_by, command_id)
      values (${randomUUID()}, ${ctx.actor.orgId}, ${propertyId}, 'stay', ${stayId}, 'room', 'REV_ROOM',
              ${`Tiền phòng ${unitCode} đêm ${p.businessDate}`}, ${p.businessDate}::date, 1, ${p.amount}, ${p.amount},
              ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(ctx.trx);
  }
}

/** `residence_notices` pending cùng transaction (S-012, S-030); `due_at` theo cấu hình cơ sở (NULL = chưa cấu hình). */
async function createResidenceNotice(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
  stayId: string,
  isForeign: boolean,
  checkedInAt: Date,
): Promise<{ noticeId: string; dueAt: Date | null }> {
  const cfg = await sql<{ d: unknown; tz: string; local: string }>`
    select ns.stay_notice_deadline as d, p.timezone as tz,
           to_char(${checkedInAt}::timestamptz at time zone p.timezone, 'YYYY-MM-DD"T"HH24:MI') as local
    from properties p left join notification_settings ns on ns.organization_id = p.organization_id and ns.property_id = p.id
    where p.organization_id = ${orgId} and p.id = ${propertyId}`.execute(trx);
  const row = cfg.rows[0] as { d: unknown; tz: string; local: string };
  const dueLocal = stayNoticeDueLocal(row.local, isForeign, parseStayNoticeDeadline(row.d));
  let dueAt: Date | null = null;
  if (dueLocal) {
    const r = await sql<{ t: Date }>`select (${dueLocal}::timestamp at time zone ${row.tz}) as t`.execute(
      trx,
    );
    dueAt = r.rows[0]?.t ?? null;
  }
  const noticeId = randomUUID();
  await sql`insert into residence_notices (id, organization_id, property_id, stay_id, status, is_foreign, due_at)
            values (${noticeId}, ${orgId}, ${propertyId}, ${stayId}, 'pending', ${isForeign}, ${dueAt})`.execute(
    trx,
  );
  return { noticeId, dueAt };
}

async function unitCode(ctx: CommandContext, unitId: string): Promise<string> {
  const r = await sql<{
    code: string;
  }>`select code from units where organization_id = ${ctx.actor.orgId} and id = ${unitId}`.execute(ctx.trx);
  return r.rows[0]?.code ?? "";
}

async function businessDateAt(ctx: CommandContext, propertyId: string, at: Date): Promise<string> {
  const r = await sql<{
    d: string;
  }>`select app.business_date(${ctx.actor.orgId}, ${propertyId}, ${at})::text as d`.execute(ctx.trx);
  return r.rows[0]?.d as string;
}

export interface CheckInResult {
  stayId: string;
  reservationId: string;
  noticeId: string;
  noticeDueAt: Date | null;
  checkedInAt: Date;
}

/**
 * `stay.checkIn` (S-012…S-014): booking `confirmed` + stay `expected` → `in_house`. Chỉ trong khoảng [ngày đến, ngày đi) theo
 * ngày kinh doanh; booking draft/no_show/… → INVALID_TRANSITION (S-010, S-011).
 */
export async function checkIn(
  ctx: CommandContext,
  pii: PiiCipher,
  input: { reservationId: string; guests: readonly GuestInput[]; now?: Date },
): Promise<CheckInResult> {
  const now = input.now ?? new Date();
  const row = await readReservation(ctx.trx, ctx.actor, input.reservationId, true);
  authorize(ctx.actor, "reservation.manage", { propertyId: row.property_id });
  if (row.status !== "confirmed" || !row.stay_id || row.stay_status !== "expected") {
    throw new CommandError("INVALID_TRANSITION", 409, "Thao tác không hợp lệ với trạng thái hiện tại.", {
      extensions: { from: row.stay_status ?? row.status, to: "in_house" },
    });
  }
  stayMachine.assertTransition("expected", "in_house");
  const today = await businessDateAt(ctx, row.property_id, now);
  if (today < row.arrival_date || today >= row.departure_date) {
    throw new CommandError("INVALID_TRANSITION", 409, "Chỉ nhận phòng trong khoảng ngày của booking", {
      extensions: { from: "expected", to: "in_house" },
    });
  }
  const capacity = await sql<{ capacity: number }>`
    select capacity from room_types where organization_id = ${ctx.actor.orgId} and id = ${row.room_type_id}`.execute(
    ctx.trx,
  );
  assertCapacity(input.guests.length, capacity.rows[0]?.capacity ?? 0);
  const s = await staySettings(ctx.trx, ctx.actor.orgId, row.property_id);
  await assertRoomReady(ctx, row.unit_id, s.requireInspected, row.stay_id);
  const g = await recordGuests(ctx, pii, row.property_id, input.guests, row.booker_person_id);
  await postRoomCharges(
    ctx,
    row.property_id,
    row.stay_id,
    await unitCode(ctx, row.unit_id),
    row.nightly_prices,
  );
  const notice = await createResidenceNotice(
    ctx.trx,
    ctx.actor.orgId,
    row.property_id,
    row.stay_id,
    g.isForeign,
    now,
  );
  await sql`update stays set status = 'in_house', checked_in_at = ${now}, checked_in_by = ${ctx.actor.membershipId},
                   primary_guest_person_id = ${g.primaryPersonId}, additional_guest_person_ids = ${g.additionalPersonIds}::uuid[],
                   version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${row.stay_id}`.execute(ctx.trx);
  await sql`update reservations set status = 'in_house', version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${row.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "stay.checked_in",
    entityType: "stay",
    entityId: row.stay_id,
    propertyId: row.property_id,
    before: { status: "expected" },
    after: { status: "in_house", guests: input.guests.length, is_foreign: g.isForeign },
  });
  await ctx.emit({
    eventType: "stay.checked_in",
    aggregateType: "stay",
    aggregateId: row.stay_id,
    propertyId: row.property_id,
    payload: { stay_id: row.stay_id, reservation_id: row.id, notice_id: notice.noticeId },
  });
  return {
    stayId: row.stay_id,
    reservationId: row.id,
    noticeId: notice.noticeId,
    noticeDueAt: notice.dueAt,
    checkedInAt: now,
  };
}

/**
 * `stay.walkIn` (S-015, S-016): MỘT command tạo booking nguồn `walk_in` + stay đều `in_house`, allocation stay [bây giờ, giờ trả
 * ngày đi). Đêm đầu = ngày kinh doanh lúc nhận (01:30 trước giờ chốt 04:00 → đêm hôm trước). Phòng bận → ROOM_UNAVAILABLE.
 */
export async function walkIn(
  ctx: CommandContext,
  pii: PiiCipher,
  input: { unitId: string; departureDate: string; guests: readonly GuestInput[]; now?: Date },
): Promise<CheckInResult & { nights: number; roomTotal: number }> {
  const now = input.now ?? new Date();
  if (!UUID.test(input.unitId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  const u = await sql<{ property_id: string; room_type_id: string; capacity: number; code: string }>`
    select u.property_id, u.room_type_id, rt.capacity, u.code from units u
    join room_types rt on rt.organization_id = u.organization_id and rt.id = u.room_type_id
    where u.organization_id = ${ctx.actor.orgId} and u.id = ${input.unitId} and u.archived_at is null`.execute(
    ctx.trx,
  );
  const unit = u.rows[0];
  if (!unit) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  authorize(ctx.actor, "reservation.manage", { propertyId: unit.property_id });
  assertCapacity(input.guests.length, unit.capacity);
  const s = await staySettings(ctx.trx, ctx.actor.orgId, unit.property_id);
  const arrival = await businessDateAt(ctx, unit.property_id, now);
  let prices: NightPrice[];
  try {
    prices = priceNights(
      nightsOf(arrival, input.departureDate, s.maxNights),
      await loadRates(ctx.trx, ctx.actor.orgId, unit.room_type_id),
      s.weekendNights,
    );
  } catch (e) {
    return quoteProblem(e);
  }
  await assertRoomReady(ctx, input.unitId, s.requireInspected, null);
  const end = await sql<{ e: Date }>`
    select ((${input.departureDate}::date + ${s.checkOutTime}::time)::timestamp at time zone ${s.timezone}) as e`.execute(
    ctx.trx,
  );
  const g = await recordGuests(ctx, pii, unit.property_id, input.guests, null);
  const reservationId = randomUUID();
  const itemId = randomUUID();
  const stayId = randomUUID();
  const n = await sql<{
    n: string;
  }>`select app.next_number(${ctx.actor.orgId}, ${unit.property_id}, 'reservation')::text as n`.execute(
    ctx.trx,
  );
  const number = `R-${n.rows[0]?.n}`;
  const roomTotal = sumNights(prices);
  const hold = await createHold(ctx, {
    unitId: input.unitId,
    during: { start: now, end: end.rows[0]?.e as Date },
    ttlMinutes: 1,
    sourceType: "reservation_item",
    sourceId: itemId,
    now,
  });
  await confirmHold(ctx, hold.allocationId, "stay", now);
  await sql`
    insert into reservations (id, organization_id, property_id, number, status, source, booker_person_id, policy_snapshot,
                              confirmed_at, created_by, command_id)
    values (${reservationId}, ${ctx.actor.orgId}, ${unit.property_id}, ${number}, 'in_house', 'walk_in', ${g.primaryPersonId},
            ${JSON.stringify({ check_out_time: s.checkOutTime.slice(0, 5), walk_in: true })}::jsonb, ${now},
            ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(ctx.trx);
  await sql`
    insert into reservation_items (id, organization_id, property_id, reservation_id, unit_id, room_type_id, arrival_date,
                                   departure_date, guests, nightly_prices, room_total, allocation_id)
    values (${itemId}, ${ctx.actor.orgId}, ${unit.property_id}, ${reservationId}, ${input.unitId}, ${unit.room_type_id},
            ${arrival}::date, ${input.departureDate}::date, ${input.guests.length}, ${JSON.stringify(prices)}::jsonb, ${roomTotal},
            ${hold.allocationId})`.execute(ctx.trx);
  await sql`
    insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id,
                       additional_guest_person_ids, checked_in_at, checked_in_by)
    values (${stayId}, ${ctx.actor.orgId}, ${unit.property_id}, ${itemId}, ${input.unitId}, 'in_house', ${g.primaryPersonId},
            ${g.additionalPersonIds}::uuid[], ${now}, ${ctx.actor.membershipId})`.execute(ctx.trx);
  await sql`update allocations set source_type = 'stay', source_id = ${stayId}
            where organization_id = ${ctx.actor.orgId} and id = ${hold.allocationId}`.execute(ctx.trx);
  await postRoomCharges(ctx, unit.property_id, stayId, unit.code, prices);
  const notice = await createResidenceNotice(
    ctx.trx,
    ctx.actor.orgId,
    unit.property_id,
    stayId,
    g.isForeign,
    now,
  );
  await ctx.audit({
    action: "stay.walked_in",
    entityType: "stay",
    entityId: stayId,
    propertyId: unit.property_id,
    after: { status: "in_house", reservation_number: number, nights: prices.length, room_total: roomTotal },
  });
  await ctx.emit({
    eventType: "stay.checked_in",
    aggregateType: "stay",
    aggregateId: stayId,
    propertyId: unit.property_id,
    payload: { stay_id: stayId, reservation_id: reservationId, notice_id: notice.noticeId, walk_in: true },
  });
  return {
    stayId,
    reservationId,
    noticeId: notice.noticeId,
    noticeDueAt: notice.dueAt,
    checkedInAt: now,
    nights: prices.length,
    roomTotal,
  };
}
