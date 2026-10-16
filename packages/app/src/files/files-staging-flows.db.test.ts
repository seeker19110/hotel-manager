// T-303 (D-025) — hai luồng còn lại dùng dòng staging: tải lô nhập (file nguồn) và xuất thông báo lưu trú. Trên Postgres
// thật + kho object thật: quét/ghi object ngoài transaction, replay không ghi lần hai, lệch dữ liệu giữa chuẩn bị và lệnh → 409.
import { randomUUID } from "node:crypto";
import { testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { type HttpDeps, handleCommand } from "../http/command-route.ts";
import { COMMANDS } from "../http/registry.ts";
import { prepareBatchUpload, uploadBatch } from "../import/import.ts";
import { runRetention } from "../import/retention.ts";
import { testServices } from "../server/services.ts";
import { exportResidenceNotice, prepareResidenceNotice } from "../stay/residence-notices.ts";
import { type GuestInput, walkIn } from "../stay/stays.ts";
import { codeOf, okAs, runAs } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { probeIdleDuring } from "../testing/idle-probe.ts";
import type { MalwareScanner } from "./inspect.ts";
import { ObjectStorage } from "./storage.ts";

let h: Hotel;
let storage: ProbingStorage;
const pii = createPiiCipher(devKeyring());

class ProbingStorage extends ObjectStorage {
  puts = 0;
  maxIdleInTx = 0;
  override async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.puts += 1;
    this.maxIdleInTx = Math.max(this.maxIdleInTx, await probeIdleDuring(h.t.admin, h.t.name, 500));
    return super.put(key, body, contentType);
  }
}

const scanner = (): MalwareScanner & { scans: number; maxIdleInTx: number } => ({
  scans: 0,
  maxIdleInTx: 0,
  async scan() {
    this.scans += 1;
    this.maxIdleInTx = Math.max(this.maxIdleInTx, await probeIdleDuring(h.t.admin, h.t.name, 500));
    return { clean: true };
  },
});

beforeAll(async () => {
  h = await seedHotel();
  storage = new ProbingStorage(testS3Config());
  await storage.ensureBucket();
});

afterAll(async () => {
  await h?.t.drop();
});

