// PLAN đợt 2 T-103 — lớp HTTP cho command/query trên Postgres thật, gọi bằng Request/Response thật (API-CONTRACT §1–2).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { testServices } from "../server/services.ts";
import {
  type CommandDef,
  type HttpDeps,
  handleCommand,
  handleCommandStatus,
  handleQuery,
} from "./command-route.ts";
import { COMMANDS, findCommand } from "./registry.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let deps: HttpDeps;
let housekeepingUser: string;
let twoOrgUser: string;

/** Phiên giả: header `x-test-user` = auth user id; `x-test-2fa: 1` = đã bật MFA. */
function makeDeps(): HttpDeps {
  return {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: h.get("x-test-2fa") === "1" } } : null;
    },
    secureCookies: false,
    services: testServices(),
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://local.test/api/v1/x/y", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: thân phản hồi kiểm bằng toMatchObject/toEqual
async function j(res: Response): Promise<any> {
  return res.json();
}

const ECHO: CommandDef<{ n: number }, { doubled: number }> = {
  command: "test.echo",
  input: z.strictObject({ n: z.number().int().min(0) }),
  run: async (ctx, i) => {
    await ctx.audit({ action: "test.echo", entityType: "test" });
    return { data: { doubled: i.n * 2 } };
  },
};

async function addMember(org: SeededOrg, authUserId: string, role: string) {
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${org.orgId}, ${authUserId}, ${person}, ${role})`.execute(t.admin);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${org.orgId}, ${membership}, ${org.propertyId})`.execute(t.admin);
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS API");
  B = await seedOrg(t.admin, "KS API khác");
  housekeepingUser = await seedAuthUser(t.admin, `hk+${randomUUID().slice(0, 6)}@example.test`);
  await addMember(A, housekeepingUser, "housekeeping");
  twoOrgUser = await seedAuthUser(t.admin, `two+${randomUUID().slice(0, 6)}@example.test`);
  await addMember(A, twoOrgUser, "housekeeping");
  await addMember(B, twoOrgUser, "housekeeping");
  deps = makeDeps();
});

afterAll(async () => {
  await t.drop();
});

const ownerHeaders = () => ({ "x-test-user": A.ownerAuthUserId, "x-test-2fa": "1", "x-org-id": A.orgId });

