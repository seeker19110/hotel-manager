#!/usr/bin/env node
// Ratchet chuỗi viết thẳng (XC-I18N-001, D-073): đếm chuỗi tiếng Việt (có dấu) viết thẳng trong mã người dùng thấy — JSX text và
// literal "…"/'…'/`…` — theo từng tệp, trên AST (D-078; trước đó regex đếm lệch sau template lồng). Số đếm chỉ được GIẢM so với
// `scripts/i18n-literal-baseline.json`; tệp chưa có trong baseline phải = 0 (chuỗi mới đi qua `t()` của apps/web/lib/i18n.ts).
// Bỏ chú thích, test, e2e. Chuyển xong một tệp thì hạ baseline (`node scripts/i18n-literals.mjs --write`) trong cùng PR. Mục
// tiêu: baseline rỗng.
// Ngoại lệ theo tệp (D-105): `scripts/i18n-literal-exempt.json` = { "đường/dẫn": { "reason": "lý do", "max": N } } cho tệp mà MỌI
// chuỗi tiếng Việt chỉ người vận hành/nhà phát triển thấy (log, mô tả metric, lỗi cấu hình lúc khởi động, mô tả OpenAPI…). Tệp
// ngoại lệ không vào baseline; lý do rỗng/thiếu, max thiếu, tệp không tồn tại hoặc ngoài phạm vi quét ⇒ lỗi. Số chuỗi của tệp phải
// BẰNG max (T-2207): > max ⇒ lỗi (chuỗi mới không lọt im lặng), < max ⇒ lỗi tới khi hạ (`--write` chỉ hạ).
// Thông điệp ra API (`API_MESSAGE_CALLS`: CommandError, fieldError, simpleProblem, AuthzError, AccessError, TransitionError) có
// chuỗi tiếng Việt viết thẳng ⇒ lỗi ở MỌI tệp trong phạm vi, kể cả tệp ngoại lệ (T-2207). Tệp riêng (không gộp vào baseline) để `--write` không xoá
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
  "packages/domain/src",
  "packages/db/src",
];
const VI = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

// Giá trị đã giải mã (`\u00f2` trong template là `cooked`) và chuẩn NFC (chữ tổ hợp `o` + dấu huyền vẫn là "ò").
const vi = (s) => s != null && VI.test(s.normalize("NFC"));
/** Nút là một chuỗi tiếng Việt viết thẳng: StringLiteral, JSXText, hoặc template literal có ít nhất một đoạn có dấu. */
const viLiteral = (node) =>
  ((node.type === "StringLiteral" || node.type === "JSXText") && vi(node.value)) ||
  (node.type === "TemplateLiteral" && node.quasis.some((q) => vi(q.value.cooked ?? q.value.raw)));

/** Số chuỗi tiếng Việt viết thẳng trong một tệp: mỗi StringLiteral, mỗi template literal (một lần dù nhiều đoạn quanh `${…}`) và
 * mỗi đoạn chữ JSX (chữ trước và sau `{n}` là hai đoạn) có dấu tiếng Việt. Chú thích không phải nút AST nên không bị đếm. */
export function countLiterals(src, file) {
  let n = 0;
  walk(parseSource(src, file).program, (node) => {
    if (viLiteral(node)) n++;
  });
  return n;
}

/**
 * Hàm/lớp mà thông điệp đi thẳng ra API (problem+json): `new CommandError(code, status, message, opts)`, `fieldError(field,
 * code, message)` (packages/app/src/pipeline/problem.ts), `simpleProblem(code, status, title, …)` (http/command-route.ts),
 * `new AuthzError(code, message)` (packages/domain access/authorize.ts), `new AccessError(code, message)` (actor-core/actor.ts),
 * `new TransitionError(machine, from, to)` (domain state/machine.ts — mọi đối số vào message).
 */
export const API_MESSAGE_CALLS = [
  "CommandError",
  "fieldError",
  "simpleProblem",
  "AuthzError",
  "AccessError",
  "TransitionError",
];

/**
 * Chuỗi tiếng Việt viết thẳng nằm TRONG đối số (ở bất kỳ độ sâu nào — kể cả `opts.extensions`, vì cũng ra problem+json) của lời
 * gọi `API_MESSAGE_CALLS` — gọi trực tiếp, qua thuộc tính (`x.fieldError(…)`) hoặc tên import đổi (`import { CommandError as
 * E }`). Trả `["tệp:dòng: Tên(…) …"]`. Biến, `t("khoá")`, chuỗi không dấu thì không tính (khoá catalog là ASCII).
 */
