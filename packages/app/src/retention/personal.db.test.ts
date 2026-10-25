// PLAN T-2308 (STD-PRIV-005, XC-GREEN-007; D-116) — hạn lưu dữ liệu cá nhân/vận hành trên Postgres thật, bằng vai trò `app_worker`
// như worker chạy thật: hàng quá hạn bị xoá/ẩn danh; đúng mốc, chưa tới hạn và người còn quan hệ mở (lưu trú, hợp đồng, công nợ,
// tài khoản) KHÔNG bị đụng; chạy lại không đổi gì; đồng hồ lệch tương lai không xoá thêm; worker không có DELETE/UPDATE trực tiếp.
// Dữ liệu "cũ" được dựng bằng kết nối admin; mốc thời gian lùi về quá khứ trong `session_replication_role = replica` (bỏ trigger
// `set_updated_at`/chuyển trạng thái — chỉ để giả lập năm tháng trôi qua, mã chạy thật không có đường này).
import { randomBytes, randomUUID } from "node:crypto";
import { migrations } from "@hm/db";
import { MS_PER_DAY } from "@hm/domain";
import {
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedIssuedInvoice,
  seedLease,
  seedOrg,
  seedReservation,
  type TestDb,
} from "@hm/testkit";
import { type RawBuilder, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUTH_SESSION_RETENTION_DAYS,
  AUTH_VERIFICATION_RETENTION_DAYS,
  anonymizeExpiredPeople,
  GUEST_LINK_RETENTION_DAYS,
  IDENTITY_DOCUMENT_RETENTION_MONTHS,
  INBOX_RETENTION_MONTHS,
  NOTIFICATION_RETENTION_DAYS,
  PERSON_RETENTION_MONTHS,
  purgeExpiredOperational,
  WORKER_HEARTBEAT_RETENTION_DAYS,
} from "./index.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
// Mốc "bây giờ" của test: không vượt đồng hồ CSDL (hàm chặn mốc bởi now()).
const NOW = new Date(Date.now() - 1000);
const DAY = MS_PER_DAY;
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs).toISOString();
/** Mốc NOW − n tháng theo lịch, tính bằng CSDL (cùng phép `make_interval(months => n)` của hàm). */
async function monthsAgo(n: number): Promise<string> {
  const r = await sql<{
    b: Date;
  }>`select (${NOW}::timestamptz - make_interval(months => ${n}::int)) as b`.execute(t.admin);
  const b = r.rows[0]?.b;
  if (!b) throw new Error("không tính được mốc tháng");
  return b.toISOString();
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà nghỉ Sen Hồng", "hotel");
  B = await seedOrg(t.admin, "Nhà trọ Bên Sông", "rental");
});
afterAll(async () => {
  await t?.drop();
});

/** Sửa thẳng hàng bỏ qua trigger (giả lập thời gian trôi). */
async function rewind(statement: RawBuilder<unknown>): Promise<void> {
  await t.admin.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await statement.execute(trx);
  });
}

// ───────────────────────── xoá dữ liệu vận hành ─────────────────────────

const exists = async (q: RawBuilder<{ n: number }>) => ((await q.execute(t.admin)).rows[0]?.n ?? 0) > 0;
const notificationAlive = (id: string) =>
  exists(sql<{ n: number }>`select count(*)::int as n from notifications where id = ${id}`);

async function notification(org: SeededOrg, createdAt: string, withQueuedDelivery = false): Promise<string> {
  const id = randomUUID();
  await sql`insert into notifications (id, organization_id, recipient_person_id, type, title, body, dedupe_key, created_at)
            values (${id}, ${org.orgId}, ${org.ownerPersonId}, 'invoice_issued', 'Thông báo giả', 'Nội dung giả', ${`r-${id}`},
                    ${createdAt})`.execute(t.admin);
  if (withQueuedDelivery)
    await sql`insert into notification_deliveries (id, organization_id, notification_id, status, next_attempt_at, created_at, updated_at)
              values (${randomUUID()}, ${org.orgId}, ${id}, 'queued', ${createdAt}, ${createdAt}, ${createdAt})`.execute(
      t.admin,
    );
  return id;
}

