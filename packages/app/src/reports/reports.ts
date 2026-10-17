// PLAN đợt 3 T-221 — báo cáo (SPEC-audit-reporting S-009…S-012, S-019; INV-L*; D-018).
// - Mỗi báo cáo là MỘT câu SQL (một snapshot kể cả ở READ COMMITTED) — chi tiết, tổng và số dư sổ phụ đọc cùng thời
//   điểm; tổng tính ở CSDL, VND số nguyên; trả "số liệu tại" (`asOf`).
// - Công nợ tại ngày chốt d: mỗi phiếu = Σ(Nợ − Có) các dòng AR gắn phiếu đó, bút toán ngày ≤ d (gồm phân bổ, đảo, điều
//   chỉnh giảm — review lát 5 🔴); tách cột đã phân bổ / đã giảm trừ; so tổng với số dư AR toàn phạm vi — trả
//   `ledgerBalance` + `matchesLedger` (dòng AR không gắn phiếu sẽ lộ chênh lệch). Cọc không trừ vào nợ.
// - Thu tiền: chỉ `payments.status = confirmed` theo ngày kinh doanh (tiền đã thu — KHÔNG phải doanh thu).
// - Cọc đang giữ: `deposits.balance > 0`, so với số dư DEPOSIT_LIAB (Σ Có − Nợ).
// - Công suất theo đêm: phòng có allocation lease/stay hiệu lực lúc 23:59:59 giờ cơ sở; khả dụng = phòng chưa lưu trữ
//   trừ phòng bị block lúc đó (Q-04); hold không tính.
// - Quyền: `money.read` mức "Có" (người thuê/khách chỉ "Mình" ⇒ 403) cho báo cáo tiền; công suất thêm `calendar.read_status`
//   bỏ buồng phòng/kỹ thuật (chỉ owner/manager/front_desk/accountant). Cơ sở ngoài phạm vi ⇒ 404.

import { withTenant } from "@hm/db";
import { authorize, MS_PER_DAY, VN_UTC_OFFSET_MS } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../access/index.ts";
import { CommandError } from "../pipeline/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Khoảng tối đa của báo cáo theo khoảng ngày (S-019). */
export const REPORT_MAX_DAYS = 366;

const notFound = () => new CommandError("NOT_FOUND", 404, "Không tìm thấy");
const forbidden = () => new CommandError("FORBIDDEN", 403, "Bạn không có quyền xem báo cáo này");
const badDate = (field: string) =>
  new CommandError("VALIDATION_FAILED", 422, "Ngày không hợp lệ", {
    extensions: { errors: [{ path: field, field, code: "invalid_date" }] },
  });

export function validDate(s: string, field: string): string {
  if (
    !DATE.test(s) ||
    Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ||
    new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s
  )
    throw badDate(field);
  return s;
}

export function reportRange(from: string, to: string): { from: string; to: string; days: number } {
  validDate(from, "from");
  validDate(to, "to");
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY + 1;
  if (days < 1) throw badDate("to");
  if (days > REPORT_MAX_DAYS)
    throw new CommandError(
      "REPORT_RANGE_TOO_LARGE",
      422,
      "Khoảng thời gian quá dài. Hãy chọn ngắn hơn hoặc dùng Xuất dữ liệu.",
    );
  return { from, to, days };
}

/** Báo cáo tiền: vai trò có `money.read` mức đầy đủ (không phải "Mình"). */
function authorizeMoney(actor: Actor, propertyId?: string): void {
  if (authorize(actor, "money.read").grant !== "yes") throw forbidden();
  if (propertyId !== undefined) {
    if (!UUID.test(propertyId)) throw notFound();
    authorize(actor, "money.read", { propertyId });
  }
}

function authorizeOccupancy(actor: Actor, propertyId?: string): void {
  if (!["owner", "manager", "front_desk", "accountant"].includes(actor.role)) throw forbidden();
  authorize(actor, "calendar.read_status");
  if (propertyId !== undefined) {
    if (!UUID.test(propertyId)) throw notFound();
    authorize(actor, "calendar.read_status", { propertyId });
  }
}

/** Cơ sở trong phạm vi (và lọc nếu có) — dùng trong CTE `pr`. */
const scope = (actor: Actor, propertyId?: string) => sql`
  select p.id, p.name, p.timezone from properties p
  where p.organization_id = ${actor.orgId}
    and (${actor.allProperties} or p.id = any(${[...actor.propertyIds]}::uuid[]))
    ${propertyId ? sql`and p.id = ${propertyId}` : sql``}`;

const today = () => new Date(Date.now() + VN_UTC_OFFSET_MS).toISOString().slice(0, 10);

