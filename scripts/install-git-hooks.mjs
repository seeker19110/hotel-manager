// Cài hook git của dự án (XC-DX-006): chạy tự động qua script `prepare` sau `pnpm install`.
// Ghi một "stub" vào thư mục hooks của git (`.git/hooks/pre-commit`) gọi `.githooks/pre-commit` của cây làm việc hiện tại
// → sửa logic hook chỉ cần đổi `.githooks/`, không cần cài lại. Cài tốt nhất có thể: không có git, không phải repo git
// (Docker build, tarball), hoặc đã có hook của công cụ khác → không làm gì và KHÔNG làm hỏng `pnpm install`.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

/**
 * @param {string} cwd thư mục chạy (repo cần cài hook)
 * @param {Record<string, string>} [env] biến môi trường thêm cho git (test)
 * @returns {{ status: "installed" | "updated" | "unchanged" | "foreign-hook" | "no-git"; path?: string }}
 */
export function installHooks(cwd = process.cwd(), env = {}) {
  const r = spawnSync("git", ["rev-parse", "--git-path", "hooks"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (r.error || r.status !== 0) return { status: "no-git" };
  const dir = resolve(cwd, r.stdout.trim());
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
  else if (status !== "no-git") console.log(`[git-hooks] pre-commit: ${status} (${path})`);
}
