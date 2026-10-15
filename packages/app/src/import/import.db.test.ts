// PLAN đợt 2 T-115 — import dữ liệu chuyển đổi trên Postgres thật + object storage (SPEC-import S-001…S-020 trừ S-009;
// SPEC-lease S-026). Fixture `import-basic`: chủ O, quản lý M (`import.prepare`), lễ tân F; ngày mốc 2026-11-01.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { eicarOnlyScanner } from "../files/inspect.ts";
import { ObjectStorage } from "../files/storage.ts";
import { financialSummary } from "../ledger/period-close.ts";
import { recordReading } from "../metering/meters.ts";
import { executeCommand } from "../pipeline/command.ts";
import {
  cancelBatch,
  commitBatch,
  confirmBatch,
  downloadErrorReport,
  getBatch,
  getTemplate,
  type ImportPreview,
  setExpectedTotals,
  uploadBatch,
  validateBatch,
} from "./import.ts";
import { readXlsx, writeXlsx } from "./xlsx.ts";

let t: TestDb;
let A: SeededOrg;
let O: Actor;
let M: Actor;
let F: Actor;
let storage: ObjectStorage;
const deps = () => ({ storage, scanner: eicarOnlyScanner });
const CUTOFF = "2026-11-01";

async function member(role: string): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${A.orgId}, ${user}, ${person}, ${role})`.execute(t.admin);
  return resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
}

const reresolve = (a: Actor) =>
  resolveActor(t.runtime, { authUserId: a.authUserId, orgId: A.orgId, twoFactorEnabled: true });

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3], key: string = randomUUID()) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "import.test", idempotencyKey: key, payload: { key }, correlationId: "c-import" },
    fn,
  );
}

async function ok<T>(p: Promise<Awaited<ReturnType<typeof run<T>>>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

async function fails(p: Promise<{ status: string; problem?: unknown }>) {
  const r = await p;
  if (r.status !== "failed") throw new Error("lẽ ra thất bại");
  return r.problem as {
    code: string;
    status: number;
    errors?: { field: string; code: string }[];
    totals?: Record<string, unknown>;
  };
}

/** CSV đầu vào (không chống injection — đây là file người dùng). */
function csv(rows: (string | number)[][]): Uint8Array {
  const q = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return new TextEncoder().encode(rows.map((r) => r.map(q).join(",")).join("\r\n"));
}

/** Cơ sở riêng cho mỗi test; M, F trong phạm vi; dịch vụ DIEN/NUOC. */
async function property() {
  const propertyId = randomUUID();
  await sql`insert into properties (id, organization_id, name, template)
            values (${propertyId}, ${A.orgId}, ${`P1 ${propertyId.slice(0, 4)}`}, 'rental')`.execute(t.admin);
  for (const a of [M, F]) {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${A.orgId}, ${a.membershipId}, ${propertyId})`.execute(t.admin);
  }
  [M, F] = await Promise.all([reresolve(M), reresolve(F)]);
  for (const [code, name, kind] of [
    ["DIEN", "Điện", "electric"],
    ["NUOC", "Nước", "water"],
  ] as const) {
    await sql`insert into services (id, organization_id, property_id, code, name, kind, revenue_account, meter_kind)
              values (${randomUUID()}, ${A.orgId}, ${propertyId}, ${code}, ${name}, 'metered', 'REV_UTIL', ${kind})`.execute(
      t.admin,
    );
  }
  const upload = (a: Actor, kind: string, bytes: Uint8Array, cutoffOn: string | undefined = CUTOFF) =>
    run<{ batchId: string; rows: number }>(a, async (ctx) => ({
      data: await uploadBatch(ctx, deps(), {
        propertyId,
        kind,
        bytes,
        ...(cutoffOn === undefined ? {} : { cutoffOn }),
      }),
    }));
  const validate = (a: Actor, batchId: string) =>
    run<ImportPreview>(a, async (ctx) => ({ data: await validateBatch(ctx, { batchId }) }));
  const confirm = (a: Actor, batchId: string) =>
    run(a, async (ctx) => ({ data: await confirmBatch(ctx, { batchId }) }));
  const commit = (a: Actor, batchId: string, key?: string) =>
    run(a, async (ctx) => ({ data: await commitBatch(ctx, { batchId }) }), key);
  /** Tải lên + kiểm + xác nhận + commit (đường vui). */
  const load = async (
    kind: string,
    rows: (string | number)[][],
    totals?: { debt: number; deposit: number },
  ) => {
    const { batchId } = await ok(upload(M, kind, csv(rows)));
    const pv = await ok(validate(M, batchId));
    if (pv.counts.error > 0) throw new Error(JSON.stringify(pv.errors));
    if (totals)
      await ok(run(M, async (ctx) => ({ data: await setExpectedTotals(ctx, { batchId, ...totals }) })));
    await ok(confirm(O, batchId));
    await ok(commit(O, batchId));
    return { batchId, preview: pv };
  };
  const count = async (table: "units" | "leases") =>
    (
      await sql<{
        n: number;
      }>`select count(*)::int as n from ${sql.table(table)} where property_id = ${propertyId}`.execute(
        t.admin,
      )
    ).rows[0]?.n;
  return { propertyId, upload, validate, confirm, commit, load, count };
}