describe("purgeExpiredOperational — thông báo trong app (RET-11)", () => {
  it("quá 180 ngày và không còn lần gửi ⇒ xoá (mọi tổ chức); đúng mốc, mới hơn, còn lần gửi chờ ⇒ giữ; chạy lại = 0", async () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBe(180);
    const old = await notification(A, ago(181));
    const oldOther = await notification(B, ago(900));
    const justOver = await notification(A, ago(180, 1000));
    const boundary = await notification(A, ago(180));
    const recent = await notification(A, ago(179));
    const pending = await notification(A, ago(400), true); // còn lần gửi `queued` ⇒ FK RESTRICT, giữ tới khi lần gửi xong/dọn
    const s = await purgeExpiredOperational(t.worker, { now: NOW });
    expect(s.notifications).toBe(3);
    for (const id of [old, oldOther, justOver]) expect(await notificationAlive(id), id).toBe(false);
    for (const id of [boundary, recent, pending]) expect(await notificationAlive(id), id).toBe(true);
    expect((await purgeExpiredOperational(t.worker, { now: NOW })).notifications).toBe(0);
  });

  it("theo lô có trần: lô 2 × 2 vòng xoá 4 trong 5; lượt sau xoá nốt", async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, (_, i) => notification(A, ago(200 + i))));
    expect(
      (await purgeExpiredOperational(t.worker, { now: NOW, batch: 2, maxRounds: 2 })).notifications,
    ).toBe(4);
    expect(
      (await purgeExpiredOperational(t.worker, { now: NOW, batch: 2, maxRounds: 2 })).notifications,
    ).toBe(1);
    for (const id of ids) expect(await notificationAlive(id)).toBe(false);
  });
});

describe("purgeExpiredOperational — nhịp worker, phiên, mã xác minh, liên kết khách (RET-12…RET-15)", () => {
  it("nhịp worker không cập nhật quá 30 ngày ⇒ xoá; đúng mốc và còn sống ⇒ giữ", async () => {
    expect(WORKER_HEARTBEAT_RETENTION_DAYS).toBe(30);
    await sql`insert into worker_heartbeats (name, beat_at, started_at) values
              ('ret-old', ${ago(31)}, ${ago(60)}), ('ret-edge', ${ago(30)}, ${ago(60)}), ('ret-live', ${ago(0)}, ${ago(60)})`.execute(
      t.admin,
    );
    expect((await purgeExpiredOperational(t.worker, { now: NOW })).workerHeartbeats).toBe(1);
    const left = await sql<{
      name: string;
    }>`select name from worker_heartbeats where name like 'ret-%' order by name`.execute(t.admin);
    expect(left.rows.map((r) => r.name)).toEqual(["ret-edge", "ret-live"]);
  });

  it("phiên hết hạn quá 30 ngày ⇒ xoá; đúng mốc, mới hết hạn, còn hạn ⇒ giữ", async () => {
    expect(AUTH_SESSION_RETENTION_DAYS).toBe(30);
    const user = await seedAuthUser(t.admin, `ret-${randomUUID().slice(0, 8)}@example.test`);
    const session = async (expiresAt: string) => {
      const id = randomUUID();
      await sql`insert into auth."session" (id, "expiresAt", token, "updatedAt", "userId")
                values (${id}, ${expiresAt}, ${randomUUID()}, now(), ${user})`.execute(t.admin);
      return id;
    };
    const old = await session(ago(31));
    const justOver = await session(ago(30, 1000));
    const boundary = await session(ago(30));
    const expiredRecently = await session(ago(1));
    const live = await session(new Date(NOW.getTime() + DAY).toISOString());
    expect((await purgeExpiredOperational(t.worker, { now: NOW })).authSessions).toBe(2);
    const left = await sql<{ id: string }>`select id from auth."session" where "userId" = ${user}`.execute(
      t.admin,
    );
    expect(new Set(left.rows.map((r) => r.id))).toEqual(new Set([boundary, expiredRecently, live]));
    expect(left.rows.map((r) => r.id)).not.toContain(old);
    expect(left.rows.map((r) => r.id)).not.toContain(justOver);
  });

  it("mã xác minh hết hạn quá 1 ngày ⇒ xoá; đúng mốc và còn hạn ⇒ giữ", async () => {
    expect(AUTH_VERIFICATION_RETENTION_DAYS).toBe(1);
    const tag = `ret-${randomUUID()}`;
    const ver = async (expiresAt: string) => {
      const id = randomUUID();
      await sql`insert into auth."verification" (id, identifier, value, "expiresAt") values (${id}, ${tag}, 'băm-giả', ${expiresAt})`.execute(
        t.admin,
      );
      return id;
    };
    await ver(ago(1, 1000));
    await ver(ago(10));
    const boundary = await ver(ago(1));
    const live = await ver(new Date(NOW.getTime() + 600_000).toISOString());
    expect((await purgeExpiredOperational(t.worker, { now: NOW })).authVerifications).toBe(2);
    const left = await sql<{
      id: string;
    }>`select id from auth."verification" where identifier = ${tag}`.execute(t.admin);
    expect(new Set(left.rows.map((r) => r.id))).toEqual(new Set([boundary, live]));
  });

  it("liên kết khách: 90 ngày sau mốc sớm hơn của hết hạn/thu hồi ⇒ xoá; đúng mốc, còn hiệu lực ⇒ giữ", async () => {
    expect(GUEST_LINK_RETENTION_DAYS).toBe(90);
    const { reservationId } = await seedReservation(t.admin, { org: A, bookerPersonId: A.ownerPersonId });
    const link = async (createdAt: string, expiresAt: string, revokedAt: string | null = null) => {
      const id = randomUUID();
      await sql`insert into guest_access_links (id, organization_id, property_id, reservation_id, token_hash, expires_at, revoked_at,
                                                revoked_by, created_by, created_at)
                values (${id}, ${A.orgId}, ${A.propertyId}, ${reservationId}, ${randomBytes(32)}, ${expiresAt}, ${revokedAt},
                        ${revokedAt ? A.ownerMembershipId : null}, ${A.ownerMembershipId}, ${createdAt})`.execute(
        t.admin,
      );
      return id;
    };
    const expiredOld = await link(ago(200), ago(91));
    const revokedOld = await link(ago(200), new Date(NOW.getTime() + 30 * DAY).toISOString(), ago(91)); // thu hồi sớm
    const revokedAfterExpiry = await link(ago(300), ago(120), ago(10)); // mốc sớm hơn = hết hạn 120 ngày trước
    const boundary = await link(ago(200), ago(90));
    const expiredRecently = await link(ago(100), ago(89));
    const revokedRecently = await link(ago(100), new Date(NOW.getTime() + DAY).toISOString(), ago(5));
    const live = await link(ago(1), new Date(NOW.getTime() + DAY).toISOString());
    expect((await purgeExpiredOperational(t.worker, { now: NOW })).guestAccessLinks).toBe(3);
    const left = await sql<{
      id: string;
    }>`select id from guest_access_links where reservation_id = ${reservationId}`.execute(t.admin);
    expect(new Set(left.rows.map((r) => r.id))).toEqual(
      new Set([boundary, expiredRecently, revokedRecently, live]),
    );
    expect(
      [expiredOld, revokedOld, revokedAfterExpiry].some((id) => left.rows.some((r) => r.id === id)),
    ).toBe(false);
  });
});

