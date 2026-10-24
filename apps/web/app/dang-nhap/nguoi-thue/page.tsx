import type { Metadata } from "next";
import { messagesFor, t } from "../../../lib/i18n.ts";
import { TenantLoginForm } from "./tenant-login-form.tsx";

export const metadata: Metadata = { title: t("tenant_login_page.metadata.title") };

export default function TenantLoginPage() {
  return (
    <main id="main" className="page">
      <h1>{t("tenant_login_page.page.title")}</h1>
      <p>{t("tenant_login_page.intro")}</p>
      <TenantLoginForm m={messagesFor("tenant_login_form.", "auth_form.")} />
      <p>
        <a className="btn btn--secondary" href="/dang-nhap">
          {t("tenant_login_page.staff_link")}
        </a>
      </p>
    </main>
  );
}
