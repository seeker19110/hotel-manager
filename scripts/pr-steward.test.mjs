// pr-steward (khung 3.5.0, ADR-0027) bật auto-merge của GitHub cho PR đủ tiêu chuẩn. Auto-merge chỉ chờ CI khi nhánh đích có
// required status check; repo chưa import .github/rulesets/main.json thì GitHub merge NGAY lúc bật (#84, #85 vào main khi
// e2e/lighthouse còn chạy). T-1107: bước steward chỉ `--apply` khi đọc được rule `required_status_checks` của nhánh đích.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const wf = parse(readFileSync(join(ROOT, ".github/workflows/pr-steward.yml"), "utf8"));
const step = wf.jobs.steward.steps.find((s) => String(s.run ?? "").includes("pr steward"));

/** Chạy đúng script của bước với `gh`/`python3` giả; `gh` trả `ghOut` và mã `ghCode`. */
function runStep(ghOut, ghCode, pr = "85") {
  const stub = `gh() { printf '%s\\n' ${JSON.stringify(ghOut)}; return ${ghCode}; }\npython3() { echo "CALL: $*"; }\n`;
  const r = spawnSync("bash", ["-c", stub + step.run], {
    env: { PATH: process.env.PATH, GH_REPO: "o/r", PR: pr, BASE: "main" },
    encoding: "utf8",
  });
  return {
    code: r.status,
    out: r.stdout,
    call: r.stdout.split("\n").find((l) => l.startsWith("CALL:")) ?? "",
  };
}

describe("pr-steward: chỉ tự merge khi nhánh đích có required check", () => {
  it("bước steward đọc rule của nhánh mặc định", () => {
    expect(step.env.BASE).toMatch(/^\$\{\{ github\.event\.repository\.default_branch \}\}$/);
    expect(step.run).toMatch(/gh api "repos\/\$GH_REPO\/rules\/branches\/\$BASE"/);
    expect(step.run).toContain('select(.type == "required_status_checks")');
  });

  it("có required check ⇒ --apply như cũ", () => {
    expect(runStep("2", 0).call).toBe(
      "CALL: .xtemplates/scripts/xt.py pr steward --apply --repo o/r --pr 85",
    );
    expect(runStep("1", 0, "").call).toBe("CALL: .xtemplates/scripts/xt.py pr steward --apply --repo o/r");
  });

  it("không có rule, lỗi API, hay đầu ra lạ ⇒ chỉ báo (không --apply) kèm cảnh báo", () => {
    for (const [out, code] of [
      ["0", 0],
      ["", 1],
      ['{"message":"Not Found"}', 1],
      ["abc", 0],
    ]) {
      const r = runStep(out, code);
      expect(r.code).toBe(0);
      expect(r.call).toBe("CALL: .xtemplates/scripts/xt.py pr steward --repo o/r --pr 85");
      expect(r.out).toMatch(/::warning::main chưa có required status check/);
    }
  });
});
