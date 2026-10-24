#!/usr/bin/env node
// Ratchet chuỗi viết thẳng (XC-I18N-001, D-073): đếm chuỗi tiếng Việt (có dấu) viết thẳng trong mã người dùng thấy — JSX text và
// literal "…"/'…'/`…` — theo từng tệp, trên AST (D-078; trước đó regex đếm lệch sau template lồng). Số đếm chỉ được GIẢM so với
// `scripts/i18n-literal-baseline.json`; tệp chưa có trong baseline phải = 0 (chuỗi mới đi qua `t()` của apps/web/lib/i18n.ts).
// Bỏ chú thích, test, e2e. Chuyển xong một tệp thì hạ baseline (`node scripts/i18n-literals.mjs --write`) trong cùng PR. Mục
// tiêu: baseline rỗng.
// Ngoại lệ theo tệp (D-105): `scripts/i18n-literal-exempt.json` = { "đường/dẫn": "lý do" } cho tệp mà MỌI chuỗi tiếng Việt chỉ người
// vận hành/nhà phát triển thấy (log, mô tả metric, lỗi cấu hình lúc khởi động, mô tả OpenAPI…). Tệp ngoại lệ không bị đếm; lý do
// rỗng/thiếu, tệp không tồn tại hoặc nằm ngoài phạm vi quét ⇒ lỗi. Tệp riêng (không gộp vào baseline) để `--write` không xoá
// ngoại lệ và rào "baseline chỉ hạ" vẫn đọc baseline là { tệp: số }. Thêm ngoại lệ = một dòng hiện rõ trong diff cho reviewer.
// `--strict`: thoát ≠ 0 khi còn bất kỳ tệp (ngoài ngoại lệ) nào có chuỗi viết thẳng — trong baseline hoặc lần quét này.
// Dùng: node scripts/i18n-literals.mjs [--write] [--strict]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";
import { parseSource, walk } from "./ts-ast.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const BASELINE = join(ROOT, "scripts/i18n-literal-baseline.json");
export const EXEMPT = join(ROOT, "scripts/i18n-literal-exempt.json");
export const SCOPE = [
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "apps/worker/src",
  "packages/app/src",
];
const VI = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

/** Số chuỗi tiếng Việt viết thẳng trong một tệp: mỗi StringLiteral, mỗi template literal (một lần dù nhiều đoạn quanh `${…}`) và
 * mỗi đoạn chữ JSX (chữ trước và sau `{n}` là hai đoạn) có dấu tiếng Việt. Chú thích không phải nút AST nên không bị đếm. */
export function countLiterals(src, file) {
  // Giá trị đã giải mã (`\u00f2` trong template là `cooked`) và chuẩn NFC (chữ tổ hợp `o` + dấu huyền vẫn là "ò").
  const vi = (s) => s != null && VI.test(s.normalize("NFC"));
  let n = 0;
  walk(parseSource(src, file).program, (node) => {
    if (
      (node.type === "StringLiteral" && vi(node.value)) ||
      (node.type === "JSXText" && vi(node.value)) ||
      (node.type === "TemplateLiteral" && node.quasis.some((q) => vi(q.value.cooked ?? q.value.raw)))
    )
      n++;
  });
  return n;
}

const files = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n.startsWith(".") || n === "e2e" || n === "testing") return [];
    return statSync(p).isDirectory()
      ? files(p)
      : /\.(tsx?|mjs)$/.test(n) && !/\.(test|spec)\./.test(n)
        ? [p]
        : [];
  });

/**
 * { "đường/dẫn": số } cho mọi tệp có chuỗi viết thẳng trong phạm vi, trừ tệp ngoại lệ (`exempt`: { tệp: lý do }; mặc định đọc
 * `scripts/i18n-literal-exempt.json` của chính `root` — không có tệp đó thì không ngoại lệ nào).
 */
