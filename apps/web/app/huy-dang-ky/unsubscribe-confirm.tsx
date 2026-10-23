"use client";
// Nút xác nhận huỷ đăng ký: chỉ POST khi người dùng bấm (không tự gọi khi tải trang). Token không hiển thị, không ghi log.
import { useState } from "react";
import { useOnline } from "../../components/pwa/pwa-shell.tsx";
import { Button } from "../../components/ui/button.tsx";
import { ErrorState } from "../../components/ui/state.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";

type M = Messages<"unsubscribe_confirm." | "auth_form.">;

/** Lời nhắn theo mã trạng thái khi máy chủ không kèm `title` (dựng từ `m` — client không import catalog, D-098). */
function fallback(m: M): Record<number, string> {
  return {
    404: tm(m, "unsubscribe_confirm.error.invalid_link"),
    410: tm(m, "unsubscribe_confirm.error.expired"),
    422: tm(m, "unsubscribe_confirm.error.required_type"),
  };
}

export function UnsubscribeConfirm({ token, m }: { token: string; m: M }) {
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (token.length < 10)
    return (
      <ErrorState
        title={tm(m, "unsubscribe_confirm.invalid.title")}
        text={tm(m, "unsubscribe_confirm.invalid.text")}
      />
    );

  async function confirm() {
    if (!online) return setError(tm(m, "auth_form.offline"));
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
      if (res.ok) setDone(j?.data?.message ?? tm(m, "unsubscribe_confirm.done"));
      else setError(j?.title ?? fallback(m)[res.status] ?? tm(m, "unsubscribe_confirm.error.generic"));
    } catch {
      setError(tm(m, "unsubscribe_confirm.error.no_response"));
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
      <p>{tm(m, "unsubscribe_confirm.text")}</p>
      <Button onClick={confirm} loading={busy}>
        {tm(m, "unsubscribe_confirm.submit")}
      </Button>
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
