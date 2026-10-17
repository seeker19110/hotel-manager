// Việc buồng phòng (SPEC-housekeeping-maintenance; ERD `tasks`). Phần lõi dùng chung: tạo việc dọn từ check-out/chuyển phòng
// /nghiệm thu sửa chữa — không tạo trùng cho một phòng (S-002: việc đang mở được ghi thêm nguồn), phòng về `dirty` cùng
// transaction (S-001). Vòng đời giao/nhận/nghiệm thu: T-211.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize, TransitionError } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/index.ts";
import { type CommandContext, CommandError } from "../pipeline/index.ts";

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

// ——— Vòng đời việc (T-211; SPEC-housekeeping S-003…S-011, S-020, S-022, S-023) ———

type TaskStatus = "open" | "assigned" | "in_progress" | "done" | "verified" | "cancelled";
/** Ánh xạ trạng thái việc dọn → chiều vệ sinh của phòng (SPEC-housekeeping mục 2). */
const UNIT_STATUS: Partial<Record<TaskStatus, string>> = {
  open: "dirty",
  assigned: "assigned",
  in_progress: "cleaning",
  done: "clean",
  verified: "inspected",
};

interface TaskRow {
  id: string;
  property_id: string;
  unit_id: string;
  kind: "cleaning" | "inspection";
  status: TaskStatus;
  assignee_membership_id: string | null;
  assignee_person_id: string | null;
  done_by: string | null;
  previous_housekeeping_status: string | null;
  source_type: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Đọc việc (RLS đọc theo cơ sở) → kiểm quyền bằng `check` → mới khoá FOR UPDATE. Không đủ quyền nhận 403 đúng SPEC (S-006)
 * thay vì 404; khoá không lấy được hàng mà hàng vẫn đọc được = việc vừa đổi bởi người khác (vd hai người cùng nhận) → 409.
 */
async function lockTask(
  ctx: CommandContext,
  taskId: string,
  check: (t: TaskRow) => void = () => {},
): Promise<TaskRow> {
  if (!UUID.test(taskId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy việc");
  const read = (lock: boolean) =>
    sql<TaskRow>`
      select t.id, t.property_id, t.unit_id, t.kind, t.status, t.assignee_membership_id, m.person_id as assignee_person_id,
             t.done_by, t.previous_housekeeping_status, t.source_type
      from tasks t left join memberships m on m.organization_id = t.organization_id and m.id = t.assignee_membership_id
      where t.organization_id = ${ctx.actor.orgId} and t.id = ${taskId}
      ${lock ? sql`for update of t` : sql``}`.execute(ctx.trx);
  const seen = (await read(false)).rows[0];
  if (!seen || (!ctx.actor.allProperties && !ctx.actor.propertyIds.includes(seen.property_id)))
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy việc");
  check(seen);
  const locked = (await read(true)).rows[0];
  if (!locked) {
    const now = (await read(false)).rows[0];
    throw new TransitionError("task", now?.status ?? seen.status, "changed");
  }
  check(locked);
  return locked;
}

function denyTransition(from: string, to: string): never {
  throw new TransitionError("task", from, to);
}

/** Việc dọn KHÁC đang mở trên cùng phòng (S-002: việc cũ `done` + sự kiện mới ⇒ đã có việc mới). */
async function otherOpenCleaning(ctx: CommandContext, t: TaskRow): Promise<string | null> {
  const r = await sql<{ id: string }>`
    select id from tasks where organization_id = ${ctx.actor.orgId} and unit_id = ${t.unit_id} and kind = 'cleaning'
      and id <> ${t.id} and status in ('open','assigned','in_progress') limit 1`.execute(ctx.trx);
  return r.rows[0]?.id ?? null;
}

async function setUnitStatus(ctx: CommandContext, t: TaskRow, status: TaskStatus): Promise<void> {
  if (t.kind !== "cleaning") return;
  // Phòng đã bẩn lại và có việc dọn mới đang mở: việc cũ không được ghi đè trạng thái phòng (review R2 — không báo phòng
  // sẵn sàng khi còn bẩn).
  if (await otherOpenCleaning(ctx, t)) return;
  // Huỷ: chỉ việc tạo tay mới trả phòng về trạng thái trước đó; việc sinh từ trả phòng/đổi phòng/sự cố thì phòng vẫn bẩn
  // (chưa ai dọn — review R6, D-014).
  const hs =
    status === "cancelled"
      ? t.source_type === "manual"
        ? t.previous_housekeeping_status
        : "dirty"
      : UNIT_STATUS[status];
  if (!hs) return;
  await sql`update units set housekeeping_status = ${hs}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${t.unit_id}`.execute(ctx.trx);
}

async function audited(
  ctx: CommandContext,
  t: TaskRow,
  action: string,
  to: TaskStatus,
  extra: Record<string, unknown> = {},
) {
  await ctx.audit({
    action: `housekeeping.${action}`,
    entityType: "task",
    entityId: t.id,
    propertyId: t.property_id,
    before: { status: t.status, assignee: t.assignee_membership_id },
    after: { status: to, ...extra },
  });
}

/** `housekeeping.createTask` (thủ công): việc dọn đi qua `createCleaningTask` (không trùng); kiểm tra phòng thì tạo mới. */
export async function createTask(
  ctx: CommandContext,
  input: {
    unitId: string;
    kind: "cleaning" | "inspection";
    priority?: "normal" | "high" | "urgent";
    note?: string;
  },
): Promise<{ taskId: string; created: boolean }> {
  if (!UUID.test(input.unitId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  const u = await sql<{ property_id: string }>`
    select property_id from units where organization_id = ${ctx.actor.orgId} and id = ${input.unitId} and archived_at is null`.execute(
    ctx.trx,
  );
  const unit = u.rows[0];
  if (!unit) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  authorize(ctx.actor, "housekeeping.assign", {
    propertyId: unit.property_id,
    subjectPersonId: ctx.actor.personId,
  });
  if (input.note !== undefined && input.note.length > 2000)
    throw new CommandError("VALIDATION_FAILED", 422, "Ghi chú tối đa 2.000 ký tự");
  if (input.kind === "cleaning") {
    const r = await createCleaningTask(ctx, {
      propertyId: unit.property_id,
      unitId: input.unitId,
      sourceType: "manual",
      sourceId: null,
      ...(input.note ? { note: input.note } : {}),
    });
    if (input.priority && r.created)
      await sql`update tasks set priority = ${input.priority} where organization_id = ${ctx.actor.orgId} and id = ${r.taskId}`.execute(
        ctx.trx,
      );
    return r;
  }
  const id = randomUUID();
  await sql`
    insert into tasks (id, organization_id, property_id, unit_id, kind, status, priority, source_type, note, created_by)
    values (${id}, ${ctx.actor.orgId}, ${unit.property_id}, ${input.unitId}, 'inspection', 'open', ${input.priority ?? "normal"},
            'manual', ${input.note ?? null}, ${ctx.actor.membershipId})`.execute(ctx.trx);
  await ctx.audit({
    action: "housekeeping.task_created",
    entityType: "task",
    entityId: id,
    propertyId: unit.property_id,
  });
  return { taskId: id, created: true };
}

/** Người nhận việc: thành viên đang hoạt động, đúng cơ sở, vai trò vận hành. */
async function assertAssignee(
  ctx: CommandContext,
  propertyId: string,
  membershipId: string,
): Promise<string> {
  if (!UUID.test(membershipId)) throw new CommandError("VALIDATION_FAILED", 422, "Người nhận không hợp lệ");
  const r = await sql<{ person_id: string }>`
    select m.person_id from memberships m
    where m.organization_id = ${ctx.actor.orgId} and m.id = ${membershipId} and m.status = 'active'
      and m.role in ('housekeeping','maintenance','manager','owner')
      and (m.all_properties or exists (select 1 from property_scopes ps where ps.organization_id = m.organization_id
                                        and ps.membership_id = m.id and ps.property_id = ${propertyId}))`.execute(
    ctx.trx,
  );
  if (!r.rows[0])
    throw new CommandError(
      "VALIDATION_FAILED",
      422,
      "Người nhận không thuộc cơ sở hoặc không làm buồng phòng",
      {
        extensions: { errors: [{ path: "assignee", field: "assignee", code: "invalid" }] },
      },
    );
  return r.rows[0].person_id;
}

/** `housekeeping.assignTask` (S-004): quản lý/lễ tân giao (hoặc giao lại khi chưa bắt đầu). */
export async function assignTask(
  ctx: CommandContext,
  input: { taskId: string; assigneeMembershipId: string },
) {
  const t = await lockTask(ctx, input.taskId);
  authorize(ctx.actor, "housekeeping.assign", { propertyId: t.property_id });
  if (ctx.actor.role === "housekeeping")
    throw new CommandError("FORBIDDEN", 403, "Buồng phòng chỉ tự nhận việc");
  if (t.status !== "open" && t.status !== "assigned") denyTransition(t.status, "assigned");
  await assertAssignee(ctx, t.property_id, input.assigneeMembershipId);
  await sql`update tasks set status = 'assigned', assignee_membership_id = ${input.assigneeMembershipId}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${t.id}`.execute(ctx.trx);
  await setUnitStatus(ctx, t, "assigned");
  await audited(ctx, t, "task_assigned", "assigned", { assignee: input.assigneeMembershipId });
  return { taskId: t.id, status: "assigned" as const };
}

/** `housekeeping.claimTask` (S-004, Q-02): buồng phòng tự nhận việc `open`; hai người song song → người sau 409. */
export async function claimTask(ctx: CommandContext, input: { taskId: string }) {
  const t = await lockTask(ctx, input.taskId);
  authorize(ctx.actor, "housekeeping.assign", {
    propertyId: t.property_id,
    subjectPersonId: ctx.actor.personId,
  });
  if (t.status !== "open") denyTransition(t.status, "assigned");
  await assertAssignee(ctx, t.property_id, ctx.actor.membershipId);
  await sql`update tasks set status = 'assigned', assignee_membership_id = ${ctx.actor.membershipId}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${t.id}`.execute(ctx.trx);
  await setUnitStatus(ctx, t, "assigned");
  await audited(ctx, t, "task_claimed", "assigned", { assignee: ctx.actor.membershipId });
  return { taskId: t.id, status: "assigned" as const };
}

/** Chỉ người được giao (hoặc owner/manager) cập nhật tiến độ (S-006). */
function authorizeProgress(ctx: CommandContext, t: TaskRow): void {
  authorize(ctx.actor, "housekeeping.progress", {
    propertyId: t.property_id,
    subjectPersonId: t.assignee_person_id ?? "",
  });
}

/** `housekeeping.startTask` (S-005): assigned → in_progress, phòng `cleaning`. */
export async function startTask(ctx: CommandContext, input: { taskId: string }) {
  const t = await lockTask(ctx, input.taskId, (row) => authorizeProgress(ctx, row));
  if (t.status !== "assigned") denyTransition(t.status, "in_progress");
  await sql`update tasks set status = 'in_progress', started_at = now(), version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${t.id}`.execute(ctx.trx);
  await setUnitStatus(ctx, t, "in_progress");
  await audited(ctx, t, "task_started", "in_progress");
  return { taskId: t.id, status: "in_progress" as const };
}

/** `housekeeping.completeTask` (S-005, S-011): in_progress → done, phòng `clean`. */
export async function completeTask(ctx: CommandContext, input: { taskId: string; note?: string }) {
  const t = await lockTask(ctx, input.taskId, (row) => authorizeProgress(ctx, row));
  if (t.status !== "in_progress") denyTransition(t.status, "done");
  if (input.note !== undefined && input.note.length > 2000)
    throw new CommandError("VALIDATION_FAILED", 422, "Ghi chú tối đa 2.000 ký tự");
  await sql`update tasks set status = 'done', done_by = ${ctx.actor.membershipId}, done_at = now(),
                   note = coalesce(${input.note ?? null}, note), version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${t.id}`.execute(ctx.trx);
  await setUnitStatus(ctx, t, "done");
  await audited(ctx, t, "task_done", "done");
  await ctx.emit({
    eventType: "housekeeping.task_done",
    aggregateType: "task",
    aggregateId: t.id,
    propertyId: t.property_id,
    payload: { task_id: t.id, unit_id: t.unit_id },
  });
  return { taskId: t.id, status: "done" as const };
}

/**
 * `housekeeping.verifyTask` (S-007, S-008, Q-01/Q-03/Q-05): owner/manager (lễ tân khi cơ sở bật) nghiệm thu; người làm không
 * tự nghiệm thu khi bật tách quyền (mặc định) → SELF_APPROVAL_FORBIDDEN. Đạt → verified, phòng `inspected`; không đạt → về
 * `assigned` cho cùng người, phòng `assigned`.
 */
export async function verifyTask(
  ctx: CommandContext,
  input: { taskId: string; result: "pass" | "fail"; reason?: string },
) {
  // Lễ tân chỉ nghiệm thu khi cơ sở bật (kiểm tiếp sau khoá); vai trò khác phải có quyền nghiệm thu TRƯỚC khi khoá (403).
  const t = await lockTask(ctx, input.taskId, (row) => {
    if (ctx.actor.role !== "front_desk") authorize(ctx.actor, "task.verify", { propertyId: row.property_id });
  });
  const settings = await sql<{ s: Record<string, unknown> }>`
    select settings as s from properties where organization_id = ${ctx.actor.orgId} and id = ${t.property_id}`.execute(
    ctx.trx,
  );
  const s = settings.rows[0]?.s ?? {};
  const frontDeskInspects = s.front_desk_can_inspect === true && ctx.actor.role === "front_desk";
  if (!frontDeskInspects) authorize(ctx.actor, "task.verify", { propertyId: t.property_id });
  if (t.status !== "done") denyTransition(t.status, input.result === "pass" ? "verified" : "assigned");
  if (s.segregate_inspection !== false && t.done_by === ctx.actor.membershipId)
    throw new CommandError("SELF_APPROVAL_FORBIDDEN", 403, "Bạn không thể tự nghiệm thu việc mình đã làm.");
  if (input.result === "pass") {
    await sql`update tasks set status = 'verified', verified_by = ${ctx.actor.membershipId}, verified_at = now(), version = version + 1
              where organization_id = ${ctx.actor.orgId} and id = ${t.id}`.execute(ctx.trx);
    await setUnitStatus(ctx, t, "verified");
    await audited(ctx, t, "task_verified", "verified", { verified_by: ctx.actor.membershipId });
    await ctx.emit({
      eventType: "housekeeping.task_verified",
      aggregateType: "task",
      aggregateId: t.id,
      propertyId: t.property_id,
      payload: { task_id: t.id, unit_id: t.unit_id },
    });
    return { taskId: t.id, status: "verified" as const };
  }
  const reason = input.reason?.trim() ?? "";
  if (!reason) throw new CommandError("VALIDATION_FAILED", 422, "Cần lý do không đạt");
  const newer = t.kind === "cleaning" ? await otherOpenCleaning(ctx, t) : null;
  if (newer) {
    // Đã có việc dọn mới cho phòng (S-002): việc cũ không đạt thì đóng lại, lý do chuyển sang việc mới (review R3 — thay vì
    // 409 DUPLICATE do unique việc dọn mở).
    await sql`update tasks set status = 'cancelled', cancel_reason = ${`Không đạt: ${reason} — gộp vào việc dọn mới`}, version = version + 1
              where organization_id = ${ctx.actor.orgId} and id = ${t.id}`.execute(ctx.trx);
    await sql`update tasks set note = left(concat_ws(E'\n', note, ${`Kiểm việc trước không đạt: ${reason}`}::text), 2000),
                     version = version + 1
              where organization_id = ${ctx.actor.orgId} and id = ${newer}`.execute(ctx.trx);
    await audited(ctx, t, "task_rejected", "cancelled", { reason, merged_into: newer });
    return { taskId: t.id, status: "cancelled" as const };
  }
  await sql`update tasks set status = 'assigned', done_by = null, done_at = null, version = version + 1,
                   note = left(concat_ws(E'\n', note, ${`Không đạt: ${reason}`}::text), 2000)
            where organization_id = ${ctx.actor.orgId} and id = ${t.id}`.execute(ctx.trx);
  await setUnitStatus(ctx, t, "assigned");
  await audited(ctx, t, "task_rejected", "assigned", { reason });
  return { taskId: t.id, status: "assigned" as const };
}

/** `housekeeping.cancelTask`: việc chưa kết thúc → cancelled có lý do; phòng giữ trạng thái trước khi có việc. */
export async function cancelTask(ctx: CommandContext, input: { taskId: string; reason: string }) {
  const t = await lockTask(ctx, input.taskId);
  authorize(ctx.actor, "housekeeping.assign", { propertyId: t.property_id });
  if (ctx.actor.role === "housekeeping")
    throw new CommandError("FORBIDDEN", 403, "Buồng phòng không huỷ việc");
  if (!["open", "assigned", "in_progress"].includes(t.status)) denyTransition(t.status, "cancelled");
  const reason = input.reason.trim();
  if (!reason) throw new CommandError("VALIDATION_FAILED", 422, "Cần lý do huỷ");
  await sql`update tasks set status = 'cancelled', cancel_reason = ${reason}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${t.id}`.execute(ctx.trx);
  await setUnitStatus(ctx, t, "cancelled");
  await audited(ctx, t, "task_cancelled", "cancelled", { reason });
  return { taskId: t.id, status: "cancelled" as const };
}

/** Danh sách trường cho phép của một việc — KHÔNG có tên/SĐT khách, giấy tờ, tiền (S-003, S-020; test so khớp). */
export const TASK_FIELDS = [
  "id",
  "unitId",
  "unitCode",
  "floor",
  "kind",
  "status",
  "priority",
  "assigneeMembershipId",
  "assigneeName",
  "note",
  "arrivalToday",
  "expectedArrivalAt",
  "createdAt",
  "doneAt",
  "verifiedAt",
] as const;

export interface TaskView {
  id: string;
  unitId: string;
  unitCode: string;
  floor: string;
  kind: string;
  status: string;
  priority: string;
  assigneeMembershipId: string | null;
  assigneeName: string | null;
  note: string | null;
  arrivalToday: boolean;
  expectedArrivalAt: Date | null;
  createdAt: Date;
  doneAt: Date | null;
  verifiedAt: Date | null;
}

function authorizeRead(actor: Actor, propertyId: string): void {
  try {
    authorize(actor, "calendar.read_status", { propertyId });
  } catch {
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
  }
}

async function queryTasks(
  trx: Transaction<unknown>,
  actor: Actor,
  where: { propertyId: string; taskId?: string; floorId?: string; status?: string; assignee?: string },
  now: Date,
): Promise<TaskView[]> {
  const r = await sql<{
    id: string;
    unit_id: string;
    unit_code: string;
    floor: string;
    kind: string;
    status: string;
    priority: string;
    assignee_membership_id: string | null;
    assignee_name: string | null;
    note: string | null;
    arrival_at: Date | null;
    from_checkout: boolean;
    created_at: Date;
    done_at: Date | null;
    verified_at: Date | null;
  }>`
    with today as (select app.business_date(${actor.orgId}, ${where.propertyId}, ${now}) as d)
    select t.id, t.unit_id, u.code as unit_code, f.name as floor, t.kind, t.status, t.priority, t.assignee_membership_id,
           ap.full_name as assignee_name, t.note, t.created_at, t.done_at, t.verified_at,
           arr.arrival_at,
           (t.source_type = 'stay') as from_checkout
    from tasks t
    join units u on u.organization_id = t.organization_id and u.id = t.unit_id
    join floors f on f.organization_id = u.organization_id and f.id = u.floor_id
    left join memberships am on am.organization_id = t.organization_id and am.id = t.assignee_membership_id
    left join persons ap on ap.organization_id = am.organization_id and ap.id = am.person_id
    left join app.unit_arrivals(${where.propertyId}, (select d from today)) arr on arr.unit_id = t.unit_id
    where t.organization_id = ${actor.orgId} and t.property_id = ${where.propertyId}
      ${where.taskId ? sql`and t.id = ${where.taskId}` : sql``}
      ${where.floorId ? sql`and u.floor_id = ${where.floorId}` : sql``}
      ${where.status ? sql`and t.status = ${where.status}` : where.taskId ? sql`` : sql`and t.status in ('open','assigned','in_progress','done')`}
      ${where.assignee ? sql`and t.assignee_membership_id = ${where.assignee}` : sql``}
    order by (arr.arrival_at is not null) desc, (t.source_type = 'stay') desc, t.created_at
    limit 500`.execute(trx);
  return r.rows.map((x) => ({
    id: x.id,
    unitId: x.unit_id,
    unitCode: x.unit_code,
    floor: x.floor,
    kind: x.kind,
    status: x.status,
    priority: x.priority,
    assigneeMembershipId: x.assignee_membership_id,
    assigneeName: x.assignee_name,
    note: x.note,
    arrivalToday: x.arrival_at !== null,
    expectedArrivalAt: x.arrival_at,
    createdAt: x.created_at,
    doneAt: x.done_at,
    verifiedAt: x.verified_at,
  }));
}

/** `housekeeping.listTasks` (S-003): theo cơ sở/tầng; khách đến hôm nay → vừa trả → thời gian tạo (Q-04). */
export async function listTasks(
  db: Kysely<unknown>,
  actor: Actor,
  input: { propertyId: string; floorId?: string; status?: TaskStatus; assignee?: string; now?: Date },
): Promise<TaskView[]> {
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
  authorizeRead(actor, input.propertyId);
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const p = await sql<{
      id: string;
    }>`select id from properties where organization_id = ${actor.orgId} and id = ${input.propertyId}`.execute(
      trx,
    );
    if (!p.rows[0]) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
    return queryTasks(trx, actor, input, input.now ?? new Date());
  });
}

/** `housekeeping.getTask` (S-020, S-022): cùng danh sách trường; khác tổ chức/ngoài phạm vi → 404. */
export async function getTask(
  db: Kysely<unknown>,
  actor: Actor,
  taskId: string,
  now = new Date(),
): Promise<TaskView> {
  if (!UUID.test(taskId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy việc");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{ property_id: string }>`
      select property_id from tasks where organization_id = ${actor.orgId} and id = ${taskId}`.execute(trx);
    const row = r.rows[0];
    if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy việc");
    authorizeRead(actor, row.property_id);
    const [v] = await queryTasks(trx, actor, { propertyId: row.property_id, taskId }, now);
    if (!v) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy việc");
    return v;
  });
}