describe("handleCommand — thứ tự kiểm và mã lỗi", () => {
  it("không phiên → 401 UNAUTHENTICATED (problem+json, no-store, có correlation id)", async () => {
    const res = await handleCommand(ECHO, post({ n: 1 }), deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await j(res);
    expect(body).toMatchObject({
      code: "UNAUTHENTICATED",
      correlation_id: res.headers.get("x-correlation-id"),
    });
  });

  it("chưa chọn tổ chức → 409 ORG_CONTEXT_REQUIRED kèm danh sách tổ chức của mình (S-020)", async () => {
    const res = await handleCommand(ECHO, post({ n: 1 }, { "x-test-user": twoOrgUser }), deps);
    expect(res.status).toBe(409);
    const body = await j(res);
    expect(body.code).toBe("ORG_CONTEXT_REQUIRED");
    expect(body.organizations.map((o: { id: string }) => o.id).sort()).toEqual([A.orgId, B.orgId].sort());
  });

  it("cookie chọn tổ chức dùng được; X-Org-Id ưu tiên hơn cookie", async () => {
    const key = randomUUID();
    const viaCookie = await handleCommand(
      ECHO,
      post({ n: 2 }, { "x-test-user": twoOrgUser, cookie: `hm_org=${B.orgId}`, "idempotency-key": key }),
      deps,
    );
    expect(viaCookie.status).toBe(200);
    const n = await sql<{
      o: string;
    }>`select organization_id as o from idempotency_keys where key = ${key}`.execute(t.admin);
    expect(n.rows[0]?.o).toBe(B.orgId);
    const key2 = randomUUID();
    await handleCommand(
      ECHO,
      post(
        { n: 2 },
        {
          "x-test-user": twoOrgUser,
          cookie: `hm_org=${B.orgId}`,
          "x-org-id": A.orgId,
          "idempotency-key": key2,
        },
      ),
      deps,
    );
    const m = await sql<{
      o: string;
    }>`select organization_id as o from idempotency_keys where key = ${key2}`.execute(t.admin);
    expect(m.rows[0]?.o).toBe(A.orgId);
  });

  it("tổ chức không phải thành viên → 404; vai trò cần MFA mà chưa bật → 403 MFA_REQUIRED", async () => {
    const r1 = await handleCommand(
      ECHO,
      post({ n: 1 }, { "x-test-user": housekeepingUser, "x-org-id": B.orgId }),
      deps,
    );
    expect(r1.status).toBe(404);
    const r2 = await handleCommand(
      ECHO,
      post({ n: 1 }, { "x-test-user": A.ownerAuthUserId, "x-org-id": A.orgId }),
      deps,
    );
    expect(r2.status).toBe(403);
    expect((await j(r2)).code).toBe("MFA_REQUIRED");
  });

  it("thiếu/sai Idempotency-Key → 400; JSON hỏng → 400; schema sai → 422 kèm errors[path, code]", async () => {
    expect((await handleCommand(ECHO, post({ n: 1 }, ownerHeaders()), deps)).status).toBe(400);
    expect(
      (await handleCommand(ECHO, post({ n: 1 }, { ...ownerHeaders(), "idempotency-key": "abc" }), deps))
        .status,
    ).toBe(400);
    const bad = await handleCommand(
      ECHO,
      post("{oops", { ...ownerHeaders(), "idempotency-key": randomUUID() }),
      deps,
    );
    expect(bad.status).toBe(400);
    expect((await j(bad)).code).toBe("MALFORMED_REQUEST");
    const invalid = await handleCommand(
      ECHO,
      post({ n: -1, x: 1 }, { ...ownerHeaders(), "idempotency-key": randomUUID() }),
      deps,
    );
    expect(invalid.status).toBe(422);
    const body = await j(invalid);
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: "n" })]));
  });

  it("thành công → {command_id, status, data}; gửi lại cùng key → cùng kết quả, chạy một lần; khác thân → 409", async () => {
    const key = randomUUID();
    const h = { ...ownerHeaders(), "idempotency-key": key };
    const r1 = await handleCommand(ECHO, post({ n: 21 }, h), deps);
    expect(r1.status).toBe(200);
    expect(await j(r1)).toEqual({ command_id: key, status: "committed", data: { doubled: 42 } });
    const r2 = await handleCommand(ECHO, post({ n: 21 }, h), deps);
    expect(await j(r2)).toEqual({ command_id: key, status: "committed", data: { doubled: 42 } });
    const audits = await sql<{
      n: number;
    }>`select count(*)::int as n from audit_events where command_id = ${key}`.execute(t.admin);
    expect(audits.rows[0]?.n).toBe(1);
    const r3 = await handleCommand(ECHO, post({ n: 22 }, h), deps);
    expect(r3.status).toBe(422);
    expect((await j(r3)).code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("lỗi không dự kiến → 500 INTERNAL, không lộ chi tiết, gọi onUnexpectedError với correlation id", async () => {
    const seen: string[] = [];
    const boom: CommandDef<unknown, never> = {
      command: "test.boom",
      input: z.unknown(),
      run: async () => {
        throw new Error("chi tiết nội bộ");
      },
    };
    const res = await handleCommand(
      boom,
      post({}, { ...ownerHeaders(), "idempotency-key": randomUUID(), "x-correlation-id": "corr-12345" }),
      { ...deps, onUnexpectedError: (_e, c) => seen.push(c) },
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("chi tiết nội bộ");
    expect(JSON.parse(text)).toMatchObject({ code: "INTERNAL", correlation_id: "corr-12345" });
    expect(seen).toEqual(["corr-12345"]);
  });
});

describe("GET /commands/{id} (SPEC-pwa S-010, S-011, S-019)", () => {
  it("committed → kết quả; chưa có → 404 COMMAND_NOT_FOUND; của người khác → 404", async () => {
    const key = randomUUID();
    await handleCommand(ECHO, post({ n: 5 }, { ...ownerHeaders(), "idempotency-key": key }), deps);
    const get = (id: string, headers: Record<string, string>) =>
      handleCommandStatus(id, new Request(`http://local.test/api/v1/commands/${id}`, { headers }), deps);
    const ok = await get(key, ownerHeaders());
    expect(await j(ok)).toEqual({ command_id: key, status: "committed", data: { doubled: 10 } });
    const missing = await get(randomUUID(), ownerHeaders());
    expect(missing.status).toBe(404);
    expect((await j(missing)).code).toBe("COMMAND_NOT_FOUND");
    const other = await get(key, { "x-test-user": housekeepingUser, "x-org-id": A.orgId });
    expect(other.status).toBe(404);
  });

  it("lệnh thất bại nghiệp vụ → status failed kèm problem", async () => {
    const key = randomUUID();
    const res = await handleCommand(
      COMMANDS["approval.approve"] as CommandDef<unknown, unknown>,
      post({ approval_request_id: randomUUID() }, { ...ownerHeaders(), "idempotency-key": key }),
      deps,
    );
    expect(res.status).toBe(404);
    const st = await handleCommandStatus(
      key,
      new Request("http://local.test/x", { headers: ownerHeaders() }),
      deps,
    );
    expect(await j(st)).toMatchObject({
      command_id: key,
      status: "failed",
      problem: { code: "NOT_FOUND" },
    });
  });
});

describe("danh mục command + query", () => {
  it("findCommand: tên hợp lệ; tên lạ/ký tự lạ → undefined", () => {
    expect(findCommand("approval", "request")?.command).toBe("approval.request");
    expect(findCommand("approval", "constructor")).toBeUndefined();
    expect(findCommand("__proto__", "x")).toBeUndefined();
    expect(findCommand("approval", "re-quest")).toBeUndefined();
  });

  it("approval.request không nhận payload từ client (schema strict)", async () => {
    const res = await handleCommand(
      COMMANDS["approval.request"] as CommandDef<unknown, unknown>,
      post(
        {
          kind: "adjustment",
          amount: 1,
          reason: "x",
          property_id: A.propertyId,
          payload: { at_checkout: true },
        },
        { ...ownerHeaders(), "idempotency-key": randomUUID() },
      ),
      deps,
    );
    expect(res.status).toBe(422);
  });

  it("approval.request hợp lệ qua HTTP → 201", async () => {
    const res = await handleCommand(
      COMMANDS["approval.request"] as CommandDef<unknown, unknown>,
      post(
        { kind: "adjustment", amount: 1000, reason: "điều chỉnh thử", property_id: A.propertyId },
        { ...ownerHeaders(), "idempotency-key": randomUUID() },
      ),
      deps,
    );
    expect(res.status).toBe(201);
    expect((await j(res)).data.approvalRequestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("handleQuery: tham số query string qua schema; lỗi nghiệp vụ → problem", async () => {
    const q = {
      query: "test.whoami",
      input: z.strictObject({ times: z.coerce.number().int().min(1).max(3) }),
      run: async (_db: unknown, actor: { role: string }, i: { times: number }) => actor.role.repeat(i.times),
    };
    const ok = await handleQuery(
      q,
      new Request("http://local.test/q?times=2", { headers: ownerHeaders() }),
      deps,
    );
    expect(await j(ok)).toEqual({ data: "ownerowner" });
    const bad = await handleQuery(
      q,
      new Request("http://local.test/q?times=9", { headers: ownerHeaders() }),
      deps,
    );
    expect(bad.status).toBe(422);
  });
});
