import type { Metadata } from "next";
import { messagesFor, t } from "../../lib/i18n.ts";
import { RegisterForm } from "./register-form.tsx";

export const metadata: Metadata = { title: t("register_page.metadata.title") };

export default function RegisterPage() {
  return (
    <main id="main" className="page">
      <h1>{t("register_page.page.title")}</h1>
      <RegisterForm m={messagesFor("register_form.", "auth_form.")} />
      <p>
        <a className="btn btn--secondary" href="/dang-nhap">
          {t("register_page.login_link")}
        </a>
      </p>
    </main>
  );
}
