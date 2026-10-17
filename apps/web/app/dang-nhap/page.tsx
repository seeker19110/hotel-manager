import type { Metadata } from "next";
import { LoginForm } from "./login-form.tsx";

export const metadata: Metadata = { title: "Đăng nhập — Hotel Manager" };

export default function LoginPage() {
  return (
    <main id="main" className="page">
      <h1>Đăng nhập</h1>
      <LoginForm />
      <p>
        <a className="btn btn--secondary" href="/dang-nhap/nguoi-thue">
          Tôi là người thuê
        </a>
      </p>
      <p>
        <a className="btn btn--secondary" href="/dang-ky">
          Tạo tài khoản mới
        </a>
      </p>
    </main>
  );
}
