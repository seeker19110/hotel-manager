// Rào truy vấn Testing Library (FE-TEST-001; PLAN đợt 9 T-804). Thay cho `eslint-plugin-testing-library` (repo dùng Biome,
// không có ESLint): quét mọi file `*.test.tsx` có import `@testing-library/*` và đòi
//   1. prefer-screen-queries — truy vấn qua `screen.…`/`within(…)`, KHÔNG lấy `getBy…` ra từ kết quả `render(…)` (destructure
//      hoặc `const view = render(…); view.getByRole(…)`);
//   2. no-container — không đụng `container`/`baseElement` (cả `view.container`; đi vòng qua truy vấn theo vai trò/nhãn);
//   3. getByTestId chỉ khi không có lựa chọn khác: mỗi lần dùng có chú thích `// testid: <lý do>` ở cùng dòng hoặc dòng trên,
//      và tỷ lệ `…ByTestId` / tổng truy vấn ≤ 10% (MAX_TESTID_RATIO).
// Dùng lexer của `test-assertions.mjs` để chuỗi/comment không gây nhiễu.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { blank, ROOT, TEST_FILE, walk } from "./test-assertions.mjs";

export const MAX_TESTID_RATIO = 0.1;
const QUERY =
  /\b(?:get|query|find)(?:All)?By(Role|LabelText|PlaceholderText|Text|DisplayValue|AltText|Title|TestId)\b/g;
const DESTRUCTURED_FROM_RENDER =
  /\{[^{}]*\b(?:get|query|find)(?:All)?By\w+[^{}]*\}\s*=\s*(?:await\s+)?render(?:Hook)?\s*\(/;
/** `const view = render(…)` — tên được gán kết quả render (để bắt `view.getByRole(…)`). */
const RENDER_RESULT_NAME =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?render(?:Hook)?\s*\(/g;
const CONTAINER_USE =
  /\{[^{}]*\b(?:container|baseElement)\b[^{}]*\}\s*=\s*render\s*\(|\b(?:container|baseElement)\s*\.|\.\s*(?:container|baseElement)\b/;
const TESTID_NOTE = /\/\/\s*testid:\s*\S.{2,}/;

/** Có dùng Testing Library không (chỉ các file này chịu rào). */
export const usesTestingLibrary = (src) => /from\s+["']@testing-library\//.test(src);

/** Đếm truy vấn trong một file: {total, testId}. */
export function countQueries(src) {
  let total = 0;
  let testId = 0;
  for (const m of blank(src).matchAll(QUERY)) {
    total++;
    if (m[1] === "TestId") testId++;
  }
  return { total, testId };
}

/** Vi phạm trong MỘT file: [{line, rule, text}] (chưa tính tỷ lệ toàn cục). */
export function violationsIn(src) {
  const clean = blank(src);
  const rawLines = src.split("\n");
  const cleanLines = clean.split("\n");
  const out = [];
  // prefer-screen-queries / no-container có thể trải nhiều dòng (destructure xuống dòng) → quét theo đoạn rồi quy về dòng.
  const lineOf = (index) => clean.slice(0, index).split("\n").length;
  const dm = DESTRUCTURED_FROM_RENDER.exec(clean);
  if (dm)
    out.push({
      line: lineOf(dm.index),
      rule: "prefer-screen-queries",
      text: "lấy truy vấn từ kết quả render()",
    });
  for (const nm of clean.matchAll(RENDER_RESULT_NAME)) {
    const name = (nm[1] ?? "").replaceAll("$", "\\$");
    const use = new RegExp(`(?<![\\w$])${name}\\s*\\.\\s*(?:get|query|find)(?:All)?By\\w+`).exec(clean);
    if (use)
      out.push({
        line: lineOf(use.index),
        rule: "prefer-screen-queries",
        text: `truy vấn qua kết quả render() (${nm[1]}.…), dùng screen`,
      });
  }
  const cm = CONTAINER_USE.exec(clean);
  if (cm) out.push({ line: lineOf(cm.index), rule: "no-container", text: "dùng container/baseElement" });
  cleanLines.forEach((line, i) => {
    if (!/\b(?:get|query|find)(?:All)?ByTestId\b/.test(line)) return;
    const noted = TESTID_NOTE.test(rawLines[i] ?? "") || TESTID_NOTE.test(rawLines[i - 1] ?? "");
    if (!noted)
      out.push({
        line: i + 1,
        rule: "testid-needs-reason",
        text: "getByTestId thiếu chú thích `// testid: <lý do>`",
      });
  });
  return out;
}

/** Quét repo: {files, total, testId, ratio, violations:[{file,line,rule,text}]}. */
export function scanRepo(root = ROOT) {
  const files = walk(root, /\.test\.tsx$/).filter((f) => TEST_FILE.test(f));
  const violations = [];
  let total = 0;
  let testId = 0;
  let scanned = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!usesTestingLibrary(src)) continue;
    scanned++;
    const c = countQueries(src);
    total += c.total;
    testId += c.testId;
    for (const v of violationsIn(src)) violations.push({ file: relative(root, f), ...v });
  }
  const ratio = total === 0 ? 0 : testId / total;
  if (ratio > MAX_TESTID_RATIO) {
    violations.push({
      file: "(toàn bộ test component)",
      line: 0,
      rule: "testid-ratio",
      text: `getByTestId ${testId}/${total} = ${(ratio * 100).toFixed(1)}% > ${MAX_TESTID_RATIO * 100}%`,
    });
  }
  return { files: scanned, total, testId, ratio, violations };
}
