// WF-TEAM-003: kiểm checklist Definition of Ready của issue (scripts/dor-check.mjs) + khoá cấu hình workflow dor-check.yml.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dorSection, unmetDor } from "./dor-check.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

const issue = (dor) =>
  `## Mục tiêu\nx\n\n## Definition of Ready\n<!-- chú thích - [ ] không tính -->\n${dor}\n\n## Gate\n- [ ] ngoài mục DoR không tính\n`;

describe("unmetDor", () => {
  it("tick hết → đủ", () => expect(unmetDor(issue("- [x] một\n- [X] hai"))).toEqual([]));
  it("còn mục chưa tick → liệt kê đúng mục đó", () => {
    expect(unmetDor(issue("- [x] một\n- [ ] hai chưa"))).toEqual(["chưa tick: hai chưa"]);
  });
  it("thiếu mục DoR / mục không có checklist / thân rỗng / null → chưa Ready", () => {
    expect(unmetDor("## Mục tiêu\nx")[0]).toContain("thiếu mục");
    expect(unmetDor(issue("chỉ văn bản"))[0]).toContain("không có checklist");
    expect(unmetDor("")).toHaveLength(1);
    expect(unmetDor(null)).toHaveLength(1);
    expect(unmetDor(undefined)).toHaveLength(1);
  });
  it("chú thích HTML và mục sau DoR không bị tính; mục trống được nêu", () => {
    expect(dorSection(issue("- [x] a"))).not.toContain("chú thích");
    expect(dorSection(issue("- [x] a"))).not.toContain("ngoài mục DoR");
    expect(unmetDor(issue("- [ ]"))).toEqual(["chưa tick: (trống)"]);
  });
  it("mục DoR ở cuối thân (không có mục sau) và xuống dòng CRLF", () => {
    expect(unmetDor("## Definition of Ready\r\n- [x] a\r\n- [ ] b")).toEqual(["chưa tick: b"]);
  });
  it("Unicode trong mục", () => {
    expect(unmetDor(issue("- [ ] Phạm vi gọn trong một PR — đủ rõ"))).toEqual([
      "chưa tick: Phạm vi gọn trong một PR — đủ rõ",
    ]);
  });
});

describe("mẫu issue task.md", () => {
  it("thân mẫu nguyên bản CHƯA Ready (mọi mục còn trống), tick hết thì Ready", () => {
    const body = read(".github/ISSUE_TEMPLATE/task.md").replace(/^---[\s\S]*?---\n/, "");
    expect(unmetDor(body).length).toBeGreaterThanOrEqual(5);
    expect(unmetDor(body.replaceAll("- [ ]", "- [x]"))).toEqual([]);
  });
});

describe("mẫu issue bug.md (mọi mẫu issue đều có DoR để nhãn ready kiểm được)", () => {
  const body = read(".github/ISSUE_TEMPLATE/bug.md").replace(/^---[\s\S]*?---\n/, "");
  it("thân mẫu nguyên bản CHƯA Ready; chỉ tick mục DoR thì Ready; tick mục ngoài DoR không đủ", () => {
    expect(unmetDor(body).length).toBeGreaterThanOrEqual(3);
    expect(dorSection(body) ?? "").toContain("- [ ]");
    const tickDor = (m) => m.replaceAll("- [ ]", "- [x]");
    expect(unmetDor(body.replace(/## Definition of Ready[\s\S]*?(?=\n## )/, tickDor))).toEqual([]);
    // tick mục ngoài DoR ("Mức ảnh hưởng") không làm Ready
    const outside = body.replace(/## Mức ảnh hưởng[\s\S]*?(?=\n## )/, tickDor);
    expect(unmetDor(outside)).toEqual(unmetDor(body));
  });
  it("mọi mẫu issue trong .github/ISSUE_TEMPLATE có mục Definition of Ready", () => {
    for (const f of ["bug.md", "task.md"])
      expect(dorSection(read(`.github/ISSUE_TEMPLATE/${f}`)), f).not.toBeNull();
  });
});

describe("CLI", () => {
  const run = (body) => {
    try {
      return {
        code: 0,
        out: execFileSync("node", [`${ROOT}scripts/dor-check.mjs`], {
          env: { ...process.env, ISSUE_BODY: body },
          encoding: "utf8",
          stdio: "pipe",
        }),
      };
    } catch (e) {
      return { code: e.status, out: String(e.stderr) };
    }
  };
  it("exit 0 khi đủ, 1 khi thiếu", () => {
    expect(run(issue("- [x] a")).code).toBe(0);
    const bad = run(issue("- [ ] a"));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("chưa tick: a");
  });
});

describe("workflow dor-check.yml", () => {
  const yml = read(".github/workflows/dor-check.yml");
  it("id job trùng tên job `dor-check` (Bằng chứng blueprint ghi ci:dor-check)", () => {
    expect(yml).toMatch(/^ {2}dor-check:\n {4}name: dor-check\n/m);
  });
  it("chạy khi issue được gán nhãn/sửa; quyền tối thiểu; thân issue qua env, không nội suy vào run", () => {
    expect(yml).toMatch(/issues:\s*\n\s+types:\s*\[labeled, edited\]/);
    expect(yml).toMatch(/permissions:\s*\n\s+contents: read\s*\n\s+issues: write/);
    expect(yml).toMatch(/ISSUE_BODY: \$\{\{ github\.event\.issue\.body \}\}/);
    const uses = yml.split("\n").filter((l) => l.includes("github.event.issue.body"));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l.trim()).toMatch(/^ISSUE_BODY: /);
  });
  it("gỡ nhãn ready khi DoR chưa đủ", () => {
    expect(yml).toContain("--remove-label ready");
    expect(yml).toContain("scripts/dor-check.mjs");
  });
  it("không continue-on-error", () => expect(yml).not.toContain("continue-on-error"));
});
