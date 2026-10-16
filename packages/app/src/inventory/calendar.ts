// Truy vấn lịch phòng (SPEC-inventory-allocation S-021, Q-05) và trạng thái ba chiều (S-014). Chỉ đọc, chạy qua kết nối
// runtime trong `withTenant` (RLS giữ ranh giới tổ chức; phạm vi cơ sở kiểm bằng `authorize`).
import { withTenant } from "@hm/db";
import { AuthzError, authorize } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../access/actor.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";
import { type Occupancy, occupancyOf, unitStatus } from "./inventory.ts";

/**
 * Khoảng truy vấn tối đa (Q-05): 62 ngày = hai tháng dương lịch liền nhau — đủ cho màn "tháng này + tháng sau", đồng thời
 * chặn quét toàn bộ lịch (mỗi lần ≤ 62 ngày × ≤ MAX_LIMIT phòng đoạn).
 */
export const MAX_CALENDAR_DAYS = 62;
export const DEFAULT_CALENDAR_LIMIT = 50;
export const MAX_CALENDAR_LIMIT = 200;

export interface CalendarInput {
  propertyId: string;
  /** Ngày địa phương `YYYY-MM-DD`, gồm. */
  from: string;
  /** Ngày địa phương `YYYY-MM-DD`, KHÔNG gồm (khoảng nửa mở [from, to)). */
  to: string;
  floorId?: string;
  roomTypeId?: string;
  limit?: number;
  cursor?: string;
  now?: Date;
}

export interface CalendarSegment {
  allocation_id: string;
  kind: "hold" | "stay" | "lease" | "block";
  source_type: string | null;
  /** Trạng thái nguồn (hiện chỉ hợp đồng; stay/booking bổ sung khi có bảng — T-204/T-205); null nếu RLS che nguồn. */
  source_status: string | null;
  /** Nhãn tối thiểu không PII: số hợp đồng hoặc lý do block (null khi RLS che nguồn khỏi vai trò đó, vd buồng phòng với hợp đồng). */
  label: string | null;
  /** Chỉ vai trò có `calendar.read_guests`; còn lại luôn null. */
  guest_name: string | null;
  start: string;
  end: string | null;
  start_local: string;
  end_local: string | null;
  expires_at: string | null;
}

export interface CalendarRoom {
  unit_id: string;
  code: string;
  floor: { id: string; name: string };
  room_type: { id: string; name: string } | null;
  housekeeping: string;
  availability: "active" | "out_of_service";
  /** Lý do ngừng khai thác — chỉ vai trò có `calendar.read_guests`. */
  availability_reason: string | null;
  occupancy: Occupancy;
  segments: CalendarSegment[];
}

