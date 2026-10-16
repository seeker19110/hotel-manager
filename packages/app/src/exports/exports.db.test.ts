// PLAN đợt 3 T-222 — xuất dữ liệu trên Postgres thật + SeaweedFS (SPEC-audit-reporting S-013…S-018).
import { randomUUID } from "node:crypto";
import { seedIssuedInvoice, testS3Config } from "@hm/testkit";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { ObjectStorage } from "../files/storage.ts";
import { codeOf, okAs, runAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import {
  downloadExport,
  EXPORT_RATE_PER_HOUR,
  EXPORT_TTL_MINUTES,
  expireExports,
  getExportStatus,
  ORG_EXPORT_EXCLUDED_COLUMN,
  requestExport,
  requestOrgExport,
  runExportJob,
  safeText,
  toCsv,
} from "./exports.ts";

let h: Hotel;
let storage: ObjectStorage;
let hs2: string;
let payer: string;
const TODAY = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const fresh = (a: Actor): Actor => ({ ...a, authenticatedAt: new Date() });
const deps = () => ({ db: h.t.runtime, workerDb: h.t.worker, storage });
const job = (exportId: string) => ({ organization_id: h.org.orgId, payload: { export_id: exportId } });
const text = async (url: string) => {
  const r = await fetch(url);
  expect(r.status).toBe(200);
  return new Uint8Array(await r.arrayBuffer());
};
const decode = (b: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(b);

beforeAll(async () => {
  h = await seedHotel();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  hs2 = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${hs2}, ${h.org.orgId}, 'HS2', 'hotel')`.execute(
    h.t.admin,
  );
  // Người trả có tên dạng công thức (S-016); phiếu 1.580.000 ở HS1 và 700.000 ở HS2.
  payer = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${payer}, ${h.org.orgId}, ${'=HYPERLINK("http://x","bấm")'})`.execute(
    h.t.admin,
  );
  for (const [propertyId, amount] of [
    [h.org.propertyId, 1_580_000],
    [hs2, 700_000],
  ] as const)
    await seedIssuedInvoice(h.t.admin, {
      orgId: h.org.orgId,
      propertyId,
      payerPersonId: payer,
      lines: [{ amount }],
    });
  // Dữ liệu của tổ chức khác (không được lọt vào xuất toàn tổ chức).
  await sql`insert into persons (id, organization_id, full_name) values (${randomUUID()}, ${h.other.orgId}, 'Người của tổ chức khác ZQX')`.execute(
    h.t.admin,
  );
});

afterAll(async () => {
  await h?.t.drop();
});

describe("S-016 chống formula injection (thuần)", () => {
  it("ô chữ bắt đầu = + - @ tab CR → thêm '; số và chuỗi số thuần giữ nguyên", () => {
    for (const s of ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tx", "\rx"]) expect(safeText(s)).toBe(`'${s}`);
    expect(safeText("-1580000")).toBe("-1580000");
    expect(safeText("Nhà trọ")).toBe("Nhà trọ");
    const csv = decode(
      toCsv([
        ["Tên", "Số tiền"],
        ['=HYPERLINK("http://x","bấm")', 1_580_000],
        ["a,b", -5],
      ]),
    );
    expect(csv).toBe(`﻿Tên,Số tiền\r\n"'=HYPERLINK(""http://x"",""bấm"")",1580000\r\n"a,b",-5\r\n`);
  });
});

describe("S-013/S-014 quyền + xác thực lại", () => {
  it("manager → 403; kế toán xuất nhóm không phải tiền → 403; owner chưa xác thực lại gần đây → 401 REAUTH_REQUIRED, không tạo job", async () => {
    const req = { kind: "receivables" as const, format: "csv" as const };
    expect(await codeOf(runAs(h.t, fresh(h.manager), (ctx) => requestExport(ctx, req)))).toBe("FORBIDDEN");
    expect(
      await codeOf(
        runAs(h.t, fresh(h.accountant), (ctx) =>
          requestExport(ctx, { kind: "occupancy", format: "csv", filters: { from: TODAY, to: TODAY } }),
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(await codeOf(runAs(h.t, h.owner, (ctx) => requestExport(ctx, req)))).toBe("REAUTH_REQUIRED");
    const old = { ...h.owner, authenticatedAt: new Date(Date.now() - 6 * 60_000) };
    const r = await runAs(h.t, old, (ctx) => requestExport(ctx, req));
    expect(r).toMatchObject({ status: "failed", problem: { code: "REAUTH_REQUIRED", status: 401 } });
    expect(await codeOf(runAs(h.t, h.owner, (ctx) => requestOrgExport(ctx)))).toBe("REAUTH_REQUIRED");
    expect(await codeOf(runAs(h.t, fresh(h.accountant), (ctx) => requestOrgExport(ctx)))).toBe("FORBIDDEN");
    const n = await sql<{ n: number }>`select count(*)::int as n from export_jobs`.execute(h.t.admin);
    expect(n.rows[0]?.n).toBe(0);
  });
});

describe("S-015 job, file riêng tư, link có hạn, audit", () => {
  it("owner xác thực lại → queued + outbox; worker → ready, thông báo export_ready; chỉ người yêu cầu tải; sau hạn → 410", async () => {
    const owner = fresh(h.owner);
    const q = await okAs(h.t, owner, (ctx) => requestExport(ctx, { kind: "receivables", format: "csv" }));
    expect(q.status).toBe("queued");
    const ob = await sql<{ n: number }>`
      select count(*)::int as n from outbox where event_type = 'export.requested' and aggregate_id = ${q.exportId}`.execute(
      h.t.admin,
    );
    expect(ob.rows[0]?.n).toBe(1);
    // Chưa chạy → tải 409 EXPORT_NOT_READY.
    expect(
      await codeOf(runAs(h.t, owner, (ctx) => downloadExport(ctx, deps(), { exportId: q.exportId }))),
    ).toBe("EXPORT_NOT_READY");
    const now = new Date();
    expect(await runExportJob(deps(), job(q.exportId), now)).toBe("ready");
    // Giao lại (pg-boss) không chạy lần hai.
    expect(await runExportJob(deps(), job(q.exportId), now)).toBe("skipped");
    const st = await getExportStatus(h.t.runtime, owner, q.exportId);
    expect(st).toMatchObject({ status: "ready", rowCount: 2 });
    expect(st.expiresAt?.getTime()).toBe(now.getTime() + EXPORT_TTL_MINUTES * 60_000);
    const d = await okAs(h.t, owner, (ctx) => downloadExport(ctx, deps(), { exportId: q.exportId, now }));
    expect(d.expiresIn).toBeLessThanOrEqual(300);
    const csv = decode(await text(d.url));
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""bấm"")"`);
    expect(csv).toContain(",1580000,");
    // Người khác (kể cả owner khác cùng tổ chức) → 404; kế toán không thấy job của owner.
    const owner2 = fresh(await seedMember(h.t, h.org, "owner", { properties: "all" }));
    expect(
      await codeOf(runAs(h.t, owner2, (ctx) => downloadExport(ctx, deps(), { exportId: q.exportId }))),
    ).toBe("NOT_FOUND");
    await expect(getExportStatus(h.t.runtime, h.accountant, q.exportId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Sau hạn → 410; job chuyển expired.
    const late = new Date(now.getTime() + EXPORT_TTL_MINUTES * 60_000 + 1);
    expect(
      await codeOf(
        runAs(h.t, owner, (ctx) => downloadExport(ctx, deps(), { exportId: q.exportId, now: late })),
      ),
    ).toBe("LINK_EXPIRED");
    expect(await expireExports(h.t.worker, late)).toBeGreaterThanOrEqual(1);
    expect((await getExportStatus(h.t.runtime, owner, q.exportId)).status).toBe("expired");
    const a = await sql<{ action: string }>`
      select action from audit_events where entity_id = ${q.exportId} order by occurred_at, action`.execute(
      h.t.admin,
    );
    expect(a.rows.map((x) => x.action).sort()).toEqual([
      "export.completed",
      "export.downloaded",
      "export.requested",
    ]);
    const n = await sql<{ n: number }>`
      select count(*)::int as n from notifications where dedupe_key = ${`export_ready:${q.exportId}`}
        and recipient_person_id = ${owner.personId}`.execute(h.t.admin);
    expect(n.rows[0]?.n).toBe(1);
    // File riêng tư: chỉ người yêu cầu thấy hàng files (RLS).
    const { withTenant } = await import("@hm/db");
    const seen = await withTenant(
      h.t.runtime,
      { orgId: h.org.orgId, actorId: h.manager.membershipId },
      (trx) =>
        sql<{ n: number }>`select count(*)::int as n from files where owner_type = 'export_job'`.execute(trx),
    );
    expect(seen.rows[0]?.n).toBe(0);
  });

  it("XLSX: ô công thức ghi kiểu chuỗi (inlineStr), không có <f>; số tiền là số", async () => {
    const owner = fresh(h.owner);
    const q = await okAs(h.t, owner, (ctx) => requestExport(ctx, { kind: "receivables", format: "xlsx" }));
    expect(await runExportJob(deps(), job(q.exportId))).toBe("ready");
    const d = await okAs(h.t, owner, (ctx) => downloadExport(ctx, deps(), { exportId: q.exportId }));
    const raw = Buffer.from(await text(d.url)).toString("latin1");
    expect(raw).not.toMatch(/<f[ >]/);
    expect(raw).toContain('t="inlineStr"');
    expect(raw).toMatch(/<v>1580000<\/v>/);
  });
});

describe("S-017 không vượt phạm vi; thu hồi quyền trước khi chạy", () => {
  it("kế toán chỉ HS1: file chỉ có HS1; lọc HS2 → 404 không tạo job; bị đình chỉ trước khi job chạy → failed FORBIDDEN", async () => {
    const acc = fresh(await seedMember(h.t, h.org, "accountant", { properties: [h.org.propertyId] }));
    const q = await okAs(h.t, acc, (ctx) => requestExport(ctx, { kind: "receivables", format: "csv" }));
    expect(await runExportJob(deps(), job(q.exportId))).toBe("ready");
    const d = await okAs(h.t, acc, (ctx) => downloadExport(ctx, deps(), { exportId: q.exportId }));
    const csv = decode(await text(d.url));
    expect(csv).toContain(",1580000,");
    expect(csv).not.toContain("700000");
    const before = await sql<{ n: number }>`select count(*)::int as n from export_jobs`.execute(h.t.admin);
    expect(
      await codeOf(
        runAs(h.t, acc, (ctx) => requestExport(ctx, { kind: "receivables", format: "csv", propertyId: hs2 })),
      ),
    ).toBe("NOT_FOUND");
    const after = await sql<{ n: number }>`select count(*)::int as n from export_jobs`.execute(h.t.admin);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

    const q2 = await okAs(h.t, acc, (ctx) => requestExport(ctx, { kind: "deposits", format: "csv" }));
    await sql`update memberships set status = 'suspended' where id = ${acc.membershipId}`.execute(h.t.admin);
    expect(await runExportJob(deps(), job(q2.exportId))).toBe("failed");
    const j = await sql<{ status: string; failed_reason: string; file_key: string | null }>`
      select status, failed_reason, file_key from export_jobs where id = ${q2.exportId}`.execute(h.t.admin);
    expect(j.rows[0]).toMatchObject({ status: "failed", failed_reason: "FORBIDDEN", file_key: null });
  });

  it("app_runtime không đổi được trạng thái job (chỉ worker); worker không chuyển ngược trạng thái", async () => {
    const owner = fresh(h.owner);
    const q = await okAs(h.t, owner, (ctx) => requestExport(ctx, { kind: "deposits", format: "csv" }));
    const { withTenant } = await import("@hm/db");
    await expect(
      withTenant(h.t.runtime, { orgId: h.org.orgId, actorId: owner.membershipId }, (trx) =>
        sql`update export_jobs set status = 'ready' where id = ${q.exportId}`.execute(trx),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(h.t.worker, { orgId: h.org.orgId }, (trx) =>
        sql`update export_jobs set status = 'expired' where id = ${q.exportId}`.execute(trx),
      ),
    ).rejects.toThrow(/không chuyển/);
  });
});

describe("S-018 xuất toàn bộ tổ chức", () => {
  it("ZIP CSV các bảng nghiệp vụ của đúng tổ chức; không ảnh/file/số giấy tờ/cột bí mật", async () => {
    const owner = fresh(h.owner);
    const q = await okAs(h.t, owner, (ctx) => requestOrgExport(ctx));
    expect(await runExportJob(deps(), job(q.exportId))).toBe("ready");
    const d = await okAs(h.t, owner, (ctx) => downloadExport(ctx, deps(), { exportId: q.exportId }));
    const zip = Buffer.from(await text(d.url));
    expect(zip.subarray(0, 2).toString("latin1")).toBe("PK");
    const raw = zip.toString("utf8");
    for (const f of ["persons.csv", "invoices.csv", "journal_lines.csv", "README.txt"])
      expect(raw).toContain(f);
    for (const f of ["identity_documents.csv", "files.csv", "memberships.csv"]) expect(raw).not.toContain(f);
    expect(raw).not.toContain("Người của tổ chức khác ZQX");
    expect(raw).toContain("KS Mai");
    expect(raw).not.toMatch(/storage_key|token_hash|blind_index/);
    expect(ORG_EXPORT_EXCLUDED_COLUMN.test("doc_number")).toBe(true);
  });
});

describe("Giới hạn tần suất", () => {
  it(`quá ${EXPORT_RATE_PER_HOUR} yêu cầu/giờ/người → 429 RATE_LIMITED`, async () => {
    const o = fresh(await seedMember(h.t, h.org, "owner", { properties: "all" }));
    for (let i = 0; i < EXPORT_RATE_PER_HOUR; i++)
      await okAs(h.t, o, (ctx) => requestExport(ctx, { kind: "deposits", format: "csv" }));
    expect(
      await codeOf(runAs(h.t, o, (ctx) => requestExport(ctx, { kind: "deposits", format: "csv" }))),
    ).toBe("RATE_LIMITED");
  });
});

describe("Review lát 5 — job xuất bền vững", () => {
  it("kho object lỗi giữa chừng → job thành failed INTERNAL (không kẹt running), lượt giao lại bỏ qua", async () => {
    const owner = fresh(h.owner);
    const q = await okAs(h.t, owner, (ctx) => requestExport(ctx, { kind: "deposits", format: "csv" }));
    const broken = {
      ...deps(),
      storage: { put: async () => Promise.reject(new Error("S3 503")) } as unknown as ObjectStorage,
    };
    await expect(runExportJob(broken, job(q.exportId))).rejects.toThrow("S3 503");
    const st = await getExportStatus(h.t.runtime, owner, q.exportId);
    expect(st).toMatchObject({ status: "failed", failedReason: "INTERNAL" });
    expect(await runExportJob(deps(), job(q.exportId))).toBe("skipped");
  });

  it("lượt chạy lại (job `running` bị bỏ dở > 10 phút) khi dữ liệu đã đổi → vẫn ready với dữ liệu mới, không 409 (review lát 7 🟡5)", async () => {
    const acc = fresh(await seedMember(h.t, h.org, "accountant", { properties: [h.org.propertyId] }));
    const q = await okAs(h.t, acc, (ctx) => requestExport(ctx, { kind: "receivables", format: "csv" }));
    // Lượt 1 "sập tiến trình" sau khi file đã ghi + chốt nhưng trước khi chuyển job sang ready: workerDb từ lần mở giao dịch
    // thứ hai trở đi ném lỗi (cả lần ghi `failed` cũng hỏng) ⇒ job kẹt `running`.
    let opened = 0;
    const crashing = new Proxy(h.t.worker, {
      get(target, prop) {
        if (prop === "transaction")
          return (...a: []) => {
            opened += 1;
            if (opened > 1) throw new Error("sập tiến trình giả lập");
            return target.transaction(...a);
          };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Kysely<unknown>;
    await expect(runExportJob({ ...deps(), workerDb: crashing }, job(q.exportId))).rejects.toThrow(
      "sập tiến trình",
    );
    const st1 = await sql<{
      status: string;
    }>`select status from export_jobs where id = ${q.exportId}`.execute(h.t.admin);
    expect(st1.rows[0]?.status).toBe("running");

    // Dữ liệu đổi giữa hai lượt ⇒ nội dung file khác (sha256 khác).
    await seedIssuedInvoice(h.t.admin, {
      orgId: h.org.orgId,
      propertyId: h.org.propertyId,
      payerPersonId: payer,
      lines: [{ amount: 987_654 }],
    });
    const later = new Date(Date.now() + 11 * 60_000);
    expect(await runExportJob(deps(), job(q.exportId), later)).toBe("ready");
    const d = await okAs(h.t, acc, (ctx) => downloadExport(ctx, deps(), { exportId: q.exportId }));
    expect(decode(await text(d.url))).toContain(",987654,");
  });

  it("xuất toàn tổ chức khi tiến trình chạy giờ Việt Nam: cột date giữ đúng ngày (không lùi một ngày)", async () => {
    await h.t.admin.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`update invoices set due_on = '2031-02-03' where organization_id = ${h.org.orgId} and property_id = ${hs2}`.execute(
        trx,
      );
    });
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Ho_Chi_Minh";
    try {
      const owner = fresh(h.owner);
      const q = await okAs(h.t, owner, (ctx) => requestOrgExport(ctx));
      expect(await runExportJob(deps(), job(q.exportId))).toBe("ready");
      const d = await okAs(h.t, owner, (ctx) => downloadExport(ctx, deps(), { exportId: q.exportId }));
      const raw = Buffer.from(await text(d.url)).toString("utf8");
      expect(raw).toContain(",2031-02-03,");
      expect(raw).not.toContain("2031-02-02T17:00:00.000Z");
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});
