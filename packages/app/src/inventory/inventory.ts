// Lịch tài nguyên (SPEC-inventory-allocation, DOMAIN-MODEL §3). Bất biến chồng phòng nằm ở CSDL (EXCLUDE — INV-I1);
// code chỉ dọn hold hết hạn dưới khoá phòng (INV-I3), dịch lỗi 23P01 → ROOM_UNAVAILABLE và ghi audit/outbox.
import { randomUUID } from "node:crypto";
import { authorize } from "@hm/domain";
import { sql, type Transaction } from "kysely";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";

export interface Interval {
  start: Date;
  /** null = khoảng mở (chỉ hợp đồng). */
  end: Date | null;
}

function rangeLiteral(i: Interval): string {
  if (i.end && i.end.getTime() <= i.start.getTime()) {
    throw new CommandError("VALIDATION_FAILED", 422, "Thời điểm kết thúc phải sau thời điểm bắt đầu");
  }
  return `[${i.start.toISOString()},${i.end ? i.end.toISOString() : ""})`;
}

async function lockUnit(
  trx: Transaction<unknown>,
  orgId: string,
  unitId: string,
): Promise<{ property_id: string; availability: string }> {
  const r = await sql<{ property_id: string; availability: string; archived_at: Date | null }>`
    select property_id, availability, archived_at from units where organization_id = ${orgId} and id = ${unitId} for update`.execute(
    trx,
  );
  const u = r.rows[0];
  if (!u || u.archived_at) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  return u;
}

/** Dọn hold hết hạn chồng khoảng cần dùng — dưới khoá phòng, nhả đúng một lần (INV-I3). */
async function releaseExpiredOverlapping(
  trx: Transaction<unknown>,
  orgId: string,
  unitId: string,
  range: string,
  now: Date,
) {
  const r = await sql<{ id: string }>`
    update allocations set active = false, deactivated_at = ${now}, deactivated_reason = 'expired'
    where organization_id = ${orgId} and unit_id = ${unitId} and active and kind = 'hold'
      and expires_at <= ${now} and during && ${range}::tstzrange
    returning id`.execute(trx);
  return r.rows.map((x) => x.id);
}

function translateOverlap(err: unknown): never {
  if ((err as { code?: string }).code === "23P01") {
    throw new CommandError("ROOM_UNAVAILABLE", 409, "Phòng đã có người đặt trong khoảng thời gian này");
  }
  throw err;
}

export type AlternativeUnit = { unit_id: string; code: string };

/**
 * Phòng CÙNG LOẠI, cùng cơ sở, đang khai thác và trống trong `range` (hold hết hạn chưa nhả không tính là chiếm) — gợi ý
 * khi giữ trùng (S-002) và khi phòng ngừng khai thác có khách (S-013). Chỉ gợi ý, không giữ chỗ. Phòng chưa gán loại → rỗng.
 */
export async function alternativeUnits(
  trx: Transaction<unknown>,
  orgId: string,
  unitId: string,
  range: string,
  now: Date,
  limit = 10,
): Promise<AlternativeUnit[]> {
  const r = await sql<AlternativeUnit>`
    select u.id as unit_id, u.code
    from units src
    join units u on u.organization_id = src.organization_id and u.property_id = src.property_id
                and u.room_type_id = src.room_type_id and u.id <> src.id
    join floors f on f.organization_id = u.organization_id and f.id = u.floor_id
    where src.organization_id = ${orgId} and src.id = ${unitId} and src.room_type_id is not null
      and u.archived_at is null and u.availability = 'active'
      and not exists (
        select 1 from allocations a
        where a.organization_id = u.organization_id and a.unit_id = u.id and a.active
          and a.during && ${range}::tstzrange and (a.kind <> 'hold' or a.expires_at > ${now}))
    order by f.sort_order, f.name, lower(u.code), u.id
    limit ${limit}`.execute(trx);
  return r.rows;
}

export interface CreateHoldInput {
  unitId: string;
  during: Interval;
  /** Bỏ trống → `properties.hold_ttl_minutes` của cơ sở (Q-01, mặc định 15). */
  ttlMinutes?: number;
  sourceType?: "reservation_item" | "lease";
  sourceId?: string;
  now?: Date;
}

