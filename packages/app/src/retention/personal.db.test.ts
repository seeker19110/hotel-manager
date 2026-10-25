// T-2308 (STD-PRIV-005, XC-GREEN-007; D-116) — dọn/ẩn danh dữ liệu cá nhân và các bảng còn lại theo hạn giữ, trên Postgres thật,
// bằng vai trò `app_worker` như worker chạy thật: quá hạn bị xoá/ẩn danh, chưa quá hạn (kể cả ĐÚNG mốc) còn nguyên; người còn quan
// hệ hiệu lực không bị đụng; sổ tiền (khoá ngoại, số tiền) nguyên vẹn; app_runtime không gọi được hàm; chạy song song an toàn.
import { randomUUID } from "node:crypto";
import { migrations } from "@hm/db";
import { MS_PER_DAY } from "@hm/domain";
import {
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedIssuedInvoice,
  seedOrg,
  seedReservation,
  type TestDb,
} from "@hm/testkit";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRetention } from "../import/retention.ts";
import {
  AUTH_SESSION_GRACE_DAYS,
  AUTH_VERIFICATION_GRACE_DAYS,
  GUEST_LINK_GRACE_DAYS,
  IDENTITY_DOCUMENT_RETENTION_MONTHS,
  INBOX_RAW_RETENTION_YEARS,
  NOTIFICATION_RETENTION_DAYS,
  PERSON_RETENTION_YEARS,
  purgePersonalData,
  WORKER_HEARTBEAT_STALE_DAYS,
} from "./index.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;

// Mốc "bây giờ" của test: không vượt đồng hồ CSDL (hàm chặn mốc bởi now()).
const NOW = new Date(Date.now() - 1000);
const DAY = MS_PER_DAY;
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs).toISOString();
const shift = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà nghỉ Hoa Sen", "hotel");
  B = await seedOrg(t.admin, "Nhà trọ khác", "rental");
});

afterAll(async () => {
  await t?.drop();
});

/** Mốc tính bởi CSDL trong phiên worker (cùng phép tính lịch tháng/năm như hàm dọn). */
async function cutoff(unit: "months" | "years", n: number): Promise<string> {
  const r = await sql<{ b: Date }>`
    select (${NOW}::timestamptz - make_interval(${sql.raw(unit)} => ${n}::int)) as b`.execute(t.worker);
  return (r.rows[0] as { b: Date }).b.toISOString();
}

async function alive(table: string, ids: string[], key = "id"): Promise<Set<string>> {
  const r = await sql<{ k: string }>`
    select ${sql.ref(key)}::text as k from ${sql.table(table)} where ${sql.ref(key)}::text = any(${ids}::text[])`.execute(
    t.admin,
  );
  return new Set(r.rows.map((x) => x.k));
}

// ───────────────────────── notifications ─────────────────────────

async function notification(
  org: SeededOrg,
  createdAt: string,
  delivery?: "queued" | "sent",
): Promise<string> {
  const id = randomUUID();
  await sql`insert into notifications (id, organization_id, recipient_person_id, type, title, body, dedupe_key, created_at)
            values (${id}, ${org.orgId}, ${org.ownerPersonId}, 'invoice_issued', 'Thông báo giả', 'Nội dung giả', ${`n-${id}`},
                    ${createdAt})`.execute(t.admin);
  if (delivery)
    await sql`insert into notification_deliveries (id, organization_id, notification_id, status, next_attempt_at, sent_at,
                                                    created_at, updated_at)
              values (${randomUUID()}, ${org.orgId}, ${id}, ${delivery}, ${delivery === "queued" ? createdAt : null},
                      ${delivery === "sent" ? NOW.toISOString() : null}, ${createdAt}, ${NOW.toISOString()})`.execute(
      t.admin,
    );
  return id;
}

describe("notifications (RET-11)", () => {
  it("quá 180 ngày và không còn lần gửi bị xoá (mọi tổ chức); đúng mốc, chưa tới mốc, còn lần gửi được giữ", async () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBe(180);
    const old = await notification(A, ago(181));
    const oldOther = await notification(B, ago(400));
    const justOver = await notification(A, ago(180, 1000));
    const atBoundary = await notification(A, ago(180));
    const recent = await notification(A, ago(179));
    const pendingDelivery = await notification(A, ago(400), "queued"); // lần gửi chưa xong ⇒ giữ thông báo cha
    const doneDelivery = await notification(A, ago(400), "sent"); // lần gửi còn (chưa tới hạn dọn RET-04) ⇒ giữ
    const all = [old, oldOther, justOver, atBoundary, recent, pendingDelivery, doneDelivery];
    const s = await purgePersonalData(t.worker, { now: NOW });
    expect(s.notifications).toBe(3);
    expect(await alive("notifications", all)).toEqual(
      new Set([atBoundary, recent, pendingDelivery, doneDelivery]),
    );
    expect((await purgePersonalData(t.worker, { now: NOW })).notifications).toBe(0); // chạy lại: idempotent
  });
});

// ───────────────────────── worker_heartbeats ─────────────────────────

