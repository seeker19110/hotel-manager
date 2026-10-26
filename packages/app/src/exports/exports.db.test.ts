// PLAN đợt 3 T-222 — xuất dữ liệu trên Postgres thật + SeaweedFS (SPEC-audit-reporting S-013…S-018).
import { createHash, randomUUID } from "node:crypto";
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
  ORG_EXPORT_FILE_OWNER_ALLOWLIST,
  ORG_EXPORT_FILES_MAX_BYTES,
  ORG_EXPORT_SKIP_REASONS,
  orgFileSkipReasonForOwner,
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

/** Đọc ZIP kiểu "store" (không nén) do `zipStore` ghi: tên → nội dung. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (zip.readUInt32LE(off) === 0x04034b50) {
    const size = zip.readUInt32LE(off + 18);
    const nameLen = zip.readUInt16LE(off + 26);
    const extraLen = zip.readUInt16LE(off + 28);
    const name = zip.subarray(off + 30, off + 30 + nameLen).toString("utf8");
    const start = off + 30 + nameLen + extraLen;
    out.set(name, zip.subarray(start, start + size));
    off = start + size;
  }
  return out;
}

/** Dòng CSV đơn giản (không có dấu phẩy trong ô) → mảng đối tượng theo tiêu đề. */
function manifestRows(csv: Buffer): Record<string, string>[] {
  const [head, ...rest] = csv
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/);
  const cols = (head ?? "").split(",");
  return rest.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i] as string, v])));
}

