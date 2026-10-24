// Điều hướng portal người thuê (mobile): Kỳ thu · Hợp đồng · Điện nước · Yêu cầu. Mục đang mở có aria-current.
// Server component (dựng trong lib/portal-page.tsx) ⇒ dịch bằng `t()` ở server, không qua `useMessages()` (D-101 chỉ cho client).
import { t } from "../../lib/i18n.ts";

export function PortalNav({ current }: { current: string }) {
  const items = [
    { href: "/portal", label: t("portal_nav.charges") },
    { href: "/portal/hop-dong", label: t("portal_nav.contract") },
    { href: "/portal/dien-nuoc", label: t("portal_nav.meters") },
    { href: "/portal/yeu-cau", label: t("portal_nav.requests") },
  ] as const;
  return (
    <nav aria-label={t("portal_nav.label")} className="app-nav">
      <ul>
        {items.map((i) => (
          <li key={i.href}>
            <a href={i.href} aria-current={i.href === current ? "page" : undefined}>
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
