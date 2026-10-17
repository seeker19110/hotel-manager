"use client";
// Đăng nhập người thuê bằng mã OTP gửi qua email (SPEC-portal Q-01; Better Auth emailOTP): bước 1 nhập email, bước 2 nhập mã.
// Thông điệp bước 1 luôn như nhau (không lộ email có tồn tại hay không); mã sai/hết hạn → một thông điệp chung.
import { type FormEvent, useState } from "react";
import { useOnline } from "../../../components/pwa/pwa-shell.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { TextField } from "../../../components/ui/field.tsx";
import { timedFetch } from "../../../lib/fetch-timeout.ts";

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number }> {
  const res = await timedFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  return { ok: res.ok, status: res.status };
}

export function TenantLoginForm() {
  const online = useOnline();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!online) return setError("Không có kết nối mạng. Thao tác chưa được gửi.");
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      if (step === "email") {
        const value = String(form.get("email") ?? "").trim();
        if (!value) return setError("Bắt buộc nhập email");
        const r = await post("/api/auth/email-otp/send-verification-otp", { email: value, type: "sign-in" });
        if (r.status === 429) return setError("Bạn thử quá nhiều lần. Vui lòng đợi ít phút.");
        if (!r.ok) return setError("Không gửi được mã. Vui lòng thử lại.");
        setEmail(value);
        setStep("code");
      } else {
        const otp = String(form.get("otp") ?? "").trim();
        if (!/^\d{6}$/.test(otp)) return setError("Nhập mã gồm 6 chữ số");
        const r = await post("/api/auth/sign-in/email-otp", { email, otp });
        if (r.status === 429) return setError("Bạn thử quá nhiều lần. Vui lòng đợi ít phút.");
        if (!r.ok) return setError("Mã không đúng hoặc đã hết hạn.");
        window.location.assign("/chon-to-chuc");
      }
    } catch {
      setError("Chưa nhận được phản hồi. Kiểm tra mạng rồi thử lại.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {step === "email" ? (
        <TextField label="Email" name="email" type="email" autoComplete="email" required error={error} />
      ) : (
        <>
          <p role="status">Nếu email đúng, mã đã được gửi. Mã có hiệu lực 5 phút.</p>
          <TextField
            label="Mã đăng nhập 6 số"
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
        {step === "email" ? "Gửi mã" : "Đăng nhập"}
      </Button>
    </form>
  );
}
