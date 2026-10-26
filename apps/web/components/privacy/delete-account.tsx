"use client";
// Xoá tài khoản ở trang Quyền riêng tư (T-2311, CMP-RIGHTS-007, D-123): xác thực lại TRƯỚC (nhập lại mật khẩu; tài khoản người thuê
// không có mật khẩu thì đăng nhập lại bằng mã OTP gửi qua email ⇒ phiên mới ≤ 5 phút) rồi hộp xác nhận nêu rõ hậu quả — chỉ gửi khi
// bấm nút ghi đúng hành động "Xoá vĩnh viễn tài khoản"; Esc/"Quay lại" không gửi gì. Server kiểm lại mọi điều kiện (phiên, mật khẩu,
// owner duy nhất); phần dữ liệu được giữ và căn cứ hiển thị ở trang (server dựng).
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useRef, useState } from "react";
import { TenantLoginForm } from "../../app/dang-nhap/nguoi-thue/tenant-login-form.tsx";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";
import { useOnline } from "../pwa/pwa-shell.tsx";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/field.tsx";
import { postDataRequest } from "./post-data-request.ts";

export type DeleteAccountMessages = Messages<"data_requests." | "tenant_login_form." | "auth_form.">;

export function DeleteAccount({ hasPassword, m }: { hasPassword: boolean; m: DeleteAccountMessages }) {
  const router = useRouter();
  const online = useOnline();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const password = useRef<string | undefined>(undefined);
  const [reauthed, setReauthed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState("");

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || dialogRef.current?.open) return;
    if (!online) return setError(tm(m, "data_requests.error.offline"));
    if (hasPassword) {
      const value = String(new FormData(e.currentTarget).get("password") ?? "");
      if (!value) return setError(tm(m, "data_requests.delete.error.password_required"));
      password.current = value;
    }
    setError(undefined);
    dialogRef.current?.showModal();
  }

  async function onConfirm() {
    dialogRef.current?.close();
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      const r = await postDataRequest("delete", hasPassword ? password.current : undefined);
      password.current = undefined;
      if (r.status === 401 && r.code === "REAUTH_REQUIRED")
        return setError(
          r.reason === "invalid_password"
            ? tm(m, "data_requests.delete.error.password_invalid")
            : tm(m, "data_requests.delete.error.reauth"),
        );
      if (r.status === 401) return setError(tm(m, "data_requests.error.session"));
      if (r.code === "LAST_OWNER") return setError(tm(m, "data_requests.delete.error.last_owner"));
      if (r.status === 429) return setError(tm(m, "data_requests.error.too_many"));
      if (!r.ok) return setError(tm(m, "data_requests.error.failed"));
      setNotice(tm(m, "data_requests.delete.done"));
      router.refresh();
    } catch {
      setError(tm(m, "data_requests.error.failed"));
    } finally {
      setBusy(false);
    }
  }

  const otpStep = !hasPassword && !reauthed;
  return (
    <div data-testid="dsar-delete">
      {otpStep ? (
        <>
          <p>{tm(m, "data_requests.delete.otp_intro")}</p>
          <TenantLoginForm onSuccess={() => setReauthed(true)} m={m} />
        </>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          {hasPassword ? (
            <TextField
              label={tm(m, "data_requests.delete.password_label")}
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          ) : (
            <p role="status">{tm(m, "data_requests.delete.otp_done")}</p>
          )}
          <Button type="submit" loading={busy}>
            {tm(m, "data_requests.delete.submit")}
          </Button>
        </form>
      )}
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
      <p role="status" aria-live="polite">
        {notice}
      </p>
      <dialog
        ref={dialogRef}
        className="confirm-dialog"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onClose={() => {
          // Sự kiện `close` đến SAU một task — lúc đó `onConfirm` đã đọc mật khẩu để gửi; đóng bằng Esc/"Quay lại" thì bỏ mật khẩu.
          if (!dialogRef.current?.open) password.current = undefined;
        }}
      >
        <h2 id={titleId} className="confirm-dialog__title">
          {tm(m, "data_requests.delete.confirm_title")}
        </h2>
        <p id={descId}>{tm(m, "data_requests.delete.confirm_text")}</p>
        <div className="confirm-dialog__actions">
          <Button variant="secondary" onClick={() => dialogRef.current?.close()}>
            {tm(m, "data_requests.delete.back")}
          </Button>
          <Button onClick={onConfirm}>{tm(m, "data_requests.delete.confirm")}</Button>
        </div>
      </dialog>
    </div>
  );
}
