// PLAN đợt 8 T-709 (OPS-COST-004) — ngân sách email ngày/tổ chức trên Postgres thật: dưới 80% gửi thường; 80% cảnh báo MỘT lần;
// 90% chỉ loại bắt buộc; 100% dừng (hoãn, không mất) + metric/cảnh báo; sang ngày UTC mới gửi lại phần hoãn; hai tổ chức độc lập;
// đồng thời không vượt (khoá hàng trong `app.email_budget_take`, migration 0063).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectMetrics, handleMetrics, metricsToken } from "../observability/metrics.ts";
import {
  EMAIL_BUDGET_THROTTLE_PCT,
  EMAIL_BUDGET_WARN_PCT,
  EMAIL_DAILY_BUDGET_PER_ORG,
  takeEmailBudget,
} from "./budget.ts";
import { createNotification } from "./dispatch.ts";
import { FakeEmailSender } from "./email.ts";
import { sendDueEmails } from "./send.ts";
import type { NotificationType } from "./templates.ts";

let t: TestDb;
const NOW = new Date("2026-10-16T02:00:00Z");
const NEXT_DAY = new Date("2026-10-17T00:00:00Z");
const SECRET = "test-secret-at-least-32-characters-long!!";

type Ev = { event: string; fields: Record<string, unknown> };
const emailOf = (o: SeededOrg) => `chu.${o.orgId.slice(0, 8)}@example.test`;

async function newOrg(name: string): Promise<SeededOrg> {
  const o = await seedOrg(t.admin, name);
  await sql`update persons set email = ${emailOf(o)} where id = ${o.ownerPersonId}`.execute(t.admin);
  return o;
}

/** n lần gửi `queued` đến hạn tại NOW cho chủ tổ chức; `required` ⇒ loại `account_security`, ngược lại `export_ready`. */
async function queue(o: SeededOrg, n: number, required = false): Promise<void> {
  const type: NotificationType = required ? "account_security" : "export_ready";
  const vars = required
    ? { orgName: "KS Mai", action: "Đổi mật khẩu" }
    : { orgName: "KS Mai", exportName: "bao-cao.xlsx", exportId: randomUUID() };
  for (let i = 0; i < n; i++)
    await t.admin.transaction().execute(async (trx) => {
      const id = await createNotification(
        trx,
        o.orgId,
        {
          propertyId: o.propertyId,
          recipientPersonId: o.ownerPersonId,
          type,
          vars,
          dedupeKey: `b:${randomUUID()}`,
        },
        { now: NOW },
      );
      expect(id).not.toBeNull();
    });
}

async function run(now: Date, opts: { budget?: number; sender?: FakeEmailSender; events?: Ev[] } = {}) {
  const sender = opts.sender ?? new FakeEmailSender();
  const events = opts.events ?? [];
  const stats = await sendDueEmails(t.worker, sender, {
    now,
    limit: 100,
    perOrg: 100,
    ...(opts.budget !== undefined ? { dailyBudget: opts.budget } : {}),
    log: (event, fields) => events.push({ event, fields }),
  });
  return { stats, sender, events };
}

const sentTo = (s: FakeEmailSender, o: SeededOrg) => s.sent.filter((m) => m.to === emailOf(o)).length;
const budgetEvents = (events: Ev[], org?: SeededOrg) =>
  events.filter(
    (e) => e.event.startsWith("notification.email_budget") && (!org || e.fields.org_id === org.orgId),
  );
const row = async (o: SeededOrg, day = "2026-10-16") =>
  (
    await sql<{ used: number; throttled: number; stopped: number; level: number }>`
      select used, throttled, stopped, level from email_budget_days where organization_id = ${o.orgId} and day = ${day}`.execute(
      t.admin,
    )
  ).rows[0];
const deliveries = async (o: SeededOrg) =>
  (
    await sql<{ status: string; attempts: number; next_attempt_at: Date | null; locked_until: Date | null }>`
      select status, attempts, next_attempt_at, locked_until from notification_deliveries where organization_id = ${o.orgId}
      order by created_at, id`.execute(t.admin)
  ).rows;

beforeAll(async () => {
  t = await createTestDb();
}, 120_000);
afterAll(async () => {
  await t?.drop();
});

