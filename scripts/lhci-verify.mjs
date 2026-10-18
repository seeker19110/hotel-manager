#!/usr/bin/env node
// Sau `lhci autorun` (PRF-WEB-005): (1) mọi lượt đo phải dừng đúng URL đã yêu cầu — trang sau đăng nhập bị chuyển về /dang-nhap
// (cookie sai/hết hạn) thì Lighthouse vẫn chấm điểm trang đăng nhập và job xanh giả; (2) che cookie phiên trong báo cáo trước khi
// lưu artifact: Lighthouse chép `extraHeaders` vào `lhr.configSettings` của cả JSON lẫn HTML.
// Dùng: node scripts/lhci-verify.mjs <thư mục .lighthouseci>          — kiểm URL cuối (exit 1 khi lệch hoặc không có lượt đo)
//       node scripts/lhci-verify.mjs --scrub <thư mục .lighthouseci>  — che cookie (K6_COOKIE) và bỏ extraHeaders
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "./is-main.mjs";

const path = (u) => {
  const x = new URL(u);
  return x.pathname.replace(/\/+$/, "") || "/";
};

/** Lượt đo bị chuyển hướng: [{ requested, final }]. */
export function redirectedRuns(lhrs) {
  return lhrs
    .map((l) => ({ requested: l.requestedUrl, final: l.finalDisplayedUrl ?? l.finalUrl }))
    .filter((r) => !r.requested || !r.final || path(r.requested) !== path(r.final));
}

/** Văn bản báo cáo đã che: bỏ khối extraHeaders và mọi lần xuất hiện của cookie (cả dạng JSON-escape). */
export function scrub(text, cookie) {
  let out = text.replace(/"extraHeaders":\{[^{}]*\}/g, '"extraHeaders":{}');
  if (cookie) {
    for (const v of new Set([cookie, JSON.stringify(cookie).slice(1, -1), ...cookie.split(/;\s*/)]))
      if (v.length >= 8) out = out.split(v).join("***");
  }
  return out;
}

function main(argv) {
  const scrubMode = argv[0] === "--scrub";
  const dir = scrubMode ? argv[1] : argv[0];
  if (!dir || !existsSync(dir)) {
    console.error(`lhci-verify: không có thư mục ${dir ?? "(thiếu)"}`);
    return 2;
  }
  const files = readdirSync(dir).filter((n) => /\.(json|html)$/.test(n));
  if (scrubMode) {
    const cookie = process.env.K6_COOKIE ?? "";
    for (const n of files) writeFileSync(join(dir, n), scrub(readFileSync(join(dir, n), "utf8"), cookie));
    console.log(`[lhci-verify] đã che ${files.length} tệp`);
    return 0;
  }
  const lhrs = files
    .filter((n) => /^lhr-.*\.json$/.test(n))
    .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
  if (lhrs.length === 0) {
    console.error("lhci-verify: không có lượt đo lhr-*.json nào — lhci không chạy?");
    return 1;
  }
  const bad = redirectedRuns(lhrs);
  for (const r of bad)
    console.error(`lhci-verify: ${r.requested} → dừng ở ${r.final} (phiên đăng nhập hỏng?)`);
  console.log(`[lhci-verify] ${lhrs.length} lượt đo · ${bad.length} lệch URL`);
  return bad.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
