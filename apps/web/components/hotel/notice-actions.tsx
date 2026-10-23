"use client";
// Thông báo lưu trú (SPEC-reservation-stay S-028…S-030): xuất file theo mẫu (liên kết ký có hạn ngắn) và đánh dấu đã nộp.
// Hệ thống chỉ xuất file và ghi dấu vết — KHÔNG tự nộp; "đã nộp" do người dùng xác nhận kèm kênh và thời điểm bấm.
import { safeUrl } from "@hm/app/http";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";
import { CommandStatus } from "../command/command-status.tsx";
import { problemText, useCommand } from "../command/use-command.ts";
import { Button } from "../ui/button.tsx";
import { SelectField } from "../ui/field.tsx";

/** Kênh nộp (dựng từ `m` — client không import catalog, D-098). */
function channels(m: Messages<"notice_actions.">) {
  return [
    { value: "in_person", label: tm(m, "notice_actions.channel.in_person") },
    { value: "online", label: tm(m, "notice_actions.channel.online") },
    { value: "other", label: tm(m, "notice_actions.channel.other") },
  ];
}

export function NoticeActions({
  noticeId,
  stayId,
  unitCode,
  submitted,
  m,
}: {
  noticeId: string;
  stayId: string;
  unitCode: string;
  submitted: boolean;
  m: Messages<"notice_actions.">;
}) {
  const router = useRouter();
  const exp = useCommand<{ url: string; expiresIn: number }>("stay/exportResidenceNotice");
  const mark = useCommand("stay/markNoticeSubmitted");
  const [url, setUrl] = useState<string | null>(null);
  const [channel, setChannel] = useState("in_person");

  const afterExport = (r: { url: string } | null) => {
    if (r) {
      setUrl(r.url);
      router.refresh();
    }
  };
  const afterMark = (r: unknown) => {
    if (r !== null) router.refresh();
  };

  return (
    <div className="card__actions">
      <Button
        variant="secondary"
        loading={exp.busy}
        disabled={exp.locked}
        onClick={() => void exp.send({ stay_id: stayId }).then(afterExport)}
      >
        {tm(m, "notice_actions.export", { unit: unitCode })}
      </Button>
      <CommandStatus
        phase={exp.phase}
        commandId={exp.commandId}
        problem={exp.problem}
        general={exp.phase === "error" ? problemText(exp.problem) : null}
        successText={tm(m, "notice_actions.export_success")}
        onResend={() => void exp.resend().then(afterExport)}
        onRecheck={() => void exp.recheck().then(afterExport)}
      />
      {safeUrl(url) ? (
        <a className="btn" href={safeUrl(url) as string} download data-testid="notice-download">
          {tm(m, "notice_actions.download", { unit: unitCode })}
        </a>
      ) : null}
      {submitted ? null : (
        <>
          <SelectField
            name="channel"
            label={tm(m, "notice_actions.channel.label", { unit: unitCode })}
            options={channels(m)}
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            disabled={mark.locked}
          />
          <Button
            loading={mark.busy}
            disabled={mark.locked}
            onClick={() =>
              void mark
                .send({ notice_id: noticeId, submitted_at: new Date().toISOString(), channel })
                .then(afterMark)
            }
          >
            {tm(m, "notice_actions.mark", { unit: unitCode })}
          </Button>
          <CommandStatus
            phase={mark.phase}
            commandId={mark.commandId}
            problem={mark.problem}
            general={mark.phase === "error" ? problemText(mark.problem) : null}
            successText={tm(m, "notice_actions.mark_success")}
            onResend={() => void mark.resend().then(afterMark)}
            onRecheck={() => void mark.recheck().then(afterMark)}
          />
        </>
      )}
    </div>
  );
}
