"use client";
// Đăng ký tài khoản (Better Auth email/mật khẩu, tối thiểu 10 ký tự) rồi đăng nhập luôn → /chon-to-chuc, nơi tạo tổ chức đầu tiên
// (SPEC-access S-001). Email đã có tài khoản và lỗi chung dùng cùng một thông báo (không lộ email có tồn tại).
import { type FormEvent, useState } from "react";
import { useOnline } from "../../components/pwa/pwa-shell.tsx";
import { Button } from "../../components/ui/button.tsx";
import { TextField } from "../../components/ui/field.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";

async function post(path: string, body: unknown) {
  const res = await timedFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  return {
    ok: res.ok,
    status: res.status,
    data: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

export function RegisterForm() {
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!online) return setError("Không có kết nối mạng. Thao tác chưa được gửi.");
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email") ?? "");
    const password = String(f.get("password") ?? "");
    const name = String(f.get("name") ?? "").trim();
    if (!name) return setError("Bắt buộc nhập họ và tên.");
    if (password.length < 10) return setError("Mật khẩu tối thiểu 10 ký tự.");
    setBusy(true);
    setError(undefined);
    try {
      const r = await post("/api/auth/sign-up/email", { name, email, password });
      if (!r.ok)
        return setError(
          r.status === 429
            ? "Bạn thử quá nhiều lần. Vui lòng đợi rồi thử lại."
            : "Không tạo được tài khoản. Kiểm tra email và mật khẩu, hoặc đăng nhập nếu đã có tài khoản.",
        );
      const s = await post("/api/auth/sign-in/email", { email, password });
      if (!s.ok) return setError("Đã tạo tài khoản nhưng chưa đăng nhập được. Hãy đăng nhập.");
      window.location.assign("/chon-to-chuc");
    } catch {
      setError("Chưa nhận được phản hồi. Kiểm tra mạng rồi thử lại.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <TextField label="Họ và tên" name="name" autoComplete="name" required maxLength={200} />
      <TextField label="Email" name="email" type="email" autoComplete="username" required />
      <TextField
        label="Mật khẩu"
        name="password"
        type="password"
        autoComplete="new-password"
        hint="Tối thiểu 10 ký tự."
        required
        error={error}
      />
      <Button type="submit" loading={busy}>
        Tạo tài khoản
      </Button>
    </form>
  );
}
