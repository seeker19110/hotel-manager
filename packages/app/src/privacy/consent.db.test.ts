// T-2310 (CMP-RIGHTS-001, CMP-VN-001, CMP-RIGHTS-004; D-119) — đồng ý theo mục đích trên Postgres thật: `consent_records` chỉ-thêm
// (trigger + quyền), RLS theo người dùng (app.auth_user_id), CHECK danh mục đóng, cấp/rút = hàng mới, đồng thời, API của chính người dùng
// (không nhận chủ thể từ client), đăng ký thiếu service_core bị từ chối ở server, track() bỏ qua người chưa đồng ý product_analytics.
import { createHash, randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyticsActorKey, pseudonymizeActor, track } from "../analytics/index.ts";
import { type Auth, createAuth, parseSignUpConsent } from "../auth/auth.ts";
import { handleConsentsGet, handleConsentsPost } from "../http/consents-route.ts";
import {
  CONSENT_POLICY_VERSION,
  ConsentError,
  consentDisplays,
  consentSnapshotHash,
  consentText,
  currentConsents,
  grantConsent,
  hasConsent,
  withdrawConsent,
} from "./index.ts";

const BASE = "http://localhost:3000";
const PASSWORD = ["mat", "khau", "dong", "y", "12"].join("-");

let t: TestDb;
let auth: Auth;
let closeAuth: () => Promise<void>;
let A: SeededOrg;

beforeAll(async () => {
  t = await createTestDb();
  const created = createAuth({
    databaseUrl: t.runtimeUrl,
    secret: "s".repeat(48),
    baseURL: BASE,
    ipRateLimit: false,
  });
  auth = created.auth;
  closeAuth = created.close;
  A = await seedOrg(t.admin, "KS đồng ý");
});
afterAll(async () => {
  await closeAuth?.();
  await t?.drop();
});

const user = () => seedAuthUser(t.admin, `dy-${randomUUID()}@example.test`);
const rows = async (subject: string) =>
  (
    await sql<{
      purpose: string;
      action: string;
      channel: string;
      policy_version: string;
      ui_snapshot_hash: string;
    }>`select purpose, action, channel, policy_version, ui_snapshot_hash from consent_records
       where subject_user_id = ${subject} order by id`.execute(t.admin)
  ).rows;
const inSubject = <T>(
  subject: string | null,
  fn: (trx: import("kysely").Transaction<unknown>) => Promise<T>,
) =>
  t.runtime.transaction().execute(async (trx) => {
    if (subject) await sql`select set_config('app.auth_user_id', ${subject}, true)`.execute(trx);
    return fn(trx);
  });

describe("danh mục mục đích + bằng chứng (CMP-VN-001)", () => {
  it("hai mục đích đóng, chỉ service_core bắt buộc; văn bản từ catalog, có nêu loại dữ liệu/mục đích/bên nhận", () => {
    expect(consentDisplays().map((d) => [d.purpose, d.required])).toEqual([
      ["service_core", true],
      ["product_analytics", false],
    ]);
    for (const d of consentDisplays()) {
      expect(d.text.length).toBeGreaterThan(80);
      expect(d.policyVersion).toBe(CONSENT_POLICY_VERSION);
    }
    expect(consentText("product_analytics")).toMatch(/không chia sẻ cho bên thứ ba/);
  });

  it("băm = SHA-256(version + mục đích + văn bản); khác mục đích/khác phiên bản ⇒ khác băm", () => {
    const expected = createHash("sha256")
      .update(`${CONSENT_POLICY_VERSION}\nservice_core\n${consentText("service_core")}`)
      .digest("hex");
    expect(consentSnapshotHash("service_core")).toBe(expected);
    expect(consentSnapshotHash("product_analytics")).not.toBe(expected);
    expect(consentSnapshotHash("service_core", "2027-01-01")).not.toBe(expected);
  });
});

