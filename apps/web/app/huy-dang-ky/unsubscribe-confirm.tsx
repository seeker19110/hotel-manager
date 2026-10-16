"use client";
// Nút xác nhận huỷ đăng ký: chỉ POST khi người dùng bấm (không tự gọi khi tải trang). Token không hiển thị, không ghi log.
import { useState } from "react";
import { useOnline } from "../../components/pwa/pwa-shell.tsx";
import { Button } from "../../components/ui/button.tsx";
import { ErrorState } from "../../components/ui/state.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";

const FALLBACK: Record<number, string> = {
  404: "Liên kết không hợp lệ.",
  410: "Liên kết đã hết hạn. Vui lòng đổi tuỳ chọn trong mục Tài khoản.",
  422: "Loại thông báo này cần thiết cho tài khoản và không tắt được.",
};

export function UnsubscribeConfirm({ token }: { token: string }) {
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (token.length < 10)
    return (
      <ErrorState
        title="Liên kết không hợp lệ"
        text="Hãy mở đúng liên kết trong email, hoặc đổi tuỳ chọn thông báo trong mục Tài khoản."
      />
    );

  async function confirm() {
    if (!online) return setError("Không có kết nối mạng. Thao tác chưa được gửi.");
    setBusy(true);
    setError(null);
    try {
      const res = await timedFetch("/api/v1/notifications/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        credentials: "same-origin",
        referrerPolicy: "no-referrer",
      });
      const j = (await res.json().catch(() => null)) as {
        data?: { message?: string };
        title?: string;
      } | null;
      if (res.ok) setDone(j?.data?.message ?? "Đã huỷ đăng ký email loại này.");
      else setError(j?.title ?? FALLBACK[res.status] ?? "Không thực hiện được. Vui lòng thử lại.");
    } catch {
      setError("Chưa nhận được phản hồi. Kiểm tra mạng rồi bấm lại.");
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <p className="command-form__status command-form__status--ok" role="status" data-testid="unsub-done">
        {done}
      </p>
    );
  return (
    <>
      <p>Bấm nút bên dưới để không nhận loại email này nữa. Bạn có thể bật lại trong mục Tài khoản.</p>
      <Button onClick={confirm} loading={busy}>
        Xác nhận huỷ đăng ký
      </Button>
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
