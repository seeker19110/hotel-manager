// T-405 — audit "từ đâu" (CMP-AUDIT-002, IND-SAAS-009): `audit_events.source_ip`/`user_agent` do pipeline lệnh ghi từ
// `requestClient`; IP đã cắt, UA ≤ 200 ký tự NFC; worker/hệ thống ⇒ null; CSDL chặn IP đầy đủ; append-only vẫn giữ;
// đọc theo quyền như 0042.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { executeCommand } from "../pipeline/command.ts";
import { seedMember } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { getEvent, listEvents } from "./events.ts";

let h: Hotel;
let accountant: Actor;

beforeAll(async () => {
  h = await seedHotel();
  accountant = await seedMember(h.t, h.org, "accountant", { name: "Kế toán K" });
});
afterAll(async () => {
  await h?.t.drop();
});

/** Chạy một lệnh ghi audit với `client` cho trước; trả `correlation_id` để tra lại. */
async function runWith(
  actor: Actor,
  client: { ip: string | null; userAgent: string | null } | undefined,
  action = "test.source",
): Promise<string> {
  const correlationId = `src-${randomUUID()}`;
  const r = await executeCommand(
    h.t.runtime,
    actor,
    {
      command: "test.command",
      idempotencyKey: randomUUID(),
      payload: { n: randomUUID() },
      correlationId,
      ...(client ? { client } : {}),
    },
    async (ctx) => {
      await ctx.audit({ action, entityType: "test", entityId: randomUUID() });
      return { data: {} };
    },
  );
  expect(r.status).toBe("committed");
  return correlationId;
}

const rowOf = async (correlationId: string) =>
  (
    await sql<{ source_ip: string | null; user_agent: string | null; outcome: string }>`
      select source_ip, user_agent, outcome from audit_events where correlation_id = ${correlationId}
      order by created_at, id`.execute(h.t.admin)
  ).rows;

describe("audit-source — ctx.audit lấy client từ requestClient", () => {
  it("IPv4 cắt /24, IPv6 cắt /48, UA giữ nguyên khi ngắn", async () => {
    const c4 = await runWith(h.owner, { ip: "198.51.100.23", userAgent: "Mozilla/5.0 Test" });
    expect(await rowOf(c4)).toEqual([
      { source_ip: "198.51.100.0", user_agent: "Mozilla/5.0 Test", outcome: "success" },
    ]);
    const c6 = await runWith(h.owner, { ip: "2001:db8:abcd:12::1", userAgent: null });
    expect(await rowOf(c6)).toEqual([{ source_ip: "2001:db8:abcd::", user_agent: null, outcome: "success" }]);
  });

  it("IPv6 viết tắt/IPv4-mapped cũng cắt đúng; IP không hợp lệ → null (không lưu chuỗi rác)", async () => {
    expect(
      (await rowOf(await runWith(h.owner, { ip: "::ffff:192.0.2.77", userAgent: null })))[0]?.source_ip,
    ).toBe("192.0.2.0");
    expect((await rowOf(await runWith(h.owner, { ip: "::1", userAgent: null })))[0]?.source_ip).toBe(
      "0:0:0::",
    );
    expect(
      (await rowOf(await runWith(h.owner, { ip: "unknown", userAgent: null })))[0]?.source_ip,
    ).toBeNull();
    expect(
      (await rowOf(await runWith(h.owner, { ip: "999.1.1.1", userAgent: null })))[0]?.source_ip,
    ).toBeNull();
  });

  it("UA: NFC, bỏ ký tự điều khiển, cắt ≤ 200 ký tự theo điểm mã (không cắt đôi cặp thay thế)", async () => {
    const decomposed = "Trình duyệt"; // i + dấu huyền (NFD) → ì (NFC)
    const ua1 = (await rowOf(await runWith(h.owner, { ip: null, userAgent: `${decomposed}\r\nX` })))[0]
      ?.user_agent;
    expect(ua1).toBe("Tr\u00ecnh duy\u1ec7t  X"); // NFC, CR/LF → khoảng trắng
    expect(ua1).not.toMatch(/[\r\n]/);
    const long = `${"😀".repeat(150)}${"a".repeat(100)}`;
    const ua2 = (await rowOf(await runWith(h.owner, { ip: null, userAgent: long })))[0]?.user_agent as string;
    expect(Array.from(ua2)).toHaveLength(200);
    expect(ua2.endsWith("😀")).toBe(false); // 150 emoji + 50 'a'
    expect(ua2.slice(-50)).toBe("a".repeat(50));
    expect((await rowOf(await runWith(h.owner, { ip: null, userAgent: "   " })))[0]?.user_agent).toBeNull();
  });

  it("không có client (worker/hệ thống/test cũ) → null cả hai cột", async () => {
    expect(await rowOf(await runWith(h.owner, undefined))).toEqual([
      { source_ip: null, user_agent: null, outcome: "success" },
    ]);
  });

  it("lần bị từ chối (command.denied) cũng ghi nguồn", async () => {
    const correlationId = `src-${randomUUID()}`;
    const r = await executeCommand(
      h.t.runtime,
      h.owner,
      {
        command: "test.denied",
        idempotencyKey: randomUUID(),
        payload: { n: 1 },
        correlationId,
        client: { ip: "203.0.113.200", userAgent: "UA-denied" },
      },
      async () => {
        const { CommandError } = await import("../pipeline/problem.ts");
        throw new CommandError("INVALID_TRANSITION", 409, "Không hợp lệ");
      },
    );
    expect(r.status).toBe("failed");
    expect(await rowOf(correlationId)).toEqual([
      { source_ip: "203.0.113.0", user_agent: "UA-denied", outcome: "denied" },
    ]);
  });
});

