#!/usr/bin/env node
// Chặn load test vào production (QA-PERF-007): BASE_URL của k6 chỉ được là loopback, hoặc host nằm trong danh sách cho phép mà
// chính danh sách đó chỉ gồm loopback/host staging có chủ đích (`*.staging.*`, `staging-*`). Mọi host khác → exit 1.
// Host chỉ gồm ký tự không phải `/:@?#[]`: userinfo (`staging-x@prod`), `?`/`#` ngay sau host → không hợp lệ (URL thật sẽ tới
// host sau `@`/trước `?`). Lớp hai nằm trong k6 (perf/k6/lib.js `assertSafeTarget`). Dùng: node scripts/k6-target-guard.mjs <BASE_URL> <K6_ALLOWED_HOSTS>
import { isMain } from "./is-main.mjs";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const STAGING = /(^|\.)staging(\.|-)|^staging-/;

/** null = an toàn; chuỗi = lý do chặn. */
export function targetProblem(baseUrl, allowedCsv) {
  const m = /^https?:\/\/([^/:@?#[\]]+|\[[^\]]+\])(?::\d+)?(?:\/|$)/.exec(String(baseUrl ?? ""));
  if (!m) return `BASE_URL không hợp lệ: ${baseUrl}`;
  const host = m[1].toLowerCase();
  const allowed = String(allowedCsv ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = allowed.filter((h) => !LOOPBACK.has(h) && !STAGING.test(h));
  if (bad.length) return `K6_ALLOWED_HOSTS có host không phải loopback/staging: ${bad.join(",")}`;
  if (!LOOPBACK.has(host) && !STAGING.test(host))
    return `BASE_URL ${host} không phải loopback/staging — không tải vào production`;
  if (!allowed.includes(host)) return `BASE_URL ${host} không nằm trong K6_ALLOWED_HOSTS`;
  return null;
}

if (isMain(import.meta.url)) {
  const p = targetProblem(process.argv[2], process.argv[3]);
  if (p) console.error(`[k6-target-guard] ${p}`);
  else console.log(`[k6-target-guard] đích an toàn: ${process.argv[2]}`);
  process.exit(p ? 1 : 0);
}
