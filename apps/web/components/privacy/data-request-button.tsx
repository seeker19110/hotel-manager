"use client";
// Nút gửi yêu cầu truy cập (bản sao dữ liệu) hoặc hạn chế xử lý ở trang Quyền riêng tư (T-2311, D-123). Một bấm = một yêu cầu;
// bấm lại khi đang có yêu cầu mở cùng loại ⇒ server trả đúng yêu cầu đó (idempotent), không tạo thêm. Xong thì làm mới trang để
// trạng thái đọc lại từ CSDL. Quyền thật ở server (phiên + RLS theo người dùng); CSRF bằng kiểm Origin của proxy.
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";
import { useOnline } from "../pwa/pwa-shell.tsx";
import { Button } from "../ui/button.tsx";
import { postDataRequest } from "./post-data-request.ts";

export function DataRequestButton({
  type,
  label,
  m,
}: {
  type: "access" | "restrict";
  label: string;
  m: Messages<"data_requests.">;
}) {
  const router = useRouter();
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | undefined>();

  async function onClick() {
    if (busy) return;
    if (!online) return setError(tm(m, "data_requests.error.offline"));
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      const r = await postDataRequest(type);
      if (r.status === 401) return setError(tm(m, "data_requests.error.session"));
      if (r.status === 429) return setError(tm(m, "data_requests.error.too_many"));
      if (!r.ok) return setError(tm(m, "data_requests.error.failed"));
      setNotice(
        r.result === "existing"
          ? tm(m, "data_requests.notice.existing")
          : type === "access"
            ? tm(m, "data_requests.notice.access_created")
            : tm(m, "data_requests.notice.restrict_created"),
      );
      router.refresh();
    } catch {
      setError(tm(m, "data_requests.error.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid={`dsar-${type}`}>
      <Button variant="secondary" loading={busy} onClick={onClick}>
        {label}
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
