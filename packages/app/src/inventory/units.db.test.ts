// Tạo phòng, mã phòng duy nhất theo cơ sở, chỉ bán nguyên phòng, lưu trữ phòng (SPEC-access S-004, S-005, S-006, T017; ERD `units`).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedLease, seedOrg, seedReservation, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { ownerOf, runAs, seedMember } from "../testing/helpers.ts";
import { listRooms } from "./rooms.ts";
import { archiveUnit, createUnit } from "./units.ts";

let t: TestDb;
let A: SeededOrg;
let owner: Actor;
let frontDesk: Actor;
let property2: string;

const create = (actor: Actor, propertyId: string, code: string) =>
  runAs(t, actor, (ctx) => createUnit(ctx, { propertyId, floorName: "Tầng 1", code, capacity: 2 }));

const unitCount = async (propertyId: string) =>
  (
    await sql<{ n: number }>`select count(*)::int as n from units where property_id = ${propertyId}`.execute(
      t.admin,
    )
  ).rows[0]?.n ?? -1;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ mã phòng");
  owner = await ownerOf(t, A);
  frontDesk = await seedMember(t, A, "front_desk");
  property2 = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${property2}, ${A.orgId}, 'Trọ mã phòng — CS2', 'rental')`.execute(
    t.admin,
  );
});

afterAll(async () => {
  await t.drop();
});

describe("SPEC-access S-004: mã phòng duy nhất theo cơ sở", () => {
  it("trùng mã ở cùng cơ sở → 409 UNIT_CODE_TAKEN (không phân biệt hoa thường, bỏ khoảng trắng); cơ sở khác cùng mã → tạo được", async () => {
    expect(await create(owner, A.propertyId, "301A")).toMatchObject({ status: "committed" });
    const before = await unitCount(A.propertyId);
    for (const dup of ["301A", "301a", "  301A  "]) {
      expect(await create(owner, A.propertyId, dup)).toMatchObject({
        status: "failed",
        httpStatus: 409,
        problem: { code: "UNIT_CODE_TAKEN" },
      });
    }
    expect(await unitCount(A.propertyId)).toBe(before);
    expect(await create(owner, property2, "301A")).toMatchObject({ status: "committed" });
  });

  it("ca biên: mã rỗng/chỉ khoảng trắng và quá 20 ký tự → 422, không tạo; lễ tân không có quyền → 403", async () => {
    const before = await unitCount(A.propertyId);
    for (const bad of ["", "   ", "x".repeat(21)]) {
      expect(await create(owner, A.propertyId, bad)).toMatchObject({
        status: "failed",
        httpStatus: 422,
        problem: { code: "VALIDATION_FAILED" },
      });
    }
    expect(await create(frontDesk, A.propertyId, "999")).toMatchObject({ status: "failed", httpStatus: 403 });
    expect(await unitCount(A.propertyId)).toBe(before);
  });

  it("mã đúng 20 ký tự và Unicode có dấu hợp lệ", async () => {
    expect(await create(owner, A.propertyId, "P".repeat(20))).toMatchObject({ status: "committed" });
    expect(await create(owner, A.propertyId, "Phòng Đặc Biệt")).toMatchObject({ status: "committed" });
    expect(await create(owner, A.propertyId, "PHÒNG ĐẶC BIỆT")).toMatchObject({
      status: "failed",
      problem: { code: "UNIT_CODE_TAKEN" },
    });
  });
});

describe("SPEC-access S-005: không bán theo giường ở V1", () => {
  const withKind = (extra: { kind?: string; parentUnitId?: string | null }, code: string) =>
    runAs(t, owner, (ctx) =>
      createUnit(ctx, { propertyId: A.propertyId, floorName: "Tầng 1", code, capacity: 2, ...extra }),
    );

  it("kind='bed' hoặc parent_unit_id khác null → 422 VALIDATION_FAILED chỉ đúng trường sai; không tạo phòng", async () => {
    const before = await unitCount(A.propertyId);
    expect(await withKind({ kind: "bed" }, "BED1")).toMatchObject({
      status: "failed",
      httpStatus: 422,
      problem: { code: "VALIDATION_FAILED", errors: [{ field: "kind" }] },
    });
    expect(await withKind({ parentUnitId: randomUUID() }, "BED2")).toMatchObject({
      status: "failed",
      httpStatus: 422,
      problem: { code: "VALIDATION_FAILED", errors: [{ field: "parent_unit_id" }] },
    });
    expect(await withKind({ kind: "" }, "BED3")).toMatchObject({ status: "failed", httpStatus: 422 });
    expect(await unitCount(A.propertyId)).toBe(before);
  });

  it("kind='whole', không gửi kind, parent_unit_id null → tạo được; schema vẫn giữ cột và chặn ghi trực tiếp kind khác", async () => {
    expect(await withKind({ kind: "whole" }, "W1")).toMatchObject({ status: "committed" });
    expect(await withKind({}, "W2")).toMatchObject({ status: "committed" });
    expect(await withKind({ kind: "whole", parentUnitId: null }, "W3")).toMatchObject({
      status: "committed",
    });
    const cols = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_name = 'units' and column_name in ('kind', 'parent_unit_id') order by 1`.execute(t.admin);
    expect(cols.rows.map((c) => c.column_name)).toEqual(["kind", "parent_unit_id"]);
    await expect(
      sql`insert into units (id, organization_id, property_id, floor_id, code, kind)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, 'DBBED', 'bed')`.execute(
        t.admin,
      ),
    ).rejects.toThrow(/units_kind_check|check constraint/);
  });
});

