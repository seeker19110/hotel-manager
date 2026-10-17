// Danh mục command công khai qua `POST /api/v1/<module>/<command>` (API-CONTRACT §1). Thêm command = thêm một mục ở đây
// (schema Zod là hợp đồng đầu vào). Tên mục = tên command trong SPEC §5.

import type { StatementMapping } from "@hm/domain";
import { mibToBytes } from "@hm/domain";
import { z } from "zod";
import { resetMemberMfa } from "../access/index.ts";
import { APPROVAL_KINDS, cancelApproval, decideApproval, requestApproval } from "../approvals/index.ts";
import { getEvent, listEvents } from "../audit/index.ts";
import {
  createPeriod,
  issuePeriod,
  lockBillingPeriod,
  previewPeriod,
  reopenPeriod,
  returnToDraft,
  submitForReview,
} from "../billing/index.ts";
import {
  receiveDeposit,
  requestCreditRefund,
  requestDeduction,
  requestDepositRefund,
} from "../deposits/index.ts";
import {
  downloadExport,
  EXPORT_KINDS,
  getExportStatus,
  listMyExports,
  requestExport,
  requestOrgExport,
} from "../exports/index.ts";
import {
  assignTask,
  cancelTask,
  claimTask,
  completeTask,
  createTask,
  getTask,
  listTasks,
  startTask,
  verifyTask,
} from "../housekeeping/index.ts";
import { getIdentityDocument } from "../identity/index.ts";
import {
  cancelBatch,
  commitBatch,
  confirmBatch,
  downloadErrorReport,
  getBatch,
  getTemplate,
  setExpectedTotals,
  validateBatch,
} from "../import/index.ts";
import {
  approveBlock,
  archiveUnit,
  createUnit,
  endBlock,
  getCalendar,
  getUnitStatus,
  searchAvailability,
  setUnitAvailability,
} from "../inventory/index.ts";
import {
  activateLease,
  addOccupant,
  approveSettlement,
  cancelLease,
  closeLease,
  createDraft,
  getLease,
  getPerson,
  giveNotice,
  holdLease,
  prepareSettlement,
  recordHandover,
  removeOccupant,
  renewLease,
  signLease,
  submitForSignature,
  updateDraft,
} from "../lease/index.ts";
import { financialSummary, issueAdjustment, lockPeriod, unlockPeriod } from "../ledger/index.ts";
import {
  assignWorkOrder,
  cancelWorkOrder,
  completeWorkOrder,
  createWorkOrder,
  listMyWorkOrders,
  listWorkOrders,
  proposeWorkOrderBlock,
  startWorkOrder,
  verifyWorkOrder,
} from "../maintenance/index.ts";
import {
  acknowledgeAnomaly,
  installMeter,
  readingRoute,
  recordReading,
  replaceMeter,
  setServicePrice,
} from "../metering/index.ts";
import {
  getPreferences,
  listDeliveries,
  listMyNotifications,
  markAllRead,
  markRead,
  retryDelivery,
  updatePreference,
  updateSettings,
} from "../notifications/index.ts";
import {
  allocatePayment,
  collectCash,
  confirmPayment,
  recordPayment,
  reversePayment,
} from "../payments/index.ts";
import {
  createGuestLink,
  createRequest,
  getMyInvoice,
  getMyLease,
  getPaymentInstructions,
  inviteTenant,
  listMyInvoices,
  listMyMeterReadings,
  listMyRequests,
  listPaymentClaims,
  revokeGuestLink,
  revokeTenantAccess,
  submitPaymentClaim,
} from "../portal/index.ts";
import {
  confirmMatch,
  getTransferInfo,
  importStatement,
  previewMatches,
  resolveBreak,
} from "../reconciliation/index.ts";
import { collections, depositsHeld, occupancy, receivables } from "../reports/index.ts";
import {
  closeShift,
  handoverShift,
  openShift,
  reassignDiscrepancy,
  receiveHandover,
} from "../shifts/index.ts";
import {
  cancelReservation,
  changeDates,
  checkIn,
  checkOut,
  confirmReservation,
  createReservation,
  createRoomType,
  exportResidenceNotice,
  type GuestInput,
  getFolio,
  getReservation,
  holdReservation,
  listNotices,
  listReservations,
  markNoShow,
  markNoticeSubmitted,
  postCharge,
  prepareResidenceNotice,
  quote,
  setRate,
  updateRoomType,
  voidCharge,
  walkIn,
} from "../stay/index.ts";
import { getSummary, listItems, TODAY_CARDS } from "../today/index.ts";
import {
  bankTxn,
  COMMAND_INPUTS,
  type guest,
  isoDate,
  money,
  positiveMoney,
  uuid,
} from "./command-inputs.ts";
import type { CommandDef, QueryDef } from "./command-route.ts";

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
const toGuest = (g: z.infer<typeof guest>): GuestInput => ({
  docType: g.doc_type,
  docNumber: g.doc_number,
  ...(g.person_id ? { personId: g.person_id } : {}),
  ...(g.full_name ? { fullName: g.full_name } : {}),
  ...(g.phone ? { phone: g.phone } : {}),
  ...(g.email ? { email: g.email } : {}),
  ...(g.nationality ? { nationality: g.nationality } : {}),
});
const column = z.union([z.string().trim().min(1).max(100), z.number().int().min(0).max(200)]);
const toBankTxn = (b: z.infer<typeof bankTxn>) => ({
  ref: b.ref,
  occurredAt: b.occurred_at,
  ...(b.description ? { description: b.description } : {}),
});

/** Kiểu rộng cho danh mục (mỗi mục giữ schema riêng). */
// biome-ignore lint/suspicious/noExplicitAny: danh mục không đồng nhất; mỗi mục tự gõ kiểu qua defineCommand
type AnyCommand = CommandDef<any, any, any>;

