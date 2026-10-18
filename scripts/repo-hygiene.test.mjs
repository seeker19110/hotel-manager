// T-307: vệ sinh repo — rào máy cho README/link tài liệu/phiên bản Node/CHANGELOG/.gitattributes/mẫu PR
// (BASE-DOC-001/005, BASE-REPO-003/006/007, BASE-DEP-003/006, XC-DX-001/003, WF-GIT-010, WF-DOC-002, DB-MIG-011).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** Mọi .md dưới `dir` (tương đối ROOT), bỏ thư mục trong `skip` (đường dẫn tương đối ROOT, dùng dấu /). */
function markdownFiles(dir, skip = []) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir)).sort()) {
    const rel = `${dir}/${name}`;
    if (skip.includes(rel)) continue;
    const abs = join(ROOT, rel);
    if (statSync(abs).isDirectory()) out.push(...markdownFiles(rel, skip));
    else if (name.endsWith(".md")) out.push(rel);
  }
  return out;
}

/** Bỏ khối code rào (``` / ~~~) và đoạn code dòng — link nằm trong đó không phải link thật. */
function stripCode(md) {
  const lines = md.split("\n");
  const kept = [];
  let fence = null;
  for (const line of lines) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      kept.push("");
      continue;
    }
    if (m) {
      fence = m[1];
      kept.push("");
      continue;
    }
    kept.push(line.replace(/`+[^`\n]*`+/g, ""));
  }
  return kept.join("\n");
}

/** Đích link tương đối của một tài liệu: `[t](đích)`, `[t](<đích>)`, `[id]: đích`. Bỏ URL ngoài, #anchor, ?query. */
function relativeLinkTargets(md) {
  const text = stripCode(md);
  const raw = [];
  for (const m of text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g))
    raw.push(m[1]);
  for (const m of text.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/gm)) raw.push(m[1]);
  const out = [];
  for (let t of raw) {
    if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1);
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//")) continue; // https:, mailto:, …
    t = t.split("#")[0].split("?")[0];
    if (t) out.push(decodeURIComponent(t));
  }
  return out;
}

const DOC_FILES = [
  "README.md",
  "RUNBOOK.md",
  "PROJECT.md",
  ...markdownFiles("docs", ["docs/autopilot/archive"]),
];

describe("relativeLinkTargets", () => {
  it.each([
    ["[a](docs/x.md)", ["docs/x.md"]],
    ["[a](docs/x.md#muc)", ["docs/x.md"]],
    ["[a](#chi-anchor)", []],
    ["[a](https://owasp.org/x) [b](mailto:a@example.test)", []],
    ["[a](<docs/có dấu.md>)", ["docs/có dấu.md"]],
    ['[a](x.md "tiêu đề")', ["x.md"]],
    ["[id]: ../y.md", ["../y.md"]],
    ["`[a](khong-co.md)` và [b](co.md)", ["co.md"]],
    ["```md\n[a](khong-co.md)\n```\n[b](co.md)", ["co.md"]],
    ["[a](tai%20lieu.md)", ["tai lieu.md"]],
    ["không có link", []],
    ["", []],
  ])("%j", (md, expected) => {
    expect(relativeLinkTargets(md)).toEqual(expected);
  });
});

describe("link tương đối trong README, PROJECT và docs/** (trừ docs/autopilot/archive)", () => {
  it("có tài liệu để kiểm", () => {
    expect(DOC_FILES).toContain("README.md");
    expect(DOC_FILES).toContain("PROJECT.md");
    expect(DOC_FILES).toContain("docs/RUNBOOK.md");
    expect(DOC_FILES.some((f) => f.startsWith("docs/autopilot/archive/"))).toBe(false);
  });

  it("mọi link trỏ tới file/thư mục có thật", () => {
    const broken = [];
    for (const file of DOC_FILES) {
      for (const target of relativeLinkTargets(read(file))) {
        const abs = target.startsWith("/") ? join(ROOT, target) : resolve(ROOT, dirname(file), target);
        if (!abs.startsWith(ROOT) || !existsSync(abs)) broken.push(`${file} → ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

/** `xt.yaml` phẳng `khoá: giá trị` (giá trị có thể trong dấu nháy kép kiểu JSON). */
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

describe("README nêu đúng lệnh trong xt.yaml", () => {
  const xt = xtYaml();
  const readme = read("README.md");
  it.each(["lint", "test", "typecheck", "build", "e2e", "install"])("lệnh %s", (key) => {
    expect(xt[key], `xt.yaml thiếu khoá ${key}`).toBeTruthy();
    expect(readme).toContain(xt[key]);
  });
  it("lệnh init (môi trường từ máy trống)", () => {
    expect(readme).toContain(xt.init);
  });
  it("có các mục bắt buộc", () => {
    for (const h of ["Yêu cầu môi trường", "Cài đặt", "Chạy", "Kiểm tra", "Cấu trúc thư mục", "Tài liệu"])
      expect(readme, h).toMatch(new RegExp(`^## ${h}`, "m"));
  });
});

const semver = (v) => v.split(".").map(Number);
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
/** Chỉ hiểu dạng `>=X.Y.Z <M` (đủ cho `engines.node` của repo). */
function satisfies(version, range) {
  const m = /^>=(\d+\.\d+\.\d+) <(\d+)$/.exec(range.trim());
  if (!m) throw new Error(`khoảng phiên bản không hỗ trợ: ${range}`);
  const v = semver(version);
  return cmp(v, semver(m[1])) >= 0 && v[0] < Number(m[2]);
}

describe("satisfies", () => {
  it.each([
    ["24.22.0", ">=24.11.0 <25", true],
    ["24.11.0", ">=24.11.0 <25", true],
    ["24.10.9", ">=24.11.0 <25", false],
    ["25.0.0", ">=24.11.0 <25", false],
    ["24.99.99", ">=24.11.0 <25", true],
  ])("%s ∈ %s = %s", (v, r, ok) => {
    expect(satisfies(v, r)).toBe(ok);
  });
});

describe(".nvmrc", () => {
  const nvmrc = read(".nvmrc").trim();
  const pkg = JSON.parse(read("package.json"));
  it("là X.Y.Z đầy đủ, một dòng", () => {
    expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
    expect(read(".nvmrc").trimEnd().split("\n")).toHaveLength(1);
  });
  it("nằm trong engines.node", () => {
    expect(satisfies(nvmrc, pkg.engines.node)).toBe(true);
  });
  it("mọi workflow dùng đúng .nvmrc: `node-version-file: .nvmrc`, không ghi cứng `node-version:` (PRF-WEB-010)", () => {
    const dir = join(ROOT, ".github/workflows");
    let setups = 0;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, `${f} ghi cứng node-version`).not.toMatch(/^\s*node-version:/m);
      const uses = [...text.matchAll(/uses:\s*actions\/setup-node@/g)].length;
      const files = [...text.matchAll(/^\s*node-version-file:\s*\.nvmrc\s*$/gm)].length;
      expect(files, `${f}: mỗi setup-node phải có node-version-file: .nvmrc`).toBe(uses);
      setups += uses;
    }
    expect(setups).toBeGreaterThan(0);
  });
  it("pnpm/action-setup không ghi cứng version (đọc `packageManager` của package.json)", () => {
    const dir = join(ROOT, ".github/workflows");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, `${f}: pnpm/action-setup ghi cứng version`).not.toMatch(
        /pnpm\/action-setup@[^\n]*\n\s+with:\n(?:\s+[\w-]+:[^\n]*\n)*?\s+version:/,
      );
    }
    expect(JSON.parse(read("package.json")).packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });
  it("bằng NODE_VERSION của scripts/dev-env-setup.sh", () => {
    expect(/^NODE_VERSION="([\d.]+)"/m.exec(read("scripts/dev-env-setup.sh"))?.[1]).toBe(nvmrc);
  });
});

