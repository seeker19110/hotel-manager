// T-804: khoá cấu hình chất lượng frontend (FE-TEST-002/003, FE-PERF-002/004, PRF-WEB-006, XC-GREEN-002, UX-RESP-008,
// FE-BUILD-003/004). Phần chỉ chứng minh được khi job CI chạy → test cấu trúc đọc file cấu hình/workflow; mỗi luật có ca ĐỎ.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const workflow = read(".github/workflows/frontend-quality.yml");

/** Tách thân của từng job trong workflow: {tênKhoá: văn bản}. */
function jobsOf(text) {
  const body = text.split(/^jobs:\n/m)[1] ?? "";
  const out = {};
  for (const m of body.matchAll(/^ {2}([A-Za-z0-9_-]+):\n((?: {4}.*\n|\n)*)/gm)) out[m[1]] = m[2];
  return out;
}
const jobs = jobsOf(workflow);
const needsOf = (body) =>
  /^ {4}needs:\s*\[([^\]]*)\]/m
    .exec(body)?.[1]
    ?.split(",")
    .map((s) => s.trim()) ?? [];

describe("jobsOf / needsOf (bộ đọc)", () => {
  it("đọc đúng job và needs; không có needs → rỗng", () => {
    const j = jobsOf("jobs:\n  a:\n    runs-on: x\n  b:\n    needs: [a, c]\n    runs-on: y\n");
    expect(Object.keys(j)).toEqual(["a", "b"]);
    expect(needsOf(j.b)).toEqual(["a", "c"]);
    expect(needsOf(j.a)).toEqual([]);
  });
});

describe("FE-TEST-002 / PRF-WEB-006 / UX-RESP-008 — E2E hai project + axe", () => {
  const cfg = read("apps/web/playwright.config.ts");
  it("playwright.config có project `mobile` và `desktop`", () => {
    expect(cfg).toMatch(/name:\s*"mobile"/);
    expect(cfg).toMatch(/name:\s*"desktop"/);
    expect(cfg).toContain('devices["Desktop Chrome"]');
    expect(cfg).toContain('devices["Pixel 7"]');
  });
  it("quét axe bằng AxeBuilder, mọi mức impact đều chặn (đủ serious/critical của PRF-WEB-006)", () => {
    const a11y = read("apps/web/e2e/a11y.ts");
    expect(a11y).toContain('from "@axe-core/playwright"');
    expect(a11y).toContain("new AxeBuilder");
    expect(a11y).toMatch(/r\.violations\.map/);
    expect(a11y).not.toMatch(/violations\.filter/);
  });
  it("mỗi project có server + CSDL riêng: hai webServer, hai baseURL khác nhau (luồng ghi một lần không đụng nhau)", () => {
    expect(cfg.match(/command: "[^"]*node e2e\/server\.ts"/g)).toHaveLength(2);
    expect(cfg).toMatch(/DESKTOP_PORT = PORT \+ 200/);
    expect(cfg).toMatch(/name: "mobile", use: \{[^}]*baseURL: BASE_URL/);
    expect(cfg).toMatch(/baseURL: DESKTOP_URL/);
    for (const f of ["hotel", "members", "rental", "invitation", "portal"])
      expect(read(`apps/web/e2e/${f}.spec.ts`), f).toMatch(/portOf\(info\.project\.use\.baseURL\)/);
    expect(read("apps/web/e2e/sessions.ts")).not.toMatch(/process\.env\.E2E_PORT/);
  });
  it("job e2e của ci.yml chạy playwright test KHÔNG ghim --project (nên chạy cả hai)", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/run: pnpm --filter web exec playwright test\s*$/m);
  });
  it("job e2e-repeat chạy cả hai project với --repeat-each=3", () => {
    expect(jobs["e2e-repeat"]).toMatch(
      /playwright test smoke --repeat-each=3 --project=mobile --project=desktop/,
    );
  });
});

