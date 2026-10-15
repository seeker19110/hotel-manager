// Danh mục command công khai qua `POST /api/v1/<module>/<command>` (API-CONTRACT §1). Thêm command = thêm một mục ở đây
// (schema Zod là hợp đồng đầu vào). Tên mục = tên command trong SPEC §5.
import type { StatementMapping } from "@hm/domain";
import { z } from "zod";
import { APPROVAL_KINDS, cancelApproval, decideApproval, requestApproval } from "../approvals/approvals.ts";
import {
  receiveDeposit,
  requestCreditRefund,
  requestDeduction,
  requestDepositRefund,
} from "../deposits/deposits.ts";
import { financialSummary, issueAdjustment, lockPeriod, unlockPeriod } from "../ledger/period-close.ts";
import { allocatePayment, confirmPayment, recordPayment, reversePayment } from "../payments/payments.ts";
import {
  confirmMatch,
  getTransferInfo,
  importStatement,
  previewMatches,
  resolveBreak,
} from "../reconciliation/reconciliation.ts";
import {
  closeShift,
  handoverShift,
  openShift,
  reassignDiscrepancy,
  receiveHandover,
} from "../shifts/shifts.ts";
import type { CommandDef, QueryDef } from "./command-route.ts";

const uuid = z.uuid();
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveMoney = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const bankTxn = z.strictObject({
  ref: z.string().trim().min(1).max(100),
  occurred_at: z.iso.datetime({ offset: true }),
  description: z.string().max(500).optional(),
});
const isoDate = z.iso.date();
const column = z.union([z.string().trim().min(1).max(100), z.number().int().min(0).max(200)]);
const toBankTxn = (b: z.infer<typeof bankTxn>) => ({
  ref: b.ref,
  occurredAt: b.occurred_at,
  ...(b.description ? { description: b.description } : {}),
});

/** Kiểu rộng cho danh mục (mỗi mục giữ schema riêng). */
// biome-ignore lint/suspicious/noExplicitAny: danh mục không đồng nhất; mỗi mục tự gõ kiểu qua defineCommand
type AnyCommand = CommandDef<any, any>;

function defineCommand<I, O>(def: CommandDef<I, O>): CommandDef<I, O> {
  return def;
}

