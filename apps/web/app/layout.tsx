import "./globals.css";
import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { PwaShell } from "../components/pwa/pwa-shell.tsx";
import { APP_VERSION } from "../lib/app-version.ts";
import { BRAND_COLOR } from "../lib/brand.ts";
import { messagesFor, t } from "../lib/i18n.ts";
import { MessagesProvider } from "../lib/i18n-context.tsx";

export const metadata: Metadata = {
  title: "Hotel Manager",
  description: t("app.description"),
  applicationName: "Hotel Manager",
  icons: { apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
  appleWebApp: { capable: true, title: t("app.short_name"), statusBarStyle: "default" },
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
          {t("app.skip_link")}
        </a>
        {/* Chữ dùng chung của hạ tầng client (D-101): mọi trang, error.tsx và banner của vỏ PWA nằm trong provider. */}
        <MessagesProvider m={messagesFor("common.")}>
          <PwaShell reauth={messagesFor("login_form.", "tenant_login_form.", "auth_form.")}>
            <header className="app-header">
              <p className="app-header__title">Hotel Manager</p>
            </header>
            {children}
          </PwaShell>
        </MessagesProvider>
      </body>
    </html>
  );
}
