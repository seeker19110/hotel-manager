// T-303 (DB-TX-003, ARC-INT-003; D-025) — quét + ghi object NGOÀI transaction lệnh, trên Postgres thật + kho object thật:
// (a) máy quét chậm không giữ session `idle in transaction` của runtime; (b) object mồ côi có dòng `pending_scan` và job hạn
// giữ xoá; (c) replay cùng Idempotency-Key không ghi/quét lần hai; (d) người khác không chốt được dòng staging của mình.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import type { HttpDeps } from "../http/command-route.ts";
import { runRetention } from "../import/retention.ts";
import { executeCommand } from "../pipeline/command.ts";
import { testServices } from "../server/services.ts";
import { probeIdleDuring } from "../testing/idle-probe.ts";
import { ScannerUnavailableError } from "./clamd.ts";
import { prepareUpload, uploadFile } from "./files.ts";
import { handleFileUpload } from "./http.ts";
import type { MalwareScanner } from "./inspect.ts";
import { finalizeStaged, stagedId } from "./staging.ts";
import { ObjectStorage } from "./storage.ts";

// JPEG tối thiểu hợp lệ (SOI, JFIF, SOS, EOI).
const JPEG = new Uint8Array([
  0xff,
  0xd8,
  0xff,
  0xe0,
  0,
  16,
  ...Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"),
  0xff,
  0xda,
  0,
  8,
  1,
  1,
  0,
  0,
  0x3f,
  0,
  0x12,
  0x34,
  0xff,
  0xd9,
]);

class CountingStorage extends ObjectStorage {
  puts = 0;
  override async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.puts += 1;
    return super.put(key, body, contentType);
  }
}

let t: TestDb;
let A: SeededOrg;
let storage: CountingStorage;
let hk: { actor: Actor; user: string };
let fd: { actor: Actor; user: string };