export interface ReceivableRow {
  invoiceId: string;
  number: string;
  propertyId: string;
  propertyName: string;
  payerPersonId: string;
  payerName: string;
  kind: string;
  dueOn: string | null;
  total: number;
  allocated: number;
  /** Đã giảm trừ (điều chỉnh đã duyệt, bút toán ≤ ngày chốt) = tổng − đã phân bổ − còn nợ. */
  adjusted: number;
  balance: number;
  daysOverdue: number;
}

export interface ReceivablesReport {
  asOf: string;
  rows: ReceivableRow[];
  total: number;
  ledgerBalance: number;
  matchesLedger: boolean;
  generatedAt: Date;
}

/** `reports.receivables` (S-009): công nợ tại ngày chốt `asOf` (mặc định hôm nay giờ VN). */
export async function receivables(
  db: Kysely<unknown>,
  actor: Actor,
  input: { asOf?: string; propertyId?: string } = {},
): Promise<ReceivablesReport> {
  authorizeMoney(actor, input.propertyId);
  const asOf = validDate(input.asOf ?? today(), "as_of");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      rows: {
        invoice_id: string;
        number: string;
        property_id: string;
        property_name: string;
        payer_person_id: string;
        payer_name: string;
        kind: string;
        due_on: string | null;
        total: number;
        allocated: number;
        adjusted: number;
        balance: number;
        days_overdue: number;
      }[];
      total: string;
      ledger: string;
      now: Date;
    }>`
      with pr as (${scope(actor, input.propertyId)}),
      inv as (
        select i.id, i.number, i.property_id, pr.name as property_name, i.payer_person_id, pe.full_name as payer_name, i.kind,
               i.due_on, i.total,
               coalesce((select sum(a.amount) from payment_allocations a
                         join journal_entries e on e.organization_id = a.organization_id and e.id = a.entry_id
                         left join journal_entries re on re.organization_id = a.organization_id and re.id = a.reversal_entry_id
                         where a.organization_id = i.organization_id and a.invoice_id = i.id and e.business_date <= ${asOf}::date
                           and (re.id is null or re.business_date > ${asOf}::date)), 0)::bigint as allocated,
               -- Số còn nợ THEO SỔ PHỤ tại ngày chốt: gồm phân bổ, đảo phân bổ, điều chỉnh giảm (Có AR gắn phiếu gốc).
               ar.balance
        from invoices i
        join pr on pr.id = i.property_id
        join persons pe on pe.organization_id = i.organization_id and pe.id = i.payer_person_id
        join lateral (
          select sum(jl.debit - jl.credit)::bigint as balance, count(*) as n from journal_lines jl
          join journal_entries je on je.organization_id = jl.organization_id and je.id = jl.entry_id
          where jl.organization_id = i.organization_id and jl.invoice_id = i.id and jl.account = 'AR'
            and je.business_date <= ${asOf}::date
        ) ar on ar.n > 0
        -- Phiếu điều chỉnh (kind adjustment) không có dòng AR riêng — phần giảm nằm ở phiếu gốc.
        where i.organization_id = ${actor.orgId} and i.business_date <= ${asOf}::date and i.kind <> 'adjustment'
      ), open as (
        select *, (total - allocated - balance)::bigint as adjusted,
               greatest(${asOf}::date - due_on, 0) as days_overdue
        from inv where balance <> 0
      )
      select coalesce((select jsonb_agg(jsonb_build_object(
                 'invoice_id', id, 'number', number, 'property_id', property_id, 'property_name', property_name,
                 'payer_person_id', payer_person_id, 'payer_name', payer_name, 'kind', kind, 'due_on', due_on,
                 'total', total, 'allocated', allocated, 'adjusted', adjusted, 'balance', balance,
                 'days_overdue', coalesce(days_overdue, 0))
               order by days_overdue desc nulls last, number) from open), '[]'::jsonb) as rows,
             coalesce((select sum(balance) from open), 0)::text as total,
             coalesce((select sum(jl.debit - jl.credit) from journal_lines jl
                       join journal_entries je on je.organization_id = jl.organization_id and je.id = jl.entry_id
                       join pr on pr.id = jl.property_id
                       where jl.organization_id = ${actor.orgId} and jl.account = 'AR' and je.business_date <= ${asOf}::date), 0)::text
               as ledger,
             now() as now`.execute(trx);
    const x = r.rows[0];
    const total = Number(x?.total ?? 0);
    const ledgerBalance = Number(x?.ledger ?? 0);
    return {
      asOf,
      rows: (x?.rows ?? []).map((y) => ({
        invoiceId: y.invoice_id,
        number: y.number,
        propertyId: y.property_id,
        propertyName: y.property_name,
        payerPersonId: y.payer_person_id,
        payerName: y.payer_name,
        kind: y.kind,
        dueOn: y.due_on,
        total: Number(y.total),
        allocated: Number(y.allocated),
        adjusted: Number(y.adjusted),
        balance: Number(y.balance),
        daysOverdue: Number(y.days_overdue),
      })),
      total,
      ledgerBalance,
      matchesLedger: total === ledgerBalance,
      generatedAt: x?.now ?? new Date(),
    };
  });
}

