import "./globals.css";
import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { PwaShell } from "../components/pwa/pwa-shell.tsx";
import { APP_VERSION } from "../lib/app-version.ts";
import { BRAND_COLOR } from "../lib/brand.ts";

export const metadata: Metadata = {
  title: "Hotel Manager",
  description: "Quản lý phòng trọ, nhà nghỉ, khách sạn nhỏ",
  applicationName: "Hotel Manager",
  icons: { apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
  appleWebApp: { capable: true, title: "Quản lý phòng", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  // S-009: phiên bản bản build của trang này; client gửi lại ở `X-App-Version` (components/command/app-version.ts).
  other: { "hm-app-version": APP_VERSION },
};

export const viewport: Viewport = {
  themeColor: BRAND_COLOR,
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Render theo request: Next gắn nonce CSP (proxy.ts) vào script của nó; trang tĩnh sẽ thiếu nonce và bị CSP chặn.
  await connection();
  return (
    <html lang="vi">
      <body>
        <a className="skip-link" href="#main">
          Bỏ qua tới nội dung
        </a>
        <PwaShell>
          <header className="app-header">
            <p className="app-header__title">Hotel Manager</p>
          </header>
          {children}
        </PwaShell>
      </body>
    </html>
  );
}
