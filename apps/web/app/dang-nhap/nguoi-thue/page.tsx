import type { Metadata } from "next";
import { messagesFor } from "../../../lib/i18n.ts";
import { TenantLoginForm } from "./tenant-login-form.tsx";

export const metadata: Metadata = { title: "Đăng nhập người thuê — Hotel Manager" };

export default function TenantLoginPage() {
  return (
    <main id="main" className="page">
      <h1>Đăng nhập người thuê</h1>
      <p>Nhập email chủ trọ đã đăng ký cho bạn. Chúng tôi gửi một mã 6 số đến email đó.</p>
      <TenantLoginForm m={messagesFor("tenant_login_form.", "auth_form.")} />
      <p>
        <a className="btn btn--secondary" href="/dang-nhap">
          Tôi là nhân viên
        </a>
      </p>
    </main>
  );
}
