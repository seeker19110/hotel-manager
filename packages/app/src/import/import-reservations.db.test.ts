// PLAN đợt 3 T-208 — import booking đang có/tương lai (SPEC-import S-009; SPEC-reservation-stay S-003, S-005, S-014; INV-G3, INV-I1)
// trên Postgres thật. Fixture: cơ sở khách sạn A (nhận 14:00 / trả 12:00, Asia/Ho_Chi_Minh), chủ O (xác nhận/commit), quản lý M
// (`import.prepare`); cơ sở của tổ chức B để kiểm chéo tenant. Ngày mốc chuyển đổi 2026-11-01.
// Giá trong file = giá đã chốt với khách ⇒ ảnh chụp `nightly_prices` (không đọc bảng giá); ứng trước đầu kỳ = Nợ OPENING_BALANCE /
// Có CUSTOMER_CREDIT (không CASH/BANK/REV_*, không tạo `payments`).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { eicarOnlyScanner } from "../files/inspect.ts";
import { ObjectStorage } from "../files/storage.ts";
import { executeCommand } from "../pipeline/command.ts";
import { confirmReservation, createReservation, holdReservation } from "../reservation/reservation.ts";
import {
  commitBatch,
  confirmBatch,
  downloadErrorReport,
  getBatch,
  getTemplate,
  IMPORT_COLUMNS,
  type ImportPreview,
  nightlyAmountsOf,
  uploadBatch,
  validateBatch,
} from "./import.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let O: Actor;
let M: Actor;
let OB: Actor;
let storage: ObjectStorage;
const deps = () => ({ storage, scanner: eicarOnlyScanner });
const CUTOFF = "2026-11-01";
const HEADER = [
  "external_id",
  "unit_code",
  "arrival_on",
  "departure_on",
  "guest_name",
  "guest_phone",
  "guests",
  "nightly_price",
  "total_amount",
  "advance_amount",
];

type Row = (string | number)[];
type Problem = {
  code: string;
  status: number;
  errors?: { field: string; code: string }[];
};

async function member(role: string): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${A.orgId}, ${user}, ${person}, ${role})`.execute(t.admin);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${A.orgId}, ${membership}, ${A.propertyId})`.execute(t.admin);
  return resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
}

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3], key: string = randomUUID()) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "import.test", idempotencyKey: key, payload: { key }, correlationId: "c-import-res" },
    fn,
  );
}