export function apiMessageLiterals(src, file) {
  const program = parseSource(src, file).program;
  const names = new Map(API_MESSAGE_CALLS.map((n) => [n, n]));
  for (const d of program.body)
    if (d.type === "ImportDeclaration")
      for (const s of d.specifiers) {
        const imported = s.type === "ImportSpecifier" ? (s.imported.name ?? s.imported.value) : null;
        if (imported && API_MESSAGE_CALLS.includes(imported)) names.set(s.local.name, imported);
      }
  const calleeName = (c) =>
    c.type === "Identifier"
      ? c.name
      : (c.type === "MemberExpression" || c.type === "OptionalMemberExpression") &&
          !c.computed &&
          c.property.type === "Identifier"
        ? c.property.name
        : null;
  const out = [];
  const seen = new Set(); // lời gọi lồng nhau (fieldError trong CommandError) không báo trùng một chuỗi
  walk(program, (node) => {
    if (!["NewExpression", "CallExpression", "OptionalCallExpression"].includes(node.type)) return;
    const name = names.get(calleeName(node.callee) ?? "");
    if (!name) return;
    for (const arg of node.arguments)
      walk(arg, (n) => {
        if (viLiteral(n) && !seen.has(n) && seen.add(n))
          out.push(
            `${file}:${n.loc.start.line}: ${name}(…) có chuỗi tiếng Việt viết thẳng — thông điệp ra API phải qua t("…") của catalog (kể cả tệp ngoại lệ)`,
          );
      });
  });
  return out;
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
 * { "đường/dẫn": số } cho mọi tệp có chuỗi viết thẳng trong phạm vi, trừ tệp ngoại lệ (`exempt`: { tệp: { reason, max } }; mặc định đọc
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
        `${f}: ${n} chuỗi viết thẳng > ngưỡng ${baseline[f] ?? 0} — dùng t() và khoá trong catalog của gói (apps/web, packages/app hoặc packages/domain: messages/vi.json)`,
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

/** Tệp nằm trong phạm vi quét (đường dẫn tương đối gốc, dấu `/`): dưới SCOPE, đuôi .ts/.tsx/.mjs, không test/e2e/testing. */
const inScope = (f) =>
  SCOPE.some((d) => f.startsWith(`${d}/`)) &&
  /\.(tsx?|mjs)$/.test(f) &&
  !/\.(test|spec)\./.test(f) &&
  !/(^|\/)(e2e|testing|node_modules)\//.test(f);

/**
 * Lỗi của danh sách ngoại lệ `{ "đường/dẫn": { "reason": "lý do", "max": N } }` (D-105): không phải object; mục không phải
 * object; lý do không phải chuỗi hoặc rỗng; `max` không phải số nguyên ≥ 1; tệp không tồn tại; tệp nằm ngoài SCOPE hoặc là tệp
 * test/e2e (vốn không bị đếm); tệp không còn chuỗi nào (ngoại lệ thừa che mắt reviewer); số chuỗi > max (chuỗi mới lọt vào tệp
 * ngoại lệ — người dùng thấy thì qua t(), chỉ vận hành thì nâng max: một dòng hiện rõ trong diff); số chuỗi < max (hạ max bằng
 * `--write` — max luôn bằng đúng số đếm để mọi chuỗi thêm sau đều buộc sửa danh sách).
 */
export function exemptErrors(exempt, root = ROOT) {
  if (typeof exempt !== "object" || exempt === null || Array.isArray(exempt))
    return ['ngoại lệ phải là object { "đường/dẫn": { "reason": "lý do", "max": N } }'];
  const errors = [];
  for (const [f, e] of Object.entries(exempt)) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      errors.push(`${f}: mục ngoại lệ phải là { "reason": "lý do", "max": N }`);
      continue;
    }
    const unknown = Object.keys(e).filter((k) => k !== "reason" && k !== "max");
    if (unknown.length) errors.push(`${f}: khoá lạ trong mục ngoại lệ (${unknown.join(", ")})`);
    if (typeof e.reason !== "string" || !e.reason.trim()) errors.push(`${f}: ngoại lệ thiếu lý do`);
    const maxOk = Number.isInteger(e.max) && e.max >= 1;
    if (!maxOk) errors.push(`${f}: ngoại lệ thiếu "max" (số nguyên ≥ 1 = số chuỗi viết thẳng hiện có)`);
    const p = join(root, f);
    if (!existsSync(p) || !statSync(p).isFile()) {
      errors.push(`${f}: tệp ngoại lệ không tồn tại`);
      continue;
    }
    if (!inScope(f)) {
      errors.push(`${f}: tệp ngoại lệ nằm ngoài phạm vi quét (${SCOPE.join(", ")})`);
      continue;
    }
    const n = countLiterals(readFileSync(p, "utf8"), p);
    if (n === 0) errors.push(`${f}: ngoại lệ thừa (0 chuỗi viết thẳng) — bỏ khỏi danh sách`);
    else if (maxOk && n > e.max)
      errors.push(
        `${f}: ${n} chuỗi viết thẳng > max ${e.max} của ngoại lệ — chuỗi người dùng thấy dùng t(); chỉ người vận hành thấy thì nâng max (reviewer rà)`,
      );
    else if (maxOk && n < e.max)
      errors.push(
        `${f}: còn ${n} chuỗi viết thẳng < max ${e.max} — hạ max (\`node scripts/i18n-literals.mjs --write\`)`,
      );
  }
  return errors;
}

