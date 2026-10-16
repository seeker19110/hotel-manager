// PLAN đợt 3 T-217 — portal người thuê (SPEC-portal S-001…S-011, S-021). Quyền ở hai lớp: hàm chỉ cho vai trò `tenant`
// (vai trò khác → 403) và RLS riêng của `tenant` (0039/0040) quyết dòng nào thấy được — không thấy = 404 kèm audit
// `portal.access_denied` (S-003), thân lỗi không chứa dữ liệu của người khác. Số dư lấy từ sổ (cột `open_amount`).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize, bankBin, buildVietQr } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import type { FileDeps } from "../files/files.ts";
import { createWorkOrder, type Severity } from "../maintenance/work-orders.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError } from "../pipeline/problem.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHOTO_URL_SECONDS = 300;

function tenantOnly(actor: Actor): void {
  if (actor.role !== "tenant")
    throw new CommandError("FORBIDDEN", 403, "Bạn không có quyền thực hiện thao tác này.");
}

const notFound = () => new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu.");

/** S-003: truy cập tài nguyên không thuộc mình → audit (transaction riêng, không lộ gì trong phản hồi). */
async function denied(
  db: Kysely<unknown>,
  actor: Actor,
  entityType: string,
  entityId: string,
  correlationId: string,
) {
  await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
    sql`insert into audit_events (id, organization_id, actor_type, actor_person_id, action, entity_type, entity_id, correlation_id,
                                  outcome)
        values (${randomUUID()}, ${actor.orgId}, 'user', ${actor.personId}, 'portal.access_denied', ${entityType},
                ${UUID.test(entityId) ? entityId : null}, ${correlationId}, 'denied')`.execute(trx),
  );
}

const period = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const balanceLabel = (balance: number) => (balance > 0 ? "Còn nợ" : "Đã trả đủ");

export interface MyInvoice {
  id: string;
  number: string;
  period: string;
  dueOn: string | null;
  total: number;
  paid: number;
  balance: number;
  statusLabel: string;
}

interface InvoiceRow {
  id: string;
  property_id: string;
  number: string;
  memo_ref: string;
  due_on: string | null;
  business_date: string;
  period_start: string | null;
  total: string;
  allocated_total: string;
  open_amount: string;
}

async function invoiceRows(trx: Transaction<unknown>, actor: Actor, id?: string): Promise<InvoiceRow[]> {
  const r = await sql<InvoiceRow>`
    select i.id, i.property_id, i.number, i.memo_ref, i.due_on::text, i.business_date::text, bp.period_start::text,
           i.total::text, i.allocated_total::text, i.open_amount::text
    from invoices i
    left join billing_periods bp on bp.organization_id = i.organization_id and bp.id = i.billing_period_id
    where i.organization_id = ${actor.orgId} and i.payer_person_id = ${actor.personId}
      ${id ? sql`and i.id = ${id}` : sql``}
    order by i.business_date desc, i.number desc limit 200`.execute(trx);
  return r.rows;
}

function view(i: InvoiceRow): MyInvoice {
  const balance = Number(i.open_amount);
  return {
    id: i.id,
    number: i.number,
    period: period(i.period_start ?? i.business_date),
    dueOn: i.due_on,
    total: Number(i.total),
    paid: Number(i.allocated_total),
    balance,
    statusLabel: balanceLabel(balance),
  };
}

/** `portal.listMyInvoices` (S-001, S-021): phiếu mình trả của kỳ đã phát hành; rỗng → []. */
export async function listMyInvoices(
  db: Kysely<unknown>,
  actor: Actor,
  input: { status?: "open" | "paid" } = {},
): Promise<MyInvoice[]> {
  tenantOnly(actor);
  const rows = await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
    invoiceRows(trx, actor),
  );
  return rows
    .map(view)
    .filter((i) => !input.status || (input.status === "open" ? i.balance > 0 : i.balance <= 0));
}

