// T-608: rào máy cho hiệu năng — kịch bản k6, cấu hình Lighthouse CI, ngân sách trang, baseline và tài liệu phải hợp lệ và KHỚP nhau
// (XC-PERF-004, XC-GREEN-001, QA-PERF-002/006/007/010, FE-PERF-002/018, QA-PERF-015). Không chạy k6/lhci (không có trong container):
// kiểm cấu trúc/ngưỡng/an toàn mục tiêu; số đo thật nằm ở docs/perf/baseline-*.json.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const K6_DIR = "perf/k6";
const HOT_FLOWS = ["login-select-org.js", "room-list.js", "create-hold.js", "collect-cash.js"];
const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, "");

/** Nạp lib.js (ESM của k6, import "k6/http") trong Node bằng cách cắt import/export và giả lập `__ENV`/`http`. */
function loadLib(env = {}) {
  const src = read(`${K6_DIR}/lib.js`)
    .replace(/^import .*$/m, "")
    .replace(/^export /gm, "");
  const factory = new Function(
    "__ENV",
    "http",
    `${src}\nreturn { assertSafeTarget, scenarios, thresholds, uuidv4, commandHeaders, dateOffset, requireEnv, LIMITS, BASE_URL };`,
  );
  return factory(env, { post: () => ({}) });
}

const doc = read("docs/perf/README.md");
const docThresholds = JSON.parse(/```json perf-thresholds\n([\s\S]*?)\n```/.exec(doc)?.[1] ?? "null");
const lhrc = json("lighthouserc.json");
const budgets = json("perf/budgets.json");
const baselines = readdirSync(join(ROOT, "docs/perf"))
  .filter((n) => /^baseline-.*\.json$/.test(n))
  .map((n) => ({ name: n, data: json(`docs/perf/${n}`) }));

