// SPEC-access S-007 — consumer `member.invited`: gửi email lời mời qua EmailSender (FakeEmailSender ở dev/CI), token dựng lại từ khoá,
// idempotency theo id lời mời (giao lại không gửi hai thư), lời mời đã dùng/quá hạn bị bỏ qua, lỗi tạm ném lại, địa chỉ hỏng chỉ ghi log.
import { randomUUID } from "node:crypto";
import { EmailSendError, FakeEmailSender, invitationKey, invitationToken } from "@hm/app";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationHandlers } from "./jobs.ts";
import type { OutboxJob } from "./relay.ts";

let t: TestDb;
let A: SeededOrg;
const key = invitationKey("bi-mat-thu-nghiem-cua-worker-0123456789abcdef");
const opts = { key, baseUrl: "https://hm.example.test" };

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà nghỉ gửi thư mời");
});
afterAll(async () => {
  await t?.drop();
});

async function pending(status = "pending", expires = "now() + interval '7 days'") {
  const id = randomUUID();
  const email = `moi+${id.slice(0, 6)}@example.test`;
  await sql`insert into invitations (id, organization_id, email, role, property_ids, token_hash, expires_at, status, invited_by, accepted_at)
            values (${id}, ${A.orgId}, ${email}, 'front_desk', ${[A.propertyId]}::uuid[], sha256(convert_to(${id}::text, 'UTF8')),
                    ${sql.raw(expires)}, ${status}, ${A.ownerMembershipId}, ${status === "accepted" ? sql`now()` : null})`.execute(
    t.admin,
  );
  const job: OutboxJob = {
    organization_id: A.orgId,
    outbox_id: randomUUID(),
    event_type: "member.invited",
    aggregate_id: id,
    payload: { invitation_id: id },
    correlation_id: "c",
  };
  return { id, email, job };
}

describe("member.invited → email", () => {
  it("gửi đúng một thư tới email được mời, có liên kết #token dựng lại; giao lại cùng sự kiện không tạo thư thứ hai", async () => {
    const sender = new FakeEmailSender();
    const h = invitationHandlers(t.admin, sender, opts)["member.invited"] as (j: OutboxJob) => Promise<void>;
    const p = await pending();
    await h(p.job);
    await h(p.job);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.to).toBe(p.email);
    expect(sender.sent[0]?.text).toContain(
      `https://hm.example.test/loi-moi#token=${invitationToken(key, p.id)}`,
    );
    expect(sender.sent[0]?.subject).toContain("lễ tân");
  });

  it("đã chấp nhận / quá hạn / thu hồi → không gửi", async () => {
    const sender = new FakeEmailSender();
    const h = invitationHandlers(t.admin, sender, opts)["member.invited"] as (j: OutboxJob) => Promise<void>;
    for (const p of [
      await pending("accepted"),
      await pending("pending", "now() - interval '1 second'"),
      await pending("revoked"),
    ])
      await h(p.job);
    expect(sender.attempts).toHaveLength(0);
  });

  it("lỗi tạm thời ném lại (pg-boss thử lại); lỗi vĩnh viễn (địa chỉ không hợp lệ) không ném; payload thiếu id ném", async () => {
    const sender = new FakeEmailSender();
    const h = invitationHandlers(t.admin, sender, opts)["member.invited"] as (j: OutboxJob) => Promise<void>;
    const p = await pending();
    sender.failWith = () => new EmailSendError("temporary", "SMTP 451");
    await expect(h(p.job)).rejects.toThrow("SMTP 451");
    sender.failWith = () => new EmailSendError("permanent", "5.1.1");
    await expect(h(p.job)).resolves.toBeUndefined();
    sender.failWith = null;
    await h(p.job);
    expect(sender.sent).toHaveLength(1);
    await expect(h({ ...p.job, payload: {} })).rejects.toThrow("invitation_id");
  });
});