// ───────────────────────── ẩn danh giấy tờ + người ─────────────────────────

async function person(org: SeededOrg, at: string, name = "Nguyễn Văn Giả"): Promise<string> {
  const id = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, phone, email, address, nationality, created_at, updated_at)
            values (${id}, ${org.orgId}, ${name}, '0912345678', ${`p-${id.slice(0, 8)}@example.test`}, '1 Đường Giả, Huế', 'VN',
                    ${at}, ${at})`.execute(t.admin);
  return id;
}

/** Giấy tờ (số mã hoá giả + blind index + ảnh) tạo/sửa lúc `at`. */
async function idDoc(
  org: SeededOrg,
  personId: string,
  at: string,
  retentionUntil: string | null = null,
): Promise<{ docId: string; fileId: string }> {
  const docId = randomUUID();
  const fileId = randomUUID();
  const enc = Buffer.concat([Buffer.from([1]), randomBytes(40)]); // byte đầu = key id (ck_identity_documents_key_byte)
  await sql`insert into files (id, organization_id, property_id, owner_type, owner_id, mime, size_bytes, sha256, status, storage_key,
                               exif_stripped, created_at, updated_at)
            values (${fileId}, ${org.orgId}, ${org.propertyId}, 'identity_document', ${docId}, 'image/jpeg', 1234, ${"a".repeat(64)},
                    'ready', ${`${org.orgId}/identity/${fileId}`}, true, ${at}, ${at})`.execute(t.admin);
  await sql`insert into identity_documents (id, organization_id, property_id, person_id, doc_type, file_id, retention_until,
                                            doc_number_enc, doc_number_key_id, doc_number_hash, doc_number_last4, nationality,
                                            created_at, updated_at)
            values (${docId}, ${org.orgId}, ${org.propertyId}, ${personId}, 'cccd', ${fileId}, ${retentionUntil}::date, ${enc}, 1,
                    ${randomBytes(32)}, '6789', 'VN', ${at}, ${at})`.execute(t.admin);
  return { docId, fileId };
}

/** Lượt ở (một đặt phòng riêng) của `guest`; `checkedOutAt` null ⇒ đang ở (in_house). Mọi mốc của hàng đặt về `at`. */
async function stay(
  org: SeededOrg,
  guest: string,
  at: string,
  checkedOutAt: string | null,
  extra: { additional?: string[] } = {},
): Promise<string> {
  const { reservationId, itemId } = await seedReservation(t.admin, {
    org,
    bookerPersonId: org.ownerPersonId,
  });
  const id = randomUUID();
  await rewind(sql`insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id,
                                      additional_guest_person_ids, checked_in_at, checked_out_at, created_at, updated_at)
                   values (${id}, ${org.orgId}, ${org.propertyId}, ${itemId}, ${org.unitId},
                           ${checkedOutAt ? "checked_out" : "in_house"}, ${guest}, ${extra.additional ?? []}::uuid[], ${at},
                           ${checkedOutAt}, ${at}, ${checkedOutAt ?? at})`);
  // Đặt phòng của lượt ở cũng đã xong từ lâu (người đặt là chủ cơ sở — không ảnh hưởng người đang xét).
  await rewind(
    sql`update reservations set status = 'checked_out', created_at = ${at}, updated_at = ${at} where id = ${reservationId}`,
  );
  return id;
}

/** Hợp đồng của `rep`: `movedOutOn` (YYYY-MM-DD) ⇒ đã đóng, cập nhật lần cuối lúc `closedAt`; null ⇒ đang thuê. */
async function lease(
  org: SeededOrg,
  rep: string,
  movedOutOn: string | null,
  closedAt: string,
): Promise<string> {
  const { leaseId } = await seedLease(t.admin, {
    orgId: org.orgId,
    propertyId: org.propertyId,
    representativePersonId: rep,
  });
  await rewind(sql`update leases set status = ${movedOutOn ? "closed" : "active"}, signed_on = '2010-01-01', moved_out_on = ${movedOutOn}::date,
                                     created_at = ${closedAt}, updated_at = ${closedAt} where id = ${leaseId}`);
  return leaseId;
}

const docState = async (docId: string) =>
  (
    await sql<{
      anonymized: boolean;
      enc: boolean;
      hash: boolean;
      last4: string | null;
      file_id: string | null;
    }>`select anonymized_at is not null as anonymized, doc_number_enc is not null as enc, doc_number_hash is not null as hash,
              doc_number_last4 as last4, file_id from identity_documents where id = ${docId}`.execute(t.admin)
  ).rows[0];
const isAnonDoc = async (docId: string) => (await docState(docId))?.anonymized === true;
const personRow = async (id: string) =>
  (
    await sql<{
      id: string;
      full_name: string;
      phone: string | null;
      email: string | null;
      address: string | null;
      nationality: string | null;
      anonymized: boolean;
    }>`select id, full_name, phone, email, address, nationality, anonymized_at is not null as anonymized
       from persons where id = ${id}`.execute(t.admin)
  ).rows[0];
const auditCount = async (action: string, entityId: string) =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from audit_events where action = ${action} and entity_id = ${entityId}`.execute(
      t.admin,
    )
  ).rows[0]?.n ?? 0;

