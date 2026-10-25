// Chất lượng bộ test — khoá cấu hình bằng máy (PLAN đợt 9 T-805): coverage có nhánh + ngưỡng ratchet (QA-COV-001/002/008),
// E2E bắt buộc theo tiêu chí (QA-E2E-005, QA-STRAT-008), PR fix: kèm test (QA-STRAT-005),
// lint 0 cảnh báo + kiểm format trong cổng (BASE-GATE-003), bộ lệnh chuẩn một nơi (XC-DX-002).
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareCoverageConfig,
  coverageCliOverrides,
  METRICS,
  parseCoverageConfig,
} from "./check-coverage-ratchet.mjs";
import { checkFixHasTest } from "./fix-requires-test.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const SELF = "scripts/test-quality.test.mjs";
// Fixture của rào khác (chuỗi mẫu chứa mã test/biome-ignore giả để thử bộ phân tích) — không phải test thật.
const FIXTURE_FILES = new Set([
  SELF,
  "scripts/test-assertions.test.mjs",
  "scripts/commented-code.mjs",
  "scripts/commented-code.test.mjs",
]);
const workflow = read(".github/workflows/test-quality.yml");
/** Thân một job (từ `  <id>:` tới job kế tiếp). */
const job = (id) => new RegExp(`^  ${id}:\\n((?:    .*\\n|\\n)*)`, "m").exec(workflow)?.[1] ?? "";
const vitestConfig = read("vitest.config.ts");

describe("QA-COV-001: coverage nhánh cho unit + db, lưu artifact", () => {
  it("vitest.config.ts: provider v8, reporter có json-summary + lcov (có số nhánh), include mã sản phẩm", () => {
    expect(vitestConfig).toMatch(/provider:\s*"v8"/);
    expect(vitestConfig).toMatch(/reporter:\s*\[[^\]]*"json-summary"[^\]]*"lcov"/);
    expect(vitestConfig).toMatch(/reportsDirectory:\s*"coverage"/);
    expect(vitestConfig).toMatch(/include:\s*\[[^\]]*packages\/\*\/src/s);
  });
  it("job coverage chạy vitest --coverage cho CẢ hai project (không lọc --project) và upload coverage/", () => {
    const body = job("coverage");
    expect(body).toMatch(/run: pnpm exec vitest run --coverage\s*$/m);
    expect(body).not.toMatch(/--project/);
    expect(body).toMatch(/TEST_DATABASE_URL:/);
    expect(body).toMatch(/upload-artifact@[0-9a-f]{40}/);
    expect(body).toMatch(/path: coverage\//);
    expect(body).toMatch(/if-no-files-found: error/);
  });
  it("job coverage cài binary PostgreSQL 17 (test TLS CSDL tự initdb) TRƯỚC bước vitest", () => {
    const body = job("coverage");
    const pg = body.indexOf("scripts/dev-env-setup.sh --only postgres");
    expect(pg).toBeGreaterThan(0);
    expect(pg).toBeLessThan(body.indexOf("vitest run --coverage"));
  });
  it("workflow chạy trên pull_request và push main; không continue-on-error", () => {
    // D-091 (harden): trigger workflow_dispatch thêm lúc hoãn (D-085) đã gỡ; giữ dạng tuỳ chọn để regex không phụ thuộc pha.
    expect(workflow).toMatch(
      /^on:\n {2}push:\n {4}branches: \[main\]\n(?: {2}workflow_dispatch: \{\}\n)? {2}pull_request:/m,
    );
    expect(workflow).not.toMatch(/continue-on-error/);
  });
  it("chạy trên MỌI PR vào main: không lọc `paths` cấp workflow; sửa tiêu đề/mô tả (edited) chạy lại", () => {
    const on = /^on:\n((?: {2}.*\n)+)/m.exec(workflow)?.[1] ?? "";
    expect(on).not.toMatch(/\bpaths(?:-ignore)?:/);
    expect(on).toMatch(/^ {4}branches: \[main\]$/m);
    expect(on).toMatch(/^ {4}types: \[opened, synchronize, reopened, edited\]$/m);
  });
  it("không job nào bị bỏ qua khi sửa tiêu đề/mô tả (AUD-CI-001): check-run `skipped` đến sau không được che lần chạy đỏ cùng SHA", () => {
    for (const name of ["coverage", "coverage-ratchet", "fix-requires-test"])
      expect(job(name), name).not.toMatch(/edited/);
  });
  it("edited có nhóm concurrency riêng — không huỷ coverage đang chạy của lần đẩy mã", () => {
    expect(workflow).toMatch(/^ {2}group: .*github\.event\.action == 'edited' && 'edited' \|\| 'code'/m);
  });
  it("thư mục coverage/ không bị commit", () => {
    expect(read(".gitignore")).toMatch(/^coverage\/$/m);
  });
});

