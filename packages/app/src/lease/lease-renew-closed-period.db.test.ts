// Phụ lục không hồi tố vào kỳ thu đã phát hành/khoá (SPEC-lease S-027 ca 2; INV-F6) trên Postgres thật.
import { randomUUID } from "node:crypto";
import { activateLease, createTestDb, type SeededOrg, seedLease, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { codeOf, okAs, runAs, seedMember } from "../testing/helpers.ts";
import { renewLease } from "./handover.ts";
import type { LeaseTerms } from "./lease.ts";

let t: TestDb;
let A: SeededOrg;
let M: Actor;

const terms = (effectiveFrom: string, effectiveTo: string | null = null): LeaseTerms => ({
  effectiveFrom,
  effectiveTo,
  rentAmount: 3_300_000,
  depositAmount: 3_000_000,
  services: [],
});

async function newLease(effectiveTo: string | null): Promise<string> {
  const tenant = await seedMember(t, A, "tenant", {
    properties: [],
    name: `Người thuê ${randomUUID().slice(0, 4)}`,
  });
  const { leaseId } = await seedLease(t.admin, {
    orgId: A.orgId,
    propertyId: A.propertyId,
    representativePersonId: tenant.personId,
    effectiveFrom: "2026-09-01",
    rentAmount: 3_000_000,
  });
  if (effectiveTo)
    await sql`update lease_versions set effective_to = ${effectiveTo}::date where lease_id = ${leaseId}`.execute(
      t.admin,
    );
  await activateLease(t.admin, { org: A, leaseId, effectiveFrom: "2026-09-01" });
  return leaseId;
}

async function addPeriod(start: string, end: string, status: "issued" | "locked"): Promise<void> {
  await sql`insert into billing_periods (id, organization_id, property_id, period_start, period_end, status, issued_at)
            values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${start}::date, ${end}::date, ${status}, now())`.execute(
    t.admin,
  );
}

const versions = async (leaseId: string) =>
  (
    await sql<{ version_no: number; superseded_on: string | null }>`
      select version_no, superseded_on::text from lease_versions where lease_id = ${leaseId} order by version_no`.execute(
      t.admin,
    )
  ).rows;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà trọ Kỳ Khoá", "rental");
  M = await seedMember(t, A, "manager");
});

afterAll(async () => {
  await t?.drop();
});

describe("lease.renew không hồi tố vào kỳ đã phát hành/khoá", () => {
  it("không thời hạn: kỳ 10/2026 đã phát hành → phụ lục từ 01/10 và từ 31/10 bị PERIOD_ISSUED (không đổi gì); từ 01/11 được", async () => {
    const leaseId = await newLease(null);
    await addPeriod("2026-10-01", "2026-10-31", "issued");
    for (const from of ["2026-10-01", "2026-10-15", "2026-10-31"])
      expect(await codeOf(runAs(t, M, (ctx) => renewLease(ctx, { leaseId, terms: terms(from) })))).toBe(
        "PERIOD_ISSUED",
      );
    expect(await versions(leaseId)).toEqual([{ version_no: 1, superseded_on: null }]);
    const ok = await okAs(t, M, (ctx) => renewLease(ctx, { leaseId, terms: terms("2026-11-01") }));
    expect(ok.versionNo).toBe(2);
    expect(await versions(leaseId)).toEqual([
      { version_no: 1, superseded_on: "2026-11-01" },
      { version_no: 2, superseded_on: null },
    ]);
  });

  it("kỳ đã khoá (và mốc khoá sổ) → PERIOD_LOCKED; sau mốc khoá được", async () => {
    const leaseId = await newLease(null);
    // Khoá sổ tới 30/11 rồi kỳ 11/2026 ở trạng thái locked (một cơ chế khoá, trigger deferred kiểm cuối transaction).
    await sql`insert into period_locks (id, organization_id, property_id, locked_through, locked_by, reason)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, '2026-11-30', ${M.membershipId}, 'Chốt kỳ')`.execute(
      t.admin,
    );
    await addPeriod("2026-11-01", "2026-11-30", "locked");
    expect(await codeOf(runAs(t, M, (ctx) => renewLease(ctx, { leaseId, terms: terms("2026-11-20") })))).toBe(
      "PERIOD_LOCKED",
    );
    const ok = await okAs(t, M, (ctx) => renewLease(ctx, { leaseId, terms: terms("2026-12-01") }));
    expect(ok.versionNo).toBe(2);
  });

  it("có hạn: phụ lục cách quãng nhưng bắt đầu trong kỳ đã phát hành → PERIOD_ISSUED; sau kỳ thì được", async () => {
    const leaseId = await newLease("2027-01-15");
    await addPeriod("2027-02-01", "2027-02-28", "issued");
    expect(
      await codeOf(
        runAs(t, M, (ctx) => renewLease(ctx, { leaseId, terms: terms("2027-02-10", "2027-12-31") })),
      ),
    ).toBe("PERIOD_ISSUED");
    expect(await versions(leaseId)).toEqual([{ version_no: 1, superseded_on: null }]);
    const ok = await okAs(t, M, (ctx) =>
      renewLease(ctx, { leaseId, terms: terms("2027-03-01", "2027-12-31") }),
    );
    expect(ok.versionNo).toBe(2);
  });
});
