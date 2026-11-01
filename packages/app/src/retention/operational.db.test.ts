// T-2505 — operational tables omitted from privacy.retention: invitations and authentication buckets.
// SPEC-dsar-audit S-008: cutoff, live state, linked evidence, batching, locking, rollback and permissions below.
import { randomBytes, randomUUID } from "node:crypto";
import { MS_PER_DAY } from "@hm/domain";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { type RawBuilder, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { down, up } from "../../../db/src/migrations/0078_operational_retention.ts";
import { purgeExpiredOperational } from "./personal.ts";
import {
  AUTH_LOGIN_THROTTLE_RETENTION_DAYS,
  AUTH_RATE_LIMIT_RETENTION_DAYS,
  INVITATION_RETENTION_DAYS,
} from "./policy.ts";

let t: TestDb;
let org: SeededOrg;
const NOW = new Date(Date.now() - 1000);
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * MS_PER_DAY - extraMs);
beforeAll(async () => {
  t = await createTestDb();
  org = await seedOrg(t.admin, "Nhà trọ Dọn Dữ Liệu Vận Hành", "rental");
});
afterAll(async () => {
  await t?.drop();
});
const count = async (q: RawBuilder<{ n: number }>) => (await q.execute(t.admin)).rows[0]?.n ?? 0;
const invitationAlive = (id: string) =>
  count(sql`select count(*)::int as n from invitations where id = ${id}`);
const throttleAlive = (hash: Buffer) =>
  count(sql`select count(*)::int as n from auth.login_throttle where email_hash = ${hash}`);
const rateAlive = (id: string) =>
  count(sql`select count(*)::int as n from auth."rateLimit" where id = ${id}`);

async function invitation(at: Date, status = "pending", expiresAt = at, acceptedAt: Date | null = null) {
  const id = randomUUID();
  await sql`insert into invitations (id, organization_id, email, role, token_hash, expires_at,
    status, invited_by, accepted_at, created_at, updated_at)
    values (${id}, ${org.orgId}, ${`invite-${id}@example.com`}, 'tenant', ${randomBytes(32)}, ${expiresAt},
    ${status}, ${org.ownerMembershipId}, ${acceptedAt}, ${at}, ${at})`.execute(t.admin);
  return id;
}
async function throttle(windowAt: Date, lockedUntil: Date | null = null) {
  const hash = randomBytes(32);
  await sql`insert into auth.login_throttle (email_hash, failures, window_started_at, locked_until)
    values (${hash}, 3, ${windowAt}, ${lockedUntil})`.execute(t.admin);
  return hash;
}
async function rateLimit(at: Date | bigint) {
  const id = randomUUID();
  const milliseconds = at instanceof Date ? at.getTime() : at.toString();
  await sql`insert into auth."rateLimit" (id, key, count, "lastRequest")
    values (${id}, ${`retention-${id}`}, 4, ${milliseconds})`.execute(t.admin);
  return id;
}