/**
 * Bản ngoại lệ với `max` hạ xuống đúng số đếm hiện tại khi 0 < số đếm < max (chỉ giảm, như baseline — không bao giờ nâng; số đếm
 * 0 hoặc > max để nguyên cho `exemptErrors` báo). Mục sai định dạng/tệp không tồn tại để nguyên. Trả { exempt, lowered }.
 */
export function lowerExemptMax(exempt, root = ROOT) {
  const out = {};
  const lowered = [];
  for (const [f, e] of Object.entries(exempt)) {
    out[f] = e;
    const p = join(root, f);
    if (typeof e !== "object" || e === null || !Number.isInteger(e.max) || !inScope(f)) continue;
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    const n = countLiterals(readFileSync(p, "utf8"), p);
    if (n > 0 && n < e.max) {
      out[f] = { ...e, max: n };
      lowered.push(`${f}: max ${e.max} → ${n}`);
    }
  }
  return { exempt: out, lowered };
}

/** Lỗi `apiMessageLiterals` trên MỌI tệp trong phạm vi quét — kể cả tệp ngoại lệ (thông điệp ra API không bao giờ được miễn). */
export function apiMessageErrors(root = ROOT) {
  const errors = [];
  for (const d of SCOPE)
    for (const f of files(join(root, d)))
      errors.push(...apiMessageLiterals(readFileSync(f, "utf8"), relative(root, f).split("\\").join("/")));
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
  let exempt = loadExempt();
  if (process.argv.includes("--write")) {
    // Chỉ hạ max của ngoại lệ (không nâng, không thêm/bỏ mục); lỗi còn lại (> max, thừa, sai định dạng) vẫn báo bên dưới.
    const r = lowerExemptMax(exempt);
    if (r.lowered.length) {
      exempt = r.exempt;
      writeFileSync(EXEMPT, `${JSON.stringify(exempt, null, 2)}\n`);
      for (const l of r.lowered) console.log(`[i18n-literals] hạ ngoại lệ ${l}`);
    }
  }
  const exErrs = exemptErrors(exempt);
  if (exErrs.length) {
    for (const e of exErrs) console.error(e);
    console.error(`[i18n-literals] ${exErrs.length} lỗi ở ${relative(ROOT, EXEMPT)}`);
    process.exit(1);
  }
  const apiErrs = apiMessageErrors();
  const current = scan(ROOT, exempt);
  if (process.argv.includes("--write")) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`[i18n-literals] ghi baseline: ${Object.keys(current).length} tệp`);
    for (const e of apiErrs) console.error(e);
    process.exit(apiErrs.length ? 1 : 0);
  }
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  const errs = [...apiErrs, ...regressions(current, baseline)];
  if (process.argv.includes("--strict"))
    for (const f of remaining(current, baseline, exempt))
      errs.push(
        `${f}: còn ${current[f] ?? 0} chuỗi viết thẳng (baseline ${baseline[f] ?? 0}) — --strict cần 0 ngoài ngoại lệ`,
      );
  for (const e of errs) console.error(e);
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  const exemptTotal = Object.values(exempt).reduce((a, e) => a + e.max, 0);
  console.log(
    `[i18n-literals] ${total} chuỗi viết thẳng trong ${Object.keys(current).length} tệp · ${Object.keys(exempt).length} tệp ngoại lệ (${exemptTotal} chuỗi, theo max) · ${errs.length} lỗi`,
  );
  process.exit(errs.length ? 1 : 0);
}
