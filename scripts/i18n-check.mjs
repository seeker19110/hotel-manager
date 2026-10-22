#!/usr/bin/env node
// Kiểm tệp dịch (XC-I18N-009, D-073) — file dịch cũng là đầu vào: `apps/web/messages/<locale>.json` (khoá → { message, description }).
//  · nguồn `vi`: mọi khoá có `description` (ngữ cảnh cho người dịch — XC-I18N-001);
//  · mọi locale: `message` đúng cú pháp ICU (parser của formatjs), cùng tập tham số với nguồn, không thẻ HTML/script/`javascript:`;
//    thiếu khoá so với nguồn → lỗi (chưa có cơ chế fallback khai báo);
//  · mã nguồn: mọi khoá `t("…")` đều có trong nguồn (khoá dựng động `tOr(\`…\`)` kiểm theo tiền tố); mỗi lời gọi `t` (import từ
//    lib/i18n) truyền đúng tập tham số `{tên}` của khoá — thiếu thì người dùng thấy `{tên}` thô, thừa là gõ nhầm (đọc trên AST, D-078);
//    lời gọi `tm(m, "khoá", {…})` (import từ lib/i18n-format — client component, D-098) kiểm y như vậy: khoá viết thẳng, có trong
//    nguồn, đúng tập tham số;
//  · bundle: không module `"use client"` nào (kể cả gián tiếp qua import tương đối) import giá trị từ lib/i18n.ts hay tệp
//    messages/*.json — catalog bị nhân bản vào mỗi chunk JS client (D-098, CI bundle-size đỏ ở PR #123). Chỉ `import type`.
// Thoát 1 khi có lỗi. Dùng: node scripts/i18n-check.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { isMain } from "./is-main.mjs";
import { parseSource, walk } from "./ts-ast.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MESSAGES_DIR = join(ROOT, "apps/web/messages");
export const SOURCE_LOCALE = "vi";
const UNSAFE = /<\s*\/?\s*[a-z][^>]*>|javascript:|on\w+\s*=/i;

/** Tên tham số của một message ICU (đệ quy qua plural/select). Ném lỗi khi sai cú pháp. */
export function messageArgs(message) {
  const names = new Set();
  // Runtime `t()` (apps/web/lib/i18n.ts) chỉ thay `{tên}` ASCII — cổng chỉ nhận đúng tập con đó, không nhận plural/select/
  // number/date, dấu nháy đơn (ICU coi là thoát) hay tên tham số có dấu; hỗ trợ thêm ở runtime thì nới ở đây cùng lúc.
  if (message.includes("'")) throw new Error("dấu nháy đơn (ICU thoát) chưa được hỗ trợ");
  for (const el of parse(message, { ignoreTag: true })) {
    if (el.type === TYPE.literal) continue;
    if (el.type !== TYPE.argument) throw new Error("chỉ hỗ trợ literal và {tham_số} đơn giản");
    if (!/^\w+$/.test(el.value)) throw new Error(`tên tham số "${el.value}" phải khớp ^\\w+$`);
    names.add(el.value);
  }
  // `{ name }` (khoảng trắng) parser chấp nhận nhưng runtime chỉ thay `{tên}` sát ngoặc.
  if (/[{}]/.test(message.replace(/\{\w+\}/g, ""))) throw new Error("tham số phải viết sát ngoặc {tên}");
  return [...names].sort();
}

const safeArgs = (message) => {
  try {
    return messageArgs(message);
  } catch {
    return undefined; // nguồn sai cú pháp đã báo ở vòng nguồn
  }
};

