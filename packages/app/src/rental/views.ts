// Truy vấn chỉ đọc cho giao diện nhà trọ (PLAN đợt 2 T-117). Phạm vi do RLS của từng bảng quyết định (vai trò + cơ sở được
// giao); không có quyền ghi nào ở đây — mọi thao tác đi qua command (`/api/v1/<module>/<command>`).
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../access/index.ts";

export interface LeaseListItem {
  id: string;
  number: string;
  status: string;
  property_id: string;
  property: string;
  unit: string;
  tenant: string;
  billing_start_on: string;
  rent_amount: number;
}

export async function listLeases(db: Kysely<unknown>, actor: Actor): Promise<LeaseListItem[]> {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<Omit<LeaseListItem, "rent_amount"> & { rent_amount: string }>`
      select l.id, l.number, l.status, l.property_id, p.name as property, u.code as unit, per.full_name as tenant,
             l.billing_start_on::text,
             (select v.rent_amount from lease_versions v where v.organization_id = l.organization_id and v.lease_id = l.id
              order by v.version_no desc limit 1)::text as rent_amount
      from leases l
      join properties p on p.organization_id = l.organization_id and p.id = l.property_id
      join units u on u.organization_id = l.organization_id and u.id = l.unit_id
      join persons per on per.organization_id = l.organization_id and per.id = l.representative_person_id
      where l.organization_id = ${actor.orgId}
      order by p.name, u.code, l.billing_start_on desc`.execute(trx);
    return r.rows.map((x) => ({ ...x, rent_amount: Number(x.rent_amount) }));
  });
}

export interface LeaseExtras {
  unit: string;
  property: string;
  tenant: string;
  tenant_phone: string | null;
  deposit_balance: number | null;
  open_ar: number;
  meters: { kind: string; last: number }[];
  open_shift: boolean;
}

/** Thông tin kèm trang chi tiết hợp đồng: phòng, người thuê, cọc đang giữ, nợ mở, công tơ, ca tiền mặt của người xem. */
export async function leaseExtras(
  db: Kysely<unknown>,
  actor: Actor,
  leaseId: string,
): Promise<LeaseExtras | null> {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<
      Omit<LeaseExtras, "meters" | "deposit_balance" | "open_ar" | "open_shift"> & {
        unit_id: string;
        property_id: string;
        deposit_balance: string | null;
        open_ar: string;
      }
    >`
      select u.code as unit, u.id as unit_id, p.name as property, p.id as property_id, per.full_name as tenant,
             per.phone as tenant_phone,
             (select d.balance from deposits d where d.organization_id = l.organization_id and d.lease_id = l.id)::text
               as deposit_balance,
             (select coalesce(sum(i.open_amount), 0) from invoices i where i.organization_id = l.organization_id
                and i.lease_id = l.id)::text as open_ar
      from leases l
      join properties p on p.organization_id = l.organization_id and p.id = l.property_id
      join units u on u.organization_id = l.organization_id and u.id = l.unit_id
      join persons per on per.organization_id = l.organization_id and per.id = l.representative_person_id
      where l.organization_id = ${actor.orgId} and l.id = ${leaseId}`.execute(trx);
    const row = r.rows[0];
    if (!row) return null;
    const m = await sql<{ kind: string; last: string }>`
      select m.kind, coalesce((select r.value from meter_readings r where r.organization_id = m.organization_id
                                 and r.meter_id = m.id and r.status = 'approved' order by r.read_on desc limit 1),
                              m.initial_value)::text as last
      from meters m where m.organization_id = ${actor.orgId} and m.unit_id = ${row.unit_id} and m.removed_on is null
      order by m.kind`.execute(trx);
    const s = await sql`
      select 1 from shifts where organization_id = ${actor.orgId} and property_id = ${row.property_id}
        and opened_by = ${actor.membershipId} and status = 'open'`.execute(trx);
    return {
      unit: row.unit,
      property: row.property,
      tenant: row.tenant,
      tenant_phone: row.tenant_phone,
      deposit_balance: row.deposit_balance === null ? null : Number(row.deposit_balance),
      open_ar: Number(row.open_ar),
      meters: m.rows.map((x) => ({ kind: x.kind, last: Number(x.last) })),
      open_shift: s.rows.length > 0,
    };
  });
}

export interface RentalProperty {
  id: string;
  name: string;
  open_shift: boolean;
  /** Tháng hiện tại theo múi giờ của cơ sở (`YYYY-MM`) — mặc định ô "Tháng" khi tạo kỳ (AUD-XFEAT-002). */
  local_month: string;
}

/** Cơ sở cho thuê trong phạm vi + người xem có đang mở ca tiền mặt ở đó không. */
export async function rentalProperties(db: Kysely<unknown>, actor: Actor): Promise<RentalProperty[]> {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<RentalProperty>`
      select p.id, p.name,
             exists (select 1 from shifts s where s.organization_id = p.organization_id and s.property_id = p.id
                       and s.opened_by = ${actor.membershipId} and s.status = 'open') as open_shift,
             to_char(now() at time zone p.timezone, 'YYYY-MM') as local_month
      from properties p where p.organization_id = ${actor.orgId} and p.template in ('rental','mixed') and p.archived_at is null
        and (${actor.allProperties} or p.id = any(${[...actor.propertyIds]}::uuid[]))
      order by p.name`.execute(trx);
    return r.rows;
  });
}

