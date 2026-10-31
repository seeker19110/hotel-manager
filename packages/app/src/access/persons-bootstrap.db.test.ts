// T-2503 / AUD-SEC-004: bootstrap INSERT is not permission to update or lock existing personal data.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { down, up } from "../../../db/src/migrations/0077_persons_bootstrap_scope.ts";
import { seedMember } from "../testing/helpers.ts";
import { createOrganization } from "./organization.ts";

let t: TestDb;
let org: SeededOrg;
beforeAll(async () => {
  t = await createTestDb();
  org = await seedOrg(t.admin, "Bootstrap scope");
});
afterAll(async () => {
  await t?.drop();
});

const update = (actorId?: string, db = t.runtime, orgId = org.orgId) =>
  withTenant(db, { orgId, ...(actorId ? { actorId } : {}) }, async (trx) => {
    const r = await sql`update persons set nationality = 'VN', version = version + 1
      where id = ${org.ownerPersonId}`.execute(trx);
    return r.numAffectedRows;
  });

describe("AUD-SEC-004 — persons bootstrap scope", () => {
  it("unknown actor cannot UPDATE an existing person or lock it FOR UPDATE", async () => {
    const actorId = randomUUID();
    const before = await sql`select full_name, nationality, version from persons
      where id = ${org.ownerPersonId}`.execute(t.admin);
    // A WHERE/RETURNING or reading version also invokes SELECT policy, hiding the weaker UPDATE policy.
    // The write itself must be denied even when no existing column is read.
    const changed = await withTenant(t.runtime, { orgId: org.orgId, actorId }, (trx) =>
      sql`update persons set nationality = 'VN'`.execute(trx),
    );
    expect(changed.numAffectedRows).toBe(0n);
    const locked = await withTenant(t.runtime, { orgId: org.orgId, actorId }, (trx) =>
      sql`select id from persons where id = ${org.ownerPersonId} for update`.execute(trx),
    );
    expect(locked.rows).toEqual([]);
    const after = await sql`select full_name, nationality, version from persons
      where id = ${org.ownerPersonId}`.execute(t.admin);
    expect(after.rows).toEqual(before.rows);
  });

  it("unknown actor still inserts the new bootstrap person, but cannot update it", async () => {
    const actorId = randomUUID();
    const personId = randomUUID();
    await withTenant(t.runtime, { orgId: org.orgId, actorId }, async (trx) => {
      await sql`insert into persons (id, organization_id, full_name)
        values (${personId}, ${org.orgId}, 'New bootstrap person')`.execute(trx);
      const changed = await sql`update persons set nationality = 'VN'`.execute(trx);
      expect(changed.numAffectedRows).toBe(0n);
    });
    const stored = await sql<{ nationality: string | null }>`select nationality from persons
      where id = ${personId}`.execute(t.admin);
    expect(stored.rows).toEqual([{ nationality: null }]);
  });

  it("org.create still commits a person, owner, audit and outbox atomically", async () => {
    const userId = await seedAuthUser(t.admin, `bootstrap-${randomUUID()}@example.test`);
    const result = await createOrganization(
      { db: t.runtime, userId, key: randomUUID(), payload: { name: "New org" }, correlationId: randomUUID() },
      { name: "New org" },
    );
    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;
    const rows = await sql<{ people: number; members: number; audit: number; events: number }>`select
      (select count(*)::int from persons where organization_id = ${result.data.organizationId}) as people,
      (select count(*)::int from memberships where id = ${result.data.membershipId} and role = 'owner') as members,
      (select count(*)::int from audit_events where organization_id = ${result.data.organizationId}
        and action = 'organization.created') as audit,
      (select count(*)::int from outbox where organization_id = ${result.data.organizationId}
        and event_type = 'organization.created') as events`.execute(t.admin);
    expect(rows.rows).toEqual([{ people: 1, members: 1, audit: 1, events: 1 }]);
  });

  it.each(["owner", "manager", "front_desk", "accountant"])(
    "active %s retains UPDATE and row locks",
    async (role) => {
      const actor = await seedMember(t, org, role);
      expect(await update(actor.membershipId)).toBe(1n);
      const locked = await withTenant(t.runtime, { orgId: org.orgId, actorId: actor.membershipId }, (trx) =>
        sql`select id from persons where id = ${org.ownerPersonId} for update`.execute(trx),
      );
      expect(locked.rows).toEqual([{ id: org.ownerPersonId }]);
    },
  );

  it("tenant, suspended, revoked and expired memberships cannot UPDATE", async () => {
    const tenant = await seedMember(t, org, "tenant");
    expect(await update(tenant.membershipId)).toBe(0n);
    for (const status of ["suspended", "revoked", "expired"]) {
      const actor = await seedMember(t, org, "manager");
      if (status === "expired") {
        await sql`update memberships set valid_from = now() - interval '2 seconds', valid_to = now() - interval '1 second'
          where id = ${actor.membershipId}`.execute(t.admin);
      } else {
        await sql`update memberships set status = ${status}, revoked_at = ${status === "revoked" ? sql`now()` : null}
          where id = ${actor.membershipId}`.execute(t.admin);
      }
      expect(await update(actor.membershipId)).toBe(0n);
    }
  });

  it("known owner from another organization cannot use the bootstrap exception", async () => {
    const other = await seedOrg(t.admin, "Other bootstrap org");
    expect(await update(other.ownerMembershipId)).toBe(0n);
    expect(await update(org.ownerMembershipId, t.runtime, other.orgId)).toBe(0n);
  });

  it("runtime system context and worker without actor retain their existing UPDATE behavior", async () => {
    expect(await update()).toBe(1n);
    expect(await update(undefined, t.worker)).toBe(1n);
  });

  it("down restores the old behavior, up closes it again without changing INSERT or grants", async () => {
    const actorId = randomUUID();
    const blind = () =>
      withTenant(t.runtime, { orgId: org.orgId, actorId }, (trx) =>
        sql`update persons set nationality = 'VN'`.execute(trx),
      );
    const grants = () =>
      sql`select
      has_function_privilege('app_runtime', 'app.actor_may_update_person()', 'execute') as runtime,
      has_function_privilege('app_worker', 'app.actor_may_update_person()', 'execute') as worker`.execute(
        t.admin,
      );
    const before = await grants();
    try {
      await down(t.admin);
      expect((await blind()).numAffectedRows).toBeGreaterThan(0n);
    } finally {
      await up(t.admin);
    }
    expect((await blind()).numAffectedRows).toBe(0n);
    expect((await grants()).rows).toEqual(before.rows);
  });
});
