"use client";
// Một lựa chọn tổ chức (S-020): xoá dữ liệu người dùng trên máy rồi gọi `session.switchOrganization`
// (API-CONTRACT: JSON + Idempotency-Key; gửi lại cùng key khi lỗi mạng).
import { safeUrl } from "@hm/app/http";
import { useRef, useState } from "react";
import { clearUserData, useOnline } from "../../components/pwa/pwa-shell.tsx";
import { Button } from "../../components/ui/button.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";
import type { Messages } from "../../lib/i18n.ts";
import { useMessages } from "../../lib/i18n-context.tsx";
import { tm } from "../../lib/i18n-format.ts";

export function OrgChoice({
  organizationId,
  label,
  meta,
  home = "/phong",
  m,
}: {
  organizationId: string;
  label: string;
  meta: string;
  /** Trang đích sau khi chọn: nhân viên → /phong, người thuê → /portal. */
  home?: string;
  m: Messages<"org_choice.">;
}) {
  const common = useMessages();
  const online = useOnline();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose() {
    if (!online) return setError(tm(common, "common.command.offline"));
    setBusy(true);
    setError(null);
    key.current ??= crypto.randomUUID();
    try {
      await clearUserData();
      const res = await timedFetch("/api/v1/session/switchOrganization", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key.current },
        body: JSON.stringify({ organization_id: organizationId }),
        credentials: "same-origin",
      });
      if (res.status === 401) return window.location.assign("/dang-nhap");
      if (!res.ok) {
        key.current = null;
        return setError(tm(m, "org_choice.error.failed"));
      }
      window.location.assign(safeUrl(home) ?? "/phong");
    } catch {
      setError(tm(m, "org_choice.error.no_response"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant="secondary" className="choice-list__item" loading={busy} onClick={choose}>
        <span>{label}</span>
        <span className="choice-list__meta">{meta}</span>
      </Button>
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
