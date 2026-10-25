// Schema sự kiện analytics sản phẩm — danh sách cho phép (allowlist) MỘT nơi (PLAN T-2309; PM-METRIC-003/005/006; D-118).
// Sự kiện mới = thêm một mục ở `EVENTS` (kèm chủ, chỉ số phục vụ, ngày thêm); `track()` từ chối mọi tên/thuộc tính ngoài danh sách.
// Quy tắc thuộc tính: CHỈ ID nội bộ (uuid), enum (tập giá trị đóng) hoặc số nguyên có cận — không chuỗi tự do, không PII
// (tên, email, SĐT, địa chỉ, IP, ghi chú…). Khoá thuộc tính snake_case, không nằm trong danh sách đen PII (`validate.ts`, kiểm lúc nạp
// module và bằng test). Tên sự kiện `doi_tuong.hanh_dong` (chữ thường/số/gạch dưới, một dấu chấm; khớp CHECK của `product_events.name`).
// Đổi hình dạng một sự kiện = thêm phiên bản MỚI (`versions[n]`), nâng `current`; phiên bản cũ giữ nguyên để payload cũ vẫn hợp lệ.
// Đối chiếu chỉ số: docs PROJECT.md §2 — M-01 (`billing_period.created` → `billing_period.issued`), M-03 (`stay.check_in_started` →
// `stay.checked_in`), M-05 (`core_task.completed` theo `property_id`).

export type PropSpec =
  | { kind: "uuid" }
  | { kind: "enum"; values: readonly [string, ...string[]] }
  | { kind: "int"; min: number; max: number };

export interface PropDef {
  type: PropSpec;
  required: boolean;
}

export interface EventVersion {
  /** Ngày thêm phiên bản (YYYY-MM-DD). */
  addedOn: string;
  props: Readonly<Record<string, PropDef>>;
}

export interface EventDef {
  /** Module/nhóm chịu trách nhiệm về ý nghĩa sự kiện. */
  owner: string;
  /** Chỉ số PROJECT.md §2 mà sự kiện phục vụ. */
  metric: string;
  /** Phiên bản mặc định khi phát (phải có trong `versions`). */
  current: number;
  versions: Readonly<Record<number, EventVersion>>;
}

export type EventRegistry = Readonly<Record<string, EventDef>>;

const uuid = (required = true): PropDef => ({ type: { kind: "uuid" }, required });
const int = (min: number, max: number, required = true): PropDef => ({
  type: { kind: "int", min, max },
  required,
});
const oneOf = (values: readonly [string, ...string[]], required = true): PropDef => ({
  type: { kind: "enum", values },
  required,
});

/** Nguồn tạo lượt lưu trú: từ đặt phòng có sẵn hay khách vãng lai nhận phòng ngay. */
const STAY_SOURCE = ["reservation", "walk_in"] as const;
/** Tác vụ lõi tính cho chỉ số dùng hằng tuần M-05 (thêm giá trị = phiên bản mới của `core_task.completed`). */
export const CORE_TASKS = ["billing_period_issued", "stay_checked_in"] as const;
export type CoreTask = (typeof CORE_TASKS)[number];

/** Tên sự kiện đo chỉ số; ngoài danh sách này `track()` ném lỗi. */
export const EVENTS = {
  "billing_period.created": {
    owner: "billing",
    metric: "M-01",
    current: 1,
    versions: { 1: { addedOn: "2026-10-25", props: { billing_period_id: uuid() } } },
  },
  "billing_period.issued": {
    owner: "billing",
    metric: "M-01",
    current: 1,
    versions: {
      1: { addedOn: "2026-10-25", props: { billing_period_id: uuid(), invoice_count: int(0, 100_000) } },
    },
  },
  "stay.check_in_started": {
    owner: "stay",
    metric: "M-03",
    current: 1,
    versions: {
      1: {
        addedOn: "2026-10-25",
        props: { source: oneOf(STAY_SOURCE), reservation_id: uuid(false) },
      },
    },
  },
  "stay.checked_in": {
    owner: "stay",
    metric: "M-03",
    current: 1,
    versions: {
      1: {
        addedOn: "2026-10-25",
        props: {
          source: oneOf(STAY_SOURCE),
          stay_id: uuid(),
          reservation_id: uuid(),
          guest_count: int(1, 10_000),
        },
      },
    },
  },
  "core_task.completed": {
    owner: "product",
    metric: "M-05",
    current: 1,
    versions: { 1: { addedOn: "2026-10-25", props: { task: oneOf(CORE_TASKS) } } },
  },
} as const satisfies EventRegistry;

export type EventName = keyof typeof EVENTS;