describe("SPEC-access S-006: lưu trữ phòng (soft delete — INV-G7)", () => {
  const NOW = new Date("2026-10-20T03:00:00Z");
  const archive = (actor: Actor, unitId: string) =>
    runAs(t, actor, (ctx) => archiveUnit(ctx, { unitId, now: NOW }));
  const room = async (code: string) => {
    const r = await runAs(t, owner, (ctx) =>
      createUnit(ctx, { propertyId: A.propertyId, floorName: "Tầng 6", code, capacity: 2 }),
    );
    if (r.status !== "committed") throw new Error(r.problem.code);
    return r.data.unitId;
  };
  const alloc = (unit: string, kind: string, lo: string, hi: string | null, expires: string | null = null) =>
    sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during, expires_at)
        values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${unit}, ${kind},
                tstzrange(${lo}::timestamptz, ${hi}::timestamptz, '[)'), ${expires}::timestamptz)`.execute(
      t.admin,
    );
  const archivedAt = async (unit: string) =>
    (await sql<{ a: Date | null }>`select archived_at as a from units where id = ${unit}`.execute(t.admin))
      .rows[0]?.a;

  it("còn allocation đang hiệu lực kết thúc sau hiện tại (đang ở, sắp tới, hợp đồng mở) → 409 UNIT_IN_USE, phòng không đổi", async () => {
    for (const [code, kind, lo, hi] of [
      ["IU1", "stay", "2026-10-19T07:00:00Z", "2026-10-21T05:00:00Z"], // đang ở
      ["IU2", "stay", "2026-10-25T07:00:00Z", "2026-10-26T05:00:00Z"], // sắp tới
      ["IU3", "lease", "2026-10-01T00:00:00Z", null], // hợp đồng khoảng mở
    ] as const) {
      const u = await room(code);
      await alloc(u, kind, lo, hi);
      expect(await archive(owner, u)).toMatchObject({
        status: "failed",
        httpStatus: 409,
        problem: { code: "UNIT_IN_USE" },
      });
      expect(await archivedAt(u)).toBeNull();
    }
  });

  it("không còn lịch tương lai → đặt archived_at, biến khỏi danh sách phòng nhưng hàng và lịch sử còn nguyên; giữ chỗ phòng đã lưu trữ → 404; mã phòng dùng lại được", async () => {
    const u = await room("AR1");
    await alloc(u, "stay", "2026-10-10T07:00:00Z", "2026-10-12T05:00:00Z"); // đã kết thúc
    await alloc(u, "hold", "2026-10-30T07:00:00Z", "2026-10-31T05:00:00Z", "2026-10-20T02:00:00Z"); // hold quá hạn chưa nhả
    const r = await archive(owner, u);
    expect(r).toMatchObject({ status: "committed" });
    expect(await archivedAt(u)).toEqual(NOW);
    const listed = await listRooms(t.runtime, owner);
    const codes = listed.flatMap((p) => p.rooms);
    expect(codes.some((x) => x.unitId === u)).toBe(false);
    expect(codes.length).toBeGreaterThan(0); // phòng khác vẫn hiện — không phải danh sách rỗng
    const history = await sql<{
      n: number;
    }>`select count(*)::int as n from allocations where unit_id = ${u}`.execute(t.admin);
    expect(history.rows[0]?.n).toBe(2);
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where entity_id = ${u} and action = 'unit.archived'`.execute(
      t.admin,
    );
    expect(audit.rows[0]?.n).toBe(1);
    // Đã lưu trữ rồi thì không còn là phòng đang dùng: lưu trữ lại → 404; mã `AR1` giải phóng cho phòng mới.
    expect(await archive(owner, u)).toMatchObject({ status: "failed", httpStatus: 404 });
    expect(await room("AR1")).toBeTruthy();
  });

  it("ca biên: allocation kết thúc đúng thời điểm hiện tại → lưu trữ được ([start,end) — hết lúc now); lễ tân 403; phòng của tổ chức khác 404", async () => {
    const u = await room("AR2");
    await alloc(u, "stay", "2026-10-19T07:00:00Z", NOW.toISOString());
    expect(await archive(frontDesk, u)).toMatchObject({ status: "failed", httpStatus: 403 });
    expect(await archivedAt(u)).toBeNull();
    expect(await archive(owner, u)).toMatchObject({ status: "committed" });
    const other = await seedOrg(t.admin, "Trọ khác");
    const otherUnit = randomUUID();
    await sql`insert into units (id, organization_id, property_id, floor_id, code)
              values (${otherUnit}, ${other.orgId}, ${other.propertyId}, ${other.floorId}, 'X1')`.execute(
      t.admin,
    );
    expect(await archive(owner, otherUnit)).toMatchObject({ status: "failed", httpStatus: 404 });
  });
});

