// Việc buồng phòng (SPEC-housekeeping-maintenance F-007: S-001…S-011, S-020, S-022, S-023; DOMAIN-MODEL §4 vòng đời phiếu việc).
// - Lệnh ghi chạy trong command pipeline (idempotency INV-G5, audit INV-G6 cùng transaction); chuyển trạng thái qua `taskMachine`
//   (domain) và trigger `app.task_guard` (CSDL) — hai lớp. Khoá hàng `tasks` (FOR UPDATE) nên tự nhận song song chỉ một người thắng.
// - Quyền: `housekeeping.assign` (giao/tự nhận/huỷ), `housekeeping.progress` (bắt đầu/hoàn tất; buồng phòng chỉ việc được giao cho
//   mình, owner/manager mọi việc trong phạm vi), `task.verify` (nghiệm thu: owner/manager; lễ tân khi cơ sở bật
//   `front_desk_can_inspect`); người làm không tự nghiệm thu khi `separate_task_verification` (mặc định bật).
// - Query chỉ trả các trường trong `TASK_VIEW_FIELDS` — không tên/SĐT khách, giấy tờ, tiền (S-003, S-020); RLS che thêm một lớp.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { AuthzError, authorize, TransitionError, taskMachine } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";
import { openCleaningTask, syncUnitHousekeeping, type TaskStatus } from "./cleaning.ts";

export const TASK_KINDS = ["cleaning", "inspection"] as const;
export const TASK_PRIORITIES = ["normal", "high", "urgent"] as const;
export const TASK_STATUSES = ["open", "assigned", "in_progress", "done", "verified", "cancelled"] as const;
/** Mặc định của danh sách: việc chưa kết thúc (kể cả `done` đang chờ nghiệm thu). */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ["open", "assigned", "in_progress", "done"];
export const MAX_NOTE = 2000;
export const MAX_REASON = 1000;
export const DEFAULT_TASK_LIMIT = 200;
export const MAX_TASK_LIMIT = 500;

/** Vai trò đọc được việc (khớp RLS `tasks_read`). */
const READER_ROLES: ReadonlySet<string> = new Set(["owner", "manager", "front_desk", "housekeeping"]);
/** Vai trò làm được việc (giao/tự nhận): có quyền `housekeeping.progress`. */
const WORKER_ROLES: ReadonlySet<string> = new Set(["housekeeping", "manager", "owner"]);

/** Danh sách trường ĐƯỢC PHÉP trả cho mọi vai trò (test S-020 so khớp đúng danh sách này). */
export const TASK_VIEW_FIELDS = [
  "id",
  "property_id",
  "unit_id",
  "unit_code",
  "floor_id",
  "floor_name",
  "kind",
  "status",
  "priority",
  "arrival_today",
  "expected_arrival_at",
  "assignee_membership_id",
  "assigned_to_me",
  "note",
  "source_type",
  "due_at",
  "done_at",
  "verified_at",
  "created_at",
  "version",
] as const;

export interface TaskView {
  id: string;
  property_id: string;
  unit_id: string;
  unit_code: string;
  floor_id: string;
  floor_name: string;
  kind: "cleaning" | "inspection";
  status: TaskStatus;
  /** Ưu tiên hiệu lực: có khách đến hôm nay thì tối thiểu `high` (Q-04). */
  priority: "normal" | "high" | "urgent";
  arrival_today: boolean;
  /** Giờ khách đến dự kiến hôm nay (ISO UTC) hoặc null. */
  expected_arrival_at: string | null;
  assignee_membership_id: string | null;
  assigned_to_me: boolean;
  note: string | null;
  source_type: "stay" | "move" | "work_order" | "lease" | "manual";
  due_at: string | null;
  done_at: string | null;
  verified_at: string | null;
  created_at: string;
  version: number;
}

interface LockedTask {
  id: string;
  property_id: string;
  unit_id: string;
  kind: string;
  status: TaskStatus;
  assignee_membership_id: string | null;
  assignee_person_id: string | null;
  done_by: string | null;
  note: string | null;
}

const notFound = () => new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");

/** Cơ sở nằm ngoài phạm vi → NOT_FOUND (không lộ tồn tại); vai trò không đọc được việc → FORBIDDEN. */
function assertReader(actor: Actor, propertyId: string): void {
  if (!actor.allProperties && !actor.propertyIds.includes(propertyId)) throw notFound();
  if (!READER_ROLES.has(actor.role))
    throw new AuthzError("FORBIDDEN", "Bạn không có quyền xem việc buồng phòng");
}