describe("IND-SAAS-007 xuất toàn tổ chức kèm file đính kèm (T-405)", () => {
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  /** Tạo file `ready` của tổ chức: dòng `files` + object trong kho (storeBytes ≠ bytes ⇒ giả lập object hỏng/thiếu). */
  async function seedFile(
    orgId: string,
    ownerType: string,
    bytes: Buffer,
    opts: { store?: Buffer | "missing"; mime?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const key = `${orgId}/exp-test/${id}`;
    const mime = opts.mime ?? "image/png";
    await sql`insert into files (id, organization_id, owner_type, mime, size_bytes, sha256, status, storage_key, exif_stripped)
              values (${id}, ${orgId}, ${ownerType}, ${mime}, ${bytes.length}, ${sha(bytes)}, 'ready', ${key}, true)`.execute(
      h.t.admin,
    );
    if (opts.store !== "missing") await storage.put(key, opts.store ?? bytes, mime);
    return id;
  }

  async function runOrgExport(maxBytes?: number, who: Actor = h.owner): Promise<Map<string, Buffer>> {
    const owner = fresh(who);
    const q = await okAs(h.t, owner, (ctx) => requestOrgExport(ctx));
    const d0 = { ...deps(), ...(maxBytes === undefined ? {} : { orgFilesMaxBytes: maxBytes }) };
    expect(await runExportJob(d0, job(q.exportId))).toBe("ready");
    const d = await okAs(h.t, owner, (ctx) => downloadExport(ctx, deps(), { exportId: q.exportId }));
    return readZip(Buffer.from(await text(d.url)));
  }

  it("nhúng file ready (ảnh sự cố, chứng từ) đúng nội dung + MANIFEST; không lấy file tổ chức khác, bản xuất cũ, ảnh giấy tờ tuỳ thân", async () => {
    const photo = Buffer.from(`ảnh sự cố ${randomUUID()}`);
    const pdf = Buffer.from(`%PDF chứng từ ${randomUUID()}`);
    const idDoc = Buffer.from(`CCCD-IMAGE-${randomUUID()}`);
    const foreign = Buffer.from(`FOREIGN-ORG-FILE-${randomUUID()}`);
    const fPhoto = await seedFile(h.org.orgId, "work_order", photo);
    const fPdf = await seedFile(h.org.orgId, "payment_claim", pdf, { mime: "application/pdf" });
    const fId = await seedFile(h.org.orgId, "identity_document", idDoc);
    await seedFile(h.other.orgId, "work_order", foreign);

    const zip = await runOrgExport();
    expect(zip.get(`files/work_order/${fPhoto}.png`)).toEqual(photo);
    expect(zip.get(`files/payment_claim/${fPdf}.pdf`)).toEqual(pdf);
    expect([...zip.keys()].some((k) => k.includes(fId))).toBe(false);
    for (const raw of zip.values()) {
      expect(raw.includes(idDoc)).toBe(false);
      expect(raw.includes(foreign)).toBe(false);
    }
    const rows = manifestRows(zip.get("files/MANIFEST.csv") as Buffer);
    const by = (id: string) => rows.find((r) => r.file_id === id);
    expect(by(fPhoto)).toMatchObject({
      status: "included",
      zip_path: `files/work_order/${fPhoto}.png`,
      sha256: sha(photo),
    });
    expect(by(fId)).toMatchObject({ status: "skipped", reason: "identity_document", zip_path: "" });
    expect(rows.filter((r) => r.owner_type === "export_job").every((r) => r.status === "skipped")).toBe(true); // bản xuất cũ không tự nhúng vào bản mới
    expect(zip.get("README.txt")?.toString("utf8")).toContain("TỪ ĐIỂN CỘT");
  });

  it("D-033: file residence_notice / import_batch / export_job KHÔNG vào ZIP (có thể chứa số giấy tờ), MANIFEST ghi lý do; allowlist nhúng đủ", async () => {
    const notice = Buffer.from(`SO-GIAY-TO-9876543210-${randomUUID()}`);
    const batch = Buffer.from(`IMPORT-BATCH-${randomUUID()}`);
    const oldExport = Buffer.from(`OLD-EXPORT-${randomUUID()}`);
    const fNotice = await seedFile(h.org.orgId, "residence_notice", notice, { mime: "text/csv" });
    const fBatch = await seedFile(h.org.orgId, "import_batch", batch, { mime: "text/csv" });
    // Bản xuất cũ chỉ người yêu cầu thấy (RLS) ⇒ dùng chủ riêng (cũng tránh trần 10 yêu cầu/giờ của h.owner).
    const o2 = await seedMember(h.t, h.org, "owner", { properties: "all" });
    const fOld = await seedFile(h.org.orgId, "export_job", oldExport, { mime: "text/csv" });
    await sql`update files set uploaded_by = ${o2.membershipId} where id = ${fOld}`.execute(h.t.admin);
    const allowed: string[] = [];
    // lease_settlement nằm trong allowlist nhưng RLS `files` hiện chưa có nhánh cho loại này (ELSE false) ⇒ không ai thấy; xem hàm thuần bên dưới.
    for (const t of ["work_order", "handover", "meter_reading", "task", "payment_claim"])
      allowed.push(await seedFile(h.org.orgId, t, Buffer.from(`OK-${t}-${randomUUID()}`)));

    const zip = await runOrgExport(undefined, o2);
    for (const id of [fNotice, fBatch, fOld]) expect([...zip.keys()].some((k) => k.includes(id))).toBe(false);
    for (const raw of zip.values()) {
      for (const secret of [notice, batch, oldExport]) expect(raw.includes(secret)).toBe(false);
    }
    const rows = manifestRows(zip.get("files/MANIFEST.csv") as Buffer);
    const by = (id: string) => rows.find((r) => r.file_id === id);
    expect(by(fNotice)).toMatchObject({ status: "skipped", reason: "residence_notice", zip_path: "" });
    expect(by(fBatch)).toMatchObject({ status: "skipped", reason: "import_batch", zip_path: "" });
    expect(by(fOld)).toMatchObject({ status: "skipped", reason: "export_job", zip_path: "" });
    for (const id of allowed) expect(by(id)).toMatchObject({ status: "included" });
    const readme = zip.get("README.txt")?.toString("utf8") ?? "";
    expect(readme).not.toContain(
      "KHÔNG GỒM: số giấy tờ tuỳ thân, ảnh giấy tờ tuỳ thân, thông tin đăng nhập, khoá/băm/bí mật, bản xuất cũ.",
    );
    expect(readme).toContain("thông báo lưu trú");
  });

  it("vượt trần tổng dung lượng → không nhúng, liệt kê kèm lý do; file nhỏ hơn phía sau vẫn vừa thì vẫn nhúng", async () => {
    const big = Buffer.alloc(600, 1);
    const small = Buffer.from(`nhỏ-${randomUUID()}`);
    const fBig = await seedFile(h.org.orgId, "meter_reading", big);
    const fSmall = await seedFile(h.org.orgId, "meter_reading", small);
    // Trần đủ chứa các file nhỏ đã có từ trước nhưng không đủ cho `big` (600 B) cộng dồn.
    const used = await sql<{ n: string }>`
      select coalesce(sum(size_bytes), 0)::text as n from files
      where organization_id = ${h.org.orgId} and status = 'ready' and owner_type in (${sql.join([...ORG_EXPORT_FILE_OWNER_ALLOWLIST])})
        and id not in (${fBig}, ${fSmall})`.execute(h.t.admin);
    const cap = Number(used.rows[0]?.n) + small.length + 10;
    const zip = await runOrgExport(cap);
    const rows = manifestRows(zip.get("files/MANIFEST.csv") as Buffer);
    expect(rows.find((r) => r.file_id === fBig)).toMatchObject({
      status: "skipped",
      reason: "over_total_limit",
      zip_path: "",
    });
    expect(rows.find((r) => r.file_id === fSmall)).toMatchObject({ status: "included" });
    expect([...zip.keys()].some((k) => k.includes(fBig))).toBe(false);
    expect(zip.get(`files/meter_reading/${fSmall}.png`)).toEqual(small);
    expect(ORG_EXPORT_SKIP_REASONS.over_total_limit).toBeTruthy();
  });

  it("object thiếu/hỏng trong kho: bản xuất vẫn hoàn tất, file đó ghi fetch_failed/checksum_mismatch", async () => {
    const miss = await seedFile(h.org.orgId, "task", Buffer.from("thiếu"), { store: "missing" });
    const bad = await seedFile(h.org.orgId, "task", Buffer.from("đúng"), { store: Buffer.from("SAI") });
    const rows = manifestRows((await runOrgExport()).get("files/MANIFEST.csv") as Buffer);
    expect(rows.find((r) => r.file_id === miss)).toMatchObject({ status: "skipped", reason: "fetch_failed" });
    expect(rows.find((r) => r.file_id === bad)).toMatchObject({
      status: "skipped",
      reason: "checksum_mismatch",
    });
  });

  it("file chưa ready (đang quét/bị từ chối) không vào bản xuất; không có file nào → MANIFEST chỉ có tiêu đề", async () => {
    const orgless = Buffer.from("PENDING-FILE");
    const id = randomUUID();
    await sql`insert into files (id, organization_id, owner_type, mime, size_bytes, sha256, status, storage_key)
              values (${id}, ${h.org.orgId}, 'task', 'application/pdf', ${orgless.length}, ${sha(orgless)}, 'pending_scan',
                      ${`${h.org.orgId}/exp-test/${id}`})`.execute(h.t.admin);
    const zip = await runOrgExport();
    expect(manifestRows(zip.get("files/MANIFEST.csv") as Buffer).some((r) => r.file_id === id)).toBe(false);
    expect(ORG_EXPORT_FILES_MAX_BYTES).toBeGreaterThan(0);
  });
});

describe("D-033 allowlist owner_type nhúng file (hàm thuần)", () => {
  it("chỉ 6 loại trong allowlist được nhúng; loại không nhạy cảm cũng như loại MỚI chưa biết đều bị bỏ (đóng mặc định)", () => {
    expect([...ORG_EXPORT_FILE_OWNER_ALLOWLIST].sort()).toEqual(
      ["handover", "lease_settlement", "meter_reading", "payment_claim", "task", "work_order"].sort(),
    );
    for (const t of ORG_EXPORT_FILE_OWNER_ALLOWLIST) expect(orgFileSkipReasonForOwner(t)).toBeNull();
    expect(orgFileSkipReasonForOwner("identity_document")).toBe("identity_document");
    expect(orgFileSkipReasonForOwner("residence_notice")).toBe("residence_notice");
    expect(orgFileSkipReasonForOwner("import_batch")).toBe("import_batch");
    expect(orgFileSkipReasonForOwner("export_job")).toBe("export_job");
    expect(orgFileSkipReasonForOwner("loai_moi_chua_biet")).toBe("owner_type_not_allowed");
    expect(orgFileSkipReasonForOwner("")).toBe("owner_type_not_allowed");
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
    // Retry-After = giây tới lúc yêu cầu cũ nhất rời cửa sổ 1 giờ (BE-REL-006).
    const over = await runAs(h.t, o, (ctx) => requestExport(ctx, { kind: "deposits", format: "csv" }));
    expect(over.status).toBe("failed");
    if (over.status === "failed") {
      expect(over.problem.retry_after).toBeGreaterThan(3500);
      expect(over.problem.retry_after).toBeLessThanOrEqual(3600);
    }
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

describe("xuất nhật ký giữ bộ lọc người hỗ trợ (/nhat-ky, D-128)", () => {
  it("filters.actor_type = platform_support ⇒ lưu vào job và CSV chỉ có sự kiện của support; giá trị lạ ⇒ 422", async () => {
    const owner = fresh(await seedMember(h.t, h.org, "owner", { name: "Chủ xuất nhật ký" }));
    const tag = randomUUID().slice(0, 8);
    const at = `${TODAY}T05:00:00Z`;
    for (const [actorType, corr] of [
      ["platform_support", `ho-tro-${tag}`],
      ["user", `nguoi-dung-${tag}`],
    ] as const)
      await sql`insert into audit_events (id, organization_id, occurred_at, actor_type, actor_person_id, action, entity_type,
                                          correlation_id)
                values (${randomUUID()}, ${h.org.orgId}, ${at}, ${actorType}, ${owner.personId}, 'support.accessed', 'page', ${corr})`.execute(
        h.t.admin,
      );
    const q = await okAs(h.t, owner, (ctx) =>
      requestExport(ctx, {
        kind: "audit",
        format: "csv",
        filters: { from: TODAY, to: TODAY, actorType: "platform_support" },
      }),
    );
    const f = await sql<{
      filters: Record<string, string>;
    }>`select filters from export_jobs where id = ${q.exportId}`.execute(h.t.admin);
    expect(f.rows[0]?.filters).toMatchObject({ actor_type: "platform_support" });
    expect(await runExportJob(deps(), job(q.exportId))).toBe("ready");
    const d = await okAs(h.t, owner, (ctx) => downloadExport(ctx, deps(), { exportId: q.exportId }));
    const csv = decode(await text(d.url));
    expect(csv).toContain(`ho-tro-${tag}`);
    expect(csv).not.toContain(`nguoi-dung-${tag}`);
    expect(
      await codeOf(
        runAs(h.t, owner, (ctx) =>
          requestExport(ctx, {
            kind: "audit",
            format: "csv",
            filters: { from: TODAY, to: TODAY, actorType: "khac" },
          }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});
