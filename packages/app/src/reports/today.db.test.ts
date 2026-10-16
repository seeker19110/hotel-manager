// PLAN đợt 3 T-216 — màn "Hôm nay" và xem nhật ký audit trên Postgres thật (SPEC-audit-reporting S-004, S-005, S-006, S-007, S-008, S-019;
// INV-G1, INV-G2, INV-G6). Tổ chức A: hai cơ sở HS1 (UTC+7, giờ chốt 04:00) và HS2 (Asia/Tokyo UTC+9, giờ chốt 00:00 — để thấy ngày kinh
// doanh khác nhau theo cơ sở). Dữ liệu dựng bằng kết nối quản trị (bỏ qua máy trạng thái bằng `session_replication_role = replica`); mọi truy
// vấn chạy bằng kết nối `app_runtime` qua RLS. Tổ chức B kiểm cách ly chéo tenant. Tổ chức C dành cho nhật ký (đếm chính xác).
import { randomUUID } from "node:crypto";
import {
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedIssuedInvoice,
  seedLease,
  seedOrg,
  seedReservation,
  type TestDb,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { type HttpDeps, handleQuery } from "../http/command-route.ts";
import { QUERIES } from "../http/registry.ts";
import { executeCommand } from "../pipeline/command.ts";
import { AUDIT_MAX_RANGE_DAYS, listAuditEvents } from "./audit.ts";
import { getTodaySummary, TODAY_PENDING_SOURCES } from "./today.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let C: SeededOrg;
let HS2: { propertyId: string; floorId: string; roomTypeId: string };
let CP2: { propertyId: string; floorId: string; roomTypeId: string };
let O: Actor; // owner A
let OB: Actor;
let OC: Actor;
let M1: Actor; // quản lý chỉ HS1
let M12: Actor; // quản lý HS1 + HS2
let M0: Actor; // quản lý không có cơ sở nào
let F: Actor; // lễ tân HS1
let K: Actor; // kế toán (mọi cơ sở)
let H: Actor; // buồng phòng HS1
let TN: Actor; // người thuê
let deps: HttpDeps;

/** 15/10/2026 15:00 giờ HS1 (UTC+7); ngày kinh doanh HS1 = 2026-10-15. */
const NOW = new Date("2026-10-15T08:00:00Z");
const BD = "2026-10-15";

type Org = { orgId: string; propertyId: string; floorId: string; roomTypeId: string };

async function member(
  org: SeededOrg,
  role: string,
  scope: "all" | readonly string[],
  twoFactor = true,
): Promise<{ actor: Actor; personId: string; membershipId: string }> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${`NV ${role}`})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${membership}, ${org.orgId}, ${user}, ${person}, ${role}, ${scope === "all"})`.execute(
    t.admin,
  );
  if (scope !== "all") {
    for (const p of scope) {
      await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
                values (${randomUUID()}, ${org.orgId}, ${membership}, ${p})`.execute(t.admin);
    }
  }
  const actor = await resolveActor(t.runtime, {
    authUserId: user,
    orgId: org.orgId,
    twoFactorEnabled: twoFactor,
  });
  return { actor, personId: person, membershipId: membership };
}

async function addProperty(org: SeededOrg, name: string, tz: string, cutoff: string) {
  const s = { propertyId: randomUUID(), floorId: randomUUID(), roomTypeId: randomUUID() };
  await sql`insert into properties (id, organization_id, name, template, timezone, business_day_cutoff)
            values (${s.propertyId}, ${org.orgId}, ${name}, 'hotel', ${tz}, ${cutoff}::time)`.execute(
    t.admin,
  );
  await sql`insert into floors (id, organization_id, property_id, name) values (${s.floorId}, ${org.orgId}, ${s.propertyId}, 'Tầng 1')`.execute(
    t.admin,
  );
  await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
            values (${s.roomTypeId}, ${org.orgId}, ${s.propertyId}, 'STD', 'Tiêu chuẩn', 2)`.execute(t.admin);
  return s;
}

async function person(org: { orgId: string }, name: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${id}, ${org.orgId}, ${name})`.execute(
    t.admin,
  );
  return id;
}

async function unit(
  org: Org,
  code: string,
  over: { hk?: string; availability?: string; archived?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status, availability,
                               availability_reason, archived_at)
            values (${id}, ${org.orgId}, ${org.propertyId}, ${org.floorId}, ${org.roomTypeId}, ${`${code}-${id.slice(0, 3)}`},
                    ${over.hk ?? "clean"}, ${over.availability ?? "active"},
                    ${over.availability === "out_of_service" ? "Sửa chữa" : null}, ${over.archived ? sql`now()` : null})`.execute(
    t.admin,
  );
  return id;
}

/** Lượt ở dựng thẳng (bỏ máy trạng thái): booking draft + dòng phòng + stay ở trạng thái mong muốn. */
async function stay(
  org: Org,
  o: { arrival: string; departure: string; status: string; guest: string; code?: string; hk?: string },
): Promise<{ stayId: string; unitId: string }> {
  const unitId = await unit(org, o.code ?? "R", o.hk ? { hk: o.hk } : {});
  const guest = await person(org, o.guest);
  const r = await seedReservation(t.admin, {
    orgId: org.orgId,
    propertyId: org.propertyId,
    bookerPersonId: guest,
    unitId,
    roomTypeId: org.roomTypeId,
    arrivalDate: o.arrival,
    departureDate: o.departure,
  });
  const stayId = randomUUID();
  await t.admin.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id,
                                 checked_in_at, checked_out_at)
              values (${stayId}, ${org.orgId}, ${org.propertyId}, ${r.itemId}, ${unitId}, ${o.status}, ${guest},
                      ${o.status === "in_house" || o.status === "checked_out" ? sql`now()` : null},
                      ${o.status === "checked_out" ? sql`now()` : null})`.execute(trx);
  });
  return { stayId, unitId };
}

