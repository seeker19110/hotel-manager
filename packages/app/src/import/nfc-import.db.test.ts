// PLAN đợt 5 T-407 — NFC cho ô import + tên file tải lên; UTF-8 khứ hồi qua API (BASE-DATA-001/002, UX-CONTENT-002, XC-I18N-005)
// trên Postgres thật + SeaweedFS.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Actor } from "../access/actor.ts";
import { ObjectStorage } from "../files/storage.ts";
import { type CommandDef, type HttpDeps, handleCommand } from "../http/command-route.ts";
import { normalizeUploadName } from "../http/normalize.ts";
import { testServices } from "../server/services.ts";
import { okAs, ownerOf, seedMember } from "../testing/helpers.ts";
import { handleImportUpload } from "./http.ts";
import { validateBatch } from "./import.ts";

let t: TestDb;
let A: SeededOrg;
let M: Actor;
let storage: ObjectStorage;

// "Việt" dạng tổ hợp (NFD: e + dấu mũ + dấu nặng) và dựng sẵn (NFC).
const NFD = "Vie\u0302\u0323t";
const NFC = "Việt";

function deps(actor: Actor): HttpDeps {
  return {
    db: t.runtime,
    getSession: async () => ({ user: { id: actor.authUserId, twoFactorEnabled: true } }),
    secureCookies: false,
    services: testServices({ storage }),
  };
}

async function upload(actor: Actor, csv: string, fileName: string): Promise<Response> {
  const form = new FormData();
  form.set("file", new File([new TextEncoder().encode(csv)], fileName, { type: "text/csv" }));
  form.set("property_id", A.propertyId);
  form.set("kind", "units");
  const body = new Response(form);
  const buf = await body.arrayBuffer();
  return handleImportUpload(
    new Request("http://localhost/api/v1/import/upload", {
      method: "POST",
      headers: {
        "x-org-id": A.orgId,
        "idempotency-key": randomUUID(),
        "content-type": body.headers.get("content-type") as string,
      },
      body: buf,
    }),
    deps(actor),
  );
}

const rowsOf = async (batchId: string) =>
  (
    await sql<{
      raw: Record<string, { v: string }>;
      data: Record<string, unknown> | null;
    }>`select raw, data from import_rows where batch_id = ${batchId} order by row_no`.execute(t.admin)
  ).rows;

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "Trọ NFC", "rental");
  await ownerOf(t, A);
  M = await seedMember(t, A, "manager");
});

afterAll(async () => {
  await t?.drop();
});

describe("nfc-import — ô CSV/Excel chuẩn hoá NFC khi tải lên", () => {
  it("ô tiếng Việt NFD → lưu NFC (dòng thô + sau kiểm), tên file NFD → audit ghi NFC", async () => {
    expect(NFD).not.toBe(NFC);
    const csv = `external_id,unit_code,floor,capacity\r\nU-${NFD},${NFD}1,Tầng ${NFD},2\r\n`;
    const res = await upload(M, csv, `${NFD}.csv`);
    expect(res.status).toBe(201);
    const { batchId } = ((await res.json()) as { data: { batchId: string } }).data;

    const [row] = await rowsOf(batchId);
    expect(row?.raw.external_id?.v).toBe(`U-${NFC}`);
    expect(row?.raw.unit_code?.v).toBe(`${NFC}1`);
    expect(row?.raw.floor?.v).toBe(`Tầng ${NFC}`);
    expect(Buffer.from(row?.raw.floor?.v ?? "").equals(Buffer.from(`Tầng ${NFC}`))).toBe(true);

    await okAs(t, M, (ctx) => validateBatch(ctx, { batchId }));
    const [checked] = await rowsOf(batchId);
    expect(checked?.data?.floor).toBe(`Tầng ${NFC}`);

    const audit = await sql<{ after: { file_name: string } }>`
      select after from audit_events where entity_id = ${batchId} and action = 'import_batch.uploaded'`.execute(
      t.admin,
    );
    expect(audit.rows[0]?.after.file_name).toBe(`${NFC}.csv`);
  });

  it("tiêu đề cột NFD cũng khớp (không báo thiếu cột); ô rỗng và chuỗi ASCII giữ nguyên", async () => {
    const csv = "external_id,unit_code,floor,capacity\r\nU-ascii,A1,,3\r\n";
    const res = await upload(M, csv, "mau.csv");
    expect(res.status).toBe(201);
    const { batchId } = ((await res.json()) as { data: { batchId: string } }).data;
    const [row] = await rowsOf(batchId);
    expect(row?.raw.external_id?.v).toBe("U-ascii");
    expect(row?.raw.floor).toBeUndefined();
  });

  it("dòng thô cũ đã lưu NFD (lô tải trước khi có chuẩn hoá) vẫn được kiểm và ghi dữ liệu dạng NFC", async () => {
    const res = await upload(M, "external_id,unit_code,floor,capacity\r\nU-old,B1,T1,2\r\n", "cu.csv");
    const { batchId } = ((await res.json()) as { data: { batchId: string } }).data;
    await sql`update import_rows set raw = jsonb_set(raw, '{floor}', jsonb_build_object('v', ${`Tầng ${NFD}`}::text, 'numeric', false))
              where batch_id = ${batchId}`.execute(t.admin);
    await okAs(t, M, (ctx) => validateBatch(ctx, { batchId }));
    const [row] = await rowsOf(batchId);
    expect(row?.data?.floor).toBe(`Tầng ${NFC}`);
  });
});

