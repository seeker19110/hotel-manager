"use client";
// Hộp đăng nhập lại (SPEC-pwa S-013): phiên hết hạn khi đang dùng ⇒ hộp modal ngay trên trang (form phía sau giữ nguyên nội
// dung đã nhập). Đăng nhập xong ⇒ `useCommand` gửi lại với CÙNG command_id; nếu ngữ cảnh tổ chức đã khác, server trả 409
// CONTEXT_CHANGED/ORG_CONTEXT_REQUIRED và form bị huỷ. "Để sau" ⇒ không gửi gì. Focus về tiêu đề khi mở.
import { useCallback, useEffect, useRef, useState } from "react";
import { LoginForm } from "../../app/dang-nhap/login-form.tsx";
import { TenantLoginForm } from "../../app/dang-nhap/nguoi-thue/tenant-login-form.tsx";
import type { Messages } from "../../lib/i18n.ts";
import { useMessages } from "../../lib/i18n-context.tsx";
import { tm } from "../../lib/i18n-format.ts";
import { Button } from "../ui/button.tsx";
import { setReauthHandler } from "./reauth.ts";

/** Chữ của hai form đăng nhập hiển thị trong hộp (server dựng ở layout; client không import catalog, D-098). */
export type ReauthMessages = Messages<"login_form." | "tenant_login_form." | "auth_form.">;

export function ReauthDialog({ m }: { m: ReauthMessages }) {
  const common = useMessages();
  const ref = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  // Form đăng nhập chỉ dựng khi hộp mở (tránh trùng ô "Email"/"Mật khẩu" ẩn trên mọi trang, kể cả /dang-nhap).
  const [open, setOpen] = useState<"staff" | "tenant" | null>(null);
  const pending = useRef<{ promise: Promise<boolean>; settle: (ok: boolean) => void } | null>(null);

  const settle = useCallback((ok: boolean) => {
    const p = pending.current;
    pending.current = null;
    if (ref.current?.open) ref.current.close();
    setOpen(null);
    p?.settle(ok);
  }, []);

  useEffect(() => {
    setReauthHandler(() => {
      // Nhiều lệnh cùng gặp 401: dùng chung một hộp, cùng chờ một lần đăng nhập.
      if (pending.current) return pending.current.promise;
      let resolve: (ok: boolean) => void = () => {};
      const promise = new Promise<boolean>((r) => {
        resolve = r;
      });
      pending.current = { promise, settle: resolve };
      // Người thuê (portal) đăng nhập bằng mã OTP email; nhân viên bằng mật khẩu.
      setOpen(window.location.pathname.startsWith("/portal") ? "tenant" : "staff");
      ref.current?.showModal();
      title.current?.focus();
      return promise;
    });
    return () => setReauthHandler(null);
  }, []);

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="reauth-title"
      data-testid="reauth-dialog"
      onCancel={(e) => {
        e.preventDefault();
        settle(false);
      }}
    >
      <h2 id="reauth-title" ref={title} tabIndex={-1} className="confirm-dialog__title">
        {tm(common, "common.reauth.title")}
      </h2>
      <p role="alert">{tm(common, "common.command.unauthenticated")}</p>
      {open === "tenant" ? <TenantLoginForm onSuccess={() => settle(true)} m={m} /> : null}
      {open === "staff" ? <LoginForm onSuccess={() => settle(true)} m={m} /> : null}
      <div className="confirm-dialog__actions">
        <Button variant="secondary" onClick={() => settle(false)}>
          {tm(common, "common.reauth.later")}
        </Button>
      </div>
    </dialog>
  );
}
