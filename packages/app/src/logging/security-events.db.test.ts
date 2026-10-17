// PLAN đợt 4 T-304 — sự kiện bảo mật chuẩn hoá trên Postgres thật (SEC-LOG-001/002) + NFC ở biên (BASE-DATA-002,
// UX-CONTENT-002, XC-I18N-005). Mỗi sự kiện một ca tích hợp: phát đúng một lần, SAU commit, đúng hình dạng, không PII/bí mật.
import { createHash, randomUUID } from "node:crypto";
import { authorize } from "@hm/domain";
import { testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { resetMemberMfa } from "../access/mfa-recovery.ts";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { downloadExport, requestExport, runExportJob } from "../exports/exports.ts";
import { ObjectStorage } from "../files/storage.ts";
import {
  type CommandDef,
  type HttpDeps,
  handleCommand,
  handleQuery,
  type QueryDef,
} from "../http/command-route.ts";
import { findCommand } from "../http/registry.ts";
import { CommandError } from "../pipeline/problem.ts";
import { revokeTenantAccess } from "../portal/access.ts";
import {
  createGuestLink,
  GUEST_RATE_LIMIT_PER_MINUTE,
  guestGetStay,
  revokeGuestLink,
} from "../portal/guest.ts";
import { testServices } from "../server/services.ts";
import { confirmReservation, createReservation, holdReservation } from "../stay/reservations.ts";
import { checkIn } from "../stay/stays.ts";
import { codeOf, okAs, runAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { assertLogRecords } from "../testing/log-schema.ts";
import { createLogger } from "./logger.ts";
import { setAppLogger } from "./runtime.ts";
import { securityRecordSchema } from "./security-events.ts";

let h: Hotel;
let storage: ObjectStorage;
let lines: string[] = [];
const pii = createPiiCipher(devKeyring());

/** Bản ghi sự kiện bảo mật đã phát (category=security), đã kiểm đúng schema. */
const events = () =>
  lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.category === "security")
    .map((r) => securityRecordSchema.parse(r));

beforeAll(async () => {
  h = await seedHotel();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
});
afterAll(async () => {
  setAppLogger(undefined);
  await h?.t.drop();
});
beforeEach(() => {
  lines = [];
  setAppLogger(
    createLogger({
      sink: { write: (l) => lines.push(l) },
      service: "hm-test",
      version: "0.0.0",
      env: "test",
    }),
  );
});
afterEach(() => {
  // Mọi dòng log phát ra trong từng test phải hợp lệ schema chung (BASE-ERR-006).
  assertLogRecords(lines);
  setAppLogger(undefined);
});

function makeDeps(session?: { createdAt?: Date }): HttpDeps {
  return {
    db: h.t.runtime,
    getSession: async (hd) => {
      const id = hd.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: true }, ...(session ? { session } : {}) } : null;
    },
    secureCookies: false,
    services: testServices(),
  };
}

const CLIENT = { "x-forwarded-for": "10.0.0.1, 203.0.113.77", "user-agent": "HM-Test/1.0 (kiem thu)" };
const as = (a: Actor) => ({ "x-test-user": a.authUserId, "x-org-id": a.orgId });
const post = (headers: Record<string, string>, body: unknown, key = randomUUID()) =>
  new Request("http://local.test/api/v1/x/y", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key, ...CLIENT, ...headers },
    body: JSON.stringify(body),
  });

const ADMIN_ONLY: CommandDef<Record<string, never>, { ok: true }> = {
  command: "test.adminOnly",
  input: (await import("zod")).z.strictObject({}),
  run: async (ctx) => {
    authorize(ctx.actor, "member.change_role", {});
    return { data: { ok: true } };
  },
};

