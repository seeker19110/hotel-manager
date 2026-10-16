// PLAN đợt 3 T-210 — thông báo lưu trú trên Postgres thật + object storage thật (SPEC-reservation-stay S-028…S-030).
import { randomUUID } from "node:crypto";
import { testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { ObjectStorage } from "../files/storage.ts";
import { readXlsx } from "../import/xlsx.ts";
import { testServices } from "../server/services.ts";
import { codeOf, okAs, runAs } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { exportResidenceNotice, listNotices, markNoticeSubmitted } from "./residence-notices.ts";
import { type GuestInput, walkIn } from "./stays.ts";

let h: Hotel;
let storage: ObjectStorage;
let svc: ReturnType<typeof testServices>;
const pii = createPiiCipher(devKeyring());
const AN: GuestInput = {
  fullName: "Nguyễn Văn An",
  phone: "0100005678",
  docType: "cccd",
  docNumber: "001234567890",
};
const JOHN: GuestInput = {
  fullName: "John Doe",
  phone: "+15551234567",
  docType: "passport",
  docNumber: "X1234567",
  nationality: "US",
};

beforeAll(async () => {
  h = await seedHotel();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  svc = testServices({ pii, storage });
});

afterAll(async () => {
  await h?.t.drop();
});

let seq = 0;
async function stay(guests: GuestInput[], at = new Date("2026-10-15T07:00:00Z")) {
  const unit = randomUUID();
  seq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${unit}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`4${String(seq).padStart(2, "0")}`}, 'inspected')`.execute(
    h.t.admin,
  );
  return okAs(h.t, h.frontDesk, (ctx) =>
    walkIn(ctx, pii, { unitId: unit, departureDate: "2026-10-16", guests, now: at }),
  );
}

async function setTemplate(t: unknown) {
  await sql`insert into notification_settings (id, organization_id, property_id, residence_notice_template, updated_by)
            values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${JSON.stringify(t)}::jsonb, ${h.org.ownerMembershipId})
            on conflict (organization_id, property_id) do update set residence_notice_template = excluded.residence_notice_template`.execute(
    h.t.admin,
  );
}

const download = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());

describe("S-028 xuất file thông báo lưu trú theo mẫu", () => {
  it("chưa cấu hình mẫu → 409 NOTICE_TEMPLATE_MISSING; buồng phòng → 404", async () => {
    const s = await stay([AN]);
    expect(
      await codeOf(runAs(h.t, h.frontDesk, (ctx) => exportResidenceNotice(ctx, svc, { stayId: s.stayId }))),
    ).toBe("NOTICE_TEMPLATE_MISSING");
    expect(
      await codeOf(
        runAs(h.t, h.housekeeping, (ctx) => exportResidenceNotice(ctx, svc, { stayId: s.stayId })),
      ),
    ).toBe("NOT_FOUND");
  });

  it("CSV chỉ gồm trường mẫu yêu cầu (có số giấy tờ đầy đủ, KHÔNG SĐT/tiền); exported; xuất lại giữ exported, mỗi lần một audit", async () => {
    await setTemplate({
      format: "csv",
      fields: ["full_name", "doc_type", "doc_number", "nationality", "check_in_date", "unit_code"],
      labels: { full_name: "HO_TEN" },
    });
    const s = await stay([AN]);
    const r = await okAs(h.t, h.frontDesk, (ctx) => exportResidenceNotice(ctx, svc, { stayId: s.stayId }));
    expect(r.status).toBe("exported");
    const csv = new TextDecoder().decode(await download(r.url));
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("HO_TEN,Loại giấy tờ,Số giấy tờ,Quốc tịch,Ngày đến,Phòng");
    expect(lines[1]).toMatch(/^Nguyễn Văn An,CCCD,001234567890,VN,2026-10-15,4\d\d$/);
    expect(csv).not.toContain("0100005678");
    expect(csv).not.toContain("600000");
    const again = await okAs(h.t, h.frontDesk, (ctx) =>
      exportResidenceNotice(ctx, svc, { stayId: s.stayId }),
    );
    expect(again.status).toBe("exported");
    expect(again.fileId).not.toBe(r.fileId);
    const audits = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where entity_id = ${r.noticeId} and action = 'residence_notice.exported'`.execute(
      h.t.admin,
    );
    expect(audits.rows[0]?.n).toBe(2);
    const n = await sql<{ status: string; export_file_id: string }>`
      select status, export_file_id from residence_notices where id = ${r.noticeId}`.execute(h.t.admin);
    expect(n.rows[0]).toEqual({ status: "exported", export_file_id: again.fileId });
    const file = await sql<{
      delete_after: string;
    }>`select delete_after::text from files where id = ${r.fileId}`.execute(h.t.admin);
    expect(file.rows[0]?.delete_after).not.toBeNull();
  });

  it("thiếu trường bắt buộc của mẫu (giấy tờ đã ẩn danh) → 422 kèm danh sách trường thiếu, không đổi trạng thái", async () => {
    await setTemplate({ format: "csv", fields: ["full_name", "doc_number"] });
    const s = await stay([{ ...AN, docNumber: "009988776655" }]);
    await sql`update identity_documents set anonymized_at = now(), doc_number_enc = null, doc_number_key_id = null,
                     doc_number_hash = null, doc_number_last4 = null
              where organization_id = ${h.org.orgId} and doc_number_last4 = '6655'`.execute(h.t.admin);
    const res = await runAs(h.t, h.frontDesk, (ctx) => exportResidenceNotice(ctx, svc, { stayId: s.stayId }));
    expect(res.status).toBe("failed");
    if (res.status === "failed") {
      expect(res.problem.code).toBe("VALIDATION_FAILED");
      expect(res.problem.errors?.map((e) => e.path)).toEqual(["guests.0.doc_number"]);
    }
    const n = await sql<{
      status: string;
    }>`select status from residence_notices where id = ${s.noticeId}`.execute(h.t.admin);
    expect(n.rows[0]?.status).toBe("pending");
  });

  it("mẫu chứa trường ngoài danh sách cho phép (vd SĐT) → coi như chưa có mẫu, không xuất", async () => {
    await setTemplate({ format: "csv", fields: ["full_name", "phone"] });
    const s = await stay([AN]);
    expect(
      await codeOf(runAs(h.t, h.frontDesk, (ctx) => exportResidenceNotice(ctx, svc, { stayId: s.stayId }))),
    ).toBe("NOTICE_TEMPLATE_MISSING");
  });
});

