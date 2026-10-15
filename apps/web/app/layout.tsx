import type { ReactNode } from "react";

export const metadata = {
  title: "Hotel Manager",
  description: "Quản lý phòng trọ, nhà nghỉ, khách sạn nhỏ",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