/**
 * Nạp việc rồi khoá hàng. Đọc không khoá trước để kiểm quyền (người không được giao nhận 403, không phải 409); sau đó
 * `FOR UPDATE` và kiểm lại trên bản đã khoá. RLS áp cả cho `FOR UPDATE`: nếu hàng vừa bị người khác nhận/đổi trong lúc chờ khoá,
 * hàng không còn khớp chính sách → không có dòng → `INVALID_TRANSITION` ("Việc này đã thay đổi trạng thái").
 */
async function lockTask(
  ctx: CommandContext,
  taskId: string,
  check: (row: LockedTask) => void | Promise<void>,
): Promise<LockedTask> {
  const orgId = ctx.actor.orgId;
  const first = await sql<LockedTask>`
    select t.id, t.property_id, t.unit_id, t.kind, t.status, t.assignee_membership_id, t.done_by, t.note,
           m.person_id as assignee_person_id
    from tasks t left join memberships m on m.organization_id = t.organization_id and m.id = t.assignee_membership_id
    where t.organization_id = ${orgId} and t.id = ${taskId}`.execute(ctx.trx);
  const seen = first.rows[0];
  if (!seen) throw notFound();
  await check(seen);
  const locked = await sql<LockedTask>`
    select t.id, t.property_id, t.unit_id, t.kind, t.status, t.assignee_membership_id, t.done_by, t.note,
           m.person_id as assignee_person_id
    from tasks t left join memberships m on m.organization_id = t.organization_id and m.id = t.assignee_membership_id
    where t.organization_id = ${orgId} and t.id = ${taskId}
    for update of t`.execute(ctx.trx);
  const row = locked.rows[0];
  if (!row)
    throw new CommandError("INVALID_TRANSITION", 409, "Việc này đã thay đổi trạng thái. Vui lòng tải lại.", {
      extensions: { from: seen.status },
    });
  await check(row);
  return row;
}

function cleanNote(field: string, v: string | undefined, max: number): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t.length > max) throw fieldError(field, "TOO_LONG", `Tối đa ${max} ký tự`);
  return t.length === 0 ? null : t;
}

async function propertySettings(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
): Promise<{ frontDeskCanInspect: boolean; separateVerification: boolean }> {
  const r = await sql<{ fd: boolean; sep: boolean }>`
    select coalesce(settings ->> 'front_desk_can_inspect', 'false') = 'true' as fd,
           coalesce(settings ->> 'separate_task_verification', 'true') <> 'false' as sep
    from properties where organization_id = ${orgId} and id = ${propertyId}`.execute(trx);
  return { frontDeskCanInspect: r.rows[0]?.fd ?? false, separateVerification: r.rows[0]?.sep ?? true };
}

async function audit(
  ctx: CommandContext,
  action: string,
  task: { id: string; property_id: string },
  before: unknown,
  after: unknown,
  reason?: string,
) {
  await ctx.audit({
    action,
    entityType: "task",
    entityId: task.id,
    propertyId: task.property_id,
    before,
    after,
    ...(reason ? { reason } : {}),
  });
}

// ───────────────────────────── lệnh ghi ─────────────────────────────

export interface CreateTaskInput {
  unitId: string;
  kind?: "cleaning" | "inspection";
  priority?: "normal" | "high" | "urgent";
  note?: string;
}

