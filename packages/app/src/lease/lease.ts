// Hợp đồng thuê dài hạn — soạn, người ở, giữ chỗ, ký (PLAN đợt 2 T-109; SPEC-lease S-001…S-004, S-008…S-010, S-020,
// S-022…S-024; DOMAIN-MODEL §4). Bốn mốc ngày tách biệt: `signed_on`, `billing_start_on`, ngày bàn giao (`handovers`, T-110),
// `moved_out_on` (T-111). Chống chồng phòng nằm ở `allocations` (INV-I1): ký = xác nhận hold của hợp đồng hoặc tạo allocation
// `lease` mới — chồng ⇒ ROOM_UNAVAILABLE. Mốc giờ allocation: 00:00 giờ cơ sở của ngày hiệu lực → 00:00 của (ngày hết hạn + 1).
import { createHash, randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize, leaseMachine } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import { confirmHold, createHold, type Interval } from "../inventory/inventory.ts";
import { type CommandContext, canonicalJson } from "../pipeline/command.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type LeaseStatus = (typeof leaseMachine.states)[number];

function assertDate(d: string, field: string): void {
  const t = new Date(`${d}T00:00:00Z`);
  if (!DATE.test(d) || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) {
    throw fieldError(field, "INVALID_DATE", `${field}: ngày không hợp lệ (YYYY-MM-DD)`);
  }
}

function assertMoney(n: number, field: string): void {
  if (!Number.isSafeInteger(n) || n < 0)
    throw fieldError(field, "INVALID_AMOUNT", `${field}: số nguyên đồng ≥ 0`);
}

export interface LeaseServiceTerm {
  serviceId: string;
  quantity: number;
  /** Giá riêng của hợp đồng (đồng); bỏ trống = theo bảng giá cơ sở. */
  unitPrice?: number;
}

export interface LeaseTerms {
  effectiveFrom: string;
  /** NULL = không thời hạn. Ngày này GỒM trong hiệu lực. */
  effectiveTo: string | null;
  rentAmount: number;
  depositAmount: number;
  services: readonly LeaseServiceTerm[];
}

export const LEASE_LIMITS = { services: 30, occupants: 20 } as const;

export async function validateTerms(
  ctx: CommandContext,
  propertyId: string,
  t: LeaseTerms,
  prefix = "terms",
): Promise<void> {
  assertDate(t.effectiveFrom, `${prefix}.effective_from`);
  if (t.effectiveTo !== null) {
    assertDate(t.effectiveTo, `${prefix}.effective_to`);
    if (t.effectiveTo < t.effectiveFrom) {
      throw fieldError(`${prefix}.effective_to`, "BEFORE_START", "Ngày hết hạn phải ≥ ngày hiệu lực");
    }
  }
  assertMoney(t.rentAmount, `${prefix}.rent_amount`);
  assertMoney(t.depositAmount, `${prefix}.deposit_amount`);
  if (t.services.length > LEASE_LIMITS.services) {
    throw fieldError(`${prefix}.services`, "TOO_MANY", `Tối đa ${LEASE_LIMITS.services} dịch vụ`);
  }
  const ids = new Set<string>();
  t.services.forEach((s, i) => {
    if (!UUID.test(s.serviceId) || ids.has(s.serviceId)) {
      throw fieldError(`${prefix}.services[${i}].service_id`, "INVALID", "Dịch vụ không hợp lệ hoặc lặp");
    }
    ids.add(s.serviceId);
    if (!Number.isInteger(s.quantity) || s.quantity < 0 || s.quantity > 1000) {
      throw fieldError(`${prefix}.services[${i}].quantity`, "INVALID", "Số lượng không hợp lệ");
    }
    if (s.unitPrice !== undefined) assertMoney(s.unitPrice, `${prefix}.services[${i}].unit_price`);
  });
  if (ids.size > 0) {
    const r = await sql<{ id: string }>`
      select id from services where organization_id = ${ctx.actor.orgId} and property_id = ${propertyId}
        and archived_at is null and id = any(${[...ids]}::uuid[])`.execute(ctx.trx);
    const found = new Set(r.rows.map((x) => x.id));
    const i = t.services.findIndex((s) => !found.has(s.serviceId));
    if (i >= 0)
      throw fieldError(`${prefix}.services[${i}].service_id`, "NOT_FOUND", "Dịch vụ không thuộc cơ sở");
  }
}

