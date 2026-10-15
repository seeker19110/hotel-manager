import { EmptyState } from "../components/ui/state.tsx";

export default function HomePage() {
  return (
    <main id="main" className="page">
      <h1>Hôm nay</h1>
      <EmptyState
        title="Chưa đăng nhập"
        text="Đăng nhập để xem phòng và việc trong ngày."
        action={
          <a className="btn" href="/dang-nhap">
            Đăng nhập
          </a>
        }
      />
    </main>
  );
}