export interface CalendarView {
  property_id: string;
  timezone: string;
  from: string;
  to: string;
  rooms: CalendarRoom[];
  /** null = hết trang. Truyền nguyên văn vào `cursor` để lấy trang kế. */
  next_cursor: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dayNumber(field: string, v: string): number {
  const ms = DAY.test(v) ? Date.parse(`${v}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== v)
    throw fieldError(field, "INVALID", "Ngày phải dạng YYYY-MM-DD hợp lệ");
  return ms / 86_400_000;
}

type CursorKey = [number, string, string, string];

function encodeCursor(k: CursorKey): string {
  return Buffer.from(JSON.stringify(k), "utf8").toString("base64url");
}

function decodeCursor(c: string): CursorKey {
  try {
    const k = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(k) &&
      k.length === 4 &&
      Number.isInteger(k[0]) &&
      typeof k[1] === "string" &&
      typeof k[2] === "string" &&
      typeof k[3] === "string" &&
      UUID.test(k[3])
    )
      return k as CursorKey;
  } catch {
    // rơi xuống lỗi bên dưới
  }
  throw fieldError("cursor", "INVALID", "Con trỏ phân trang không hợp lệ");
}

function canSeeGuests(actor: Actor, propertyId: string): boolean {
  try {
    authorize(actor, "calendar.read_guests", { propertyId });
    return true;
  } catch (err) {
    if (err instanceof AuthzError && err.code === "FORBIDDEN") return false;
    throw err;
  }
}

/**
 * Lịch phòng theo cơ sở, phân trang theo PHÒNG (tầng → mã phòng → id, keyset nên không trùng/sót khi dữ liệu đổi giữa các
 * trang). Chỉ trả đoạn còn hiệu lực chồng khoảng; hold hết hạn chưa nhả không hiển thị. Vai trò chỉ có `calendar.read_status`
 * không nhận tên khách/lý do; không bao giờ có số tiền.
 */
export async function getCalendar(
  db: Kysely<unknown>,
  actor: Actor,
  input: CalendarInput,
): Promise<CalendarView> {
  authorize(actor, "calendar.read_status", { propertyId: input.propertyId });
  const fromDay = dayNumber("from", input.from);
  const toDay = dayNumber("to", input.to);
  if (toDay <= fromDay) throw fieldError("to", "INVALID_RANGE", "Ngày kết thúc phải sau ngày bắt đầu");
  if (toDay - fromDay > MAX_CALENDAR_DAYS)
    throw fieldError("to", "OUT_OF_RANGE", `Khoảng xem lịch tối đa ${MAX_CALENDAR_DAYS} ngày`);
  const limit = input.limit ?? DEFAULT_CALENDAR_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CALENDAR_LIMIT)
    throw fieldError("limit", "OUT_OF_RANGE", `Số phòng mỗi trang 1–${MAX_CALENDAR_LIMIT}`);
  const after = input.cursor ? decodeCursor(input.cursor) : null;
  const now = input.now ?? new Date();
  const seeGuests = canSeeGuests(actor, input.propertyId);

  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const p = await sql<{ timezone: string }>`
      select timezone from properties
      where organization_id = ${actor.orgId} and id = ${input.propertyId} and archived_at is null`.execute(
      trx,
    );
    const tz = p.rows[0]?.timezone;
    if (!tz) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");

    const page = await sql<{
      unit_id: string;
      code: string;
      code_key: string;
      floor_id: string;
      floor_name: string;
      sort_order: number;
      room_type_id: string | null;
      room_type_name: string | null;
      housekeeping_status: string;
      availability: "active" | "out_of_service";
      availability_reason: string | null;
    }>`
      select u.id as unit_id, u.code, lower(u.code) as code_key, f.id as floor_id, f.name as floor_name, f.sort_order,
             rt.id as room_type_id, rt.name as room_type_name, u.housekeeping_status, u.availability,
             case when ${seeGuests}::boolean then u.availability_reason end as availability_reason
      from units u
      join floors f on f.organization_id = u.organization_id and f.id = u.floor_id
      left join room_types rt on rt.organization_id = u.organization_id and rt.id = u.room_type_id
      where u.organization_id = ${actor.orgId} and u.property_id = ${input.propertyId} and u.archived_at is null
        and (${input.floorId ?? null}::uuid is null or u.floor_id = ${input.floorId ?? null}::uuid)
        and (${input.roomTypeId ?? null}::uuid is null or u.room_type_id = ${input.roomTypeId ?? null}::uuid)
        and (${after === null}::boolean
             or (f.sort_order, f.name, lower(u.code), u.id)
                > (${after?.[0] ?? 0}::int, ${after?.[1] ?? ""}::text, ${after?.[2] ?? ""}::text,
                   ${after?.[3] ?? "00000000-0000-0000-0000-000000000000"}::uuid))
      order by f.sort_order, f.name, lower(u.code), u.id
      limit ${limit + 1}`.execute(trx);

    const hasMore = page.rows.length > limit;
    const rows = hasMore ? page.rows.slice(0, limit) : page.rows;
    const ids = rows.map((r) => r.unit_id);
    const segments = new Map<string, CalendarSegment[]>();
    const kindsNow = new Map<string, string[]>();

    if (ids.length > 0) {
      const seg = await sql<{
        unit_id: string;
        allocation_id: string;
        kind: CalendarSegment["kind"];
        source_type: string | null;
        lease_status: string | null;
        label: string | null;
        guest_name: string | null;
        lo: Date;
        hi: Date | null;
        start_local: string;
        end_local: string | null;
        expires_at: Date | null;
      }>`
        select a.unit_id, a.id as allocation_id, a.kind, a.source_type, l.status as lease_status,
               coalesce(l.number, b.reason) as label,
               case when ${seeGuests}::boolean then pr.full_name end as guest_name,
               lower(a.during) as lo, upper(a.during) as hi,
               to_char(lower(a.during) at time zone ${tz}, 'YYYY-MM-DD"T"HH24:MI') as start_local,
               to_char(upper(a.during) at time zone ${tz}, 'YYYY-MM-DD"T"HH24:MI') as end_local,
               a.expires_at
        from allocations a
        left join leases l on a.source_type = 'lease' and l.organization_id = a.organization_id and l.id = a.source_id
        left join persons pr on pr.organization_id = l.organization_id and pr.id = l.representative_person_id
        left join blocks b on a.source_type = 'block' and b.organization_id = a.organization_id and b.id = a.source_id
        where a.organization_id = ${actor.orgId} and a.unit_id = any(${ids}::uuid[]) and a.active
          and a.during && tstzrange((${input.from}::date)::timestamp at time zone ${tz},
                                    (${input.to}::date)::timestamp at time zone ${tz}, '[)')
          and (a.kind <> 'hold' or a.expires_at > ${now})
        order by a.unit_id, lower(a.during), a.id`.execute(trx);
      for (const s of seg.rows) {
        const list = segments.get(s.unit_id) ?? [];
        list.push({
          allocation_id: s.allocation_id,
          kind: s.kind,
          source_type: s.source_type,
          source_status: s.lease_status,
          label: s.label,
          guest_name: s.guest_name,
          start: s.lo.toISOString(),
          end: s.hi ? s.hi.toISOString() : null,
          start_local: s.start_local,
          end_local: s.end_local,
          expires_at: s.expires_at ? s.expires_at.toISOString() : null,
        });
        segments.set(s.unit_id, list);
      }
      const cur = await sql<{ unit_id: string; kind: string }>`
        select a.unit_id, a.kind from allocations a
        where a.organization_id = ${actor.orgId} and a.unit_id = any(${ids}::uuid[]) and a.active
          and a.during @> ${now}::timestamptz and (a.kind <> 'hold' or a.expires_at > ${now})`.execute(trx);
      for (const c of cur.rows) kindsNow.set(c.unit_id, [...(kindsNow.get(c.unit_id) ?? []), c.kind]);
    }

    const last = rows[rows.length - 1];
    return {
      property_id: input.propertyId,
      timezone: tz,
      from: input.from,
      to: input.to,
      rooms: rows.map((r) => ({
        unit_id: r.unit_id,
        code: r.code,
        floor: { id: r.floor_id, name: r.floor_name },
        room_type: r.room_type_id && r.room_type_name ? { id: r.room_type_id, name: r.room_type_name } : null,
        housekeeping: r.housekeeping_status,
        availability: r.availability,
        availability_reason: r.availability_reason,
        occupancy: occupancyOf(kindsNow.get(r.unit_id) ?? []),
        segments: segments.get(r.unit_id) ?? [],
      })),
      next_cursor:
        hasMore && last
          ? encodeCursor([last.sort_order, last.floor_name, last.code_key, last.unit_id])
          : null,
    };
  });
}

export interface UnitStatusView {
  unit_id: string;
  at: string;
  occupancy: Occupancy;
  housekeeping: string;
  availability: string;
  /** Còn bán được tại `at`: khai thác bình thường và không bị chiếm/giữ/khoá. */
  sellable: boolean;
  /** Nhận khách ngay được (Q-07 mặc định): trống, khai thác bình thường, vệ sinh `clean` hoặc `inspected`. */
  ready_for_arrival: boolean;
}

/** `inventory.getUnitStatus` (S-014): ba chiều độc lập + hai cờ suy ra. */
export async function getUnitStatus(
  db: Kysely<unknown>,
  actor: Actor,
  input: { unitId: string; at?: Date },
): Promise<UnitStatusView> {
  const at = input.at ?? new Date();
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const u = await sql<{ property_id: string }>`
      select property_id from units where organization_id = ${actor.orgId} and id = ${input.unitId} and archived_at is null`.execute(
      trx,
    );
    const propertyId = u.rows[0]?.property_id;
    if (!propertyId) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
    authorize(actor, "calendar.read_status", { propertyId });
    const s = await unitStatus(trx, actor.orgId, input.unitId, at);
    const active = s.availability === "active";
    return {
      unit_id: input.unitId,
      at: at.toISOString(),
      occupancy: s.occupancy,
      housekeeping: s.housekeeping,
      availability: s.availability,
      sellable: active && s.occupancy === "vacant",
      ready_for_arrival:
        active && s.occupancy === "vacant" && (s.housekeeping === "clean" || s.housekeeping === "inspected"),
    };
  });
}
