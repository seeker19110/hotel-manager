// T-401 (IND-SAAS-008, BE-REL-006) — hạn mức lệnh theo tổ chức trong pipeline: vượt ⇒ 429 + Retry-After, tổ chức khác không
// bị ảnh hưởng, 429 không bị lưu (retry cùng key sau khi hết giới hạn chạy được), replay không tốn hạn mức.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { problemResponse } from "../http/command-route.ts";
import { ownerOf, seedMember } from "../testing/helpers.ts";
import { COMMAND_MEMBER_QUOTA_PER_MINUTE, COMMAND_QUOTA_PER_MINUTE, executeCommand } from "./command.ts";
import { CommandError } from "./problem.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let ownerA: Actor;
let ownerB: Actor;

const noop = async () => ({ data: { ok: true } });

const forbidden = async (): Promise<{ data: { ok: boolean } }> => {
  throw new CommandError("FORBIDDEN", 403, "Không đủ quyền");
};

function run(
  actor: Actor,
  quotaPerMinute: number,
  key = randomUUID(),
  opts: { memberQuotaPerMinute?: number; handler?: typeof noop } = {},
) {
  return executeCommand(
    t.runtime,
    actor,
    {
      command: "demo.noop",
      idempotencyKey: key,
      payload: { k: key },
      correlationId: "c-quota",
      quotaPerMinute,
      ...(opts.memberQuotaPerMinute === undefined ? {} : { memberQuotaPerMinute: opts.memberQuotaPerMinute }),
    },
    opts.handler ?? noop,
  );
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Quota A");
  B = await seedOrg(t.admin, "Quota B");
  ownerA = await ownerOf(t, A);
  ownerB = await ownerOf(t, B);
});

afterAll(async () => {
  await t.drop();
});

describe("quota lệnh theo tổ chức", () => {
  it("hằng mặc định hợp lý: đủ rộng cho thao tác tay, hữu hạn", () => {
    expect(COMMAND_QUOTA_PER_MINUTE).toBeGreaterThanOrEqual(120);
    expect(COMMAND_QUOTA_PER_MINUTE).toBeLessThanOrEqual(6000);
  });

  it("vượt hạn mức ⇒ 429 RATE_LIMITED có retry_after ⇒ header Retry-After; tổ chức khác vẫn chạy bình thường", async () => {
    for (let i = 0; i < 3; i++) expect((await run(ownerA, 3)).status).toBe("committed");
    const over = await run(ownerA, 3);
    expect(over.status).toBe("failed");
    if (over.status !== "failed") return;
    expect(over.httpStatus).toBe(429);
    expect(over.problem.code).toBe("RATE_LIMITED");
    expect(over.problem.retry_after).toBeGreaterThanOrEqual(1);
    expect(over.problem.retry_after).toBeLessThanOrEqual(60);
    const res = problemResponse(over.problem, "c-quota");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBe(over.problem.retry_after);

    // Tổ chức B (cùng hạn mức 3) không bị ảnh hưởng bởi việc A bão hoà.
    for (let i = 0; i < 3; i++) expect((await run(ownerB, 3)).status).toBe("committed");
  });

  it("429 không được lưu: sau khi hết giới hạn, gửi lại CÙNG Idempotency-Key chạy được; replay không tốn hạn mức", async () => {
    const key = randomUUID();
    const over = await run(ownerA, 3, key);
    expect(over.status).toBe("failed");
    const stored = await sql<{ n: number }>`select count(*)::int as n from idempotency_keys
      where organization_id = ${A.orgId} and key = ${key}`.execute(t.admin);
    expect(stored.rows[0]?.n).toBe(0);

    // Lùi mọi hàng của A ra khỏi cửa sổ 60 giây (giả lập thời gian trôi).
    await sql`update idempotency_keys set created_at = now() - interval '2 minutes',
              expires_at = now() + interval '7 days' where organization_id = ${A.orgId}`.execute(t.admin);
    const again = await run(ownerA, 3, key);
    expect(again.status).toBe("committed");
    // Đã đủ 3 lệnh trong cửa sổ (2 hàng mới + hàng vừa tạo), lệnh thứ 4 bị chặn…
    await run(ownerA, 3);
    await run(ownerA, 3);
    expect((await run(ownerA, 3)).status).toBe("failed");
    // …nhưng gửi lại key cũ (replay) vẫn trả kết quả đã lưu, không bị 429.
    const replay = await run(ownerA, 3, key);
    expect(replay).toMatchObject({ status: "committed", replayed: true });
  });

  it("Retry-After đúng thời điểm hàng cũ nhất rời cửa sổ (không phải hằng 60)", async () => {
    await sql`update idempotency_keys set created_at = now() - interval '2 minutes' where organization_id = ${B.orgId}`.execute(
      t.admin,
    );
    for (let i = 0; i < 2; i++) await run(ownerB, 2);
    // Hàng cũ nhất trong cửa sổ cách đây 45 giây ⇒ còn ~15 giây.
    await sql`update idempotency_keys set created_at = now() - interval '45 seconds'
              where id = (select id from idempotency_keys where organization_id = ${B.orgId}
                          order by created_at desc limit 1)`.execute(t.admin);
    await sql`update idempotency_keys set created_at = now() - interval '45 seconds'
              where id = (select id from idempotency_keys where organization_id = ${B.orgId} and created_at > now() - interval '5 seconds'
                          limit 1)`.execute(t.admin);
    const over = await run(ownerB, 2);
    expect(over.status).toBe("failed");
    if (over.status !== "failed") return;
    expect(over.problem.retry_after).toBeGreaterThanOrEqual(13);
    expect(over.problem.retry_after).toBeLessThanOrEqual(16);
  });

  it("hạn mức theo thành viên nhỏ hơn hạn mức tổ chức", () => {
    expect(COMMAND_MEMBER_QUOTA_PER_MINUTE).toBeGreaterThanOrEqual(30);
    expect(COMMAND_MEMBER_QUOTA_PER_MINUTE).toBeLessThan(COMMAND_QUOTA_PER_MINUTE);
  });
});

