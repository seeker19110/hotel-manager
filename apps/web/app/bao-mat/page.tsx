import type { Metadata } from "next";
import { consentDisplays } from "../../lib/consent.ts";
import { messagesFor, t } from "../../lib/i18n.ts";
import { AccountRights } from "./account-rights.tsx";
import { MfaEnroll } from "./mfa-enroll.tsx";
import { PrivacySettings } from "./privacy-settings.tsx";

export const metadata: Metadata = { title: t("security_page.metadata.title") };

// Bật xác thực hai lớp (TOTP) cho CHÍNH tài khoản đang đăng nhập (Better Auth `twoFactor`, ADR-0002; SPEC-access S-011) và khối
// "Quyền riêng tư": trạng thái đồng ý theo mục đích, bật/tắt phân tích sản phẩm một bước (T-2310, D-119); khối "Dữ liệu của bạn":
// tải dữ liệu, hạn chế xử lý, xoá tài khoản (T-2311, D-120).
export default function SecurityPage() {
  return (
    <main id="main" className="page">
      <h1>{t("security_page.page.title")}</h1>
      <MfaEnroll m={messagesFor("mfa_enroll.", "auth_form.")} />
      <PrivacySettings m={messagesFor("privacy_settings.")} consents={consentDisplays()} />
      <AccountRights m={messagesFor("account_rights.")} />
    </main>
  );
}
