// T-804: khoá cấu hình chất lượng frontend (FE-TEST-002/003, FE-PERF-002/004, PRF-WEB-006, XC-GREEN-002, UX-RESP-008,
// FE-BUILD-003/004). Phần chỉ chứng minh được khi job CI chạy → test cấu trúc đọc file cấu hình/workflow; mỗi luật có ca ĐỎ.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { authConfig } from "./lhci-auth-config.mjs";

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
    // Spec không rơi lặng lẽ về cổng mặc định khi quên gán PORT ở beforeAll: khởi tạo NaN, không đọc E2E_PORT.
    for (const f of ["hotel", "members", "rental", "invitation", "portal"])
      expect(read(`apps/web/e2e/${f}.spec.ts`), f).toMatch(/^let PORT = Number\.NaN;/m);
    for (const f of readdirSync(join(ROOT, "apps/web/e2e")).filter((n) => n.endsWith(".spec.ts")))
      expect(read(`apps/web/e2e/${f}`), f).not.toMatch(/process\.env\.E2E_PORT/);
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
  it("5 lần chạy (median loại run nhiễu), ≥ 5 URL chính gồm ≥ 2 trang sau đăng nhập (PRF-WEB-005), mobile", () => {
    expect(rc.collect.numberOfRuns).toBe(5);
    expect(rc.collect.url.length).toBeGreaterThanOrEqual(5);
    const paths = rc.collect.url.map((u) => new URL(u).pathname);
    const publicPaths = ["/dang-nhap", "/dang-nhap/nguoi-thue", "/offline"];
    expect(paths.filter((p) => !publicPaths.includes(p)).length).toBeGreaterThanOrEqual(2);
    // Trang sau đăng nhập đo trước: ghé trang đăng nhập làm phiên đo mất hiệu lực (các trang sau sẽ đo nhầm /dang-nhap).
    const firstPublic = paths.findIndex((p) => publicPaths.includes(p));
    expect(paths.slice(firstPublic).every((p) => publicPaths.includes(p))).toBe(true);
    // URL sau đăng nhập phải là trang có thật của app.
    for (const p of paths) expect(existsSync(join(ROOT, "apps/web/app", p, "page.tsx")), p).toBe(true);
    expect(rc.collect.settings.formFactor).toBe("mobile");
  });
  it("trang sau đăng nhập đo bằng phiên thật: job dựng server, lấy phiên, sinh config có Cookie rồi autorun với config đó", () => {
    const at = (needle) => jobs.lighthouse.indexOf(needle);
    expect(at("node e2e/server.ts")).toBeGreaterThan(-1);
    expect(at("node e2e/perf-session-env.ts")).toBeGreaterThan(at("node e2e/server.ts"));
    expect(at("node scripts/lhci-auth-config.mjs")).toBeGreaterThan(at("node e2e/perf-session-env.ts"));
    expect(jobs.lighthouse).toMatch(
      /pnpm exec lhci autorun --config="\$RUNNER_TEMP\/lighthouserc\.auth\.json"/,
    );
    const cfg = authConfig(JSON.parse(read("lighthouserc.json")), "a=1; b=2").ci;
    expect(cfg.collect.settings.extraHeaders).toEqual({ Cookie: "a=1; b=2" });
    expect(cfg.collect.startServerCommand).toBeUndefined();
    expect(cfg.collect.url).toEqual(rc.collect.url);
    expect(cfg.assert).toEqual(rc.assert); // không nới ngưỡng
    expect(() => authConfig(JSON.parse(read("lighthouserc.json")), "")).toThrow(/thiếu cookie/);
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
  it("ổn định, KHÔNG nới ngưỡng: throttle `simulate` (mặc định, ghi tường minh), --disable-dev-shm-usage, đợi dấu hiệu server chính", () => {
    expect(rc.collect.settings.throttlingMethod).toBe("simulate");
    expect(rc.collect.settings.chromeFlags).toContain("--disable-dev-shm-usage");
    expect(rc.collect.startServerReadyPattern).toBe("E2E_SERVER_READY");
    // Dấu hiệu do e2e/server.ts in SAU khi /api/health của server chính trả 200 (không phải "Ready in" của Next — bản sao cũng in).
    const server = read("apps/web/e2e/server.ts");
    expect(server).toContain('"E2E_SERVER_READY"');
    expect(server).toMatch(/\$\{BASE_URL\}\/api\/health/);
    expect(server).toMatch(/process\.env\.E2E_NO_REPLICA === "1"/);
    expect(jobs.lighthouse).toMatch(/E2E_NO_REPLICA: "1"/);
  });
  it("job lighthouse chạy lhci autorun (đỏ khi vi phạm), không continue-on-error; lhci 0.15.1 trong pnpm workspace gốc (MỘT lockfile)", () => {
    expect(jobs.lighthouse).toMatch(/pnpm install --frozen-lockfile/);
    expect(jobs.lighthouse).toMatch(/pnpm exec lhci autorun/);
    expect(jobs.lighthouse).not.toMatch(/npx|npm ci|tools\/lhci/);
    expect(workflow).not.toMatch(/continue-on-error/);
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.devDependencies["@lhci/cli"]).toBe("0.15.1");
    expect(read("pnpm-lock.yaml")).toMatch(/'?@lhci\/cli@0\.15\.1'?:/);
    expect(existsSync(join(ROOT, "tools/lhci/package.json"))).toBe(false);
    expect(existsSync(join(ROOT, "tools/lhci/package-lock.json"))).toBe(false);
  });
  it("FE-BUILD-001: đúng MỘT lockfile được commit (pnpm-lock.yaml) — không package-lock/yarn.lock ở đâu cả", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((f) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/.test(f));
    expect(tracked).toEqual(["pnpm-lock.yaml"]);
  });
  it("ngoại lệ giấy phép BSD của lhci: đúng parse-cache-control@1.0.1, có hạn, định danh D-068", () => {
    const policy = JSON.parse(read("license-policy.json"));
    expect(policy.exceptions).toHaveLength(1);
    const [ex] = policy.exceptions;
    expect(ex).toMatchObject({ package: "parse-cache-control", license: "BSD", expires: "2027-04-18" });
    expect(ex.reason).toContain("D-068");
    expect(ex.approved_by).toContain("D-068");
    expect(read("pnpm-lock.yaml")).toMatch(/parse-cache-control@1\.0\.1/);
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
    expect(JSON.parse(read("package.json")).scripts.lint).toBe("biome ci --error-on-warnings .");
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

describe("FE-TEST-006 — rào PR fix kèm test + job regression", () => {
  const tq = read(".github/workflows/test-quality.yml");
  it("rào PR fix nằm ở job fix-requires-test của test-quality.yml (T-805), chạy lại khi sửa tiêu đề PR (edited)", () => {
    expect(tq).toMatch(/types: \[opened, synchronize, reopened, edited\]/);
    expect(tq).toMatch(/fix-requires-test:\n {4}name: fix-requires-test/);
    expect(tq).toMatch(/TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
    expect(tq).toMatch(/node scripts\/fix-requires-test\.mjs --title "\$TITLE"/);
    expect(existsSync(join(ROOT, ".github/workflows/fix-has-test.yml"))).toBe(false); // không trùng lặp rào
  });
  it("job regression chạy test component + rào truy vấn; không chứa bước kiểm PR fix (đã tách sang test-quality.yml)", () => {
    expect(jobs.regression).toMatch(/pnpm vitest run --project unit apps\/web\/components/);
    expect(jobs.regression).not.toMatch(/fix-has-test|fix-requires-test/);
  });
});