async function member(role: string): Promise<{ actor: Actor; user: string }> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, ${role})`.execute(
    t.admin,
  );
  const mid = randomUUID();
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${mid}, ${A.orgId}, ${user}, ${person}, ${role}, false)`.execute(t.admin);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${A.orgId}, ${mid}, ${A.propertyId})`.execute(t.admin);
  return {
    actor: await resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true }),
    user,
  };
}

const slowScanner = (ms: number, onScan?: () => void): MalwareScanner => ({
  async scan() {
    onScan?.();
    await new Promise((r) => setTimeout(r, ms));
    return { clean: true };
  },
});

/**
 * Máy quét chậm tự đo: trong suốt thời gian "quét" (đúng lúc hệ thống đang chờ I/O ngoài) lấy mẫu `idle in transaction` mỗi
 * 25 ms. Chỉ đo cửa sổ quét — các transaction ngắn hợp lệ trước/sau không bị tính.
 */
function measuringScanner(ms: number) {
  const m = { scans: 0, maxIdleInTx: 0 };
  const scanner: MalwareScanner = {
    async scan() {
      m.scans += 1;
      m.maxIdleInTx = Math.max(m.maxIdleInTx, await probeIdleDuring(t.admin, t.name, ms));
      return { clean: true };
    },
  };
  return { m, scanner };
}

const cmd = (actor: Actor, key: string, fn: Parameters<typeof executeCommand>[3]) =>
  executeCommand(
    t.runtime,
    actor,
    { command: "file.test", idempotencyKey: key, payload: { k: key }, correlationId: "c" },
    fn,
  );

const input = () => ({ ownerType: "work_order" as const, propertyId: A.propertyId, bytes: JPEG });

async function rowOf(fileId: string) {
  const r = await sql<{
    status: string;
    storage_key: string;
    delete_after: string | null;
    uploaded_by: string | null;
  }>`select status, storage_key, delete_after::text, uploaded_by from files where id = ${fileId}`.execute(
    t.admin,
  );
  return r.rows[0];
}

async function objectStatus(key: string): Promise<number> {
  return (await fetch(await storage.signedGetUrl(key))).status;
}

beforeAll(async () => {
  t = await createTestDb();
  storage = new CountingStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "KS staging");
  hk = await member("housekeeping");
  fd = await member("front_desk");
});

afterAll(async () => {
  await t?.drop();
});

describe("stagedId", () => {
  it("tất định, đúng dạng UUID v5, khác theo người/phạm vi/khoá; không phân biệt hoa thường của khoá", () => {
    const k = randomUUID();
    const a = stagedId(A.orgId, "m1", "s", k);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stagedId(A.orgId, "m1", "s", k)).toBe(a);
    expect(stagedId(A.orgId, "m1", "s", k.toUpperCase())).toBe(a);
    expect(stagedId(A.orgId, "m2", "s", k)).not.toBe(a);
    expect(stagedId(A.orgId, "m1", "s2", k)).not.toBe(a);
    expect(stagedId(A.orgId, "m1", "s", randomUUID())).not.toBe(a);
  });
});

describe("(a) máy quét chậm không giữ transaction", () => {
  it("đường staging: 0 session idle-in-transaction suốt lúc quét; đường cũ (đối chứng): có", async () => {
    const staged = measuringScanner(700);
    const sdeps = { storage, scanner: staged.scanner };
    const key = randomUUID();
    const prepared = await prepareUpload(t.runtime, sdeps, hk.actor, input(), key);
    const r = await cmd(hk.actor, key, async (ctx) => ({
      data: await uploadFile(ctx, sdeps, { ...input(), prepared }),
    }));
    expect(r.status).toBe("committed");
    expect(staged.m.scans).toBe(1);
    expect(staged.m.maxIdleInTx).toBe(0);

    // Đối chứng: cùng máy quét chậm nhưng quét TRONG transaction lệnh → phải thấy idle in transaction (chứng minh phép đo đúng).
    const legacy = measuringScanner(700);
    const ldeps = { storage, scanner: legacy.scanner };
    const r2 = await cmd(hk.actor, randomUUID(), async (ctx) => ({
      data: await uploadFile(ctx, ldeps, input()),
    }));
    expect(r2.status).toBe("committed");
    expect(legacy.m.maxIdleInTx).toBeGreaterThanOrEqual(1);
  });

  it("qua HTTP: tải ảnh với máy quét chậm không để lại session idle-in-transaction", async () => {
    const slow = measuringScanner(600);
    const deps: HttpDeps = {
      db: t.runtime,
      getSession: async (h) => {
        const id = h.get("x-test-user");
        return id ? { user: { id, twoFactorEnabled: true } } : null;
      },
      secureCookies: false,
      services: testServices({ storage, scanner: slow.scanner }),
    };
    const r = await handleFileUpload(
      new Request(`http://local.test/api/v1/files/upload?owner_type=work_order&property_id=${A.propertyId}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "idempotency-key": randomUUID(),
          "x-test-user": hk.user,
          "x-org-id": A.orgId,
        },
        body: Buffer.from(JPEG),
      }),
      deps,
    );
    expect(r.status).toBe(201);
    expect(slow.m.scans).toBe(1);
    expect(slow.m.maxIdleInTx).toBe(0);
  });
});