describe("worker_heartbeats (RET-12)", () => {
  it("không cập nhật quá 30 ngày bị xoá; đúng mốc và mới được giữ", async () => {
    expect(WORKER_HEARTBEAT_STALE_DAYS).toBe(30);
    const rows: [string, string][] = [
      ["w-old", ago(31)],
      ["w-just-over", ago(30, 1000)],
      ["w-boundary", ago(30)],
      ["w-fresh", ago(0)],
    ];
    for (const [name, at] of rows)
      await sql`insert into worker_heartbeats (name, beat_at, started_at) values (${name}, ${at}, ${at})`.execute(
        t.admin,
      );
    const s = await purgePersonalData(t.worker, { now: NOW });
    expect(s.workerHeartbeats).toBe(2);
    expect(
      await alive(
        "worker_heartbeats",
        rows.map(([n]) => n),
        "name",
      ),
    ).toEqual(new Set(["w-boundary", "w-fresh"]));
  });
});

// ───────────────────────── auth.session / auth.verification ─────────────────────────

async function session(userId: string, expiresAt: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into auth."session" (id, "expiresAt", token, "updatedAt", "ipAddress", "userAgent", "userId")
            values (${id}, ${expiresAt}, ${`tok-${id}`}, ${expiresAt}, '203.0.113.9', 'test-agent', ${userId})`.execute(
    t.admin,
  );
  return id;
}

async function verification(expiresAt: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into auth."verification" (id, identifier, value, "expiresAt")
            values (${id}, ${`otp-${id}`}, 'hash-gia', ${expiresAt})`.execute(t.admin);
  return id;
}

describe("phiên đăng nhập và mã xác minh Better Auth (RET-13, RET-14)", () => {
  it("phiên hết hạn quá 30 ngày bị xoá; mã xác minh hết hạn quá 1 ngày bị xoá; đúng mốc, còn hạn được giữ", async () => {
    expect(AUTH_SESSION_GRACE_DAYS).toBe(30);
    expect(AUTH_VERIFICATION_GRACE_DAYS).toBe(1);
    const user = await seedAuthUser(t.admin, `s+${randomUUID().slice(0, 8)}@example.test`);
    const sOld = await session(user, ago(31));
    const sJustOver = await session(user, ago(30, 1000));
    const sBoundary = await session(user, ago(30));
    const sExpiredRecently = await session(user, ago(2));
    const sLive = await session(user, ago(-1));
    const vOld = await verification(ago(1, 1000));
    const vBoundary = await verification(ago(1));
    const vFresh = await verification(ago(0.5));
    const vLive = await verification(ago(-0.01));
    const s = await purgePersonalData(t.worker, { now: NOW });
    expect(s.authSessions).toBe(2);
    expect(s.authVerifications).toBe(1);
    expect(await alive("auth.session", [sOld, sJustOver, sBoundary, sExpiredRecently, sLive])).toEqual(
      new Set([sBoundary, sExpiredRecently, sLive]),
    );
    expect(await alive("auth.verification", [vOld, vBoundary, vFresh, vLive])).toEqual(
      new Set([vBoundary, vFresh, vLive]),
    );
    // Người dùng không bị đụng (chỉ phiên).
    expect(await alive("auth.user", [user])).toEqual(new Set([user]));
  });
});

// ───────────────────────── guest_access_links ─────────────────────────

async function guestLink(org: SeededOrg, expiresAt: string, revokedAt?: string): Promise<string> {
  const { reservationId } = await seedReservation(t.admin, { org, bookerPersonId: org.ownerPersonId });
  const id = randomUUID();
  const createdAt = shift(revokedAt && revokedAt < expiresAt ? revokedAt : expiresAt, -2 * DAY);
  await sql`insert into guest_access_links (id, organization_id, property_id, reservation_id, token_hash, expires_at, created_by,
                                            created_at, revoked_at, revoked_by)
            values (${id}, ${org.orgId}, ${org.propertyId}, ${reservationId}, decode(${randomUUID().replaceAll("-", "").repeat(2)}, 'hex'),
                    ${expiresAt}, ${org.ownerMembershipId}, ${createdAt}, ${revokedAt ?? null},
                    ${revokedAt ? org.ownerMembershipId : null})`.execute(t.admin);
  return id;
}

describe("guest_access_links (RET-15)", () => {
  it("kết thúc (hết hạn hoặc thu hồi — mốc sớm hơn) quá 90 ngày bị xoá; đúng mốc, còn hiệu lực được giữ", async () => {
    expect(GUEST_LINK_GRACE_DAYS).toBe(90);
    const expiredOld = await guestLink(A, ago(91));
    const expiredJustOver = await guestLink(B, ago(90, 1000));
    const expiredBoundary = await guestLink(A, ago(90));
    const revokedOld = await guestLink(A, ago(10), ago(91)); // hết hạn gần đây nhưng đã thu hồi từ 91 ngày trước
    const revokedRecent = await guestLink(A, ago(-200), ago(89));
    const live = await guestLink(A, ago(-2));
    const all = [expiredOld, expiredJustOver, expiredBoundary, revokedOld, revokedRecent, live];
    const s = await purgePersonalData(t.worker, { now: NOW });
    expect(s.guestAccessLinks).toBe(3);
    expect(await alive("guest_access_links", all)).toEqual(new Set([expiredBoundary, revokedRecent, live]));
  });
});

// ───────────────────────── inbox.raw ─────────────────────────