describe("cấp / rút = hàng mới, không sửa tại chỗ (CMP-RIGHTS-001)", () => {
  it("người mới: mọi mục đích null, hasConsent false", async () => {
    const u = await user();
    expect(await currentConsents(t.runtime, u)).toEqual({ service_core: null, product_analytics: null });
    expect(await hasConsent(t.runtime, u, "service_core")).toBe(false);
    expect(await hasConsent(t.runtime, "khong-phai-uuid", "service_core")).toBe(false);
  });

  it("cấp → một hàng grant với phiên bản + băm của server; rút → THÊM hàng withdraw, hàng cũ còn nguyên; cấp lại → thêm hàng", async () => {
    const u = await user();
    const g = await grantConsent(t.runtime, {
      subjectId: u,
      purpose: "product_analytics",
      channel: "register",
    });
    expect(g.changed).toBe(true);
    expect(g.state).toMatchObject({
      granted: true,
      channel: "register",
      policyVersion: CONSENT_POLICY_VERSION,
    });
    expect(await hasConsent(t.runtime, u, "product_analytics")).toBe(true);
    await withdrawConsent(t.runtime, { subjectId: u, purpose: "product_analytics", channel: "settings" });
    expect(await hasConsent(t.runtime, u, "product_analytics")).toBe(false);
    await grantConsent(t.runtime, { subjectId: u, purpose: "product_analytics", channel: "settings" });
    const r = await rows(u);
    expect(r.map((x) => [x.action, x.channel])).toEqual([
      ["grant", "register"],
      ["withdraw", "settings"],
      ["grant", "settings"],
    ]);
    expect(new Set(r.map((x) => x.ui_snapshot_hash))).toEqual(
      new Set([consentSnapshotHash("product_analytics")]),
    );
    expect((await currentConsents(t.runtime, u)).product_analytics?.granted).toBe(true);
    expect((await currentConsents(t.runtime, u)).service_core).toBeNull();
  });

  it("không đổi trạng thái thì không ghi: cấp hai lần = 1 hàng; rút khi chưa từng cấp = 0 hàng; rút hai lần = 1 hàng withdraw", async () => {
    const u = await user();
    expect(
      (await withdrawConsent(t.runtime, { subjectId: u, purpose: "product_analytics", channel: "settings" }))
        .changed,
    ).toBe(false);
    expect(await rows(u)).toEqual([]);
    await grantConsent(t.runtime, { subjectId: u, purpose: "service_core", channel: "portal" });
    expect(
      (await grantConsent(t.runtime, { subjectId: u, purpose: "service_core", channel: "settings" })).changed,
    ).toBe(false);
    await grantConsent(t.runtime, { subjectId: u, purpose: "product_analytics", channel: "settings" });
    await withdrawConsent(t.runtime, { subjectId: u, purpose: "product_analytics", channel: "settings" });
    await withdrawConsent(t.runtime, { subjectId: u, purpose: "product_analytics", channel: "settings" });
    expect((await rows(u)).map((x) => `${x.purpose}:${x.action}`)).toEqual([
      "service_core:grant",
      "product_analytics:grant",
      "product_analytics:withdraw",
    ]);
  });

  it("cấp lại khi phiên bản chính sách đã đổi (hàng cũ khác phiên bản) → ghi hàng mới với phiên bản hiện hành", async () => {
    const u = await user();
    await sql`insert into consent_records (subject_user_id, purpose, action, policy_version, channel, ui_snapshot_hash)
              values (${u}, 'service_core', 'grant', '2026-01-01', 'register', ${"b".repeat(64)})`.execute(
      t.admin,
    );
    expect(
      (await grantConsent(t.runtime, { subjectId: u, purpose: "service_core", channel: "settings" })).changed,
    ).toBe(true);
    expect((await rows(u)).map((x) => x.policy_version)).toEqual(["2026-01-01", CONSENT_POLICY_VERSION]);
  });

  it("rút service_core (bắt buộc) bị từ chối — rút = xoá tài khoản (T-2311); không ghi gì", async () => {
    const u = await user();
    await grantConsent(t.runtime, { subjectId: u, purpose: "service_core", channel: "register" });
    await expect(
      withdrawConsent(t.runtime, { subjectId: u, purpose: "service_core", channel: "settings" }),
    ).rejects.toMatchObject({ code: "CONSENT_WITHDRAW_REQUIRES_DELETION" });
    expect((await rows(u)).length).toBe(1);
    expect(await hasConsent(t.runtime, u, "service_core")).toBe(true);
  });

  it("đầu vào sai ném ConsentError trước khi chạm CSDL: id không phải UUID, mục đích/kênh lạ", async () => {
    await expect(
      grantConsent(t.runtime, { subjectId: "x", purpose: "service_core", channel: "register" }),
    ).rejects.toBeInstanceOf(ConsentError);
    const u = await user();
    await expect(
      grantConsent(t.runtime, { subjectId: u, purpose: "marketing" as never, channel: "register" }),
    ).rejects.toBeInstanceOf(ConsentError);
    await expect(
      grantConsent(t.runtime, { subjectId: u, purpose: "service_core", channel: "email" as never }),
    ).rejects.toBeInstanceOf(ConsentError);
    expect(await rows(u)).toEqual([]);
  });
});