describe("anonymizeExpiredPeople — giấy tờ nhận dạng (RET-16: 12 tháng sau lưu trú/thuê cuối)", () => {
  it("chỉ giấy tờ quá hạn bị ẩn danh: xoá số/băm/4 số cuối, gỡ ảnh + hẹn xoá object, ghi audit; còn lại giữ nguyên", async () => {
    expect(IDENTITY_DOCUMENT_RETENTION_MONTHS).toBe(12);
    const old = await monthsAgo(24);
    // Quá hạn: trả phòng 13 tháng trước.
    const p1 = await person(A, old);
    const d1 = await idDoc(A, p1, old);
    await stay(A, p1, old, await monthsAgo(13));
    // Quá hạn: hợp đồng đã đóng, chuyển đi 13+ tháng trước (tổ chức khác).
    const p2 = await person(B, old);
    const d2 = await idDoc(B, p2, old);
    await lease(B, p2, (await monthsAgo(14)).slice(0, 10), await monthsAgo(14));
    // Quá hạn: không có lưu trú/thuê nào, giấy tờ ghi 13 tháng trước.
    const p3 = await person(A, old);
    const d3 = await idDoc(A, p3, await monthsAgo(13));
    // Đúng mốc 12 tháng ⇒ giữ (so sánh nghiêm ngặt).
    const p4 = await person(A, old);
    const d4 = await idDoc(A, p4, old);
    await stay(A, p4, old, await monthsAgo(12));
    // Trả phòng 11 tháng trước ⇒ còn trong hạn.
    const p5 = await person(A, old);
    const d5 = await idDoc(A, p5, old);
    await stay(A, p5, old, await monthsAgo(11));
    // Đang ở (in_house, nhận phòng từ 2 năm trước) ⇒ quan hệ mở.
    const p6 = await person(A, old);
    const d6 = await idDoc(A, p6, old);
    await stay(A, p6, old, null);
    // Người ở kèm (additional_guest_person_ids) của một lượt đang ở ⇒ quan hệ mở.
    const p7 = await person(A, old);
    const d7 = await idDoc(A, p7, old);
    await stay(A, A.ownerPersonId, old, null, { additional: [p7] });
    // Hợp đồng còn hiệu lực ⇒ quan hệ mở.
    const p8 = await person(B, old);
    const d8 = await idDoc(B, p8, old);
    await lease(B, p8, null, old);
    // Trả phòng từ lâu nhưng còn công nợ mở (phiếu chưa thu) ⇒ giữ.
    const p9 = await person(A, old);
    const d9 = await idDoc(A, p9, old);
    await stay(A, p9, old, await monthsAgo(20));
    await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: p9,
      lines: [{ amount: 350_000 }],
    });
    // Trả phòng từ lâu nhưng `retention_until` còn ở tương lai (giữ theo yêu cầu riêng) ⇒ giữ.
    const p10 = await person(A, old);
    const d10 = await idDoc(A, p10, old, new Date(NOW.getTime() + 30 * DAY).toISOString().slice(0, 10));
    await stay(A, p10, old, await monthsAgo(20));

    const s = await anonymizeExpiredPeople(t.worker, { now: NOW });
    expect(s.identityDocuments).toBe(3);
    for (const d of [d1, d2, d3]) {
      expect(await docState(d.docId)).toEqual({
        anonymized: true,
        enc: false,
        hash: false,
        last4: null,
        file_id: null,
      });
      expect(await auditCount("identity_document.anonymized", d.docId)).toBe(1);
      // Ảnh giấy tờ: hẹn xoá hôm nay ⇒ job `import.retention` (app.files_due_for_deletion) sẽ xoá object rồi đánh dấu deleted.
      const due = await sql<{
        id: string;
      }>`select id from app.files_due_for_deletion((now() at time zone 'UTC')::date, 1000)`.execute(t.admin);
      expect(due.rows.map((r) => r.id)).toContain(d.fileId);
    }
    for (const d of [d4, d5, d6, d7, d8, d9, d10]) {
      expect(await docState(d.docId), d.docId).toMatchObject({
        anonymized: false,
        enc: true,
        hash: true,
        last4: "6789",
      });
      expect(await auditCount("identity_document.anonymized", d.docId)).toBe(0);
    }
    // Ẩn danh giấy tờ không đụng hồ sơ người.
    expect((await personRow(p1))?.anonymized).toBe(false);
    // Chạy lại: không còn gì tới hạn, không thêm audit (idempotent).
    expect((await anonymizeExpiredPeople(t.worker, { now: NOW })).identityDocuments).toBe(0);
    expect(await auditCount("identity_document.anonymized", d1.docId)).toBe(1);
  });
});

