"use client";
// Tải bản xuất nhật ký đã sẵn sàng (T-2313): `exports.download` trả URL ký ngắn hạn (≤ 5 phút) cho chính người yêu cầu — hiện liên
// kết tải sau khi lệnh thành công (cùng cách màn thông báo lưu trú). Link hết hạn ⇒ bấm lại để lấy link mới.
import { safeUrl } from "@hm/app/http";
import { useState } from "react";
import { CommandStatus } from "../../components/command/command-status.tsx";
import { problemText, useCommand } from "../../components/command/use-command.ts";
import { Button } from "../../components/ui/button.tsx";
import type { Messages } from "../../lib/i18n.ts";
import { useMessages } from "../../lib/i18n-context.tsx";
import { tm } from "../../lib/i18n-format.ts";

export function ExportDownload({ exportId, m }: { exportId: string; m: Messages<"audit_log.download."> }) {
  const cmd = useCommand<{ url: string; expiresIn: number }>("exports/download");
  const common = useMessages();
  const [url, setUrl] = useState<string | null>(null);
  const after = (r: { url: string } | null) => {
    if (r) setUrl(r.url);
  };
  return (
    <span className="card__actions">
      <Button
        variant="secondary"
        loading={cmd.busy}
        disabled={cmd.locked}
        onClick={() => void cmd.send({ export_id: exportId }).then(after)}
      >
        {tm(m, "audit_log.download.prepare")}
      </Button>
      <CommandStatus
        phase={cmd.phase}
        commandId={cmd.commandId}
        problem={cmd.problem}
        general={cmd.phase === "error" ? problemText(common, cmd.problem) : null}
        successText={tm(m, "audit_log.download.ready")}
        onResend={() => void cmd.resend().then(after)}
        onRecheck={() => void cmd.recheck().then(after)}
      />
      {safeUrl(url) ? (
        <a className="btn" href={safeUrl(url) as string} download data-testid="audit-export-download">
          {tm(m, "audit_log.download.link")}
        </a>
      ) : null}
    </span>
  );
}