async function inbox(
  org: SeededOrg,
  receivedAt: string,
  status: "pending" | "processed" | "ignored" = "processed",
) {
  const id = randomUUID();
  await sql`insert into inbox (id, organization_id, provider, account, provider_event_id, payload_hash, raw, signature_verified,
                               process_status, received_at)
            values (${id}, ${org.orgId}, 'testbank', ${randomUUID()}, ${`ev-${id}`}, ${"c".repeat(64)},
                    '{"so_tien": 500000, "noi_dung": "chuyen khoan gia"}'::jsonb, true, ${status}, ${receivedAt})`.execute(
    t.admin,
  );
  return id;
}

/** Đầu năm (giờ VN) của năm hiện tại − n: hàng nhận TRƯỚC mốc này mới hết hạn giữ n năm (tính từ hết năm nhận). */
async function inboxBoundary(years: number): Promise<string> {
  const r = await sql<{ b: Date }>`
    select ((date_trunc('year', ${NOW}::timestamptz at time zone 'Asia/Ho_Chi_Minh') - make_interval(years => ${years}::int))
            at time zone 'Asia/Ho_Chi_Minh') as b`.execute(t.admin);
  return (r.rows[0] as { b: Date }).b.toISOString();
}

describe("inbox — sổ phụ ngân hàng thô (RET-16)", () => {
  it("qua 10 năm tính từ hết năm nhận: làm rỗng raw, GIỮ dòng (hash, mã sự kiện); đúng mốc, pending, mới: nguyên", async () => {
    expect(INBOX_RAW_RETENTION_YEARS).toBe(10);
    const boundary = await inboxBoundary(10); // 00:00 01/01/(năm nay − 10) giờ VN
    const old = await inbox(A, shift(boundary, -400 * DAY));
    const justBefore = await inbox(B, shift(boundary, -1000)); // 23:59:59 31/12 năm (nay − 11) ⇒ hết hạn
    const atBoundary = await inbox(A, boundary); // nhận đầu năm (nay − 10) ⇒ còn giữ tới hết năm nay
    const pendingOld = await inbox(A, shift(boundary, -400 * DAY), "pending");
    const recent = await inbox(A, ago(30));
    const all = [old, justBefore, atBoundary, pendingOld, recent];
    const s = await purgePersonalData(t.worker, { now: NOW });
    expect(s.inboxRaw).toBe(2);
    const rows = await sql<{ id: string; raw: unknown; payload_hash: string; provider_event_id: string }>`
      select id, raw, payload_hash, provider_event_id from inbox where id = any(${all}::uuid[])`.execute(
      t.admin,
    );
    expect(rows.rows).toHaveLength(all.length); // không dòng nào bị xoá
    const raw = new Map(rows.rows.map((r) => [r.id, r.raw]));
    expect(raw.get(old)).toEqual({});
    expect(raw.get(justBefore)).toEqual({});
    for (const keep of [atBoundary, pendingOld, recent])
      expect(raw.get(keep)).toEqual({ so_tien: 500000, noi_dung: "chuyen khoan gia" });
    for (const r of rows.rows) {
      expect(r.payload_hash).toBe("c".repeat(64));
      expect(r.provider_event_id).toBe(`ev-${r.id}`);
    }
    expect((await purgePersonalData(t.worker, { now: NOW })).inboxRaw).toBe(0);
  });

  it("bất biến inbox vẫn giữ: không làm rỗng raw hàng còn hạn/pending, không sửa raw khác '{}', không xoá dòng", async () => {
    const boundary = await inboxBoundary(10);
    const recent = await inbox(A, ago(1));
    const pendingOld = await inbox(A, shift(boundary, -400 * DAY), "pending");
    const old = await inbox(A, shift(boundary, -400 * DAY));
    await expect(
      sql`update inbox set raw = '{}'::jsonb where id = ${recent}`.execute(t.admin),
    ).rejects.toThrow(/không được sửa/);
    await expect(
      sql`update inbox set raw = '{}'::jsonb where id = ${pendingOld}`.execute(t.admin),
    ).rejects.toThrow(/không được sửa/);
    await expect(
      sql`update inbox set raw = '{"x":1}'::jsonb where id = ${old}`.execute(t.admin),
    ).rejects.toThrow(/không được sửa/);
    await expect(
      sql`update inbox set payload_hash = ${"d".repeat(64)} where id = ${old}`.execute(t.admin),
    ).rejects.toThrow(/không được sửa/);
    await expect(sql`delete from inbox where id = ${old}`.execute(t.admin)).rejects.toThrow(/append-only/);
    // Hàm dọn với số năm < 10 vẫn không đụng hàng chưa qua sàn 10 năm của luật.
    const nineYears = await inbox(A, shift(await inboxBoundary(9), -DAY));
    await sql`select app.purge_inbox_raw(${NOW}, 1, 1000)`.execute(t.worker);
    const r = await sql<{ raw: unknown }>`select raw from inbox where id = ${nineYears}`.execute(t.admin);
    expect(r.rows[0]?.raw).not.toEqual({});
  });
});

// ───────────────────────── identity_documents / persons ─────────────────────────