describe("operational retention omissions (T-2505)", () => {
  it("privacy.retention removes expired invitations and stale auth buckets", async () => {
    const invite = await invitation(ago(100));
    const login = await throttle(ago(8));
    const bucket = await rateLimit(ago(8));
    await purgeExpiredOperational(t.worker, { now: NOW });
    expect(await invitationAlive(invite)).toBe(0);
    expect(await throttleAlive(login)).toBe(0);
    expect(await rateAlive(bucket)).toBe(0);
  });

  it("invitations: latest expiry/update/acceptance controls cutoff; boundary and linked evidence remain", async () => {
    expect(INVITATION_RETENTION_DAYS).toBe(90);
    const old = await invitation(ago(91));
    const revoked = await invitation(ago(91), "revoked");
    const accepted = await invitation(ago(100), "accepted", ago(100), ago(91));
    const boundary = await invitation(ago(90));
    const recent = await invitation(ago(89));
    const live = await invitation(ago(1000), "pending", ago(-1));
    const recentlyAccepted = await invitation(ago(100), "accepted", ago(100), ago(1));
    const recentlyUpdated = await invitation(ago(100));
    await sql`update invitations set status = 'revoked' where id = ${recentlyUpdated}`.execute(t.admin);
    const linkedPerson = await invitation(ago(1000));
    const linkedMember = await invitation(ago(1000));
    await t.admin.transaction().execute(async (trx) => {
      // Seed historical links without the updated-at trigger restarting their clock.
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`update invitations set person_id = ${org.ownerPersonId} where id = ${linkedPerson}`.execute(
        trx,
      );
      await sql`update invitations set membership_id = ${org.ownerMembershipId} where id = ${linkedMember}`.execute(
        trx,
      );
    });
    expect((await purgeExpiredOperational(t.worker, { now: NOW })).invitations).toBe(3);
    for (const id of [old, revoked, accepted]) expect(await invitationAlive(id)).toBe(0);
    for (const id of [boundary, recent, live, recentlyAccepted, recentlyUpdated, linkedPerson, linkedMember])
      expect(await invitationAlive(id)).toBe(1);
  });

  it("login buckets: keep recent windows, future locks and exact seven-day boundaries", async () => {
    expect(AUTH_LOGIN_THROTTLE_RETENTION_DAYS).toBe(7);
    const old = await throttle(ago(8));
    const oldLock = await throttle(ago(10), ago(8));
    const windowBoundary = await throttle(ago(7));
    const lockBoundary = await throttle(ago(10), ago(7));
    const recent = await throttle(ago(6));
    const live = await throttle(ago(100), ago(-1));
    const futureWindow = await throttle(ago(-1));
    expect((await purgeExpiredOperational(t.worker, { now: NOW })).authLoginThrottle).toBe(2);
    for (const hash of [old, oldLock]) expect(await throttleAlive(hash)).toBe(0);
    for (const hash of [windowBoundary, lockBoundary, recent, live, futureWindow])
      expect(await throttleAlive(hash)).toBe(1);
  });

  it("rate buckets use milliseconds and tolerate the full bigint range without timestamp conversion", async () => {
    expect(AUTH_RATE_LIMIT_RETENTION_DAYS).toBe(7);
    const old = await rateLimit(ago(8));
    const justOver = await rateLimit(ago(7, 1));
    const minimum = await rateLimit(-9_223_372_036_854_775_808n);
    const boundary = await rateLimit(ago(7));
    const recent = await rateLimit(ago(6));
    const future = await rateLimit(9_223_372_036_854_775_807n);
    expect((await purgeExpiredOperational(t.worker, { now: NOW })).authRateLimits).toBe(3);
    for (const id of [old, justOver, minimum]) expect(await rateAlive(id)).toBe(0);
    for (const id of [boundary, recent, future]) expect(await rateAlive(id)).toBe(1);
    // A fractional-millisecond cutoff still expires the integer just before it, with no rounding loss.
    await sql`select app.purge_auth_rate_limits(${NOW}::timestamptz + interval '500 microseconds', 7, 5000)`.execute(
      t.worker,
    );
    expect(await rateAlive(boundary)).toBe(0);
    expect(await rateAlive(future)).toBe(1);
  });

  it("future caller time cannot shorten retention; minimum days cannot be bypassed", async () => {
    const invite = await invitation(ago(89));
    const login = await throttle(ago(6));
    const bucket = await rateLimit(ago(6));
    const future = new Date(Date.now() + 1000 * MS_PER_DAY);
    await sql`select app.purge_invitations(${future}, -100, 5000)`.execute(t.worker);
    await sql`select app.purge_auth_login_throttle(${future}, -100, 5000)`.execute(t.worker);
    await sql`select app.purge_auth_rate_limits(${future}, -100, 5000)`.execute(t.worker);
    expect(await invitationAlive(invite)).toBe(1);
    expect(await throttleAlive(login)).toBe(1);
    expect(await rateAlive(bucket)).toBe(1);
    // A longer requested policy is respected too.
    const longer = await invitation(ago(100));
    await sql`select app.purge_invitations(${NOW}, 365, 5000)`.execute(t.worker);
    expect(await invitationAlive(longer)).toBe(1);
    await sql`select app.purge_invitations(${NOW}, 90, 5000)`.execute(t.worker);
  });

  it("job batch/round limit applies independently to each table and repeats until drained", async () => {
    const invites: string[] = [];
    const logins: Buffer[] = [];
    const buckets: string[] = [];
    for (let i = 0; i < 5; i++) {
      invites.push(await invitation(ago(100)));
      logins.push(await throttle(ago(8)));
      buckets.push(await rateLimit(ago(8)));
    }
    for (const expected of [2, 2, 1, 0]) {
      const stats = await purgeExpiredOperational(t.worker, { now: NOW, batch: 2, maxRounds: 1 });
      expect(stats).toMatchObject({
        invitations: expected,
        authLoginThrottle: expected,
        authRateLimits: expected,
      });
    }
    for (const id of invites) expect(await invitationAlive(id)).toBe(0);
    for (const hash of logins) expect(await throttleAlive(hash)).toBe(0);
    for (const id of buckets) expect(await rateAlive(id)).toBe(0);
  });

  it("database clamps batch to at least one and at most 5000 rows", async () => {
    const invite1 = await invitation(ago(100));
    const invite2 = await invitation(ago(100));
    const result = await sql<{ n: number }>`select app.purge_invitations(${NOW}, 90, 0) as n`.execute(
      t.worker,
    );
    expect(result.rows[0]?.n).toBe(1);
    expect((await invitationAlive(invite1)) + (await invitationAlive(invite2))).toBe(1);
    await sql`select app.purge_invitations(${NOW}, 90, 5000)`.execute(t.worker);
    const prefix = `batch-${randomUUID()}`;
    await sql`insert into auth."rateLimit" (key, count, "lastRequest")
      select ${prefix} || '-' || n::text, 1, ${ago(8).getTime()} from generate_series(1, 5002) n`.execute(
      t.admin,
    );
    const capped = await sql<{
      n: number;
    }>`select app.purge_auth_rate_limits(${NOW}, 7, 999999) as n`.execute(t.worker);
    expect(capped.rows[0]?.n).toBe(5000);
    expect(
      await count(sql`select count(*)::int as n from auth."rateLimit" where key like ${`${prefix}%`}`),
    ).toBe(2);
    expect(
      (await sql<{ n: number }>`select app.purge_auth_rate_limits(${NOW}, 7, 999999) as n`.execute(t.worker))
        .rows[0]?.n,
    ).toBe(2);
  });

  it("SKIP LOCKED skips in-flight invitation renewal and auth requests, then rechecks their fresh timestamps", async () => {
    const invite = await invitation(ago(100));
    const login = await throttle(ago(8));
    const bucket = await rateLimit(ago(8));
    await t.admin.transaction().execute(async (trx) => {
      await sql`select id from invitations where id = ${invite} for update`.execute(trx);
      await sql`select email_hash from auth.login_throttle where email_hash = ${login} for update`.execute(
        trx,
      );
      await sql`select id from auth."rateLimit" where id = ${bucket} for update`.execute(trx);
      expect((await purgeExpiredOperational(t.worker, { now: NOW })).invitations).toBe(0);
      expect(await invitationAlive(invite)).toBe(1);
      expect(await throttleAlive(login)).toBe(1);
      expect(await rateAlive(bucket)).toBe(1);
      await sql`update invitations set expires_at = now() + interval '1 day' where id = ${invite}`.execute(
        trx,
      );
      await sql`update auth.login_throttle set window_started_at = now() where email_hash = ${login}`.execute(
        trx,
      );
      await sql`update auth."rateLimit" set "lastRequest" = floor(extract(epoch from now()) * 1000)::bigint where id = ${bucket}`.execute(
        trx,
      );
    });
    const stats = await purgeExpiredOperational(t.worker, { now: NOW });
    expect(stats).toMatchObject({ invitations: 0, authLoginThrottle: 0, authRateLimits: 0 });
    expect(await invitationAlive(invite)).toBe(1);
    expect(await throttleAlive(login)).toBe(1);
    expect(await rateAlive(bucket)).toBe(1);
  });

  it("transaction rollback restores deleted records and a retry deletes them once", async () => {
    const invite = await invitation(ago(100));
    const login = await throttle(ago(8));
    const bucket = await rateLimit(ago(8));
    await expect(
      t.worker.transaction().execute(async (trx) => {
        await sql`select app.purge_invitations(${NOW}, 90, 5000)`.execute(trx);
        await sql`select app.purge_auth_login_throttle(${NOW}, 7, 5000)`.execute(trx);
        await sql`select app.purge_auth_rate_limits(${NOW}, 7, 5000)`.execute(trx);
        throw new Error("rollback retention batch");
      }),
    ).rejects.toThrow("rollback retention batch");
    expect(await invitationAlive(invite)).toBe(1);
    expect(await throttleAlive(login)).toBe(1);
    expect(await rateAlive(bucket)).toBe(1);
    expect(await purgeExpiredOperational(t.worker, { now: NOW })).toMatchObject({
      invitations: 1,
      authLoginThrottle: 1,
      authRateLimits: 1,
    });
    expect(await purgeExpiredOperational(t.worker, { now: NOW })).toMatchObject({
      invitations: 0,
      authLoginThrottle: 0,
      authRateLimits: 0,
    });
  });

  it("one failing table does not prevent authentication cleanup; retry finishes the failed table", async () => {
    const invite = await invitation(ago(100));
    const login = await throttle(ago(8));
    const bucket = await rateLimit(ago(8));
    const logs: unknown[] = [];
    await sql`revoke execute on function app.purge_invitations(timestamptz, integer, integer) from app_worker`.execute(
      t.admin,
    );
    try {
      await expect(
        purgeExpiredOperational(t.worker, { now: NOW, log: (e, f) => logs.push([e, f]) }),
      ).rejects.toBeInstanceOf(AggregateError);
    } finally {
      await sql`grant execute on function app.purge_invitations(timestamptz, integer, integer) to app_worker`.execute(
        t.admin,
      );
    }
    expect(logs).toEqual([["retention.operational_purge_failed", { table: "invitations", error: "error" }]]);
    expect(await invitationAlive(invite)).toBe(1);
    expect(await throttleAlive(login)).toBe(0);
    expect(await rateAlive(bucket)).toBe(0);
    expect((await purgeExpiredOperational(t.worker, { now: NOW })).invitations).toBe(1);
  });

  it("helpers are worker-only and direct worker DELETE remains denied", async () => {
    for (const query of [
      sql`select app.purge_invitations(${NOW}, 90, 1)`,
      sql`select app.purge_auth_login_throttle(${NOW}, 7, 1)`,
      sql`select app.purge_auth_rate_limits(${NOW}, 7, 1)`,
    ])
      await expect(query.execute(t.runtime)).rejects.toMatchObject({ code: "42501" });
    for (const query of [
      sql`delete from invitations`,
      sql`delete from auth.login_throttle`,
      sql`delete from auth."rateLimit"`,
    ])
      await expect(query.execute(t.worker)).rejects.toMatchObject({ code: "42501" });
    const config = await sql<{ config: string[]; public: boolean }>`select proconfig as config,
      has_function_privilege('public', p.oid, 'execute') as public
      from pg_proc p where p.oid in ('app.purge_invitations(timestamptz, integer, integer)'::regprocedure,
        'app.purge_auth_login_throttle(timestamptz, integer, integer)'::regprocedure,
        'app.purge_auth_rate_limits(timestamptz, integer, integer)'::regprocedure)`.execute(t.admin);
    expect(config.rows).toHaveLength(3);
    for (const row of config.rows) {
      expect(row.public).toBe(false);
      expect(row.config).toContain("TimeZone=UTC");
      expect(row.config).toContain("search_path=pg_catalog, public, pg_temp");
    }
  });

  it("down removes only helpers/indexes; up restores grants and retained data remains", async () => {
    const invite = await invitation(ago(1));
    await down(t.admin);
    const missing = await sql<{ helper: string | null; index: string | null }>`select
      to_regprocedure('app.purge_invitations(timestamptz, integer, integer)')::text as helper,
      to_regclass('ix_invitations_retention_dead_at')::text as index`.execute(t.admin);
    expect(missing.rows[0]).toEqual({ helper: null, index: null });
    expect(await invitationAlive(invite)).toBe(1);
    await up(t.admin);
    await expect(sql`select app.purge_invitations(${NOW}, 90, 100)`.execute(t.worker)).resolves.toBeDefined();
    await expect(
      sql`select app.purge_auth_login_throttle(${NOW}, 7, 100)`.execute(t.worker),
    ).resolves.toBeDefined();
    await expect(
      sql`select app.purge_auth_rate_limits(${NOW}, 7, 100)`.execute(t.worker),
    ).resolves.toBeDefined();
    expect(await invitationAlive(invite)).toBe(1);
  });
});
