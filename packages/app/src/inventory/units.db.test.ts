// Tạo phòng và mã phòng duy nhất theo cơ sở (SPEC-access S-004, T017; ERD `units` — `uq_units_code`).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { ownerOf, runAs, seedMember } from "../testing/helpers.ts";
import { createUnit } from "./units.ts";

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
