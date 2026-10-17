// Folio lượt ở (SPEC-reservation-stay S-017, S-018, S-022, S-024, S-025; DOMAIN-MODEL §1, §5): khung nhìn trên `charges` +
// thanh toán của booking + phân bổ; cọc bảo đảm hiển thị RIÊNG, không trừ vào số còn phải thu (INV-F5). Ghi dịch vụ/phụ thu
// chỉ khi khách đang ở; huỷ khoản chỉ trước khi phát hành (trigger INV-G4) và trong kỳ chưa khoá (PERIOD_LOCKED).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/index.ts";
import { approvalRequired, registerApprovalExecutor } from "../approvals/approvals.ts";
import { customerCredit } from "../payments/payments.ts";
import { type CommandContext, CommandError } from "../pipeline/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = { service: "REV_SERVICE", fee: "REV_FEE", discount: "DISCOUNT" } as const;
export type PostableKind = keyof typeof ACCOUNT;

function fieldError(path: string, code: string, message: string): CommandError {
  return new CommandError("VALIDATION_FAILED", 422, message, {
    extensions: { errors: [{ path, field: path, code }] },
  });
}

interface StayRow {
  id: string;
  property_id: string;
  status: string;
  reservation_id: string;
  booker_person_id: string;
  unit_code: string;
}