describe("SPEC-access S-006 / INV-G7: không lưu trữ phòng còn hợp đồng, booking hoặc block chưa kết thúc tham chiếu", () => {
  const archive = (unitId: string) =>
    runAs(t, owner, (ctx) => archiveUnit(ctx, { unitId, now: new Date("2026-10-20T03:00:00Z") }));
  const newUnit = async (code: string) => {
    const r = await runAs(t, owner, (ctx) =>
      createUnit(ctx, { propertyId: A.propertyId, floorName: "Tầng 7", code, capacity: 2 }),
    );
    if (r.status !== "committed") throw new Error(r.problem.code);
    return r.data.unitId;
  };
  const person = async () => {
    const id = randomUUID();
    await sql`insert into persons (id, organization_id, full_name, phone) values (${id}, ${A.orgId}, 'Người thuê', '0100000001')`.execute(
      t.admin,
    );
    return id;
  };
  const archivedAt = async (unit: string) =>
    (await sql<{ a: Date | null }>`select archived_at as a from units where id = ${unit}`.execute(t.admin))
      .rows[0]?.a;

  it("hợp đồng nháp (chưa giữ phòng, chưa có allocation) → 409 UNIT_IN_USE; huỷ hợp đồng → lưu trữ được", async () => {
    const u = await newUnit("RF1");
    const { leaseId } = await seedLease(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      representativePersonId: await person(),
      unitId: u,
    });
    expect(await archive(u)).toMatchObject({
      status: "failed",
      httpStatus: 409,
      problem: { code: "UNIT_IN_USE" },
    });
    expect(await archivedAt(u)).toBeNull();
    await sql`update leases set status = 'cancelled', cancel_reason = 'test' where id = ${leaseId}`.execute(
      t.admin,
    );
    expect(await archive(u)).toMatchObject({ status: "committed" });
  });

  it("booking chưa kết thúc (draft) → 409 UNIT_IN_USE; đã huỷ → lưu trữ được", async () => {
    const u = await newUnit("RF2");
    const { reservationId } = await seedReservation(t.admin, {
      org: { ...A, unitId: u },
      bookerPersonId: await person(),
    });
    expect(await archive(u)).toMatchObject({
      status: "failed",
      httpStatus: 409,
      problem: { code: "UNIT_IN_USE" },
    });
    expect(await archivedAt(u)).toBeNull();
    await sql`update reservations set status = 'cancelled', cancel_reason = 'test', cancelled_at = now() where id = ${reservationId}`.execute(
      t.admin,
    );
    expect(await archive(u)).toMatchObject({ status: "committed" });
  });

  it("block đang chờ duyệt (`requested`) → 409 UNIT_IN_USE; block đã bị từ chối/kết thúc không chặn", async () => {
    const u = await newUnit("RF3");
    const blockId = randomUUID();
    await sql`insert into blocks (id, organization_id, property_id, unit_id, period, reason, requested_by)
              values (${blockId}, ${A.orgId}, ${A.propertyId}, ${u}, tstzrange('2026-10-25T00:00Z', '2026-10-26T00:00Z', '[)'),
                      'sửa điện', ${A.ownerMembershipId})`.execute(t.admin);
    expect(await archive(u)).toMatchObject({
      status: "failed",
      httpStatus: 409,
      problem: { code: "UNIT_IN_USE" },
    });
    await sql`update blocks set status = 'rejected' where id = ${blockId}`.execute(t.admin);
    expect(await archive(u)).toMatchObject({ status: "committed" });
  });
});
