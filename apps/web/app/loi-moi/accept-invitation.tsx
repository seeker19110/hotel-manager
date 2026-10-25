"use client";
// Nhận lời mời nhân viên (SPEC-access S-007, S-008): đọc token từ fragment (không gửi lên máy chủ), đăng nhập/đăng ký nếu cần rồi
// gọi `member.acceptInvitation` và vào tổ chức. Mọi lý do lời mời không dùng được cùng một thông báo (khớp 410 INVITATION_INVALID).
// Gửi lại khi chưa rõ kết quả dùng CÙNG Idempotency-Key (server trả đúng kết quả cũ); lệnh cấp người dùng không có ngữ cảnh tổ chức
// nên không tra `/api/v1/commands/{id}` như `useCommand`.
import { safeUrl } from "@hm/app/http";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { type ConsentOffer, offerConsent } from "../../components/privacy/consent-offer.ts";
import { clearUserData, useOnline } from "../../components/pwa/pwa-shell.tsx";
import { Button } from "../../components/ui/button.tsx";
import { CheckboxField, TextField } from "../../components/ui/field.tsx";
import { ErrorState, LoadingState } from "../../components/ui/state.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";

type Phase = "checking" | "anonymous" | "ready" | "accepting" | "done" | "invalid" | "failed" | "no-token";
type AuthMode = "login" | "register" | "totp";

