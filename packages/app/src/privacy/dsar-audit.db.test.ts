// T-2502 (D-139) — account-scoped DSAR audit on real PostgreSQL, runtime/worker roles.
// Lifecycle evidence is atomic, state-based retries add no duplicates, and signing failure never claims issuance.
import { randomUUID } from "node:crypto";
import { withUserContext } from "@hm/db";
import { createTestDb, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { down, up } from "../../../db/src/migrations/0076_dsar_audit_events.ts";
import { createDsarRequest, dsarDownloadUrl, processDsarRequests } from "./dsar.ts";
import { DSAR_DOWNLOADS_PER_HOUR } from "./dsar-policy.ts";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.drop();
});

const newUser = () => seedAuthUser(t.admin, `audit-${randomUUID()}@example.com`);
function fakeStorage() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key: string, bytes: Uint8Array) {
      objects.set(key, bytes);
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async signedGetUrl() {
      return "https://storage.invalid/private?signature=must-not-appear-in-audit";
    },
  };
}

interface Event {
  id: string;
  subject_user_id: string;
  request_id: string;
  actor_type: string;
  action: string;
  request_type: string;
  request_status: string;
  occurred_at: Date;
  correlation_id: string;
}
const events = async (requestId: string) =>
  (
    await sql<Event>`select * from dsar_audit_events where request_id = ${requestId}::uuid
      order by occurred_at, id`.execute(t.admin)
  ).rows;

const finishAccess = async (userId: string) => {
  const request = await createDsarRequest(t.runtime, userId, { type: "access" });
  const storage = fakeStorage();
  await processDsarRequests(t.worker, { storage });
  return { request: request.request, storage };
};