export function scan(root = ROOT, exempt = loadExempt(join(root, "scripts/i18n-literal-exempt.json"))) {
  const out = {};
  for (const d of SCOPE)
    for (const f of files(join(root, d))) {
      if (Object.hasOwn(exempt, relative(root, f).split("\\").join("/"))) continue;
      const n = countLiterals(readFileSync(f, "utf8"), f);
      if (n > 0) out[relative(root, f)] = n;
    }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Lỗi khi số đếm tăng so với baseline (tệp mới phải = 0). */
export function regressions(current, baseline) {
  return Object.entries(current)
    .filter(([f, n]) => n > (baseline[f] ?? 0))
    .map(
      ([f, n]) =>
        `${f}: ${n} chuỗi viết thẳng > ngưỡng ${baseline[f] ?? 0} — dùng t() và khoá trong apps/web/messages/vi.json`,
    );
}

/**
 * Dòng baseline bị nâng so với `before` (baseline trên main) mà vượt số đếm của chính tệp đó trên main (`countOnBase(f)`, tệp
 * chưa có trên main → 0). Bộ đếm không đổi thì main đã qua ratchet nên số đếm trên main ≤ baseline của main ⇒ mọi lần nâng đều
 * bị bắt; chỉ khi bộ đếm chặt hơn (D-078) mới nâng được, và chỉ tới đúng số chuỗi đã có sẵn trên main — PR không thể vừa đổi
 * bộ đếm vừa thêm chuỗi.
 */
export function unjustifiedRaises(now, before, countOnBase) {
  return Object.entries(now)
    .filter(([f, n]) => n > (before[f] ?? 0) && n > countOnBase(f))
    .map(
      ([f, n]) => `${f}: baseline ${before[f] ?? 0} → ${n} nhưng trên main chỉ có ${countOnBase(f)} chuỗi`,
    );
}

/**
 * Lỗi của danh sách ngoại lệ `{ "đường/dẫn": "lý do" }` (D-105): không phải object; lý do không phải chuỗi hoặc rỗng; tệp không
 * tồn tại; tệp nằm ngoài SCOPE hoặc là tệp test/e2e (vốn không bị đếm); tệp không còn chuỗi nào (ngoại lệ thừa che mắt reviewer —
 * chuỗi người dùng thấy thêm sau vào tệp đó sẽ lọt).
 */
export function exemptErrors(exempt, root = ROOT) {
  if (typeof exempt !== "object" || exempt === null || Array.isArray(exempt))
    return ['ngoại lệ phải là object { "đường/dẫn": "lý do" }'];
  const errors = [];
  for (const [f, reason] of Object.entries(exempt)) {
    if (typeof reason !== "string" || !reason.trim()) errors.push(`${f}: ngoại lệ thiếu lý do`);
    const p = join(root, f);
    if (!existsSync(p) || !statSync(p).isFile()) errors.push(`${f}: tệp ngoại lệ không tồn tại`);
    else if (
      !SCOPE.some((d) => f.startsWith(`${d}/`)) ||
      !/\.(tsx?|mjs)$/.test(f) ||
      /\.(test|spec)\./.test(f) ||
      /(^|\/)(e2e|testing|node_modules)\//.test(f)
    )
      errors.push(`${f}: tệp ngoại lệ nằm ngoài phạm vi quét (${SCOPE.join(", ")})`);
    else if (countLiterals(readFileSync(p, "utf8"), p) === 0)
      errors.push(`${f}: ngoại lệ thừa (0 chuỗi viết thẳng) — bỏ khỏi danh sách`);
  }
  return errors;
}

/** Tệp (ngoài ngoại lệ) còn chuỗi viết thẳng — trong baseline hoặc lần quét — cho `--strict` (mục tiêu: rỗng). */
export function remaining(current, baseline, exempt = {}) {
  const left = new Set(
    [...Object.entries(baseline), ...Object.entries(current)]
      .filter(([f, n]) => n > 0 && !Object.hasOwn(exempt, f))
      .map(([f]) => f),
  );
  return [...left].sort();
}

export function loadExempt(path = EXEMPT) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

if (isMain(import.meta.url)) {
  const exempt = loadExempt();
  const exErrs = exemptErrors(exempt);
  if (exErrs.length) {
    for (const e of exErrs) console.error(e);
    console.error(`[i18n-literals] ${exErrs.length} lỗi ở ${relative(ROOT, EXEMPT)}`);
    process.exit(1);
  }
  const current = scan(ROOT, exempt);
  if (process.argv.includes("--write")) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`[i18n-literals] ghi baseline: ${Object.keys(current).length} tệp`);
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  const errs = regressions(current, baseline);
  if (process.argv.includes("--strict"))
    for (const f of remaining(current, baseline, exempt))
      errs.push(
        `${f}: còn ${current[f] ?? 0} chuỗi viết thẳng (baseline ${baseline[f] ?? 0}) — --strict cần 0 ngoài ngoại lệ`,
      );
  for (const e of errs) console.error(e);
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  console.log(
    `[i18n-literals] ${total} chuỗi viết thẳng trong ${Object.keys(current).length} tệp · ${Object.keys(exempt).length} tệp ngoại lệ · ${errs.length} lỗi`,
  );
  process.exit(errs.length ? 1 : 0);
}
