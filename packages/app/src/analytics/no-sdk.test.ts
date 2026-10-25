// PLAN T-2309 (PM-METRIC-004/005; D-118) — rào CI: analytics sản phẩm chỉ đi qua `track()` (tự host, server-side). Cấm SDK/mã phân tích
// của bên thứ ba trong apps/ và packages/ (chỉ miễn ĐÚNG tệp này — nơi định nghĩa mẫu cấm; mã module analytics vẫn bị quét), host/CDN
// của dịch vụ phân tích, và cấm gói SDK analytics trong mọi
// package.json. Thêm công cụ phân tích mới = quyết định (D-NNN) + cập nhật docs/privacy, không lách bằng cách đổi tên biến.
// Ghi chú: từ `segment` trần KHÔNG bị cấm (trùng nghĩa "đoạn": CalendarSegment, path segment) — chỉ cấm dấu hiệu của Segment SDK/CDN.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "coverage",
  ".turbo",
  "test-results",
  "playwright-report",
]);
/** Tệp được miễn quét: chỉ tệp chứa chính các mẫu cấm (danh sách tường minh — không miễn cả thư mục). */
const EXEMPT_FILES = new Set([join(ROOT, "packages/app/src/analytics/no-sdk.test.ts")]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const p = join(dir, name);
    if (EXEMPT_FILES.has(p)) return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|html)$/;
