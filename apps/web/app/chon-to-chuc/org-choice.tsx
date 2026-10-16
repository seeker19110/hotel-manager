"use client";
// Một lựa chọn tổ chức (S-020): xoá dữ liệu người dùng trên máy rồi gọi `session.switchOrganization`
// (API-CONTRACT: JSON + Idempotency-Key; gửi lại cùng key khi lỗi mạng).
import { safeUrl } from "@hm/app/http";
import { useRef, useState } from "react";
import { clearUserData, useOnline } from "../../components/pwa/pwa-shell.tsx";
import { Button } from "../../components/ui/button.tsx";

export function OrgChoice({
  organizationId,
  label,
  meta,
  home = "/phong",
}: {
  organizationId: string;
  label: string;
  meta: string;
  /** Trang đích sau khi chọn: nhân viên → /phong, người thuê → /portal. */
  home?: string;
}) {
  const online = useOnline();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose() {
    if (!online) return setError("Không có kết nối mạng. Thao tác chưa được gửi.");
    setBusy(true);
    setError(null);
    key.current ??= crypto.randomUUID();
    try {
      await clearUserData();
      const res = await fetch("/api/v1/session/switchOrganization", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key.current },
        body: JSON.stringify({ organization_id: organizationId }),
        credentials: "same-origin",
      });
      if (res.status === 401) return window.location.assign("/dang-nhap");
      if (!res.ok) {
        key.current = null;
        return setError("Không chọn được tổ chức này. Tải lại trang để xem danh sách mới.");
      }
      window.location.assign(safeUrl(home) ?? "/phong");
    } catch {
      setError("Chưa nhận được phản hồi. Kiểm tra mạng rồi bấm lại.");
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