describe("S-030 khách nước ngoài", () => {
  it("XLSX có quốc tịch + số hộ chiếu theo mẫu; is_foreign", async () => {
    await setTemplate({ format: "xlsx", fields: ["full_name", "nationality", "doc_type", "doc_number"] });
    const s = await stay([JOHN]);
    const r = await okAs(h.t, h.frontDesk, (ctx) => exportResidenceNotice(ctx, svc, { stayId: s.stayId }));
    const rows = readXlsx(await download(r.url)).map((row) => row.cells.map((c) => c.v));
    expect(rows[1]).toEqual(["John Doe", "US", "Hộ chiếu", "X1234567"]);
    const n = await sql<{
      is_foreign: boolean;
    }>`select is_foreign from residence_notices where id = ${r.noticeId}`.execute(h.t.admin);
    expect(n.rows[0]?.is_foreign).toBe(true);
  });
});

describe("S-029 đánh dấu đã thông báo lưu trú", () => {
  it("submitted lưu người/thời điểm/kênh; gửi lại cùng key → cùng kết quả; key khác → INVALID_TRANSITION; tương lai → 422", async () => {
    const s = await stay([AN]);
    const future = new Date(Date.now() + 3_600_000);
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          markNoticeSubmitted(ctx, { noticeId: s.noticeId, submittedAt: future, channel: "online" }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    const key = randomUUID();
    const at = new Date("2026-10-15T09:00:00Z");
    const send = () =>
      runAs(
        h.t,
        h.frontDesk,
        (ctx) => markNoticeSubmitted(ctx, { noticeId: s.noticeId, submittedAt: at, channel: "online" }),
        {
          key,
          command: "stay.markNoticeSubmitted",
          payload: { notice_id: s.noticeId },
        },
      );
    expect((await send()).status).toBe("committed");
    expect(await send()).toMatchObject({ status: "committed", replayed: true });
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          markNoticeSubmitted(ctx, { noticeId: s.noticeId, submittedAt: at, channel: "in_person" }),
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    const n = await sql<{ status: string; channel: string; submitted_by: string; submitted_at: Date }>`
      select status, channel, submitted_by, submitted_at from residence_notices where id = ${s.noticeId}`.execute(
      h.t.admin,
    );
    expect(n.rows[0]).toMatchObject({
      status: "submitted",
      channel: "online",
      submitted_by: h.frontDesk.membershipId,
    });
    expect(n.rows[0]?.submitted_at.toISOString()).toBe(at.toISOString());
    // CSDL chặn lùi trạng thái sau khi đã thông báo.
    await expect(
      sql`update residence_notices set status = 'exported' where id = ${s.noticeId}`.execute(h.t.admin),
    ).rejects.toThrow(/không lùi/);
  });
});

describe("stay.listNotices", () => {
  it("quá hạn chưa nộp lên đầu; không có tên/số giấy tờ; buồng phòng/tổ chức khác → 404", async () => {
    await sql`update notification_settings set stay_notice_deadline = '{"domestic_cutoff":"23:00","domestic_next_day_before":"08:00"}'
              where organization_id = ${h.org.orgId}`.execute(h.t.admin);
    const due = await stay([AN], new Date("2026-10-15T08:00:00Z"));
    const list = await listNotices(h.t.runtime, h.frontDesk, {
      propertyId: h.org.propertyId,
      now: new Date("2026-10-15T17:00:00Z"),
    });
    expect(list[0]?.id).toBe(due.noticeId);
    expect(list[0]?.overdue).toBe(true);
    expect(JSON.stringify(list)).not.toContain("Nguyễn");
    await expect(
      listNotices(h.t.runtime, h.housekeeping, { propertyId: h.org.propertyId }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      listNotices(h.t.runtime, h.ownerOther, { propertyId: h.org.propertyId }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