function defineCommand<I, O, P = undefined>(def: CommandDef<I, O, P>): CommandDef<I, O, P> {
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
  "room_type.create": defineCommand({
    command: "room_type.create",
    input: z.strictObject({
      property_id: uuid,
      code: z.string().trim().min(1).max(20),
      name: z.string().trim().min(1).max(100),
      capacity: z.number().int().min(1).max(50),
    }),
    run: async (ctx, i) => ({
      data: await createRoomType(ctx, {
        propertyId: i.property_id,
        code: i.code,
        name: i.name,
        capacity: i.capacity,
      }),
      httpStatus: 201,
    }),
  }),
  "room_type.update": defineCommand({
    command: "room_type.update",
    input: z.strictObject({
      room_type_id: uuid,
      name: z.string().trim().min(1).max(100).optional(),
      capacity: z.number().int().min(1).max(50).optional(),
    }),
    run: async (ctx, i) => ({
      data: await updateRoomType(ctx, {
        roomTypeId: i.room_type_id,
        ...(i.name === undefined ? {} : { name: i.name }),
        ...(i.capacity === undefined ? {} : { capacity: i.capacity }),
      }),
    }),
  }),
  "rate.set": defineCommand({
    command: "rate.set",
    input: z.strictObject({
      room_type_id: uuid,
      weekday_price: positiveMoney,
      weekend_price: positiveMoney,
      effective_from: isoDate.optional(),
    }),
    run: async (ctx, i) => ({
      data: await setRate(ctx, {
        roomTypeId: i.room_type_id,
        weekdayPrice: i.weekday_price,
        weekendPrice: i.weekend_price,
        ...(i.effective_from ? { effectiveFrom: i.effective_from } : {}),
      }),
    }),
  }),
  "reservation.create": defineCommand({
    command: "reservation.create",
    input: COMMAND_INPUTS["reservation.create"],
    run: async (ctx, i) => ({
      data: await createReservation(ctx, {
        unitId: i.unit_id,
        arrivalDate: i.arrival_date,
        departureDate: i.departure_date,
        guests: i.guests,
        source: i.source,
        booker:
          "person_id" in i.booker
            ? { personId: i.booker.person_id }
            : {
                fullName: i.booker.full_name,
                phone: i.booker.phone,
                ...(i.booker.email ? { email: i.booker.email } : {}),
              },
      }),
      httpStatus: 201,
    }),
  }),
  "reservation.hold": defineCommand({
    command: "reservation.hold",
    input: COMMAND_INPUTS["reservation.hold"],
    run: async (ctx, i) => ({ data: await holdReservation(ctx, { reservationId: i.reservation_id }) }),
  }),
  "reservation.confirm": defineCommand({
    command: "reservation.confirm",
    input: COMMAND_INPUTS["reservation.confirm"],
    run: async (ctx, i) => ({
      data: await confirmReservation(ctx, {
        reservationId: i.reservation_id,
        ...(i.payment
          ? {
              payment: {
                amount: i.payment.amount,
                method: i.payment.method,
                kind: i.payment.kind,
                ...(i.payment.receiving_account_id
                  ? { receivingAccountId: i.payment.receiving_account_id }
                  : {}),
                ...(i.payment.bank_txn ? { bankTxn: toBankTxn(i.payment.bank_txn) } : {}),
              },
            }
          : {}),
      }),
    }),
  }),
  "reservation.cancel": defineCommand({
    command: "reservation.cancel",
    input: COMMAND_INPUTS["reservation.cancel"],
    run: async (ctx, i) => ({
      data: await cancelReservation(ctx, {
        reservationId: i.reservation_id,
        reason: i.reason,
        ...(i.cancellation_fee === undefined ? {} : { cancellationFee: i.cancellation_fee }),
      }),
    }),
  }),
  "reservation.changeDates": defineCommand({
    command: "reservation.changeDates",
    input: z.strictObject({
      reservation_id: uuid,
      arrival_date: isoDate,
      departure_date: isoDate,
      preview_only: z.boolean().default(false),
    }),
    run: async (ctx, i) => ({
      data: await changeDates(ctx, {
        reservationId: i.reservation_id,
        arrivalDate: i.arrival_date,
        departureDate: i.departure_date,
        previewOnly: i.preview_only,
      }),
    }),
  }),
  "stay.checkIn": defineCommand({
    command: "stay.checkIn",
    input: COMMAND_INPUTS["stay.checkIn"],
    run: async (ctx, i, svc) => ({
      data: await checkIn(ctx, svc.pii, { reservationId: i.reservation_id, guests: i.guests.map(toGuest) }),
    }),
  }),
  "stay.walkIn": defineCommand({
    command: "stay.walkIn",
    input: COMMAND_INPUTS["stay.walkIn"],
    run: async (ctx, i, svc) => ({
      data: await walkIn(ctx, svc.pii, {
        unitId: i.unit_id,
        departureDate: i.departure_date,
        guests: i.guests.map(toGuest),
      }),
      httpStatus: 201,
    }),
  }),
  "stay.postCharge": defineCommand({
    command: "stay.postCharge",
    input: COMMAND_INPUTS["stay.postCharge"],
    run: async (ctx, i) => ({
      data: await postCharge(ctx, {
        stayId: i.stay_id,
        kind: i.kind,
        description: i.description,
        quantity: i.quantity,
        unitPrice: i.unit_price,
      }),
      httpStatus: 201,
    }),
  }),
  "stay.voidCharge": defineCommand({
    command: "stay.voidCharge",
    input: COMMAND_INPUTS["stay.voidCharge"],
    run: async (ctx, i) => ({ data: await voidCharge(ctx, { chargeId: i.charge_id, reason: i.reason }) }),
  }),
  "stay.checkOut": defineCommand({
    command: "stay.checkOut",
    input: COMMAND_INPUTS["stay.checkOut"],
    run: async (ctx, i) => ({
      data: await checkOut(ctx, {
        stayId: i.stay_id,
        ...(i.payments
          ? {
              payments: i.payments.map((p) => ({
                method: p.method,
                amount: p.amount,
                ...(p.receiving_account_id ? { receivingAccountId: p.receiving_account_id } : {}),
                ...(p.bank_txn ? { bankTxn: toBankTxn(p.bank_txn) } : {}),
              })),
            }
          : {}),
        ...(i.allow_balance
          ? {
              allowBalance: {
                debtorPersonId: i.allow_balance.debtor_person_id,
                dueDate: i.allow_balance.due_date,
                ...(i.allow_balance.approval_request_id
                  ? { approvalRequestId: i.allow_balance.approval_request_id }
                  : {}),
              },
            }
          : {}),
        ...(i.deposit_refund
          ? {
              depositRefund: {
                amount: i.deposit_refund.amount,
                method: i.deposit_refund.method,
                ...(i.deposit_refund.receiving_account_id
                  ? { receivingAccountId: i.deposit_refund.receiving_account_id }
                  : {}),
              },
            }
          : {}),
        ...(i.deposit_deduction ? { depositDeduction: i.deposit_deduction } : {}),
      }),
    }),
  }),
  "stay.exportResidenceNotice": defineCommand({
    command: "stay.exportResidenceNotice",
    input: z.strictObject({ stay_id: uuid }),
    // Dựng file + ghi object NGOÀI transaction lệnh (T-303); lệnh chỉ chốt dòng `files` và cập nhật thông báo.
    prepare: (db, actor, i, svc, meta) =>
      prepareResidenceNotice(db, svc, actor, { stayId: i.stay_id }, meta.idempotencyKey),
    run: async (ctx, i, svc, prepared) => ({
      data: await exportResidenceNotice(ctx, svc, { stayId: i.stay_id, prepared }),
    }),
  }),
  "stay.markNoticeSubmitted": defineCommand({
    command: "stay.markNoticeSubmitted",
    input: COMMAND_INPUTS["stay.markNoticeSubmitted"],
    run: async (ctx, i) => ({
      data: await markNoticeSubmitted(ctx, {
        noticeId: i.notice_id,
        submittedAt: new Date(i.submitted_at),
        channel: i.channel,
        ...(i.evidence_file_id ? { evidenceFileId: i.evidence_file_id } : {}),
      }),
    }),
  }),
  "housekeeping.createTask": defineCommand({
    command: "housekeeping.createTask",
    input: COMMAND_INPUTS["housekeeping.createTask"],
    run: async (ctx, i) => ({
      data: await createTask(ctx, {
        unitId: i.unit_id,
        kind: i.kind,
        ...(i.priority ? { priority: i.priority } : {}),
        ...(i.note ? { note: i.note } : {}),
      }),
      httpStatus: 201,
    }),
  }),
  "housekeeping.assignTask": defineCommand({
    command: "housekeeping.assignTask",
    input: z.strictObject({ task_id: uuid, assignee_membership_id: uuid }),
    run: async (ctx, i) => ({
      data: await assignTask(ctx, { taskId: i.task_id, assigneeMembershipId: i.assignee_membership_id }),
    }),
  }),
  "housekeeping.claimTask": defineCommand({
    command: "housekeeping.claimTask",
    input: COMMAND_INPUTS["housekeeping.claimTask"],
    run: async (ctx, i) => ({ data: await claimTask(ctx, { taskId: i.task_id }) }),
  }),
  "housekeeping.startTask": defineCommand({
    command: "housekeeping.startTask",
    input: COMMAND_INPUTS["housekeeping.startTask"],
    run: async (ctx, i) => ({ data: await startTask(ctx, { taskId: i.task_id }) }),
  }),
  "housekeeping.completeTask": defineCommand({
    command: "housekeeping.completeTask",
    input: COMMAND_INPUTS["housekeeping.completeTask"],
    run: async (ctx, i) => ({
      data: await completeTask(ctx, { taskId: i.task_id, ...(i.note ? { note: i.note } : {}) }),
    }),
  }),
  "housekeeping.verifyTask": defineCommand({
    command: "housekeeping.verifyTask",
    input: COMMAND_INPUTS["housekeeping.verifyTask"],
    run: async (ctx, i) => ({
      data: await verifyTask(ctx, {
        taskId: i.task_id,
        result: i.result,
        ...(i.reason ? { reason: i.reason } : {}),
      }),
    }),
  }),
  "housekeeping.cancelTask": defineCommand({
    command: "housekeeping.cancelTask",
    input: COMMAND_INPUTS["housekeeping.cancelTask"],
    run: async (ctx, i) => ({ data: await cancelTask(ctx, { taskId: i.task_id, reason: i.reason }) }),
  }),
  "maintenance.createWorkOrder": defineCommand({
    command: "maintenance.createWorkOrder",
    input: COMMAND_INPUTS["maintenance.createWorkOrder"],
    run: async (ctx, i) => ({
      data: await createWorkOrder(ctx, {
        unitId: i.unit_id,
        title: i.title,
        description: i.description,
        severity: i.severity,
        fileIds: i.file_ids,
      }),
      httpStatus: 201,
    }),
  }),
  "maintenance.assignWorkOrder": defineCommand({
    command: "maintenance.assignWorkOrder",
    input: COMMAND_INPUTS["maintenance.assignWorkOrder"],
    run: async (ctx, i) => ({
      data: await assignWorkOrder(ctx, {
        workOrderId: i.work_order_id,
        assigneeMembershipId: i.assignee_membership_id,
      }),
    }),
  }),
  "maintenance.startWorkOrder": defineCommand({
    command: "maintenance.startWorkOrder",
    input: COMMAND_INPUTS["maintenance.startWorkOrder"],
    run: async (ctx, i) => ({ data: await startWorkOrder(ctx, { workOrderId: i.work_order_id }) }),
  }),
  "maintenance.completeWorkOrder": defineCommand({
    command: "maintenance.completeWorkOrder",
    input: COMMAND_INPUTS["maintenance.completeWorkOrder"],
    run: async (ctx, i) => ({
      data: await completeWorkOrder(ctx, {
        workOrderId: i.work_order_id,
        fileIds: i.file_ids,
        ...(i.note ? { note: i.note } : {}),
      }),
    }),
  }),
  "maintenance.verifyWorkOrder": defineCommand({
    command: "maintenance.verifyWorkOrder",
    input: COMMAND_INPUTS["maintenance.verifyWorkOrder"],
    run: async (ctx, i) => ({ data: await verifyWorkOrder(ctx, { workOrderId: i.work_order_id }) }),
  }),
  "portal.createRequest": defineCommand({
    command: "portal.createRequest",
    input: COMMAND_INPUTS["portal.createRequest"],
    run: async (ctx, i) => ({
      data: await createRequest(ctx, {
        unitId: i.unit_id,
        title: i.title,
        description: i.description,
        ...(i.severity ? { severity: i.severity } : {}),
        ...(i.file_ids ? { fileIds: i.file_ids } : {}),
      }),
      httpStatus: 201,
    }),
  }),
  "portal.submitPaymentClaim": defineCommand({
    command: "portal.submitPaymentClaim",
    input: COMMAND_INPUTS["portal.submitPaymentClaim"],
    run: async (ctx, i) => ({
      data: await submitPaymentClaim(ctx, {
        invoiceId: i.invoice_id,
        amount: i.amount,
        ...(i.reference_code ? { referenceCode: i.reference_code } : {}),
        ...(i.proof_file_id ? { proofFileId: i.proof_file_id } : {}),
      }),
      httpStatus: 201,
    }),
  }),
  "exports.request": defineCommand({
    command: "exports.request",
    input: z.strictObject({
      kind: z.enum(EXPORT_KINDS),
      format: z.enum(["csv", "xlsx"]),
      property_id: z.string().max(64).optional(),
      filters: z
        .strictObject({
          as_of: isoDate.optional(),
          from: isoDate.optional(),
          to: isoDate.optional(),
          correlation_id: z.string().min(1).max(200).optional(),
        })
        .optional(),
    }),
    run: async (ctx, i) => ({
      data: await requestExport(ctx, {
        kind: i.kind,
        format: i.format,
        ...(i.property_id ? { propertyId: i.property_id } : {}),
        filters: {
          ...(i.filters?.as_of ? { asOf: i.filters.as_of } : {}),
          ...(i.filters?.from ? { from: i.filters.from } : {}),
          ...(i.filters?.to ? { to: i.filters.to } : {}),
          ...(i.filters?.correlation_id ? { correlationId: i.filters.correlation_id } : {}),
        },
      }),
      httpStatus: 202,
    }),
  }),
  "exports.requestOrgExport": defineCommand({
    command: "exports.requestOrgExport",
    input: z.strictObject({}),
    run: async (ctx) => ({ data: await requestOrgExport(ctx), httpStatus: 202 }),
  }),
  "exports.download": defineCommand({
    command: "exports.download",
    input: z.strictObject({ export_id: z.string().max(64) }),
    run: async (ctx, i, svc) => ({ data: await downloadExport(ctx, svc, { exportId: i.export_id }) }),
  }),
  "portal.createGuestLink": defineCommand({
    command: "portal.createGuestLink",
    input: z.strictObject({ stay_id: uuid }),
    run: async (ctx, i) => ({ data: await createGuestLink(ctx, { stayId: i.stay_id }), httpStatus: 201 }),
  }),
  "portal.revokeGuestLink": defineCommand({
    command: "portal.revokeGuestLink",
    input: z.strictObject({ link_id: uuid }),
    run: async (ctx, i) => ({ data: await revokeGuestLink(ctx, { linkId: i.link_id }) }),
  }),
  "portal.inviteTenant": defineCommand({
    command: "portal.inviteTenant",
    input: z.strictObject({ person_id: uuid, email: z.string().trim().min(3).max(320) }),
    run: async (ctx, i) => ({ data: await inviteTenant(ctx, { personId: i.person_id, email: i.email }) }),
  }),
  "portal.revokeTenantAccess": defineCommand({
    command: "portal.revokeTenantAccess",
    input: z.strictObject({ membership_id: uuid, reason: z.string().trim().max(500).optional() }),
    run: async (ctx, i) => ({
      data: await revokeTenantAccess(ctx, {
        membershipId: i.membership_id,
        ...(i.reason ? { reason: i.reason } : {}),
      }),
    }),
  }),
  "notifications.markRead": defineCommand({
    command: "notifications.markRead",
    input: COMMAND_INPUTS["notifications.markRead"],
    run: async (ctx, i) => ({ data: await markRead(ctx, { notificationId: i.notification_id }) }),
  }),
  "notifications.markAllRead": defineCommand({
    command: "notifications.markAllRead",
    input: COMMAND_INPUTS["notifications.markAllRead"],
    run: async (ctx) => ({ data: await markAllRead(ctx) }),
  }),
  "notifications.updatePreferences": defineCommand({
    command: "notifications.updatePreferences",
    input: z.strictObject({
      type: z.string().max(40),
      channel: z.literal("email"),
      state: z.enum(["opted_in", "opted_out"]),
    }),
    run: async (ctx, i) => ({ data: await updatePreference(ctx, { type: i.type, state: i.state }) }),
  }),
  "notifications.retryDelivery": defineCommand({
    command: "notifications.retryDelivery",
    input: z.strictObject({ delivery_id: uuid }),
    run: async (ctx, i) => ({ data: await retryDelivery(ctx, { deliveryId: i.delivery_id }) }),
  }),
  "notifications.updateSettings": defineCommand({
    command: "notifications.updateSettings",
    input: z.strictObject({
      property_id: uuid,
      overdue_reminder_offsets_days: z.array(z.number().int()).max(10).optional(),
      lease_expiry_offsets_days: z.array(z.number().int()).max(10).optional(),
      stay_notice_deadline: z
        .strictObject({
          domestic_cutoff: z.string().max(5).optional(),
          domestic_next_day_before: z.string().max(5).optional(),
          foreign_hours: z.number().int().optional(),
        })
        .nullable()
        .optional(),
      send_window_start: z.string().max(5).optional(),
      send_window_end: z.string().max(5).optional(),
    }),
    run: async (ctx, i) => ({
      data: await updateSettings(ctx, {
        propertyId: i.property_id,
        ...(i.overdue_reminder_offsets_days
          ? { overdueReminderOffsetsDays: i.overdue_reminder_offsets_days }
          : {}),
        ...(i.lease_expiry_offsets_days ? { leaseExpiryOffsetsDays: i.lease_expiry_offsets_days } : {}),
        ...(i.stay_notice_deadline !== undefined
          ? {
              stayNoticeDeadline:
                i.stay_notice_deadline === null
                  ? null
                  : Object.fromEntries(
                      Object.entries(i.stay_notice_deadline).filter(([, v]) => v !== undefined),
                    ),
            }
          : {}),
        ...(i.send_window_start ? { sendWindowStart: i.send_window_start } : {}),
        ...(i.send_window_end ? { sendWindowEnd: i.send_window_end } : {}),
      }),
    }),
  }),
  "maintenance.cancelWorkOrder": defineCommand({
    command: "maintenance.cancelWorkOrder",
    input: COMMAND_INPUTS["maintenance.cancelWorkOrder"],
    run: async (ctx, i) => ({
      data: await cancelWorkOrder(ctx, { workOrderId: i.work_order_id, reason: i.reason }),
    }),
  }),
  "maintenance.proposeBlock": defineCommand({
    command: "maintenance.proposeBlock",
    input: z.strictObject({
      work_order_id: uuid,
      start: z.iso.datetime({ offset: true }),
      end: z.iso.datetime({ offset: true }),
      reason: z.string().trim().min(1).max(1000),
    }),
    run: async (ctx, i) => ({
      data: await proposeWorkOrderBlock(ctx, {
        workOrderId: i.work_order_id,
        start: new Date(i.start),
        end: new Date(i.end),
        reason: i.reason,
      }),
      httpStatus: 201,
    }),
  }),
  "inventory.approveBlock": defineCommand({
    command: "inventory.approveBlock",
    input: z.strictObject({ block_id: uuid }),
    run: async (ctx, i) => {
      await approveBlock(ctx, i.block_id);
      return { data: { blockId: i.block_id, status: "approved" } };
    },
  }),
  "unit.create": defineCommand({
    command: "unit.create",
    input: COMMAND_INPUTS["unit.create"],
    run: async (ctx, i) => ({
      data: await createUnit(ctx, {
        propertyId: i.property_id,
        floorName: i.floor,
        code: i.code,
        capacity: i.capacity,
        ...(i.kind === undefined ? {} : { kind: i.kind }),
        ...(i.parent_unit_id === undefined ? {} : { parentUnitId: i.parent_unit_id }),
      }),
      httpStatus: 201,
    }),
  }),
  "unit.archive": defineCommand({
    command: "unit.archive",
    input: COMMAND_INPUTS["unit.archive"],
    run: async (ctx, i) => ({
      data: { unitId: i.unit_id, ...(await archiveUnit(ctx, { unitId: i.unit_id })) },
    }),
  }),
  "inventory.endBlock": defineCommand({
    command: "inventory.endBlock",
    input: z.strictObject({ block_id: uuid }),
    run: async (ctx, i) => ({ data: await endBlock(ctx, i.block_id) }),
  }),
  "inventory.setUnitAvailability": defineCommand({
    command: "inventory.setUnitAvailability",
    input: COMMAND_INPUTS["inventory.setUnitAvailability"],
    run: async (ctx, i) => ({
      data: await setUnitAvailability(ctx, {
        unitId: i.unit_id,
        availability: i.availability,
        ...(i.reason !== undefined ? { reason: i.reason } : {}),
      }),
    }),
  }),
  "reservation.markNoShow": defineCommand({
    command: "reservation.markNoShow",
    input: COMMAND_INPUTS["reservation.markNoShow"],
    run: async (ctx, i) => ({
      data: await markNoShow(ctx, { reservationId: i.reservation_id, reason: i.reason }),
    }),
  }),
  "shift.open": defineCommand({
    command: "shift.open",
    input: COMMAND_INPUTS["shift.open"],
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
    input: COMMAND_INPUTS["payment.confirm"],
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
  "payment.collectCash": defineCommand({
    command: "payment.collectCash",
    input: COMMAND_INPUTS["payment.collectCash"],
    run: async (ctx, i) => ({
      data: await collectCash(ctx, { invoiceId: i.invoice_id, amount: i.amount }),
      httpStatus: 201,
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
    input: COMMAND_INPUTS["deposit.receive"],
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
      csv: z.string().min(1).max(mibToBytes(4)),
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
    input: COMMAND_INPUTS["reconciliation.resolveBreak"],
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
    input: COMMAND_INPUTS["lease.submitForSignature"],
    run: async (ctx, i) => ({ data: await submitForSignature(ctx, { leaseId: i.lease_id }) }),
  }),
  "lease.hold": defineCommand({
    command: "lease.hold",
    input: z.strictObject({ lease_id: uuid }),
    run: async (ctx, i) => ({ data: await holdLease(ctx, { leaseId: i.lease_id }), httpStatus: 201 }),
  }),
  "lease.sign": defineCommand({
    command: "lease.sign",
    input: COMMAND_INPUTS["lease.sign"],
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
    input: COMMAND_INPUTS["lease.recordHandover"],
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
    input: COMMAND_INPUTS["lease.activate"],
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
    input: COMMAND_INPUTS["lease.giveNotice"],
    run: async (ctx, i) => ({
      data: await giveNotice(ctx, { leaseId: i.lease_id, plannedMoveOutOn: i.planned_move_out_on }),
    }),
  }),
  "lease.prepareSettlement": defineCommand({
    command: "lease.prepareSettlement",
    input: COMMAND_INPUTS["lease.prepareSettlement"],
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
  "service.setPrice": defineCommand({
    command: "service.setPrice",
    input: z.strictObject({
      service_id: uuid,
      unit_price: z.number().nonnegative(),
      effective_from: isoDate,
      effective_to: isoDate.nullable().optional(),
      basis_note: z.string().max(500).optional(),
    }),
    run: async (ctx, i) => ({
      data: await setServicePrice(ctx, {
        serviceId: i.service_id,
        unitPrice: i.unit_price,
        effectiveFrom: i.effective_from,
        ...(i.effective_to === undefined ? {} : { effectiveTo: i.effective_to }),
        ...(i.basis_note === undefined ? {} : { basisNote: i.basis_note }),
      }),
      httpStatus: 201,
    }),
  }),
  "meter.install": defineCommand({
    command: "meter.install",
    input: z.strictObject({
      unit_id: uuid,
      kind: z.enum(["electric", "water"]),
      installed_on: isoDate,
      initial_value: z.number().nonnegative(),
      serial: z.string().trim().min(1).max(60).optional(),
    }),
    run: async (ctx, i) => ({
      data: await installMeter(ctx, {
        unitId: i.unit_id,
        kind: i.kind,
        installedOn: i.installed_on,
        initialValue: i.initial_value,
        ...(i.serial ? { serial: i.serial } : {}),
      }),
      httpStatus: 201,
    }),
  }),
  "meter.recordReading": defineCommand({
    command: "meter.recordReading",
    input: COMMAND_INPUTS["meter.recordReading"],
    run: async (ctx, i) => ({
      data: await recordReading(ctx, {
        meterId: i.meter_id,
        billingPeriodId: i.billing_period_id,
        value: i.value,
        ...(i.read_on ? { readOn: i.read_on } : {}),
        ...(i.photo_file_id ? { photoFileId: i.photo_file_id } : {}),
        ...(i.base_version === undefined ? {} : { baseVersion: i.base_version }),
      }),
    }),
  }),
  "meter.replace": defineCommand({
    command: "meter.replace",
    input: z.strictObject({
      meter_id: uuid,
      occurred_on: isoDate,
      old_final_value: z.number().nonnegative(),
      new_initial_value: z.number().nonnegative(),
      new_serial: z.string().trim().min(1).max(60).optional(),
      old_photo_file_id: uuid.optional(),
      new_photo_file_id: uuid.optional(),
    }),
    run: async (ctx, i) => ({
      data: await replaceMeter(ctx, {
        meterId: i.meter_id,
        occurredOn: i.occurred_on,
        oldFinalValue: i.old_final_value,
        newInitialValue: i.new_initial_value,
        ...(i.new_serial ? { newSerial: i.new_serial } : {}),
        ...(i.old_photo_file_id ? { oldPhotoFileId: i.old_photo_file_id } : {}),
        ...(i.new_photo_file_id ? { newPhotoFileId: i.new_photo_file_id } : {}),
      }),
      httpStatus: 201,
    }),
  }),
  "billing.createPeriod": defineCommand({
    command: "billing.createPeriod",
    input: COMMAND_INPUTS["billing.createPeriod"],
    run: async (ctx, i) => {
      const r = await createPeriod(ctx, { propertyId: i.property_id, month: i.month });
      return { data: r, httpStatus: r.created ? 201 : 200 };
    },
  }),
  "billing.submitForReview": defineCommand({
    command: "billing.submitForReview",
    input: COMMAND_INPUTS["billing.submitForReview"],
    run: async (ctx, i) => ({ data: await submitForReview(ctx, { billingPeriodId: i.billing_period_id }) }),
  }),
  "billing.returnToDraft": defineCommand({
    command: "billing.returnToDraft",
    input: COMMAND_INPUTS["billing.returnToDraft"],
    run: async (ctx, i) => ({
      data: await returnToDraft(ctx, { billingPeriodId: i.billing_period_id, reason: i.reason }),
    }),
  }),
  "billing.issuePeriod": defineCommand({
    command: "billing.issuePeriod",
    input: COMMAND_INPUTS["billing.issuePeriod"],
    run: async (ctx, i) => ({
      data: await issuePeriod(ctx, { billingPeriodId: i.billing_period_id, previewHash: i.preview_hash }),
      httpStatus: 201,
    }),
  }),
  "billing.lockPeriod": defineCommand({
    command: "billing.lockPeriod",
    input: z.strictObject({ billing_period_id: uuid, reason: z.string().max(500) }),
    run: async (ctx, i) => ({
      data: await lockBillingPeriod(ctx, { billingPeriodId: i.billing_period_id, reason: i.reason }),
    }),
  }),
  "billing.reopenPeriod": defineCommand({
    command: "billing.reopenPeriod",
    input: z.strictObject({ billing_period_id: uuid, reason: z.string().max(500) }),
    run: async (ctx, i) => ({
      data: await reopenPeriod(ctx, { billingPeriodId: i.billing_period_id, reason: i.reason }),
    }),
  }),
  // `import.upload` cần storage + multipart — route riêng khi web nối object storage (chưa có ở đợt 2).
  "import.validate": defineCommand({
    command: "import.validate",
    input: z.strictObject({ batch_id: uuid }),
    run: async (ctx, i) => ({ data: await validateBatch(ctx, { batchId: i.batch_id }) }),
  }),
  "import.setExpectedTotals": defineCommand({
    command: "import.setExpectedTotals",
    input: z.strictObject({ batch_id: uuid, debt: money, deposit: money }),
    run: async (ctx, i) => ({
      data: await setExpectedTotals(ctx, { batchId: i.batch_id, debt: i.debt, deposit: i.deposit }),
    }),
  }),
  "import.confirm": defineCommand({
    command: "import.confirm",
    input: z.strictObject({ batch_id: uuid }),
    run: async (ctx, i) => ({ data: await confirmBatch(ctx, { batchId: i.batch_id }) }),
  }),
  "import.commit": defineCommand({
    command: "import.commit",
    input: z.strictObject({ batch_id: uuid }),
    run: async (ctx, i) => ({ data: await commitBatch(ctx, { batchId: i.batch_id }) }),
  }),
  "import.cancel": defineCommand({
    command: "import.cancel",
    input: z.strictObject({ batch_id: uuid, reason: z.string().max(500) }),
    run: async (ctx, i) => ({ data: await cancelBatch(ctx, { batchId: i.batch_id, reason: i.reason }) }),
  }),
  "member.resetMfa": defineCommand({
    command: "member.resetMfa",
    input: z.strictObject({ membership_id: uuid, reason: z.string().max(500) }),
    run: async (ctx, i) => ({
      data: await resetMemberMfa(ctx, { membershipId: i.membership_id, reason: i.reason }),
    }),
  }),
  "meter.acknowledgeAnomaly": defineCommand({
    command: "meter.acknowledgeAnomaly",
    input: z.strictObject({ reading_id: uuid, note: z.string().trim().min(1).max(1000) }),
    run: async (ctx, i) => ({
      data: await acknowledgeAnomaly(ctx, { readingId: i.reading_id, note: i.note }),
    }),
  }),
};

/** Tìm command theo đường dẫn `<module>/<command>`; tên chỉ gồm chữ/số để không lọt ký tự lạ. */
export function findCommand(module: string, command: string): AnyCommand | undefined {
  if (!/^[a-z][a-zA-Z_]*$/.test(module) || !/^[a-zA-Z][a-zA-Z]*$/.test(command)) return undefined;
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
  "billing.previewPeriod": {
    query: "billing.previewPeriod",
    input: z.strictObject({ billing_period_id: uuid }),
    run: (db, actor, i: { billing_period_id: string }) =>
      previewPeriod(db, actor, { billingPeriodId: i.billing_period_id }),
  },
  "import.get": {
    query: "import.get",
    input: z.strictObject({ batch_id: uuid }),
    run: (db, actor, i: { batch_id: string }) => getBatch(db, actor, { batchId: i.batch_id }),
  },
  "import.getTemplate": {
    query: "import.getTemplate",
    input: z.strictObject({ kind: z.enum(["units", "leases", "meter_readings", "opening_balances"]) }),
    run: async (_db, actor, i: { kind: string }) => getTemplate(actor, i.kind),
  },
  "import.downloadErrorReport": {
    query: "import.downloadErrorReport",
    input: z.strictObject({ batch_id: uuid }),
    run: (db, actor, i: { batch_id: string }) => downloadErrorReport(db, actor, { batchId: i.batch_id }),
  },
  "lease.get": {
    query: "lease.get",
    input: z.strictObject({ lease_id: uuid }),
    run: (db, actor, i: { lease_id: string }) => getLease(db, actor, i.lease_id),
  },
  "reservation.quote": {
    query: "reservation.quote",
    input: z
      .strictObject({
        room_type_id: uuid.optional(),
        unit_id: uuid.optional(),
        arrival_date: isoDate,
        departure_date: isoDate,
        guests: z.coerce.number().int().min(1).max(50),
      })
      .refine((v) => (v.room_type_id === undefined) !== (v.unit_id === undefined), {
        message: "cần đúng một trong room_type_id, unit_id",
        path: ["room_type_id"],
      }),
    run: (
      db,
      actor,
      i: {
        room_type_id?: string;
        unit_id?: string;
        arrival_date: string;
        departure_date: string;
        guests: number;
      },
    ) =>
      quote(db, actor, {
        ...(i.room_type_id ? { roomTypeId: i.room_type_id } : {}),
        ...(i.unit_id ? { unitId: i.unit_id } : {}),
        arrivalDate: i.arrival_date,
        departureDate: i.departure_date,
        guests: i.guests,
      }),
  },
  "reservation.list": {
    query: "reservation.list",
    input: z.strictObject({
      property_id: uuid,
      from: isoDate,
      to: isoDate,
      status: z
        .enum(["draft", "held", "confirmed", "in_house", "checked_out", "cancelled", "no_show", "expired"])
        .optional(),
    }),
    run: (db, actor, i: { property_id: string; from: string; to: string; status?: never }) =>
      listReservations(db, actor, {
        propertyId: i.property_id,
        from: i.from,
        to: i.to,
        ...(i.status ? { status: i.status } : {}),
      }),
  },
  "stay.getFolio": {
    query: "stay.getFolio",
    input: z.strictObject({ stay_id: uuid }),
    run: (db, actor, i: { stay_id: string }) => getFolio(db, actor, i.stay_id),
  },
  "stay.listNotices": {
    query: "stay.listNotices",
    input: z.strictObject({
      property_id: uuid,
      status: z.enum(["pending", "exported", "submitted"]).optional(),
      due_before: z.iso.datetime({ offset: true }).optional(),
    }),
    run: (
      db,
      actor,
      i: { property_id: string; status?: "pending" | "exported" | "submitted"; due_before?: string },
    ) =>
      listNotices(db, actor, {
        propertyId: i.property_id,
        ...(i.status ? { status: i.status } : {}),
        ...(i.due_before ? { dueBefore: new Date(i.due_before) } : {}),
      }),
  },
  "housekeeping.listTasks": {
    query: "housekeeping.listTasks",
    input: z.strictObject({
      property_id: uuid,
      floor_id: uuid.optional(),
      status: z.enum(["open", "assigned", "in_progress", "done", "verified", "cancelled"]).optional(),
      assignee: uuid.optional(),
    }),
    run: (db, actor, i: { property_id: string; floor_id?: string; status?: never; assignee?: string }) =>
      listTasks(db, actor, {
        propertyId: i.property_id,
        ...(i.floor_id ? { floorId: i.floor_id } : {}),
        ...(i.status ? { status: i.status } : {}),
        ...(i.assignee ? { assignee: i.assignee } : {}),
      }),
  },
  "housekeeping.getTask": {
    query: "housekeeping.getTask",
    input: z.strictObject({ task_id: uuid }),
    run: (db, actor, i: { task_id: string }) => getTask(db, actor, i.task_id),
  },
  "inventory.getUnitStatus": {
    query: "inventory.getUnitStatus",
    input: z.strictObject({ unit_id: uuid }),
    run: (db, actor, i: { unit_id: string }) => getUnitStatus(db, actor, i.unit_id),
  },
  "inventory.getCalendar": {
    query: "inventory.getCalendar",
    input: z.strictObject({
      property_id: uuid,
      from: isoDate,
      to: isoDate,
      floor_id: uuid.optional(),
      room_type_id: uuid.optional(),
      limit: z
        .string()
        .regex(/^\d{1,3}$/)
        .optional(),
      cursor: z
        .string()
        .regex(/^\d{1,7}$/)
        .optional(),
    }),
    run: (
      db,
      actor,
      i: {
        property_id: string;
        from: string;
        to: string;
        floor_id?: string;
        room_type_id?: string;
        limit?: string;
        cursor?: string;
      },
    ) =>
      getCalendar(db, actor, {
        propertyId: i.property_id,
        from: i.from,
        to: i.to,
        ...(i.floor_id ? { floorId: i.floor_id } : {}),
        ...(i.room_type_id ? { roomTypeId: i.room_type_id } : {}),
        ...(i.limit ? { limit: Number(i.limit) } : {}),
        ...(i.cursor ? { cursor: i.cursor } : {}),
      }),
  },
  "inventory.searchAvailability": {
    query: "inventory.searchAvailability",
    input: z.strictObject({
      property_id: uuid,
      start: z.iso.datetime({ offset: true }),
      end: z.iso.datetime({ offset: true }),
      guests: z
        .string()
        .regex(/^\d{1,2}$/)
        .optional(),
      room_type_id: uuid.optional(),
    }),
    run: (
      db,
      actor,
      i: { property_id: string; start: string; end: string; guests?: string; room_type_id?: string },
    ) =>
      searchAvailability(db, actor, {
        propertyId: i.property_id,
        start: new Date(i.start),
        end: new Date(i.end),
        ...(i.guests ? { guests: Number(i.guests) } : {}),
        ...(i.room_type_id ? { roomTypeId: i.room_type_id } : {}),
      }),
  },
  "audit.listEvents": {
    query: "audit.listEvents",
    input: z.strictObject({
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
      property_id: z.string().max(64).optional(),
      actor_person_id: uuid.optional(),
      entity_type: z.string().min(1).max(64).optional(),
      entity_id: uuid.optional(),
      action: z.string().min(1).max(100).optional(),
      correlation_id: z.string().min(1).max(200).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      cursor: z.string().max(500).optional(),
      limit: z
        .string()
        .regex(/^\d{1,3}$/)
        .optional(),
    }),
    run: (db, actor, i: Record<string, string | undefined>) =>
      listEvents(db, actor, {
        ...(i.from ? { from: new Date(i.from) } : {}),
        ...(i.to ? { to: new Date(i.to) } : {}),
        ...(i.property_id ? { propertyId: i.property_id } : {}),
        ...(i.actor_person_id ? { actorPersonId: i.actor_person_id } : {}),
        ...(i.entity_type ? { entityType: i.entity_type } : {}),
        ...(i.entity_id ? { entityId: i.entity_id } : {}),
        ...(i.action ? { action: i.action } : {}),
        ...(i.correlation_id ? { correlationId: i.correlation_id } : {}),
        ...(i.order ? { order: i.order as "asc" | "desc" } : {}),
        ...(i.cursor ? { cursor: i.cursor } : {}),
        ...(i.limit ? { limit: Number(i.limit) } : {}),
      }),
  },
  "audit.getEvent": {
    query: "audit.getEvent",
    input: z.strictObject({ event_id: z.string().max(64) }),
    run: (db, actor, i: { event_id: string }) => getEvent(db, actor, i.event_id),
  },
  "reports.receivables": {
    query: "reports.receivables",
    input: z.strictObject({ as_of: isoDate.optional(), property_id: z.string().max(64).optional() }),
    run: (db, actor, i: { as_of?: string; property_id?: string }) =>
      receivables(db, actor, {
        ...(i.as_of ? { asOf: i.as_of } : {}),
        ...(i.property_id ? { propertyId: i.property_id } : {}),
      }),
  },
  "reports.collections": {
    query: "reports.collections",
    input: z.strictObject({ from: isoDate, to: isoDate, property_id: z.string().max(64).optional() }),
    run: (db, actor, i: { from: string; to: string; property_id?: string }) =>
      collections(db, actor, {
        from: i.from,
        to: i.to,
        ...(i.property_id ? { propertyId: i.property_id } : {}),
      }),
  },
  "reports.depositsHeld": {
    query: "reports.depositsHeld",
    input: z.strictObject({ property_id: z.string().max(64).optional() }),
    run: (db, actor, i: { property_id?: string }) =>
      depositsHeld(db, actor, i.property_id ? { propertyId: i.property_id } : {}),
  },
  "reports.occupancy": {
    query: "reports.occupancy",
    input: z.strictObject({ from: isoDate, to: isoDate, property_id: z.string().max(64).optional() }),
    run: (db, actor, i: { from: string; to: string; property_id?: string }) =>
      occupancy(db, actor, {
        from: i.from,
        to: i.to,
        ...(i.property_id ? { propertyId: i.property_id } : {}),
      }),
  },
  "exports.getStatus": {
    query: "exports.getStatus",
    input: z.strictObject({ export_id: z.string().max(64) }),
    run: (db, actor, i: { export_id: string }) => getExportStatus(db, actor, i.export_id),
  },
  "exports.listMine": {
    query: "exports.listMine",
    input: z.strictObject({}),
    run: (db, actor) => listMyExports(db, actor),
  },
  "today.getSummary": {
    query: "today.getSummary",
    input: z.strictObject({ property_id: z.string().max(64).optional() }),
    run: (db, actor, i: { property_id?: string }) =>
      getSummary(db, actor, i.property_id ? { propertyId: i.property_id } : {}),
  },
  "today.listItems": {
    query: "today.listItems",
    input: z.strictObject({ card: z.enum(TODAY_CARDS), property_id: z.string().max(64).optional() }),
    run: (db, actor, i: { card: (typeof TODAY_CARDS)[number]; property_id?: string }) =>
      listItems(db, actor, { card: i.card, ...(i.property_id ? { propertyId: i.property_id } : {}) }),
  },
  "portal.listMyInvoices": {
    query: "portal.listMyInvoices",
    input: z.strictObject({ status: z.enum(["open", "paid"]).optional() }),
    run: (db, actor, i: { status?: "open" | "paid" }) =>
      listMyInvoices(db, actor, i.status ? { status: i.status } : {}),
  },
  "portal.getMyInvoice": {
    query: "portal.getMyInvoice",
    input: z.strictObject({ invoice_id: z.string().max(64) }),
    run: (db, actor, i: { invoice_id: string }, _s, meta) => getMyInvoice(db, actor, i.invoice_id, meta),
  },
  "portal.getMyLease": {
    query: "portal.getMyLease",
    input: z.strictObject({}),
    run: (db, actor) => getMyLease(db, actor),
  },
  "portal.listMyMeterReadings": {
    query: "portal.listMyMeterReadings",
    input: z.strictObject({}),
    run: (db, actor, _i, services) => listMyMeterReadings(db, actor, services),
  },
  "portal.listMyRequests": {
    query: "portal.listMyRequests",
    input: z.strictObject({}),
    run: (db, actor) => listMyRequests(db, actor),
  },
  "portal.getPaymentInstructions": {
    query: "portal.getPaymentInstructions",
    input: z.strictObject({ invoice_id: z.string().max(64) }),
    run: (db, actor, i: { invoice_id: string }, _s, meta) =>
      getPaymentInstructions(db, actor, i.invoice_id, meta),
  },
  "payment.listClaims": {
    query: "payment.listClaims",
    input: z.strictObject({
      property_id: uuid.optional(),
      status: z.enum(["submitted", "matched", "rejected"]).optional(),
    }),
    run: (db, actor, i: { property_id?: string; status?: "submitted" | "matched" | "rejected" }) =>
      listPaymentClaims(db, actor, {
        ...(i.property_id ? { propertyId: i.property_id } : {}),
        ...(i.status ? { status: i.status } : {}),
      }),
  },
  "notifications.listMine": {
    query: "notifications.listMine",
    input: z.strictObject({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      before: z.iso.datetime({ offset: true }).optional(),
    }),
    run: (db, actor, i: { limit?: number; before?: string }) =>
      listMyNotifications(db, actor, {
        ...(i.limit ? { limit: i.limit } : {}),
        ...(i.before ? { before: new Date(i.before) } : {}),
      }),
  },
  "notifications.getPreferences": {
    query: "notifications.getPreferences",
    input: z.strictObject({}),
    run: (db, actor) => getPreferences(db, actor),
  },
  "notifications.listDeliveries": {
    query: "notifications.listDeliveries",
    input: z.strictObject({
      property_id: uuid.optional(),
      status: z.enum(["queued", "sending", "sent", "retrying", "failed", "dead", "suppressed"]).optional(),
      recipient_person_id: uuid.optional(),
      type: z.string().max(40).optional(),
    }),
    run: (
      db,
      actor,
      i: { property_id?: string; status?: never; recipient_person_id?: string; type?: string },
    ) =>
      listDeliveries(db, actor, {
        ...(i.property_id ? { propertyId: i.property_id } : {}),
        ...(i.status ? { status: i.status } : {}),
        ...(i.recipient_person_id ? { recipientPersonId: i.recipient_person_id } : {}),
        ...(i.type ? { type: i.type } : {}),
      }),
  },
  "maintenance.listWorkOrders": {
    query: "maintenance.listWorkOrders",
    input: z.strictObject({
      property_id: uuid,
      status: z.enum(["open", "assigned", "in_progress", "done", "verified", "cancelled"]).optional(),
      mine: z.enum(["true", "false"]).optional(),
    }),
    run: (db, actor, i: { property_id: string; status?: never; mine?: "true" | "false" }) =>
      listWorkOrders(db, actor, {
        propertyId: i.property_id,
        ...(i.status ? { status: i.status } : {}),
        mine: i.mine === "true",
      }),
  },
  "maintenance.listMyWorkOrders": {
    query: "maintenance.listMyWorkOrders",
    input: z.strictObject({}),
    run: (db, actor) => listMyWorkOrders(db, actor),
  },
  "reservation.get": {
    query: "reservation.get",
    input: z.strictObject({ reservation_id: uuid }),
    run: (db, actor, i: { reservation_id: string }) => getReservation(db, actor, i.reservation_id),
  },
  "identity.get": {
    query: "identity.get",
    input: z.strictObject({ identity_document_id: uuid }),
    run: (db, actor, i: { identity_document_id: string }) =>
      getIdentityDocument(db, actor, i.identity_document_id),
  },
  "person.get": {
    query: "person.get",
    input: z.strictObject({ person_id: z.string().max(64) }),
    run: (db, actor, i: { person_id: string }) => getPerson(db, actor, i.person_id),
  },
  "meter.getReadingRoute": {
    query: "meter.getReadingRoute",
    input: z.strictObject({ billing_period_id: uuid }),
    run: (db, actor, i: { billing_period_id: string }) =>
      readingRoute(db, actor, { billingPeriodId: i.billing_period_id }),
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
  if (!/^[a-z][a-zA-Z_]*$/.test(module) || !/^[a-zA-Z][a-zA-Z]*$/.test(query)) return undefined;
  return Object.hasOwn(QUERIES, `${module}.${query}`) ? QUERIES[`${module}.${query}`] : undefined;
}
