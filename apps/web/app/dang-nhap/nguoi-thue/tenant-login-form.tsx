"use client";
// Đăng nhập người thuê bằng mã OTP gửi qua email (SPEC-portal Q-01; Better Auth emailOTP): bước 1 nhập email, bước 2 nhập mã.
// Thông điệp bước 1 luôn như nhau (không lộ email có tồn tại hay không); mã sai/hết hạn → một thông điệp chung.
// Bước 3 (T-2310, D-119) — CHỈ khi tài khoản chưa đồng ý mục đích bắt buộc (`service_core`, lần đầu dùng portal): ô đồng ý không tick
// sẵn → ghi ở server (`POST /api/v1/privacy/consents`, chủ thể = phiên). Trang portal cũng chặn ở server (`withPortal`) nếu bỏ qua bước này.
import type { ConsentDisplay } from "@hm/app";
import { type FormEvent, useState } from "react";
import { useOnline } from "../../../components/pwa/pwa-shell.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { CheckboxField, TextField } from "../../../components/ui/field.tsx";
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

/** Người dùng của phiên còn thiếu đồng ý bắt buộc? Lỗi đọc ⇒ false (trang portal vẫn chặn ở server). */
async function missingRequiredConsent(): Promise<boolean> {
  try {
    const res = await timedFetch("/api/v1/privacy/consents", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { consents: { required: boolean; granted: boolean }[] };
    return j.consents.some((c) => c.required && !c.granted);
  } catch {
    return false;
  }
}

/**
 * `onSuccess`: đăng nhập lại ngay trên trang (hộp đăng nhập lại, S-013) — không chuyển sang /chon-to-chuc. `consent`: văn bản đồng ý bắt
 * buộc (server truyền) — có thì bật bước đồng ý lần đầu; `initialStep="consent"` khi portal chuyển về vì chưa đồng ý (đã đăng nhập).
 */
export function TenantLoginForm({
  onSuccess,
  m,
  consent,
  initialStep = "email",
}: {
  onSuccess?: () => void;
  m: Messages<"tenant_login_form." | "auth_form.">;
  consent?: ConsentDisplay | undefined;
  initialStep?: "email" | "consent";
}) {
  const online = useOnline();
  const [step, setStep] = useState<"email" | "code" | "consent">(consent ? initialStep : "email");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!online) return setError(tm(m, "auth_form.offline"));
    const form = new FormData(e.currentTarget);
    const done = () => (onSuccess ? onSuccess() : window.location.assign("/chon-to-chuc"));
    if (step === "consent" && form.get("consent_service_core") !== "on")
      return setError(tm(m, "tenant_login_form.consent.required"));
    setBusy(true);
    setError(undefined);
    try {
      if (step === "consent") {
        const res = await timedFetch("/api/v1/privacy/consents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ purpose: "service_core", action: "grant", channel: "portal" }),
          credentials: "same-origin",
        });
        if (!res.ok) return setError(tm(m, "tenant_login_form.consent.failed"));
        done();
      } else if (step === "email") {
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
        if (consent && (await missingRequiredConsent())) return setStep("consent");
        done();
      }
    } catch {
      setError(tm(m, "auth_form.no_response"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {step === "consent" && consent ? (
        <>
          <p>{tm(m, "tenant_login_form.consent.intro")}</p>
          <CheckboxField name="consent_service_core" label={consent.text} required error={error} />
        </>
      ) : step === "email" ? (
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
        {step === "consent"
          ? tm(m, "tenant_login_form.consent.submit")
          : step === "email"
            ? tm(m, "tenant_login_form.submit.send")
            : tm(m, "tenant_login_form.submit.signin")}
      </Button>
    </form>
  );
}