describe("QA-COV-002: ngưỡng ratchet là số cho lines + branches (+ functions, statements)", () => {
  it("cả bốn ngưỡng có giá trị số dương", () => {
    for (const m of METRICS) {
      expect(typeof cfg.thresholds[m], m).toBe("number");
      expect(cfg.thresholds[m], m).toBeGreaterThan(0);
      expect(cfg.thresholds[m], m).toBeLessThanOrEqual(100);
    }
  });
  const cfg = parseCoverageConfig(vitestConfig);
  it("job coverage-ratchet chạy trên PR, so với nhánh gốc, nhận mô tả PR", () => {
    const body = job("coverage-ratchet");
    expect(workflow).toMatch(
      /coverage-ratchet:\n {4}name: coverage-ratchet\n {4}if: github.event_name == 'pull_request'/,
    );
    expect(body).toMatch(/check-coverage-ratchet\.mjs --base "origin\/\$BASE_REF" --body-file/);
    expect(body).toMatch(/git fetch --no-tags --depth=1 origin "\$BASE_REF"/);
  });

  const base = { thresholds: { lines: 90, branches: 80, functions: 90, statements: 90 }, exclude: ["a/**"] };
  it("bộ so sánh: giữ nguyên hoặc tăng → đạt (kể cả số thập phân)", () => {
    expect(compareCoverageConfig(base, base)).toEqual([]);
    expect(
      compareCoverageConfig(base, { ...base, thresholds: { ...base.thresholds, branches: 80.1 } }),
    ).toEqual([]);
  });
  it("bộ so sánh: hạ dù 0,1 điểm → đỏ, kể cả khi mô tả PR xin miễn trừ", () => {
    const lower = { ...base, thresholds: { ...base.thresholds, lines: 89.9 } };
    expect(compareCoverageConfig(base, lower, "Coverage-config: hạ vì lý do nào đó dài")).toHaveLength(1);
  });
  it("bộ so sánh: xoá ngưỡng (undefined, không phải 0) → đỏ", () => {
    const { branches: _drop, ...rest } = base.thresholds;
    const out = compareCoverageConfig(base, { ...base, thresholds: rest });
    expect(out.join("\n")).toMatch(/branches bị xoá/);
  });
  it("bộ so sánh: nền chưa có ngưỡng → chỉ đòi bản mới có đủ bốn ngưỡng", () => {
    expect(compareCoverageConfig({ thresholds: {}, exclude: [] }, { ...base, exclude: [] })).toEqual([]);
    expect(
      compareCoverageConfig({ thresholds: {}, exclude: [] }, { thresholds: {}, exclude: [] }),
    ).toHaveLength(4);
  });
  it("bộ so sánh: ngưỡng 0 là số hợp lệ nhưng không hạ được từ số dương", () => {
    expect(
      compareCoverageConfig(base, { ...base, thresholds: { ...base.thresholds, lines: 0 } }),
    ).toHaveLength(1);
  });
  it("parseCoverageConfig đọc đúng thresholds/exclude/include, bỏ qua `exclude` ngoài khối coverage", () => {
    const src = `export default { test: { exclude: ["x"], coverage: { include: ["i/**"], exclude: ["a", 'b', \`c\`], thresholds: { lines: 1.5, branches: 2 } } } }`;
    expect(parseCoverageConfig(src)).toEqual({
      thresholds: { lines: 1.5, branches: 2 },
      exclude: ["a", "b", "c"],
      include: ["i/**"],
      invalid: [],
    });
    expect(parseCoverageConfig("export default {}")).toEqual({
      thresholds: {},
      exclude: [],
      include: [],
      invalid: [],
    });
  });
  it("parseCoverageConfig: ngoặc/dấu phẩy trong chuỗi glob và mã bị comment-out không làm lệch kết quả", () => {
    const src = [
      "export default { test: { coverage: {",
      "  // thresholds: { lines: 1 },",
      '  exclude: ["a/[x]/**", "b,c/**"], /* exclude: ["z"] */',
      "  thresholds: { lines: 90, branches: 80 },",
      "} } }",
    ].join("\n");
    expect(parseCoverageConfig(src)).toEqual({
      thresholds: { lines: 90, branches: 80 },
      exclude: ["a/[x]/**", "b,c/**"],
      include: [],
      invalid: [],
    });
  });
});

