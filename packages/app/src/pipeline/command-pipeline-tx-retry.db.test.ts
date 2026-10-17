// DB-TX-002 trên Postgres thật: `withTenantRetry` chạy lại TOÀN BỘ transaction khi serialization failure (40001) thật
// (hai transaction SERIALIZABLE chéo nhau), giữ ngữ cảnh tổ chức/RLS ở mỗi lần chạy, không thử lại lỗi vĩnh viễn.
import { randomUUID } from "node:crypto";
import { withTenant, withTenantRetry } from "@hm/db";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let t: TestDb;
let A: SeededOrg;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS tx-retry");
});

afterAll(async () => {
  await t.drop();
});

function barrier(n: number) {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  return async () => {
    if (++arrived === n) open();
    await gate;
  };
}

const count = async (orgId: string, label: string) =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from persons where organization_id = ${orgId} and full_name like ${`${label}%`}`.execute(
      t.admin,
    )
  ).rows[0]?.n;

describe("withTenantRetry — 40001 thật (SERIALIZABLE write-skew)", () => {
  it("hai transaction cùng đọc rồi cùng ghi → một bên bị 40001, chạy lại và thấy dữ liệu của bên kia; không mất, không trùng", async () => {
    const label = `SSI ${randomUUID().slice(0, 6)}`;
    const meet = barrier(2);
    const attempts = { a: 0, b: 0 };
    const waits: number[] = [];
    // Nạn nhân chạy lại SAU KHI bên kia commit xong (có trần 2 s để không treo nếu cả hai cùng bị huỷ): nếu chạy lại ngay
    // trong lúc bên kia chưa commit, lần chạy lại lại đụng xung đột đọc/ghi và có thể hết lượt — test phụ thuộc thời gian.
    const done: Record<"a" | "b", Promise<unknown>> = { a: Promise.resolve(), b: Promise.resolve() };
    const afterOther = (who: "a" | "b") =>
      Promise.race([
        done[who === "a" ? "b" : "a"].catch(() => undefined),
        new Promise((r) => setTimeout(r, 2_000)),
      ]);
    const run = (who: "a" | "b") =>
      withTenantRetry(
        t.runtime,
        { orgId: A.orgId },
        async (trx) => {
          const n = ++attempts[who];
          // Đọc tập hàng (khoá vị từ SSI) rồi mới ghi dựa trên kết quả đọc.
          const seen = await sql<{ n: number }>`
            select count(*)::int as n from persons where organization_id = ${A.orgId} and full_name like ${`${label}%`}`.execute(
            trx,
          );
          if (n === 1) await meet(); // chỉ lần đầu: cả hai đã đọc trước khi bất kỳ bên nào ghi
          await sql`insert into persons (id, organization_id, full_name)
                    values (${randomUUID()}, ${A.orgId}, ${`${label} ${who} thấy ${seen.rows[0]?.n}`})`.execute(
            trx,
          );
          return seen.rows[0]?.n ?? -1;
        },
        {
          isolationLevel: "serializable",
          random: () => 0.5,
          sleep: async (ms) => {
            waits.push(ms);
            await afterOther(who);
          },
        },
      );
    done.a = run("a");
    done.b = run("b");
    const [ra, rb] = await Promise.all([done.a, done.b]);
    expect(attempts.a + attempts.b).toBe(3); // đúng một nạn nhân chạy lại một lần
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(0);
    // Tuần tự hoá được: một bên thấy 0, bên kia (chạy lại) thấy 1 — không cùng thấy 0 (write skew).
    expect([ra, rb].sort()).toEqual([0, 1]);
    expect(await count(A.orgId, label)).toBe(2);
  });

  it("lỗi vĩnh viễn (vi phạm ràng buộc) → không chạy lại, không chờ, ném nguyên lỗi", async () => {
    const id = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${id}, ${A.orgId}, 'KH trùng id')`.execute(
      t.admin,
    );
    let calls = 0;
    const waits: number[] = [];
    const err = await withTenantRetry(
      t.runtime,
      { orgId: A.orgId },
      async (trx) => {
        calls++;
        await sql`insert into persons (id, organization_id, full_name) values (${id}, ${A.orgId}, 'KH trùng id 2')`.execute(
          trx,
        );
      },
      { sleep: async (ms) => void waits.push(ms) },
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23505");
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it("mỗi lần chạy lại vẫn trong ngữ cảnh tổ chức (RLS): org khác không thấy dữ liệu; hết lượt → ném 40001", async () => {
    const B = await seedOrg(t.admin, "KS tx-retry B");
    let calls = 0;
    const seenOrgs: (string | null | undefined)[] = [];
    const err = await withTenantRetry(
      t.runtime,
      { orgId: A.orgId },
      async (trx) => {
        calls++;
        const r = await sql<{
          org: string | null;
        }>`select current_setting('app.org_id', true) as org`.execute(trx);
        seenOrgs.push(r.rows[0]?.org);
        throw Object.assign(new Error("deadlock"), { code: "40P01" });
      },
      {
        policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, maxElapsedMs: 1_000 },
        sleep: async () => {},
      },
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("40P01");
    expect(calls).toBe(3);
    expect(seenOrgs).toEqual([A.orgId, A.orgId, A.orgId]);
    const other = await withTenant(
      t.runtime,
      { orgId: B.orgId },
      async (trx) =>
        (
          await sql<{
            n: number;
          }>`select count(*)::int as n from persons where organization_id = ${A.orgId}`.execute(trx)
        ).rows[0]?.n,
    );
    expect(other).toBe(0);
  });

  it("orgId không phải UUID → lỗi ngay, không retry; actorId sai cũng vậy", async () => {
    let calls = 0;
    await expect(
      withTenantRetry(t.runtime, { orgId: "không-phải-uuid" }, async () => {
        calls++;
      }),
    ).rejects.toThrow("orgId không phải UUID");
    await expect(
      withTenantRetry(t.runtime, { orgId: A.orgId, actorId: "x" }, async () => {
        calls++;
      }),
    ).rejects.toThrow("actorId không phải UUID");
    expect(calls).toBe(0);
  });
});
