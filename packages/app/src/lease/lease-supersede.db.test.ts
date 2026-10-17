// PLAN đợt 3 T-224 — phụ lục cho hợp đồng không thời hạn qua `superseded_on` trên Postgres thật (SPEC-lease S-027; D-007).
import { activateLease, createTestDb, type SeededOrg, seedLease, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { createPeriod, previewPeriod } from "../billing/billing.ts";
import { codeOf, okAs, ownerOf, runAs, seedMember } from "../testing/helpers.ts";
import { renewLease } from "./handover.ts";
import { getLease, type LeaseTerms } from "./lease.ts";

let t: TestDb;
let A: SeededOrg;
let O: Actor;
let M: Actor;
let leaseId: string;

const V2: LeaseTerms = {
  effectiveFrom: "2026-12-01",
  effectiveTo: null,
  rentAmount: 3_300_000,
  depositAmount: 3_000_000,
  services: [],
};

const versionRow = async (no: number) =>
  (
    await sql<{
      superseded_on: string | null;
      effective_until: string | null;
      terms_hash: string;
      rent_amount: string;
    }>`
      select superseded_on::text, effective_until::text, terms_hash, rent_amount::text from lease_versions
      where lease_id = ${leaseId} and version_no = ${no}`.execute(t.admin)
  ).rows[0];

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà trọ Hoa Sen", "rental");
  O = await ownerOf(t, A);
  M = await seedMember(t, A, "manager");
  const tenant = await seedMember(t, A, "tenant", { properties: [], name: "Người thuê An" });
  leaseId = (
    await seedLease(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      representativePersonId: tenant.personId,
      effectiveFrom: "2026-09-01",
      rentAmount: 3_000_000,
    })
  ).leaseId;
  await activateLease(t.admin, { org: A, leaseId, effectiveFrom: "2026-09-01" });
});

afterAll(async () => {
  await t?.drop();
});

describe("S-027 phụ lục thay phiên bản không thời hạn", () => {
  it("v1 3.000.000 không thời hạn → phụ lục v2 3.300.000 từ 01/12: v1 superseded_on 01/12 (băm không đổi), kỳ 11 = 3.000.000, kỳ 12 = 3.300.000, audit", async () => {
    const before = await versionRow(1);
    expect(before).toMatchObject({ superseded_on: null, effective_until: null });
    const r = await okAs(t, M, (ctx) => renewLease(ctx, { leaseId, terms: V2 }));
    expect(r.versionNo).toBe(2);
    const v1 = await versionRow(1);
    expect(v1).toMatchObject({
      superseded_on: "2026-12-01",
      effective_until: "2026-11-30",
      terms_hash: before?.terms_hash,
      rent_amount: "3000000",
    });
    expect(await versionRow(2)).toMatchObject({
      superseded_on: null,
      effective_until: null,
      rent_amount: "3300000",
    });
    const view = await getLease(t.runtime, M, leaseId);
    expect(view.versions.map((v) => [v.version_no, v.effective_until])).toEqual([
      [1, "2026-11-30"],
      [2, null],
    ]);
    const a = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'lease.version_superseded' and entity_id = ${leaseId}`.execute(
      t.admin,
    );
    expect(a.rows[0]?.n).toBe(1);

    const rent = async (month: string) => {
      const p = await okAs(t, M, (ctx) => createPeriod(ctx, { propertyId: A.propertyId, month }));
      const pv = await previewPeriod(t.runtime, M, { billingPeriodId: p.billingPeriodId });
      const item = pv.items.find((i) => i.lease_id === leaseId);
      return item?.lines.filter((l) => l.kind === "room").reduce((s, l) => s + l.amount, 0);
    };
    expect(await rent("2026-11")).toBe(3_000_000);
    expect(await rent("2026-12")).toBe(3_300_000);
  });

  it("superseded_on: đặt lần hai, xoá về NULL, sửa cột khác của phiên bản đã ký → DOCUMENT_IMMUTABLE; phiên bản có hạn không dùng superseded_on", async () => {
    for (const q of [
      sql`update lease_versions set superseded_on = '2027-01-01' where lease_id = ${leaseId} and version_no = 1`,
      sql`update lease_versions set superseded_on = null where lease_id = ${leaseId} and version_no = 1`,
      sql`update lease_versions set rent_amount = 1 where lease_id = ${leaseId} and version_no = 1`,
      sql`update lease_versions set superseded_on = '2027-01-01', rent_amount = 1 where lease_id = ${leaseId} and version_no = 2`,
    ])
      await expect(q.execute(t.admin)).rejects.toMatchObject({ hint: "DOCUMENT_IMMUTABLE" });
    // Phiên bản có hạn: CHECK chặn superseded_on (vẫn theo S-011/S-012).
    const fixed = await okAs(t, O, (ctx) =>
      renewLease(ctx, { leaseId, terms: { ...V2, effectiveFrom: "2027-03-01", effectiveTo: "2027-12-31" } }),
    );
    expect(fixed.versionNo).toBe(3);
    expect(await versionRow(2)).toMatchObject({ superseded_on: "2027-03-01", effective_until: "2027-02-28" });
    await expect(
      sql`update lease_versions set superseded_on = '2027-06-01' where lease_id = ${leaseId} and version_no = 3`.execute(
        t.admin,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("phụ lục có ngày hiệu lực ≤ ngày hiệu lực của phiên bản đang mở / trùng phiên bản có hạn → LEASE_VERSION_OVERLAP, không đổi gì", async () => {
    // v3 (có hạn 01/03–31/12/2027) đang là phiên bản cuối: phụ lục từ 01/06/2027 chồng → 409.
    expect(
      await codeOf(
        runAs(t, M, (ctx) => renewLease(ctx, { leaseId, terms: { ...V2, effectiveFrom: "2027-06-01" } })),
      ),
    ).toBe("LEASE_VERSION_OVERLAP");
    // Phụ lục sau v3, không thời hạn → được; rồi phụ lục khác cùng ngày bắt đầu với phiên bản mở → 409.
    await okAs(t, M, (ctx) => renewLease(ctx, { leaseId, terms: { ...V2, effectiveFrom: "2028-01-01" } }));
    expect(
      await codeOf(
        runAs(t, M, (ctx) => renewLease(ctx, { leaseId, terms: { ...V2, effectiveFrom: "2028-01-01" } })),
      ),
    ).toBe("LEASE_VERSION_OVERLAP");
    expect(await versionRow(4)).toMatchObject({ superseded_on: null, effective_until: null });
  });
});
