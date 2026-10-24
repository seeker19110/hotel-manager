"use client";
// Tạo tổ chức (SPEC-access S-001 `org.create`): người dùng đã đăng nhập tạo tổ chức và thành chủ sở hữu; xong thì chọn sẵn tổ chức
// đó và sang màn tạo cơ sở. Lệnh cấp người dùng (chưa có ngữ cảnh tổ chức) nên gửi lại khi chưa rõ kết quả dùng CÙNG Idempotency-Key
// — server trả đúng tổ chức đã tạo, không tạo hai lần.
import { safeUrl } from "@hm/app/http";
import { type FormEvent, useRef, useState } from "react";
import { clearUserData, useOnline } from "../../components/pwa/pwa-shell.tsx";
import { Button } from "../../components/ui/button.tsx";
import { TextField } from "../../components/ui/field.tsx";
import { timedFetch } from "../../lib/fetch-timeout.ts";
import type { Messages } from "../../lib/i18n.ts";
import { useMessages } from "../../lib/i18n-context.tsx";
import { tm } from "../../lib/i18n-format.ts";

async function post(path: string, body: unknown, key: string) {
  const res = await timedFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  return {
    ok: res.ok,
    status: res.status,
    data: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

export function CreateOrganization({ m }: { m: Messages<"org_create."> }) {
  const common = useMessages();
  const online = useOnline();
  const key = useRef<string | null>(null);
  const lastName = useRef("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (!online) return setError(tm(common, "common.command.offline"));
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    if (!name) return setError(tm(m, "org_create.error.name_required"));
    if (name.length > 200) return setError(tm(m, "org_create.error.name_too_long"));
    // Đổi tên sau một lần chưa rõ kết quả = thao tác mới (key mới); cùng tên = gửi lại đúng thao tác cũ.
    if (name !== lastName.current) key.current = null;
    lastName.current = name;
    key.current ??= crypto.randomUUID();
    setBusy(true);
    setError(undefined);
    try {
      const r = await post("/api/v1/org/create", { name }, key.current);
      if (r.status === 401) return window.location.assign("/dang-nhap");
      if (r.status === 422 || r.status === 400) {
        key.current = null;
        return setError(tm(m, "org_create.error.name_invalid"));
      }
      if (!r.ok) return setError(tm(m, "org_create.error.failed"));
      const orgId = (r.data.data as { organizationId?: string } | undefined)?.organizationId;
      key.current = null;
      await clearUserData();
      let next = "/chon-to-chuc";
      if (orgId) {
        try {
          const sw = await post(
            "/api/v1/session/switchOrganization",
            { organization_id: orgId },
            crypto.randomUUID(),
          );
          if (sw.ok) next = "/co-so";
        } catch {
          next = "/chon-to-chuc";
        }
      }
      window.location.assign(safeUrl(next) ?? "/chon-to-chuc");
    } catch {
      setError(tm(m, "org_create.error.no_response"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate data-testid="create-org-form">
      <TextField
        label={tm(m, "org_create.field.name")}
        hint={tm(m, "org_create.field.name_hint")}
        name="name"
        required
        maxLength={200}
        error={error}
      />
      <Button type="submit" loading={busy}>
        {tm(m, "org_create.submit")}
      </Button>
    </form>
  );
}
