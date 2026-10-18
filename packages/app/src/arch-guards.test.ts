// PLAN đợt 4 T-306 — rào cấu trúc chạy trong `pnpm test` (không đổi cấu hình cổng/CI):
//   · lint migration mới: cấm DROP COLUMN / RENAME COLUMN / ALTER COLUMN … TYPE / DROP TABLE / RENAME TO / .dropColumn()… trừ khi đánh dấu expand-contract (DB-MIG-008, OPS-DEPLOY-003)
//   · tên ADR `NNNN-slug` không trùng/hở số (ARC-ADR-002)
//   · packages/domain không import hạ tầng I/O (ARC-MOD-003)
//   · không vòng phụ thuộc MỚI giữa thư mục module của packages/app (ARC-MOD-004) — ratchet theo arch-guards.baseline.json
//   · module của packages/app chỉ import module khác qua điểm công khai `<module>/index.ts` (ARC-MOD-005) — cấm tuyệt đối, không còn nền
//   · không dùng định dạng thời gian theo locale/toString ở mã chạy (BASE-DATA-006)
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import baseline from "./arch-guards.baseline.json" with { type: "json" };

const ROOT = new URL("../../../", import.meta.url).pathname;
const APP_SRC = join(ROOT, "packages/app/src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const isTest = (f: string) => /\.test\.(ts|tsx|mjs)$/.test(f);
const productTs = (dir: string) => walk(dir).filter((f) => /\.tsx?$/.test(f) && !isTest(f));

// ───────────────────────── lint migration (DB-MIG-008) ─────────────────────────

/** Migration có số > ngưỡng mới bị lint. Ngưỡng = số lớn nhất lúc viết rào (0046); 0001…0046 đã áp, không đụng. */
const LINT_FROM = 47;
/**
 * Dấu `contract` (OPS-DEPLOY-003): `-- expand-contract: contract sau expand ở release vX.Y.Z — <lý do>` (gạch ngang `-`, `–` hoặc `—`).
 * Phải ghi release đã phát hành bước expand (code cũ không còn đọc cột) và lý do; thiếu một trong hai → không được chấp nhận.
 * Nhóm 1 = số phiên bản. Mã nguồn được chuẩn hoá NFC trước khi so (dấu tiếng Việt tổ hợp/dựng sẵn đều khớp).
 */
const MARKER =
  /--\s*expand-contract:\s*contract\s+sau\s+expand\s+ở\s+release\s+v?(\d+\.\d+\.\d+)\s+[-–—]\s+\S{3,}/;
const FORBIDDEN: [string, RegExp][] = [
  ["DROP COLUMN", /\bDROP\s+COLUMN\b/i],
  ["RENAME COLUMN", /\bRENAME\s+COLUMN\b/i],
  ["ALTER COLUMN … TYPE", /\bALTER\s+COLUMN\s+("[^"]+"|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b/i],
  ["DROP TABLE", /\bDROP\s+TABLE\b/i],
  ["Kysely .dropColumn()", /\.\s*dropColumn\s*\(/],
  ["Kysely .renameColumn()", /\.\s*renameColumn\s*\(/],
  ["Kysely .dropTable()", /\.\s*dropTable\s*\(/],
  ["Kysely .renameTo()", /\.\s*renameTo\s*\(/],
];
/** Câu lệnh nhiều dòng `ALTER TABLE … RENAME TO …`: vị trí (chỉ số trong chuỗi) của cụm `RENAME TO` — dòng đó là dòng được kiểm dấu. */
const RENAME_TABLE = /\bALTER\s+TABLE\b[^;]*?(\bRENAME\s+TO\b)/gi;

/** Phiên bản đã phát hành theo CHANGELOG (`## [X.Y.Z]`, bỏ `Unreleased`). Nguồn duy nhất: tag git không có trong clone nông của CI. */
function releasedVersions(changelog: string): Set<string> {
  return new Set([...changelog.matchAll(/^##\s+\[v?(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1] as string));
}

/**
 * Vi phạm trong mã nguồn một migration. Phần `DOWN` (đường lùi) được bỏ qua — đảo `ADD COLUMN` bằng `DROP COLUMN` là đúng.
 * Một câu lệnh cấm được chấp nhận khi dòng đó hoặc dòng không-trống ngay phía trên có dấu `MARKER` (kèm release của bước expand).
 * `released` (nếu có): release trong dấu phải là bản đã phát hành (CHANGELOG) — không được viện một release chưa có.
 */
function lintMigration(source: string, released?: Set<string>): string[] {
  const up = source.normalize("NFC").replace(/const\s+DOWN\s*=\s*`[\s\S]*?`;/, "");
  const lines = up.split("\n");
  const found: string[] = [];
  const hits: [number, string][] = [];
  lines.forEach((line, i) => {
    for (const [label, re] of FORBIDDEN) if (re.test(line)) hits.push([i, label]);
  });
  for (const m of up.matchAll(RENAME_TABLE)) {
    const at = m.index + m[0].length - (m[1] as string).length;
    hits.push([up.slice(0, at).split("\n").length - 1, "ALTER TABLE … RENAME TO"]);
  }
  for (const [i, label] of hits.sort((a, b) => a[0] - b[0])) {
    const line = lines[i] ?? "";
    let prev = i - 1;
    while (prev >= 0 && (lines[prev] ?? "").trim() === "") prev--;
    const marker = MARKER.exec(line) ?? MARKER.exec(lines[prev] ?? "");
    if (!marker)
      found.push(
        `dòng ${i + 1}: ${label} không có "-- expand-contract: contract sau expand ở release vX.Y.Z — <lý do>"`,
      );
    else if (released && !released.has(marker[1] as string))
      found.push(
        `dòng ${i + 1}: ${label} viện release v${marker[1]} chưa có trong CHANGELOG.md (chưa phát hành)`,
      );
  }
  return found;
}

const migrationNumber = (f: string) => Number(/^(\d{4})_/.exec(basename(f))?.[1] ?? Number.NaN);

describe("arch-guards — lint migration mới (DB-MIG-008, OPS-DEPLOY-003)", () => {
  const dir = join(ROOT, "packages/db/src/migrations");
  const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.ts$/.test(f));

  it("ngưỡng lint = số migration lớn nhất lúc viết rào (không lùi ngưỡng để né)", () => {
    const max = Math.max(...files.map(migrationNumber));
    expect(max).toBeGreaterThanOrEqual(LINT_FROM - 1);
    expect(LINT_FROM).toBe(47);
  });

  it(`migration số ≥ ${LINT_FROM} không có DROP/RENAME COLUMN/TABLE, ALTER COLUMN TYPE nếu không đánh dấu expand-contract (release đã phát hành)`, () => {
    const released = releasedVersions(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"));
    const bad = files
      .filter((f) => migrationNumber(f) >= LINT_FROM)
      .flatMap((f) => lintMigration(readFileSync(join(dir, f), "utf8"), released).map((m) => `${f}: ${m}`));
    expect(bad).toEqual([]);
  });

  it("lint bắt thêm DROP TABLE, ALTER TABLE … RENAME TO (nhiều dòng) và API Kysely tương ứng; dấu hợp lệ thì qua", () => {
    const ok = "-- expand-contract: contract sau expand ở release v0.3.0 — bảng cũ không còn được đọc";
    expect(lintMigration("DROP TABLE old_t;")).toHaveLength(1);
    expect(lintMigration("drop   table if exists old_t;")).toHaveLength(1);
    expect(lintMigration("ALTER TABLE a RENAME TO b;")).toHaveLength(1);
    expect(lintMigration("ALTER TABLE a\n  RENAME   TO b;")).toHaveLength(1);
    expect(lintMigration("ALTER TABLE a ADD COLUMN c int;\nALTER INDEX i RENAME TO j;")).toEqual([]);
    for (const call of [".dropColumn('x')", ".renameColumn('x', 'y')", ".dropTable('t')", ".renameTo('t2')"])
      expect(lintMigration(`await db.schema.alterTable('t')\n  ${call}\n  .execute();`), call).toHaveLength(
        1,
      );
    expect(lintMigration(`${ok}\nDROP TABLE old_t;`)).toEqual([]);
    expect(lintMigration(`ALTER TABLE a\n  RENAME TO b; ${ok}`)).toEqual([]);
    expect(lintMigration(`${ok}\nALTER TABLE a\n  RENAME TO b;`)).toHaveLength(1); // dấu phải sát dòng có RENAME TO, không chỉ trước ALTER TABLE
    // Đường lùi DOWN của bảng (DROP TABLE đảo CREATE TABLE) được bỏ qua.
    expect(
      lintMigration("const UP = `CREATE TABLE t (id int);`;\nconst DOWN = `\nDROP TABLE t;\n`;"),
    ).toEqual([]);
  });

  it("dấu contract: chấp nhận gạch `-`, `–`, `—`; chuẩn hoá NFC (tổ hợp = dựng sẵn); release phải có trong CHANGELOG", () => {
    const body = (dash: string, text = "cột cũ không còn được đọc") =>
      `ALTER TABLE t DROP COLUMN a; -- expand-contract: contract sau expand ở release v1.2.3 ${dash} ${text}`;
    for (const dash of ["-", "–", "—"]) expect(lintMigration(body(dash)), dash).toEqual([]);
    expect(lintMigration(body("_"))).toHaveLength(1);
    expect(lintMigration(body("—", "ab"))).toHaveLength(1); // lý do quá ngắn
    const decomposed = body("—").normalize("NFD");
    expect(decomposed).not.toBe(body("—"));
    expect(lintMigration(decomposed)).toEqual([]);
    const released = releasedVersions(
      "## [Unreleased]\n\n## [1.2.3] - 2026-11-01\n\n## [v1.0.0] - 2026-10-01\n",
    );
    expect([...released].sort()).toEqual(["1.0.0", "1.2.3"]);
    expect(lintMigration(body("—"), released)).toEqual([]);
    expect(lintMigration(body("—").replace("1.2.3", "9.9.9"), released)[0]).toMatch(
      /v9\.9\.9 chưa có trong CHANGELOG/,
    );
    expect(releasedVersions("## [Unreleased]\n")).toEqual(new Set());
    expect(lintMigration(body("—"), new Set())).toHaveLength(1); // chưa có bản phát hành nào ⇒ chưa được contract
  });

  it("lint bắt đúng: cấm, đánh dấu hợp lệ, đường lùi DOWN, chữ hoa/thường, nhiều khoảng trắng", () => {
    expect(lintMigration("ALTER TABLE t DROP COLUMN a;")).toHaveLength(1);
    expect(lintMigration("alter table t\n  rename   column a to b;")).toHaveLength(1);
    expect(lintMigration('ALTER TABLE t ALTER COLUMN "a" TYPE bigint;')).toHaveLength(1);
    expect(lintMigration("ALTER TABLE t ALTER COLUMN a SET DATA TYPE text;")).toHaveLength(1);
    expect(
      lintMigration("ALTER TABLE t ADD COLUMN a int;\nALTER TABLE t ALTER COLUMN a SET NOT NULL;"),
    ).toEqual([]);
    const ok = "expand-contract: contract sau expand ở release v0.3.0 — cột cũ không còn được đọc";
    expect(lintMigration(`ALTER TABLE t DROP COLUMN a; -- ${ok}`)).toEqual([]);
    expect(lintMigration(`-- ${ok}\n\nALTER TABLE t DROP COLUMN a;`)).toEqual([]);
    // Dấu thiếu release của bước expand / thiếu lý do / không phải bước contract / ở xa câu lệnh → vẫn đỏ.
    expect(lintMigration("-- expand-contract:\nALTER TABLE t DROP COLUMN a;")).toHaveLength(1);
    expect(
      lintMigration("-- expand-contract: bước contract của #123\nALTER TABLE t DROP COLUMN a;"),
    ).toHaveLength(1);
    expect(
      lintMigration(
        "-- expand-contract: contract sau expand ở release v0.3 — x\nALTER TABLE t DROP COLUMN a;",
      ),
    ).toHaveLength(1);
    expect(
      lintMigration(
        "-- expand-contract: contract sau expand ở release v0.3.0 —\nALTER TABLE t DROP COLUMN a;",
      ),
    ).toHaveLength(1);
    expect(lintMigration(`-- ${ok}\nSELECT 1;\nALTER TABLE t DROP COLUMN a;`)).toHaveLength(1);
    // Đường lùi được bỏ qua; nhưng DROP ở UP trước DOWN vẫn bị bắt.
    expect(
      lintMigration(
        "const UP = `ALTER TABLE t ADD COLUMN a int;`;\nconst DOWN = `\nALTER TABLE t DROP COLUMN a;\n`;",
      ),
    ).toEqual([]);
    expect(
      lintMigration(
        "const UP = `\nALTER TABLE t DROP COLUMN a;\n`;\nconst DOWN = `\nALTER TABLE t ADD COLUMN a int;\n`;",
      ),
    ).toHaveLength(1);
  });
});

// ───────────────────────── tên ADR (ARC-ADR-002) ─────────────────────────

describe("arch-guards — ADR đặt tên NNNN-slug, số không trùng/hở", () => {
  const dir = join(ROOT, "docs/adr");
  const NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
  const entries = readdirSync(dir).filter((f) => f !== "README.md");
  // Số đã giữ chỗ cho ADR đang viết ở nhánh khác (0003: numeric đơn giá). Xoá phần tử này khi ADR-0003 vào nhánh chính.
  // Số ADR đã dành chỗ (đang viết ở nhánh khác) — rỗng khi mọi ADR đã có.
  const RESERVED_ADR_NUMBERS: number[] = [];

  /** Trả danh sách lỗi tên/số cho một tập tên tệp. */
  function adrProblems(names: string[]): string[] {
    const problems = names.filter((n) => !NAME.test(n)).map((n) => `tên không đúng NNNN-slug.md: ${n}`);
    const nums = names.flatMap((n) => {
      const m = NAME.exec(n);
      return m ? [Number(m[1])] : [];
    });
    for (const n of new Set(nums.filter((x, i) => nums.indexOf(x) !== i))) problems.push(`trùng số ${n}`);
    const max = Math.max(0, ...nums);
    for (let i = 1; i <= max; i++)
      if (!nums.includes(i) && !RESERVED_ADR_NUMBERS.includes(i))
        problems.push(`hở số ${String(i).padStart(4, "0")}`);
    return problems;
  }

  it("docs/adr hiện tại hợp lệ và có ít nhất ADR-0001", () => {
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(adrProblems(entries)).toEqual([]);
  });

  it("bắt đúng: trùng số, hở số, sai dạng tên", () => {
    expect(adrProblems(["0001-a.md", "0001-b.md"])).toEqual(["trùng số 1"]);
    expect(adrProblems(["0001-a.md", "0003-c.md"])).toEqual(["hở số 0002"]);
    expect(adrProblems(["0001-a.md", "0002_B.md", "adr-3.md"])).toHaveLength(2);
    expect(adrProblems(["001-a.md"])).toHaveLength(1);
    expect(adrProblems([])).toEqual([]);
  });
});

// ───────────────────────── import theo tầng ─────────────────────────

/** Mọi specifier import/export-from/dynamic import/require trong một tệp (đã bỏ chú thích). */
function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  for (const re of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s*["']([^"']+)["']/gm,
  ])
    for (const m of code.matchAll(re)) out.push(m[1] as string);
  return out;
}

const DOMAIN_FORBIDDEN = [
  "kysely",
  "pg",
  "pg-boss",
  "aws4fetch",
  "better-auth",
  "next",
  "@hm/app",
  "@hm/db",
  "node:fs",
  "node:fs/promises",
  "fs",
  "node:net",
  "net",
  "node:http",
  "node:https",
  "http",
  "https",
  "node:child_process",
  "node:dns",
  "node:tls",
];
const forbiddenDomainImport = (spec: string) =>
  DOMAIN_FORBIDDEN.some((f) => spec === f || spec.startsWith(`${f}/`));

describe("arch-guards — packages/domain không import I/O (ARC-MOD-003)", () => {
  const files = productTs(join(ROOT, "packages/domain/src"));

  it("quét được mã miền (không rỗng)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("mã miền (không tính *.test.ts) không import kysely|pg|pg-boss|aws4fetch|node:fs|node:net|node:http… hay @hm/app|@hm/db", () => {
    const bad = files.flatMap((f) =>
      importSpecifiers(readFileSync(f, "utf8"))
        .filter(forbiddenDomainImport)
        .map((s) => `${relative(ROOT, f)} → ${s}`),
    );
    expect(bad).toEqual([]);
  });

  it("bắt đúng các dạng import", () => {
    const src = [
      'import { sql } from "kysely";',
      'import pg from "pg";',
      'const fs = await import("node:fs");',
      'import "node:net";',
      'export * from "node:http";',
      'import { x } from "pg-boss";',
      '// import { y } from "aws4fetch";',
      'import { ok } from "./local.ts";',
      'import { z } from "zod";',
    ].join("\n");
    expect(importSpecifiers(src).filter(forbiddenDomainImport)).toEqual([
      "kysely",
      "pg",
      "node:http",
      "pg-boss",
      "node:fs",
      "node:net",
    ]);
    expect(forbiddenDomainImport("pgx")).toBe(false);
    expect(forbiddenDomainImport("node:path")).toBe(false);
  });
});

// ───────────────────────── vòng phụ thuộc giữa module app (ARC-MOD-004) ─────────────────────────

/** Cạnh 'thư mục -> thư mục' giữa các thư mục cấp một của packages/app/src (bỏ test; tệp ở gốc src không phải module). */
function moduleEdges(files: string[], srcDir: string): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const f of files) {
    const from = relative(srcDir, f).split("/");
    if (from.length < 2) continue;
    for (const spec of importSpecifiers(readFileSync(f, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const to = relative(srcDir, resolve(dirname(f), spec)).split("/");
      if (to[0]?.startsWith("..") || to.length < 2 || to[0] === from[0]) continue;
      const key = `${from[0]}->${to[0]}`;
      if (!edges.has(key)) edges.set(key, new Set());
      edges.get(key)?.add(relative(srcDir, f));
    }
  }
  return edges;
}

/** Cạnh nằm trong một thành phần liên thông mạnh (Tarjan) = cạnh tham gia vòng. */
function cyclicEdges(edgeKeys: string[]): string[] {
  const adj = new Map<string, string[]>();
  for (const k of edgeKeys) {
    const [a, b] = k.split("->") as [string, string];
    adj.set(a, [...(adj.get(a) ?? []), b]);
    if (!adj.has(b)) adj.set(b, []);
  }
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const comp = new Map<string, number>();
  let comps = 0;
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
    }
    if (low.get(v) === index.get(v)) {
      let w: string | undefined;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        comp.set(w, comps);
      } while (w !== v);
      comps++;
    }
  };
  for (const v of adj.keys()) if (!index.has(v)) visit(v);
  return edgeKeys
    .filter((k) => {
      const [a, b] = k.split("->") as [string, string];
      return comp.get(a) === comp.get(b);
    })
    .sort();
}

describe("arch-guards — không vòng phụ thuộc mới giữa module packages/app (ARC-MOD-004, ratchet)", () => {
  const files = productTs(APP_SRC);
  const edges = moduleEdges(files, APP_SRC);
  const current = cyclicEdges([...edges.keys()]);
  // JSON rỗng suy ra kiểu never[]/{} — ép về kiểu thật của nền.
  const base: string[] = baseline.canh_trong_vong;
  const reasons: Record<string, string> = baseline.vong;

  it("đồ thị có đủ module (bảo đảm quét không rỗng)", () => {
    expect(edges.size).toBeGreaterThan(80);
  });

  it("không có cạnh vòng nào ngoài danh sách nền (vòng mới → sửa phụ thuộc, KHÔNG thêm vào nền)", () => {
    const added = current.filter((e) => !base.includes(e));
    expect(
      added.map((e) => `${e} (${[...(edges.get(e) ?? [])].slice(0, 3).join(", ")})`),
      "cạnh mới tạo/nối vòng phụ thuộc",
    ).toEqual([]);
  });

  it("danh sách nền không có mục thừa (vòng đã gỡ thì xoá khỏi nền — ratchet chỉ co lại)", () => {
    expect(base.filter((e) => !current.includes(e))).toEqual([]);
  });

  it("nền được ghi chú lý do cho từng nhóm vòng (nền rỗng ⇒ không còn nhóm nào)", () => {
    expect(Object.keys(reasons).length > 0).toBe(base.length > 0);
    for (const reason of Object.values(reasons)) expect(reason.length).toBeGreaterThan(40);
  });

  it("thuật toán: nhận ra vòng 2 nút, vòng gián tiếp, bỏ qua cạnh một chiều", () => {
    expect(cyclicEdges(["a->b", "b->a", "c->a"])).toEqual(["a->b", "b->a"]);
    expect(cyclicEdges(["a->b", "b->c", "c->a", "c->d"])).toEqual(["a->b", "b->c", "c->a"]);
    expect(cyclicEdges(["a->b", "b->c"])).toEqual([]);
    expect(cyclicEdges([])).toEqual([]);
  });
});

// ───────────────────────── biên module công khai (ARC-MOD-005) ─────────────────────────

/**
 * Điểm công khai của một module = `<module>/index.ts`. Tệp khác của module chỉ được import trong chính module đó.
 * Cạnh vi phạm = 'module nguồn->module đích/tệp' (ví dụ `lease->ledger/ledger.ts`). Tệp ở gốc src (vd. `index.ts` của `@hm/app`)
 * không thuộc module nào nên được import tự do.
 */
function deepImportEdges(files: string[], srcDir: string): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const f of files) {
    const from = relative(srcDir, f).split("/");
    if (from.length < 2) continue;
    for (const spec of importSpecifiers(readFileSync(f, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const to = relative(srcDir, resolve(dirname(f), spec)).split("/");
      if (to[0]?.startsWith("..") || to.length < 2 || to[0] === from[0]) continue;
      if (to.length === 2 && to[1] === "index.ts") continue;
      const key = `${from[0]}->${to.join("/")}`;
      if (!edges.has(key)) edges.set(key, new Set());
      edges.get(key)?.add(relative(srcDir, f));
    }
  }
  return edges;
}

describe("arch-guards — module chỉ import module khác qua index.ts (ARC-MOD-005, cấm tuyệt đối)", () => {
  const files = productTs(APP_SRC);
  const edges = deepImportEdges(files, APP_SRC);

  it("quét được các import chéo module (không rỗng; đã qua index.ts nên đếm theo cạnh thư mục)", () => {
    expect(moduleEdges(files, APP_SRC).size).toBeGreaterThan(80);
  });

  it("không có import tệp nội bộ của module khác — đi qua index.ts của module đích (không còn nền để nới)", () => {
    expect(
      [...edges.keys()].sort().map((e) => `${e} (${[...(edges.get(e) ?? [])].slice(0, 3).join(", ")})`),
      "import tệp nội bộ của module khác",
    ).toEqual([]);
  });

  it("mọi module có mã chạy đều có index.ts (biên công khai)", () => {
    const modules = readdirSync(APP_SRC).filter((n) => statSync(join(APP_SRC, n)).isDirectory());
    const missing = modules.filter(
      (m) => productTs(join(APP_SRC, m)).length > 0 && !readdirSync(join(APP_SRC, m)).includes("index.ts"),
    );
    expect(missing, "module thiếu index.ts").toEqual([]);
    expect(modules.length).toBeGreaterThan(30);
  });

  it("nền arch-guards không còn mục import_noi_bo (đã về 0, chỉ được giữ ở 0)", () => {
    expect("import_noi_bo" in baseline).toBe(false);
  });

  it("bắt đúng: import tệp nội bộ bị phát hiện; index.ts, cùng module, tệp gốc src, ngoài src thì không", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-arch-"));
    try {
      const put = (rel: string, src: string) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), src);
        return join(dir, rel);
      };
      const x = put(
        "a/x.ts",
        'import { v } from "../b/inner.ts";\nimport { w } from "../b/index.ts";\nimport "./y.ts";',
      );
      const y = put(
        "a/y.ts",
        'export const y = await import("../b/deep/inner.ts");\nexport * from "../root.ts";',
      );
      const z = put(
        "c/z.ts",
        'import { q } from "zod";\nimport { r } from "../../outside.ts";\nexport { s } from "../a/index.ts";',
      );
      put("b/inner.ts", "export const v = 1;");
      const got = deepImportEdges([x, y, z], dir);
      expect([...got.keys()].sort()).toEqual(["a->b/deep/inner.ts", "a->b/inner.ts"]);
      expect(deepImportEdges([], dir).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── thời gian ở lớp lưu (BASE-DATA-006) ─────────────────────────

describe("arch-guards — không định dạng thời gian theo locale/toString ở mã chạy (BASE-DATA-006)", () => {
  it("packages/*/src (không tính test) không dùng toLocaleDateString/toLocaleTimeString/Date#toString/toLocaleString trên Date", () => {
    const bad: string[] = [];
    for (const pkg of readdirSync(join(ROOT, "packages")))
      for (const f of productTs(join(ROOT, "packages", pkg, "src"))) {
        readFileSync(f, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (/\.toLocale(Date|Time)String\(|new Date\([^)]*\)\.(toString|toLocaleString)\(/.test(line))
              bad.push(`${relative(ROOT, f)}:${i + 1}`);
          });
      }
    expect(bad).toEqual([]);
  });
});
