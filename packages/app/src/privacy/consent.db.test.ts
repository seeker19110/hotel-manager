// PLAN T-2310 (CMP-RIGHTS-001/004, CMP-VN-001; D-122; migration 0068) — đồng ý theo mục đích trên Postgres thật, bằng vai trò
// `app_runtime` như chạy thật: append-only (UPDATE/DELETE/TRUNCATE bị chặn kể cả admin); cho → rút → cho = 3 hàng, trạng thái hiện
// tại đúng; idempotent theo trạng thái (kể cả đồng thời); RLS theo NGƯỜI DÙNG (A không đọc/ghi của B, thiếu ngữ cảnh ⇒ lỗi);
// client không đặt được `recorded_at`; analytics: có đồng ý ⇒ `trackCommand` ghi, rút ⇒ thôi ghi; xuất lịch sử theo người;
// handler HTTP cho cả ca được phép và bị từ chối.
import { randomUUID } from "node:crypto";
import { withTenant, withUserContext } from "@hm/db";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveActor } from "../access/actor.ts";
import { configureAnalytics, resetAnalytics, track } from "../analytics/index.ts";
import { createPeriod } from "../billing/billing.ts";
import { handleGetConsents, handleSetConsent } from "../http/consents.ts";
import { executeCommand } from "../pipeline/command.ts";
import {
  CONSENT_PURPOSES,
  ConsentError,
  consentHistory,
  consentOverview,
  createAnalyticsConsentCheck,
  grantConsent,
  hasConsent,
  purposeDef,
  uiSnapshotHash,
  withdrawConsent,
} from "./index.ts";

let t: TestDb;
let A: SeededOrg;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà nghỉ Đồng Ý", "rental");
});
afterAll(async () => {
  await t?.drop();
});
afterEach(() => resetAnalytics());

const newUser = () => seedAuthUser(t.admin, `u-${randomUUID()}@example.com`);
const VERSION = purposeDef("analytics").version;

interface RawRow {
  subject_user_id: string;
  action: string;
  channel: string;
  policy_version: string;
  ui_snapshot_hash: string;
}
const rowsOf = async (userId: string) =>
  (
    await sql<RawRow>`select subject_user_id, action, channel, policy_version, ui_snapshot_hash from consent_records
                      where subject_user_id = ${userId} order by recorded_at, seq`.execute(t.admin)
  ).rows;

const analyticsGranted = async (userId: string) =>
  (await consentOverview(t.runtime, userId)).find((p) => p.id === "analytics")?.granted;

