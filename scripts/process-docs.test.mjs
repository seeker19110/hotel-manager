// T-412: rào máy cho tài liệu + quy trình — ADR (lint heading), ROUTES ↔ cây apps/web/app, domains.md ↔ packages/app/src,
// API-CONTRACT ↔ ERROR_CODES, PROJECT §5/§10, SPEC (frontmatter, tiêu chí Given/When/Then, câu hỏi đã đóng, S-NNN ↔ test),
// AGENTS/README ↔ xt.yaml, THREAT-MODEL ↔ ADR, mẫu PR/issue, Dockerfile, bàn giao.
// (BASE-DOC-007, ARC-STYLE-001, ARC-ADR-003, FE-RENDER-001, PRF-WEB-001, STD-PROC-001, PM-REQ-019, PM-PRIO-004, PM-RISK-003/006,
// PM-SPEC-004/020, WF-SDD-001/002/003, XC-DOCAI-001/003, SEC-TM-001, BASE-SEC-006/013, SEC-INFRA-001, OPS-MAINT-005,
// WF-TEAM-003/004, WF-REVIEW-001, WF-DOC-001, PM-HANDOVER-002, XC-GREEN-005, ARC-RES-002/005)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../packages/app/src/errors.ts";
import { aliasOf, expandIds, mentioned, scenarios, coverage as specCoverage } from "./spec-coverage.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const exists = (rel) => existsSync(join(ROOT, rel));

/** Mọi file dưới `dir` (tương đối ROOT), đường dẫn tương đối ROOT dùng dấu /. */
function walk(dir, skip = ["node_modules", ".next"]) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir)).sort()) {
    if (skip.includes(name)) continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel, skip));
    else out.push(rel);
  }
  return out;
}

/** Frontmatter YAML phẳng `khoá: giá trị` giữa hai dòng `---` đầu file. null nếu không có. */
function frontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v);
    out[kv[1]] = v;
  }
  return out;
}

/** Nội dung dưới heading (bất kỳ cấp) có tiêu đề khớp `re`, tới heading cùng hoặc cao cấp hơn kế tiếp. */
function section(md, re) {
  const lines = md.split("\n");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (h && re.test(h[2])) {
      start = i + 1;
      level = h[1].length;
      break;
    }
  }
  if (start < 0) return null;
  const body = [];
  for (let i = start; i < lines.length; i++) {
    const h = /^(#{1,6})\s/.exec(lines[i]);
    if (h && h[1].length <= level) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

describe("frontmatter / section (bộ phân tích dùng chung)", () => {
  it("đọc khoá, nháy kép; không có frontmatter → null", () => {
    expect(frontmatter('---\na: b\nc: "d: e"\n---\n# x')).toEqual({ a: "b", c: "d: e" });
    expect(frontmatter("# x")).toBeNull();
    expect(frontmatter("")).toBeNull();
  });
  it("section lấy đúng thân tới heading cùng cấp", () => {
    const md = "# T\n## A\nx\n### A1\ny\n## B\nz";
    expect(section(md, /^A$/)).toBe("x\n### A1\ny");
    expect(section(md, /^Không có$/)).toBeNull();
  });
});

// ───────────────────────── ADR (ARC-ADR-003, ARC-STYLE-001, PRF-WEB-001) ─────────────────────────

const ADR_STATUS = /^(proposed|accepted|superseded|deprecated|rejected)\b/;

/** Số phương án trong mục "Các phương án đã cân nhắc": dòng đánh số/gạch đầu dòng, hoặc ô cuối của hàng bảng phân tách bằng "·". */
function countOptions(body) {
  if (!body) return 0;
  let n = 0;
  for (const line of body.split("\n")) {
    if (/^\s*(\d+\.|-|\*)\s+\S/.test(line)) n++;
    else if (/^\|/.test(line) && !/^\|\s*-/.test(line)) {
      const cells = line.split("|").map((c) => c.trim());
      const last = cells[cells.length - 2] ?? "";
      if (last.includes("·")) n += last.split("·").length;
    }
  }
  return n;
}

/** Lỗi lint của một ADR (mảng thông điệp, rỗng = đạt). */
function lintAdr(md) {
  const errs = [];
  const fm = frontmatter(md);
  if (!fm) return ["thiếu frontmatter"];
  if (!ADR_STATUS.test(fm.status ?? "")) errs.push(`status không hợp lệ: ${fm.status}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fm.date ?? "")) errs.push(`date không phải YYYY-MM-DD: ${fm.date}`);
  if (!/^# ADR-\d{4}: \S/m.test(md)) errs.push("thiếu tiêu đề `# ADR-NNNN: …`");
  for (const [name, re] of [
    ["Bối cảnh", /^Bối cảnh/],
    ["Quyết định", /^Quyết định$/],
    ["Hệ quả", /^Hệ quả$/],
    ["Điều kiện xem lại", /^Điều kiện (xem|đọc) lại$/],
  ])
    if (section(md, re) === null) errs.push(`thiếu mục "${name}"`);
  const opts = section(md, /^Các phương án đã cân nhắc$/);
  if (opts === null) errs.push('thiếu mục "Các phương án đã cân nhắc"');
  else if (countOptions(opts) < 2) errs.push("mục phương án có < 2 phương án");
  return errs;
}

describe("lint ADR (ARC-ADR-003, ARC-STYLE-001)", () => {
  const files = readdirSync(join(ROOT, "docs/adr")).filter((f) => /^\d{4}-.*\.md$/.test(f));

  it("có ADR để kiểm, gồm ADR-0004 (chiến lược render)", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files).toContain("0004-chien-luoc-render.md");
  });
  it.each(files)("%s đủ frontmatter và các mục bắt buộc", (f) => {
    expect(lintAdr(read(`docs/adr/${f}`))).toEqual([]);
  });
  it("lint bắt đúng: thiếu mục, status lạ, ngày sai, < 2 phương án", () => {
    const ok = [
      "---\nstatus: proposed\ndate: 2026-10-16\n---",
      "# ADR-0009: x",
      "## Bối cảnh và vấn đề\n.",
      "## Các phương án đã cân nhắc\n1. a\n2. b",
      "## Quyết định\n.\n### Hệ quả\n.",
      "## Điều kiện xem lại\n.",
    ].join("\n");
    expect(lintAdr(ok)).toEqual([]);
    expect(lintAdr(ok.replace("## Điều kiện xem lại", "## Khác"))).toEqual(['thiếu mục "Điều kiện xem lại"']);
    expect(lintAdr(ok.replace("status: proposed", "status: ok"))).toHaveLength(1);
    expect(lintAdr(ok.replace("2026-10-16", "16/10/2026"))).toHaveLength(1);
    expect(lintAdr(ok.replace("1. a\n2. b", "1. a"))).toEqual(["mục phương án có < 2 phương án"]);
    expect(lintAdr("# ADR-0001: x")).toEqual(["thiếu frontmatter"]);
  });
  it("countOptions: danh sách đánh số và hàng bảng phân tách bằng ·", () => {
    expect(countOptions("1. a\n2. b\n3. c")).toBe(3);
    expect(countOptions("| Năng lực | Phương án |\n|---|---|\n| X | **A** · B · C |")).toBe(3);
    expect(countOptions("")).toBe(0);
    expect(countOptions(null)).toBe(0);
  });
  it("ADR-0004 nêu các nhóm route và trỏ ROUTES.md", () => {
    const adr = read("docs/adr/0004-chien-luoc-render.md");
    expect(adr).toContain("no-store");
    expect(adr).toContain("connection()");
    expect(adr).toContain("docs/ROUTES.md");
  });
});

// ───────────────────────── ROUTES.md ↔ cây apps/web/app (FE-RENDER-001, PRF-WEB-001) ─────────────────────────

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Đường dẫn URL của một file route: bỏ nhóm `(x)`, bỏ tên file. */
function routePath(relFromApp) {
  const parts = relFromApp
    .split("/")
    .slice(0, -1)
    .filter((p) => !/^\(.*\)$/.test(p));
  return `/${parts.join("/")}`;
}

/** Các method export từ một route.ts: `export function GET`, `export { h as POST }`, `export const { …, GET }`. */
function routeMethods(src) {
  const found = new Set();
  for (const m of METHODS) {
    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(src)) found.add(m);
    if (new RegExp(`\\bas\\s+${m}\\b`).test(src)) found.add(m);
    if (new RegExp(`export\\s+const\\s*\\{[^}]*\\b${m}\\b[^}]*\\}`).test(src)) found.add(m);
  }
  return METHODS.filter((m) => found.has(m));
}

