// Điều hướng chính của nhân viên (nhà trọ + khách sạn + vận hành). Mục hiện theo vai trò và loại cơ sở trong phạm vi; quyền thật
// vẫn kiểm ở server mỗi lần gọi — thanh này chỉ gọn cho điện thoại. Mục đang mở có aria-current. Chuông thông báo cuối thanh.
import { Icon } from "../ui/icon.tsx";

type Role =
  | "owner"
  | "manager"
  | "front_desk"
  | "accountant"
  | "housekeeping"
  | "maintenance"
  | (string & {});

interface Item {
  href: string;
  label: string;
  roles: readonly Role[];
  /** Chỉ hiện khi có cơ sở thuộc loại này (bỏ qua = luôn hiện). */
  kind?: "hotel" | "rental";
}

const STAFF = ["owner", "manager", "front_desk", "accountant", "housekeeping", "maintenance"] as const;
const FRONT = ["owner", "manager", "front_desk"] as const;
const MONEY = ["owner", "manager", "accountant"] as const;

const ITEMS: readonly Item[] = [
  { href: "/", label: "Hôm nay", roles: STAFF },
  { href: "/lich-phong", label: "Lịch phòng", roles: [...FRONT, "accountant"], kind: "hotel" },
  { href: "/dat-phong", label: "Đặt phòng", roles: [...FRONT, "accountant"], kind: "hotel" },
  { href: "/buong-phong", label: "Buồng phòng", roles: [...FRONT, "housekeeping"] },
  { href: "/su-co", label: "Sự cố", roles: [...FRONT, "housekeeping", "maintenance"] },
  { href: "/thong-bao-luu-tru", label: "Thông báo lưu trú", roles: FRONT, kind: "hotel" },
  { href: "/hop-dong", label: "Hợp đồng", roles: MONEY, kind: "rental" },
  { href: "/ky-thu", label: "Kỳ thu", roles: MONEY, kind: "rental" },
  { href: "/thu-tien", label: "Thu tiền", roles: [...MONEY, "front_desk"], kind: "rental" },
  { href: "/doi-soat", label: "Đối soát", roles: MONEY, kind: "rental" },
  { href: "/phong", label: "Phòng", roles: STAFF },
];

export interface NavKinds {
  hotel: boolean;
  rental: boolean;
}

export function AppNav({
  current,
  role,
  kinds = { hotel: true, rental: true },
  unread = 0,
}: {
  current: string;
  role: Role;
  kinds?: NavKinds;
  unread?: number;
}) {
  const items = ITEMS.filter((i) => i.roles.includes(role) && (i.kind === undefined || kinds[i.kind]));
  return (
    <nav aria-label="Chức năng" className="app-nav">
      <ul>
        {items.map((i) => (
          <li key={i.href}>
            <a href={i.href} aria-current={i.href === current ? "page" : undefined}>
              {i.label}
            </a>
          </li>
        ))}
        <li>
          <a
            href="/thong-bao"
            className="bell"
            aria-current={current === "/thong-bao" ? "page" : undefined}
            aria-label={unread > 0 ? `${unread} thông báo chưa đọc` : "Thông báo"}
            data-testid="bell"
            data-unread={unread}
          >
            <Icon name="bell" />
            {unread > 0 ? (
              <span className="bell__count" aria-hidden="true">
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </a>
        </li>
      </ul>
    </nav>
  );
}