describe("tải lô nhập (import.upload)", () => {
  const CSV = new TextEncoder().encode(
    ["external_id,unit_code,floor,capacity", "U-1,101,Tầng 1,2", "U-2,102,Tầng 1,2"].join("\n"),
  );
  const input = () => ({ propertyId: h.org.propertyId, kind: "units", bytes: CSV });

  it("quét + ghi object nguồn ngoài transaction; lô trỏ đúng file đã chốt ready; replay không quét/ghi lại", async () => {
    const sc = scanner();
    const deps = { storage, scanner: sc };
    const key = randomUUID();
    const puts0 = storage.puts;
    const prepared = await prepareBatchUpload(h.t.runtime, deps, h.manager, input(), key);
    const r = await runAs(h.t, h.manager, (ctx) => uploadBatch(ctx, deps, { ...input(), prepared }), { key });
    expect(r.status).toBe("committed");
    expect(sc.maxIdleInTx).toBe(0);
    expect(storage.maxIdleInTx).toBe(0);
    expect(storage.puts).toBe(puts0 + 1);
    const b = await sql<{ id: string; file_id: string; status: string; fstatus: string; owner_id: string }>`
      select b.id, b.file_id, b.status, f.status as fstatus, f.owner_id
      from import_batches b join files f on f.organization_id = b.organization_id and f.id = b.file_id
      where b.file_id = ${prepared.fileId}`.execute(h.t.admin);
    expect(b.rows[0]).toMatchObject({ id: prepared.batchId, fstatus: "ready", owner_id: prepared.batchId });
    // Replay: cùng key → bỏ qua quét + ghi.
    const again = await prepareBatchUpload(h.t.runtime, deps, h.manager, input(), key);
    expect(again.fileId).toBe(prepared.fileId);
    expect(sc.scans).toBe(1);
    expect(storage.puts).toBe(puts0 + 1);
  });

  it("đầu vào sai (thiếu cột / không quyền) bị chặn TRƯỚC khi quét hay ghi: không dòng staging, không object", async () => {
    const sc = scanner();
    const deps = { storage, scanner: sc };
    const puts0 = storage.puts;
    const before = await sql<{ n: number }>`select count(*)::int as n from files`.execute(h.t.admin);
    await expect(
      prepareBatchUpload(
        h.t.runtime,
        deps,
        h.manager,
        { ...input(), bytes: new TextEncoder().encode("a,b\n1,2") },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      prepareBatchUpload(h.t.runtime, deps, h.housekeeping, input(), randomUUID()),
    ).rejects.toBeDefined();
    const after = await sql<{ n: number }>`select count(*)::int as n from files`.execute(h.t.admin);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect(sc.scans).toBe(0);
    expect(storage.puts).toBe(puts0);
  });

  it("máy quét báo nhiễm → 415, không ghi object", async () => {
    const infected: MalwareScanner = { scan: async () => ({ clean: false, reason: "Test" }) };
    const puts0 = storage.puts;
    await expect(
      prepareBatchUpload(h.t.runtime, { storage, scanner: infected }, h.manager, input(), randomUUID()),
    ).rejects.toMatchObject({ status: 415 });
    expect(storage.puts).toBe(puts0);
  });
});

describe("xuất thông báo lưu trú", () => {
  const AN: GuestInput = {
    fullName: "Nguyễn Văn An",
    phone: "0912345678",
    docType: "cccd",
    docNumber: "001234567890",
  };
  const svc = () => testServices({ pii, storage });
  let seq = 0;

  async function stay() {
    const unit = randomUUID();
    seq += 1;
    await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
              values (${unit}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`7${String(seq).padStart(2, "0")}`}, 'inspected')`.execute(
      h.t.admin,
    );
    return okAs(h.t, h.frontDesk, (ctx) =>
      walkIn(ctx, pii, {
        unitId: unit,
        departureDate: "2026-10-16",
        guests: [AN],
        now: new Date("2026-10-15T07:00:00Z"),
      }),
    );
  }
  async function template(fields: string[]) {
    await sql`insert into notification_settings (id, organization_id, property_id, residence_notice_template, updated_by)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${JSON.stringify({ format: "csv", fields })}::jsonb, ${h.org.ownerMembershipId})
              on conflict (organization_id, property_id) do update set residence_notice_template = excluded.residence_notice_template`.execute(
      h.t.admin,
    );
  }

  it("dựng + ghi object ngoài transaction (kho chậm không giữ idle-in-transaction); lệnh chốt file ready hạn 1 ngày; file đúng nội dung", async () => {
    await template(["full_name", "doc_number"]);
    const s = await stay();
    const key = randomUUID();
    const puts0 = storage.puts;
    const prepared = await prepareResidenceNotice(h.t.runtime, svc(), h.frontDesk, { stayId: s.stayId }, key);
    expect(storage.maxIdleInTx).toBe(0);
    const r = await runAs(
      h.t,
      h.frontDesk,
      (ctx) => exportResidenceNotice(ctx, svc(), { stayId: s.stayId, prepared }),
      { key },
    );
    expect(r.status).toBe("committed");
    if (r.status !== "committed") return;
    expect(r.data.fileId).toBe(prepared.fileId);
    expect(storage.puts).toBe(puts0 + 1);
    const f = await sql<{ status: string; delete_after: string; today: string }>`
      select status, delete_after::text, current_date::text as today from files where id = ${prepared.fileId}`.execute(
      h.t.admin,
    );
    expect(f.rows[0]?.status).toBe("ready");
    expect(
      new Date(`${f.rows[0]?.delete_after}T00:00:00Z`).getTime() -
        new Date(`${f.rows[0]?.today}T00:00:00Z`).getTime(),
    ).toBe(86_400_000);
    const csv = new TextDecoder().decode(new Uint8Array(await (await fetch(r.data.url)).arrayBuffer()));
    expect(csv).toContain("Nguyễn Văn An,001234567890");
    // Replay (cùng key): prepare bỏ qua ghi.
    const again = await prepareResidenceNotice(h.t.runtime, svc(), h.frontDesk, { stayId: s.stayId }, key);
    expect(again.fileId).toBe(prepared.fileId);
    expect(storage.puts).toBe(puts0 + 1);
  });

  it("dữ liệu đổi giữa chuẩn bị và lệnh → 409 VERSION_CONFLICT, file đã ghi còn pending_scan và được job hạn giữ dọn", async () => {
    await template(["full_name"]);
    const s = await stay();
    const prepared = await prepareResidenceNotice(
      h.t.runtime,
      svc(),
      h.frontDesk,
      { stayId: s.stayId },
      randomUUID(),
    );
    await template(["full_name", "nationality"]); // mẫu đổi → file lệch
    const code = await codeOf(
      runAs(h.t, h.frontDesk, (ctx) => exportResidenceNotice(ctx, svc(), { stayId: s.stayId, prepared })),
    );
    expect(code).toBe("VERSION_CONFLICT");
    const row = await sql<{ status: string; storage_key: string }>`
      select status, storage_key from files where id = ${prepared.fileId}`.execute(h.t.admin);
    expect(row.rows[0]?.status).toBe("pending_scan");
    const late = await runRetention(h.t.worker, storage, { now: new Date(Date.now() + 5 * 86_400_000) });
    expect(late.filesFailed).toBe(0);
    const after = await sql<{
      status: string;
    }>`select status from files where id = ${prepared.fileId}`.execute(h.t.admin);
    expect(after.rows[0]?.status).toBe("deleted");
  });

  it("buồng phòng / chưa có mẫu bị chặn ở bước chuẩn bị: không ghi object", async () => {
    await template(["full_name"]);
    const s = await stay();
    const puts0 = storage.puts;
    await expect(
      prepareResidenceNotice(h.t.runtime, svc(), h.housekeeping, { stayId: s.stayId }, randomUUID()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(storage.puts).toBe(puts0);
  });

  it("qua HTTP (registry: prepare + run): gửi lại cùng Idempotency-Key → cùng file, đúng một lần ghi object", async () => {
    await template(["full_name"]);
    const s = await stay();
    const deps: HttpDeps = {
      db: h.t.runtime,
      getSession: async (hd) => {
        const id = hd.get("x-test-user");
        return id ? { user: { id, twoFactorEnabled: true } } : null;
      },
      secureCookies: false,
      services: svc(),
    };
    const key = randomUUID();
    const post = () =>
      handleCommand(
        COMMANDS["stay.exportResidenceNotice"] as NonNullable<(typeof COMMANDS)[string]>,
        new Request("http://local.test/api/v1/stay/exportResidenceNotice", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
            "x-test-user": h.frontDesk.authUserId,
            "x-org-id": h.org.orgId,
          },
          body: JSON.stringify({ stay_id: s.stayId }),
        }),
        deps,
      );
    const puts0 = storage.puts;
    const r1 = await post();
    const r2 = await post();
    expect([r1.status, r2.status]).toEqual([200, 200]);
    // biome-ignore lint/suspicious/noExplicitAny: thân phản hồi kiểm bằng toBe
    const [d1, d2] = [(await r1.json()) as any, (await r2.json()) as any];
    expect(d2.data.fileId).toBe(d1.data.fileId);
    expect(storage.puts).toBe(puts0 + 1);
    expect(storage.maxIdleInTx).toBe(0);
  });
});
