// STD-PROC-003: thay đổi phá vỡ hợp đồng API công khai (apps/web/openapi.json) chỉ đi với tăng MAJOR của `info.version`
// VÀ có `BREAKING CHANGE:` (footer) hoặc `!` ở tiêu đề commit/PR (Conventional Commits 1.0.0, SemVer 2.0.0 §8).
// Dùng (CI job `pr-policy`, `fetch-depth: 0`): `node scripts/check-openapi-breaking.mjs --base origin/main [--extra-file pr.txt]`
//   --extra-file: tiêu đề PR + dòng trống + mô tả PR (squash merge lấy tiêu đề/mô tả làm commit). Test: scripts/openapi-breaking.test.mjs.
// Không dùng công cụ ngoài: bộ quy tắc dưới đây là TẬP CON của oasdiff (xoá đường dẫn/phương thức/tham số bắt buộc/trường phản hồi,
// thêm yêu cầu bắt buộc, đổi kiểu/định dạng/enum/ràng buộc theo hướng request hoặc response, đổi xác thực).
import { readFileSync } from "node:fs";
import { argValue, git, isMain, refExists, showAt } from "./git-history.mjs";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const OPENAPI_FILE = "apps/web/openapi.json";

/** Theo `$ref` nội bộ (`#/components/...`) tới nút thật; hỏng/quá sâu → {}. */
export function deref(doc, node) {
  let cur = node;
  for (let depth = 0; cur && typeof cur === "object" && typeof cur.$ref === "string"; depth++) {
    if (depth > 20 || !cur.$ref.startsWith("#/")) return {};
    cur = cur.$ref
      .slice(2)
      .split("/")
      .reduce((acc, k) => acc?.[k.replaceAll("~1", "/").replaceAll("~0", "~")], doc);
  }
  return cur ?? {};
}

const typeSet = (t) => new Set(t === undefined ? [] : Array.isArray(t) ? t : [t]);
const covers = (set, t) => set.has(t) || (t === "integer" && set.has("number"));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const defined = (v) => v !== undefined;
const LOWER = ["minLength", "minimum", "minItems", "exclusiveMinimum", "minProperties"];
const UPPER = ["maxLength", "maximum", "maxItems", "exclusiveMaximum", "maxProperties"];

/**
 * So hai schema theo hướng `dir`: "request" (client gửi — hẹp lại là phá vỡ) hoặc "response" (client nhận — rộng ra là phá vỡ).
 * Ghi vào `out` các câu mô tả; `seen` chống vòng `$ref`.
 */
export function diffSchema(oldDoc, oldS, newDoc, newS, dir, where, out, seen = new Set()) {
  if (!oldS || !newS) return;
  if (oldS.$ref && newS.$ref) {
    const key = `${oldS.$ref}>${newS.$ref}|${dir}`;
    if (seen.has(key)) return;
    seen.add(key);
  }
  const o = deref(oldDoc, oldS);
  const n = deref(newDoc, newS);
  const req = dir === "request";
  const flag = (msg) => out.push(`${where}: ${msg}`);

  const ot = typeSet(o.type);
  const nt = typeSet(n.type);
  if (ot.size && nt.size) {
    const bad = req ? [...ot].filter((t) => !covers(nt, t)) : [...nt].filter((t) => !covers(ot, t));
    if (bad.length)
      flag(
        `kiểu ${req ? "request hẹp lại" : "response mở rộng"} (${[...ot].join("|")} → ${[...nt].join("|")})`,
      );
  } else if (req && !ot.size && nt.size) flag(`request thêm ràng buộc kiểu ${[...nt].join("|")}`);

  if (req ? defined(n.format) && n.format !== o.format : defined(o.format) && n.format !== o.format) {
    flag(`đổi format (${o.format ?? "—"} → ${n.format ?? "—"})`);
  }

  if (req && defined(n.enum)) {
    if (!defined(o.enum) || o.enum.some((v) => !n.enum.some((w) => same(v, w))))
      flag("request bớt giá trị enum");
  }
  if (!req && defined(o.enum) && defined(n.enum) && n.enum.some((v) => !o.enum.some((w) => same(v, w)))) {
    flag("response thêm giá trị enum");
  }

  for (const k of LOWER) {
    if (
      req
        ? defined(n[k]) && (!defined(o[k]) || n[k] > o[k])
        : defined(o[k]) && (!defined(n[k]) || n[k] < o[k])
    ) {
      flag(`đổi ${k} (${o[k] ?? "—"} → ${n[k] ?? "—"})`);
    }
  }
  for (const k of UPPER) {
    if (
      req
        ? defined(n[k]) && (!defined(o[k]) || n[k] < o[k])
        : defined(o[k]) && (!defined(n[k]) || n[k] > o[k])
    ) {
      flag(`đổi ${k} (${o[k] ?? "—"} → ${n[k] ?? "—"})`);
    }
  }
  if (req ? defined(n.pattern) && n.pattern !== o.pattern : defined(o.pattern) && n.pattern !== o.pattern) {
    flag("đổi pattern");
  }

  const op = o.properties ?? {};
  const np = n.properties ?? {};
  for (const k of Object.keys(op)) {
    if (!(k in np)) {
      if (!req) flag(`response bỏ trường '${k}'`);
      else if (n.additionalProperties === false) flag(`request không còn nhận trường '${k}'`);
      continue;
    }
    diffSchema(oldDoc, op[k], newDoc, np[k], dir, `${where}.${k}`, out, seen);
  }
  const oreq = new Set(o.required ?? []);
  const nreq = new Set(n.required ?? []);
  if (req) {
    for (const k of nreq) if (!oreq.has(k)) flag(`request: trường '${k}' thành bắt buộc`);
    if (o.additionalProperties !== false && n.additionalProperties === false && Object.keys(np).length) {
      flag("request không còn cho phép trường thừa (additionalProperties: false)");
    }
  } else {
    for (const k of oreq) if (!nreq.has(k)) flag(`response: trường '${k}' không còn bắt buộc`);
  }

  if (o.items && n.items) diffSchema(oldDoc, o.items, newDoc, n.items, dir, `${where}[]`, out, seen);

  for (const kw of ["allOf", "anyOf", "oneOf"]) {
    const a = o[kw];
    const b = n[kw];
    if (!a && !b) continue;
    if (!a || !b || a.length !== b.length) flag(`đổi cấu trúc ${kw}`);
    else {
      for (const [i, s] of a.entries())
        diffSchema(oldDoc, s, newDoc, b[i], dir, `${where}.${kw}[${i}]`, out, seen);
    }
  }
}

