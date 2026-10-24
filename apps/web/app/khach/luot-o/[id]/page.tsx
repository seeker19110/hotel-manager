import type { Metadata } from "next";
import { messagesFor, t } from "../../../../lib/i18n.ts";
import { GuestStay } from "./guest-stay.tsx";

export const metadata: Metadata = {
  title: t("guest_stay_page.metadata.title"),
  // Mã liên kết nằm ở fragment (#t=…) nên không vào log/Referer; vẫn tắt Referer để chắc chắn không lộ gì sang trang khác.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function GuestStayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main id="main" className="page">
      <h1>{t("guest_stay_page.page.title")}</h1>
      <GuestStay stayId={id} m={messagesFor("guest_stay.")} />
    </main>
  );
}
