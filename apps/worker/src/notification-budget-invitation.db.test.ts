// T-709 (OPS-COST-004) — đường gửi lời mời nhân viên (`member.invited`, job nền pg-boss) cũng đi qua ngân sách email ngày/tổ chức:
// lời mời là loại giao dịch (còn gửi ở mức bóp 90%); hết ngân sách ⇒ không gọi nhà cung cấp, ném `EmailBudgetDeferredError` để job
// thử lại (không mất); sang ngày UTC mới gửi được.
import { randomUUID } from "node:crypto";
import { EmailBudgetDeferredError, FakeEmailSender, invitationKey } from "@hm/app";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationHandlers } from "./jobs.ts";
import type { OutboxJob } from "./relay.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
const key = invitationKey("bi-mat-thu-nghiem-cua-worker-0123456789abcdef");

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà nghỉ lời mời A");
  B = await seedOrg(t.admin, "Nhà nghỉ lời mời B");
});
afterAll(async () => {
  await t?.drop();
});

async function pending(o: SeededOrg): Promise<OutboxJob> {
  const id = randomUUID();
  await sql`insert into invitations (id, organization_id, email, role, property_ids, token_hash, expires_at, status, invited_by)
            values (${id}, ${o.orgId}, ${`moi+${id.slice(0, 6)}@example.test`}, 'front_desk', ${[o.propertyId]}::uuid[],
                    sha256(convert_to(${id}::text, 'UTF8')), now() + interval '7 days', 'pending', ${o.ownerMembershipId})`.execute(
    t.admin,
  );
  return {
    organization_id: o.orgId,
    outbox_id: randomUUID(),
    event_type: "member.invited",
    aggregate_id: id,
    payload: { invitation_id: id },
    correlation_id: "c",
  };
}

describe("member.invited qua ngân sách email ngày", () => {
  it("ngân sách 3: 3 thư đầu gửi; thư thứ 4 bị hoãn (không gọi nhà cung cấp, lỗi có hạn thử lại); tổ chức khác vẫn gửi; sang ngày UTC mới gửi được", async () => {
    const sender = new FakeEmailSender();
    let clock = new Date("2026-10-16T10:00:00Z");
    const logs: string[] = [];
    const logger = {
      warn: (e: string) => logs.push(e),
      info: () => {},
      error: () => {},
      debug: () => {},
      child: () => logger,
    };
    const h = invitationHandlers(
      t.worker,
      sender,
      { key, baseUrl: "https://hm.example.test", dailyBudget: 3, now: () => clock },
      logger as never,
    )["member.invited"] as (j: OutboxJob) => Promise<void>;

    for (let i = 0; i < 3; i++) await h(await pending(A));
    expect(sender.sent).toHaveLength(3);
    // 3/3 = 100%: mức 80/90/100 chạm lần lượt (3 ⇒ 100% ngay lượt cuối vì 2/3 = 66%, 3/3 = 100%).
    expect(logs).toContain("notification.email_budget_exhausted");

    const blocked = await pending(A);
    const err = await h(blocked).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailBudgetDeferredError);
    expect((err as EmailBudgetDeferredError).retryAt.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(sender.sent).toHaveLength(3);
    expect(logs).toContain("notification.email_budget_deferred_stopped");

    await h(await pending(B)); // tổ chức khác độc lập
    expect(sender.sent).toHaveLength(4);

    clock = new Date("2026-10-17T00:00:00Z");
    await h(blocked); // giao lại cùng job sang ngày mới ⇒ gửi
    expect(sender.sent).toHaveLength(5);
  });

  it("lời mời bị bỏ qua (đã dùng/không còn chờ) không tiêu ngân sách", async () => {
    const o = await seedOrg(t.admin, "Nhà nghỉ lời mời C");
    const sender = new FakeEmailSender();
    const h = invitationHandlers(t.worker, sender, {
      key,
      baseUrl: "https://hm.example.test",
      dailyBudget: 1,
      now: () => new Date("2026-10-16T10:00:00Z"),
    })["member.invited"] as (j: OutboxJob) => Promise<void>;
    const job = await pending(o);
    await sql`update invitations set status = 'revoked' where id = ${job.aggregate_id}`.execute(t.admin);
    await h(job);
    expect(sender.sent).toHaveLength(0);
    const r = await sql<{
      n: number;
    }>`select count(*)::int as n from email_budget_days where organization_id = ${o.orgId}`.execute(t.admin);
    expect(r.rows[0]?.n).toBe(0);
    await h(await pending(o)); // ngân sách còn nguyên ⇒ vẫn gửi được 1 thư
    expect(sender.sent).toHaveLength(1);
  });
});
