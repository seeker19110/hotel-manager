// Tạo phòng (SPEC-access-and-property — `unit.manage`; dùng bởi import SPEC-import S-002…S-005). Tầng tìm theo tên, loại phòng
// theo sức chứa (`P<n>`), tạo nếu chưa có; mã phòng trùng trong cơ sở bị chặn bởi unique index `uq_units_code`.
import { randomUUID } from "node:crypto";
import { authorize } from "@hm/domain";
import { sql } from "kysely";
import { t } from "../i18n.ts";
import { type CommandContext, CommandError, fieldError } from "../pipeline/index.ts";

/** Thông báo 404 chung (cơ sở/phòng ngoài tầm nhìn không phân biệt với không tồn tại). */
const NOT_FOUND_MSG = t("common.unit_not_found");

export async function createUnit(
  ctx: CommandContext,
  input: {
    propertyId: string;
    floorName: string;
    code: string;
    capacity: number;
    /** V1 chỉ bán nguyên phòng (SPEC-access S-005): chỉ nhận `whole`; cột vẫn giữ trong schema để mở rộng sau. */
    kind?: string;
    parentUnitId?: string | null;
  },
): Promise<{ unitId: string }> {
  authorize(ctx.actor, "unit.manage", { propertyId: input.propertyId });
  if (input.kind !== undefined && input.kind !== "whole")
    throw fieldError("kind", "INVALID", t("inventory.unit_whole_only"));
  if (input.parentUnitId !== undefined && input.parentUnitId !== null)
    throw fieldError("parent_unit_id", "INVALID", t("inventory.unit_sub_unsupported"));
  const code = input.code.trim();
  const floorName = input.floorName.trim();
  if (code.length < 1 || code.length > 20)
    throw fieldError("code", "INVALID", t("inventory.unit_code_length"));
  if (floorName.length < 1 || floorName.length > 100)
    throw fieldError("floor", "INVALID", t("inventory.floor_name_length"));
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 50)
    throw fieldError("capacity", "OUT_OF_RANGE", t("inventory.capacity_range"));
  // Cơ sở ngoài tầm nhìn (tổ chức khác, id lạ, hoặc ngoài phạm vi) → 404 như trước: RLS danh mục (0064) sẽ chặn INSERT … RETURNING
  // bằng lỗi quyền (403) trước khi khoá ngoại kịp báo, nên tra cơ sở trước.
  const prop =
    await sql`select 1 from properties where organization_id = ${ctx.actor.orgId} and id = ${input.propertyId}`.execute(
      ctx.trx,
    );
  if (prop.rows.length === 0) throw new CommandError("NOT_FOUND", 404, NOT_FOUND_MSG);
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
    values (${randomUUID()}, ${ctx.actor.orgId}, ${input.propertyId}, ${typeCode}, ${t("inventory.unit_type_default_name", { capacity: input.capacity })},
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

/**
 * `unit.archive` (SPEC-access S-006, INV-G7): lưu trữ mềm — đặt `archived_at`, không xoá hàng (chứng từ/lịch sử còn tham chiếu).
 * Phòng còn allocation đang hiệu lực kết thúc sau `now` (hoặc khoảng mở), hoặc còn hợp đồng/booking chưa kết thúc/block
 * `requested` tham chiếu → 409 UNIT_IN_USE; hold đã quá hạn chưa được worker nhả không tính là đang dùng.
 */
export async function archiveUnit(
  ctx: CommandContext,
  input: { unitId: string; now?: Date },
): Promise<{ archivedAt: Date }> {
  const now = input.now ?? new Date();
  const r = await sql<{ property_id: string; archived_at: Date | null }>`
    select property_id, archived_at from units
    where organization_id = ${ctx.actor.orgId} and id = ${input.unitId} for update`.execute(ctx.trx);
  const u = r.rows[0];
  if (!u || u.archived_at) throw new CommandError("NOT_FOUND", 404, NOT_FOUND_MSG);
  authorize(ctx.actor, "unit.manage", { propertyId: u.property_id });
  const busy = await sql<{ n: number }>`
    select count(*)::int as n from allocations
    where organization_id = ${ctx.actor.orgId} and unit_id = ${input.unitId} and active
      and (upper_inf(during) or upper(during) > ${now}) and (kind <> 'hold' or expires_at > ${now})`.execute(
    ctx.trx,
  );
  // Hợp đồng/booking chưa kết thúc và block chờ duyệt chưa chiếm allocation nhưng vẫn tham chiếu phòng: lưu trữ lúc này
  // sẽ để `lease.sign`/`reservation.hold`/`block.approve` ghi allocation lên phòng đã lưu trữ (INV-G7).
  const pending = await sql<{ n: number }>`
    select (select count(*) from leases where organization_id = ${ctx.actor.orgId} and unit_id = ${input.unitId}
              and status not in ('closed', 'cancelled'))
         + (select count(*) from reservation_items i
              join reservations r on r.organization_id = i.organization_id and r.id = i.reservation_id
            where i.organization_id = ${ctx.actor.orgId} and i.unit_id = ${input.unitId}
              and r.status not in ('checked_out', 'cancelled', 'no_show', 'expired'))
         + (select count(*) from blocks where organization_id = ${ctx.actor.orgId} and unit_id = ${input.unitId}
              and status = 'requested')
         as n`.execute(ctx.trx);
  if ((busy.rows[0]?.n ?? 0) + Number(pending.rows[0]?.n ?? 0) > 0)
    throw new CommandError("UNIT_IN_USE", 409, t("inventory.unit_in_use"));
  await sql`update units set archived_at = ${now}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${input.unitId}`.execute(ctx.trx);
  await ctx.audit({
    action: "unit.archived",
    entityType: "unit",
    entityId: input.unitId,
    propertyId: u.property_id,
  });
  return { archivedAt: now };
}
