import type { Metadata } from "next";

export const metadata: Metadata = { title: "Không có kết nối mạng — Hotel Manager" };

// S-004: trang dự phòng khi mất mạng — được precache; không chứa dữ liệu nghiệp vụ.
export default function OfflinePage() {
  return (
    <main id="main" className="page">
      <h1>Không có kết nối mạng</h1>
      <p>Ứng dụng cần mạng để xem và lưu dữ liệu. Chưa có thao tác nào được gửi.</p>
      <a className="btn" href="/">
        Thử lại
      </a>
    </main>
  );
}
