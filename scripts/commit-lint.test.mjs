// Test cho scripts/commit-lint.mjs (BASE-REPO-005; T-802): Conventional Commits 1.0.0, subject ≤ 72 ký tự.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintMessage, lintRange, parseLog, stripComments, TYPES } from "./commit-lint.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/commit-lint.mjs");

describe("lintMessage — hợp lệ", () => {
  it.each([
    "feat: thêm kỳ thu",
    "fix(ledger): sửa làm tròn tiền",
    "feat(api)!: đổi mã lỗi",
    "chore(deps-dev): bump vitest",
    "docs(autopilot): kế hoạch đợt 9 — CI/file cổng/công cụ (D-059)",
    "revert: hoàn lại thay đổi",
    "feat: x\n\nThân nhiều dòng.\nDòng hai.\n\nCo-Authored-By: A <a@example.test>",
    "feat!: bỏ API cũ\n\nBREAKING CHANGE: endpoint /v1 bị xoá",
    "feat: x\n\nBREAKING-CHANGE: đổi tên trường",
    "Merge branch 'main' into wip/x",
    "Merge pull request #12 from a/b",
    "feat: thêm\n# Please enter the commit message\n# dòng chú thích của git",
  ])("%j", (msg) => expect(lintMessage(msg)).toEqual([]));

  it("mọi type của khung đều được chấp nhận", () => {
    for (const t of TYPES) expect(lintMessage(`${t}: x`)).toEqual([]);
  });
});

describe("lintMessage — biên 72 ký tự (điểm mã, không phải byte)", () => {
  const head = (n) => `feat: ${"a".repeat(n - 6)}`;
  it("đúng 72 ký tự đạt, 73 đỏ", () => {
    expect([...head(72)]).toHaveLength(72);
    expect(lintMessage(head(72))).toEqual([]);
    expect(lintMessage(head(73)).join()).toMatch(/73 ký tự > 72/);
  });
  it("tiếng Việt có dấu: 72 chữ có dấu (nhiều byte hơn) vẫn đạt; 73 đỏ", () => {
    const vi = (n) => `feat: ${"ế".repeat(n - 6)}`;
    expect(Buffer.byteLength(vi(72))).toBeGreaterThan(72);
    expect(lintMessage(vi(72))).toEqual([]);
    expect(lintMessage(vi(73))).not.toEqual([]);
  });
  it("ký tự ngoài BMP (emoji) tính một ký tự", () => {
    expect(lintMessage(`feat: ${"😀".repeat(66)}`)).toEqual([]);
  });
});

describe("lintMessage — vi phạm", () => {
  it.each([
    ["", /rỗng/],
    ["   \n\n", /rỗng/],
    ["# chỉ có chú thích", /rỗng/],
    ["thêm kỳ thu", /dạng "type\(scope\)!: mô tả"/],
    ["Feat: hoa thường sai", /dạng/],
    ["feature: type lạ", /dạng/],
    ["feat:thiếu cách", /dạng/],
    ["feat(): scope rỗng", /dạng/],
    ["feat(Scope): scope viết hoa", /dạng/],
    ["feat: ", /rỗng|dạng/],
    ["feat:  hai khoảng trắng đầu", /khoảng trắng/],
    ["fixup! feat: x", /dạng/],
    ["WIP", /dạng/],
    ["feat: x\nthân dính liền tiêu đề", /dòng trống/],
    ["feat: x\n\nBREAKING CHANGE:", /BREAKING CHANGE: <mô tả>/],
    ["feat: x\n\nbreaking change: viết thường", /BREAKING CHANGE: <mô tả>/],
    ["feat: x\n\nBREAKING CHANGE thiếu hai chấm", /BREAKING CHANGE: <mô tả>/],
  ])("%j", (msg, re) => expect(lintMessage(msg).join("\n")).toMatch(re));

  it("null/undefined không ném lỗi, báo rỗng", () => {
    expect(lintMessage(undefined)).toEqual(["commit message rỗng"]);
    expect(lintMessage(null)).toEqual(["commit message rỗng"]);
  });
});

describe("stripComments / parseLog", () => {
  it("bỏ dòng # và khoảng trắng cuối", () => {
    expect(stripComments("a\n# c\nb\n\n")).toBe("a\nb");
  });
  it("tách log nhiều commit, giữ thân nhiều dòng", () => {
    const raw = "aaa\x00feat: một\n\nthân\n\x01\nbbb\x00fix: hai\n\x01";
    expect(parseLog(raw)).toEqual([
      { sha: "aaa", message: "feat: một\n\nthân\n" },
      { sha: "bbb", message: "fix: hai\n" },
    ]);
    expect(parseLog("")).toEqual([]);
  });
});

describe("lintRange / CLI trên repo git tạm", () => {
  const git = (cwd, ...a) =>
    execFileSync(
      "git",
      ["-c", "user.email=t@example.test", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...a],
      { cwd, encoding: "utf8", stdio: "pipe" },
    );
  const run = (cwd, args) => {
    try {
      return {
        code: 0,
        out: execFileSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8", stdio: "pipe" }),
      };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  it("--range bắt đúng commit sai, bỏ qua commit merge; range rỗng đạt", () => {
    const dir = mkdtempSync(join(tmpdir(), "clint-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "commit", "-q", "--allow-empty", "-m", "không theo quy ước (nằm ngoài range)");
      git(dir, "checkout", "-q", "-b", "pr");
      git(dir, "commit", "-q", "--allow-empty", "-m", "feat: commit tốt");
      expect(run(dir, ["--range", "main..HEAD"]).code).toBe(0);
      git(dir, "commit", "-q", "--allow-empty", "-m", `fix: ${"x".repeat(80)}`);
      git(dir, "commit", "-q", "--allow-empty", "-m", "sửa linh tinh");
      const red = run(dir, ["--range", "main..HEAD"]);
      expect(red.code).toBe(1);
      expect(red.out).toMatch(/2 commit vi phạm/);
      expect(lintRange("main..HEAD", dir)).toHaveLength(2);
      expect(lintRange("HEAD..HEAD", dir)).toEqual([]);
      git(dir, "checkout", "-q", "main");
      git(dir, "merge", "-q", "--no-ff", "-m", "Merge branch 'pr' vào main", "pr");
      expect(lintRange("HEAD^1..HEAD", dir)).toHaveLength(2); // commit merge không bị tính
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("--file (hook commit-msg): đọc file, bỏ chú thích; --message; thiếu/thừa tham số → 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "clint-"));
    try {
      const good = join(dir, "good");
      const bad = join(dir, "bad");
      writeFileSync(good, "feat(x): tốt\n\n# chú thích\n");
      writeFileSync(bad, "bậy bạ\n");
      expect(run(dir, ["--file", good]).code).toBe(0);
      expect(run(dir, ["--file", bad]).code).toBe(1);
      expect(run(dir, ["--message", "docs: ok"]).code).toBe(0);
      expect(run(dir, ["--message", "no"]).code).toBe(1);
      expect(run(dir, []).code).toBe(2);
      expect(run(dir, ["--message", "docs: a", "--file", good]).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
