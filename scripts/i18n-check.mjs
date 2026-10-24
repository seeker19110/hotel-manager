#!/usr/bin/env node
// Kiểm tệp dịch (XC-I18N-009, D-073) — file dịch cũng là đầu vào. Hai catalog cùng định dạng (khoá → { message, description }),
// mỗi catalog đi với mã nguồn của nó (TREES): `apps/web/messages/<locale>.json` ↔ apps/web (t/tOr của lib/i18n.ts, tm của
// lib/i18n-format.ts) và `packages/app/messages/<locale>.json` ↔ packages/app/src (t của src/i18n.ts, import tương đối — D-104;
// packages/app không phụ thuộc apps/web nên catalog riêng). Mọi luật dưới đây áp cho cả hai:
//  · nguồn `vi`: mọi khoá có `description` (ngữ cảnh cho người dịch — XC-I18N-001);
//  · mọi locale: `message` đúng cú pháp ICU (parser của formatjs), cùng tập tham số với nguồn, không thẻ HTML/script/`javascript:`;
//    thiếu khoá so với nguồn → lỗi (chưa có cơ chế fallback khai báo);
//  · mã nguồn: mọi khoá `t("…")` đều có trong nguồn (khoá dựng động `tOr(\`…\`)` kiểm theo tiền tố); mỗi lời gọi `t` (import từ
//    lib/i18n) truyền đúng tập tham số `{tên}` của khoá — thiếu thì người dùng thấy `{tên}` thô, thừa là gõ nhầm (đọc trên AST, D-078);
//    lời gọi `tm(m, "khoá", {…})` (import từ lib/i18n-format — client component, D-098) kiểm y như vậy: khoá viết thẳng, có trong
//    nguồn, đúng tập tham số — `m` là biểu thức tuỳ ý nên `tm(useMessages(), "khoá")` và `const m = useMessages(); tm(m, …)`
//    (context `common.` của lib/i18n-context.tsx, D-101) được kiểm như nhau;
//  · bundle: không module `"use client"` nào (kể cả gián tiếp qua import tương đối) import giá trị từ lib/i18n.ts hay tệp
//    messages/*.json — catalog bị nhân bản vào mỗi chunk JS client (D-098, CI bundle-size đỏ ở PR #123). Chỉ `import type`.
//    Đi theo cả import gói `@hm/<gói>/<đường>` (theo `exports` của packages/*/package.json): module client chạm
//    packages/app/src/i18n.ts hoặc packages/app/messages/<locale>.json (vd qua `@hm/app/http`) cũng là lỗi.
//  · catalog con (D-106) `<thư mục catalog>/<tên>.<locale>.json` (vd packages/app/messages/form.vi.json): tập câu NHỎ cho module
//    mà trình duyệt nạp (http/command-inputs.ts) — được phép vào bundle client (không khớp luật trên), nhưng chỉ đúng các tệp mã
//    khai ở `subcatalogs` dùng nó. Kiểm như catalog chính (mô tả, ICU, tham số, HTML) + mọi lời gọi hàm tra cứu (`formText`) trong
//    tệp mã khai báo: khoá viết thẳng, có trong catalog con, đúng tham số; khoá không được gọi ở đâu ⇒ lỗi (giữ catalog con tối thiểu).
// Thoát 1 khi có lỗi. Dùng: node scripts/i18n-check.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { isMain } from "./is-main.mjs";
import { parseSource, walk } from "./ts-ast.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MESSAGES_DIR = join(ROOT, "apps/web/messages");
export const APP_MESSAGES_DIR = join(ROOT, "packages/app/messages");
/** Catalog ↔ mã nguồn dùng nó (đường dẫn tương đối gốc repo). `roles`: tệp ROLES/STATUSES có khoá dựng động (chỉ web). */
export const TREES = [
  {
    name: "apps/web",
    messages: "apps/web/messages",
    sources: "apps/web",
    roles: "apps/web/lib/roles.ts",
    client: true,
  },
  {
    name: "packages/app",
    messages: "packages/app/messages",
    sources: "packages/app/src",
    subcatalogs: [{ name: "form", fn: "formText", sources: ["packages/app/src/http/command-inputs.ts"] }],
  },
];

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
export function tCallErrors(text, file, src, fns = null) {
  const ast = parseSource(text, file);
  // `fns` (catalog con): kiểm đúng các hàm tên đó (định nghĩa ngay trong tệp, không qua import) — bỏ qua import lib/i18n.
  const locals = new Map(fns ? fns.map((f) => [f.name, f]) : []); // tên cục bộ → mục CHECKED
  const errors = [];
  for (const node of fns ? [] : ast.program.body) {
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
      // `t("…")` viết đúng tên do `usedKeys` báo; tên khác (tm, formText, `t` import đổi tên) báo ở đây.
      if (fn.name !== "t" || node.callee.name !== "t")
        errors.push(`${at}: ${node.callee.name}("${key}") không có trong nguồn`);
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

// Catalog chính (`<locale>.json`, không dấu chấm trong tên). Catalog con `<tên>.<locale>.json` (D-106) không khớp: nó được thiết
// kế để vào bundle client (nhỏ, chỉ câu form) — phạm vi dùng do `subcatalogErrors` giữ.
const CATALOG =
  /(^|\/)(apps\/web\/(lib\/i18n\.ts|messages\/[^/.]+\.json)|packages\/app\/(src\/i18n\.ts|messages\/[^/.]+\.json))$/;

/** Gói workspace `@hm/…` → { dir, exports } đọc từ packages/*\/package.json dưới `root` (không có thư mục → rỗng). */
function workspacePackages(root) {
  const dir = join(root, "packages");
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const pj = join(dir, n, "package.json");
    if (!existsSync(pj)) continue;
    const pkg = JSON.parse(readFileSync(pj, "utf8"));
    if (typeof pkg.name === "string") out.set(pkg.name, { dir: join(dir, n), exports: pkg.exports ?? {} });
  }
  return out;
}

/**
 * Đường dẫn import → tệp trên đĩa: tương đối (dự án ghi đuôi `.ts`/`.tsx`; thiếu đuôi thì thử thêm) hoặc gói workspace
 * `@hm/x[/sub]` theo `exports` (chuỗi; điều kiện `import`/`default`). Gói ngoài/không có trong exports → null.
 */
function resolveImport(from, spec, pkgs = new Map()) {
  const tryFile = (base) => {
    for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")])
      if (existsSync(p) && statSync(p).isFile()) return p;
    return null;
  };
  if (spec.startsWith(".")) return tryFile(resolve(dirname(from), spec));
  const m = /^(@[^/]+\/[^/]+)(\/.*)?$/.exec(spec);
  const pkg = m && pkgs.get(m[1]);
  if (!pkg) return null;
  const target = pkg.exports[`.${m[2] ?? ""}`];
  const rel = typeof target === "string" ? target : (target?.import ?? target?.default);
  return typeof rel === "string" ? tryFile(join(pkg.dir, rel)) : null;
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
  const pkgs = workspacePackages(root);
  const deps = (f) => {
    if (!cache.has(f))
      cache.set(
        f,
        valueImports(readFileSync(f, "utf8"), f)
          .map((s) => resolveImport(f, s, pkgs))
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

/** Catalog chính của thư mục: { locale: catalog } từ các tệp `<locale>.json`; `sub` = tên catalog con ⇒ tệp `<sub>.<locale>.json`. */
export function loadCatalogs(dir = MESSAGES_DIR, sub = null) {
  const pick = sub ? new RegExp(`^${sub}\\.([^.]+)\\.json$`) : /^([^.]+)\.json$/;
  return Object.fromEntries(
    readdirSync(dir)
      .map((n) => [n, pick.exec(n)])
      .filter(([, m]) => m)
      .map(([n, m]) => [m[1], JSON.parse(readFileSync(join(dir, n), "utf8"))]),
  );
}

/**
 * Lỗi của một catalog con (D-106) dưới `root`: catalog (`checkCatalogs`, tiền tố `<thư mục>/<tên>.<locale>`), lời gọi hàm tra
 * cứu `sub.fn` trong `sub.sources` (khoá viết thẳng, có trong catalog con, đúng tham số — `tCallErrors` với `fns`), khoá không
 * được gọi ở tệp nào (catalog con phải tối thiểu vì nó vào bundle), tệp nguồn khai báo không tồn tại.
 */
export function subcatalogErrors(tree, sub, root = ROOT) {
  const dir = join(root, tree.messages);
  const catalogs = existsSync(dir) ? loadCatalogs(dir, sub.name) : {};
  if (!catalogs[SOURCE_LOCALE])
    return { errors: [`${tree.messages}/${sub.name}.${SOURCE_LOCALE}.json: thiếu catalog con`], catalogs };
  const errors = checkCatalogs(catalogs).map((e) => `${tree.messages}/${sub.name}.${e}`);
  const src = catalogs[SOURCE_LOCALE];
  const used = new Set();
  for (const rel of sub.sources) {
    const f = join(root, rel);
    if (!existsSync(f)) {
      errors.push(`${rel}: tệp dùng catalog con ${sub.name} không tồn tại`);
      continue;
    }
    const text = readFileSync(f, "utf8");
    errors.push(...tCallErrors(text, rel, src, [{ name: sub.fn, keyAt: 0 }]));
    walk(parseSource(text, rel).program, (n) => {
      if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === sub.fn)
        if (n.arguments[0]?.type === "StringLiteral") used.add(n.arguments[0].value);
    });
  }
  for (const k of Object.keys(src))
    if (!used.has(k))
      errors.push(
        `${tree.messages}/${sub.name}.${SOURCE_LOCALE}:${k}: khoá không được ${sub.fn}() nào dùng — bỏ khỏi catalog con`,
      );
  return { errors, catalogs };
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

/**
 * Mọi lỗi của một cây (catalog + mã nguồn dùng nó, xem TREES) dưới `root`: catalog (lỗi có tiền tố thư mục catalog), khoá/tham
 * số của lời gọi dịch, module client kéo catalog (cây `client`), khoá dựng động của roles (cây có `roles`). Thiếu thư mục
 * catalog → lỗi (không lặng lẽ bỏ qua cả cây).
 */
export function treeErrors(tree, root = ROOT) {
  const dir = join(root, tree.messages);
  if (!existsSync(dir)) return { errors: [`${tree.messages}: thiếu thư mục catalog`], catalogs: {} };
  const catalogs = loadCatalogs(dir);
  const errors = checkCatalogs(catalogs).map((e) => `${tree.messages}/${e}`);
  const src = catalogs[SOURCE_LOCALE] ?? {};
  const files = sourceFiles(join(root, tree.sources));
  errors.push(...sourceErrors(files, src, root));
  if (tree.client) errors.push(...clientCatalogErrors(files, root));
  if (tree.roles) errors.push(...roleKeyErrors(src, readFileSync(join(root, tree.roles), "utf8")));
  for (const sub of tree.subcatalogs ?? []) errors.push(...subcatalogErrors(tree, sub, root).errors);
  return { errors, catalogs };
}

function main() {
  let total = 0;
  for (const tree of TREES) {
    const { errors, catalogs } = treeErrors(tree);
    for (const e of errors) console.error(e);
    total += errors.length;
    console.log(
      `[i18n-check] ${tree.messages}: ${Object.keys(catalogs).length} locale · ${Object.keys(catalogs[SOURCE_LOCALE] ?? {}).length} khoá · ${errors.length} lỗi`,
    );
    for (const sub of tree.subcatalogs ?? []) {
      const n = Object.keys(subcatalogErrors(tree, sub).catalogs[SOURCE_LOCALE] ?? {}).length;
      console.log(
        `[i18n-check]   catalog con ${tree.messages}/${sub.name}.*.json: ${n} khoá (lỗi gộp ở dòng trên)`,
      );
    }
  }
  return total ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(main());
