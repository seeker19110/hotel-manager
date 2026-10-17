import type { Metadata } from "next";
import { MfaEnroll } from "./mfa-enroll.tsx";

export const metadata: Metadata = { title: "Bảo mật tài khoản — Hotel Manager" };

// Bật xác thực hai lớp (TOTP) cho CHÍNH tài khoản đang đăng nhập (Better Auth `twoFactor`, ADR-0002; SPEC-access S-011).
export default function SecurityPage() {
  return (
    <main id="main" className="page">
      <h1>Bảo mật tài khoản</h1>
      <MfaEnroll />
    </main>
  );
}