async function ok<T>(p: Promise<Awaited<ReturnType<typeof run<T>>>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

async function fails(p: Promise<{ status: string; problem?: unknown }>): Promise<Problem> {
  const r = await p;
  if (r.status !== "failed") throw new Error("lẽ ra thất bại");
  return r.problem as Problem;
}

/** CSV đầu vào (file người dùng, không chống injection). */
function csv(rows: Row[]): Uint8Array {
  const q = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return new TextEncoder().encode(rows.map((r) => r.map(q).join(",")).join("\r\n"));
}

const uniq = () => randomUUID().slice(0, 6);

/** Phòng riêng cho mỗi test (loại phòng STD sức chứa 2, KHÔNG có bảng giá — chứng minh giá lấy từ file). */
async function newUnit(org: SeededOrg = A, capacity?: number): Promise<{ id: string; code: string }> {
  const id = randomUUID();
  const code = `R${uniq()}`;
  let typeId = org.roomTypeId;
  if (capacity !== undefined) {
    typeId = randomUUID();
    await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
              values (${typeId}, ${org.orgId}, ${org.propertyId}, ${`C${uniq()}`}, 'Loại thử', ${capacity})`.execute(
      t.admin,
    );
  }
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${id}, ${org.orgId}, ${org.propertyId}, ${org.floorId}, ${typeId}, ${code})`.execute(
    t.admin,
  );
  return { id, code };
}

/** Dòng booking hợp lệ mặc định (2 đêm 10→12/11, giá đêm 650.000); ghi đè từng cột theo tên. */
function line(unitCode: string, o: Partial<Record<(typeof HEADER)[number], string | number>> = {}): Row {
  const base: Record<string, string | number> = {
    external_id: `BK-${uniq()}`,
    unit_code: unitCode,
    arrival_on: "2026-11-10",
    departure_on: "2026-11-12",
    guest_name: "Nguyễn Văn A",
    guest_phone: "0900000001",
    guests: 2,
    nightly_price: 650000,
    total_amount: "",
    advance_amount: "",
    ...o,
  };
  return HEADER.map((h) => base[h] ?? "");
}

const upload = (a: Actor, rows: Row[], propertyId = A.propertyId, cutoffOn: string | null = CUTOFF) =>
  run<{ batchId: string; rows: number }>(a, async (ctx) => ({
    data: await uploadBatch(ctx, deps(), {
      propertyId,
      kind: "reservations",
      bytes: csv([HEADER, ...rows]),
      ...(cutoffOn === null ? {} : { cutoffOn }),
    }),
  }));
const validate = (a: Actor, batchId: string) =>
  run<ImportPreview>(a, async (ctx) => ({ data: await validateBatch(ctx, { batchId }) }));
const confirm = (a: Actor, batchId: string) =>
  run(a, async (ctx) => ({ data: await confirmBatch(ctx, { batchId }) }));
const commit = (a: Actor, batchId: string) =>
  run<{ created: number; skipped: number }>(a, async (ctx) => ({
    data: await commitBatch(ctx, { batchId }),
  }));

/** Tải lên + kiểm; trả batchId và xem trước. */
async function preview(rows: Row[], a: Actor = M) {
  const { batchId } = await ok(upload(a, rows));
  return { batchId, pv: await ok(validate(a, batchId)) };
}

async function loadAll(rows: Row[]) {
  const { batchId, pv } = await preview(rows);
  if (pv.counts.error > 0) throw new Error(JSON.stringify(pv.errors));
  await ok(confirm(O, batchId));
  const res = await ok(commit(O, batchId));
  return { batchId, pv, res };
}

const q = async <T extends object>(s: ReturnType<typeof sql<T>>) => (await s.execute(t.admin)).rows;

const reservationsOf = (batchId: string) =>
  q(sql<{
    id: string;
    status: string;
    source: string;
    confirmed_without_payment: boolean;
    confirmation_payment_id: string | null;
    booker_person_id: string;
  }>`select r.id, r.status, r.source, r.confirmed_without_payment, r.confirmation_payment_id, r.booker_person_id
     from import_external_refs x join reservations r on r.id = x.target_id
     where x.batch_id = ${batchId} order by x.external_id`);

const countRes = async (propertyId: string) =>
  (
    await q(sql<{ n: number }>`select count(*)::int as n from reservations where property_id = ${propertyId}`)
  )[0]?.n;

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "KS chuyển đổi", "hotel");
  B = await seedOrg(t.admin, "KS tổ chức khác", "hotel");
  for (const o of [A, B]) {
    await sql`update properties set check_in_time = '14:00', check_out_time = '12:00', business_day_cutoff = '04:00'
              where id = ${o.propertyId}`.execute(t.admin);
  }
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  OB = await resolveActor(t.runtime, {
    authUserId: B.ownerAuthUserId,
    orgId: B.orgId,
    twoFactorEnabled: true,
  });
  M = await member("manager");
});

afterAll(async () => {
  await t.drop();
});

describe("mẫu file và hàm giá đêm (thuần)", () => {
  it("S-001: mẫu `reservations` có đủ cột theo SPEC và dòng ví dụ", () => {
    const tpl = getTemplate(M, "reservations");
    expect(tpl.csv.replace("﻿", "").split("\r\n")[0]).toBe(HEADER.join(","));
    expect(IMPORT_COLUMNS.reservations.filter((c) => c.required).map((c) => c.name)).toEqual([
      "external_id",
      "unit_code",
      "arrival_on",
      "departure_on",
      "guest_name",
      "guest_phone",
    ]);
  });

  it("nightlyAmountsOf: giá đêm đều; chỉ có tổng thì chia đều, phần dư dồn đêm đầu, Σ đúng từng đồng", () => {
    expect(nightlyAmountsOf("2026-11-10", "2026-11-12", 650000, null).map((n) => n.amount)).toEqual([
      650000, 650000,
    ]);
    const r = nightlyAmountsOf("2026-11-30", "2026-12-03", null, 1000001);
    expect(r.map((n) => n.businessDate)).toEqual(["2026-11-30", "2026-12-01", "2026-12-02"]);
    expect(r.map((n) => n.amount)).toEqual([333334, 333334, 333333]);
    expect(r.reduce((s, n) => s + n.amount, 0)).toBe(1000001);
    // 1 đêm: toàn bộ tổng; tổng nhỏ hơn số đêm: đêm cuối 0 đ (không âm).
    expect(nightlyAmountsOf("2026-11-10", "2026-11-11", null, 7).map((n) => n.amount)).toEqual([7]);
    expect(nightlyAmountsOf("2026-11-10", "2026-11-13", null, 2).map((n) => n.amount)).toEqual([1, 1, 0]);
  });
});