describe("đồng thời", () => {
  it("20 lần cấp song song cùng người + mục đích → đúng 1 hàng", async () => {
    const u = await user();
    const rs = await Promise.all(
      Array.from({ length: 20 }, () =>
        grantConsent(t.runtime, { subjectId: u, purpose: "product_analytics", channel: "settings" }),
      ),
    );
    expect(rs.filter((r) => r.changed)).toHaveLength(1);
    expect(await rows(u)).toHaveLength(1);
  });

  it("bật/tắt song song xen kẽ: lịch sử luôn xen kẽ grant/withdraw (không hai hàng liền nhau cùng hành động) và trạng thái = hàng cuối", async () => {
    const u = await user();
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        i % 2 === 0
          ? grantConsent(t.runtime, { subjectId: u, purpose: "product_analytics", channel: "settings" })
          : withdrawConsent(t.runtime, { subjectId: u, purpose: "product_analytics", channel: "settings" }),
      ),
    );
    const acts = (await rows(u)).map((x) => x.action);
    expect(acts[0]).toBe("grant");
    for (let i = 1; i < acts.length; i++) expect(acts[i]).not.toBe(acts[i - 1]);
    expect(await hasConsent(t.runtime, u, "product_analytics")).toBe(acts.at(-1) === "grant");
  });
});

