// PLAN đợt 2 T-102 — yêu cầu duyệt có hạn mức trên Postgres thật (SPEC-access S-017; SPEC-ledger S-014, S-033; INV-F5).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { executeCommand } from "../pipeline/command.ts";
import {
  type ApprovalExecutor,
  type ApprovalInput,
  approvalRequired,
  cancelApproval,
  decideApproval,
  replaceApprovalExecutorForTest,
  requestApproval,
} from "./approvals.ts";

let t: TestDb;
let A: SeededOrg;
let owner: Actor;
let manager: Actor;
let frontDesk: Actor;
let accountant: Actor;
let housekeeping: Actor;
let frontDeskOther: Actor;

async function member(role: string, limits: Record<string, number> = {}): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties, limits)
            values (${membership}, ${A.orgId}, ${user}, ${person}, ${role}, ${role === "accountant"},
                    ${JSON.stringify(limits)}::jsonb)`.execute(t.admin);
  if (role !== "accountant") {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${A.orgId}, ${membership}, ${A.propertyId})`.execute(t.admin);
  }
  return resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
}

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3], key: string = randomUUID()) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "approval.test", idempotencyKey: key, payload: { k: key }, correlationId: "c" },
    fn,
  );
}

async function request(actor: Actor, input: Partial<ApprovalInput> & Pick<ApprovalInput, "kind" | "amount">) {
  const r = await run(actor, async (ctx) => ({
    data: await requestApproval(ctx, { reason: "kiểm thử", propertyId: A.propertyId, ...input }),
  }));
  if (r.status !== "committed") throw new Error(JSON.stringify(r));
  return r.data.approvalRequestId;
}

function decide(actor: Actor, id: string, decision: "approve" | "reject" = "approve") {
  return run(actor, async (ctx) => ({
    data: await decideApproval(ctx, { approvalRequestId: id, decision }),
  }));
}

async function executions(id: string): Promise<number> {
  const r = await sql<{ n: number }>`
    select count(*)::int as n from audit_events where action = 'test.executed' and entity_id = ${id}`.execute(
    t.admin,
  );
  return r.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS duyệt");
  owner = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  manager = await member("manager", { allocation: 5_000_000 });
  frontDesk = await member("front_desk");
  frontDeskOther = await member("front_desk");
  accountant = await member("accountant");
  housekeeping = await member("housekeeping");
});

afterAll(async () => {
  replaceApprovalExecutorForTest("adjustment", undefined);
  replaceApprovalExecutorForTest("deposit_refund", undefined);
  replaceApprovalExecutorForTest("discount", undefined);
  await t.drop();
});

beforeEach(() => {
  const exec: ApprovalExecutor = {
    async execute(ctx, req) {
      await ctx.audit({ action: "test.executed", entityType: "approval_request", entityId: req.id });
      return { ok: true };
    },
  };
  replaceApprovalExecutorForTest("adjustment", exec);
  replaceApprovalExecutorForTest("discount", exec);
  // Ngữ cảnh "đang check-out" do executor suy ra từ dữ liệu của yêu cầu (ở đây payload server ghi), không từ client.
  replaceApprovalExecutorForTest("deposit_refund", {
    ...exec,
    context: async (_ctx, req) => ({ atCheckout: req.payload.at_checkout === true }),
  });
});

