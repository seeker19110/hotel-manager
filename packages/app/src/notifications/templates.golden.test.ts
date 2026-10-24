// Đầu ra mẫu thông báo/email giữ NGUYÊN từng ký tự khi chuỗi chuyển sang catalog (XC-I18N-001, T-2205): so với tệp vàng
// `templates.golden.json` (sinh từ mã trước khi chuyển). Đổi chữ trong catalog ⇒ test đỏ ⇒ cố ý cập nhật tệp vàng.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type DeliveryStatus, type NotificationType, render, type Vars } from "./templates.ts";

const ID = "6f1c2b3a-1111-4222-8333-444455556666";
const OPTS = { baseUrl: "https://app.example/", unsubscribeUrl: "https://app.example/u/1" };
const CASES: ReadonlyArray<readonly [string, NotificationType, Vars]> = [
  ["invite", "account_security", { orgName: "Nhà trọ Hoa Sen", kind: "tenant_invited", action: "x" }],
  ["mfa_reset", "account_security", { orgName: "Nhà trọ Hoa Sen", kind: "mfa_reset", action: "đặt lại" }],
  ["pwd", "account_security", { orgName: "Nhà trọ Hoa Sen", kind: "password_changed", action: "đổi" }],
  ["mfa_off", "account_security", { orgName: "Nhà trọ Hoa Sen", kind: "mfa_disabled", action: "tắt" }],
  ["generic", "account_security", { orgName: "Nhà trọ Hoa Sen", action: "đăng nhập lạ" }],
  [
    "issued",
    "invoice_issued",
    { propertyName: "KS Mai", period: "10/2026", dueOn: "2026-10-10", amount: 1_580_000, invoiceId: ID },
  ],
  [
    "overdue",
    "invoice_overdue",
    { propertyName: "KS Mai", period: "10/2026", dueOn: "2026-10-10", amount: 1_580_000, invoiceId: ID },
  ],
  [
    "lease_staff",
    "lease_expiring",
    { propertyName: "KS Mai", unitCode: "203", endOn: "2026-11-30", leaseId: ID },
  ],
  [
    "lease_tenant",
    "lease_expiring",
    { propertyName: "KS Mai", unitCode: "203", endOn: "2026-11-30", leaseId: ID, audience: "tenant" },
  ],
  ["stay_cfg", "stay_notice_due", { propertyName: "KS Mai", kind: "config_missing" }],
  ...["normal", "urgent", "overdue"].map(
    (severity) =>
      [
        `stay_${severity}`,
        "stay_notice_due",
        { propertyName: "KS Mai", unitCode: "203", dueAtLocal: "23:00 15/10/2026", noticeId: ID, severity },
      ] as const,
  ),
  ...["assigned", "in_progress", "done", "verified", "cancelled"].map(
    (status) =>
      [
        `mt_${status}`,
        "maintenance_status",
        { propertyName: "KS Mai", unitCode: "203", status, workOrderId: ID },
      ] as const,
  ),
  ["export", "export_ready", { exportName: "Báo cáo công nợ 10/2026", exportId: ID }],
];
const BAD: ReadonlyArray<readonly [string, NotificationType, Vars]> = [
  [
    "bad_status",
    "maintenance_status",
    { propertyName: "KS Mai", unitCode: "203", status: "x", workOrderId: ID },
  ],
  ["missing", "export_ready", { exportId: ID }],
  ["wrong_type", "export_ready", { exportName: { a: 1 } as never, exportId: ID }],
  [
    "bad_amount",
    "invoice_issued",
    { propertyName: "KS", period: "p", dueOn: "2026-10-10", amount: 1.5, invoiceId: ID },
  ],
  [
    "bad_date",
    "invoice_issued",
    { propertyName: "KS", period: "p", dueOn: "10/10/2026", amount: 1, invoiceId: ID },
  ],
  [
    "bad_date2",
    "invoice_issued",
    { propertyName: "KS", period: "p", dueOn: "2026-13-40", amount: 1, invoiceId: ID },
  ],
  ["bad_id", "export_ready", { exportName: "a", exportId: "nope" }],
  ["sensitive", "export_ready", { exportName: "a", exportId: ID, x: "1" }],
];
const STATUSES: DeliveryStatus[] = ["queued", "sending", "sent", "retrying", "failed", "dead", "suppressed"];

async function snapshot() {
  const { deliveryStatusLabel } = await import("./templates.ts");
  const out: Record<string, unknown> = {};
  for (const [k, type, vars] of CASES) {
    out[`${k}:bare`] = render(type, vars);
    out[`${k}:opts`] = render(type, vars, OPTS);
  }
  out["account_security:required_no_unsub"] = render("account_security", CASES[0]?.[2] as Vars, OPTS);
  for (const [k, type, vars] of BAD)
    try {
      out[k] = render(type, vars);
    } catch (e) {
      out[k] = { error: (e as Error).name, message: (e as Error).message };
    }
  try {
    render("nope" as NotificationType, {});
  } catch (e) {
    out.no_template = { error: (e as Error).name, message: (e as Error).message };
  }
  for (const s of STATUSES)
    for (const r of [null, "OPTED_OUT", "NO_ADDRESS", "SETTLED"])
      out[`label:${s}:${r}`] = deliveryStatusLabel(s, r);
  return out;
}

describe("mẫu thông báo — đầu ra byte-như-cũ (T-2205)", () => {
  it("khớp tệp vàng", async () => {
    const got = await snapshot();
    if (process.env.GOLDEN_WRITE)
      writeFileSync(new URL("./templates.golden.json", import.meta.url), `${JSON.stringify(got, null, 2)}\n`);
    const want = JSON.parse(readFileSync(new URL("./templates.golden.json", import.meta.url), "utf8"));
    expect(got).toEqual(want);
  });
});