export const COMMANDS: Readonly<Record<string, AnyCommand>> = {
  "approval.request": defineCommand({
    command: "approval.request",
    // Không nhận `payload` từ client: ngữ cảnh duyệt do server suy ra (executor), không tin client.
    input: z.strictObject({
      kind: z.enum(APPROVAL_KINDS),
      amount: money.nullable(),
      reason: z.string().trim().min(1).max(1000),
      property_id: uuid.nullable(),
      subject_type: z.string().min(1).max(64).optional(),
      subject_id: uuid.optional(),
    }),
    run: async (ctx, i) => ({
      data: await requestApproval(ctx, {
        kind: i.kind,
        amount: i.amount,
        reason: i.reason,
        propertyId: i.property_id,
        ...(i.subject_type ? { subjectType: i.subject_type } : {}),
        ...(i.subject_id ? { subjectId: i.subject_id } : {}),
      }),
      httpStatus: 201,
    }),
  }),
  "approval.approve": defineCommand({
    command: "approval.approve",
    input: z.strictObject({ approval_request_id: uuid, note: z.string().max(1000).optional() }),
    run: async (ctx, i) => ({
      data: await decideApproval(ctx, {
        approvalRequestId: i.approval_request_id,
        decision: "approve",
        ...(i.note ? { note: i.note } : {}),
      }),
    }),
  }),
  "approval.reject": defineCommand({
    command: "approval.reject",
    input: z.strictObject({ approval_request_id: uuid, note: z.string().trim().min(1).max(1000) }),
    run: async (ctx, i) => ({
      data: await decideApproval(ctx, {
        approvalRequestId: i.approval_request_id,
        decision: "reject",
        note: i.note,
      }),
    }),
  }),
  "approval.cancel": defineCommand({
    command: "approval.cancel",
    input: z.strictObject({ approval_request_id: uuid }),
    run: async (ctx, i) => ({ data: await cancelApproval(ctx, i.approval_request_id) }),
  }),
  "shift.open": defineCommand({
    command: "shift.open",
    input: z.strictObject({ property_id: uuid, opening_cash: money }),
    run: async (ctx, i) => ({
      data: await openShift(ctx, { propertyId: i.property_id, openingCash: i.opening_cash }),
      httpStatus: 201,
    }),
  }),
  "shift.close": defineCommand({
    command: "shift.close",
    input: z.strictObject({ shift_id: uuid, counted_cash: money }),
    run: async (ctx, i) => ({
      data: await closeShift(ctx, { shiftId: i.shift_id, countedCash: i.counted_cash }),
    }),
  }),
  "shift.handover": defineCommand({
    command: "shift.handover",
    input: z.strictObject({ shift_id: uuid, to_membership_id: uuid }),
    run: async (ctx, i) => ({
      data: await handoverShift(ctx, { shiftId: i.shift_id, toMembershipId: i.to_membership_id }),
    }),
  }),
  "shift.receiveHandover": defineCommand({
    command: "shift.receiveHandover",
    input: z.strictObject({ shift_id: uuid, received_cash: money }),
    run: async (ctx, i) => ({
      data: await receiveHandover(ctx, { shiftId: i.shift_id, receivedCash: i.received_cash }),
      httpStatus: 201,
    }),
  }),
  "shift.reassignDiscrepancy": defineCommand({
    command: "shift.reassignDiscrepancy",
    input: z.strictObject({
      discrepancy_id: uuid,
      responsible_membership_id: uuid,
      reason: z.string().trim().min(1).max(1000),
    }),
    run: async (ctx, i) => {
      await reassignDiscrepancy(ctx, {
        discrepancyId: i.discrepancy_id,
        responsibleMembershipId: i.responsible_membership_id,
        reason: i.reason,
      });
      return { data: { discrepancy_id: i.discrepancy_id } };
    },
  }),
  "payment.record": defineCommand({
    command: "payment.record",
    input: z.strictObject({
      property_id: uuid,
      method: z.enum(["cash", "bank_transfer"]),
      amount: positiveMoney,
      payer_person_id: uuid,
      receiving_account_id: uuid.optional(),
      bank_txn: bankTxn.optional(),
    }),
    run: async (ctx, i) => ({
      data: await recordPayment(ctx, {
        propertyId: i.property_id,
        method: i.method,
        amount: i.amount,
        payerPersonId: i.payer_person_id,
        ...(i.receiving_account_id ? { receivingAccountId: i.receiving_account_id } : {}),
        ...(i.bank_txn ? { bankTxn: toBankTxn(i.bank_txn) } : {}),
      }),
      httpStatus: 201,
    }),
  }),
  "payment.confirm": defineCommand({
    command: "payment.confirm",
    input: z.strictObject({
      payment_id: uuid,
      evidence: z
        .strictObject({ bank_transaction_id: uuid.optional(), bank_txn: bankTxn.optional() })
        .optional(),
    }),
    run: async (ctx, i) => ({
      data: await confirmPayment(ctx, {
        paymentId: i.payment_id,
        ...(i.evidence
          ? {
              evidence: {
                ...(i.evidence.bank_transaction_id
                  ? { bankTransactionId: i.evidence.bank_transaction_id }
                  : {}),
                ...(i.evidence.bank_txn ? { bankTxn: toBankTxn(i.evidence.bank_txn) } : {}),
              },
            }
          : {}),
      }),
    }),
  }),
  "payment.allocate": defineCommand({
    command: "payment.allocate",
    input: z.strictObject({
      payment_id: uuid,
      allocations: z
        .array(z.strictObject({ invoice_id: uuid, amount: positiveMoney }))
        .min(1)
        .max(50),
    }),
    run: async (ctx, i) => ({
      data: await allocatePayment(ctx, {
        paymentId: i.payment_id,
        allocations: i.allocations.map((a) => ({ invoiceId: a.invoice_id, amount: a.amount })),
      }),
    }),
  }),
  "payment.reverse": defineCommand({
    command: "payment.reverse",
    input: z.strictObject({ payment_id: uuid, reason: z.string().trim().min(1).max(1000) }),
    run: async (ctx, i) => ({
      data: await reversePayment(ctx, { paymentId: i.payment_id, reason: i.reason }),
    }),
  }),
  "deposit.receive": defineCommand({
    command: "deposit.receive",
    input: z
      .strictObject({
        property_id: uuid,
        lease_id: uuid.optional(),
        reservation_id: uuid.optional(),
        payer_person_id: uuid,
        amount: positiveMoney,
        method: z.enum(["cash", "bank_transfer"]),
        receiving_account_id: uuid.optional(),
        bank_txn: bankTxn.optional(),
      })
      .refine((i) => Boolean(i.lease_id) !== Boolean(i.reservation_id), {
        message: "lease_id hoặc reservation_id",
      }),
    run: async (ctx, i) => ({
      data: await receiveDeposit(ctx, {
        propertyId: i.property_id,
        payerPersonId: i.payer_person_id,
        amount: i.amount,
        method: i.method,
        ...(i.lease_id ? { leaseId: i.lease_id } : {}),
        ...(i.reservation_id ? { reservationId: i.reservation_id } : {}),
        ...(i.receiving_account_id ? { receivingAccountId: i.receiving_account_id } : {}),
        ...(i.bank_txn ? { bankTxn: toBankTxn(i.bank_txn) } : {}),
      }),
      httpStatus: 201,
    }),
  }),
  "deposit.requestDeduction": defineCommand({
    command: "deposit.requestDeduction",
    input: z.strictObject({
      deposit_id: uuid,
      invoice_id: uuid,
      amount: positiveMoney,
      reason: z.string().trim().min(1).max(1000),
    }),
    run: async (ctx, i) => ({
      data: await requestDeduction(ctx, {
        depositId: i.deposit_id,
        invoiceId: i.invoice_id,
        amount: i.amount,
        reason: i.reason,
      }),
      httpStatus: 201,
    }),
  }),
  "deposit.requestRefund": defineCommand({
    command: "deposit.requestRefund",
    input: z.strictObject({
      deposit_id: uuid,
      amount: positiveMoney,
      reason: z.string().trim().min(1).max(1000),
      method: z.enum(["cash", "bank_transfer"]),
      receiving_account_id: uuid.optional(),
    }),
    run: async (ctx, i) => ({
      data: await requestDepositRefund(ctx, {
        depositId: i.deposit_id,
        amount: i.amount,
        reason: i.reason,
        refund:
          i.method === "cash"
            ? { method: "cash" }
            : { method: "bank_transfer", receivingAccountId: i.receiving_account_id ?? "" },
      }),
      httpStatus: 201,
    }),
  }),
  "credit.requestRefund": defineCommand({
    command: "credit.requestRefund",
    input: z.strictObject({
      person_id: uuid,
      property_id: uuid,
      amount: positiveMoney,
      reason: z.string().trim().min(1).max(1000),
      method: z.enum(["cash", "bank_transfer"]),
      receiving_account_id: uuid.optional(),
    }),
    run: async (ctx, i) => ({
      data: await requestCreditRefund(ctx, {
        personId: i.person_id,
        propertyId: i.property_id,
        amount: i.amount,
        reason: i.reason,
        refund:
          i.method === "cash"
            ? { method: "cash" }
            : { method: "bank_transfer", receivingAccountId: i.receiving_account_id ?? "" },
      }),
      httpStatus: 201,
    }),
  }),
  "reconciliation.importStatement": defineCommand({
    command: "reconciliation.importStatement",
    input: z.strictObject({
      receiving_account_id: uuid,
      // Giới hạn cứng chống body khổng lồ; quá 2 MB (byte) → 413 FILE_TOO_LARGE ở lệnh (SPEC-ledger mục 5).
      csv: z
        .string()
        .min(1)
        .max(4 * 1024 * 1024),
      mapping: z.strictObject({
        date: column,
        description: column,
        amount: column.optional(),
        credit: column.optional(),
        debit: column.optional(),
        ref: column.optional(),
        balance: column.optional(),
        header: z.boolean().optional(),
      }),
    }),
    run: async (ctx, i) => ({
      data: await importStatement(ctx, {
        receivingAccountId: i.receiving_account_id,
        csv: i.csv,
        mapping: Object.fromEntries(
          Object.entries(i.mapping).filter(([, v]) => v !== undefined),
        ) as unknown as StatementMapping,
      }),
    }),
  }),
  "reconciliation.confirmMatch": defineCommand({
    command: "reconciliation.confirmMatch",
    input: z.strictObject({
      bank_transaction_id: uuid,
      allocations: z.array(z.strictObject({ invoice_id: uuid, amount: positiveMoney })).max(50),
      payer_person_id: uuid.optional(),
      third_party_payer: z.boolean().optional(),
      note: z.string().trim().max(1000).optional(),
    }),
    run: async (ctx, i) => ({
      data: await confirmMatch(ctx, {
        bankTransactionId: i.bank_transaction_id,
        allocations: i.allocations.map((a) => ({ invoiceId: a.invoice_id, amount: a.amount })),
        ...(i.payer_person_id ? { payerPersonId: i.payer_person_id } : {}),
        ...(i.third_party_payer === undefined ? {} : { thirdPartyPayer: i.third_party_payer }),
        ...(i.note === undefined ? {} : { note: i.note }),
      }),
      httpStatus: 201,
    }),
  }),
  "reconciliation.resolveBreak": defineCommand({
    command: "reconciliation.resolveBreak",
    input: z.strictObject({ break_id: uuid, resolution: z.string().trim().min(1).max(1000) }),
    run: async (ctx, i) => ({
      data: await resolveBreak(ctx, { breakId: i.break_id, resolution: i.resolution }),
    }),
  }),
  "ledger.lockPeriod": defineCommand({
    command: "ledger.lockPeriod",
    input: z.strictObject({
      property_id: uuid,
      locked_through: isoDate,
      reason: z.string().trim().min(1).max(1000),
    }),
    run: async (ctx, i) => ({
      data: await lockPeriod(ctx, {
        propertyId: i.property_id,
        lockedThrough: i.locked_through,
        reason: i.reason,
      }),
      httpStatus: 201,
    }),
  }),
  "ledger.unlockPeriod": defineCommand({
    command: "ledger.unlockPeriod",
    // Lý do kiểm ở lệnh (sau kiểm quyền) để người không có quyền nhận 403 trước 422 (S-023).
    input: z.strictObject({ property_id: uuid, from: isoDate, reason: z.string().max(1000) }),
    run: async (ctx, i) => ({
      data: await unlockPeriod(ctx, { propertyId: i.property_id, from: i.from, reason: i.reason }),
    }),
  }),
  "ledger.issueAdjustment": defineCommand({
    command: "ledger.issueAdjustment",
    input: z.strictObject({
      invoice_id: uuid,
      amount: positiveMoney,
      reason: z.string().trim().min(1).max(1000),
    }),
    run: async (ctx, i) => ({
      data: await issueAdjustment(ctx, { invoiceId: i.invoice_id, amount: i.amount, reason: i.reason }),
      httpStatus: 201,
    }),
  }),
};

