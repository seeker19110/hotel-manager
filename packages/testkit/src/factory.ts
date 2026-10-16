// Dữ liệu giả cho test (người giả, không dữ liệu thật — kế hoạch §12). Ghi bằng kết nối admin (không chịu RLS).
import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";

export interface SeededOrg {
  orgId: string;
  propertyId: string;
  floorId: string;
  roomTypeId: string;
  unitId: string;
  ownerPersonId: string;
  ownerMembershipId: string;
  ownerAuthUserId: string;
}

/** Tạo hàng `auth.user` tối thiểu (khi test không cần đăng nhập thật). */
export async function seedAuthUser(
  admin: Kysely<unknown>,
  email: string,
  id: string = randomUUID(),
): Promise<string> {
  await sql`insert into auth."user" (id, name, email, "emailVerified") values (${id}, ${email}, ${email}, false)`.execute(
    admin,
  );
  return id;
}

export async function seedOrg(
  admin: Kysely<unknown>,
  name: string,
  template = "hotel",
  ownerAuthUserId?: string,
): Promise<SeededOrg> {
  const s: SeededOrg = {
    orgId: randomUUID(),
    propertyId: randomUUID(),
    floorId: randomUUID(),
    roomTypeId: randomUUID(),
    unitId: randomUUID(),
    ownerPersonId: randomUUID(),
    ownerMembershipId: randomUUID(),
    ownerAuthUserId: ownerAuthUserId ?? randomUUID(),
  };
  if (!ownerAuthUserId)
    await seedAuthUser(admin, `owner+${s.orgId.slice(0, 8)}@example.test`, s.ownerAuthUserId);
  await admin.transaction().execute(async (trx) => {
    await sql`insert into organizations (id, name, created_by) values (${s.orgId}, ${name}, ${s.ownerAuthUserId})`.execute(
      trx,
    );
    await sql`insert into properties (id, organization_id, name, template) values (${s.propertyId}, ${s.orgId}, ${`${name} — CS1`}, ${template})`.execute(
      trx,
    );
    await sql`insert into floors (id, organization_id, property_id, name) values (${s.floorId}, ${s.orgId}, ${s.propertyId}, 'Tầng 1')`.execute(
      trx,
    );
    await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
              values (${s.roomTypeId}, ${s.orgId}, ${s.propertyId}, 'STD', 'Tiêu chuẩn', 2)`.execute(trx);
    await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
              values (${s.unitId}, ${s.orgId}, ${s.propertyId}, ${s.floorId}, ${s.roomTypeId}, '101')`.execute(
      trx,
    );
    await sql`insert into persons (id, organization_id, full_name, email)
              values (${s.ownerPersonId}, ${s.orgId}, ${`Chủ ${name}`}, ${`owner+${s.orgId.slice(0, 8)}@example.test`})`.execute(
      trx,
    );
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
              values (${s.ownerMembershipId}, ${s.orgId}, ${s.ownerAuthUserId}, ${s.ownerPersonId}, 'owner', true)`.execute(
      trx,
    );
  });
  return s;
}

export interface SeedInvoiceLine {
  kind?: "room" | "utility" | "service" | "fee";
  revenueAccount?: "REV_ROOM" | "REV_UTIL" | "REV_SERVICE" | "REV_FEE";
  amount: number;
  description?: string;
}

/**
 * Phiếu `fee` đã phát hành (giả) cho test: phiếu + dòng + bút toán Nợ AR / Có doanh thu, cùng một transaction (đủ hàng rào
 * tổng = Σ dòng và bút toán cân). Logic phát hành thật ở billing (PLAN đợt 2 T-114).
 */
export async function seedIssuedInvoice(
  admin: Kysely<unknown>,
  input: {
    orgId: string;
    propertyId: string;
    payerPersonId: string;
    lines: readonly SeedInvoiceLine[];
    leaseId?: string;
    /** Mã tham chiếu cố định (ví dụ trong SPEC, vd `HM7Q4K2P`); mặc định ngẫu nhiên. */
    memoRef?: string;
    /** Ngày kinh doanh `YYYY-MM-DD` (phiếu kỳ cũ khi test chốt kỳ); mặc định hôm nay. */
    businessDate?: string;
  },
): Promise<{ invoiceId: string; total: number; memoRef: string }> {
  const invoiceId = randomUUID();
  const total = input.lines.reduce((s, l) => s + l.amount, 0);
  const memoRef = input.memoRef ?? `HM${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const entryId = randomUUID();
  await admin.transaction().execute(async (trx) => {
    await sql`insert into invoices (id, organization_id, property_id, kind, number, memo_ref, payer_person_id, business_date, total,
                                    lease_id)
              values (${invoiceId}, ${input.orgId}, ${input.propertyId}, 'fee', ${`T-${invoiceId.slice(0, 8)}`}, ${memoRef},
                      ${input.payerPersonId}, coalesce(${input.businessDate ?? null}::date, app.business_date(${input.orgId}, ${input.propertyId})), ${total}, ${input.leaseId ?? null})`.execute(
      trx,
    );
    // Phiếu 0 đ không có bút toán (mỗi dòng sổ phải đúng một phía > 0).
    const posts = total > 0;
    if (posts) {
      await sql`insert into journal_entries (id, organization_id, property_id, entry_type, business_date, source_doc_type, source_doc_id)
                values (${entryId}, ${input.orgId}, ${input.propertyId}, 'invoice_issued',
                        coalesce(${input.businessDate ?? null}::date, app.business_date(${input.orgId}, ${input.propertyId})), 'invoice', ${invoiceId})`.execute(
        trx,
      );
    }
    let no = 0;
    let jl = 0;
    if (posts)
      await sql`insert into journal_lines (id, organization_id, property_id, entry_id, line_no, account, debit, credit, person_id, invoice_id)
              values (${randomUUID()}, ${input.orgId}, ${input.propertyId}, ${entryId}, ${++jl}, 'AR', ${total}, 0,
                      ${input.payerPersonId}, ${invoiceId})`.execute(trx);
    for (const l of input.lines) {
      const lineId = randomUUID();
      const account = l.revenueAccount ?? "REV_FEE";
      await sql`insert into invoice_lines (id, organization_id, property_id, invoice_id, line_no, kind, description, revenue_account,
                                           quantity, unit_price, amount, rounding_rule, formula_version)
                values (${lineId}, ${input.orgId}, ${input.propertyId}, ${invoiceId}, ${++no}, ${l.kind ?? "fee"},
                        ${l.description ?? "Phí (giả)"}, ${account}, 1, ${l.amount}, ${l.amount}, 'HALF_UP_1', 1)`.execute(
        trx,
      );
      if (!posts || l.amount === 0) continue;
      await sql`insert into journal_lines (id, organization_id, property_id, entry_id, line_no, account, debit, credit, invoice_id,
                                           invoice_line_id)
                values (${randomUUID()}, ${input.orgId}, ${input.propertyId}, ${entryId}, ${++jl}, ${account}, 0, ${l.amount},
                        ${invoiceId}, ${lineId})`.execute(trx);
    }
  });
  return { invoiceId, total, memoRef };
}

/**
 * Hợp đồng `draft` tối thiểu (phiên bản 1 + người đại diện) cho test cần `lease_id` thật (FK từ migration 0014).
 * Không truyền `unitId` ⇒ tạo tầng/loại phòng/phòng mới trong cơ sở.
 */
export async function seedLease(
  admin: Kysely<unknown>,
  input: {
    orgId: string;
    propertyId: string;
    representativePersonId: string;
    unitId?: string;
    effectiveFrom?: string;
    rentAmount?: number;
    depositAmount?: number;
  },
): Promise<{ leaseId: string; unitId: string }> {
  const leaseId = randomUUID();
  let unitId = input.unitId;
  await admin.transaction().execute(async (trx) => {
    if (!unitId) {
      const floorId = randomUUID();
      const typeId = randomUUID();
      unitId = randomUUID();
      await sql`insert into floors (id, organization_id, property_id, name) values (${floorId}, ${input.orgId}, ${input.propertyId}, ${`T-${floorId.slice(0, 4)}`})`.execute(
        trx,
      );
      await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
                values (${typeId}, ${input.orgId}, ${input.propertyId}, ${`RT${typeId.slice(0, 6)}`}, 'Phòng trọ', 2)`.execute(
        trx,
      );
      await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
                values (${unitId}, ${input.orgId}, ${input.propertyId}, ${floorId}, ${typeId}, ${`P${unitId.slice(0, 6)}`})`.execute(
        trx,
      );
    }
    const from = input.effectiveFrom ?? "2026-11-01";
    await sql`insert into leases (id, organization_id, property_id, unit_id, number, billing_start_on, representative_person_id)
              values (${leaseId}, ${input.orgId}, ${input.propertyId}, ${unitId}, ${`HD-T${leaseId.slice(0, 8)}`}, ${from}::date,
                      ${input.representativePersonId})`.execute(trx);
    await sql`insert into lease_versions (id, organization_id, property_id, lease_id, version_no, kind, effective_from, rent_amount,
                                          deposit_amount)
              values (${randomUUID()}, ${input.orgId}, ${input.propertyId}, ${leaseId}, 1, 'original', ${from}::date,
                      ${input.rentAmount ?? 3_000_000}, ${input.depositAmount ?? 3_000_000})`.execute(trx);
    await sql`insert into lease_occupants (id, organization_id, property_id, lease_id, person_id, role, is_representative, from_on)
              values (${randomUUID()}, ${input.orgId}, ${input.propertyId}, ${leaseId}, ${input.representativePersonId}, 'primary',
                      true, ${from}::date)`.execute(trx);
  });
  return { leaseId, unitId: unitId as string };
}

/**
 * Đưa hợp đồng `draft` của `seedLease` tới `active` (ký phiên bản → chờ bàn giao → bàn giao nhập khẩu → đang thuê) bằng đúng
 * chuỗi chuyển trạng thái mà trigger cho phép; dùng cho test/E2E cần người thuê có hợp đồng hiệu lực (portal).
 */
export async function activateLease(
  admin: Kysely<unknown>,
  input: { org: SeededOrg; leaseId: string; effectiveFrom?: string },
): Promise<void> {
  const from = input.effectiveFrom ?? "2026-11-01";
  await admin.transaction().execute(async (trx) => {
    await sql`update lease_versions set signed_at = now(), terms_hash = ${"0".repeat(64)}, terms_snapshot = '{}'
              where lease_id = ${input.leaseId}`.execute(trx);
    await sql`update leases set status = 'pending_signature' where id = ${input.leaseId}`.execute(trx);
    await sql`update leases set status = 'signed_awaiting_handover', signed_on = ${from}::date where id = ${input.leaseId}`.execute(
      trx,
    );
    await sql`insert into handovers (id, organization_id, property_id, lease_id, kind, handed_over_on, staff_confirmed_by,
                                     confirmed_at, source, readings_pending, confirmation_method)
              values (${randomUUID()}, ${input.org.orgId}, ${input.org.propertyId}, ${input.leaseId}, 'move_in', ${from}::date,
                      ${input.org.ownerMembershipId}, now(), 'import', false, 'import')`.execute(trx);
    await sql`update leases set status = 'active' where id = ${input.leaseId}`.execute(trx);
  });
}

/** Booking `draft` tối thiểu (một dòng phòng, giá giả) — cho test cần FK tới `reservations` (cọc/ứng trước đặt phòng). */
export async function seedReservation(
  admin: Kysely<unknown>,
  input: { org: SeededOrg; bookerPersonId: string; arrivalDate?: string; departureDate?: string },
): Promise<{ reservationId: string; itemId: string }> {
  const reservationId = randomUUID();
  const itemId = randomUUID();
  const a = input.arrivalDate ?? "2026-10-20";
  const d = input.departureDate ?? "2026-10-21";
  await admin.transaction().execute(async (trx) => {
    await sql`insert into reservations (id, organization_id, property_id, number, status, source, booker_person_id, created_by)
              values (${reservationId}, ${input.org.orgId}, ${input.org.propertyId}, ${`R-${Math.floor(Math.random() * 1e9)}`},
                      'draft', 'direct', ${input.bookerPersonId}, ${input.org.ownerMembershipId})`.execute(
      trx,
    );
    await sql`insert into reservation_items (id, organization_id, property_id, reservation_id, unit_id, room_type_id,
                                             arrival_date, departure_date, guests, nightly_prices, room_total)
              select ${itemId}, ${input.org.orgId}, ${input.org.propertyId}, ${reservationId}, ${input.org.unitId},
                     ${input.org.roomTypeId}, ${a}::date, ${d}::date, 1,
                     (select jsonb_agg(jsonb_build_object('businessDate', g::date::text, 'amount', 600000))
                      from generate_series(${a}::date, ${d}::date - 1, interval '1 day') g),
                     600000 * (${d}::date - ${a}::date)`.execute(trx);
  });
  return { reservationId, itemId };
}