describe("một thành viên không làm cạn hạn mức của cả tổ chức (review đợt 5 🟠1)", () => {
  it("thành viên gửi hàng loạt lệnh bị 403 ⇒ lệnh lỗi KHÔNG tính vào hạn mức tổ chức ⇒ owner vẫn ghi được", async () => {
    const org = await seedOrg(t.admin, "Quota C");
    const owner = await ownerOf(t, org);
    const bad = await seedMember(t, org, "front_desk");
    for (let i = 0; i < 8; i++) {
      const r = await run(bad, 5, randomUUID(), { handler: forbidden });
      expect(r).toMatchObject({ status: "failed", httpStatus: 403 }); // 403 thật, không phải 429 của tổ chức
    }
    for (let i = 0; i < 5; i++) expect((await run(owner, 5)).status).toBe("committed");
    expect(await run(owner, 5)).toMatchObject({ status: "failed", httpStatus: 429 }); // lệnh THÀNH CÔNG vẫn tính
  });

  it("hạn mức theo thành viên: kẻ spam bị 429 của riêng mình (kể cả lệnh lỗi), kiểm trước hạn mức tổ chức; người khác không bị ảnh hưởng", async () => {
    const org = await seedOrg(t.admin, "Quota D");
    const owner = await ownerOf(t, org);
    const bad = await seedMember(t, org, "front_desk");
    for (let i = 0; i < 3; i++)
      expect(
        await run(bad, 1000, randomUUID(), { memberQuotaPerMinute: 3, handler: forbidden }),
      ).toMatchObject({
        httpStatus: 403,
      });
    const over = await run(bad, 1000, randomUUID(), { memberQuotaPerMinute: 3, handler: forbidden });
    expect(over).toMatchObject({ status: "failed", httpStatus: 429 });
    if (over.status === "failed") {
      expect(over.problem.code).toBe("RATE_LIMITED");
      expect(over.problem.retry_after).toBeGreaterThanOrEqual(1);
    }
    expect((await run(owner, 1000, randomUUID(), { memberQuotaPerMinute: 3 })).status).toBe("committed");
  });

  it("replay key cũ (> 60 s) khi hạn mức đã cạn vẫn nhận lại kết quả cũ, không bị 429 (🟢4)", async () => {
    const org = await seedOrg(t.admin, "Quota E");
    const owner = await ownerOf(t, org);
    const key = randomUUID();
    expect((await run(owner, 3, key)).status).toBe("committed");
    await sql`update idempotency_keys set created_at = now() - interval '2 minutes', expires_at = now() + interval '7 days'
              where organization_id = ${org.orgId}`.execute(t.admin); // key cũ rời cửa sổ 60 s
    for (let i = 0; i < 3; i++) expect((await run(owner, 3)).status).toBe("committed"); // cạn hạn mức tổ chức
    expect((await run(owner, 3)).status).toBe("failed"); // lệnh MỚI bị chặn…
    expect(await run(owner, 3, key)).toMatchObject({ status: "committed", replayed: true }); // …replay thì không
    // …cũng không bị hạn mức thành viên chặn.
    expect(await run(owner, 3, key, { memberQuotaPerMinute: 1 })).toMatchObject({
      status: "committed",
      replayed: true,
    });
  });
});
