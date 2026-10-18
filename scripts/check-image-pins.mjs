// Hàng rào chuỗi cung ứng (T-012): mọi image container trong deploy/ phải ghim digest sha256 — tag trôi bị chặn.
// Kiểm `image:` trong compose và `FROM` trong Dockerfile; test: scripts/check-image-pins.test.mjs (chạy trong `pnpm test`).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PINNED = /@sha256:[0-9a-f]{64}$/;

/**
 * Trả về các tham chiếu image chưa ghim digest trong nội dung một file.
 * `skipExpressions`: bỏ qua giá trị là biểu thức workflow (`${{ matrix.x }}`) — dùng cho .github/workflows, nơi image thật
 * nằm ở khoá `ref:` của matrix và được supply-chain.test.mjs kiểm riêng.
 */
export function findUnpinned(text, { skipExpressions = false } = {}) {
  const refs = [];
  // Multi-stage: `FROM <tên stage đã khai báo>` không phải image ngoài.
  const stages = new Set();
  for (const raw of text.split("\n")) {
    const stage = /^FROM\s+.+\s+AS\s+(\S+)\s*$/i.exec(raw.trim());
    const line = raw.replace(/\s+#.*$/, "").trim();
    const m =
      /^(?:-\s*)?image:\s*["']?([^"'\s]+)["']?$/.exec(line) ??
      /^FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
    if (m && skipExpressions && m[1].includes("${{")) continue;
    if (m && m[1] !== "scratch" && !stages.has(m[1].toLowerCase()) && !PINNED.test(m[1])) refs.push(m[1]);
    if (stage?.[1]) stages.add(stage[1].toLowerCase());
  }
  return refs;
}

/** Các file cần kiểm dưới thư mục deploy (compose*.yaml/yml, Dockerfile*). */
export function deployFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    if (/^(compose|docker-compose).*\.ya?ml$/.test(e.name) || /^Dockerfile|\.Dockerfile$/.test(e.name)) {
      out.push(join(e.parentPath, e.name));
    }
  }
  return out.sort();
}

export function checkDir(dir) {
  return deployFiles(dir).flatMap((f) => findUnpinned(readFileSync(f, "utf8")).map((ref) => `${f}: ${ref}`));
}

/** Workflow GitHub (`*.yml`/`*.yaml`) dưới một thư mục: image của `services:`/`container:` cũng phải ghim digest (BASE-DEP-008). */
export function workflowFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => join(dir, e.name))
    .sort();
}

export function checkWorkflows(dir) {
  return workflowFiles(dir).flatMap((f) =>
    findUnpinned(readFileSync(f, "utf8"), { skipExpressions: true }).map((ref) => `${f}: ${ref}`),
  );
}