/** `portal.getMyInvoice` (S-002…S-004): dòng phiếu + phân bổ; không thuộc mình → 404 + audit. */
export async function getMyInvoice(
  db: Kysely<unknown>,
  actor: Actor,
  invoiceId: string,
  meta: { correlationId: string },
) {
  tenantOnly(actor);
  const found = UUID.test(invoiceId)
    ? await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
        const i = (await invoiceRows(trx, actor, invoiceId))[0];
        if (!i) return null;
        const lines = await sql<{
          kind: string;
          description: string;
          quantity: string;
          unit_price: string;
          amount: string;
        }>`
          select kind, description, quantity::text, unit_price::text, amount::text from invoice_lines
          where organization_id = ${actor.orgId} and invoice_id = ${i.id} order by line_no`.execute(trx);
        const allocs = await sql<{ amount: string; created_at: Date }>`
          select amount::text, created_at from payment_allocations
          where organization_id = ${actor.orgId} and invoice_id = ${i.id} and reversed_at is null order by created_at`.execute(
          trx,
        );
        return {
          ...view(i),
          lines: lines.rows.map((l) => ({
            kind: l.kind,
            description: l.description,
            quantity: Number(l.quantity),
            unitPrice: Number(l.unit_price),
            amount: Number(l.amount),
          })),
          allocations: allocs.rows.map((a) => ({ amount: Number(a.amount), allocatedAt: a.created_at })),
        };
      })
    : null;
  if (!found) {
    await denied(db, actor, "invoice", invoiceId, meta.correlationId);
    throw notFound();
  }
  return found;
}

/** `portal.getMyLease` (S-006): hợp đồng mình đứng tên, phiên bản đang hiệu lực, cọc tách nhãn; không giấy tờ (Q-08). */
export async function getMyLease(db: Kysely<unknown>, actor: Actor) {
  tenantOnly(actor);
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      id: string;
      number: string;
      status: string;
      unit_id: string;
      property_id: string;
      unit_code: string;
      version_no: number | null;
      effective_from: string | null;
      effective_to: string | null;
      rent_amount: string | null;
      deposit_amount: string | null;
      deposit_balance: string | null;
    }>`
      select l.id, l.number, l.status, l.unit_id, l.property_id, u.code as unit_code, v.version_no, v.effective_from::text, v.effective_to::text,
             v.rent_amount::text, v.deposit_amount::text,
             (select sum(d.balance)::text from deposits d where d.organization_id = l.organization_id and d.lease_id = l.id) as deposit_balance
      from leases l
      join units u on u.organization_id = l.organization_id and u.id = l.unit_id
      join properties p on p.organization_id = l.organization_id and p.id = l.property_id
      left join lateral (select lv.version_no, lv.effective_from, lv.effective_to, lv.rent_amount, lv.deposit_amount
                         from lease_versions lv
                         where lv.organization_id = l.organization_id and lv.lease_id = l.id and lv.signed_at is not null
                           and lv.effective_from <= (now() at time zone p.timezone)::date
                         order by lv.version_no desc limit 1) v on true
      where l.organization_id = ${actor.orgId} and l.representative_person_id = ${actor.personId}
        and l.status not in ('draft','cancelled')
      order by l.created_at desc`.execute(trx);
    return r.rows.map((x) => ({
      id: x.id,
      number: x.number,
      status: x.status,
      unitId: x.unit_id,
      propertyId: x.property_id,
      unitCode: x.unit_code,
      currentVersion:
        x.version_no === null
          ? null
          : {
              versionNo: x.version_no,
              effectiveFrom: x.effective_from,
              effectiveTo: x.effective_to,
              rentAmount: Number(x.rent_amount),
            },
      deposit: {
        amount: Number(x.deposit_amount ?? 0),
        balance: Number(x.deposit_balance ?? 0),
        label: "Cọc — không phải tiền đã trả cho phiếu",
      },
    }));
  });
}

/** `portal.listMyMeterReadings` (S-007): chỉ chỉ số đã duyệt của phòng mình thuê; ảnh qua URL ký ngắn hạn. */
export async function listMyMeterReadings(
  db: Kysely<unknown>,
  actor: Actor,
  deps: Pick<FileDeps, "storage">,
) {
  tenantOnly(actor);
  const rows = await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      id: string;
      kind: string;
      read_on: string;
      value: string;
      storage_key: string | null;
    }>`
      select r.id, m.kind, r.read_on::text, r.value::text, f.storage_key
      from meter_readings r
      join meters m on m.organization_id = r.organization_id and m.id = r.meter_id
      left join files f on f.organization_id = r.organization_id and f.id = r.photo_file_id and f.status = 'ready'
      where r.organization_id = ${actor.orgId}
      order by r.read_on desc, m.kind limit 200`.execute(trx);
    return r.rows;
  });
  return Promise.all(
    rows.map(async (x) => ({
      id: x.id,
      kind: x.kind,
      readOn: x.read_on,
      value: Number(x.value),
      photoUrl: x.storage_key ? await deps.storage.signedGetUrl(x.storage_key, PHOTO_URL_SECONDS) : null,
    })),
  );
}

// ——— Yêu cầu sửa chữa (S-008, S-009) ———

const REQUEST_LABEL: Readonly<Record<string, string>> = {
  open: "Đã tiếp nhận",
  assigned: "Đã giao thợ",
  in_progress: "Đang xử lý",
  done: "Đã xong — chờ nghiệm thu",
  verified: "Đã hoàn tất",
  cancelled: "Đã huỷ",
};

