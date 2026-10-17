// Ca quầy tối thiểu (PLAN đợt 2 T-104; SPEC-ledger "Ca quầy tối thiểu", S-034, S-035; INV-F3b, INV-F6).
// - Tiền mặt dự kiến = đầu ca + Σ(Nợ − Có) các dòng CASH gắn ca trong sổ phụ (thu đã xác nhận, chi/hoàn, khoản đảo) —
//   một nguồn sự thật, không nhập tay.
// - Lễ tân mở/đóng/giao ca CỦA MÌNH; owner/manager ca bất kỳ trong phạm vi; kế toán đóng/đối chiếu, KHÔNG mở ca
//   (SPEC: "accountant đóng/đối chiếu ca (không nhận tiền)").
// - Chênh lệch ≠ 0 → `shift_discrepancies` có người chịu trách nhiệm; không tự sửa số dư.
import { randomUUID } from "node:crypto";
import { authorize } from "@hm/domain";
import { sql, type Transaction } from "kysely";
import { type CommandContext, CommandError } from "../pipeline/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertCash(n: number, field: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new CommandError("VALIDATION_FAILED", 422, `${field} phải là số nguyên đồng không âm`);
  }
}

interface ShiftRow {
  id: string;
  property_id: string;
  opened_by: string;
  opener_person_id: string;
  opening_cash: string;
  status: "open" | "closed" | "handed_over";
  counted_cash: string | null;
  handed_to: string | null;
}

/**
 * Đọc ca (RLS cho thấy ca trong phạm vi), kiểm quyền bằng `check`, rồi mới khoá hàng FOR UPDATE — để người không có
 * quyền ghi nhận 403 đúng SPEC thay vì 404, và chỉ người có quyền mới giữ khoá.
 */
