// PLAN đợt 4 T-306 — rào cấu trúc chạy trong `pnpm test` (không đổi cấu hình cổng/CI):
//   · lint migration mới: cấm DROP COLUMN / RENAME COLUMN / ALTER COLUMN … TYPE trừ khi đánh dấu expand-contract (DB-MIG-008, OPS-DEPLOY-003)
//   · tên ADR `NNNN-slug` không trùng/hở số (ARC-ADR-002)
//   · packages/domain không import hạ tầng I/O (ARC-MOD-003)
//   · không vòng phụ thuộc MỚI giữa thư mục module của packages/app (ARC-MOD-004) — ratchet theo arch-guards.baseline.json
//   · module của packages/app chỉ import module khác qua điểm công khai `<module>/index.ts` (ARC-MOD-005) — ratchet theo cùng tệp nền
//   · không dùng định dạng thời gian theo locale/toString ở mã chạy (BASE-DATA-006)
import { readdirSync, readFileSync, statSync } from "node:fs";
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
const MARKER = /--\s*expand-contract:\s*\S{3,}/;
const FORBIDDEN: [string, RegExp][] = [
  ["DROP COLUMN", /\bDROP\s+COLUMN\b/i],
  ["RENAME COLUMN", /\bRENAME\s+COLUMN\b/i],
  ["ALTER COLUMN … TYPE", /\bALTER\s+COLUMN\s+("[^"]+"|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b/i],
];

/**
 * Vi phạm trong mã nguồn một migration. Phần `DOWN` (đường lùi) được bỏ qua — đảo `ADD COLUMN` bằng `DROP COLUMN` là đúng.
 * Một câu lệnh cấm được chấp nhận khi dòng đó hoặc dòng không-trống ngay phía trên có `-- expand-contract: <lý do>`.
 */
function lintMigration(source: string): string[] {
  const up = source.replace(/const\s+DOWN\s*=\s*`[\s\S]*?`;/, "");
  const lines = up.split("\n");
  const found: string[] = [];
  lines.forEach((line, i) => {
    for (const [label, re] of FORBIDDEN) {
      if (!re.test(line)) continue;
      let prev = i - 1;
      while (prev >= 0 && (lines[prev] ?? "").trim() === "") prev--;
      const marked = MARKER.test(line) || MARKER.test(lines[prev] ?? "");
      if (!marked) found.push(`dòng ${i + 1}: ${label} không có "-- expand-contract: <lý do>"`);
    }
  });
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

  it(`migration số ≥ ${LINT_FROM} không có DROP/RENAME COLUMN, ALTER COLUMN TYPE nếu không đánh dấu expand-contract`, () => {
    const bad = files
      .filter((f) => migrationNumber(f) >= LINT_FROM)
      .flatMap((f) => lintMigration(readFileSync(join(dir, f), "utf8")).map((m) => `${f}: ${m}`));
    expect(bad).toEqual([]);
  });

  it("lint bắt đúng: cấm, đánh dấu hợp lệ, đường lùi DOWN, chữ hoa/thường, nhiều khoảng trắng", () => {
    expect(lintMigration("ALTER TABLE t DROP COLUMN a;")).toHaveLength(1);
    expect(lintMigration("alter table t\n  rename   column a to b;")).toHaveLength(1);
    expect(lintMigration('ALTER TABLE t ALTER COLUMN "a" TYPE bigint;')).toHaveLength(1);
    expect(lintMigration("ALTER TABLE t ALTER COLUMN a SET DATA TYPE text;")).toHaveLength(1);
    expect(
      lintMigration("ALTER TABLE t ADD COLUMN a int;\nALTER TABLE t ALTER COLUMN a SET NOT NULL;"),
    ).toEqual([]);
    expect(lintMigration("ALTER TABLE t DROP COLUMN a; -- expand-contract: bước contract của #123")).toEqual(
      [],
    );
    expect(
      lintMigration(
        "-- expand-contract: cột cũ đã không còn được đọc từ 0.3\n\nALTER TABLE t DROP COLUMN a;",
      ),
    ).toEqual([]);
    // Dấu không kèm lý do, hoặc ở xa câu lệnh → vẫn đỏ.
    expect(lintMigration("-- expand-contract:\nALTER TABLE t DROP COLUMN a;")).toHaveLength(1);
    expect(lintMigration("-- expand-contract: lý do\nSELECT 1;\nALTER TABLE t DROP COLUMN a;")).toHaveLength(
      1,
    );
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

describe("arch-guards — module chỉ import module khác qua index.ts (ARC-MOD-005, ratchet)", () => {
  const files = productTs(APP_SRC);
  const edges = deepImportEdges(files, APP_SRC);
  const current = [...edges.keys()].sort();
  const base = Object.entries(baseline.import_noi_bo).flatMap(([from, targets]) =>
    targets.map((t) => `${from}->${t}`),
  );

  it("quét được các import chéo module (không rỗng; đã qua index.ts nên đếm theo cạnh thư mục)", () => {
    expect(moduleEdges(files, APP_SRC).size).toBeGreaterThan(80);
  });

  it("không có import nội bộ mới ngoài danh sách nền (đi qua index.ts của module đích, KHÔNG thêm vào nền)", () => {
    const added = current.filter((e) => !base.includes(e));
    expect(
      added.map((e) => `${e} (${[...(edges.get(e) ?? [])].slice(0, 3).join(", ")})`),
      "import tệp nội bộ của module khác",
    ).toEqual([]);
  });

  it("danh sách nền không có mục thừa (đã chuyển sang index.ts thì xoá khỏi nền — ratchet chỉ co lại)", () => {
    expect(base.filter((e) => !current.includes(e))).toEqual([]);
  });

  it("nền được sắp xếp và không trùng (diff gọn, dễ review)", () => {
    for (const targets of Object.values(baseline.import_noi_bo))
      expect(targets).toEqual([...new Set(targets)].sort());
    expect(Object.keys(baseline.import_noi_bo)).toEqual(Object.keys(baseline.import_noi_bo).sort());
  });

  it("module đã có index.ts thì module khác không còn import tệp nội bộ của nó (đã gỡ hết)", () => {
    for (const mod of ["actor-core", "pipeline"])
      expect(
        current.filter((e) => e.split("->")[1]?.startsWith(`${mod}/`)),
        `${mod} có index.ts — import qua index.ts`,
      ).toEqual([]);
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
