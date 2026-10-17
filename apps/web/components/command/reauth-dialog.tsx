"use client";
// Hộp đăng nhập lại (SPEC-pwa S-013): phiên hết hạn khi đang dùng ⇒ hộp modal ngay trên trang (form phía sau giữ nguyên nội
// dung đã nhập). Đăng nhập xong ⇒ `useCommand` gửi lại với CÙNG command_id; nếu ngữ cảnh tổ chức đã khác, server trả 409
// CONTEXT_CHANGED/ORG_CONTEXT_REQUIRED và form bị huỷ. "Để sau" ⇒ không gửi gì. Focus về tiêu đề khi mở.
import { useCallback, useEffect, useRef, useState } from "react";
import { LoginForm } from "../../app/dang-nhap/login-form.tsx";
import { TenantLoginForm } from "../../app/dang-nhap/nguoi-thue/tenant-login-form.tsx";
import { Button } from "../ui/button.tsx";
import { setReauthHandler, UNAUTHENTICATED_TEXT } from "./reauth.ts";

export function ReauthDialog() {
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
        Đăng nhập lại
      </h2>
      <p role="alert">{UNAUTHENTICATED_TEXT}</p>
      {open === "tenant" ? <TenantLoginForm onSuccess={() => settle(true)} /> : null}
      {open === "staff" ? <LoginForm onSuccess={() => settle(true)} /> : null}
      <div className="confirm-dialog__actions">
        <Button variant="secondary" onClick={() => settle(false)}>
          Để sau
        </Button>
      </div>
    </dialog>
  );
}
