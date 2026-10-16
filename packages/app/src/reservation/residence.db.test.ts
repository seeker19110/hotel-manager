// PLAN đợt 3 T-207 — thông báo lưu trú trên Postgres thật (SPEC-reservation-stay S-028, S-029, S-030, S-025, Q-13;
// SPEC-notifications S-014, S-015, S-016, S-020, S-021; ERD `residence_notices`; INV-G1, INV-G2, INV-G6, INV-G7).
// Cơ sở `hotel`: UTC+7, giờ chốt ngày 04:00. Hạn cấu hình (giá trị thử, nguồn pháp lý [T] — Q-13): trước 23:00; đến từ 23:00 thì
// trước 08:00 hôm sau; khách nước ngoài 12 giờ. Hệ thống KHÔNG gửi gì ra ngoài: file chỉ để tải về.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { getFileUrl, uploadFile } from "../files/files.ts";
import { eicarOnlyScanner } from "../files/inspect.ts";
import { ObjectStorage } from "../files/storage.ts";
import { type HttpDeps, handleCommand, handleQuery } from "../http/command-route.ts";
import { COMMANDS, QUERIES } from "../http/registry.ts";
import { dispatchNotificationEvent } from "../notifications/dispatch.ts";
import { updateSettings } from "../notifications/notifications.ts";
import { scanResidenceNotices, scanStayNoticeConfig } from "../notifications/reminders.ts";
import { executeCommand } from "../pipeline/command.ts";
import { setRatePlan } from "./rates.ts";
import { confirmReservation, createReservation, holdReservation, markNoShow } from "./reservation.ts";
import {
  exportResidenceNotice,
  listNotices,
  markNoticeSubmitted,
  RESIDENCE_EXPORT_RETENTION_DAYS,
} from "./residence.ts";
import { checkIn, type GuestInput, walkIn } from "./stay.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let O: Actor;
let M: Actor;
let F: Actor;
let K: Actor;
let H: Actor;
let OB: Actor;
let storage: ObjectStorage;
let deps: HttpDeps;

type Problem = { code: string; status: number; errors?: { field: string; path: string; code: string }[] };

const NOW = new Date("2026-10-16T03:00:00Z"); // 10:00 giờ VN
const DOC = "079123456789";
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
/** Giờ địa phương (UTC+7) của ngày 20/10/2026 → UTC. */
const local = (hhmm: string, day = 20) => new Date(`2026-10-${day}T${hhmm}:00+07:00`);

const DEADLINE = {
  before_time: "23:00",
  late_arrival_after: "23:00",
  late_deadline_time: "08:00",
  foreign_guest_hours: 12,
};
const TEMPLATE = {
  columns: ["stt", "full_name", "doc_type", "doc_number", "unit_code", "checked_in_at"],
  foreign_columns: ["nationality", "passport_number"],
  required: ["full_name", "doc_number", "passport_number"],
};

async function member(role: string, org: SeededOrg = A): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${membership}, ${org.orgId}, ${user}, ${person}, ${role}, ${role === "accountant"})`.execute(
    t.admin,
  );
  if (role !== "accountant") {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${org.orgId}, ${membership}, ${org.propertyId})`.execute(t.admin);
  }
  return resolveActor(t.runtime, { authUserId: user, orgId: org.orgId, twoFactorEnabled: true });
}

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3], key: string = randomUUID()) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "residence.test", idempotencyKey: key, payload: { key }, correlationId: "c-residence-test" },
    fn,
  );
}

async function ok<T>(p: Promise<Awaited<ReturnType<typeof run<T>>>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

async function fails(p: Promise<Awaited<ReturnType<typeof run<unknown>>>>): Promise<Problem> {
  const r = await p;
  if (r.status !== "failed") throw new Error("lẽ ra thất bại");
  return r.problem as unknown as Problem;
}

async function pgError(p: PromiseLike<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message?: string };
  }
  throw new Error("lẽ ra phải lỗi CSDL");
}

async function rows<T = Record<string, unknown>>(q: ReturnType<typeof sql<T>>): Promise<T[]> {
  return (await q.execute(t.admin)).rows;
}
const one = async <T = Record<string, unknown>>(q: ReturnType<typeof sql<T>>) => (await rows(q))[0] as T;