describe("dưới 80%: gửi bình thường", () => {
  it("7/10: gửi cả 7, không cảnh báo/hoãn, bộ đếm = 7, mức 0", async () => {
    const o = await newOrg("KS dưới ngưỡng");
    await queue(o, 7);
    const { stats, sender, events } = await run(NOW, { budget: 10 });
    expect(stats).toMatchObject({ claimed: 7, sent: 7, deferred: 0 });
    expect(sentTo(sender, o)).toBe(7);
    expect(budgetEvents(events, o)).toEqual([]);
    expect(await row(o)).toMatchObject({ used: 7, throttled: 0, stopped: 0, level: 0 });
  });
  it("hàng đợi rỗng: không tạo hàng đếm, không lỗi", async () => {
    const { stats } = await run(NOW, { budget: 10 });
    expect(stats.claimed).toBe(0);
  });
});

describe("80%: cảnh báo đúng một lần", () => {
  it("lượt thứ 8/10 ghi `email_budget_warn` một lần (có metric); lượt 9 không lặp cảnh báo 80% mà ghi mức bóp", async () => {
    const o = await newOrg("KS 80%");
    await queue(o, 8);
    const first = await run(NOW, { budget: 10 });
    expect(first.stats.sent).toBe(8);
    const ev1 = budgetEvents(first.events, o);
    expect(ev1.map((e) => e.event)).toEqual(["notification.email_budget_warn"]);
    expect(ev1[0]?.fields).toMatchObject({
      used: 8,
      budget: 10,
      ratio: 0.8,
      metric: "hm_email_budget_used_ratio",
    });
    expect(await row(o)).toMatchObject({ used: 8, level: 1 });

    await queue(o, 1);
    const second = await run(NOW, { budget: 10 });
    expect(second.stats.sent).toBe(1);
    expect(budgetEvents(second.events, o).map((e) => e.event)).toEqual([
      "notification.email_budget_throttle",
    ]);
    expect(await row(o)).toMatchObject({ used: 9, level: 2 });
  });
});

describe("90%: chỉ loại bắt buộc", () => {
  it("ở 9/10 loại thường bị hoãn tới đầu ngày UTC sau (không tính lần thử), loại bắt buộc vẫn gửi", async () => {
    const o = await newOrg("KS 90%");
    await queue(o, 9);
    await run(NOW, { budget: 10 });
    expect((await row(o))?.used).toBe(9);

    await queue(o, 2); // thường
    const thr = await run(NOW, { budget: 10 });
    expect(thr.stats).toMatchObject({ claimed: 2, sent: 0, deferred: 2 });
    expect(sentTo(thr.sender, o)).toBe(0);
    expect(budgetEvents(thr.events, o).map((e) => e.event)).toEqual([
      "notification.email_budget_deferred_throttled",
      "notification.email_budget_deferred_throttled",
    ]);
    expect(budgetEvents(thr.events, o)[0]?.fields).toMatchObject({
      metric: "hm_email_budget_throttled_total",
      used: 9,
      budget: 10,
    });
    const d = (await deliveries(o)).filter((x) => x.status === "retrying");
    expect(d).toHaveLength(2);
    for (const x of d) {
      expect(x.attempts).toBe(0); // hoãn vì ngân sách không phải một lần thử
      expect(x.next_attempt_at?.toISOString()).toBe(NEXT_DAY.toISOString());
      expect(x.locked_until).toBeNull();
    }
    expect(await row(o)).toMatchObject({ used: 9, throttled: 2, level: 2 });

    await queue(o, 1, true); // bắt buộc vẫn qua ở mức bóp
    const req = await run(NOW, { budget: 10 });
    expect(req.stats).toMatchObject({ claimed: 1, sent: 1, deferred: 0 });
    expect(req.sender.sent[0]?.subject).toContain("Đổi mật khẩu");
    expect(budgetEvents(req.events, o).map((e) => e.event)).toEqual(["notification.email_budget_exhausted"]);
    expect(await row(o)).toMatchObject({ used: 10, throttled: 2, level: 3 });
  });
});