async function person(org: SeededOrg, createdAt: string = ago(5000)): Promise<string> {
  const id = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, phone, email, address, nationality, created_at, updated_at)
            values (${id}, ${org.orgId}, 'Nguyễn Văn Giả', '0100000266', ${`p+${id.slice(0, 8)}@example.test`}, '1 Đường Giả',
                    'VN', ${createdAt}, ${createdAt})`.execute(t.admin);
  return id;
}

async function stay(
  org: SeededOrg,
  guest: string,
  status: "in_house" | "checked_out" | "expected",
  endedAt: string = ago(0),
  additional: string[] = [],
): Promise<string> {
  const { itemId } = await seedReservation(t.admin, { org, bookerPersonId: org.ownerPersonId });
  const id = randomUUID();
  const inAt = status === "expected" ? null : shift(endedAt, -2 * DAY);
  await sql`insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, primary_guest_person_id,
                               additional_guest_person_ids, status, checked_in_at, checked_out_at, created_at, updated_at)
            values (${id}, ${org.orgId}, ${org.propertyId}, ${itemId}, ${org.unitId}, ${guest}, ${additional}::uuid[], ${status},
                    ${inAt}, ${status === "checked_out" ? endedAt : null}, ${shift(endedAt, -3 * DAY)}, ${endedAt})`.execute(
    t.admin,
  );
  return id;
}

async function lease(
  org: SeededOrg,
  rep: string,
  status: "active" | "closed",
  endedAt: string = ago(0),
  occupant?: string,
): Promise<string> {
  const id = randomUUID();
  const day = endedAt.slice(0, 10);
  await t.admin.transaction().execute(async (trx) => {
    await sql`insert into leases (id, organization_id, property_id, unit_id, number, billing_start_on, representative_person_id,
                                  status, signed_on, moved_out_on, created_at, updated_at)
              values (${id}, ${org.orgId}, ${org.propertyId}, ${org.unitId}, ${`HD-R${id.slice(0, 8)}`}, ${day}::date - 365, ${rep},
                      ${status}, ${day}::date - 366, ${status === "closed" ? day : null}::date, ${shift(endedAt, -400 * DAY)},
                      ${endedAt})`.execute(trx);
    await sql`insert into lease_versions (id, organization_id, property_id, lease_id, version_no, kind, effective_from, rent_amount,
                                          deposit_amount)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${id}, 1, 'original', ${day}::date - 365, 3000000, 0)`.execute(
      trx,
    );
    await sql`insert into lease_occupants (id, organization_id, property_id, lease_id, person_id, role, is_representative, from_on,
                                           updated_at)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${id}, ${rep}, 'primary', true, ${day}::date - 365,
                      ${endedAt})`.execute(trx);
    if (occupant)
      await sql`insert into lease_occupants (id, organization_id, property_id, lease_id, person_id, role, is_representative,
                                             from_on, updated_at)
                values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${id}, ${occupant}, 'occupant', false,
                        ${day}::date - 365, ${endedAt})`.execute(trx);
  });
  return id;
}

/** Giấy tờ + ảnh (file `ready`, owner = giấy tờ). */
async function idDoc(
  org: SeededOrg,
  personId: string,
  retentionUntil?: string,
): Promise<{ docId: string; fileId: string }> {
  const docId = randomUUID();
  const fileId = randomUUID();
  await sql`insert into files (id, organization_id, storage_key, mime, sha256, size_bytes, status, exif_stripped, owner_type, owner_id,
                               created_at)
            values (${fileId}, ${org.orgId}, ${`${org.orgId}/identity/${fileId}.jpg`}, 'image/jpeg', ${"e".repeat(64)}, 1234,
                    'ready', true, 'identity_document', ${docId}, ${ago(5000)})`.execute(t.admin);
  await sql`insert into identity_documents (id, organization_id, person_id, doc_type, doc_number_enc, doc_number_key_id,
                                            doc_number_hash, doc_number_last4, nationality, file_id, retention_until, created_at)
            values (${docId}, ${org.orgId}, ${personId}, 'cccd', decode(${`01${"ab".repeat(40)}`}, 'hex'), 1,
                    decode(${randomUUID().replaceAll("-", "").repeat(2)}, 'hex'), '1234', 'VN', ${fileId}, ${retentionUntil ?? null}::date,
                    ${ago(5000)})`.execute(t.admin);
  return { docId, fileId };
}

interface DocRow {
  id: string;
  anonymized: boolean;
  enc: boolean;
  hash: boolean;
  last4: string | null;
  nationality: string | null;
  file_id: string | null;
  doc_type: string;
}
async function docs(ids: string[]): Promise<Map<string, DocRow>> {
  const r = await sql<DocRow>`
    select id, anonymized_at is not null as anonymized, doc_number_enc is not null as enc, doc_number_hash is not null as hash,
           doc_number_last4 as last4, nationality, file_id, doc_type
    from identity_documents where id = any(${ids}::uuid[])`.execute(t.admin);
  return new Map(r.rows.map((x) => [x.id, x]));
}

describe("identity_documents (RET-17)", () => {
  it("ẩn danh 12 tháng sau quan hệ lưu trú/thuê cuối; còn hiệu lực, 11 tháng, đúng mốc, retention_until chưa qua: nguyên", async () => {
    expect(IDENTITY_DOCUMENT_RETENTION_MONTHS).toBe(12);
    const cut = await cutoff("months", 12);
    const monthsAgo = (m: number) => shift(NOW.toISOString(), -m * 30.5 * DAY);
    const p = {
      inHouse: await person(A),
      leaseActive: await person(A),
      occupantActive: await person(A),
      additionalInHouse: await person(A),
      openReservation: await person(A),
      ended11m: await person(A),
      boundary: await person(A),
      held: await person(A),
      ended13m: await person(A),
      leaseClosed13m: await person(B),
      justOver: await person(A),
    };
    // Còn quan hệ hiệu lực (kể cả lượt cũ đã kết thúc từ lâu) ⇒ không đụng.
    await stay(A, p.inHouse, "checked_out", monthsAgo(30));
    await stay(A, p.inHouse, "in_house");
    await lease(A, p.leaseActive, "active");
    await lease(A, await person(A, ago(1)), "active", ago(0), p.occupantActive);
    await stay(A, await person(A, ago(1)), "in_house", ago(0), [p.additionalInHouse]);
    await stay(A, p.openReservation, "checked_out", monthsAgo(30));
    await seedReservation(t.admin, { org: A, bookerPersonId: p.openReservation }); // đặt phòng `draft` mới
    // Hết quan hệ nhưng chưa đủ hạn.
    await stay(A, p.ended11m, "checked_out", monthsAgo(11));
    await stay(A, p.boundary, "checked_out", cut); // đúng mốc ⇒ giữ
    await stay(A, p.held, "checked_out", monthsAgo(30));
    // Quá hạn.
    await stay(A, p.ended13m, "checked_out", monthsAgo(13));
    await lease(B, p.leaseClosed13m, "closed", monthsAgo(13));
    await stay(A, p.justOver, "checked_out", shift(cut, -1000));

    const d = {
      inHouse: await idDoc(A, p.inHouse),
      leaseActive: await idDoc(A, p.leaseActive),
      occupantActive: await idDoc(A, p.occupantActive),
      additionalInHouse: await idDoc(A, p.additionalInHouse),
      openReservation: await idDoc(A, p.openReservation),
      ended11m: await idDoc(A, p.ended11m),
      boundary: await idDoc(A, p.boundary),
      held: await idDoc(A, p.held, ago(-30).slice(0, 10)),
      ended13m: await idDoc(A, p.ended13m),
      leaseClosed13m: await idDoc(B, p.leaseClosed13m),
      justOver: await idDoc(A, p.justOver),
    };
    const s = await purgePersonalData(t.worker, { now: NOW });
    expect(s.identityDocuments).toBe(3);
    const rows = await docs(Object.values(d).map((x) => x.docId));
    const gone = new Set([d.ended13m.docId, d.leaseClosed13m.docId, d.justOver.docId]);
    for (const [name, { docId, fileId }] of Object.entries(d)) {
      const r = rows.get(docId) as DocRow;
      if (gone.has(docId)) {
        expect(r, name).toMatchObject({
          anonymized: true,
          enc: false,
          hash: false,
          last4: null,
          nationality: null,
          file_id: null,
        });
        expect(r.doc_type, name).toBe("cccd"); // tombstone: loại giấy tờ giữ lại
      } else {
        expect(r, name).toMatchObject({
          anonymized: false,
          enc: true,
          hash: true,
          last4: "1234",
          nationality: "VN",
          file_id: fileId,
        });
      }
    }
    // Ảnh giấy tờ đã ẩn danh: hẹn xoá hôm nay (UTC) — job import.retention xoá object rồi đánh dấu `deleted`; ảnh khác không đụng.
    const files = await sql<{ id: string; delete_after: string | null }>`
      select id, to_char(delete_after, 'YYYY-MM-DD') as delete_after from files
      where id = any(${Object.values(d).map((x) => x.fileId)}::uuid[])`.execute(t.admin);
    const today = NOW.toISOString().slice(0, 10);
    for (const f of files.rows) {
      const due = [d.ended13m.fileId, d.leaseClosed13m.fileId, d.justOver.fileId].includes(f.id);
      expect(f.delete_after).toBe(due ? today : null);
    }
    const deleted: string[] = [];
    await runRetention(t.worker, { delete: async (key: string) => void deleted.push(key) }, { now: NOW });
    expect(deleted.sort()).toEqual(
      [d.ended13m, d.leaseClosed13m, d.justOver]
        .map((x) => `${x === d.leaseClosed13m ? B.orgId : A.orgId}/identity/${x.fileId}.jpg`)
        .sort(),
    );
    const st = await sql<{ n: number }>`
      select count(*)::int as n from files where id = any(${[d.ended13m.fileId, d.leaseClosed13m.fileId, d.justOver.fileId]}::uuid[])
        and status = 'deleted'`.execute(t.admin);
    expect(st.rows[0]?.n).toBe(3);
    // Người (persons) chưa bị đụng ở bước này (hạn 10 năm riêng).
    const ppl = await sql<{ n: number }>`
      select count(*)::int as n from persons where id = any(${Object.values(p)}::uuid[]) and anonymized_at is not null`.execute(
      t.admin,
    );
    expect(ppl.rows[0]?.n).toBe(0);
    expect((await purgePersonalData(t.worker, { now: NOW })).identityDocuments).toBe(0);
  });
});

/** Bút toán cân (doanh thu ↔ tín dụng khách theo người) ghi lùi thời gian — sổ tiền của người. */
async function ledger(org: SeededOrg, personId: string, at: string, amount: number): Promise<string> {
  const entry = randomUUID();
  await t.admin.transaction().execute(async (trx) => {
    await sql`insert into journal_entries (id, organization_id, property_id, entry_type, business_date, source_doc_type, source_doc_id,
                                           created_at)
              values (${entry}, ${org.orgId}, ${org.propertyId}, 'invoice_issued', ${at.slice(0, 10)}::date, 'invoice', ${randomUUID()},
                      ${at})`.execute(trx);
    await sql`insert into journal_lines (id, organization_id, property_id, entry_id, line_no, account, debit, credit, created_at)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${entry}, 1, 'REV_FEE', ${amount}, 0, ${at})`.execute(
      trx,
    );
    await sql`insert into journal_lines (id, organization_id, property_id, entry_id, line_no, account, debit, credit, person_id,
                                         created_at)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${entry}, 2, 'CUSTOMER_CREDIT', 0, ${amount}, ${personId},
                      ${at})`.execute(trx);
  });
  return entry;
}

/** Phiếu còn nợ (open_amount > 0), lùi thời gian — CHỈ test: tắt tạm trigger bất biến của phiếu/sổ để ghi mốc cũ. */
async function openInvoice(org: SeededOrg, personId: string, at: string): Promise<void> {
  const { invoiceId } = await seedIssuedInvoice(t.admin, {
    orgId: org.orgId,
    propertyId: org.propertyId,
    payerPersonId: personId,
    lines: [{ amount: 700000 }],
    businessDate: at.slice(0, 10),
  });
  await t.admin.transaction().execute(async (trx) => {
    for (const tg of [
      "invoices disable trigger trg_invoices_immutable",
      "invoices disable trigger trg_invoices_updated",
      "journal_lines disable trigger trg_journal_lines_append_only",
    ])
      await sql.raw(`alter table ${tg}`).execute(trx);
    await sql`update invoices set issued_at = ${at}, updated_at = ${at} where id = ${invoiceId}`.execute(trx);
    await sql`update journal_lines set created_at = ${at} where invoice_id = ${invoiceId}`.execute(trx);
    for (const tg of [
      "invoices enable trigger trg_invoices_immutable",
      "invoices enable trigger trg_invoices_updated",
      "journal_lines enable trigger trg_journal_lines_append_only",
    ])
      await sql.raw(`alter table ${tg}`).execute(trx);
  });
}

interface PersonRow {
  id: string;
  anonymized: boolean;
  full_name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  nationality: string | null;
}

describe("persons (RET-18)", () => {
  it("ẩn danh 10 năm sau quan hệ cuối, GIỮ dòng và sổ tiền; còn quan hệ/nợ/giấy tờ/thành viên, 9 năm, đúng mốc: nguyên", async () => {
    expect(PERSON_RETENTION_YEARS).toBe(10);
    const cut = await cutoff("years", 10);
    const yearsAgo = (y: number) => shift(NOW.toISOString(), -y * 365.25 * DAY);
    const p = {
      expired: await person(A, yearsAgo(15)),
      expiredLease: await person(B, yearsAgo(15)),
      justOver: await person(A, yearsAgo(15)),
      nineYears: await person(A, yearsAgo(15)),
      boundary: await person(A, yearsAgo(15)),
      activeLease: await person(A, yearsAgo(15)),
      member: await person(A, yearsAgo(15)),
      openDebt: await person(A, yearsAgo(15)),
      heldDoc: await person(A, yearsAgo(15)),
      fresh: await person(A, ago(1)),
      neverRelated: await person(A, yearsAgo(11)),
    };
    const entry = await ledger(A, p.expired, yearsAgo(11), 450000);
    const expiredStay = await stay(A, p.expired, "checked_out", yearsAgo(11));
    await lease(B, p.expiredLease, "closed", yearsAgo(10.5));
    await stay(A, p.justOver, "checked_out", shift(cut, -1000));
    await ledger(A, p.nineYears, yearsAgo(9), 100000);
    await stay(A, p.nineYears, "checked_out", yearsAgo(12));
    await stay(A, p.boundary, "checked_out", cut);
    await lease(A, p.activeLease, "active", yearsAgo(11)); // hợp đồng đang hiệu lực (sửa lần cuối 11 năm trước)
    await sql`insert into memberships (id, organization_id, person_id, role, status, valid_from, created_at, updated_at)
              values (${randomUUID()}, ${A.orgId}, ${p.member}, 'tenant', 'active', ${yearsAgo(14)}, ${yearsAgo(14)},
                      ${yearsAgo(12)})`.execute(t.admin);
    await openInvoice(A, p.openDebt, yearsAgo(11));
    await stay(A, p.heldDoc, "checked_out", yearsAgo(11));
    await idDoc(A, p.heldDoc, ago(-365).slice(0, 10)); // giấy tờ còn giữ theo retention_until ⇒ người cũng giữ
    const all = Object.values(p);

    const s = await purgePersonalData(t.worker, { now: NOW });
    expect(s.persons).toBe(4);
    const r = await sql<PersonRow>`
      select id, anonymized_at is not null as anonymized, full_name, phone, email, address, nationality
      from persons where id = any(${all}::uuid[])`.execute(t.admin);
    expect(r.rows).toHaveLength(all.length); // tombstone: không xoá dòng nào
    const done = new Set([p.expired, p.expiredLease, p.justOver, p.neverRelated]);
    for (const row of r.rows) {
      if (done.has(row.id)) {
        expect(row).toMatchObject({
          anonymized: true,
          full_name: "—",
          phone: null,
          email: null,
          address: null,
          nationality: null,
        });
      } else {
        expect(row).toMatchObject({
          anonymized: false,
          full_name: "Nguyễn Văn Giả",
          phone: "0100000266",
          nationality: "VN",
        });
      }
    }
    // Sổ tiền và lượt ở của người đã ẩn danh nguyên vẹn (khoá ngoại, số tiền).
    const lines = await sql<{ account: string; debit: string; credit: string; person_id: string | null }>`
      select account, debit::text, credit::text, person_id from journal_lines where entry_id = ${entry} order by line_no`.execute(
      t.admin,
    );
    expect(lines.rows).toEqual([
      { account: "REV_FEE", debit: "450000", credit: "0", person_id: null },
      { account: "CUSTOMER_CREDIT", debit: "0", credit: "450000", person_id: p.expired },
    ]);
    const st = await sql<{
      g: string;
    }>`select primary_guest_person_id as g from stays where id = ${expiredStay}`.execute(t.admin);
    expect(st.rows[0]?.g).toBe(p.expired);
    expect((await purgePersonalData(t.worker, { now: NOW })).persons).toBe(0);
  });
});

// ───────────────────────── an toàn chung ─────────────────────────

const FNS = [
  "purge_notifications(timestamptz, integer, integer)",
  "purge_worker_heartbeats(timestamptz, integer, integer)",
  "purge_auth_sessions(timestamptz, integer, integer)",
  "purge_auth_verifications(timestamptz, integer, integer)",
  "purge_guest_access_links(timestamptz, integer, integer)",
  "purge_inbox_raw(timestamptz, integer, integer)",
  "anonymize_identity_documents(timestamptz, integer, integer)",
  "anonymize_persons(timestamptz, integer, integer)",
];

describe("an toàn của hàm dọn/ẩn danh", () => {
  it("chỉ app_worker gọi được; app_runtime bị từ chối mọi hàm; worker không có DELETE/UPDATE trực tiếp", async () => {
    for (const f of FNS) {
      const name = f.slice(0, f.indexOf("("));
      await expect(
        sql`select ${sql.raw(`app.${name}`)}(${NOW}, 1000, 1)`.execute(t.runtime),
        name,
      ).rejects.toThrow(/permission denied/);
      const g = await sql<{ w: boolean; r: boolean; p: boolean }>`
        select has_function_privilege('app_worker', ${`app.${f}`}, 'EXECUTE') as w,
               has_function_privilege('app_runtime', ${`app.${f}`}, 'EXECUTE') as r,
               has_function_privilege('public', ${`app.${f}`}, 'EXECUTE') as p`.execute(t.admin);
      expect(g.rows[0], name).toEqual({ w: true, r: false, p: false });
    }
    // Hàm phụ tính trạng thái quan hệ: không ai ngoài chủ sở hữu gọi được (đọc chéo tổ chức).
    for (const f of ["retention_stay_lease_state(uuid, uuid)", "retention_person_state(uuid, uuid)"]) {
      const g = await sql<{ w: boolean; r: boolean }>`
        select has_function_privilege('app_worker', ${`app.${f}`}, 'EXECUTE') as w,
               has_function_privilege('app_runtime', ${`app.${f}`}, 'EXECUTE') as r`.execute(t.admin);
      expect(g.rows[0], f).toEqual({ w: false, r: false });
    }
    const priv = await sql<Record<string, boolean>>`
      select has_table_privilege('app_worker', 'notifications', 'DELETE') as n,
             has_table_privilege('app_worker', 'guest_access_links', 'DELETE') as g,
             has_table_privilege('app_worker', 'identity_documents', 'UPDATE') as i,
             has_table_privilege('app_worker', 'auth.session', 'DELETE') as s`.execute(t.admin);
    expect(priv.rows[0]).toEqual({ n: false, g: false, i: false, s: false });
  });

  it("mốc ở tương lai (đồng hồ worker lệch) không xoá/ẩn danh hàng chưa tới hạn; số ngày 0/âm được nâng lên 1", async () => {
    const n = await notification(A, ago(0.5));
    const ses = await session(
      await seedAuthUser(t.admin, `f+${randomUUID().slice(0, 8)}@example.test`),
      ago(0.5),
    );
    const pr = await person(A, ago(0.5));
    const far = new Date(Date.now() + 5000 * DAY);
    for (const f of FNS) {
      const name = f.slice(0, f.indexOf("("));
      await sql`select ${sql.raw(`app.${name}`)}(${far}, 1, 1000)`.execute(t.worker);
      await sql`select ${sql.raw(`app.${name}`)}(${NOW}, 0, 1000)`.execute(t.worker);
      await sql`select ${sql.raw(`app.${name}`)}(${NOW}, -5, 1000)`.execute(t.worker);
    }
    expect(await alive("notifications", [n])).toEqual(new Set([n]));
    expect(await alive("auth.session", [ses])).toEqual(new Set([ses]));
    const r = await sql<{
      a: boolean;
    }>`select anonymized_at is not null as a from persons where id = ${pr}`.execute(t.admin);
    expect(r.rows[0]?.a).toBe(false);
  });

  it("theo lô có trần: lô 3 × 2 vòng xoá 6 trong 7; lượt sau xoá nốt", async () => {
    const ids = await Promise.all(Array.from({ length: 7 }, (_, i) => notification(B, ago(300 + i))));
    const first = await purgePersonalData(t.worker, { now: NOW, batch: 3, maxRounds: 2 });
    expect(first.notifications).toBe(6);
    expect((await alive("notifications", ids)).size).toBe(1);
    const second = await purgePersonalData(t.worker, { now: NOW, batch: 3, maxRounds: 2 });
    expect(second.notifications).toBe(1);
    expect((await alive("notifications", ids)).size).toBe(0);
  });

  it("đồng thời: hai worker chạy cùng lúc không lỗi, không xử lý trùng (SKIP LOCKED) — tổng đúng bằng số hàng quá hạn", async () => {
    const notes = await Promise.all(Array.from({ length: 40 }, (_, i) => notification(A, ago(200 + i))));
    const people: string[] = [];
    for (let i = 0; i < 12; i++) {
      const pid = await person(B, ago(6000));
      await stay(B, pid, "checked_out", ago(4000 + i));
      people.push(pid);
    }
    const second = await createTestDbWorker();
    try {
      const [x, y] = await Promise.all([
        purgePersonalData(t.worker, { now: NOW, batch: 5 }),
        purgePersonalData(second, { now: NOW, batch: 5 }),
      ]);
      expect(x.notifications + y.notifications).toBe(40);
      expect(x.persons + y.persons).toBe(12);
    } finally {
      await second.destroy();
    }
    expect((await alive("notifications", notes)).size).toBe(0);
    const r = await sql<{ n: number }>`
      select count(*)::int as n from persons where id = any(${people}::uuid[]) and anonymized_at is not null`.execute(
      t.admin,
    );
    expect(r.rows[0]?.n).toBe(12);
  });

  it("một bảng lỗi không chặn bảng khác: ném AggregateError sau khi dọn xong phần còn lại, log chỉ tên bảng (không PII)", async () => {
    const n = await notification(A, ago(500));
    await sql`insert into worker_heartbeats (name, beat_at, started_at) values ('w-agg', ${ago(90)}, ${ago(90)})`.execute(
      t.admin,
    );
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    await sql`revoke execute on function app.purge_notifications(timestamptz, integer, integer) from app_worker`.execute(
      t.admin,
    );
    try {
      await expect(
        purgePersonalData(t.worker, { now: NOW, log: (event, fields) => void logs.push({ event, fields }) }),
      ).rejects.toBeInstanceOf(AggregateError);
    } finally {
      await sql`grant execute on function app.purge_notifications(timestamptz, integer, integer) to app_worker`.execute(
        t.admin,
      );
    }
    expect(await alive("notifications", [n])).toEqual(new Set([n]));
    expect(await alive("worker_heartbeats", ["w-agg"], "name")).toEqual(new Set());
    expect(logs).toEqual([
      {
        event: "retention.personal_purge_failed",
        fields: { table: "notifications", error: expect.any(String) },
      },
    ]);
  });
});

/** Kết nối app_worker thứ hai tới cùng CSDL test (mô phỏng hai tiến trình worker). */
async function createTestDbWorker(): Promise<Kysely<unknown>> {
  return new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: t.workerUrl, max: 2 }) }),
  });
}

describe("migration 0066 — down/up", () => {
  it("down gỡ hàm, index và trả trigger inbox về bản cũ; up áp lại được", async () => {
    const m = migrations["0066_personal_data_retention"];
    if (!m) throw new Error("thiếu migration 0066_personal_data_retention");
    const own = await createTestDb();
    try {
      const count = async () => [
        (
          await sql<{
            n: number;
          }>`select count(*)::int as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'app' and p.proname in ('purge_notifications','purge_worker_heartbeats','purge_auth_sessions',
              'purge_auth_verifications','purge_guest_access_links','purge_inbox_raw','anonymize_identity_documents',
              'anonymize_persons','retention_stay_lease_state','retention_person_state')`.execute(own.admin)
        ).rows[0]?.n,
        (
          await sql<{ n: number }>`select count(*)::int as n from pg_indexes
            where indexname in ('ix_notifications_created_at','ix_guest_access_links_ended','ix_inbox_raw_retention',
              'ix_auth_session_expires','ix_auth_verification_expires','ix_stays_additional_guests')`.execute(
            own.admin,
          )
        ).rows[0]?.n,
        (
          await sql<{
            ok: boolean;
          }>`select pg_get_functiondef('app.inbox_immutable()'::regprocedure) like '%Asia/Ho_Chi_Minh%' as ok`.execute(
            own.admin,
          )
        ).rows[0]?.ok,
      ];
      expect(await count()).toEqual([10, 6, true]);
      await own.admin
        .transaction()
        .execute((trx) => (m.down ? m.down(trx) : Promise.reject(new Error("migration 0066 thiếu down"))));
      expect(await count()).toEqual([0, 0, false]);
      await own.admin.transaction().execute((trx) => m.up(trx));
      expect(await count()).toEqual([10, 6, true]);
    } finally {
      await own.drop();
    }
  });
});
