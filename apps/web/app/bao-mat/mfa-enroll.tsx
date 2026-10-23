"use client";
// Đăng ký TOTP: (1) nhập mật khẩu → Better Auth sinh khoá + mã dự phòng; (2) thêm khoá vào ứng dụng xác thực rồi nhập mã 6 số để
// xác nhận. Vai trò chủ/quản lý/kế toán/lễ tân bắt buộc bước này trước khi thao tác (Q-06). Mã dự phòng chỉ hiện MỘT lần.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { TextField } from "../../components/ui/field.tsx";
import { ErrorState, LoadingState } from "../../components/ui/state.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";

type Phase = "checking" | "anonymous" | "enabled" | "password" | "verify" | "failed";

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

export function MfaEnroll({ m }: { m: Messages<"mfa_enroll." | "auth_form."> }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [secret, setSecret] = useState("");
  const [codes, setCodes] = useState<string[]>([]);

  const check = useCallback(async () => {
    setPhase("checking");
    try {
      const res = await timedFetch("/api/v1/me", { credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) return setPhase("anonymous");
      if (!res.ok) return setPhase("failed");
      const j = (await res.json()) as { user: { twoFactorEnabled: boolean } };
      setPhase(j.user.twoFactorEnabled ? "enabled" : "password");
    } catch {
      setPhase("failed");
    }
  }, []);
  useEffect(() => {
    void check();
  }, [check]);

  async function onPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    setBusy(true);
    setError(undefined);
    try {
      const r = await post("/api/auth/two-factor/enable", { password });
      if (!r.ok) return setError(tm(m, "mfa_enroll.error.password"));
      const uri = String(r.data.totpURI ?? "");
      setSecret(new URL(uri).searchParams.get("secret") ?? "");
      setCodes(Array.isArray(r.data.backupCodes) ? (r.data.backupCodes as string[]) : []);
      setPhase("verify");
    } catch {
      setError(tm(m, "auth_form.no_response"));
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    setBusy(true);
    setError(undefined);
    try {
      const r = await post("/api/auth/two-factor/verify-totp", { code });
      if (!r.ok) return setError(tm(m, "auth_form.totp.invalid"));
      setSecret("");
      setCodes([]);
      window.location.assign("/chon-to-chuc");
    } catch {
      setError(tm(m, "auth_form.no_response"));
    } finally {
      setBusy(false);
    }
  }

  if (phase === "checking") return <LoadingState label={tm(m, "mfa_enroll.checking")} rows={2} />;
  if (phase === "failed")
    return (
      <ErrorState
        title={tm(m, "mfa_enroll.failed.title")}
        text={tm(m, "mfa_enroll.failed.text")}
        action={<Button onClick={() => void check()}>{tm(m, "mfa_enroll.retry")}</Button>}
      />
    );
  if (phase === "anonymous")
    return (
      <ErrorState
        title={tm(m, "mfa_enroll.anonymous.title")}
        text={tm(m, "mfa_enroll.anonymous.text")}
        action={
          <a className="btn" href="/dang-nhap">
            {tm(m, "mfa_enroll.anonymous.action")}
          </a>
        }
      />
    );
  if (phase === "enabled")
    return (
      <>
        <p role="status">{tm(m, "mfa_enroll.enabled.status")}</p>
        {/* Liên kết dạng nút: vùng chạm ≥ 44 px (UX-A11Y-001). */}
        <a className="btn" href="/chon-to-chuc">
          {tm(m, "mfa_enroll.enabled.action")}
        </a>
      </>
    );
  if (phase === "password")
    return (
      <form onSubmit={onPassword} noValidate>
        <p>{tm(m, "mfa_enroll.password.intro")}</p>
        <TextField
          label={tm(m, "mfa_enroll.password.label")}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          error={error}
        />
        <Button type="submit" loading={busy}>
          {tm(m, "mfa_enroll.password.submit")}
        </Button>
      </form>
    );
  return (
    <form onSubmit={onVerify} noValidate>
      <p>{tm(m, "mfa_enroll.verify.intro")}</p>
      <p>
        {tm(m, "mfa_enroll.verify.secret")}
        <code data-testid="totp-secret">{secret}</code>
      </p>
      {codes.length > 0 ? (
        <>
          <p>{tm(m, "mfa_enroll.verify.backup")}</p>
          <ul data-testid="backup-codes">
            {codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <TextField
        label={tm(m, "auth_form.totp.label")}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        required
        error={error}
      />
      <Button type="submit" loading={busy}>
        {tm(m, "mfa_enroll.verify.submit")}
      </Button>
    </form>
  );
}