describe("nfc-import — tên file tải lên", () => {
  it("NFC, bỏ đường dẫn, ký tự điều khiển/đảo chiều, cắt 200 điểm mã; rỗng → 'tep'", () => {
    expect(normalizeUploadName(`${NFD}.csv`)).toBe(`${NFC}.csv`);
    expect(normalizeUploadName("C:\\Users\\a\\hop-dong.csv")).toBe("hop-dong.csv");
    expect(normalizeUploadName("../../etc/passwd")).toBe("passwd");
    expect(normalizeUploadName("a\u202Efdp.csv\u0000")).toBe("afdp.csv");
    expect(normalizeUploadName("x".repeat(500))).toHaveLength(200);
    expect(Array.from(normalizeUploadName("🏨".repeat(300)))).toHaveLength(200);
    expect(normalizeUploadName("")).toBe("tep");
    expect(normalizeUploadName("///")).toBe("tep");
    expect(normalizeUploadName("  ")).toBe("tep");
  });
});

describe("nfc-import — UTF-8 khứ hồi qua API", () => {
  const TEXT = "Tiếng Việt 🇻🇳";
  const ECHO: CommandDef<{ text: string }, { text: string; id: string }> = {
    command: "test.round_trip",
    input: z.strictObject({ text: z.string().min(1).max(100) }),
    run: async (ctx, i) => {
      const id = randomUUID();
      await sql`insert into persons (id, organization_id, full_name) values (${id}, ${ctx.actor.orgId}, ${i.text})`.execute(
        ctx.trx,
      );
      await ctx.audit({ action: "test.round_trip", entityType: "person", entityId: id });
      return { data: { text: i.text, id } };
    },
  };

  it("lưu 'Tiếng Việt 🇻🇳' qua command → đọc lại từ CSDL nguyên vẹn; phản hồi UTF-8 khai charset", async () => {
    const res = await handleCommand(
      ECHO,
      new Request("http://local.test/api/v1/x/round_trip", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "idempotency-key": randomUUID(),
          "x-org-id": A.orgId,
          "x-test-user": A.ownerAuthUserId,
        },
        // Gửi NFD để cùng lúc kiểm chuẩn hoá: emoji cờ (hai ký tự vùng) không bị đổi.
        body: JSON.stringify({ text: TEXT.replace("Việt", NFD) }),
      }),
      {
        db: t.runtime,
        getSession: async (h) => ({ user: { id: h.get("x-test-user") as string, twoFactorEnabled: true } }),
        secureCookies: false,
        services: testServices({ storage }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
      data: { text: string; id: string };
    };
    expect(body.data.text).toBe(TEXT);
    const stored = await sql<{
      full_name: string;
    }>`select full_name from persons where id = ${body.data.id}`.execute(t.admin);
    expect(stored.rows[0]?.full_name).toBe(TEXT);
    expect(Buffer.from(stored.rows[0]?.full_name ?? "").equals(Buffer.from(TEXT, "utf8"))).toBe(true);
  });
});
