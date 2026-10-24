import type { Metadata } from "next";
import { t } from "../../lib/i18n.ts";

export const metadata: Metadata = { title: t("offline.metadata.title") };

// S-004: trang dự phòng khi mất mạng — được precache; không chứa dữ liệu nghiệp vụ.
export default function OfflinePage() {
  return (
    <main id="main" className="page">
      <h1>{t("offline.page.title")}</h1>
      <p>{t("offline.text")}</p>
      <a className="btn" href="/">
        {t("common.retry")}
      </a>
    </main>
  );
}
