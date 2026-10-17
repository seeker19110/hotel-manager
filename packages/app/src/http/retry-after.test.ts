// BE-REL-006 (T-401): mọi 429 có Retry-After. Rào: không nơi nào dựng CommandError 429 bằng tay (phải qua `rateLimited`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rateLimited } from "../pipeline/problem.ts";
import { json, problemResponse, simpleProblem } from "./command-route.ts";
import { DEFAULT_RETRY_AFTER_SECONDS, retryAfterSeconds, withRetryAfter } from "./retry-after.ts";

describe("retryAfterSeconds", () => {
  it("số hợp lệ ⇒ làm tròn lên, kẹp 1 ngày; không hợp lệ ⇒ mặc định", () => {
    expect(retryAfterSeconds(15)).toBe(15);
    expect(retryAfterSeconds(0.2 + 1)).toBe(2);
    expect(retryAfterSeconds("30")).toBe(30);
    expect(retryAfterSeconds(10 ** 9)).toBe(86_400);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, "abc", "", {}])
      expect(retryAfterSeconds(bad), String(bad)).toBe(DEFAULT_RETRY_AFTER_SECONDS);
  });
});

describe("phản hồi 429", () => {
  it("problemResponse/json/simpleProblem 429: có Retry-After (theo retry_after, thiếu ⇒ 60); không phải 429 ⇒ không có", () => {
    const p = rateLimited("chậm lại", 17);
    expect(p.status).toBe(429);
    expect(p.extensions.retry_after).toBe(17);
    expect(
      problemResponse(
        { type: "t", title: "x", status: 429, code: "RATE_LIMITED", retry_after: 17 },
        "c",
      ).headers.get("retry-after"),
    ).toBe("17");
    expect(simpleProblem("RATE_LIMITED", 429, "x", "c").headers.get("retry-after")).toBe("60");
    expect(simpleProblem("RATE_LIMITED", 429, "x", "c", { retry_after: 5 }).headers.get("retry-after")).toBe(
      "5",
    );
    expect(json({ x: 1 }, 429, "c").headers.get("retry-after")).toBe("60");
    expect(simpleProblem("NOT_FOUND", 404, "x", "c").headers.get("retry-after")).toBeNull();
  });
  it("409 IDEMPOTENCY_IN_PROGRESS (D-043) có Retry-After theo retry_after; 409 khác thì không", () => {
    expect(
      problemResponse(
        { type: "t", title: "x", status: 409, code: "IDEMPOTENCY_IN_PROGRESS", retry_after: 1 },
        "c",
      ).headers.get("retry-after"),
    ).toBe("1");
    expect(simpleProblem("VERSION_CONFLICT", 409, "x", "c").headers.get("retry-after")).toBeNull();
  });
  it("rateLimited kẹp tối thiểu 1 giây (0, âm, số lẻ)", () => {
    expect(rateLimited("x", 0).extensions.retry_after).toBe(1);
    expect(rateLimited("x", -3).extensions.retry_after).toBe(1);
    expect(rateLimited("x", 1.2).extensions.retry_after).toBe(2);
  });
});

describe("withRetryAfter (phản hồi do Better Auth dựng)", () => {
  it("429 chỉ có X-Retry-After ⇒ thêm Retry-After; đã có Retry-After hợp lệ ⇒ giữ; thiếu cả hai ⇒ 60; không phải 429 ⇒ nguyên", async () => {
    const a = withRetryAfter(new Response("{}", { status: 429, headers: { "x-retry-after": "42" } }));
    expect(a.headers.get("retry-after")).toBe("42");
    expect(a.status).toBe(429);
    expect(await a.text()).toBe("{}");
    const keep = new Response("{}", { status: 429, headers: { "retry-after": "900" } });
    expect(withRetryAfter(keep)).toBe(keep);
    expect(withRetryAfter(new Response(null, { status: 429 })).headers.get("retry-after")).toBe("60");
    const ok = new Response("ok", { status: 200 });
    expect(withRetryAfter(ok)).toBe(ok);
  });
});

describe("rào: không dựng CommandError 429 bằng tay", () => {
  it("mọi `new CommandError(…, 429, …)` ngoài problem.ts đều phải đổi sang rateLimited()", () => {
    const root = new URL("..", import.meta.url).pathname;
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
      });
    const bad: string[] = [];
    for (const f of walk(root)) {
      if (f.endsWith("pipeline/problem.ts")) continue;
      const src = readFileSync(f, "utf8");
      if (/new CommandError\(\s*"RATE_LIMITED"/.test(src) || /new CommandError\([^)]*,\s*429\s*,/s.test(src))
        bad.push(f);
    }
    expect(bad).toEqual([]);
  });
});