describe("S-009 booking tương lai trùng phòng", () => {
  it("phòng đã có booking 10→12/11: dòng 11→13/11 lỗi ROOM_UNAVAILABLE, dòng khác vẫn 'sẽ tạo'; commit bị chặn, không ghi gì", async () => {
    const u201 = await newUnit();
    const u202 = await newUnit();
    // Booking có sẵn trong hệ thống (qua đúng hàm module đặt phòng).
    await ok(
      run(O, async (ctx) => {
        const r = await createReservation(ctx, {
          booker: { fullName: "Khách có sẵn", phone: "0911111111" },
          rooms: [{ unitId: u201.id, guests: 1 }],
          arrivalDate: "2026-11-10",
          departureDate: "2026-11-12",
          nightlyRates: nightlyAmountsOf("2026-11-10", "2026-11-12", 600000, null),
        });
        await holdReservation(ctx, { reservationId: r.id });
        await confirmReservation(ctx, { reservationId: r.id, imported: true });
        return { data: r.id };
      }),
    );
    const before = await countRes(A.propertyId);
    const { batchId, pv } = await preview([
      line(u201.code, { external_id: "BK-BUSY", arrival_on: "2026-11-11", departure_on: "2026-11-13" }),
      line(u202.code, { external_id: "BK-FREE" }),
    ]);
    expect(pv.counts).toMatchObject({ create: 1, error: 1 });
    expect(pv.errors).toEqual([
      expect.objectContaining({ row: 2, column: "unit_code", code: "ROOM_UNAVAILABLE" }),
    ]);
    expect(pv.rows.map((r) => [r.external_id, r.action])).toEqual([
      ["BK-BUSY", "error"],
      ["BK-FREE", "create"],
    ]);
    // Có lỗi dòng ⇒ không xác nhận/commit được (S-003).
    expect((await fails(confirm(O, batchId))).code).toBe("IMPORT_HAS_ERRORS");
    expect((await fails(commit(O, batchId))).code).toBe("IMPORT_HAS_ERRORS");
    expect(await countRes(A.propertyId)).toBe(before);
    // Báo cáo lỗi tải được và có mã.
    const rep = await downloadErrorReport(t.runtime, M, { batchId });
    expect(rep.csv).toContain("ROOM_UNAVAILABLE");
  });

  it("nối ngày với booking có sẵn (đi 12/11 12:00, đến 12/11 14:00) KHÔNG trùng; chồng một đêm thì trùng", async () => {
    const u = await newUnit();
    await loadAll([
      line(u.code, { external_id: "BK-1", arrival_on: "2026-11-10", departure_on: "2026-11-12" }),
    ]);
    const { pv } = await preview([
      line(u.code, { external_id: "BK-2", arrival_on: "2026-11-12", departure_on: "2026-11-14" }),
      line(u.code, { external_id: "BK-3", arrival_on: "2026-11-09", departure_on: "2026-11-11" }),
    ]);
    expect(pv.counts).toMatchObject({ create: 1, error: 1 });
    expect(pv.rows.map((r) => r.action)).toEqual(["create", "error"]);
  });
});