async function newUnit(code: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${id}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, ${A.roomTypeId}, ${`${code}-${id.slice(0, 4)}`})`.execute(
    t.admin,
  );
  return id;
}

type GuestOver = { [K in keyof GuestInput]?: GuestInput[K] | undefined };
const guest = (over: GuestOver = {}): GuestInput => {
  const g: Record<string, unknown> = {
    fullName: "Nguyễn Văn A",
    phone: "0901234567",
    document: { type: "cccd", number: DOC },
    ...over,
  };
  for (const k of Object.keys(g)) if (g[k] === undefined) delete g[k];
  return g as GuestInput;
};

const FOREIGN = (over: GuestOver = {}): GuestInput =>
  guest({
    fullName: "John Smith",
    phone: "0912345678",
    nationality: "US",
    document: { type: "passport", number: "X1234567" },
    ...over,
  });

/** Walk-in tại thời điểm `now` (giờ UTC) — tạo lượt ở `in_house` + thông báo `pending` trong một transaction. */
async function stayAt(now: Date, guests: GuestInput[] = [guest()], unit?: string) {
  const unitId = unit ?? (await newUnit("W"));
  const r = await ok(
    run(F, async (ctx) => ({
      data: await walkIn(ctx, { unitId, departureDate: "2026-10-24", guests, now }),
    })),
  );
  return { ...r, unitId };
}

const noticeOf = (stayId: string) =>
  one(
    sql<{
      id: string;
      status: string;
      is_foreign: boolean;
      due_at: Date | null;
      exported_at: Date | null;
      exported_by: string | null;
      export_file_id: string | null;
      submitted_at: Date | null;
      submitted_by: string | null;
      channel: string | null;
      evidence_file_id: string | null;
    }>`select id, status, is_foreign, due_at, exported_at, exported_by, export_file_id, submitted_at, submitted_by, channel,
              evidence_file_id from residence_notices where stay_id = ${stayId}`,
  );

const doExport = (actor: Actor, stayId: string, key?: string, now = NOW) =>
  run(actor, async (ctx) => ({ data: await exportResidenceNotice(ctx, { storage }, { stayId, now }) }), key);

const doSubmit = (
  actor: Actor,
  noticeId: string,
  over: { submittedAt?: Date; channel?: string; evidenceFileId?: string } = {},
  key?: string,
  now = NOW,
) =>
  run(
    actor,
    async (ctx) => ({
      data: await markNoticeSubmitted(ctx, {
        noticeId,
        submittedAt: over.submittedAt ?? new Date("2026-10-16T02:00:00Z"),
        channel: over.channel ?? "in_person",
        ...(over.evidenceFileId ? { evidenceFileId: over.evidenceFileId } : {}),
        now,
      }),
    }),
    key,
  );

const csvOf = async (url: string) => (await (await fetch(url)).text()).replace(/^﻿/, "");

function jpeg(): Uint8Array {
  const seg = (m: number, p: number[]) => [0xff, m, (p.length + 2) >> 8, (p.length + 2) & 0xff, ...p];
  return Uint8Array.from([
    0xff,
    0xd8,
    ...seg(0xe0, [...Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
    0x12,
    0x34,
    0xff,
    0xd9,
  ]);
}

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "KS thông báo lưu trú", "hotel");
  B = await seedOrg(t.admin, "KS khác", "hotel");
  await sql`update properties set check_in_time = '14:00', check_out_time = '12:00', business_day_cutoff = '04:00'
            where id = ${A.propertyId}`.execute(t.admin);
  await sql`update properties set settings = ${JSON.stringify({ reservation: { confirm_without_payment: true } })}::jsonb
            where id = ${A.propertyId}`.execute(t.admin);
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  OB = await resolveActor(t.runtime, {
    authUserId: B.ownerAuthUserId,
    orgId: B.orgId,
    twoFactorEnabled: true,
  });
  M = await member("manager");
  F = await member("front_desk");
  K = await member("accountant");
  H = await member("housekeeping");
  await ok(
    run(O, async (ctx) => ({
      data: await setRatePlan(ctx, {
        roomTypeId: A.roomTypeId,
        weekdayPrice: 600_000,
        weekendPrice: 700_000,
        effectiveFrom: "2026-01-01",
      }),
    })),
  );
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: true } } : null;
    },
    secureCookies: false,
  };
});

afterAll(async () => {
  await t.drop();
});

describe("residence: chưa cấu hình hạn/mẫu (SPEC-notifications S-020; reservation S-030)", () => {
  let stayId: string;
  let noticeId: string;

  it("check-in vẫn tạo thông báo pending không có due_at; không có sự kiện nhắc; xuất → 409 NOTICE_TEMPLATE_MISSING; đánh dấu đã thông báo được", async () => {
    const s = await stayAt(local("20:10"));
    stayId = s.stay_id;
    const n = await noticeOf(stayId);
    noticeId = n.id;
    expect(n).toMatchObject({ status: "pending", is_foreign: false, due_at: null });
    // không có hạn ⇒ job không nhắc; chỉ có cảnh báo cấu hình (S-020)
    const scan = await scanResidenceNotices(t.worker, local("23:30"));
    expect(scan.created).toBe(0);
    expect(await rows(sql`select 1 from outbox where event_type = 'stay_notice.reminder'`)).toHaveLength(0);
    expect((await scanStayNoticeConfig(t.worker, local("23:30"))).created).toBe(1);

    const p = await fails(doExport(F, stayId));
    expect(p).toMatchObject({ code: "NOTICE_TEMPLATE_MISSING", status: 409 });
    expect(await noticeOf(stayId)).toMatchObject({ status: "pending", export_file_id: null });
    expect(await rows(sql`select 1 from files where owner_type = 'residence_notice'`)).toHaveLength(0);
  });

  it("cơ sở cấu hình hạn sau đó → due_at được tính bù cho lượt đang ở; thông báo đã nộp không bị đổi", async () => {
    const sub = await ok(doSubmit(F, noticeId, { channel: "online" }));
    expect(sub).toMatchObject({ status: "submitted", channel: "online" });
    const open = await stayAt(local("20:10"));
    expect((await noticeOf(open.stay_id)).due_at).toBeNull();

    await ok(
      run(M, async (ctx) => ({
        data: await updateSettings(ctx, {
          propertyId: A.propertyId,
          stayNoticeDeadline: DEADLINE,
          residenceNoticeTemplate: TEMPLATE,
        }),
      })),
    );
    expect(iso((await noticeOf(open.stay_id)).due_at)).toBe(iso(local("23:00")));
    expect((await noticeOf(stayId)).due_at).toBeNull(); // đã submitted: bất biến
    const audit = await one(
      sql<{ after: { residence_notice_due_backfilled?: number } }>`
        select after from audit_events where action = 'notification.settings_updated' order by created_at desc limit 1`,
    );
    expect(audit.after.residence_notice_due_backfilled).toBe(1);
  });

  it("mẫu không hợp lệ (cột ngoài danh mục như SĐT) bị từ chối khi lưu cấu hình", async () => {
    const p = await fails(
      run(M, async (ctx) => ({
        data: await updateSettings(ctx, {
          propertyId: A.propertyId,
          residenceNoticeTemplate: { columns: ["full_name", "phone"] },
        }),
      })),
    );
    expect(p).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    expect(p.errors?.[0]?.field).toBe("residence_notice_template");
  });
});

describe("residence: tạo thông báo + hạn theo giờ đến (S-028, S-014, S-015, S-030)", () => {
  it.each([
    ["22:59 → trước 23:00 cùng ngày", "20:10", "23:00", 20],
    ["22:59", "22:59", "23:00", 20],
    ["23:00 đúng giờ tính là sau 23 giờ → 08:00 hôm sau", "23:00", "08:00", 21],
    ["23:40 → 08:00 hôm sau (S-015)", "23:40", "08:00", 21],
  ])("khách trong nước %s", async (_n, checkInAt, dueAt, dueDay) => {
    const s = await stayAt(local(checkInAt));
    const n = await noticeOf(s.stay_id);
    expect(n.status).toBe("pending");
    expect(iso(n.due_at)).toBe(iso(local(dueAt, dueDay)));
  });

  it("đến 01:30 sau nửa đêm → 08:00 cùng ngày địa phương (cách hiểu chặt hơn: vẫn trong khung đêm 23:00–08:00)", async () => {
    const s = await stayAt(local("01:30", 21));
    expect(iso((await noticeOf(s.stay_id)).due_at)).toBe(iso(local("08:00", 21)));
  });

  it("khách nước ngoài 14:00 + 12 giờ = 02:00 hôm sau (S-015); is_foreign = true", async () => {
    const s = await stayAt(local("14:00"), [FOREIGN()]);
    expect(s.is_foreign).toBe(true);
    const n = await noticeOf(s.stay_id);
    expect(n.is_foreign).toBe(true);
    expect(iso(n.due_at)).toBe(iso(local("02:00", 21)));
  });

  it("nhóm có một khách nước ngoài (người đại diện trong nước) → quy tắc nước ngoài", async () => {
    const s = await stayAt(local("15:00"), [guest(), FOREIGN({ phone: undefined })]);
    expect(iso((await noticeOf(s.stay_id)).due_at)).toBe(iso(local("03:00", 21)));
  });

  it("cấu hình nước ngoài 24 giờ (fixture S-030) → 14:00 + 24 giờ; thiếu foreign_guest_hours → quy tắc trong nước", async () => {
    const set = (d: Record<string, string | number>) =>
      ok(
        run(M, async (ctx) => ({
          data: await updateSettings(ctx, { propertyId: A.propertyId, stayNoticeDeadline: d }),
        })),
      );
    await set({ ...DEADLINE, foreign_guest_hours: 24 });
    const a = await stayAt(local("14:00"), [FOREIGN()]);
    expect(iso((await noticeOf(a.stay_id)).due_at)).toBe(iso(local("14:00", 21)));
    const { foreign_guest_hours: _omit, ...noForeign } = DEADLINE;
    await set(noForeign);
    const b = await stayAt(local("14:00"), [FOREIGN()]);
    expect(iso((await noticeOf(b.stay_id)).due_at)).toBe(iso(local("23:00")));
    // thiếu late_deadline_time: đến sau ngưỡng không có hạn (không bịa số) nhưng thông báo vẫn tạo
    await set({ before_time: "23:00" });
    const c = await stayAt(local("23:30"));
    expect(await noticeOf(c.stay_id)).toMatchObject({ status: "pending", due_at: null });
    await set(DEADLINE);
  });

  it("check-in booking có sẵn tạo thông báo cùng transaction; no_show/cancelled/expected không có thông báo", async () => {
    const book = async (arrival: string) => {
      const unitId = await newUnit("B");
      const r = await ok(
        run(F, async (ctx) => ({
          data: await createReservation(ctx, {
            booker: { fullName: "Trần B", phone: "0901234567" },
            rooms: [{ unitId, guests: 2 }],
            arrivalDate: arrival,
            departureDate: "2026-10-23",
          }),
        })),
      );
      await ok(
        run(F, async (ctx) => ({ data: await holdReservation(ctx, { reservationId: r.id, now: NOW }) })),
      );
      const c = await ok(
        run(M, async (ctx) => ({ data: await confirmReservation(ctx, { reservationId: r.id, now: NOW }) })),
      );
      return { reservationId: r.id, stayId: c.stay_id };
    };
    const a = await book("2026-10-20");
    expect(await rows(sql`select 1 from residence_notices where stay_id = ${a.stayId}`)).toHaveLength(0);
    const ci = await ok(
      run(F, async (ctx) => ({
        data: await checkIn(ctx, { reservationId: a.reservationId, guests: [guest()], now: local("20:10") }),
      })),
    );
    const n = await noticeOf(ci.stay_id);
    expect(n).toMatchObject({ status: "pending", is_foreign: false });
    expect(iso(n.due_at)).toBe(iso(local("23:00")));
    const created = await one(
      sql<{
        n: number;
      }>`select count(*)::int as n from audit_events where action = 'residence_notice.created' and entity_id = ${n.id}`,
    );
    expect(created.n).toBe(1);

    const ns = await book("2026-10-20");
    await ok(
      run(F, async (ctx) => ({
        data: await markNoShow(ctx, {
          reservationId: ns.reservationId,
          reason: "Khách không đến",
          now: new Date("2026-10-22T03:00:00Z"),
        }),
      })),
    );
    expect(await rows(sql`select 1 from residence_notices where stay_id = ${ns.stayId}`)).toHaveLength(0);
    // Check-in từ no_show bị chặn nên cũng không thể sinh thông báo.
    const retry = await fails(
      run(F, async (ctx) => ({
        data: await checkIn(ctx, { reservationId: ns.reservationId, guests: [guest()], now: local("20:10") }),
      })),
    );
    expect(retry.code).toBe("INVALID_TRANSITION");
    expect(await rows(sql`select 1 from residence_notices where stay_id = ${ns.stayId}`)).toHaveLength(0);
  });

  it("check-in lỗi (thiếu giấy tờ) → rollback cả thông báo", async () => {
    const before = await one(sql<{ n: number }>`select count(*)::int as n from residence_notices`);
    const p = await fails(
      run(F, async (ctx) => ({
        data: await walkIn(ctx, {
          unitId: await newUnit("X"),
          departureDate: "2026-10-24",
          guests: [{ fullName: "Không giấy tờ", phone: "0901234567" } as GuestInput],
          now: local("20:10"),
        }),
      })),
    );
    expect(p.code).toBe("VALIDATION_FAILED");
    const after = await one(sql<{ n: number }>`select count(*)::int as n from residence_notices`);
    expect(after.n).toBe(before.n);
  });
});

describe("residence: xuất file theo mẫu (S-028, S-030, S-025)", () => {
  it("xuất lần đầu: CSV chỉ gồm trường mẫu (không SĐT/tiền), pending → exported, audit không chứa số giấy tờ; xuất lại giữ exported, mỗi lần một audit", async () => {
    const s = await stayAt(local("20:10"), [
      guest(),
      guest({ fullName: "Bé Lê", phone: undefined, document: { type: "other", number: "GS-00012" } }),
    ]);
    const key = randomUUID();
    const r = await ok(doExport(F, s.stay_id, key));
    expect(r).toMatchObject({
      status: "exported",
      guests: 2,
      is_foreign: false,
      re_export: false,
      expires_in: 300,
    });
    const body = await csvOf(r.url);
    const lines = body.split("\r\n");
    expect(lines[0]).toBe("STT,Họ và tên,Loại giấy tờ,Số giấy tờ,Số phòng,Giờ đến");
    expect(lines[1]).toMatch(new RegExp(`^1,Nguyễn Văn A,cccd,${DOC},.+,2026-10-20 20:10$`));
    expect(lines[2]).toMatch(/^2,Bé Lê,other,GS-00012,/);
    expect(body).not.toMatch(/0901234567|600\.?000|1200000/); // SĐT, tiền phòng
    // kết quả lệnh + audit + outbox không có số giấy tờ đầy đủ
    expect(JSON.stringify(r)).not.toContain(DOC);
    const n = await noticeOf(s.stay_id);
    expect(n).toMatchObject({ status: "exported", exported_by: F.membershipId, export_file_id: r.file_id });
    const f = await one(
      sql<{ owner_type: string; mime: string; storage_key: string; delete_after: string; status: string }>`
        select owner_type, mime, storage_key, delete_after::text, status from files where id = ${r.file_id}`,
    );
    expect(f).toMatchObject({ owner_type: "residence_notice", mime: "text/csv", status: "ready" });
    expect(f.storage_key.startsWith(`${A.orgId}/residence_notice/`)).toBe(true);
    const expectDelete = new Date(NOW.getTime() + RESIDENCE_EXPORT_RETENTION_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(f.delete_after).toBe(expectDelete);
    const leaks = await rows(
      sql`select 1 from audit_events where after::text like ${`%${DOC}%`} or before::text like ${`%${DOC}%`}`,
    );
    expect(leaks).toHaveLength(0);
    expect(await rows(sql`select 1 from outbox where payload::text like ${`%${DOC}%`}`)).toHaveLength(0);

    // cùng Idempotency-Key → cùng kết quả, không file thứ hai
    const again = await ok(doExport(F, s.stay_id, key));
    expect(again.file_id).toBe(r.file_id);
    // key khác → xuất lại: giữ exported, file mới, audit thứ hai
    const r2 = await ok(doExport(M, s.stay_id));
    expect(r2).toMatchObject({ status: "exported", re_export: true });
    expect(r2.file_id).not.toBe(r.file_id);
    expect(await noticeOf(s.stay_id)).toMatchObject({ status: "exported", export_file_id: r2.file_id });
    const audits = await one(
      sql<{
        n: number;
      }>`select count(*)::int as n from audit_events where action = 'residence_notice.exported' and entity_id = ${n.id}`,
    );
    expect(audits.n).toBe(2);
  });

  it("khách nước ngoài: thêm quốc tịch + số hộ chiếu theo mẫu", async () => {
    const s = await stayAt(local("14:00"), [FOREIGN()]);
    const r = await ok(doExport(O, s.stay_id));
    expect(r.is_foreign).toBe(true);
    const lines = (await csvOf(r.url)).split("\r\n");
    expect(lines[0]).toBe("STT,Họ và tên,Loại giấy tờ,Số giấy tờ,Số phòng,Giờ đến,Quốc tịch,Số hộ chiếu");
    expect(lines[1]).toMatch(/^1,John Smith,passport,X1234567,.+,2026-10-20 14:00,US,X1234567$/);
  });

  it("chống formula injection: tên bắt đầu bằng = → ô có tiền tố ' ; tên có dấu phẩy/ngoặc kép/Unicode được quote đúng", async () => {
    const s = await stayAt(local("20:10"), [
      guest({ fullName: '=HYPERLINK("http://x")' }),
      guest({
        fullName: 'Lê "Bảo", Đặng',
        phone: undefined,
        document: { type: "cccd", number: "012345678901" },
      }),
    ]);
    const body = await csvOf((await ok(doExport(F, s.stay_id))).url);
    const lines = body.split("\r\n");
    expect(lines[1]).toContain(`,"'=HYPERLINK(`); // có dấu " trong ô nên được quote; tiền tố ' nằm trong ô
    expect(lines[1]).not.toMatch(/^1,=/);
    expect(lines[2]).toContain('"Lê ""Bảo"", Đặng"');
    expect(lines[2]).toContain("012345678901"); // số giấy tờ giữ số 0 đầu dạng văn bản
  });

  it("thiếu trường bắt buộc của mẫu (giấy tờ đã ẩn danh) → 422 kèm guests[i].doc_number, không tạo file, không đổi trạng thái", async () => {
    const s = await stayAt(local("20:10"), [
      guest({ fullName: "Phạm Giấy Tờ", document: { type: "cccd", number: "034567890123" } }),
    ]);
    const person = await one(
      sql<{ id: string }>`select primary_guest_person_id as id from stays where id = ${s.stay_id}`,
    );
    await sql`update identity_documents set doc_number = null, anonymized_at = now() where person_id = ${person.id}`.execute(
      t.admin,
    );
    const files = await one(
      sql<{ n: number }>`select count(*)::int as n from files where owner_type = 'residence_notice'`,
    );
    const p = await fails(doExport(F, s.stay_id));
    expect(p).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    expect(p.errors?.map((e) => e.field)).toEqual(["guests[0].doc_number"]);
    expect(await noticeOf(s.stay_id)).toMatchObject({ status: "pending", export_file_id: null });
    const after = await one(
      sql<{ n: number }>`select count(*)::int as n from files where owner_type = 'residence_notice'`,
    );
    expect(after.n).toBe(files.n);
  });

  it("buồng phòng, kế toán, tổ chức khác → 404; không có thông báo (stay lạ) → 404; không rò sự tồn tại", async () => {
    const s = await stayAt(local("20:10"));
    for (const who of [H, K, OB]) {
      expect(await fails(doExport(who, s.stay_id))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    }
    expect(await fails(doExport(F, randomUUID()))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(await fails(doExport(F, "khong-phai-uuid"))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(await noticeOf(s.stay_id)).toMatchObject({ status: "pending" });
  });

  it("file xuất chỉ owner/manager/lễ tân trong phạm vi đọc được ở tầng RLS; buồng phòng/kế toán không thấy hàng", async () => {
    const s = await stayAt(local("20:10"));
    const r = await ok(doExport(F, s.stay_id));
    const count = (actor: Actor) =>
      withTenant(t.runtime, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) =>
        Number(
          (await sql<{ n: string }>`select count(*) as n from files where id = ${r.file_id}`.execute(trx))
            .rows[0]?.n,
        ),
      );
    expect(await count(F)).toBe(1);
    expect(await count(M)).toBe(1);
    expect(await count(H)).toBe(0);
    expect(await count(K)).toBe(0);
    expect(await count(OB)).toBe(0);
  });

  it("getFileUrl cho file xuất: lễ tân/manager nhận URL ký; buồng phòng/kế toán/tổ chức khác → 404", async () => {
    const s = await stayAt(local("20:10"));
    const r = await ok(doExport(F, s.stay_id));
    const url = (actor: Actor) =>
      run(actor, async (ctx) => ({
        data: await getFileUrl(ctx, { storage, scanner: eicarOnlyScanner }, r.file_id),
      }));
    expect((await ok(url(M))).expiresIn).toBe(300);
    for (const who of [H, K, OB])
      expect(await fails(url(who))).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("lệnh lỗi sau khi ghi object (rollback) không để lại file mồ côi ở bản ghi", async () => {
    const s = await stayAt(local("20:10"));
    const before = await one(
      sql<{ n: number }>`select count(*)::int as n from files where owner_type = 'residence_notice'`,
    );
    await expect(
      run(F, async (ctx) => {
        await exportResidenceNotice(ctx, { storage }, { stayId: s.stay_id, now: NOW });
        throw new Error("lỗi giả lập sau khi xuất");
      }),
    ).rejects.toThrow("lỗi giả lập");
    const after = await one(
      sql<{ n: number }>`select count(*)::int as n from files where owner_type = 'residence_notice'`,
    );
    expect(after.n).toBe(before.n);
    expect(await noticeOf(s.stay_id)).toMatchObject({ status: "pending" });
  });
});

describe("residence: đánh dấu đã thông báo (S-029)", () => {
  it("từ exported → submitted: người gửi, kênh, thời điểm UTC, bằng chứng; hệ thống không gửi gì ra ngoài", async () => {
    const s = await stayAt(local("20:10"));
    await ok(doExport(F, s.stay_id));
    const up = await ok(
      run(F, async (ctx) => ({
        data: await uploadFile(
          ctx,
          { storage, scanner: eicarOnlyScanner },
          { ownerType: "residence_notice", propertyId: A.propertyId, bytes: jpeg() },
        ),
      })),
    );
    const n = await noticeOf(s.stay_id);
    const key = randomUUID();
    const r = await ok(
      doSubmit(
        F,
        n.id,
        { submittedAt: new Date("2026-10-16T01:30:00Z"), channel: "online", evidenceFileId: up.fileId },
        key,
      ),
    );
    expect(r).toMatchObject({
      status: "submitted",
      channel: "online",
      submitted_by: F.membershipId,
      has_evidence: true,
      submitted_at: "2026-10-16T01:30:00.000Z",
    });
    expect(await noticeOf(s.stay_id)).toMatchObject({
      status: "submitted",
      submitted_by: F.membershipId,
      evidence_file_id: up.fileId,
    });
    // cùng key → cùng kết quả
    expect(await ok(doSubmit(F, n.id, { channel: "online" }, key))).toEqual(r);
    // key khác khi đã submitted → 409 INVALID_TRANSITION
    expect(await fails(doSubmit(M, n.id))).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
    const audit = await one(
      sql<{
        after: Record<string, unknown>;
      }>`select after from audit_events where action = 'residence_notice.submitted' and entity_id = ${n.id}`,
    );
    expect(audit.after).toMatchObject({
      status: "submitted",
      channel: "online",
      evidence: true,
      after_due: false,
    });
    // xuất lại sau khi đã nộp: vẫn tải được, dòng thông báo không đổi
    const again = await ok(doExport(F, s.stay_id));
    expect(again.status).toBe("submitted");
    expect((await noticeOf(s.stay_id)).export_file_id).not.toBe(again.file_id);
  });

  it("đi thẳng từ pending; nộp sau hạn vẫn hợp lệ (audit after_due)", async () => {
    const s = await stayAt(local("20:10"));
    const n = await noticeOf(s.stay_id);
    await ok(
      doSubmit(M, n.id, { submittedAt: local("23:30"), channel: "in_person" }, undefined, local("23:45")),
    );
    const audit = await one(
      sql<{
        after: Record<string, unknown>;
      }>`select after from audit_events where action = 'residence_notice.submitted' and entity_id = ${n.id}`,
    );
    expect(audit.after.after_due).toBe(true);
  });

  it("submitted_at ở tương lai, kênh lạ, bằng chứng không hợp lệ → 422; buồng phòng/kế toán/tổ chức khác → 404; trạng thái giữ nguyên", async () => {
    const s = await stayAt(local("20:10"));
    const n = await noticeOf(s.stay_id);
    const fut = await fails(doSubmit(F, n.id, { submittedAt: new Date(NOW.getTime() + 1000) }));
    expect(fut).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    expect(fut.errors?.[0]?.field).toBe("submitted_at");
    expect((await fails(doSubmit(F, n.id, { channel: "email" }))).errors?.[0]?.field).toBe("channel");
    expect((await fails(doSubmit(F, n.id, { evidenceFileId: randomUUID() }))).errors?.[0]?.field).toBe(
      "evidence_file_id",
    );
    // file giấy tờ (loại khác) không dùng làm bằng chứng
    const idImg = await ok(
      run(F, async (ctx) => ({
        data: await uploadFile(
          ctx,
          { storage, scanner: eicarOnlyScanner },
          { ownerType: "identity_document", propertyId: A.propertyId, bytes: jpeg() },
        ),
      })),
    );
    expect((await fails(doSubmit(F, n.id, { evidenceFileId: idImg.fileId }))).errors?.[0]?.field).toBe(
      "evidence_file_id",
    );
    for (const who of [H, K, OB])
      expect(await fails(doSubmit(who, n.id))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(await noticeOf(s.stay_id)).toMatchObject({ status: "pending", submitted_at: null });
  });

  it("qua HTTP registry: stay.markNoticeSubmitted + stay.listNotices (schema chặt, 401 khi chưa đăng nhập)", async () => {
    const s = await stayAt(local("20:10"));
    const n = await noticeOf(s.stay_id);
    const def = COMMANDS["stay.markNoticeSubmitted"];
    if (!def) throw new Error("thiếu command");
    const post = (body: unknown, user?: string, key: string = randomUUID()) =>
      handleCommand(
        def,
        new Request("http://x/api/v1/stay/markNoticeSubmitted", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
            "x-org-id": A.orgId,
            ...(user ? { "x-test-user": user } : {}),
          },
          body: JSON.stringify(body),
        }),
        deps,
      );
    const body = { notice_id: n.id, submitted_at: "2026-10-16T01:00:00Z", channel: "in_person" };
    expect((await post(body)).status).toBe(401);
    expect((await post({ ...body, channel: "fax" }, A.ownerAuthUserId)).status).toBe(422);
    expect((await post({ ...body, extra: 1 }, A.ownerAuthUserId)).status).toBe(422);
    const okRes = await post(body, A.ownerAuthUserId);
    expect(okRes.status).toBe(200);
    expect(((await okRes.json()) as { data: { status: string } }).data.status).toBe("submitted");

    const q = QUERIES["stay.listNotices"];
    if (!q) throw new Error("thiếu query");
    const get = (qs: string, user: string) =>
      handleQuery(
        q,
        new Request(`http://x/api/v1/stay/listNotices?${qs}`, {
          headers: { "x-test-user": user, "x-org-id": A.orgId },
        }),
        deps,
      );
    const res = await get(`property_id=${A.propertyId}&status=submitted`, A.ownerAuthUserId);
    expect(res.status).toBe(200);
    expect(
      (await res.json()) as { data?: { items: { notice_id: string }[] }; items?: { notice_id: string }[] },
    ).toBeTruthy();
  });
});

describe("residence: ràng buộc DB (chỉ đi tiến, bất biến, RLS)", () => {
  it("không lùi trạng thái; đã submitted bất biến; không xoá; submitted thiếu người gửi/kênh bị CHECK chặn", async () => {
    const s = await stayAt(local("20:10"));
    await ok(doExport(F, s.stay_id));
    const n = await noticeOf(s.stay_id);
    const back = await pgError(
      sql`update residence_notices set status = 'pending', exported_at = null, exported_by = null, export_file_id = null where id = ${n.id}`.execute(
        t.admin,
      ),
    );
    expect(back.code).toBe("23514");
    expect(back.message).toMatch(/không lùi trạng thái/);
    const noWho = await pgError(
      sql`update residence_notices set status = 'submitted' where id = ${n.id}`.execute(t.admin),
    );
    expect(noWho.message).toMatch(/ck_residence_notices_submitted/);
    await ok(doSubmit(F, n.id));
    const edit = await pgError(
      sql`update residence_notices set channel = 'other' where id = ${n.id}`.execute(t.admin),
    );
    expect(edit.code).toBe("55000");
    const dueEdit = await pgError(
      sql`update residence_notices set due_at = now() where id = ${n.id}`.execute(t.admin),
    );
    expect(dueEdit.code).toBe("55000");
    const del = await pgError(sql`delete from residence_notices where id = ${n.id}`.execute(t.admin));
    expect(del.code).toBeDefined();
    const dup = await pgError(
      sql`insert into residence_notices (id, organization_id, property_id, stay_id) values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${s.stay_id})`.execute(
        t.admin,
      ),
    );
    expect(dup.message).toMatch(/uq_residence_notices_stay/);
    const bornSubmitted = await pgError(
      sql`insert into residence_notices (id, organization_id, property_id, stay_id, status) values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${randomUUID()}, 'submitted')`.execute(
        t.admin,
      ),
    );
    expect(bornSubmitted.code).toBeDefined();
  });

  it("RLS: owner/manager/lễ tân thấy; buồng phòng và kế toán không thấy hàng nào; tổ chức khác không thấy", async () => {
    const total = Number(
      (
        await one(
          sql<{ n: string }>`select count(*) as n from residence_notices where organization_id = ${A.orgId}`,
        )
      ).n,
    );
    expect(total).toBeGreaterThan(5);
    const count = (actor: Actor) =>
      withTenant(t.runtime, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) =>
        Number(
          (await sql<{ n: string }>`select count(*) as n from residence_notices`.execute(trx)).rows[0]?.n,
        ),
      );
    expect(await count(O)).toBe(total);
    expect(await count(M)).toBe(total);
    expect(await count(F)).toBe(total);
    expect(await count(H)).toBe(0);
    expect(await count(K)).toBe(0);
    expect(await count(OB)).toBe(0);
    // housekeeping không ghi được ngay cả khi truy vấn thẳng
    const w = await pgError(
      withTenant(t.runtime, { orgId: H.orgId, actorId: H.membershipId }, (trx) =>
        sql`update residence_notices set due_at = null`.execute(trx).then((r) => {
          if (Number(r.numAffectedRows ?? 0) > 0) throw new Error("buồng phòng sửa được");
          throw new Error("không dòng nào bị ảnh hưởng");
        }),
      ),
    );
    expect(w.message).toBe("không dòng nào bị ảnh hưởng");
  });
});