describe("FE-TEST-003 — test tất định", () => {
  it("vitest.config ghim TZ=UTC và LANG cho cả project unit và db", () => {
    const cfg = read("vitest.config.ts");
    expect(cfg).toMatch(/TZ:\s*"UTC"/);
    expect(cfg).toMatch(/LANG:/);
    expect(cfg.match(/env:\s*DETERMINISTIC_ENV/g)).toHaveLength(2);
  });
  it("test đang chạy thật sự ở UTC (cấu hình có hiệu lực, kể cả khi máy đặt TZ khác)", () => {
    expect(process.env.TZ).toBe("UTC");
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(0);
    expect(new Date(2026, 9, 18, 7, 0).toISOString()).toBe("2026-10-18T07:00:00.000Z");
  });
  it("playwright ghim locale vi-VN và timezoneId", () => {
    const cfg = read("apps/web/playwright.config.ts");
    expect(cfg).toMatch(/locale:\s*"vi-VN"/);
    expect(cfg).toMatch(/timezoneId:\s*"UTC"/);
  });
  it("CI chạy unit 3 lần ở múi giờ khác UTC", () => {
    expect(jobs["unit-deterministic"]).toMatch(/for i in 1 2 3/);
    expect(jobs["unit-deterministic"]).toMatch(/TZ=Asia\/Ho_Chi_Minh pnpm vitest run --project unit/);
  });
  it("có test dùng đồng hồ giả", () => {
    expect(read("apps/web/components/hotel/hold-countdown.test.tsx")).toContain("vi.useFakeTimers()");
  });
});

describe("FE-PERF-002 / PRF-WEB-005 — Lighthouse CI", () => {
  const rc = JSON.parse(read("lighthouserc.json")).ci;
  it("3 lần chạy, median, ≥ 3 URL, mobile", () => {
    expect(rc.collect.numberOfRuns).toBe(3);
    expect(rc.collect.url.length).toBeGreaterThanOrEqual(3);
    expect(rc.collect.settings.formFactor).toBe("mobile");
  });
  it("assert mức error: Performance ≥ 0,9, LCP ≤ 2500, CLS ≤ 0,1; mọi assert có aggregationMethod median (trừ unsized-images)", () => {
    const a = rc.assert.assertions;
    expect(a["categories:performance"]).toEqual(["error", { minScore: 0.9, aggregationMethod: "median" }]);
    expect(a["largest-contentful-paint"][0]).toBe("error");
    expect(a["largest-contentful-paint"][1].maxNumericValue).toBeLessThanOrEqual(2500);
    expect(a["cumulative-layout-shift"][1].maxNumericValue).toBeLessThanOrEqual(0.1);
    expect(a["total-blocking-time"]).toBeDefined();
    for (const [k, v] of Object.entries(a))
      if (k !== "unsized-images") expect(v[1].aggregationMethod).toBe("median");
  });
  it("job lighthouse chạy lhci autorun (đỏ khi vi phạm), không continue-on-error", () => {
    expect(jobs.lighthouse).toMatch(/@lhci\/cli@0\.15\.1 autorun/);
    expect(workflow).not.toMatch(/continue-on-error/);
  });
});

describe("FE-PERF-004 / XC-GREEN-002 — ngân sách bundle", () => {
  const limits = JSON.parse(read(".size-limit.json"));
  it(".size-limit.json có mục gzip với limit và trỏ tới đầu ra build của apps/web", () => {
    expect(limits.length).toBeGreaterThan(0);
    for (const e of limits) {
      expect(e.gzip).toBe(true);
      expect(e.limit).toMatch(/^\d+(\.\d+)? kB$/);
      expect(e.path).toContain("apps/web/.next/");
    }
  });
  it("docs/PERF-BUDGET.md ghi số đo và lý do cho ngưỡng", () => {
    const doc = read("docs/PERF-BUDGET.md");
    expect(doc).toMatch(/Lý do chọn ngưỡng/);
    for (const e of limits) expect(doc).toContain(e.limit.replace(" ", " "));
  });
  it("job bundle-size build rồi chạy size-limit, sau typecheck + lint", () => {
    expect(jobs["build-size"]).toMatch(/run: pnpm build/);
    expect(jobs["build-size"]).toMatch(/run: pnpm size/);
    expect(needsOf(jobs["build-size"]).sort()).toEqual(["lint", "typecheck"]);
    expect(JSON.parse(read("package.json")).scripts.size).toBe("size-limit");
  });
});