/** `portal.createRequest` (S-008): phiếu sự cố nguồn người thuê, phòng của hợp đồng mình (qua module sự cố). */
export async function createRequest(
  ctx: CommandContext,
  input: {
    unitId: string;
    title: string;
    description: string;
    severity?: Severity;
    fileIds?: readonly string[];
  },
) {
  tenantOnly(ctx.actor);
  const r = await createWorkOrder(ctx, {
    unitId: input.unitId,
    title: input.title,
    description: input.description,
    severity: input.severity ?? "medium",
    ...(input.fileIds ? { fileIds: input.fileIds } : {}),
  });
  return { requestId: r.workOrderId, statusLabel: REQUEST_LABEL.open, rejectedFileIds: r.rejectedFileIds };
}

/** `portal.listMyRequests` (S-009): nhãn trạng thái + thời điểm theo giờ cơ sở; không tên/SĐT nhân viên. */
export async function listMyRequests(db: Kysely<unknown>, actor: Actor) {
  tenantOnly(actor);
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      id: string;
      unit_code: string;
      title: string;
      status: string;
      created_at: Date;
      updated_at: Date;
      updated_local: string;
    }>`
      select w.id, u.code as unit_code, w.title, w.status, w.created_at, w.updated_at,
             to_char(w.updated_at at time zone p.timezone, 'HH24:MI DD/MM/YYYY') as updated_local
      from work_orders w
      join units u on u.organization_id = w.organization_id and u.id = w.unit_id
      join properties p on p.organization_id = w.organization_id and p.id = w.property_id
      where w.organization_id = ${actor.orgId} and w.reporter_person_id = ${actor.personId}
      order by w.created_at desc limit 100`.execute(trx);
    return r.rows.map((x) => ({
      id: x.id,
      unitCode: x.unit_code,
      title: x.title,
      status: x.status,
      statusLabel: REQUEST_LABEL[x.status] ?? x.status,
      createdAt: x.created_at,
      updatedAt: x.updated_at,
      updatedAtLocal: x.updated_local,
    }));
  });
}

// ——— Thanh toán: QR + "Tôi đã chuyển" (S-010, S-011) ———

/** `portal.getPaymentInstructions`: QR VietQR + mã tham chiếu cho phiếu của mình (chỉ hiển thị, không xác nhận thu). */
export async function getPaymentInstructions(
  db: Kysely<unknown>,
  actor: Actor,
  invoiceId: string,
  meta: { correlationId: string },
) {
  tenantOnly(actor);
  const out = UUID.test(invoiceId)
    ? await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
        const i = (await invoiceRows(trx, actor, invoiceId))[0];
        if (!i) return null;
        const a = await sql<{ bank_code: string; account_number: string; account_name: string }>`
          select bank_code, account_number, account_name from receiving_accounts
          where organization_id = ${actor.orgId} and property_id = ${i.property_id} and active order by id limit 1`.execute(
          trx,
        );
        const acct = a.rows[0] ?? null;
        const due = Number(i.open_amount);
        const bin = acct ? bankBin(acct.bank_code) : null;
        let qr: string | null = null;
        if (acct && bin && due > 0) {
          try {
            qr = buildVietQr({ bin, accountNumber: acct.account_number, amount: due, memo: i.memo_ref });
          } catch (e) {
            if (!(e instanceof RangeError)) throw e;
          }
        }
        return {
          invoiceId: i.id,
          amountDue: due,
          transferContent: i.memo_ref,
          account: acct
            ? { bankCode: acct.bank_code, accountNumber: acct.account_number, accountName: acct.account_name }
            : null,
          qrPayload: qr,
          notice: "Chuyển đúng nội dung. Phiếu chỉ được ghi nhận đã trả khi chủ trọ thấy tiền vào tài khoản.",
        };
      })
    : null;
  if (!out) {
    await denied(db, actor, "invoice", invoiceId, meta.correlationId);
    throw notFound();
  }
  return out;
}

/**
 * `portal.submitPaymentClaim` ("Tôi đã chuyển", S-010, S-011): tạo báo chuyển `submitted` — KHÔNG tạo payment hay bút
 * toán, số dư phiếu không đổi (INV-F3). Một báo chuyển mỗi Idempotency-Key (unique `command_id`).
 */