describe("residence: stay.listNotices (quá hạn nổi lên đầu)", () => {
  it("sắp xếp quá hạn → sắp tới hạn → chưa có hạn → đã nộp; lọc status/due_before; quyền theo vai trò/phạm vi", async () => {
    const b = await member("manager", B);
    expect(b.orgId).toBe(B.orgId);
    const now = local("23:50");
    const list = await listNotices(t.runtime, F, { propertyId: A.propertyId, now });
    const flags = list.items.map((i) =>
      i.status === "submitted" ? "S" : i.overdue ? "O" : i.due_at ? "D" : "N",
    );
    // chuỗi có dạng O…O D…D N…N S…S (đi tới, không xen kẽ)
    expect(flags.join("")).toMatch(/^O*D*N*S*$/);
    expect(flags).toContain("O");
    expect(flags).toContain("S");
    const overdue = list.items.filter((i) => i.overdue).map((i) => i.due_at as string);
    expect([...overdue].sort()).toEqual(overdue); // hạn cũ nhất trước
    const onlySubmitted = await listNotices(t.runtime, F, {
      propertyId: A.propertyId,
      status: "submitted",
      now,
    });
    expect(onlySubmitted.items.every((i) => i.status === "submitted")).toBe(true);
    const dueBefore = await listNotices(t.runtime, F, {
      propertyId: A.propertyId,
      dueBefore: local("23:00"),
      now,
    });
    expect(dueBefore.items.every((i) => i.due_at !== null && new Date(i.due_at) <= local("23:00"))).toBe(
      true,
    );
    const limited = await listNotices(t.runtime, F, { propertyId: A.propertyId, limit: 2, now });
    expect(limited.items).toHaveLength(2);
    // quyền
    for (const who of [H, K])
      await expect(listNotices(t.runtime, who, { propertyId: A.propertyId })).rejects.toMatchObject({
        status: 404,
      });
    // owner tổ chức khác có "mọi cơ sở" của tổ chức B: RLS không cho thấy hàng nào của A (không lộ dữ liệu).
    expect((await listNotices(t.runtime, OB, { propertyId: A.propertyId })).items).toEqual([]);
    await expect(listNotices(t.runtime, b, { propertyId: A.propertyId })).rejects.toMatchObject({
      status: 404,
    });
    const empty = await listNotices(t.runtime, OB, { propertyId: B.propertyId });
    expect(empty.items).toEqual([]);
  });
});