describe("commit nguyên khối qua module đặt phòng", () => {
  it("giá từ file (không có bảng giá), booking confirmed + stay expected + allocation stay; ứng trước = OPENING_BALANCE/CUSTOMER_CREDIT", async () => {
    const u1 = await newUnit();
    const u2 = await newUnit();
    const u3 = await newUnit();
    const { batchId, pv, res } = await loadAll([
      line(u1.code, { external_id: "BK-A", advance_amount: 500000 }),
      line(u2.code, {
        external_id: "BK-B",
        arrival_on: "2026-11-30",
        departure_on: "2026-12-03",
        nightly_price: "",
        total_amount: "1.000.001",
        guests: 1,
        guest_name: "Trần Thị B",
        guest_phone: "+84 912 345 678",
      }),
      line(u3.code, { external_id: "BK-C", advance_amount: 0 }),
    ]);
    expect(pv.totals).toEqual({ rows: 3, room_total: 1_300_000 + 1_000_001 + 1_300_000, advance: 500000 });
    expect(res).toMatchObject({ created: 3, skipped: 0 });

    const rows = await reservationsOf(batchId);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      // Xác nhận không kèm khoản thu: không có payment, không bịa chứng cứ (INV-F3 đi nhánh "không tiền").
      expect(r).toMatchObject({ status: "confirmed", source: "direct", confirmed_without_payment: true });
      expect(r.confirmation_payment_id).toBeNull();
    }
    const items = await q(sql<{
      external_id: string;
      nightly_prices: { business_date: string; amount: number }[];
      room_total: string;
      guests: number;
      nights: number;
      stay_status: string;
      alloc_kind: string;
      alloc_active: boolean;
    }>`select x.external_id, i.nightly_prices, i.room_total::text, i.guests, i.nights, s.status as stay_status,
              a.kind as alloc_kind, a.active as alloc_active
       from import_external_refs x join reservation_items i on i.reservation_id = x.target_id
       join stays s on s.reservation_item_id = i.id
       join allocations a on a.source_type = 'stay' and a.source_id = s.id
       where x.batch_id = ${batchId} order by x.external_id`);
    expect(
      items.map((i) => [i.external_id, i.room_total, i.nights, i.stay_status, i.alloc_kind, i.alloc_active]),
    ).toEqual([
      ["BK-A", "1300000", 2, "expected", "stay", true],
      ["BK-B", "1000001", 3, "expected", "stay", true],
      ["BK-C", "1300000", 2, "expected", "stay", true],
    ]);
    expect(items[0]?.nightly_prices.map((n) => n.amount)).toEqual([650000, 650000]);
    expect(items[1]?.nightly_prices.map((n) => [n.business_date, n.amount])).toEqual([
      ["2026-11-30", 333334],
      ["2026-12-01", 333334],
      ["2026-12-02", 333333],
    ]);
    expect(items[1]?.guests).toBe(1);

    // Người đặt tạo từ file (tên + SĐT).
    const booker = await q(sql<{ full_name: string; phone: string }>`
      select p.full_name, p.phone from persons p where p.id = ${rows[1]?.booker_person_id}`);
    expect(booker[0]).toEqual({ full_name: "Trần Thị B", phone: "+84 912 345 678" });

    // Sổ: chỉ một bút toán ứng trước (BK-A): Nợ OPENING_BALANCE / Có CUSTOMER_CREDIT; không CASH/BANK/REV_*; không payments mới.
    const lines = await q(sql<{ account: string; debit: string; credit: string; person_id: string | null }>`
      select l.account, l.debit::text, l.credit::text, l.person_id from journal_entries e
      join journal_lines l on l.entry_id = e.id
      where e.source_doc_type = 'import_batch' and e.source_doc_id = ${batchId} order by l.line_no`);
    expect(lines).toEqual([
      { account: "OPENING_BALANCE", debit: "500000", credit: "0", person_id: null },
      { account: "CUSTOMER_CREDIT", debit: "0", credit: "500000", person_id: rows[0]?.booker_person_id },
    ]);
    const money = await q(sql<{ n: number }>`
      select count(*)::int as n from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.property_id = ${A.propertyId} and l.account in ('CASH','BANK','REV_ROOM','REV_SERVICE','REV_FEE','REV_UTIL')
        and e.created_at > now() - interval '1 minute'`);
    expect(money[0]?.n).toBe(0);
    const pays = await q(
      sql<{
        n: number;
      }>`select count(*)::int as n from payments where reservation_id = any(${rows.map((r) => r.id)}::uuid[])`,
    );
    expect(pays[0]?.n).toBe(0);

    // Dòng nhập ghi đích và trạng thái lô.
    const tgt = await q(sql<{ target_id: string; action: string }>`
      select target_id, action from import_rows where batch_id = ${batchId} order by row_no`);
    expect(tgt.map((x) => x.action)).toEqual(["create", "create", "create"]);
    expect(tgt.map((x) => x.target_id).sort()).toEqual(rows.map((r) => r.id).sort());
    const b = await getBatch(t.runtime, M, { batchId });
    expect(b.status).toBe("committed");
    // Sự kiện xác nhận đánh dấu `imported` để thông báo không gửi khách như booking mới.
    const ev = await q(sql<{ payload: { imported?: boolean } }>`
      select payload from outbox where event_type = 'reservation.confirmed' and aggregate_id = ${rows[0]?.id}`);
    expect(ev[0]?.payload.imported).toBe(true);
  });

  it("S-005: import lại đúng file → mọi dòng 'không đổi — bỏ qua', commit tạo 0 bản ghi, không nhân đôi booking/bút toán", async () => {
    const u1 = await newUnit();
    const u2 = await newUnit();
    const rows = [
      line(u1.code, { external_id: "BK-R1", advance_amount: 100000 }),
      line(u2.code, { external_id: "BK-R2" }),
    ];
    await loadAll(rows);
    const resBefore = await countRes(A.propertyId);
    const jBefore = await q(
      sql<{ n: number }>`select count(*)::int as n from journal_entries where property_id = ${A.propertyId}`,
    );
    const { batchId, pv } = await preview(rows);
    expect(pv.counts).toMatchObject({ create: 0, skip_unchanged: 2, error: 0 });
    await ok(confirm(O, batchId));
    expect(await ok(commit(O, batchId))).toEqual({ status: "committed", created: 0, skipped: 2 });
    expect(await countRes(A.propertyId)).toBe(resBefore);
    const jAfter = await q(
      sql<{ n: number }>`select count(*)::int as n from journal_entries where property_id = ${A.propertyId}`,
    );
    expect(jAfter[0]?.n).toBe(jBefore[0]?.n);
  });

  it("S-006: cùng external_id nhưng nội dung khác (đổi ngày/giá/ứng trước) → IMPORT_EXTERNAL_ID_CONFLICT; chỉ dòng đó", async () => {
    const u1 = await newUnit();
    const u2 = await newUnit();
    await loadAll([line(u1.code, { external_id: "BK-X", advance_amount: 100000 })]);
    const { pv } = await preview([
      line(u1.code, { external_id: "BK-X", advance_amount: 200000 }),
      line(u2.code, { external_id: "BK-Y" }),
    ]);
    expect(pv.errors).toEqual([
      expect.objectContaining({ row: 2, column: "external_id", code: "IMPORT_EXTERNAL_ID_CONFLICT" }),
    ]);
    expect(pv.counts).toMatchObject({ create: 1, error: 1 });
  });

  it("hai dòng cùng phòng chồng ngày trong cùng file → dòng sau ROOM_UNAVAILABLE kèm external_id dòng bị chồng; nối ngày (đi = đến) hợp lệ", async () => {
    const u = await newUnit();
    const { batchId, pv } = await preview([
      line(u.code, { external_id: "BK-F1", arrival_on: "2026-11-10", departure_on: "2026-11-13" }),
      line(u.code, { external_id: "BK-F2", arrival_on: "2026-11-12", departure_on: "2026-11-14" }),
      line(u.code, { external_id: "BK-F3", arrival_on: "2026-11-13", departure_on: "2026-11-15" }),
    ]);
    expect(pv.errors).toEqual([expect.objectContaining({ row: 3, code: "ROOM_UNAVAILABLE", ref: "BK-F1" })]);
    expect(pv.rows.map((r) => r.action)).toEqual(["create", "error", "create"]);
    expect((await fails(confirm(O, batchId))).code).toBe("IMPORT_HAS_ERRORS");
    // Bỏ dòng chồng (file mới): hai dòng nối ngày cùng commit được, hai allocation liền nhau trên một phòng.
    const fixed = await loadAll([
      line(u.code, { external_id: "BK-G1", arrival_on: "2026-11-10", departure_on: "2026-11-13" }),
      line(u.code, { external_id: "BK-G3", arrival_on: "2026-11-13", departure_on: "2026-11-15" }),
    ]);
    expect(fixed.res.created).toBe(2);
    const al = await q(sql<{ n: number }>`
      select count(*)::int as n from allocations where unit_id = ${u.id} and active and kind = 'stay'`);
    expect(al[0]?.n).toBe(2);
  });

  it("S-004: phòng bị người khác lấy giữa kiểm và commit → rollback cả lô (kể cả dòng hợp lệ trước đó), lô về validated, CONFLICT_AT_COMMIT ở dòng bận", async () => {
    const u1 = await newUnit();
    const u2 = await newUnit();
    const { batchId, pv } = await preview([
      line(u1.code, { external_id: "BK-K1", advance_amount: 300000 }),
      line(u2.code, { external_id: "BK-K2" }),
    ]);
    expect(pv.counts).toMatchObject({ create: 2, error: 0 });
    await ok(confirm(O, batchId));
    // Người khác giữ phòng u2 ngay sau khi kiểm.
    await ok(
      run(O, async (ctx) => {
        const r = await createReservation(ctx, {
          booker: { fullName: "Khách đến trước", phone: "0922222222" },
          rooms: [{ unitId: u2.id, guests: 1 }],
          arrivalDate: "2026-11-11",
          departureDate: "2026-11-12",
          nightlyRates: nightlyAmountsOf("2026-11-11", "2026-11-12", 500000, null),
        });
        await holdReservation(ctx, { reservationId: r.id });
        await confirmReservation(ctx, { reservationId: r.id, imported: true });
        return { data: r.id };
      }),
    );
    const before = await countRes(A.propertyId);
    const p = await fails(commit(O, batchId));
    expect(p.code).toBe("IMPORT_HAS_ERRORS");
    expect(p.errors).toEqual([expect.objectContaining({ field: "*", code: "CONFLICT_AT_COMMIT" })]);
    expect(await countRes(A.propertyId)).toBe(before); // dòng K1 (hợp lệ) cũng không được ghi
    const jr = await q(
      sql<{ n: number }>`select count(*)::int as n from journal_entries where source_doc_id = ${batchId}`,
    );
    expect(jr[0]?.n).toBe(0);
    const b = await getBatch(t.runtime, M, { batchId });
    expect(b.status).toBe("validated");
    expect(b.errors).toEqual([expect.objectContaining({ row: 3, code: "CONFLICT_AT_COMMIT" })]);
    const refs = await q(
      sql<{ n: number }>`select count(*)::int as n from import_external_refs where batch_id = ${batchId}`,
    );
    expect(refs[0]?.n).toBe(0);
  });
});