export interface PeriodListItem {
  id: string;
  property_id: string;
  property: string;
  period_start: string;
  period_end: string;
  status: string;
  invoices: number;
  total: number;
}

export async function listBillingPeriods(db: Kysely<unknown>, actor: Actor): Promise<PeriodListItem[]> {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<Omit<PeriodListItem, "total"> & { total: string }>`
      select b.id, b.property_id, p.name as property, b.period_start::text, b.period_end::text, b.status,
             (select count(*)::int from invoices i where i.organization_id = b.organization_id and i.billing_period_id = b.id)
               as invoices,
             (select coalesce(sum(i.total), 0) from invoices i where i.organization_id = b.organization_id
                and i.billing_period_id = b.id)::text as total
      from billing_periods b join properties p on p.organization_id = b.organization_id and p.id = b.property_id
      where b.organization_id = ${actor.orgId}
      order by p.name, b.period_start desc`.execute(trx);
    return r.rows.map((x) => ({ ...x, total: Number(x.total) }));
  });
}

export interface OpenInvoice {
  id: string;
  number: string;
  kind: string;
  property_id: string;
  property: string;
  unit: string | null;
  payer_person_id: string;
  payer: string;
  business_date: string;
  total: number;
  open_amount: number;
}

/** Phiếu còn phải thu (số còn lại theo `invoices.open_amount`). */
export async function listOpenInvoices(db: Kysely<unknown>, actor: Actor): Promise<OpenInvoice[]> {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<Omit<OpenInvoice, "total" | "open_amount"> & { total: string; open_amount: string }>`
      select i.id, i.number, i.kind, i.property_id, p.name as property, u.code as unit, i.payer_person_id,
             per.full_name as payer, i.business_date::text, i.total::text, i.open_amount::text
      from invoices i
      join properties p on p.organization_id = i.organization_id and p.id = i.property_id
      join persons per on per.organization_id = i.organization_id and per.id = i.payer_person_id
      left join leases l on l.organization_id = i.organization_id and l.id = i.lease_id
      left join units u on u.organization_id = l.organization_id and u.id = l.unit_id
      where i.organization_id = ${actor.orgId} and i.open_amount > 0
      order by i.business_date, i.number`.execute(trx);
    return r.rows.map((x) => ({ ...x, total: Number(x.total), open_amount: Number(x.open_amount) }));
  });
}

export interface BreakItem {
  id: string;
  property: string;
  reason: string;
  amount: number | null;
  description: string | null;
  created_at: string;
}

/** Hàng chờ đối soát: giao dịch ngân hàng chưa khớp được tự động (SPEC-ledger S-021…). */
export async function listOpenBreaks(db: Kysely<unknown>, actor: Actor): Promise<BreakItem[]> {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<
      Omit<BreakItem, "amount" | "created_at"> & { amount: string | null; created_at: Date }
    >`
      select b.id, p.name as property, b.reason, t.amount::text as amount, t.description, b.created_at
      from reconciliation_breaks b
      join properties p on p.organization_id = b.organization_id and p.id = b.property_id
      left join bank_transactions t on t.organization_id = b.organization_id and t.id = b.bank_transaction_id
      where b.organization_id = ${actor.orgId} and b.status = 'open'
      order by b.created_at`.execute(trx);
    return r.rows.map((x) => ({
      ...x,
      amount: x.amount === null ? null : Number(x.amount),
      created_at: new Date(x.created_at).toISOString(),
    }));
  });
}

export interface PendingPayment {
  id: string;
  property: string;
  method: string;
  purpose: string;
  amount: number;
  payer: string;
  created_at: string;
}

/** Khoản thu đã ghi nhưng chưa xác nhận (vd nhận cọc tiền mặt) — xác nhận mới ghi sổ (INV-F3). */
export async function listPendingPayments(db: Kysely<unknown>, actor: Actor): Promise<PendingPayment[]> {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<Omit<PendingPayment, "amount" | "created_at"> & { amount: string; created_at: Date }>`
      select pm.id, p.name as property, pm.method, pm.purpose, pm.amount::text, per.full_name as payer, pm.created_at
      from payments pm
      join properties p on p.organization_id = pm.organization_id and p.id = pm.property_id
      join persons per on per.organization_id = pm.organization_id and per.id = pm.payer_person_id
      where pm.organization_id = ${actor.orgId} and pm.status = 'pending'
      order by pm.created_at`.execute(trx);
    return r.rows.map((x) => ({
      ...x,
      amount: Number(x.amount),
      created_at: new Date(x.created_at).toISOString(),
    }));
  });
}
