"use client";
// Đăng nhập email/mật khẩu (+ TOTP khi tài khoản bật 2 lớp) qua Better Auth (ADR-0002). Lỗi hiện bằng role="alert".
import { type FormEvent, useState } from "react";
import { useOnline } from "../../components/pwa/pwa-shell.tsx";
import { Button } from "../../components/ui/button.tsx";
import { TextField } from "../../components/ui/field.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";

type Step = "password" | "totp";

async function post(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await timedFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

function messageFor(status: number, data: Record<string, unknown>): string {
  if (data.code === "ACCOUNT_LOCKED" || status === 429) {
    return "Tài khoản tạm khoá do đăng nhập sai nhiều lần. Thử lại sau 15 phút.";
  }
  if (status === 401 || status === 400) return "Email hoặc mật khẩu không đúng.";
  return "Không đăng nhập được. Vui lòng thử lại.";
}

export function LoginForm() {
  const online = useOnline();
  const [step, setStep] = useState<Step>("password");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!online) {
      setError("Không có kết nối mạng. Thao tác chưa được gửi.");
      return;
    }
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      if (step === "password") {
        const r = await post("/api/auth/sign-in/email", {
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        });
        if (!r.ok) return setError(messageFor(r.status, r.data));
        if (r.data.twoFactorRedirect) return setStep("totp");
      } else {
        const r = await post("/api/auth/two-factor/verify-totp", { code: String(form.get("code") ?? "") });
        if (!r.ok) return setError("Mã xác thực không đúng hoặc đã hết hạn.");
      }
      window.location.assign("/chon-to-chuc");
    } catch {
      setError("Chưa nhận được phản hồi. Kiểm tra mạng rồi thử lại.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {step === "password" ? (
        <>
          <TextField label="Email" name="email" type="email" autoComplete="username" required />
          <TextField
            label="Mật khẩu"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            error={error}
          />
        </>
      ) : (
        <TextField
          label="Mã xác thực 6 số"
          hint="Mở ứng dụng xác thực trên điện thoại để lấy mã."
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          required
          error={error}
        />
      )}
      <Button type="submit" loading={busy}>
        {step === "password" ? "Đăng nhập" : "Xác nhận"}
      </Button>
    </form>
  );
}
