"use client";
// Nhận lời mời nhân viên (SPEC-access S-007, S-008): đọc token từ fragment (không gửi lên máy chủ), đăng nhập/đăng ký nếu cần rồi
// gọi `member.acceptInvitation` và vào tổ chức. Mọi lý do lời mời không dùng được cùng một thông báo (khớp 410 INVITATION_INVALID).
// Gửi lại khi chưa rõ kết quả dùng CÙNG Idempotency-Key (server trả đúng kết quả cũ); lệnh cấp người dùng không có ngữ cảnh tổ chức
// nên không tra `/api/v1/commands/{id}` như `useCommand`.
// Đồng ý (T-2310, D-119): đăng ký mới ở đây gửi kèm đồng ý theo mục đích (kênh `invitation`); tài khoản CHƯA đồng ý `service_core`
// (vd. tạo trước khi có tính năng) thấy ô bắt buộc ở bước chấp nhận và gửi `consent_service_core` — server kiểm và ghi cùng transaction.
import type { ConsentDisplay } from "@hm/app";
import { safeUrl } from "@hm/app/http";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
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

/** Đọc trạng thái đồng ý; lỗi ⇒ coi như không thiếu (server vẫn kiểm và trả CONSENT_REQUIRED nếu thiếu). */
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

export function AcceptInvitation({
  m,
  consents,
}: {
  m: Messages<"invitation.">;
  consents: readonly ConsentDisplay[];
}) {
  const online = useOnline();
  const token = useRef<string | null>(null);
  const key = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [who, setWho] = useState<string | null>(null);
  const [mode, setMode] = useState<AuthMode>("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  /** Tài khoản đang đăng nhập chưa đồng ý mục đích bắt buộc ⇒ hiện ô đồng ý ở bước chấp nhận. */
  const [needsConsent, setNeedsConsent] = useState(false);
  const [coreTicked, setCoreTicked] = useState(false);
  const [consentError, setConsentError] = useState<string | undefined>();
  const core = consents.find((c) => c.required);

  const checkSession = useCallback(async () => {
    setPhase("checking");
    try {
      const res = await timedFetch("/api/v1/me", { credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) return setPhase("anonymous");
      if (!res.ok) return setPhase("failed");
      const j = (await res.json()) as { user: { email: string } };
      setWho(j.user.email);
      setNeedsConsent(await missingRequiredConsent());
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
        if (f.get("consent_service_core") !== "on")
          return setConsentError(tm(m, "invitation.consent.required"));
        setConsentError(undefined);
        const r = await jsonPost("/api/auth/sign-up/email", {
          name: String(f.get("name") ?? "").trim(),
          email,
          password,
          consents: { service_core: true, product_analytics: f.get("consent_product_analytics") === "on" },
          consent_channel: "invitation",
        });
        if (r.data.code === "CONSENT_REQUIRED") return setConsentError(tm(m, "invitation.consent.required"));
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
    if (needsConsent && !coreTicked) return setConsentError(tm(m, "invitation.consent.required"));
    setConsentError(undefined);
    key.current ??= crypto.randomUUID();
    setPhase("accepting");
    setProblem(undefined);
    try {
      const r = await jsonPost(
        "/api/v1/member/acceptInvitation",
        { token: token.current, ...(needsConsent ? { consent_service_core: true } : {}) },
        key.current,
      );
      if (r.status === 401) return setPhase("anonymous");
      if (r.status === 410) {
        token.current = null;
        key.current = null;
        return setPhase("invalid");
      }
      if (r.status === 422 && r.data.code === "CONSENT_REQUIRED") {
        // Trạng thái đồng ý đọc trước đó đã cũ/không đọc được: hiện ô bắt buộc; thân request sẽ khác ⇒ khoá idempotency mới.
        key.current = null;
        setNeedsConsent(true);
        setConsentError(tm(m, "invitation.consent.required"));
        return setPhase("ready");
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
                <fieldset className="consent-block">
                  <legend>{tm(m, "invitation.consent.legend")}</legend>
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
      {needsConsent && core ? (
        <fieldset className="consent-block">
          <legend>{tm(m, "invitation.consent.legend")}</legend>
          <CheckboxField
            name="consent_service_core"
            label={core.text}
            required
            checked={coreTicked}
            onChange={(e) => setCoreTicked(e.currentTarget.checked)}
            error={consentError}
          />
        </fieldset>
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