/** Lỗi của bộ tệp dịch: { locale: { key: { message, description } } } → mảng chuỗi lỗi. */
export function checkCatalogs(catalogs, source = SOURCE_LOCALE) {
  const errors = [];
  const src = catalogs[source];
  if (!src) return [`thiếu locale nguồn ${source}`];
  const srcArgs = {};
  for (const [key, entry] of Object.entries(src)) {
    if (!entry || typeof entry.message !== "string") {
      errors.push(`${source}:${key}: thiếu message`);
      continue;
    }
    if (!entry.description?.trim())
      errors.push(`${source}:${key}: thiếu description (ngữ cảnh cho người dịch)`);
  }
  const ordered = Object.entries(catalogs).sort(([a], [b]) =>
    a === source ? -1 : b === source ? 1 : a < b ? -1 : 1,
  );
  for (const [locale, cat] of ordered) {
    for (const [key, entry] of Object.entries(cat)) {
      if (typeof entry?.message !== "string" || !entry.message.trim()) {
        if (locale !== source) errors.push(`${locale}:${key}: message phải là chuỗi không rỗng`);
        else if (typeof entry?.message === "string") errors.push(`${locale}:${key}: message rỗng`);
        continue;
      }
      if (!Object.hasOwn(src, key)) errors.push(`${locale}:${key}: khoá không có trong nguồn ${source}`);
      if (UNSAFE.test(entry.message)) errors.push(`${locale}:${key}: có HTML/script lạ`);
      let args;
      try {
        args = messageArgs(entry.message);
      } catch (e) {
        errors.push(`${locale}:${key}: sai cú pháp ICU (${e.message})`);
        continue;
      }
      if (locale === source) srcArgs[key] = args;
      else if (
        Object.hasOwn(src, key) &&
        srcArgs[key] !== undefined &&
        JSON.stringify(args) !== JSON.stringify(srcArgs[key] ?? safeArgs(src[key].message))
      )
        errors.push(
          `${locale}:${key}: tham số [${args}] khác nguồn [${srcArgs[key] ?? safeArgs(src[key].message)}]`,
        );
    }
    if (locale !== source)
      for (const key of Object.keys(src))
        if (!Object.hasOwn(cat, key)) errors.push(`${locale}:${key}: thiếu khoá của nguồn`);
  }
  return errors;
}

const sourceFiles = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n.startsWith(".") || n === "e2e") return [];
    return statSync(p).isDirectory()
      ? sourceFiles(p)
      : /\.(tsx?|mjs)$/.test(n) && !/\.test\./.test(n)
        ? [p]
        : [];
  });

/** Khoá dùng trong mã: `t("k")` (chính xác) và `tOr(\`tiền.tố.${…}\`)` (tiền tố). */
export function usedKeys(files) {
  const exact = new Map();
  const prefixes = new Map();
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\bt\(\s*"([^"]+)"/g)) exact.set(m[1], f);
    for (const m of text.matchAll(/\btOr\(\s*`([^`$]+)\$\{/g)) prefixes.set(m[1], f);
  }
  return { exact, prefixes };
}

const propName = (p) =>
  p.type === "ObjectProperty" && !p.computed
    ? p.key.type === "Identifier"
      ? p.key.name
      : p.key.type === "StringLiteral"
        ? p.key.value
        : null
    : null;

// Hàm dịch được kiểm: module (theo đuôi đường dẫn import) → tên export → vị trí đối số khoá (tham số ở ngay sau).
const CHECKED = [
  { module: /(^|\/)i18n(\.ts)?$/, name: "t", keyAt: 0 },
  { module: /(^|\/)i18n-format(\.ts)?$/, name: "tm", keyAt: 1 },
];

/**
 * Lỗi tham số của các lời gọi `t(...)` / `tm(m, ...)` trong một tệp. Chỉ xét tên cục bộ của `t` import từ module `…/i18n(.ts)` (biến `t` khác
 * không bị bắt nhầm). Khoá phải là chuỗi viết thẳng (khoá động dùng `tOr`); đối số thứ hai (nếu có) phải là object literal với
 * khoá tĩnh, và tập khoá phải đúng bằng tập tham số ICU của message nguồn. Khoá `t()` không có trong nguồn do `usedKeys` báo;
 * khoá `tm()` không có trong nguồn báo ngay tại đây (đối số đầu là biểu thức tuỳ ý — regex của `usedKeys` không đọc chắc được).
 */