export function servicesJson(services: readonly LeaseServiceTerm[]): string {
  return JSON.stringify(
    services.map((s) => ({
      service_id: s.serviceId,
      quantity: s.quantity,
      ...(s.unitPrice === undefined ? {} : { unit_price: s.unitPrice }),
    })),
  );
}

/** Người đứng/ở hợp đồng: có trong tổ chức; người thuê (primary/co_tenant) bắt buộc SĐT (SPEC-lease §4). */
async function assertPerson(
  ctx: CommandContext,
  personId: string,
  field: string,
  requirePhone: boolean,
): Promise<void> {
  if (!UUID.test(personId)) throw fieldError(field, "INVALID", "Người không hợp lệ");
  const r = await sql<{ phone: string | null }>`
    select phone from persons where organization_id = ${ctx.actor.orgId} and id = ${personId} and anonymized_at is null`.execute(
    ctx.trx,
  );
  const p = r.rows[0];
  if (!p) throw fieldError(field, "NOT_FOUND", "Không tìm thấy người");
  if (requirePhone && !p.phone)
    throw fieldError(`${field}.phone`, "REQUIRED", "Người thuê cần số điện thoại");
}

export interface LeaseRow {
  id: string;
  property_id: string;
  unit_id: string;
  number: string;
  status: LeaseStatus;
  signed_on: string | null;
  billing_start_on: string;
  representative_person_id: string;
}

