// Folio lượt ở (SPEC-reservation-stay S-017, S-018, S-022, S-024, S-025; DOMAIN-MODEL §1, §5): khung nhìn trên `charges` +
// thanh toán của booking + phân bổ; cọc bảo đảm hiển thị RIÊNG, không trừ vào số còn phải thu (INV-F5). Ghi dịch vụ/phụ thu
// chỉ khi khách đang ở; huỷ khoản chỉ trước khi phát hành (trigger INV-G4) và trong kỳ chưa khoá (PERIOD_LOCKED).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";

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
  if (input.kind === "discount")
    authorize(ctx.actor, "reservation.override_price", { propertyId: stay.property_id, amount: gross });
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
    where organization_id = ${ctx.actor.orgId} and id = ${input.chargeId} and source_type = 'stay' for update`.execute(
    ctx.trx,
  );
  const c = r.rows[0];
  if (!c?.stay_id) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy khoản");
  const stay = await readStay(ctx.trx, ctx.actor, c.stay_id, true);
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
  }>`
    select id, method, amount::text, status, allocated_total::text as allocated, receipt_no from payments
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
  const paidTotal = invoice
    ? invoice.allocated
    : payments.filter((p) => p.status === "confirmed").reduce((s, p) => s + (p.amount - p.allocated), 0);
  const balance = invoice ? invoice.balance : chargesTotal - paidTotal;
  const d = dep.rows[0];
  return {
    stayId: stay.id,
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
