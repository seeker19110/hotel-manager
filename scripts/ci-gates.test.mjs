// T-807: rào cấu trúc cho cổng CI — khoá cấu hình mà chỉ CI mới chứng minh được bằng job xanh
// (WF-CI-001 job gom `quality` + ruleset khớp job thật, D-065 ruleset gom mọi cổng PR của đợt 9,
// WF-CI-004 zizmor + không nội suy input không tin cậy, XC-DX-001 onboarding-smoke).
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const WORKFLOW_DIR = ".github/workflows";

/** Mọi workflow đã parse: `{ "ci.yml": {...}, … }`. */
function workflows() {
  const out = {};
  for (const f of readdirSync(join(ROOT, WORKFLOW_DIR))
    .filter((n) => /\.ya?ml$/.test(n))
    .sort())
    out[f] = parse(read(`${WORKFLOW_DIR}/${f}`));
  return out;
}

const MATRIX_NAME = ["$", "{{ matrix.name }}"].join("");

/** Context của một job: `name:` (hoặc khoá job); job ma trận → mỗi phần tử `matrix.include[].name` một context. */
function jobContexts(key, job) {
  const label = String(job.name ?? key);
  if (!label.includes(MATRIX_NAME)) return [label];
  const include = job.strategy?.matrix?.include ?? [];
  return include.map((m) => label.replace(MATRIX_NAME, String(m.name)));
}

/** Tên check của mọi job — đúng cách GitHub đặt context. */
function jobNames(wfs) {
  const names = new Set();
  for (const wf of Object.values(wfs))
    for (const [key, job] of Object.entries(wf.jobs ?? {}))
      for (const c of jobContexts(key, job)) names.add(c);
  return names;
}

/**
 * Workflow có chạy trên MỌI pull_request vào main (không lọc `paths`/`paths-ignore`/nhánh khác)? `pull_request_target`
 * cũng tính (merge-gate của khung: workflow lấy từ nhánh mặc định, vẫn báo check trên head của PR).
 */
const PR_EVENTS = ["pull_request", "pull_request_target"];
function runsOnEveryPr(wf) {
  const on = wf.on;
  if (typeof on === "string") return PR_EVENTS.includes(on);
  if (Array.isArray(on)) return on.some((e) => PR_EVENTS.includes(e));
  const event = PR_EVENTS.find((e) => on && e in on);
  if (!event) return false;
  const pr = on[event] ?? {};
  if (pr.paths || pr["paths-ignore"] || pr["branches-ignore"]) return false;
  return !pr.branches || pr.branches.includes("main");
}

/** `if:` của job loại hẳn sự kiện pull_request (chỉ push/lịch/chạy tay/issue)? */
const skipsPullRequest = (job) =>
  /event_name\s*==\s*'(push|schedule|workflow_dispatch|issues)'/.test(String(job.if ?? ""));

/**
 * `if:` của job phụ thuộc HÀNH ĐỘNG của sự kiện PR (`edited`, `changes`…)? Job required mà bị bỏ qua ở một hành động sẽ sinh check-run
 * `skipped` mới nhất cùng SHA, GitHub tính là qua và có thể che lần chạy đỏ trước đó (AUD-CI-001).
 */
const skipsOnEventAction = (job) => /github\.event\.(action|changes)\b/.test(String(job.if ?? ""));

/** Context của mọi job chạy trên mọi PR vào main (job có `if:` bỏ qua → kết quả skipped, GitHub tính là qua). */
function prContexts(wfs) {
  const out = new Set();
  for (const wf of Object.values(wfs)) {
    if (!runsOnEveryPr(wf)) continue;
    for (const [key, job] of Object.entries(wf.jobs ?? {}))
      if (!skipsPullRequest(job)) for (const c of jobContexts(key, job)) out.add(c);
  }
  return out;
}

const requiredContexts = (ruleset) =>
  ruleset.rules
    .filter((r) => r.type === "required_status_checks")
    .flatMap((r) => r.parameters.required_status_checks.map((c) => c.context));

