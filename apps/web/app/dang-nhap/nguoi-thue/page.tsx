import type { Metadata } from "next";
import { consentDisplays } from "../../../lib/consent.ts";
import { messagesFor, t } from "../../../lib/i18n.ts";
import { currentSession } from "../../../lib/session.ts";
import { TenantLoginForm } from "./tenant-login-form.tsx";

export const metadata: Metadata = { title: t("tenant_login_page.metadata.title") };

// `?buoc=dong-y`: portal chuyển về vì người thuê đã đăng nhập nhưng chưa đồng ý mục đích bắt buộc (T-2310) ⇒ mở thẳng bước đồng ý.
export default async function TenantLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const consentStep = (await searchParams).buoc === "dong-y" && (await currentSession()) !== null;
  return (
    <main id="main" className="page">
      <h1>{t("tenant_login_page.page.title")}</h1>
      <p>{t("tenant_login_page.intro")}</p>
      <TenantLoginForm
        m={messagesFor("tenant_login_form.", "auth_form.")}
        consent={consentDisplays().find((c) => c.purpose === "service_core")}
        initialStep={consentStep ? "consent" : "email"}
      />
      <p>
        <a className="btn btn--secondary" href="/dang-nhap">
          {t("tenant_login_page.staff_link")}
        </a>
      </p>
    </main>
  );
}