/** `housekeeping.createTask` (thủ công): owner/manager/lễ tân. Việc dọn trùng việc đang mở của phòng → trả việc đó (S-002). */
export async function createTask(ctx: CommandContext, input: CreateTaskInput) {
  const orgId = ctx.actor.orgId;
  const u = await sql<{ property_id: string }>`
    select property_id from units where organization_id = ${orgId} and id = ${input.unitId} and archived_at is null`.execute(
    ctx.trx,
  );
  const propertyId = u.rows[0]?.property_id;
  if (!propertyId) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  authorize(ctx.actor, "housekeeping.assign", { propertyId });
  const note = cleanNote("note", input.note, MAX_NOTE);
  const kind = input.kind ?? "cleaning";
  const priority = input.priority ?? "normal";
  if (kind === "cleaning") {
    const r = await openCleaningTask(ctx.trx, {
      orgId,
      propertyId,
      unitId: input.unitId,
      source: { type: "manual", id: null },
      note,
      priority,
    });
    await audit(
      ctx,
      r.created ? "housekeeping.task_created" : "housekeeping.task_source_added",
      { id: r.taskId, property_id: propertyId },
      null,
      { unit_id: input.unitId, kind, status: r.status, source_type: "manual", created: r.created },
    );
    return { task_id: r.taskId, created: r.created, status: r.status };
  }
  const id = randomUUID();
  await sql`
    insert into tasks (id, organization_id, property_id, unit_id, kind, priority, source_type, note)
    values (${id}, ${orgId}, ${propertyId}, ${input.unitId}, 'inspection', ${priority}, 'manual', ${note})`.execute(
    ctx.trx,
  );
  await audit(ctx, "housekeeping.task_created", { id, property_id: propertyId }, null, {
    unit_id: input.unitId,
    kind,
    status: "open",
    source_type: "manual",
    created: true,
  });
  return { task_id: id, created: true, status: "open" as const };
}

interface AssigneeRow {
  id: string;
  role: string;
}

async function loadAssignee(
  trx: Transaction<unknown>,
  orgId: string,
  membershipId: string,
  propertyId: string,
): Promise<AssigneeRow> {
  const r = await sql<AssigneeRow>`
    select m.id, m.role from memberships m
    where m.organization_id = ${orgId} and m.id = ${membershipId} and m.status = 'active'
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      and (m.all_properties or exists (
            select 1 from property_scopes ps
            where ps.organization_id = m.organization_id and ps.membership_id = m.id and ps.property_id = ${propertyId}))`.execute(
    trx,
  );
  const row = r.rows[0];
  if (!row || !WORKER_ROLES.has(row.role))
    throw fieldError(
      "assignee_membership_id",
      "INVALID",
      "Người nhận phải là nhân viên buồng phòng trong cơ sở này",
    );
  return row;
}

/** `housekeeping.assignTask` (S-004): owner/manager/lễ tân giao việc `open`, hoặc đổi người khi còn `assigned`. */
export async function assignTask(
  ctx: CommandContext,
  input: { taskId: string; assigneeMembershipId: string },
) {
  const t = await lockTask(
    ctx,
    input.taskId,
    (row) => void authorize(ctx.actor, "housekeeping.assign", { propertyId: row.property_id }),
  );
  if (t.status !== "open" && t.status !== "assigned") throw new TransitionError("task", t.status, "assigned");
  await loadAssignee(ctx.trx, ctx.actor.orgId, input.assigneeMembershipId, t.property_id);
  await sql`
    update tasks set status = 'assigned', assignee_membership_id = ${input.assigneeMembershipId}
    where organization_id = ${ctx.actor.orgId} and id = ${t.id}`.execute(ctx.trx);
  await syncUnitHousekeeping(ctx.trx, ctx.actor.orgId, { ...t, status: "assigned" });
  await audit(
    ctx,
    "housekeeping.task_assigned",
    t,
    { status: t.status, assignee_membership_id: t.assignee_membership_id },
    { status: "assigned", assignee_membership_id: input.assigneeMembershipId },
  );
  return { task_id: t.id, status: "assigned" as const, assignee_membership_id: input.assigneeMembershipId };
}

/** `housekeeping.claimTask` (S-004, Q-02): tự nhận việc chưa giao trong phạm vi cơ sở; người đến sau → INVALID_TRANSITION. */
export async function claimTask(ctx: CommandContext, input: { taskId: string }) {
  const t = await lockTask(ctx, input.taskId, (row) => {
    authorize(ctx.actor, "housekeeping.assign", {
      propertyId: row.property_id,
      subjectPersonId: ctx.actor.personId,
    });
    if (!WORKER_ROLES.has(ctx.actor.role))
      throw new AuthzError("FORBIDDEN", "Vai trò này không nhận việc dọn");
  });
  if (t.status !== "open") throw new TransitionError("task", t.status, "assigned");
  await sql`
    update tasks set status = 'assigned', assignee_membership_id = ${ctx.actor.membershipId}
    where organization_id = ${ctx.actor.orgId} and id = ${t.id}`.execute(ctx.trx);
  await syncUnitHousekeeping(ctx.trx, ctx.actor.orgId, { ...t, status: "assigned" });
  await audit(
    ctx,
    "housekeeping.task_claimed",
    t,
    { status: "open" },
    { status: "assigned", assignee_membership_id: ctx.actor.membershipId },
  );
  return { task_id: t.id, status: "assigned" as const, assignee_membership_id: ctx.actor.membershipId };
}