describe("audit-source — ràng buộc CSDL, append-only, đọc theo quyền", () => {
  const insert = (ip: string | null, ua: string | null) =>
    sql`insert into audit_events (id, organization_id, actor_type, action, entity_type, correlation_id, source_ip, user_agent)
        values (${randomUUID()}, ${h.org.orgId}, 'worker', 'test.constraint', 'test', 'c', ${ip}, ${ua})`.execute(
      h.t.admin,
    );

  it("CSDL từ chối IP đầy đủ/chuỗi rác và UA > 200 hoặc rỗng; chấp nhận IP cắt, null", async () => {
    await expect(insert("203.0.113.5", null)).rejects.toThrow(/ck_audit_source_ip/);
    await expect(insert("2001:db8:1:2:3:4:5:6", null)).rejects.toThrow(/ck_audit_source_ip/);
    await expect(insert("không phải ip", null)).rejects.toThrow(/ck_audit_source_ip/);
    await expect(insert(null, "x".repeat(201))).rejects.toThrow(/ck_audit_user_agent/);
    await expect(insert(null, "")).rejects.toThrow(/ck_audit_user_agent/);
    await insert("203.0.113.0", "x".repeat(200));
    await insert("2001:db8:1::", null);
    await insert(null, null);
  });

  it("append-only vẫn giữ: không UPDATE/DELETE hai cột mới kể cả owner bảng", async () => {
    await expect(sql`update audit_events set source_ip = null`.execute(h.t.admin)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`delete from audit_events`.execute(h.t.admin)).rejects.toThrow(/append-only/);
  });

  it("owner thấy nguồn qua listEvents/getEvent; kế toán không thấy dòng ngoài nhóm tiền (RLS 0042 áp cho cả cột mới)", async () => {
    const corr = await runWith(h.owner, { ip: "198.51.100.9", userAgent: "UA-owner" }, "unit.updated");
    const list = await listEvents(h.t.runtime, h.owner, { correlationId: corr });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ sourceIp: "198.51.100.0", userAgent: "UA-owner" });
    const one = await getEvent(h.t.runtime, h.owner, list.items[0]?.id as string);
    expect(one).toMatchObject({ sourceIp: "198.51.100.0", userAgent: "UA-owner" });
    expect((await listEvents(h.t.runtime, accountant, { correlationId: corr })).items).toEqual([]);
    await expect(getEvent(h.t.runtime, accountant, one.id)).rejects.toMatchObject({ status: 404 });
    const money = await runWith(h.owner, { ip: "198.51.100.9", userAgent: "UA-money" }, "payment.confirmed");
    expect((await listEvents(h.t.runtime, accountant, { correlationId: money })).items[0]).toMatchObject({
      sourceIp: "198.51.100.0",
    });
  });
});