function realRoutes() {
  const out = new Map();
  for (const f of walk("apps/web/app")) {
    const rel = relative("apps/web/app", f);
    const base = rel.split("/").at(-1);
    if (base === "page.tsx") out.set(routePath(rel), { kind: "page", methods: ["GET"] });
    else if (base === "route.ts") out.set(routePath(rel), { kind: "api", methods: routeMethods(read(f)) });
    else if (rel === "manifest.ts") out.set("/manifest.webmanifest", { kind: "meta", methods: ["GET"] });
  }
  return out;
}

function documentedRoutes() {
  const out = new Map();
  for (const line of read("docs/ROUTES.md").split("\n")) {
    const m = /^\| `(\/[^`]*)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/.exec(
      line,
    );
    if (!m) continue;
    out.set(m[1], {
      methods: m[3].split(",").map((x) => x.trim()),
      render: m[4].trim(),
      cache: m[5].trim(),
      access: m[6].trim(),
      purpose: m[7].trim(),
    });
  }
  return out;
}

describe("routePath / routeMethods", () => {
  it("bỏ nhóm (x) và tên file; giữ tham số động", () => {
    expect(routePath("a/[id]/page.tsx")).toBe("/a/[id]");
    expect(routePath("page.tsx")).toBe("/");
    expect(routePath("(grp)/b/route.ts")).toBe("/b");
  });
  it("nhận các dạng export method", () => {
    expect(routeMethods("export function GET(){}\nexport async function POST(){}")).toEqual(["GET", "POST"]);
    expect(routeMethods("export { handle as GET, handle as POST };")).toEqual(["GET", "POST"]);
    expect(routeMethods("export const { dynamic, GET } = x();")).toEqual(["GET"]);
    expect(routeMethods("export const dynamic = 'force-dynamic';")).toEqual([]);
  });
});

describe("docs/ROUTES.md khớp cây apps/web/app (FE-RENDER-001)", () => {
  const real = realRoutes();
  const doc = documentedRoutes();

  it("quét được route thật và dòng tài liệu", () => {
    expect(real.size).toBeGreaterThan(40);
    expect(doc.size).toBeGreaterThan(40);
  });
  it("số route trong bảng = số route thực, cùng tập đường dẫn", () => {
    expect([...doc.keys()].sort()).toEqual([...real.keys()].sort());
  });
  it("method từng route khớp export thật", () => {
    const bad = [];
    for (const [path, r] of real) {
      const d = doc.get(path);
      if (d && JSON.stringify(d.methods) !== JSON.stringify(r.methods))
        bad.push(`${path}: bảng ${d.methods} ≠ mã ${r.methods}`);
    }
    expect(bad).toEqual([]);
  });
  it("mỗi dòng có chế độ render, cache, quyền, mục đích không rỗng", () => {
    for (const [path, d] of doc)
      for (const k of ["render", "cache", "access", "purpose"]) expect(d[k], `${path}.${k}`).not.toBe("");
  });
  it("mọi route động ghi cache no-store (trừ ngoại lệ có tên)", () => {
    const ok = new Set(["/manifest.webmanifest"]);
    for (const [path, d] of doc) if (!ok.has(path)) expect(d.cache, path).toContain("no-store");
  });
  it("mọi route API trong cây ghi force-dynamic ở mã (trừ /serwist)", () => {
    const bad = [];
    for (const f of walk("apps/web/app/api"))
      if (f.endsWith("route.ts") && !/export const dynamic = "force-dynamic"/.test(read(f))) bad.push(f);
    expect(bad).toEqual([]);
  });
  it("proxy đặt no-store trừ đường dẫn công khai (căn cứ của cột Cache)", () => {
    // T-403 chuyển việc đặt header sang `responseSecurityHeaders` (packages/app/src/http/security.ts); proxy gọi hàm đó.
    expect(read("apps/web/proxy.ts")).toContain("responseSecurityHeaders");
    const security = read("packages/app/src/http/security.ts");
    expect(security).toContain('"no-store"');
    expect(security).toContain("isCacheablePublicPath");
  });
});

// ───────────────────────── domains.md ↔ packages/app/src (ranh giới module) ─────────────────────────

const TIERS = "ABCDEF";

function domainRows() {
  const rows = new Map();
  for (const line of read("docs/architecture/domains.md").split("\n")) {
    const m = /^\| `([a-z-]+)` \| ([^|]+) \| ([A-F]) \| ([^|]+) \|$/.exec(line);
    if (m) rows.set(m[1], { domain: m[2].trim(), tier: m[3] });
  }
  return rows;
}

function importSpecifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out = [];
  for (const re of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s*["']([^"']+)["']/gm,
  ])
    for (const m of code.matchAll(re)) out.push(m[1]);
  return out;
}

const isProduct = (f) => /\.tsx?$/.test(f) && !/\.test\.(ts|tsx|mjs)$/.test(f);

/** Cạnh thư mục→thư mục giữa các thư mục cấp một của packages/app/src. */
function appEdges() {
  const edges = new Map();
  for (const f of walk("packages/app/src").filter(isProduct)) {
    const from = relative("packages/app/src", f).split("/");
    if (from.length < 2) continue;
    for (const spec of importSpecifiers(read(f))) {
      if (!spec.startsWith(".")) continue;
      const target = join("/", ...from.slice(0, -1), spec);
      const to = target.split("/").filter(Boolean);
      if (to.includes("..") || to.length < 2 || to[0] === from[0]) continue;
      const key = `${from[0]}->${to[0]}`;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push(f);
    }
  }
  return edges;
}

