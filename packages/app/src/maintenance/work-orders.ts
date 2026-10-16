// Phiếu sự cố/sửa chữa (SPEC-housekeeping-maintenance S-012…S-019, S-021; ERD `work_orders`). Ảnh qua `files` đã quét — chỉ
// `ready` mới gắn, file bị từ chối không gắn và người báo được nhắc tải lại; tối đa 5 ảnh/phiếu (Q-06). Kỹ thuật đề xuất block,
// chỉ owner/manager duyệt/kết thúc block; nghiệm thu (người khác người làm) kết thúc block và tạo việc dọn trước khi bán lại.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize, TransitionError } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../access/actor.ts";
import { createCleaningTask } from "../housekeeping/tasks.ts";
import { approveBlock, endBlock, proposeBlock } from "../inventory/inventory.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_WORK_ORDER_PHOTOS = 5;
export type Severity = "low" | "medium" | "high" | "critical";
type Status = "open" | "assigned" | "in_progress" | "done" | "verified" | "cancelled";

function fieldError(path: string, code: string, message: string): CommandError {
  return new CommandError("VALIDATION_FAILED", 422, message, {
    extensions: { errors: [{ path, field: path, code }] },
  });
}

/** Gắn ảnh đã quét vào phiếu: `ready` → gắn; `rejected`/không phải của mình/không đúng loại → bỏ qua và báo lại. */
async function attachPhotos(
  ctx: CommandContext,
  workOrderId: string,
  propertyId: string,
  fileIds: readonly string[],
): Promise<{ attached: string[]; rejected: string[] }> {
  if (fileIds.length > MAX_WORK_ORDER_PHOTOS)
    throw fieldError("file_ids", "too_many", `Tối đa ${MAX_WORK_ORDER_PHOTOS} ảnh mỗi phiếu`);
  const existing = await sql<{ n: number }>`
    select count(*)::int as n from files where organization_id = ${ctx.actor.orgId} and owner_type = 'work_order'
      and owner_id = ${workOrderId} and status = 'ready'`.execute(ctx.trx);
  if ((existing.rows[0]?.n ?? 0) + fileIds.length > MAX_WORK_ORDER_PHOTOS)
    throw fieldError("file_ids", "too_many", `Tối đa ${MAX_WORK_ORDER_PHOTOS} ảnh mỗi phiếu`);
  const attached: string[] = [];
  const rejected: string[] = [];
  for (const [i, id] of fileIds.entries()) {
    if (!UUID.test(id)) throw fieldError(`file_ids.${i}`, "invalid", "Mã ảnh không hợp lệ");
    const r = await sql<{ id: string }>`
      update files set owner_id = ${workOrderId}
      where organization_id = ${ctx.actor.orgId} and id = ${id} and owner_type = 'work_order' and status = 'ready'
        and uploaded_by = ${ctx.actor.membershipId} and property_id = ${propertyId} and owner_id is null
      returning id`.execute(ctx.trx);
    if (r.rows[0]) attached.push(id);
    else rejected.push(id);
  }
  return { attached, rejected };
}