/**
 * Chuỗi `${{ … }}` nằm thẳng trong `run:` (script injection — GitHub Security hardening). Trả về danh sách vi phạm
 * `job/bước: biểu thức`. Input phải đi qua `env:` rồi dùng như biến shell có quote.
 */
function interpolationsInRun(wf) {
  const bad = [];
  for (const [jobKey, job] of Object.entries(wf.jobs ?? {}))
    for (const [i, step] of (job.steps ?? []).entries())
      for (const m of String(step.run ?? "").matchAll(/\$\{\{[\s\S]*?\}\}/g))
        bad.push(`${jobKey}/#${i}: ${m[0]}`);
  return bad;
}

const tmpDirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ci-gates-"));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const ci = parse(read(`${WORKFLOW_DIR}/ci.yml`));
const stepRun = (job, namePart) => job.steps.find((s) => String(s.name ?? "").includes(namePart))?.run;

/** Cổng đợt 9 (T-801…T-807) chạy trên mọi PR — D-065: phải có trong ruleset để chặn merge khi người import. */
const WAVE9_GATES = [
  "commit-lint",
  "pr-policy",
  "new-deps",
  "openapi",
  "prometheus-rules",
  "otel-collector",
  "schema-compat",
  "fe-typecheck",
  "fe-lint",
  "bundle-size",
  "lighthouse",
  "unit-deterministic",
  "e2e-repeat",
  "regression",
  "sast",
  "dast",
  "sbom",
  "image-scan (postgres)",
  "image-scan (node-base)",
  "image-scan (seaweedfs)",
  "image-scan (caddy)",
  "coverage",
  "coverage-ratchet",
  "fix-requires-test",
];
/** Cổng có từ trước đợt 9; `quality` gom gate/e2e/backup-restore/workflow-lint/onboarding-smoke (T-807). */
const BASE_GATES = ["quality", "protection-guard", "gitleaks", "dep-audit"];
/** Cổng của khung X-Templates 3.0.0: `merge-gate` đỏ khi PR ngoại lệ cứng đang bật auto-merge (ADR-0023 của khung). */
const FRAMEWORK_GATES = ["merge-gate"];

