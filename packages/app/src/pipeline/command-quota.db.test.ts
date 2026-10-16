// T-401 (IND-SAAS-008, BE-REL-006) — hạn mức lệnh theo tổ chức trong pipeline: vượt ⇒ 429 + Retry-After, tổ chức khác không
// bị ảnh hưởng, 429 không bị lưu (retry cùng key sau khi hết giới hạn chạy được), replay không tốn hạn mức.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { problemResponse } from "../http/command-route.ts";
import { ownerOf } from "../testing/helpers.ts";
import { COMMAND_QUOTA_PER_MINUTE, executeCommand } from "./command.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let ownerA: Actor;
let ownerB: Actor;

const noop = async () => ({ data: { ok: true } });

function run(actor: Actor, quotaPerMinute: number, key = randomUUID()) {
  return executeCommand(
    t.runtime,
    actor,
    {
      command: "demo.noop",
      idempotencyKey: key,
      payload: { k: key },
      correlationId: "c-quota",
      quotaPerMinute,
    },
    noop,
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
});
