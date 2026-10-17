// Truy vấn lịch tài nguyên (SPEC-inventory-allocation S-020, S-021): `inventory.getCalendar` (phòng × đoạn allocation theo giờ
// địa phương của cơ sở) và `inventory.searchAvailability` (phòng còn trống cho một khoảng). Chỉ đọc; RLS giữ ranh giới tổ chức,
// phạm vi cơ sở kiểm bằng `authorize` (cơ sở ngoài phạm vi/tổ chức khác → 404). Màn /lich-phong hiện vẫn đọc booking
// (`reservation.list` + `listRooms`) — truy vấn này là lịch ở tầng allocation (gồm hold, hợp đồng, block, quá hạn).
import { withTenant } from "@hm/db";
import { authorize, grantFor, isMatrixRole, MS_PER_DAY } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/index.ts";
import { CommandError, fieldError } from "../pipeline/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Q-05: tối đa 62 ngày mỗi lần xem lịch; phân trang theo phòng. */
export const CALENDAR_MAX_DAYS = 62;
export const CALENDAR_DEFAULT_ROOMS = 100;
export const CALENDAR_MAX_ROOMS = 200;
const SEARCH_MAX_ROOMS = 200;

export interface CalendarSegment {
  allocationId: string;
  kind: "hold" | "stay" | "lease" | "block";
  sourceType: string | null;
  sourceId: string | null;
  /** Trạng thái của nguồn (booking/lượt ở/hợp đồng/block). */
  sourceStatus: string | null;
  /** Khoảng theo UTC (ISO) và theo giờ địa phương của cơ sở (`YYYY-MM-DDTHH:MM`); `end*` null = khoảng mở (hợp đồng). */
  start: string;
  end: string | null;
  startLocal: string;
  endLocal: string | null;
  /** Hold: hạn giữ (đếm ngược trên UI). */
  expiresAt: string | null;
  /** Còn ngoại lệ quá hạn (`STAY_OVERSTAY`/`LEASE_OVERSTAY`) đang mở — lịch hiển thị "Quá hạn trả". */
  overdue: boolean;
  /** Chỉ có khi vai trò được xem tên khách (`calendar.read_guests`). */
  guestName?: string | null;
  /** Chỉ có khi vai trò xem được tiền (`money.read`): tiền phòng của booking nguồn (đồng). */
  roomTotal?: number | null;
}

export interface CalendarRoom {
  unitId: string;
  code: string;
  floorId: string;
  floorName: string;
  roomTypeId: string | null;
  roomTypeName: string | null;
  housekeeping: string;
  availability: "active" | "out_of_service";
  segments: CalendarSegment[];
}

export interface Calendar {
  propertyId: string;
  timezone: string;
  from: string;
  to: string;
  rooms: CalendarRoom[];
  /** Có trang kế (phòng) khi khác null. */
  nextCursor: string | null;
}

export interface CalendarInput {
  propertyId: string;
  /** Ngày địa phương (YYYY-MM-DD), gồm `from`, không gồm `to` — cùng quy ước `reservation.list`. */
  from: string;
  to: string;
  floorId?: string;
  roomTypeId?: string;
  limit?: number;
  cursor?: string;
}