describe("(b) object mồ côi do lệnh lỗi", () => {
  it("lệnh lỗi sau khi ghi object → dòng pending_scan còn đó; runRetention sau hạn xoá object + đánh dấu deleted", async () => {
    const deps = { storage, scanner: slowScanner(0) };
    const key = randomUUID();
    const prepared = await prepareUpload(t.runtime, deps, hk.actor, input(), key);
    expect(await objectStatus(`${A.orgId}/work_order/${prepared.fileId}`)).toBe(200);

    await expect(
      cmd(hk.actor, key, async (ctx) => {
        await uploadFile(ctx, deps, { ...input(), prepared });
        throw new Error("lỗi bất ngờ sau khi chốt file"); // transaction rollback ⇒ dòng quay về pending_scan
      }),
    ).rejects.toThrow("lỗi bất ngờ");

    const row = await rowOf(prepared.fileId);
    expect(row?.status).toBe("pending_scan");
    expect(row?.delete_after).not.toBeNull(); // hạn staging — căn cứ để job dọn
    expect(row?.uploaded_by).toBe(hk.actor.membershipId);

    // Chưa tới hạn → chưa xoá.
    const early = await runRetention(t.worker, storage, { now: new Date() });
    expect(early.filesDeleted).toBe(0);
    expect(await objectStatus(row?.storage_key as string)).toBe(200);

    // Sau hạn staging (2 ngày) → xoá object, đánh dấu deleted.
    const late = await runRetention(t.worker, storage, { now: new Date(Date.now() + 5 * 86_400_000) });
    expect(late.filesDeleted).toBeGreaterThanOrEqual(1);
    expect(late.filesFailed).toBe(0);
    expect((await rowOf(prepared.fileId))?.status).toBe("deleted");
    expect(await objectStatus(row?.storage_key as string)).toBe(404);
  });

  it("file đã chốt ready (delete_after rỗng) không bị job hạn giữ đụng tới", async () => {
    const deps = { storage, scanner: slowScanner(0) };
    const key = randomUUID();
    const prepared = await prepareUpload(t.runtime, deps, hk.actor, input(), key);
    await cmd(hk.actor, key, async (ctx) => ({
      data: await uploadFile(ctx, deps, { ...input(), prepared }),
    }));
    const row = await rowOf(prepared.fileId);
    expect(row).toMatchObject({ status: "ready", delete_after: null });
    await runRetention(t.worker, storage, { now: new Date(Date.now() + 30 * 86_400_000) });
    expect((await rowOf(prepared.fileId))?.status).toBe("ready");
    expect(await objectStatus(row?.storage_key as string)).toBe(200);
  });

  it("máy quét báo nhiễm → không ghi object, dòng chốt rejected; máy quét không trả lời → 503, object không được ghi, thử lại được", async () => {
    const infected: MalwareScanner = { scan: async () => ({ clean: false, reason: "Test-Signature" }) };
    const before = storage.puts;
    const k1 = randomUUID();
    const p1 = await prepareUpload(t.runtime, { storage, scanner: infected }, hk.actor, input(), k1);
    expect(p1).toMatchObject({ status: "rejected", rejectReason: "Test-Signature" });
    expect(storage.puts).toBe(before);
    await cmd(hk.actor, k1, async (ctx) => ({
      data: await uploadFile(ctx, { storage, scanner: infected }, { ...input(), prepared: p1 }),
    }));
    expect((await rowOf(p1.fileId))?.status).toBe("rejected");

    const down: MalwareScanner = {
      scan: async () => Promise.reject(new ScannerUnavailableError("clamd không phản hồi")),
    };
    const k2 = randomUUID();
    await expect(
      prepareUpload(t.runtime, { storage, scanner: down }, hk.actor, input(), k2),
    ).rejects.toMatchObject({ status: 503 });
    expect(storage.puts).toBe(before);
    // Thử lại cùng key khi máy quét hồi phục → thành công, dùng lại đúng dòng staging.
    const p2 = await prepareUpload(t.runtime, { storage, scanner: slowScanner(0) }, hk.actor, input(), k2);
    expect(p2.status).toBe("ready");
    expect(storage.puts).toBe(before + 1);
  });
});