function paramMap(doc, pathItem, op) {
  const map = new Map();
  for (const p of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]) {
    const d = deref(doc, p);
    if (d.name) map.set(`${d.in}:${d.name}`, d);
  }
  return map;
}

const requirementKeys = (sec) => (sec ?? []).map((r) => JSON.stringify(Object.keys(r).sort()));

function diffOperation(oldDoc, oPath, oOp, newDoc, nPath, nOp, where, out) {
  const op = paramMap(oldDoc, oPath, oOp);
  const np = paramMap(newDoc, nPath, nOp);
  for (const [key, o] of op) {
    const n = np.get(key);
    if (!n) {
      if (o.required) out.push(`${where}: bỏ tham số bắt buộc '${o.name}' (${o.in})`);
      continue;
    }
    if (n.required && !o.required) out.push(`${where}: tham số '${o.name}' (${o.in}) thành bắt buộc`);
    diffSchema(oldDoc, o.schema, newDoc, n.schema, "request", `${where} tham số '${o.name}'`, out);
  }
  for (const [key, n] of np)
    if (!op.has(key) && n.required) out.push(`${where}: thêm tham số bắt buộc '${n.name}' (${n.in})`);

  const ob = deref(oldDoc, oOp.requestBody);
  const nb = deref(newDoc, nOp.requestBody);
  if (nOp.requestBody) {
    if (nb.required && !ob.required) out.push(`${where}: request body thành bắt buộc`);
    for (const [mt, om] of Object.entries(ob.content ?? {})) {
      const nm = nb.content?.[mt];
      if (!nm) out.push(`${where}: request không còn nhận ${mt}`);
      else diffSchema(oldDoc, om.schema, newDoc, nm.schema, "request", `${where} request ${mt}`, out);
    }
  }

  for (const [code, oRes] of Object.entries(oOp.responses ?? {})) {
    const nRes = nOp.responses?.[code];
    if (!nRes) {
      if (/^2\d\d$/.test(code)) out.push(`${where}: bỏ phản hồi ${code}`);
      continue;
    }
    const od = deref(oldDoc, oRes);
    const nd = deref(newDoc, nRes);
    for (const [mt, om] of Object.entries(od.content ?? {})) {
      const nm = nd.content?.[mt];
      if (!nm) {
        if (/^2\d\d$/.test(code)) out.push(`${where}: phản hồi ${code} không còn ${mt}`);
      } else diffSchema(oldDoc, om.schema, newDoc, nm.schema, "response", `${where} ${code} ${mt}`, out);
    }
  }

  const oSec = requirementKeys(oOp.security ?? oldDoc.security);
  const nSec = requirementKeys(nOp.security ?? newDoc.security);
  const oHasAuth = oSec.some((k) => k !== "[]");
  const nHasAuth = nSec.some((k) => k !== "[]") && !nSec.includes("[]");
  if (!oHasAuth && nHasAuth) out.push(`${where}: thêm yêu cầu xác thực`);
  else if (oHasAuth && nHasAuth && !nSec.some((k) => oSec.includes(k)))
    out.push(`${where}: đổi cơ chế xác thực`);
}

