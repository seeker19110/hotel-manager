// Yêu cầu duyệt có hạn mức (PLAN đợt 2 T-102; ERD `approval_requests`; SPEC-access S-017, SPEC-ledger S-014/S-033, INV-F5).
// - Lập: ai có ô khác "—" trong ma trận của hành động tương ứng (kể cả "Đề nghị" của kế toán), trong phạm vi cơ sở.
// - Duyệt: authorize() đầy đủ — hạn mức theo số tiền, cấm tự duyệt, "Đề nghị" không được duyệt; thao tác chờ duyệt chạy
//   ĐÚNG MỘT LẦN trong cùng transaction với trạng thái `executed` (khoá hàng FOR UPDATE; hai người duyệt cùng lúc → một
//   người nhận INVALID_TRANSITION).
// - Ngữ cảnh duyệt (vd. "đang check-out") do executor suy ra từ CSDL, không nhận từ client.
import { randomUUID } from "node:crypto";
import { type Action, authorize, authorizeRequest } from "@hm/domain";
import { sql } from "kysely";
import type { Actor } from "../access/index.ts";
import { type CommandContext, CommandError } from "../pipeline/index.ts";

export const APPROVAL_KINDS = [
  "deposit_deduction",
  "deposit_refund",
  "credit_refund",
  "adjustment",
  "reversal",
  "discount",
  "cancellation_fee",
  "allow_balance",
  "period_unlock",
  "lease_settlement",
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** Hành động trong ma trận quyền (SPEC-access 5.3) dùng để kiểm lập/duyệt từng loại. */
export const KIND_ACTION: Readonly<Record<ApprovalKind, Action>> = {
  deposit_deduction: "deposit.refund",
  deposit_refund: "deposit.refund",
  credit_refund: "credit.refund",
  adjustment: "payment.allocate",
  reversal: "payment.allocate",
  discount: "reservation.override_price",
  cancellation_fee: "reservation.override_price",
  allow_balance: "stay.checkout_with_debt",
  period_unlock: "period.unlock",
  lease_settlement: "lease.approve_settlement",
};

export interface ApprovalRow {
  id: string;
  propertyId: string | null;
  kind: ApprovalKind;
  amount: number | null;
  reason: string;
  subjectType: string | null;
  subjectId: string | null;
  payload: Record<string, unknown>;
  requestedBy: string;
  requesterPersonId: string;
  status: "pending" | "approved" | "rejected" | "executed" | "cancelled";
}

export interface ApprovalExecutor {
  /** Ngữ cảnh kiểm quyền suy ra từ CSDL (vd. atCheckout từ trạng thái stay) — không tin client. */
  context?(ctx: CommandContext, req: ApprovalRow): Promise<{ atCheckout?: boolean }>;
  /** Thực hiện thao tác đã được duyệt (cùng transaction). */
  execute(ctx: CommandContext, req: ApprovalRow): Promise<unknown>;
}

const executors = new Map<ApprovalKind, ApprovalExecutor>();

/** Module nghiệp vụ đăng ký cách thực hiện từng loại (một lần lúc nạp module). */
export function registerApprovalExecutor(kind: ApprovalKind, executor: ApprovalExecutor): void {
  if (executors.has(kind)) throw new Error(`Đã đăng ký executor cho ${kind}`);
  executors.set(kind, executor);
}

/** Chỉ cho test: thay executor của một loại. */
export function replaceApprovalExecutorForTest(
  kind: ApprovalKind,
  executor: ApprovalExecutor | undefined,
): void {
  if (executor) executors.set(kind, executor);
  else executors.delete(kind);
}

export interface ApprovalInput {
  kind: ApprovalKind;
  amount: number | null;
  reason: string;
  propertyId: string | null;
  subjectType?: string;
  subjectId?: string;
  payload?: Record<string, unknown>;
}

function validate(input: ApprovalInput): void {
  if (!(APPROVAL_KINDS as readonly string[]).includes(input.kind)) {
    throw new CommandError("VALIDATION_FAILED", 422, "Loại yêu cầu duyệt không hợp lệ");
  }
  if (input.amount !== null && (!Number.isSafeInteger(input.amount) || input.amount < 0)) {
    throw new CommandError("VALIDATION_FAILED", 422, "Số tiền phải là số nguyên đồng không âm");
  }
  if (!input.reason.trim()) throw new CommandError("VALIDATION_FAILED", 422, "Cần lý do");
}

async function insertRequest(
  trx: CommandContext["trx"],
  actor: Actor,
  input: ApprovalInput,
  commandId: string | null,
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into approval_requests (id, organization_id, property_id, kind, amount, reason, subject_type, subject_id, payload,
                                   requested_by, command_id)
    values (${id}, ${actor.orgId}, ${input.propertyId}, ${input.kind}, ${input.amount}, ${input.reason.trim()},
            ${input.subjectType ?? null}, ${input.subjectId ?? null}, ${JSON.stringify(input.payload ?? {})}::jsonb,
            ${actor.membershipId}, ${commandId})`.execute(trx);
  return id;
}

/** `approval.request`: lập yêu cầu duyệt (trạng thái pending), audit + outbox để báo người duyệt. */
export async function requestApproval(
  ctx: CommandContext,
  input: ApprovalInput,
): Promise<{ approvalRequestId: string }> {
  validate(input);
  authorizeRequest(
    ctx.actor,
    KIND_ACTION[input.kind],
    input.propertyId ? { propertyId: input.propertyId } : {},
  );
  const id = await insertRequest(ctx.trx, ctx.actor, input, ctx.commandId);
  await ctx.audit({
    action: "approval.requested",
    entityType: "approval_request",
    entityId: id,
    ...(input.propertyId ? { propertyId: input.propertyId } : {}),
    after: {
      kind: input.kind,
      amount: input.amount,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
    },
    reason: input.reason,
  });
  await ctx.emit({
    eventType: "approval.requested",
    aggregateType: "approval_request",
    aggregateId: id,
    ...(input.propertyId ? { propertyId: input.propertyId } : {}),
    payload: { approval_request_id: id, kind: input.kind, amount: input.amount },
  });
  return { approvalRequestId: id };
}

/**
 * Lệnh nghiệp vụ vượt hạn mức của chính người thao tác (SPEC-access S-017): trả 403 APPROVAL_LIMIT_EXCEEDED và lập yêu
 * cầu pending (ghi trong transaction lưu kết quả lỗi — đúng một lần cho mỗi Idempotency-Key); problem có
 * `approval_request_id`.
 */
export function approvalRequired(actor: Actor, input: ApprovalInput, message: string): CommandError {
  validate(input);
  authorizeRequest(actor, KIND_ACTION[input.kind], input.propertyId ? { propertyId: input.propertyId } : {});
  return new CommandError("APPROVAL_LIMIT_EXCEEDED", 403, message, {
    persist: async (trx) => ({ approval_request_id: await insertRequest(trx, actor, input, null) }),
  });
}

async function lockRequest(ctx: CommandContext, id: string): Promise<ApprovalRow> {
  const r = await sql<{
    id: string;
    property_id: string | null;
    kind: ApprovalKind;
    amount: string | null;
    reason: string;
    subject_type: string | null;
    subject_id: string | null;
    payload: Record<string, unknown>;
    requested_by: string;
    requester_person_id: string;
    status: ApprovalRow["status"];
  }>`
    select a.id, a.property_id, a.kind, a.amount, a.reason, a.subject_type, a.subject_id, a.payload, a.requested_by,
           m.person_id as requester_person_id, a.status
    from approval_requests a
    join memberships m on m.organization_id = a.organization_id and m.id = a.requested_by
    where a.organization_id = ${ctx.actor.orgId} and a.id = ${id}
    for update of a`.execute(ctx.trx);
  const row = r.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy yêu cầu duyệt");
  return {
    id: row.id,
    propertyId: row.property_id,
    kind: row.kind,
    amount: row.amount === null ? null : Number(row.amount),
    reason: row.reason,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    payload: row.payload,
    requestedBy: row.requested_by,
    requesterPersonId: row.requester_person_id,
    status: row.status,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `approval.approve` / `approval.reject`. Duyệt = kiểm hạn mức theo số tiền rồi thực hiện đúng một lần. */
export async function decideApproval(
  ctx: CommandContext,
  input: { approvalRequestId: string; decision: "approve" | "reject"; note?: string },
): Promise<{ status: "executed" | "rejected"; result?: unknown }> {
  if (!UUID.test(input.approvalRequestId))
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy yêu cầu duyệt");
  const req = await lockRequest(ctx, input.approvalRequestId);
  if (req.status !== "pending") {
    throw new CommandError("INVALID_TRANSITION", 409, `Yêu cầu đã ở trạng thái ${req.status}`);
  }
  const action = KIND_ACTION[req.kind];
  const executor = executors.get(req.kind);
  const extra = input.decision === "approve" && executor?.context ? await executor.context(ctx, req) : {};
  const authz = authorize(ctx.actor, action, {
    ...(req.propertyId ? { propertyId: req.propertyId } : {}),
    // Từ chối không phụ thuộc số tiền; duyệt kiểm đúng số tiền của yêu cầu.
    amount: input.decision === "approve" ? (req.amount ?? 0) : 0,
    requestedByPersonId: req.requesterPersonId,
    ...extra,
  });
  // SPEC-ledger mục 10 (một chỗ quyết hạn mức): kế toán chỉ lập đề nghị, không duyệt loại nào (review R4).
  if ((authz.grant !== "yes" && authz.grant !== "limit") || ctx.actor.role === "accountant") {
    throw new CommandError("FORBIDDEN", 403, "Vai trò này chỉ lập đề nghị, không duyệt");
  }
  if (req.requestedBy === ctx.actor.membershipId) {
    throw new CommandError("SELF_APPROVAL_FORBIDDEN", 403, "Bạn không thể tự duyệt yêu cầu mình lập");
  }
  const base = {
    entityType: "approval_request",
    entityId: req.id,
    ...(req.propertyId ? { propertyId: req.propertyId } : {}),
  };
  if (input.decision === "reject") {
    await sql`
      update approval_requests set status = 'rejected', approved_by = ${ctx.actor.membershipId}, decided_at = now(),
             decision_note = ${input.note ?? null}, version = version + 1
      where organization_id = ${ctx.actor.orgId} and id = ${req.id}`.execute(ctx.trx);
    await ctx.audit({
      ...base,
      action: "approval.rejected",
      before: { status: "pending", requested_by: req.requestedBy },
      after: { status: "rejected", approved_by: ctx.actor.membershipId },
      ...(input.note ? { reason: input.note } : {}),
    });
    return { status: "rejected" };
  }
  if (!executor) {
    throw new CommandError("APPROVAL_NOT_EXECUTABLE", 409, `Chưa hỗ trợ thực hiện loại ${req.kind}`);
  }
  await sql`
    update approval_requests set status = 'approved', approved_by = ${ctx.actor.membershipId}, decided_at = now(),
           decision_note = ${input.note ?? null}, version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${req.id}`.execute(ctx.trx);
  const result = await executor.execute(ctx, req);
  await sql`
    update approval_requests set status = 'executed', executed_at = now(), version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${req.id}`.execute(ctx.trx);
  await ctx.audit({
    ...base,
    action: "approval.executed",
    before: { status: "pending", requested_by: req.requestedBy },
    after: { status: "executed", approved_by: ctx.actor.membershipId, kind: req.kind, amount: req.amount },
    ...(input.note ? { reason: input.note } : {}),
  });
  return { status: "executed", result };
}

/** `approval.cancel`: chỉ người lập huỷ yêu cầu còn pending. */
export async function cancelApproval(
  ctx: CommandContext,
  approvalRequestId: string,
): Promise<{ status: "cancelled" }> {
  if (!UUID.test(approvalRequestId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy yêu cầu duyệt");
  const req = await lockRequest(ctx, approvalRequestId);
  if (req.requestedBy !== ctx.actor.membershipId) {
    throw new CommandError("FORBIDDEN", 403, "Chỉ người lập được huỷ yêu cầu");
  }
  if (req.status !== "pending") {
    throw new CommandError("INVALID_TRANSITION", 409, `Yêu cầu đã ở trạng thái ${req.status}`);
  }
  await sql`
    update approval_requests set status = 'cancelled', decided_at = now(), version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${req.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "approval.cancelled",
    entityType: "approval_request",
    entityId: req.id,
    ...(req.propertyId ? { propertyId: req.propertyId } : {}),
    before: { status: "pending" },
    after: { status: "cancelled" },
  });
  return { status: "cancelled" };
}