describe("residence: job nhắc hạn (SPEC-notifications S-014, S-015, S-016, S-021)", () => {
  const events = (noticeId: string) =>
    rows(
      sql<{ organization_id: string; payload: { phase: string; business_date: string }; dedupe_key: string }>`
        select organization_id, payload, dedupe_key from outbox
        where event_type = 'stay_notice.reminder' and aggregate_id = ${noticeId} order by created_at, id`,
    );

  it("nhắc đầu (due) khi có hạn; chạy lại/chạy song song vẫn một sự kiện", async () => {
    const s = await stayAt(local("20:10")); // hạn 23:00
    const n = await noticeOf(s.stay_id);
    const first = await scanResidenceNotices(t.worker, local("20:20"));
    expect(first.created).toBeGreaterThanOrEqual(1);
    const ev = await events(n.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload.phase).toBe("due");
    expect(ev[0]?.organization_id).toBe(A.orgId);
    expect((await scanResidenceNotices(t.worker, local("20:20"))).created).toBe(0);
    await Promise.all(Array.from({ length: 4 }, () => scanResidenceNotices(t.worker, local("20:25"))));
    expect(await events(n.id)).toHaveLength(1);
  });

  it("Khẩn khi còn ≤ 30 phút (ranh giới 22:29 không, 22:30 có); Quá hạn mỗi ngày kinh doanh đúng một lần; ngày kế lại một lần", async () => {
    const s = await stayAt(local("20:10"));
    const n = await noticeOf(s.stay_id);
    await scanResidenceNotices(t.worker, local("22:29")); // còn 31 phút → vẫn nhắc đầu
    expect((await events(n.id)).map((e) => e.payload.phase)).toEqual(["due"]);
    await scanResidenceNotices(t.worker, local("22:30")); // còn đúng 30 phút → Khẩn
    expect((await events(n.id)).map((e) => e.payload.phase)).toEqual(["due", "urgent"]);
    await scanResidenceNotices(t.worker, local("22:45"));
    expect(await events(n.id)).toHaveLength(2);
    await scanResidenceNotices(t.worker, local("23:00")); // đúng hạn → Quá hạn
    const ev = await events(n.id);
    expect(ev.map((e) => e.payload.phase)).toEqual(["due", "urgent", "overdue"]);
    expect(ev[2]?.dedupe_key).toBe(`stay_notice.overdue:${n.id}:2026-10-20`);
    await scanResidenceNotices(t.worker, local("23:15"));
    await scanResidenceNotices(t.worker, local("23:45"));
    expect(await events(n.id)).toHaveLength(3); // các lần sau trong cùng ngày: không thêm
    await scanResidenceNotices(t.worker, local("09:00", 21)); // ngày kinh doanh 21/10
    const ev2 = await events(n.id);
    expect(ev2).toHaveLength(4);
    expect(ev2[3]?.dedupe_key).toBe(`stay_notice.overdue:${n.id}:2026-10-21`);
    // 03:59 vẫn thuộc ngày kinh doanh hôm trước (giờ chốt 04:00): không phát thêm
    await scanResidenceNotices(t.worker, local("03:59", 22));
    expect(await events(n.id)).toHaveLength(4);
    await scanResidenceNotices(t.worker, local("04:00", 22)); // sang ngày kinh doanh 22/10
    expect(await events(n.id)).toHaveLength(5);
  });

  it("lỡ nhiều lượt: lần quét đầu rơi vào cửa sổ Khẩn chỉ phát Khẩn (không dồn nhắc đầu)", async () => {
    const s = await stayAt(local("22:40"));
    const n = await noticeOf(s.stay_id); // hạn 23:00
    await scanResidenceNotices(t.worker, local("22:50"));
    expect((await events(n.id)).map((e) => e.payload.phase)).toEqual(["urgent"]);
  });

  it("dừng nhắc khi đã nộp (trước hay sau hạn); exported vẫn được nhắc; chưa có hạn không nhắc", async () => {
    const a = await stayAt(local("20:10"));
    const b = await stayAt(local("20:10"));
    const na = await noticeOf(a.stay_id);
    const nb = await noticeOf(b.stay_id);
    await ok(doExport(F, b.stay_id)); // exported chưa phải đã nộp
    await ok(doSubmit(F, na.id, { submittedAt: local("20:30") }, undefined, local("20:31")));
    await scanResidenceNotices(t.worker, local("23:30"));
    expect(await events(na.id)).toHaveLength(0);
    expect((await events(nb.id)).map((e) => e.payload.phase)).toEqual(["overdue"]);
    // nộp sau khi đã quá hạn và đã có nhắc → ngày sau không nhắc nữa
    await ok(doSubmit(F, nb.id, { submittedAt: local("23:40") }, undefined, local("23:41")));
    await scanResidenceNotices(t.worker, local("09:00", 21));
    expect(await events(nb.id)).toHaveLength(1);
  });

  it("thông báo tạo cho owner/manager/lễ tân trong phạm vi — không cho buồng phòng/kế toán; mức Khẩn/Quá hạn; trùng không nhân đôi; đã nộp trước khi dispatch → không tạo", async () => {
    const s = await stayAt(local("20:10"));
    const n = await noticeOf(s.stay_id);
    const fire = async (at: Date) => {
      await scanResidenceNotices(t.worker, at);
      const evs = await rows(
        sql<{ id: string; organization_id: string; event_type: string; payload: Record<string, unknown> }>`
          select id, organization_id, event_type, payload from outbox
          where event_type = 'stay_notice.reminder' and aggregate_id = ${n.id} order by created_at, id`,
      );
      for (const e of evs)
        await dispatchNotificationEvent(
          t.worker,
          {
            organization_id: e.organization_id,
            outbox_id: e.id,
            event_type: e.event_type,
            payload: e.payload,
          },
          at,
        );
    };
    const notes = () =>
      rows(
        sql<{
          title: string;
          severity: string;
          type: string;
          link: string;
          dedupe_key: string;
          recipient: string;
        }>`
          select title, severity, type, link, dedupe_key, recipient_person_id as recipient from notifications
          where dedupe_key like ${`stay_notice_%:${n.id}%`} order by created_at, id`,
      );
    await fire(local("20:20"));
    let got = await notes();
    const recipients = new Set(got.map((g) => g.recipient));
    expect(recipients).toEqual(new Set([O.personId, M.personId, F.personId]));
    expect(recipients.has(H.personId)).toBe(false);
    expect(recipients.has(K.personId)).toBe(false);
    expect(got[0]).toMatchObject({
      type: "stay_notice_due",
      severity: "normal",
      title: expect.stringMatching(/^Phòng .+: cần thông báo lưu trú trước 23:00 20\/10\/2026$/),
      link: `/luu-tru/${s.stay_id}/thong-bao`,
    });
    // D-010: chỉ trong app — không có lần gửi email nào (không gửi gì ra ngoài).
    expect(
      await rows(
        sql`select 1 from notification_deliveries d join notifications n on n.id = d.notification_id where n.type = 'stay_notice_due'`,
      ),
    ).toHaveLength(0);
    await fire(local("20:20")); // dispatch lần hai: không nhân đôi
    expect(await notes()).toHaveLength(3);
    await fire(local("22:40"));
    await fire(local("23:10"));
    got = await notes();
    expect(got.filter((g) => g.severity === "urgent")).toHaveLength(3);
    expect(got.filter((g) => g.severity === "overdue")).toHaveLength(3);
    expect(
      got
        .filter((g) => g.severity === "overdue")
        .every((g) => g.dedupe_key === `stay_notice_overdue:${n.id}:2026-10-20`),
    ).toBe(true);
    // đã nộp ngay trước lúc dispatch sự kiện cũ → mapper không tạo thêm (lớp phòng thủ thứ hai)
    await ok(doSubmit(F, n.id, { submittedAt: local("23:15") }, undefined, local("23:16")));
    await fire(local("09:00", 21));
    expect(await notes()).toHaveLength(9);
  });

  it("chéo tenant: sự kiện nhắc chỉ mang tổ chức của thông báo; tổ chức B không có thông báo thì không có sự kiện", async () => {
    const all = await rows(
      sql<{
        organization_id: string;
      }>`select distinct organization_id from outbox where event_type = 'stay_notice.reminder'`,
    );
    expect(all.map((r) => r.organization_id)).toEqual([A.orgId]);
    // dispatch sự kiện của A nhưng ép sang B: không tìm thấy thông báo ⇒ không tạo gì
    const one1 = await one(
      sql<{
        id: string;
        payload: Record<string, unknown>;
      }>`select id, payload from outbox where event_type = 'stay_notice.reminder' limit 1`,
    );
    const r = await dispatchNotificationEvent(
      t.worker,
      {
        organization_id: B.orgId,
        outbox_id: one1.id,
        event_type: "stay_notice.reminder",
        payload: one1.payload,
      },
      local("23:10"),
    );
    expect(r).toEqual({ created: 0, duplicates: 0 });
  });
});
