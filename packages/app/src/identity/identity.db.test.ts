// T-202 (D-004) — số giấy tờ mã hoá tầng app trên Postgres thật: CSDL không có số rõ ở bất kỳ cột nào, chỉ trả bản che,
// buồng phòng/khác tổ chức → 404, dùng lại hàng khi cùng số, xoay khoá đọc được bản cũ, ràng buộc CSDL chặn ghi lệch.
import { randomBytes, randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { createPiiCipher, devKeyring, parseKeyring } from "../crypto/pii.ts";
import { codeOf, okAs, ownerOf, runAs, seedMember } from "../testing/helpers.ts";
import {
  findIdentityByNumber,
  getIdentityDocument,
  recordIdentityDocument,
  reencryptIdentityDocuments,
  revealDocNumber,
} from "./identity.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let frontDesk: Actor;
let housekeeping: Actor;
let accountant: Actor;
let ownerB: Actor;
const pii = createPiiCipher(devKeyring());
const NUMBER = "001234567890";

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS giấy tờ A");
  B = await seedOrg(t.admin, "KS giấy tờ B");
  frontDesk = await seedMember(t, A, "front_desk");
  housekeeping = await seedMember(t, A, "housekeeping");
  accountant = await seedMember(t, A, "accountant", { properties: "all" });
  ownerB = await ownerOf(t, B);
});

afterAll(async () => {
  await t?.drop();
});

const record = (actor: Actor, docNumber = NUMBER, personId = A.ownerPersonId) =>
  okAs(t, actor, (ctx) =>
    recordIdentityDocument(ctx, pii, {
      personId,
      propertyId: A.propertyId,
      docType: "cccd",
      docNumber,
    }),
  );