export async function submitPaymentClaim(
  ctx: CommandContext,
  input: { invoiceId: string; amount: number; referenceCode?: string; proofFileId?: string },
) {
  tenantOnly(ctx.actor);
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw new CommandError("VALIDATION_FAILED", 422, "Số tiền phải là số nguyên đồng > 0", {
      extensions: { errors: [{ path: "amount", field: "amount", code: "invalid" }] },
    });
  if (!UUID.test(input.invoiceId)) throw notFound();
  const i = (await invoiceRows(ctx.trx, ctx.actor, input.invoiceId))[0];
  if (!i) {
    // Ghi audit ở transaction lưu kết quả lỗi (lệnh chính rollback) — S-003.
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu.", {
      persist: async (trx) => {
        await sql`insert into audit_events (id, organization_id, actor_type, actor_person_id, action, entity_type, entity_id,
                                            correlation_id, outcome)
                  values (${randomUUID()}, ${ctx.actor.orgId}, 'user', ${ctx.actor.personId}, 'portal.access_denied', 'invoice',
                          ${input.invoiceId}, ${ctx.correlationId}, 'denied')`.execute(trx);
        return {};
      },
    });
  }
  const reference = (input.referenceCode ?? i.memo_ref).trim().slice(0, 100) || i.memo_ref;
  if (input.proofFileId !== undefined && !UUID.test(input.proofFileId)) throw notFound();
  const claimId = randomUUID();
  await sql`
    insert into payment_claims (id, organization_id, property_id, invoice_id, person_id, amount, reference_code, proof_file_id,
                                command_id)
    values (${claimId}, ${ctx.actor.orgId}, ${i.property_id}, ${i.id}, ${ctx.actor.personId}, ${input.amount}, ${reference},
            ${input.proofFileId ?? null}, ${ctx.commandId})`.execute(ctx.trx);
  if (input.proofFileId) {
    // Ảnh chứng từ (Q-07): chỉ file `payment_claim` đã quét sạch, của chính người báo, chưa gắn nơi khác.
    const f = await sql<{ id: string }>`
      update files set owner_id = ${claimId}
      where organization_id = ${ctx.actor.orgId} and id = ${input.proofFileId} and owner_type = 'payment_claim' and status = 'ready'
        and uploaded_by = ${ctx.actor.membershipId} and owner_id is null
      returning id`.execute(ctx.trx);
    if (!f.rows[0])
      throw new CommandError(
        "VALIDATION_FAILED",
        422,
        "Ảnh chứng từ không hợp lệ (chưa quét xong hoặc không phải của bạn)",
        {
          extensions: { errors: [{ path: "proof_file_id", field: "proof_file_id", code: "invalid" }] },
        },
      );
  }
  await ctx.audit({
    action: "payment_claim.submitted",
    entityType: "payment_claim",
    entityId: claimId,
    propertyId: i.property_id,
    after: { invoice_id: i.id, amount: input.amount },
  });
  await ctx.emit({
    eventType: "payment_claim.submitted",
    aggregateType: "payment_claim",
    aggregateId: claimId,
    propertyId: i.property_id,
    payload: { payment_claim_id: claimId, invoice_id: i.id },
  });
  return {
    claimId,
    status: "submitted" as const,
    message: "Đã ghi nhận báo chuyển — chủ trọ sẽ xác nhận khi thấy tiền",
  };
}

/** Hàng chờ báo chuyển cho nhân viên có quyền thu (S-010): theo cơ sở trong phạm vi (RLS). */
export async function listPaymentClaims(
  db: Kysely<unknown>,
  actor: Actor,
  input: { propertyId?: string; status?: "submitted" | "matched" | "rejected" } = {},
) {
  if (input.propertyId !== undefined && !UUID.test(input.propertyId)) throw notFound();
  authorize(actor, "payment.record", input.propertyId ? { propertyId: input.propertyId } : {});
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      id: string;
      property_id: string;
      invoice_id: string;
      invoice_number: string;
      person_id: string;
      amount: string;
      reference_code: string;
      status: string;
      created_at: Date;
    }>`
      select c.id, c.property_id, c.invoice_id, i.number as invoice_number, c.person_id, c.amount::text, c.reference_code,
             c.status, c.created_at
      from payment_claims c join invoices i on i.organization_id = c.organization_id and i.id = c.invoice_id
      where c.organization_id = ${actor.orgId}
        ${input.propertyId ? sql`and c.property_id = ${input.propertyId}` : sql``}
        and c.status = ${input.status ?? "submitted"}
      order by c.created_at limit 200`.execute(trx);
    return r.rows.map((x) => ({
      id: x.id,
      propertyId: x.property_id,
      invoiceId: x.invoice_id,
      invoiceNumber: x.invoice_number,
      personId: x.person_id,
      amount: Number(x.amount),
      referenceCode: x.reference_code,
      status: x.status,
      createdAt: x.created_at,
    }));
  });
}