const UNIT_HEADER = ["external_id", "unit_code", "floor", "capacity"];
const units30 = (prefix = "U") =>
  Array.from({ length: 30 }, (_, i) => [
    `${prefix}-${String(i + 1).padStart(3, "0")}`,
    String(101 + i),
    `Tầng ${1 + Math.floor(i / 10)}`,
    2,
  ]);
const LEASE_HEADER = [
  "external_id",
  "unit_code",
  "tenant_name",
  "tenant_phone",
  "rent_amount",
  "deposit_amount",
  "billing_start_on",
  "end_on",
  "services",
  "occupants",
];

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "Trọ chuyển đổi", "rental");
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  M = await member("manager");
  F = await member("front_desk");
});

afterAll(async () => {
  await t.drop();
});

describe("S-001 mẫu, S-015 quyền, S-019 XLSX", () => {
  it("S-001: XLSX có tiêu đề + dòng ví dụ; CSV UTF-8 có BOM", () => {
    const tpl = getTemplate("leases");
    const rows = readXlsx(new Uint8Array(Buffer.from(tpl.xlsx_base64, "base64")));
    expect(rows[0]?.cells.map((c) => c.v)).toEqual(
      LEASE_HEADER.slice(0, 7).concat(["end_on", "signed_on", "services", "occupants"]),
    );
    expect(rows).toHaveLength(2);
    expect(tpl.csv.startsWith("﻿external_id,unit_code,tenant_name")).toBe(true);
    expect(() => getTemplate("x")).toThrow();
  });

  it("S-015: lễ tân tải lên → 403; loại đặt phòng chưa mở; file rỗng/chỉ tiêu đề → 422; file lạ → 415", async () => {
    const P = await property();
    expect(await fails(P.upload(F, "units", csv([UNIT_HEADER, ["U-1", "101", "T1", 2]])))).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect(await fails(P.upload(M, "reservations", csv([UNIT_HEADER])))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(await fails(P.upload(M, "units", csv([UNIT_HEADER])))).toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
    expect(await fails(P.upload(M, "units", new Uint8Array([0xff, 0xfe, 0x00, 0x41])))).toMatchObject({
      code: "FILE_TYPE_NOT_ALLOWED",
      status: 415,
    });
    expect(
      await fails(
        P.upload(
          M,
          "units",
          csv([
            ["external_id", "unit_code"],
            ["U-1", "101"],
          ]),
        ),
      ),
    ).toMatchObject({
      code: "VALIDATION_FAILED",
      errors: [
        { field: "floor", code: "REQUIRED" },
        { field: "capacity", code: "REQUIRED" },
      ],
    });
  });

  it("S-019: XLSX — ô số giữ kiểu số, ngày seri Excel chuyển đúng sang date", async () => {
    const P = await property();
    await P.load("units", [UNIT_HEADER, ["U-1", "101", "Tầng 1", 2]]);
    const xlsx = writeXlsx([
      {
        name: "leases",
        rows: [LEASE_HEADER, ["HD-X", 101, "Lê Văn C", "0900000003", 3_000_000, 0, 46082, "", "DIEN", ""]],
      },
    ]);
    const { batchId } = await ok(P.upload(M, "leases", xlsx));
    const pv = await ok(P.validate(M, batchId));
    expect(pv.counts).toMatchObject({ create: 1, error: 0 });
    const d = await sql<{ data: { billing_start_on: string; rent_amount: number } }>`
      select data from import_rows where batch_id = ${batchId}`.execute(t.admin);
    expect(d.rows[0]?.data).toMatchObject({ billing_start_on: "2026-03-01", rent_amount: 3_000_000 });
  });
});

describe("S-002…S-006 phòng: xem trước, lỗi từng dòng, nguyên khối, không nhân đôi", () => {
  it("S-002: 30 dòng hợp lệ → validated, 30 sẽ tạo, 0 lỗi, chưa ghi phòng nào", async () => {
    const P = await property();
    const { batchId } = await ok(P.upload(M, "units", csv([UNIT_HEADER, ...units30()])));
    const pv = await ok(P.validate(M, batchId));
    expect(pv).toMatchObject({ status: "validated", counts: { create: 30, error: 0 } });
    expect(await P.count("units")).toBe(0);
  });

  it("S-003: dòng 7 trùng mã với dòng 3, dòng 12 sức chứa −1 → lỗi theo cột; commit 409 IMPORT_HAS_ERRORS, không ghi", async () => {
    const P = await property();
    const rows = units30();
    (rows[5] as (string | number)[])[1] = (rows[1] as (string | number)[])[1] as string; // file dòng 7 = dữ liệu thứ 6
    (rows[10] as (string | number)[])[3] = -1; // file dòng 12
    const { batchId } = await ok(P.upload(M, "units", csv([UNIT_HEADER, ...rows])));
    const pv = await ok(P.validate(M, batchId));
    expect(pv.errors.map((e) => [e.row, e.column, e.code])).toEqual([
      [7, "unit_code", "DUPLICATE_IN_FILE"],
      [12, "capacity", "OUT_OF_RANGE"],
    ]);
    expect(await fails(P.commit(O, batchId))).toMatchObject({ code: "IMPORT_HAS_ERRORS", status: 409 });
    expect(await fails(P.confirm(O, batchId))).toMatchObject({ code: "IMPORT_HAS_ERRORS" });
    expect(await P.count("units")).toBe(0);
  });

  it("S-004: dòng 26 trùng mã với phòng vừa tạo ngoài lô → rollback cả lô, lô về validated kèm CONFLICT_AT_COMMIT", async () => {
    const P = await property();
    const { batchId } = await ok(P.upload(M, "units", csv([UNIT_HEADER, ...units30()])));
    await ok(P.validate(M, batchId));
    await ok(P.confirm(O, batchId));
    const floor = randomUUID();
    await sql`insert into floors (id, organization_id, property_id, name) values (${floor}, ${A.orgId}, ${P.propertyId}, 'Khác')`.execute(
      t.admin,
    );
    await sql`insert into units (id, organization_id, property_id, floor_id, code)
              values (${randomUUID()}, ${A.orgId}, ${P.propertyId}, ${floor}, '125')`.execute(t.admin);
    const r = await fails(P.commit(O, batchId));
    expect(r).toMatchObject({
      code: "IMPORT_HAS_ERRORS",
      status: 409,
      errors: [{ field: "*", code: "CONFLICT_AT_COMMIT" }],
    });
    expect(await P.count("units")).toBe(1);
    const b = await getBatch(t.runtime, M, { batchId });
    expect(b).toMatchObject({ status: "validated", confirmed_by: null });
    expect(b.errors).toMatchObject([{ row: 26, code: "CONFLICT_AT_COMMIT" }]);
  });

  it("S-005/S-006: nhập lại cùng file → 30 bỏ qua, tạo 0; U-005 khác sức chứa → IMPORT_EXTERNAL_ID_CONFLICT", async () => {
    const P = await property();
    await P.load("units", [UNIT_HEADER, ...units30()]);
    expect(await P.count("units")).toBe(30);
    const again = await P.load("units", [UNIT_HEADER, ...units30()]);
    expect(again.preview.counts).toMatchObject({ create: 0, skip_unchanged: 30 });
    expect(await P.count("units")).toBe(30);
    const changed = units30();
    (changed[4] as (string | number)[])[3] = 3;
    const { batchId } = await ok(P.upload(M, "units", csv([UNIT_HEADER, ...changed])));
    const pv = await ok(P.validate(M, batchId));
    expect(pv.errors).toMatchObject([{ row: 6, column: "external_id", code: "IMPORT_EXTERNAL_ID_CONFLICT" }]);
  });
});

describe("S-007, S-008 hợp đồng; S-010 chỉ số đầu", () => {
  it("S-007 + S-010: hợp đồng active + người ở + allocation + bàn giao import chờ chỉ số; đủ chỉ số thì bỏ cờ, kỳ 11 dùng 1.250", async () => {
    const P = await property();
    await P.load("units", [UNIT_HEADER, ["U-1", "U101", "Tầng 1", 2]]);
    const { batchId } = await P.load("leases", [
      LEASE_HEADER,
      [
        "HD-01",
        "U101",
        "Nguyễn Văn A",
        "0900000001",
        "3.000.000",
        3_000_000,
        "2026-03-01",
        "2027-02-28",
        "DIEN;NUOC",
        "Trần Thị B",
      ],
    ]);
    const ref = await sql<{
      target_id: string;
    }>`select target_id from import_external_refs where batch_id = ${batchId}`.execute(t.admin);
    const leaseId = ref.rows[0]?.target_id as string;
    const l = await sql<{
      status: string;
      source: string;
      occupants: number;
      alloc: number;
      pending: boolean;
      method: string;
    }>`
      select l.status, v.source,
             (select count(*)::int from lease_occupants o where o.lease_id = l.id) as occupants,
             (select count(*)::int from allocations a where a.source_id = l.id and a.kind = 'lease' and a.active) as alloc,
             h.readings_pending as pending, h.confirmation_method as method
      from leases l join lease_versions v on v.lease_id = l.id join handovers h on h.lease_id = l.id and h.kind = 'move_in'
      where l.id = ${leaseId}`.execute(t.admin);
    expect(l.rows[0]).toEqual({
      status: "active",
      source: "import",
      occupants: 2,
      alloc: 1,
      pending: true,
      method: "import",
    });

    // S-010: chỉ số âm → OUT_OF_RANGE; điện 1.250 (lắp công tơ mới) + nước 340 → bỏ cờ chờ chỉ số.
    const RH = ["external_id", "unit_code", "meter_kind", "value", "read_on"];
    const bad = await ok(P.upload(M, "meter_readings", csv([RH, ["X", "U101", "electric", -5, ""]])));
    expect((await ok(P.validate(M, bad.batchId))).errors).toMatchObject([
      { column: "value", code: "OUT_OF_RANGE" },
    ]);
    await P.load("meter_readings", [
      RH,
      ["CS-1", "U101", "electric", 1250, ""],
      ["CS-2", "U101", "water", 340, ""],
    ]);
    const h = await sql<{ pending: boolean }>`
      select readings_pending as pending from handovers where lease_id = ${leaseId}`.execute(t.admin);
    expect(h.rows[0]?.pending).toBe(false);
    const rd = await sql<{ source: string; status: string; read_on: string }>`
      select distinct r.source, r.status, r.read_on::text from meter_readings r join meters m on m.id = r.meter_id
      join units u on u.id = m.unit_id where u.property_id = ${P.propertyId}`.execute(t.admin);
    expect(rd.rows).toEqual([{ source: "import", status: "approved", read_on: CUTOFF }]);
    const meter = await sql<{ id: string }>`
      select m.id from meters m join units u on u.id = m.unit_id where u.property_id = ${P.propertyId} and m.kind = 'electric'`.execute(
      t.admin,
    );
    const period = randomUUID();
    await sql`insert into billing_periods (id, organization_id, property_id, period_start, period_end)
              values (${period}, ${A.orgId}, ${P.propertyId}, '2026-11-01', '2026-11-30')`.execute(t.admin);
    const r = await ok(
      run(F, async (ctx) => ({
        data: await recordReading(ctx, {
          meterId: meter.rows[0]?.id as string,
          billingPeriodId: period,
          value: 1350,
        }),
      })),
    );
    expect(r.consumption).toBe(100);
  });

  it("S-008: hai hợp đồng chồng nhau cùng phòng → dòng sau ROOM_UNAVAILABLE kèm external_id dòng bị chồng", async () => {
    const P = await property();
    await P.load("units", [UNIT_HEADER, ["U-1", "U101", "Tầng 1", 2]]);
    const { batchId } = await ok(
      P.upload(
        M,
        "leases",
        csv([
          LEASE_HEADER,
          ["HD-A", "U101", "A", "0900000001", 3_000_000, 0, "2026-03-01", "2027-02-28", "", ""],
          ["HD-B", "U101", "B", "0900000002", 3_000_000, 0, "2026-10-01", "2027-11-30", "", ""],
          ["HD-C", "U999", "C", "0900000003", 3_000_000, 0, "2026-10-01", "", "GAS", ""],
        ]),
      ),
    );
    const pv = await ok(P.validate(M, batchId));
    expect(pv.errors.map((e) => [e.row, e.column, e.code, e.ref ?? null])).toEqual([
      [3, "unit_code", "ROOM_UNAVAILABLE", "HD-A"],
      [4, "unit_code", "REFERENCE_NOT_FOUND", null],
      [4, "services", "REFERENCE_NOT_FOUND", null],
    ]);
    expect(await fails(P.confirm(O, batchId))).toMatchObject({ code: "IMPORT_HAS_ERRORS" });
  });
});

describe("S-011…S-014, S-020 số dư đầu kỳ", () => {
  const BH = ["external_id", "lease_external_id", "type", "amount", "note"];
  async function withLeases(n: number) {
    const P = await property();
    await P.load("units", [
      UNIT_HEADER,
      ...Array.from({ length: n }, (_, i) => [`U-${i}`, `P${i}`, "Tầng 1", 2]),
    ]);
    await P.load("leases", [
      LEASE_HEADER,
      ...Array.from({ length: n }, (_, i) => [
        `HD-${i}`,
        `P${i}`,
        `Người ${i}`,
        `090000000${i}`,
        3_000_000,
        3_000_000,
        "2026-03-01",
        "",
        "",
        "",
      ]),
    ]);
    return P;
  }

  it("S-011/S-012: nợ 1.580.000 → phiếu số dư + Nợ AR/Có OPENING_BALANCE, không REV; cọc 3.000.000 → Nợ OPENING_BALANCE/Có DEPOSIT_LIAB", async () => {
    const P = await withLeases(1);
    await P.load(
      "opening_balances",
      [BH, ["SD-1", "HD-0", "debt", 1_580_000, "Điện tháng 10"], ["SD-2", "HD-0", "cọc", "3.000.000", ""]],
      { debt: 1_580_000, deposit: 3_000_000 },
    );
    const inv = await sql<{ kind: string; total: string; business_date: string }>`
      select kind, total::text, business_date::text from invoices where property_id = ${P.propertyId}`.execute(
      t.admin,
    );
    expect(inv.rows).toEqual([{ kind: "opening_balance", total: "1580000", business_date: CUTOFF }]);
    const jl = await sql<{ account: string; debit: string; credit: string }>`
      select l.account, sum(l.debit)::text as debit, sum(l.credit)::text as credit from journal_lines l
      join journal_entries e on e.id = l.entry_id where e.property_id = ${P.propertyId} and e.entry_type = 'opening_balance'
      group by l.account order by l.account`.execute(t.admin);
    expect(jl.rows.map((r) => [r.account, Number(r.debit), Number(r.credit)])).toEqual([
      ["AR", 1_580_000, 0],
      ["DEPOSIT_LIAB", 0, 3_000_000],
      ["OPENING_BALANCE", 3_000_000, 1_580_000],
    ]);
    const dep = await sql<{
      balance: string;
    }>`select balance::text from deposits where property_id = ${P.propertyId}`.execute(t.admin);
    expect(dep.rows).toEqual([{ balance: "3000000" }]);
    const fs = await financialSummary(t.runtime, O, {
      propertyId: P.propertyId,
      from: "2026-01-01",
      to: CUTOFF,
    });
    expect(fs.revenue.net).toBe(0);
    expect(fs.balances).toMatchObject({ receivables: 1_580_000, deposits_held: 3_000_000 });
    expect(fs.cash_flow).toMatchObject({ payments_received: 0, deposits_received: 0 });
  });

  it("S-013/S-014: tổng lệch → 409 IMPORT_TOTALS_MISMATCH kèm chênh; chưa xác nhận → IMPORT_CONFIRMATION_REQUIRED; quản lý không xác nhận được", async () => {
    const P = await withLeases(2);
    const rows = [BH, ["D1", "HD-0", "debt", 12_450_000, ""], ["C1", "HD-0", "deposit", 42_000_000, ""]];
    const { batchId } = await ok(P.upload(M, "opening_balances", csv(rows)));
    await ok(P.validate(M, batchId));
    expect(await fails(P.confirm(O, batchId))).toMatchObject({ code: "VALIDATION_FAILED" });
    const diff = await ok(
      run(M, async (ctx) => ({
        data: await setExpectedTotals(ctx, { batchId, debt: 12_450_000, deposit: 45_000_000 }),
      })),
    );
    expect(diff.diff).toEqual({ debt: 0, deposit: -3_000_000 });
    expect(await fails(P.commit(O, batchId))).toMatchObject({
      code: "IMPORT_TOTALS_MISMATCH",
      status: 409,
      totals: { deposit: { expected: 45_000_000, actual: 42_000_000, diff: -3_000_000 } },
    });
    // Sửa file cho khớp (thêm cọc 3.000.000 của HD-1) thì nhập được — S-014: phải xác nhận trước.
    const fixed = await ok(
      P.upload(M, "opening_balances", csv([...rows, ["C2", "HD-1", "deposit", 3_000_000, ""]])),
    );
    await ok(P.validate(M, fixed.batchId));
    await ok(
      run(M, async (ctx) => ({
        data: await setExpectedTotals(ctx, { batchId: fixed.batchId, debt: 12_450_000, deposit: 45_000_000 }),
      })),
    );
    expect(await fails(P.commit(O, fixed.batchId))).toMatchObject({
      code: "IMPORT_CONFIRMATION_REQUIRED",
      status: 409,
    });
    expect(await fails(P.confirm(M, fixed.batchId))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    await ok(P.confirm(O, fixed.batchId));
    const b = await getBatch(t.runtime, M, { batchId: fixed.batchId });
    expect(b).toMatchObject({ status: "confirmed", confirmed_by: O.membershipId });
    expect(await ok(P.commit(O, fixed.batchId))).toMatchObject({ status: "committed", created: 3 });
  });

  it("S-020: quy tắc đọc số tiền từng dòng", async () => {
    const P = await withLeases(2);
    const cases: [string, string, string | number, string][] = [
      ["a", "debt", "1580000", "create"],
      ["b", "debt", "0", "skip_empty"],
      ["c", "debt", "1", "create"],
      ["d", "deposit", "3.000.000", "create"],
      ["e", "debt", "1.500", "create"],
      ["f", "debt", "1.50", "NOT_INTEGER_VND"],
      ["g", "debt", "1.5000", "NOT_INTEGER_VND"],
      ["h", "debt", "12.34.567", "NOT_INTEGER_VND"],
      ["i", "debt", "1.580.000,5", "NOT_INTEGER_VND"],
      ["j", "debt", "1,500", "NOT_INTEGER_VND"],
      ["k", "debt", "1580000,5", "NOT_INTEGER_VND"],
      ["l", "debt", "-500000", "OUT_OF_RANGE"],
    ];
    const rows = [
      BH,
      ...cases.map(([id, type, amount]) => [id, "HD-0", type, amount, ""]),
      ["m", "HD-1", "deposit", "", ""],
    ];
    const { batchId } = await ok(P.upload(M, "opening_balances", csv(rows)));
    const pv = await ok(P.validate(M, batchId));
    const got = pv.rows.map((r) => {
      const e = pv.errors.find((x) => x.row === r.row);
      return [r.external_id, e ? e.code : r.action];
    });
    expect(got).toEqual([...cases.map(([id, , , kq]) => [id, kq]), ["m", "REQUIRED"]]);
    expect(pv.rows.find((r) => r.external_id === "b")?.note).toBe("Không có số dư");
    expect(pv.totals).toEqual({ debt: 1_580_000 + 1 + 1_500, deposit: 3_000_000 });
  });
});

describe("S-016 huỷ, S-017 commit lặp/song song, S-018 báo cáo lỗi", () => {
  it("S-016: huỷ lô validated → cancelled, không dữ liệu; huỷ lô committed → INVALID_TRANSITION", async () => {
    const P = await property();
    const { batchId } = await ok(P.upload(M, "units", csv([UNIT_HEADER, ["U-1", "101", "T1", 2]])));
    await ok(P.validate(M, batchId));
    await ok(run(M, async (ctx) => ({ data: await cancelBatch(ctx, { batchId, reason: "Sai file" }) })));
    expect((await getBatch(t.runtime, M, { batchId })).status).toBe("cancelled");
    expect(await P.count("units")).toBe(0);
    const done = await P.load("units", [UNIT_HEADER, ["U-1", "101", "T1", 2]]);
    expect(
      await fails(
        run(M, async (ctx) => ({ data: await cancelBatch(ctx, { batchId: done.batchId, reason: "x" }) })),
      ),
    ).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
    const del = await sql`delete from import_batches where id = ${batchId}`
      .execute(t.admin)
      .catch((e: unknown) => e);
    expect(del).toBeInstanceOf(Error);
  });

  it("S-017: gửi lại cùng key → kết quả cũ; hai lệnh khác key song song → 1 thành công, 1 INVALID_TRANSITION", async () => {
    const P = await property();
    const { batchId } = await ok(P.upload(M, "units", csv([UNIT_HEADER, ...units30()])));
    await ok(P.validate(M, batchId));
    await ok(P.confirm(O, batchId));
    const [a, b] = await Promise.all([P.commit(O, batchId), P.commit(O, batchId)]);
    expect([a.status, b.status].sort()).toEqual(["committed", "failed"]);
    const failed = a.status === "failed" ? a : b;
    expect(failed).toMatchObject({ problem: { code: "INVALID_TRANSITION", status: 409 } });
    expect(await P.count("units")).toBe(30);
    const key = randomUUID();
    const P2 = await property();
    const x = await ok(P2.upload(M, "units", csv([UNIT_HEADER, ["U-9", "901", "T9", 1]])));
    await ok(P2.validate(M, x.batchId));
    await ok(P2.confirm(O, x.batchId));
    const first = await P2.commit(O, x.batchId, key);
    const again = await P2.commit(O, x.batchId, key);
    expect(again).toMatchObject({ status: "committed", replayed: true });
    expect(again.status === "committed" && again.data).toEqual(first.status === "committed" && first.data);
  });

  it("S-018: CSV lỗi chống formula injection; cột số giữ kiểu số", async () => {
    const P = await property();
    const { batchId } = await ok(
      P.upload(
        M,
        "units",
        csv([
          UNIT_HEADER,
          ["U-1", '=HYPERLINK("http://x","bấm")', "@SUM(A1)", "-1+2"],
          ["U-2", "+84 912", "T1", 2],
        ]),
      ),
    );
    await ok(P.validate(M, batchId));
    const r = await downloadErrorReport(t.runtime, M, { batchId });
    const lines = r.csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("row,external_id,column,code,message,value");
    expect(lines.slice(1)).toEqual([
      `2,U-1,unit_code,TOO_LONG,Quá 20 ký tự,"'=HYPERLINK(""http://x"",""bấm"")"`,
      "2,U-1,capacity,INVALID_FORMAT,Sai định dạng,'-1+2",
    ]);
  });
});