describe("hạn mức khi duyệt (SPEC-ledger S-014, S-033)", () => {
  it("SPEC-access S-026: quản lý: hoàn 6.000.000 > 5.000.000 → APPROVAL_LIMIT_EXCEEDED; 4.000.000 → thực hiện đúng một lần", async () => {
    const big = await request(frontDesk, { kind: "deposit_refund", amount: 6_000_000 });
    expect(await decide(manager, big)).toMatchObject({
      status: "failed",
      problem: { code: "APPROVAL_LIMIT_EXCEEDED" },
    });
    expect(await executions(big)).toBe(0);
    const ok = await request(frontDesk, { kind: "deposit_refund", amount: 4_000_000 });
    expect(await decide(manager, ok)).toMatchObject({ status: "committed", data: { status: "executed" } });
    expect(await executions(ok)).toBe(1);
    expect(await decide(owner, ok)).toMatchObject({
      status: "failed",
      problem: { code: "INVALID_TRANSITION" },
    });
    expect(await executions(ok)).toBe(1);
  });

  it("lễ tân: 1.500.000 lúc check-out được; 2.500.000 vượt; ngoài check-out → FORBIDDEN", async () => {
    const small = await request(accountant, {
      kind: "deposit_refund",
      amount: 1_500_000,
      payload: { at_checkout: true },
    });
    expect(await decide(frontDesk, small)).toMatchObject({ status: "committed" });
    const big = await request(accountant, {
      kind: "deposit_refund",
      amount: 2_500_000,
      payload: { at_checkout: true },
    });
    expect(await decide(frontDesk, big)).toMatchObject({ problem: { code: "APPROVAL_LIMIT_EXCEEDED" } });
    const notCheckout = await request(accountant, { kind: "deposit_refund", amount: 100_000 });
    expect(await decide(frontDesk, notCheckout)).toMatchObject({ problem: { code: "FORBIDDEN" } });
  });

  it("SPEC-access S-026: kế toán chỉ lập đề nghị, không duyệt; tự duyệt bị cấm kể cả owner", async () => {
    const id = await request(frontDesk, { kind: "deposit_refund", amount: 100_000 });
    expect(await decide(accountant, id)).toMatchObject({ problem: { code: "FORBIDDEN" } });
    const mine = await request(owner, { kind: "adjustment", amount: 100_000 });
    expect(await decide(owner, mine)).toMatchObject({ problem: { code: "SELF_APPROVAL_FORBIDDEN" } });
    expect(await executions(mine)).toBe(0);
  });

  it("buồng phòng không lập được yêu cầu tiền", async () => {
    await expect(request(housekeeping, { kind: "deposit_refund", amount: 1 })).rejects.toThrow(/FORBIDDEN/);
  });

  it("hai người duyệt cùng lúc → đúng một lần thực hiện", async () => {
    const id = await request(accountant, { kind: "adjustment", amount: 1_000_000 });
    const rs = await Promise.all([decide(owner, id), decide(manager, id)]);
    expect(rs.filter((r) => r.status === "committed")).toHaveLength(1);
    expect(rs.filter((r) => r.status === "failed" && r.problem.code === "INVALID_TRANSITION")).toHaveLength(
      1,
    );
    expect(await executions(id)).toBe(1);
  });

  it("từ chối và huỷ: không thực hiện; chỉ người lập được huỷ", async () => {
    const a = await request(accountant, { kind: "adjustment", amount: 10_000 });
    expect(await decide(owner, a, "reject")).toMatchObject({ data: { status: "rejected" } });
    expect(await decide(owner, a)).toMatchObject({ problem: { code: "INVALID_TRANSITION" } });
    const b = await request(accountant, { kind: "adjustment", amount: 10_000 });
    expect(await run(owner, async (ctx) => ({ data: await cancelApproval(ctx, b) }))).toMatchObject({
      status: "failed",
      problem: { code: "FORBIDDEN" },
    });
    expect(await run(accountant, async (ctx) => ({ data: await cancelApproval(ctx, b) }))).toMatchObject({
      data: { status: "cancelled" },
    });
    expect((await executions(a)) + (await executions(b))).toBe(0);
  });
});

