import type { Metadata } from "next";
import { LoginForm } from "./login-form.tsx";

export const metadata: Metadata = { title: "Đăng nhập — Hotel Manager" };

export default function LoginPage() {
  return (
    <main id="main" className="page">
      <h1>Đăng nhập</h1>
      <LoginForm />
    </main>
  );
}
