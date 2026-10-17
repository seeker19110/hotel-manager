// Fixture khách sạn dùng chung cho test đợt 3 (SPEC-reservation-stay mục 2): cơ sở `hotel` múi giờ Asia/Ho_Chi_Minh, nhận
// 14:00 / trả 12:00, giờ chốt ngày 04:00 khi cần (S-016); loại STD sức chứa 2 giá 600.000 / 700.000; phòng 201, 202
// `inspected`; tài khoản nhận giả; owner, quản lý M, lễ tân L/L2, buồng phòng H, kế toán K. Chỉ dữ liệu giả.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import type { Actor } from "../access/index.ts";
import { setRate } from "../stay/index.ts";
import { okAs, ownerOf, seedMember } from "./helpers.ts";

export interface Hotel {
  t: TestDb;
  org: SeededOrg;
  other: SeededOrg;
  owner: Actor;
  manager: Actor;
  frontDesk: Actor;
  frontDesk2: Actor;
  housekeeping: Actor;
  accountant: Actor;
  ownerOther: Actor;
  units: { r201: string; r202: string };
  receivingAccountId: string;
}

export async function seedHotel(opts: { cutoff?: string } = {}): Promise<Hotel> {
  const t = await createTestDb();
  const org = await seedOrg(t.admin, "KS Mai");
  const other = await seedOrg(t.admin, "KS Khác");
  await sql`update properties set check_in_time = '14:00', check_out_time = '12:00', business_day_cutoff = ${opts.cutoff ?? "00:00"}::time
            where id = ${org.propertyId}`.execute(t.admin);
  const r201 = randomUUID();
  const r202 = randomUUID();
  for (const [id, code] of [
    [r201, "201"],
    [r202, "202"],
  ]) {
    await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
              values (${id}, ${org.orgId}, ${org.propertyId}, ${org.floorId}, ${org.roomTypeId}, ${code}, 'inspected')`.execute(
      t.admin,
    );
  }
  const receivingAccountId = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${receivingAccountId}, ${org.orgId}, ${org.propertyId}, '970436', '****6789', '0123456789', 'KS MAI')`.execute(
    t.admin,
  );
  const owner = await ownerOf(t, org);
  await okAs(t, owner, (ctx) =>
    setRate(ctx, {
      roomTypeId: org.roomTypeId,
      weekdayPrice: 600_000,
      weekendPrice: 700_000,
      effectiveFrom: "2026-01-01",
    }),
  );
  return {
    t,
    org,
    other,
    owner,
    manager: await seedMember(t, org, "manager", { name: "Quản lý M" }),
    frontDesk: await seedMember(t, org, "front_desk", { name: "Lễ tân L" }),
    frontDesk2: await seedMember(t, org, "front_desk", { name: "Lễ tân L2" }),
    housekeeping: await seedMember(t, org, "housekeeping", { name: "Buồng phòng H" }),
    accountant: await seedMember(t, org, "accountant", { properties: "all", name: "Kế toán K" }),
    ownerOther: await ownerOf(t, other),
    units: { r201, r202 },
    receivingAccountId,
  };
}

/** Σ Nợ − Σ Có của một tài khoản sổ phụ trong tổ chức (tuỳ chọn theo người). */
export async function ledgerBalance(h: Hotel, account: string, personId?: string): Promise<number> {
  const r = await sql<{ b: string }>`
    select coalesce(sum(debit - credit), 0)::text as b from journal_lines
    where organization_id = ${h.org.orgId} and account = ${account}
      ${personId ? sql`and person_id = ${personId}` : sql``}`.execute(h.t.admin);
  return Number(r.rows[0]?.b ?? 0);
}