describe("DSAR audit — migration and lifecycle", () => {
  // SPEC-dsar-audit S-007
  it("empty schema down/up restores prior export contract and restricted grants", async () => {
    await down(t.admin);
    const old = await sql<{
      definition: string;
    }>`select pg_get_functiondef('app.dsar_export_data(uuid)'::regprocedure) as definition`.execute(t.admin);
    expect(old.rows[0]?.definition).not.toContain("dsar_audit_events");
    await up(t.admin);
    const grants = await sql<{ runtime: boolean; worker: boolean; public: boolean }>`select
      has_function_privilege('app_runtime', 'app.dsar_audit_url_issued(uuid)', 'execute') as runtime,
      has_function_privilege('app_worker', 'app.dsar_audit_url_issued(uuid)', 'execute') as worker,
      has_function_privilege('public', 'app.dsar_audit_url_issued(uuid)', 'execute') as public`.execute(
      t.admin,
    );
    expect(grants.rows[0]).toEqual({ runtime: true, worker: false, public: false });
  });

  // SPEC-dsar-audit S-001
  it("orgless account: request and immediate restriction completion are recorded once", async () => {
    const userId = await newUser();
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => createDsarRequest(t.runtime, userId, { type: "restrict" })),
    );
    const ids = new Set(rs.map((r) => r.request.id));
    expect(ids.size).toBe(1);
    const id = rs[0]?.request.id as string;
    const rows = await events(id);
    expect(rows.map((e) => e.action)).toEqual(["dsar.requested", "dsar.completed"]);
    for (const row of rows) {
      expect(row).toMatchObject({
        subject_user_id: userId,
        request_id: id,
        actor_type: "user",
        request_type: "restrict",
        request_status: "completed",
        correlation_id: `dsar:${id}`,
      });
      expect(row.occurred_at).toBeInstanceOf(Date);
    }
    expect(
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from memberships where auth_user_id = ${userId}`.execute(t.admin)
      ).rows[0]?.n,
    ).toBe(0);
  });

  it("request INSERT and evidence roll back together if downstream restriction insert fails", async () => {
    const userId = await newUser();
    const broken = t.runtime.withPlugin({
      transformQuery(args) {
        if (JSON.stringify(args.node).includes("insert into processing_restrictions"))
          throw new Error("restriction insert unavailable");
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    await expect(createDsarRequest(broken, userId, { type: "restrict" })).rejects.toThrow(
      "restriction insert unavailable",
    );
    const counts = await sql<{ requests: number; evidence: number; restrictions: number }>`select
      (select count(*)::int from dsar_requests where subject_user_id = ${userId}) as requests,
      (select count(*)::int from dsar_audit_events where subject_user_id = ${userId}) as evidence,
      (select count(*)::int from processing_restrictions where subject_user_id = ${userId}) as restrictions`.execute(
      t.admin,
    );
    expect(counts.rows[0]).toEqual({ requests: 0, evidence: 0, restrictions: 0 });
  });

  // SPEC-dsar-audit S-002
  it("access create, claim and completion are atomic; duplicate create and worker retries add no transitions", async () => {
    const userId = await newUser();
    const request = await createDsarRequest(t.runtime, userId, { type: "access" });
    await createDsarRequest(t.runtime, userId, { type: "access" });
    const storage = fakeStorage();
    const failing = t.worker.withPlugin({
      transformQuery(args) {
        if (JSON.stringify(args.node).includes("dsar_complete_access"))
          throw new Error("completion unavailable");
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    expect(await processDsarRequests(failing, { storage })).toMatchObject({ failed: 1 });
    const id = request.request.id;
    expect((await events(id)).map((e) => e.action)).toEqual(["dsar.requested", "dsar.processing"]);
    await sql`update dsar_requests set processing_started_at = now() - interval '16 minutes' where id = ${id}`.execute(
      t.admin,
    );
    expect(await processDsarRequests(t.worker, { storage })).toMatchObject({ accessCompleted: 1 });
    await processDsarRequests(t.worker, { storage });
    const rows = await events(id);
    expect(rows.map((e) => e.action)).toEqual(["dsar.requested", "dsar.processing", "dsar.completed"]);
    expect(rows.map((e) => e.actor_type)).toEqual(["user", "worker", "worker"]);
  });

  it("audit insertion failure rolls back worker completion", async () => {
    const userId = await newUser();
    const { request } = await finishAccess(userId);
    // A fresh access request is allowed once the previous one completed.
    const next = await createDsarRequest(t.runtime, userId, { type: "access" });
    await sql`select * from app.dsar_claim(now(), 15, 100)`.execute(t.worker);
    await sql`create function public.test_fail_dsar_audit() returns trigger language plpgsql as $$
      begin raise exception 'audit unavailable'; end $$;
      create trigger test_dsar_audit_failure before insert on dsar_audit_events
      for each row execute function public.test_fail_dsar_audit()`.execute(t.admin);
    try {
      await expect(
        sql`select app.dsar_complete_access(${next.request.id}::uuid,
          ${`dsar/${userId}/${next.request.id}.json`}, now() + interval '1 hour', '{}'::jsonb)`.execute(
          t.worker,
        ),
      ).rejects.toThrow("audit unavailable");
    } finally {
      await sql`drop trigger test_dsar_audit_failure on dsar_audit_events;
        drop function public.test_fail_dsar_audit()`.execute(t.admin);
    }
    expect(
      (
        await sql<{ status: string }>`select status from dsar_requests where id = ${next.request.id}`.execute(
          t.admin,
        )
      ).rows[0]?.status,
    ).toBe("processing");
    expect((await events(next.request.id)).map((e) => e.action)).toEqual([
      "dsar.requested",
      "dsar.processing",
    ]);
    expect((await events(request.id)).at(-1)?.action).toBe("dsar.completed");
  });

  it("account erasure retains evidence and audits completion/rejection of pending access", async () => {
    const userId = await newUser();
    const access = await createDsarRequest(t.runtime, userId, { type: "access" });
    const deletion = await createDsarRequest(t.runtime, userId, {
      type: "delete",
      reauthenticatedAt: new Date(),
    });
    await sql`select * from app.dsar_claim(now(), 15, 100)`.execute(t.worker);
    await sql`select app.dsar_erase_account(${deletion.request.id}::uuid, 'retained-by-test-policy')`.execute(
      t.worker,
    );
    expect((await events(deletion.request.id)).map((e) => e.action)).toEqual([
      "dsar.requested",
      "dsar.processing",
      "dsar.completed",
    ]);
    expect((await events(access.request.id)).at(-1)).toMatchObject({
      action: "dsar.rejected",
      actor_type: "worker",
      request_status: "rejected",
    });
    const text = JSON.stringify([
      ...(await events(access.request.id)),
      ...(await events(deletion.request.id)),
    ]);
    expect(text).not.toContain("retained-by-test-policy");
    expect(text).not.toContain("@example.com");
  });
});

describe("DSAR audit — RLS and append-only permissions", () => {
  // SPEC-dsar-audit S-003
  it("A sees only own evidence, B cannot see A, and missing context fails closed", async () => {
    const a = await newUser();
    const b = await newUser();
    const ar = await createDsarRequest(t.runtime, a, { type: "restrict" });
    await createDsarRequest(t.runtime, b, { type: "restrict" });
    const own = await withUserContext(t.runtime, a, (trx) =>
      sql<Event>`select * from dsar_audit_events`.execute(trx),
    );
    expect(own.rows).toHaveLength(2);
    expect(own.rows.every((e) => e.subject_user_id === a)).toBe(true);
    const other = await withUserContext(t.runtime, b, (trx) =>
      sql`select * from dsar_audit_events where request_id = ${ar.request.id}`.execute(trx),
    );
    expect(other.rows).toEqual([]);
    await expect(sql`select * from dsar_audit_events`.execute(t.runtime)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("runtime and worker cannot insert, alter, delete or truncate audit rows", async () => {
    for (const db of [t.runtime, t.worker]) {
      const statements = [
        sql`insert into dsar_audit_events default values`,
        sql`update dsar_audit_events set actor_type = 'worker'`,
        sql`delete from dsar_audit_events`,
        sql`truncate dsar_audit_events`,
      ];
      for (const statement of statements)
        await expect(statement.execute(db)).rejects.toMatchObject({ code: "42501" });
    }
    for (const statement of [
      sql`update dsar_audit_events set actor_type = 'worker'`,
      sql`delete from dsar_audit_events`,
      sql`truncate dsar_audit_events`,
    ])
      await expect(statement.execute(t.admin)).rejects.toMatchObject({ code: "55000" });
  });

  it("support read-only policies cover the new table without preventing the support account's own DSAR evidence", async () => {
    const userId = await newUser();
    const org = await seedOrg(t.admin, "Nhà trọ Hỗ Trợ Quyền Chủ Thể");
    const personId = randomUUID();
    const membershipId = randomUUID();
    await sql`insert into persons (id, organization_id, full_name)
      values (${personId}, ${org.orgId}, 'Người hỗ trợ thử nghiệm')`.execute(t.admin);
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role,
      all_properties, valid_to, support_reason)
      values (${membershipId}, ${org.orgId}, ${userId}, ${personId}, 'platform_support',
        true, now() + interval '1 hour', 'support-case-test')`.execute(t.admin);
    await createDsarRequest(t.runtime, org.ownerAuthUserId, { type: "restrict" });
    const { request, storage } = await finishAccess(userId);
    await expect(dsarDownloadUrl(t.runtime, storage, userId, request.id)).resolves.toHaveProperty("url");
    const rows = await withUserContext(t.runtime, userId, async (trx) => {
      await sql`select set_config('app.org_id', ${org.orgId}, true),
        set_config('app.actor_id', ${membershipId}, true)`.execute(trx);
      expect(
        (await sql<{ ok: boolean }>`select app.actor_not_support() as ok`.execute(trx)).rows[0]?.ok,
      ).toBe(false);
      // The definer writes trusted evidence despite a read-only organization context; no direct table grant exists.
      expect(
        (await sql<{ ok: boolean }>`select app.dsar_audit_url_issued(${request.id}::uuid) as ok`.execute(trx))
          .rows[0]?.ok,
      ).toBe(true);
      return (await sql<Event>`select * from dsar_audit_events`.execute(trx)).rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.subject_user_id === userId)).toBe(true);
    const policies = await sql<{ policyname: string; permissive: string }>`select policyname, permissive
      from pg_policies where schemaname = 'public' and tablename = 'dsar_audit_events'
        and policyname in ('support_ro_ins', 'support_ro_upd', 'support_ro_del') order by policyname`.execute(
      t.admin,
    );
    expect(policies.rows).toEqual([
      { policyname: "support_ro_del", permissive: "RESTRICTIVE" },
      { policyname: "support_ro_ins", permissive: "RESTRICTIVE" },
      { policyname: "support_ro_upd", permissive: "RESTRICTIVE" },
    ]);
  });

  it("down refuses to destroy nonempty evidence and leaves helpers/table usable", async () => {
    await expect(down(t.admin)).rejects.toMatchObject({ code: "55000", hint: "DSAR_AUDIT_EVIDENCE_EXISTS" });
    const { request, storage } = await finishAccess(await newUser());
    await expect(
      dsarDownloadUrl(
        t.runtime,
        storage,
        (await events(request.id))[0]?.subject_user_id as string,
        request.id,
      ),
    ).resolves.toHaveProperty("url");
  });
});

