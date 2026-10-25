// PLAN đợt 6 T-505 (XC-GREEN-007, ARC-RES-009) — dọn bảng sự kiện theo chính sách hạn giữ, trên Postgres thật, bằng vai trò
// `app_worker` như worker chạy thật: hàng cũ bị xoá, hàng mới/còn cần giữ không bị xoá, đúng mốc (nghiêm ngặt "<"), theo lô.
import { randomUUID } from "node:crypto";
import { migrations } from "@hm/db";
import { MS_PER_DAY } from "@hm/domain";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DELIVERY_DONE_RETENTION_DAYS,
  DELIVERY_FAILED_RETENTION_DAYS,
  OUTBOX_PUBLISHED_RETENTION_DAYS,
  purgeEventTables,
} from "./index.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
// Mốc "bây giờ" của test: đồng hồ CSDL (hàm chặn mốc bởi now() của CSDL nên mốc test phải không vượt now()).
const NOW = new Date(Date.now() - 1000);
const DAY = MS_PER_DAY;
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs).toISOString();

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà trọ Hoa Sen", "rental");
  B = await seedOrg(t.admin, "Nhà trọ khác", "rental");
});
afterAll(async () => {
  await t?.drop();
});

const alive = async (table: "outbox" | "idempotency_keys" | "notification_deliveries", ids: string[]) =>
  new Set(
    (
      await sql<{ id: string }>`select id from ${sql.table(table)} where id = any(${ids}::uuid[])`.execute(
        t.admin,
      )
    ).rows.map((r) => r.id),
  );

