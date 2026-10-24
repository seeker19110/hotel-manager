// Điều hướng chính của nhân viên (SPEC-pwa S-014): thanh dưới với đúng các điểm vào của `primaryNav` (tối đa 5: Hôm nay ·
// Phòng/Lịch · Thu tiền · Công việc · Thêm); thanh trên (dưới tiêu đề ứng dụng) luôn nêu cơ sở đang thao tác + chuông thông báo.
// Mục đang mở có aria-current. Chi tiết mục theo vai trò: `nav-items.ts`.
import { t } from "../../lib/i18n.ts";
import { Icon } from "../ui/icon.tsx";
import { activeKey, moreLinks, type NavKinds, primaryNav, type Role, scopeLabel } from "./nav-items.ts";

export type { NavKinds } from "./nav-items.ts";

export function AppNav({
  current,
  role,
  kinds = { hotel: true, rental: true },
  unread = 0,
  propertyNames = [],
}: {
  current: string;
  role: Role;
  kinds?: NavKinds;
  unread?: number;
  propertyNames?: readonly string[];
}) {
  const items = primaryNav(role, kinds);
  const active = activeKey(items, current);
  return (
    <>
      <div className="scope-bar">
        <p className="scope-bar__property" data-testid="scope-bar">
          <span className="scope-bar__label">{t("nav.scope.label")} </span>
          {scopeLabel(propertyNames)}
        </p>
        <a
          href="/thong-bao"
          className="bell"
          aria-current={current === "/thong-bao" ? "page" : undefined}
          aria-label={unread > 0 ? t("nav.bell.unread", { count: unread }) : t("nav.bell.none")}
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
      </div>
      <nav aria-label={t("nav.label")} className="app-nav" data-testid="app-nav">
        <ul>
          {items.map((i) => (
            <li key={i.key}>
              <a
                href={i.href}
                aria-current={i.key === active && current !== "/thong-bao" ? "page" : undefined}
              >
                {i.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

/** Các màn của vai trò mà thanh dưới chưa trỏ thẳng tới (trang "Thêm"). */
export function MoreLinks({ role, kinds }: { role: Role; kinds?: NavKinds }) {
  const items = moreLinks(role, kinds);
  return (
    <ul className="card-list more-links" data-testid="more-links">
      {items.map((i) => (
        <li key={i.href}>
          <a className="btn btn--secondary" href={i.href}>
            {i.label}
          </a>
        </li>
      ))}
    </ul>
  );
}
