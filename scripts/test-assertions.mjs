// Rào "test phải có khẳng định" (QA-COV-004; PLAN đợt 8 T-702). Quét mọi file test (*.test.ts/.tsx/.mjs, *.spec.ts):
//   1. mỗi `it(`/`test(` (kể cả `.each`, `.only`, `.skip`, `.todo`…) phải chứa ≥ 1 khẳng định thật: `expect(…)`
//      (trừ khi chỉ toàn matcher snapshot), `expectTypeOf`, `assert…`, hoặc gọi một HELPER KHẲNG ĐỊNH;
//   2. snapshot (`toMatchSnapshot`/`toMatchInlineSnapshot`/`toMatchFileSnapshot`/`toMatchImageSnapshot`) không được
//      là khẳng định duy nhất của một test.
// Helper khẳng định = hàm khai ở hạ tầng test (`SUPPORT_PATH`: packages/testkit, apps/*/e2e) hoặc ngay trong file test đó,
// mà thân hàm chứa khẳng định hoặc gọi helper khác (điểm cố định) — vd `expectAccessible`. Hàm của mã sản phẩm KHÔNG là
// helper dù có `assert…` bên trong (đó là guard của nghiệp vụ). Tên `assert…` gọi thẳng trong thân test vẫn tính là khẳng định.
// Bộ phân tích là lexer nhẹ (bỏ chuỗi/comment/regex/template) — không phụ thuộc thư viện ngoài.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
  ".git",
  ".autopilot",
  ".xtemplates",
]);
export const TEST_FILE = /\.(test|spec)\.(ts|tsx|mjs)$/;
const SOURCE_FILE = /\.(ts|tsx|mjs)$/;
export const SNAPSHOT_MATCHERS = new Set([
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
  "toMatchFileSnapshot",
  "toMatchImageSnapshot",
  "toHaveScreenshot",
  "toThrowErrorMatchingSnapshot",
  "toThrowErrorMatchingInlineSnapshot",
]);
/** Nơi khai helper khẳng định dùng chung: hạ tầng test (không phải mã sản phẩm — mã sản phẩm có `assert…` là guard, không phải khẳng định test). */
export const SUPPORT_PATH = /^(packages\/testkit\/|apps\/[^/]+\/e2e\/)/;
const TEST_MODIFIERS = new Set([
  "only",
  "skip",
  "todo",
  "fails",
  "concurrent",
  "sequential",
  "fixme",
  "runIf",
  "skipIf",
]);

export function walk(dir, accept, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, accept, out);
    else if (accept.test(name)) out.push(p);
  }
  return out;
}

const REGEX_PREV = new Set([..."(,=:[!&|?{};+-*%<>~^"]);

/**
 * Thay nội dung chuỗi, template, comment, regex literal bằng khoảng trắng (giữ xuống dòng và độ dài) để tìm cú pháp
 * bằng regex/đếm ngoặc không bị nhiễu. Giữ nguyên dấu nháy mở/đóng của chuỗi để vị trí không đổi.
 * `keepComments: true` giữ nguyên comment (chỉ xoá chuỗi/regex/template) — để trích comment thật, không lẫn chuỗi giống comment.
 */
export function blank(src, { keepComments = false } = {}) {
  return lex(src, keepComments).out.join("");
}

