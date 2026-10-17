"use client";
// Đăng ký TOTP: (1) nhập mật khẩu → Better Auth sinh khoá + mã dự phòng; (2) thêm khoá vào ứng dụng xác thực rồi nhập mã 6 số để
// xác nhận. Vai trò chủ/quản lý/kế toán/lễ tân bắt buộc bước này trước khi thao tác (Q-06). Mã dự phòng chỉ hiện MỘT lần.
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { TextField } from "../../components/ui/field.tsx";
import { ErrorState, LoadingState } from "../../components/ui/state.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";

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

export function MfaEnroll() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [secret, setSecret] = useState("");
  const [codes, setCodes] = useState<string[]>([]);

  async function check() {
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
  }
  useEffect(() => {
    void check();
  }, []);

  async function onPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    setBusy(true);
    setError(undefined);
    try {
      const r = await post("/api/auth/two-factor/enable", { password });
      if (!r.ok) return setError("Mật khẩu không đúng.");
      const uri = String(r.data.totpURI ?? "");
      setSecret(new URL(uri).searchParams.get("secret") ?? "");
      setCodes(Array.isArray(r.data.backupCodes) ? (r.data.backupCodes as string[]) : []);
      setPhase("verify");
    } catch {
      setError("Chưa nhận được phản hồi. Kiểm tra mạng rồi thử lại.");
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
      if (!r.ok) return setError("Mã xác thực không đúng hoặc đã hết hạn.");
      setSecret("");
      setCodes([]);
      window.location.assign("/chon-to-chuc");
    } catch {
      setError("Chưa nhận được phản hồi. Kiểm tra mạng rồi thử lại.");
    } finally {
      setBusy(false);
    }
  }

  if (phase === "checking") return <LoadingState label="Đang kiểm tra tài khoản…" rows={2} />;
  if (phase === "failed")
    return (
      <ErrorState
        title="Chưa tải được trạng thái tài khoản"
        text="Kiểm tra mạng rồi thử lại."
        action={<Button onClick={() => void check()}>Thử lại</Button>}
      />
    );
  if (phase === "anonymous")
    return (
      <ErrorState
        title="Cần đăng nhập"
        text="Đăng nhập rồi quay lại trang này để bật xác thực hai lớp."
        action={
          <a className="btn" href="/dang-nhap">
            Đăng nhập
          </a>
        }
      />
    );
  if (phase === "enabled")
    return (
      <p role="status">
        Xác thực hai lớp đã được bật cho tài khoản này. <a href="/chon-to-chuc">Chọn tổ chức để làm việc</a>.
      </p>
    );
  if (phase === "password")
    return (
      <form onSubmit={onPassword} noValidate>
        <p>
          Nhập mật khẩu để bắt đầu. Bạn sẽ cần một ứng dụng xác thực trên điện thoại (Google Authenticator,
          Microsoft Authenticator…).
        </p>
        <TextField
          label="Mật khẩu hiện tại"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          error={error}
        />
        <Button type="submit" loading={busy}>
          Tiếp tục
        </Button>
      </form>
    );
  return (
    <form onSubmit={onVerify} noValidate>
      <p>
        Thêm khoá sau vào ứng dụng xác thực (chọn &quot;nhập khoá thiết lập&quot;, loại theo thời gian), rồi
        nhập mã 6 số ứng dụng hiển thị.
      </p>
      <p>
        Khoá thiết lập: <code data-testid="totp-secret">{secret}</code>
      </p>
      {codes.length > 0 ? (
        <>
          <p>Mã dự phòng (chỉ hiện một lần — cất ở nơi an toàn, mỗi mã dùng một lần khi mất điện thoại):</p>
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
        label="Mã xác thực 6 số"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        required
        error={error}
      />
      <Button type="submit" loading={busy}>
        Xác nhận và bật
      </Button>
    </form>
  );
}