describe("không có số rõ trong CSDL (D-004)", () => {
  it("mọi cột của hàng, audit và kết quả command lưu lại không chứa số; chỉ 4 số cuối", async () => {
    const r = await record(frontDesk, "001 234 567 890");
    expect(r.docNumberMasked).toBe("****7890");
    const dump = await sql<{ j: string }>`
      select row_to_json(d)::text as j from identity_documents d where id = ${r.identityDocumentId}`.execute(
      t.admin,
    );
    expect(dump.rows[0]?.j).not.toContain(NUMBER);
    const raw = await sql<{ enc: Buffer; last4: string; key_id: number }>`
      select doc_number_enc as enc, doc_number_last4 as last4, doc_number_key_id as key_id
      from identity_documents where id = ${r.identityDocumentId}`.execute(t.admin);
    expect(raw.rows[0]?.enc.toString("latin1")).not.toContain(NUMBER);
    expect(raw.rows[0]?.last4).toBe("7890");
    expect(raw.rows[0]?.key_id).toBe(1);
    const leaks = await sql<{ n: number }>`
      select (select count(*) from audit_events where after::text like ${`%${NUMBER}%`} or before::text like ${`%${NUMBER}%`})
           + (select count(*) from idempotency_keys where response::text like ${`%${NUMBER}%`})
           + (select count(*) from outbox where payload::text like ${`%${NUMBER}%`}) as n`.execute(t.admin);
    expect(Number(leaks.rows[0]?.n)).toBe(0);
  });

  it("giải mã trong tiến trình cho nghĩa vụ pháp lý; tìm theo số qua blind index", async () => {
    const r = await record(frontDesk, "079 999 000 111");
    const plain = await withTenant(
      t.runtime,
      { orgId: A.orgId, actorId: frontDesk.membershipId },
      async (trx) => ({
        number: await revealDocNumber(trx, pii, A.orgId, r.identityDocumentId),
        found: await findIdentityByNumber(trx, pii, A.orgId, "cccd", "079999000111"),
        foundOtherOrg: await findIdentityByNumber(trx, pii, B.orgId, "cccd", "079999000111"),
      }),
    );
    expect(plain.number).toBe("079999000111");
    expect(plain.found).toContain(r.identityDocumentId);
    expect(plain.foundOtherOrg).toEqual([]);
  });

  it("cùng người + cùng số → dùng lại hàng, không nhân bản dữ liệu nhạy cảm", async () => {
    const a = await record(frontDesk, "012 000 000 999");
    const b = await record(frontDesk, "012000000999");
    expect(b.identityDocumentId).toBe(a.identityDocumentId);
    expect(b.reused).toBe(true);
  });

  it("số không hợp lệ → 422 VALIDATION_FAILED, không ghi gì", async () => {
    expect(
      await codeOf(
        runAs(t, frontDesk, (ctx) =>
          recordIdentityDocument(ctx, pii, {
            personId: A.ownerPersonId,
            propertyId: A.propertyId,
            docType: "cccd",
            docNumber: "12",
          }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

describe("đọc chỉ bản che, theo quyền (SPEC-housekeeping S-020, INV-G1)", () => {
  it("lễ tân đọc bản che; buồng phòng, kế toán, tổ chức khác → 404", async () => {
    const r = await record(frontDesk, "034 111 222 333");
    const v = await getIdentityDocument(t.runtime, frontDesk, r.identityDocumentId);
    expect(v).toMatchObject({ docType: "cccd", docNumberMasked: "****2333", anonymized: false });
    expect(JSON.stringify(v)).not.toContain("034111222333");
    for (const actor of [housekeeping, accountant, ownerB]) {
      await expect(getIdentityDocument(t.runtime, actor, r.identityDocumentId)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
  });

  it("buồng phòng ghi giấy tờ → 404 (không lộ chức năng), không ghi hàng", async () => {
    expect(
      await codeOf(
        runAs(t, housekeeping, (ctx) =>
          recordIdentityDocument(ctx, pii, {
            personId: A.ownerPersonId,
            propertyId: A.propertyId,
            docType: "cccd",
            docNumber: "001999888777",
          }),
        ),
      ),
    ).toBe("NOT_FOUND");
  });
});

describe("xoay khoá và hàng rào CSDL", () => {
  it("keyring mới đọc bản cũ; mã hoá lại chuyển sang khoá mới, vẫn giải mã đúng", async () => {
    const r = await record(frontDesk, "045 678 901 234");
    const dev = devKeyring();
    const k2 = randomBytes(32).toString("base64");
    const keys = `1:${(dev.keys.get(1) as Buffer).toString("base64")},2:${k2}`;
    const rotated = createPiiCipher(parseKeyring(keys, 2, dev.indexKey.toString("base64")));
    const n = await t.admin
      .transaction()
      .execute((trx) => reencryptIdentityDocuments(trx, rotated, A.orgId, 2));
    expect(n).toBeGreaterThan(0);
    const row = await sql<{ key_id: number }>`
      select doc_number_key_id as key_id from identity_documents where id = ${r.identityDocumentId}`.execute(
      t.admin,
    );
    expect(row.rows[0]?.key_id).toBe(2);
    const plain = await t.admin
      .transaction()
      .execute((trx) => revealDocNumber(trx, rotated, A.orgId, r.identityDocumentId));
    expect(plain).toBe("045678901234");
    // Chạy lại: không còn hàng khoá cũ → 0 (idempotent).
    expect(
      await t.admin.transaction().execute((trx) => reencryptIdentityDocuments(trx, rotated, A.orgId, 2)),
    ).toBe(0);
  });

  it("CSDL chặn: thiếu băm/4 số cuối, byte khoá lệch cột key_id", async () => {
    const enc = Buffer.concat([Buffer.from([1]), randomBytes(40)]);
    const base = (cols: { keyId: number; hash: Buffer | null; last4: string | null }) =>
      sql`insert into identity_documents (id, organization_id, property_id, person_id, doc_type, doc_number_enc,
                                          doc_number_key_id, doc_number_hash, doc_number_last4)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${A.ownerPersonId}, 'cccd', ${enc}, ${cols.keyId},
                  ${cols.hash}, ${cols.last4})`.execute(t.admin);
    await expect(base({ keyId: 1, hash: null, last4: "1234" })).rejects.toThrow(
      /ck_identity_documents_number/,
    );
    await expect(base({ keyId: 1, hash: randomBytes(32), last4: null })).rejects.toThrow(
      /ck_identity_documents_number/,
    );
    await expect(base({ keyId: 2, hash: randomBytes(32), last4: "1234" })).rejects.toThrow(
      /ck_identity_documents_key_byte/,
    );
  });

  it("không còn cột số rõ trong bảng", async () => {
    const cols = await sql<{ c: string }>`
      select column_name as c from information_schema.columns where table_name = 'identity_documents'`.execute(
      t.admin,
    );
    const names = cols.rows.map((r) => r.c);
    expect(names).not.toContain("doc_number");
    expect(names).not.toContain("doc_number_masked");
    expect(names).toEqual(expect.arrayContaining(["doc_number_enc", "doc_number_hash", "doc_number_last4"]));
  });
});