/** Lexer lõi của `blank`: trả {out: mảng ký tự đã làm trống, comments: [[bắt đầu, kết thúc)] của mọi comment thật}. */
export function lex(src, keepComments = false) {
  const out = src.split("");
  const comments = [];
  const n = src.length;
  const wipe = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // Bỏ qua template literal bắt đầu ở `i` (src[i] === "`"); trả về chỉ số sau dấu ` đóng. Phần `${…}` giữ nguyên (là mã).
  const template = (i) => {
    let k = i + 1;
    while (k < n) {
      const c = src[k];
      if (c === "\\") {
        wipe(k, k + 2);
        k += 2;
      } else if (c === "`") return k + 1;
      else if (c === "$" && src[k + 1] === "{") {
        k = code(k + 2, true);
      } else {
        if (c !== "\n") out[k] = " ";
        k++;
      }
    }
    return k;
  };
  // Duyệt mã từ `i`; nếu `inTemplate` thì dừng khi gặp `}` khớp `${` và trả về chỉ số sau nó.
  const code = (i, inTemplate) => {
    let depth = 0;
    let prev = "";
    let k = i;
    while (k < n) {
      const c = src[k];
      const d = src[k + 1];
      if (c === "/" && d === "/") {
        const e = src.indexOf("\n", k);
        const end = e === -1 ? n : e;
        comments.push([k, end]);
        if (!keepComments) wipe(k, end);
        k = end;
      } else if (c === "/" && d === "*") {
        const e = src.indexOf("*/", k + 2);
        const end = e === -1 ? n : e + 2;
        comments.push([k, end]);
        if (!keepComments) wipe(k, end);
        k = end;
      } else if (c === '"' || c === "'") {
        let e = k + 1;
        while (e < n && src[e] !== c && src[e] !== "\n") e += src[e] === "\\" ? 2 : 1;
        wipe(k + 1, e);
        k = e + 1;
        prev = c;
      } else if (c === "`") {
        k = template(k);
        prev = "`";
      } else if (c === "/" && (prev === "" || REGEX_PREV.has(prev) || prev === "n")) {
        // regex literal (prev "n" = sau từ khoá như `return`/`typeof` — xấp xỉ), quét tới `/` đóng ngoài lớp [...]
        let e = k + 1;
        let cls = false;
        while (e < n && src[e] !== "\n") {
          if (src[e] === "\\") e += 2;
          else if (src[e] === "[") {
            cls = true;
            e++;
          } else if (src[e] === "]") {
            cls = false;
            e++;
          } else if (src[e] === "/" && !cls) break;
          else e++;
        }
        if (src[e] === "/") {
          wipe(k + 1, e);
          k = e + 1;
          prev = "/";
        } else {
          prev = c;
          k++;
        }
      } else {
        if (inTemplate) {
          if (c === "{") depth++;
          else if (c === "}") {
            if (depth === 0) return k + 1;
            depth--;
          }
        }
        if (!/\s/.test(c))
          prev = /[A-Za-z0-9_$]/.test(c)
            ? /[A-Za-z_$]/.test(c) &&
              /\b(return|typeof|case|of|in)$/.test(src.slice(Math.max(0, k - 6), k + 1))
              ? "n"
              : "x"
            : c;
        k++;
      }
    }
    return k;
  };
  code(0, false);
  return { out, comments };
}