describe("sự kiện từ chối ở lớp HTTP (401/403/404-quyền/429/REAUTH)", () => {
  it("401 không phiên → auth.unauthenticated: actor null, IP cắt /24, UA, correlation_id, một bản ghi", async () => {
    const res = await handleCommand(ADMIN_ONLY, post({}, {}), makeDeps());
    expect(res.status).toBe(401);
    const [e, ...rest] = events();
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({
      event: "auth.unauthenticated",
      outcome: "denied",
      actor: null,
      target: { type: "endpoint", id: "/api/v1/x/y" },
      reason: "UNAUTHENTICATED",
      source_ip: "203.0.113.0",
      user_agent: "HM-Test/1.0 (kiem thu)",
      correlation_id: res.headers.get("x-correlation-id"),
    });
    expect(lines.join("\n")).not.toContain("203.0.113.77");
  });

  it("403 thiếu quyền (lễ tân gọi lệnh chỉ owner) → authz.denied có actor/vai trò/tên lệnh, không PII", async () => {
    const res = await handleCommand(ADMIN_ONLY, post(as(h.frontDesk), {}), makeDeps());
    expect(res.status).toBe(403);
    const [e, ...rest] = events();
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({
      event: "authz.denied",
      outcome: "denied",
      actor: {
        user_id: h.frontDesk.authUserId,
        org_id: h.org.orgId,
        membership_id: h.frontDesk.membershipId,
        role: "front_desk",
      },
      target: { type: "command", id: "test.adminOnly" },
      reason: "FORBIDDEN",
      source_ip: "203.0.113.0",
    });
    expect(lines.join("\n")).not.toMatch(/@example\.test/);
  });

  it("gửi lại cùng Idempotency-Key (replay) không phát thêm sự kiện", async () => {
    const key = randomUUID();
    await handleCommand(ADMIN_ONLY, post(as(h.frontDesk), {}, key), makeDeps());
    expect(events()).toHaveLength(1);
    const again = await handleCommand(ADMIN_ONLY, post(as(h.frontDesk), {}, key), makeDeps());
    expect(again.status).toBe(403);
    expect(events()).toHaveLength(1);
  });

  it("404 do không thuộc tổ chức yêu cầu (owner tổ chức khác) → authz.org_not_found, ghi user + tổ chức dò", async () => {
    const res = await handleCommand(
      ADMIN_ONLY,
      post({ "x-test-user": h.ownerOther.authUserId, "x-org-id": h.org.orgId }, {}),
      makeDeps(),
    );
    expect(res.status).toBe(404);
    const [e] = events();
    expect(e).toMatchObject({
      event: "authz.org_not_found",
      actor: { user_id: h.ownerOther.authUserId, org_id: h.org.orgId, membership_id: null, role: null },
      reason: "NOT_FOUND",
    });
  });

  it("429 (lệnh ném RATE_LIMITED) → rate_limit.exceeded", async () => {
    const limited: CommandDef<Record<string, never>, never> = {
      command: "test.limited",
      input: ADMIN_ONLY.input as CommandDef<Record<string, never>, never>["input"],
      run: async () => {
        throw new CommandError("RATE_LIMITED", 429, "Quá nhiều");
      },
    };
    const res = await handleCommand(limited, post(as(h.owner), {}), makeDeps());
    expect(res.status).toBe(429);
    expect(events()).toMatchObject([
      {
        event: "rate_limit.exceeded",
        reason: "RATE_LIMITED",
        target: { type: "command", id: "test.limited" },
      },
    ]);
  });

  it("REAUTH_REQUIRED thật qua exports.request (phiên cũ 10 phút) → auth.reauth_required", async () => {
    const def = findCommand("exports", "request");
    expect(def).toBeDefined();
    const old = new Date(Date.now() - 10 * 60_000);
    const res = await handleCommand(
      def as NonNullable<typeof def>,
      post(as(h.owner), { kind: "receivables", format: "csv" }),
      makeDeps({ createdAt: old }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(events()).toMatchObject([
      {
        event: "auth.reauth_required",
        outcome: "denied",
        actor: { role: "owner" },
        target: { type: "command", id: "exports.request" },
        reason: "REAUTH_REQUIRED",
      },
    ]);
  });

  it("truy vấn bị 403 → authz.denied với target query", async () => {
    const q: QueryDef<Record<string, never>, never> = {
      query: "test.secretQuery",
      input: ADMIN_ONLY.input as QueryDef<Record<string, never>, never>["input"],
      run: async (_db, actor) => {
        authorize(actor, "member.change_role", {});
        throw new Error("không tới đây");
      },
    };
    const res = await handleQuery(
      q,
      new Request("http://local.test/api/v1/x/y", { headers: { ...as(h.housekeeping), ...CLIENT } }),
      makeDeps(),
    );
    expect(res.status).toBe(403);
    expect(events()).toMatchObject([
      {
        event: "authz.denied",
        actor: { role: "housekeeping" },
        target: { type: "query", id: "test.secretQuery" },
      },
    ]);
  });
});

describe("sự kiện thành công chỉ phát SAU commit", () => {
  it("handler gọi ctx.security rồi lỗi nghiệp vụ → rollback → KHÔNG có sự kiện", async () => {
    const r = await runAs(h.t, h.owner, async (ctx) => {
      ctx.security({ event: "member.mfa_reset", target: { type: "membership", id: "x" } });
      throw new CommandError("VALIDATION_FAILED", 422, "sai");
    });
    expect(r.status).toBe("failed");
    // Không có sự kiện THÀNH CÔNG của handler đã rollback; chỉ còn ghi nhận đầu vào bị từ chối (422).
    expect(events().map((e) => e.event)).toEqual(["input.validation_failed"]);
  });

  it("handler thành công → đúng một sự kiện outcome=success kèm actor, correlation_id", async () => {
    await okAs(h.t, h.owner, async (ctx) => {
      ctx.security({ event: "member.mfa_reset", target: { type: "membership", id: "m-1" } });
    });
    expect(events()).toMatchObject([
      {
        event: "member.mfa_reset",
        outcome: "success",
        actor: { role: "owner", membership_id: h.owner.membershipId },
        correlation_id: "test-corr",
      },
    ]);
  });

  it("member.resetMfa thật → member.mfa_reset; sự cố từ chối (tự đặt lại của mình) → authz.denied, không success", async () => {
    const mgr = await seedMember(h.t, h.org, "manager", { name: "Quản lý MFA" });
    await okAs(h.t, h.owner, (ctx) =>
      resetMemberMfa(ctx, { membershipId: mgr.membershipId, reason: "Mất điện thoại" }),
    );
    expect(events()).toMatchObject([
      { event: "member.mfa_reset", outcome: "success", target: { type: "membership", id: mgr.membershipId } },
    ]);
    lines = [];
    expect(
      await codeOf(
        runAs(h.t, h.owner, (ctx) =>
          resetMemberMfa(ctx, { membershipId: h.owner.membershipId, reason: "x" }),
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(events()).toMatchObject([{ event: "authz.denied", outcome: "denied", reason: "FORBIDDEN" }]);
  });

  it("portal.revokeTenantAccess → portal.tenant_access_revoked (thu hồi lần hai idempotent: không phát lại)", async () => {
    const personId = randomUUID();
    const membershipId = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${personId}, ${h.org.orgId}, 'Người thuê T')`.execute(
      h.t.admin,
    );
    await sql`insert into memberships (id, organization_id, person_id, role, status)
              values (${membershipId}, ${h.org.orgId}, ${personId}, 'tenant', 'active')`.execute(h.t.admin);
    await okAs(h.t, h.owner, (ctx) => revokeTenantAccess(ctx, { membershipId, reason: "Hết hợp đồng" }));
    expect(events()).toMatchObject([
      {
        event: "portal.tenant_access_revoked",
        outcome: "success",
        target: { type: "membership", id: membershipId },
      },
    ]);
    lines = [];
    await okAs(h.t, h.owner, (ctx) => revokeTenantAccess(ctx, { membershipId }));
    expect(events()).toHaveLength(0);
  });

  it("exports.download thành công → export.downloaded; chưa sẵn sàng (409) → không có sự kiện", async () => {
    const owner = { ...h.owner, authenticatedAt: new Date() };
    const q = await okAs(h.t, owner, (ctx) => requestExport(ctx, { kind: "receivables", format: "csv" }));
    const deps = { db: h.t.runtime, workerDb: h.t.worker, storage };
    expect(
      await codeOf(runAs(h.t, owner, (ctx) => downloadExport(ctx, deps, { exportId: q.exportId }))),
    ).toBe("EXPORT_NOT_READY");
    expect(events()).toHaveLength(0);
    expect(
      await runExportJob(deps, { organization_id: h.org.orgId, payload: { export_id: q.exportId } }),
    ).toBe("ready");
    await okAs(h.t, owner, (ctx) => downloadExport(ctx, deps, { exportId: q.exportId }));
    const [e, ...rest] = events();
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({
      event: "export.downloaded",
      outcome: "success",
      actor: { role: "owner" },
      target: { type: "export_job", id: q.exportId },
    });
    expect(lines.join("\n")).not.toMatch(/https?:\/\//); // URL ký không vào log
  });
});

describe("liên kết khách (guest_link.*) và 429 theo IP", () => {
  let seq = 0;
  async function stayWithLink() {
    seq += 1;
    const unitId = randomUUID();
    await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
              values (${unitId}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`SE${seq}`}, 'inspected')`.execute(
      h.t.admin,
    );
    const d = await okAs(h.t, h.manager, (ctx) =>
      createReservation(ctx, {
        unitId,
        arrivalDate: "2026-10-20",
        departureDate: "2026-10-22",
        guests: 1,
        source: "direct",
        booker: { fullName: "Khách SE", phone: "0100005678" },
      }),
    );
    await okAs(h.t, h.manager, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
    await okAs(h.t, h.manager, (ctx) =>
      confirmReservation(ctx, {
        reservationId: d.reservationId,
        payment: {
          amount: 500_000,
          method: "bank_transfer",
          kind: "advance",
          receivingAccountId: h.receivingAccountId,
          bankTxn: { ref: `FT-${randomUUID().slice(0, 12)}`, occurredAt: "2026-10-16T03:00:00Z" },
        },
      }),
    );
    const s = await okAs(h.t, h.frontDesk, (ctx) =>
      checkIn(ctx, pii, {
        reservationId: d.reservationId,
        guests: [
          {
            fullName: "Khách SE",
            phone: "0100005678",
            docType: "cccd",
            docNumber: `0018${String(seq).padStart(8, "0")}`,
          },
        ],
        now: new Date("2026-10-20T08:00:00Z"),
      }),
    );
    const link = await okAs(h.t, h.manager, (ctx) =>
      createGuestLink(ctx, { stayId: s.stayId, now: new Date("2026-10-21T03:00:00Z") }),
    );
    return { stayId: s.stayId, ...link };
  }
  const NOW = new Date("2026-10-21T03:00:00Z");
  // Octet cuối ≥ 1: log cắt IP về ".0" — octet cuối 0 làm IP đầy đủ trùng bản đã cắt và test "không lộ IP" đỏ ngẫu nhiên (1/250).
  const ip = () => `198.51.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

  it("sai bước hai 5 lần → guest_link.denied ×4 rồi guest_link.locked; sau đó truy cập link khoá → denied LINK_REVOKED; token/SĐT không vào log", async () => {
    const s = await stayWithLink();
    lines = []; // bỏ guest_link.issued của bước dựng dữ liệu
    const from = ip();
    for (let i = 0; i < 5; i++) {
      await guestGetStay(h.t.runtime, {
        token: s.token,
        stayId: s.stayId,
        phoneLast4: "0000",
        ip: from,
        userAgent: "GuestBrowser",
        correlationId: "corr-guest-1",
        now: NOW,
      }).catch(() => undefined);
    }
    const ev = events();
    expect(ev.map((e) => `${e.event}:${e.reason}`)).toEqual([
      "guest_link.denied:SECOND_FACTOR_MISMATCH",
      "guest_link.denied:SECOND_FACTOR_MISMATCH",
      "guest_link.denied:SECOND_FACTOR_MISMATCH",
      "guest_link.denied:SECOND_FACTOR_MISMATCH",
      "guest_link.locked:SECOND_FACTOR_ATTEMPTS",
    ]);
    expect(ev[4]).toMatchObject({
      target: { type: "guest_access_link", id: s.linkId },
      source_ip: from.replace(/\.\d+$/, ".0"),
      user_agent: "GuestBrowser",
      correlation_id: "corr-guest-1",
      actor: null,
    });
    const text = lines.join("\n");
    expect(text).not.toContain(s.token);
    expect(text).not.toContain(from);
    expect(text).not.toContain("0100005678");
    lines = [];
    await guestGetStay(h.t.runtime, {
      token: s.token,
      stayId: s.stayId,
      phoneLast4: "5678",
      ip: from,
      now: NOW,
    }).catch(() => undefined);
    expect(events()).toMatchObject([{ event: "guest_link.denied", reason: "LINK_REVOKED" }]);
  });

  it("token sai nhiều lần từ một IP → guest_link.denied rồi rate_limit.exceeded (429) sau 10 lần", async () => {
    const from = ip();
    const results: string[] = [];
    for (let i = 0; i <= GUEST_RATE_LIMIT_PER_MINUTE; i++) {
      const bad = createHash("sha256").update(`bad-${i}-${from}`).digest("base64url");
      await guestGetStay(h.t.runtime, { token: bad, stayId: randomUUID(), ip: from, now: NOW }).catch((e) =>
        results.push((e as CommandError).code),
      );
    }
    expect(results.at(-1)).toBe("RATE_LIMITED");
    const names = events().map((e) => e.event);
    expect(names.filter((n) => n === "guest_link.denied")).toHaveLength(GUEST_RATE_LIMIT_PER_MINUTE);
    expect(names.at(-1)).toBe("rate_limit.exceeded");
  });

  it("portal.revokeGuestLink → guest_link.revoked (sau commit, chỉ khi thành công)", async () => {
    const s = await stayWithLink();
    lines = [];
    await okAs(h.t, h.manager, (ctx) => revokeGuestLink(ctx, { linkId: s.linkId }));
    expect(events()).toMatchObject([
      {
        event: "guest_link.revoked",
        outcome: "success",
        target: { type: "guest_access_link", id: s.linkId },
      },
    ]);
  });
});

describe("NFC ở biên — 'Việt' tổ hợp (NFD) lưu giống dựng sẵn (NFC)", () => {
  const NFD = "Khách Vie\u0302\u0323t Nam";
  const NFC = "Khách Việt Nam";

  async function freshUnit(): Promise<string> {
    const unitId = randomUUID();
    await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
              values (${unitId}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`N${unitId.slice(0, 8)}`}, 'inspected')`.execute(
      h.t.admin,
    );
    return unitId;
  }
  // `housekeeping.createTask` lưu `note` nguyên văn vào `tasks.note` — chuỗi người nhập đi qua đúng đường biên của mọi lệnh.
  const createTask = (unitId: string, note: string, key = randomUUID()) => {
    const def = findCommand("housekeeping", "createTask");
    return handleCommand(
      def as NonNullable<typeof def>,
      post(as(h.owner), { unit_id: unitId, kind: "inspection", note }, key),
      makeDeps(),
    );
  };
  const noteOf = async (taskId: string) =>
    (await sql<{ note: string }>`select note from tasks where id = ${taskId}`.execute(h.t.admin)).rows[0]
      ?.note;

  it("tên/ghi chú NFD → cột lưu là NFC (cùng chuỗi với gõ dựng sẵn)", async () => {
    expect(NFD).not.toBe(NFC);
    expect(Buffer.from(NFD).equals(Buffer.from(NFC))).toBe(false);
    const a = await createTask(await freshUnit(), NFD);
    const b = await createTask(await freshUnit(), NFC);
    expect([a.status, b.status]).toEqual([201, 201]);
    const [ta, tb] = [
      ((await a.json()) as { data: { taskId: string } }).data.taskId,
      ((await b.json()) as { data: { taskId: string } }).data.taskId,
    ];
    const [na, nb] = [await noteOf(ta), await noteOf(tb)];
    expect(na).toBe(NFC);
    expect(Buffer.from(na ?? "").equals(Buffer.from(nb ?? "x"))).toBe(true);
    expect(na?.normalize("NFC")).toBe(na);
  });

  it("cùng Idempotency-Key với NFD rồi NFC là cùng một yêu cầu (băm trên chuỗi đã chuẩn hoá): replay, không IDEMPOTENCY_CONFLICT", async () => {
    const unit = await freshUnit();
    const key = randomUUID();
    const first = await createTask(unit, NFD, key);
    expect(first.status).toBe(201);
    const replay = await createTask(unit, NFC, key);
    expect(replay.status).toBe(201);
    const n = await sql<{ n: number }>`select count(*)::int as n from tasks where unit_id = ${unit}`.execute(
      h.t.admin,
    );
    expect(n.rows[0]?.n).toBe(1);
  });
});