describe("phiên bản sản phẩm", () => {
  it("package.json gốc có version SemVer", () => {
    expect(JSON.parse(read("package.json")).version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});

describe("CHANGELOG.md", () => {
  const changelog = read("CHANGELOG.md");
  it("theo Keep a Changelog và có [Unreleased]", () => {
    expect(changelog).toMatch(/^## \[Unreleased\]\s*$/m);
    expect(changelog).toContain("keepachangelog.com/en/1.1.0");
  });
  it("[Unreleased] không rỗng", () => {
    const body = changelog.split(/^## \[Unreleased\]\s*$/m)[1]?.split(/^## /m)[0] ?? "";
    expect(body.trim().length).toBeGreaterThan(0);
  });
});

describe("cấu hình repo", () => {
  it(".gitattributes chuẩn hoá cuối dòng", () => {
    const ga = read(".gitattributes");
    expect(ga).toMatch(/^\* text=auto( |$)/m);
    expect(ga).toMatch(/^\*\.sh text eol=lf/m);
    expect(ga).toMatch(/^\*\.png binary/m);
  });
  it(".editorconfig đặt utf-8, lf, 2 space (Python 4)", () => {
    const ec = read(".editorconfig");
    expect(ec).toMatch(/^root = true/m);
    expect(ec).toMatch(/^charset = utf-8/m);
    expect(ec).toMatch(/^end_of_line = lf/m);
    expect(ec).toMatch(/^indent_size = 2/m);
    expect(ec).toMatch(/\[\*\.py\]\s*\nindent_size = 4/);
  });
  it(".gitignore bỏ file IDE/OS", () => {
    const lines = read(".gitignore").split("\n");
    for (const entry of [".vscode/", ".idea/", ".DS_Store", "Thumbs.db"]) expect(lines).toContain(entry);
  });
  it("mẫu PR là của sản phẩm, đủ mục", () => {
    const t = read(".github/pull_request_template.md");
    expect(t).not.toMatch(/xt\.py validate|unittest discover -s tests/);
    for (const h of [
      "Mục tiêu / SPEC",
      "Thay đổi",
      "Bằng chứng cổng",
      "Tiêu chí chấp nhận",
      "Docs cập nhật / không cần",
      "Migration",
      "Rủi ro",
      "Checklist bảo mật",
    ])
      expect(t, h).toMatch(new RegExp(`^## ${h}`, "m"));
    expect(t).toMatch(/Backup trước migrate/);
    expect(t).toMatch(/Đường lùi/);
  });
});

// T-706 (PM-HANDOVER-002, D-056): gói bàn giao tồn tại và khớp nhau. Kiểm máy của `test -f README.md -a -f RUNBOOK.md -a -d docs/adr`,
// thêm PROGRESS.md, sổ rủi ro, danh sách tài khoản (không bí mật); RUNBOOK.md ở gốc chỉ TRỎ tới docs/RUNBOOK.md (không nhân đôi);
// "clean clone build" = job `quality` của CI (checkout sạch + `pnpm install --frozen-lockfile` + cổng gồm build), không workflow riêng.
describe("gói bàn giao (PM-HANDOVER-002)", () => {
  const isFile = (rel) => existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isFile();
  const isDir = (rel) => existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isDirectory();

  it.each([
    "README.md",
    "RUNBOOK.md",
    "PROGRESS.md",
    "docs/RUNBOOK.md",
    "docs/RISKS.md",
    "docs/handover/accounts.md",
  ])("%s tồn tại và không rỗng", (f) => {
    expect(isFile(f), f).toBe(true);
    expect(read(f).trim().length, f).toBeGreaterThan(50);
  });

  it("docs/adr là thư mục có ít nhất một ADR đánh số", () => {
    expect(isDir("docs/adr")).toBe(true);
    expect(
      readdirSync(join(ROOT, "docs/adr")).filter((n) => /^\d{4}-.+\.md$/.test(n)).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("RUNBOOK.md ở gốc trỏ docs/RUNBOOK.md và không nhân đôi nội dung", () => {
    const root = read("RUNBOOK.md");
    expect(relativeLinkTargets(root)).toContain("docs/RUNBOOK.md");
    expect(root.split("\n").length).toBeLessThanOrEqual(30);
    // Không chép mục của runbook thật (mục đánh số `## N.`) sang bản gốc.
    const realSections = [...read("docs/RUNBOOK.md").matchAll(/^## (\d+\. .+)$/gm)].map((m) => m[1]);
    expect(realSections.length).toBeGreaterThan(3);
    for (const h of realSections) expect(root, h).not.toContain(h);
  });

  it("mọi file trong gói bàn giao được README hoặc RUNBOOK.md ở gốc dẫn tới", () => {
    const links = new Set([
      ...relativeLinkTargets(read("README.md")),
      ...relativeLinkTargets(read("RUNBOOK.md")),
    ]);
    const has = (t) => [...links].some((l) => l === t || l.startsWith(`${t}`));
    for (const t of [
      "docs/RUNBOOK.md",
      "docs/adr",
      "PROGRESS.md",
      "docs/RISKS.md",
      "docs/handover/accounts.md",
    ])
      expect(has(t), `README/RUNBOOK.md không dẫn tới ${t}`).toBe(true);
    expect([...links].some((l) => l === "RUNBOOK.md" || l === "docs/RUNBOOK.md")).toBe(true);
  });

  it("danh sách tài khoản không chứa bí mật dạng giá trị", () => {
    const t = read("docs/handover/accounts.md");
    expect(t).not.toMatch(/(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{8,}/i);
    expect(t).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/);
  });

  it("clean clone build = job gate (nằm dưới job gom quality) của CI: checkout sạch → install --frozen-lockfile → cổng có build", () => {
    const ci = read(".github/workflows/ci.yml");
    const gateJob = /^ {2}gate:\n([\s\S]*?)(?=^ {2}[a-z][\w-]*:\n)/m.exec(ci)?.[1] ?? "";
    expect(gateJob.length).toBeGreaterThan(0);
    const at = (needle) => gateJob.indexOf(needle);
    expect(at("actions/checkout")).toBeGreaterThan(-1);
    expect(at("pnpm install --frozen-lockfile")).toBeGreaterThan(at("actions/checkout"));
    expect(at("dev-task.sh gate")).toBeGreaterThan(at("pnpm install --frozen-lockfile"));
    // Cổng (`gate` = build → typecheck → lint → test) chỉ có nghĩa nếu `build` trong xt.yaml là lệnh thật.
    expect(xtYaml().build).toMatch(/pnpm .*build/);
    expect(read(".xtemplates/scripts/dev-task.sh")).toMatch(/gate/);
  });
});
