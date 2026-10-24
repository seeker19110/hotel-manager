import type { Metadata } from "next";
import { messagesFor, t } from "../../lib/i18n.ts";
import { AcceptInvitation } from "./accept-invitation.tsx";

// Token lời mời nằm ở FRAGMENT (`/loi-moi#token=…`) — trình duyệt không gửi fragment lên máy chủ nên token không vào nhật ký truy
// cập/proxy; trang chỉ đọc nó phía client rồi xoá khỏi thanh địa chỉ. `no-referrer` để liên kết ra ngoài không mang theo URL trang.
export const metadata: Metadata = {
  title: t("invitation_page.metadata.title"),
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function InvitationPage() {
  return (
    <main id="main" className="page">
      <h1>{t("invitation_page.page.title")}</h1>
      <AcceptInvitation m={messagesFor("invitation.")} />
    </main>
  );
}
