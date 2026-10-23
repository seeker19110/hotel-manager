import type { Metadata } from "next";
import { messagesFor } from "../../lib/i18n.ts";
import { UnsubscribeConfirm } from "./unsubscribe-confirm.tsx";

export const metadata: Metadata = {
  title: "Huỷ đăng ký email — Hotel Manager",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

// SPEC-notifications S-010. Trang chỉ HIỂN THỊ nút xác nhận; KHÔNG đổi gì khi tải (trình quét liên kết/prefetch hay tự mở link).
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const raw = q.t ?? q.token;
  const token = Array.isArray(raw) ? raw[0] : raw;
  return (
    <main id="main" className="page">
      <h1>Huỷ đăng ký email</h1>
      <UnsubscribeConfirm token={token ?? ""} m={messagesFor("unsubscribe_confirm.", "auth_form.")} />
    </main>
  );
}
