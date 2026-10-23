import type { Metadata } from "next";
import { messagesFor } from "../../lib/i18n.ts";
import { RegisterForm } from "./register-form.tsx";

export const metadata: Metadata = { title: "Tạo tài khoản — Hotel Manager" };

export default function RegisterPage() {
  return (
    <main id="main" className="page">
      <h1>Tạo tài khoản</h1>
      <RegisterForm m={messagesFor("register_form.", "auth_form.")} />
      <p>
        <a className="btn btn--secondary" href="/dang-nhap">
          Tôi đã có tài khoản
        </a>
      </p>
    </main>
  );
}