/** Chỉ số `)` khớp với `(` tại `open` trong văn bản đã `blank`; -1 nếu mất cân bằng. */
export function matchParen(text, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Các lời gọi khai báo test trong `src`: {name, line, body, kind}. `kind`: "test" (có hàm thân), "todo" (không có
 * thân thực thi), "dynamic" (không tìm được thân). `describe`/hook/`test.step`/`test.use`… không tính.
 */
export function findTests(src) {
  const text = blank(src);
  const out = [];
  const re = /(?<![\w$.])(it|test)((?:\s*\.\s*[A-Za-z]+)*)\s*(?:\(|<)/g;
  for (const m of text.matchAll(re)) {
    const mods = [...m[2].matchAll(/\.\s*([A-Za-z]+)/g)].map((x) => x[1]);
    // `test.describe`, `test.step`, `test.use`, `test.beforeEach`… không phải khai báo test.
    if (mods.some((x) => !TEST_MODIFIERS.has(x) && x !== "each")) continue;
    let open = text.indexOf("(", m.index + m[0].length - 1);
    if (open === -1) continue;
    let close = matchParen(text, open);
    if (close === -1) continue;
    const isEach = mods.includes("each");
    if (isEach) {
      // it.each(bảng)("tên", fn): lời gọi thật là cặp ngoặc kế tiếp
      const next = /^\s*\(/.exec(text.slice(close + 1));
      if (!next) continue;
      open = close + 1 + next[0].length - 1;
      close = matchParen(text, open);
      if (close === -1) continue;
    }
    const args = text.slice(open + 1, close);
    // Điều kiện kiểu `test.skip(cond, "lý do")` trong thân test: đối số đầu không phải tên test và không có hàm → bỏ.
    const line = src.slice(0, m.index).split("\n").length;
    const hasFn = /=>|\bfunction\b/.test(args);
    if (mods.includes("todo")) {
      out.push({ name: mods.join("."), line, body: "", kind: "todo" });
      continue;
    }
    if (!hasFn) {
      // `test.skip(cond, reason)` / `test.fixme(...)` bên trong test: không phải khai báo.
      if (mods.some((x) => x === "skip" || x === "fixme" || x === "skipIf" || x === "runIf")) {
        if (!/^\s*(["'`])/.test(src.slice(open + 1, close))) continue;
      }
      out.push({ name: mods.join("."), line, body: args, kind: "dynamic" });
      continue;
    }
    out.push({ name: mods.join("."), line, body: args, kind: "test" });
  }
  return out;
}

/** Khẳng định trong thân test: số khẳng định thật, số snapshot. `helpers` = tập tên helper khẳng định. */
export function countAssertions(body, helpers = new Set()) {
  let real = 0;
  let snapshot = 0;
  const text = body;
  for (const m of text.matchAll(/(?<![\w$])(expect(?:TypeOf)?)\s*(?:\.\s*(?:soft|poll)\s*)?\(/g)) {
    const open = text.indexOf("(", m.index + m[1].length);
    const close = matchParen(text, open);
    if (close === -1) {
      real++;
      continue;
    }
    // Chuỗi sau expect(...): .not/.resolves/.rejects rồi .matcher(
    const tail = /^(?:\s*\.\s*(?:not|resolves|rejects)\b)*\s*\.\s*([A-Za-z]+)/.exec(text.slice(close + 1));
    if (tail && SNAPSHOT_MATCHERS.has(tail[1])) snapshot++;
    else real++;
  }
  for (const m of text.matchAll(
    /(?<![\w$.])assert[A-Za-z]*\s*[.(]|\.\s*should\b|\bfc\.assert\s*\(|\bassert\s*\./g,
  )) {
    void m;
    real++;
  }
  for (const h of helpers) {
    const re = new RegExp(`(?<![\\w$.])${h.replace(/\$/g, "\\$")}\\s*\\(`, "g");
    for (const _ of text.matchAll(re)) real++;
  }
  return { real, snapshot };
}

/** Các hàm khai trong `src` (function declaration và `const f = (…) =>`): [{name, body}] (body đã `blank`). */
export function collectDefs(src) {
  const text = blank(src);
  const defs = [];
  for (const m of text.matchAll(
    /(?<![\w$.])(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g,
  )) {
    const open = text.indexOf("(", m.index + m[0].length - 1);
    const close = matchParen(text, open);
    if (close === -1) continue;
    const brace = text.indexOf("{", close);
    if (brace === -1) continue;
    const end = matchParen(text, brace);
    if (end === -1) continue;
    defs.push({ name: m[1], body: text.slice(brace, end + 1) });
  }
  for (const m of text.matchAll(
    /(?<![\w$.])(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=\n{]+)?=>/g,
  )) {
    const after = m.index + m[0].length;
    const rest = text.slice(after);
    const brace = /^\s*\{/.exec(rest);
    let body;
    if (brace) {
      const open = after + brace[0].length - 1;
      const end = matchParen(text, open);
      if (end === -1) continue;
      body = text.slice(open, end + 1);
    } else {
      const stop = rest.search(/\n(?=\S)/);
      body = stop === -1 ? rest : rest.slice(0, stop);
    }
    defs.push({ name: m[1], body });
  }
  return defs;
}

/** Điểm cố định: tên hàm trong `defs` mà thân chứa khẳng định thật hoặc gọi helper đã biết (kể cả `seed`). */
export function helperFixpoint(defs, seed = new Set()) {
  const helpers = new Set(seed);
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of defs) {
      if (helpers.has(d.name)) continue;
      if (countAssertions(d.body, helpers).real > 0) {
        helpers.add(d.name);
        changed = true;
      }
    }
  }
  return helpers;
}

/**
 * Helper khẳng định DÙNG CHUNG: hàm khai ở file hạ tầng test (`SUPPORT_PATH`, không phải file test) — vd `expectAccessible`.
 * Helper khai ngay trong file test chỉ có hiệu lực trong file đó (tránh tên chung như `run` ở file này che lỗ hổng ở file khác).
 * `files` = {path → nội dung}.
 */
export function assertionHelpers(files) {
  const defs = Object.entries(files)
    .filter(([rel]) => SUPPORT_PATH.test(rel) && !TEST_FILE.test(rel))
    .flatMap(([, src]) => collectDefs(src));
  return helperFixpoint(defs);
}

/**
 * Đánh giá một file test: danh sách vi phạm {line, name, reason}. `reason` ∈ "no-assertion" | "snapshot-only" |
 * "todo" | "dynamic".
 */
export function violationsIn(src, helpers = new Set()) {
  const out = [];
  for (const t of findTests(src)) {
    if (t.kind === "todo") {
      out.push({ line: t.line, name: t.name, reason: "todo" });
      continue;
    }
    const { real, snapshot } = countAssertions(t.body, helpers);
    if (real === 0 && snapshot > 0) out.push({ line: t.line, name: t.name, reason: "snapshot-only" });
    else if (real === 0) out.push({ line: t.line, name: t.name, reason: "no-assertion" });
  }
  return out;
}

/** Quét cả repo: trả {violations: [{file, line, reason}], tests: số test đã thấy, files: số file test}. */
export function scanRepo(root = ROOT) {
  const sourceFiles = walk(root, SOURCE_FILE);
  const contents = Object.fromEntries(sourceFiles.map((f) => [relative(root, f), readFileSync(f, "utf8")]));
  const helpers = assertionHelpers(contents);
  const supportDefs = Object.entries(contents)
    .filter(([rel]) => SUPPORT_PATH.test(rel) && !TEST_FILE.test(rel))
    .flatMap(([, src]) => collectDefs(src));
  const violations = [];
  let tests = 0;
  let files = 0;
  for (const [rel, src] of Object.entries(contents)) {
    if (!TEST_FILE.test(rel)) continue;
    files++;
    tests += findTests(src).length;
    const local = helperFixpoint([...supportDefs, ...collectDefs(src)], helpers);
    for (const v of violationsIn(src, local)) violations.push({ file: rel, ...v });
  }
  return { violations, tests, files, helpers };
}
