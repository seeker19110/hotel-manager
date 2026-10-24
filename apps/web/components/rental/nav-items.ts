// Điều hướng chính của nhân viên (SPEC-pwa S-014): đúng 5 điểm vào theo thứ tự Hôm nay · Phòng/Lịch · Thu tiền · Công việc ·
// Thêm; mục hiện theo vai trò (menu theo vai trò, kế hoạch §09) — vai trò không có quyền thì ẩn mục, không đổi thứ tự. Các màn
// còn lại (đặt phòng, hợp đồng, kỳ thu, đối soát, thông báo…) nằm trong "Thêm". Quyền thật vẫn kiểm ở server mỗi lần gọi.
import { t } from "../../lib/i18n.ts";

export type Role =
  | "owner"
  | "manager"
  | "front_desk"
  | "accountant"
  | "housekeeping"
  | "maintenance"
  | (string & {});

export interface NavKinds {
  hotel: boolean;
  rental: boolean;
}

export interface NavEntry {
  key: "today" | "rooms" | "money" | "work" | "more";
  label: string;
  href: string;
  /** Các route thuộc điểm vào này (để đánh dấu `aria-current`). */
  paths: readonly string[];
}

const STAFF = ["owner", "manager", "front_desk", "accountant", "housekeeping", "maintenance"] as const;
const FRONT = ["owner", "manager", "front_desk"] as const;
const MONEY = ["owner", "manager", "accountant"] as const;

const has = (roles: readonly string[], role: Role) => roles.includes(role);

/** Năm (hoặc ít hơn khi vai trò không có quyền) điểm vào của thanh điều hướng dưới. */
export function primaryNav(role: Role, kinds: NavKinds = { hotel: true, rental: true }): NavEntry[] {
  const out: NavEntry[] = [{ key: "today", label: t("nav.primary.today"), href: "/", paths: ["/"] }];
  if (has(STAFF, role)) {
    // Khách sạn: lễ tân/quản lý/kế toán xem lịch; còn lại (và nhà trọ) xem danh sách phòng.
    const calendar = kinds.hotel && has([...FRONT, "accountant"], role);
    out.push({
      key: "rooms",
      label: t("nav.primary.rooms"),
      href: calendar ? "/lich-phong" : "/phong",
      paths: ["/phong", "/lich-phong"],
    });
  }
  if (has([...MONEY, "front_desk"], role))
    out.push({ key: "money", label: t("nav.primary.money"), href: "/thu-tien", paths: ["/thu-tien"] });
  if (has([...FRONT, "housekeeping"], role))
    out.push({
      key: "work",
      label: t("nav.primary.work"),
      href: "/buong-phong",
      paths: ["/buong-phong", "/su-co"],
    });
  else if (has(["maintenance"], role))
    out.push({
      key: "work",
      label: t("nav.primary.work"),
      href: "/su-co",
      paths: ["/buong-phong", "/su-co"],
    });
  out.push({ key: "more", label: t("nav.primary.more"), href: "/them", paths: [] });
  return out;
}

interface MoreItem {
  href: string;
  label: string;
  roles: readonly Role[];
  kind?: "hotel" | "rental";
}

/** Dựng lúc gọi (không lúc nạp module) để nhãn lấy từ catalog đúng thời điểm. */
const moreItems = (): readonly MoreItem[] => [
  { href: "/lich-phong", label: t("nav.more.calendar"), roles: [...FRONT, "accountant"], kind: "hotel" },
  { href: "/phong", label: t("nav.more.rooms"), roles: STAFF },
  { href: "/dat-phong", label: t("nav.more.bookings"), roles: [...FRONT, "accountant"], kind: "hotel" },
  { href: "/buong-phong", label: t("nav.more.housekeeping"), roles: [...FRONT, "housekeeping"] },
  { href: "/su-co", label: t("nav.more.incidents"), roles: [...FRONT, "housekeeping", "maintenance"] },
  { href: "/thong-bao-luu-tru", label: t("nav.more.notices"), roles: FRONT, kind: "hotel" },
  { href: "/hop-dong", label: t("nav.more.leases"), roles: MONEY, kind: "rental" },
  { href: "/ky-thu", label: t("nav.more.periods"), roles: MONEY, kind: "rental" },
  { href: "/doi-soat", label: t("nav.more.reconciliation"), roles: MONEY, kind: "rental" },
  { href: "/thong-bao", label: t("nav.more.notifications"), roles: STAFF },
  { href: "/co-so", label: t("nav.more.properties"), roles: ["owner"] },
  { href: "/thanh-vien", label: t("nav.more.members"), roles: ["owner", "manager"] },
];

/** Các màn trong trang "Thêm": mọi màn của vai trò mà thanh dưới chưa trỏ thẳng tới. */
export function moreLinks(
  role: Role,
  kinds: NavKinds = { hotel: true, rental: true },
): { href: string; label: string }[] {
  const direct = new Set(primaryNav(role, kinds).map((e) => e.href));
  return moreItems()
    .filter((i) => i.roles.includes(role) && (i.kind === undefined || kinds[i.kind]) && !direct.has(i.href))
    .map(({ href, label }) => ({ href, label }));
}

/** Điểm vào đang mở theo route hiện tại (route không thuộc điểm vào nào ⇒ "Thêm"). */
export function activeKey(entries: readonly NavEntry[], current: string): NavEntry["key"] {
  return entries.find((e) => e.paths.includes(current))?.key ?? "more";
}

/** Tên cơ sở trong phạm vi, gọn cho màn hẹp: một cơ sở ⇒ tên; nhiều ⇒ hai tên đầu + số còn lại. */
export function scopeLabel(names: readonly string[]): string {
  if (names.length === 0) return t("nav.no_property");
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}
