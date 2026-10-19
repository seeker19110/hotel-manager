// pr-steward (khung 3.5.0, ADR-0027) bật auto-merge của GitHub cho PR đủ tiêu chuẩn. Auto-merge chỉ chờ CI khi nhánh đích có
// required status check; không có thì GitHub merge NGAY lúc bật (#84, #85 vào main khi e2e/lighthouse còn chạy, trước khi có
// ruleset). T-1107: bước steward chỉ `--apply` khi nhánh đích có ≥ 1 context required (đọc `rules/branches/<nhánh>`).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const wf = parse(readFileSync(join(ROOT, ".github/workflows/pr-steward.yml"), "utf8"));
const step = wf.jobs.steward.steps.find((s) => String(s.run ?? "").includes("pr steward"));

/**
 * Chạy đúng script của bước dưới `bash -e` (shell mặc định của runner). `gh` giả trả `body` qua `jq` THẬT với filter
 * `--jq` của chính workflow (mã thoát `ghCode` ≠ 0 ⇒ lỗi API, không in gì); `python3` giả in lệnh được gọi.
 */
function runStep({ body = "", ghCode = 0, pr = "85" } = {}) {
  const stub = `gh() {
  local q=""; while [ $# -gt 0 ]; do if [ "$1" = --jq ]; then q="$2"; shift; fi; shift; done
  [ ${ghCode} -eq 0 ] || { echo "HTTP 403" >&2; return ${ghCode}; }
  printf '%s' "$GH_BODY" | jq "$q"
}
python3() { echo "CALL: $*"; }
`;
  const r = spawnSync("bash", ["-e", "-c", stub + step.run], {
    env: { PATH: process.env.PATH, GH_REPO: "o/r", PR: pr, BASE: "main", GH_BODY: body },
    encoding: "utf8",
  });
  return {
    code: r.status,
    out: r.stdout,
    call: r.stdout.split("\n").find((l) => l.startsWith("CALL:")) ?? "",
  };
}
const rule = (contexts) => ({
  type: "required_status_checks",
  parameters: { required_status_checks: contexts.map((context) => ({ context })) },
});
const APPLY = "CALL: .xtemplates/scripts/xt.py pr steward --apply --repo o/r --pr 85";
const REPORT = "CALL: .xtemplates/scripts/xt.py pr steward --repo o/r --pr 85";

describe("pr-steward: chỉ tự merge khi nhánh đích có required check", () => {
  it("bước steward đọc rule của nhánh mặc định", () => {
    expect(step.env.BASE).toMatch(/^\$\{\{ github\.event\.repository\.default_branch \}\}$/);
    expect(step.run).toMatch(/gh api "repos\/\$GH_REPO\/rules\/branches\/\$BASE"/);
  });

  it("có ≥ 1 context required ⇒ --apply như cũ (cả khi không chỉ định PR)", () => {
    const body = JSON.stringify([{ type: "deletion" }, rule(["quality", "e2e"])]);
    expect(runStep({ body }).call).toBe(APPLY);
    expect(runStep({ body, pr: "" }).call).toBe(
      "CALL: .xtemplates/scripts/xt.py pr steward --apply --repo o/r",
    );
  });

  it("không có rule, rule có danh sách context rỗng, hay chỉ rule khác ⇒ chỉ báo, cảnh báo 'chưa có'", () => {
    for (const rules of [[], [{ type: "deletion" }, { type: "non_fast_forward" }], [rule([])]]) {
      const r = runStep({ body: JSON.stringify(rules) });
      expect(r.code).toBe(0);
      expect(r.call).toBe(REPORT);
      expect(r.out).toMatch(/::warning::main chưa có required status check/);
    }
  });

  it("lỗi API (403/404) hoặc body không phải mảng rule ⇒ chỉ báo, cảnh báo 'không đọc được'", () => {
    for (const r of [runStep({ ghCode: 1 }), runStep({ body: '{"message":"Not Found"}' })]) {
      expect(r.code).toBe(0);
      expect(r.call).toBe(REPORT);
      expect(r.out).toMatch(/::warning::không đọc được rule của main/);
    }
  });
});