describe("CSDL: chỉ-thêm, danh mục đóng, RLS theo người dùng", () => {
  it("UPDATE/DELETE/TRUNCATE bị trigger chặn kể cả với owner (55000); app_runtime không có quyền UPDATE/DELETE; worker không đọc", async () => {
    const u = await user();
    await grantConsent(t.runtime, { subjectId: u, purpose: "service_core", channel: "register" });
    await expect(sql`update consent_records set action = 'withdraw'`.execute(t.admin)).rejects.toMatchObject({
      code: "55000",
    });
    await expect(sql`delete from consent_records`.execute(t.admin)).rejects.toMatchObject({ code: "55000" });
    await expect(sql`truncate consent_records`.execute(t.admin)).rejects.toMatchObject({ code: "55000" });
    await expect(
      inSubject(u, (trx) => sql`update consent_records set action = 'withdraw'`.execute(trx)),
    ).rejects.toThrow(/permission denied/);
    await expect(inSubject(u, (trx) => sql`delete from consent_records`.execute(trx))).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`select count(*) from consent_records`.execute(t.worker)).rejects.toThrow(
      /permission denied/,
    );
    expect((await rows(u)).length).toBe(1);
  });

  it("CHECK: mục đích/hành động/kênh ngoài danh mục, băm không phải hex 64, phiên bản sai dạng, người dùng không tồn tại → từ chối", async () => {
    const u = await user();
    const ins = (cols: Record<string, string>) => {
      const v = {
        subject_user_id: u,
        purpose: "service_core",
        action: "grant",
        policy_version: "2026-10-25",
        channel: "register",
        ui_snapshot_hash: "c".repeat(64),
        ...cols,
      };
      return sql`insert into consent_records (subject_user_id, purpose, action, policy_version, channel, ui_snapshot_hash)
        values (${v.subject_user_id}, ${v.purpose}, ${v.action}, ${v.policy_version}, ${v.channel}, ${v.ui_snapshot_hash})`.execute(
        t.admin,
      );
    };
    for (const bad of [
      { purpose: "marketing" },
      { action: "update" },
      { channel: "email" },
      { ui_snapshot_hash: "C".repeat(64) },
      { ui_snapshot_hash: "c".repeat(63) },
      { policy_version: "v1" },
      { policy_version: "" },
      { subject_user_id: randomUUID() },
    ])
      await expect(ins(bad), JSON.stringify(bad)).rejects.toThrow();
    await ins({});
    expect((await rows(u)).length).toBe(1);
  });

  it("RLS: không ngữ cảnh người dùng → không thấy/không ghi được; ngữ cảnh của A không đọc/ghi được hàng của B", async () => {
    const a = await user();
    const b = await user();
    await grantConsent(t.runtime, { subjectId: a, purpose: "service_core", channel: "register" });
    await grantConsent(t.runtime, { subjectId: b, purpose: "service_core", channel: "register" });
    expect((await sql`select * from consent_records`.execute(t.runtime)).rows).toEqual([]);
    const seen = await inSubject(a, (trx) =>
      sql<{ s: string }>`select subject_user_id as s from consent_records`.execute(trx),
    );
    expect(new Set(seen.rows.map((r) => r.s))).toEqual(new Set([a]));
    const hash = consentSnapshotHash("product_analytics");
    await expect(
      inSubject(a, (trx) =>
        sql`insert into consent_records (subject_user_id, purpose, action, policy_version, channel, ui_snapshot_hash)
            values (${b}, 'product_analytics', 'grant', ${CONSENT_POLICY_VERSION}, 'settings', ${hash})`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inSubject(null, (trx) =>
        sql`insert into consent_records (subject_user_id, purpose, action, policy_version, channel, ui_snapshot_hash)
            values (${a}, 'product_analytics', 'grant', ${CONSENT_POLICY_VERSION}, 'settings', ${hash})`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await hasConsent(t.runtime, b, "product_analytics")).toBe(false);
  });
});

describe("API /api/v1/privacy/consents — chỉ của chính người đăng nhập (CMP-RIGHTS-004: rút một bước)", () => {
  const deps = () => ({
    db: t.runtime,
    getSession: async (h: Headers) => {
      const id = h.get("x-test-user");
      return id ? { user: { id } } : null;
    },
  });
  const get = (who?: string) =>
    handleConsentsGet(
      new Request(`${BASE}/api/v1/privacy/consents`, { headers: who ? { "x-test-user": who } : {} }),
      deps(),
    );
  const post = (who: string | undefined, body: unknown) =>
    handleConsentsPost(
      new Request(`${BASE}/api/v1/privacy/consents`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(who ? { "x-test-user": who } : {}) },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      deps(),
    );
  type Body = {
    consents: { purpose: string; granted: boolean; required: boolean; channel: string | null }[];
    code?: string;
  };

  it("không phiên → 401 cho cả GET và POST, không ghi gì", async () => {
    expect((await get()).status).toBe(401);
    expect(
      (await post(undefined, { purpose: "product_analytics", action: "grant", channel: "settings" })).status,
    ).toBe(401);
  });

  it("bật rồi tắt product_analytics: mỗi lần MỘT request; GET phản ánh; có hàng withdraw kênh settings", async () => {
    const u = await user();
    const g0 = (await (await get(u)).json()) as Body;
    expect(g0.consents.map((c) => [c.purpose, c.required, c.granted])).toEqual([
      ["service_core", true, false],
      ["product_analytics", false, false],
    ]);
    const on = await post(u, { purpose: "product_analytics", action: "grant", channel: "settings" });
    expect(on.status).toBe(200);
    expect(((await on.json()) as Body).consents.find((c) => c.purpose === "product_analytics")?.granted).toBe(
      true,
    );
    const off = await post(u, { purpose: "product_analytics", action: "withdraw", channel: "settings" });
    expect(off.status).toBe(200);
    expect(
      ((await off.json()) as Body).consents.find((c) => c.purpose === "product_analytics"),
    ).toMatchObject({
      granted: false,
      channel: "settings",
    });
    expect((await rows(u)).map((x) => x.action)).toEqual(["grant", "withdraw"]);
  });

  it("rút service_core → 409 CONSENT_WITHDRAW_REQUIRES_DELETION; cấp service_core kênh portal được (đăng nhập portal lần đầu)", async () => {
    const u = await user();
    expect((await post(u, { purpose: "service_core", action: "grant", channel: "portal" })).status).toBe(200);
    const r = await post(u, { purpose: "service_core", action: "withdraw", channel: "settings" });
    expect([r.status, ((await r.json()) as Body).code]).toEqual([409, "CONSENT_WITHDRAW_REQUIRES_DELETION"]);
    expect((await rows(u)).map((x) => `${x.action}:${x.channel}`)).toEqual(["grant:portal"]);
  });

  it("không tin client cho chủ thể: trường lạ (subject_user_id) → 422; kênh register/mục đích lạ → 422; thân không phải JSON → 400; người khác không bị đổi", async () => {
    const me = await user();
    const victim = await user();
    for (const body of [
      { purpose: "product_analytics", action: "grant", channel: "settings", subject_user_id: victim },
      { purpose: "product_analytics", action: "grant", channel: "register" },
      { purpose: "marketing", action: "grant", channel: "settings" },
      { purpose: "product_analytics", action: "toggle", channel: "settings" },
      {},
    ]) {
      const r = await post(me, body);
      expect([r.status, ((await r.json()) as Body).code], JSON.stringify(body)).toEqual([
        422,
        "VALIDATION_FAILED",
      ]);
    }
    expect((await post(me, "khong-json")).status).toBe(400);
    expect(await rows(victim)).toEqual([]);
    expect(await rows(me)).toEqual([]);
  });
});

describe("đăng ký (Better Auth) — service_core bắt buộc, ghi ở server", () => {
  const signUp = (body: Record<string, unknown>) =>
    auth.handler(
      new Request(`${BASE}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ name: "Người đăng ký", password: PASSWORD, ...body }),
      }),
    );
  const userIdOf = async (email: string) =>
    (await sql<{ id: string }>`select id from auth."user" where email = ${email}`.execute(t.admin)).rows[0]
      ?.id;

  it("thiếu/sai đồng ý bắt buộc → 400 CONSENT_REQUIRED, KHÔNG tạo tài khoản", async () => {
    for (const consents of [
      undefined,
      {},
      { service_core: false },
      { service_core: "true" },
      { service_core: true, product_analytics: "yes" },
      { service_core: true, marketing: true },
      null,
    ]) {
      const email = `thieu-${randomUUID().slice(0, 8)}@example.test`;
      const res = await signUp({ email, ...(consents === undefined ? {} : { consents }) });
      expect(res.status, JSON.stringify(consents)).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("CONSENT_REQUIRED");
      expect(await userIdOf(email)).toBeUndefined();
    }
    const email = `kenh-${randomUUID().slice(0, 8)}@example.test`;
    expect(
      (await signUp({ email, consents: { service_core: true }, consent_channel: "settings" })).status,
    ).toBe(400);
    expect(await userIdOf(email)).toBeUndefined();
  });

  it("chỉ service_core → 1 hàng grant kênh register; analytics KHÔNG được ghi (mặc định không đồng ý)", async () => {
    const email = `core-${randomUUID().slice(0, 8)}@example.test`;
    expect((await signUp({ email, consents: { service_core: true, product_analytics: false } })).status).toBe(
      200,
    );
    const id = (await userIdOf(email)) as string;
    expect((await rows(id)).map((x) => `${x.purpose}:${x.action}:${x.channel}`)).toEqual([
      "service_core:grant:register",
    ]);
    expect((await rows(id))[0]?.ui_snapshot_hash).toBe(consentSnapshotHash("service_core"));
  });

  it("tick analytics → 2 hàng; đăng ký từ trang lời mời → kênh invitation", async () => {
    const email = `ca-hai-${randomUUID().slice(0, 8)}@example.test`;
    expect(
      (
        await signUp({
          email,
          consents: { service_core: true, product_analytics: true },
          consent_channel: "invitation",
        })
      ).status,
    ).toBe(200);
    const id = (await userIdOf(email)) as string;
    expect((await rows(id)).map((x) => `${x.purpose}:${x.channel}`)).toEqual([
      "service_core:invitation",
      "product_analytics:invitation",
    ]);
  });

  it("đăng ký lại email đã có (phản hồi chung, người dùng giả) → không ghi đồng ý thay cho chủ tài khoản thật", async () => {
    const email = `trung-${randomUUID().slice(0, 8)}@example.test`;
    expect((await signUp({ email, consents: { service_core: true } })).status).toBe(200);
    const id = (await userIdOf(email)) as string;
    expect((await signUp({ email, consents: { service_core: true, product_analytics: true } })).status).toBe(
      200,
    );
    expect((await rows(id)).map((x) => x.purpose)).toEqual(["service_core"]);
  });

  it("parseSignUpConsent (thuần): chỉ nhận đúng dạng", () => {
    expect(parseSignUpConsent({ consents: { service_core: true } })).toEqual({
      purposes: ["service_core"],
      channel: "register",
    });
    expect(parseSignUpConsent({ consents: [true] })).toBeNull();
    expect(parseSignUpConsent(undefined)).toBeNull();
    expect(
      parseSignUpConsent({ consents: { service_core: true }, consent_channel: "invitation" })?.channel,
    ).toBe("invitation");
  });
});

describe("xử lý theo mục đích: track() kiểm đồng ý product_analytics (D-119)", () => {
  const KEY = analyticsActorKey("bi-mat-thu-nghiem-dong-y-khong-dung-o-production-0123");
  const sink = () => ({ db: t.runtime, actorKey: KEY });
  const mine = async (u: string) =>
    Number(
      (
        await sql<{
          n: string;
        }>`select count(*)::text as n from product_events where actor_key = ${pseudonymizeActor(KEY, u)}`.execute(
          t.admin,
        )
      ).rows[0]?.n,
    );

  it("chưa đồng ý → không ghi; đồng ý → ghi; rút → ngừng ghi ngay; sự kiện hệ thống luôn ghi", async () => {
    const u = await user();
    const ev = () =>
      track(sink(), { event: "payment.recorded", orgId: A.orgId, userId: u, props: { method: "cash" } });
    await ev();
    expect(await mine(u)).toBe(0);
    await grantConsent(t.runtime, { subjectId: u, purpose: "product_analytics", channel: "settings" });
    await ev();
    expect(await mine(u)).toBe(1);
    await withdrawConsent(t.runtime, { subjectId: u, purpose: "product_analytics", channel: "settings" });
    await ev();
    expect(await mine(u)).toBe(1);
    const sys = async () =>
      Number(
        (
          await sql<{ n: string }>`select count(*)::text as n from product_events
            where organization_id = ${A.orgId} and actor_key is null`.execute(t.admin)
        ).rows[0]?.n,
      );
    const before = await sys();
    await track(sink(), { event: "billing_period.issued", orgId: A.orgId, props: {} });
    expect(await sys()).toBe(before + 1);
  });
});