/** Danh sách thay đổi phá vỡ giữa hai tài liệu OpenAPI (đã parse). */
export function findBreakingChanges(oldDoc, newDoc) {
  const out = [];
  for (const [path, oPath] of Object.entries(oldDoc.paths ?? {})) {
    const nPath = newDoc.paths?.[path];
    if (!nPath) {
      out.push(`${path}: bỏ đường dẫn`);
      continue;
    }
    for (const m of METHODS) {
      if (!oPath[m]) continue;
      const where = `${m.toUpperCase()} ${path}`;
      if (!nPath[m]) out.push(`${where}: bỏ phương thức`);
      else diffOperation(oldDoc, oPath, oPath[m], newDoc, nPath, nPath[m], where, out);
    }
  }
  return out;
}

const major = (v) => {
  const m = /^(\d+)\.\d+\.\d+/.exec(String(v ?? ""));
  return m ? Number(m[1]) : null;
};

/** Có xác nhận phá vỡ trong tiêu đề (`type!:`) hoặc footer `BREAKING CHANGE:` của một trong các văn bản commit/PR. */
export function hasBreakingAck(texts) {
  return texts.some(
    (t) => /^[a-z]+(?:\([^)]*\))?!:\s*\S/.test(t.trimStart()) || /^BREAKING[ -]CHANGE:\s*\S/m.test(t),
  );
}

/** Luật phiên bản: phá vỡ ⇒ MAJOR tăng + có xác nhận; phiên bản không được lùi. */
export function evaluate({ oldDoc, newDoc, texts }) {
  const problems = [];
  const breaking = findBreakingChanges(oldDoc, newDoc);
  const mo = major(oldDoc.info?.version);
  const mn = major(newDoc.info?.version);
  if (mn === null) problems.push(`info.version '${newDoc.info?.version}' không phải SemVer X.Y.Z`);
  if (mo !== null && mn !== null && mn < mo)
    problems.push(`info.version giảm MAJOR (${oldDoc.info.version} → ${newDoc.info.version})`);
  if (breaking.length && mo !== null && mn !== null && mn <= mo) {
    problems.push(
      `có ${breaking.length} thay đổi phá vỡ mà MAJOR không tăng (${oldDoc.info.version} → ${newDoc.info.version})`,
    );
  }
  if (breaking.length && !hasBreakingAck(texts)) {
    problems.push(
      `có ${breaking.length} thay đổi phá vỡ mà không có 'BREAKING CHANGE:' ở commit/PR (hoặc 'type!:' ở tiêu đề)`,
    );
  }
  return { breaking, problems };
}

function commitTexts(base, cwd) {
  return git(["log", "--format=%B%x1e", `${base}..HEAD`], cwd)
    .split("\x1e")
    .map((s) => s.trim())
    .filter(Boolean);
}

function main() {
  const base = argValue(process.argv, "--base", "origin/main");
  const file = argValue(process.argv, "--file", OPENAPI_FILE);
  if (!refExists(base)) {
    process.stderr.write(`không thấy nhánh gốc '${base}' — checkout cần fetch-depth: 0\n`);
    return 2;
  }
  const baseText = showAt(base, file);
  if (baseText === null) {
    process.stdout.write(`✓ ${file} chưa có ở ${base} — không có hợp đồng cũ để so.\n`);
    return 0;
  }
  const texts = commitTexts(base);
  const extra = argValue(process.argv, "--extra-file");
  if (extra) texts.push(readFileSync(extra, "utf8"));
  const { breaking, problems } = evaluate({
    oldDoc: JSON.parse(baseText),
    newDoc: JSON.parse(readFileSync(file, "utf8")),
    texts,
  });
  for (const b of breaking) process.stdout.write(`  phá vỡ: ${b}\n`);
  for (const p of problems) process.stderr.write(`✗ ${p}\n`);
  if (!problems.length) {
    process.stdout.write(`✓ Hợp đồng API: ${breaking.length} thay đổi phá vỡ, đủ MAJOR + BREAKING CHANGE.\n`);
  }
  return problems.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(main());
