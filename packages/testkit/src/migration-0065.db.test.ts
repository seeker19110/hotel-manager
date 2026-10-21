// AUD-DATA-003/004 (T-1603): migration 0065 thêm policy RESTRICTIVE theo VAI TRÒ cho đường ghi hồ sơ người và tiền.
//  · `persons` INSERT: chỉ owner/manager/front_desk; UPDATE (gồm FOR UPDATE của `lockPerson`): + accountant (D-090). Cả hai
//    cho ngữ cảnh bootstrap org.create/acceptInvitation (actor_id đặt nhưng membership chưa tồn tại); housekeeping/maintenance/
//    tenant/guest và membership không active bị chặn.
//  · `payments` INSERT/UPDATE và `shift_discrepancies` INSERT: chỉ owner/manager/front_desk/accountant (ma trận `payment.record`,
//    `shift.open_close`).
//  · Không actor (worker, ngữ cảnh hệ thống) → không đổi. `down` gỡ đúng các policy; up lại dựng lại.
// Chạy trên Postgres thật bằng role `app_runtime` (chịu RLS) với `app.org_id`/`app.actor_id` đặt như `withTenant`.
import { randomUUID } from "node:crypto";
import { createMigrator, migrations } from "@hm/db";
import { type Kysely, sql, type Transaction } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db.ts";
import { type SeededOrg, seedAuthUser, seedOrg } from "./factory.ts";

const NAME = "0065_role_write_policies";
const PREV = "0064_catalog_property_scope";
const POLICIES = [
  "persons.persons_role_insert",
  "persons.persons_role_update",
  "payments.payments_role_insert",
  "payments.payments_role_update",
  "shift_discrepancies.discrepancies_role_insert",
];
const ALLOWED = ["owner", "manager", "front_desk", "accountant"] as const;
/** D-090: tạo hồ sơ người — accountant KHÔNG (không có đường tạo person nào của kế toán). */
const PERSON_CREATORS = ["owner", "manager", "front_desk"] as const;
const DENIED = ["housekeeping", "maintenance", "tenant", "guest"] as const;
type Role = (typeof ALLOWED)[number] | (typeof DENIED)[number];

let t: TestDb;
let s: SeededOrg;
const member: Record<string, { id: string; personId: string; shiftId: string }> = {};
let suspendedHk: string;

beforeAll(async () => {
  t = await createTestDb();
  s = await seedOrg(t.admin, "Org 0065");
  const add = async (role: Role, status = "active") => {
    const au = randomUUID();
    const personId = randomUUID();
    const id = randomUUID();
    const shiftId = randomUUID();
    await seedAuthUser(t.admin, `${role}-${id.slice(0, 6)}@example.test`, au);
    await sql`insert into persons (id, organization_id, full_name) values (${personId}, ${s.orgId}, ${role})`.execute(
      t.admin,
    );
    // Mọi thành viên đều có phạm vi cơ sở (accountant: mọi cơ sở; còn lại: property_scopes) — phạm vi KHÔNG phải thứ chặn, chỉ vai
    // trò (đúng ca AUD-DATA-004: housekeeping có phạm vi cơ sở).
    const all = role === "accountant";
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, status, all_properties)
              values (${id}, ${s.orgId}, ${au}, ${personId}, ${role}, ${status}, ${all})`.execute(t.admin);
    if (!all)
      await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
                values (${randomUUID()}, ${s.orgId}, ${id}, ${s.propertyId})`.execute(t.admin);
    // Mỗi thành viên một ca mở riêng (uq_shifts_one_open theo người mở) — để ghi tiền mặt/chênh lệch ca.
    await sql`insert into shifts (id, organization_id, property_id, opened_by, opening_cash)
              values (${shiftId}, ${s.orgId}, ${s.propertyId}, ${id}, 0)`.execute(t.admin);
    return { id, personId, shiftId };
  };
  for (const r of [...ALLOWED.filter((r) => r !== "owner"), ...DENIED]) member[r] = await add(r);
  const ownerShift = randomUUID();
  await sql`insert into shifts (id, organization_id, property_id, opened_by, opening_cash)
            values (${ownerShift}, ${s.orgId}, ${s.propertyId}, ${s.ownerMembershipId}, 0)`.execute(t.admin);
  member.owner = { id: s.ownerMembershipId, personId: s.ownerPersonId, shiftId: ownerShift };
  suspendedHk = (await add("housekeeping", "suspended")).id;
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

/** Chạy `q` bằng `db` (mặc định app_runtime) trong một giao dịch có ngữ cảnh tổ chức (+ actor nếu có) — như `withTenant`. */
function as<T>(
  actor: string | null,
  q: (trx: Transaction<unknown>) => Promise<T>,
  db: Kysely<unknown> = t.runtime,
) {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.org_id', ${s.orgId}, true)`.execute(trx);
    if (actor) await sql`select set_config('app.actor_id', ${actor}, true)`.execute(trx);
    return q(trx);
  });
}

