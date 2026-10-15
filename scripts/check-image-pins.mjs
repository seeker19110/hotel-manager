// Hàng rào chuỗi cung ứng (T-012): mọi image container trong deploy/ phải ghim digest sha256 — tag trôi bị chặn.
// Kiểm `image:` trong compose và `FROM` trong Dockerfile; test: scripts/check-image-pins.test.mjs (chạy trong `pnpm test`).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PINNED = /@sha256:[0-9a-f]{64}$/;

/** Trả về các tham chiếu image chưa ghim digest trong nội dung một file. */
export function findUnpinned(text) {
  const refs = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const m =
      /^(?:-\s*)?image:\s*["']?([^"'\s]+)["']?$/.exec(line) ??
      /^FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
    if (m && m[1] !== "scratch" && !PINNED.test(m[1])) refs.push(m[1]);
  }
  return refs;
}

/** Các file cần kiểm dưới thư mục deploy (compose*.yaml/yml, Dockerfile*). */
export function deployFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    if (/^(compose|docker-compose).*\.ya?ml$/.test(e.name) || /^Dockerfile/.test(e.name)) {
      out.push(join(e.parentPath, e.name));
    }
  }
  return out.sort();
}

export function checkDir(dir) {
  return deployFiles(dir).flatMap((f) => findUnpinned(readFileSync(f, "utf8")).map((ref) => `${f}: ${ref}`));
}