async function outbox(org: SeededOrg, publishedAt: string | null, error?: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into outbox (id, organization_id, event_type, payload, correlation_id, published_at, last_error, created_at)
            values (${id}, ${org.orgId}, 'retention.test', '{}'::jsonb, ${`c-${id}`}, ${publishedAt}, ${error ?? null},
                    ${publishedAt ?? ago(300)})`.execute(t.admin);
  return id;
}

describe("outbox đã phát", () => {
  it("quá 90 ngày bị xoá (mọi tổ chức); đúng mốc 90 ngày, 89 ngày, chưa phát (kể cả cũ/no_consumer) được giữ", async () => {
    expect(OUTBOX_PUBLISHED_RETENTION_DAYS).toBe(90);
    const old = await outbox(A, ago(91));
    const oldOtherOrg = await outbox(B, ago(400));
    const justOver = await outbox(A, ago(90, 1000)); // cũ hơn mốc 1 giây
    const atBoundary = await outbox(A, ago(90)); // đúng mốc ⇒ giữ (so sánh nghiêm ngặt)
    const justUnder = await outbox(A, ago(90, -1000)); // mới hơn mốc 1 giây
    const recent = await outbox(A, ago(89));
    const unpublishedOld = await outbox(A, null);
    const noConsumer = await outbox(A, null, "no_consumer");
    const all = [old, oldOtherOrg, justOver, atBoundary, justUnder, recent, unpublishedOld, noConsumer];

    const stats = await purgeEventTables(t.worker, { now: NOW });
    expect(stats.outbox).toBe(3);
    expect(await alive("outbox", all)).toEqual(
      new Set([atBoundary, justUnder, recent, unpublishedOld, noConsumer]),
    );

    // Chạy lại: không còn gì để xoá (idempotent), hàng giữ nguyên.
    expect((await purgeEventTables(t.worker, { now: NOW })).outbox).toBe(0);
  });

  it("xoá theo lô có trần: lô 3 × 2 vòng xoá 6 trong 7 hàng; lượt sau xoá nốt hàng còn lại", async () => {
    const ids = await Promise.all(Array.from({ length: 7 }, (_, i) => outbox(A, ago(100 + i))));
    const first = await purgeEventTables(t.worker, { now: NOW, batch: 3, maxRounds: 2 });
    expect(first.outbox).toBe(6);
    expect((await alive("outbox", ids)).size).toBe(1);
    const second = await purgeEventTables(t.worker, { now: NOW, batch: 3, maxRounds: 2 });
    expect(second.outbox).toBe(1);
    expect((await alive("outbox", ids)).size).toBe(0);
  });

  it("bảng rỗng: không lỗi, trả 0", async () => {
    const s = await purgeEventTables(t.worker, { now: NOW });
    expect(s).toEqual({ outbox: 0, idempotencyKeys: 0, notificationDeliveries: 0 });
  });
});

async function idem(org: SeededOrg, expiresAt: string, status = "committed"): Promise<string> {
  const id = randomUUID();
  // `created_at < expires_at` (ck_idempotency_expiry): đặt tạo trước hạn 7 ngày như mặc định.
  await sql`insert into idempotency_keys (id, organization_id, key, command, actor_person_id, request_hash, status, response,
                                          correlation_id, created_at, expires_at)
            values (${id}, ${org.orgId}, ${randomUUID()}, 'test.command', ${org.ownerPersonId}, decode(${"ab".repeat(32)}, 'hex'),
                    ${status}, ${status === "committed" ? "{}" : null}::jsonb, 'c', (${expiresAt}::timestamptz - interval '7 days'),
                    ${expiresAt})`.execute(t.admin);
  return id;
}

describe("idempotency_keys hết hạn", () => {
  it("hết hạn bị xoá (cả in_progress bị bỏ dở, mọi tổ chức); đúng mốc hết hạn và chưa hết hạn được giữ", async () => {
    const expired = await idem(A, ago(0, 1000));
    const expiredOld = await idem(B, ago(30));
    const stuck = await idem(A, ago(2), "in_progress");
    const atBoundary = await idem(A, NOW.toISOString()); // expires_at = mốc ⇒ chưa "quá" hạn
    const future = await idem(A, new Date(NOW.getTime() + DAY).toISOString());
    const all = [expired, expiredOld, stuck, atBoundary, future];
    const stats = await purgeEventTables(t.worker, { now: NOW });
    expect(stats.idempotencyKeys).toBe(3);
    expect(await alive("idempotency_keys", all)).toEqual(new Set([atBoundary, future]));
  });
});

async function delivery(
  org: SeededOrg,
  status: "queued" | "sending" | "sent" | "retrying" | "failed" | "dead" | "suppressed",
  ageDays: number,
  extraMs = 0,
): Promise<string> {
  const notif = randomUUID();
  const id = randomUUID();
  const at = ago(ageDays, extraMs);
  await sql`insert into notifications (id, organization_id, recipient_person_id, type, title, body, dedupe_key, created_at)
            values (${notif}, ${org.orgId}, ${org.ownerPersonId}, 'invoice_issued', 'Thông báo giả', 'Nội dung giả', ${`d-${notif}`}, ${at})`.execute(
    t.admin,
  );
  await sql`insert into notification_deliveries (id, organization_id, notification_id, status, suppressed_reason, next_attempt_at,
                                                  locked_until, sent_at, created_at, updated_at)
            values (${id}, ${org.orgId}, ${notif}, ${status}, ${status === "suppressed" ? "OPTED_OUT" : null},
                    ${status === "queued" || status === "retrying" ? at : null},
                    ${status === "sending" ? at : null}, ${status === "sent" ? at : null}, ${at}, ${at})`.execute(
    t.admin,
  );
  return id;
}

describe("notification_deliveries", () => {
  it("đã xong (sent/suppressed) quá 90 ngày bị xoá; failed/dead quá 180 ngày bị xoá; đang xử lý và còn trong hạn được giữ", async () => {
    expect(DELIVERY_DONE_RETENTION_DAYS).toBe(90);
    expect(DELIVERY_FAILED_RETENTION_DAYS).toBe(180);
    const sentOld = await delivery(A, "sent", 91);
    const suppressedOld = await delivery(B, "suppressed", 120);
    const sentJustOver = await delivery(A, "sent", 90, 1000);
    const sentBoundary = await delivery(A, "sent", 90); // đúng mốc ⇒ giữ
    const sentRecent = await delivery(A, "sent", 89);
    const failedOld = await delivery(A, "failed", 181);
    const deadOld = await delivery(B, "dead", 365);
    const failedMid = await delivery(A, "failed", 91); // hết hạn của "xong" nhưng failed giữ tới 180 ngày
    const deadBoundary = await delivery(A, "dead", 180);
    // Chưa xong thì không bao giờ xoá theo tuổi (còn việc phải làm).
    const queued = await delivery(A, "queued", 400);
    const sending = await delivery(A, "sending", 400);
    const retrying = await delivery(A, "retrying", 400);
    const all = [
      sentOld,
      suppressedOld,
      sentJustOver,
      sentBoundary,
      sentRecent,
      failedOld,
      deadOld,
      failedMid,
      deadBoundary,
      queued,
      sending,
      retrying,
    ];
    const stats = await purgeEventTables(t.worker, { now: NOW });
    expect(stats.notificationDeliveries).toBe(5);
    expect(await alive("notification_deliveries", all)).toEqual(
      new Set([sentBoundary, sentRecent, failedMid, deadBoundary, queued, sending, retrying]),
    );
    // Thông báo (hàng cha) không bị động tới: chỉ dọn lần gửi.
    const parents = await sql<{ n: number }>`select count(*)::int as n from notifications`.execute(t.admin);
    expect(parents.rows[0]?.n).toBeGreaterThanOrEqual(all.length);
  });
});

describe("an toàn của hàm dọn", () => {
  it("mốc ở tương lai (đồng hồ worker lệch) không xoá hàng chưa tới hạn; số ngày 0/âm được nâng lên 1", async () => {
    const recentOutbox = await outbox(A, ago(0.5));
    const futureIdem = await idem(A, new Date(Date.now() + DAY).toISOString());
    const recentDelivery = await delivery(A, "sent", 0.5);
    const farFuture = new Date(Date.now() + 1000 * DAY);
    await sql`select app.purge_outbox(${farFuture}, 90, 1000)`.execute(t.worker);
    await sql`select app.purge_idempotency_keys(${farFuture}, 1000)`.execute(t.worker);
    await sql`select app.purge_notification_deliveries(${farFuture}, 90, 180, 1000)`.execute(t.worker);
    await sql`select app.purge_outbox(${NOW}, 0, 1000)`.execute(t.worker);
    await sql`select app.purge_outbox(${NOW}, -5, 1000)`.execute(t.worker);
    await sql`select app.purge_notification_deliveries(${NOW}, 0, -1, 1000)`.execute(t.worker);
    expect(await alive("outbox", [recentOutbox])).toEqual(new Set([recentOutbox]));
    expect(await alive("idempotency_keys", [futureIdem])).toEqual(new Set([futureIdem]));
    expect(await alive("notification_deliveries", [recentDelivery])).toEqual(new Set([recentDelivery]));
  });

  it("chỉ app_worker gọi được hàm; worker không có DELETE trực tiếp; runtime không gọi được; audit_events không xoá được", async () => {
    await expect(sql`select app.purge_outbox(${NOW}, 90, 10)`.execute(t.runtime)).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`select app.purge_idempotency_keys(${NOW}, 10)`.execute(t.runtime)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      sql`select app.purge_notification_deliveries(${NOW}, 90, 180, 10)`.execute(t.runtime),
    ).rejects.toThrow(/permission denied/);
    const priv = await sql<{ o: boolean; d: boolean }>`
      select has_table_privilege('app_worker', 'outbox', 'DELETE') as o,
             has_table_privilege('app_worker', 'notification_deliveries', 'DELETE') as d`.execute(t.admin);
    expect(priv.rows[0]).toEqual({ o: false, d: false });
    // Sự kiện audit cũ 10 năm vẫn ở đó sau mọi lượt dọn (append-only, không nằm trong chính sách dọn).
    const audit = randomUUID();
    await sql`insert into audit_events (id, organization_id, occurred_at, actor_type, action, entity_type, correlation_id, created_at)
              values (${audit}, ${A.orgId}, ${ago(3650)}, 'worker', 'retention.test', 'outbox', 'c', ${ago(3650)})`.execute(
      t.admin,
    );
    await purgeEventTables(t.worker, { now: NOW });
    const left = await sql<{
      n: number;
    }>`select count(*)::int as n from audit_events where id = ${audit}`.execute(t.admin);
    expect(left.rows[0]?.n).toBe(1);
  });

  it("một bảng lỗi không chặn bảng khác: ném AggregateError sau khi dọn xong phần còn lại, log nêu tên bảng", async () => {
    const oldDelivery = await delivery(A, "sent", 120);
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    await sql`revoke execute on function app.purge_outbox(timestamptz, integer, integer) from app_worker`.execute(
      t.admin,
    );
    try {
      await expect(
        purgeEventTables(t.worker, { now: NOW, log: (event, fields) => void logs.push({ event, fields }) }),
      ).rejects.toBeInstanceOf(AggregateError);
    } finally {
      await sql`grant execute on function app.purge_outbox(timestamptz, integer, integer) to app_worker`.execute(
        t.admin,
      );
    }
    expect(await alive("notification_deliveries", [oldDelivery])).toEqual(new Set());
    expect(logs.map((l) => [l.event, l.fields.table])).toEqual([["retention.events_purge_failed", "outbox"]]);
  });
});

describe("migration 0056 — down/up", () => {
  it("down gỡ hàm và index; up áp lại được", async () => {
    const m = migrations["0056_event_table_retention"];
    if (!m) throw new Error("thiếu migration 0056_event_table_retention");
    const own = await createTestDb(); // DB riêng: không đụng dữ liệu các test trên
    try {
      // [số hàm app.purge_* của 0056 + `purge_import_rows` (0045), số index của 0056] — theo TÊN: migration sau thêm hàm purge_* khác
      // (vd hạn lưu dữ liệu cá nhân) không làm đổi phép đếm của 0056 (job schema-compat chạy test này trên schema mới hơn).
      const count = async () => [
        (
          await sql<{
            n: number;
          }>`select count(*)::int as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                                   where s.nspname = 'app' and p.proname in ('purge_outbox', 'purge_idempotency_keys',
                                     'purge_notification_deliveries', 'purge_import_rows')`.execute(own.admin)
        ).rows[0]?.n,
        (
          await sql<{ n: number }>`select count(*)::int as n from pg_indexes
                                   where indexname in ('ix_outbox_published_at','ix_notification_deliveries_done')`.execute(
            own.admin,
          )
        ).rows[0]?.n,
      ];
      expect(await count()).toEqual([4, 2]);
      await own.admin
        .transaction()
        .execute((trx) => (m.down ? m.down(trx) : Promise.reject(new Error("migration 0056 thiếu down"))));
      expect(await count()).toEqual([1, 0]);
      await own.admin.transaction().execute((trx) => m.up(trx));
      expect(await count()).toEqual([4, 2]);
    } finally {
      await own.drop();
    }
  });
});
