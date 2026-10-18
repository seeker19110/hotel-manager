// Module đang được chạy trực tiếp (`node scripts/x.mjs`) hay chỉ được import? So URL thật (qua realpath/symlink, ký tự
// đặc biệt trong đường dẫn được mã hoá đúng) thay cho `import.meta.url === \`file://${argv[1]}\`` — sai khi đường dẫn có
// khoảng trắng/Unicode hoặc đi qua symlink.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @param {string} metaUrl `import.meta.url` của module gọi */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== "string" || argv1 === "") return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === metaUrl;
  } catch {
    return false; // argv[1] không phải đường dẫn tồn tại (vd. `node -e`, REPL) → không phải chạy trực tiếp
  }
}