describe("anonymizeExpiredPeople — hồ sơ người (RET-17: 10 năm sau quan hệ tiền/thuê/lưu trú cuối)", () => {
  it("chỉ người quá hạn bị ẩn danh (giữ id, xoá liên hệ, ghi audit không PII); còn quan hệ mở/còn trong hạn giữ nguyên", async () => {
    expect(PERSON_RETENTION_MONTHS).toBe(120);
    const veryOld = await monthsAgo(150);
    // Quá hạn: hợp đồng đóng 10 năm + 1 tháng trước; còn giấy tờ chưa ẩn danh ⇒ cùng lượt giấy tờ ẩn danh trước rồi tới người.
    const q1 = await person(A, veryOld, "Trần Thị Cũ");
    const q1doc = await idDoc(A, q1, veryOld);
    await lease(A, q1, (await monthsAgo(121)).slice(0, 10), await monthsAgo(121));
    // Quá hạn: chỉ có phiếu 0 đ đã tất toán 11 năm trước (quan hệ tiền).
    const q2 = await person(B, veryOld);
    const inv2 = await seedIssuedInvoice(t.admin, {
      orgId: B.orgId,
      propertyId: B.propertyId,
      payerPersonId: q2,
      lines: [{ amount: 0 }],
    });
    await rewind(
      sql`update invoices set issued_at = ${await monthsAgo(132)}, updated_at = ${await monthsAgo(132)} where id = ${inv2.invoiceId}`,
    );
    // Đúng mốc 10 năm ⇒ giữ.
    const q3 = await person(A, veryOld);
    await lease(A, q3, null, veryOld);
    const lease3 = await sql<{
      id: string;
    }>`select id from leases where representative_person_id = ${q3}`.execute(t.admin);
    const edge = await monthsAgo(120);
    await rewind(sql`update leases set status = 'closed', moved_out_on = ${(await monthsAgo(121)).slice(0, 10)}::date,
                                       updated_at = ${edge} where id = ${lease3.rows[0]?.id}`);
    // Quan hệ tiền 9 năm trước ⇒ còn trong hạn.
    const q4 = await person(A, veryOld);
    const inv4 = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: q4,
      lines: [{ amount: 0 }],
    });
    await rewind(
      sql`update invoices set issued_at = ${await monthsAgo(108)}, updated_at = ${await monthsAgo(108)} where id = ${inv4.invoiceId}`,
    );
    // Công nợ mở từ 11 năm trước ⇒ giữ (quan hệ mở).
    const q5 = await person(A, veryOld);
    const inv5 = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: q5,
      lines: [{ amount: 500_000 }],
    });
    await rewind(
      sql`update invoices set issued_at = ${await monthsAgo(132)}, updated_at = ${await monthsAgo(132)} where id = ${inv5.invoiceId}`,
    );
    await rewind(
      sql`update journal_lines set created_at = ${await monthsAgo(132)} where invoice_id = ${inv5.invoiceId}`,
    );
    // Thành viên còn active (nhân viên lâu năm, hồ sơ cũ) ⇒ giữ.
    const q6 = await person(B, veryOld);
    const user6 = await seedAuthUser(t.admin, `staff-${q6.slice(0, 8)}@example.test`);
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, created_at, updated_at, valid_from)
              values (${randomUUID()}, ${B.orgId}, ${user6}, ${q6}, 'front_desk', ${veryOld}, ${veryOld}, ${veryOld})`.execute(
      t.admin,
    );
    await rewind(sql`update memberships set updated_at = ${veryOld} where person_id = ${q6}`);
    // Giấy tờ còn `retention_until` tương lai ⇒ giấy tờ chưa ẩn danh ⇒ người cũng giữ.
    const q7 = await person(A, veryOld);
    const q7doc = await idDoc(A, q7, veryOld, new Date(NOW.getTime() + 30 * DAY).toISOString().slice(0, 10));
    // Hồ sơ người mới sửa (updated_at gần đây) ⇒ đồng hồ tính lại.
    const q8 = await person(A, veryOld);
    await rewind(sql`update persons set updated_at = ${await monthsAgo(1)} where id = ${q8}`);

    const s = await anonymizeExpiredPeople(t.worker, { now: NOW });
    expect(s.persons).toBe(2);
    expect(s.identityDocuments).toBeGreaterThanOrEqual(1);
    expect(await isAnonDoc(q1doc.docId)).toBe(true);
    for (const id of [q1, q2]) {
      expect(await personRow(id)).toEqual({
        id,
        full_name: "***",
        phone: null,
        email: null,
        address: null,
        nationality: null,
        anonymized: true,
      });
      expect(await auditCount("person.anonymized", id)).toBe(1);
      const a = await sql<{ after: Record<string, unknown>; actor_type: string; reason: string }>`
        select after, actor_type, reason from audit_events where action = 'person.anonymized' and entity_id = ${id}`.execute(
        t.admin,
      );
      expect(a.rows[0]).toEqual({
        after: { retention_months: 120 },
        actor_type: "worker",
        reason: "retention_expired",
      });
    }
    // Sổ tiền vẫn trỏ đúng người (id giữ nguyên, FK nguyên vẹn).
    expect(
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from invoices where payer_person_id = ${q2}`.execute(t.admin)
      ).rows[0]?.n,
    ).toBe(1);
    for (const id of [q3, q4, q5, q6, q7, q8]) {
      expect((await personRow(id))?.anonymized, id).toBe(false);
      expect((await personRow(id))?.phone, id).toBe("0912345678");
    }
    expect(await isAnonDoc(q7doc.docId)).toBe(false);
    // Chạy lại: idempotent.
    expect(await anonymizeExpiredPeople(t.worker, { now: NOW })).toEqual({
      identityDocuments: 0,
      persons: 0,
    });
    expect(await auditCount("person.anonymized", q1)).toBe(1);
  });

  it("hai worker chạy song song: không lỗi, mỗi người ẩn danh đúng một lần (SKIP LOCKED)", async () => {
    const veryOld = await monthsAgo(150);
    const ids = await Promise.all(Array.from({ length: 12 }, () => person(B, veryOld)));
    const [r1, r2] = await Promise.all([
      anonymizeExpiredPeople(t.worker, { now: NOW, batch: 3 }),
      anonymizeExpiredPeople(t.worker, { now: NOW, batch: 3 }),
    ]);
    expect(r1.persons + r2.persons).toBe(12);
    for (const id of ids) {
      expect((await personRow(id))?.anonymized).toBe(true);
      expect(await auditCount("person.anonymized", id)).toBe(1);
    }
  });

  it("inbox giữ 10 năm: chỉ là hằng (chưa có job — không hàng nào tới hạn trước 10 năm)", () => {
    expect(INBOX_RETENTION_MONTHS).toBe(120);
  });
});

