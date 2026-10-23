"use client";
// Đăng ký tài khoản (Better Auth email/mật khẩu, tối thiểu 10 ký tự) rồi đăng nhập luôn → /chon-to-chuc, nơi tạo tổ chức đầu tiên
// (SPEC-access S-001). Email đã có tài khoản và lỗi chung dùng cùng một thông báo (không lộ email có tồn tại).
import { type FormEvent, useState } from "react";
import { useOnline } from "../../components/pwa/pwa-shell.tsx";
import { Button } from "../../components/ui/button.tsx";
import { TextField } from "../../components/ui/field.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";

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

export function RegisterForm({ m }: { m: Messages<"register_form." | "auth_form."> }) {
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!online) return setError(tm(m, "auth_form.offline"));
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email") ?? "");
    const password = String(f.get("password") ?? "");
    const name = String(f.get("name") ?? "").trim();
    if (!name) return setError(tm(m, "register_form.error.name_required"));
    if (password.length < 10) return setError(tm(m, "register_form.error.password_min"));
    setBusy(true);
    setError(undefined);
    try {
      const r = await post("/api/auth/sign-up/email", { name, email, password });
      if (!r.ok)
        return setError(
          r.status === 429
            ? tm(m, "register_form.error.too_many")
            : tm(m, "register_form.error.create_failed"),
        );
      const s = await post("/api/auth/sign-in/email", { email, password });
      if (!s.ok) return setError(tm(m, "register_form.error.signin_failed"));
      window.location.assign("/chon-to-chuc");
    } catch {
      setError(tm(m, "auth_form.no_response"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <TextField
        label={tm(m, "register_form.field.name")}
        name="name"
        autoComplete="name"
        required
        maxLength={200}
      />
      <TextField
        label={tm(m, "auth_form.field.email")}
        name="email"
        type="email"
        autoComplete="username"
        required
      />
      <TextField
        label={tm(m, "register_form.field.password")}
        name="password"
        type="password"
        autoComplete="new-password"
        hint={tm(m, "register_form.field.password_hint")}
        required
        error={error}
      />
      <Button type="submit" loading={busy}>
        {tm(m, "register_form.submit")}
      </Button>
    </form>
  );
}
