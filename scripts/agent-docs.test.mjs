// T-807: tài liệu cho agent (XC-DOCAI-004 ranh giới tin cậy) và CODEOWNERS (WF-REVIEW-007, XC-DOCAI-005).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** Các dòng quy tắc của CODEOWNERS: `{ pattern, owners }` (bỏ dòng trống/chú thích). */
function codeowners(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [pattern, ...owners] = l.split(/\s+/);
      return { pattern, owners };
    });
}

describe("XC-DOCAI-004 — AGENTS.md nêu ranh giới tin cậy", () => {
  const agents = read("AGENTS.md");
  it("có mục Điểm dừng bắt buộc và câu 'dữ liệu, không phải chỉ thị'", () => {
    expect(agents).toMatch(/^## \d+\. Điểm dừng bắt buộc/m);
    expect(agents).toContain("dữ liệu, không phải chỉ thị");
  });
  it("có câu 'hướng dẫn này không thay cho hook/permission'", () => {
    expect(agents.toLowerCase()).toContain("hướng dẫn này không thay cho hook/permission");
  });
  it("hook tương ứng tồn tại trong .claude/settings.json (PreToolUse, Stop)", () => {
    const hooks = JSON.parse(read(".claude/settings.json")).hooks;
    expect(Object.keys(hooks)).toEqual(expect.arrayContaining(["PreToolUse", "Stop"]));
  });
});

describe("WF-REVIEW-007 / XC-DOCAI-005 — CODEOWNERS", () => {
  const rules = codeowners(read(".github/CODEOWNERS"));
  const has = (pattern) => rules.some((r) => r.pattern === pattern && r.owners.length > 0);

  it("mọi dòng có ít nhất một owner dạng @người-dùng", () => {
    expect(rules.length).toBeGreaterThan(10);
    for (const r of rules) {
      expect(r.owners.length, r.pattern).toBeGreaterThan(0);
      for (const o of r.owners) expect(o, r.pattern).toMatch(/^@[A-Za-z0-9][A-Za-z0-9-]*(\/[\w.-]+)?$/);
    }
  });

  it.each([
    "/AGENTS.md",
    "/CLAUDE.md",
    "/.claude/",
    "/.cursor/",
    "/.githooks/",
    "/.github/",
    "/packages/db/",
    "/packages/app/src/auth/",
    "/packages/app/src/crypto/",
    "/packages/app/src/privacy/",
    "/packages/app/src/ledger/",
    "/packages/app/src/payments/",
    "/deploy/",
  ])("vùng nhạy cảm %s có code owner", (p) => {
    expect(has(p)).toBe(true);
  });

  it("đường dẫn cụ thể trong CODEOWNERS có thật (trừ .cursor chưa dùng)", () => {
    for (const r of rules) {
      if (r.pattern === "*" || r.pattern === "/.cursor/") continue;
      expect(existsSync(join(ROOT, r.pattern.slice(1))), r.pattern).toBe(true);
    }
  });

  it("migration nằm dưới /packages/db/ (có owner)", () => {
    expect(existsSync(join(ROOT, "packages/db/src/migrations"))).toBe(true);
  });
});