describe("an toàn của hàm hạn lưu (0066)", () => {
  it("mốc ở tương lai (đồng hồ worker lệch) không xoá/ẩn danh thêm; số ngày/tháng 0/âm được nâng lên 1", async () => {
    const future = new Date(Date.now() + 5000 * DAY);
    const recentNotif = await notification(A, ago(0.5)); // nửa ngày: dưới cả mức sàn 1 ngày
    const p = await person(A, ago(400));
    const d = await idDoc(A, p, ago(400));
    await stay(A, p, ago(400), ago(2)); // trả phòng 2 ngày trước
    await sql`insert into worker_heartbeats (name, beat_at) values ('ret-skew', ${ago(0.5)})`.execute(
      t.admin,
    );
    for (const q of [
      sql`select app.purge_notifications(${future}, 180, 1000)`,
      sql`select app.purge_notifications(${NOW}, 0, 1000)`,
      sql`select app.purge_notifications(${NOW}, -5, 1000)`,
      sql`select app.purge_worker_heartbeats(${future}, 30, 1000)`,
      sql`select app.purge_worker_heartbeats(${NOW}, 0, 1000)`,
      sql`select app.purge_auth_sessions(${future}, 30, 1000)`,
      sql`select app.purge_auth_verifications(${future}, 1, 1000)`,
      sql`select app.purge_guest_access_links(${future}, 90, 1000)`,
      sql`select app.anonymize_identity_documents(${future}, 12, 1000)`,
      sql`select app.anonymize_identity_documents(${NOW}, 0, 1000)`,
      sql`select app.anonymize_persons(${future}, 120, 1000)`,
      sql`select app.anonymize_persons(${NOW}, -1, 1000)`,
    ]) {
      await q.execute(t.worker);
    }
    expect(await notificationAlive(recentNotif)).toBe(true);
    expect(await isAnonDoc(d.docId)).toBe(false);
    expect((await personRow(p))?.anonymized).toBe(false);
    expect(
      await exists(
        sql<{ n: number }>`select count(*)::int as n from worker_heartbeats where name = 'ret-skew'`,
      ),
    ).toBe(true);
  });

  it("chỉ app_worker gọi được hàm; worker không có DELETE/UPDATE trực tiếp; hàm trợ giúp không cấp cho ai", async () => {
    for (const q of [
      sql`select app.purge_notifications(${NOW}, 180, 10)`,
      sql`select app.purge_worker_heartbeats(${NOW}, 30, 10)`,
      sql`select app.purge_auth_sessions(${NOW}, 30, 10)`,
      sql`select app.purge_auth_verifications(${NOW}, 1, 10)`,
      sql`select app.purge_guest_access_links(${NOW}, 90, 10)`,
      sql`select app.anonymize_identity_documents(${NOW}, 12, 10)`,
      sql`select app.anonymize_persons(${NOW}, 120, 10)`,
    ]) {
      await expect(q.execute(t.runtime)).rejects.toThrow(/permission denied/);
    }
    for (const db of [t.worker, t.runtime]) {
      await expect(
        sql`select * from app.retention_person_activity(${A.orgId}::uuid, ${A.ownerPersonId}::uuid)`.execute(
          db,
        ),
      ).rejects.toThrow(/permission denied/);
    }
    const priv = await sql<Record<string, boolean>>`
      select has_table_privilege('app_worker', 'notifications', 'DELETE') as notif,
             has_table_privilege('app_worker', 'worker_heartbeats', 'DELETE') as beat,
             has_table_privilege('app_worker', 'auth.session', 'DELETE') as sess,
             has_table_privilege('app_worker', 'auth.verification', 'DELETE') as ver,
             has_table_privilege('app_worker', 'guest_access_links', 'DELETE') as link,
             has_table_privilege('app_worker', 'identity_documents', 'UPDATE') as doc,
             has_table_privilege('app_worker', 'identity_documents', 'DELETE') as doc_del`.execute(t.admin);
    expect(Object.values(priv.rows[0] ?? {})).toEqual([false, false, false, false, false, false, false]);
    // Đường trực tiếp bị từ chối thật (không chỉ catalog).
    await expect(sql`delete from notifications`.execute(t.worker)).rejects.toThrow(/permission denied/);
    // (Postgres có thể báo lỗi RLS `app.org_id chưa đặt` trước lỗi quyền — cả hai đều là từ chối.)
    await expect(sql`update identity_documents set nationality = null`.execute(t.worker)).rejects.toThrow(
      /permission denied|app\.org_id chưa đặt/,
    );
    // `persons`: app_worker có sẵn quyền bảng UPDATE/DELETE từ migration 0001 (ngoài phạm vi T-2308) — RLS theo tổ chức chặn:
    // không có ngữ cảnh tổ chức thì lệnh bị từ chối; đường ẩn danh duy nhất là hàm `app.anonymize_persons`.
    await expect(
      sql`update persons set full_name = 'x' where id = ${A.ownerPersonId}`.execute(t.worker),
    ).rejects.toThrow(/app\.org_id chưa đặt/);
    await expect(sql`delete from persons where id = ${A.ownerPersonId}`.execute(t.worker)).rejects.toThrow(
      /app\.org_id chưa đặt/,
    );
    expect((await personRow(A.ownerPersonId))?.full_name).not.toBe("x");
  });

  it("một bảng lỗi không chặn bảng khác: AggregateError sau khi dọn xong phần còn lại, log nêu tên bảng", async () => {
    await sql`insert into worker_heartbeats (name, beat_at) values ('ret-iso', ${ago(45)})`.execute(t.admin);
    const old = await notification(A, ago(500));
    const logs: [string, unknown][] = [];
    await sql`revoke execute on function app.purge_notifications(timestamptz, integer, integer) from app_worker`.execute(
      t.admin,
    );
    try {
      await expect(
        purgeExpiredOperational(t.worker, { now: NOW, log: (e, f) => void logs.push([e, f.table]) }),
      ).rejects.toBeInstanceOf(AggregateError);
    } finally {
      await sql`grant execute on function app.purge_notifications(timestamptz, integer, integer) to app_worker`.execute(
        t.admin,
      );
    }
    expect(logs).toEqual([["retention.operational_purge_failed", "notifications"]]);
    expect(
      await exists(
        sql<{ n: number }>`select count(*)::int as n from worker_heartbeats where name = 'ret-iso'`,
      ),
    ).toBe(false);
    expect(await notificationAlive(old)).toBe(true);
    expect((await purgeExpiredOperational(t.worker, { now: NOW })).notifications).toBeGreaterThanOrEqual(1);
  });
});