describe("perf: kịch bản k6 — luồng nóng, ngưỡng theo phân vị, an toàn mục tiêu", () => {
  const files = readdirSync(join(ROOT, K6_DIR)).filter((n) => n.endsWith(".js") && n !== "lib.js");

  it("đủ 4 luồng nóng (đăng nhập→chọn tổ chức, danh sách phòng, tạo giữ phòng, thu tiền), không thừa kịch bản chưa tài liệu hoá", () => {
    expect(files.sort()).toEqual([...HOT_FLOWS].sort());
    for (const f of files) expect(doc, `docs/perf/README.md thiếu ${f}`).toContain(f);
  });

  it.each([...HOT_FLOWS, "lib.js"])("%s có cú pháp ESM hợp lệ", (f) => {
    const r = spawnSync(process.execPath, ["--check", join(ROOT, K6_DIR, f)], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it.each(HOT_FLOWS)(
    "%s: dùng lib, setup chặn mục tiêu lạ, có thresholds, không URL cứng, không avg<",
    (f) => {
      const src = read(`${K6_DIR}/${f}`);
      const code = stripComments(src);
      expect(code).toMatch(/from "\.\/lib\.js"/);
      expect(code).toMatch(/export function setup\(\) \{\s*assertSafeTarget\(\);/); // QA-PERF-007
      expect(code).toMatch(/export const options = \{[\s\S]*thresholds/);
      expect(code).toMatch(/scenarios\("\w+"\)/);
      expect(code).not.toMatch(/https?:\/\//); // BASE_URL chỉ từ môi trường
      expect(code).not.toMatch(/\bavg\s*[<>]/); // XC-PERF-004
      // Hàm thực thi khai trong scenario phải được export.
      const exec = /scenarios\("(\w+)"\)/.exec(code)?.[1];
      expect(code, `${f}: thiếu export function ${exec}`).toMatch(new RegExp(`export function ${exec}\\(`));
      expect(src).toMatch(/__ENV|requireEnv/);
    },
  );

  it("lib.js không dùng avg< và khai báo ngưỡng p(95), p(99), tỷ lệ lỗi, checks", () => {
    const lib = stripComments(read(`${K6_DIR}/lib.js`));
    expect(lib).not.toMatch(/\bavg\s*[<>]/);
    const { thresholds, LIMITS } = loadLib();
    const t = thresholds("x");
    expect(Object.keys(t).sort()).toEqual(["checks", "http_req_duration{name:x}", "http_req_failed"].sort());
    expect(t["http_req_duration{name:x}"]).toEqual([`p(95)<${LIMITS.apiP95Ms}`, `p(99)<${LIMITS.apiP99Ms}`]);
    expect(t.http_req_failed[0]).toMatchObject({ threshold: "rate<0.01", abortOnFail: true });
    const hold = thresholds("h", LIMITS.holdP95Ms, LIMITS.holdP99Ms)["http_req_duration{name:h}"];
    expect(hold).toEqual(["p(95)<1500", "p(99)<3000"]);
  });

  it("giữ phòng dùng ngưỡng riêng 1,5 s, các luồng còn lại dùng ngưỡng API", () => {
    const hold = stripComments(read(`${K6_DIR}/create-hold.js`));
    expect(hold).toMatch(/thresholds\("reservation-hold", LIMITS\.holdP95Ms, LIMITS\.holdP99Ms\)/);
    for (const f of HOT_FLOWS.filter((x) => x !== "create-hold.js"))
      expect(stripComments(read(`${K6_DIR}/${f}`))).not.toMatch(/holdP95Ms/);
  });

  it("mọi nhãn `name` dùng trong ngưỡng có request mang đúng nhãn đó (ngưỡng không treo vào hư không)", () => {
    for (const f of HOT_FLOWS) {
      const code = stripComments(read(`${K6_DIR}/${f}`));
      const tagged = [...code.matchAll(/thresholds\("([\w-]+)"/g)].map((m) => m[1]);
      expect(tagged.length, f).toBeGreaterThan(0);
      for (const tag of tagged)
        expect(
          code.split(`"${tag}"`).length - 1,
          `${f}: không request nào gắn name:${tag}`,
        ).toBeGreaterThanOrEqual(2);
    }
  });

  it("QA-PERF-007: BASE_URL thiếu/không hợp lệ/ngoài danh sách cho phép (kể cả mẹo userinfo, hậu tố) → ném lỗi; localhost → qua", () => {
    const bad = [
      "",
      "https://hotel-manager.vn",
      "https://app.example.com:443/x",
      "http://localhost.evil.com",
      ["http://127.0.0.1", "evil.com/"].join("\u0040"),
      "http://evil.com/localhost",
      "ftp://localhost",
      "localhost:3100",
      "http://[::2]:3100",
    ];
    for (const b of bad)
      expect(() => loadLib({ BASE_URL: b }).assertSafeTarget(), JSON.stringify(b)).toThrow();
    for (const ok of [
      "http://localhost:3100",
      "http://127.0.0.1:3100/",
      "http://[::1]:3100",
      "http://localhost",
    ])
      expect(() => loadLib({ BASE_URL: ok }).assertSafeTarget(), ok).not.toThrow();
    // Staging phải được thêm có chủ đích.
    const staging = { BASE_URL: "https://staging.hm.example.vn", K6_ALLOWED_HOSTS: "staging.hm.example.vn" };
    expect(() => loadLib(staging).assertSafeTarget()).not.toThrow();
    expect(() => loadLib({ ...staging, K6_ALLOWED_HOSTS: "localhost" }).assertSafeTarget()).toThrow(
      /production/,
    );
  });

  it("scenario theo K6_PROFILE: smoke (mặc định), load (ramping-vus tới K6_VUS), spike (ramping-arrival-rate)", () => {
    const s = (env) => loadLib(env).scenarios("run").run;
    expect(s({})).toMatchObject({ executor: "constant-vus", vus: 1, duration: "30s", exec: "run" });
    const load = s({ K6_PROFILE: "load", K6_VUS: "200" });
    expect(load.executor).toBe("ramping-vus");
    expect(Math.max(...load.stages.map((x) => x.target))).toBe(200);
    expect(load.stages.at(-1).target).toBe(0);
    expect(s({ K6_PROFILE: "load", K6_VUS: "0" }).stages[0].target).toBeGreaterThanOrEqual(1); // biên 0
    expect(s({ K6_PROFILE: "spike" }).executor).toBe("ramping-arrival-rate");
    expect(s({ K6_PROFILE: "khong-co" }).executor).toBe("constant-vus"); // lạ → smoke an toàn
  });

  it("lệnh ghi có Idempotency-Key UUID v4 mới mỗi lần, Origin cùng nguồn, cookie/tổ chức từ môi trường", () => {
    const lib = loadLib({ BASE_URL: "http://127.0.0.1:3100", K6_COOKIE: "a=b", ORG_ID: "org-1" });
    const a = lib.commandHeaders();
    const b = lib.commandHeaders();
    expect(a["idempotency-key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(a["idempotency-key"]).not.toBe(b["idempotency-key"]);
    expect(a).toMatchObject({ origin: "http://127.0.0.1:3100", cookie: "a=b", "x-org-id": "org-1" });
    expect(Object.keys(loadLib({ BASE_URL: "http://localhost" }).commandHeaders())).not.toContain("cookie");
    expect(lib.dateOffset(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(() => lib.requireEnv("KHONG_CO")).toThrow(/KHONG_CO/);
  });

  it("lệnh/đường dẫn trong kịch bản có thật trong registry (không gọi lệnh đã đổi tên)", () => {
    const registry = read("packages/app/src/http/registry.ts");
    const paths = new Set();
    for (const f of HOT_FLOWS)
      for (const m of read(`${K6_DIR}/${f}`).matchAll(/\/api\/v1\/([a-z]+)\/([A-Za-z]+)/g))
        paths.add(`${m[1]}.${m[2]}`);
    const NON_REGISTRY = new Set(["session.switchOrganization"]);
    expect(paths.size).toBeGreaterThanOrEqual(5);
    for (const p of paths)
      if (!NON_REGISTRY.has(p) && !p.startsWith("auth."))
        expect(registry, `registry thiếu ${p}`).toContain(`"${p}": `);
  });
});

describe("perf: Lighthouse CI — ngưỡng theo hồ sơ web-app, không tắt throttle, không nới", () => {
  const a = lhrc.ci.assert.assertions;

  it("3 URL, numberOfRuns 5, mobile, trung vị, lưu cục bộ (không đẩy dữ liệu ra ngoài)", () => {
    expect(lhrc.ci.collect.numberOfRuns).toBe(5);
    expect(lhrc.ci.collect.url.length).toBeGreaterThanOrEqual(3);
    expect(new Set(lhrc.ci.collect.url).size).toBe(lhrc.ci.collect.url.length);
    expect(lhrc.ci.collect.settings.formFactor).toBe("mobile");
    expect(lhrc.ci.upload.target).toBe("filesystem");
    for (const u of lhrc.ci.collect.url) expect(u).toMatch(/^http:\/\/127\.0\.0\.1:3100\//);
  });

  it("FE-PERF-018: không tắt/ghi đè throttling (throttlingMethod chỉ được là `simulate` — mặc định của lhci)", () => {
    const settings = lhrc.ci.collect.settings;
    expect(settings.throttlingMethod).toBe("simulate");
    const { throttlingMethod: _kept, ...rest } = settings;
    const text = JSON.stringify({
      ...lhrc,
      ci: { ...lhrc.ci, collect: { ...lhrc.ci.collect, settings: rest } },
    });
    expect(text).not.toMatch(
      /throttlingMethod|disableThrottling|"throttling"|cpuSlowdownMultiplier|screenEmulation|preset/i,
    );
  });

  it("FE-PERF-002: Performance ≥ 0,9, LCP ≤ 2.500 ms, CLS ≤ 0,1 là `error`, lấy median; A11y ≥ 0,9 (STD-A11Y-010)", () => {
    expect(a["categories:performance"]).toEqual(["error", { minScore: 0.9, aggregationMethod: "median" }]);
    expect(a["categories:accessibility"]).toEqual(["error", { minScore: 0.9, aggregationMethod: "median" }]);
    expect(a["largest-contentful-paint"]).toEqual([
      "error",
      { maxNumericValue: 2500, aggregationMethod: "median" },
    ]);
    expect(a["cumulative-layout-shift"]).toEqual([
      "error",
      { maxNumericValue: 0.1, aggregationMethod: "median" },
    ]);
    expect(a["unsized-images"][0]).toBe("error");
  });

  it("QA-PERF-015: TBT/best-practices/SEO ở `warn` (có kế hoạch siết trong tài liệu); mọi assertion có mức hợp lệ", () => {
    for (const k of ["total-blocking-time", "categories:best-practices", "categories:seo"])
      expect(a[k][0], k).toBe("warn");
    for (const [k, v] of Object.entries(a)) expect(["error", "warn"], k).toContain(v[0]);
    expect(doc).toMatch(/siết `error`[^.]*2026-12-31/);
  });

  it("khớp tài liệu (khối perf-thresholds) và baseline-lighthouse.json", () => {
    const t = docThresholds.lighthouse;
    expect(a["categories:performance"][1].minScore).toBe(t.performance);
    expect(a["categories:accessibility"][1].minScore).toBe(t.accessibility);
    expect(a["largest-contentful-paint"][1].maxNumericValue).toBe(t.lcp_ms);
    expect(a["cumulative-layout-shift"][1].maxNumericValue).toBe(t.cls);
    expect(a["total-blocking-time"][1].maxNumericValue).toBe(t.tbt_ms);
    expect(lhrc.ci.collect.numberOfRuns).toBe(t.runs);
    const targets = baselines.find((b) => b.name === "baseline-lighthouse.json").data.targets;
    expect(targets).toMatchObject({
      performance_min_score: t.performance,
      accessibility_min_score: t.accessibility,
      lcp_ms_max: t.lcp_ms,
      cls_max: t.cls,
      tbt_ms_max: t.tbt_ms,
      runs: t.runs,
    });
  });

  it("URL Lighthouse là route có thật và công khai (không cần đăng nhập)", () => {
    for (const u of lhrc.ci.collect.url) {
      const route = new URL(u).pathname;
      expect(existsSync(join(ROOT, `apps/web/app${route}/page.tsx`)), route).toBe(true);
    }
  });
});

describe("perf: ngưỡng k6 khớp tài liệu, SLO và PROJECT.md", () => {
  it("LIMITS trong lib.js = khối perf-thresholds = baseline-k6.json", () => {
    const { LIMITS } = loadLib();
    expect(LIMITS).toMatchObject({
      apiP95Ms: docThresholds.api_p95_ms,
      apiP99Ms: docThresholds.api_p99_ms,
      holdP95Ms: docThresholds.hold_p95_ms,
      holdP99Ms: docThresholds.hold_p99_ms,
      failRate: docThresholds.http_req_failed_rate,
    });
    const targets = baselines.find((b) => b.name === "baseline-k6.json").data.targets;
    expect(targets).toMatchObject({
      api_p95_ms: docThresholds.api_p95_ms,
      api_p99_ms: docThresholds.api_p99_ms,
      hold_p95_ms: docThresholds.hold_p95_ms,
      hold_p99_ms: docThresholds.hold_p99_ms,
      http_req_failed_rate: docThresholds.http_req_failed_rate,
    });
    expect(docThresholds.api_p95_ms).toBeLessThan(docThresholds.api_p99_ms);
    expect(docThresholds.hold_p95_ms).toBeLessThan(docThresholds.hold_p99_ms);
  });

  it("p95 ≤ ngưỡng ở PROJECT.md §5 và docs/ops/SLO.md (800 ms API, 1,5 s giữ phòng)", () => {
    const project = read("PROJECT.md");
    const slo = read("docs/ops/SLO.md");
    expect(project).toMatch(/API thường p95 < 800 ms/);
    expect(project).toMatch(/tạo giữ phòng p95 < 1,5 s/);
    expect(slo).toMatch(/≤ 800 ms/);
    expect(slo).toMatch(/≤ 1,5 s/);
    expect(docThresholds.api_p95_ms).toBe(800);
    expect(docThresholds.hold_p95_ms).toBe(1500);
  });
});

describe("perf: ngân sách trang + baseline (XC-GREEN-001, QA-PERF-006)", () => {
  it("mọi ngân sách là số nguyên dương; route có trang thật; spec E2E đọc đúng file và chỉ ghi khi PERF_BASELINE_OUT", () => {
    const routes = Object.keys(budgets.pages);
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const [route, b] of Object.entries(budgets.pages)) {
      expect(Number.isInteger(b.max_transfer_kb) && b.max_transfer_kb > 0, route).toBe(true);
      expect(Number.isInteger(b.max_requests) && b.max_requests > 0, route).toBe(true);
      expect(existsSync(join(ROOT, `apps/web/app${route}/page.tsx`)), route).toBe(true);
    }
    const spec = read("apps/web/e2e/perf-baseline.spec.ts");
    expect(spec).toContain("perf/budgets.json");
    expect(spec).toMatch(/process\.env\.PERF_BASELINE_OUT/);
    expect(spec).toMatch(/test\.skip\(!OUT/);
    for (const route of routes) expect(spec, route).toMatch(new RegExp(`"${route}"`));
  });

  it("có baseline web đã đo và hai baseline chưa đo ghi rõ lý do", () => {
    expect(baselines.map((b) => b.name).sort()).toEqual(
      ["baseline-k6.json", "baseline-lighthouse.json", "baseline-web-2026-10-17.json"].sort(),
    );
  });

  for (const b of baselines) {
    it(`${b.name}: hợp lệ theo trạng thái measured`, () => {
      const d = b.data;
      expect(d.schema).toBe(1);
      expect(typeof d.measured).toBe("boolean");
      if (!d.measured) {
        // Chưa đo: không được có số liệu bịa; phải nói lý do.
        expect(d.reason.length).toBeGreaterThan(30);
        expect(d.reason).toMatch(/chưa đo/);
        expect(d.date).toBeNull();
        expect(d.commit).toBeNull();
        expect(d.results).toBeNull();
        return;
      }
      // Đã đo: đủ 5 trường điều kiện (QA-PERF-006) và số hợp lệ.
      expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d.commit).toMatch(/^[0-9a-f]{7,40}\b/);
      expect(d.environment.description.length).toBeGreaterThan(20);
      expect(d.environment.os).toBeTruthy();
      expect(d.device.browser).toBeTruthy();
      expect(d.device.network).toBeTruthy();
      expect(d.api.vus).toBeGreaterThanOrEqual(1);
      expect(d.api.duration_s).toBeGreaterThan(0);
      expect(d.api.samples).toBeGreaterThanOrEqual(100);
      expect(d.api.failed).toBe(0);
      // Phân vị (XC-PERF-004): đơn điệu và dương, không có trung bình thay thế.
      expect(d.api.p50_ms).toBeGreaterThan(0);
      expect(d.api.p95_ms).toBeGreaterThanOrEqual(d.api.p50_ms);
      expect(d.api.p99_ms).toBeGreaterThanOrEqual(d.api.p95_ms);
      expect(JSON.stringify(d)).not.toMatch(/"avg|"mean/);
      // Trọng lượng + số request các màn chính (XC-GREEN-001) phủ đúng các route có ngân sách và nằm trong ngân sách.
      expect(d.pages.map((p) => p.route).sort()).toEqual(Object.keys(budgets.pages).sort());
      for (const p of d.pages) {
        expect(p.transfer_kb, p.route).toBeGreaterThan(0);
        expect(p.requests, p.route).toBeGreaterThan(0);
        expect(p.js_kb, p.route).toBeLessThanOrEqual(p.transfer_kb);
        expect(p.transfer_kb, `${p.route}: vượt ngân sách KB`).toBeLessThanOrEqual(
          budgets.pages[p.route].max_transfer_kb,
        );
        expect(p.requests, `${p.route}: vượt ngân sách request`).toBeLessThanOrEqual(
          budgets.pages[p.route].max_requests,
        );
      }
      // Backend: CPU/RAM theo 1.000 yêu cầu; kWh chưa đo thì phải nói thẳng, không điền số.
      expect(d.backend.requests).toBe(1000);
      expect(d.backend.cpu_ms_per_1000_requests).toBeGreaterThan(0);
      expect(d.backend.rss_mb_after).toBeGreaterThan(0);
      expect(d.backend.kwh_per_1000_requests === null ? d.backend.kwh_note : "ok").toMatch(/chưa đo|ok/);
    });
  }

  it("GO-NO-GO.md có mục số đo hiệu năng với đủ 5 trường cho từng số, số chưa đo ghi rõ (QA-PERF-006)", () => {
    const go = read("GO-NO-GO.md");
    const sec = /## 2b\. Số đo hiệu năng[\s\S]*?(?=\n## )/.exec(go)?.[0] ?? "";
    expect(sec).not.toBe("");
    const rows = sec.split("\n").filter((l) => l.startsWith("|") && !/^\|[-| ]+\|$/.test(l));
    const [header, ...body] = rows.map((l) =>
      l
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
    expect(header).toEqual([
      "Số đo",
      "Kết quả",
      "Commit",
      "Môi trường",
      "Thiết bị/mạng",
      "VU/thời lượng",
      "Ngày",
    ]);
    expect(body.length).toBeGreaterThanOrEqual(5);
    const web = baselines.find((b) => b.name === "baseline-web-2026-10-17.json").data;
    for (const r of body) {
      expect(
        r.every((c) => c.length > 0),
        r[0],
      ).toBe(true);
      if (/chưa đo/.test(r[1])) continue;
      expect(r[2], r[0]).toContain(web.commit.split(" ")[0]);
      expect(r[6], r[0]).toBe(web.date);
    }
    // Các số p50/p95/p99 trong GO-NO-GO khớp baseline (làm tròn 0,1 ms).
    const f = (n) => String(Math.round(n * 10) / 10).replace(".", ",");
    expect(sec).toContain(`p50 ${f(web.api.p50_ms)} ms`);
    expect(sec).toContain(`p95 ${f(web.api.p95_ms)} ms`);
    expect(sec).toContain(`p99 ${f(web.api.p99_ms)} ms`);
  });

  it("đợt 9 (D-059, chủ dự án duyệt 2026-10-17): lhci chỉ chạy trong job `lighthouse`; k6 chưa có workflow (cần staging)", () => {
    for (const n of readdirSync(join(ROOT, ".github/workflows"))) {
      const text = read(`.github/workflows/${n}`);
      expect(text, n).not.toMatch(/\bk6 run\b/i);
      if (n !== "frontend-quality.yml") expect(text, n).not.toMatch(/lhci|lighthouse-ci/i);
    }
    expect(read(".github/workflows/frontend-quality.yml")).toMatch(/^ {2}lighthouse:\n/m);
    expect(doc).toMatch(/## 5\. Job CI/);
  });
});
