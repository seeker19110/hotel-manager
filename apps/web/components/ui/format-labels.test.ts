// Nhãn mã của lib/format.ts lấy từ catalog qua `m` (D-103): chữ giữ nguyên như bảng viết thẳng trước đây, mã lạ trả nguyên mã
// (kể cả tên thuộc tính của Object.prototype — bảng cũ `X[code] ?? code` trả hàm cho "constructor"), và lib/format.ts không
// import giá trị catalog (module này được client component import — D-098).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bookingStatusLabel,
  cardLabel,
  chargeKindLabel,
  hkStatusLabel,
  leaseStatusLabel,
  meterLabel,
  noticeStatusLabel,
  paymentMethodLabel,
  paymentStatusLabel,
  periodStatusLabel,
  priorityLabel,
  severityLabel,
  stayStatusLabel,
  taskKindLabel,
  taskStatusLabel,
  weekdayDay,
  workOrderStatusLabel,
} from "../../lib/format.ts";
import { messagesFor } from "../../lib/i18n.ts";

const m = messagesFor(
  "label.",
  "rooms.hk.",
  "housekeeping.list.create.kind_",
  "housekeeping.list.create.priority_",
  "incident_form.severity.",
  "stay.add.kind_",
  "guest_stay.status.",
  "today_list.title.",
);

describe("nhãn mã (lib/format.ts)", () => {
  it("chữ đúng từng ký tự như trước khi chuyển vào catalog", () => {
    expect(leaseStatusLabel(m, "signed_awaiting_handover")).toBe("Đã ký — chờ bàn giao");
    expect(periodStatusLabel(m, "reviewing")).toBe("Chờ phát hành");
    expect(meterLabel(m, "electric")).toBe("Điện");
    expect(bookingStatusLabel(m, "expired")).toBe("Hết hạn giữ");
    expect(hkStatusLabel(m, "dirty")).toBe("Bẩn");
    expect(hkStatusLabel(m, "clean")).toBe("Sạch — chờ kiểm");
    expect(hkStatusLabel(m, "inspected")).toBe("Đã kiểm — sẵn sàng");
    expect(taskStatusLabel(m, "done")).toBe("Đã xong — chờ nghiệm thu");
    expect(taskKindLabel(m, "inspection")).toBe("Kiểm tra phòng");
    expect(priorityLabel(m, "urgent")).toBe("Khẩn");
    expect(workOrderStatusLabel(m, "open")).toBe("Mới báo");
    expect(severityLabel(m, "critical")).toBe("Nghiêm trọng");
    expect(noticeStatusLabel(m, "exported")).toBe("Đã xuất — chưa nộp");
    expect(chargeKindLabel(m, "room")).toBe("Tiền phòng");
    expect(chargeKindLabel(m, "fee")).toBe("Phụ thu");
    expect(paymentMethodLabel(m, "bank_transfer")).toBe("Chuyển khoản");
    expect(paymentStatusLabel(m, "reversed")).toBe("Đã đảo");
    expect(stayStatusLabel(m, "expected")).toBe("Chờ nhận phòng");
    expect(stayStatusLabel(m, "no_show")).toBe("Không đến");
    expect(cardLabel(m, "arrivals", "ngắn")).toBe("Khách đến hôm nay");
  });

  it("mã lạ/rỗng/tên thuộc tính prototype → nguyên mã (hoặc fallback/undefined)", () => {
    expect(leaseStatusLabel(m, "archived")).toBe("archived");
    expect(bookingStatusLabel(m, "")).toBe("");
    expect(taskStatusLabel(m, "constructor")).toBe("constructor");
    expect(cardLabel(m, "receivables", "Nợ đến hạn")).toBe("Nợ đến hạn");
    expect(meterLabel(m, "gas")).toBeUndefined();
    expect(severityLabel(m, "toString")).toBeUndefined();
  });

  it("weekdayDay: thứ theo ngày UTC, ngày dd/mm/yyyy", () => {
    expect(weekdayDay(m, "2026-10-21")).toBe("Thứ tư 21/10/2026");
    expect(weekdayDay(m, "2026-10-25")).toBe("Chủ nhật 25/10/2026");
    expect(weekdayDay(m, "2026-10-24")).toBe("Thứ bảy 24/10/2026");
  });

  it("lib/format.ts không import giá trị catalog (D-098)", () => {
    const src = readFileSync(join(import.meta.dirname, "../../lib/format.ts"), "utf8");
    expect(src).toMatch(/^import type \{ MessageKey \} from "\.\/i18n\.ts";$/m);
    expect(src).not.toMatch(/^import \{[^}]*\} from "\.\/i18n\.ts"/m);
    expect(src).not.toMatch(/messages\/vi\.json/);
  });
});
