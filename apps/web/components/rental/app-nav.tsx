// Điều hướng chính khu nhà trọ (PLAN đợt 2 T-117). Mục đang mở có aria-current.
const ITEMS = [
  { href: "/hop-dong", label: "Hợp đồng" },
  { href: "/ky-thu", label: "Kỳ thu" },
  { href: "/thu-tien", label: "Thu tiền" },
  { href: "/doi-soat", label: "Đối soát" },
  { href: "/phong", label: "Phòng" },
] as const;

export function AppNav({ current }: { current: string }) {
  return (
    <nav aria-label="Chức năng" className="app-nav">
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
