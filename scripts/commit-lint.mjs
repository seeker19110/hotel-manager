// Kiểm commit message theo Conventional Commits 1.0.0 (BASE-REPO-005; PLAN đợt 9 T-802).
// `type(scope)!: mô tả` · type thuộc danh sách khung · subject (dòng đầu) ≤ 72 KÝ TỰ (đếm điểm mã Unicode, không đếm byte —
// tiếng Việt có dấu) · mô tả không rỗng · thân cách tiêu đề một dòng trống · footer `BREAKING CHANGE:`/`BREAKING-CHANGE:`
// phải có nội dung. Bỏ qua commit merge (`Merge …`) và dòng chú thích `#` của git khi dùng làm hook.
// Cùng một luật ở 3 nơi: hook local `.githooks/commit-msg`, `scripts/commit-gated.sh`, và CI (`.github/workflows/commit-lint.yml`
// kiểm MỌI commit của PR bằng `--range`). Tiêu đề PR (squash) vẫn do job `quality` kiểm bằng cùng regex.
// Dùng: node scripts/commit-lint.mjs --message "<msg>" | --file <đường dẫn COMMIT_EDITMSG> | --range <base>..<head>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isMain } from "./is-main.mjs";

export const TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];
export const MAX_SUBJECT = 72;
const HEADER = new RegExp(
  `^(?<type>${TYPES.join("|")})(?:\\((?<scope>[a-z0-9._/-]+)\\))?(?<bang>!)?: (?<desc>.*)$`,
);
const MERGE = /^Merge (?:branch|remote-tracking branch|pull request|tag) /;

/** Bỏ dòng chú thích `#` (git tự thêm khi soạn commit) và khoảng trắng cuối; giữ nguyên dòng trống ở giữa. */
export function stripComments(message) {
  return message
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .replace(/\s+$/, "");
}

/** Lỗi của một commit message ([] = hợp lệ). `message` có thể chứa chú thích `#`. */
export function lintMessage(message) {
  const msg = stripComments(String(message ?? ""));
  const lines = msg.split("\n");
  const header = lines[0] ?? "";
  if (header.trim() === "") return ["commit message rỗng"];
  if (MERGE.test(header)) return [];
  const errors = [];
  const len = [...header].length;
  if (len > MAX_SUBJECT) errors.push(`dòng đầu dài ${len} ký tự > ${MAX_SUBJECT}: "${header}"`);
  const m = HEADER.exec(header);
  if (!m) {
    errors.push(`dòng đầu phải dạng "type(scope)!: mô tả" với type ∈ {${TYPES.join(", ")}}: "${header}"`);
  } else if (m.groups.desc.trim() === "") {
    errors.push("mô tả sau dấu hai chấm không được rỗng");
  } else if (/^\s|\s$/.test(m.groups.desc)) {
    errors.push("mô tả không được bắt đầu/kết thúc bằng khoảng trắng");
  }
  if (lines.length > 1 && lines[1].trim() !== "") errors.push("giữa dòng đầu và thân phải có một dòng trống");
  // Footer phá vỡ tương thích: `BREAKING CHANGE: <mô tả>` (hoa, có nội dung).
  lines.slice(1).forEach((l, i) => {
    if (/^BREAKING[ -]CHANGE\b/i.test(l)) {
      if (!/^BREAKING[ -]CHANGE: \S/.test(l))
        errors.push(`dòng ${i + 2}: footer phải là "BREAKING CHANGE: <mô tả>" (viết hoa, có nội dung)`);
    }
  });
  return errors;
}

/** Tách đầu ra `git log --format=%H%x00%B%x01` thành [{sha, message}]. */
export function parseLog(raw) {
  return raw
    .split("\x01")
    .map((chunk) => chunk.replace(/^\n+/, ""))
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => {
      const [sha, ...rest] = chunk.split("\x00");
      return { sha: sha.trim(), message: rest.join("\x00") };
    });
}

/** Kiểm mọi commit không-merge trong `range` (vd `origin/main..HEAD`). Trả [{sha, errors}] chỉ gồm commit lỗi. */
export function lintRange(range, cwd = process.cwd()) {
  const raw = execFileSync("git", ["log", "--no-merges", "--format=%H%x00%B%x01", range], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseLog(raw)
    .map(({ sha, message }) => ({ sha, errors: lintMessage(message) }))
    .filter((r) => r.errors.length > 0);
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const message = arg(argv, "--message");
  const file = arg(argv, "--file");
  const range = arg(argv, "--range");
  if ([message, file, range].filter((v) => v !== undefined).length !== 1) {
    process.stderr.write(
      'Dùng: node scripts/commit-lint.mjs --message "<msg>" | --file <COMMIT_EDITMSG> | --range <base>..<head>\n',
    );
    return 2;
  }
  if (range !== undefined) {
    const bad = lintRange(range);
    for (const r of bad)
      process.stderr.write(`::error::commit ${r.sha.slice(0, 10)}: ${r.errors.join("; ")}\n`);
    if (bad.length > 0) {
      process.stderr.write(
        `✗ ${bad.length} commit vi phạm Conventional Commits (sửa bằng rebase tương tác/amend trên nhánh của bạn).\n`,
      );
      return 1;
    }
    process.stdout.write(`✓ Mọi commit trong ${range} theo Conventional Commits.\n`);
    return 0;
  }
  const errors = lintMessage(message ?? readFileSync(file, "utf8"));
  if (errors.length > 0) {
    process.stderr.write(`✗ commit message sai Conventional Commits 1.0.0:\n  ${errors.join("\n  ")}\n`);
    return 1;
  }
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
