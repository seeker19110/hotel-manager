"use client";
// Đăng ký tài khoản (Better Auth email/mật khẩu, tối thiểu 10 ký tự) rồi đăng nhập luôn → /chon-to-chuc, nơi tạo tổ chức đầu tiên
// (SPEC-access S-001). Email đã có tài khoản và lỗi chung dùng cùng một thông báo (không lộ email có tồn tại).
// Đồng ý theo mục đích (T-2310, D-119): ô `service_core` bắt buộc, ô `product_analytics` tuỳ chọn — cả hai KHÔNG tick sẵn; văn bản do
// server truyền (cùng nguồn với băm bằng chứng). Server từ chối đăng ký thiếu `service_core` (400 CONSENT_REQUIRED).
import type { ConsentDisplay } from "@hm/app";
import { type FormEvent, useState } from "react";
import { useOnline } from "../../components/pwa/pwa-shell.tsx";
import { Button } from "../../components/ui/button.tsx";
import { CheckboxField, TextField } from "../../components/ui/field.tsx";
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

export function RegisterForm({
  m,
  consents,
}: {
  m: Messages<"register_form." | "auth_form.">;
  consents: readonly ConsentDisplay[];
}) {
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [consentError, setConsentError] = useState<string | undefined>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!online) return setError(tm(m, "auth_form.offline"));
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email") ?? "");
    const password = String(f.get("password") ?? "");
    const name = String(f.get("name") ?? "").trim();
    if (!name) return setError(tm(m, "register_form.error.name_required"));
    if (password.length < 10) return setError(tm(m, "register_form.error.password_min"));
    setError(undefined);
    if (f.get("consent_service_core") !== "on")
      return setConsentError(tm(m, "register_form.consent.required"));
    setConsentError(undefined);
    setBusy(true);
    try {
      const r = await post("/api/auth/sign-up/email", {
        name,
        email,
        password,
        consents: { service_core: true, product_analytics: f.get("consent_product_analytics") === "on" },
      });
      if (r.data.code === "CONSENT_REQUIRED") return setConsentError(tm(m, "register_form.consent.required"));
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
      <fieldset className="consent-block">
        <legend>{tm(m, "register_form.consent.legend")}</legend>
        {consents.map((c) => (
          <CheckboxField
            key={c.purpose}
            name={`consent_${c.purpose}`}
            label={c.text}
            required={c.required}
            error={c.required ? consentError : undefined}
          />
        ))}
      </fieldset>
      <Button type="submit" loading={busy}>
        {tm(m, "register_form.submit")}
      </Button>
    </form>
  );
}