/** Kiểm quyền tiến độ (S-006): owner/manager mọi việc trong phạm vi; buồng phòng chỉ việc được giao cho mình. */
function checkProgress(actor: Actor, row: LockedTask): void {
  authorize(actor, "housekeeping.progress", {
    propertyId: row.property_id,
    ...(row.assignee_person_id ? { subjectPersonId: row.assignee_person_id } : {}),
  });
}

/** `housekeeping.startTask` (S-005): `assigned → in_progress`, phòng `cleaning`. */
export async function startTask(ctx: CommandContext, input: { taskId: string; note?: string }) {
  const t = await lockTask(ctx, input.taskId, (row) => checkProgress(ctx.actor, row));
  taskMachine.assertTransition(t.status, "in_progress");
  const note = cleanNote("note", input.note, MAX_NOTE);
  await sql`
    update tasks set status = 'in_progress', note = coalesce(${note}::text, note)
    where organization_id = ${ctx.actor.orgId} and id = ${t.id}`.execute(ctx.trx);
  await syncUnitHousekeeping(ctx.trx, ctx.actor.orgId, { ...t, status: "in_progress" });
  await audit(ctx, "housekeeping.task_started", t, { status: t.status }, { status: "in_progress" });
  return { task_id: t.id, status: "in_progress" as const };
}

/** `housekeeping.completeTask` (S-005, S-011): `in_progress → done`, phòng `clean`; ghi người làm + giờ (UTC). */
export async function completeTask(
  ctx: CommandContext,
  input: { taskId: string; note?: string; now?: Date },
) {
  const t = await lockTask(ctx, input.taskId, (row) => checkProgress(ctx.actor, row));
  taskMachine.assertTransition(t.status, "done");
  const note = cleanNote("note", input.note, MAX_NOTE);
  const now = input.now ?? new Date();
  await sql`
    update tasks set status = 'done', done_by = ${ctx.actor.membershipId}, done_at = ${now}, note = coalesce(${note}::text, note)
    where organization_id = ${ctx.actor.orgId} and id = ${t.id}`.execute(ctx.trx);
  await syncUnitHousekeeping(ctx.trx, ctx.actor.orgId, { ...t, status: "done" });
  await audit(
    ctx,
    "housekeeping.task_completed",
    t,
    { status: t.status },
    { status: "done", done_by: ctx.actor.membershipId, done_at: now.toISOString() },
  );
  return { task_id: t.id, status: "done" as const, done_at: now.toISOString() };
}

/** Quyền nghiệm thu: `task.verify` (owner/manager) hoặc lễ tân khi cơ sở bật `front_desk_can_inspect` (Q-01, D-002). */
async function assertCanVerify(ctx: CommandContext, row: LockedTask) {
  try {
    authorize(ctx.actor, "task.verify", { propertyId: row.property_id });
  } catch (err) {
    if (!(err instanceof AuthzError) || err.code !== "FORBIDDEN" || ctx.actor.role !== "front_desk")
      throw err;
    const s = await propertySettings(ctx.trx, ctx.actor.orgId, row.property_id);
    if (!s.frontDeskCanInspect) throw err;
  }
}

/**
 * `housekeeping.verifyTask` (S-007, S-008): `done → verified` (phòng `inspected`) hoặc không đạt → `assigned` cho cùng người
 * (phòng `assigned`, lý do vào ghi chú để người làm biết). Người làm không tự nghiệm thu khi bật tách quyền.
 */
