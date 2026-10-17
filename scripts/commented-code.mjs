// Rào "không có code comment-out bỏ dở" ở mã chạy (QA-STATIC-005; PLAN đợt 8 T-703, D-055). Cùng kiểu `no-console.test.ts`:
// test quét mã trong project unit thay cho rule lint (đổi `biome.json` là điểm dừng). Phát hiện theo DÒNG comment
// (`// …` và từng dòng trong `/* … */`) trông như cú pháp mã: câu lệnh kết thúc `;`, khai báo, rẽ nhánh/vòng lặp, import/export,
// lời gọi hàm đứng một mình. Comment tiếng Việt (có chữ có dấu) và câu văn tiếng Anh dài (≥ 5 từ liên tiếp) không bị báo.
// Comment lấy bằng lexer (không nhầm chuỗi/regex/template giống comment). Không phụ thuộc thư viện ngoài.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { lex, ROOT, walk } from "./test-assertions.mjs";

export const SCAN_DIRS = ["packages", "apps", "scripts"];
export const SOURCE = /\.(ts|tsx|mjs|js)$/;
/** File test và file khai báo kiểu `.d.ts` không thuộc phạm vi "mã chạy". */
export const EXCLUDE = /\.(test|spec)\.(ts|tsx|mjs)$|\.d\.ts$/;

/** Chỉ thị công cụ / nhãn việc: không phải code comment-out. */
const DIRECTIVE =
  /^(?:biome-ignore|@ts-|eslint|istanbul|c8\b|prettier-ignore|vitest-environment|#?region|#?endregion|TODO|FIXME|NOTE|XXX|HACK|https?:|<reference)/i;

const PATTERNS = [
  // khai báo
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:const|let|var)\s+[\w${}[\],\s:<>|]+?=\s*\S/,
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[\w$]*\s*(?:<[^>]*>)?\s*\(/,
  /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[\w$]+[^;]*\{\s*$/,
  /^(?:export\s+)?(?:interface|enum)\s+[\w$]+[^;]*\{\s*$/,
  /^(?:export\s+)?type\s+[\w$]+(?:<[^>]*>)?\s*=\s*\S/,
  // câu lệnh
  /^(?:await|return|throw|yield|delete|break|continue)\b.*;\s*$/,
  /^(?:return|break|continue);?\s*$/,
  // rẽ nhánh / vòng lặp
  /^(?:\}\s*)?(?:else\s+)?(?:if|for|while|switch|catch)\s*\(.*\)\s*\{?\s*$/,
  /^(?:\}\s*)?else\s*\{?\s*$/,
  /^try\s*\{\s*$/,
  /^\}\s*(?:catch|finally)\b.*\{\s*$/,
  /^(?:case\s+.+|default)\s*:\s*$/,
  // module
  /^import\s.+\sfrom\s+['"][^'"]*['"]\s*;?\s*$/,
  /^import\s+['"][^'"]*['"]\s*;?\s*$/,
  /^export\s*(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s*(?:from\s+['"][^'"]*['"])?\s*;?\s*$/,
  // lời gọi / gán đứng một mình
  /^[A-Za-z_$][\w$]*(?:\??\.[\w$]+|\[[^\]]*\])*\(.*\)\s*;\s*$/,
  /^[A-Za-z_$][\w$]*(?:\??\.[\w$]+)+\(.*\)\s*$/, // không `;` thì buộc là lời gọi phương thức (a.b(…)) — `Tên(ghi)` trơn là tiêu đề
  /^[A-Za-z_$][\w$]*(?:\??\.[\w$]+|\[[^\]]*\])*\s*(?:[-+*/%|&^?]{0,2}=|\+\+|--)(?!=)\s*.*;\s*$/,
  // ngoặc đóng lẻ của khối bị comment
  /^[}\])]+[;,)]*\s*$/,
  // JSX comment-out (`{/* <Button … /> */}`): thẻ đầy đủ, thẻ component mở dở nhiều dòng, dòng thuộc tính, biểu thức `{…}`
  /^<\/?>$/,
  /^<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>$/,
  /^<[A-Z][\w.]*\s*$/,
  /^[\w-]+=(?:\{.*\}|""|'')\s*\/?>?$/,
  /^\{[\w$.?]+\(.*\)\}$/,
];

