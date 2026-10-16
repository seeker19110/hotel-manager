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
    const proxy = read("apps/web/proxy.ts");
    expect(proxy).toContain('"no-store"');
    expect(proxy).toContain("isCacheablePublicPath");
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
