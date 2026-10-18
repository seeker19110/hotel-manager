#!/usr/bin/env node
// Ratchet chuỗi viết thẳng (XC-I18N-001, D-073): đếm chuỗi tiếng Việt (có dấu) viết thẳng trong mã người dùng thấy — JSX text và
// literal "…"/'…'/`…` — theo từng tệp. Số đếm chỉ được GIẢM so với `scripts/i18n-literal-baseline.json`; tệp chưa có trong baseline
// phải = 0 (chuỗi mới đi qua `t()` của apps/web/lib/i18n.ts). Bỏ chú thích, test, e2e. Chuyển xong một tệp thì hạ baseline
// (`node scripts/i18n-literals.mjs --write`) trong cùng PR. Mục tiêu: baseline rỗng.
// Dùng: node scripts/i18n-literals.mjs [--write]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const BASELINE = join(ROOT, "scripts/i18n-literal-baseline.json");
export const SCOPE = [
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "apps/worker/src",
  "packages/app/src",
];
const VI = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

/** Bỏ chú thích // và /* *\/ (giữ chuỗi): đủ cho đếm, không phải trình phân tích đầy đủ. */
export function stripComments(src) {
  return src.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m, str) => (str ? m : " "),
  );
}

/** Số chuỗi tiếng Việt viết thẳng trong một đoạn mã. */
export function countLiterals(src) {
  const code = stripComments(src);
  let n = 0;
  for (const m of code.matchAll(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g))
    if (VI.test(m[0])) n++;
  // JSX text: giữa `>` và `<`/`{`, không phải trong chuỗi (đã đếm ở trên) — bỏ chuỗi trước khi tìm.
  const noStrings = code.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""');
  for (const m of noStrings.matchAll(/>([^<>{}]+)[<{]/g)) if (VI.test(m[1])) n++;
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

/** { "đường/dẫn": số } cho mọi tệp có chuỗi viết thẳng trong phạm vi. */
export function scan(root = ROOT) {
  const out = {};
  for (const d of SCOPE)
    for (const f of files(join(root, d))) {
      const n = countLiterals(readFileSync(f, "utf8"));
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

if (isMain(import.meta.url)) {
  const current = scan();
  if (process.argv.includes("--write")) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`[i18n-literals] ghi baseline: ${Object.keys(current).length} tệp`);
    process.exit(0);
  }
  const errs = regressions(current, JSON.parse(readFileSync(BASELINE, "utf8")));
  for (const e of errs) console.error(e);
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  console.log(
    `[i18n-literals] ${total} chuỗi viết thẳng trong ${Object.keys(current).length} tệp · ${errs.length} tăng`,
  );
  process.exit(errs.length ? 1 : 0);
}
