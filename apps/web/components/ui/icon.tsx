// Icon SVG nội tuyến (PLAN đợt 4 T-310, UX-VISUAL-006): không dùng ký tự emoji/ký hiệu Unicode làm icon — hiển thị khác nhau
// giữa hệ điều hành và bị trình đọc màn hình đọc thành chữ. Luôn kèm chữ bên cạnh; icon chỉ trang trí (aria-hidden).
type IconName = "warning" | "info" | "blocked" | "bell";

const PATHS: Record<IconName, string> = {
  warning: "M12 3 2 21h20L12 3zm0 6v6m0 2.5v1",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 8v6m0-9.5v1",
  blocked: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2zm4 4a2 2 0 0 0 4 0",
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
