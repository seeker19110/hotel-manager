// Helper CHỈ cho test: duyệt mã nguồn repo để dựng "rào" (guard) bằng quét văn bản — không import từ mã chạy.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
]);

export interface SourceFile {
  /** Đường dẫn tương đối từ gốc repo, dấu `/`. */
  path: string;
  text: string;
}

/** Mọi file có đuôi trong `exts` dưới các thư mục `roots` (tương đối gốc repo), bỏ thư mục sinh ra/phụ thuộc. */
export function sourceFiles(
  roots: readonly string[],
  exts: RegExp,
  opts: { includeTests?: boolean } = {},
): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (
        exts.test(name) &&
        (opts.includeTests || !/\.test\.(ts|tsx|mjs)$|(^|\/)test_.*\.py$/.test(name))
      )
        out.push({ path: relative(REPO_ROOT, p).split("\\").join("/"), text: readFileSync(p, "utf8") });
    }
  };
  for (const r of roots) walk(join(REPO_ROOT, r));
  return out;
}

/** Nội dung giữa cặp `{ … }` bắt đầu tại `open` (chỉ số của `{`); đếm ngoặc, đủ cho mã TS đã qua formatter. */
export function braceBody(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}
