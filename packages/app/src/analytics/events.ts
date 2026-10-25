// Danh mục sự kiện sản phẩm (PM-METRIC-002/005): allowlist KIỂU ĐÓNG — sự kiện không có ở đây thì `track()` ném lỗi.
// Quy ước tên `doi_tuong.hanh_dong` (snake_case, thì quá khứ). Thuộc tính CHỈ enum / số nguyên có biên / bool: KHÔNG có chuỗi tự do,
// nên không có chỗ nào để PII lọt vào theo thiết kế (danh sách đen tên trường + quét regex ở `pii.ts` là lớp phòng thủ thứ hai).
// Thêm sự kiện = thêm một mục ở đây + dòng ở docs/privacy/data-map.yaml (nếu đổi loại dữ liệu) + review PR (PM-METRIC-005).
// Mọi thuộc tính đều BẮT BUỘC (không optional): một dạng dữ liệu duy nhất cho mỗi phiên bản sự kiện.
import { z } from "zod";

/** Số nguyên đếm có biên: biên là một phần của schema (giá trị ngoài biên là lỗi lập trình, không cắt lặng lẽ). */
const count = (max: number) => z.number().int().min(0).max(max);

export const EVENT_SCHEMA_VERSION = 1;

export const EVENT_SCHEMAS = {
  /** Chủ trọ/khách sạn đăng ký tổ chức mới (`org.create`). */
  "organization.registered": z.strictObject({}),
  /** Tạo hợp đồng thuê (nháp). `occupant_count` ≤ 19 như đầu vào `lease.createDraft`. */
  "lease.created": z.strictObject({ occupant_count: count(19), has_end_date: z.boolean() }),
  /** Phát hành kỳ thu (`billing.issuePeriod`). */
  "billing_period.issued": z.strictObject({}),
  /** Ghi nhận một khoản thanh toán (`payment.record`). */
  "payment.recorded": z.strictObject({ method: z.enum(["cash", "bank_transfer"]) }),
  /** Nhận phòng theo đặt phòng (`stay.checkIn`). `guest_count` ≤ 50 như đầu vào. */
  "stay.checked_in": z.strictObject({ guest_count: count(50) }),
  /** Nhận phòng khách vãng lai không đặt trước (`stay.walkIn`). */
  "stay.walked_in": z.strictObject({ guest_count: count(50) }),
} as const;

export type EventName = keyof typeof EVENT_SCHEMAS;
export type EventProps<E extends EventName> = z.input<(typeof EVENT_SCHEMAS)[E]>;

export const EVENT_NAMES = Object.keys(EVENT_SCHEMAS) as EventName[];

export function isEventName(name: unknown): name is EventName {
  return typeof name === "string" && Object.hasOwn(EVENT_SCHEMAS, name);
}
