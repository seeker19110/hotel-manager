// PM-METRIC-003 (T-2309, D-118): MỘT điểm gửi sự kiện sản phẩm — `track()` ở packages/app/src/analytics, tự host. Không SDK analytics nào
// khác trong apps/ packages/ và không khai SDK như vậy trong package.json. Quét theo chuỗi (không cần AST): chỉ cần thấy là đỏ.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOWED_DIR = join("packages", "app", "src", "analytics");
const SKIP_DIRS = new Set([
  "node_modules",
  "worktrees",
  ".next",
  "dist",
  "build",
  "coverage",
  "test-results",
  "playwright-report",
  ".turbo",
]);
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|json|ya?ml)$/;

/** Mẫu cấm (không phân biệt hoa/thường với tên SDK). `plausible(`/`gtag(` là LỜI GỌI, không phải từ "plausible" trong văn xuôi. */
const FORBIDDEN = [/posthog/i, /plausible\(/i, /gtag\(/, /analytics\.track/, /mixpanel/i, /@segment\//];
/** Tên gói SDK analytics không được khai trong package.json. */
const FORBIDDEN_PACKAGES = [
  /posthog/i,
  /plausible/i,
  /mixpanel/i,
  /^@segment\//,
  /^analytics-node$/,
  /^@vercel\/analytics$/,
  /^react-ga/i,
  /^ga-4-react$/,
  /^@amplitude\//,
  /^amplitude-js$/,
  /^@datadog\/browser-rum$/,
  /^umami/i,
  /^matomo/i,
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (SOURCE_EXT.test(e.name)) yield p;
  }
}

/** Vi phạm trong `apps/` và `packages/` của `root`, bỏ thư mục `analytics` được phép. */
function findSdkUses(root) {
  const hits = [];
  for (const top of ["apps", "packages"]) {
    for (const file of walk(join(root, top))) {
      const rel = relative(root, file);
      if (rel.startsWith(`${ALLOWED_DIR}${sep}`)) continue;
      const text = readFileSync(file, "utf8");
      for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${rel}: ${re}`);
    }
  }
  return hits;
}

/** Gói SDK analytics được khai trong mọi package.json của root, apps/*, packages/*. */
function findSdkDeclared(root) {
  const manifests = [join(root, "package.json")];
  for (const top of ["apps", "packages"])
    for (const e of readdirSync(join(root, top), { withFileTypes: true }))
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) manifests.push(join(root, top, e.name, "package.json"));
  const hits = [];
  for (const m of manifests) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(m, "utf8"));
    } catch {
      continue;
    }
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
      for (const name of Object.keys(pkg[field] ?? {}))
        if (FORBIDDEN_PACKAGES.some((re) => re.test(name)))
          hits.push(`${relative(root, m)}: ${field}.${name}`);
  }
  return hits;
}

const tmp = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "hm-analytics-guard-"));
  tmp.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  mkdirSync(join(root, "apps"), { recursive: true });
  mkdirSync(join(root, "packages"), { recursive: true });
  return root;
}

describe("PM-METRIC-003: không SDK analytics ngoài packages/app/src/analytics", () => {
  it("repo thật: apps/ và packages/ không có SDK/lời gọi analytics ngoài thư mục được phép", () => {
    expect(findSdkUses(ROOT)).toEqual([]);
  });

  it("repo thật: không package.json nào khai SDK analytics", () => {
    expect(findSdkDeclared(ROOT)).toEqual([]);
  });

  it("thư mục analytics tồn tại và có track() (điểm duy nhất)", () => {
    const src = readFileSync(join(ROOT, ALLOWED_DIR, "track.ts"), "utf8");
    expect(src).toMatch(/export async function track</);
  });

  it("bộ quét bắt từng mẫu cấm ở nơi khác (không vacuous)", () => {
    for (const bad of [
      "import posthog from 'posthog-js'",
      "window.plausible('x')",
      "plausible('pageview')",
      "gtag('event', 'x')",
      "analytics.track('x')",
      "import Mixpanel from 'mixpanel-browser'",
      "import { AnalyticsBrowser } from '@segment/analytics-next'",
    ]) {
      const root = fixture({ "apps/web/app/page.ts": bad });
      expect(findSdkUses(root), bad).toHaveLength(1);
    }
  });

  it("thư mục được phép và node_modules/worktrees được bỏ qua; từ 'plausible' trong văn xuôi không bị bắt", () => {
    const root = fixture({
      "packages/app/src/analytics/x.ts": "// posthog gtag( analytics.track",
      "packages/app/node_modules/pkg/index.js": "posthog",
      "apps/web/worktrees/t1/a.ts": "posthog",
      "packages/app/src/other.ts": "// the explanation is plausible and holds",
    });
    expect(findSdkUses(root)).toEqual([]);
  });

  it("bộ quét package.json bắt SDK khai trong mọi nhóm phụ thuộc", () => {
    const root = fixture({
      "package.json": JSON.stringify({ devDependencies: { "posthog-js": "1.0.0" } }),
      "apps/web/package.json": JSON.stringify({ dependencies: { "@segment/analytics-next": "1.0.0" } }),
      "packages/app/package.json": JSON.stringify({ optionalDependencies: { mixpanel: "1.0.0" } }),
    });
    expect(findSdkDeclared(root)).toHaveLength(3);
  });
});