describe("DSAR audit — URL issuance and portable evidence", () => {
  // SPEC-dsar-audit S-005
  it("30 successful issuances share one account limit across requests; attempt 31 never calls the signer", async () => {
    expect(DSAR_DOWNLOADS_PER_HOUR).toBe(30);
    const userId = await newUser();
    const first = await finishAccess(userId);
    const second = await finishAccess(userId);
    let signed = 0;
    const storage = {
      async signedGetUrl() {
        signed += 1;
        return "https://storage.invalid/private?signature=redacted";
      },
    };
    for (let i = 0; i < DSAR_DOWNLOADS_PER_HOUR; i++)
      await dsarDownloadUrl(t.runtime, storage, userId, i % 2 === 0 ? first.request.id : second.request.id);
    await expect(dsarDownloadUrl(t.runtime, storage, userId, first.request.id)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfter: expect.any(Number),
    });
    expect(signed).toBe(30);
    expect(
      [...(await events(first.request.id)), ...(await events(second.request.id))].filter(
        (e) => e.action === "dsar.url_issued",
      ),
    ).toHaveLength(30);
    const other = await newUser();
    const third = await finishAccess(other);
    await expect(dsarDownloadUrl(t.runtime, storage, other, third.request.id)).resolves.toHaveProperty("url");
    expect(signed).toBe(31);
  });

  // SPEC-dsar-audit S-004
  it("successful signing commits url_issued, without URL/storage key/payload in evidence", async () => {
    const userId = await newUser();
    const { request, storage } = await finishAccess(userId);
    const result = await dsarDownloadUrl(t.runtime, storage, userId, request.id);
    expect(result.url).toContain("signature=");
    const rows = await events(request.id);
    expect(rows.at(-1)).toMatchObject({ action: "dsar.url_issued", actor_type: "user" });
    const text = JSON.stringify(rows);
    for (const value of ["signature=", "storage.invalid", `dsar/${userId}/`, "@example.com"])
      expect(text).not.toContain(value);
  });

  it("signing failure emits no issuance; evidence write failure does not return the signed URL", async () => {
    const userId = await newUser();
    const { request, storage } = await finishAccess(userId);
    await expect(
      dsarDownloadUrl(
        t.runtime,
        {
          async signedGetUrl() {
            throw new Error("sign unavailable");
          },
        },
        userId,
        request.id,
      ),
    ).rejects.toThrow("sign unavailable");
    expect((await events(request.id)).some((e) => e.action === "dsar.url_issued")).toBe(false);
    const used = await sql<{ n: number }>`select sum(hits)::int as n from rate_limit_counters
      where scope = 'dsar.download' and subject = ${userId}`.execute(t.admin);
    expect(used.rows[0]?.n).toBe(1);
    const broken = t.runtime.withPlugin({
      transformQuery(args) {
        if (JSON.stringify(args.node).includes("dsar_audit_url_issued")) throw new Error("audit unavailable");
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    await expect(dsarDownloadUrl(broken, storage, userId, request.id)).rejects.toThrow("audit unavailable");
    expect((await events(request.id)).some((e) => e.action === "dsar.url_issued")).toBe(false);
  });

  it("expiry during signing is rechecked before issuance; forged other-user helper calls fail", async () => {
    const userId = await newUser();
    const other = await newUser();
    const { request } = await finishAccess(userId);
    const forged = await withUserContext(t.runtime, other, (trx) =>
      sql<{ ok: boolean }>`select app.dsar_audit_url_issued(${request.id}::uuid) as ok`.execute(trx),
    );
    expect(forged.rows[0]?.ok).toBe(false);
    await expect(
      dsarDownloadUrl(
        t.runtime,
        {
          async signedGetUrl() {
            await sql`update dsar_requests set result_expires_at = now() - interval '1 second' where id = ${request.id}`.execute(
              t.admin,
            );
            return "https://storage.invalid/already-expired";
          },
        },
        userId,
        request.id,
      ),
    ).rejects.toMatchObject({ code: "LINK_EXPIRED" });
    expect((await events(request.id)).some((e) => e.action === "dsar.url_issued")).toBe(false);
  });

  // SPEC-dsar-audit S-006
  it("access export contains own audit history and excludes another subject's events", async () => {
    const userId = await newUser();
    const other = await newUser();
    await createDsarRequest(t.runtime, userId, { type: "restrict" });
    const foreign = await createDsarRequest(t.runtime, other, { type: "restrict" });
    const { storage } = await finishAccess(userId);
    const pkg = [...storage.objects.values()]
      .map(
        (bytes) =>
          JSON.parse(new TextDecoder().decode(bytes)) as {
            account: { id: string };
            audit_events: Record<string, unknown>[];
          },
      )
      .find((x) => x.account.id === userId);
    expect(pkg).toBeDefined();
    expect(pkg?.audit_events.length).toBeGreaterThanOrEqual(4);
    expect(pkg?.audit_events.some((e) => e.action === "dsar.requested")).toBe(true);
    expect(JSON.stringify(pkg?.audit_events)).not.toContain(foreign.request.id);
    expect(Object.keys(pkg?.audit_events[0] ?? {}).sort()).toEqual([
      "action",
      "actor_type",
      "correlation_id",
      "id",
      "occurred_at",
      "request_id",
      "request_status",
      "request_type",
    ]);
  });
});
