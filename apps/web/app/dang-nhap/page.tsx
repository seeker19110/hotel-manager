import type { Metadata } from "next";
import { messagesFor, t } from "../../lib/i18n.ts";
import { LoginForm } from "./login-form.tsx";

export const metadata: Metadata = { title: t("login_page.metadata.title") };

export default function LoginPage() {
  return (
    <main id="main" className="page">
      <h1>{t("login_page.page.title")}</h1>
      <LoginForm m={messagesFor("login_form.", "auth_form.")} />
      <p>
        <a className="btn btn--secondary" href="/dang-nhap/nguoi-thue">
          {t("login_page.tenant_link")}
        </a>
      </p>
      <p>
        <a className="btn btn--secondary" href="/dang-ky">
          {t("login_page.register_link")}
        </a>
      </p>
    </main>
  );
}