describe("consent_records — bảng append-only theo tài khoản (migration 0068)", () => {
  it("CHECK purpose của CSDL khớp đúng danh mục mục đích cần đồng ý trong mã", async () => {
    const r = await sql<{ def: string }>`
      select pg_get_constraintdef(c.oid) as def from pg_constraint c
      where c.conrelid = 'public.consent_records'::regclass and c.contype = 'c'
        and pg_get_constraintdef(c.oid) like '%purpose%'`.execute(t.admin);
    const values = [...(r.rows[0]?.def ?? "").matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...CONSENT_PURPOSES].sort());
  });

  it("UPDATE/DELETE/TRUNCATE bị chặn (SQLSTATE 55000) kể cả với admin; hàng còn nguyên", async () => {
    const u = await newUser();
    await grantConsent(t.runtime, u, { purpose: "analytics", channel: "signup" });
    for (const stmt of [
      sql`update consent_records set action = 'withdraw' where subject_user_id = ${u}`,
      sql`delete from consent_records where subject_user_id = ${u}`,
      sql`truncate consent_records`,
    ])
      await expect(stmt.execute(t.admin)).rejects.toMatchObject({ code: "55000" });
    expect((await rowsOf(u)).map((x) => x.action)).toEqual(["grant"]);
  });

  it("cho → rút → cho tạo 3 hàng; trạng thái hiện tại theo hàng mới nhất; băm văn bản + phiên bản do server đặt", async () => {
    const u = await newUser();
    expect(await analyticsGranted(u)).toBe(false);
    expect((await grantConsent(t.runtime, u, { purpose: "analytics", channel: "signup" })).status).toBe(
      "recorded",
    );
    expect(await analyticsGranted(u)).toBe(true);
    const w = await withdrawConsent(t.runtime, u, { purpose: "analytics", channel: "settings" });
    expect(w).toMatchObject({ status: "recorded", granted: false, record: { action: "withdraw" } });
    expect(await analyticsGranted(u)).toBe(false);
    await grantConsent(t.runtime, u, { purpose: "analytics", channel: "settings", policyVersion: VERSION });
    expect(await analyticsGranted(u)).toBe(true);
    const rows = await rowsOf(u);
    expect(rows.map((x) => [x.action, x.channel])).toEqual([
      ["grant", "signup"],
      ["withdraw", "settings"],
      ["grant", "settings"],
    ]);
    for (const r of rows) {
      expect(r.policy_version).toBe(VERSION);
      expect(r.ui_snapshot_hash).toBe(uiSnapshotHash(purposeDef("analytics")));
    }
  });

  it("idempotent theo trạng thái: cho lặp ⇒ unchanged, không thêm hàng; rút khi chưa từng cho ⇒ unchanged, 0 hàng", async () => {
    const u = await newUser();
    const w0 = await withdrawConsent(t.runtime, u, { purpose: "analytics", channel: "settings" });
    expect(w0).toEqual({ status: "unchanged", granted: false, record: null });
    expect(await rowsOf(u)).toHaveLength(0);
    await grantConsent(t.runtime, u, { purpose: "analytics", channel: "settings" });
    const again = await grantConsent(t.runtime, u, { purpose: "analytics", channel: "portal" });
    expect(again).toMatchObject({ status: "unchanged", granted: true, record: { channel: "settings" } });
    await withdrawConsent(t.runtime, u, { purpose: "analytics", channel: "settings" });
    expect((await withdrawConsent(t.runtime, u, { purpose: "analytics", channel: "settings" })).status).toBe(
      "unchanged",
    );
    expect(await rowsOf(u)).toHaveLength(2);
  });

  it("đồng thời: 6 lần cho cùng lúc của một người ⇒ đúng 1 hàng (khoá advisory theo người + mục đích)", async () => {
    const u = await newUser();
    const rs = await Promise.all(
      Array.from({ length: 6 }, () =>
        grantConsent(t.runtime, u, { purpose: "analytics", channel: "settings" }),
      ),
    );
    expect(rs.filter((r) => r.status === "recorded")).toHaveLength(1);
    expect(await rowsOf(u)).toHaveLength(1);
  });

  it("phiên bản văn bản client gửi khác bản hiện hành ⇒ ConsentError, không ghi; rút không cần khớp phiên bản", async () => {
    const u = await newUser();
    await expect(
      grantConsent(t.runtime, u, { purpose: "analytics", channel: "settings", policyVersion: "2000-01-01" }),
    ).rejects.toBeInstanceOf(ConsentError);
    expect(await rowsOf(u)).toHaveLength(0);
  });

  it("đồng ý theo phiên bản văn bản CŨ không còn hiệu lực (outdated) — cho lại theo bản mới ghi hàng mới", async () => {
    const u = await newUser();
    await sql`insert into consent_records (id, subject_user_id, purpose, action, policy_version, channel, ui_snapshot_hash)
              values (${randomUUID()}, ${u}, 'analytics', 'grant', '2025-01-01', 'signup', ${"a".repeat(64)})`.execute(
      t.admin,
    );
    const o = (await consentOverview(t.runtime, u)).find((p) => p.id === "analytics");
    expect(o).toMatchObject({ granted: false, outdated: true });
    expect(await hasConsent(t.runtime, u, "analytics")).toBe(false);
    expect((await grantConsent(t.runtime, u, { purpose: "analytics", channel: "settings" })).status).toBe(
      "recorded",
    );
    expect(await hasConsent(t.runtime, u, "analytics")).toBe(true);
  });

  it("mục đích không cần đồng ý hiện trong tổng quan với granted = null", async () => {
    const o = await consentOverview(t.runtime, await newUser());
    expect(o.filter((p) => !p.requiresConsent).map((p) => [p.id, p.granted])).toEqual([
      ["service", null],
      ["legal", null],
    ]);
  });
});