describe("kiểm từng dòng (lỗi dòng, không đoán ý)", () => {
  it("bảng lỗi: ngày sai, ngày đi ≤ ngày đến, quá số đêm, trước ngày mốc, phòng không có, sức chứa, thiếu giá, giá lệch, ứng trước vượt, SĐT, số tiền sai mẫu", async () => {
    const u = await newUnit(); // sức chứa 2
    const u4 = await newUnit(A, 4);
    const cases: [string, Row, string, string][] = [
      ["ngày đến sai mẫu", line(u.code, { arrival_on: "10/11/2026" }), "arrival_on", "INVALID_FORMAT"],
      ["ngày không có thật", line(u.code, { arrival_on: "2026-02-30" }), "arrival_on", "INVALID_FORMAT"],
      [
        "ngày đi = ngày đến",
        line(u.code, { arrival_on: "2026-11-10", departure_on: "2026-11-10" }),
        "departure_on",
        "OUT_OF_RANGE",
      ],
      [
        "ngày đi trước ngày đến",
        line(u.code, { arrival_on: "2026-11-10", departure_on: "2026-11-09" }),
        "departure_on",
        "OUT_OF_RANGE",
      ],
      [
        "31 đêm",
        line(u.code, { arrival_on: "2026-11-10", departure_on: "2026-12-11" }),
        "departure_on",
        "OUT_OF_RANGE",
      ],
      [
        "đến trước ngày mốc",
        line(u.code, { arrival_on: "2026-10-31", departure_on: "2026-11-02" }),
        "arrival_on",
        "OUT_OF_RANGE",
      ],
      ["phòng không có", line("KHONG-CO"), "unit_code", "REFERENCE_NOT_FOUND"],
      ["vượt sức chứa", line(u.code, { guests: 3 }), "guests", "CAPACITY_EXCEEDED"],
      ["số khách 0", line(u.code, { guests: 0 }), "guests", "OUT_OF_RANGE"],
      ["thiếu cả hai giá", line(u.code, { nightly_price: "", total_amount: "" }), "total_amount", "REQUIRED"],
      [
        "giá lệch tổng",
        line(u.code, { nightly_price: 650000, total_amount: 1000000 }),
        "total_amount",
        "OUT_OF_RANGE",
      ],
      ["giá đêm 0", line(u.code, { nightly_price: 0 }), "nightly_price", "OUT_OF_RANGE"],
      ["giá thập phân", line(u.code, { nightly_price: "650000,5" }), "nightly_price", "NOT_INTEGER_VND"],
      ["giá sai nhóm nghìn", line(u.code, { nightly_price: "1.50" }), "nightly_price", "NOT_INTEGER_VND"],
      ["ứng trước vượt tổng", line(u.code, { advance_amount: 1300001 }), "advance_amount", "OUT_OF_RANGE"],
      ["ứng trước âm", line(u.code, { advance_amount: "-1" }), "advance_amount", "OUT_OF_RANGE"],
      ["SĐT sai", line(u.code, { guest_phone: "abc" }), "guest_phone", "INVALID_FORMAT"],
      ["thiếu tên", line(u.code, { guest_name: "" }), "guest_name", "REQUIRED"],
      ["thiếu external_id", line(u.code, { external_id: "" }), "external_id", "REQUIRED"],
    ];
    const { pv } = await preview(cases.map((c) => c[1]));
    for (const [i, [name, , column, code]] of cases.entries()) {
      const hit = pv.errors.filter((e) => e.row === i + 2);
      expect(
        hit.map((e) => [e.column, e.code]),
        name,
      ).toContainEqual([column, code]);
    }
    expect(pv.counts).toMatchObject({ create: 0, error: cases.length });
    // Biên hợp lệ cạnh các ca trên: đúng 30 đêm, đúng ngày mốc, sức chứa đủ, "650.000", ứng trước = tổng, SĐT quốc tế.
    const ok1 = await preview([
      line(u.code, { arrival_on: "2026-11-01", departure_on: "2026-12-01", nightly_price: "650.000" }),
      line(u4.code, { guests: 4, advance_amount: 1300000, guest_phone: "+84 90 000 0001" }),
    ]);
    expect(ok1.pv.errors).toEqual([]);
    expect(ok1.pv.counts).toMatchObject({ create: 2 });
  });

  it("Unicode và công thức trong file là dữ liệu: tên tiếng Việt lưu nguyên; ô `=...` không chạy, báo cáo lỗi thêm tiền tố '", async () => {
    const u = await newUnit();
    const { pv, batchId } = await preview([
      line(u.code, { external_id: "BK-U", guest_name: "Nguyễn Thị Ánh Tuyết 🌸" }),
      line(u.code, { external_id: "BK-V", guest_name: '=HYPERLINK("http://x","bấm")', arrival_on: "bad" }),
    ]);
    expect(pv.counts).toMatchObject({ create: 1, error: 1 });
    const rep = await downloadErrorReport(t.runtime, M, { batchId });
    expect(rep.csv).toContain("INVALID_FORMAT");
    expect(rep.csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it("cơ sở chưa cấu hình giờ nhận/trả phòng: mọi dòng lỗi CHECK_TIMES_MISSING (không đoán giờ)", async () => {
    const u = await newUnit();
    await sql`update properties set check_in_time = null, check_out_time = null where id = ${A.propertyId}`.execute(
      t.admin,
    );
    try {
      const { pv } = await preview([line(u.code)]);
      expect(pv.errors).toEqual([expect.objectContaining({ code: "CHECK_TIMES_MISSING" })]);
    } finally {
      await sql`update properties set check_in_time = '14:00', check_out_time = '12:00' where id = ${A.propertyId}`.execute(
        t.admin,
      );
    }
  });

  it("phòng ngừng khai thác hoặc đã lưu trữ: lỗi dòng, không nhận booking", async () => {
    const u = await newUnit();
    const v = await newUnit();
    await sql`update units set availability = 'out_of_service', availability_reason = 'sửa chữa' where id = ${u.id}`.execute(
      t.admin,
    );
    await sql`update units set archived_at = now() where id = ${v.id}`.execute(t.admin);
    const { pv } = await preview([line(u.code), line(v.code)]);
    expect(pv.counts.error).toBe(2);
    expect(pv.errors.map((e) => e.code).sort()).toEqual(["REFERENCE_NOT_FOUND", "UNIT_OUT_OF_SERVICE"]);
  });

  it("upload: thiếu ngày mốc → 422 REQUIRED; thiếu cột bắt buộc → 422; người không có quyền → 403", async () => {
    const u = await newUnit();
    const p = await fails(upload(M, [line(u.code)], A.propertyId, null));
    expect(p).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    expect(p.errors).toEqual([expect.objectContaining({ field: "cutoff_on", code: "REQUIRED" })]);
    const missing = await fails(
      run(M, async (ctx) => ({
        data: await uploadBatch(ctx, deps(), {
          propertyId: A.propertyId,
          kind: "reservations",
          cutoffOn: CUTOFF,
          bytes: csv([
            ["external_id", "unit_code"],
            ["x", "1"],
          ]),
        }),
      })),
    );
    expect(missing.code).toBe("VALIDATION_FAILED");
    const fd = await member("front_desk");
    expect((await fails(upload(fd, [line(u.code)]))).status).toBe(403);
  });
});

describe("chéo tenant (INV-G1)", () => {
  it("mã phòng của tổ chức khác không phân giải được; cùng external_id ở tổ chức khác độc lập; không đọc/commit lô của nhau", async () => {
    const ua = await newUnit(A);
    const ub = await newUnit(B);
    // Tổ chức A dùng mã phòng của B → REFERENCE_NOT_FOUND.
    const { pv } = await preview([line(ub.code, { external_id: "BK-T" })]);
    expect(pv.errors).toEqual([
      expect.objectContaining({ column: "unit_code", code: "REFERENCE_NOT_FOUND" }),
    ]);

    // Cùng external_id "BK-SHARED" ở A và B: hai nhập độc lập, đều tạo.
    const a = await loadAll([line(ua.code, { external_id: "BK-SHARED" })]);
    const bUp = await ok(
      run(OB, async (ctx) => ({
        data: await uploadBatch(ctx, deps(), {
          propertyId: B.propertyId,
          kind: "reservations",
          cutoffOn: CUTOFF,
          bytes: csv([HEADER, line(ub.code, { external_id: "BK-SHARED" })]),
        }),
      })),
    );
    const bPv = await ok(validate(OB, bUp.batchId));
    expect(bPv.counts).toMatchObject({ create: 1, skip_unchanged: 0, error: 0 });
    await ok(confirm(OB, bUp.batchId));
    expect(await ok(commit(OB, bUp.batchId))).toMatchObject({ created: 1 });
    expect(await countRes(B.propertyId)).toBe(1);

    // B không thấy/không commit lô của A (404), A không thấy lô của B.
    expect((await fails(validate(OB, a.batchId))).status).toBe(404);
    expect((await fails(commit(OB, a.batchId))).status).toBe(404);
    expect((await fails(validate(O, bUp.batchId))).status).toBe(404);
    // Booking của lô A thuộc đúng tổ chức A.
    const owner = await q(sql<{ organization_id: string }>`
      select r.organization_id from import_external_refs x join reservations r on r.id = x.target_id where x.batch_id = ${a.batchId}`);
    expect(owner.map((o) => o.organization_id)).toEqual([A.orgId]);
  });
});