describe("(c) replay cùng Idempotency-Key", () => {
  it("prepare lặp: dòng chưa chốt → quét + ghi lại đúng object cũ; đã chốt → bỏ qua cả quét lẫn ghi", async () => {
    let scans = 0;
    const deps = { storage, scanner: slowScanner(0, () => void scans++) };
    const key = randomUUID();
    const puts0 = storage.puts;
    const p1 = await prepareUpload(t.runtime, deps, hk.actor, input(), key);
    const p2 = await prepareUpload(t.runtime, deps, hk.actor, input(), key); // lượt trước chưa chốt
    expect(p2.fileId).toBe(p1.fileId);
    expect(storage.puts).toBe(puts0 + 2);
    expect(scans).toBe(2);
    await cmd(hk.actor, key, async (ctx) => ({
      data: await uploadFile(ctx, deps, { ...input(), prepared: p2 }),
    }));
    const p3 = await prepareUpload(t.runtime, deps, hk.actor, input(), key); // đã ready
    expect(p3).toMatchObject({ fileId: p1.fileId, status: "ready" });
    expect(storage.puts).toBe(puts0 + 2);
    expect(scans).toBe(2);
    const n = await sql<{ n: number }>`select count(*)::int as n from files where id = ${p1.fileId}`.execute(
      t.admin,
    );
    expect(n.rows[0]?.n).toBe(1);
  });

  it("qua HTTP: gửi lại cùng key → cùng fileId, đúng một lần ghi object và một lần quét", async () => {
    let scans = 0;
    const deps: HttpDeps = {
      db: t.runtime,
      getSession: async (h) => {
        const id = h.get("x-test-user");
        return id ? { user: { id, twoFactorEnabled: true } } : null;
      },
      secureCookies: false,
      services: testServices({ storage, scanner: slowScanner(0, () => void scans++) }),
    };
    const key = randomUUID();
    const req = (body: Uint8Array = JPEG) =>
      new Request(`http://local.test/api/v1/files/upload?owner_type=work_order&property_id=${A.propertyId}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "idempotency-key": key,
          "x-test-user": hk.user,
          "x-org-id": A.orgId,
        },
        body: Buffer.from(body),
      });
    const puts0 = storage.puts;
    const r1 = await handleFileUpload(req(), deps);
    const r2 = await handleFileUpload(req(), deps);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: thân phản hồi kiểm bằng toBe
    const [d1, d2] = [(await r1.json()) as any, (await r2.json()) as any];
    expect(d2.data.fileId).toBe(d1.data.fileId);
    expect(storage.puts).toBe(puts0 + 1);
    expect(scans).toBe(1);
    // Cùng key, nội dung khác → 409.
    expect((await handleFileUpload(req(new Uint8Array([...JPEG, 0])), deps)).status).toBe(409);
  });
});

describe("(d) dòng staging chỉ của chính người tạo", () => {
  it("người khác (cùng tổ chức) không chuyển/sửa được dòng staging; không tạo được dòng staging mạo danh", async () => {
    const deps = { storage, scanner: slowScanner(0) };
    const prepared = await prepareUpload(t.runtime, deps, hk.actor, input(), randomUUID());
    const as = (a: Actor) => ({ orgId: A.orgId, actorId: a.membershipId });

    // Lễ tân (cùng cơ sở, thấy được dòng work_order) cố chuyển sang ready bằng SQL: RLS RESTRICTIVE chặn → 0 dòng.
    const hack = await withTenant(t.runtime, as(fd.actor), async (trx) => {
      const u =
        await sql`update files set status = 'ready', delete_after = null where id = ${prepared.fileId}`.execute(
          trx,
        );
      return Number(u.numAffectedRows ?? 0);
    });
    expect(hack).toBe(0);
    expect((await rowOf(prepared.fileId))?.status).toBe("pending_scan");

    // Qua hàm chốt của ứng dụng cũng bị từ chối (409), dòng không đổi.
    await expect(
      withTenant(t.runtime, as(fd.actor), (trx) =>
        finalizeStaged(trx, fd.actor, prepared.fileId, { status: "ready", deleteAfterDays: null }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await rowOf(prepared.fileId))?.status).toBe("pending_scan");

    // Không chèn được dòng staging đứng tên người khác.
    await expect(
      withTenant(t.runtime, as(fd.actor), (trx) =>
        sql`insert into files (id, organization_id, property_id, owner_type, mime, size_bytes, sha256, status, storage_key,
                               exif_stripped, uploaded_by, delete_after)
            values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, 'work_order', 'image/jpeg', 10, ${"a".repeat(64)},
                    'pending_scan', ${`${A.orgId}/work_order/${randomUUID()}`}, true, ${hk.actor.membershipId},
                    current_date + 2)`.execute(trx),
      ),
    ).rejects.toThrow(/row-level security/);

    // Chính người tạo chốt được.
    await withTenant(t.runtime, as(hk.actor), (trx) =>
      finalizeStaged(trx, hk.actor, prepared.fileId, { status: "ready", deleteAfterDays: null }),
    );
    expect((await rowOf(prepared.fileId))?.status).toBe("ready");
  });

  it("cùng Idempotency-Key nhưng người khác → id khác (không đụng dòng của nhau)", async () => {
    const deps = { storage, scanner: slowScanner(0) };
    const key = randomUUID();
    const a = await prepareUpload(t.runtime, deps, hk.actor, input(), key);
    const b = await prepareUpload(t.runtime, deps, fd.actor, input(), key);
    expect(b.fileId).not.toBe(a.fileId);
  });
});