describe("FE-BUILD-003 / FE-BUILD-004 — build nghiêm, lint 0 cảnh báo", () => {
  /** Mọi tệp nguồn cấu hình dưới `dir` (không vào node_modules/.next). */
  const configFiles = (dir, out = []) => {
    for (const n of readdirSync(join(ROOT, dir))) {
      if (["node_modules", ".next", ".git", ".xtemplates", ".autopilot"].includes(n)) continue;
      const rel = join(dir, n);
      if (statSync(join(ROOT, rel)).isDirectory()) configFiles(rel, out);
      else if (/(^|\/)(next\.config\.[cm]?[jt]s|tsconfig[\w.-]*\.json)$/.test(rel)) out.push(rel);
    }
    return out;
  };
  const files = configFiles(".");
  it("không `ignoreBuildErrors`/`ignoreDuringBuilds` ở cấu hình nào", () => {
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) expect(read(f), f).not.toMatch(/ignoreBuildErrors|ignoreDuringBuilds/);
  });
  it("skipLibCheck chỉ ở tsconfig.base.json, kèm lý do, và repo không có .d.ts tự viết", () => {
    const withSkip = files.filter((f) => /skipLibCheck/.test(read(f)));
    expect(withSkip).toEqual(["tsconfig.base.json"]);
    const base = read("tsconfig.base.json");
    expect(base).toMatch(/Lý do skipLibCheck/);
    const dts = [];
    const walk = (d) => {
      for (const n of readdirSync(join(ROOT, d))) {
        if (["node_modules", ".next", ".git", ".xtemplates", ".autopilot"].includes(n)) continue;
        const rel = join(d, n);
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (n.endsWith(".d.ts") && n !== "next-env.d.ts") dts.push(rel);
      }
    };
    walk(".");
    expect(dts).toEqual([]);
  });
  it("build chỉ chạy sau typecheck + lint (needs)", () => {
    expect(needsOf(jobs["build-size"])).toEqual(expect.arrayContaining(["typecheck", "lint"]));
    expect(needsOf(jobs.lighthouse)).toEqual(expect.arrayContaining(["typecheck", "lint"]));
  });
  it("lint = biome ci --error-on-warnings (một cấu hình biome.json), job fe-lint chạy pnpm lint", () => {
    expect(JSON.parse(read("package.json")).scripts.lint).toBe("biome ci . --error-on-warnings");
    expect(jobs.lint).toMatch(/run: pnpm lint/);
    expect(existsSync(join(ROOT, "biome.json"))).toBe(true);
  });
  it("pre-commit một cơ chế (D-066c): .githooks/pre-commit chạy biome trên file đã stage với cùng cờ; không .husky", () => {
    const hook = read(".githooks/pre-commit");
    expect(hook).toMatch(/biome" check --staged/);
    expect(hook).toMatch(/--error-on-warnings/);
    expect(existsSync(join(ROOT, ".husky"))).toBe(false);
    expect(JSON.parse(read("package.json")).scripts["hooks:install"]).toBeUndefined();
    expect(JSON.parse(read("package.json")).scripts.prepare).toContain("install-git-hooks.mjs");
    expect(statSync(join(ROOT, ".githooks/pre-commit")).mode & 0o111).not.toBe(0);
  });
  it("biome ghim phiên bản đúng một nơi (lockfile)", () => {
    expect(JSON.parse(read("package.json")).devDependencies["@biomejs/biome"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("FE-TEST-006 — job regression", () => {
  it("fetch-depth 0, kiểm PR fix chạm file test, chạy test component", () => {
    expect(jobs.regression).toMatch(/fetch-depth: 0/);
    expect(jobs.regression).toMatch(/node scripts\/check-fix-has-test\.mjs/);
    expect(jobs.regression).toMatch(/pnpm vitest run --project unit apps\/web\/components/);
  });
});