/** Phiếu đã phát hành (giả) + hạn + số đã phân bổ (cột `due_on` bất biến sau phát hành ⇒ đặt qua replica). */
async function invoice(
  org: Org,
  payer: string,
  o: { total: number; allocated?: number; due: string | null },
): Promise<string> {
  const inv = await seedIssuedInvoice(t.admin, {
    orgId: org.orgId,
    propertyId: org.propertyId,
    payerPersonId: payer,
    lines: [{ amount: o.total }],
    businessDate: "2026-10-01",
  });
  await t.admin.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`update invoices set due_on = ${o.due}::date, allocated_total = ${o.allocated ?? 0} where id = ${inv.invoiceId}`.execute(
      trx,
    );
  });
  return inv.invoiceId;
}

async function notice(org: Org, stayId: string, dueAt: Date | null, status = "pending"): Promise<void> {
  await t.admin.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`insert into residence_notices (id, organization_id, property_id, stay_id, status, is_foreign, due_at)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${stayId}, ${status}, false, ${dueAt})`.execute(
      trx,
    );
  });
}

async function lease(org: Org, rep: string, endsOn: string, status = "active"): Promise<string> {
  const { leaseId } = await seedLease(t.admin, {
    orgId: org.orgId,
    propertyId: org.propertyId,
    representativePersonId: rep,
    effectiveFrom: "2026-01-01",
  });
  await t.admin.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`update leases set status = ${status}, signed_on = '2026-09-01' where id = ${leaseId}`.execute(
      trx,
    );
    await sql`update lease_versions set signed_at = now(), terms_hash = ${"a".repeat(64)}, terms_snapshot = '{}'::jsonb,
              effective_to = ${endsOn}::date where lease_id = ${leaseId} and version_no = 1`.execute(trx);
  });
  return leaseId;
}

async function period(org: Org, start: string, end: string, status: string): Promise<void> {
  await t.admin.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`insert into billing_periods (id, organization_id, property_id, period_start, period_end, status)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${start}::date, ${end}::date, ${status})`.execute(
      trx,
    );
  });
}

const HS1 = (): Org => ({
  orgId: A.orgId,
  propertyId: A.propertyId,
  floorId: A.floorId,
  roomTypeId: A.roomTypeId,
});
const HS2o = (): Org => ({ orgId: A.orgId, ...HS2 });

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS Hôm nay", "hotel");
  B = await seedOrg(t.admin, "KS khác", "hotel");
  C = await seedOrg(t.admin, "KS nhật ký", "hotel");
  await sql`update properties set business_day_cutoff = '04:00', name = 'HS1' where id = ${A.propertyId}`.execute(
    t.admin,
  );
  HS2 = await addProperty(A, "HS2", "Asia/Tokyo", "00:00");
  await sql`update properties set name = 'CP1' where id = ${C.propertyId}`.execute(t.admin);
  CP2 = await addProperty(C, "CP2", "Asia/Ho_Chi_Minh", "00:00");

  const res = (org: SeededOrg) =>
    resolveActor(t.runtime, { authUserId: org.ownerAuthUserId, orgId: org.orgId, twoFactorEnabled: true });
  O = await res(A);
  OB = await res(B);
  OC = await res(C);
  M1 = (await member(A, "manager", [A.propertyId])).actor;
  M12 = (await member(A, "manager", [A.propertyId, HS2.propertyId])).actor;
  M0 = (await member(A, "manager", [])).actor;
  F = (await member(A, "front_desk", [A.propertyId])).actor;
  K = (await member(A, "accountant", "all")).actor;
  H = (await member(A, "housekeeping", [A.propertyId], false)).actor;
  TN = (await member(A, "tenant", [], false)).actor;

  // ----- HS1: ngày kinh doanh 2026-10-15 -----
  const h1 = HS1();
  await stay(h1, {
    arrival: BD,
    departure: "2026-10-17",
    status: "expected",
    guest: "Nguyễn Văn Đến Một",
    code: "A1",
  });
  await stay(h1, {
    arrival: BD,
    departure: "2026-10-16",
    status: "expected",
    guest: "Lê Thị Đến Hai",
    code: "A2",
  });
  const s3 = await stay(h1, {
    arrival: BD,
    departure: "2026-10-18",
    status: "in_house",
    guest: "Phạm Đã Nhận Phòng",
    code: "A3",
  });
  const s4 = await stay(h1, {
    arrival: "2026-10-13",
    departure: BD,
    status: "in_house",
    guest: "Trần Sắp Đi",
    code: "D1",
    hk: "assigned",
  });
  await stay(h1, {
    arrival: "2026-10-14",
    departure: BD,
    status: "checked_out",
    guest: "Hoàng Đã Đi",
    code: "D2",
    hk: "dirty",
  });
  const s6 = await stay(h1, {
    arrival: "2026-10-13",
    departure: "2026-10-17",
    status: "in_house",
    guest: "Vũ Đang Ở",
    code: "I1",
    hk: "cleaning",
  });
  const s7 = await stay(h1, {
    arrival: "2026-10-12",
    departure: "2026-10-14",
    status: "in_house",
    guest: "Đặng Ở Quá Hạn",
    code: "O1",
  });
  await stay(h1, {
    arrival: "2026-10-16",
    departure: "2026-10-17",
    status: "expected",
    guest: "Bùi Ngày Mai",
    code: "T1",
  });
  await stay(h1, {
    arrival: BD,
    departure: "2026-10-16",
    status: "no_show",
    guest: "Ngô Không Đến",
    code: "N1",
  });
  await stay(h1, {
    arrival: BD,
    departure: "2026-10-16",
    status: "cancelled",
    guest: "Đỗ Đã Huỷ",
    code: "N2",
  });
  // Phòng cần dọn HS1 = D1 (assigned) + D2 (dirty) + I1 (cleaning) + C1 (dirty) = 4 (S-006).
  await unit(h1, "C1", { hk: "dirty" });
  await unit(h1, "C2", { hk: "clean" });
  await unit(h1, "C3", { hk: "inspected" });
  await unit(h1, "C4", { hk: "dirty", availability: "out_of_service" }); // ngừng khai thác: không phải dọn
  await unit(h1, "C5", { hk: "dirty", archived: true }); // đã lưu trữ
  // Công nợ HS1
  const payerA = await person(h1, "Trần Thị Nợ Quá Hạn");
  await invoice(h1, payerA, { total: 3_580_000, allocated: 2_000_000, due: "2026-10-10" }); // còn 1.580.000, quá hạn 5 ngày
  await invoice(h1, payerA, { total: 500_000, due: BD }); // đến hạn hôm nay
  await invoice(h1, payerA, { total: 700_000, due: "2026-10-16" }); // chưa đến hạn
  await invoice(h1, payerA, { total: 900_000, allocated: 900_000, due: "2026-10-01" }); // đã tất toán
  await invoice(h1, payerA, { total: 400_000, due: null }); // chưa có hạn
  // Kỳ thu
  await period(h1, "2026-10-01", "2026-10-31", "reviewing");
  await period(h1, "2026-09-01", "2026-09-30", "draft");
  // Thông báo lưu trú
  await notice(h1, s3.stayId, new Date(NOW.getTime() - 3_600_000)); // quá hạn
  await notice(h1, s6.stayId, new Date(NOW.getTime() + 2 * 3_600_000)); // 17:00 hôm nay
  await notice(h1, s4.stayId, new Date("2026-10-16T02:00:00Z")); // 09:00 ngày kinh doanh 16 → chưa tới
  await notice(h1, s7.stayId, null); // chưa cấu hình hạn → không tính
  // Hợp đồng
  const rep = await person(h1, "Chủ hợp đồng");
  await lease(h1, rep, "2026-11-05"); // còn 21 ngày
  await lease(h1, rep, "2027-01-01"); // ngoài tầm 30 ngày
  await lease(h1, rep, "2026-10-10"); // hết hạn 5 ngày trước nhưng vẫn active
  await lease(h1, rep, "2026-10-20", "closed"); // đã đóng → không tính

  // ----- HS2 (Tokyo, chốt 00:00): cũng có việc, để kiểm phạm vi cơ sở -----
  const h2 = HS2o();
  await stay(h2, {
    arrival: BD,
    departure: "2026-10-16",
    status: "expected",
    guest: "Kawasaki Khách HS2",
    code: "H2A",
  });
  await unit(h2, "H2C", { hk: "dirty" });
  const payer2 = await person(h2, "Khách nợ HS2");
  await invoice(h2, payer2, { total: 1_430_000, allocated: 500_000, due: "2026-10-14" }); // còn 930.000, quá hạn 1 ngày

  // ----- Tổ chức B: dữ liệu riêng -----
  const hb: Org = { orgId: B.orgId, propertyId: B.propertyId, floorId: B.floorId, roomTypeId: B.roomTypeId };
  await stay(hb, {
    arrival: BD,
    departure: "2026-10-16",
    status: "expected",
    guest: "Khách của B",
    code: "B1",
    hk: "dirty",
  });
  await invoice(hb, await person(hb, "Nợ của B"), { total: 7_777_000, due: "2026-10-01" });

  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: true } } : null;
    },
    secureCookies: false,
  };
});