/** `maintenance.createWorkOrder` (S-012…S-015): nhân viên báo; người thuê báo qua portal (`source='tenant'`, T-217). */
export async function createWorkOrder(
  ctx: CommandContext,
  input: {
    unitId: string;
    title: string;
    description: string;
    severity: Severity;
    fileIds?: readonly string[];
    reporterPersonId?: string;
  },
): Promise<{ workOrderId: string; attachedFileIds: string[]; rejectedFileIds: string[] }> {
  if (!UUID.test(input.unitId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  const u = await sql<{ property_id: string }>`
    select property_id from units where organization_id = ${ctx.actor.orgId} and id = ${input.unitId} and archived_at is null`.execute(
    ctx.trx,
  );
  const unit = u.rows[0];
  if (!unit) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  const tenant = ctx.actor.role === "tenant";
  authorize(ctx.actor, "work_order.create", {
    ...(tenant ? {} : { propertyId: unit.property_id }),
    subjectPersonId: input.reporterPersonId ?? ctx.actor.personId,
  });
  if (tenant) {
    // Người thuê chỉ báo phòng thuộc hợp đồng đang hiệu lực của mình (S-021); phòng khác → 404 (không lộ tồn tại).
    const own = await sql<{ id: string }>`
      select l.id from leases l
      where l.organization_id = ${ctx.actor.orgId} and l.unit_id = ${input.unitId}
        and l.status in ('active','notice_given')
        and (l.representative_person_id = ${ctx.actor.personId}
             or exists (select 1 from lease_occupants o where o.organization_id = l.organization_id and o.lease_id = l.id
                          and o.person_id = ${ctx.actor.personId} and o.role in ('primary','co_tenant')))
      limit 1`.execute(ctx.trx);
    if (!own.rows[0]) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  }
  const title = input.title.trim();
  const description = input.description.trim();
  if (title.length < 1 || title.length > 200) throw fieldError("title", "required", "Tiêu đề 1–200 ký tự");
  if (description.length < 1 || description.length > 2000)
    throw fieldError("description", "required", "Mô tả 1–2.000 ký tự");
  const id = randomUUID();
  await sql`
    insert into work_orders (id, organization_id, property_id, unit_id, title, description, severity, source,
                             reporter_membership_id, reporter_person_id)
    values (${id}, ${ctx.actor.orgId}, ${unit.property_id}, ${input.unitId}, ${title}, ${description}, ${input.severity},
            ${tenant ? "tenant" : "staff"}, ${tenant ? null : ctx.actor.membershipId}, ${tenant ? ctx.actor.personId : null})`.execute(
    ctx.trx,
  );
  const photos = await attachPhotos(ctx, id, unit.property_id, input.fileIds ?? []);
  await ctx.audit({
    action: "work_order.created",
    entityType: "work_order",
    entityId: id,
    propertyId: unit.property_id,
    after: { severity: input.severity, source: tenant ? "tenant" : "staff", photos: photos.attached.length },
  });
  // Thông báo quản lý + kỹ thuật (F-011); file bị từ chối → người báo được nhắc tải lại.
  await ctx.emit({
    eventType: "work_order.created",
    aggregateType: "work_order",
    aggregateId: id,
    propertyId: unit.property_id,
    payload: { work_order_id: id, unit_id: input.unitId, rejected_files: photos.rejected.length },
  });
  return { workOrderId: id, attachedFileIds: photos.attached, rejectedFileIds: photos.rejected };
}

interface WoRow {
  id: string;
  property_id: string;
  unit_id: string;
  status: Status;
  assignee_membership_id: string | null;
  assignee_person_id: string | null;
  done_by: string | null;
  block_id: string | null;
}

async function lockWorkOrder(ctx: CommandContext, id: string, check: (w: WoRow) => void): Promise<WoRow> {
  if (!UUID.test(id)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
  const read = (lock: boolean) =>
    sql<WoRow>`
      select w.id, w.property_id, w.unit_id, w.status, w.assignee_membership_id, m.person_id as assignee_person_id, w.done_by,
             w.block_id
      from work_orders w left join memberships m on m.organization_id = w.organization_id and m.id = w.assignee_membership_id
      where w.organization_id = ${ctx.actor.orgId} and w.id = ${id} ${lock ? sql`for update of w` : sql``}`.execute(
      ctx.trx,
    );
  const seen = (await read(false)).rows[0];
  if (
    !seen ||
    ctx.actor.role === "tenant" ||
    (!ctx.actor.allProperties && !ctx.actor.propertyIds.includes(seen.property_id))
  )
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phiếu");
  check(seen);
  const locked = (await read(true)).rows[0];
  if (!locked) throw new TransitionError("work_order", seen.status, "changed");
  check(locked);
  return locked;
}

function deny(from: string, to: string): never {
  throw new TransitionError("work_order", from, to);
}

async function audit(
  ctx: CommandContext,
  w: WoRow,
  action: string,
  to: Status,
  extra: Record<string, unknown> = {},
) {
  await ctx.audit({
    action: `work_order.${action}`,
    entityType: "work_order",
    entityId: w.id,
    propertyId: w.property_id,
    before: { status: w.status },
    after: { status: to, ...extra },
  });
  await ctx.emit({
    eventType: "work_order.status_changed",
    aggregateType: "work_order",
    aggregateId: w.id,
    propertyId: w.property_id,
    payload: { work_order_id: w.id, status: to },
  });
}

/** `maintenance.assignWorkOrder`: owner/manager giao cho kỹ thuật trong phạm vi cơ sở. */
export async function assignWorkOrder(
  ctx: CommandContext,
  input: { workOrderId: string; assigneeMembershipId: string },
) {
  const w = await lockWorkOrder(ctx, input.workOrderId, (row) => {
    authorize(ctx.actor, "work_order.handle", { propertyId: row.property_id });
    if (ctx.actor.role === "maintenance")
      throw new CommandError("FORBIDDEN", 403, "Kỹ thuật không tự giao phiếu");
  });
  if (w.status !== "open" && w.status !== "assigned") deny(w.status, "assigned");
  if (!UUID.test(input.assigneeMembershipId))
    throw fieldError("assignee", "invalid", "Người nhận không hợp lệ");
  const m = await sql<{ id: string }>`
    select m.id from memberships m
    where m.organization_id = ${ctx.actor.orgId} and m.id = ${input.assigneeMembershipId} and m.status = 'active'
      and m.role in ('maintenance','manager','owner')
      and (m.all_properties or exists (select 1 from property_scopes ps where ps.organization_id = m.organization_id
                                        and ps.membership_id = m.id and ps.property_id = ${w.property_id}))`.execute(
    ctx.trx,
  );
  if (!m.rows[0])
    throw fieldError("assignee", "invalid", "Người nhận không thuộc cơ sở hoặc không phải kỹ thuật");
  await sql`update work_orders set status = 'assigned', assignee_membership_id = ${input.assigneeMembershipId}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${w.id}`.execute(ctx.trx);
  await audit(ctx, w, "assigned", "assigned", { assignee: input.assigneeMembershipId });
  return { workOrderId: w.id, status: "assigned" as const };
}

function authorizeHandle(ctx: CommandContext, w: WoRow): void {
  authorize(ctx.actor, "work_order.handle", {
    propertyId: w.property_id,
    subjectPersonId: w.assignee_person_id ?? "",
  });
}

/** `maintenance.startWorkOrder`: người được giao (hoặc owner/manager). */
export async function startWorkOrder(ctx: CommandContext, input: { workOrderId: string }) {
  const w = await lockWorkOrder(ctx, input.workOrderId, (row) => authorizeHandle(ctx, row));
  if (w.status !== "assigned") deny(w.status, "in_progress");
  await sql`update work_orders set status = 'in_progress', version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${w.id}`.execute(ctx.trx);
  await audit(ctx, w, "started", "in_progress");
  return { workOrderId: w.id, status: "in_progress" as const };
}

/** `maintenance.completeWorkOrder` (S-019): ghi chú + ảnh sau sửa; chưa mở lại phòng (cần nghiệm thu). */
export async function completeWorkOrder(
  ctx: CommandContext,
  input: { workOrderId: string; note?: string; fileIds?: readonly string[] },
) {
  const w = await lockWorkOrder(ctx, input.workOrderId, (row) => authorizeHandle(ctx, row));
  if (w.status !== "in_progress") deny(w.status, "done");
  if (input.note !== undefined && input.note.length > 2000)
    throw fieldError("note", "too_long", "Ghi chú tối đa 2.000 ký tự");
  const photos = await attachPhotos(ctx, w.id, w.property_id, input.fileIds ?? []);
  await sql`update work_orders set status = 'done', done_by = ${ctx.actor.membershipId}, done_at = now(),
                   resolution_note = ${input.note ?? null}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${w.id}`.execute(ctx.trx);
  await audit(ctx, w, "done", "done", { photos: photos.attached.length });
  return { workOrderId: w.id, status: "done" as const, rejectedFileIds: photos.rejected };
}

/**
 * `maintenance.verifyWorkOrder` (S-019, Q-08): owner/manager, khác người làm (SELF_APPROVAL_FORBIDDEN); kết thúc block đang
 * chặn phòng và tạo việc dọn `open` — phòng chỉ bán lại sau dọn + kiểm.
 */
export async function verifyWorkOrder(ctx: CommandContext, input: { workOrderId: string; now?: Date }) {
  const w = await lockWorkOrder(ctx, input.workOrderId, (row) =>
    authorize(ctx.actor, "task.verify", { propertyId: row.property_id }),
  );
  if (w.status !== "done") deny(w.status, "verified");
  if (w.done_by === ctx.actor.membershipId)
    throw new CommandError("SELF_APPROVAL_FORBIDDEN", 403, "Bạn không thể tự nghiệm thu việc mình đã làm.");
  await sql`update work_orders set status = 'verified', verified_by = ${ctx.actor.membershipId}, verified_at = now(), version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${w.id}`.execute(ctx.trx);
  let blockEnded = false;
  if (w.block_id) {
    const b = await sql<{
      status: string;
    }>`select status from blocks where organization_id = ${ctx.actor.orgId} and id = ${w.block_id}`.execute(
      ctx.trx,
    );
    if (b.rows[0]?.status === "approved") {
      await endBlock(ctx, w.block_id, input.now);
      blockEnded = true;
    } else if (b.rows[0]?.status === "requested") {
      await sql`update blocks set status = 'rejected', version = version + 1
                where organization_id = ${ctx.actor.orgId} and id = ${w.block_id}`.execute(ctx.trx);
    }
  }
  const task = await createCleaningTask(ctx, {
    propertyId: w.property_id,
    unitId: w.unit_id,
    sourceType: "work_order",
    sourceId: w.id,
  });
  await audit(ctx, w, "verified", "verified", { block_ended: blockEnded, cleaning_task_id: task.taskId });
  return { workOrderId: w.id, status: "verified" as const, blockEnded, cleaningTaskId: task.taskId };
}

/** `maintenance.cancelWorkOrder`: owner/manager, có lý do. */
export async function cancelWorkOrder(ctx: CommandContext, input: { workOrderId: string; reason: string }) {
  const w = await lockWorkOrder(ctx, input.workOrderId, (row) => {
    authorize(ctx.actor, "work_order.handle", { propertyId: row.property_id });
    if (ctx.actor.role === "maintenance")
      throw new CommandError("FORBIDDEN", 403, "Kỹ thuật không huỷ phiếu");
  });
  if (!["open", "assigned", "in_progress"].includes(w.status)) deny(w.status, "cancelled");
  const reason = input.reason.trim();
  if (!reason) throw fieldError("reason", "required", "Cần lý do huỷ");
  await sql`update work_orders set status = 'cancelled', cancel_reason = ${reason}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${w.id}`.execute(ctx.trx);
  await audit(ctx, w, "cancelled", "cancelled", { reason });
  return { workOrderId: w.id, status: "cancelled" as const };
}

/** `maintenance.proposeBlock` (S-018): tạo block `requested` gắn phiếu (qua `inventory.proposeBlock`); kỹ thuật không duyệt. */
export async function proposeWorkOrderBlock(
  ctx: CommandContext,
  input: { workOrderId: string; start: Date; end: Date; reason: string },
): Promise<{ blockId: string }> {
  const w = await lockWorkOrder(ctx, input.workOrderId, (row) =>
    authorize(ctx.actor, "block.propose", { propertyId: row.property_id }),
  );
  if (!["open", "assigned", "in_progress"].includes(w.status)) deny(w.status, w.status);
  const reason = input.reason.trim();
  if (!reason) throw fieldError("reason", "required", "Cần lý do");
  const { blockId } = await proposeBlock(ctx, {
    unitId: w.unit_id,
    period: { start: input.start, end: input.end },
    reason,
  });
  await sql`update blocks set work_order_id = ${w.id} where organization_id = ${ctx.actor.orgId} and id = ${blockId}`.execute(
    ctx.trx,
  );
  await sql`update work_orders set block_id = ${blockId}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${w.id}`.execute(ctx.trx);
  return { blockId };
}

export { approveBlock };

export const WORK_ORDER_FIELDS = [
  "id",
  "unitId",
  "unitCode",
  "title",
  "description",
  "severity",
  "status",
  "source",
  "assigneeMembershipId",
  "blockId",
  "createdAt",
  "doneAt",
  "verifiedAt",
  "photoFileIds",
] as const;

export interface WorkOrderView {
  id: string;
  unitId: string;
  unitCode: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  source: string;
  assigneeMembershipId: string | null;
  blockId: string | null;
  createdAt: Date;
  doneAt: Date | null;
  verifiedAt: Date | null;
  photoFileIds: string[];
}

/** `maintenance.listWorkOrders` (query, S-022): theo cơ sở; `mine` = phiếu được giao cho mình. Không tiền/khách. */
export async function listWorkOrders(
  db: Kysely<unknown>,
  actor: Actor,
  input: { propertyId: string; status?: Status; mine?: boolean },
): Promise<WorkOrderView[]> {
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
  try {
    authorize(actor, "calendar.read_status", { propertyId: input.propertyId });
  } catch {
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
  }
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const p = await sql<{
      id: string;
    }>`select id from properties where organization_id = ${actor.orgId} and id = ${input.propertyId}`.execute(
      trx,
    );
    if (!p.rows[0]) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
    const r = await sql<{
      id: string;
      unit_id: string;
      unit_code: string;
      title: string;
      description: string;
      severity: string;
      status: string;
      source: string;
      assignee_membership_id: string | null;
      block_id: string | null;
      created_at: Date;
      done_at: Date | null;
      verified_at: Date | null;
      photos: string[] | null;
    }>`
      select w.id, w.unit_id, u.code as unit_code, w.title, w.description, w.severity, w.status, w.source,
             w.assignee_membership_id, w.block_id, w.created_at, w.done_at, w.verified_at,
             (select array_agg(f.id order by f.created_at) from files f where f.organization_id = w.organization_id
                and f.owner_type = 'work_order' and f.owner_id = w.id and f.status = 'ready') as photos
      from work_orders w join units u on u.organization_id = w.organization_id and u.id = w.unit_id
      where w.organization_id = ${actor.orgId} and w.property_id = ${input.propertyId}
        ${input.status ? sql`and w.status = ${input.status}` : sql``}
        ${input.mine ? sql`and w.assignee_membership_id = ${actor.membershipId}` : sql``}
      order by case w.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, w.created_at
      limit 500`.execute(trx);
    return r.rows.map((x) => ({
      id: x.id,
      unitId: x.unit_id,
      unitCode: x.unit_code,
      title: x.title,
      description: x.description,
      severity: x.severity,
      status: x.status,
      source: x.source,
      assigneeMembershipId: x.assignee_membership_id,
      blockId: x.block_id,
      createdAt: x.created_at,
      doneAt: x.done_at,
      verifiedAt: x.verified_at,
      photoFileIds: x.photos ?? [],
    }));
  });
}

export interface TenantWorkOrderView {
  id: string;
  unitCode: string;
  title: string;
  severity: string;
  status: string;
  createdAt: Date;
  doneAt: Date | null;
  verifiedAt: Date | null;
}

/**
 * `maintenance.listMyWorkOrders` (query, S-021): người thuê xem phiếu MÌNH báo — RLS `work_orders_read` lọc theo
 * `reporter_person_id`; không lộ người được giao, mô tả nội bộ, block hay ảnh.
 */
export async function listMyWorkOrders(db: Kysely<unknown>, actor: Actor): Promise<TenantWorkOrderView[]> {
  if (actor.role !== "tenant" || !actor.personId)
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      id: string;
      unit_code: string;
      title: string;
      severity: string;
      status: string;
      created_at: Date;
      done_at: Date | null;
      verified_at: Date | null;
    }>`
      select w.id, u.code as unit_code, w.title, w.severity, w.status, w.created_at, w.done_at, w.verified_at
      from work_orders w join units u on u.organization_id = w.organization_id and u.id = w.unit_id
      where w.organization_id = ${actor.orgId} and w.reporter_person_id = ${actor.personId}
      order by w.created_at desc
      limit 200`.execute(trx);
    return r.rows.map((x) => ({
      id: x.id,
      unitCode: x.unit_code,
      title: x.title,
      severity: x.severity,
      status: x.status,
      createdAt: x.created_at,
      doneAt: x.done_at,
      verifiedAt: x.verified_at,
    }));
  });
}