const validDate = (d: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

async function propertyTimezone(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
): Promise<string> {
  const p = await sql<{ timezone: string }>`
    select timezone from properties where organization_id = ${orgId} and id = ${propertyId} and archived_at is null`.execute(
    trx,
  );
  const tz = p.rows[0]?.timezone;
  if (!tz) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  return tz;
}

/** `inventory.getCalendar` (S-021): chỉ phòng của cơ sở (lọc tầng/loại), mỗi phòng các đoạn allocation chồng khoảng xem. */
export async function getCalendar(
  db: Kysely<unknown>,
  actor: Actor,
  input: CalendarInput,
  now = new Date(),
): Promise<Calendar> {
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  authorize(actor, "calendar.read_status", { propertyId: input.propertyId });
  if (!validDate(input.from)) throw fieldError("from", "invalid_date", "Ngày bắt đầu không hợp lệ");
  if (!validDate(input.to)) throw fieldError("to", "invalid_date", "Ngày kết thúc không hợp lệ");
  const days = (Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / MS_PER_DAY;
  if (days <= 0) throw fieldError("to", "invalid_range", "Khoảng ngày không hợp lệ");
  if (days > CALENDAR_MAX_DAYS)
    throw fieldError("to", "range_too_long", `Chỉ xem tối đa ${CALENDAR_MAX_DAYS} ngày mỗi lần`);
  if (input.floorId !== undefined && !UUID.test(input.floorId))
    throw fieldError("floor_id", "invalid", "Tầng không hợp lệ");
  if (input.roomTypeId !== undefined && !UUID.test(input.roomTypeId))
    throw fieldError("room_type_id", "invalid", "Loại phòng không hợp lệ");
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? CALENDAR_DEFAULT_ROOMS), 1), CALENDAR_MAX_ROOMS);
  const offset = input.cursor === undefined ? 0 : Number(input.cursor);
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000)
    throw fieldError("cursor", "invalid", "Con trỏ trang không hợp lệ");
  const role = actor.role;
  const guestsVisible = isMatrixRole(role) && grantFor("calendar.read_guests", role) !== "no";
  const moneyVisible = isMatrixRole(role) && grantFor("money.read", role) === "yes";

  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const tz = await propertyTimezone(trx, actor.orgId, input.propertyId);
    const rooms = await sql<{
      unit_id: string;
      code: string;
      floor_id: string;
      floor_name: string;
      room_type_id: string | null;
      room_type_name: string | null;
      housekeeping_status: string;
      availability: "active" | "out_of_service";
    }>`
      select u.id as unit_id, u.code, u.floor_id, f.name as floor_name, u.room_type_id, rt.name as room_type_name,
             u.housekeeping_status, u.availability
      from units u
      join floors f on f.organization_id = u.organization_id and f.property_id = u.property_id and f.id = u.floor_id
      left join room_types rt on rt.organization_id = u.organization_id and rt.property_id = u.property_id and rt.id = u.room_type_id
      where u.organization_id = ${actor.orgId} and u.property_id = ${input.propertyId} and u.archived_at is null
        ${input.floorId ? sql`and u.floor_id = ${input.floorId}` : sql``}
        ${input.roomTypeId ? sql`and u.room_type_id = ${input.roomTypeId}` : sql``}
      order by f.sort_order, f.name, lower(u.code), u.id
      limit ${limit + 1} offset ${offset}`.execute(trx);
    const page = rooms.rows.slice(0, limit);
    const unitIds = page.map((r) => r.unit_id);
    const segs =
      unitIds.length === 0
        ? []
        : (
            await sql<{
              id: string;
              unit_id: string;
              kind: CalendarSegment["kind"];
              source_type: string | null;
              source_id: string | null;
              source_status: string | null;
              lo: Date;
              hi: Date | null;
              lo_local: string;
              hi_local: string | null;
              expires_at: Date | null;
              overdue: boolean;
              guest_name: string | null;
              room_total: string | null;
            }>`
      select a.id, a.unit_id, a.kind, a.source_type, a.source_id,
             case when a.source_type = 'stay' then st.status when a.source_type = 'reservation_item' then rs.status
                  when a.source_type = 'lease' then ls.status when a.source_type = 'block' then bl.status end as source_status,
             lower(a.during) as lo, upper(a.during) as hi,
             to_char(lower(a.during) at time zone ${tz}, 'YYYY-MM-DD"T"HH24:MI') as lo_local,
             to_char(upper(a.during) at time zone ${tz}, 'YYYY-MM-DD"T"HH24:MI') as hi_local,
             a.expires_at,
             exists (select 1 from exceptions e where e.organization_id = a.organization_id and e.allocation_id = a.id
                       and e.status = 'open' and e.type in ('STAY_OVERSTAY', 'LEASE_OVERSTAY')) as overdue,
             case when a.source_type = 'stay' then sp.full_name when a.source_type = 'reservation_item' then bp.full_name
                  when a.source_type = 'lease' then lp.full_name end as guest_name,
             ri.room_total::text as room_total
      from allocations a
      left join stays st on a.source_type = 'stay' and st.organization_id = a.organization_id and st.id = a.source_id
      left join reservation_items ri on ri.organization_id = a.organization_id
           and ((a.source_type = 'reservation_item' and ri.id = a.source_id) or (a.source_type = 'stay' and ri.id = st.reservation_item_id))
      left join reservations rs on rs.organization_id = ri.organization_id and rs.id = ri.reservation_id
      left join persons bp on bp.organization_id = rs.organization_id and bp.id = rs.booker_person_id
      left join persons sp on sp.organization_id = st.organization_id and sp.id = st.primary_guest_person_id
      left join leases ls on a.source_type = 'lease' and ls.organization_id = a.organization_id and ls.id = a.source_id
      left join persons lp on lp.organization_id = ls.organization_id and lp.id = ls.representative_person_id
      left join blocks bl on a.source_type = 'block' and bl.organization_id = a.organization_id and bl.id = a.source_id
      where a.organization_id = ${actor.orgId} and a.property_id = ${input.propertyId} and a.unit_id = any(${unitIds}::uuid[])
        and a.active and (a.kind <> 'hold' or a.expires_at > ${now})
        and a.during && tstzrange((${input.from}::date)::timestamp at time zone ${tz},
                                  (${input.to}::date)::timestamp at time zone ${tz}, '[)')
      order by lower(a.during), a.id`.execute(trx)
          ).rows;
    const byUnit = new Map<string, CalendarSegment[]>();
    for (const s of segs) {
      const seg: CalendarSegment = {
        allocationId: s.id,
        kind: s.kind,
        sourceType: s.source_type,
        sourceId: s.source_id,
        sourceStatus: s.source_status,
        start: s.lo.toISOString(),
        end: s.hi ? s.hi.toISOString() : null,
        startLocal: s.lo_local,
        endLocal: s.hi_local,
        expiresAt: s.expires_at ? s.expires_at.toISOString() : null,
        overdue: s.overdue,
        // Vai trò chỉ xem trạng thái (housekeeping, maintenance…) không nhận tên khách và số tiền: bỏ hẳn khoá, không gửi null.
        ...(guestsVisible ? { guestName: s.guest_name } : {}),
        ...(guestsVisible && moneyVisible
          ? { roomTotal: s.room_total === null ? null : Number(s.room_total) }
          : {}),
      };
      const list = byUnit.get(s.unit_id);
      if (list) list.push(seg);
      else byUnit.set(s.unit_id, [seg]);
    }
    return {
      propertyId: input.propertyId,
      timezone: tz,
      from: input.from,
      to: input.to,
      rooms: page.map((r) => ({
        unitId: r.unit_id,
        code: r.code,
        floorId: r.floor_id,
        floorName: r.floor_name,
        roomTypeId: r.room_type_id,
        roomTypeName: r.room_type_name,
        housekeeping: r.housekeeping_status,
        availability: r.availability,
        segments: byUnit.get(r.unit_id) ?? [],
      })),
      nextCursor: rooms.rows.length > limit ? String(offset + limit) : null,
    };
  });
}

