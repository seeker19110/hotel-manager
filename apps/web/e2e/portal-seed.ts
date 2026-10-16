// Dữ liệu giả cho E2E portal (T-219): người thuê An (có OTP email), Bình, phiếu 10/2026 3.580.000 đ, chỉ số đã duyệt,
// tài khoản nhận tiền, lượt ở + liên kết khách (hợp lệ / hết hạn / thu hồi). Ghi bằng kết nối admin (không chịu RLS).
import { createHash, randomUUID } from "node:crypto";
import {
  activateLease,
  type SeededOrg,
  seedAuthUser,
  seedLease,
  seedOrg,
  seedReservation,
} from "@hm/testkit/setup";
import { type Kysely, sql } from "kysely";
import {
  GUEST_PHONE_LAST4,
  GUEST_STAY_ID,
  GUEST_TOKEN,
  GUEST_TOKEN_EXPIRED,
  GUEST_TOKEN_REVOKED,
  ORG_PORTAL,
  ORG_PORTAL_2,
  PORTAL_BANK_ACCOUNT,
  PORTAL_MEMO,
  PORTAL_OTHER_TENANT,
  PORTAL_TENANT,
  PORTAL_UNIT,
} from "./fixtures.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest();

async function tenant(
  db: Kysely<unknown>,
  org: SeededOrg,
  name: string,
  email: string,
  phone: string | null,
) {
  const personId = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, email, phone)
            values (${personId}, ${org.orgId}, ${name}, ${email}, ${phone})`.execute(db);
  const lease = await seedLease(db, {
    orgId: org.orgId,
    propertyId: org.propertyId,
    representativePersonId: personId,
    effectiveFrom: "2026-09-01",
  });
  await activateLease(db, { org, leaseId: lease.leaseId, effectiveFrom: "2026-09-01" });
  const authUserId = await seedAuthUser(db, email);
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${randomUUID()}, ${org.orgId}, ${authUserId}, ${personId}, 'tenant')`.execute(db);
  return { personId, authUserId, ...lease };
}

async function invoice(
  db: Kysely<unknown>,
  org: SeededOrg,
  periodId: string,
  payer: { personId: string; leaseId: string },
  memo: string,
  lines: [string, string, number][],
) {
  const id = randomUUID();
  const total = lines.reduce((s, l) => s + l[2], 0);
  await db.transaction().execute(async (trx) => {
    await sql`insert into invoices (id, organization_id, property_id, kind, lease_id, billing_period_id, number, memo_ref, payer_person_id,
                                    business_date, due_on, total)
              values (${id}, ${org.orgId}, ${org.propertyId}, 'periodic', ${payer.leaseId}, ${periodId}, ${`P-${memo}`}, ${memo},
                      ${payer.personId}, '2026-10-01', '2026-10-10', ${total})`.execute(trx);
    for (const [n, [kind, desc, amount]] of lines.entries())
      await sql`insert into invoice_lines (id, organization_id, property_id, invoice_id, line_no, kind, description, revenue_account,
                                           quantity, unit_price, amount, rounding_rule, formula_version)
                values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${id}, ${n + 1}, ${kind}, ${desc}, 'REV_ROOM', 1, ${amount},
                        ${amount}, 'HALF_UP_1', 1)`.execute(trx);
  });
  return id;
}

