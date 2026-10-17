// Migration 0044 có đường lùi khi ĐÃ có phụ lục cho hợp đồng không thời hạn (D-007): down đóng phiên bản bị thay bằng
// effective_to = superseded_on − 1 (vượt trigger bất biến hẹp), dựng lại EXCLUDE không lỗi 23P01, up lại được.
import { createMigrator } from "@hm/db";
import { activateLease, createTestDb, type SeededOrg, seedLease, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { okAs, seedMember } from "../testing/helpers.ts";
import { renewLease } from "./handover.ts";

let t: TestDb;
let A: SeededOrg;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà trọ Down", "rental");
});

afterAll(async () => {
  await t?.drop();
});

describe("migration 0044 down/up sau phụ lục hợp đồng không thời hạn", () => {
  it("down 0044 giữ dữ liệu đúng (v1 effective_to = ngày trước v2, băm không đổi), EXCLUDE dựng lại được, up lại được", async () => {
    const M = await seedMember(t, A, "manager");
    const tenant = await seedMember(t, A, "tenant", { properties: [], name: "Người thuê Bình" });
    const { leaseId } = await seedLease(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      representativePersonId: tenant.personId,
      effectiveFrom: "2026-09-01",
      rentAmount: 3_000_000,
    });
    await activateLease(t.admin, { org: A, leaseId, effectiveFrom: "2026-09-01" });
    await okAs(t, M, (ctx) =>
      renewLease(ctx, {
        leaseId,
        terms: {
          effectiveFrom: "2026-12-01",
          effectiveTo: null,
          rentAmount: 3_300_000,
          depositAmount: 3_000_000,
          services: [],
        },
      }),
    );
    const rows = () =>
      sql<{ version_no: number; effective_from: string; effective_to: string | null; terms_hash: string }>`
        select version_no, effective_from::text, effective_to::text, terms_hash from lease_versions
        where lease_id = ${leaseId} order by version_no`.execute(t.admin);
    const before = (await rows()).rows;
    expect(before.map((r) => r.effective_to)).toEqual([null, null]);

    const migrator = createMigrator(t.admin);
    const down = await migrator.migrateTo("0043_export_jobs");
    expect(down.error).toBeUndefined();
    const hasCol = await sql<{ n: number }>`
      select count(*)::int as n from information_schema.columns
      where table_name = 'lease_versions' and column_name in ('superseded_on', 'effective_until')`.execute(
      t.admin,
    );
    expect(hasCol.rows[0]?.n).toBe(0);
    const mid = (await rows()).rows;
    expect(mid.map((r) => [r.version_no, r.effective_from, r.effective_to])).toEqual([
      [1, "2026-09-01", "2026-11-30"],
      [2, "2026-12-01", null],
    ]);
    expect(mid.map((r) => r.terms_hash)).toEqual(before.map((r) => r.terms_hash));
    // Trigger bất biến được bật lại sau down.
    await expect(
      sql`update lease_versions set rent_amount = 1 where lease_id = ${leaseId} and version_no = 1`.execute(
        t.admin,
      ),
    ).rejects.toMatchObject({ hint: "DOCUMENT_IMMUTABLE" });

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();
    const after = (
      await sql<{ version_no: number; effective_until: string | null; superseded_on: string | null }>`
        select version_no, effective_until::text, superseded_on::text from lease_versions
        where lease_id = ${leaseId} order by version_no`.execute(t.admin)
    ).rows;
    expect(after.map((r) => [r.version_no, r.effective_until, r.superseded_on])).toEqual([
      [1, "2026-11-30", null],
      [2, null, null],
    ]);
  });
});