export interface AvailableRoom {
  unitId: string;
  code: string;
  floorName: string;
  roomTypeId: string | null;
  roomTypeName: string | null;
  capacity: number | null;
}

/**
 * `inventory.searchAvailability` (S-020): phòng còn trống trong [start, end) — đã trừ allocation active (hold CÒN HẠN, lượt ở,
 * hợp đồng, block), phòng ngừng khai thác, và phòng còn ngoại lệ quá hạn (`STAY_OVERSTAY`/`LEASE_OVERSTAY`) đang mở: phòng đó
 * thực tế còn người nên không được chào bán dù allocation đã hết giờ.
 */
export async function searchAvailability(
  db: Kysely<unknown>,
  actor: Actor,
  input: { propertyId: string; start: Date; end: Date; guests?: number; roomTypeId?: string },
  now = new Date(),
): Promise<{ rooms: AvailableRoom[] }> {
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  authorize(actor, "calendar.read_status", { propertyId: input.propertyId });
  if (Number.isNaN(input.start.getTime()))
    throw fieldError("start", "invalid_date", "Thời điểm bắt đầu không hợp lệ");
  if (Number.isNaN(input.end.getTime()) || input.end.getTime() <= input.start.getTime())
    throw fieldError("end", "invalid_range", "Thời điểm kết thúc phải sau thời điểm bắt đầu");
  if (
    input.guests !== undefined &&
    (!Number.isInteger(input.guests) || input.guests < 1 || input.guests > 50)
  )
    throw fieldError("guests", "invalid", "Số khách không hợp lệ");
  if (input.roomTypeId !== undefined && !UUID.test(input.roomTypeId))
    throw fieldError("room_type_id", "invalid", "Loại phòng không hợp lệ");
  const range = `[${input.start.toISOString()},${input.end.toISOString()})`;
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    await propertyTimezone(trx, actor.orgId, input.propertyId);
    const r = await sql<{
      unit_id: string;
      code: string;
      floor_name: string;
      room_type_id: string | null;
      room_type_name: string | null;
      capacity: number | null;
    }>`
      select u.id as unit_id, u.code, f.name as floor_name, u.room_type_id, rt.name as room_type_name, rt.capacity
      from units u
      join floors f on f.organization_id = u.organization_id and f.property_id = u.property_id and f.id = u.floor_id
      left join room_types rt on rt.organization_id = u.organization_id and rt.property_id = u.property_id and rt.id = u.room_type_id
      where u.organization_id = ${actor.orgId} and u.property_id = ${input.propertyId} and u.archived_at is null
        and u.availability = 'active'
        ${input.roomTypeId ? sql`and u.room_type_id = ${input.roomTypeId}` : sql``}
        ${input.guests !== undefined ? sql`and rt.capacity >= ${input.guests}` : sql``}
        and not exists (select 1 from allocations a where a.organization_id = u.organization_id and a.unit_id = u.id and a.active
                          and (a.kind <> 'hold' or a.expires_at > ${now}) and a.during && ${range}::tstzrange)
        and not exists (select 1 from exceptions e join allocations oa on oa.organization_id = e.organization_id and oa.id = e.allocation_id
                        where e.organization_id = u.organization_id and e.status = 'open'
                          and e.type in ('STAY_OVERSTAY', 'LEASE_OVERSTAY') and oa.unit_id = u.id and oa.active)
      order by f.sort_order, f.name, lower(u.code), u.id
      limit ${SEARCH_MAX_ROOMS}`.execute(trx);
    return {
      rooms: r.rows.map((x) => ({
        unitId: x.unit_id,
        code: x.code,
        floorName: x.floor_name,
        roomTypeId: x.room_type_id,
        roomTypeName: x.room_type_name,
        capacity: x.capacity,
      })),
    };
  });
}
