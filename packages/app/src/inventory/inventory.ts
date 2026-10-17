// Lịch tài nguyên (SPEC-inventory-allocation, DOMAIN-MODEL §3). Bất biến chồng phòng nằm ở CSDL (EXCLUDE — INV-I1);
// code chỉ dọn hold hết hạn dưới khoá phòng (INV-I3), dịch lỗi 23P01 → ROOM_UNAVAILABLE và ghi audit/outbox.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize, minutesToMs } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/index.ts";
import { createCleaningTask } from "../housekeeping/index.ts";
import { type CommandContext, CommandError } from "../pipeline/index.ts";

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

export async function lockUnit(
  trx: Transaction<unknown>,
  orgId: string,
  unitId: string,
): Promise<{ property_id: string; availability: string; room_type_id: string | null }> {
  const r = await sql<{
    property_id: string;
    availability: string;
    room_type_id: string | null;
    archived_at: Date | null;
  }>`
    select property_id, availability, room_type_id, archived_at from units where organization_id = ${orgId} and id = ${unitId} for update`.execute(
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

/** Phòng cùng loại, cùng cơ sở, còn trống trong khoảng (đã trừ hold còn hạn, block, ngừng khai thác) — gợi ý khi ROOM_UNAVAILABLE. */
async function alternativeUnits(
  trx: Transaction<unknown>,
  orgId: string,
  unit: { id: string; property_id: string; room_type_id: string | null },
  range: string,
  now: Date,
): Promise<{ unit_id: string; code: string }[]> {
  if (!unit.room_type_id) return [];
  const r = await sql<{ unit_id: string; code: string }>`
    select u.id as unit_id, u.code from units u
    where u.organization_id = ${orgId} and u.property_id = ${unit.property_id} and u.room_type_id = ${unit.room_type_id}
      and u.id <> ${unit.id} and u.archived_at is null and u.availability = 'active'
      and not exists (select 1 from allocations a where a.organization_id = u.organization_id and a.unit_id = u.id and a.active
                        and (a.kind <> 'hold' or a.expires_at > ${now}) and a.during && ${range}::tstzrange)
    order by u.code limit 5`.execute(trx);
  return r.rows;
}

export interface CreateHoldInput {
  unitId: string;
  during: Interval;
  ttlMinutes: number;
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
  if (!Number.isInteger(input.ttlMinutes) || input.ttlMinutes <= 0) {
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
  const expiresAt = new Date(now.getTime() + minutesToMs(input.ttlMinutes));
  try {
    await sql`savepoint hold_insert`.execute(ctx.trx);
    await sql`
      insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during, expires_at, created_by)
      values (${id}, ${ctx.actor.orgId}, ${unit.property_id}, ${input.unitId}, 'hold', ${input.sourceType ?? null},
              ${input.sourceId ?? null}, ${range}::tstzrange, ${expiresAt}, ${ctx.actor.membershipId})`.execute(
      ctx.trx,
    );
  } catch (err) {
    // Về lại savepoint để người gọi còn dùng được transaction (vd tìm phòng gợi ý — SPEC-reservation-stay S-004).
    if ((err as { code?: string }).code === "23P01") {
      await sql`rollback to savepoint hold_insert`.execute(ctx.trx);
      const alternatives = await alternativeUnits(
        ctx.trx,
        ctx.actor.orgId,
        { id: input.unitId, property_id: unit.property_id, room_type_id: unit.room_type_id },
        range,
        now,
      );
      throw new CommandError("ROOM_UNAVAILABLE", 409, "Phòng đã có người đặt trong khoảng thời gian này", {
        extensions: { alternatives },
      });
    }
    throw err;
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
  if (row.expires_at.getTime() <= now.getTime()) {
    // Lệnh chính rollback nên việc nhả hold (đúng một lần, kèm audit như job worker — INV-I3) ghi ở transaction riêng.
    const { orgId } = ctx.actor;
    throw new CommandError("HOLD_EXPIRED", 409, "Giữ chỗ đã hết hạn", {
      persist: async (trx, audit) => {
        const released = await sql`
          update allocations set active = false, deactivated_at = ${now}, deactivated_reason = 'expired'
          where organization_id = ${orgId} and id = ${allocationId} and kind = 'hold' and active
          returning id`.execute(trx);
        if (released.rows[0]) {
          await audit({
            action: "allocation.hold_expired",
            entityType: "allocation",
            entityId: allocationId,
            propertyId: row.property_id,
          });
        }
        return {};
      },
    });
  }
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
  input: { allocationId: string; toUnitId: string; at: Date; reason: string },
) {
  if (!input.reason.trim()) throw new CommandError("VALIDATION_FAILED", 422, "Cần ghi lý do chuyển phòng");
  // Khoá cả phòng nguồn lẫn phòng đích theo id tăng dần (SPEC-inventory) — hai lệnh chuyển ngược chiều không thể khoá chéo.
  const src = await sql<{ unit_id: string }>`
    select unit_id from allocations where organization_id = ${ctx.actor.orgId} and id = ${input.allocationId} and active`.execute(
    ctx.trx,
  );
  const srcUnit = src.rows[0]?.unit_id;
  if (!srcUnit) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phân bổ phòng");
  for (const unitId of [...new Set([srcUnit, input.toUnitId])].sort()) {
    await sql`select 1 from units where organization_id = ${ctx.actor.orgId} and id = ${unitId} for update`.execute(
      ctx.trx,
    );
  }
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
  const target = await lockUnit(ctx.trx, ctx.actor.orgId, input.toUnitId);
  if (target.property_id !== a.property_id)
    throw new CommandError("VALIDATION_FAILED", 422, "Chỉ chuyển trong cùng cơ sở");
  const newId = randomUUID();
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
  // Phòng cũ thành bẩn và có đúng một việc dọn mở (F-007) — cùng transaction với việc chuyển.
  await createCleaningTask(ctx, {
    propertyId: a.property_id,
    unitId: a.unit_id,
    sourceType: "move",
    sourceId: newId,
  });
  await ctx.audit({
    action: "allocation.moved",
    entityType: "allocation",
    entityId: input.allocationId,
    propertyId: a.property_id,
    reason: input.reason,
    before: { unit_id: a.unit_id, start: a.lo.toISOString(), end: a.hi ? a.hi.toISOString() : null },
    after: {
      unit_id: input.toUnitId,
      effective_at: input.at.toISOString(),
      old_end: input.at.toISOString(),
      new_allocation: newId,
    },
  });
  return { newAllocationId: newId };
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

/** Duyệt block = tạo allocation `block`; đụng khách đã xác nhận → BLOCK_CONFLICT, block vẫn `requested`. */
export async function approveBlock(ctx: CommandContext, blockId: string) {
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
  try {
    await sql`savepoint block_alloc`.execute(ctx.trx);
    await sql`
      insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during, created_by)
      values (${randomUUID()}, ${ctx.actor.orgId}, ${b.property_id}, ${b.unit_id}, 'block', 'block', ${blockId}, ${b.period}::tstzrange,
              ${ctx.actor.membershipId})`.execute(ctx.trx);
  } catch (err) {
    if ((err as { code?: string }).code === "23P01") {
      await sql`rollback to savepoint block_alloc`.execute(ctx.trx);
      // Danh sách allocation đang chiếm khoảng (kind, nguồn, khoảng) để người duyệt biết cần chuyển ai (SPEC-inventory S-012).
      const c = await sql<{
        kind: string;
        source_type: string | null;
        source_id: string | null;
        lo: Date;
        hi: Date | null;
      }>`
        select kind, source_type, source_id, lower(during) as lo, upper(during) as hi from allocations
        where organization_id = ${ctx.actor.orgId} and unit_id = ${b.unit_id} and active and during && ${b.period}::tstzrange
        order by lower(during), id`.execute(ctx.trx);
      throw new CommandError(
        "BLOCK_CONFLICT",
        409,
        "Khoảng block đụng khách/hợp đồng đã có — cần tái bố trí trước",
        {
          extensions: {
            items: c.rows.map((x) => ({
              kind: x.kind,
              source_type: x.source_type,
              source_id: x.source_id,
              start: x.lo.toISOString(),
              end: x.hi ? x.hi.toISOString() : null,
            })),
          },
        },
      );
    }
    throw err;
  }
  await sql`update blocks set status = 'approved', approved_by = ${ctx.actor.membershipId}, approved_at = now() where id = ${blockId}`.execute(
    ctx.trx,
  );
  await ctx.audit({
    action: "block.approved",
    entityType: "block",
    entityId: blockId,
    propertyId: b.property_id,
  });
}

export type Occupancy = "vacant" | "held" | "occupied" | "blocked";

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
  const kinds = u.kinds ?? [];
  const occupancy: Occupancy = kinds.includes("block")
    ? "blocked"
    : kinds.some((k) => k === "stay" || k === "lease")
      ? "occupied"
      : kinds.includes("hold")
        ? "held"
        : "vacant";
  return { occupancy, housekeeping: u.housekeeping_status, availability: u.availability };
}

/**
 * `inventory.getUnitStatus` (query, SPEC-housekeeping S-007, S-010): ba chiều trạng thái + `ready_for_arrival` = trống, đang
 * khai thác và đã kiểm (`inspected`; cơ sở không bắt buộc kiểm thì `clean` cũng được). "Sạch" không có nghĩa là "trống".
 */
export async function getUnitStatus(
  db: Kysely<unknown>,
  actor: Actor,
  unitId: string,
  at = new Date(),
): Promise<{
  unitId: string;
  occupancy: Occupancy;
  housekeeping: string;
  availability: string;
  readyForArrival: boolean;
  sellable: boolean;
}> {
  if (!/^[0-9a-f-]{36}$/i.test(unitId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const p = await sql<{ property_id: string; require_inspected: boolean }>`
      select u.property_id, p.require_inspected from units u join properties p on p.organization_id = u.organization_id and p.id = u.property_id
      where u.organization_id = ${actor.orgId} and u.id = ${unitId}`.execute(trx);
    const row = p.rows[0];
    if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
    try {
      authorize(actor, "calendar.read_status", { propertyId: row.property_id });
    } catch {
      throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
    }
    const s = await unitStatus(trx, actor.orgId, unitId, at);
    const clean = s.housekeeping === "inspected" || (!row.require_inspected && s.housekeeping === "clean");
    return {
      unitId,
      ...s,
      // Còn bán được: không có ai chiếm/giữ/chặn tại `at` và phòng đang khai thác — vệ sinh không ảnh hưởng (bẩn vẫn bán được).
      sellable: s.occupancy === "vacant" && s.availability === "active",
      readyForArrival: s.occupancy === "vacant" && s.availability === "active" && clean,
    };
  });
}

/**
 * `inventory.endBlock` (SPEC-housekeeping S-019; SPEC-inventory block): chỉ owner/manager (`block.approve`); block `approved` →
 * `ended`, allocation block thu lại tới thời điểm kết thúc (chưa bắt đầu → nhả). Gọi lại block đã kết thúc → 409.
 */
export async function endBlock(
  ctx: CommandContext,
  blockId: string,
  now = new Date(),
): Promise<{ blockId: string }> {
  const r = await sql<{ property_id: string; status: string }>`
    select property_id, status from blocks where organization_id = ${ctx.actor.orgId} and id = ${blockId} for update`.execute(
    ctx.trx,
  );
  const b = r.rows[0];
  if (!b) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy block");
  authorize(ctx.actor, "block.approve", { propertyId: b.property_id });
  if (b.status !== "approved")
    throw new CommandError("INVALID_TRANSITION", 409, "Block không ở trạng thái đang chặn");
  const a = await sql<{ id: string; lo: Date; hi: Date }>`
    select id, lower(during) as lo, upper(during) as hi from allocations
    where organization_id = ${ctx.actor.orgId} and kind = 'block' and source_id = ${blockId} and active for update`.execute(
    ctx.trx,
  );
  for (const al of a.rows) {
    if (now.getTime() <= al.lo.getTime()) {
      await sql`update allocations set active = false, deactivated_at = ${now}, deactivated_reason = 'ended'
                where organization_id = ${ctx.actor.orgId} and id = ${al.id}`.execute(ctx.trx);
    } else if (now.getTime() < al.hi.getTime()) {
      // Đang chặn: giữ khoảng đã chặn thật (lịch sử) rồi nhả — bất biến `trg_blocks_allocation`: ended ⇒ không còn active.
      await sql`update allocations set during = tstzrange(lower(during), ${now}, '[)'), active = false, deactivated_at = ${now},
                       deactivated_reason = 'ended'
                where organization_id = ${ctx.actor.orgId} and id = ${al.id}`.execute(ctx.trx);
    } else {
      // Khoảng chặn đã qua (sửa xong muộn hơn hạn block): giữ nguyên khoảng, chỉ nhả (review buồng phòng/sự cố R1).
      await sql`update allocations set active = false, deactivated_at = ${now}, deactivated_reason = 'ended'
                where organization_id = ${ctx.actor.orgId} and id = ${al.id}`.execute(ctx.trx);
    }
  }
  await sql`update blocks set status = 'ended', ended_at = ${now}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${blockId}`.execute(ctx.trx);
  await ctx.audit({
    action: "block.ended",
    entityType: "block",
    entityId: blockId,
    propertyId: b.property_id,
  });
  return { blockId };
}
