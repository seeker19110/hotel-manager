// Việc buồng phòng (SPEC-housekeeping-maintenance; ERD `tasks`). Phần lõi dùng chung: tạo việc dọn từ check-out/chuyển phòng
// /nghiệm thu sửa chữa — không tạo trùng cho một phòng (S-002: việc đang mở được ghi thêm nguồn), phòng về `dirty` cùng
// transaction (S-001). Vòng đời giao/nhận/nghiệm thu: T-211.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { CommandContext } from "../pipeline/command.ts";

export type TaskSource = "stay" | "move" | "work_order" | "lease" | "manual";

export async function createCleaningTask(
  ctx: CommandContext,
  input: {
    propertyId: string;
    unitId: string;
    sourceType: TaskSource;
    sourceId: string | null;
    note?: string;
  },
): Promise<{ taskId: string; created: boolean }> {
  const unit = await sql<{ housekeeping_status: string }>`
    select housekeeping_status from units where organization_id = ${ctx.actor.orgId} and id = ${input.unitId} for update`.execute(
    ctx.trx,
  );
  const prev = unit.rows[0]?.housekeeping_status ?? "clean";
  const open = await sql<{ id: string }>`
    select id from tasks where organization_id = ${ctx.actor.orgId} and unit_id = ${input.unitId} and kind = 'cleaning'
      and status in ('open','assigned','in_progress') for update`.execute(ctx.trx);
  const existing = open.rows[0];
  if (existing) {
    await sql`update tasks set extra_sources = extra_sources || ${JSON.stringify([{ type: input.sourceType, id: input.sourceId }])}::jsonb,
                     version = version + 1
              where organization_id = ${ctx.actor.orgId} and id = ${existing.id}`.execute(ctx.trx);
    await ctx.audit({
      action: "housekeeping.task_source_added",
      entityType: "task",
      entityId: existing.id,
      propertyId: input.propertyId,
      after: { source_type: input.sourceType, source_id: input.sourceId },
    });
    return { taskId: existing.id, created: false };
  }
  const id = randomUUID();
  await sql`
    insert into tasks (id, organization_id, property_id, unit_id, kind, status, source_type, source_id, note,
                       previous_housekeeping_status, created_by)
    values (${id}, ${ctx.actor.orgId}, ${input.propertyId}, ${input.unitId}, 'cleaning', 'open', ${input.sourceType},
            ${input.sourceId}, ${input.note ?? null}, ${prev}, ${ctx.actor.membershipId})`.execute(ctx.trx);
  await sql`update units set housekeeping_status = 'dirty', version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${input.unitId}`.execute(ctx.trx);
  await ctx.audit({
    action: "housekeeping.task_created",
    entityType: "task",
    entityId: id,
    propertyId: input.propertyId,
    after: { kind: "cleaning", source_type: input.sourceType, unit_id: input.unitId },
  });
  await ctx.emit({
    eventType: "housekeeping.task_created",
    aggregateType: "task",
    aggregateId: id,
    propertyId: input.propertyId,
    payload: { task_id: id, unit_id: input.unitId },
  });
  return { taskId: id, created: true };
}
