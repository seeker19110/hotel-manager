"use client";
// Khối "Quyền riêng tư" của trang Bảo mật (T-2310, D-119; CMP-RIGHTS-004): trạng thái đồng ý từng mục đích của CHÍNH người đăng nhập.
// `product_analytics`: MỘT nút bật/tắt (một bước — như lúc cấp ở đăng ký), hiệu lực ngay: `track()` kiểm đồng ý ở mỗi sự kiện. Mục đích
// bắt buộc `service_core`: không có nút tắt — giải thích rút = xoá tài khoản (T-2311); tài khoản cũ chưa có bản ghi thì cho xác nhận.
// Nút bật và nút tắt cùng kiểu/cùng cỡ (không dark pattern, UX-CONTENT-005); không hỏi lại sau khi người dùng đã tắt.
import type { ConsentDisplay } from "@hm/app";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { ErrorState, LoadingState } from "../../components/ui/state.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";

interface Row {
  purpose: string;
  required: boolean;
  granted: boolean;
}
type Phase = "checking" | "anonymous" | "failed" | "ready";

export function PrivacySettings({
  m,
  consents,
}: {
  m: Messages<"privacy_settings.">;
  consents: readonly ConsentDisplay[];
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setPhase("checking");
    try {
      const res = await timedFetch("/api/v1/privacy/consents", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.status === 401) return setPhase("anonymous");
      if (!res.ok) return setPhase("failed");
      setRows(((await res.json()) as { consents: Row[] }).consents);
      setPhase("ready");
    } catch {
      setPhase("failed");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function change(purpose: string, action: "grant" | "withdraw") {
    setBusy(purpose);
    setNotice(null);
    try {
      const res = await timedFetch("/api/v1/privacy/consents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose, action, channel: "settings" }),
        credentials: "same-origin",
      });
      if (!res.ok) return setNotice({ ok: false, text: tm(m, "privacy_settings.error.save") });
      setRows(((await res.json()) as { consents: Row[] }).consents);
      setNotice({ ok: true, text: tm(m, "privacy_settings.saved") });
    } catch {
      setNotice({ ok: false, text: tm(m, "privacy_settings.error.save") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="privacy-heading" data-testid="privacy-settings">
      <h2 id="privacy-heading">{tm(m, "privacy_settings.heading")}</h2>
      {phase === "checking" ? <LoadingState label={tm(m, "privacy_settings.checking")} rows={2} /> : null}
      {phase === "anonymous" ? <p>{tm(m, "privacy_settings.anonymous")}</p> : null}
      {phase === "failed" ? (
        <ErrorState
          title={tm(m, "privacy_settings.failed.title")}
          text={tm(m, "privacy_settings.failed.text")}
          action={<Button onClick={() => void load()}>{tm(m, "privacy_settings.retry")}</Button>}
        />
      ) : null}
      {phase === "ready" ? (
        <>
          <p>{tm(m, "privacy_settings.intro")}</p>
          <ul className="consent-list">
            {rows.map((r) => {
              const text = consents.find((c) => c.purpose === r.purpose)?.text ?? r.purpose;
              return (
                <li key={r.purpose} data-testid={`consent-${r.purpose}`} data-granted={String(r.granted)}>
                  <p>{text}</p>
                  <p>
                    <strong data-testid={`consent-status-${r.purpose}`}>
                      {r.granted ? tm(m, "privacy_settings.status.on") : tm(m, "privacy_settings.status.off")}
                    </strong>
                  </p>
                  {r.required ? (
                    r.granted ? (
                      <p className="field__hint">{tm(m, "privacy_settings.core.note")}</p>
                    ) : (
                      <Button loading={busy === r.purpose} onClick={() => void change(r.purpose, "grant")}>
                        {tm(m, "privacy_settings.core.grant")}
                      </Button>
                    )
                  ) : (
                    <Button
                      variant="secondary"
                      loading={busy === r.purpose}
                      onClick={() => void change(r.purpose, r.granted ? "withdraw" : "grant")}
                    >
                      {r.granted
                        ? tm(m, "privacy_settings.analytics.turn_off")
                        : tm(m, "privacy_settings.analytics.turn_on")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {notice ? (
            <p role={notice.ok ? "status" : "alert"} className={notice.ok ? undefined : "field__error"}>
              {notice.text}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