export async function verifyTask(
  ctx: CommandContext,
  input: { taskId: string; result: "pass" | "fail"; reason?: string; now?: Date },
) {
  const orgId = ctx.actor.orgId;
  const t = await lockTask(ctx, input.taskId, (row) => assertCanVerify(ctx, row));
  const target = input.result === "pass" ? "verified" : "assigned";
  if (t.status !== "done") throw new TransitionError("task", t.status, target);
  const reason = cleanNote("reason", input.reason, MAX_REASON);
  if (input.result === "fail" && !reason)
    throw fieldError("reason", "REQUIRED", "Nghiệm thu không đạt cần lý do");
  const now = input.now ?? new Date();

  if (input.result === "pass") {
    const s = await propertySettings(ctx.trx, orgId, t.property_id);
    if (s.separateVerification && t.done_by === ctx.actor.membershipId)
      throw new CommandError("SELF_APPROVAL_FORBIDDEN", 403, "Bạn không thể tự nghiệm thu việc mình đã làm.");
    await sql`
      update tasks set status = 'verified', verified_by = ${ctx.actor.membershipId}, verified_at = ${now}
      where organization_id = ${orgId} and id = ${t.id}`.execute(ctx.trx);
    await syncUnitHousekeeping(ctx.trx, orgId, { ...t, status: "verified" });
    await audit(
      ctx,
      "housekeeping.task_verified",
      t,
      { status: "done" },
      { status: "verified", verified_by: ctx.actor.membershipId, verified_at: now.toISOString() },
    );
    return { task_id: t.id, status: "verified" as const, verified_at: now.toISOString() };
  }

  await sql`
    update tasks set status = 'assigned', done_by = null, done_at = null, note = ${reason}
    where organization_id = ${orgId} and id = ${t.id}`.execute(ctx.trx);
  await syncUnitHousekeeping(ctx.trx, orgId, { ...t, status: "assigned" });
  await audit(
    ctx,
    "housekeeping.task_rejected",
    t,
    { status: "done", done_by: t.done_by },
    { status: "assigned", assignee_membership_id: t.assignee_membership_id },
    reason ?? undefined,
  );
  return { task_id: t.id, status: "assigned" as const };
}

/** `housekeeping.cancelTask`: huỷ việc chưa nghiệm thu (owner/manager/lễ tân); phòng chưa dọn xong về `dirty`. */
export async function cancelTask(ctx: CommandContext, input: { taskId: string; reason: string }) {
  const t = await lockTask(
    ctx,
    input.taskId,
    (row) => void authorize(ctx.actor, "housekeeping.assign", { propertyId: row.property_id }),
  );
  taskMachine.assertTransition(t.status, "cancelled");
  const reason = cleanNote("reason", input.reason, MAX_REASON);
  if (!reason) throw fieldError("reason", "REQUIRED", "Cần lý do huỷ việc");
  await sql`
    update tasks set status = 'cancelled', cancel_reason = ${reason}
    where organization_id = ${ctx.actor.orgId} and id = ${t.id}`.execute(ctx.trx);
  await syncUnitHousekeeping(ctx.trx, ctx.actor.orgId, { ...t, status: "cancelled" });
  await audit(ctx, "housekeeping.task_cancelled", t, { status: t.status }, { status: "cancelled" }, reason);
  return { task_id: t.id, status: "cancelled" as const };
}

// ───────────────────────────── query ─────────────────────────────

