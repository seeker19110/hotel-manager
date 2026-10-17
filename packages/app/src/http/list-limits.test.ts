// PLAN đợt 5 T-408 (XC-PERF-006): mọi query `*.list*` trong registry có LIMIT trần trong SQL (hoặc phân trang có trần), nên một
// yêu cầu không thể kéo về 10⁶ dòng. Thêm query `list*` mới mà quên khai ở đây → đỏ; hàm khai nhưng mất `limit` → đỏ.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QUERIES } from "./registry.ts";

const SRC = new URL("../", import.meta.url);

/** query → [file, hàm chứa câu SQL danh sách] (hàm đệm khi `list*` gọi qua helper). */
const IMPL: Record<string, [string, string]> = {
  "member.list": ["access/directory.ts", "listMembers"],
  "property.list": ["access/directory.ts", "listProperties"],
  "reservation.list": ["stay/reservations.ts", "listReservations"],
  "stay.listNotices": ["stay/residence-notices.ts", "listNotices"],
  "housekeeping.listTasks": ["housekeeping/tasks.ts", "queryTasks"],
  "audit.listEvents": ["audit/events.ts", "listEvents"],
  "exports.listMine": ["exports/exports.ts", "listMyExports"],
  "today.listItems": ["today/today.ts", "listItems"],
  "portal.listMyInvoices": ["portal/tenant.ts", "invoiceRows"],
  "portal.listMyMeterReadings": ["portal/tenant.ts", "listMyMeterReadings"],
  "portal.listMyRequests": ["portal/tenant.ts", "listMyRequests"],
  "payment.listClaims": ["portal/tenant.ts", "listPaymentClaims"],
  "notifications.listMine": ["notifications/preferences.ts", "listMyNotifications"],
  "notifications.listDeliveries": ["notifications/preferences.ts", "listDeliveries"],
  "maintenance.listWorkOrders": ["maintenance/work-orders.ts", "listWorkOrders"],
  "maintenance.listMyWorkOrders": ["maintenance/work-orders.ts", "listMyWorkOrders"],
};

/** Thân hàm: từ `function name` đến khai báo cấp cao kế tiếp. */
function bodyOf(file: string, fn: string): string {
  const src = readFileSync(new URL(file, SRC), "utf8");
  const start = src.search(new RegExp(`function ${fn}\\b`));
  expect(start, `${file}: không thấy hàm ${fn}`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(export |async function |function |const \w+ = (async )?\()/);
  return rest.slice(0, end === -1 ? undefined : end);
}

/** Số lớn nhất đứng sau `limit` trong thân hàm (literal) — null nếu chỉ có biểu thức/`${...}`. */
const limitOf = (body: string): { literal: number | null; has: boolean } => {
  const all = [...body.matchAll(/\blimit\s+(\d+|\$\{)/gi)];
  const lits = all.map((m) => Number(m[1])).filter((n) => !Number.isNaN(n));
  return { has: all.length > 0, literal: lits.length ? Math.max(...lits) : null };
};

describe("list-limits — mọi query list* có trần số dòng (XC-PERF-006)", () => {
  const listNames = Object.keys(QUERIES).filter((k) => /\.list[A-Z]?/.test(k) || /^[a-z]+\.list$/.test(k));

  it("registry có query list* (rào không rỗng) và mỗi query đã khai nơi cài đặt", () => {
    expect(listNames.length).toBeGreaterThanOrEqual(16);
    expect(listNames.filter((k) => !(k in IMPL))).toEqual([]);
    expect(Object.keys(IMPL).filter((k) => !(k in QUERIES))).toEqual([]);
  });

  it("câu SQL danh sách có LIMIT; trần literal ≤ 500 (audit/thông báo: trần theo tham số, kiểm ở bên dưới)", () => {
    const bad: string[] = [];
    for (const [q, [file, fn]] of Object.entries(IMPL)) {
      const { has, literal } = limitOf(bodyOf(file, fn));
      if (!has) bad.push(`${q}: không có LIMIT trong ${fn}`);
      else if (literal !== null && literal > 500) bad.push(`${q}: LIMIT ${literal} > 500`);
    }
    expect(bad).toEqual([]);
  });

  it("query nhận `limit` từ client chặn trần: audit ≤ 200, thông báo ≤ 100 (yêu cầu 10⁶ bị từ chối hoặc bị cắt)", () => {
    const audit = QUERIES["audit.listEvents"]?.input;
    const notif = QUERIES["notifications.listMine"]?.input;
    // audit: `limit` là chuỗi tối đa 3 chữ số → 1.000.000 bị từ chối; hàm cắt tiếp ở AUDIT_PAGE_MAX (200).
    expect(audit?.safeParse({ limit: "1000000" }).success).toBe(false);
    expect(audit?.safeParse({ limit: "999" }).success).toBe(true); // hợp lệ ở schema, hàm cắt về 200
    expect(readFileSync(new URL("audit/events.ts", SRC), "utf8")).toContain(
      "Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), AUDIT_PAGE_MAX)",
    );
    expect(notif?.safeParse({ limit: "1000000" }).success).toBe(false);
    expect(notif?.safeParse({ limit: "100" }).success).toBe(true);
    expect(notif?.safeParse({ limit: "101" }).success).toBe(false);
    expect(notif?.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("bắt đúng: thân hàm không có LIMIT bị phát hiện", () => {
    expect(limitOf("select * from t order by id").has).toBe(false);
    expect(limitOf("select * from t limit 200")).toEqual({ has: true, literal: 200 });
    expect(limitOf(`... limit \${limit}`)).toEqual({ has: true, literal: null });
  });
});
