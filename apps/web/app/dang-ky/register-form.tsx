"use client";
// Đăng ký tài khoản (Better Auth email/mật khẩu, tối thiểu 10 ký tự) rồi đăng nhập luôn → /chon-to-chuc, nơi tạo tổ chức đầu tiên
// (SPEC-access S-001). Email đã có tài khoản và lỗi chung dùng cùng một thông báo (không lộ email có tồn tại).
// Ô đồng ý analytics KHÔNG tick sẵn, không bắt buộc (T-2310, D-122); tick thì ghi đồng ý sau khi đăng nhập (kênh `signup`).
import { type FormEvent, useState } from "react";
import { type ConsentOffer, offerConsent } from "../../components/privacy/consent-offer.ts";
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
  consent,
}: {
  m: Messages<"register_form." | "auth_form.">;
  consent: ConsentOffer;
}) {
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
    const analytics = f.get("analytics_consent") === "on";
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
      // Đồng ý chỉ ghi khi người dùng TỰ tick; gửi hỏng ⇒ vẫn đi tiếp (mặc định = không đồng ý) nhưng trang sau hiện thông báo
      // không chặn để chọn lại ở trang Quyền riêng tư.
      const saved = analytics ? await offerConsent(consent, "signup") : true;
      // Đường dẫn nội bộ viết thẳng (rào FE-SEC-002); tham số = CONSENT_UNSAVED_PARAM (test đối chiếu).
      if (saved) window.location.assign("/chon-to-chuc");
      else window.location.assign("/chon-to-chuc?dong_y_chua_luu=1");
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
      <CheckboxField label={consent.label} hint={consent.hint} name="analytics_consent" />
      <Button type="submit" loading={busy}>
        {tm(m, "register_form.submit")}
      </Button>
    </form>
  );
}
