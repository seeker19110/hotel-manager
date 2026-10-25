"use client";
// Quyền của chủ thể dữ liệu trên trang Bảo mật (T-2311, D-120; STD-PRIV-004, CMP-RIGHTS-007): tải dữ liệu của tôi, hạn chế xử lý, xoá
// tài khoản. Xuất/xoá cần xác thực lại ≤ 5 phút: server trả 401 REAUTH_REQUIRED ⇒ mở hộp đăng nhập lại toàn cục rồi gửi lại MỘT lần.
// Không dark pattern (UX-CONTENT-005): nêu rõ cái bị xoá và cái được giữ kèm lý do; xoá = gõ lại email + một nút (như đăng ký: điền + một
// nút); không đếm ngược, không câu bêu xấu; owner duy nhất thì giải thích cách chuyển quyền thay vì ẩn nút.
import { useCallback, useEffect, useState } from "react";
import { requestReauth } from "../../components/command/reauth.ts";
import { clearUserData } from "../../components/pwa/pwa-shell.tsx";
import { Button } from "../../components/ui/button.tsx";
import { TextField } from "../../components/ui/field.tsx";
import { ErrorState, LoadingState } from "../../components/ui/state.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";

type Phase = "checking" | "anonymous" | "failed" | "ready" | "deleted";
interface Status {
  restricted: boolean;
  sole_owner_orgs: number;
}

const ENDPOINT = "/api/v1/privacy/dsar";

async function post(body: unknown): Promise<Response> {
  return timedFetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
}

/** POST; gặp 401 REAUTH_REQUIRED ⇒ đăng nhập lại (hộp toàn cục) rồi gửi lại đúng một lần. */
async function postWithReauth(body: unknown): Promise<Response> {
  const res = await post(body);
  if (res.status !== 401) return res;
  const code = (
    (await res
      .clone()
      .json()
      .catch(() => ({}))) as { code?: string }
  ).code;
  if (code !== "REAUTH_REQUIRED") return res;
  if (!(await requestReauth())) return res;
  return post(body);
}

export function AccountRights({ m }: { m: Messages<"account_rights."> }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [status, setStatus] = useState<Status>({ restricted: false, sole_owner_orgs: 0 });
  const [busy, setBusy] = useState<"access" | "restrict" | "delete" | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState("");
  const [confirmError, setConfirmError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setPhase("checking");
    try {
      const res = await timedFetch(ENDPOINT, { credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) return setPhase("anonymous");
      if (!res.ok) return setPhase("failed");
      setStatus((await res.json()) as Status);
      setPhase("ready");
    } catch {
      setPhase("failed");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function download() {
    setBusy("access");
    setNotice(null);
    try {
      const res = await postWithReauth({ action: "access" });
      if (!res.ok) return setNotice({ ok: false, text: tm(m, "account_rights.access.error") });
      const blob = await res.blob();
      const name =
        /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "du-lieu.json";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice({ ok: true, text: tm(m, "account_rights.access.done") });
    } catch {
      setNotice({ ok: false, text: tm(m, "account_rights.access.error") });
    } finally {
      setBusy(null);
    }
  }

  async function toggleRestriction() {
    setBusy("restrict");
    setNotice(null);
    try {
      const res = await post({ action: "restrict", active: !status.restricted });
      if (!res.ok) return setNotice({ ok: false, text: tm(m, "account_rights.restrict.error") });
      const r = (await res.json()) as { restricted: boolean };
      setStatus((s) => ({ ...s, restricted: r.restricted }));
      setNotice({ ok: true, text: tm(m, "account_rights.restrict.saved") });
    } catch {
      setNotice({ ok: false, text: tm(m, "account_rights.restrict.error") });
    } finally {
      setBusy(null);
    }
  }

  async function deleteAccount() {
    setConfirmError(undefined);
    setNotice(null);
    if (confirm.trim().length === 0) return setConfirmError(tm(m, "account_rights.delete.confirm_required"));
    setBusy("delete");
    try {
      const res = await postWithReauth({ action: "delete", confirm_email: confirm });
      if (res.status === 202) {
        setPhase("deleted");
        // Xoá dữ liệu người dùng trên máy (cache/IndexedDB/storage) như khi đăng xuất; giữ service worker (app shell).
        await clearUserData();
        return;
      }
      const code = ((await res.json().catch(() => ({}))) as { code?: string }).code;
      if (code === "CONFIRMATION_MISMATCH") return setConfirmError(tm(m, "account_rights.delete.mismatch"));
      if (code === "SOLE_OWNER") {
        await load();
        return;
      }
      setNotice({ ok: false, text: tm(m, "account_rights.delete.error") });
    } catch {
      setNotice({ ok: false, text: tm(m, "account_rights.delete.error") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="rights-heading" data-testid="account-rights">
      <h2 id="rights-heading">{tm(m, "account_rights.heading")}</h2>
      {phase === "checking" ? <LoadingState label={tm(m, "account_rights.checking")} rows={2} /> : null}
      {phase === "anonymous" ? <p>{tm(m, "account_rights.anonymous")}</p> : null}
      {phase === "failed" ? (
        <ErrorState
          title={tm(m, "account_rights.failed.title")}
          text={tm(m, "account_rights.failed.text")}
          action={<Button onClick={() => void load()}>{tm(m, "account_rights.retry")}</Button>}
        />
      ) : null}
      {phase === "deleted" ? (
        <div role="status" data-testid="account-deleted">
          <p>{tm(m, "account_rights.delete.done")}</p>
          <p>
            <a href="/dang-nhap">{tm(m, "account_rights.delete.to_login")}</a>
          </p>
        </div>
      ) : null}
      {phase === "ready" ? (
        <>
          <h3>{tm(m, "account_rights.access.heading")}</h3>
          <p>{tm(m, "account_rights.access.intro")}</p>
          <Button variant="secondary" loading={busy === "access"} onClick={() => void download()}>
            {tm(m, "account_rights.access.button")}
          </Button>

          <h3>{tm(m, "account_rights.restrict.heading")}</h3>
          <p>{tm(m, "account_rights.restrict.intro")}</p>
          <p>
            <strong data-testid="restriction-status">
              {status.restricted ? tm(m, "account_rights.restrict.on") : tm(m, "account_rights.restrict.off")}
            </strong>
          </p>
          <Button variant="secondary" loading={busy === "restrict"} onClick={() => void toggleRestriction()}>
            {status.restricted
              ? tm(m, "account_rights.restrict.turn_off")
              : tm(m, "account_rights.restrict.turn_on")}
          </Button>

          <h3>{tm(m, "account_rights.delete.heading")}</h3>
          <p>{tm(m, "account_rights.delete.erased")}</p>
          <p>{tm(m, "account_rights.delete.retained")}</p>
          {status.sole_owner_orgs > 0 ? (
            <p data-testid="delete-blocked" role="note">
              {tm(m, "account_rights.delete.sole_owner")}
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void deleteAccount();
              }}
            >
              <TextField
                label={tm(m, "account_rights.delete.confirm_label")}
                hint={tm(m, "account_rights.delete.confirm_hint")}
                type="email"
                autoComplete="off"
                value={confirm}
                error={confirmError}
                onChange={(e) => setConfirm(e.target.value)}
              />
              <Button type="submit" loading={busy === "delete"}>
                {tm(m, "account_rights.delete.button")}
              </Button>
            </form>
          )}
          {notice ? (
            <p role={notice.ok ? "status" : "alert"} className={notice.ok ? undefined : "field__error"}>
              {notice.text}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