export async function readStay(
  trx: Transaction<unknown>,
  actor: Actor,
  stayId: string,
  lock: boolean,
): Promise<StayRow> {
  if (!UUID.test(stayId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
  if (lock)
    await sql`select 1 from stays where organization_id = ${actor.orgId} and id = ${stayId} for update`.execute(
      trx,
    );
  const r = await sql<StayRow>`
    select s.id, s.property_id, s.status, r.id as reservation_id, r.booker_person_id, u.code as unit_code
    from stays s
    join reservation_items i on i.organization_id = s.organization_id and i.id = s.reservation_item_id
    join reservations r on r.organization_id = i.organization_id and r.id = i.reservation_id
    join units u on u.organization_id = s.organization_id and u.id = s.unit_id
    where s.organization_id = ${actor.orgId} and s.id = ${stayId}`.execute(trx);
  const row = r.rows[0];
  if (!row || (!actor.allProperties && !actor.propertyIds.includes(row.property_id)))
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
  return row;
}

/**
 * `stay.postCharge` (S-017, S-018): dịch vụ/phụ thu (≥ 0) hoặc giảm giá (âm, trong hạn mức đổi giá). Ngày kinh doanh hiện tại;
 * kỳ đã khoá → PERIOD_LOCKED (trigger). Idempotency theo Idempotency-Key của pipeline (cùng key khác số tiền → 409).
 */
export async function postCharge(
  ctx: CommandContext,
  input: {
    stayId: string;
    kind: PostableKind;
    description: string;
    quantity: number;
    unitPrice: number;
    now?: Date;
  },
  opts: { approved?: boolean } = {},
): Promise<{ chargeId: string; amount: number; businessDate: string }> {
  const stay = await readStay(ctx.trx, ctx.actor, input.stayId, true);
  authorize(ctx.actor, "folio.post_charge", { propertyId: stay.property_id });
  if (stay.status !== "in_house")
    throw new CommandError("INVALID_TRANSITION", 409, "Chỉ ghi dịch vụ khi khách đang ở", {
      extensions: { from: stay.status, to: stay.status },
    });
  const description = input.description.trim();
  if (description.length < 1 || description.length > 500)
    throw fieldError("description", "required", "Mô tả 1–500 ký tự");
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 1000)
    throw fieldError("quantity", "invalid", "Số lượng là số nguyên 1–1000");
  if (!Number.isSafeInteger(input.unitPrice) || input.unitPrice <= 0)
    throw fieldError("unit_price", "invalid", "Đơn giá là số nguyên đồng > 0");
  const gross = input.quantity * input.unitPrice;
  if (!Number.isSafeInteger(gross)) throw fieldError("unit_price", "too_large", "Số tiền quá lớn");
  if (input.kind === "discount" && !opts.approved) {
    try {
      authorize(ctx.actor, "reservation.override_price", { propertyId: stay.property_id, amount: gross });
    } catch (e) {
      if ((e as { code?: string }).code !== "APPROVAL_LIMIT_EXCEEDED") throw e;
      // Vượt hạn mức (SPEC-access 5.3, S-017): lập yêu cầu duyệt `discount`; người duyệt thực hiện qua executor bên dưới.
      throw approvalRequired(
        ctx.actor,
        {
          kind: "discount",
          amount: gross,
          reason: description,
          propertyId: stay.property_id,
          subjectType: "stay",
          subjectId: stay.id,
          payload: { description, quantity: input.quantity, unit_price: input.unitPrice },
        },
        "Giảm giá vượt hạn mức — đã gửi yêu cầu duyệt",
      );
    }
  }
  const amount = input.kind === "discount" ? -gross : gross;
  const day = await sql<{ d: string }>`
    select app.business_date(${ctx.actor.orgId}, ${stay.property_id}, ${input.now ?? new Date()})::text as d`.execute(
    ctx.trx,
  );
  const businessDate = day.rows[0]?.d as string;
  const id = randomUUID();
  await sql`
    insert into charges (id, organization_id, property_id, source_type, stay_id, kind, revenue_account, description,
                         business_date, quantity, unit_price, amount, created_by, command_id)
    values (${id}, ${ctx.actor.orgId}, ${stay.property_id}, 'stay', ${stay.id}, ${input.kind}, ${ACCOUNT[input.kind]},
            ${description}, ${businessDate}::date, ${input.quantity}, ${input.kind === "discount" ? -input.unitPrice : input.unitPrice},
            ${amount}, ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(ctx.trx);
  await ctx.audit({
    action: "folio.charge_posted",
    entityType: "charge",
    entityId: id,
    propertyId: stay.property_id,
    after: { stay_id: stay.id, kind: input.kind, amount, business_date: businessDate },
  });
  return { chargeId: id, amount, businessDate };
}

/** `stay.voidCharge` (S-018, S-022, S-023): huỷ có lý do khoản chưa phát hành, ngoài kỳ khoá; phí phòng đổi qua đổi ngày. */
export async function voidCharge(
  ctx: CommandContext,
  input: { chargeId: string; reason: string },
): Promise<{ chargeId: string; voided: true }> {
  if (!UUID.test(input.chargeId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy khoản");
  const r = await sql<{
    stay_id: string | null;
    kind: string;
    voided_at: Date | null;
    business_date: string;
    property_id: string;
  }>`
    select stay_id, kind, voided_at, business_date::text, property_id from charges
    where organization_id = ${ctx.actor.orgId} and id = ${input.chargeId} and source_type = 'stay'`.execute(
    ctx.trx,
  );
  const seen = r.rows[0];
  if (!seen?.stay_id) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy khoản");
  // Thứ tự khoá như check-out (stay → charges) để hai lệnh song song không deadlock (review R-nghi ngờ 1).
  const stay = await readStay(ctx.trx, ctx.actor, seen.stay_id, true);
  const relock = await sql<{ voided_at: Date | null }>`
    select voided_at from charges where organization_id = ${ctx.actor.orgId} and id = ${input.chargeId} for update`.execute(
    ctx.trx,
  );
  const c = { ...seen, voided_at: relock.rows[0]?.voided_at ?? null };
  authorize(ctx.actor, "folio.post_charge", { propertyId: stay.property_id });
  const reason = input.reason.trim();
  if (reason.length < 1) throw fieldError("reason", "required", "Cần lý do huỷ");
  if (c.kind === "room")
    throw fieldError("charge_id", "room_charge", "Tiền phòng đổi bằng đổi ngày, không huỷ từng đêm");
  if (c.voided_at)
    throw new CommandError("INVALID_TRANSITION", 409, "Khoản đã huỷ", {
      extensions: { from: "voided", to: "voided" },
    });
  const lock = await sql<{ lt: string | null }>`
    select app.locked_through(${ctx.actor.orgId}, ${c.property_id})::text as lt`.execute(ctx.trx);
  const lt = lock.rows[0]?.lt;
  if (lt && c.business_date <= lt)
    throw new CommandError("PERIOD_LOCKED", 409, "Kỳ này đã khoá. Hãy tạo điều chỉnh có duyệt.");
  // Đã lên phiếu → trigger charge_guard chặn (DOCUMENT_IMMUTABLE, S-023).
  await sql`update charges set voided_at = now(), voided_by = ${ctx.actor.membershipId}, void_reason = ${reason}
            where organization_id = ${ctx.actor.orgId} and id = ${input.chargeId}`.execute(ctx.trx);
  await ctx.audit({
    action: "folio.charge_voided",
    entityType: "charge",
    entityId: input.chargeId,
    propertyId: stay.property_id,
    reason,
  });
  return { chargeId: input.chargeId, voided: true };
}

export interface FolioView {
  stayId: string;
  /** Cơ sở và booking của lượt ở — UI cần để mở ca tiền mặt đúng cơ sở và quay về booking. */
  propertyId: string;
  reservationId: string;
  stayStatus: string;
  unitCode: string;
  charges: {
    id: string;
    kind: string;
    description: string;
    businessDate: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    voided: boolean;
  }[];
  payments: {
    id: string;
    method: string;
    amount: number;
    status: string;
    allocated: number;
    receiptNo: string | null;
  }[];
  invoice: { id: string; number: string; total: number; allocated: number; balance: number } | null;
  chargesTotal: number;
  paidTotal: number;
  balance: number;
  /** Cọc bảo đảm — tách riêng, không trừ vào `balance` (INV-F5). */
  deposit: { id: string; amount: number; balance: number } | null;
}

/** Tính folio trong transaction có sẵn (check-out dùng lại cùng công thức). */
export async function folioIn(trx: Transaction<unknown>, actor: Actor, stay: StayRow): Promise<FolioView> {
  const ch = await sql<{
    id: string;
    kind: string;
    description: string;
    d: string;
    q: string;
    up: string;
    amount: string;
    voided: boolean;
  }>`
    select id, kind, description, business_date::text as d, quantity::text as q, unit_price::text as up, amount::text,
           voided_at is not null as voided
    from charges where organization_id = ${actor.orgId} and stay_id = ${stay.id}
    order by business_date, created_at`.execute(trx);
  const pays = await sql<{
    id: string;
    method: string;
    amount: string;
    status: string;
    allocated: string;
    receipt_no: string | null;
    payer_person_id: string;
  }>`
    select id, method, amount::text, status, allocated_total::text as allocated, receipt_no, payer_person_id from payments
    where organization_id = ${actor.orgId} and reservation_id = ${stay.reservation_id} and purpose = 'receivable'
    order by created_at`.execute(trx);
  const inv = await sql<{ id: string; number: string; total: string; allocated: string }>`
    select id, number, total::text, allocated_total::text as allocated from invoices
    where organization_id = ${actor.orgId} and stay_id = ${stay.id} and kind = 'folio'`.execute(trx);
  const dep = await sql<{ id: string; amount: string; balance: string }>`
    select id, amount::text, balance::text from deposits where organization_id = ${actor.orgId} and reservation_id = ${stay.reservation_id}`.execute(
    trx,
  );
  const charges = ch.rows.map((c) => ({
    id: c.id,
    kind: c.kind,
    description: c.description,
    businessDate: c.d,
    quantity: Number(c.q),
    unitPrice: Number(c.up),
    amount: Number(c.amount),
    voided: c.voided,
  }));
  const chargesTotal = charges.filter((c) => !c.voided).reduce((s, c) => s + c.amount, 0);
  const payments = pays.rows.map((p) => ({
    id: p.id,
    method: p.method,
    amount: Number(p.amount),
    status: p.status,
    allocated: Number(p.allocated),
    receiptNo: p.receipt_no,
  }));
  const i = inv.rows[0];
  const invoice = i
    ? {
        id: i.id,
        number: i.number,
        total: Number(i.total),
        allocated: Number(i.allocated),
        balance: Number(i.total) - Number(i.allocated),
      }
    : null;
  // Trước phát hành: đã trả = ứng trước đã xác nhận còn chưa phân bổ nơi khác. Sau phát hành: theo phiếu folio (sổ phụ).
  // Phần chưa phân bổ chỉ còn giá trị tới số dư CUSTOMER_CREDIT thật của người trả (có thể đã hoàn — review R2).
  let unissuedPaid = 0;
  if (!invoice) {
    const free = new Map<string, number>();
    for (const p of pays.rows)
      if (p.status === "confirmed")
        free.set(
          p.payer_person_id,
          (free.get(p.payer_person_id) ?? 0) + Number(p.amount) - Number(p.allocated),
        );
    for (const [personId, f] of free) {
      const credit = await customerCredit(trx, actor.orgId, personId, stay.property_id);
      unissuedPaid += Math.max(0, Math.min(f, credit));
    }
  }
  const paidTotal = invoice ? invoice.allocated : unissuedPaid;
  const balance = invoice ? invoice.balance : chargesTotal - paidTotal;
  const d = dep.rows[0];
  return {
    stayId: stay.id,
    propertyId: stay.property_id,
    reservationId: stay.reservation_id,
    stayStatus: stay.status,
    unitCode: stay.unit_code,
    charges,
    payments,
    invoice,
    chargesTotal,
    paidTotal,
    balance,
    deposit: d ? { id: d.id, amount: Number(d.amount), balance: Number(d.balance) } : null,
  };
}

/** `stay.getFolio` (query, S-017, S-025): buồng phòng/kỹ thuật, ngoài phạm vi, khác tổ chức → 404. */
export async function getFolio(db: Kysely<unknown>, actor: Actor, stayId: string): Promise<FolioView> {
  if (!["owner", "manager", "front_desk", "accountant"].includes(actor.role))
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) =>
    folioIn(trx, actor, await readStay(trx, actor, stayId, false)),
  );
}

let registered = false;
/** Duyệt `discount` (vượt hạn mức) = ghi đúng khoản giảm giá đã duyệt vào folio đang mở của lượt ở. */
export function registerFolioExecutors(): void {
  if (registered) return;
  registered = true;
  registerApprovalExecutor("discount", {
    async execute(ctx, req) {
      const q = req.payload.quantity;
      const up = req.payload.unit_price;
      const d = req.payload.description;
      if (
        req.subjectType !== "stay" ||
        !req.subjectId ||
        typeof q !== "number" ||
        typeof up !== "number" ||
        typeof d !== "string"
      )
        throw new CommandError("VALIDATION_FAILED", 422, "Yêu cầu giảm giá thiếu lượt ở/số tiền");
      return postCharge(
        ctx,
        { stayId: req.subjectId, kind: "discount", description: d, quantity: q, unitPrice: up },
        { approved: true },
      );
    },
  });
}

registerFolioExecutors();
