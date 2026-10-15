// Query danh sách phòng theo phạm vi cơ sở của actor (SPEC-access-and-property — phạm vi; quyền `calendar.read_status`).
// Lọc phạm vi ở câu truy vấn (không lấy hết rồi lọc ở client); RLS giữ ranh giới tổ chức.
import { withTenant } from "@hm/db";
import { authorize } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../access/actor.ts";

export interface RoomRow {
  unitId: string;
  code: string;
  floorName: string;
  roomTypeName: string | null;
  housekeepingStatus: string;
  availability: "active" | "out_of_service";
}

export interface PropertyRooms {
  propertyId: string;
  propertyName: string;
  rooms: RoomRow[];
}

export async function listRooms(db: Kysely<unknown>, actor: Actor): Promise<PropertyRooms[]> {
  authorize(actor, "calendar.read_status");
  const scope = actor.allProperties ? null : [...actor.propertyIds];
  const rows = await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      property_id: string;
      property_name: string;
      unit_id: string | null;
      code: string | null;
      floor_name: string | null;
      room_type_name: string | null;
      housekeeping_status: string | null;
      availability: "active" | "out_of_service" | null;
    }>`
      select p.id as property_id, p.name as property_name, u.id as unit_id, u.code, f.name as floor_name,
             rt.name as room_type_name, u.housekeeping_status, u.availability
      from properties p
      left join units u on u.organization_id = p.organization_id and u.property_id = p.id and u.archived_at is null
      left join floors f on f.organization_id = u.organization_id and f.id = u.floor_id
      left join room_types rt on rt.organization_id = u.organization_id and rt.id = u.room_type_id
      where p.organization_id = ${actor.orgId} and p.archived_at is null
        and (${scope}::uuid[] is null or p.id = any(${scope}::uuid[]))
      order by p.name, f.sort_order, f.name, lower(u.code)`.execute(trx);
    return r.rows;
  });
  const byProperty = new Map<string, PropertyRooms>();
  for (const r of rows) {
    let p = byProperty.get(r.property_id);
    if (!p) {
      p = { propertyId: r.property_id, propertyName: r.property_name, rooms: [] };
      byProperty.set(r.property_id, p);
    }
    if (r.unit_id && r.code && r.floor_name && r.housekeeping_status && r.availability) {
      p.rooms.push({
        unitId: r.unit_id,
        code: r.code,
        floorName: r.floor_name,
        roomTypeName: r.room_type_name,
        housekeepingStatus: r.housekeeping_status,
        availability: r.availability,
      });
    }
  }
  return [...byProperty.values()];
}