const insertPerson = (trx: Transaction<unknown>, id: string = randomUUID()) =>
  sql`insert into persons (id, organization_id, full_name) values (${id}, ${s.orgId}, 'Khách thử')`.execute(
    trx,
  );
const updatePerson = async (trx: Transaction<unknown>, id: string) =>
  (await sql`update persons set nationality = 'VN', version = version + 1 where id = ${id}`.execute(trx))
    .numAffectedRows;
/** Phiếu thu tiền mặt `recorded_by` = actor (điều kiện của `payments_record`), vào ca mở của chính actor. */
const insertPayment = (
  trx: Transaction<unknown>,
  m: { id: string; shiftId: string },
  id: string = randomUUID(),
) =>
  sql`insert into payments (id, organization_id, property_id, method, purpose, amount, payer_person_id, shift_id,
                            business_date, recorded_by)
      values (${id}, ${s.orgId}, ${s.propertyId}, 'cash', 'receivable', 100000, ${s.ownerPersonId}, ${m.shiftId},
              '2026-10-21', ${m.id})`.execute(trx);
const insertDiscrepancy = (trx: Transaction<unknown>, m: { id: string; shiftId: string }) =>
  sql`insert into shift_discrepancies (id, organization_id, property_id, shift_id, kind, amount, responsible_membership_id)
      values (${randomUUID()}, ${s.orgId}, ${s.propertyId}, ${m.shiftId}, 'close', -5000, ${m.id})`.execute(
    trx,
  );
const RLS = /row-level security/;

describe("migration 0065 — sổ + policy", () => {
  it("0065 đứng liền sau 0064; có đủ 5 policy RESTRICTIVE cho app_runtime", async () => {
    const keys = Object.keys(migrations);
    expect(keys.indexOf(NAME)).toBe(keys.indexOf(PREV) + 1);
    const r = await sql<{ p: string; permissive: string; roles: string[] }>`
      select tablename || '.' || policyname as p, permissive, roles::text[] as roles from pg_policies
      where policyname in ('persons_role_insert','persons_role_update','payments_role_insert','payments_role_update',
                           'discrepancies_role_insert') order by 1`.execute(t.admin);
    expect(r.rows.map((x) => x.p)).toEqual([...POLICIES].sort());
    for (const x of r.rows) expect([x.permissive, x.roles]).toEqual(["RESTRICTIVE", ["app_runtime"]]);
  });
});

describe("AUD-DATA-003 — persons: ghi theo vai trò", () => {
  it.each(DENIED)("%s: INSERT persons bị RLS chặn; UPDATE không đổi dòng nào", async (role) => {
    const m = member[role] as { id: string };
    await expect(as(m.id, (trx) => insertPerson(trx))).rejects.toThrow(RLS);
    // Kể cả hồ sơ của chính mình (tenant/guest đọc được dòng mình qua persons_read) — UPDATE bị lọc ở USING.
    const own = await as(m.id, (trx) => updatePerson(trx, (member[role] as { personId: string }).personId));
    expect(own).toBe(0n);
    const other = await as(m.id, (trx) => updatePerson(trx, s.ownerPersonId));
    expect(other).toBe(0n);
  });

  it("membership bị đình chỉ (housekeeping suspended) cũng bị chặn", async () => {
    await expect(as(suspendedHk, (trx) => insertPerson(trx))).rejects.toThrow(RLS);
  });

  it.each(PERSON_CREATORS)("%s: INSERT + UPDATE persons được", async (role) => {
    const m = member[role] as { id: string };
    const id = randomUUID();
    await as(m.id, (trx) => insertPerson(trx, id));
    expect(await as(m.id, (trx) => updatePerson(trx, id))).toBe(1n);
  });

  it("accountant (D-090): INSERT persons bị RLS chặn; UPDATE hồ sơ có sẵn vẫn được", async () => {
    const acc = (member.accountant as { id: string }).id;
    await expect(as(acc, (trx) => insertPerson(trx))).rejects.toThrow(RLS);
    const id = randomUUID();
    await t.admin.transaction().execute((trx) => insertPerson(trx, id));
    expect(await as(acc, (trx) => updatePerson(trx, id))).toBe(1n);
  });

  it("accountant khoá hàng persons FOR UPDATE được (mutex CUSTOMER_CREDIT — lockPerson); housekeeping thì không thấy dòng", async () => {
    const lock = (actor: string) =>
      as(actor, async (trx) => {
        const r = await sql`select id from persons where id = ${s.ownerPersonId} for update`.execute(trx);
        return r.rows.length;
      });
    expect(await lock((member.accountant as { id: string }).id)).toBe(1);
    expect(await lock((member.housekeeping as { id: string }).id)).toBe(0);
  });

  it("bootstrap org.create/acceptInvitation: actor_id đặt nhưng membership CHƯA tồn tại ⇒ vẫn tạo được person", async () => {
    const id = randomUUID();
    await as(randomUUID(), (trx) => insertPerson(trx, id));
    const n = await sql<{ n: number }>`select count(*)::int as n from persons where id = ${id}`.execute(
      t.admin,
    );
    expect(n.rows[0]?.n).toBe(1);
  });

  it("không actor (worker/hệ thống) trên app_runtime và app_worker: không đổi hành vi", async () => {
    const id = randomUUID();
    await as(null, (trx) => insertPerson(trx, id));
    expect(await as(null, (trx) => updatePerson(trx, id))).toBe(1n);
    expect(await as(null, (trx) => updatePerson(trx, id), t.worker)).toBe(1n);
  });
});

