// FE-TEST-006: PR `fix` phải chạm file test; mọi ca còn lại không bị chặn.
import { describe, expect, it } from "vitest";
import { checkFixHasTest, isFixTitle } from "./check-fix-has-test.mjs";

describe("isFixTitle", () => {
  it.each([
    ["fix: sửa", true],
    ["fix(web): sửa", true],
    ["fix!: phá tương thích", true],
    ["FIX: hoa", true],
    ["feat: thêm", false],
    ["fixture: không phải fix", false],
    ["", false],
    [undefined, false],
  ])("%s → %s", (t, want) => {
    expect(isFixTitle(t)).toBe(want);
  });
});

describe("checkFixHasTest", () => {
  it("PR fix không đổi file test → đỏ, nêu lý do", () => {
    const r = checkFixHasTest("fix(web): lỗi nút", ["apps/web/components/ui/button.tsx"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("test tái hiện");
  });
  it("PR fix kèm test (ts/tsx/mjs/spec/python) → xanh", () => {
    for (const f of [
      "apps/web/components/ui/button.test.tsx",
      "apps/web/e2e/hotel.spec.ts",
      "scripts/x.test.mjs",
      "scripts/test_pr_policy.py",
    ])
      expect(checkFixHasTest("fix: a", ["a.ts", f]).ok).toBe(true);
  });
  it("PR fix không có file nào đổi (rỗng) → đỏ", () => {
    expect(checkFixHasTest("fix: a", []).ok).toBe(false);
  });
  it("PR không phải fix thì không đòi test", () => {
    expect(checkFixHasTest("docs: sửa tài liệu", ["README.md"]).ok).toBe(true);
  });
  it("tên file chỉ chứa 'test' trong thư mục nhưng không phải file test → đỏ", () => {
    expect(checkFixHasTest("fix: a", ["apps/web/lib/contest.ts", "docs/testing.md"]).ok).toBe(false);
  });
});