afterAll(async () => {
  await t.drop();
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; status?: number; errors?: unknown };
  }
  throw new Error("lẽ ra phải lỗi");
};

describe("today — S-006 màn Hôm nay cho chủ/quản lý theo ngày kinh doanh", () => {
  it("HS1: số thẻ đúng (đến 3 · đi 2 · đang ở 4 · ở quá hạn 1 · nợ 2 · kỳ thu 1 · dọn 4 · thông báo 2 · hợp đồng 2)", async () => {
    const s = await getTodaySummary(t.runtime, O, { propertyId: A.propertyId, now: NOW });
    expect(s.business_date).toBe(BD);
    expect(s.properties).toHaveLength(1);
    expect(s.cards).toEqual({
      arrivals: 3,
      departures: 2,
      in_house: 4,
      overstays: 1,
      debt_due_or_overdue: 2,
      billing_review: 1,
      cleaning: 4,
      residence_notices: 2,
      leases_expiring: 2,
    });
    expect(s.pending_sources).toEqual([...TODAY_PENDING_SOURCES]);
    // Danh sách khớp số thẻ (bấm thẻ mở danh sách có đúng số dòng).
    expect(s.guests?.arrivals.map((g) => g.guest_name).sort()).toEqual(
      ["Lê Thị Đến Hai", "Nguyễn Văn Đến Một", "Phạm Đã Nhận Phòng"].sort(),
    );
    expect(s.guests?.departures.map((g) => g.stay_status).sort()).toEqual(["checked_out", "in_house"]);
    expect(s.guests?.in_house).toHaveLength(4);
    expect(s.guests?.overstays.map((g) => g.guest_name)).toEqual(["Đặng Ở Quá Hạn"]);
    expect(s.cleaning?.items).toHaveLength(4);
    expect(s.cleaning?.source).toBe("units.housekeeping_status");
    expect(new Set(s.cleaning?.items.map((x) => x.housekeeping_status))).toEqual(
      new Set(["dirty", "assigned", "cleaning"]),
    );
    // Khách không đến/đã huỷ/ngày mai không có trong "đến".
    expect(JSON.stringify(s.guests)).not.toMatch(/Không Đến|Đã Huỷ|Ngày Mai/);
  });

  it("công nợ: quá hạn 1.580.000 (5 ngày) + đến hạn hôm nay 500.000; phiếu chưa hạn/tất toán/không hạn bị loại; tổng ở DB", async () => {
    const s = await getTodaySummary(t.runtime, O, { propertyId: A.propertyId, now: NOW });
    expect(s.debts).toMatchObject({
      overdue_count: 1,
      overdue_amount: 1_580_000,
      due_today_count: 1,
      due_today_amount: 500_000,
      total_count: 2,
      total_amount: 2_080_000,
    });
    expect(s.debts?.top[0]).toMatchObject({
      open_amount: 1_580_000,
      days_overdue: 5,
      due_on: "2026-10-10",
      payer_name: "Trần Thị Nợ Quá Hạn",
    });
    expect(s.debts?.top.map((x) => x.open_amount)).toEqual([1_580_000, 500_000]); // top theo số tiền giảm dần
    const top1 = await getTodaySummary(t.runtime, O, { propertyId: A.propertyId, now: NOW, debtTop: 1 });
    expect(top1.debts?.top).toHaveLength(1);
    expect(top1.debts?.total_amount).toBe(2_080_000); // tổng không phụ thuộc N
  });

  it("thông báo lưu trú: quá hạn 1 + đến hạn hôm nay 1; hạn sang ngày kinh doanh sau và chưa cấu hình hạn không tính", async () => {
    const s = await getTodaySummary(t.runtime, O, { propertyId: A.propertyId, now: NOW });
    expect(s.residence_notices).toMatchObject({ overdue_count: 1, due_today_count: 1 });
    expect(s.residence_notices?.items.map((x) => x.overdue)).toEqual([true, false]); // quá hạn lên đầu
  });

  it("hợp đồng sắp hết hạn: trong 30 ngày + đã quá hạn vẫn active (days_left âm); đổi tầm nhìn 7 ngày chỉ còn hợp đồng đã quá hạn", async () => {
    const s = await getTodaySummary(t.runtime, O, { propertyId: A.propertyId, now: NOW });
    expect(s.leases_expiring?.items.map((x) => x.days_left)).toEqual([-5, 21]);
    const w = await getTodaySummary(t.runtime, O, {
      propertyId: A.propertyId,
      now: NOW,
      leaseHorizonDays: 7,
    });
    expect(w.leases_expiring?.count).toBe(1);
    expect(w.leases_expiring?.horizon_days).toBe(7);
  });

  it("không lọc cơ sở: gộp mọi cơ sở trong phạm vi, mỗi cơ sở một ngày kinh doanh riêng", async () => {
    const s = await getTodaySummary(t.runtime, O, { now: NOW });
    expect(s.properties.map((p) => p.name)).toEqual(["HS1", "HS2"]);
    expect(s.cards.arrivals).toBe(4); // 3 của HS1 + 1 của HS2
    expect(s.cards.cleaning).toBe(5);
    expect(s.debts).toMatchObject({ overdue_count: 2, overdue_amount: 2_510_000 }); // 1.580.000 + 930.000 (S-009)
    // Hai cơ sở lệch ngày kinh doanh (20:30Z: HS1 03:30 ngày 16 < giờ chốt 04:00 → 15; HS2 05:30 ngày 16 → 16).
    const late = await getTodaySummary(t.runtime, O, { now: new Date("2026-10-15T20:30:00Z") });
    expect(late.properties.map((p) => p.business_date)).toEqual(["2026-10-15", "2026-10-16"]);
    expect(late.business_date).toBeNull();
  });

  it("giới hạn danh sách: itemLimit cắt danh sách nhưng số thẻ vẫn đầy đủ", async () => {
    const s = await getTodaySummary(t.runtime, O, { propertyId: A.propertyId, now: NOW, itemLimit: 1 });
    expect(s.guests?.arrivals).toHaveLength(1);
    expect(s.cards.arrivals).toBe(3);
    expect(s.cleaning?.items).toHaveLength(1);
    expect(s.cards.cleaning).toBe(4);
    expect(s.leases_expiring?.items).toHaveLength(1);
    expect(s.cards.leases_expiring).toBe(2);
  });
});

