// Ngoại lệ lịch (`exceptions`, DOMAIN-MODEL §7; SPEC-inventory-allocation §4): mở đúng một ngoại lệ đang mở cho mỗi
// (allocation, loại) nhờ unique `uq_exceptions_open`; chạy lại bao nhiêu lần cũng một hiệu lực. Dùng chung cho command
// (`setUnitAvailability`, `resizeAllocation`) và job worker (`inventory.detectOverdue`, `lease.detectOverstay`).
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { currentTraceparent } from "../logging/index.ts";

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
 * Booking đã xác nhận KẾ TIẾP trên cùng phòng sau khi allocation quá hạn kết thúc → `RELOCATION_REQUIRED` (SPEC S-017, S-020;
 * Q-09). "Đã xác nhận" = allocation `stay` đang active (lượt ở `expected`/`in_house`); hold chưa xác nhận không tính.
 * Trả ngoại lệ vừa MỞ MỚI (đã có rồi thì rỗng) để người gọi ghi audit/outbox.
 */
export async function openRelocationForNextBooking(
  trx: Transaction<unknown>,
  a: { orgId: string; propertyId: string; overstayAllocationId: string },
): Promise<{ id: string; allocationId: string }[]> {
  const next = await sql<{ id: string }>`
    select n.id from allocations o
    join allocations n on n.organization_id = o.organization_id and n.unit_id = o.unit_id and n.active and n.kind = 'stay'
                      and n.id <> o.id and lower(n.during) >= upper(o.during)
    where o.organization_id = ${a.orgId} and o.id = ${a.overstayAllocationId} and not upper_inf(o.during)
    order by lower(n.during), n.id limit 1`.execute(trx);
  const target = next.rows[0];
  if (!target) return [];
  const e = await openException(trx, {
    orgId: a.orgId,
    propertyId: a.propertyId,
    type: "RELOCATION_REQUIRED",
    allocationId: target.id,
    relatedAllocationId: a.overstayAllocationId,
  });
  return e.created ? [{ id: e.id, allocationId: target.id }] : [];
}
