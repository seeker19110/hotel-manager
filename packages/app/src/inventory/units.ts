// Tạo phòng (SPEC-access-and-property — `unit.manage`; dùng bởi import SPEC-import S-002…S-005). Tầng tìm theo tên, loại phòng
// theo sức chứa (`P<n>`), tạo nếu chưa có; mã phòng trùng trong cơ sở bị chặn bởi unique index `uq_units_code`.
import { randomUUID } from "node:crypto";
import { authorize } from "@hm/domain";
import { sql } from "kysely";
import { type CommandContext, fieldError } from "../pipeline/index.ts";

export async function createUnit(
  ctx: CommandContext,
  input: { propertyId: string; floorName: string; code: string; capacity: number },
): Promise<{ unitId: string }> {
  authorize(ctx.actor, "unit.manage", { propertyId: input.propertyId });
  const code = input.code.trim();
  const floorName = input.floorName.trim();
  if (code.length < 1 || code.length > 20) throw fieldError("code", "INVALID", "Mã phòng 1–20 ký tự");
  if (floorName.length < 1 || floorName.length > 100)
    throw fieldError("floor", "INVALID", "Tên tầng 1–100 ký tự");
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 50)
    throw fieldError("capacity", "OUT_OF_RANGE", "Sức chứa 1–50");
  const floor = await sql<{ id: string }>`
    insert into floors (id, organization_id, property_id, name, sort_order)
    values (${randomUUID()}, ${ctx.actor.orgId}, ${input.propertyId}, ${floorName},
            (select coalesce(max(sort_order), 0) + 1 from floors where organization_id = ${ctx.actor.orgId}
               and property_id = ${input.propertyId}))
    on conflict (organization_id, property_id, name) where archived_at is null do update set name = excluded.name
    returning id`.execute(ctx.trx);
  const typeCode = `P${input.capacity}`;
  const type = await sql<{ id: string }>`
    insert into room_types (id, organization_id, property_id, code, name, capacity)
    values (${randomUUID()}, ${ctx.actor.orgId}, ${input.propertyId}, ${typeCode}, ${`Phòng ${input.capacity} người`},
            ${input.capacity})
    on conflict (organization_id, property_id, code) where archived_at is null do update set code = excluded.code
    returning id`.execute(ctx.trx);
  const unitId = randomUUID();
  await sql`
    insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
    values (${unitId}, ${ctx.actor.orgId}, ${input.propertyId}, ${floor.rows[0]?.id}, ${type.rows[0]?.id}, ${code})`.execute(
    ctx.trx,
  );
  await ctx.audit({
    action: "unit.created",
    entityType: "unit",
    entityId: unitId,
    propertyId: input.propertyId,
    after: { code, floor: floorName, capacity: input.capacity },
  });
  return { unitId };
}