/** Đọc (RLS) → kiểm quyền → khoá: người không có quyền nhận 403 thay vì chờ khoá; không đọc được ⇒ 404. */
export async function lockLease(
  ctx: CommandContext,
  leaseId: string,
  action: "lease.manage" | "lease.hold" | "lease.handover",
): Promise<LeaseRow> {
  if (!UUID.test(leaseId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy hợp đồng");
  const read = (lock: boolean) =>
    sql<LeaseRow>`
      select id, property_id, unit_id, number, status, signed_on::text, billing_start_on::text, representative_person_id
      from leases where organization_id = ${ctx.actor.orgId} and id = ${leaseId} ${lock ? sql`for update` : sql``}`.execute(
      ctx.trx,
    );
  const seen = (await read(false)).rows[0];
  if (!seen) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy hợp đồng");
  authorize(ctx.actor, action, { propertyId: seen.property_id });
  // Giữ chỗ/bàn giao không đổi hàng hợp đồng (lễ tân không ghi `leases` nên không khoá được): tuần tự hoá bằng khoá phòng +
  // EXCLUDE của allocations (giữ chỗ), UNIQUE (lease_id, kind) của handovers (bàn giao).
  if (action !== "lease.manage") return seen;
  const row = (await read(true)).rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy hợp đồng");
  return row;
}

export function transition(row: LeaseRow, to: LeaseStatus): void {
  leaseMachine.assertTransition(row.status, to);
}

interface VersionRow {
  id: string;
  version_no: number;
  effective_from: string;
  effective_to: string | null;
  rent_amount: string;
  deposit_amount: string;
  billing_cycle: string;
  services: unknown;
  signed_at: Date | null;
}

export async function originalVersion(ctx: CommandContext, leaseId: string): Promise<VersionRow> {
  const r = await sql<VersionRow>`
    select id, version_no, effective_from::text, effective_to::text, rent_amount, deposit_amount, billing_cycle, services, signed_at
    from lease_versions where organization_id = ${ctx.actor.orgId} and lease_id = ${leaseId} and version_no = 1`.execute(
    ctx.trx,
  );
  const v = r.rows[0];
  if (!v) throw new Error(`hợp đồng ${leaseId} thiếu phiên bản 1`);
  return v;
}

/** [00:00 giờ cơ sở ngày `from`, 00:00 giờ cơ sở ngày `to + 1`) — `to` null ⇒ khoảng mở. */
export async function leaseInterval(
  trx: Transaction<unknown>,
  orgId: string,
  propertyId: string,
  from: string,
  to: string | null,
): Promise<Interval> {
  const r = await sql<{ s: Date; e: Date | null }>`
    select (${from}::date::timestamp at time zone p.timezone) as s,
           case when ${to}::date is null then null else ((${to}::date + 1)::timestamp at time zone p.timezone) end as e
    from properties p where p.organization_id = ${orgId} and p.id = ${propertyId}`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  return { start: new Date(row.s), end: row.e ? new Date(row.e) : null };
}

export interface CreateDraftInput {
  unitId: string;
  representativePersonId: string;
  signedOn?: string;
  billingStartOn: string;
  terms: LeaseTerms;
  occupants?: readonly { personId: string; role: "co_tenant" | "occupant" }[];
}

/** `lease.createDraft` (S-001): hợp đồng `draft` + phiên bản 1 + người đại diện; chưa giữ phòng. */
export async function createDraft(
  ctx: CommandContext,
  input: CreateDraftInput,
): Promise<{ leaseId: string; number: string; versionNo: 1 }> {
  if (!UUID.test(input.unitId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  const u = await sql<{ property_id: string; archived_at: Date | null }>`
    select property_id, archived_at from units where organization_id = ${ctx.actor.orgId} and id = ${input.unitId}`.execute(
    ctx.trx,
  );
  const unit = u.rows[0];
  if (!unit || unit.archived_at) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  authorize(ctx.actor, "lease.manage", { propertyId: unit.property_id });
  assertDate(input.billingStartOn, "billing_start_on");
  if (input.signedOn !== undefined) assertDate(input.signedOn, "signed_on");
  await validateTerms(ctx, unit.property_id, input.terms);
  await assertPerson(ctx, input.representativePersonId, "representative_person_id", true);
  const occupants = input.occupants ?? [];
  if (occupants.length + 1 > LEASE_LIMITS.occupants) {
    throw fieldError("occupants", "TOO_MANY", `Tối đa ${LEASE_LIMITS.occupants} người ở`);
  }
  const seen = new Set([input.representativePersonId]);
  for (const [i, o] of occupants.entries()) {
    if (seen.has(o.personId)) throw fieldError(`occupants[${i}].person_id`, "DUPLICATE", "Người ở bị lặp");
    seen.add(o.personId);
    await assertPerson(ctx, o.personId, `occupants[${i}].person_id`, o.role === "co_tenant");
  }

  const n = await sql<{ n: string }>`
    select app.next_number(${ctx.actor.orgId}, ${unit.property_id}, 'lease')::text as n`.execute(ctx.trx);
  const number = `HD-${String(n.rows[0]?.n).padStart(6, "0")}`;
  const leaseId = randomUUID();
  await sql`
    insert into leases (id, organization_id, property_id, unit_id, number, signed_on, billing_start_on, representative_person_id,
                        created_by, command_id)
    values (${leaseId}, ${ctx.actor.orgId}, ${unit.property_id}, ${input.unitId}, ${number}, ${input.signedOn ?? null}::date,
            ${input.billingStartOn}::date, ${input.representativePersonId}, ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(
    ctx.trx,
  );
  await sql`
    insert into lease_versions (id, organization_id, property_id, lease_id, version_no, kind, effective_from, effective_to,
                                rent_amount, deposit_amount, services, created_by, command_id)
    values (${randomUUID()}, ${ctx.actor.orgId}, ${unit.property_id}, ${leaseId}, 1, 'original', ${input.terms.effectiveFrom}::date,
            ${input.terms.effectiveTo}::date, ${input.terms.rentAmount}, ${input.terms.depositAmount},
            ${servicesJson(input.terms.services)}::jsonb, ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(
    ctx.trx,
  );
  const insertOccupant = (personId: string, role: string, rep: boolean) =>
    sql`
      insert into lease_occupants (id, organization_id, property_id, lease_id, person_id, role, is_representative, from_on)
      values (${randomUUID()}, ${ctx.actor.orgId}, ${unit.property_id}, ${leaseId}, ${personId}, ${role}, ${rep},
              ${input.terms.effectiveFrom}::date)`.execute(ctx.trx);
  await insertOccupant(input.representativePersonId, "primary", true);
  for (const o of occupants) await insertOccupant(o.personId, o.role, false);
  await ctx.audit({
    action: "lease.created",
    entityType: "lease",
    entityId: leaseId,
    propertyId: unit.property_id,
    after: {
      number,
      unit_id: input.unitId,
      rent_amount: input.terms.rentAmount,
      deposit_amount: input.terms.depositAmount,
    },
  });
  await ctx.emit({
    eventType: "lease.created",
    aggregateType: "lease",
    aggregateId: leaseId,
    propertyId: unit.property_id,
    payload: { lease_id: leaseId },
  });
  return { leaseId, number, versionNo: 1 };
}

/** `lease.updateDraft` (S-003): sửa điều khoản phiên bản 1 khi chưa ký; đã ký ⇒ DOCUMENT_IMMUTABLE (lập phụ lục). */
export async function updateDraft(
  ctx: CommandContext,
  input: { leaseId: string; billingStartOn?: string; signedOn?: string | null; terms: LeaseTerms },
): Promise<{ leaseId: string; versionNo: 1 }> {
  const lease = await lockLease(ctx, input.leaseId, "lease.manage");
  const v = await originalVersion(ctx, lease.id);
  if (v.signed_at || !["draft", "pending_signature"].includes(lease.status)) {
    throw new CommandError(
      "DOCUMENT_IMMUTABLE",
      409,
      "Điều khoản đã ký không sửa được. Hãy lập phụ lục (lease.renew).",
    );
  }
  await validateTerms(ctx, lease.property_id, input.terms);
  if (input.billingStartOn !== undefined) assertDate(input.billingStartOn, "billing_start_on");
  if (input.signedOn) assertDate(input.signedOn, "signed_on");
  await sql`
    update lease_versions set effective_from = ${input.terms.effectiveFrom}::date, effective_to = ${input.terms.effectiveTo}::date,
           rent_amount = ${input.terms.rentAmount}, deposit_amount = ${input.terms.depositAmount},
           services = ${servicesJson(input.terms.services)}::jsonb
    where id = ${v.id}`.execute(ctx.trx);
  await sql`
    update leases set billing_start_on = coalesce(${input.billingStartOn ?? null}::date, billing_start_on),
           signed_on = ${input.signedOn === undefined ? sql`signed_on` : sql`${input.signedOn}::date`}, version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${lease.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "lease.draft_updated",
    entityType: "lease",
    entityId: lease.id,
    propertyId: lease.property_id,
    before: {
      rent_amount: Number(v.rent_amount),
      effective_from: v.effective_from,
      effective_to: v.effective_to,
    },
    after: {
      rent_amount: input.terms.rentAmount,
      effective_from: input.terms.effectiveFrom,
      effective_to: input.terms.effectiveTo,
    },
  });
  return { leaseId: lease.id, versionNo: 1 };
}

/** `lease.addOccupant` (S-008): PII tối thiểu — họ tên (+ SĐT với người thuê); giấy tờ tuỳ chọn ở `identity_documents`. */
export async function addOccupant(
  ctx: CommandContext,
  input: { leaseId: string; personId: string; role: "co_tenant" | "occupant"; fromOn: string },
): Promise<{ occupantId: string }> {
  const lease = await lockLease(ctx, input.leaseId, "lease.manage");
  if (["closed", "cancelled"].includes(lease.status)) {
    throw new CommandError("INVALID_TRANSITION", 409, "Hợp đồng đã kết thúc", {
      extensions: { from: lease.status },
    });
  }
  assertDate(input.fromOn, "from_on");
  await assertPerson(ctx, input.personId, "person_id", input.role === "co_tenant");
  const count = await sql<{ n: number }>`
    select count(*)::int as n from lease_occupants
    where organization_id = ${ctx.actor.orgId} and lease_id = ${lease.id} and to_on is null`.execute(ctx.trx);
  if ((count.rows[0]?.n ?? 0) >= LEASE_LIMITS.occupants) {
    throw fieldError("person_id", "TOO_MANY", `Tối đa ${LEASE_LIMITS.occupants} người ở`);
  }
  const id = randomUUID();
  try {
    await sql`savepoint add_occupant`.execute(ctx.trx);
    await sql`
      insert into lease_occupants (id, organization_id, property_id, lease_id, person_id, role, from_on)
      values (${id}, ${ctx.actor.orgId}, ${lease.property_id}, ${lease.id}, ${input.personId}, ${input.role},
              ${input.fromOn}::date)`.execute(ctx.trx);
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw fieldError("person_id", "DUPLICATE", "Người này đã ở hợp đồng");
    throw e;
  }
  await ctx.audit({
    action: "lease.occupant_added",
    entityType: "lease",
    entityId: lease.id,
    propertyId: lease.property_id,
    after: { occupant_id: id, role: input.role },
  });
  return { occupantId: id };
}

/** `lease.removeOccupant`: đặt ngày rời đi (không xoá dòng); không rời người đại diện (đổi người đứng = phụ lục). */
export async function removeOccupant(
  ctx: CommandContext,
  input: { leaseId: string; personId: string; toOn: string },
): Promise<{ occupantId: string }> {
  const lease = await lockLease(ctx, input.leaseId, "lease.manage");
  assertDate(input.toOn, "to_on");
  const r = await sql<{ id: string; is_representative: boolean; from_on: string }>`
    select id, is_representative, from_on::text from lease_occupants
    where organization_id = ${ctx.actor.orgId} and lease_id = ${lease.id} and person_id = ${input.personId} and to_on is null`.execute(
    ctx.trx,
  );
  const o = r.rows[0];
  if (!o) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy người ở");
  if (o.is_representative)
    throw fieldError("person_id", "REPRESENTATIVE", "Không thể rời người đứng hợp đồng");
  if (input.toOn < o.from_on) throw fieldError("to_on", "BEFORE_START", "Ngày rời đi trước ngày vào ở");
  await sql`update lease_occupants set to_on = ${input.toOn}::date where id = ${o.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "lease.occupant_removed",
    entityType: "lease",
    entityId: lease.id,
    propertyId: lease.property_id,
    after: { occupant_id: o.id, to_on: input.toOn },
  });
  return { occupantId: o.id };
}

/** `lease.submitForSignature`: draft → pending_signature. */
export async function submitForSignature(
  ctx: CommandContext,
  input: { leaseId: string },
): Promise<{ status: LeaseStatus }> {
  const lease = await lockLease(ctx, input.leaseId, "lease.manage");
  transition(lease, "pending_signature");
  await sql`update leases set status = 'pending_signature', version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${lease.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "lease.submitted",
    entityType: "lease",
    entityId: lease.id,
    propertyId: lease.property_id,
    before: { status: lease.status },
    after: { status: "pending_signature" },
  });
  return { status: "pending_signature" };
}

export async function leaseAllocations(ctx: CommandContext, leaseId: string) {
  const r = await sql<{
    id: string;
    kind: string;
    active: boolean;
    expires_at: Date | null;
    deactivated_reason: string | null;
  }>`
    select id, kind, active, expires_at, deactivated_reason from allocations
    where organization_id = ${ctx.actor.orgId} and source_type = 'lease' and source_id = ${leaseId}
    order by created_at desc, id`.execute(ctx.trx);
  return r.rows;
}

/**
 * `lease.hold` (S-023, S-024): giữ phòng cho hợp đồng chưa ký bằng allocation `hold` (TTL `properties.lease_hold_ttl_hours`,
 * so hạn bằng UTC). Hợp đồng không đổi trạng thái. Phòng đang có người/đang được giữ ⇒ ROOM_UNAVAILABLE.
 */
export async function holdLease(
  ctx: CommandContext,
  input: { leaseId: string; now?: Date },
): Promise<{ allocationId: string; expiresAt: Date }> {
  const lease = await lockLease(ctx, input.leaseId, "lease.hold");
  if (!["draft", "pending_signature"].includes(lease.status)) {
    throw new CommandError("INVALID_TRANSITION", 409, "Chỉ giữ chỗ hợp đồng chưa ký", {
      extensions: { from: lease.status },
    });
  }
  const now = input.now ?? new Date();
  const current = (await leaseAllocations(ctx, lease.id)).find(
    (a) => a.active && a.kind === "hold" && (a.expires_at as Date).getTime() > now.getTime(),
  );
  if (current) throw new CommandError("INVALID_TRANSITION", 409, "Hợp đồng đang được giữ chỗ");
  const v = await originalVersion(ctx, lease.id);
  const ttl = await sql<{ h: number }>`
    select lease_hold_ttl_hours as h from properties where organization_id = ${ctx.actor.orgId} and id = ${lease.property_id}`.execute(
    ctx.trx,
  );
  const during = await leaseInterval(
    ctx.trx,
    ctx.actor.orgId,
    lease.property_id,
    v.effective_from,
    v.effective_to,
  );
  const r = await createHold(ctx, {
    unitId: lease.unit_id,
    during,
    ttlMinutes: (ttl.rows[0]?.h ?? 48) * 60,
    sourceType: "lease",
    sourceId: lease.id,
    now,
  });
  await ctx.audit({
    action: "lease.held",
    entityType: "lease",
    entityId: lease.id,
    propertyId: lease.property_id,
    after: { allocation_id: r.allocationId, expires_at: r.expiresAt.toISOString() },
  });
  return r;
}

/**
 * `lease.sign` (S-002, S-004, S-022, S-024): pending_signature → signed_awaiting_handover; đóng băng phiên bản 1
 * (`terms_snapshot`, `terms_hash` SHA-256); giữ phòng: hold của hợp đồng (còn hạn) chuyển thành `lease` trong cùng câu lệnh,
 * hold đã hết hạn ⇒ HOLD_EXPIRED (phải giữ lại), chưa từng giữ ⇒ tạo allocation `lease`; chồng ⇒ ROOM_UNAVAILABLE.
 */
export async function signLease(
  ctx: CommandContext,
  input: { leaseId: string; signerPersonId: string; signedOn?: string; now?: Date },
): Promise<{ status: LeaseStatus; allocationId: string; termsHash: string }> {
  const lease = await lockLease(ctx, input.leaseId, "lease.manage");
  transition(lease, "signed_awaiting_handover");
  if (input.signerPersonId !== lease.representative_person_id) {
    throw fieldError("signer_person_id", "NOT_REPRESENTATIVE", "Người ký phải là người đứng hợp đồng");
  }
  if (input.signedOn !== undefined) assertDate(input.signedOn, "signed_on");
  const now = input.now ?? new Date();
  const v = await originalVersion(ctx, lease.id);
  const during = await leaseInterval(
    ctx.trx,
    ctx.actor.orgId,
    lease.property_id,
    v.effective_from,
    v.effective_to,
  );

  const allocs = await leaseAllocations(ctx, lease.id);
  const hold = allocs.find((a) => a.active && a.kind === "hold");
  let allocationId: string;
  if (hold) {
    await confirmHold(ctx, hold.id, "lease", now, during); // hết hạn ⇒ HOLD_EXPIRED
    allocationId = hold.id;
  } else if (allocs.some((a) => a.kind === "hold" && a.deactivated_reason === "expired")) {
    throw new CommandError("HOLD_EXPIRED", 409, "Thời gian giữ phòng đã hết. Vui lòng giữ lại.");
  } else {
    const u =
      await sql`select 1 from units where organization_id = ${ctx.actor.orgId} and id = ${lease.unit_id} for update`.execute(
        ctx.trx,
      );
    if (u.rows.length === 0) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
    allocationId = randomUUID();
    try {
      await sql`savepoint lease_alloc`.execute(ctx.trx);
      await sql`
        insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during, created_by)
        values (${allocationId}, ${ctx.actor.orgId}, ${lease.property_id}, ${lease.unit_id}, 'lease', 'lease', ${lease.id},
                tstzrange(${during.start}, ${during.end}, '[)'), ${ctx.actor.membershipId})`.execute(ctx.trx);
    } catch (e) {
      if ((e as { code?: string }).code === "23P01") {
        throw new CommandError(
          "ROOM_UNAVAILABLE",
          409,
          "Phòng đã có người hoặc đã được giữ trong khoảng này",
        );
      }
      throw e;
    }
  }

  const signedOn =
    input.signedOn ??
    lease.signed_on ??
    (
      await sql<{
        d: string;
      }>`select app.business_date(${ctx.actor.orgId}, ${lease.property_id})::text as d`.execute(ctx.trx)
    ).rows[0]?.d;
  const occupants = await sql<{
    person_id: string;
    role: string;
    is_representative: boolean;
    from_on: string;
  }>`
    select person_id, role, is_representative, from_on::text from lease_occupants
    where organization_id = ${ctx.actor.orgId} and lease_id = ${lease.id} and to_on is null order by person_id`.execute(
    ctx.trx,
  );
  const snapshot = {
    lease_id: lease.id,
    number: lease.number,
    unit_id: lease.unit_id,
    representative_person_id: lease.representative_person_id,
    signed_on: signedOn,
    billing_start_on: lease.billing_start_on,
    version_no: v.version_no,
    effective_from: v.effective_from,
    effective_to: v.effective_to,
    rent_amount: Number(v.rent_amount),
    deposit_amount: Number(v.deposit_amount),
    billing_cycle: v.billing_cycle,
    services: v.services,
    occupants: occupants.rows,
  };
  const termsHash = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
  await sql`
    update lease_versions set terms_snapshot = ${canonicalJson(snapshot)}::jsonb, terms_hash = ${termsHash}, signed_at = ${now}
    where id = ${v.id}`.execute(ctx.trx);
  await sql`
    update leases set status = 'signed_awaiting_handover', signed_on = ${signedOn}::date, version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${lease.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "lease.signed",
    entityType: "lease",
    entityId: lease.id,
    propertyId: lease.property_id,
    before: { status: lease.status },
    after: { status: "signed_awaiting_handover", allocation_id: allocationId, terms_hash: termsHash },
  });
  await ctx.emit({
    eventType: "lease.signed",
    aggregateType: "lease",
    aggregateId: lease.id,
    propertyId: lease.property_id,
    payload: { lease_id: lease.id, allocation_id: allocationId },
  });
  return { status: "signed_awaiting_handover", allocationId, termsHash };
}

/** `lease.cancel`: draft/pending_signature/signed_awaiting_handover → cancelled, có lý do; nhả hold/allocation của hợp đồng. */
export async function cancelLease(
  ctx: CommandContext,
  input: { leaseId: string; reason: string; now?: Date },
): Promise<{ status: LeaseStatus; released: string[] }> {
  const lease = await lockLease(ctx, input.leaseId, "lease.manage");
  transition(lease, "cancelled");
  const reason = input.reason.trim();
  if (!reason) throw fieldError("reason", "REQUIRED", "Cần lý do huỷ");
  const now = input.now ?? new Date();
  const released = await sql<{ id: string }>`
    update allocations set active = false, deactivated_at = ${now}, deactivated_reason = 'cancelled'
    where organization_id = ${ctx.actor.orgId} and source_type = 'lease' and source_id = ${lease.id} and active
    returning id`.execute(ctx.trx);
  await sql`update leases set status = 'cancelled', cancel_reason = ${reason}, version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${lease.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "lease.cancelled",
    entityType: "lease",
    entityId: lease.id,
    propertyId: lease.property_id,
    before: { status: lease.status },
    after: { status: "cancelled", released: released.rows.map((r) => r.id) },
    reason,
  });
  return { status: "cancelled", released: released.rows.map((r) => r.id) };
}

export interface LeaseView {
  id: string;
  number: string;
  property_id: string;
  unit_id: string;
  status: LeaseStatus;
  signed_on: string | null;
  billing_start_on: string;
  planned_move_out_on: string | null;
  moved_out_on: string | null;
  representative_person_id: string;
  versions: {
    version_no: number;
    kind: string;
    effective_from: string;
    effective_to: string | null;
    rent_amount: number;
    deposit_amount: number;
    billing_cycle: string;
    services: unknown;
    terms_hash: string | null;
    signed_at: string | null;
  }[];
  occupants: {
    person_id: string;
    role: string;
    is_representative: boolean;
    from_on: string;
    to_on: string | null;
  }[];
  /** Biên bản bàn giao (S-010: người thuê xem hợp đồng và biên bản của mình). */
  handovers: {
    id: string;
    kind: string;
    handed_over_on: string;
    assets: unknown;
    keys_count: number;
    confirmed_at: string | null;
    confirmed_by_tenant_at: string | null;
  }[];
}

/** `lease.get` (S-010): RLS quyết ai đọc được — người thuê chỉ hợp đồng mình đứng tên; không đọc được ⇒ 404. */
export async function getLease(db: Kysely<unknown>, actor: Actor, leaseId: string): Promise<LeaseView> {
  if (!UUID.test(leaseId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy hợp đồng");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const l = await sql<Omit<LeaseView, "versions" | "occupants" | "handovers">>`
      select id, number, property_id, unit_id, status, signed_on::text, billing_start_on::text, planned_move_out_on::text,
             moved_out_on::text, representative_person_id
      from leases where organization_id = ${actor.orgId} and id = ${leaseId}`.execute(trx);
    const lease = l.rows[0];
    if (!lease) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy hợp đồng");
    const v = await sql<{
      version_no: number;
      kind: string;
      effective_from: string;
      effective_to: string | null;
      rent_amount: string;
      deposit_amount: string;
      billing_cycle: string;
      services: unknown;
      terms_hash: string | null;
      signed_at: Date | null;
    }>`
      select version_no, kind, effective_from::text, effective_to::text, rent_amount, deposit_amount, billing_cycle, services,
             terms_hash, signed_at
      from lease_versions where organization_id = ${actor.orgId} and lease_id = ${leaseId} order by version_no`.execute(
      trx,
    );
    const o = await sql<LeaseView["occupants"][number]>`
      select person_id, role, is_representative, from_on::text, to_on::text from lease_occupants
      where organization_id = ${actor.orgId} and lease_id = ${leaseId} order by is_representative desc, from_on, person_id`.execute(
      trx,
    );
    const h = await sql<{
      id: string;
      kind: string;
      handed_over_on: string;
      assets: unknown;
      keys_count: number;
      confirmed_at: Date | null;
      confirmed_by_tenant_at: Date | null;
    }>`
      select id, kind, handed_over_on::text, assets, keys_count, confirmed_at, confirmed_by_tenant_at from handovers
      where organization_id = ${actor.orgId} and lease_id = ${leaseId} order by kind`.execute(trx);
    return {
      ...lease,
      handovers: h.rows.map((x) => ({
        ...x,
        confirmed_at: x.confirmed_at ? new Date(x.confirmed_at).toISOString() : null,
        confirmed_by_tenant_at: x.confirmed_by_tenant_at
          ? new Date(x.confirmed_by_tenant_at).toISOString()
          : null,
      })),
      versions: v.rows.map((x) => ({
        ...x,
        rent_amount: Number(x.rent_amount),
        deposit_amount: Number(x.deposit_amount),
        signed_at: x.signed_at ? new Date(x.signed_at).toISOString() : null,
      })),
      occupants: o.rows,
    };
  });
}

/** `person.get` (S-009): PII theo vai trò ở RLS; không đọc được ⇒ 404 và audit lần bị từ chối (không lộ tồn tại). */
export async function getPerson(
  db: Kysely<unknown>,
  actor: Actor,
  personId: string,
): Promise<{ id: string; full_name: string; phone: string | null; email: string | null }> {
  if (UUID.test(personId)) {
    const r = await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
      sql<{ id: string; full_name: string; phone: string | null; email: string | null }>`
        select id, full_name, phone, email from persons where organization_id = ${actor.orgId} and id = ${personId}`.execute(
        trx,
      ),
    );
    const p = r.rows[0];
    if (p) return p;
  }
  await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
    sql`
      insert into audit_events (id, organization_id, actor_type, actor_person_id, action, entity_type, entity_id, correlation_id,
                                outcome)
      values (${randomUUID()}, ${actor.orgId}, 'user', ${actor.personId}, 'person.read', 'person',
              ${UUID.test(personId) ? personId : null}, ${`query:person.get:${randomUUID()}`}, 'denied')`.execute(
      trx,
    ),
  );
  throw new CommandError("NOT_FOUND", 404, "Không tìm thấy");
}