export async function seedPortal(db: Kysely<unknown>): Promise<{ orgId: string; tenantPersonId: string }> {
  const org = await seedOrg(db, ORG_PORTAL, "rental");
  const an = await tenant(db, org, PORTAL_TENANT.name, PORTAL_TENANT.email, PORTAL_TENANT.phone);
  const binh = await tenant(db, org, PORTAL_OTHER_TENANT.name, PORTAL_OTHER_TENANT.email, null);
  await sql`update units set code = ${PORTAL_UNIT} where id = ${an.unitId}`.execute(db);

  const issued = randomUUID();
  await sql`insert into billing_periods (id, organization_id, property_id, period_start, period_end, status, issued_at, issued_by)
            values (${issued}, ${org.orgId}, ${org.propertyId}, '2026-10-01', '2026-10-28', 'issued', now(), ${org.ownerMembershipId})`.execute(
    db,
  );
  const draft = randomUUID();
  await sql`insert into billing_periods (id, organization_id, property_id, period_start, period_end, status)
            values (${draft}, ${org.orgId}, ${org.propertyId}, '2026-11-01', '2026-11-28', 'draft')`.execute(
    db,
  );
  await invoice(db, org, issued, an, PORTAL_MEMO, [
    ["room", "Tiền phòng", 3_000_000],
    ["utility", "Điện (1.350 − 1.250) × 3.000", 300_000],
    ["utility", "Nước 12 × 15.000", 180_000],
    ["fee", "Phí dịch vụ", 100_000],
  ]);
  // Phiếu kỳ nháp: không được hiện (S-001). Phiếu của Bình: An không được thấy (S-003).
  await invoice(db, org, draft, an, "HME2EAN002", [["room", "Tiền phòng (nháp)", 3_000_000]]);
  await invoice(db, org, issued, binh, "HME2EBI001", [["room", "Tiền phòng", 2_500_000]]);
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, '970436', '****6789', ${PORTAL_BANK_ACCOUNT}, 'NHA TRO HOA SEN')`.execute(
    db,
  );

  // Chỉ số điện: 1.350 đã duyệt hiện; 1.420 nháp không hiện (S-007).
  const meter = randomUUID();
  await sql`insert into meters (id, organization_id, property_id, unit_id, kind, installed_on)
            values (${meter}, ${org.orgId}, ${org.propertyId}, ${an.unitId}, 'electric', '2026-09-01')`.execute(
    db,
  );
  for (const [value, status, on] of [
    [1350, "approved", "2026-10-01"],
    [1420, "draft", "2026-11-01"],
  ] as const)
    await sql`insert into meter_readings (id, organization_id, property_id, meter_id, read_on, value, status, source, approved_by)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${meter}, ${on}::date, ${value}, ${status}, 'import',
                      ${status === "approved" ? org.ownerMembershipId : null})`.execute(db);

  // Ngữ cảnh thứ hai của An (S-012/S-013): người thuê ở tổ chức khác.
  const org2 = await seedOrg(db, ORG_PORTAL_2, "rental");
  const person2 = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person2}, ${org2.orgId}, ${PORTAL_TENANT.name})`.execute(
    db,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${randomUUID()}, ${org2.orgId}, ${an.authUserId}, ${person2}, 'tenant')`.execute(db);

  // Lượt ở của khách lẻ + ba liên kết (hợp lệ / hết hạn / thu hồi).
  const booker = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, phone)
            values (${booker}, ${org.orgId}, 'Khách đặt phòng (giả)', ${`090123${GUEST_PHONE_LAST4}`})`.execute(
    db,
  );
  const { itemId } = await seedReservation(db, {
    org,
    bookerPersonId: booker,
    arrivalDate: "2026-10-20",
    departureDate: "2026-10-22",
  });
  const stayId = GUEST_STAY_ID;
  await sql`insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id,
                               checked_in_at, checked_in_by)
            values (${stayId}, ${org.orgId}, ${org.propertyId}, ${itemId}, ${org.unitId}, 'in_house', ${booker}, now(),
                    ${org.ownerMembershipId})`.execute(db);
  for (const [token, expires, revoked] of [
    [GUEST_TOKEN, "now() + interval '2 days'", false],
    [GUEST_TOKEN_EXPIRED, "now() - interval '1 day'", false],
    [GUEST_TOKEN_REVOKED, "now() + interval '2 days'", true],
  ] as const)
    await sql`insert into guest_access_links (id, organization_id, property_id, stay_id, token_hash, expires_at, created_by, created_at,
                                              revoked_at, revoked_by)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${stayId}, ${sha256(token)},
                      ${sql.raw(expires)}, ${org.ownerMembershipId}, now() - interval '3 days',
                      ${revoked ? sql`now()` : null}, ${revoked ? org.ownerMembershipId : null})`.execute(db);
  return { orgId: org.orgId, tenantPersonId: an.personId };
}