interface TaskDbRow {
  id: string;
  property_id: string;
  unit_id: string;
  unit_code: string;
  floor_id: string;
  floor_name: string;
  kind: TaskView["kind"];
  status: TaskStatus;
  priority: TaskView["priority"];
  arrival_at: Date | null;
  assignee_membership_id: string | null;
  note: string | null;
  source_type: TaskView["source_type"];
  due_at: Date | null;
  done_at: Date | null;
  verified_at: Date | null;
  created_at: Date;
  version: number;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

function toView(r: TaskDbRow, actor: Actor): TaskView {
  const arrival = r.arrival_at !== null;
  return {
    id: r.id,
    property_id: r.property_id,
    unit_id: r.unit_id,
    unit_code: r.unit_code,
    floor_id: r.floor_id,
    floor_name: r.floor_name,
    kind: r.kind,
    status: r.status,
    priority: arrival && r.priority === "normal" ? "high" : r.priority,
    arrival_today: arrival,
    expected_arrival_at: iso(r.arrival_at),
    assignee_membership_id: r.assignee_membership_id,
    assigned_to_me: r.assignee_membership_id === actor.membershipId,
    note: r.note,
    source_type: r.source_type,
    due_at: iso(r.due_at),
    done_at: iso(r.done_at),
    verified_at: iso(r.verified_at),
    created_at: new Date(r.created_at).toISOString(),
    version: r.version,
  };
}

const TASK_SELECT = (propertyId: string, now: Date) => sql`
  select t.id, t.property_id, t.unit_id, u.code as unit_code, f.id as floor_id, f.name as floor_name, t.kind, t.status, t.priority,
         arr.arrival_at, t.assignee_membership_id, t.note, t.source_type, t.due_at, t.done_at, t.verified_at, t.created_at, t.version
  from tasks t
  join units u on u.organization_id = t.organization_id and u.id = t.unit_id
  join floors f on f.organization_id = u.organization_id and f.id = u.floor_id
  left join app.housekeeping_arrivals(${propertyId}::uuid, ${now}::timestamptz) arr on arr.unit_id = t.unit_id`;

export interface ListTasksInput {
  propertyId: string;
  floorId?: string;
  statuses?: readonly string[];
  /** `me` hoặc membership id. */
  assignee?: string;
  limit?: number;
  now?: Date;
}

/**
 * `housekeeping.listTasks` (S-003): việc của cơ sở (lọc tầng/trạng thái/người nhận). Thứ tự: phòng có khách đến hôm nay (giờ đến
 * sớm trước) → ưu tiên đã đặt → phòng vừa trả/chuyển → thời gian tạo (Q-04). "Hôm nay" theo ngày kinh doanh của cơ sở.
 */
export async function listTasks(
  db: Kysely<unknown>,
  actor: Actor,
  input: ListTasksInput,
): Promise<TaskView[]> {
  assertReader(actor, input.propertyId);
  const statuses = input.statuses && input.statuses.length > 0 ? input.statuses : ACTIVE_STATUSES;
  for (const s of statuses)
    if (!(TASK_STATUSES as readonly string[]).includes(s))
      throw fieldError("status", "INVALID", `Trạng thái không hợp lệ: ${s}`);
  const limit = input.limit ?? DEFAULT_TASK_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TASK_LIMIT)
    throw fieldError("limit", "OUT_OF_RANGE", `Số việc mỗi lần 1–${MAX_TASK_LIMIT}`);
  const now = input.now ?? new Date();
  const assignee = input.assignee === "me" ? actor.membershipId : (input.assignee ?? null);
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    // Cơ sở của tổ chức khác (hoặc không tồn tại) → NOT_FOUND, không trả danh sách rỗng (S-022).
    const p =
      await sql`select 1 from properties where organization_id = ${actor.orgId} and id = ${input.propertyId}`.execute(
        trx,
      );
    if (p.rows.length === 0) throw notFound();
    const r = await sql<TaskDbRow>`
      ${TASK_SELECT(input.propertyId, now)}
      where t.organization_id = ${actor.orgId} and t.property_id = ${input.propertyId}
        and t.status in (${sql.join(statuses)})
        and (${input.floorId ?? null}::uuid is null or u.floor_id = ${input.floorId ?? null}::uuid)
        and (${assignee}::uuid is null or t.assignee_membership_id = ${assignee}::uuid)
      order by (arr.arrival_at is not null) desc, arr.arrival_at asc nulls last,
               case t.priority when 'urgent' then 2 when 'high' then 1 else 0 end desc,
               (t.source_type in ('stay', 'move')) desc, t.created_at asc, t.id asc
      limit ${limit}`.execute(trx);
    return r.rows.map((x) => toView(x, actor));
  });
}

/** `housekeeping.getTask` (S-020, S-022): việc ngoài phạm vi/khác tổ chức/không đọc được → NOT_FOUND. */
export async function getTask(
  db: Kysely<unknown>,
  actor: Actor,
  input: { taskId: string; now?: Date },
): Promise<TaskView> {
  if (!READER_ROLES.has(actor.role)) throw notFound();
  const now = input.now ?? new Date();
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const p = await sql<{ property_id: string }>`
      select property_id from tasks where organization_id = ${actor.orgId} and id = ${input.taskId}`.execute(
      trx,
    );
    const propertyId = p.rows[0]?.property_id;
    if (!propertyId || (!actor.allProperties && !actor.propertyIds.includes(propertyId))) throw notFound();
    const r = await sql<TaskDbRow>`
      ${TASK_SELECT(propertyId, now)}
      where t.organization_id = ${actor.orgId} and t.id = ${input.taskId}`.execute(trx);
    const row = r.rows[0];
    if (!row) throw notFound();
    return toView(row, actor);
  });
}
