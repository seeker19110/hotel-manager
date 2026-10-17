// Ngoại lệ lịch (`exceptions`, DOMAIN-MODEL §7; SPEC-inventory-allocation §4): mở đúng một ngoại lệ đang mở cho mỗi
// (allocation, loại) nhờ unique `uq_exceptions_open`; chạy lại bao nhiêu lần cũng một hiệu lực. Dùng chung cho command
// (`setUnitAvailability`, `resizeAllocation`) và job worker (`inventory.detectOverdue`, `lease.detectOverstay`).
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { currentTraceparent } from "../logging/index.ts";
import type { CommandContext } from "../pipeline/index.ts";

export type ExceptionType = "LEASE_OVERSTAY" | "STAY_OVERSTAY" | "RELOCATION_REQUIRED" | "EXTENSION_CONFLICT";

/** Mở ngoại lệ cho allocation; đã có cái đang mở cùng loại thì trả cái đó (`created: false`). */
export async function openException(
  trx: Transaction<unknown>,
  a: {
    orgId: string;
    propertyId: string;
    type: ExceptionType;
    allocationId: string;
    relatedAllocationId?: string | null;
  },
): Promise<{ id: string; created: boolean }> {
  const id = randomUUID();
  const ins = await sql<{ id: string }>`
    insert into exceptions (id, organization_id, property_id, type, allocation_id, related_allocation_id)
    values (${id}, ${a.orgId}, ${a.propertyId}, ${a.type}, ${a.allocationId}, ${a.relatedAllocationId ?? null})
    on conflict do nothing returning id`.execute(trx);
  if (ins.rows[0]) return { id, created: true };
  const cur = await sql<{ id: string }>`
    select id from exceptions where organization_id = ${a.orgId} and allocation_id = ${a.allocationId}
      and type = ${a.type} and status = 'open'`.execute(trx);
  const existing = cur.rows[0];
  if (!existing) throw new Error("exceptions: xung đột chèn nhưng không thấy ngoại lệ đang mở");
  return { id: existing.id, created: false };
}

/** Outbox `exception.opened` (SPEC §9; dedupe theo ngoại lệ). Người gọi tự ghi audit tương ứng (command: `ctx.audit`). */
export async function insertExceptionOutbox(
  trx: Transaction<unknown>,
  a: {
    orgId: string;
    propertyId: string;
    exceptionId: string;
    type: ExceptionType;
    details: Record<string, string | number | boolean | null>;
    correlationId: string;
    commandId?: string;
  },
): Promise<void> {
  await sql`
    insert into outbox (id, organization_id, property_id, event_type, aggregate_type, aggregate_id, payload, correlation_id,
                        command_id, dedupe_key, traceparent)
    values (${randomUUID()}, ${a.orgId}, ${a.propertyId}, 'exception.opened', 'exception', ${a.exceptionId},
            ${JSON.stringify({ exception_id: a.exceptionId, type: a.type, ...a.details })}::jsonb, ${a.correlationId},
            ${a.commandId ?? null}, ${`exception.opened:${a.exceptionId}`}, ${currentTraceparent()})`.execute(
    trx,
  );
}

/** Audit + outbox `exception.opened` do WORKER ghi (actor_type='worker') trong ngữ cảnh tổ chức — cùng transaction với ngoại lệ. */
export async function recordWorkerExceptionOpened(
  trx: Transaction<unknown>,
  a: {
    orgId: string;
    propertyId: string;
    exceptionId: string;
    type: ExceptionType;
    details: Record<string, string | number | boolean | null>;
    correlationId: string;
  },
): Promise<void> {
  await sql`
    insert into audit_events (id, organization_id, property_id, actor_type, action, entity_type, entity_id, after, correlation_id)
    values (${randomUUID()}, ${a.orgId}, ${a.propertyId}, 'worker', 'exception.opened', 'exception', ${a.exceptionId},
            ${JSON.stringify({ type: a.type, ...a.details })}::jsonb, ${a.correlationId})`.execute(trx);
  await insertExceptionOutbox(trx, a);
}