export async function createHold(
  ctx: CommandContext,
  input: CreateHoldInput,
): Promise<{ allocationId: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const unit = await lockUnit(ctx.trx, ctx.actor.orgId, input.unitId);
  authorize(ctx.actor, input.sourceType === "lease" ? "lease.hold" : "reservation.manage", {
    propertyId: unit.property_id,
  });
  if (unit.availability !== "active")
    throw new CommandError("UNIT_OUT_OF_SERVICE", 409, "Phòng đang ngừng khai thác");
  // Hợp đồng không thời hạn được giữ chỗ mở cuối (SPEC-lease S-023); booking luôn có điểm cuối.
  if (!input.during.end && input.sourceType !== "lease")
    throw new CommandError("VALIDATION_FAILED", 422, "Giữ chỗ phải có thời điểm kết thúc");
  let ttlMinutes = input.ttlMinutes;
  if (ttlMinutes === undefined) {
    const p = await sql<{ m: number }>`
      select hold_ttl_minutes as m from properties where organization_id = ${ctx.actor.orgId} and id = ${unit.property_id}`.execute(
      ctx.trx,
    );
    ttlMinutes = p.rows[0]?.m ?? 15;
  }
  if (!Number.isInteger(ttlMinutes) || ttlMinutes <= 0) {
    throw new CommandError("VALIDATION_FAILED", 422, "Thời hạn giữ chỗ không hợp lệ");
  }
  const range = rangeLiteral(input.during);
  const released = await releaseExpiredOverlapping(ctx.trx, ctx.actor.orgId, input.unitId, range, now);
  for (const id of released) {
    await ctx.audit({
      action: "allocation.hold_expired",
      entityType: "allocation",
      entityId: id,
      propertyId: unit.property_id,
    });
  }
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);
  await sql`savepoint hold_insert`.execute(ctx.trx);
  try {
    await sql`
      insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during, expires_at, created_by)
      values (${id}, ${ctx.actor.orgId}, ${unit.property_id}, ${input.unitId}, 'hold', ${input.sourceType ?? null},
              ${input.sourceId ?? null}, ${range}::tstzrange, ${expiresAt}, ${ctx.actor.membershipId})`.execute(
      ctx.trx,
    );
  } catch (err) {
    if ((err as { code?: string }).code !== "23P01") throw err;
    // Giao dịch đang ở trạng thái lỗi: quay về savepoint để truy vấn gợi ý (S-002), rồi vẫn ném 409 (cả giao dịch rollback).
    await sql`rollback to savepoint hold_insert`.execute(ctx.trx);
    const alternatives = await alternativeUnits(ctx.trx, ctx.actor.orgId, input.unitId, range, now);
    throw new CommandError("ROOM_UNAVAILABLE", 409, "Phòng đã có người đặt trong khoảng thời gian này", {
      extensions: { alternatives },
    });
  }
  await ctx.audit({
    action: "allocation.held",
    entityType: "allocation",
    entityId: id,
    propertyId: unit.property_id,
    after: { range },
  });
  await ctx.emit({
    eventType: "allocation.held",
    aggregateType: "allocation",
    aggregateId: id,
    propertyId: unit.property_id,
    payload: { allocation_id: id },
  });
  return { allocationId: id, expiresAt };
}

/** Nhả hold đúng một lần: lần gọi sau trả `released: false` (không lỗi, không audit lần hai). */
export async function releaseHold(
  ctx: CommandContext,
  allocationId: string,
  now = new Date(),
  reason?: string,
): Promise<{ released: boolean }> {
  const r = await sql<{ property_id: string }>`
    update allocations set active = false, deactivated_at = ${now}, deactivated_reason = 'released'
    where organization_id = ${ctx.actor.orgId} and id = ${allocationId} and kind = 'hold' and active
    returning property_id`.execute(ctx.trx);
  const row = r.rows[0];
  if (!row) return { released: false };
  authorize(ctx.actor, "reservation.manage", { propertyId: row.property_id });
  await ctx.audit({
    action: "allocation.released",
    entityType: "allocation",
    entityId: allocationId,
    propertyId: row.property_id,
    ...(reason ? { reason } : {}),
  });
  return { released: true };
}

