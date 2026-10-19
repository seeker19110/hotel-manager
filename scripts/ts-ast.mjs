// Phân tích mã TS/TSX/JS thành AST cho các script kiểm (D-078): regex không hiểu template lồng, chú thích trong chuỗi, `//` trong
// chữ JSX — lệch một cặp nháy là sai cả phần sau của tệp. Dùng @babel/parser (plugin typescript + jsx), chỉ đọc, không biến đổi.
import { parse } from "@babel/parser";

/** AST của một tệp. `.ts`/`.mts`/`.cts` không bật jsx (`<T>x` là ép kiểu); tệp khác (và đoạn mã không tên) bật cả jsx. Lỗi cú
 * pháp ném kèm tên tệp — script kiểm đỏ thay vì đếm sai. */
export function parseSource(src, file = "snippet.tsx") {
  const plugins = /\.[mc]?ts$/.test(file) ? ["typescript"] : ["typescript", "jsx"];
  try {
    return parse(src, { sourceType: "module", plugins });
  } catch (e) {
    throw new Error(`${file}: không phân tích được (${e.message})`);
  }
}

const SKIP = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
]);

/** Duyệt mọi nút (sâu trước, theo thứ tự trong mã); chú thích không phải nút nên tự bị loại. */
export function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const [k, v] of Object.entries(node)) {
    if (SKIP.has(k) || !v || typeof v !== "object") continue;
    if (Array.isArray(v)) for (const c of v) walk(c, visit);
    else walk(v, visit);
  }
}
