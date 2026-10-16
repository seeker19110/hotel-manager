"use client";
// Thông báo lưu trú (SPEC-reservation-stay S-028…S-030): xuất file theo mẫu (liên kết ký có hạn ngắn) và đánh dấu đã nộp.
// Hệ thống chỉ xuất file và ghi dấu vết — KHÔNG tự nộp; "đã nộp" do người dùng xác nhận kèm kênh và thời điểm bấm.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CommandStatus } from "../command/command-status.tsx";
import { problemText, useCommand } from "../command/use-command.ts";
import { Button } from "../ui/button.tsx";
import { SelectField } from "../ui/field.tsx";

const CHANNELS = [
  { value: "in_person", label: "Nộp trực tiếp" },
  { value: "online", label: "Nộp trực tuyến" },
  { value: "other", label: "Kênh khác" },
];

export function NoticeActions({
  noticeId,
  stayId,
  unitCode,
  submitted,
}: {
  noticeId: string;
  stayId: string;
  unitCode: string;
  submitted: boolean;
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
        Xuất file phòng {unitCode}
      </Button>
      <CommandStatus
        phase={exp.phase}
        problem={exp.problem}
        general={exp.phase === "error" ? problemText(exp.problem) : null}
        successText="Đã xuất file — tải trong vài phút."
        onResend={() => void exp.resend().then(afterExport)}
        onRecheck={() => void exp.recheck().then(afterExport)}
      />
      {url ? (
        <a className="btn" href={url} download data-testid="notice-download">
          Tải file thông báo phòng {unitCode}
        </a>
      ) : null}
      {submitted ? null : (
        <>
          <SelectField
            name="channel"
            label={`Kênh đã nộp (phòng ${unitCode})`}
            options={CHANNELS}
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
            Đánh dấu đã nộp phòng {unitCode}
          </Button>
          <CommandStatus
            phase={mark.phase}
            problem={mark.problem}
            general={mark.phase === "error" ? problemText(mark.problem) : null}
            successText="Đã ghi nhận đã nộp."
            onResend={() => void mark.resend().then(afterMark)}
            onRecheck={() => void mark.recheck().then(afterMark)}
          />
        </>
      )}
    </div>
  );
}