async function lockShift(
  ctx: CommandContext,
  shiftId: string,
  check: (row: ShiftRow) => void,
): Promise<ShiftRow> {
  if (!UUID.test(shiftId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy ca");
  const read = (lock: boolean) =>
    sql<ShiftRow>`
    select s.id, s.property_id, s.opened_by, m.person_id as opener_person_id, s.opening_cash, s.status, s.counted_cash,
           s.handed_to
    from shifts s join memberships m on m.organization_id = s.organization_id and m.id = s.opened_by
    where s.organization_id = ${ctx.actor.orgId} and s.id = ${shiftId}
    ${lock ? sql`for update of s` : sql``}`.execute(ctx.trx);
  const seen = (await read(false)).rows[0];
  if (!seen) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy ca");
  check(seen);
  const row = (await read(true)).rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy ca");
  return row;
}

/**
 * Ca đang mở của chính người thao tác tại cơ sở (null nếu chưa mở) — dùng cho xác nhận/chi tiền mặt (INV-F3b). Khoá
 * FOR SHARE tới hết transaction để đóng ca không chen giữa (INV-F6).
 */
export async function openShiftOf(
  trx: Transaction<unknown>,
  orgId: string,
  membershipId: string,
  propertyId: string,
): Promise<string | null> {
  const r = await sql<{ id: string }>`
    select id from shifts
    where organization_id = ${orgId} and opened_by = ${membershipId} and property_id = ${propertyId} and status = 'open'
    for share`.execute(trx);
  return r.rows[0]?.id ?? null;
}

/** Tiền mặt dự kiến theo sổ phụ (đầu ca + Σ Nợ − Σ Có của dòng CASH gắn ca). */
export async function expectedCash(
  trx: Transaction<unknown>,
  orgId: string,
  shiftId: string,
): Promise<number> {
  const r = await sql<{ opening: string; net: string }>`
    select s.opening_cash as opening,
           coalesce((select sum(l.debit - l.credit) from journal_lines l
                     where l.organization_id = s.organization_id and l.shift_id = s.id and l.account = 'CASH'), 0) as net
    from shifts s where s.organization_id = ${orgId} and s.id = ${shiftId}`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy ca");
  return Number(row.opening) + Number(row.net);
}

async function insertShift(
  ctx: CommandContext,
  input: { propertyId: string; openingCash: number; previousShiftId?: string },
): Promise<string> {
  const id = randomUUID();
  try {
    await sql`savepoint shift_open`.execute(ctx.trx);
    await sql`
      insert into shifts (id, organization_id, property_id, opened_by, opening_cash, previous_shift_id)
      values (${id}, ${ctx.actor.orgId}, ${input.propertyId}, ${ctx.actor.membershipId}, ${input.openingCash},
              ${input.previousShiftId ?? null})`.execute(ctx.trx);
    await sql`release savepoint shift_open`.execute(ctx.trx);
  } catch (err) {
    if ((err as { constraint?: string }).constraint === "uq_shifts_one_open") {
      await sql`rollback to savepoint shift_open`.execute(ctx.trx);
      throw new CommandError("SHIFT_ALREADY_OPEN", 409, "Bạn đang có một ca chưa đóng");
    }
    throw err;
  }
  await ctx.audit({
    action: "shift.opened",
    entityType: "shift",
    entityId: id,
    propertyId: input.propertyId,
    after: { opening_cash: input.openingCash, previous_shift_id: input.previousShiftId ?? null },
  });
  return id;
}

/** `shift.open`: mở ca của chính mình (đầu ca 0 đ hợp lệ). */
export async function openShift(
  ctx: CommandContext,
  input: { propertyId: string; openingCash: number },
): Promise<{ shiftId: string }> {
  assertCash(input.openingCash, "Tiền đầu ca");
  if (ctx.actor.role === "accountant") {
    throw new CommandError("FORBIDDEN", 403, "Kế toán đóng/đối chiếu ca, không mở ca nhận tiền");
  }
  authorize(ctx.actor, "shift.open_close", {
    propertyId: input.propertyId,
    subjectPersonId: ctx.actor.personId,
  });
  return { shiftId: await insertShift(ctx, input) };
}

/** `shift.close`: nhập tiền đếm; hệ thống tính dự kiến từ sổ phụ; chênh lệch ≠ 0 → shift_discrepancies. */
export async function closeShift(
  ctx: CommandContext,
  input: { shiftId: string; countedCash: number },
): Promise<{ expectedCash: number; countedCash: number; difference: number; discrepancyId: string | null }> {
  assertCash(input.countedCash, "Tiền đếm thực tế");
  const s = await lockShift(ctx, input.shiftId, (row) =>
    authorize(ctx.actor, "shift.open_close", {
      propertyId: row.property_id,
      subjectPersonId: row.opener_person_id,
    }),
  );
  if (s.status !== "open") throw new CommandError("INVALID_TRANSITION", 409, "Ca không còn mở");
  const pending = await sql<{ n: number }>`
    select count(*)::int as n from payments
    where organization_id = ${ctx.actor.orgId} and shift_id = ${s.id} and status = 'pending'`.execute(
    ctx.trx,
  );
  if ((pending.rows[0]?.n ?? 0) > 0) {
    throw new CommandError("SHIFT_HAS_PENDING_PAYMENTS", 409, "Còn khoản tiền mặt chưa xác nhận trong ca");
  }
  const expected = await expectedCash(ctx.trx, ctx.actor.orgId, s.id);
  const difference = input.countedCash - expected;
  await sql`
    update shifts set status = 'closed', expected_cash = ${expected}, counted_cash = ${input.countedCash},
           closed_by = ${ctx.actor.membershipId}, closed_at = now(), version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${s.id}`.execute(ctx.trx);
  let discrepancyId: string | null = null;
  if (difference !== 0) {
    discrepancyId = randomUUID();
    await sql`
      insert into shift_discrepancies (id, organization_id, property_id, shift_id, kind, amount, responsible_membership_id)
      values (${discrepancyId}, ${ctx.actor.orgId}, ${s.property_id}, ${s.id}, 'close', ${difference}, ${s.opened_by})`.execute(
      ctx.trx,
    );
  }
  await ctx.audit({
    action: "shift.closed",
    entityType: "shift",
    entityId: s.id,
    propertyId: s.property_id,
    before: { status: "open" },
    after: { status: "closed", expected_cash: expected, counted_cash: input.countedCash, difference },
  });
  return { expectedCash: expected, countedCash: input.countedCash, difference, discrepancyId };
}

/** `shift.handover` bước 1: người giao (chủ ca đã đóng) chỉ định người nhận; số giao = tiền đếm khi đóng ca. */
export async function handoverShift(
  ctx: CommandContext,
  input: { shiftId: string; toMembershipId: string },
): Promise<{ shiftId: string; declaredCash: number }> {
  const s = await lockShift(ctx, input.shiftId, (row) =>
    authorize(ctx.actor, "shift.handover", {
      propertyId: row.property_id,
      subjectPersonId: row.opener_person_id,
    }),
  );
  if (s.status !== "closed" || s.handed_to !== null) {
    throw new CommandError("INVALID_TRANSITION", 409, "Chỉ giao ca đã đóng và chưa giao");
  }
  if (input.toMembershipId === s.opened_by) {
    throw new CommandError("SELF_APPROVAL_FORBIDDEN", 403, "Không tự nhận ca của chính mình");
  }
  if (!UUID.test(input.toMembershipId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy người nhận");
  const to = await sql<{ id: string }>`
    select id from memberships
    where organization_id = ${ctx.actor.orgId} and id = ${input.toMembershipId} and status = 'active'
      and role in ('owner','manager','front_desk')`.execute(ctx.trx);
  if (!to.rows[0]) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy người nhận");
  await sql`
    update shifts set handed_to = ${input.toMembershipId}, version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${s.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "shift.handover_declared",
    entityType: "shift",
    entityId: s.id,
    propertyId: s.property_id,
    after: { handed_to: input.toMembershipId, declared_cash: Number(s.counted_cash) },
  });
  return { shiftId: s.id, declaredCash: Number(s.counted_cash) };
}

/**
 * `shift.receiveHandover` bước 2: người nhận (≠ người giao) xác nhận số nhận; mở ca mới với đầu ca = số nhận. Lệch với số
 * giao → shift_discrepancies loại `handover` (người chịu trách nhiệm mặc định = người giao).
 */
export async function receiveHandover(
  ctx: CommandContext,
  input: { shiftId: string; receivedCash: number },
): Promise<{ newShiftId: string; difference: number; discrepancyId: string | null }> {
  assertCash(input.receivedCash, "Tiền nhận");
  const s = await lockShift(ctx, input.shiftId, (row) => {
    if (row.handed_to !== null && row.handed_to !== ctx.actor.membershipId) {
      throw new CommandError(
        row.opened_by === ctx.actor.membershipId ? "SELF_APPROVAL_FORBIDDEN" : "FORBIDDEN",
        403,
        "Chỉ người được giao mới xác nhận nhận ca",
      );
    }
  });
  if (s.status !== "closed" || s.handed_to === null) {
    throw new CommandError("INVALID_TRANSITION", 409, "Ca không ở trạng thái chờ nhận");
  }
  const declared = Number(s.counted_cash);
  const difference = input.receivedCash - declared;
  await sql`
    update shifts set status = 'handed_over', received_cash = ${input.receivedCash}, received_at = now(), version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${s.id}`.execute(ctx.trx);
  let discrepancyId: string | null = null;
  if (difference !== 0) {
    discrepancyId = randomUUID();
    await sql`
      insert into shift_discrepancies (id, organization_id, property_id, shift_id, kind, amount, responsible_membership_id)
      values (${discrepancyId}, ${ctx.actor.orgId}, ${s.property_id}, ${s.id}, 'handover', ${difference}, ${s.opened_by})`.execute(
      ctx.trx,
    );
  }
  await ctx.audit({
    action: "shift.handover_received",
    entityType: "shift",
    entityId: s.id,
    propertyId: s.property_id,
    after: {
      received_by: ctx.actor.membershipId,
      received_cash: input.receivedCash,
      declared_cash: declared,
      difference,
    },
  });
  const newShiftId = await insertShift(ctx, {
    propertyId: s.property_id,
    openingCash: input.receivedCash,
    previousShiftId: s.id,
  });
  return { newShiftId, difference, discrepancyId };
}

/** Quản lý gán lại người chịu trách nhiệm chênh lệch (có audit). */
export async function reassignDiscrepancy(
  ctx: CommandContext,
  input: { discrepancyId: string; responsibleMembershipId: string; reason: string },
): Promise<void> {
  if (!["owner", "manager"].includes(ctx.actor.role)) {
    throw new CommandError("FORBIDDEN", 403, "Chỉ quản lý/chủ gán lại người chịu trách nhiệm");
  }
  if (!input.reason.trim()) throw new CommandError("VALIDATION_FAILED", 422, "Cần lý do");
  const d = await sql<{ property_id: string; responsible_membership_id: string; status: string }>`
    select property_id, responsible_membership_id, status from shift_discrepancies
    where organization_id = ${ctx.actor.orgId} and id = ${input.discrepancyId} for update`.execute(ctx.trx);
  const row = d.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy chênh lệch");
  authorize(ctx.actor, "shift.open_close", { propertyId: row.property_id });
  if (row.status !== "open") throw new CommandError("INVALID_TRANSITION", 409, "Chênh lệch đã xử lý");
  const target = await sql<{ id: string }>`
    select m.id from memberships m
    where m.organization_id = ${ctx.actor.orgId} and m.id = ${input.responsibleMembershipId} and m.status = 'active'
      and m.role in ('owner','manager','front_desk','accountant')
      and (m.all_properties or exists (select 1 from property_scopes ps where ps.organization_id = m.organization_id
                                        and ps.membership_id = m.id and ps.property_id = ${row.property_id}))`.execute(
    ctx.trx,
  );
  if (target.rows.length === 0) {
    throw new CommandError(
      "VALIDATION_FAILED",
      422,
      "Người được gán phải là nhân viên còn hiệu lực của cơ sở",
    );
  }
  await sql`
    update shift_discrepancies set responsible_membership_id = ${input.responsibleMembershipId}, version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${input.discrepancyId}`.execute(ctx.trx);
  await ctx.audit({
    action: "shift.discrepancy_reassigned",
    entityType: "shift_discrepancy",
    entityId: input.discrepancyId,
    propertyId: row.property_id,
    before: { responsible: row.responsible_membership_id },
    after: { responsible: input.responsibleMembershipId },
    reason: input.reason,
  });
}
