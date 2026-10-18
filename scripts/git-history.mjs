// Hàm git dùng chung cho các rào so với nhánh gốc (DB-MIG-003, ARC-ADR-004, STD-PROC-003): CI checkout `fetch-depth: 0`
// rồi so `BASE...HEAD`. Không có phụ thuộc ngoài; test: scripts/history-guards.test.mjs.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Môi trường sạch biến GIT_* (hook/worktree có thể đặt GIT_DIR, GIT_INDEX_FILE… làm lệch repo đích). */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
}

/** Chạy `git <args>` trong `cwd`, trả stdout (UTF-8); lỗi → ném. */
export function git(args, cwd = process.cwd()) {
  return execFileSync("git", args, {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** `ref` có phân giải được thành commit không. */
export function refExists(ref, cwd) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Nội dung file tại `ref`; file không có ở `ref` → null. */
export function showAt(ref, path, cwd) {
  try {
    return git(["show", `${ref}:${path}`], cwd);
  } catch {
    return null;
  }
}

/** File đổi giữa `base` (điểm rẽ) và HEAD dưới `paths`: [{ status: "A"|"M"|"D"|"T", path }] (không dò đổi tên). */
export function changedEntries(base, paths, cwd) {
  const out = git(["diff", "--name-status", "--no-renames", "-z", `${base}...HEAD`, "--", ...paths], cwd);
  const parts = out.split("\0").filter((s) => s !== "");
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) entries.push({ status: parts[i][0], path: parts[i + 1] });
  return entries;
}

/** Đường dẫn file có ở `ref` dưới thư mục `dir`. */
export function filesAt(ref, dir, cwd) {
  return git(["ls-tree", "-r", "--name-only", "-z", ref, "--", `${dir}/`], cwd)
    .split("\0")
    .filter((s) => s !== "");
}

/** Đọc `--base X` (mặc định `fallback`) từ argv. */
export function argValue(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

/** Chạy `main()` chỉ khi file này là điểm vào (không chạy khi test import). */
export function isMain(metaUrl) {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === metaUrl;
}