/** Dấu hiệu SDK/mã phân tích bên thứ ba trong mã nguồn (không phân biệt hoa/thường). */
const FORBIDDEN_SOURCE: [string, RegExp][] = [
  ["posthog", /posthog/i],
  ["plausible(", /plausible\s*\(/i],
  ["gtag(", /\bgtag\s*\(/i],
  ["analytics.track", /\banalytics\s*\.\s*track\b/i],
  ["mixpanel", /mixpanel/i],
  ["amplitude", /amplitude/i],
  [
    "segment SDK",
    /@segment\/|cdn\.segment\.|api\.segment\.(io|com)|analytics-next|analytics-node|segment-analytics/i,
  ],
  ["google analytics/tag manager", /google-analytics|googletagmanager|ga\(\s*['"]send['"]/i],
  ["vercel analytics", /@vercel\/analytics|@vercel\/speed-insights/i],
  // Host/CDN của dịch vụ phân tích (thẻ <script>, fetch/beacon thẳng tới máy chủ bên thứ ba).
  [
    "analytics host/CDN",
    /i\.posthog\.com|plausible\.io|googletagmanager\.com|google-analytics\.com|cdn\.segment\.|cdn\.mxpnl\.com|api\.mixpanel\.com|cdn\.amplitude\.com|static\.hotjar\.com/i,
  ],
];
/** Gói analytics trong dependencies/devDependencies/peer/optional của mọi package.json. */
const FORBIDDEN_PACKAGES = [
  /^posthog/,
  /^@posthog\//,
  /^plausible/,
  /^@plausible/,
  /^mixpanel/,
  /^@mixpanel\//,
  /^@segment\//,
  /^analytics-(node|next)$/,
  /^analytics$/,
  /^@amplitude\//,
  /^amplitude/,
  /^react-ga/,
  /^react-gtm/,
  /^@analytics\//,
  /^@vercel\/(analytics|speed-insights)$/,
  /^@next\/third-parties$/,
  /^universal-analytics$/,
  /^ga-4-react$/,
  /^heap-api$/,
  /^hotjar/,
  /^@hotjar\//,
  /^logrocket/,
  /^@fullstory\//,
  /^rudder/,
  /^@rudderstack\//,
];

const rel = (f: string) => relative(ROOT, f).replaceAll("\\", "/");
const sourceFiles = () =>
  ["apps", "packages"].flatMap((d) => walk(join(ROOT, d))).filter((f) => SOURCE.test(f));

function hits(text: string): string[] {
  return FORBIDDEN_SOURCE.filter(([, re]) => re.test(text)).map(([label]) => label);
}

describe("rào analytics — không SDK/mã phân tích ngoài track()", () => {
  it("quét thật: thấy nhiều tệp nguồn của apps/ và packages/, kể cả mã module analytics; chỉ miễn đúng tệp định nghĩa mẫu", () => {
    const files = sourceFiles().map(rel);
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain("packages/app/src/billing/billing.ts");
    for (const f of ["track.ts", "validate.ts", "events.ts", "index.ts", "command.ts", "analytics.test.ts"])
      expect(files).toContain(`packages/app/src/analytics/${f}`);
    expect(files).not.toContain("packages/app/src/analytics/no-sdk.test.ts");
    expect([...EXEMPT_FILES].map(rel)).toEqual(["packages/app/src/analytics/no-sdk.test.ts"]);
  });

  it("không tệp nguồn nào chứa dấu hiệu SDK analytics bên thứ ba", () => {
    const bad: string[] = [];
    for (const f of sourceFiles()) {
      const found = hits(readFileSync(f, "utf8"));
      if (found.length > 0) bad.push(`${rel(f)}: ${found.join(", ")}`);
    }
    expect(bad).toEqual([]);
  });

  it("không package.json nào khai gói SDK analytics", () => {
    const manifests = [
      join(ROOT, "package.json"),
      ...["apps", "packages"].flatMap((d) =>
        readdirSync(join(ROOT, d)).map((w) => join(ROOT, d, w, "package.json")),
      ),
    ].filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
    expect(manifests.length).toBeGreaterThan(5);
    const bad: string[] = [];
    for (const m of manifests) {
      const pkg = JSON.parse(readFileSync(m, "utf8")) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
        for (const dep of Object.keys(pkg[field] ?? {}))
          if (FORBIDDEN_PACKAGES.some((re) => re.test(dep))) bad.push(`${rel(m)}: ${dep}`);
    }
    expect(bad).toEqual([]);
  });

  it("rào bắt đúng mẫu (không xanh rỗng) và không báo nhầm 'segment' của lịch/đường dẫn", () => {
    expect(hits("posthog.capture('x')")).toEqual(["posthog"]);
    expect(hits("window.plausible ('pageview')")).toEqual(["plausible("]);
    expect(hits("gtag('event', 'x')")).toEqual(["gtag("]);
    expect(hits("analytics.track('x')")).toEqual(["analytics.track"]);
    expect(hits("import mixpanel from 'mixpanel-browser'")).toEqual(["mixpanel"]);
    expect(hits("import { init } from '@amplitude/analytics-browser'")).toEqual(["amplitude"]);
    expect(hits("import { AnalyticsBrowser } from '@segment/analytics-next'")).toEqual(["segment SDK"]);
    expect(hits("<script src='https://www.googletagmanager.com/gtm.js'>")).toEqual([
      "google analytics/tag manager",
      "analytics host/CDN",
    ]);
    // Host/CDN: kể cả khi không có tên SDK trong mã (fetch/beacon thẳng).
    expect(hits("navigator.sendBeacon('https://plausible.io/api/event', b)")).toEqual(["analytics host/CDN"]);
    expect(hits("fetch('https://eu.i.posthog.com/capture/')")).toEqual(["posthog", "analytics host/CDN"]);
    expect(hits("<script src='https://www.google-analytics.com/analytics.js'>")).toEqual([
      "google analytics/tag manager",
      "analytics host/CDN",
    ]);
    expect(hits("<script src='https://cdn.segment.com/analytics.js/v1/x/analytics.min.js'>")).toEqual([
      "segment SDK",
      "analytics host/CDN",
    ]);
    expect(hits("const host = 'plausible.example.vn'")).toEqual([]);
    expect(hits("const segments: CalendarSegment[] = []; path.split('/').map((segment) => segment)")).toEqual(
      [],
    );
    expect(hits("track('core_task.completed', { task })")).toEqual([]);
    for (const p of [
      "posthog-js",
      "@posthog/react",
      "plausible-tracker",
      "mixpanel-browser",
      "@segment/analytics-next",
      "react-ga4",
      "@amplitude/analytics-browser",
      "@next/third-parties",
    ])
      expect(
        FORBIDDEN_PACKAGES.some((re) => re.test(p)),
        p,
      ).toBe(true);
    for (const p of ["kysely", "pg", "next", "react", "vitest", "yaml"])
      expect(
        FORBIDDEN_PACKAGES.some((re) => re.test(p)),
        p,
      ).toBe(false);
  });
});
