import type { Metadata } from "next";
import { messagesFor, t } from "../../lib/i18n.ts";
import { MfaEnroll } from "./mfa-enroll.tsx";

export const metadata: Metadata = { title: t("security_page.metadata.title") };

// Bật xác thực hai lớp (TOTP) cho CHÍNH tài khoản đang đăng nhập (Better Auth `twoFactor`, ADR-0002; SPEC-access S-011).
export default function SecurityPage() {
  return (
    <main id="main" className="page">
      <h1>{t("security_page.page.title")}</h1>
      <MfaEnroll m={messagesFor("mfa_enroll.", "auth_form.")} />
      <p>
        <a className="btn btn--secondary" href="/quyen-rieng-tu">
          {t("privacy_page.link")}
        </a>
      </p>
    </main>
  );
}