/**
 * Hold → cam kết (stay/lease) trong cùng UPDATE: không có khe hở để người khác chen vào. `during` (tuỳ chọn) đặt lại khoảng
 * cam kết trong cùng câu lệnh (vd điều khoản hợp đồng đổi sau khi giữ chỗ); chồng phòng khác → ROOM_UNAVAILABLE.
 */
export async function confirmHold(
  ctx: CommandContext,
  allocationId: string,
  kind: "stay" | "lease",
  now = new Date(),
  during?: Interval,
) {
  const r = await sql<{ property_id: string; expires_at: Date }>`
    select property_id, expires_at from allocations
    where organization_id = ${ctx.actor.orgId} and id = ${allocationId} and kind = 'hold' and active for update`.execute(
    ctx.trx,
  );
  const row = r.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy giữ chỗ");
  authorize(ctx.actor, kind === "lease" ? "lease.manage" : "reservation.manage", {
    propertyId: row.property_id,
  });
  if (row.expires_at.getTime() <= now.getTime())
    throw new CommandError("HOLD_EXPIRED", 409, "Giữ chỗ đã hết hạn");
  try {
    await sql`savepoint confirm_hold`.execute(ctx.trx);
    await sql`update allocations set kind = ${kind}, expires_at = null
              ${during ? sql`, during = ${rangeLiteral(during)}::tstzrange` : sql``}
              where id = ${allocationId}`.execute(ctx.trx);
  } catch (err) {
    translateOverlap(err);
  }
  await ctx.audit({
    action: "allocation.confirmed",
    entityType: "allocation",
    entityId: allocationId,
    propertyId: row.property_id,
    after: { kind },
  });
}

/**
 * Chuyển phòng nguyên tử (SPEC-inventory chuyển phòng): thu hẹp allocation cũ về [start, at) và tạo allocation mới
 * [at, end) ở phòng đích trong CÙNG transaction. Phòng đích bận → ROOM_UNAVAILABLE và mọi thay đổi rollback.
 */