export interface CollectionsReport {
  from: string;
  to: string;
  note: string;
  byMethod: { method: "cash" | "bank_transfer"; label: string; amount: number; count: number }[];
  byDay: {
    businessDate: string;
    method: string;
    confirmedBy: string | null;
    amount: number;
    count: number;
  }[];
  total: number;
  generatedAt: Date;
}

const METHOD_LABEL = { cash: "Tiền mặt", bank_transfer: "Chuyển khoản" } as const;

/** `reports.collections` (S-010): tiền đã thu (`confirmed`) theo phương thức, ngày kinh doanh, người xác nhận. */
export async function collections(
  db: Kysely<unknown>,
  actor: Actor,
  input: { from: string; to: string; propertyId?: string },
): Promise<CollectionsReport> {
  authorizeMoney(actor, input.propertyId);
  const { from, to } = reportRange(input.from, input.to);
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      by_method: { method: "cash" | "bank_transfer"; amount: number; count: number }[];
      by_day: {
        business_date: string;
        method: string;
        confirmed_by: string | null;
        amount: number;
        count: number;
      }[];
      total: string;
      now: Date;
    }>`
      with pr as (${scope(actor, input.propertyId)}),
      p as (
        select pa.method, pa.amount, pa.business_date, pe.full_name as confirmed_by
        from payments pa join pr on pr.id = pa.property_id
        left join memberships m on m.organization_id = pa.organization_id and m.id = pa.confirmed_by
        left join persons pe on pe.organization_id = m.organization_id and pe.id = m.person_id
        where pa.organization_id = ${actor.orgId} and pa.status = 'confirmed'
          and pa.business_date between ${from}::date and ${to}::date
      )
      select coalesce((select jsonb_agg(jsonb_build_object('method', method, 'amount', amount, 'count', n) order by method)
                       from (select method, sum(amount)::bigint as amount, count(*)::int as n from p group by method) g), '[]'::jsonb)
               as by_method,
             coalesce((select jsonb_agg(jsonb_build_object('business_date', business_date, 'method', method,
                                                           'confirmed_by', confirmed_by, 'amount', amount, 'count', n)
                                        order by business_date, method, confirmed_by)
                       from (select business_date, method, confirmed_by, sum(amount)::bigint as amount, count(*)::int as n
                             from p group by business_date, method, confirmed_by) d), '[]'::jsonb) as by_day,
             coalesce((select sum(amount) from p), 0)::text as total,
             now() as now`.execute(trx);
    const x = r.rows[0];
    return {
      from,
      to,
      note: "Tiền đã thu — không phải doanh thu",
      byMethod: (x?.by_method ?? []).map((m) => ({
        method: m.method,
        label: METHOD_LABEL[m.method],
        amount: Number(m.amount),
        count: m.count,
      })),
      byDay: (x?.by_day ?? []).map((d) => ({
        businessDate: d.business_date,
        method: d.method,
        confirmedBy: d.confirmed_by,
        amount: Number(d.amount),
        count: d.count,
      })),
      total: Number(x?.total ?? 0),
      generatedAt: x?.now ?? new Date(),
    };
  });
}

export interface DepositsReport {
  rows: {
    depositId: string;
    propertyId: string;
    leaseId: string | null;
    reservationId: string | null;
    payerName: string;
    amount: number;
    deducted: number;
    refunded: number;
    balance: number;
  }[];
  total: number;
  ledgerBalance: number;
  matchesLedger: boolean;
  generatedAt: Date;
}