describe("today — S-008 ngày kinh doanh theo giờ chốt (INV-G2)", () => {
  it("giờ chốt 04:00: 01:30 ngày 16 vẫn là ngày kinh doanh 15; 03:59 → 15, 04:00 → 16 (UTC+7)", async () => {
    const at = (iso: string) =>
      getTodaySummary(t.runtime, O, { propertyId: A.propertyId, now: new Date(iso) });
    expect((await at("2026-10-15T18:30:00Z")).business_date).toBe("2026-10-15"); // 01:30 ngày 16 giờ cơ sở
    expect((await at("2026-10-15T20:59:00Z")).business_date).toBe("2026-10-15"); // 03:59
    expect((await at("2026-10-15T21:00:00Z")).business_date).toBe("2026-10-16"); // 04:00
  });

  it("qua ranh giới: khách đến ngày 16 chỉ vào thẻ 'đến' từ 04:00; khách đi ngày 15 không còn là 'đi' nữa", async () => {
    const before = await getTodaySummary(t.runtime, O, {
      propertyId: A.propertyId,
      now: new Date("2026-10-15T20:59:00Z"),
    });
    const after = await getTodaySummary(t.runtime, O, {
      propertyId: A.propertyId,
      now: new Date("2026-10-15T21:00:00Z"),
    });
    expect(before.cards.arrivals).toBe(3);
    expect(after.cards.arrivals).toBe(1); // chỉ lượt đến 2026-10-16
    expect(before.cards.departures).toBe(2);
    expect(after.cards.departures).toBe(0);
    expect(after.cards.overstays).toBe(2); // D1 (đi 15) giờ là quá ngày đi, cộng O1
  });
});