/** Tìm command theo đường dẫn `<module>/<command>`; tên chỉ gồm chữ/số để không lọt ký tự lạ. */
export function findCommand(module: string, command: string): AnyCommand | undefined {
  if (!/^[a-z][a-z_]*$/.test(module) || !/^[a-zA-Z][a-zA-Z]*$/.test(command)) return undefined;
  return Object.hasOwn(COMMANDS, `${module}.${command}`) ? COMMANDS[`${module}.${command}`] : undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: danh mục query không đồng nhất
type AnyQuery = QueryDef<any, any>;

/** Danh mục query công khai qua `GET /api/v1/<module>/<query>` — chỉ đọc. */
export const QUERIES: Readonly<Record<string, AnyQuery>> = {
  "payment.getTransferInfo": {
    query: "payment.getTransferInfo",
    input: z.strictObject({ invoice_id: uuid, receiving_account_id: uuid.optional() }),
    run: (db, actor, i: { invoice_id: string; receiving_account_id?: string }) =>
      getTransferInfo(db, actor, {
        invoiceId: i.invoice_id,
        ...(i.receiving_account_id ? { receivingAccountId: i.receiving_account_id } : {}),
      }),
  },
  "report.financialSummary": {
    query: "report.financialSummary",
    input: z.strictObject({ property_id: uuid, from: z.iso.date(), to: z.iso.date() }),
    run: (db, actor, i: { property_id: string; from: string; to: string }) =>
      financialSummary(db, actor, { propertyId: i.property_id, from: i.from, to: i.to }),
  },
  "reconciliation.previewMatches": {
    query: "reconciliation.previewMatches",
    input: z.strictObject({
      property_id: uuid,
      receiving_account_id: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
    run: (db, actor, i: { property_id: string; receiving_account_id?: string; limit?: number }) =>
      previewMatches(db, actor, {
        propertyId: i.property_id,
        ...(i.receiving_account_id ? { receivingAccountId: i.receiving_account_id } : {}),
        ...(i.limit === undefined ? {} : { limit: i.limit }),
      }),
  },
};

export function findQuery(module: string, query: string): AnyQuery | undefined {
  if (!/^[a-z][a-z_]*$/.test(module) || !/^[a-zA-Z][a-zA-Z]*$/.test(query)) return undefined;
  return Object.hasOwn(QUERIES, `${module}.${query}`) ? QUERIES[`${module}.${query}`] : undefined;
}