describe("RLS theo người dùng (app.user_id) — vai trò app_runtime", () => {
  it("A không thấy hàng của B; A không chèn được hàng mang subject B; thiếu ngữ cảnh ⇒ 42501", async () => {
    const a = await newUser();
    const b = await newUser();
    await grantConsent(t.runtime, a, { purpose: "analytics", channel: "settings" });
    await grantConsent(t.runtime, b, { purpose: "analytics", channel: "settings" });
    const seenByA = await withUserContext(t.runtime, a, async (trx) =>
      (
        await sql<{ s: string }>`select distinct subject_user_id::text as s from consent_records`.execute(trx)
      ).rows.map((x) => x.s),
    );
    expect(seenByA).toEqual([a]);
    expect((await consentHistory(t.runtime, a)).length).toBe(1);
    await expect(
      withUserContext(t.runtime, a, (trx) =>
        sql`insert into consent_records (id, subject_user_id, purpose, action, policy_version, channel, ui_snapshot_hash)
            values (${randomUUID()}, ${b}, 'analytics', 'withdraw', ${VERSION}, 'settings', ${"b".repeat(64)})`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await rowsOf(b)).map((x) => x.action)).toEqual(["grant"]);
    // Không đặt ngữ cảnh người dùng (kể cả có ngữ cảnh tổ chức) ⇒ lỗi rõ ràng, không âm thầm trả rỗng.
    await expect(
      withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
        sql`select count(*) from consent_records`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("app_runtime không đặt được recorded_at/seq, không UPDATE/DELETE; app_worker không có quyền bảng", async () => {
    const a = await newUser();
    await expect(
      withUserContext(t.runtime, a, (trx) =>
        sql`insert into consent_records (id, subject_user_id, purpose, action, policy_version, channel, ui_snapshot_hash, recorded_at)
            values (${randomUUID()}, ${a}, 'analytics', 'grant', ${VERSION}, 'settings', ${"c".repeat(64)}, '2020-01-01Z')`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await grantConsent(t.runtime, a, { purpose: "analytics", channel: "settings" });
    for (const stmt of [
      sql`update consent_records set channel = 'portal' where subject_user_id = ${a}`,
      sql`delete from consent_records where subject_user_id = ${a}`,
    ])
      await expect(withUserContext(t.runtime, a, (trx) => stmt.execute(trx))).rejects.toMatchObject({
        code: "42501",
      });
    await expect(sql`select count(*) from consent_records`.execute(t.worker)).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("analytics nối consent_records (createAnalyticsConsentCheck)", () => {
  const productEvents = async (userId: string) =>
    (
      await sql<{
        name: string;
      }>`select name from product_events where actor_user_id = ${userId} order by occurred_at`.execute(
        t.admin,
      )
    ).rows.map((x) => x.name);

  async function runCreate(org: SeededOrg, month: string) {
    const actor = await resolveActor(t.runtime, {
      authUserId: org.ownerAuthUserId,
      orgId: org.orgId,
      twoFactorEnabled: true,
    });
    return executeCommand(
      t.runtime,
      actor,
      {
        command: "billing.createPeriod",
        idempotencyKey: randomUUID(),
        payload: { month },
        correlationId: "c-consent",
      },
      async (ctx) => ({ data: await createPeriod(ctx, { propertyId: org.propertyId, month }) }),
    );
  }

  it("có đồng ý ⇒ trackCommand ghi; rút ⇒ lệnh sau không ghi nữa; chưa từng đồng ý ⇒ không ghi", async () => {
    const B = await seedOrg(t.admin, "Nhà trọ Đo Lường", "rental");
    const owner = B.ownerAuthUserId;
    configureAnalytics({ consent: createAnalyticsConsentCheck() });
    expect((await runCreate(B, "2027-01")).status).toBe("committed");
    expect(await productEvents(owner)).toEqual([]);

    await grantConsent(t.runtime, owner, { purpose: "analytics", channel: "signup" });
    expect((await runCreate(B, "2027-02")).status).toBe("committed");
    expect(await productEvents(owner)).toEqual(["billing_period.created"]);

    await withdrawConsent(t.runtime, owner, { purpose: "analytics", channel: "settings" });
    expect((await runCreate(B, "2027-03")).status).toBe("committed");
    expect(await productEvents(owner)).toEqual(["billing_period.created"]);
  });

  it("kiểm trong transaction của lệnh không đổi ngữ cảnh của nó (app.user_id khôi phục) và cache theo transaction", async () => {
    const u = await newUser();
    await grantConsent(t.runtime, u, { purpose: "analytics", channel: "settings" });
    const r = await withTenant(t.runtime, { orgId: A.orgId }, async (trx) => {
      const before = (
        await sql<{ v: string | null }>`select current_setting('app.user_id', true) as v`.execute(trx)
      ).rows[0]?.v;
      const first = await hasConsent(trx, u, "analytics");
      const after = (
        await sql<{ v: string | null }>`select current_setting('app.user_id', true) as v`.execute(trx)
      ).rows[0]?.v;
      // Rút ở transaction KHÁC: transaction đang chạy giữ kết quả đã cache (một lệnh = một quyết định).
      await withdrawConsent(t.runtime, u, { purpose: "analytics", channel: "settings" });
      const cached = await hasConsent(trx, u, "analytics");
      // Bảng theo tổ chức vẫn dùng được sau savepoint (transaction không bị "aborted").
      const n = (await sql<{ n: number }>`select count(*)::int as n from properties`.execute(trx)).rows[0]?.n;
      return { before, first, after, cached, n };
    });
    expect(r.first).toBe(true);
    expect(r.after).toBe(r.before);
    expect(r.cached).toBe(true);
    expect(r.n).toBeGreaterThanOrEqual(1);
    expect(await hasConsent(t.runtime, u, "analytics")).toBe(false);
  });

  it("không có người thao tác / mục đích khác ⇒ từ chối, không chạm CSDL", async () => {
    const check = createAnalyticsConsentCheck();
    expect(await check({ organizationId: A.orgId, actorUserId: null, purpose: "analytics" })).toBe(false);
    // Không db trong env và không fallback ⇒ từ chối.
    expect(await check({ organizationId: A.orgId, actorUserId: randomUUID(), purpose: "analytics" })).toBe(
      false,
    );
    const u = await newUser();
    await grantConsent(t.runtime, u, { purpose: "analytics", channel: "settings" });
    const r = await withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
      track(
        "core_task.completed",
        { task: "stay_checked_in" },
        { db: trx, organizationId: A.orgId, propertyId: A.propertyId, actorUserId: u },
        { consent: createAnalyticsConsentCheck() },
      ),
    );
    expect(r.status).toBe("recorded");
  });
});

describe("xuất lịch sử + handler HTTP /api/v1/me/consents", () => {
  const deps = (userId: string | null) => ({
    db: t.runtime,
    getSession: async () => (userId ? { user: { id: userId }, session: { createdAt: new Date() } } : null),
  });
  const post = (body: unknown) =>
    new Request("http://x/api/v1/me/consents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("lịch sử chỉ của chính người dùng, cũ → mới, đủ trường bằng chứng", async () => {
    const a = await newUser();
    const b = await newUser();
    await grantConsent(t.runtime, a, { purpose: "analytics", channel: "invite" });
    await withdrawConsent(t.runtime, a, { purpose: "analytics", channel: "settings" });
    await grantConsent(t.runtime, b, { purpose: "analytics", channel: "portal" });
    const h = await consentHistory(t.runtime, a);
    expect(h.map((x) => [x.action, x.channel])).toEqual([
      ["grant", "invite"],
      ["withdraw", "settings"],
    ]);
    for (const x of h) {
      expect(x.recordedAt).toBeInstanceOf(Date);
      expect(x.uiSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
      expect(x.policyVersion).toBe(VERSION);
    }
  });

  it("chưa đăng nhập ⇒ 401 cho GET và POST, không ghi", async () => {
    expect((await handleGetConsents(new Request("http://x/api/v1/me/consents"), deps(null))).status).toBe(
      401,
    );
    const r = await handleSetConsent(
      post({ purpose: "analytics", granted: true, channel: "settings" }),
      deps(null),
    );
    expect(r.status).toBe(401);
  });

  it("được phép: POST cho rồi rút (cùng một bước) ⇒ 200; GET chỉ trả của mình; ?download=1 là tệp tải về", async () => {
    const a = await newUser();
    const b = await newUser();
    await grantConsent(t.runtime, b, { purpose: "analytics", channel: "settings" });
    const g = await handleSetConsent(
      post({ purpose: "analytics", granted: true, channel: "signup", policy_version: VERSION }),
      deps(a),
    );
    expect(g.status).toBe(200);
    expect(await g.json()).toMatchObject({ data: { status: "recorded", granted: true } });
    const w = await handleSetConsent(
      post({ purpose: "analytics", granted: false, channel: "settings" }),
      deps(a),
    );
    expect(await w.json()).toMatchObject({ data: { status: "recorded", granted: false } });
    const res = await handleGetConsents(new Request("http://x/api/v1/me/consents?download=1"), deps(a));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const body = (await res.json()) as {
      purposes: { id: string; granted: boolean | null }[];
      history: { action: string }[];
    };
    expect(body.history.map((x) => x.action)).toEqual(["grant", "withdraw"]);
    expect(body.purposes.find((p) => p.id === "analytics")?.granted).toBe(false);
  });

  it("bị từ chối: mục đích không cần đồng ý/lạ, trường lạ ⇒ 422; phiên bản cũ ⇒ 409 VERSION_CONFLICT; thân không phải JSON ⇒ 400", async () => {
    const a = await newUser();
    for (const body of [
      { purpose: "service", granted: true, channel: "settings" },
      { purpose: "analytics", granted: true, channel: "email" },
      { purpose: "analytics", granted: "yes", channel: "settings" },
      { purpose: "analytics", granted: true, channel: "settings", subject_user_id: randomUUID() },
    ])
      expect((await handleSetConsent(post(body), deps(a))).status, JSON.stringify(body)).toBe(422);
    const stale = await handleSetConsent(
      post({ purpose: "analytics", granted: true, channel: "settings", policy_version: "2000-01-01" }),
      deps(a),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "VERSION_CONFLICT", current_version: VERSION });
    const bad = new Request("http://x/api/v1/me/consents", { method: "POST", body: "{" });
    expect((await handleSetConsent(bad, deps(a))).status).toBe(400);
    expect(await rowsOf(a)).toHaveLength(0);
  });
});
