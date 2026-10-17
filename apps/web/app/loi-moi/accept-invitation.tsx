"use client";
// Nhận lời mời nhân viên (SPEC-access S-007, S-008): đọc token từ fragment (không gửi lên máy chủ), đăng nhập/đăng ký nếu cần rồi
// gọi `member.acceptInvitation` và vào tổ chức. Mọi lý do lời mời không dùng được cùng một thông báo (khớp 410 INVITATION_INVALID).
// Gửi lại khi chưa rõ kết quả dùng CÙNG Idempotency-Key (server trả đúng kết quả cũ); lệnh cấp người dùng không có ngữ cảnh tổ chức
// nên không tra `/api/v1/commands/{id}` như `useCommand`.
import { safeUrl } from "@hm/app/http";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { clearUserData, useOnline } from "../../components/pwa/pwa-shell.tsx";
import { Button } from "../../components/ui/button.tsx";
import { TextField } from "../../components/ui/field.tsx";
import { ErrorState, LoadingState } from "../../components/ui/state.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";

type Phase = "checking" | "anonymous" | "ready" | "accepting" | "done" | "invalid" | "failed" | "no-token";
type AuthMode = "login" | "register" | "totp";

const INVALID_TEXT = "Lời mời không còn hiệu lực. Hãy nhờ quản trị gửi lại.";

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

export function AcceptInvitation() {
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
    if (!online) return setError("Không có kết nối mạng. Thao tác chưa được gửi.");
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email") ?? "");
    const password = String(f.get("password") ?? "");
    setBusy(true);
    setError(undefined);
    try {
      if (mode === "totp") {
        const r = await jsonPost("/api/auth/two-factor/verify-totp", { code: String(f.get("code") ?? "") });
        if (!r.ok) return setError("Mã xác thực không đúng hoặc đã hết hạn.");
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
              ? "Không tạo được tài khoản: email đã có tài khoản hoặc mật khẩu chưa đủ 10 ký tự."
              : "Không tạo được tài khoản. Vui lòng thử lại.",
          );
      }
      const r = await jsonPost("/api/auth/sign-in/email", { email, password });
      if (!r.ok)
        return setError(
          r.data.code === "ACCOUNT_LOCKED" || r.status === 429
            ? "Tài khoản tạm khoá do đăng nhập sai nhiều lần. Thử lại sau 15 phút."
            : "Email hoặc mật khẩu không đúng.",
        );
      if (r.data.twoFactorRedirect) return setMode("totp");
      await checkSession();
    } catch {
      setError("Chưa nhận được phản hồi. Kiểm tra mạng rồi thử lại.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      const r = await jsonPost("/api/auth/sign-out", {});
      if (!r.ok && r.status !== 401) return setProblem("Chưa đăng xuất được. Thử lại.");
      setWho(null);
      setMode("login");
      setError(undefined);
      setProblem(undefined);
      setPhase("anonymous");
    } catch {
      setProblem("Chưa nhận được phản hồi. Kiểm tra mạng rồi thử lại.");
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    if (!token.current || phase === "accepting") return;
    if (!online) return setProblem("Không có kết nối mạng. Thao tác chưa được gửi.");
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
        setProblem("Tài khoản này đã là thành viên của tổ chức. Chọn tổ chức để vào làm việc.");
        return setPhase("ready");
      }
      if (!r.ok) {
        // Lỗi khác (kể cả 5xx): giữ key để bấm lại là gửi lại đúng lệnh cũ.
        setProblem("Chưa nhận lời mời được. Bấm lại để thử lần nữa.");
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
      setProblem("Chưa nhận được phản hồi. Bấm lại để thử lần nữa — hệ thống không tạo hai lần.");
      setPhase("ready");
    }
  }

  if (phase === "checking") return <LoadingState label="Đang kiểm tra phiên đăng nhập…" rows={2} />;
  if (phase === "no-token")
    return (
      <ErrorState
        title="Liên kết không đầy đủ"
        text="Mở lại đúng liên kết trong email lời mời, hoặc nhờ quản trị gửi lại."
      />
    );
  if (phase === "invalid")
    return (
      <ErrorState
        title="Lời mời không còn hiệu lực"
        text={`${INVALID_TEXT} Lời mời chỉ dùng một lần, hết hạn sau 7 ngày và chỉ dành cho đúng email được mời.`}
        action={
          who ? (
            <Button variant="secondary" onClick={signOut} loading={busy}>
              Đăng xuất để dùng tài khoản khác
            </Button>
          ) : undefined
        }
      />
    );
  if (phase === "failed")
    return (
      <ErrorState
        title="Chưa kiểm tra được phiên đăng nhập"
        text="Kiểm tra mạng rồi thử lại."
        action={<Button onClick={() => void checkSession()}>Thử lại</Button>}
      />
    );
  if (phase === "done") return <LoadingState label="Đã tham gia — đang vào tổ chức…" rows={1} />;

  if (phase === "anonymous") {
    return (
      <>
        <p>
          {mode === "register"
            ? "Tạo tài khoản bằng ĐÚNG địa chỉ email nhận lời mời."
            : "Đăng nhập bằng ĐÚNG địa chỉ email nhận lời mời để chấp nhận."}
        </p>
        <form onSubmit={onAuth} noValidate>
          {mode === "totp" ? (
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
          ) : (
            <>
              {mode === "register" ? (
                <TextField label="Họ và tên" name="name" autoComplete="name" required maxLength={200} />
              ) : null}
              <TextField label="Email" name="email" type="email" autoComplete="username" required />
              <TextField
                label="Mật khẩu"
                name="password"
                type="password"
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                hint={mode === "register" ? "Tối thiểu 10 ký tự." : undefined}
                required
                error={error}
              />
            </>
          )}
          <Button type="submit" loading={busy}>
            {mode === "totp" ? "Xác nhận" : mode === "register" ? "Tạo tài khoản và tiếp tục" : "Đăng nhập"}
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
              {mode === "login" ? "Tôi chưa có tài khoản" : "Tôi đã có tài khoản"}
            </Button>
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <p>
        Bạn đang đăng nhập bằng <strong>{who}</strong>. Lời mời chỉ chấp nhận được khi đúng email này.
      </p>
      {problem ? (
        <p className="field__error" role="alert">
          {problem}
        </p>
      ) : null}
      <p>
        <Button onClick={accept} loading={phase === "accepting"}>
          Chấp nhận lời mời
        </Button>
      </p>
      <p>
        <Button variant="secondary" onClick={signOut} loading={busy}>
          Dùng tài khoản khác
        </Button>
      </p>
    </>
  );
}