describe("today — S-007 theo vai trò và phạm vi cơ sở", () => {
  it("buồng phòng chỉ thấy phòng cần dọn: không khoá tiền/khách/thông báo/hợp đồng, không số tiền hay tên khách nào", async () => {
    const s = await getTodaySummary(t.runtime, H, { now: NOW });
    expect(Object.keys(s.cards)).toEqual(["cleaning"]);
    expect(s.cleaning?.count).toBe(4);
    for (const k of ["guests", "debts", "billing_review", "residence_notices", "leases_expiring"]) {
      expect(Object.hasOwn(s, k), k).toBe(false);
    }
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/amount|1580000|Nguyễn|Trần|guest_name|payer/);
  });

  it("kế toán: tiền + kỳ thu + khách (chỉ xem) + dọn; không thông báo lưu trú/hợp đồng; không có trường giấy tờ", async () => {
    const s = await getTodaySummary(t.runtime, K, { now: NOW });
    expect(s.debts?.overdue_count).toBe(2);
    expect(s.billing_review?.count).toBe(1);
    expect(s.guests).toBeDefined();
    expect(s.cleaning).toBeDefined();
    expect(Object.hasOwn(s, "residence_notices")).toBe(false);
    expect(Object.hasOwn(s, "leases_expiring")).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/doc_number|document|identity|cccd|passport/i);
  });

  it("lễ tân: khách + tiền + thông báo lưu trú + dọn; không kỳ thu cần duyệt, không hợp đồng", async () => {
    const s = await getTodaySummary(t.runtime, F, { propertyId: A.propertyId, now: NOW });
    expect(Object.keys(s.cards).sort()).toEqual(
      [
        "arrivals",
        "cleaning",
        "debt_due_or_overdue",
        "departures",
        "in_house",
        "overstays",
        "residence_notices",
      ].sort(),
    );
  });

  it("quản lý chỉ HS1: không thấy dữ liệu HS2; hỏi HS2 → 404 NOT_FOUND; quản lý HS1+HS2 thấy cả hai", async () => {
    const s = await getTodaySummary(t.runtime, M1, { now: NOW });
    expect(s.properties.map((p) => p.name)).toEqual(["HS1"]);
    expect(s.cards.arrivals).toBe(3);
    expect(s.debts?.overdue_amount).toBe(1_580_000);
    expect(JSON.stringify(s)).not.toMatch(/Kawasaki|Khách nợ HS2/);
    expect(
      await code(getTodaySummary(t.runtime, M1, { propertyId: HS2.propertyId, now: NOW })),
    ).toMatchObject({ code: "NOT_FOUND", status: 404 });
    const both = await getTodaySummary(t.runtime, M12, { now: NOW });
    expect(both.properties.map((p) => p.name)).toEqual(["HS1", "HS2"]);
    expect(both.cards.arrivals).toBe(4);
  });

  it("quản lý chưa gán cơ sở nào: trả khung rỗng (0), không lỗi, không dữ liệu của ai", async () => {
    const s = await getTodaySummary(t.runtime, M0, { now: NOW });
    expect(s.properties).toEqual([]);
    expect(s.business_date).toBeNull();
    expect(s.cards.arrivals).toBe(0);
    expect(s.cards.cleaning).toBe(0);
    expect(s.debts?.total_amount).toBe(0);
  });

  it("người thuê không có màn Hôm nay → 403 FORBIDDEN; cơ sở không phải UUID → 404", async () => {
    expect(await code(getTodaySummary(t.runtime, TN, { now: NOW }))).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect(
      await code(getTodaySummary(t.runtime, O, { propertyId: "không-phải-uuid", now: NOW })),
    ).toMatchObject({ code: "NOT_FOUND" });
  });

  it("chéo tenant: chủ B không thấy gì của A (thẻ chỉ theo dữ liệu B); hỏi cơ sở của A → 404", async () => {
    const s = await getTodaySummary(t.runtime, OB, { now: NOW });
    expect(s.cards).toMatchObject({ arrivals: 1, cleaning: 1, debt_due_or_overdue: 1 });
    expect(s.debts?.total_amount).toBe(7_777_000);
    expect(JSON.stringify(s)).not.toMatch(/Nguyễn|Kawasaki|Trần/);
    expect(await code(getTodaySummary(t.runtime, OB, { propertyId: A.propertyId, now: NOW }))).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });
});