describe("hạn mức 3 tầng (ERD 7.1 #9)", () => {
  it("tổ chức hạ hạn mức vai trò; membership ghi đè lại", async () => {
    await sql`update organizations set settings = jsonb_set(settings, '{role_limits}', '{"manager": {"refund": 1000000}}')
              where id = ${A.orgId}`.execute(t.admin);
    try {
      const m1 = await member("manager");
      const id = await request(frontDesk, { kind: "deposit_refund", amount: 2_000_000 });
      expect(await decide(m1, id)).toMatchObject({ problem: { code: "APPROVAL_LIMIT_EXCEEDED" } });
      const m2 = await member("manager", { refund: 3_000_000 });
      expect(await decide(m2, id)).toMatchObject({ status: "committed" });
    } finally {
      await sql`update organizations set settings = settings - 'role_limits' where id = ${A.orgId}`.execute(
        t.admin,
      );
    }
  });
});

describe("vượt hạn mức khi thao tác → 403 + yêu cầu pending (SPEC-access S-017)", () => {
  it("lễ tân giảm giá 150.000 vượt hạn mức: 403, lưu 1 yêu cầu; gửi lại cùng key không tạo thêm; owner duyệt thực hiện 1 lần", async () => {
    const key = randomUUID();
    const cmd = () =>
      run(
        frontDesk,
        async () => {
          throw approvalRequired(
            frontDesk,
            { kind: "discount", amount: 150_000, reason: "khách quen", propertyId: A.propertyId },
            "Giảm giá vượt hạn mức của bạn",
          );
        },
        key,
      );
    const first = await cmd();
    expect(first).toMatchObject({
      status: "failed",
      httpStatus: 403,
      problem: { code: "APPROVAL_LIMIT_EXCEEDED" },
    });
    const id = first.status === "failed" ? first.problem.approval_request_id : undefined;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const again = await cmd();
    expect(again).toMatchObject({ status: "failed", problem: { approval_request_id: id } });
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from approval_requests where kind = 'discount'`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(1);
    expect(await decide(owner, id as string)).toMatchObject({ data: { status: "executed" } });
    expect(await executions(id as string)).toBe(1);
  });
});

describe("CSDL: RLS và ràng buộc", () => {
  it("buồng phòng không thấy yêu cầu nào; lễ tân/kế toán thấy yêu cầu trong phạm vi; lễ tân ngoài phạm vi không thấy", async () => {
    const fd = await request(frontDesk, { kind: "deposit_refund", amount: 5 });
    const ids = (a: Actor) =>
      withTenant(t.runtime, { orgId: A.orgId, actorId: a.membershipId }, async (trx) =>
        (await sql<{ id: string }>`select id from approval_requests`.execute(trx)).rows.map((r) => r.id),
      );
    expect(await ids(housekeeping)).toEqual([]);
    expect(await ids(accountant)).toContain(fd);
    expect(await ids(frontDeskOther)).toContain(fd);
    // Yêu cầu ở cơ sở khác: lễ tân chỉ được giao CS1 không thấy, owner thấy.
    const cs2 = randomUUID();
    await sql`insert into properties (id, organization_id, name, template) values (${cs2}, ${A.orgId}, 'KS duyệt — CS2', 'hotel')`.execute(
      t.admin,
    );
    const other = await request(owner, { kind: "adjustment", amount: 9, propertyId: cs2 });
    expect(await ids(frontDesk)).not.toContain(other);
    expect(await ids(owner)).toContain(other);
  });

  it("người duyệt = người lập bị CSDL chặn; trạng thái kết thúc bất biến; không xoá được", async () => {
    const id = await request(accountant, { kind: "adjustment", amount: 7 });
    await expect(
      sql`update approval_requests set status = 'rejected', approved_by = requested_by, decided_at = now() where id = ${id}`.execute(
        t.admin,
      ),
    ).rejects.toThrow(/ck_approval_requests_not_self/);
    await decide(owner, id, "reject");
    await expect(
      sql`update approval_requests set status = 'pending' where id = ${id}`.execute(t.admin),
    ).rejects.toThrow(/không thể chuyển/);
    await expect(sql`delete from approval_requests where id = ${id}`.execute(t.admin)).rejects.toThrow(
      /append-only/,
    );
  });
});
