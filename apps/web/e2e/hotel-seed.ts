// Dữ liệu giả cho E2E khách sạn (T-223): chủ có TOTP thật, buồng phòng đăng nhập mật khẩu, 3 phòng đã dọn + kiểm, bảng giá,
// mẫu thông báo lưu trú (CSV) + hạn nộp, một thông báo chưa đọc cho chủ. Ghi bằng kết nối admin (không chịu RLS).
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { createAuth } from "@hm/app";
import { seedOrg } from "@hm/testkit/setup";
import { type Kysely, sql } from "kysely";
import {
  HOTEL_HK,
  HOTEL_NOTIFICATION_TITLE,
  HOTEL_OWNER,
  HOTEL_ROOMS,
  HOTEL_WEEKDAY_PRICE,
  HOTEL_WEEKEND_PRICE,
  ORG_HOTEL,
  perfSeedFile,
} from "./fixtures.ts";
import { hotelTotpFile, totp } from "./totp.ts";

type Auth = ReturnType<typeof createAuth>["auth"];

/** Bật TOTP thật qua Better Auth cho tài khoản đã đăng ký; ghi bí mật vào `file` cho test đọc. Trả mã người dùng. */
export async function signUpWithTotp(
  auth: Auth,
  account: { email: string; password: string; name: string },
  file: string,
): Promise<string> {
  const { user } = await auth.api.signUpEmail({ body: account });
  const login = await auth.api.signInEmail({
    body: { email: account.email, password: account.password },
    returnHeaders: true,
  });
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const enabled = await auth.api.enableTwoFactor({
    body: { password: account.password },
    headers: new Headers({ cookie }),
  });
  if (!("totpURI" in enabled)) throw new Error("cần TOTP");
  const secretB32 = new URL(enabled.totpURI).searchParams.get("secret") ?? "";
  await auth.api.verifyTOTP({ body: { code: totp(secretB32) }, headers: new Headers({ cookie }) });
  writeFileSync(file, JSON.stringify({ secret: secretB32 }), { mode: 0o600 });
  return user.id;
}

export async function seedHotelOrg(db: Kysely<unknown>, auth: Auth, port: number): Promise<void> {
  const ownerUserId = await signUpWithTotp(auth, HOTEL_OWNER, hotelTotpFile(port));
  const org = await seedOrg(db, ORG_HOTEL, "hotel", ownerUserId);
  await sql`update properties set check_in_time = '14:00', check_out_time = '12:00' where id = ${org.propertyId}`.execute(
    db,
  );
  // 101 do seedOrg tạo; thêm 102, 103. Cả ba đã dọn + kiểm để nhận khách ngay.
  for (const code of HOTEL_ROOMS.filter((c) => c !== "101")) {
    await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${org.floorId}, ${org.roomTypeId}, ${code})`.execute(
      db,
    );
  }
  await sql`update units set housekeeping_status = 'inspected' where organization_id = ${org.orgId}`.execute(
    db,
  );
  await sql`insert into rate_plans (id, organization_id, property_id, room_type_id, weekday_price, weekend_price, effective_from, created_by)
            values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${org.roomTypeId}, ${HOTEL_WEEKDAY_PRICE}, ${HOTEL_WEEKEND_PRICE},
                    '2026-01-01', ${org.ownerMembershipId})`.execute(db);
  await sql`insert into notification_settings (id, organization_id, property_id, stay_notice_deadline, residence_notice_template,
                                               updated_by)
            values (${randomUUID()}, ${org.orgId}, ${org.propertyId},
                    ${JSON.stringify({ domestic_cutoff: "22:00", domestic_next_day_before: "12:00", foreign_hours: 24 })}::jsonb,
                    ${JSON.stringify({ format: "csv", fields: ["full_name", "doc_number", "unit_code"] })}::jsonb,
                    ${org.ownerMembershipId})`.execute(db);

  // Buồng phòng: đăng nhập email + mật khẩu (vai trò không bắt buộc MFA), chỉ cơ sở này.
  const units = await sql<{
    id: string;
  }>`select id from units where organization_id = ${org.orgId} order by code`.execute(db);
  writeFileSync(
    perfSeedFile(port),
    JSON.stringify({ org_id: org.orgId, property_id: org.propertyId, unit_ids: units.rows.map((u) => u.id) }),
    { mode: 0o600 },
  );
  const { user: hk } = await auth.api.signUpEmail({ body: HOTEL_HK });
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, email)
            values (${person}, ${org.orgId}, ${HOTEL_HK.name}, ${HOTEL_HK.email})`.execute(db);
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${org.orgId}, ${hk.id}, ${person}, 'housekeeping')`.execute(db);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${org.orgId}, ${membership}, ${org.propertyId})`.execute(db);

  // Một thông báo chưa đọc cho chủ (chuông hiện "1 thông báo chưa đọc").
  await sql`insert into notifications (id, organization_id, property_id, recipient_person_id, type, severity, title, body, link, vars,
                                       dedupe_key)
            values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${org.ownerPersonId}, 'maintenance_status', 'normal',
                    ${HOTEL_NOTIFICATION_TITLE}, 'Phòng 103: phiếu mẫu đã được giao cho kỹ thuật.', '/su-co', '{}'::jsonb,
                    ${`e2e-${org.orgId}`})`.execute(db);
}
