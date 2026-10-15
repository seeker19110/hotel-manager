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
