#!/usr/bin/env node
// Quét PII trong log (CMP-PRIV-008, D-072): chạy trên log server của lượt E2E (`apps/web/e2e-logs/*.log`, dữ liệu giả) thay cho
// "log staging" tới khi có staging. Logger của app đã che email/SĐT/CCCD/token (packages/app/src/logging/logger.ts); bộ quét này
// bắt phần lọt: email/SĐT/CCCD chưa che, token Bearer/cookie phiên, và tên người/cơ sở seed (mọi tên seed E2E có hậu tố "(giả)").
// Thoát 1 khi có phát hiện; in vị trí + loại, KHÔNG in nguyên giá trị.
// Dùng: node scripts/pii-log-scan.mjs <tệp|thư mục> [...]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "./is-main.mjs";

const DETECTORS = [
  // Email chưa che: logger che thành `x***@miền`.
  {
    kind: "email",
    re: /([A-Za-z0-9._%+-]+)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    keep: (m) => !/^[A-Za-z0-9._%+-]\*\*\*$/.test(m[1]),
  },
  // SĐT VN đủ số (logger che thành `0xx****yyy`).
  { kind: "phone", re: /(?<![\w-])(?:\+?84|0)\d{9}(?![\w-])/g },
  // CCCD 12 số (CMND 9 số trùng dạng số tiền/kích thước nên không quét ở đây — logger đã che theo cả khoá lẫn giá trị).
  { kind: "id-number", re: /(?<![\w.-])\d{12}(?![\w.-])/g },
  { kind: "bearer-token", re: /\b(?:Bearer|Basic)\s+(?!\*\*\*)[A-Za-z0-9._~+/=-]{8,}/g },
  { kind: "session-cookie", re: /session_token=(?!\*\*\*)[^\s;,"]{8,}/g },
  { kind: "seed-name", re: /[^\s"{}[\]:,]{1,40}(?: [^\s"{}[\]:,]{1,40}){0,4} \(giả\)/gu },
];

/** Phát hiện trong một đoạn văn bản: [{ line, kind }] (không trả giá trị). */
export function scanText(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const d of DETECTORS) {
      for (const m of line.matchAll(d.re)) if (!d.keep || d.keep(m)) out.push({ line: i + 1, kind: d.kind });
    }
  });
  return out;
}

const files = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((n) => files(join(p, n))) : [p]);

function main(argv) {
  if (argv.length === 0) {
    console.error("dùng: pii-log-scan.mjs <tệp|thư mục> [...]");
    return 2;
  }
  const targets = argv.flatMap(files).filter((f) => f.endsWith(".log"));
  if (targets.length === 0) {
    console.error(
      `pii-log-scan: không có tệp .log trong ${argv.join(", ")} — lượt E2E không ghi log server?`,
    );
    return 2;
  }
  let hits = 0;
  for (const f of targets) {
    for (const h of scanText(readFileSync(f, "utf8"))) {
      hits++;
      console.error(`${f}:${h.line}: PII chưa che (${h.kind})`);
    }
  }
  console.log(`[pii-log-scan] ${targets.length} tệp · ${hits} phát hiện`);
  return hits === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
