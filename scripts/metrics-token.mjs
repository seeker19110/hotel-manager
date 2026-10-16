#!/usr/bin/env node
// In Bearer token đọc /api/metrics (RUNBOOK §Quan sát). Đọc BETTER_AUTH_SECRET từ biến môi trường của tiến trình — không ghi
// ra file, không nhận qua tham số dòng lệnh (tránh lọt vào lịch sử shell). Cùng công thức với packages/app metricsToken().
import { hkdfSync } from "node:crypto";

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret || secret.length < 32) {
  process.stderr.write("Cần BETTER_AUTH_SECRET (≥ 32 ký tự) trong môi trường.\n");
  process.exit(1);
}
process.stdout.write(
  `${Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "hm-metrics-v1", 32)).toString("base64url")}\n`,
);