export async function moveAllocation(
  ctx: CommandContext,
  input: { allocationId: string; toUnitId: string; at: Date; reason?: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const r = await sql<{
    property_id: string;
    unit_id: string;
    kind: string;
    source_type: string | null;
    source_id: string | null;
    lo: Date;
    hi: Date | null;
  }>`
    select property_id, unit_id, kind, source_type, source_id, lower(during) as lo, upper(during) as hi
    from allocations where organization_id = ${ctx.actor.orgId} and id = ${input.allocationId} and active for update`.execute(
    ctx.trx,
  );
  const a = r.rows[0];
  if (!a) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phân bổ phòng");
  authorize(ctx.actor, "stay.move", { propertyId: a.property_id });
  if (a.kind === "hold" || a.kind === "block")
    throw new CommandError("INVALID_TRANSITION", 409, "Chỉ chuyển lượt ở/hợp đồng");
  if (input.at.getTime() < a.lo.getTime() || (a.hi && input.at.getTime() >= a.hi.getTime())) {
    throw new CommandError("VALIDATION_FAILED", 422, "Thời điểm chuyển phải nằm trong khoảng đang ở");
  }
  if (input.toUnitId === a.unit_id)
    throw new CommandError("VALIDATION_FAILED", 422, "Phòng đích phải khác phòng hiện tại");
  const target = await lockUnit(ctx.trx, ctx.actor.orgId, input.toUnitId);
  if (target.property_id !== a.property_id)
    throw new CommandError("VALIDATION_FAILED", 422, "Chỉ chuyển trong cùng cơ sở");
  if (target.availability !== "active")
    throw new CommandError("UNIT_OUT_OF_SERVICE", 409, "Phòng đích đang ngừng khai thác");
  const newId = randomUUID();
  const newRange = `[${input.at.toISOString()},${a.hi ? a.hi.toISOString() : ""})`;
  const released = await releaseExpiredOverlapping(ctx.trx, ctx.actor.orgId, input.toUnitId, newRange, now);
  for (const id of released) {
    await ctx.audit({
      action: "allocation.hold_expired",
      entityType: "allocation",
      entityId: id,
      propertyId: a.property_id,
    });
  }
  try {
    await sql`savepoint move`.execute(ctx.trx);
    if (input.at.getTime() === a.lo.getTime()) {
      await sql`update allocations set active = false, deactivated_at = ${input.at}, deactivated_reason = 'moved' where id = ${input.allocationId}`.execute(
        ctx.trx,
      );
    } else {
      await sql`update allocations set during = tstzrange(lower(during), ${input.at}, '[)') where id = ${input.allocationId}`.execute(
        ctx.trx,
      );
    }
    await sql`
      insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during, created_by)
      values (${newId}, ${ctx.actor.orgId}, ${a.property_id}, ${input.toUnitId}, ${a.kind}, ${a.source_type}, ${a.source_id},
              tstzrange(${input.at}, ${a.hi}, '[)'), ${ctx.actor.membershipId})`.execute(ctx.trx);
  } catch (err) {
    translateOverlap(err);
  }
  await sql`update units set housekeeping_status = 'dirty' where organization_id = ${ctx.actor.orgId} and id = ${a.unit_id}`.execute(
    ctx.trx,
  );
  // Khách đã được chuyển đi → yêu cầu tái bố trí (S-013) của allocation này hết hiệu lực.
  await sql`
    update exceptions set status = 'resolved', resolution = 'moved', resolved_by = ${ctx.actor.membershipId}, resolved_at = ${now}
    where organization_id = ${ctx.actor.orgId} and allocation_id = ${input.allocationId}
      and type = 'RELOCATION_REQUIRED' and status = 'open'`.execute(ctx.trx);
  await ctx.audit({
    action: "allocation.moved",
    entityType: "allocation",
    entityId: input.allocationId,
    propertyId: a.property_id,
    before: { unit: a.unit_id },
    after: { from_unit: a.unit_id, to_unit: input.toUnitId, new_allocation: newId },
    ...(input.reason ? { reason: input.reason } : {}),
  });
  return { oldAllocationId: input.allocationId, newAllocationId: newId };
}

export async function proposeBlock(
  ctx: CommandContext,
  input: { unitId: string; period: Interval; reason: string },
) {
  const unit = await lockUnit(ctx.trx, ctx.actor.orgId, input.unitId);
  authorize(ctx.actor, "block.propose", { propertyId: unit.property_id });
  if (!input.period.end) throw new CommandError("VALIDATION_FAILED", 422, "Block phải có thời điểm kết thúc");
  const id = randomUUID();
  await sql`
    insert into blocks (id, organization_id, property_id, unit_id, period, reason, requested_by)
    values (${id}, ${ctx.actor.orgId}, ${unit.property_id}, ${input.unitId}, ${rangeLiteral(input.period)}::tstzrange, ${input.reason},
            ${ctx.actor.membershipId})`.execute(ctx.trx);
  await ctx.audit({
    action: "block.requested",
    entityType: "block",
    entityId: id,
    propertyId: unit.property_id,
    reason: input.reason,
  });
  return { blockId: id };
}

/**
 * Duyệt block = tạo allocation `block`; đụng khách/hợp đồng đã có → BLOCK_CONFLICT kèm danh sách allocation xung đột
 * (`items`: kind, nguồn, khoảng UTC), block vẫn `requested`, không chèn một phần (S-012). Hold hết hạn chưa nhả bị dọn
 * trước (INV-I3) nên không tính là xung đột.
 */
export async function approveBlock(
  ctx: CommandContext,
  blockId: string,
  opts: { note?: string; now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const r = await sql<{
    property_id: string;
    unit_id: string;
    period: string;
    status: string;
    requested_by: string;
  }>`
    select property_id, unit_id, period::text as period, status, requested_by from blocks
    where organization_id = ${ctx.actor.orgId} and id = ${blockId} for update`.execute(ctx.trx);
  const b = r.rows[0];
  if (!b) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy block");
  authorize(ctx.actor, "block.approve", { propertyId: b.property_id });
  if (b.status !== "requested")
    throw new CommandError("INVALID_TRANSITION", 409, "Block không ở trạng thái chờ duyệt");
  await lockUnit(ctx.trx, ctx.actor.orgId, b.unit_id);
  const released = await releaseExpiredOverlapping(ctx.trx, ctx.actor.orgId, b.unit_id, b.period, now);
  for (const id of released) {
    await ctx.audit({
      action: "allocation.hold_expired",
      entityType: "allocation",
      entityId: id,
      propertyId: b.property_id,
    });
  }
  const allocationId = randomUUID();
  await sql`savepoint block_alloc`.execute(ctx.trx);
  try {
    await sql`
      insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during, created_by)
      values (${allocationId}, ${ctx.actor.orgId}, ${b.property_id}, ${b.unit_id}, 'block', 'block', ${blockId}, ${b.period}::tstzrange,
              ${ctx.actor.membershipId})`.execute(ctx.trx);
  } catch (err) {
    if ((err as { code?: string }).code !== "23P01") throw err;
    await sql`rollback to savepoint block_alloc`.execute(ctx.trx);
    const c = await sql<{
      allocation_id: string;
      kind: string;
      source_type: string | null;
      source_id: string | null;
      start: string;
      end: string | null;
    }>`
      select id as allocation_id, kind, source_type, source_id, lower(during)::text as start, upper(during)::text as "end"
      from allocations
      where organization_id = ${ctx.actor.orgId} and unit_id = ${b.unit_id} and active
        and during && ${b.period}::tstzrange and (kind <> 'hold' or expires_at > ${now})
      order by lower(during), id`.execute(ctx.trx);
    throw new CommandError(
      "BLOCK_CONFLICT",
      409,
      "Khoảng block đụng khách/hợp đồng đã có — cần tái bố trí trước",
      { extensions: { items: c.rows } },
    );
  }
  await sql`update blocks set status = 'approved', approved_by = ${ctx.actor.membershipId}, approved_at = now() where id = ${blockId}`.execute(
    ctx.trx,
  );
  await ctx.audit({
    action: "block.approved",
    entityType: "block",
    entityId: blockId,
    propertyId: b.property_id,
    ...(opts.note ? { reason: opts.note } : {}),
  });
  return { blockId, allocationId };
}

export interface RelocationRequired {
  exception_id: string;
  allocation_id: string;
  kind: string;
  start: string;
  end: string | null;
  /** Phòng cùng loại còn trống trong đúng khoảng của allocation này — gợi ý, chưa giữ chỗ. */
  alternatives: AlternativeUnit[];
}

/**
 * Bật/tắt ngừng khai thác (S-013). Ngừng khai thác KHÔNG xoá/huỷ booking: mỗi allocation `hold` còn hạn/`stay`/`lease`
 * chưa kết thúc trên phòng được gắn một `exceptions` `RELOCATION_REQUIRED` (mở, không trùng nhờ unique một phần) và trả
 * kèm phòng cùng loại còn trống để chuyển (`inventory.moveAllocation`). Bật lại → các yêu cầu tái bố trí của phòng tự đóng.
 */
export async function setUnitAvailability(
  ctx: CommandContext,
  input: { unitId: string; availability: "active" | "out_of_service"; reason?: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const unit = await lockUnit(ctx.trx, ctx.actor.orgId, input.unitId);
  authorize(ctx.actor, "unit.set_availability", { propertyId: unit.property_id });
  const reason = input.reason?.trim() ?? "";
  if (input.availability === "out_of_service" && reason.length < 1)
    throw fieldError("reason", "REQUIRED", "Cần ghi lý do ngừng khai thác");
  const changed = unit.availability !== input.availability;
  if (changed) {
    await sql`update units set availability = ${input.availability},
                availability_reason = ${input.availability === "active" ? null : reason}
              where organization_id = ${ctx.actor.orgId} and id = ${input.unitId}`.execute(ctx.trx);
  }
  const relocations: RelocationRequired[] = [];
  if (input.availability === "out_of_service") {
    await sql`
      insert into exceptions (id, organization_id, property_id, type, allocation_id)
      select gen_random_uuid(), a.organization_id, a.property_id, 'RELOCATION_REQUIRED', a.id
      from allocations a
      where a.organization_id = ${ctx.actor.orgId} and a.unit_id = ${input.unitId} and a.active
        and a.kind in ('hold', 'stay', 'lease')
        and (a.kind <> 'hold' or a.expires_at > ${now})
        and (upper(a.during) is null or upper(a.during) > ${now})
      on conflict (organization_id, allocation_id, type) where status = 'open' do nothing`.execute(ctx.trx);
    const open = await sql<{
      exception_id: string;
      allocation_id: string;
      kind: string;
      range: string;
      start: string;
      end: string | null;
    }>`
      select e.id as exception_id, a.id as allocation_id, a.kind, a.during::text as range,
             lower(a.during)::text as start, upper(a.during)::text as "end"
      from exceptions e
      join allocations a on a.organization_id = e.organization_id and a.id = e.allocation_id
      where e.organization_id = ${ctx.actor.orgId} and a.unit_id = ${input.unitId}
        and e.type = 'RELOCATION_REQUIRED' and e.status = 'open'
      order by lower(a.during), a.id`.execute(ctx.trx);
    for (const o of open.rows) {
      relocations.push({
        exception_id: o.exception_id,
        allocation_id: o.allocation_id,
        kind: o.kind,
        start: o.start,
        end: o.end,
        alternatives: await alternativeUnits(ctx.trx, ctx.actor.orgId, input.unitId, o.range, now),
      });
    }
  } else if (changed) {
    await sql`
      update exceptions e set status = 'resolved', resolution = 'unit_restored',
             resolved_by = ${ctx.actor.membershipId}, resolved_at = ${now}
      from allocations a
      where e.organization_id = ${ctx.actor.orgId} and a.organization_id = e.organization_id and a.id = e.allocation_id
        and a.unit_id = ${input.unitId} and e.type = 'RELOCATION_REQUIRED' and e.status = 'open'`.execute(
      ctx.trx,
    );
  }
  if (changed) {
    await ctx.audit({
      action: "unit.availability_changed",
      entityType: "unit",
      entityId: input.unitId,
      propertyId: unit.property_id,
      before: { availability: unit.availability },
      after: { availability: input.availability, exception_count: relocations.length },
      ...(reason ? { reason } : {}),
    });
    await ctx.emit({
      eventType: "unit.availability_changed",
      aggregateType: "unit",
      aggregateId: input.unitId,
      propertyId: unit.property_id,
      payload: { unit_id: input.unitId, availability: input.availability },
    });
  }
  return {
    unitId: input.unitId,
    availability: input.availability,
    exceptionIds: relocations.map((x) => x.exception_id),
    relocations,
  };
}

export type Occupancy = "vacant" | "held" | "occupied" | "blocked";

/** Chiếm dụng suy từ các loại allocation đang hiệu lực tại một thời điểm: block > ở/hợp đồng > giữ chỗ > trống. */
export function occupancyOf(kinds: readonly string[]): Occupancy {
  if (kinds.includes("block")) return "blocked";
  if (kinds.some((k) => k === "stay" || k === "lease")) return "occupied";
  return kinds.includes("hold") ? "held" : "vacant";
}

/** Ba chiều trạng thái ĐỘC LẬP của một phòng tại thời điểm `at` (DOMAIN-MODEL §3). */
export async function unitStatus(trx: Transaction<unknown>, orgId: string, unitId: string, at: Date) {
  const r = await sql<{ housekeeping_status: string; availability: string; kinds: string[] | null }>`
    select u.housekeeping_status, u.availability,
           array_agg(a.kind) filter (where a.id is not null) as kinds
    from units u
    left join allocations a on a.organization_id = u.organization_id and a.unit_id = u.id and a.active
                            and a.during @> ${at}::timestamptz and (a.kind <> 'hold' or a.expires_at > ${at})
    where u.organization_id = ${orgId} and u.id = ${unitId}
    group by u.id`.execute(trx);
  const u = r.rows[0];
  if (!u) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  return {
    occupancy: occupancyOf(u.kinds ?? []),
    housekeeping: u.housekeeping_status,
    availability: u.availability,
  };
}
