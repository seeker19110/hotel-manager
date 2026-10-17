// Luồng nóng 4: thu tiền mặt tại quầy — `payment.collectCash` trên hoá đơn đã phát hành (INV-*: tiền là số nguyên, không âm quá hạn).
// INVOICE_IDS = danh sách hoá đơn còn dư nợ (phân tách dấu phẩy), AMOUNT = số tiền mỗi lần thu (VND, mặc định 1000, nhỏ để không
// vượt dư nợ); lần thu vượt dư nợ trả 409/422 — không tính là lỗi hệ thống, đếm ở `hm_collect_rejected`. Cần ca quầy đang mở.
import { check } from "k6";
import http from "k6/http";
import { Counter } from "k6/metrics";
import { assertSafeTarget, postCommand, requireEnv, scenarios, thresholds } from "./lib.js";

const rejected = new Counter("hm_collect_rejected");

// 409/422 do đụng chỗ/vượt dư nợ là hành vi đúng của nghiệp vụ — không tính vào `http_req_failed`.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 409, 422));

export const options = {
  scenarios: scenarios("collectCash"),
  thresholds: thresholds("payment-collectCash"),
};

export function setup() {
  assertSafeTarget();
  requireEnv("K6_COOKIE", "ORG_ID", "INVOICE_IDS");
}

export function collectCash() {
  const invoices = __ENV.INVOICE_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const invoice = invoices[Math.floor(Math.random() * invoices.length)];
  const res = postCommand(
    "payment.collectCash",
    "/api/v1/payment/collectCash",
    { invoice_id: invoice, amount: Number(__ENV.AMOUNT || 1000) },
    "payment-collectCash",
  );
  if (res.status === 409 || res.status === 422) {
    rejected.add(1);
    return;
  }
  check(res, { "thu tiền 201": (r) => r.status === 201 });
}
