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
import { activateLease, recordHandover, renewLease } from "../lease/handover.ts";
import {
  addOccupant,
  cancelLease,
  createDraft,
  getLease,
  getPerson,
  holdLease,
  removeOccupant,
  signLease,
  submitForSignature,
  updateDraft,
} from "../lease/lease.ts";
import { approveSettlement, closeLease, giveNotice, prepareSettlement } from "../lease/settlement.ts";
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
const leaseTerms = z.strictObject({
  effective_from: z.iso.date(),
  effective_to: z.iso.date().nullable(),
  rent_amount: money,
  deposit_amount: money,
  services: z
    .array(
      z.strictObject({
        service_id: uuid,
        quantity: z.number().int().min(0).max(1000),
        unit_price: money.optional(),
      }),
    )
    .max(30),
});
const toTerms = (t: z.infer<typeof leaseTerms>) => ({
  effectiveFrom: t.effective_from,
  effectiveTo: t.effective_to,
  rentAmount: t.rent_amount,
  depositAmount: t.deposit_amount,
  services: t.services.map((s) => ({
    serviceId: s.service_id,
    quantity: s.quantity,
    ...(s.unit_price === undefined ? {} : { unitPrice: s.unit_price }),
  })),
});
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
  "lease.createDraft": defineCommand({
    command: "lease.createDraft",
    input: z.strictObject({
      unit_id: uuid,
      representative_person_id: uuid,
      signed_on: isoDate.optional(),
      billing_start_on: isoDate,
      terms: leaseTerms,
      occupants: z
        .array(z.strictObject({ person_id: uuid, role: z.enum(["co_tenant", "occupant"]) }))
        .max(19)
        .optional(),
    }),
    run: async (ctx, i) => ({
      data: await createDraft(ctx, {
        unitId: i.unit_id,
        representativePersonId: i.representative_person_id,
        billingStartOn: i.billing_start_on,
        terms: toTerms(i.terms),
        ...(i.signed_on ? { signedOn: i.signed_on } : {}),
        ...(i.occupants
          ? { occupants: i.occupants.map((o) => ({ personId: o.person_id, role: o.role })) }
          : {}),
      }),
      httpStatus: 201,
    }),
  }),
  "lease.updateDraft": defineCommand({
    command: "lease.updateDraft",
    input: z.strictObject({
      lease_id: uuid,
      billing_start_on: isoDate.optional(),
      signed_on: isoDate.nullable().optional(),
      terms: leaseTerms,
    }),
    run: async (ctx, i) => ({
      data: await updateDraft(ctx, {
        leaseId: i.lease_id,
        terms: toTerms(i.terms),
        ...(i.billing_start_on ? { billingStartOn: i.billing_start_on } : {}),
        ...(i.signed_on === undefined ? {} : { signedOn: i.signed_on }),
      }),
    }),
  }),
  "lease.addOccupant": defineCommand({
    command: "lease.addOccupant",
    input: z.strictObject({
      lease_id: uuid,
      person_id: uuid,
      role: z.enum(["co_tenant", "occupant"]),
      from_on: isoDate,
    }),
    run: async (ctx, i) => ({
      data: await addOccupant(ctx, {
        leaseId: i.lease_id,
        personId: i.person_id,
        role: i.role,
        fromOn: i.from_on,
      }),
      httpStatus: 201,
    }),
  }),
  "lease.removeOccupant": defineCommand({
    command: "lease.removeOccupant",
    input: z.strictObject({ lease_id: uuid, person_id: uuid, to_on: isoDate }),
    run: async (ctx, i) => ({
      data: await removeOccupant(ctx, { leaseId: i.lease_id, personId: i.person_id, toOn: i.to_on }),
    }),
  }),
  "lease.submitForSignature": defineCommand({
    command: "lease.submitForSignature",
    input: z.strictObject({ lease_id: uuid }),
    run: async (ctx, i) => ({ data: await submitForSignature(ctx, { leaseId: i.lease_id }) }),
  }),
  "lease.hold": defineCommand({
    command: "lease.hold",
    input: z.strictObject({ lease_id: uuid }),
    run: async (ctx, i) => ({ data: await holdLease(ctx, { leaseId: i.lease_id }), httpStatus: 201 }),
  }),
  "lease.sign": defineCommand({
    command: "lease.sign",
    input: z.strictObject({ lease_id: uuid, signer_person_id: uuid, signed_on: isoDate.optional() }),
    run: async (ctx, i) => ({
      data: await signLease(ctx, {
        leaseId: i.lease_id,
        signerPersonId: i.signer_person_id,
        ...(i.signed_on ? { signedOn: i.signed_on } : {}),
      }),
    }),
  }),
  "lease.cancel": defineCommand({
    command: "lease.cancel",
    input: z.strictObject({ lease_id: uuid, reason: z.string().trim().min(1).max(1000) }),
    run: async (ctx, i) => ({ data: await cancelLease(ctx, { leaseId: i.lease_id, reason: i.reason }) }),
  }),
  "lease.recordHandover": defineCommand({
    command: "lease.recordHandover",
    input: z.strictObject({
      lease_id: uuid,
      kind: z.enum(["move_in", "move_out"]),
      handed_over_on: isoDate,
      readings: z.strictObject({
        electric: z.number().nonnegative().optional(),
        water: z.number().nonnegative().optional(),
      }),
      assets: z
        .array(
          z.strictObject({
            name: z.string().max(100),
            quantity: z.number().int(),
            condition: z.string().max(200),
            file_ids: z.array(uuid).max(20).optional(),
          }),
        )
        .max(50),
      keys_count: z.number().int().min(0).max(100),
      photo_file_ids: z.array(uuid).max(20),
      note: z.string().max(2000).optional(),
      tenant_confirmation: z.strictObject({ method: z.enum(["in_person", "portal"]) }).optional(),
    }),
    run: async (ctx, i) => ({
      data: await recordHandover(ctx, {
        leaseId: i.lease_id,
        kind: i.kind,
        handedOverOn: i.handed_over_on,
        readings: Object.fromEntries(Object.entries(i.readings).filter(([, v]) => v !== undefined)),
        assets: i.assets.map((a) => ({
          name: a.name,
          quantity: a.quantity,
          condition: a.condition,
          ...(a.file_ids ? { fileIds: a.file_ids } : {}),
        })),
        keysCount: i.keys_count,
        photoFileIds: i.photo_file_ids,
        ...(i.note === undefined ? {} : { note: i.note }),
        ...(i.tenant_confirmation ? { tenantConfirmation: i.tenant_confirmation } : {}),
      }),
      httpStatus: 201,
    }),
  }),
  "lease.activate": defineCommand({
    command: "lease.activate",
    input: z.strictObject({ lease_id: uuid }),
    run: async (ctx, i) => ({ data: await activateLease(ctx, { leaseId: i.lease_id }) }),
  }),
  "lease.renew": defineCommand({
    command: "lease.renew",
    input: z.strictObject({ lease_id: uuid, terms: leaseTerms }),
    run: async (ctx, i) => ({
      data: await renewLease(ctx, { leaseId: i.lease_id, terms: toTerms(i.terms) }),
      httpStatus: 201,
    }),
  }),
  "lease.giveNotice": defineCommand({
    command: "lease.giveNotice",
    input: z.strictObject({ lease_id: uuid, planned_move_out_on: isoDate }),
    run: async (ctx, i) => ({
      data: await giveNotice(ctx, { leaseId: i.lease_id, plannedMoveOutOn: i.planned_move_out_on }),
    }),
  }),
  "lease.prepareSettlement": defineCommand({
    command: "lease.prepareSettlement",
    input: z.strictObject({
      lease_id: uuid,
      fees: z
        .array(
          z.strictObject({
            amount: positiveMoney,
            reason: z.string().max(500),
            file_ids: z.array(uuid).max(20).optional(),
          }),
        )
        .max(20),
      deductions: z
        .array(
          z.strictObject({
            invoice_id: uuid.nullable().optional(),
            amount: positiveMoney,
            reason: z.string().max(500),
          }),
        )
        .max(50)
        .optional(),
    }),
    run: async (ctx, i) => ({
      data: await prepareSettlement(ctx, {
        leaseId: i.lease_id,
        fees: i.fees.map((f) => ({
          amount: f.amount,
          reason: f.reason,
          ...(f.file_ids ? { fileIds: f.file_ids } : {}),
        })),
        ...(i.deductions
          ? {
              deductions: i.deductions.map((d) => ({
                invoiceId: d.invoice_id ?? null,
                amount: d.amount,
                reason: d.reason,
              })),
            }
          : {}),
      }),
    }),
  }),
  "lease.approveSettlement": defineCommand({
    command: "lease.approveSettlement",
    input: z.strictObject({
      settlement_id: uuid,
      refund_method: z.enum(["cash", "bank_transfer"]).optional(),
      receiving_account_id: uuid.optional(),
    }),
    run: async (ctx, i) => ({
      data: await approveSettlement(ctx, {
        settlementId: i.settlement_id,
        ...(i.refund_method === "cash"
          ? { refund: { method: "cash" as const } }
          : i.refund_method === "bank_transfer"
            ? {
                refund: {
                  method: "bank_transfer" as const,
                  receivingAccountId: i.receiving_account_id ?? "",
                },
              }
            : {}),
      }),
    }),
  }),
  "lease.close": defineCommand({
    command: "lease.close",
    input: z.strictObject({ lease_id: uuid }),
    run: async (ctx, i) => ({ data: await closeLease(ctx, { leaseId: i.lease_id }) }),
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
  "lease.get": {
    query: "lease.get",
    input: z.strictObject({ lease_id: uuid }),
    run: (db, actor, i: { lease_id: string }) => getLease(db, actor, i.lease_id),
  },
  "person.get": {
    query: "person.get",
    input: z.strictObject({ person_id: z.string().max(64) }),
    run: (db, actor, i: { person_id: string }) => getPerson(db, actor, i.person_id),
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
