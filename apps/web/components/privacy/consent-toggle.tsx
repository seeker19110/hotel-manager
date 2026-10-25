"use client";
// Bật/tắt đồng ý MỘT mục đích ở trang Quyền riêng tư (CMP-RIGHTS-004, T-2310): cho và rút cùng số bước — đổi ô rồi bấm "Lưu lựa
// chọn". Trạng thái ban đầu lấy từ server (không tick sẵn khi chưa đồng ý); lưu xong làm mới trang để trạng thái + lịch sử đọc lại
// từ CSDL. Quyền thật ở server (phiên + RLS theo người dùng); CSRF bằng kiểm Origin của proxy.
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";
import { useOnline } from "../pwa/pwa-shell.tsx";
import { Button } from "../ui/button.tsx";
import { CheckboxField } from "../ui/field.tsx";
import { type ConsentChannel, postConsent } from "./post-consent.ts";

export function ConsentToggle({
  purpose,
  version,
  label,
  granted,
  channel,
  m,
}: {
  purpose: string;
  version: string;
  label: string;
  granted: boolean;
  channel: ConsentChannel;
  m: Messages<"consent_toggle.">;
}) {
  const router = useRouter();
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>("");
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (!online) return setError(tm(m, "consent_toggle.error.offline"));
    const checked = new FormData(e.currentTarget).get("consent") === "on";
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      const r = await postConsent({ purpose, granted: checked, channel, version });
      if (r.status === 401) return setError(tm(m, "consent_toggle.error.session"));
      if (r.status === 409) return setError(tm(m, "consent_toggle.error.outdated"));
      if (!r.ok) return setError(tm(m, "consent_toggle.error.failed"));
      setNotice(r.result === "unchanged" ? tm(m, "consent_toggle.unchanged") : tm(m, "consent_toggle.saved"));
      router.refresh();
    } catch {
      setError(tm(m, "consent_toggle.error.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate data-testid={`consent-${purpose}`}>
      <CheckboxField label={label} name="consent" defaultChecked={granted} />
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
      <p role="status" aria-live="polite">
        {notice}
      </p>
      <Button type="submit" variant="secondary" loading={busy}>
        {tm(m, "consent_toggle.save")}
      </Button>
    </form>
  );
}