export function tCallErrors(text, file, src) {
  const ast = parseSource(text, file);
  const locals = new Map(); // tên cục bộ → mục CHECKED
  const errors = [];
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration" || node.importKind === "type") continue; // `import type …` không gọi được
    const fns = CHECKED.filter((c) => c.module.test(node.source.value));
    if (fns.length === 0) continue;
    for (const sp of node.specifiers)
      if (sp.type === "ImportSpecifier") {
        if (sp.importKind === "type") continue;
        const fn = fns.find((c) => c.name === (sp.imported.name ?? sp.imported.value));
        if (fn) locals.set(sp.local.name, fn);
      }
      // `import * as i18n` / import mặc định: `i18n.t(...)` không kiểm được tham số → bắt dùng `import { t }` / `{ tm }`.
      else
        errors.push(
          `${file}:${node.loc.start.line}: import ${node.source.value} bằng tên — dùng \`import { ${fns[0].name} }\` để kiểm tham số ${fns[0].name}()`,
        );
  }
  if (locals.size === 0) return errors;
  walk(ast.program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || !locals.has(node.callee.name))
      return;
    const fn = locals.get(node.callee.name);
    const at = `${file}:${node.loc.start.line}`;
    const keyArg = node.arguments[fn.keyAt];
    const paramsArg = node.arguments[fn.keyAt + 1];
    if (keyArg?.type !== "StringLiteral") {
      errors.push(
        fn.name === "t"
          ? `${at}: t() cần khoá viết thẳng "…" (khoá dựng động dùng tOr)`
          : `${at}: ${fn.name}() cần khoá viết thẳng "…" ở đối số thứ ${fn.keyAt + 1}`,
      );
      return;
    }
    const key = keyArg.value;
    if (!Object.hasOwn(src, key)) {
      if (fn.name !== "t") errors.push(`${at}: ${fn.name}("${key}") không có trong nguồn`);
      return;
    }
    let got = [];
    if (paramsArg) {
      const names = paramsArg.type === "ObjectExpression" ? paramsArg.properties.map(propName) : [null];
      if (names.includes(null)) {
        errors.push(
          `${at}: ${fn.name}("${key}") — tham số phải là object literal với khoá tĩnh (không spread/biến/khoá tính)`,
        );
        return;
      }
      got = names;
    }
    const want = messageArgs(src[key].message);
    const missing = want.filter((n) => !got.includes(n));
    const extra = got.filter((n) => !want.includes(n));
    if (missing.length)
      errors.push(`${at}: ${fn.name}("${key}") thiếu tham số ${missing.map((n) => `{${n}}`).join(", ")}`);
    if (extra.length)
      errors.push(`${at}: ${fn.name}("${key}") thừa tham số ${extra.join(", ")} (message không có)`);
  });
  return errors;
}

/** Lỗi phía mã nguồn: khoá `t("…")` không có trong nguồn, tiền tố `tOr` không có khoá, tham số `t()` sai (`tCallErrors`). */
export function sourceErrors(files, src, root = ROOT) {
  const errors = [];
  const { exact, prefixes } = usedKeys(files);
  for (const [k, f] of exact)
    if (!Object.hasOwn(src, k)) errors.push(`${relative(root, f)}: t("${k}") không có trong nguồn`);
  for (const [p, f] of prefixes)
    if (!Object.keys(src).some((k) => k.startsWith(p)))
      errors.push(`${relative(root, f)}: tiền tố "${p}" không có khoá nào`);
  for (const f of files) errors.push(...tCallErrors(readFileSync(f, "utf8"), relative(root, f), src));
  return errors;
}

const CATALOG = /(^|\/)apps\/web\/(lib\/i18n\.ts|messages\/[^/]+\.json)$/;

/** Đường dẫn import tương đối → tệp trên đĩa (dự án ghi đuôi `.ts`/`.tsx`; thiếu đuôi thì thử thêm). Gói (`@hm/…`) → null. */
function resolveImport(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")])
    if (existsSync(p) && statSync(p).isFile()) return p;
  return null;
}