describe("docs/architecture/domains.md (ranh giới module)", () => {
  const rows = domainRows();
  const dirs = readdirSync(join(ROOT, "packages/app/src"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  it("mọi thư mục packages/app/src/* có một dòng trong bảng và ngược lại", () => {
    expect([...rows.keys()].sort()).toEqual(dirs);
  });
  it("tầng hợp lệ A–F", () => {
    for (const [, r] of rows) expect(TIERS).toContain(r.tier);
  });
  it("import chéo thư mục chỉ đi tới cùng tầng hoặc thấp hơn (trừ cạnh vòng đã biết ở nền ratchet)", () => {
    const baseline = JSON.parse(read("packages/app/src/arch-guards.baseline.json")).canh_trong_vong;
    const bad = [];
    for (const [edge, files] of appEdges()) {
      if (baseline.includes(edge)) continue;
      const [a, b] = edge.split("->");
      const ta = rows.get(a)?.tier;
      const tb = rows.get(b)?.tier;
      if (ta && tb && TIERS.indexOf(ta) < TIERS.indexOf(tb)) bad.push(`${edge} (${ta}<${tb}) ${files[0]}`);
    }
    expect(bad).toEqual([]);
  });
  it("mã trong packages/* không import apps/*", () => {
    const bad = [];
    for (const pkg of readdirSync(join(ROOT, "packages")))
      for (const f of walk(`packages/${pkg}/src`).filter(isProduct))
        for (const s of importSpecifiers(read(f)))
          if (/(^|\/)apps\//.test(s) || s === "@hm/web" || s === "@hm/worker") bad.push(`${f} → ${s}`);
    expect(bad).toEqual([]);
  });
  it("packages/db không phụ thuộc @hm/app hay @hm/domain", () => {
    const pkg = JSON.parse(read("packages/db/package.json"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => ["@hm/app", "@hm/domain"].includes(d))).toEqual([]);
  });
  it("thư mục packages/domain/src nêu đủ trong tài liệu", () => {
    const doc = read("docs/architecture/domains.md");
    for (const e of readdirSync(join(ROOT, "packages/domain/src"), { withFileTypes: true }))
      if (e.isDirectory()) expect(doc, e.name).toContain(`\`${e.name}\``);
  });
});

// ───────────────────────── API-CONTRACT ↔ ERROR_CODES, OpenAPI (BASE-DOC-007) ─────────────────────────

describe("API-CONTRACT.md (BASE-DOC-007)", () => {
  const md = read("docs/design/API-CONTRACT.md");
  it("trỏ đúng file máy đọc và lệnh sinh; không nhắc openapi.yaml", () => {
    expect(md).toContain("apps/web/openapi.json");
    expect(md).toContain("pnpm openapi");
    expect(md).not.toContain("openapi.yaml");
    expect(exists("apps/web/openapi.json")).toBe(true);
    expect(JSON.parse(read("package.json")).scripts.openapi).toBeTruthy();
  });
  it("bảng mã dùng chung = các mã `contract` của ERROR_CODES (hai chiều)", () => {
    const sec = section(md, /^2\. Lỗi/) ?? "";
    const documented = new Set([...sec.matchAll(/^\| `([A-Z_]+)` \| \d{3} \|/gm)].map((m) => m[1]));
    const inCode = Object.entries(ERROR_CODES)
      .filter(([, v]) => v.source === "contract")
      .map(([k]) => k);
    expect([...documented].sort()).toEqual(inCode.sort());
  });
  it("mã riêng từng SPEC ở chỉ mục (trừ mã chỉ ở phía client) có trong ERROR_CODES", () => {
    const sec = section(md, /^2\. Lỗi/) ?? "";
    const clientOnly = new Set(["CLIENT_OUTDATED", "NETWORK_TIMEOUT", "RESULT_UNKNOWN"]);
    const missing = [];
    for (const line of sec.split("\n")) {
      const m = /^\| `SPEC-[a-z-]+\.md` \| (.*) \|$/.exec(line);
      if (!m) continue;
      for (const c of m[1].matchAll(/`([A-Z_]+)`/g))
        if (!clientOnly.has(c[1]) && !(c[1] in ERROR_CODES)) missing.push(c[1]);
    }
    expect(missing).toEqual([]);
  });
  it("bảng endpoint hệ thống nêu các route ngoài registry có thật", () => {
    const real = realRoutes();
    for (const p of ["/api/health", "/api/ready", "/api/metrics", "/api/v1/me", "/api/v1/commands/[id]"]) {
      expect(real.has(p), p).toBe(true);
      expect(md, p).toContain(
        p
          .replace("[id]", "{command_id}")
          .replace("/api/v1/commands/{command_id}", "/api/v1/commands/{command_id}"),
      );
    }
  });
});

// ───────────────────────── PROJECT.md: NFR 25010, câu hỏi chặn (STD-PROC-001, PM-REQ-019) ─────────────────────────

describe("PROJECT.md §5 theo ISO/IEC 25010:2023 (STD-PROC-001)", () => {
  const project = read("PROJECT.md");
  const nfr = section(project, /^5\. Yêu cầu phi chức năng/) ?? "";
  const rows = nfr.split("\n").filter((l) => /^\| /.test(l) && !/^\|\s*-/.test(l) && !/^\| Đặc tính/.test(l));
  it("nêu 25010 và có ≥ 9 đặc tính, mỗi đặc tính một hàng", () => {
    expect(project).toContain("25010");
    expect(rows.length).toBe(9);
  });
  it("≥ 3 hàng có ngưỡng số (ms, %, giờ, phút, WCAG, ASVS, px…)", () => {
    const numeric = rows.filter((r) => /\d/.test(r.split("|")[2] ?? ""));
    expect(numeric.length).toBeGreaterThanOrEqual(3);
  });
  it("có đủ tên chín đặc tính của phiên bản 2023", () => {
    for (const k of [
      "Hiệu năng",
      "Độ tin cậy",
      "Bảo mật",
      "Phù hợp chức năng",
      "Khả năng tương tác",
      "Tương thích",
      "Khả năng bảo trì",
      "linh hoạt",
      "An toàn",
    ])
      expect(nfr, k).toContain(k);
  });
});

describe("PROJECT.md §10 câu chặn đã quyết (PM-REQ-019)", () => {
  const project = read("PROJECT.md");
  const decisions = read("docs/autopilot/DECISIONS.md");
  const sec = section(project, /^10\. Câu hỏi mở/) ?? "";
  it("không còn câu `[chặn]` chưa tick", () => {
    expect(sec).not.toMatch(/^- \[ \] .*\[chặn/m);
    expect(project.match(/\[chặn\]/g) ?? []).toHaveLength(0);
  });
  it("mỗi câu đã tick trỏ D-NNN có trong DECISIONS.md hoặc ngày duyệt PLAN", () => {
    const closed = sec.split("\n").filter((l) => l.startsWith("- [x]"));
    expect(closed.length).toBeGreaterThanOrEqual(3);
    for (const l of closed) {
      const ds = [...l.matchAll(/\bD-(\d{3})\b/g)].map((m) => m[0]);
      for (const d of ds) expect(decisions, d).toContain(`### ${d} `);
      expect(ds.length > 0 || /\d{4}-\d{2}-\d{2}/.test(l), l.slice(0, 60)).toBe(true);
    }
  });
});

// ───────────────────────── SPEC (WF-SDD-001/002, PM-SPEC-020) ─────────────────────────

const SPEC_FILES = readdirSync(join(ROOT, "docs/specs")).filter((f) => /^SPEC-.*\.md$/.test(f));

/** Lỗi frontmatter của một spec. */
function lintSpecFrontmatter(md) {
  const fm = frontmatter(md);
  if (!fm) return ["thiếu frontmatter"];
  const errs = [];
  for (const k of ["status", "approved_by", "approved_at"]) if (!fm[k]) errs.push(`thiếu ${k}`);
  if (errs.length) return errs;
  const none = (v) => v === "(chưa)";
  if (none(fm.approved_by) !== none(fm.approved_at))
    errs.push("approved_by và approved_at phải cùng (chưa) hoặc cùng có giá trị");
  if (!none(fm.approved_at) && !/^\d{4}-\d{2}-\d{2}$/.test(fm.approved_at))
    errs.push("approved_at không phải YYYY-MM-DD");
  const table = /^\|\s*Trạng thái\s*\|\s*(\S+)/m.exec(md)?.[1];
  if (table && table.toLowerCase() !== fm.status.toLowerCase())
    errs.push(`status ${fm.status} ≠ bảng ${table}`);
  return errs;
}

/** Lỗi của mục "Tiêu chí chấp nhận": ≥ 1 S-NNN, mỗi S-NNN có Given/When/Then, ≥ 1 ca lỗi. */
function lintAcceptance(md) {
  const sec = section(md, /^2\. Tiêu chí chấp nhận/);
  if (sec === null) return ['thiếu mục "Tiêu chí chấp nhận"'];
  const errs = [];
  const parts = sec.split(/^### (?=S-\d{3}\b)/m).slice(1);
  if (parts.length === 0) return ["không có scenario S-NNN"];
  for (const p of parts) {
    const id = /^(S-\d{3})/.exec(p)?.[1];
    // Bảng input→output (`- Examples:` + bảng) cũng là dạng máy đọc được (WF-SDD-002).
    if (/^- Examples:/m.test(p) && /^\|.*\|\s*$/m.test(p)) continue;
    for (const kw of ["Given", "When", "Then"])
      if (!new RegExp(`^- ${kw}\\b`, "m").test(p)) errs.push(`${id} thiếu ${kw}`);
  }
  const errorCase = parts.some((p) =>
    /\b(4\d\d|5\d\d)\b|[A-Z]{2,}_[A-Z_]+|lỗi|từ chối|không hợp lệ|bị chặn/i.test(p),
  );
  if (!errorCase) errs.push("không có ca lỗi");
  return errs;
}

describe("SPEC frontmatter và tiêu chí chấp nhận (WF-SDD-001/002)", () => {
  it("có đủ 12 spec", () => {
    expect(SPEC_FILES.length).toBeGreaterThanOrEqual(12);
  });
  it.each(SPEC_FILES)("%s: frontmatter status/approved_by/approved_at hợp lệ", (f) => {
    expect(lintSpecFrontmatter(read(`docs/specs/${f}`))).toEqual([]);
  });
  it.each(SPEC_FILES)("%s: tiêu chí chấp nhận dạng Given/When/Then, có ca lỗi", (f) => {
    expect(lintAcceptance(read(`docs/specs/${f}`))).toEqual([]);
  });
  it("lint bắt đúng các lỗi", () => {
    const ok =
      '---\nstatus: Approved\napproved_by: "(chưa)"\napproved_at: "(chưa)"\n---\n| Trạng thái | Approved |\n';
    expect(lintSpecFrontmatter(ok)).toEqual([]);
    expect(lintSpecFrontmatter(ok.replace('approved_at: "(chưa)"', "approved_at: 2026-10-16"))).toHaveLength(
      1,
    );
    expect(lintSpecFrontmatter(ok.replace("approved_by", "x"))).toEqual(["thiếu approved_by"]);
    expect(lintSpecFrontmatter("# x")).toEqual(["thiếu frontmatter"]);
    expect(lintSpecFrontmatter(ok.replace("status: Approved", "status: Draft"))).toHaveLength(1);
    const ac =
      "## 2. Tiêu chí chấp nhận\n### S-001 a\n- Given x\n- When y\n- Then 422 VALIDATION_FAILED\n## 3. Ca biên";
    expect(lintAcceptance(ac)).toEqual([]);
    expect(lintAcceptance(ac.replace("- When y\n", ""))).toEqual(["S-001 thiếu When"]);
    expect(lintAcceptance(ac.replace("422 VALIDATION_FAILED", "ok"))).toEqual(["không có ca lỗi"]);
    const table =
      "## 2. Tiêu chí chấp nhận\n### S-001 a\n- Examples:\n\n| a | b |\n|---|---|\n| 1 | 422 |\n## 3. x";
    expect(lintAcceptance(table)).toEqual([]);
    expect(lintAcceptance("## 2. Tiêu chí chấp nhận\n### S-001 a\n- Examples:\n## 3. x")).toHaveLength(4);
    expect(lintAcceptance("## 3. x")).toEqual(['thiếu mục "Tiêu chí chấp nhận"']);
  });
  it("approved_by (chưa) chỉ ở spec chưa có người duyệt: 4 spec đợt 2 có chủ dự án + ngày", () => {
    for (const n of ["import", "lease", "ledger-payments", "metering-billing"]) {
      const fm = frontmatter(read(`docs/specs/SPEC-${n}.md`));
      expect(fm.approved_by).toContain("chủ dự án");
      expect(fm.approved_at).toBe("2026-10-15");
    }
  });
});

describe("SPEC mục 10: câu đã đóng trỏ D-NNN/ngày (PM-SPEC-020)", () => {
  const decisions = read("docs/autopilot/DECISIONS.md");
  it.each(SPEC_FILES)("%s", (f) => {
    const sec = section(read(`docs/specs/${f}`), /^10\. Câu hỏi mở/) ?? "";
    const closed = sec.split("\n").filter((l) => l.startsWith("- [x]"));
    const bad = [];
    for (const l of closed) {
      const ds = [...l.matchAll(/\bD-(\d{3})\b/g)].map((m) => m[0]);
      if (!ds.length && !/\d{4}-\d{2}-\d{2}/.test(l)) bad.push(l.slice(0, 70));
      for (const d of ds) if (!decisions.includes(`### ${d} `)) bad.push(`${d} không có trong DECISIONS.md`);
    }
    expect(bad).toEqual([]);
  });
});

// ───────────────────────── SCOPE.md (PM-PRIO-004) ─────────────────────────

describe("SCOPE.md (PM-PRIO-004)", () => {
  const text = read("SCOPE.md");
  const rows = text
    .split("\n")
    .filter((l) => /^\| \d{4}-\d{2}-\d{2} \|/.test(l))
    .map((l) =>
      l
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );
  it("nêu điều kiện xét, quy ước commit docs(scope) và đóng băng ở G1", () => {
    expect(text).toMatch(/^## Điều kiện xét/m);
    expect(text).toContain("docs(scope)");
    expect(text).toContain("G1");
  });
  it("nhật ký: mỗi dòng đủ 5 cột, có người quyết và mục bị đẩy ra/bù, ngày không giảm", () => {
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) {
      expect(r, r[0]).toHaveLength(5);
      for (const c of r) expect(c.length, `${r[0]}: ô trống`).toBeGreaterThan(0);
    }
    const dates = rows.map((r) => r[0]);
    expect([...dates].sort()).toEqual(dates);
  });
  it("PROJECT.md trỏ SCOPE.md và các D-NNN trong nhật ký có thật", () => {
    expect(read("PROJECT.md")).toContain("SCOPE.md");
    const decisions = read("docs/autopilot/DECISIONS.md");
    for (const m of text.matchAll(/\bD-\d{3}\b/g)) expect(decisions, m[0]).toContain(`### ${m[0]} `);
  });
});

// ───────────────────────── RK-NNN ↔ PLAN, bảng phụ thuộc (PM-RISK-003/006) ─────────────────────────

describe("sổ rủi ro ↔ PLAN (PM-RISK-003)", () => {
  const plan = read("docs/autopilot/PLAN.md");
  const risks = read("docs/RISKS.md");
  const riskRows = risks
    .split("\n")
    .filter((l) => /^\| RK-\d{3} \|/.test(l))
    .map((l) =>
      l
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );
  const block = section(plan, /^Rủi ro ↔ task đợt 5/) ?? "";

  it("PLAN có bảng rủi ro ↔ task và xếp RK đầu của lát 10 ở dòng task đầu", () => {
    const rows = block.split("\n").filter((l) => /^\| `T-\d{3}` \|/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows[0]).toContain("`T-401`");
    expect(rows[0]).toMatch(/RK-\d{3}/);
  });
  it("mọi RK-NNN nhắc trong PLAN có trong sổ rủi ro", () => {
    const ids = new Set(riskRows.map((r) => r[0]));
    for (const m of plan.matchAll(/\bRK-\d{3}\b/g)) expect(ids.has(m[0]), m[0]).toBe(true);
  });
  it("mọi task nêu trong bảng có dòng task trong PLAN", () => {
    for (const m of block.matchAll(/^\| `(T-\d{3})` \|/gm))
      expect(plan, m[1]).toMatch(new RegExp(`^- \\[.\\] \`${m[1]}\``, "m"));
  });
  it("rủi ro Cao × Cao nào cũng có chỗ đứng trong PLAN (task hoặc ghi là việc của người)", () => {
    for (const r of riskRows.filter((x) => x[2] === "Cao" && x[3] === "Cao"))
      expect(block, r[0]).toContain(r[0]);
  });
  it("mọi T-NNN trong cột task/test của sổ có trong PLAN hoặc kế hoạch đã lưu", () => {
    const all = [plan, ...walk("docs/autopilot/archive").map(read)].join("\n");
    const missing = [];
    for (const r of riskRows)
      for (const m of r[8].matchAll(/\bT-\d{3}\b/g))
        if (!all.includes(`\`${m[0]}\``)) missing.push(`${r[0]} → ${m[0]}`);
    expect(missing).toEqual([]);
  });
});

describe("docs/RISKS.md — bảng phụ thuộc (PM-RISK-006)", () => {
  const sec = section(read("docs/RISKS.md"), /^Phụ thuộc bên thứ ba/) ?? "";
  const rows = sec
    .split("\n")
    .filter((l) => /^\| /.test(l) && !/^\|\s*-/.test(l) && !/^\| Phụ thuộc/.test(l))
    .map((l) =>
      l
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );

  it("≥ 14 phụ thuộc, mỗi dòng đủ 6 cột, không ô trống", () => {
    expect(rows.length).toBeGreaterThanOrEqual(14);
    for (const r of rows) {
      expect(r, r[0]).toHaveLength(6);
      for (const c of r) expect(c.length, `${r[0]}: ô trống`).toBeGreaterThan(0);
    }
  });
  it("phụ thuộc lõi có mặt", () => {
    const names = rows.map((r) => r[0]).join("|");
    for (const n of [
      "Node.js",
      "PostgreSQL",
      "Next.js",
      "Better Auth",
      "pg-boss",
      "SeaweedFS",
      "Caddy",
      "pgBackRest",
      "ClamAV",
    ])
      expect(names, n).toContain(n);
  });
  it("phiên bản và giấy phép của gói npm khớp package.json đã ghim và gói đã cài", () => {
    const pkgs = {
      "Next.js": ["apps/web", "next"],
      React: ["apps/web", "react"],
      "Better Auth": ["packages/app", "better-auth"],
      Kysely: ["packages/app", "kysely"],
      pg: ["packages/app", "pg"],
      "pg-boss": ["apps/worker", "pg-boss"],
      Zod: ["packages/app", "zod"],
      aws4fetch: ["packages/app", "aws4fetch"],
      Serwist: ["apps/web", "serwist"],
    };
    for (const [name, [dir, dep]] of Object.entries(pkgs)) {
      const row = rows.find((r) => r[0] === name);
      expect(row, name).toBeTruthy();
      const pinned = JSON.parse(read(`${dir}/package.json`)).dependencies[dep];
      expect(pinned, `${name} phải ghim đúng phiên bản`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(row[1], name).toContain(pinned);
      const installed = `${dir}/node_modules/${dep}/package.json`;
      if (exists(installed)) expect(row[2], name).toBe(JSON.parse(read(installed)).license);
    }
  });
  it("Node.js và PostgreSQL khớp .nvmrc và image đã ghim", () => {
    const node = rows.find((r) => r[0] === "Node.js");
    expect(node[1]).toContain(read(".nvmrc").trim());
    const pg = rows.find((r) => r[0] === "PostgreSQL");
    expect(pg[1]).toContain(/postgres:(\d+\.\d+)/.exec(read("deploy/postgres/Dockerfile"))[1]);
  });
  it("điều chưa kiểm ghi đúng cụm '(chưa xác minh)', không để trống hay đoán", () => {
    expect(
      rows.some((r) => r.includes("(chưa xác minh)") || r.some((c) => c.includes("(chưa xác minh)"))),
    ).toBe(true);
  });
});

// ───────────────────────── AGENTS.md / README ↔ xt.yaml (XC-DOCAI-001/003) ─────────────────────────

/** `xt.yaml` phẳng `khoá: giá trị` (giá trị có thể trong nháy kép kiểu JSON). */
function xtYaml() {
  const out = {};
  for (const line of read("xt.yaml").split("\n")) {
    const m = /^([a-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim();
    out[m[1]] = v.startsWith('"') ? JSON.parse(v) : v;
  }
  return out;
}

/** Lệnh `pnpm …` trong khối code rào và đoạn code dòng của một tài liệu. */
function pnpmCommands(md) {
  const out = new Set();
  const lines = md.split("\n");
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    const candidates = fence
      ? [line.replace(/\s+#.*$/, "")]
      : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const c of candidates)
      for (const part of c.split("&&")) {
        const t = part.trim();
        if (/^pnpm\s/.test(t)) out.add(t);
      }
  }
  return [...out];
}

/** Lệnh pnpm hợp lệ: script gốc, script của package qua --filter, hoặc lệnh có sẵn của pnpm (exec/install/audit/vitest/licenses). */
function pnpmCommandProblem(cmd, rootScripts, pkgScripts) {
  const words = cmd.split(/\s+/).slice(1);
  if (words[0] === "--filter") {
    const pkg = (words[1] ?? "").replace(/^@hm\//, "");
    const next = words[2];
    if (!pkgScripts[pkg]) return `package lạ: ${words[1]}`;
    if (["exec", "run"].includes(next)) return null;
    return pkgScripts[pkg][next] ? null : `${pkg} không có script ${next}`;
  }
  const first = words[0];
  if (["exec", "install", "audit", "vitest", "licenses", "add", "-r", "run"].includes(first)) return null;
  return rootScripts[first] ? null : `script gốc không có: ${first}`;
}

describe("AGENTS.md (XC-DOCAI-001/003)", () => {
  const agents = read("AGENTS.md");
  it("có đủ các mục bắt buộc", () => {
    for (const h of [
      /^## 1\. Dự án này/m,
      /^## 3\. Đọc theo thứ tự/m,
      /^## 4\. Luật bất biến/m,
      /^## 6\. Điểm dừng bắt buộc/m,
      /^## 7\. Cổng/m,
      /^## 9\. Quy ước riêng/m,
    ])
      expect(agents).toMatch(h);
  });
  it("trỏ xt.yaml và cấm suy diễn lệnh từ văn xuôi", () => {
    expect(agents).toContain("xt.yaml");
    expect(agents).toContain("Không suy diễn lệnh từ văn xuôi");
  });
  it("mọi lệnh `.xtemplates/scripts/*` AGENTS.md nêu có thật", () => {
    for (const m of agents.matchAll(/`((?:python3 )?\.xtemplates\/scripts\/[A-Za-z0-9_.-]+)/g)) {
      const file = m[1].replace(/^python3 /, "");
      expect(exists(file), file).toBe(true);
    }
  });
  it("lệnh pnpm trong AGENTS.md, README.md khớp script thật", () => {
    const rootScripts = JSON.parse(read("package.json")).scripts;
    const pkgScripts = {};
    for (const f of [
      "apps/web",
      "apps/worker",
      "packages/app",
      "packages/db",
      "packages/domain",
      "packages/testkit",
    ])
      pkgScripts[f.split("/")[1]] = JSON.parse(read(`${f}/package.json`)).scripts ?? {};
    const bad = [];
    for (const doc of ["AGENTS.md", "README.md"])
      for (const c of pnpmCommands(read(doc))) {
        const p = pnpmCommandProblem(c, rootScripts, pkgScripts);
        if (p) bad.push(`${doc}: ${c} → ${p}`);
      }
    expect(bad).toEqual([]);
  });
});

describe("pnpmCommandProblem", () => {
  const root = { lint: "x" };
  const pk = { web: { dev: "x" }, worker: {} };
  it("nhận script gốc, script package, lệnh có sẵn; bắt lệnh lạ", () => {
    expect(pnpmCommandProblem("pnpm lint", root, pk)).toBeNull();
    expect(pnpmCommandProblem("pnpm --filter @hm/web dev", root, pk)).toBeNull();
    expect(pnpmCommandProblem("pnpm --filter @hm/web exec playwright test", root, pk)).toBeNull();
    expect(pnpmCommandProblem("pnpm vitest run", root, pk)).toBeNull();
    expect(pnpmCommandProblem("pnpm nope", root, pk)).toMatch(/không có/);
    expect(pnpmCommandProblem("pnpm --filter @hm/web start", root, pk)).toMatch(/không có script/);
    expect(pnpmCommandProblem("pnpm --filter @hm/zzz dev", root, pk)).toMatch(/package lạ/);
  });
});

describe("xt.yaml ↔ package.json, CI (XC-DOCAI-003, chỉ đọc)", () => {
  const xt = xtYaml();
  const rootScripts = JSON.parse(read("package.json")).scripts;
  const ci = read(".github/workflows/ci.yml");
  const audit = read(".github/workflows/dep-audit.yml");

  it("đủ khoá lệnh cho cổng", () => {
    for (const k of ["lint", "typecheck", "test", "build", "format", "e2e", "install", "init", "audit"])
      expect(xt[k], k).toBeTruthy();
  });
  it("mỗi lệnh `pnpm <script>` trong xt.yaml là script gốc có thật", () => {
    for (const k of ["lint", "typecheck", "test", "build", "format"])
      for (const part of xt[k].split("&&")) {
        const m = /^\s*pnpm\s+([a-z:-]+)\s*$/.exec(part);
        if (m) expect(rootScripts[m[1]], `${k}: pnpm ${m[1]}`).toBeTruthy();
      }
  });
  it("CI chạy cổng bằng dev-task.sh gate (đọc xt.yaml), và ci-check workflow có trong xt.yaml lint", () => {
    expect(ci).toContain(".xtemplates/scripts/dev-task.sh gate");
    expect(xt.lint).toContain("xt.py ci-check .github/workflows");
  });
  it("e2e: CI chạy cùng lệnh (tên package `web` ≡ `@hm/web`)", () => {
    const norm = (s) => s.replace("@hm/web", "web");
    expect(ci).toContain(norm(xt.e2e));
  });
  it("audit: dep-audit.yml chạy lệnh của xt.yaml, chặt hơn bằng --audit-level", () => {
    expect(audit).toContain(xt.audit);
    expect(audit).toMatch(
      new RegExp(`${xt.audit.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")} --audit-level \\w+`),
    );
  });
  it("README nêu mọi lệnh xt.yaml dạng chuẩn (lint/test/typecheck/build/e2e/install/init)", () => {
    const readme = read("README.md");
    for (const k of ["lint", "test", "typecheck", "build", "e2e", "install", "init"])
      expect(readme, k).toContain(xt[k]);
  });
});

// ───────────────────────── THREAT-MODEL ↔ ADR (SEC-TM-001) ─────────────────────────

describe("THREAT-MODEL cập nhật sau ADR kiến trúc mới nhất (SEC-TM-001)", () => {
  const adrDates = readdirSync(join(ROOT, "docs/adr"))
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .map((f) => frontmatter(read(`docs/adr/${f}`))?.date);
  const tm = frontmatter(read("docs/design/THREAT-MODEL.md"));
  it("mọi ADR có ngày hợp lệ", () => {
    for (const d of adrDates) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("`updated` của THREAT-MODEL ≥ ngày ADR mới nhất", () => {
    expect(tm.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(tm.updated >= [...adrDates].sort().at(-1)).toBe(true);
  });
  it("bắt đúng: ngày cũ hơn ADR → đỏ", () => {
    expect("2026-10-15" >= "2026-10-16").toBe(false);
  });
});

// ───────────────────────── phân loại dữ liệu (BASE-SEC-013) ─────────────────────────

describe("bảng phân loại dữ liệu trong PROJECT.md (BASE-SEC-013)", () => {
  const project = read("PROJECT.md");
  const dataMap = read("docs/privacy/data-map.yaml");
  it("trỏ data-map và có đủ các lớp phân loại dùng trong sổ", () => {
    expect(project).toContain("docs/privacy/data-map.yaml");
    const used = new Set([...dataMap.matchAll(/classification: "([a-z_]+)"/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThanOrEqual(3);
    for (const c of used) expect(project, c).toContain(`\`${c}\``);
  });
  it("lớp nhạy cảm nêu mã hoá và che; lớp xác thực nêu không trả ra", () => {
    expect(project).toMatch(/`nhay_cam`[^\n]*AES-256-GCM/);
    expect(project).toMatch(/`xac_thuc`[^\n]*không bao giờ trả ra/);
  });
  it("test đối chiếu catalog CSDL ↔ sổ có thật", () => {
    expect(exists("packages/app/src/privacy/data-map.db.test.ts")).toBe(true);
  });
});

// ───────────────────────── mẫu PR / issue (OPS-MAINT-005, WF-TEAM-003/004, WF-REVIEW-001, WF-DOC-001, XC-GREEN-005) ─────────────────────────

describe("mẫu PR chung (WF-TEAM-004, WF-REVIEW-001, WF-DOC-001, XC-GREEN-005)", () => {
  const t = read(".github/pull_request_template.md");
  it("có mục CI xanh kèm link lượt chạy, Docs cập nhật/không cần, DoD, bảng trước–sau", () => {
    expect(t).toMatch(/CI xanh:.*link lượt chạy/);
    expect(t).toMatch(/^## Docs cập nhật \/ không cần/m);
    expect(t).toMatch(/^## Definition of Done/m);
    expect(t).toMatch(/^## Refactor \/ perf — bảng trước–sau/m);
    expect(t).toContain("WF-REVIEW-001");
  });
  it("mỗi mục DoD có chỗ ghi bằng chứng", () => {
    const dod = section(t, /^Definition of Done/) ?? "";
    const items = dod.split("\n").filter((l) => l.startsWith("- [ ]"));
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const l of items) expect(l, l).toMatch(/bằng chứng: …/);
  });
  it("bảng trước–sau có dòng, bundle, test, phụ thuộc", () => {
    const sec = section(t, /^Refactor \/ perf/) ?? "";
    for (const k of ["Dòng mã", "Số test", "Phụ thuộc", "Bundle"]) expect(sec, k).toContain(k);
  });
});

describe("mẫu PR nâng cấp lớn (OPS-MAINT-005)", () => {
  const t = read(".github/PULL_REQUEST_TEMPLATE/major-upgrade.md");
  it("đủ mục bắt buộc", () => {
    for (const h of [
      "Gói và phiên bản",
      "Đã đọc changelog",
      "Phạm vi",
      "Kiểm chứng",
      "Triển khai và đường lùi",
      "Rủi ro",
    ])
      expect(t, h).toMatch(new RegExp(`^## ${h}`, "m"));
  });
  it("nêu nhãn `major`, codemod, toàn bộ test + E2E, canary/flag, không gộp tính năng", () => {
    expect(t).toContain("`major`");
    expect(t).toContain("Codemod");
    expect(t).toContain("playwright test");
    expect(t).toMatch(/canary\/feature flag/);
    expect(t).toMatch(/không trộn tính năng/);
  });
  it("là mẫu, không phải workflow", () => {
    expect(exists(".github/PULL_REQUEST_TEMPLATE/major-upgrade.md")).toBe(true);
    expect(walk(".github/PULL_REQUEST_TEMPLATE").every((f) => f.endsWith(".md"))).toBe(true);
  });
});

describe("issue template (WF-TEAM-003 DoR)", () => {
  const files = walk(".github/ISSUE_TEMPLATE");
  it("có mẫu task với checklist Definition of Ready và nhãn `ready`", () => {
    const task = read(".github/ISSUE_TEMPLATE/task.md");
    expect(frontmatter(task)?.name).toBeTruthy();
    expect(task).toMatch(/^## Definition of Ready/m);
    expect(task).toContain("`ready`");
    for (const k of ["Tiêu chí chấp nhận", "Không còn câu hỏi mở", "Phụ thuộc", "Gate"])
      expect(task, k).toContain(k);
  });
  it("mẫu lỗi nhắc không dán dữ liệu thật", () => {
    const bug = read(".github/ISSUE_TEMPLATE/bug.md");
    expect(bug).toMatch(/Không dán dữ liệu thật/);
  });
  it("chỉ chứa mẫu .md (không phải workflow)", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.every((f) => f.endsWith(".md") || f.endsWith(".yml"))).toBe(true);
  });
});

// ───────────────────────── Dockerfile + danh tính (BASE-SEC-006, SEC-INFRA-001) ─────────────────────────

const DOCKERFILES = ["deploy/web.Dockerfile", "deploy/worker.Dockerfile"];

/** Các khối stage: [{ from, name, lines }] theo thứ tự. */
function stages(dockerfile) {
  const out = [];
  for (const raw of dockerfile.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) out.push({ from: from[1], name: from[2], lines: [] });
    else out.at(-1)?.lines.push(line);
  }
  return out;
}

describe("Dockerfile web/worker (BASE-SEC-006)", () => {
  it.each(DOCKERFILES)(
    "%s: multi-stage, base ghim digest khớp .nvmrc, stage cuối chạy USER không root",
    (f) => {
      const st = stages(read(f));
      expect(st.length).toBeGreaterThanOrEqual(3);
      const base = st[0].from;
      expect(base).toMatch(
        new RegExp(`^node:${read(".nvmrc").trim().replaceAll(".", "\\.")}-[a-z-]+@sha256:[0-9a-f]{64}$`),
      );
      const last = st.at(-1);
      const users = last.lines.filter((l) => /^USER\s/i.test(l)).map((l) => l.split(/\s+/)[1]);
      expect(users.length).toBeGreaterThan(0);
      expect(users.at(-1)).not.toMatch(/^(root|0)(:|$)/);
      expect(users.at(-1)).toBe("node");
      // USER phải đứng trước lệnh khởi chạy.
      const idxUser = last.lines.findIndex((l) => /^USER\s/i.test(l));
      const idxCmd = last.lines.findIndex((l) => /^(CMD|ENTRYPOINT)\s/i.test(l));
      expect(idxCmd).toBeGreaterThan(idxUser);
    },
  );
  it("hai image dùng cùng một digest base và cùng bản pnpm với package.json", () => {
    const digests = DOCKERFILES.map((f) => /@sha256:([0-9a-f]{64})/.exec(read(f))[1]);
    expect(new Set(digests).size).toBe(1);
    const pnpm = /pnpm@([\d.]+)$/.exec(JSON.parse(read("package.json")).packageManager)[1];
    for (const f of DOCKERFILES) expect(read(f)).toContain(`pnpm@${pnpm}`);
  });
  it.each(DOCKERFILES)("%s: không bí mật, không COPY .env, không chạy bằng root", (f) => {
    const text = read(f);
    const code = text
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(
      /\b(ENV|ARG)\s+\S*(SECRET|PASSWORD|TOKEN|PRIVATE|API_?KEY|ACCESS_?KEY)\S*\s*=?\s*\S+/i,
    );
    expect(code).not.toMatch(/COPY\s+[^\n]*\.env/);
    expect(code).not.toMatch(/\bsudo\b/);
    expect(code).not.toMatch(/curl[^\n]*\|\s*(sh|bash)/);
  });
  it("kiểm ghim image bao phủ *.Dockerfile (check-image-pins) và không có image trôi", async () => {
    const { deployFiles, checkDir } = await import("./check-image-pins.mjs");
    const names = deployFiles(join(ROOT, "deploy")).map((f) => f.slice(join(ROOT, "deploy").length + 1));
    for (const f of DOCKERFILES) expect(names).toContain(f.replace("deploy/", ""));
    expect(checkDir(join(ROOT, "deploy"))).toEqual([]);
  });
  it(".dockerignore loại bí mật, lịch sử git và node_modules khỏi ngữ cảnh build", () => {
    const lines = read(".dockerignore")
      .split("\n")
      .map((l) => l.trim());
    for (const e of [".git", ".env", ".env.*", "node_modules", "deploy/secrets", "**/.next"])
      expect(lines, e).toContain(e);
  });
  it("lệnh khởi chạy khớp RUNBOOK: worker chạy `node apps/worker/src/index.ts`, web lắng nghe cổng Caddy trỏ tới", () => {
    expect(read("deploy/worker.Dockerfile")).toContain('["node", "apps/worker/src/index.ts"]');
    expect(read("docs/RUNBOOK.md")).toContain("node apps/worker/src/index.ts");
    const port = /reverse_proxy web:(\d+)/.exec(read("deploy/Caddyfile"))[1];
    expect(read("deploy/web.Dockerfile")).toContain(`EXPOSE ${port}`);
    expect(read("deploy/web.Dockerfile")).toContain('"--hostname", "0.0.0.0"');
  });
  it("ghi rõ chưa build thật (không có daemon Docker)", () => {
    for (const f of DOCKERFILES) expect(read(f)).toMatch(/CHƯA build thật/);
    expect(read("deploy/README.md")).toMatch(/Chưa build thật/);
  });
});

describe("tách danh tính S3 web/worker (SEC-INFRA-001)", () => {
  const cfg = JSON.parse(read("deploy/s3.json.example"));
  it("hai danh tính riêng, khoá khác nhau, một bucket, không wildcard", () => {
    const names = cfg.identities.map((i) => i.name);
    expect(names).toEqual(["hotel-manager-web", "hotel-manager-worker"]);
    const keys = cfg.identities.flatMap((i) => i.credentials.map((c) => c.accessKey));
    expect(new Set(keys).size).toBe(keys.length);
    for (const i of cfg.identities)
      for (const a of i.actions) {
        expect(a).not.toContain("*");
        expect(a).toMatch(/^(Read|Write|List):hm-files$/);
      }
  });
  it("deploy/README.md lập bảng service ↔ vai trò CSDL ↔ danh tính S3 và nêu scope token", () => {
    const r = read("deploy/README.md");
    for (const k of [
      "hotel-manager-web",
      "hotel-manager-worker",
      "app_runtime",
      "app_worker",
      "`GITHUB_TOKEN`",
      "contents: read",
    ])
      expect(r, k).toContain(k);
    expect(read("docs/RUNBOOK.md")).toContain("hotel-manager-worker");
  });
  it("vai trò CSDL trong tài liệu có trong bootstrap-roles.sql", () => {
    const sql = read("packages/db/sql/bootstrap-roles.sql");
    for (const role of ["app_runtime", "app_worker"]) expect(sql).toContain(role);
  });
});

// ───────────────────────── bàn giao (PM-HANDOVER-002) ─────────────────────────

describe("docs/handover/accounts.md (PM-HANDOVER-002)", () => {
  const text = read("docs/handover/accounts.md");
  const rows = text
    .split("\n")
    .filter((l) => /^\| /.test(l) && !/^\|\s*-/.test(l) && !/^\| Dịch vụ/.test(l))
    .map((l) =>
      l
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );
  it("có các dịch vụ cần bàn giao và trạng thái từng dòng", () => {
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const all = rows.map((r) => r[0]).join("|");
    for (const k of ["GitHub", "VPS", "Tên miền", "SMTP", "Kho sao lưu CSDL", "S3", "Kho bí mật"])
      expect(all, k).toContain(k);
    for (const r of rows) {
      expect(r, r[0]).toHaveLength(7);
      expect(r[3].length, `${r[0]}: trạng thái`).toBeGreaterThan(0);
    }
  });
  it("chưa có dịch vụ thật thì ghi 'chưa có/chưa mua/chưa chọn'", () => {
    expect(text).toMatch(/\*\*chưa (có|mua|chọn)\*\*/);
  });
  it("không chứa bí mật", () => {
    expect(text).not.toMatch(/(?:password|secret|token|key)\s*[:=]\s*[A-Za-z0-9+/_-]{12,}/i);
    expect(text).not.toMatch(/\b[A-Za-z0-9+/]{40,}={0,2}\b/);
    expect(text).not.toMatch(/postgres(ql)?:\/\/[^\s)]*:[^\s)@]+@/);
    expect(text).not.toMatch(/-----BEGIN/);
  });
  it("README trỏ tới tài liệu bàn giao và tới Dockerfile", () => {
    const readme = read("README.md");
    for (const k of [
      "docs/handover/accounts.md",
      "deploy/web.Dockerfile",
      "deploy/worker.Dockerfile",
      "SCOPE.md",
      "docs/ROUTES.md",
    ])
      expect(readme, k).toContain(k);
  });
});

// ───────────────────────── README cập nhật ─────────────────────────

describe("README (worker đã chạy thật)", () => {
  const readme = read("README.md");
  it("nêu lệnh chạy worker thật và không còn nói 'đợt 4' chưa có tiến trình", () => {
    expect(readme).toContain("node apps/worker/src/index.ts");
    expect(readme).not.toMatch(/tiến trình khởi chạy thật nằm ở đợt/);
    expect(read("docs/RUNBOOK.md")).toContain("node apps/worker/src/index.ts");
    expect(exists("apps/worker/src/index.ts")).toBe(true);
  });
});

// ───────────────────────── retry và trạng thái (ARC-RES-002/005) ─────────────────────────

describe("docs/architecture/resilience.md khớp hằng số mã nguồn (ARC-RES-002/005)", () => {
  const doc = read("docs/architecture/resilience.md");
  it("lịch email, trần lần gửi", () => {
    const send = read("packages/app/src/notifications/send.ts");
    const list = /RETRY_BACKOFF_MINUTES = \[([\d, ]+)\]/.exec(send)[1];
    expect(doc).toContain(`RETRY_BACKOFF_MINUTES = [${list}]`);
    const attempts = list.split(",").length + 1;
    expect(doc).toContain(`\`MAX_ATTEMPTS\` = ${attempts} lượt gửi`);
  });
  it("kho file S3: timeout, số lần, nền lùi, trần", () => {
    const s = read("packages/app/src/files/storage.ts");
    const num = (k) =>
      Number(
        new RegExp(`${k}: ([\\d_]+)`).exec(s.slice(s.indexOf("DEFAULT_RESILIENCE")))[1].replaceAll("_", ""),
      );
    const fmt = (n) => n.toLocaleString("vi-VN");
    expect(doc).toContain(`\`maxRetries\` = ${num("maxRetries")}`);
    expect(doc).toContain(`\`baseDelayMs\` = ${num("baseDelayMs")} ms`);
    expect(doc).toContain(`\`maxDelayMs\` = ${fmt(num("maxDelayMs"))} ms`);
    expect(doc).toContain(`\`timeoutMs\` = ${fmt(num("timeoutMs"))} ms`);
  });
  it("pg-boss và transaction lệnh", () => {
    const relay = read("apps/worker/src/relay.ts");
    const q =
      /DEFAULT_QUEUE_POLICY: QueuePolicy = \{ retryLimit: (\d+), retryDelay: (\d+), retryBackoff: true \}/.exec(
        relay,
      );
    expect(q).toBeTruthy();
    expect(doc).toContain(`\`retryLimit\` = ${q[1]}`);
    expect(doc).toContain(`\`retryDelay\` = ${q[2]} giây`);
    const cmd = read("packages/app/src/pipeline/command.ts");
    expect(doc).toContain(`\`MAX_ATTEMPTS\` = ${/const MAX_ATTEMPTS = (\d+)/.exec(cmd)[1]}`);
    expect(cmd).toContain('new Set(["40001", "40P01"])');
  });
  it("ghi rõ điều chưa làm: helper chung, jitter email, E2E hai bản sao", () => {
    expect(doc).toMatch(/\*\*không\*\*/);
    expect(doc).toMatch(/chưa làm/);
    expect(doc).toContain("hai bản sao");
  });
  it("trạng thái ở Postgres/S3: rate limit lưu CSDL đúng như mã", () => {
    expect(read("packages/app/src/auth/auth.ts")).toMatch(/storage: "database"/);
    expect(doc).toContain('rateLimit.storage = "database"');
  });
});

// ───────────────────────── S-NNN ↔ test (PM-SPEC-004, WF-SDD-003) ─────────────────────────

describe("spec-coverage: heuristic nhận S-NNN theo spec", () => {
  const names = ["ledger-payments", "lease", "pwa"];
  it("scenarios lấy `### S-NNN` không trùng, có thứ tự", () => {
    expect(scenarios("### S-002 a\n### S-001 b\n### S-002 c\nS-009")).toEqual(["S-001", "S-002"]);
    expect(scenarios("")).toEqual([]);
  });
  it("expandIds trải khoảng …", () => {
    expect([...expandIds("S-002…S-004 và S-009")].sort()).toEqual(["S-002", "S-003", "S-004", "S-009"]);
    expect([...expandIds("không có")]).toEqual([]);
  });
  it("file chỉ nhắc một spec: mọi S-NNN thuộc spec đó", () => {
    expect([...mentioned("// SPEC-pwa\nit('S-005 x'); it('S-010 y')", "pwa", names)].sort()).toEqual([
      "S-005",
      "S-010",
    ]);
    expect([...mentioned("// SPEC-pwa\nit('S-005 x')", "lease", names)]).toEqual([]);
  });
  it("file nhắc nhiều spec: chỉ S-NNN đứng ngay sau SPEC-<bí danh> được tính", () => {
    const src = "// SPEC-ledger S-014/S-033 ...\n// SPEC-lease S-007\nit('S-099')";
    expect([...mentioned(src, "ledger-payments", names)].sort()).toEqual(["S-014", "S-033"]);
    expect([...mentioned(src, "lease", names)]).toContain("S-007");
    expect([...mentioned(src, "lease", names)]).not.toContain("S-014");
  });
  it("bí danh = phần đầu tên spec", () => {
    expect(aliasOf("ledger-payments")).toBe("ledger");
    expect(aliasOf("pwa")).toBe("pwa");
  });
});

describe("độ phủ S-NNN ↔ test của spec Approved (ratchet)", () => {
  const report = specCoverage();
  const base = JSON.parse(read("scripts/spec-coverage.baseline.json")).specs;

  it("quét đủ 12 spec và hơn 200 scenario", () => {
    expect(Object.keys(report).length).toBeGreaterThanOrEqual(12);
    expect(Object.values(report).reduce((n, r) => n + r.total, 0)).toBeGreaterThan(200);
  });
  it("spec Approved không có S-NNN mới thiếu test ngoài danh sách nền (thêm test hoặc gắn ID — KHÔNG thêm vào nền)", () => {
    const bad = [];
    for (const [name, r] of Object.entries(report)) {
      if (r.status.toLowerCase() !== "approved") continue;
      const allowed = new Set(base[name]?.uncovered ?? []);
      for (const id of r.uncovered) if (!allowed.has(id)) bad.push(`${name} ${id}`);
    }
    expect(bad).toEqual([]);
  });
  it("danh sách nền không có mục thừa: scenario đã có test thì xoá khỏi nền (chỉ được co lại)", () => {
    const stale = [];
    for (const [name, b] of Object.entries(base)) {
      const r = report[name];
      if (!r) stale.push(`${name}: spec không còn`);
      else for (const id of b.uncovered) if (!r.uncovered.includes(id)) stale.push(`${name} ${id}`);
    }
    expect(stale).toEqual([]);
  });
  it("mỗi mục nền có lý do đủ rõ và chỉ chứa ID có trong spec", () => {
    for (const [name, b] of Object.entries(base)) {
      expect(b.reason.length, name).toBeGreaterThan(60);
      const ids = scenarios(read(`docs/specs/SPEC-${name}.md`));
      for (const id of b.uncovered) expect(ids, `${name} ${id}`).toContain(id);
    }
  });
});
