// T-801 (đợt 9): khoá cấu hình CI của chính sách PR — phần chỉ chứng minh được bằng job xanh trên PR thì khoá cấu trúc ở đây
// (BASE-DOC-006, BASE-DOC-008, DB-MIG-003, ARC-ADR-004, WF-DOC-002, STD-PROC-003, WF-SDD-003, WF-TEAM-003, XC-GREEN-005,
// WF-REVIEW-002, LOOP-STOP-005). Job xanh trên PR là bằng chứng chạy thật; test này giữ để không ai gỡ/nới bước.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

/** Thân (đã bỏ thụt lề) của job `name` trong một workflow phẳng; không có → null. */
function jobBody(yml, name) {
  const m = new RegExp(`^  ${name}:\\n((?:    .*\\n|\\n)*)`, "m").exec(yml);
  return m ? m[1] : null;
}

describe("pr-policy.yml", () => {
  const yml = read(".github/workflows/pr-policy.yml");
  const job = jobBody(yml, "pr-policy") ?? "";

  it("chạy trên pull_request vào main, chạy lại khi sửa mô tả/nhãn", () => {
    expect(yml).toMatch(/pull_request:\s*\n\s+branches: \[main\]/);
    for (const t of ["opened", "synchronize", "reopened", "edited", "labeled", "unlabeled"])
      expect(yml).toContain(t);
  });
  it("job tên `pr-policy`, quyền chỉ đọc, có timeout", () => {
    expect(job).not.toBe("");
    expect(job).toMatch(/name: pr-policy/);
    expect(yml).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(job).toMatch(/timeout-minutes: \d+/);
  });
  it("checkout lịch sử đầy đủ (fetch-depth: 0) để so với nhánh gốc và kiểm SHA tổ tiên", () => {
    expect(job).toMatch(/actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+fetch-depth: 0/);
  });
  it("tiêu đề/mô tả/nhãn chỉ qua biến môi trường, không nội suy vào lệnh", () => {
    const interpolated = job
      .split("\n")
      .filter(
        (l) =>
          /\$\{\{ *github\.event\.pull_request\.(title|body)/.test(l) ||
          /\$\{\{ *github\.(base_ref|head_ref)/.test(l),
      );
    expect(interpolated.length).toBeGreaterThan(0);
    for (const l of interpolated) expect(l.trim()).toMatch(/^[A-Z_]+: \$\{\{/);
  });
  it("chạy pr-policy.py --strict với nhãn, mô tả, base", () => {
    expect(job).toMatch(
      /python3 scripts\/pr-policy\.py[\s\S]*--base "origin\/\$BASE_REF"[\s\S]*--body-file[\s\S]*--labels "\$PR_LABELS"[\s\S]*--strict/,
    );
  });
  it("chạy test Python của chính sách, progress-check, link nội bộ", () => {
    expect(job).toContain('python3 -m unittest discover -s scripts -p "test_*.py"');
    expect(job).toContain("python3 .xtemplates/scripts/xt.py progress-check");
    expect(job).toContain("python3 .xtemplates/scripts/check-links.py");
  });
  it("chạy rào migration, ADR, hợp đồng API so với origin/<base>", () => {
    expect(job).toMatch(/node scripts\/check-migrations-immutable\.mjs --base "origin\/\$BASE_REF"/);
    expect(job).toMatch(/node scripts\/check-adr-immutable\.mjs --base "origin\/\$BASE_REF"/);
    expect(job).toMatch(/node scripts\/check-openapi-breaking\.mjs --base "origin\/\$BASE_REF" --extra-file/);
  });
  it("không continue-on-error", () => {
    expect(yml).not.toContain("continue-on-error");
  });
  it("bỏ qua PR của bot theo TÁC GIẢ PR (dependabot + github-actions/release-please), không theo github.actor", () => {
    const jobIf = (/^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(job)?.[1] ?? "").replace(/\s+/g, " ");
    expect(jobIf).toContain("github.event.pull_request.user.login != 'dependabot[bot]'");
    expect(jobIf).toContain("github.event.pull_request.user.login != 'github-actions[bot]'");
    expect(yml).not.toContain("github.actor");
  });
  it("chạy trên MỌI PR vào main: không lọc paths/branches-ignore ở cấp workflow; bỏ qua chỉ bằng if ở cấp job (D-065)", () => {
    const trigger = /^on:\n((?: {2}.*\n|\n)+)/m.exec(yml)?.[1] ?? "";
    expect(trigger).toContain("pull_request:");
    expect(trigger).not.toMatch(/\bpaths(?:-ignore)?:|branches-ignore:|tags(?:-ignore)?:/);
    expect(job).toMatch(/^ {4}if: /m);
  });
  it("dòng Bằng chứng của mục blueprint dựa vào job pr-policy nêu mức chặn thật (D-065)", () => {
    const bp = read("BLUEPRINT.md").split("\n");
    const items = [
      "BASE-DOC-006",
      "BASE-DOC-008",
      "STD-PROC-003",
      "DB-MIG-003",
      "WF-REVIEW-002",
      "WF-DOC-002",
      "WF-TEAM-003",
      "XC-GREEN-005",
    ];
    for (const id of items) {
      const line = bp.find((l) => l.startsWith(`- [x] \`${id}\``)) ?? "";
      const evidence = line.split("Bằng chứng:")[1] ?? "";
      expect(evidence, id).toContain("ci:pr-policy");
      expect(evidence, id).toContain(
        "job đỏ trên PR; chặn merge khi ruleset .github/rulesets/main.json được import — D-065",
      );
    }
  });
  it("mọi script mà workflow gọi đều có thật", () => {
    for (const m of yml.matchAll(/scripts\/[\w.-]+\.(?:py|mjs)|\.xtemplates\/scripts\/[\w.-]+\.py/g)) {
      expect(existsSync(`${ROOT}${m[0]}`), m[0]).toBe(true);
    }
  });
});

describe("link-check.yml (liên kết ngoài theo lịch)", () => {
  const yml = read(".github/workflows/link-check.yml");
  it("chạy theo lịch + chạy tay, quyền chỉ đọc, có cache và timeout", () => {
    expect(yml).toMatch(/schedule:\s*\n\s+- cron: "[^"]+"/);
    expect(yml).toContain("workflow_dispatch");
    expect(yml).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(yml).toMatch(/uses: actions\/cache@[0-9a-f]{40} # v\d/);
    expect(yml).toMatch(/timeout-minutes: \d+/);
    expect(yml).toContain("node scripts/check-external-links.mjs");
  });
  it("không chạy trên pull_request/push (không chặn merge vì mạng ngoài) và không continue-on-error", () => {
    expect(yml).not.toMatch(/^\s+(pull_request|push):/m);
    expect(yml).not.toContain("continue-on-error");
  });
});

describe("workflow mới qua ci-check của khung", () => {
  it("ci-check xanh cho toàn bộ .github/workflows (ghim SHA, quyền tối thiểu, timeout)", () => {
    const out = execFileSync(
      "python3",
      [`${ROOT}.xtemplates/scripts/xt.py`, "ci-check", `${ROOT}.github/workflows`],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );
    expect(out).toContain("✓");
  });
});

describe("job pr-policy là job thật (protection-guard khớp ruleset)", () => {
  it("không để ruleset trỏ tới job không có; pr-policy tồn tại để thêm vào required check", () => {
    const ruleset = JSON.parse(read(".github/rulesets/main.json"));
    const required = ruleset.rules
      .filter((r) => r.type === "required_status_checks")
      .flatMap((r) => r.parameters.required_status_checks.map((c) => c.context));
    const all = [
      "ci.yml",
      "dep-audit.yml",
      "secret-scan.yml",
      "pr-policy.yml",
      "link-check.yml",
      "dor-check.yml",
    ]
      .map((f) => read(`.github/workflows/${f}`))
      .join("\n");
    for (const ctx of required) expect(all, ctx).toMatch(new RegExp(`(^  ${ctx}:|name: ${ctx})`, "m"));
    expect(all).toMatch(/name: pr-policy/);
  });
});

describe("mẫu PR hướng dẫn đúng những gì pr-policy kiểm", () => {
  const t = read(".github/pull_request_template.md");
  it("nêu nhãn risk:, bản đồ S-NNN → test, rollback, hàng Số test", () => {
    for (const label of ["risk:money", "risk:data", "risk:auth", "risk:crypto"]) expect(t).toContain(label);
    expect(t).toMatch(/scenario → test/);
    expect(t).toMatch(/rollback/);
    expect(t).toMatch(/\| Số test/);
    expect(t).toContain("pr-policy");
  });
});

describe("xt.yaml — nguồn của nhãn risk", () => {
  it("xt.yaml giữ merge_risk_paths (nguồn nhãn risk) và L3", () => {
    const x = read("xt.yaml");
    expect(x).toMatch(/^merge_autonomy: L3$/m);
    expect(x).toMatch(/^merge_risk_paths: ".+"/m);
  });
});
