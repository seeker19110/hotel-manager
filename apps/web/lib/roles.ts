import { tOr } from "./i18n.ts";

const ROLES = [
  "owner",
  "manager",
  "front_desk",
  "accountant",
  "housekeeping",
  "maintenance",
  "tenant",
  "platform_support",
] as const;
const STATUSES = ["active", "suspended", "invited"] as const;

/** Nhãn vai trò hiển thị (một nguồn cho các màn quản trị) — chuỗi ở apps/web/messages/vi.json (`role.*`). */
export const ROLE_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  ROLES.map((r) => [r, tOr(`role.${r}`, r)]),
);

/** Nhãn trạng thái thành viên (`member_status.*`). */
export const STATUS_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  STATUSES.map((s) => [s, tOr(`member_status.${s}`, s)]),
);

/** Nhãn vai trò ngắn ở màn chọn tổ chức (`org_picker.role.*`). */
export const ORG_PICKER_ROLE_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  ROLES.map((r) => [r, tOr(`org_picker.role.${r}`, r)]),
);

/** Vai trò mà manager mời/đổi được (ma trận 5.3). */
export const STAFF_LOW = ["front_desk", "housekeeping", "maintenance"] as const;
export const STAFF_ALL = [
  "owner",
  "manager",
  "front_desk",
  "accountant",
  "housekeeping",
  "maintenance",
] as const;