describe("QA-COV-008: không sửa cấu hình coverage để cho xanh", () => {
  const base = { thresholds: { lines: 1, branches: 1, functions: 1, statements: 1 }, exclude: ["a/**"] };
  it("thêm exclude mới mà không có lý do → đỏ; có `Coverage-config: <lý do>` → đạt", () => {
    const head = { ...base, exclude: ["a/**", "b/**"] };
    expect(compareCoverageConfig(base, head)).toHaveLength(1);
    expect(
      compareCoverageConfig(base, head, "Coverage-config: b/** là mã sinh tự động, không có logic"),
    ).toEqual([]);
    expect(compareCoverageConfig(base, head, "Coverage-config: ngắn")).toHaveLength(1);
  });
  it("bớt exclude (đo rộng hơn) → đạt", () => {
    expect(compareCoverageConfig(base, { ...base, exclude: [] })).toEqual([]);
  });
  const mk = (extra = "") =>
    `export default { test: { coverage: { include: ["a/**", "b/**"], exclude: ["x/**"], thresholds: { lines: 90, branches: 80, functions: 90, statements: 90 }${extra} } } }`;
  const cmp = (headSrc, body = "") =>
    compareCoverageConfig(parseCoverageConfig(mk()), parseCoverageConfig(headSrc), body);
  it("nền chuẩn so với chính nó → đạt (kiểm bộ dựng mẫu cho 3 ca qua mặt bên dưới)", () => {
    expect(cmp(mk())).toEqual([]);
  });
  it("qua mặt 1: bỏ bớt `include` (thu hẹp phạm vi đo) → đỏ, kể cả có `Coverage-config:`; thêm include → đạt", () => {
    const narrowed = mk().replace('include: ["a/**", "b/**"]', 'include: ["a/**"]');
    expect(cmp(narrowed).join("\n")).toMatch(/include bị thu hẹp \(bỏ b\/\*\*\)/);
    expect(cmp(narrowed, "Coverage-config: gỡ b vì lý do dài đủ dùng")).toHaveLength(1);
    expect(cmp(mk().replace('"b/**"]', '"b/**", "c/**"]'))).toEqual([]);
    const noInclude = mk().replace('include: ["a/**", "b/**"], ', "");
    expect(cmp(noInclude).join("\n")).toMatch(/include bị thu hẹp/);
  });
  it("qua mặt 2: ngưỡng không phải số literal (`94.8 - 90`, biến, ép kiểu) → đỏ", () => {
    for (const expr of ["90 - 90", "90 * 0", "Number('1')", "LIMIT", "-1 + 91"]) {
      const out = cmp(mk().replace("lines: 90", `lines: ${expr}`));
      expect(out.join("\n"), expr).toMatch(/không phải giá trị literal.*ngưỡng lines/);
      expect(out.join("\n"), expr).not.toMatch(/bị xoá|thiếu ngưỡng lines/);
    }
    expect(cmp(mk().replace("lines: 90", "lines: 90.5"))).toEqual([]);
    expect(cmp(mk().replace("lines: 90,", "// lines: 1,\n lines: 90,"))).toEqual([]);
  });
  it("qua mặt 3: exclude viết bằng backtick / nối chuỗi / spread không được lọt khỏi so sánh", () => {
    const withBacktick = mk().replace('exclude: ["x/**"]', 'exclude: ["x/**", `y/**`]');
    expect(cmp(withBacktick).join("\n")).toMatch(/exclude có mục mới \(y\/\*\*\)/);
    expect(cmp(withBacktick, "Coverage-config: y là mã sinh tự động, không logic")).toEqual([]);
    for (const el of ["`y/\x24{dir}/**`", '"y/" + "**"', "...EXTRA", "EXCLUDED"]) {
      const out = cmp(mk().replace('exclude: ["x/**"]', `exclude: ["x/**", ${el}]`));
      expect(out.join("\n"), el).toMatch(/không phải giá trị literal.*exclude: /);
    }
    expect(cmp(mk().replace('include: ["a/**", "b/**"]', 'include: ["a/**", ...MORE]')).join("\n")).toMatch(
      /không phải giá trị literal.*include: \.\.\.MORE/,
    );
  });
  it("cờ --coverage.thresholds|exclude|include ở dòng lệnh bị phát hiện (kể cả dạng .lines=0)", () => {
    expect(coverageCliOverrides("run: pnpm exec vitest run --coverage")).toEqual([]);
    expect(coverageCliOverrides("a\nrun: vitest run --coverage --coverage.thresholds.lines=0")).toEqual([2]);
    expect(coverageCliOverrides("vitest --coverage.exclude='**/*.ts'")).toEqual([1]);
    expect(
      coverageCliOverrides("vitest --coverage.include=x\nvitest --coverage.thresholds.autoUpdate"),
    ).toEqual([1, 2]);
    expect(coverageCliOverrides("--coverage.reporter=text --coverage.enabled")).toEqual([]);
  });
  it("không workflow / script package.json / xt.yaml nào ghi đè coverage bằng cờ dòng lệnh", () => {
    const wfDir = join(ROOT, ".github/workflows");
    const hits = readdirSync(wfDir)
      .filter((n) => /\.ya?ml$/.test(n))
      .flatMap((n) => coverageCliOverrides(read(`.github/workflows/${n}`)).map((l) => `${n}:${l}`));
    for (const f of ["package.json", "apps/web/package.json", "xt.yaml"])
      hits.push(...coverageCliOverrides(read(f)).map((l) => `${f}:${l}`));
    expect(hits).toEqual([]);
  });
  // merge-check liệt kê tối đa 3 đường dẫn mỗi lý do → gọi Python theo nhóm 3 (không gọi từng file: chậm, dễ quá hạn khi tải cao).
  it("file cấu hình cổng + script ratchet/fix-requires-test + workflow test-quality nằm trong merge_risk_paths: merge-check trả `hard`", {
    timeout: 30_000,
  }, () => {
    const paths = [
      "vitest.config.ts",
      "apps/web/playwright.config.ts",
      "biome.json",
      "tsconfig.base.json",
      "packages/app/tsconfig.json",
      "xt.yaml",
      "scripts/check-coverage-ratchet.mjs",
      "scripts/fix-requires-test.mjs",
      ".github/workflows/test-quality.yml",
    ];
    for (let i = 0; i < paths.length; i += 3) {
      const group = paths.slice(i, i + 3);
      const pr = {
        number: 1,
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "",
        headRefOid: "abc",
        labels: [],
        statusCheckRollup: [],
        files: group.map((path) => ({ path, additions: 1, deletions: 1 })),
      };
      // merge-check thoát ≠ 0 khi verdict là `human` — chỉ đọc JSON.
      const run = spawnSync(
        "python3",
        [".xtemplates/scripts/xt.py", "merge-check", "--pr-json", "-", "--json"],
        { cwd: ROOT, input: JSON.stringify(pr), encoding: "utf8", timeout: 25_000 },
      );
      const hard = JSON.parse(run.stdout)
        .hard.filter((h) => /merge_risk_paths/.test(h))
        .join(" ");
      for (const path of group) expect(hard, path).toContain(path);
    }
  });
});