describe("today — HTTP (đăng ký query)", () => {
  const get = (name: string, qs: string, user: string, org: string) => {
    const q = QUERIES[name];
    if (!q) throw new Error(`thiếu query ${name}`);
    return handleQuery(
      q,
      new Request(`http://x/api/v1/${name.replace(".", "/")}?${qs}`, {
        headers: { "x-test-user": user, "x-org-id": org },
      }),
      deps,
    );
  };

  it("today.getSummary: 200 cho chủ, buồng phòng chỉ nhận phần dọn; tham số lạ → 422; cơ sở ngoài phạm vi → 404", async () => {
    const ok = await get("today.getSummary", `property_id=${A.propertyId}`, A.ownerAuthUserId, A.orgId);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: { cards: Record<string, number> } };
    expect(body.data.cards).toHaveProperty("arrivals");
    expect((await get("today.getSummary", "bogus=1", A.ownerAuthUserId, A.orgId)).status).toBe(422);
    expect(
      (await get("today.getSummary", `property_id=${A.propertyId}`, OB.authUserId, B.orgId)).status,
    ).toBe(404);
  });

  it("audit.listEvents: 200 cho chủ; 422 khi khoảng > 366 ngày (VALIDATION_FAILED) hoặc bộ lọc sai; 404 cơ sở của tổ chức khác", async () => {
    const ok = await get("audit.listEvents", "limit=5", C.ownerAuthUserId, C.orgId);
    expect(ok.status).toBe(200);
    const tooLong = await get(
      "audit.listEvents",
      "from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z",
      C.ownerAuthUserId,
      C.orgId,
    );
    expect(tooLong.status).toBe(422);
    expect(((await tooLong.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
    expect((await get("audit.listEvents", "action=Khong-Hop-Le", C.ownerAuthUserId, C.orgId)).status).toBe(
      422,
    );
    expect(
      (await get("audit.listEvents", `property_id=${A.propertyId}`, C.ownerAuthUserId, C.orgId)).status,
    ).toBe(404);
  });
});

// ============================================================ nhật ký audit (S-004, S-005, S-019)

describe("audit — dữ liệu nhật ký (tổ chức C: CP1 UTC+7, CP2 UTC+7)", () => {
  let CM1: Actor; // quản lý chỉ CP1
  let CM2: Actor; // quản lý chỉ CP2
  let CK: Actor; // kế toán mọi cơ sở
  let CK1: Actor; // kế toán chỉ CP1
  let CF: Actor;
  let CH: Actor;
  let CT: Actor;
  let ownerPerson: string;
  let kPerson: string;
  const T0 = Date.parse("2026-10-15T10:00:00Z");
  const at = (min: number) => new Date(T0 + min * 60_000);

  async function ev(o: {
    property?: string | null;
    action: string;
    entity?: string;
    entityId?: string | null;
    at: Date | string;
    actor?: string | null;
    correlation?: string;
    org?: string;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    outcome?: string;
  }): Promise<string> {
    const id = randomUUID();
    const actor = o.actor === undefined ? ownerPerson : o.actor;
    await sql`insert into audit_events (id, organization_id, property_id, occurred_at, actor_type, actor_person_id, action, entity_type,
                                        entity_id, before, after, reason, correlation_id, outcome)
              values (${id}, ${o.org ?? C.orgId}, ${o.property ?? null}, ${o.at}::timestamptz, ${actor ? "user" : "worker"}, ${actor},
                      ${o.action}, ${o.entity ?? "thing"}, ${o.entityId ?? null},
                      ${o.before === undefined ? null : JSON.stringify(o.before)}::jsonb,
                      ${o.after === undefined ? null : JSON.stringify(o.after)}::jsonb, ${o.reason ?? null},
                      ${o.correlation ?? `c-${id.slice(0, 8)}`}, ${o.outcome ?? "success"})`.execute(t.admin);
    return id;
  }

  const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id);
  const list = (actor: Actor, over: Parameters<typeof listAuditEvents>[2] = {}) =>
    listAuditEvents(t.runtime, actor, { now: at(600), limit: 200, ...over });

  let evPay1: string; // payment.confirmed @CP1
  let evInv2: string; // invoice.issued @CP2
  let evLease1: string; // lease.created @CP1
  let evOrg: string; // member.role_changed cấp tổ chức
  let evDep2: string; // deposit.received @CP2
  let evPeriod1: string; // period.locked @CP1
  const c9: string[] = [];

  beforeAll(async () => {
    ownerPerson = C.ownerPersonId;
    CM1 = (await member(C, "manager", [C.propertyId])).actor;
    CM2 = (await member(C, "manager", [CP2.propertyId])).actor;
    CK = (await member(C, "accountant", "all")).actor;
    const k1 = await member(C, "accountant", [C.propertyId]);
    CK1 = k1.actor;
    kPerson = k1.personId;
    CF = (await member(C, "front_desk", [C.propertyId])).actor;
    CH = (await member(C, "housekeeping", [C.propertyId], false)).actor;
    CT = (await member(C, "tenant", [], false)).actor;

    evPay1 = await ev({
      property: C.propertyId,
      action: "payment.confirmed",
      entity: "payment",
      at: at(1),
      actor: kPerson,
      before: { status: "pending" },
      after: { status: "confirmed", amount: 2_000_000 },
      reason: "Sao kê VCB 10/10",
    });
    evInv2 = await ev({ property: CP2.propertyId, action: "invoice.issued", entity: "invoice", at: at(2) });
    evLease1 = await ev({ property: C.propertyId, action: "lease.created", entity: "lease", at: at(3) });
    evOrg = await ev({ property: null, action: "member.role_changed", entity: "membership", at: at(4) });
    evDep2 = await ev({ property: CP2.propertyId, action: "deposit.received", entity: "deposit", at: at(5) });
    evPeriod1 = await ev({ property: C.propertyId, action: "period.locked", entity: "period", at: at(6) });
    // S-005: một request tạo 3 sự kiện cùng correlation_id c-9 (giữ phòng, cọc, outbox) — ghi lệch thứ tự để thử sắp xếp theo occurred_at.
    c9.push(
      await ev({
        property: C.propertyId,
        action: "allocation.held",
        entity: "allocation",
        at: at(20),
        correlation: "c-9",
      }),
    );
    c9.push(
      await ev({
        property: C.propertyId,
        action: "deposit.received",
        entity: "deposit",
        at: at(21),
        correlation: "c-9",
      }),
    );
    c9.push(
      await ev({
        property: C.propertyId,
        action: "outbox.emitted",
        entity: "outbox",
        at: at(22),
        correlation: "c-9",
      }),
    );
    // Tổ chức B có cùng correlation_id: không được lẫn sang C.
    await ev({
      org: B.orgId,
      property: B.propertyId,
      action: "payment.confirmed",
      entity: "payment",
      at: at(20),
      correlation: "c-9",
      actor: B.ownerPersonId,
    });
  });

  it("S-004 chủ: mọi sự kiện của tổ chức, gồm cấp tổ chức (không cơ sở) và cả hai cơ sở", async () => {
    const r = await list(OC);
    for (const id of [evPay1, evInv2, evLease1, evOrg, evDep2, evPeriod1, ...c9])
      expect(ids(r)).toContain(id);
    expect(
      r.items.every((i) => i.property_id === null || [C.propertyId, CP2.propertyId].includes(i.property_id)),
    ).toBe(true);
    // mặc định mới → cũ
    const times = r.items.map((i) => Date.parse(i.occurred_at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("S-004 quản lý chỉ CP1: chỉ sự kiện CP1 (không CP2, không cấp tổ chức); property_id=CP2 → 404 NOT_FOUND", async () => {
    const r = await list(CM1);
    expect(ids(r)).toEqual(expect.arrayContaining([evPay1, evLease1, evPeriod1]));
    expect(ids(r)).not.toContain(evInv2);
    expect(ids(r)).not.toContain(evDep2);
    expect(ids(r)).not.toContain(evOrg);
    expect(r.items.every((i) => i.property_id === C.propertyId)).toBe(true);
    expect(await code(list(CM1, { propertyId: CP2.propertyId }))).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(ids(await list(CM1, { propertyId: C.propertyId }))).toContain(evPay1);
    // Cơ sở không tồn tại cũng 404 y hệt (không phân biệt "ngoài phạm vi" với "không có") — kể cả với chủ.
    expect(await code(list(OC, { propertyId: randomUUID() }))).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(await code(list(OC, { propertyId: B.propertyId }))).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("S-004 kế toán: chỉ nhóm tiền (payment/invoice/deposit/period); lọc hành động ngoài nhóm → rỗng; kế toán CP1 chỉ tiền của CP1", async () => {
    const r = await list(CK);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => /^(payment|invoice|deposit|period)\./.test(i.action))).toBe(true);
    expect(ids(r)).toEqual(expect.arrayContaining([evPay1, evInv2, evDep2, evPeriod1]));
    expect(ids(r)).not.toContain(evLease1);
    expect(ids(r)).not.toContain(evOrg);
    expect((await list(CK, { action: "lease.created" })).items).toEqual([]);
    expect((await list(CK, { entityType: "lease" })).items).toEqual([]);
    const r1 = await list(CK1);
    expect(ids(r1)).toEqual(expect.arrayContaining([evPay1, evPeriod1]));
    expect(ids(r1)).not.toContain(evInv2);
    expect(ids(r1)).not.toContain(evDep2);
  });

  it("S-004 lễ tân, buồng phòng, người thuê → 403 FORBIDDEN với mọi bộ lọc (kể cả cơ sở ngoài phạm vi)", async () => {
    for (const a of [CF, CH, CT]) {
      expect(await code(list(a))).toMatchObject({ code: "FORBIDDEN", status: 403 });
      expect(await code(list(a, { propertyId: CP2.propertyId }))).toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });
      expect(await code(list(a, { correlationId: "c-9" }))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    }
  });

  it("S-005 lọc correlation_id=c-9: đúng 3 sự kiện, sắp theo occurred_at tăng dần, kèm giờ theo múi giờ cơ sở; không lẫn tổ chức B", async () => {
    const r = await list(OC, { correlationId: "c-9" });
    expect(ids(r)).toEqual(c9);
    expect(r.items.map((i) => i.action)).toEqual(["allocation.held", "deposit.received", "outbox.emitted"]);
    expect(r.items[0]).toMatchObject({
      occurred_at: "2026-10-15T10:20:00.000Z",
      occurred_at_local: "2026-10-15 17:20:00",
      timezone: "Asia/Ho_Chi_Minh",
    });
    // Quản lý chỉ CP2 lọc c-9 (sự kiện thuộc CP1) → rỗng; kế toán chỉ thấy phần tiền của c-9.
    expect((await list(CM2, { correlationId: "c-9" })).items).toEqual([]);
    expect((await list(CK, { correlationId: "c-9" })).items.map((i) => i.action)).toEqual([
      "deposit.received",
    ]);
    // Chủ B chỉ thấy bản của B.
    const rb = await list(OB, { correlationId: "c-9" });
    expect(rb.items).toHaveLength(1);
    expect(rb.items[0]?.action).toBe("payment.confirmed");
    // Sắp xếp giảm dần khi yêu cầu.
    expect(ids(await list(OC, { correlationId: "c-9", order: "desc" }))).toEqual([...c9].reverse());
    // Không khớp → rỗng, không lỗi.
    expect((await list(OC, { correlationId: "khong-co" })).items).toEqual([]);
  });

  it("S-005 thực tế: command qua pipeline ghi audit với correlation_id của request và đọc lại được qua bộ lọc", async () => {
    const r = await executeCommand<{ ok: true }>(
      t.runtime,
      OC,
      {
        command: "audit.test",
        idempotencyKey: randomUUID(),
        payload: { a: 1 },
        correlationId: "c-real-0001",
      },
      async (ctx) => {
        await ctx.audit({
          action: "payment.confirmed",
          entityType: "payment",
          entityId: randomUUID(),
          propertyId: C.propertyId,
          before: { status: "pending" },
          after: { status: "confirmed", cccd: "012345678901" },
          reason: "Sao kê VCB 10/10",
        });
        return { data: { ok: true } };
      },
    );
    expect(r.status).toBe("committed");
    const got = await listAuditEvents(t.runtime, OC, { correlationId: "c-real-0001" });
    expect(got.items).toHaveLength(1);
    expect(got.items[0]).toMatchObject({
      action: "payment.confirmed",
      reason: "Sao kê VCB 10/10",
      correlation_id: "c-real-0001",
      before: { status: "pending" },
      actor_person_id: OC.personId,
    });
    expect(got.items[0]?.command_id).toBeTruthy();
    expect(JSON.stringify(got)).not.toContain("012345678901");
  });

  it("không trả dữ liệu nhạy cảm dạng thô: hàng ghi thẳng (không qua pipeline) vẫn bị che khi đọc", async () => {
    const id = await ev({
      property: C.propertyId,
      action: "person.updated",
      entity: "person",
      at: at(30),
      correlation: "c-raw-1",
      before: { doc_number: "012345678901", note: "CCCD 012345678901 và SĐT 0901234567" },
      after: {
        password: "mat-khau-that",
        token: "tok_live_123",
        nested: { cccd: "098765432109", ok: "giữ nguyên" },
      },
      reason: "đối chiếu 012345678901",
    });
    const r = await list(OC, { correlationId: "c-raw-1" });
    expect(ids(r)).toEqual([id]);
    const json = JSON.stringify(r);
    for (const secret of ["012345678901", "098765432109", "mat-khau-that", "tok_live_123", "0901234567"]) {
      expect(json, secret).not.toContain(secret);
    }
    expect(json).toContain("giữ nguyên"); // dữ liệu thường không bị che
  });

  it("lọc theo người làm, thực thể, hành động, kết quả; UUID sai → VALIDATION_FAILED", async () => {
    const entityId = randomUUID();
    const a = await ev({
      property: C.propertyId,
      action: "lease.signed",
      entity: "lease",
      entityId,
      at: at(40),
      actor: kPerson,
    });
    const d = await ev({
      property: C.propertyId,
      action: "command.denied",
      entity: "command",
      at: at(41),
      outcome: "denied",
    });
    expect(ids(await list(OC, { entityType: "lease", entityId }))).toEqual([a]);
    expect(ids(await list(OC, { action: "lease.signed" }))).toEqual([a]);
    expect(ids(await list(OC, { outcome: "denied" }))).toEqual([d]);
    const byActor = await list(OC, { actorPersonId: kPerson });
    expect(byActor.items.length).toBeGreaterThanOrEqual(2);
    expect(byActor.items.every((i) => i.actor_person_id === kPerson)).toBe(true);
    expect(byActor.items[0]?.actor_name).toBe("NV accountant");
    expect(await code(list(OC, { actorPersonId: "x" }))).toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
    expect(await code(list(OC, { correlationId: "có dấu cách" }))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("S-019 khoảng thời gian: tối đa 366 ngày (đúng 366 được, 367 → VALIDATION_FAILED); to ≤ from → VALIDATION_FAILED; mặc định 30 ngày", async () => {
    const to = new Date("2026-10-16T00:00:00Z");
    const from366 = new Date(to.getTime() - AUDIT_MAX_RANGE_DAYS * 86_400_000);
    expect((await list(OC, { from: from366, to })).range.from).toBe(from366.toISOString());
    const err = await code(list(OC, { from: new Date(from366.getTime() - 1), to }));
    expect(err).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    expect(JSON.stringify(err)).toContain("RANGE_TOO_LARGE");
    expect(await code(list(OC, { from: to, to: from366 }))).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await code(list(OC, { from: to, to }))).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await code(list(OC, { from: new Date("không phải ngày") }))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    // Mặc định: 30 ngày gần nhất tính từ `now`; sự kiện cũ hơn không có, nhưng tra theo correlation_id thì vẫn thấy (không buộc khoảng).
    const old = await ev({
      property: C.propertyId,
      action: "lease.created",
      entity: "lease",
      at: new Date(at(600).getTime() - 40 * 86_400_000),
      correlation: "c-old-1",
    });
    expect(ids(await list(OC))).not.toContain(old);
    expect(ids(await list(OC, { correlationId: "c-old-1" }))).toEqual([old]);
    expect(ids(await list(OC, { from: new Date(at(600).getTime() - 41 * 86_400_000) }))).toContain(old);
  });

  it("keyset: phân trang không trùng, không sót — kể cả nhiều sự kiện cùng thời điểm và lệch nhau micro giây; cả hai chiều", async () => {
    // Dải riêng (ngày 2026-09-20) để đếm chính xác: 12 sự kiện cùng một micro giây + 6 sự kiện cách nhau 1 micro giây.
    const same = "2026-09-20T03:00:00.123456Z";
    const made: string[] = [];
    for (let i = 0; i < 12; i++)
      made.push(await ev({ property: C.propertyId, action: "page.same", at: same }));
    for (let i = 0; i < 6; i++)
      made.push(
        await ev({ property: C.propertyId, action: "page.micro", at: `2026-09-20T03:00:00.12345${i}Z` }),
      );
    const win = { from: new Date("2026-09-20T00:00:00Z"), to: new Date("2026-09-21T00:00:00Z") };
    for (const order of ["desc", "asc"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const p = await list(OC, { ...win, order, limit: 5, ...(cursor ? { cursor } : {}) });
        expect(p.items.length).toBeLessThanOrEqual(5);
        seen.push(...ids(p));
        cursor = p.next_cursor ?? undefined;
        pages++;
      } while (cursor && pages < 20);
      expect(pages).toBe(4); // 18 dòng / 5 = 4 trang
      expect(new Set(seen).size).toBe(seen.length); // không trùng
      expect([...seen].sort()).toEqual([...made].sort()); // không sót
      const whole = ids(await list(OC, { ...win, order, limit: 200 }));
      expect(seen).toEqual(whole); // thứ tự phân trang = thứ tự một lần lấy hết
    }
    // Trang cuối đúng bằng giới hạn → không còn trang kế (next_cursor null).
    const exact = await list(OC, { ...win, limit: 18 });
    expect(exact.items).toHaveLength(18);
    expect(exact.next_cursor).toBeNull();
    // cursor hỏng / khác chiều sắp xếp → VALIDATION_FAILED.
    expect(await code(list(OC, { ...win, cursor: "###" }))).toMatchObject({ code: "VALIDATION_FAILED" });
    const p1 = await list(OC, { ...win, limit: 5, order: "desc" });
    expect(
      await code(list(OC, { ...win, limit: 5, order: "asc", cursor: p1.next_cursor as string })),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("chéo tenant: chủ C không thấy sự kiện của A/B dù lọc đúng id/correlation; kết quả rỗng thay vì lỗi", async () => {
    const foreign = await ev({
      org: B.orgId,
      property: B.propertyId,
      action: "lease.created",
      entity: "lease",
      at: at(50),
      correlation: "c-only-b",
      actor: B.ownerPersonId,
    });
    expect((await list(OC, { correlationId: "c-only-b" })).items).toEqual([]);
    expect(ids(await list(OB, { correlationId: "c-only-b" }))).toEqual([foreign]);
    const all = await list(OC);
    expect(all.items.every((i) => i.actor_person_id === null || i.actor_person_id !== B.ownerPersonId)).toBe(
      true,
    );
  });

  it("nhật ký rỗng: tổ chức chưa có sự kiện → items [] và next_cursor null", async () => {
    const empty = await seedOrg(t.admin, "KS trống", "hotel");
    const owner = await resolveActor(t.runtime, {
      authUserId: empty.ownerAuthUserId,
      orgId: empty.orgId,
      twoFactorEnabled: true,
    });
    const r = await listAuditEvents(t.runtime, owner, { now: at(600) });
    expect(r).toMatchObject({ items: [], next_cursor: null });
  });
});
