#!/usr/bin/env node
// Kiểm tệp dịch (XC-I18N-009, D-073) — file dịch cũng là đầu vào: `apps/web/messages/<locale>.json` (khoá → { message, description }).
//  · nguồn `vi`: mọi khoá có `description` (ngữ cảnh cho người dịch — XC-I18N-001);
//  · mọi locale: `message` đúng cú pháp ICU (parser của formatjs), cùng tập tham số với nguồn, không thẻ HTML/script/`javascript:`;
//    thiếu khoá so với nguồn → lỗi (chưa có cơ chế fallback khai báo);
//  · mã nguồn: mọi khoá `t("…")` đều có trong nguồn (khoá dựng động `tOr(\`…\`)` kiểm theo tiền tố).
// Thoát 1 khi có lỗi. Dùng: node scripts/i18n-check.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { isMain } from "./is-main.mjs";

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
      if (!(key in src)) errors.push(`${locale}:${key}: khoá không có trong nguồn ${source}`);
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
        key in src &&
        srcArgs[key] !== undefined &&
        JSON.stringify(args) !== JSON.stringify(srcArgs[key] ?? safeArgs(src[key].message))
      )
        errors.push(
          `${locale}:${key}: tham số [${args}] khác nguồn [${srcArgs[key] ?? safeArgs(src[key].message)}]`,
        );
    }
    if (locale !== source)
      for (const key of Object.keys(src))
        if (!(key in cat)) errors.push(`${locale}:${key}: thiếu khoá của nguồn`);
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
    for (const n of names) if (!(`${prefix}${n}` in src)) errors.push(`thiếu khoá ${prefix}${n} (roles.ts)`);
  }
  return errors;
}

function main() {
  const catalogs = loadCatalogs();
  const errors = checkCatalogs(catalogs);
  const src = catalogs[SOURCE_LOCALE] ?? {};
  const { exact, prefixes } = usedKeys(sourceFiles(join(ROOT, "apps/web")));
  for (const [k, f] of exact)
    if (!(k in src)) errors.push(`${relative(ROOT, f)}: t("${k}") không có trong nguồn`);
  for (const [p, f] of prefixes)
    if (!Object.keys(src).some((k) => k.startsWith(p)))
      errors.push(`${relative(ROOT, f)}: tiền tố "${p}" không có khoá nào`);
  errors.push(...roleKeyErrors(src, readFileSync(join(ROOT, "apps/web/lib/roles.ts"), "utf8")));
  for (const e of errors) console.error(e);
  console.log(
    `[i18n-check] ${Object.keys(catalogs).length} locale · ${Object.keys(src).length} khoá · ${errors.length} lỗi`,
  );
  return errors.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(main());