describe("AUD-DATA-004 — payments + shift_discrepancies: ghi theo vai trò", () => {
  it.each(DENIED)("%s: INSERT payments và shift_discrepancies bị RLS chặn", async (role) => {
    const m = member[role] as { id: string; shiftId: string };
    await expect(as(m.id, (trx) => insertPayment(trx, m))).rejects.toThrow(RLS);
    await expect(as(m.id, (trx) => insertDiscrepancy(trx, m))).rejects.toThrow(RLS);
  });

  it.each(ALLOWED)(
    "%s: INSERT payments + shift_discrepancies được; UPDATE khoản mình ghi được",
    async (role) => {
      const m = member[role] as { id: string; shiftId: string };
      const id = randomUUID();
      await as(m.id, (trx) => insertPayment(trx, m, id));
      await as(m.id, (trx) => insertDiscrepancy(trx, m));
      const upd = await as(
        m.id,
        async (trx) =>
          (await sql`update payments set version = version + 1 where id = ${id}`.execute(trx))
            .numAffectedRows,
      );
      expect(upd).toBe(1n);
    },
  );

  it("housekeeping không UPDATE được phiếu thu (kể cả phiếu ghi tên mình do dữ liệu cũ)", async () => {
    const hk = member.housekeeping as { id: string; shiftId: string };
    const id = randomUUID();
    await insertPaymentAdmin(id, hk);
    const upd = await as(
      hk.id,
      async (trx) =>
        (await sql`update payments set version = version + 1 where id = ${id}`.execute(trx)).numAffectedRows,
    );
    expect(upd).toBe(0n);
  });
});

async function insertPaymentAdmin(id: string, m: { id: string; shiftId: string }) {
  await t.admin.transaction().execute((trx) => insertPayment(trx, m, id));
}

describe("migration 0065 — lùi/tiến", () => {
  it("down gỡ đúng 5 policy (housekeeping lại ghi được như trước); up lại dựng lại và chặn lại", async () => {
    const count = async () =>
      (
        await sql<{ n: number }>`select count(*)::int as n from pg_policies
          where policyname in ('persons_role_insert','persons_role_update','payments_role_insert','payments_role_update',
                               'discrepancies_role_insert')`.execute(t.admin)
      ).rows[0]?.n;
    const fn = async () =>
      (
        await sql<{ n: number }>`select ((to_regprocedure('app.actor_may_insert_person()') is not null)::int
                + (to_regprocedure('app.actor_may_update_person()') is not null)::int) as n`.execute(t.admin)
      ).rows[0]?.n;
    let undone: string | undefined;
    for (let i = 0; i < 50 && undone !== NAME; i++) {
      const res = await createMigrator(t.admin).migrateDown();
      expect(res.error).toBeUndefined();
      undone = res.results?.[0]?.migrationName;
    }
    expect(undone).toBe(NAME);
    expect(await count()).toBe(0);
    expect(await fn()).toBe(0);
    const hk = member.housekeeping as { id: string };
    await as(hk.id, (trx) => insertPerson(trx));

    const up = await createMigrator(t.admin).migrateToLatest();
    expect(up.error).toBeUndefined();
    expect(up.results?.map((r) => r.migrationName)).toContain(NAME);
    expect(await count()).toBe(5);
    expect(await fn()).toBe(2);
    await expect(as(hk.id, (trx) => insertPerson(trx))).rejects.toThrow(RLS);
  });
});