describe("WF-CI-001 — job gom quality + ruleset khớp job thật", () => {
  const ruleset = JSON.parse(read(".github/rulesets/main.json"));

  it("ruleset đòi cổng nền (quality · protection-guard · gitleaks · dep-audit) + mọi cổng PR của đợt 9 + merge-gate", () => {
    expect(requiredContexts(ruleset).sort()).toEqual(
      [...BASE_GATES, ...WAVE9_GATES, ...FRAMEWORK_GATES].sort(),
    );
  });

  it("không context trùng lặp trong ruleset", () => {
    const all = requiredContexts(ruleset);
    expect(new Set(all).size).toBe(all.length);
  });

  it("mỗi required check là một job có thật trong .github/workflows/", () => {
    const names = jobNames(workflows());
    for (const c of requiredContexts(ruleset)) expect(names.has(c), `không có job ${c}`).toBe(true);
  });

  it("quality luôn chạy (if: always()) và needs mọi job cổng khác của ci.yml", () => {
    const q = ci.jobs.quality;
    expect(String(q.if)).toMatch(/always\(\)/);
    const gates = Object.keys(ci.jobs).filter((k) => k !== "quality" && k !== "protection-guard");
    expect(gates.length).toBeGreaterThan(3);
    expect([...q.needs].sort()).toEqual(gates.sort());
    expect(q.steps.some((s) => String(s.env?.NEEDS ?? "").includes("toJSON(needs)"))).toBe(true);
  });

  const gather = stepRun(ci.jobs.quality, "success");
  const run = (needs) =>
    spawnSync("bash", ["-c", gather], {
      env: { ...process.env, NEEDS: JSON.stringify(needs) },
      encoding: "utf8",
    });

  it("quality xanh khi mọi job con success", () => {
    const r = run({ gate: { result: "success" }, e2e: { result: "success" } });
    expect(r.status).toBe(0);
  });

  it.each(["failure", "cancelled", "skipped"])("quality đỏ khi một job con là %s", (result) => {
    const r = run({ gate: { result: "success" }, e2e: { result } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`e2e=${result}`);
  });

  describe("protection-guard đỏ khi context không khớp job nào", () => {
    const script = stepRun(ci.jobs["protection-guard"], "Required check");
    const sandbox = (mutate) => {
      const d = tmp();
      mkdirSync(join(d, ".github"), { recursive: true });
      cpSync(join(ROOT, WORKFLOW_DIR), join(d, WORKFLOW_DIR), { recursive: true });
      cpSync(join(ROOT, ".github/rulesets"), join(d, ".github/rulesets"), { recursive: true });
      mutate(d);
      return spawnSync("bash", ["-c", script], { cwd: d, encoding: "utf8" });
    };

    it("khớp hết → exit 0", () => {
      expect(sandbox(() => {}).status).toBe(0);
    });

    it("thêm context không có job → exit 1 và nêu tên", () => {
      const r = sandbox((d) => {
        const p = join(d, ".github/rulesets/main.json");
        const rs = JSON.parse(readFileSync(p, "utf8"));
        const rule = rs.rules.find((x) => x.type === "required_status_checks");
        rule.parameters.required_status_checks.push({ context: "khong-co-job" });
        writeFileSync(p, JSON.stringify(rs));
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("khong-co-job");
    });

    it("context của job ma trận (có dấu cách) khớp theo từng phần tử", () => {
      const ok = sandbox(() => {});
      expect(ok.status).toBe(0);
      const bad = sandbox((d) => {
        const p = join(d, ".github/rulesets/main.json");
        const rs = JSON.parse(readFileSync(p, "utf8"));
        const rule = rs.rules.find((x) => x.type === "required_status_checks");
        rule.parameters.required_status_checks.push({ context: "image-scan (khong-co)" });
        writeFileSync(p, JSON.stringify(rs));
      });
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain("image-scan (khong-co)");
      expect(bad.stdout).not.toContain("image-scan (postgres)");
    });

    it("xoá workflow chứa job của một context → exit 1", () => {
      const r = sandbox((d) => rmSync(join(d, WORKFLOW_DIR, "dep-audit.yml")));
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("dep-audit");
    });
  });
});

describe("D-065 — ruleset gom mọi job chạy trên mọi PR vào main", () => {
  const wfs = workflows();
  const ruleset = JSON.parse(read(".github/rulesets/main.json"));
  const required = new Set(requiredContexts(ruleset));
  const aggregated = new Set(ci.jobs.quality.needs);
  const prJobs = prContexts(wfs);

  it("mỗi context trong main.json là job có thật chạy trên pull_request tới main, không lọc paths", () => {
    for (const c of required) expect(prJobs.has(c), `${c} không chạy trên mọi PR`).toBe(true);
  });

  it("mỗi job chạy trên mọi PR có trong main.json, trừ job đã gom vào quality (needs)", () => {
    for (const c of prJobs)
      if (!aggregated.has(c))
        expect(required.has(c), `${c} chạy trên PR nhưng chưa là required check`).toBe(true);
  });

  it("job gom vào quality không bị đòi lặp trong ruleset", () => {
    for (const c of aggregated) {
      expect(prJobs.has(c), c).toBe(true);
      expect(required.has(c), c).toBe(false);
    }
  });

  it("không job required nào bị bỏ qua theo hành động của sự kiện PR (edited/changes): skipped đến sau che lần chạy đỏ (AUD-CI-001)", () => {
    const bad = [];
    for (const wf of Object.values(wfs)) {
      if (!runsOnEveryPr(wf)) continue;
      for (const [key, job] of Object.entries(wf.jobs ?? {}))
        if (
          skipsOnEventAction(job) &&
          jobContexts(key, job).some((c) => required.has(c) || aggregated.has(c))
        )
          bad.push(`${key}: if: ${job.if}`);
    }
    expect(bad).toEqual([]);
  });

  it("bộ dò if: theo hành động bắt đúng các dạng che coverage (kể cả `!github.event.changes`)", () => {
    expect(skipsOnEventAction({ if: "github.event.action != 'edited'" })).toBe(true);
    expect(skipsOnEventAction({ if: ["$", "{{ !github.event.changes }}"].join("") })).toBe(true);
    expect(skipsOnEventAction({ if: "github.event_name == 'pull_request'" })).toBe(false);
    expect(skipsOnEventAction({ if: "github.actor != 'dependabot[bot]'" })).toBe(false);
    expect(skipsOnEventAction({})).toBe(false);
  });

  it("job chỉ chạy theo lịch/push/chạy tay/issue không bao giờ là required check", () => {
    for (const c of ["external-links", "eol-check", "dor-check", "release-please", "assets"]) {
      expect(jobNames(wfs).has(c), `${c} không tồn tại`).toBe(true);
      expect(required.has(c), c).toBe(false);
    }
  });

  it("nhóm cổng đợt 9 đều có mặt và là job PR thật", () => {
    expect(WAVE9_GATES.length).toBe(24);
    for (const c of WAVE9_GATES) {
      expect(required.has(c), `${c} thiếu trong main.json`).toBe(true);
      expect(prJobs.has(c), c).toBe(true);
    }
  });

  describe("bộ dò đúng ca biên", () => {
    const wf = (on, jobs) => ({ on, jobs });
    const job = { "runs-on": "ubuntu-24.04" };

    it("lọc paths / paths-ignore / nhánh khác main → không chạy trên mọi PR", () => {
      expect(runsOnEveryPr(wf({ pull_request: { branches: ["main"] } }, {}))).toBe(true);
      expect(runsOnEveryPr(wf({ pull_request: null }, {}))).toBe(true);
      expect(runsOnEveryPr(wf("pull_request", {}))).toBe(true);
      expect(runsOnEveryPr(wf(["push", "pull_request"], {}))).toBe(true);
      expect(runsOnEveryPr(wf({ pull_request: { paths: ["apps/**"] } }, {}))).toBe(false);
      expect(runsOnEveryPr(wf({ pull_request: { "paths-ignore": ["docs/**"] } }, {}))).toBe(false);
      expect(runsOnEveryPr(wf({ pull_request: { branches: ["release"] } }, {}))).toBe(false);
      expect(runsOnEveryPr(wf({ schedule: [{ cron: "0 0 * * 1" }] }, {}))).toBe(false);
      expect(runsOnEveryPr(wf({ push: { branches: ["main"] } }, {}))).toBe(false);
    });

    it("job có if: chỉ push/lịch bị loại; if: theo hành động PR vẫn tính", () => {
      expect(skipsPullRequest({ ...job, if: "github.event_name == 'push'" })).toBe(true);
      expect(skipsPullRequest({ ...job, if: "github.event_name == 'schedule'" })).toBe(true);
      expect(skipsPullRequest({ ...job, if: "github.event_name == 'pull_request'" })).toBe(false);
      expect(skipsPullRequest({ ...job, if: "github.actor != 'dependabot[bot]'" })).toBe(false);
      expect(skipsPullRequest(job)).toBe(false);
    });

    it("job ma trận → một context cho mỗi phần tử; ma trận rỗng → không context", () => {
      const m = {
        ...job,
        name: `scan (${MATRIX_NAME})`,
        strategy: { matrix: { include: [{ name: "a" }, { name: "b" }] } },
      };
      expect(jobContexts("scan", m)).toEqual(["scan (a)", "scan (b)"]);
      expect(jobContexts("scan", { ...m, strategy: undefined })).toEqual([]);
      expect(jobContexts("k", job)).toEqual(["k"]);
      expect(jobContexts("k", { ...job, name: "tên riêng" })).toEqual(["tên riêng"]);
    });

    it("prContexts bỏ workflow lọc paths và job if: push", () => {
      const got = prContexts({
        a: wf({ pull_request: null }, { ok: job, only_push: { ...job, if: "github.event_name == 'push'" } }),
        b: wf({ pull_request: { paths: ["x/**"] } }, { filtered: job }),
      });
      expect([...got]).toEqual(["ok"]);
    });
  });
});

describe("WF-CI-004 — zizmor + không nội suy input không tin cậy vào run:", () => {
  const wfs = workflows();

  const triggers = (wf) =>
    typeof wf.on === "string" ? [wf.on] : Array.isArray(wf.on) ? wf.on : Object.keys(wf.on ?? {});

  it("không workflow nào dùng workflow_run; pull_request_target chỉ ở merge-gate.yml của khung (D-069)", () => {
    for (const [f, wf] of Object.entries(wfs)) {
      expect(triggers(wf), f).not.toContain("workflow_run");
      if (f !== "merge-gate.yml") expect(triggers(wf), f).not.toContain("pull_request_target");
    }
  });

  it("merge-gate.yml (pull_request_target) không checkout code PR, chỉ quyền đọc, không secret", () => {
    const f = "merge-gate.yml";
    const wf = wfs[f];
    const text = read(`${WORKFLOW_DIR}/${f}`);
    expect(triggers(wf)).toEqual(["pull_request_target"]);
    expect(wf.permissions).toEqual({ contents: "read" });
    for (const [key, job] of Object.entries(wf.jobs)) {
      for (const level of Object.values(job.permissions ?? {})) expect(level, key).toBe("read");
      for (const step of job.steps ?? []) {
        if (String(step.uses ?? "").startsWith("actions/checkout@")) {
          expect(step.with?.ref, key).toBeUndefined();
          expect(step.with?.["persist-credentials"], key).toBe(false);
        }
      }
    }
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/pull_request\.head\.(ref|repo)/);
  });

  it("không có biểu thức Actions nằm thẳng trong run: (đi qua env:)", () => {
    for (const [f, wf] of Object.entries(wfs)) expect(interpolationsInRun(wf), f).toEqual([]);
  });

  it("bắt đúng: tiêu đề PR nội suy thẳng vào run: là vi phạm; qua env: thì không", () => {
    const bad = parse(`
on: pull_request
jobs:
  t:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ github.event.pull_request.title }}"
`);
    const good = parse(`
on: pull_request
jobs:
  t:
    runs-on: ubuntu-24.04
    steps:
      - env:
          TITLE: \${{ github.event.pull_request.title }}
        run: printf '%s' "$TITLE"
`);
    expect(interpolationsInRun(bad)).toHaveLength(1);
    expect(interpolationsInRun(good)).toEqual([]);
  });

  it("tiêu đề PR của ci.yml đi qua env TITLE", () => {
    expect(
      ci.jobs.gate.steps.some(
        (s) => s.env?.TITLE === ["$", "{{ github.event.pull_request.title }}"].join(""),
      ),
    ).toBe(true);
  });

  it("job workflow-lint chạy zizmor ghim phiên bản + hash trên .github/workflows, không bỏ qua lỗi", () => {
    const job = ci.jobs["workflow-lint"];
    expect(job).toBeTruthy();
    expect(job["continue-on-error"]).toBeUndefined();
    const text = job.steps.map((s) => `${s.run ?? ""}\n${s["continue-on-error"] ?? ""}`).join("\n");
    expect(text).toContain("--require-hashes -r .github/requirements-zizmor.txt");
    expect(text).toMatch(/zizmor" --offline .*\.github\/workflows/);
    expect(job.steps.some((s) => s["continue-on-error"])).toBe(false);
    const req = read(".github/requirements-zizmor.txt");
    expect(req).toMatch(/^zizmor==\d+\.\d+\.\d+ \\$/m);
    expect(req.match(/--hash=sha256:[0-9a-f]{64}/g)?.length ?? 0).toBeGreaterThan(0);
  });

  it("mọi checkout đặt persist-credentials: false (zizmor artipacked)", () => {
    for (const [f, wf] of Object.entries(wfs))
      for (const job of Object.values(wf.jobs))
        for (const s of job.steps ?? [])
          if (String(s.uses ?? "").startsWith("actions/checkout@"))
            expect(s.with?.["persist-credentials"], f).toBe(false);
  });
});

describe("XC-DX-001 — onboarding-smoke chạy đúng ≤ 3 lệnh ở đầu README", () => {
  const readme = read("README.md");
  const section = /^## Bắt đầu nhanh[^\n]*\n([\s\S]*?)(?=^## )/m.exec(readme)?.[1] ?? "";
  const block = /```(?:bash|sh)?\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
  const commands = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  it("khối đầu tiên của README là 'Bắt đầu nhanh', có 1–3 lệnh", () => {
    expect(readme.indexOf("```")).toBeGreaterThan(readme.indexOf("## Bắt đầu nhanh"));
    expect(commands.length).toBeGreaterThanOrEqual(1);
    expect(commands.length).toBeLessThanOrEqual(3);
  });

  it("các lệnh khớp xt.yaml (install, test) và file có thật", () => {
    expect(commands).toContain("pnpm install --frozen-lockfile");
    expect(commands).toContain("pnpm test");
    expect(existsSync(join(ROOT, "scripts/dev-env-setup.sh"))).toBe(true);
    const xt = read("xt.yaml");
    expect(xt).toContain('install: "pnpm install --frozen-lockfile"');
    expect(xt).toContain('test: "pnpm test"');
  });

  const job = ci.jobs["onboarding-smoke"];
  it("job onboarding-smoke chạy ĐÚNG Y khối lệnh README (nguyên văn, một shell) trên runner mới, không bước PATH/env ẩn", () => {
    expect(job).toBeTruthy();
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    const measure = (st) => /ONBOARD_T0|GITHUB_STEP_SUMMARY/.test(String(st.run ?? ""));
    const runs = job.steps.filter((st) => st.run && !measure(st));
    expect(runs).toHaveLength(1);
    expect(
      runs[0].run
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ).toEqual(commands);
    expect(runs[0].shell).toBeUndefined(); // shell mặc định của runner = shell người dùng gõ lệnh
    for (const st of job.steps) expect(String(st.run ?? "")).not.toMatch(/GITHUB_PATH/);
    expect(JSON.stringify(job.env ?? {})).not.toContain("PATH");
  });

  it("dòng lệnh 1 tự đưa ~/.local/bin (nơi dev-env-setup.sh cài node/pnpm) lên PATH: máy mới không cần bước tay", () => {
    expect(commands[0]).toMatch(
      /^bash scripts\/dev-env-setup\.sh && export PATH="\$HOME\/\.local\/bin:\$PATH"$/,
    );
    expect(read("scripts/dev-env-setup.sh")).toMatch(/BIN_DIR="\$\{DEV_ENV_BIN_DIR:-\$HOME\/\.local\/bin\}"/);
  });

  it("job không dùng setup-node/pnpm-action (môi trường do chính lệnh 1 dựng) và có đo thời gian", () => {
    const uses = job.steps.map((s) => String(s.uses ?? ""));
    expect(uses.some((u) => /setup-node|pnpm\/action-setup/.test(u))).toBe(false);
    const text = job.steps.map((s) => s.run ?? "").join("\n");
    expect(text).toContain("date +%s");
    expect(text).toContain("GITHUB_STEP_SUMMARY");
    expect(job.steps.at(-1).if).toMatch(/always\(\)/);
  });

  it("quality needs onboarding-smoke (job đỏ thì cổng đỏ)", () => {
    expect(ci.jobs.quality.needs).toContain("onboarding-smoke");
  });
});