describe("QA-E2E-005 + QA-STRAT-008: Playwright bắt buộc ở CI", () => {
  const pw = read("apps/web/playwright.config.ts");
  it("forbidOnly, retries ≤ 2, trace on-first-retry, workers cố định", () => {
    expect(pw).toMatch(/forbidOnly:\s*!!process\.env\.CI/);
    expect(pw).toMatch(/retries:\s*process\.env\.CI \? 2 : 0/);
    expect(pw).toMatch(/trace:\s*"on-first-retry"/);
    expect(pw).toMatch(/^\s*workers:\s*\d+,/m);
  });
  it("job e2e của CI chạy suite và upload trace khi đỏ", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/run: pnpm --filter web exec playwright test/);
    expect(ci).toMatch(/path: apps\/web\/test-results\//);
  });
});

/** Mọi file test (*.test.* / *.spec.*), bỏ thư mục sinh ra. */
function testFiles(dir = ROOT) {
  const out = [];
  for (const name of readdirSync(dir)) {
    // `worktrees`: bản sao repo tạm của subagent (.claude/worktrees/) — không phải mã dự án.
    if (
      ["node_modules", ".next", "coverage", "test-results", ".git", ".xtemplates", "worktrees"].includes(name)
    )
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...testFiles(full));
    else if (/\.(test|spec)\.(ts|tsx|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

describe("QA-STRAT-008: không có test.only/.skip không lý do", () => {
  const files = testFiles().map((f) => [relative(ROOT, f), readFileSync(f, "utf8").split("\n")]);
  const FOCUS = /\b(?:test|it|describe)\.only\(|\b(?:fit|fdescribe)\(/;
  const SKIP = /\b(?:test|it|describe)\.skip\(|\b(?:xit|xtest|xdescribe)\(/;
  it("biome.json bật noFocusedTests + noSkippedTests ở mức error", () => {
    const b = JSON.parse(read("biome.json"));
    expect(b.linter.rules.suspicious.noFocusedTests).toBe("error");
    expect(b.linter.rules.suspicious.noSkippedTests).toBe("error");
  });
  it("không file test nào còn .only/fit/fdescribe", () => {
    const hits = files.flatMap(([f, lines]) =>
      lines.flatMap((l, i) =>
        FOCUS.test(l) && !l.trim().startsWith("//") && !FIXTURE_FILES.has(f) ? [`${f}:${i + 1}`] : [],
      ),
    );
    expect(hits).toEqual([]);
  });
  it(".skip/xit chỉ được kèm `biome-ignore … noSkippedTests: <lý do>` ngay dòng trên", () => {
    const hits = files.flatMap(([f, lines]) =>
      lines.flatMap((l, i) => {
        if (!SKIP.test(l) || l.trim().startsWith("//") || FIXTURE_FILES.has(f)) return [];
        const prev = lines[i - 1] ?? "";
        return /biome-ignore lint\/suspicious\/noSkippedTests:\s*\S.{9,}/.test(prev) ? [] : [`${f}:${i + 1}`];
      }),
    );
    expect(hits).toEqual([]);
  });
  it("bộ dò bắt mẫu cấm", () => {
    expect(FOCUS.test('test.only("x", () => {})')).toBe(true);
    expect(SKIP.test('it.skip("x", () => {})')).toBe(true);
    expect(SKIP.test('describe.skipIf(cond)("x", () => {})')).toBe(false);
  });
});

describe("QA-STRAT-005: PR fix: phải kèm test", () => {
  it("fix: không đổi test → đỏ; có file test (ts/mjs/py) → đạt", () => {
    expect(checkFixHasTest("fix(lease): sửa", ["packages/app/src/lease/lease.ts"]).ok).toBe(false);
    expect(
      checkFixHasTest("fix(lease): sửa", [
        "packages/app/src/lease/lease.ts",
        "packages/app/src/lease/lease.db.test.ts",
      ]).ok,
    ).toBe(true);
    expect(checkFixHasTest("fix: x", ["a.ts", "scripts/x.test.mjs"]).ok).toBe(true);
    expect(checkFixHasTest("fix!: x", ["a.py", "tests/test_a.py"]).ok).toBe(true);
    expect(checkFixHasTest("fix: x", ["apps/web/e2e/a.spec.ts", "b.ts"]).ok).toBe(true);
  });
  it("cùng định nghĩa file test với xt.py: file dưới e2e/, tests/, __tests__/, spec/ hoặc test_*/ *_test.* đều là test", () => {
    for (const f of [
      "apps/web/e2e/helpers/auth.ts",
      "e2e/a.ts",
      "tests/conftest_helper.py",
      "packages/x/test/util.ts",
      "src/__tests__/a.ts",
      "spec/a.rb",
      "pkg/a_test.go",
      "scripts/test_pr_policy.py",
    ])
      expect(checkFixHasTest("fix: x", ["src/a.ts", f]).ok, f).toBe(true);
    for (const f of ["apps/web/e2ee/a.ts", "src/latest/a.ts", "src/contest.ts", "src/testing.ts"])
      expect(checkFixHasTest("fix: x", ["src/a.ts", f]).ok, f).toBe(false);
  });
  it("fix(deps) chỉ đổi manifest/lockfile → miễn; kèm mã khác hoặc scope khác → vẫn đòi test", () => {
    const lock = ["pnpm-lock.yaml", "package.json", "apps/web/package.json"];
    expect(checkFixHasTest("fix(deps): bump next", lock).ok).toBe(true);
    expect(checkFixHasTest("fix(deps-dev): bump vitest", [...lock, "docs/CHANGELOG.md"]).ok).toBe(true);
    expect(checkFixHasTest("fix(deps)!: bump", lock).ok).toBe(true);
    expect(checkFixHasTest("fix(deps): bump", [...lock, "src/a.ts"]).ok).toBe(false);
    expect(checkFixHasTest("fix(ui): bump", lock).ok).toBe(false);
    expect(checkFixHasTest("fix(dependencies): x", lock).ok).toBe(false);
  });
  it("ca biên: diff rỗng/chỉ tài liệu → không đòi; loại khác (feat, docs) → bỏ qua", () => {
    expect(checkFixHasTest("fix: x", []).ok).toBe(true);
    expect(checkFixHasTest("fix(docs): x", ["docs/a.md", "README.md"]).ok).toBe(true);
    expect(checkFixHasTest("feat: x", ["a.ts"]).ok).toBe(true);
    expect(checkFixHasTest("prefix: x", ["a.ts"]).ok).toBe(true);
    expect(checkFixHasTest("fixup: x", ["a.ts"]).ok).toBe(true);
  });
  it("miễn trừ cần lý do thật (≥ 12 ký tự, Unicode tiếng Việt)", () => {
    const f = ["a.ts"];
    expect(checkFixHasTest("fix: x", f, "Không cần test — lý do: chỉ đổi cấu hình triển khai").ok).toBe(true);
    expect(checkFixHasTest("fix: x", f, "Không cần test — lý do: …").ok).toBe(false);
    expect(checkFixHasTest("fix: x", f, "Không cần test — lý do: ngắn").ok).toBe(false);
  });
  it("job fix-requires-test chạy trên PR, đọc diff base...head", () => {
    const body = job("fix-requires-test");
    expect(workflow).toMatch(
      /fix-requires-test:\n {4}name: fix-requires-test\n {4}if: github.event_name == 'pull_request'/,
    );
    expect(body).toMatch(/fetch-depth: 0/);
    expect(body).toMatch(
      /git diff --name-only "\$BASE_SHA\.\.\.\$HEAD_SHA" \| node scripts\/fix-requires-test\.mjs/,
    );
  });
});

describe("QA-INT-007: kiểm OpenAPI breaking dùng công cụ tự host của T-801, không oasdiff", () => {
  it("không workflow nào dùng oasdiff (action mặc định gửi spec + telemetry ra ngoài); test-quality.yml không có job openapi-breaking", () => {
    const wfDir = join(ROOT, ".github/workflows");
    const hits = readdirSync(wfDir)
      .filter((n) => /\.ya?ml$/.test(n))
      .filter((n) => /^\s*(?:- )?uses:\s*\S*oasdiff/im.test(read(`.github/workflows/${n}`)));
    expect(hits).toEqual([]);
    expect(job("openapi-breaking")).toBe("");
  });
  it("hợp đồng được so là file đã commit và còn tồn tại", () => {
    expect(JSON.parse(read("apps/web/openapi.json")).openapi).toMatch(/^3\./);
  });
});

describe("BASE-GATE-003: lint 0 cảnh báo, gồm kiểm format, nằm trong cổng", () => {
  const pkg = JSON.parse(read("package.json"));
  it("script lint = biome ci (lint + format + import) với --error-on-warnings", () => {
    expect(pkg.scripts.lint).toMatch(/^biome ci .*--error-on-warnings/);
  });
  it("cổng xt.yaml chạy pnpm lint (qua dev-task.sh gate) và CI chạy đúng cổng đó", () => {
    // `pnpm lint` (có --error-on-warnings, khoá ở test trên) phải là lệnh ĐẦU của `lint:` trong xt.yaml, đứng độc lập (không phải `pnpm lint:openapi`).
    expect(read("xt.yaml")).toMatch(/^lint: "pnpm lint && /m);
    // CI chạy đúng cổng đó: job `lint` gọi `dev-task.sh lint` (khung 3.12.0: các task của cổng chạy ở job song song).
    expect(read(".github/workflows/ci.yml")).toMatch(
      /^\s+(run: )?\.xtemplates\/scripts\/dev-task\.sh lint\b/m,
    );
  });
  it("mọi biome-ignore có lý do (≥ 10 ký tự sau dấu hai chấm)", () => {
    const bad = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (
          ["node_modules", ".next", "coverage", ".git", ".xtemplates", "test-results", "worktrees"].includes(
            name,
          )
        )
          continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|mjs)$/.test(name) && !FIXTURE_FILES.has(relative(ROOT, full))) {
          readFileSync(full, "utf8")
            .split("\n")
            .forEach((l, i) => {
              if (/biome-ignore\b/.test(l) && !/biome-ignore [\w/]+:\s*\S.{9,}/.test(l))
                bad.push(`${relative(ROOT, full)}:${i + 1}`);
            });
        }
      }
    };
    walk(ROOT);
    expect(bad).toEqual([]);
  });
  it("không còn eslint-disable / noqa / nosec / @ts-ignore; @ts-expect-error phải kèm lý do", () => {
    const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mjs", "*.py", "*.sh"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(
        (f) => f && !f.startsWith(".xtemplates/") && !f.startsWith(".claude/") && !FIXTURE_FILES.has(f),
      );
    const bad = files.flatMap((f) =>
      read(f)
        .split("\n")
        .flatMap((l, i) =>
          /eslint-disable|# *noqa|#\s*nosec|@ts-ignore|@ts-expect-error(?!:?\s+\S{6})/.test(l)
            ? [`${f}:${i + 1}`]
            : [],
        ),
    );
    expect(bad).toEqual([]);
  });
  it('tắt rule trong biome.json: không có rule nào đặt "off" mà thiếu lý do', () => {
    const text = read("biome.json");
    expect(text.match(/"off"/g) ?? []).toEqual([]);
  });
});

describe("XC-DX-002: bộ lệnh chuẩn khai báo một nơi (xt.yaml), được CI/agent gọi nguyên văn", () => {
  const xt = Object.fromEntries(
    read("xt.yaml")
      .split("\n")
      .map((l) => /^([a-z0-9_]+):\s*"?(.*?)"?\s*$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/\\"/g, '"')]),
  );
  const pkg = JSON.parse(read("package.json"));
  it("có dev, build, test, lint, format, typecheck, migrate (rỗng = không có, có chú thích)", () => {
    for (const k of ["dev", "build", "test", "lint", "format", "typecheck", "migrate"])
      expect(k in xt, k).toBe(true);
    expect(xt.migrate).toBe("");
    expect(read("xt.yaml")).toMatch(/migrate: ""/);
  });
  it("lệnh `pnpm <script>` của xt.yaml là script có thật ở package.json gốc", () => {
    for (const k of ["build", "test", "lint", "format", "typecheck"]) {
      const m = /^pnpm (?:run )?([\w:-]+)(?:\s|$)/.exec(xt[k]);
      expect(m, `${k}: ${xt[k]}`).not.toBeNull();
      expect(pkg.scripts[m[1]], `${k} → script ${m[1]}`).toBeDefined();
    }
  });
  it("dev trỏ vào script dev có thật của @hm/web", () => {
    expect(xt.dev).toBe("pnpm --filter @hm/web dev");
    expect(JSON.parse(read("apps/web/package.json")).scripts.dev).toBeDefined();
  });
  it("e2e và audit trong xt.yaml trùng NGUYÊN VĂN lệnh ở workflow CI", () => {
    const wf = readdirSync(join(ROOT, ".github/workflows"))
      .map((n) => read(`.github/workflows/${n}`))
      .join("\n");
    // Tên package `web` ≡ `@hm/web` (pnpm cho bỏ scope) — cùng quy ước với process-docs.test.mjs.
    expect(wf).toContain(`run: ${xt.e2e.replace("--filter @hm/web", "--filter web")}`);
    expect(wf).toContain(`run: ${xt.audit}`);
  });
  it("AGENTS.md trỏ xt.yaml làm nơi lệnh chuẩn, không chép lệnh vào văn xuôi", () => {
    expect(read("AGENTS.md")).toMatch(/Lệnh chuẩn ở `xt\.yaml`/);
  });
});