describe("migration 0066 — down/up", () => {
  it("đứng sau 0065; down gỡ hàm và index; up áp lại được", async () => {
    const keys = Object.keys(migrations);
    expect(keys.indexOf("0066_personal_data_retention")).toBe(keys.indexOf("0065_role_write_policies") + 1);
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
              'purge_auth_verifications','purge_guest_access_links','retention_person_activity','anonymize_identity_documents',
              'anonymize_persons')`.execute(own.admin)
        ).rows[0]?.n,
        (
          await sql<{
            n: number;
          }>`select count(*)::int as n from pg_indexes where indexname in ('ix_notifications_created_at',
            'ix_auth_session_expires','ix_auth_verification_expires','ix_guest_links_dead_at','ix_identity_documents_retention',
            'ix_persons_retention','ix_stays_additional_guests')`.execute(own.admin)
        ).rows[0]?.n,
      ];
      expect(await count()).toEqual([8, 7]);
      await own.admin
        .transaction()
        .execute((trx) => (m.down ? m.down(trx) : Promise.reject(new Error("migration 0066 thiếu down"))));
      expect(await count()).toEqual([0, 0]);
      await own.admin.transaction().execute((trx) => m.up(trx));
      expect(await count()).toEqual([8, 7]);
    } finally {
      await own.drop();
    }
  });
});
