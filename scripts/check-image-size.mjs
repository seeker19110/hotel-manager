#!/usr/bin/env node
// Ngân sách kích thước image container (XC-GREEN-002): so kích thước (`docker image inspect --format '{{.Size}}'`, byte) với
// `perf/resource-budgets.json` → `images.<tên>.max_mb` (1 MB = 10^6 byte). Vượt → exit 1. Image không có ngân sách → exit 1
// (thêm image mới vào supply-chain.yml thì phải đặt ngân sách).
// Dùng: node scripts/check-image-size.mjs <tên> <byte>
import { readFileSync } from "node:fs";
import { isMain } from "./is-main.mjs";

const BUDGETS = new URL("../perf/resource-budgets.json", import.meta.url);

/** Kết quả kiểm: { ok, message }. */
export function checkImageSize(name, bytes, budgets = JSON.parse(readFileSync(BUDGETS, "utf8"))) {
  const b = budgets.images?.[name];
  if (!b) return { ok: false, message: `image "${name}" chưa có ngân sách trong perf/resource-budgets.json` };
  if (!Number.isFinite(bytes) || bytes <= 0)
    return { ok: false, message: `kích thước không hợp lệ: ${bytes}` };
  const mb = bytes / 1e6;
  const msg = `${name}: ${mb.toFixed(1)} MB / ngân sách ${b.max_mb} MB`;
  return mb <= b.max_mb ? { ok: true, message: msg } : { ok: false, message: `${msg} — VƯỢT ngân sách` };
}

if (isMain(import.meta.url)) {
  const [name, raw] = process.argv.slice(2);
  const r = checkImageSize(name, Number(raw));
  (r.ok ? console.log : console.error)(`[image-size] ${r.message}`);
  process.exit(r.ok ? 0 : 1);
}