describe("100%: dừng, hoãn không mất, có metric/cảnh báo", () => {
  it("hết ngân sách chặn cả loại bắt buộc; bộ đếm không tăng khi bị hoãn; /api/metrics có tỉ lệ + bộ đếm dừng", async () => {
    const o = await newOrg("KS 100%");
    // Dùng đúng hằng thật: dựng sẵn 999/1000 rồi gửi lượt cuối.
    await sql`insert into email_budget_days (organization_id, day, used, throttled, level) values (${o.orgId}, '2026-10-16',
              ${EMAIL_DAILY_BUDGET_PER_ORG - 1}, 2, 2)`.execute(t.admin);
    await queue(o, 1, true);
    const last = await run(NOW);
    expect(last.stats.sent).toBe(1);
    expect(budgetEvents(last.events, o).map((e) => e.event)).toEqual(["notification.email_budget_exhausted"]);

    await queue(o, 1, true);
    await queue(o, 2);
    const stopped = await run(NOW);
    expect(stopped.stats).toMatchObject({ claimed: 3, sent: 0, deferred: 3 });
    expect(sentTo(stopped.sender, o)).toBe(0);
    const ev = budgetEvents(stopped.events, o);
    expect(ev).toHaveLength(3);
    expect(ev.every((e) => e.event === "notification.email_budget_deferred_stopped")).toBe(true);
    expect(ev[0]?.fields).toMatchObject({
      metric: "hm_email_budget_stopped_total",
      used: EMAIL_DAILY_BUDGET_PER_ORG,
    });
    expect(await row(o)).toMatchObject({ used: EMAIL_DAILY_BUDGET_PER_ORG, stopped: 3, level: 3 });
    // Còn đủ trong hàng đợi (không mất): 3 lần gửi `retrying` hẹn ngày mai.
    expect((await deliveries(o)).filter((x) => x.status === "retrying")).toHaveLength(3);

    const s = await collectMetrics(t.runtime, NOW);
    const val = (n: string) => s.find((x) => x.name === n)?.value;
    expect(val("hm_email_budget_used_ratio")).toBe(1);
    expect(val("hm_email_budget_stopped_total")).toBeGreaterThanOrEqual(3);
    expect(val("hm_email_budget_throttled_total")).toBeGreaterThanOrEqual(2);
    // Không nhãn tổ chức (số liệu tổng hợp toàn hệ thống).
    expect(JSON.stringify(s)).not.toContain(o.orgId);

    // handleMetrics đọc theo giờ thật: dựng thêm hàng của ngày UTC hiện tại ở mức 100% để kiểm văn bản Prometheus.
    await sql`insert into email_budget_days (organization_id, day, used, level) values (${o.orgId},
              (now() at time zone 'utc')::date, ${EMAIL_DAILY_BUDGET_PER_ORG}, 3) on conflict do nothing`.execute(
      t.admin,
    );
    const res = await handleMetrics(
      new Request("http://x/api/metrics", { headers: { authorization: `Bearer ${metricsToken(SECRET)}` } }),
      { db: t.runtime, secret: SECRET },
    );
    const body = await res.text();
    expect(body).toContain("# TYPE hm_email_budget_used_ratio gauge");
    expect(body).toMatch(/^hm_email_budget_used_ratio 1$/m);
    expect(body).toMatch(/^hm_email_budget_stopped_total \d+$/m);
    expect(body).toContain("# TYPE hm_email_budget_stopped_total counter");
  });

  it("có luật cảnh báo Prometheus cho 80% và 100% trên metric thật", () => {
    const alerts = readFileSync(
      resolve(import.meta.dirname, "../../../../deploy/prometheus/alerts.yml"),
      "utf8",
    );
    expect(alerts).toMatch(
      /alert: HmEmailBudgetHigh\n\s+(?:#.*\n\s+)?expr: hm_email_budget_used_ratio >= 0\.8\n/,
    );
    expect(alerts).toMatch(/alert: HmEmailBudgetExhausted\n\s+expr: hm_email_budget_used_ratio >= 1 or /);
  });
});

describe("sang ngày UTC mới gửi lại phần hoãn", () => {
  it("trước 00:00 UTC không nhận lại; từ 00:00 UTC gửi hết phần hoãn, bộ đếm ngày mới tách riêng", async () => {
    const o = await newOrg("KS sang ngày");
    await queue(o, 6);
    const day1 = await run(NOW, { budget: 4 });
    expect(day1.stats).toMatchObject({ sent: 4, deferred: 2 });
    expect(sentTo(day1.sender, o)).toBe(4);

    const justBefore = await run(new Date("2026-10-16T23:59:59.999Z"), { budget: 4 });
    expect(justBefore.stats.claimed).toBe(0);
    expect(sentTo(justBefore.sender, o)).toBe(0);

    // (Hàng đợi dùng chung với các test khác: phần hoãn của tổ chức khác cũng đến hạn ⇒ chỉ khẳng định theo tổ chức này.)
    const day2 = await run(NEXT_DAY, { budget: 4 });
    expect(sentTo(day2.sender, o)).toBe(2);
    expect((await deliveries(o)).map((x) => x.status)).toEqual(Array(6).fill("sent"));
    expect(await row(o, "2026-10-16")).toMatchObject({ used: 4, stopped: 2 });
    expect(await row(o, "2026-10-17")).toMatchObject({ used: 2, stopped: 0, level: 0 });
    // Hoãn không phải lần thử: phần hoãn gửi ở lần nhận thứ 1 (không tiến tới `dead`).
    expect((await deliveries(o)).every((x) => x.attempts === 1)).toBe(true);
  });
});

describe("hai tổ chức độc lập", () => {
  it("tổ chức A hết ngân sách không làm tổ chức B ngừng gửi (cùng một lượt)", async () => {
    const a = await newOrg("KS A hết");
    const b = await newOrg("KS B còn");
    await sql`insert into email_budget_days (organization_id, day, used, level) values (${a.orgId}, '2026-10-16', 10, 3)`.execute(
      t.admin,
    );
    await queue(a, 3);
    await queue(b, 3);
    const { stats, sender } = await run(NOW, { budget: 10 });
    expect(stats).toMatchObject({ claimed: 6, sent: 3, deferred: 3 });
    expect(sentTo(sender, a)).toBe(0);
    expect(sentTo(sender, b)).toBe(3);
    expect(await row(a)).toMatchObject({ used: 10, stopped: 3 });
    expect(await row(b)).toMatchObject({ used: 3, stopped: 0 });
  });
});

describe("đồng thời không vượt ngân sách", () => {
  it("40 lần xin song song với ngân sách 10 ⇒ đúng 10 'send', phần còn lại bị chặn; used = 10", async () => {
    const o = await newOrg("KS song song");
    const r = await Promise.all(
      Array.from({ length: 40 }, () =>
        takeEmailBudget(t.worker, { orgId: o.orgId, required: true, now: NOW, budget: 10 }),
      ),
    );
    expect(r.filter((x) => x.decision === "send")).toHaveLength(10);
    expect(r.filter((x) => x.decision === "stopped")).toHaveLength(30);
    // Mỗi mức chỉ báo vượt ngưỡng ĐÚNG MỘT lần dù 40 kết nối cùng xin.
    expect(
      r
        .filter((x) => x.crossed)
        .map((x) => x.level)
        .sort(),
    ).toEqual([1, 2, 3]);
    expect(await row(o)).toMatchObject({ used: 10, stopped: 30, level: 3 });
  });

  it("3 vòng gửi chạy song song trên cùng hàng đợi, ngân sách 5 ⇒ tổng thư gửi ≤ 5, phần còn lại hoãn", async () => {
    const o = await newOrg("KS 3 worker");
    await queue(o, 12);
    const sender = new FakeEmailSender();
    const rs = await Promise.all([1, 2, 3].map(() => run(NOW, { budget: 5, sender })));
    expect(sentTo(sender, o)).toBe(5);
    expect(rs.reduce((n, r) => n + r.stats.sent, 0)).toBe(5);
    expect(rs.reduce((n, r) => n + r.stats.deferred, 0)).toBe(7);
    expect((await row(o))?.used).toBe(5);
  });
});

describe("tham số và quyền", () => {
  it.each([
    ["ngân sách 0", { budget: 0 }],
    ["ngân sách âm", { budget: -1 }],
  ])("%s ⇒ từ chối (không gửi khi cấu hình sai)", async (_n, q) => {
    await expect(
      takeEmailBudget(t.worker, { orgId: randomUUID(), required: true, now: NOW, ...q }),
    ).rejects.toMatchObject({
      code: "22023",
    });
  });
  it("ngưỡng sai thứ tự (bóp < cảnh báo) hoặc > 100 ⇒ từ chối", async () => {
    for (const [w, th] of [
      [90, 80],
      [80, 101],
      [0, 90],
    ])
      await expect(
        sql`select * from app.email_budget_take(${randomUUID()}, ${NOW}, 10, ${w}, ${th}, true)`.execute(
          t.worker,
        ),
      ).rejects.toMatchObject({ code: "22023" });
    expect(EMAIL_BUDGET_WARN_PCT).toBe(80);
    expect(EMAIL_BUDGET_THROTTLE_PCT).toBe(90);
  });
  it("tổ chức không tồn tại ⇒ lỗi khoá ngoại (không đếm cho tổ chức ma)", async () => {
    await expect(
      takeEmailBudget(t.worker, { orgId: randomUUID(), required: true, now: NOW, budget: 10 }),
    ).rejects.toMatchObject({
      code: "23503",
    });
  });
  it("runtime không gọi được hàm xin ngân sách và không đọc/ghi trực tiếp bảng; worker không ghi trực tiếp bảng", async () => {
    const o = await newOrg("KS quyền");
    await expect(
      sql`select * from app.email_budget_take(${o.orgId}, ${NOW}, 10, 80, 90, true)`.execute(t.runtime),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(sql`select * from email_budget_days`.execute(t.runtime)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(sql`update email_budget_days set used = 0`.execute(t.worker)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      sql`select * from app.email_budget_metrics(${NOW}, 10)`.execute(t.runtime),
    ).resolves.toBeDefined();
  });
});