/** `reports.depositsHeld` (S-011): cọc đang giữ theo hợp đồng/lượt đặt; so với DEPOSIT_LIAB. */
export async function depositsHeld(
  db: Kysely<unknown>,
  actor: Actor,
  input: { propertyId?: string } = {},
): Promise<DepositsReport> {
  authorizeMoney(actor, input.propertyId);
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      rows: {
        deposit_id: string;
        property_id: string;
        lease_id: string | null;
        reservation_id: string | null;
        payer_name: string;
        amount: number;
        deducted: number;
        refunded: number;
        balance: number;
      }[];
      total: string;
      ledger: string;
      now: Date;
    }>`
      with pr as (${scope(actor, input.propertyId)}),
      d as (
        select d.id, d.property_id, d.lease_id, d.reservation_id, pe.full_name as payer_name, d.amount, d.deducted_total,
               d.refunded_total, d.balance
        from deposits d join pr on pr.id = d.property_id
        join persons pe on pe.organization_id = d.organization_id and pe.id = d.payer_person_id
        where d.organization_id = ${actor.orgId} and d.balance > 0
      )
      select coalesce((select jsonb_agg(jsonb_build_object('deposit_id', id, 'property_id', property_id, 'lease_id', lease_id,
                                                           'reservation_id', reservation_id, 'payer_name', payer_name,
                                                           'amount', amount, 'deducted', deducted_total,
                                                           'refunded', refunded_total, 'balance', balance)
                                        order by payer_name, id) from d), '[]'::jsonb) as rows,
             coalesce((select sum(balance) from d), 0)::text as total,
             coalesce((select sum(jl.credit - jl.debit) from journal_lines jl join pr on pr.id = jl.property_id
                       where jl.organization_id = ${actor.orgId} and jl.account = 'DEPOSIT_LIAB'), 0)::text as ledger,
             now() as now`.execute(trx);
    const x = r.rows[0];
    const total = Number(x?.total ?? 0);
    const ledgerBalance = Number(x?.ledger ?? 0);
    return {
      rows: (x?.rows ?? []).map((y) => ({
        depositId: y.deposit_id,
        propertyId: y.property_id,
        leaseId: y.lease_id,
        reservationId: y.reservation_id,
        payerName: y.payer_name,
        amount: Number(y.amount),
        deducted: Number(y.deducted),
        refunded: Number(y.refunded),
        balance: Number(y.balance),
      })),
      total,
      ledgerBalance,
      matchesLedger: total === ledgerBalance,
      generatedAt: x?.now ?? new Date(),
    };
  });
}

export interface OccupancyRow {
  propertyId: string;
  propertyName: string;
  date: string;
  units: number;
  blocked: number;
  available: number;
  occupied: number;
  /** Phần trăm, 1 chữ số thập phân (null khi không có phòng khả dụng). */
  rate: number | null;
}

/** `reports.occupancy` (S-012): theo ngày × cơ sở. Công thức ghi kèm báo cáo (Q-04). */
export async function occupancy(
  db: Kysely<unknown>,
  actor: Actor,
  input: { from: string; to: string; propertyId?: string },
): Promise<{ rows: OccupancyRow[]; formula: string; generatedAt: Date }> {
  authorizeOccupancy(actor, input.propertyId);
  const { from, to } = reportRange(input.from, input.to);
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      property_id: string;
      property_name: string;
      date: string;
      units: number;
      blocked: number;
      occupied: number;
      rate: string | null;
      now: Date;
    }>`
      with pr as (${scope(actor, input.propertyId)}),
      days as (select g::date as d from generate_series(${from}::date, ${to}::date, interval '1 day') g),
      pd as (select pr.id, pr.name, days.d, ((days.d + time '23:59:59') at time zone pr.timezone) as at from pr cross join days),
      u as (
        select pd.id, pd.d, un.id as unit_id,
               exists (select 1 from allocations a where a.organization_id = un.organization_id and a.unit_id = un.id
                         and a.kind = 'block' and a.during @> pd.at and (a.active or a.deactivated_at > pd.at)) as blocked,
               exists (select 1 from allocations a where a.organization_id = un.organization_id and a.unit_id = un.id
                         and a.kind in ('lease','stay') and a.during @> pd.at and (a.active or a.deactivated_at > pd.at)) as occupied
        from pd join units un on un.organization_id = ${actor.orgId} and un.property_id = pd.id
          -- Phòng chỉ tính từ khi có (tạo) tới khi lưu trữ — ngày quá khứ không đếm phòng tạo sau (review lát 5 🟢8).
          and un.created_at <= pd.at and (un.archived_at is null or un.archived_at > pd.at)
      )
      select pd.id as property_id, pd.name as property_name, pd.d::text as date,
             count(u.unit_id)::int as units, count(*) filter (where u.blocked)::int as blocked,
             count(*) filter (where u.occupied and not u.blocked)::int as occupied,
             round(count(*) filter (where u.occupied and not u.blocked) * 100.0
                   / nullif(count(u.unit_id) - count(*) filter (where u.blocked), 0), 1)::text as rate,
             now() as now
      from pd left join u on u.id = pd.id and u.d = pd.d
      group by pd.id, pd.name, pd.d
      order by pd.d, pd.name, pd.id`.execute(trx);
    return {
      rows: r.rows.map((x) => {
        const available = x.units - x.blocked;
        return {
          propertyId: x.property_id,
          propertyName: x.property_name,
          date: x.date,
          units: x.units,
          blocked: x.blocked,
          available,
          occupied: x.occupied,
          rate: x.rate === null ? null : Number(x.rate),
        };
      }),
      formula:
        "Công suất = phòng đang ở (hợp đồng/lượt ở hiệu lực lúc 23:59:59 giờ cơ sở) ÷ phòng khả dụng (phòng chưa lưu trữ trừ phòng bị chặn); giữ chỗ không tính là đang ở.",
      generatedAt: r.rows[0]?.now ?? new Date(),
    };
  });
}
