#!/usr/bin/env node
// Config Lighthouse CI có đăng nhập (PRF-WEB-005: ≥ 5 URL chính gồm trang sau đăng nhập). Đọc lighthouserc.json, bỏ khối khởi động
// server (job `lighthouse` đã tự dựng server + lấy phiên bằng e2e/perf-session-env.ts), thêm header Cookie của phiên giả cho mọi URL,
// ghi ra tệp tạm (mode 0600, ngoài repo). Cookie đọc từ biến K6_COOKIE (đã che trong log Actions), không in ra.
// Dùng: node scripts/lhci-auth-config.mjs <tệp ra>   rồi   lhci autorun --config=<tệp ra>
import { readFileSync, writeFileSync } from "node:fs";
import { isMain } from "./is-main.mjs";

/** Config mới từ config gốc + cookie; không đổi URL/assert (ngưỡng giữ nguyên). */
export function authConfig(base, cookie) {
  if (!cookie) throw new Error("thiếu cookie phiên (K6_COOKIE) — chạy e2e/perf-session-env.ts trước");
  const ci = structuredClone(base.ci);
  delete ci.collect.startServerCommand;
  delete ci.collect.startServerReadyPattern;
  delete ci.collect.startServerReadyTimeout;
  ci.collect.settings = { ...ci.collect.settings, extraHeaders: { Cookie: cookie } };
  return { ci };
}

if (isMain(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("dùng: lhci-auth-config.mjs <tệp ra>");
    process.exit(2);
  }
  const base = JSON.parse(readFileSync(new URL("../lighthouserc.json", import.meta.url), "utf8"));
  writeFileSync(out, JSON.stringify(authConfig(base, process.env.K6_COOKIE ?? ""), null, 2), { mode: 0o600 });
  console.log(`[lhci-auth-config] ${base.ci.collect.url.length} URL → ${out}`);
}