async function jsonPost(path: string, body: unknown, key?: string) {
  const res = await timedFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  return {
    ok: res.ok,
    status: res.status,
    data: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/** Token trong fragment `#token=…`; chỉ nhận ký tự base64url để chuỗi lạ không đi tiếp. */
function tokenFromHash(hash: string): string | null {
  const v = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return v && /^[A-Za-z0-9_-]{20,200}$/.test(v) ? v : null;
}

export function AcceptInvitation({ m, consent }: { m: Messages<"invitation.">; consent: ConsentOffer }) {
  const online = useOnline();
  const token = useRef<string | null>(null);
  const key = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [who, setWho] = useState<string | null>(null);
  const [mode, setMode] = useState<AuthMode>("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  const checkSession = useCallback(async () => {
    setPhase("checking");
    try {
      const res = await timedFetch("/api/v1/me", { credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) return setPhase("anonymous");
      if (!res.ok) return setPhase("failed");
      const j = (await res.json()) as { user: { email: string } };
      setWho(j.user.email);
      setPhase("ready");
    } catch {
      setPhase("failed");
    }
  }, []);

  useEffect(() => {
    token.current = tokenFromHash(window.location.hash);
    // Xoá token khỏi thanh địa chỉ/lịch sử ngay (chỉ còn trong bộ nhớ của trang này).
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
    if (!token.current) return setPhase("no-token");
    void checkSession();
  }, [checkSession]);

  async function onAuth(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!online) return setError(tm(m, "invitation.error.offline"));
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email") ?? "");
    const password = String(f.get("password") ?? "");
    setBusy(true);
    setError(undefined);
    try {
      if (mode === "totp") {
        const r = await jsonPost("/api/auth/two-factor/verify-totp", { code: String(f.get("code") ?? "") });
        if (!r.ok) return setError(tm(m, "invitation.error.totp"));
        return await checkSession();
      }
      if (mode === "register") {
        const r = await jsonPost("/api/auth/sign-up/email", {
          name: String(f.get("name") ?? "").trim(),
          email,
          password,
        });
        if (!r.ok)
          return setError(
            r.status === 422 || r.status === 400
              ? tm(m, "invitation.error.register_rejected")
              : tm(m, "invitation.error.register_failed"),
          );
      }
      const r = await jsonPost("/api/auth/sign-in/email", { email, password });
      if (!r.ok)
        return setError(
          r.data.code === "ACCOUNT_LOCKED" || r.status === 429
            ? tm(m, "invitation.error.locked")
            : tm(m, "invitation.error.credentials"),
        );
      if (r.data.twoFactorRedirect) return setMode("totp");
      // Tài khoản mới tạo ở đây: ô đồng ý analytics (không tick sẵn) — tick thì ghi sau khi có phiên (kênh `invite`, T-2310).
      if (mode === "register" && f.get("analytics_consent") === "on") await offerConsent(consent, "invite");
      await checkSession();
    } catch {
      setError(tm(m, "invitation.error.no_response"));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      const r = await jsonPost("/api/auth/sign-out", {});
      if (!r.ok && r.status !== 401) return setProblem(tm(m, "invitation.error.sign_out"));
      setWho(null);
      setMode("login");
      setError(undefined);
      setProblem(undefined);
      setPhase("anonymous");
    } catch {
      setProblem(tm(m, "invitation.error.no_response"));
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    if (!token.current || phase === "accepting") return;
    if (!online) return setProblem(tm(m, "invitation.error.offline"));
    key.current ??= crypto.randomUUID();
    setPhase("accepting");
    setProblem(undefined);
    try {
      const r = await jsonPost("/api/v1/member/acceptInvitation", { token: token.current }, key.current);
      if (r.status === 401) return setPhase("anonymous");
      if (r.status === 410) {
        token.current = null;
        key.current = null;
        return setPhase("invalid");
      }
      if (r.status === 409 && r.data.code === "DUPLICATE") {
        key.current = null;
        setProblem(tm(m, "invitation.error.duplicate"));
        return setPhase("ready");
      }
      if (!r.ok) {
        // Lỗi khác (kể cả 5xx): giữ key để bấm lại là gửi lại đúng lệnh cũ.
        setProblem(tm(m, "invitation.error.accept_failed"));
        return setPhase("ready");
      }
      const organizationId = (r.data.data as { organizationId?: string } | undefined)?.organizationId;
      token.current = null;
      key.current = null;
      setPhase("done");
      await clearUserData();
      // Chọn sẵn tổ chức vừa tham gia; không chọn được (mạng/lỗi) thì để người dùng tự chọn ở danh sách tổ chức.
      let home = "/chon-to-chuc";
      if (organizationId) {
        try {
          const sw = await jsonPost(
            "/api/v1/session/switchOrganization",
            { organization_id: organizationId },
            crypto.randomUUID(),
          );
          if (sw.ok) home = "/";
        } catch {
          home = "/chon-to-chuc";
        }
      }
      window.location.assign(safeUrl(home) ?? "/chon-to-chuc");
    } catch {
      setProblem(tm(m, "invitation.error.accept_no_response"));
      setPhase("ready");
    }
  }

  if (phase === "checking") return <LoadingState label={tm(m, "invitation.checking")} rows={2} />;
  if (phase === "no-token")
    return (
      <ErrorState title={tm(m, "invitation.incomplete.title")} text={tm(m, "invitation.incomplete.text")} />
    );
  if (phase === "invalid")
    return (
      <ErrorState
        title={tm(m, "invitation.invalid.title")}
        text={`${tm(m, "invitation.invalid_text")}${tm(m, "invitation.invalid.rules")}`}
        action={
          who ? (
            <Button variant="secondary" onClick={signOut} loading={busy}>
              {tm(m, "invitation.invalid.sign_out")}
            </Button>
          ) : undefined
        }
      />
    );
  if (phase === "failed")
    return (
      <ErrorState
        title={tm(m, "invitation.failed.title")}
        text={tm(m, "invitation.failed.text")}
        action={<Button onClick={() => void checkSession()}>{tm(m, "invitation.failed.retry")}</Button>}
      />
    );
  if (phase === "done") return <LoadingState label={tm(m, "invitation.done")} rows={1} />;

  if (phase === "anonymous") {
    return (
      <>
        <p>
          {mode === "register"
            ? tm(m, "invitation.anon.register_intro")
            : tm(m, "invitation.anon.login_intro")}
        </p>
        <form onSubmit={onAuth} noValidate>
          {mode === "totp" ? (
            <TextField
              label={tm(m, "invitation.field.totp")}
              hint={tm(m, "invitation.field.totp_hint")}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
              error={error}
            />
          ) : (
            <>
              {mode === "register" ? (
                <TextField
                  label={tm(m, "invitation.field.name")}
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={200}
                />
              ) : null}
              <TextField label="Email" name="email" type="email" autoComplete="username" required />
              <TextField
                label={tm(m, "invitation.field.password")}
                name="password"
                type="password"
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                hint={mode === "register" ? tm(m, "invitation.field.password_hint") : undefined}
                required
                error={error}
              />
              {mode === "register" ? (
                <CheckboxField label={consent.label} hint={consent.hint} name="analytics_consent" />
              ) : null}
            </>
          )}
          <Button type="submit" loading={busy}>
            {mode === "totp"
              ? tm(m, "invitation.submit.totp")
              : mode === "register"
                ? tm(m, "invitation.submit.register")
                : tm(m, "invitation.submit.login")}
          </Button>
        </form>
        {mode !== "totp" ? (
          <p>
            <Button
              variant="secondary"
              onClick={() => {
                setError(undefined);
                setMode(mode === "login" ? "register" : "login");
              }}
            >
              {mode === "login"
                ? tm(m, "invitation.switch.to_register")
                : tm(m, "invitation.switch.to_login")}
            </Button>
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <p>
        {tm(m, "invitation.ready.signed_in_before")}
        <strong>{who}</strong>
        {tm(m, "invitation.ready.signed_in_after")}
      </p>
      {problem ? (
        <p className="field__error" role="alert">
          {problem}
        </p>
      ) : null}
      <p>
        <Button onClick={accept} loading={phase === "accepting"}>
          {tm(m, "invitation.ready.accept")}
        </Button>
      </p>
      <p>
        <Button variant="secondary" onClick={signOut} loading={busy}>
          {tm(m, "invitation.ready.other_account")}
        </Button>
      </p>
    </>
  );
}
