// Điều hướng portal người thuê (mobile): Kỳ thu · Hợp đồng · Điện nước · Yêu cầu. Mục đang mở có aria-current.
const ITEMS = [
  { href: "/portal", label: "Kỳ thu" },
  { href: "/portal/hop-dong", label: "Hợp đồng" },
  { href: "/portal/dien-nuoc", label: "Điện nước" },
  { href: "/portal/yeu-cau", label: "Yêu cầu" },
] as const;

export function PortalNav({ current }: { current: string }) {
  return (
    <nav aria-label="Portal người thuê" className="app-nav">
      <ul>
        {ITEMS.map((i) => (
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
