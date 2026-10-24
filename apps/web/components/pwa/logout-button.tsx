"use client";
// Đăng xuất (SPEC-pwa S-007): xoá dữ liệu người dùng trên máy (cache trừ app shell, IndexedDB `hm-*`, storage; báo SW
// CLEAR_USER_DATA), gọi Better Auth `sign-out` — máy chủ trả thêm `Clear-Site-Data: "cache", "storage"` — rồi thay trang bằng
// trang đăng nhập (replace: nút Back không đưa lại trang có dữ liệu; trang no-store sẽ yêu cầu đăng nhập khi tải lại).
import { useState } from "react";
import { timedFetch } from "../../lib/fetch-timeout.ts";
import { useMessages } from "../../lib/i18n-context.tsx";
import { tm } from "../../lib/i18n-format.ts";
import { Button } from "../ui/button.tsx";
import { clearUserData, useOnline } from "./pwa-shell.tsx";

export function LogoutButton() {
  const m = useMessages();
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    if (!online) return setError(tm(m, "common.command.offline"));
    setBusy(true);
    setError(null);
    try {
      await clearUserData();
      const res = await timedFetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        credentials: "same-origin",
      });
      if (res.ok) return window.location.replace("/dang-nhap");
      setError(tm(m, "common.logout.failed"));
    } catch {
      setError(tm(m, "common.logout.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant="secondary" loading={busy} onClick={() => void logout()}>
        {tm(m, "common.logout.button")}
      </Button>
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
