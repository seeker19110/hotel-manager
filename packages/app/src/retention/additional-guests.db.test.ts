// SPEC-lifecycle-race-hardening S-003: khách ở kèm và worker retention tranh khoá.
// SPEC-lifecycle-race-hardening S-004: down/up migration mới phục hồi đúng hàng rào.
// T-2404/D-134: người ở kèm dùng cùng giao thức khoá với FK tới persons để retention không làm mất hồ sơ khi nhận phòng.
import { randomUUID } from "node:crypto";
import { migrations, withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedOrg, seedReservation, type TestDb } from "@hm/testkit";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { recordIdentityDocument } from "../identity/identity.ts";
import { codeOf, okAs, ownerOf, runAs, seedMember } from "../testing/helpers.ts";

let t: TestDb;
let org: SeededOrg;
let other: SeededOrg;
const pii = createPiiCipher(devKeyring());
const DOC_NUMBER = "001234567890";

beforeAll(async () => {
  t = await createTestDb();
  org = await seedOrg(t.admin, "Nhà nghỉ Kiểm Khoá");
  other = await seedOrg(t.admin, "Nhà nghỉ Khác");
});
afterAll(async () => {
  await t?.drop();
});

async function oldPerson(): Promise<string> {
  const id = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, nationality, created_at, updated_at)
            values (${id}, ${org.orgId}, 'Khách giả', 'VN', now() - interval '150 months', now() - interval '150 months')`.execute(
    t.admin,
  );
  return id;
}

async function oldDocument(personId: string): Promise<string> {
  const owner = await ownerOf(t, org);
  const doc = await okAs(t, owner, (ctx) =>
    recordIdentityDocument(ctx, pii, {
      personId,
      propertyId: org.propertyId,
      docType: "cccd",
      docNumber: DOC_NUMBER,
    }),
  );
  await t.admin.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`update identity_documents set created_at = now() - interval '24 months', updated_at = now() - interval '24 months'
              where id = ${doc.identityDocumentId}`.execute(trx);
  });
  return doc.identityDocumentId;
}

async function freshItem(): Promise<string> {
  return (await seedReservation(t.admin, { org, bookerPersonId: org.ownerPersonId })).itemId;
}

function insertStay(db: Kysely<unknown>, itemId: string, additional: (string | null)[]) {
  return sql`insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status,
                               primary_guest_person_id, additional_guest_person_ids, checked_in_at)
             values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${itemId}, ${org.unitId}, 'in_house',
                     ${org.ownerPersonId}, ${additional}::uuid[], now())`.execute(db);
}

const docAnonymized = async (id: string) =>
  (
    await sql<{
      yes: boolean;
    }>`select anonymized_at is not null as yes from identity_documents where id = ${id}`.execute(t.admin)
  ).rows[0]?.yes;

describe("người ở kèm và retention — transaction nhận phòng thắng trước", () => {
  it("stay chưa commit giữ giấy tờ; commit xong quan hệ mở tiếp tục giữ giấy tờ", async () => {
    const person = await oldPerson();
    const doc = await oldDocument(person);
    const item = await freshItem();
    await t.runtime.connection().execute(async (conn) => {
      await sql`begin`.execute(conn);
      try {
        await sql`select set_config('app.org_id', ${org.orgId}, true), set_config('app.actor_id', ${org.ownerMembershipId}, true)`.execute(
          conn,
        );
        await insertStay(conn, item, [person]);
        await sql`select app.anonymize_identity_documents(now(), 12, 5000)`.execute(t.worker);
        expect(await docAnonymized(doc)).toBe(false);
        await sql`commit`.execute(conn);
      } finally {
        await sql`rollback`.execute(conn);
      }
    });
    await sql`select app.anonymize_identity_documents(now(), 12, 5000)`.execute(t.worker);
    expect(await docAnonymized(doc)).toBe(false);
  });

  it("người không giấy tờ cũng không bị ẩn danh trong khi array được ghi; rollback bỏ quan hệ thì lượt sau dọn được", async () => {
    const person = await oldPerson();
    const item = await freshItem();
    await t.runtime.connection().execute(async (conn) => {
      await sql`begin`.execute(conn);
      try {
        await sql`select set_config('app.org_id', ${org.orgId}, true), set_config('app.actor_id', ${org.ownerMembershipId}, true)`.execute(
          conn,
        );
        await insertStay(conn, item, [person]);
        await sql`select app.anonymize_persons(now(), 120, 5000)`.execute(t.worker);
        const state = await sql<{
          anon: boolean;
        }>`select anonymized_at is not null as anon from persons where id = ${person}`.execute(t.admin);
        expect(state.rows[0]?.anon).toBe(false);
      } finally {
        await sql`rollback`.execute(conn);
      }
    });
    await sql`select app.anonymize_persons(now(), 120, 5000)`.execute(t.worker);
    const state = await sql<{
      anon: boolean;
    }>`select anonymized_at is not null as anon from persons where id = ${person}`.execute(t.admin);
    expect(state.rows[0]?.anon).toBe(true);
  });

  it("UPDATE array của stay expected giữ cùng khoá như INSERT", async () => {
    const person = await oldPerson();
    const item = await freshItem();
    const stayId = randomUUID();
    await sql`insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, primary_guest_person_id)
              values (${stayId}, ${org.orgId}, ${org.propertyId}, ${item}, ${org.unitId}, ${org.ownerPersonId})`.execute(
      t.admin,
    );
    await withTenant(t.runtime, { orgId: org.orgId, actorId: org.ownerMembershipId }, async (trx) => {
      await sql`update stays set additional_guest_person_ids = array[${person}::uuid] where id = ${stayId}`.execute(
        trx,
      );
      await sql`select app.anonymize_persons(now(), 120, 5000)`.execute(t.worker);
      const state = await sql<{
        anon: boolean;
      }>`select anonymized_at is not null as anon from persons where id = ${person}`.execute(t.admin);
      expect(state.rows[0]?.anon).toBe(false);
    });
  });
});

describe("người ở kèm và retention — worker thắng trước", () => {
  it("đợi worker xong rồi ghi giấy tờ mới; không tái dùng hàng mà worker đang ẩn danh", async () => {
    const person = await oldPerson();
    const doc = await oldDocument(person);
    const owner = await ownerOf(t, org);
    const item = await freshItem();
    await t.worker.connection().execute(async (conn) => {
      await sql`begin`.execute(conn);
      let settled = false;
      let run: Promise<unknown> | undefined;
      try {
        const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(conn)).rows[0]?.pid;
        await sql`select app.anonymize_identity_documents(now(), 12, 5000)`.execute(conn);
        run = okAs(t, owner, async (ctx) => {
          const recorded = await recordIdentityDocument(ctx, pii, {
            personId: person,
            propertyId: org.propertyId,
            docType: "cccd",
            docNumber: DOC_NUMBER,
          });
          await insertStay(ctx.trx, item, [person]);
          return recorded;
        });
        // Gắn catch ngay: assertion đỏ vẫn phải giải phóng worker và đợi transaction nhận phòng kết thúc.
        void run.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        let blocked = false;
        for (let i = 0; i < 200; i++) {
          blocked =
            (
              await sql<{ yes: boolean }>`select exists (
            select 1 from pg_stat_activity where datname = current_database() and ${pid} = any(pg_blocking_pids(pid))
          ) as yes`.execute(t.admin)
            ).rows[0]?.yes === true;
          if (blocked || settled) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(settled).toBe(false);
        expect(blocked).toBe(true);
        await sql`commit`.execute(conn);
        const result = await run;
        expect(result).toMatchObject({ reused: false });
        expect(result).not.toMatchObject({ identityDocumentId: doc });
      } finally {
        await sql`rollback`.execute(conn);
        await run?.catch(() => undefined);
      }
    });
    expect(await docAnonymized(doc)).toBe(true);
    const active = await sql<{ n: number }>`select count(*)::int as n from identity_documents
      where person_id = ${person} and anonymized_at is null`.execute(t.admin);
    expect(active.rows[0]?.n).toBe(1);
  });
});

describe("array guests giữ ranh giới tenant và tombstone", () => {
  it("từ chối UUID không tồn tại, khác tổ chức và phần tử NULL; không để lại stay", async () => {
    for (const personId of [randomUUID(), other.ownerPersonId, null]) {
      const item = await freshItem();
      await expect(
        withTenant(t.runtime, { orgId: org.orgId, actorId: org.ownerMembershipId }, (trx) =>
          insertStay(trx, item, [personId]),
        ),
      ).rejects.toMatchObject({ code: "23503", constraint: "fk_stays_additional_guests" });
      const count = await sql<{
        n: number;
      }>`select count(*)::int as n from stays where reservation_item_id = ${item}`.execute(t.admin);
      expect(count.rows[0]?.n).toBe(0);
    }
  });

  it("tombstone không được gắn vào lượt ở mới hoặc ghi thêm giấy tờ", async () => {
    const person = await oldPerson();
    await sql`select app.anonymize_persons(now(), 120, 5000)`.execute(t.worker);
    const item = await freshItem();
    await expect(
      withTenant(t.runtime, { orgId: org.orgId, actorId: org.ownerMembershipId }, (trx) =>
        insertStay(trx, item, [person]),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "ck_stays_additional_guests_active" });
    const owner = await ownerOf(t, org);
    expect(
      await codeOf(
        runAs(t, owner, (ctx) =>
          recordIdentityDocument(ctx, pii, {
            personId: person,
            propertyId: org.propertyId,
            docType: "cccd",
            docNumber: DOC_NUMBER,
          }),
        ),
      ),
    ).toBe("NOT_FOUND");
  });

  it("array rỗng hợp lệ; trigger không nâng quyền tenant thành quyền ghi stay", async () => {
    const emptyItem = await freshItem();
    await withTenant(t.runtime, { orgId: org.orgId, actorId: org.ownerMembershipId }, (trx) =>
      insertStay(trx, emptyItem, []),
    );
    const tenant = await seedMember(t, org, "tenant");
    const item = await freshItem();
    await expect(
      withTenant(t.runtime, { orgId: org.orgId, actorId: tenant.membershipId }, (trx) =>
        insertStay(trx, item, []),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const functionState = await sql<{ definer: boolean; direct: boolean }>`select p.prosecdef as definer,
      has_function_privilege('app_runtime', p.oid, 'execute') as direct from pg_proc p
      where p.oid = 'app.lock_stay_additional_guests()'::regprocedure`.execute(t.admin);
    expect(functionState.rows[0]).toEqual({ definer: false, direct: false });
  });
});

describe("migration 0075 — down/up", () => {
  it("gỡ đúng trigger/hàm mới rồi áp lại; không chạm migration retention đã áp", async () => {
    const own = await createTestDb();
    try {
      const migration = migrations["0075_additional_guest_retention_lock"];
      if (!migration?.down) throw new Error("thiếu migration 0075 có down");
      const exists = async () =>
        (
          await sql<{ yes: boolean }>`select exists (
        select 1 from pg_trigger where tgname = 'trg_stays_additional_guests' and not tgisinternal
      ) and to_regprocedure('app.lock_stay_additional_guests()') is not null as yes`.execute(own.admin)
        ).rows[0]?.yes;
      expect(await exists()).toBe(true);
      await own.admin.transaction().execute((trx) => migration.down?.(trx) ?? Promise.resolve());
      expect(await exists()).toBe(false);
      await expect(
        sql`select app.anonymize_identity_documents(now(), 12, 10)`.execute(own.worker),
      ).resolves.toBeDefined();
      await own.admin.transaction().execute((trx) => migration.up(trx));
      expect(await exists()).toBe(true);
    } finally {
      await own.drop();
    }
  });
});
