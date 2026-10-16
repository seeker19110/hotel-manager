// Việc dọn phòng sinh từ nghiệp vụ khác (SPEC-housekeeping-maintenance S-001, S-002) và đồng bộ chiều vệ sinh của phòng
// (`units.housekeeping_status`) theo tiến độ việc. Chỉ đụng chiều vệ sinh — KHÔNG đổi chiếm dụng/khai thác (S-010).
// Gọi trong transaction của lệnh nguồn (check-out, chuyển phòng) để "cùng transaction" như SPEC; không phụ thuộc module khác của app.
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";

export type TaskStatus = "open" | "assigned" | "in_progress" | "done" | "verified" | "cancelled";
export type TaskSourceType = "stay" | "move" | "work_order" | "lease" | "manual";

/** Ánh xạ trạng thái việc dọn → chiều vệ sinh của phòng (SPEC §2; `cancelled` xử lý riêng). */
export const UNIT_STATUS_OF: Readonly<Record<Exclude<TaskStatus, "cancelled">, string>> = {
  open: "dirty",
  assigned: "assigned",
  in_progress: "cleaning",
  done: "clean",
  verified: "inspected",
};

export interface SyncTask {
  id: string;
  unit_id: string;
  kind: string;
  status: TaskStatus;
}

/**
 * Đặt `units.housekeeping_status` theo việc dọn `task`. Chỉ việc dọn (`cleaning`) và chỉ việc MỚI NHẤT của phòng mới chi phối
 * (việc cũ `done` chờ nghiệm thu bị việc mới thay thế thì nghiệm thu muộn không biến phòng bẩn thành "đã kiểm").
 * `cancelled` ("giữ trạng thái trước"): phòng chưa được dọn xong nên `assigned`/`cleaning` quay về `dirty`; `clean`/`inspected` giữ nguyên.
 */
export async function syncUnitHousekeeping(
  trx: Transaction<unknown>,
  orgId: string,
  task: SyncTask,
): Promise<void> {
  if (task.kind !== "cleaning") return;
  if (task.status === "cancelled") {
    await sql`
      update units set housekeeping_status = 'dirty'
      where organization_id = ${orgId} and id = ${task.unit_id} and housekeeping_status in ('assigned', 'cleaning')`.execute(
      trx,
    );
    return;
  }
  const latest = await sql<{ id: string }>`
    select id from tasks
    where organization_id = ${orgId} and unit_id = ${task.unit_id} and kind = 'cleaning' and status <> 'cancelled'
    order by created_at desc, id desc limit 1`.execute(trx);
  if (latest.rows[0]?.id !== task.id) return;
  await sql`
    update units set housekeeping_status = ${UNIT_STATUS_OF[task.status]}
    where organization_id = ${orgId} and id = ${task.unit_id} and housekeeping_status <> ${UNIT_STATUS_OF[task.status]}`.execute(
    trx,
  );
}

export interface OpenCleaningInput {
  orgId: string;
  propertyId: string;
  unitId: string;
  source: { type: TaskSourceType; id: string | null };
  note?: string | null;
  priority?: "normal" | "high" | "urgent";
  now?: Date;
}

export interface OpenCleaningResult {
  taskId: string;
  /** false = đã có việc (cùng nguồn, hoặc việc dọn đang mở của phòng được ghi thêm nguồn). */
  created: boolean;
  status: TaskStatus;
}

/**
 * Mở việc dọn cho một phòng (S-001/S-002), idempotent:
 * - cùng nguồn (loại, id) đã được xử lý (là nguồn chính hoặc nguồn thêm) → trả việc đó, không đụng gì;
 * - phòng đã có việc dọn chưa kết thúc (`open`/`assigned`/`in_progress`) → không tạo mới, ghi thêm nguồn vào `extra_sources`,
 *   phòng giữ đúng chiều vệ sinh của việc đó;
 * - ngược lại (chưa có, hoặc việc cũ đã `done`/`verified`/`cancelled`) → tạo việc `open`, phòng về `dirty`.
 * Phụ thuộc unique một phần `uq_tasks_open_cleaning` nên hai lời gọi song song cho cùng phòng chỉ tạo một việc.
 */
export async function openCleaningTask(
  trx: Transaction<unknown>,
  input: OpenCleaningInput,
): Promise<OpenCleaningResult> {
  const { orgId, source } = input;
  const at = (input.now ?? new Date()).toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (source.id) {
      const dup = await sql<{ id: string; status: TaskStatus }>`
        select id, status from tasks
        where organization_id = ${orgId} and kind = 'cleaning'
          and ((source_type = ${source.type} and source_id = ${source.id})
               or extra_sources @> ${JSON.stringify([{ type: source.type, id: source.id }])}::jsonb)
        limit 1`.execute(trx);
      if (dup.rows[0]) return { taskId: dup.rows[0].id, created: false, status: dup.rows[0].status };
    }
    const id = randomUUID();
    const ins = await sql<{ id: string }>`
      insert into tasks (id, organization_id, property_id, unit_id, kind, priority, source_type, source_id, note)
      values (${id}, ${orgId}, ${input.propertyId}, ${input.unitId}, 'cleaning', ${input.priority ?? "normal"}, ${source.type},
              ${source.id}, ${input.note ?? null})
      on conflict do nothing
      returning id`.execute(trx);
    if (ins.rows[0]) {
      await syncUnitHousekeeping(trx, orgId, { id, unit_id: input.unitId, kind: "cleaning", status: "open" });
      return { taskId: id, created: true, status: "open" };
    }
    const open = await sql<{ id: string; status: TaskStatus }>`
      select id, status from tasks
      where organization_id = ${orgId} and unit_id = ${input.unitId} and kind = 'cleaning'
        and status in ('open', 'assigned', 'in_progress')
      for update`.execute(trx);
    const row = open.rows[0];
    if (!row) continue; // việc đang mở vừa kết thúc giữa hai câu lệnh — thử lại
    await sql`
      update tasks set extra_sources = extra_sources || ${JSON.stringify([{ type: source.type, id: source.id, at }])}::jsonb
      where organization_id = ${orgId} and id = ${row.id}`.execute(trx);
    await syncUnitHousekeeping(trx, orgId, {
      id: row.id,
      unit_id: input.unitId,
      kind: "cleaning",
      status: row.status,
    });
    return { taskId: row.id, created: false, status: row.status };
  }
  throw new Error("openCleaningTask: không ổn định được việc dọn sau 3 lần thử");
}
