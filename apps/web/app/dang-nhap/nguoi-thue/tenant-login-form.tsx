"use client";
// Đăng nhập người thuê bằng mã OTP gửi qua email (SPEC-portal Q-01; Better Auth emailOTP): bước 1 nhập email, bước 2 nhập mã.
// Thông điệp bước 1 luôn như nhau (không lộ email có tồn tại hay không); mã sai/hết hạn → một thông điệp chung.
import { type FormEvent, useState } from "react";
import { useOnline } from "../../../components/pwa/pwa-shell.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { TextField } from "../../../components/ui/field.tsx";
import { timedFetch } from "../../../lib/fetch-timeout.ts";
import type { Messages } from "../../../lib/i18n.ts";
import { tm } from "../../../lib/i18n-format.ts";

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number }> {
  const res = await timedFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  return { ok: res.ok, status: res.status };
}

/** `onSuccess`: đăng nhập lại ngay trên trang (hộp đăng nhập lại, S-013) — không chuyển sang /chon-to-chuc. */
export function TenantLoginForm({
  onSuccess,
  m,
}: {
  onSuccess?: () => void;
  m: Messages<"tenant_login_form." | "auth_form.">;
}) {
  const online = useOnline();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!online) return setError(tm(m, "auth_form.offline"));
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      if (step === "email") {
        const value = String(form.get("email") ?? "").trim();
        if (!value) return setError(tm(m, "tenant_login_form.error.email_required"));
        const r = await post("/api/auth/email-otp/send-verification-otp", { email: value, type: "sign-in" });
        if (r.status === 429) return setError(tm(m, "tenant_login_form.error.too_many"));
        if (!r.ok) return setError(tm(m, "tenant_login_form.error.send_failed"));
        setEmail(value);
        setStep("code");
      } else {
        const otp = String(form.get("otp") ?? "").trim();
        if (!/^\d{6}$/.test(otp)) return setError(tm(m, "tenant_login_form.error.otp_format"));
        const r = await post("/api/auth/sign-in/email-otp", { email, otp });
        if (r.status === 429) return setError(tm(m, "tenant_login_form.error.too_many"));
        if (!r.ok) return setError(tm(m, "tenant_login_form.error.otp_invalid"));
        if (onSuccess) onSuccess();
        else window.location.assign("/chon-to-chuc");
      }
    } catch {
      setError(tm(m, "auth_form.no_response"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {step === "email" ? (
        <TextField
          label={tm(m, "auth_form.field.email")}
          name="email"
          type="email"
          autoComplete="email"
          required
          error={error}
        />
      ) : (
        <>
          <p role="status">{tm(m, "tenant_login_form.status.sent")}</p>
          <TextField
            label={tm(m, "tenant_login_form.field.otp")}
            name="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            required
            error={error}
          />
        </>
      )}
      <Button type="submit" loading={busy}>
        {step === "email" ? tm(m, "tenant_login_form.submit.send") : tm(m, "tenant_login_form.submit.signin")}
      </Button>
    </form>
  );
}
