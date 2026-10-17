// T-709 (OPS-COST-004) — đường gửi lời mời nhân viên (`member.invited`, job nền pg-boss) cũng đi qua ngân sách email ngày/tổ chức:
// lời mời là loại giao dịch (còn gửi ở mức bóp 90%); hết ngân sách ⇒ không gọi nhà cung cấp, xếp lại job với `startAfter` = đầu ngày UTC
// kế tiếp (không vào dead letter, không tiêu lượt thử); sang ngày UTC mới gửi được. Không có hàm xếp lại ⇒ ném `EmailBudgetDeferredError`.
import { randomUUID } from "node:crypto";
import { EmailBudgetDeferredError, FakeEmailSender, invitationKey } from "@hm/app";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deferredJobId, invitationHandlers } from "./jobs.ts";
import { DEAD_LETTER_QUEUE, ensureQueues, type OutboxJob, startConsumers } from "./relay.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let boss: PgBoss;
const key = invitationKey("bi-mat-thu-nghiem-cua-worker-0123456789abcdef");

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà nghỉ lời mời A");
  B = await seedOrg(t.admin, "Nhà nghỉ lời mời B");
  boss = new PgBoss({ connectionString: t.adminUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  await ensureQueues(boss, ["member.invited"]); // chính sách mặc định của worker (5 lần thử, backoff, dead letter)
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
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
  it("không có hàm xếp lại (đường lùi): hết ngân sách ném EmailBudgetDeferredError, không gọi nhà cung cấp; tổ chức khác vẫn gửi; sang ngày UTC mới gửi được", async () => {
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

  it("đường xếp lại thật (pg-boss): hết ngân sách ⇒ job mới start_after = 00:00 UTC hôm sau, job gốc hoàn tất, KHÔNG vào dead letter; chạy lại handler không tạo job thứ hai; sang ngày gửi được", async () => {
    const o = await seedOrg(t.admin, "Nhà nghỉ lời mời D");
    const sender = new FakeEmailSender();
    let clock = new Date("2026-10-16T22:30:00Z");
    const h = invitationHandlers(t.worker, sender, {
      key,
      baseUrl: "https://hm.example.test",
      dailyBudget: 1,
      now: () => clock,
      requeue: async (job, startAfter, id) => {
        await boss.send("member.invited", job, { id, startAfter });
      },
    })["member.invited"] as (j: OutboxJob) => Promise<void>;
    await startConsumers(boss, { "member.invited": h }, { pollingIntervalSeconds: 1 });

    await h(await pending(o)); // dùng hết 1/1
    const blocked = await pending(o);
    await boss.send("member.invited", blocked, { id: blocked.outbox_id });
    const newId = deferredJobId(blocked.outbox_id, new Date("2026-10-17T00:00:00Z"));
    type J = { state: string; start_after: Date; retry_count: number };
    const job = async (id: string) =>
      (
        await sql<J>`select state, start_after, retry_count from pgboss.job where name = 'member.invited' and id = ${id}`.execute(
          t.admin,
        )
      ).rows[0];
    const end = Date.now() + 20_000;
    while (Date.now() < end && !((await job(newId)) && (await job(blocked.outbox_id))?.state === "completed"))
      await new Promise((r) => setTimeout(r, 100));

    expect((await job(blocked.outbox_id))?.state).toBe("completed");
    expect((await job(blocked.outbox_id))?.retry_count).toBe(0); // không tiêu lượt thử
    const requeued = await job(newId);
    expect(requeued?.start_after.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(requeued?.state).toBe("created");
    expect(sender.sent).toHaveLength(1);
    const dead = await sql<{ n: number }>`select count(*)::int as n from pgboss.job
      where name = ${DEAD_LETTER_QUEUE} and data->>'outbox_id' = ${blocked.outbox_id}`.execute(t.admin);
    expect(dead.rows[0]?.n).toBe(0);

    // Chạy lại handler (vd hoàn tất job gốc lỗi giữa chừng): id dẫn xuất ổn định ⇒ vẫn đúng một job xếp lại.
    await h(blocked);
    const count = await sql<{ n: number }>`select count(*)::int as n from pgboss.job
      where name = 'member.invited' and data->>'outbox_id' = ${blocked.outbox_id}`.execute(t.admin);
    expect(count.rows[0]?.n).toBe(2); // job gốc + một job xếp lại

    // Sang ngày UTC mới: job xếp lại (cùng dữ liệu) chạy ⇒ gửi.
    clock = new Date("2026-10-17T00:00:00Z");
    await h(blocked);
    expect(sender.sent).toHaveLength(2);
  });

  it("deferredJobId: UUID hợp lệ, ổn định theo (outbox_id, mốc), khác nhau khi đổi mốc hoặc outbox_id", () => {
    const a = randomUUID();
    const d1 = new Date("2026-10-17T00:00:00Z");
    const id = deferredJobId(a, d1);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deferredJobId(a, new Date(d1))).toBe(id);
    expect(deferredJobId(a, new Date("2026-10-18T00:00:00Z"))).not.toBe(id);
    expect(deferredJobId(randomUUID(), d1)).not.toBe(id);
  });
});