/** Nguồn import GIÁ TRỊ của một tệp: `import`/`export … from` không phải `import type`, và `import("…")` viết thẳng. */
function valueImports(text, file) {
  if (file.endsWith(".json")) return [];
  const ast = parseSource(text, file);
  const out = [];
  walk(ast.program, (n) => {
    if (
      (n.type === "ImportDeclaration" ||
        n.type === "ExportNamedDeclaration" ||
        n.type === "ExportAllDeclaration") &&
      n.source &&
      n.importKind !== "type" &&
      n.exportKind !== "type"
    )
      out.push(n.source.value);
    else if (
      n.type === "CallExpression" &&
      n.callee.type === "Import" &&
      n.arguments[0]?.type === "StringLiteral"
    )
      out.push(n.arguments[0].value);
  });
  return out;
}

/**
 * Module client (`"use client"`) kéo catalog vào bundle: với mỗi tệp client, đi theo import giá trị tương đối; chạm
 * lib/i18n.ts hoặc messages/*.json → lỗi kèm chuỗi import. `import { type X }` (không phải `import type`) vẫn tính là giá trị
 * (verbatimModuleSyntax giữ lại import rỗng — chặt hơn).
 */
export function clientCatalogErrors(files, root = ROOT) {
  const errors = [];
  const cache = new Map();
  const deps = (f) => {
    if (!cache.has(f))
      cache.set(
        f,
        valueImports(readFileSync(f, "utf8"), f)
          .map((s) => resolveImport(f, s))
          .filter(Boolean),
      );
    return cache.get(f);
  };
  for (const f of files) {
    if (!/\.tsx?$/.test(f)) continue;
    const directives = parseSource(readFileSync(f, "utf8"), f).program.directives ?? [];
    if (!directives.some((d) => d.value.value === "use client")) continue;
    const seen = new Set([f]);
    const queue = [[f]];
    while (queue.length) {
      const chain = queue.shift();
      for (const d of deps(chain.at(-1))) {
        if (seen.has(d)) continue;
        seen.add(d);
        const next = [...chain, d];
        if (CATALOG.test(d.split("\\").join("/"))) {
          errors.push(
            `${relative(root, f)}: module client import catalog (${next.map((p) => relative(root, p)).join(" → ")}) — truyền m={messagesFor(…)} và dùng tm() (D-098)`,
          );
          continue;
        }
        queue.push(next);
      }
    }
  }
  return errors;
}

export function loadCatalogs(dir = MESSAGES_DIR) {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => [n.replace(/\.json$/, ""), JSON.parse(readFileSync(join(dir, n), "utf8"))]),
  );
}

/** Khoá dựng động `tOr(\`tiền.tố.${r}\`)`: mọi giá trị trong ROLES/STATUSES (roles.ts) phải có khoá thật trong nguồn. */
export function roleKeyErrors(src, rolesTs) {
  const errors = [];
  const list = (name) =>
    [...(rolesTs.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (m) => m[1],
    );
  for (const [prefix, names] of [
    ["role.", list("ROLES")],
    ["org_picker.role.", list("ROLES")],
    ["member_status.", list("STATUSES")],
  ]) {
    if (names.length === 0) errors.push(`roles.ts: không đọc được danh sách cho tiền tố ${prefix}`);
    for (const n of names)
      if (!Object.hasOwn(src, `${prefix}${n}`)) errors.push(`thiếu khoá ${prefix}${n} (roles.ts)`);
  }
  return errors;
}

function main() {
  const catalogs = loadCatalogs();
  const errors = checkCatalogs(catalogs);
  const src = catalogs[SOURCE_LOCALE] ?? {};
  const files = sourceFiles(join(ROOT, "apps/web"));
  errors.push(...sourceErrors(files, src));
  errors.push(...clientCatalogErrors(files));
  errors.push(...roleKeyErrors(src, readFileSync(join(ROOT, "apps/web/lib/roles.ts"), "utf8")));
  for (const e of errors) console.error(e);
  console.log(
    `[i18n-check] ${Object.keys(catalogs).length} locale · ${Object.keys(src).length} khoá · ${errors.length} lỗi`,
  );
  return errors.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(main());
