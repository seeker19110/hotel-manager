"use client";
// Xoá tổ chức ở trang Tổ chức (T-2312, IND-SAAS-006, UX-CONTENT-005; D-125). Không dark pattern: không ô tick bật sẵn, không hộp
// hỏi lại liên tục, không đếm ngược/khan hiếm giả, nút ghi đúng hành động, huỷ là MỘT nút. Số bước: yêu cầu = nhập mật khẩu + bấm
// (2) — bằng tạo tổ chức (nhập tên + bấm); huỷ = bấm (1). Xác thực lại TRƯỚC khi gửi: nhập lại mật khẩu; tài khoản không có mật khẩu
// đăng nhập lại bằng mã OTP (phiên mới ≤ 5 phút). Server kiểm lại mọi điều kiện (phiên, owner, mật khẩu, trạng thái tổ chức).
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { TenantLoginForm } from "../../app/dang-nhap/nguoi-thue/tenant-login-form.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";
import { orgContextHeaders } from "../command/org-context.ts";
import { useOnline } from "../pwa/pwa-shell.tsx";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/field.tsx";

export type OrgDeletionMessages = Messages<"org_deletion." | "tenant_login_form." | "auth_form.">;

async function call(method: "POST" | "DELETE", body?: unknown) {
  const res = await timedFetch("/api/v1/organization/deletion", {
    method,
    headers: { "content-type": "application/json", ...orgContextHeaders() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as {
    code?: string;
    reason?: string;
    data?: { status?: string };
  } | null;
  return {
    ok: res.ok,
    status: res.status,
    code: data?.code ?? null,
    reason: data?.reason ?? null,
    organizationStatus: data?.data?.status ?? null,
  };
}

export function RequestOrgDeletion({ hasPassword, m }: { hasPassword: boolean; m: OrgDeletionMessages }) {
  const router = useRouter();
  const online = useOnline();
  const [reauthed, setReauthed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (!online) return setError(tm(m, "org_deletion.error.offline"));
    let password: string | undefined;
    if (hasPassword) {
      password = String(new FormData(e.currentTarget).get("password") ?? "");
      if (!password) return setError(tm(m, "org_deletion.error.password_required"));
    }
    setBusy(true);
    setError(undefined);
    try {
      const r = await call("POST", password === undefined ? {} : { password });
      if (r.status === 401 && r.code === "REAUTH_REQUIRED")
        return setError(
          r.reason === "invalid_password"
            ? tm(m, "org_deletion.error.password_invalid")
            : tm(m, "org_deletion.error.reauth"),
        );
      if (r.status === 429) return setError(tm(m, "org_deletion.error.too_many"));
      if (r.status === 403) return setError(tm(m, "org_deletion.error.forbidden"));
      if (!r.ok) return setError(tm(m, "org_deletion.error.failed"));
      router.refresh();
    } catch {
      setError(tm(m, "org_deletion.error.failed"));
    } finally {
      setBusy(false);
    }
  }

  const otpStep = !hasPassword && !reauthed;
  return (
    <div data-testid="org-delete-request">
      {otpStep ? (
        <>
          <p>{tm(m, "org_deletion.otp_intro")}</p>
          <TenantLoginForm onSuccess={() => setReauthed(true)} m={m} />
        </>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          {hasPassword ? (
            <TextField
              label={tm(m, "org_deletion.password_label")}
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          ) : (
            <p role="status">{tm(m, "org_deletion.otp_done")}</p>
          )}
          <Button type="submit" loading={busy}>
            {tm(m, "org_deletion.submit")}
          </Button>
        </form>
      )}
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function CancelOrgDeletion({ m }: { m: OrgDeletionMessages }) {
  const router = useRouter();
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState("");

  async function onClick() {
    if (busy) return;
    setNotice("");
    if (!online) return setError(tm(m, "org_deletion.error.offline"));
    setBusy(true);
    setError(undefined);
    try {
      const r = await call("DELETE");
      if (r.status === 403) return setError(tm(m, "org_deletion.error.forbidden"));
      if (!r.ok) return setError(tm(m, "org_deletion.error.failed"));
      if (r.organizationStatus === "pending_deletion")
        return setError(tm(m, "org_deletion.cancel_unavailable"));
      if (r.organizationStatus !== "active") return setError(tm(m, "org_deletion.error.failed"));
      setNotice(tm(m, "org_deletion.cancelled"));
      router.refresh();
    } catch {
      setError(tm(m, "org_deletion.error.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="org-delete-cancel">
      <Button loading={busy} onClick={onClick}>
        {tm(m, "org_deletion.cancel")}
      </Button>
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
      <p role="status" aria-live="polite">
        {notice}
      </p>
    </div>
  );
}

/** Tải bản xuất đã xong: `exports.download` trả URL ký ngắn hạn rồi chuyển trình duyệt tới đó. */
export function DownloadOrgExport({ exportId, m }: { exportId: string; m: OrgDeletionMessages }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function onClick() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await timedFetch("/api/v1/exports/download", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          ...orgContextHeaders(),
        },
        body: JSON.stringify({ export_id: exportId }),
        credentials: "same-origin",
      });
      const body = (await res.json().catch(() => ({}))) as { data?: { url?: string } };
      if (!res.ok || !body.data?.url) return setError(tm(m, "org_deletion.error.failed"));
      window.location.assign(body.data.url);
    } catch {
      setError(tm(m, "org_deletion.error.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" loading={busy} onClick={onClick}>
        {tm(m, "org_deletion.export.download")}
      </Button>
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
