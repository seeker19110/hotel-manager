// T-807: rào cấu trúc cho cổng CI — khoá cấu hình mà chỉ CI mới chứng minh được bằng job xanh
// (WF-CI-001 job gom `quality` + ruleset đúng 4 check, WF-CI-004 zizmor + không nội suy input không tin cậy, XC-DX-001 onboarding-smoke).
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

/** Tên check của mọi job (`name:` hoặc khoá job) — đúng cách GitHub đặt context. */
function jobNames(wfs) {
  const names = new Set();
  for (const wf of Object.values(wfs))
    for (const [key, job] of Object.entries(wf.jobs ?? {})) names.add(job.name ?? key);
  return names;
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

describe("WF-CI-001 — job gom quality + ruleset đúng 4 required check", () => {
  const ruleset = JSON.parse(read(".github/rulesets/main.json"));

  it("ruleset đòi đúng quality · protection-guard · gitleaks · dep-audit", () => {
    expect(requiredContexts(ruleset).sort()).toEqual([
      "dep-audit",
      "gitleaks",
      "protection-guard",
      "quality",
    ]);
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

    it("xoá workflow chứa job của một context → exit 1", () => {
      const r = sandbox((d) => rmSync(join(d, WORKFLOW_DIR, "dep-audit.yml")));
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("dep-audit");
    });
  });
});

describe("WF-CI-004 — zizmor + không nội suy input không tin cậy vào run:", () => {
  const wfs = workflows();

  it("không workflow nào dùng pull_request_target hoặc workflow_run", () => {
    for (const [f, wf] of Object.entries(wfs)) {
      const on =
        typeof wf.on === "string" ? [wf.on] : Array.isArray(wf.on) ? wf.on : Object.keys(wf.on ?? {});
      expect(on, f).not.toContain("pull_request_target");
      expect(on, f).not.toContain("workflow_run");
    }
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
  it("job onboarding-smoke chạy đúng các lệnh README theo thứ tự trên runner mới", () => {
    expect(job).toBeTruthy();
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    const runs = job.steps.filter((s) => String(s.name ?? "").startsWith("Lệnh")).map((s) => s.run.trim());
    expect(runs).toEqual(commands);
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
