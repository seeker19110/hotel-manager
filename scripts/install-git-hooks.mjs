// Cài hook git của dự án (XC-DX-006): chạy tự động qua script `prepare` sau `pnpm install`.
// Ghi một "stub" vào thư mục hooks của git (`.git/hooks/pre-commit`) gọi `.githooks/pre-commit` của cây làm việc hiện tại
// → sửa logic hook chỉ cần đổi `.githooks/`, không cần cài lại. Cài tốt nhất có thể: không có git, không phải repo git
// (Docker build, tarball), hoặc đã có hook của công cụ khác → không làm gì và KHÔNG làm hỏng `pnpm install`.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Dòng nhận diện hook do script này tạo (để chạy lại an toàn, không đè hook của công cụ khác). */
export const MARKER =
  "# hm-managed-hook: sinh bởi scripts/install-git-hooks.mjs — đừng sửa tay, sửa .githooks/pre-commit";

export const STUB = `#!/bin/sh
${MARKER}
hook="$(git rev-parse --show-toplevel)/.githooks/pre-commit"
[ -x "$hook" ] || exit 0
exec "$hook" "$@"
`;

/** Chạy git, trả stdout đã cắt khoảng trắng; `null` khi git lỗi/không có. */
function git(cwd, env, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return r.error || r.status !== 0 ? null : r.stdout.trim();
}

/** `true` nếu `child` nằm trong (hoặc chính là) `parent` — so theo đường dẫn thật, bỏ qua symlink. */
function isInside(parent, child) {
  const rel = relative(realpathSync(parent), realpathSync(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Không ghi vào thư mục hooks dùng chung của người dùng: `core.hooksPath` có giá trị (repo/toàn cục/hệ thống) hoặc thư mục hooks
 * đã resolve nằm ngoài `git-common-dir` của repo → `skip-hooks-path` (chỉ cảnh báo, không ghi gì).
 * @param {string} cwd thư mục chạy (repo cần cài hook)
 * @param {Record<string, string>} [env] biến môi trường thêm cho git (test)
 * @returns {{ status: "installed" | "updated" | "unchanged" | "foreign-hook" | "no-git" | "skip-hooks-path"; path?: string }}
 */
export function installHooks(cwd = process.cwd(), env = {}) {
  const hooksPath = git(cwd, env, ["rev-parse", "--git-path", "hooks"]);
  if (hooksPath === null) return { status: "no-git" };
  const dir = resolve(cwd, hooksPath);
  const configured = git(cwd, env, ["config", "--get", "core.hooksPath"]);
  if (configured) return { status: "skip-hooks-path", path: dir };
  const common = git(cwd, env, ["rev-parse", "--git-common-dir"]);
  if (common === null) return { status: "no-git" };
  const commonDir = resolve(cwd, common);
  // Thư mục hooks chưa tồn tại (repo mới) → xét thư mục cha gần nhất đã có.
  let probe = dir;
  while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
  if (!isInside(commonDir, probe)) return { status: "skip-hooks-path", path: dir };
  const path = resolve(dir, "pre-commit");
  let status = "installed";
  if (existsSync(path)) {
    const cur = readFileSync(path, "utf8");
    if (!cur.includes("hm-managed-hook")) return { status: "foreign-hook", path };
    status = cur === STUB ? "unchanged" : "updated";
  }
  if (status !== "unchanged") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, STUB);
  }
  chmodSync(path, 0o755);
  return { status, path };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { status, path } = installHooks(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (status === "foreign-hook")
    console.warn(`[git-hooks] đã có ${path} của công cụ khác — giữ nguyên, hook dự án KHÔNG được cài.`);
  else if (status === "skip-hooks-path")
    console.warn(
      `[git-hooks] skip-hooks-path: core.hooksPath đã đặt hoặc thư mục hooks (${path}) nằm ngoài .git của repo — KHÔNG ghi gì, hook dự án KHÔNG được cài. ` +
        "Tự gọi .githooks/pre-commit từ hook của bạn, hoặc chạy: git config core.hooksPath .githooks",
    );
  else if (status !== "no-git") console.log(`[git-hooks] pre-commit: ${status} (${path})`);
}
