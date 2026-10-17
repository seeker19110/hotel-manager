// OPS-COST-004 (T-709) — phần thuần/tĩnh của ngân sách email ngày: mốc sang ngày UTC, hằng ngưỡng, và rào "mọi đường gửi email phải xin ngân sách".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMAIL_BUDGET_THROTTLE_PCT,
  EMAIL_BUDGET_WARN_PCT,
  EMAIL_DAILY_BUDGET_PER_ORG,
  nextBudgetDayStart,
} from "./budget.ts";

describe("nextBudgetDayStart — đầu ngày UTC kế tiếp", () => {
  it.each([
    ["2026-10-16T02:00:00.000Z", "2026-10-17T00:00:00.000Z"],
    ["2026-10-16T23:59:59.999Z", "2026-10-17T00:00:00.000Z"],
    // Đúng nửa đêm UTC: đã là ngày mới ⇒ mốc kế tiếp là ngày sau nữa (không trả lại chính nó).
    ["2026-10-17T00:00:00.000Z", "2026-10-18T00:00:00.000Z"],
    // Ranh giới năm + năm nhuận.
    ["2027-12-31T23:00:00.000Z", "2028-01-01T00:00:00.000Z"],
    ["2028-02-28T12:00:00.000Z", "2028-02-29T00:00:00.000Z"],
    // Giờ Việt Nam 06:30 sáng 17/10 (= 23:30 UTC 16/10) vẫn thuộc ngày UTC 16.
    ["2026-10-17T06:30:00.000+07:00", "2026-10-17T00:00:00.000Z"],
  ])("%s → %s", (now, next) => {
    expect(nextBudgetDayStart(new Date(now)).toISOString()).toBe(next);
  });
});

describe("hằng ngưỡng (đổi qua PR có review)", () => {
  it("80 < 90 < 100 và ngân sách là số nguyên dương", () => {
    expect(EMAIL_BUDGET_WARN_PCT).toBeLessThan(EMAIL_BUDGET_THROTTLE_PCT);
    expect(EMAIL_BUDGET_THROTTLE_PCT).toBeLessThan(100);
    expect(Number.isInteger(EMAIL_DAILY_BUDGET_PER_ORG)).toBe(true);
    expect(EMAIL_DAILY_BUDGET_PER_ORG).toBeGreaterThan(0);
  });
});

const ROOT = resolve(import.meta.dirname, "../../../..");
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === "node_modules" || n === ".next") return [];
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

describe("rào: mọi đường gọi EmailSender.send phải xin ngân sách (OPS-COST-004)", () => {
  const files = [...sources(join(ROOT, "packages/app/src")), ...sources(join(ROOT, "apps/worker/src"))];
  // `sender.send(` / `emailSender.send(` / `mailer.send(` — gọi nhà cung cấp email (adapter tự định nghĩa ở email.ts thì không tính).
  const callers = files.filter((f) =>
    /\b(?:sender|emailSender|mailer)\.send\(/.test(readFileSync(f, "utf8")),
  );

  it("tìm thấy đúng các đường gửi đã biết (vòng gửi thông báo + lời mời nhân viên)", () => {
    expect(callers.map((f) => f.slice(ROOT.length + 1)).sort()).toEqual([
      "apps/worker/src/jobs.ts",
      "packages/app/src/notifications/send.ts",
    ]);
  });
  it.each(callers.map((f) => [f.slice(ROOT.length + 1), f]))(
    "%s gọi takeEmailBudget TRƯỚC sender.send",
    (_n, f) => {
      const src = readFileSync(f as string, "utf8");
      const take = src.indexOf("takeEmailBudget(");
      const send = src.search(/\b(?:sender|emailSender|mailer)\.send\(/);
      expect(take, "không thấy takeEmailBudget(").toBeGreaterThan(-1);
      expect(take).toBeLessThan(send);
    },
  );
});