/**
 * MỖI booking đã xác nhận đứng sau allocation quá hạn trên cùng phòng → `RELOCATION_REQUIRED` (SPEC S-017, S-020; Q-09 hiểu chặt:
 * ngoại lệ quá hạn chưa có mốc giải quyết nên mọi booking bắt đầu từ lúc allocation kết thúc đều bị đụng, không chỉ cái kế tiếp).
 * "Đã xác nhận" = allocation `stay`/`lease` đang active (lượt ở `expected`/`in_house`, hợp đồng); hold chưa xác nhận không tính.
 * Cùng tiêu chí với `related_allocation_id` của `app.stays_overdue` (migration 0061). Trả các ngoại lệ vừa MỞ MỚI (đã có rồi thì
 * bỏ qua) để người gọi ghi audit/outbox.
 */
export async function openRelocationForNextBooking(
  trx: Transaction<unknown>,
  a: { orgId: string; propertyId: string; overstayAllocationId: string },
): Promise<{ id: string; allocationId: string }[]> {
  const next = await sql<{ id: string }>`
    select n.id from allocations o
    join allocations n on n.organization_id = o.organization_id and n.unit_id = o.unit_id and n.active
                      and n.kind in ('stay', 'lease') and n.id <> o.id and lower(n.during) >= upper(o.during)
    where o.organization_id = ${a.orgId} and o.id = ${a.overstayAllocationId} and not upper_inf(o.during)
    order by lower(n.during), n.id`.execute(trx);
  const opened: { id: string; allocationId: string }[] = [];
  for (const target of next.rows) {
    const e = await openException(trx, {
      orgId: a.orgId,
      propertyId: a.propertyId,
      type: "RELOCATION_REQUIRED",
      allocationId: target.id,
      relatedAllocationId: a.overstayAllocationId,
    });
    if (e.created) opened.push({ id: e.id, allocationId: target.id });
  }
  return opened;
}

/**
 * Đóng ngoại lệ quá hạn khi người ở thực sự đã trả phòng (check-out muộn, bàn giao trả hợp đồng): `STAY_OVERSTAY`/`LEASE_OVERSTAY`
 * trên allocation đó và `RELOCATION_REQUIRED` do chính nó gây ra (`related_allocation_id`). Allocation quá hạn vẫn `active` (giữ lịch
 * sử, không kéo dài hồi tố) nên nếu không đóng ngoại lệ thì phòng bị chặn `ROOM_OCCUPIED` mãi. Mỗi ngoại lệ đóng ghi audit +
 * outbox `exception.resolved` cùng transaction của lệnh gọi; không có ngoại lệ mở thì không làm gì. Trả id ngoại lệ vừa đóng.
 */
export async function resolveOverstayExceptions(
  ctx: CommandContext,
  a: { allocationId: string; propertyId: string; resolution: string },
): Promise<string[]> {
  // Một ngoại lệ mở mỗi (allocation, loại) dùng chung cho hai nguyên nhân (quá hạn và phòng ngừng khai thác — S-013): nếu phòng của
  // booking đích còn `out_of_service` thì nguyên nhân thứ hai còn nguyên, trả phòng muộn không được làm booking mất nhắc.
  const r = await sql<{ id: string; type: ExceptionType }>`
    update exceptions set status = 'resolved', resolution = ${a.resolution}, resolved_by = ${ctx.actor.membershipId},
                          resolved_at = now(), version = version + 1
    where organization_id = ${ctx.actor.orgId} and status = 'open'
      and ((allocation_id = ${a.allocationId} and type in ('STAY_OVERSTAY', 'LEASE_OVERSTAY'))
           or (related_allocation_id = ${a.allocationId} and type = 'RELOCATION_REQUIRED'
               and not exists (select 1 from allocations t join units u on u.organization_id = t.organization_id and u.id = t.unit_id
                               where t.organization_id = exceptions.organization_id and t.id = exceptions.allocation_id
                                 and u.availability = 'out_of_service')))
    returning id, type`.execute(ctx.trx);
  for (const e of r.rows) {
    await ctx.audit({
      action: "exception.resolved",
      entityType: "exception",
      entityId: e.id,
      propertyId: a.propertyId,
      after: { type: e.type, resolution: a.resolution, allocation_id: a.allocationId },
    });
    await ctx.emit({
      eventType: "exception.resolved",
      aggregateType: "exception",
      aggregateId: e.id,
      propertyId: a.propertyId,
      dedupeKey: `exception.resolved:${e.id}`,
      payload: { exception_id: e.id, type: e.type, resolution: a.resolution },
    });
  }
  return r.rows.map((e) => e.id);
}