const JSX_ELEMENT = /^<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>.*<\/\1>$/;

/** Thay nội dung chuỗi "…", '…', `…` bằng chuỗi rỗng cùng dấu nháy: chữ có dấu trong chuỗi không biến dòng mã thành văn xuôi. */
export function stripStrings(t) {
  return t.replace(
    /"(?:[^"\\]|\\.)*"|(?<![\w])'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
    (m) => `${m[0]}${m[0]}`,
  );
}

/** Dòng comment đã bỏ ký hiệu `//`, `/*`, `*`, `*\/` — trông như mã? */
export function looksLikeCode(text) {
  const t = stripStrings(text.trim());
  if (!t || DIRECTIVE.test(t)) return false;
  if (JSX_ELEMENT.test(t)) return true; // phần tử JSX có chữ con tiếng Việt vẫn là mã
  if ([...t].some((c) => c.charCodeAt(0) > 127 && /\p{L}/u.test(c))) return false; // có chữ ngoài ASCII (tiếng Việt có dấu) → văn xuôi
  if (/(?:^|\s)[A-Za-z]{2,}(?:\s+[A-Za-z]{2,}){4,}(?:\s|$)/.test(t)) return false; // câu văn ≥ 5 từ liền nhau
  return PATTERNS.some((re) => re.test(t));
}

/**
 * Các dòng comment thật (không lẫn chuỗi/regex/template): [{line, text}] — `text` đã bỏ ký hiệu comment. Mỗi dòng của
 * comment khối là một mục.
 */
export function commentLines(src) {
  const { comments } = lex(src);
  const inComment = new Uint8Array(src.length);
  for (const [a, b] of comments) inComment.fill(1, a, b);
  const owner = new Int32Array(src.length).fill(-1);
  comments.forEach(([a, b], idx) => owner.fill(idx, a, b));
  const out = [];
  let pos = 0;
  src.split("\n").forEach((line, i) => {
    let text = "";
    let block = -1;
    for (let k = 0; k < line.length; k++)
      if (inComment[pos + k]) {
        text += line[k];
        if (block === -1) block = owner[pos + k];
      }
    pos += line.length + 1;
    if (!text.trim()) return;
    text = text
      .replace(/^\s*(?:\/\/+!?|\/\*+!?|\*+(?!\/))\s?/, "")
      .replace(/\s*\*\/\s*$/, "")
      .replace(/^\s*\/\/+\s?/, "");
    if (!text.trim()) return;
    out.push({ line: i + 1, text, block, isLine: block >= 0 && src.startsWith("//", comments[block][0]) });
  });
  return out;
}

/** Vi phạm trong một file: [{line, text}]. */
export function commentedCodeIn(src) {
  const out = [];
  let prev = null;
  let inFence = false;
  let inExample = false;
  for (const c of commentLines(src)) {
    // Trạng thái ``` / @example chỉ sống trong một comment: sang comment khác (hoặc dòng không liền kề) thì đặt lại.
    if (prev === null || c.line !== prev.line + 1 || (c.block !== prev.block && !(c.isLine && prev.isLine))) {
      inFence = false;
      inExample = false;
    }
    prev = c;
    const t = c.text.trim();
    if (/^(?:`{3,}|~{3,})/.test(t)) {
      inFence = !inFence;
      continue;
    }
    if (/^@example\b/.test(t)) {
      inExample = true;
      continue;
    }
    if (inExample && /^@\w+/.test(t)) inExample = false;
    if (inFence || inExample) continue;
    if (looksLikeCode(c.text)) out.push({ line: c.line, text: c.text });
  }
  return out;
}

/** Quét repo: {hits: [{file, line, text}], files: số file đã quét}. */
export function scanRepo(root = ROOT) {
  const hits = [];
  let files = 0;
  for (const dir of SCAN_DIRS)
    for (const f of walk(`${root}${dir}`, SOURCE)) {
      const rel = relative(root, f);
      if (EXCLUDE.test(rel)) continue;
      files++;
      for (const h of commentedCodeIn(readFileSync(f, "utf8"))) hits.push({ file: rel, ...h });
    }
  return { hits, files };
}
