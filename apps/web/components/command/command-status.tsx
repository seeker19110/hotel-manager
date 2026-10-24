"use client";
// Khối trạng thái dùng chung của mọi form gửi command (SPEC-pwa S-010…S-012): đang kiểm tra kết quả (role=status), chưa rõ
// server đã nhận (role=alert + "Gửi lại" cùng key), server còn đang xử lý ("Kiểm tra lại"), lỗi chung (role=alert), đổi tổ chức
// ở tab khác ("Tải lại trang"), thành công (role=status — chỉ sau phản hồi máy chủ). Quá 30 s mà lệnh vẫn "đang xử lý" ⇒
// RESULT_UNKNOWN (S-012): câu cố định + mã thao tác đầy đủ, KHÔNG có nút gửi lại.
import { useMessages } from "../../lib/i18n-context.tsx";
import { tm } from "../../lib/i18n-format.ts";
import { firstNonEmpty } from "../../lib/text.ts";
import { Button } from "../ui/button.tsx";
import { CONTEXT_CHANGED_CODE } from "./org-context.ts";
import { type CommandPhase, type ProblemLike, problemText } from "./use-command.ts";

/** Mã thao tác rút gọn để hiện khi đang kiểm tra (8 ký tự đầu của UUID). */
export const shortCommandId = (id: string): string => id.slice(0, 8);

/** S-012: không biết kết quả — người dùng đọc mã này cho quản lý; chỉ cho "Kiểm tra lại" (không gửi lại lệnh). */
export function ResultUnknown({ commandId, onRecheck }: { commandId: string; onRecheck: () => void }) {
  const m = useMessages();
  return (
    <div className="banner banner--warn" role="alert" data-testid="result-unknown">
      <p>{tm(m, "common.command.result_unknown")}</p>
      <p>
        {tm(m, "common.command_status.command_id")} <code data-testid="result-unknown-id">{commandId}</code>
      </p>
      <Button variant="secondary" onClick={onRecheck}>
        {tm(m, "common.command_status.recheck")}
      </Button>
    </div>
  );
}

export function CommandStatus({
  phase,
  problem,
  general,
  successText,
  onResend,
  onRecheck,
  commandId = null,
}: {
  phase: CommandPhase;
  problem: ProblemLike | null;
  /** Lỗi chung cần hiện (đã loại lỗi gắn theo ô); null = không có. */
  general: string | null;
  successText: string;
  onResend: () => void;
  onRecheck: () => void;
  /** Mã thao tác đang gửi (từ `useCommand`); có thì hiện rút gọn khi đang kiểm tra. */
  commandId?: string | null;
}) {
  const m = useMessages();
  return (
    <>
      {phase === "checking" ? (
        <p className="command-form__status" role="status">
          {tm(m, "common.command_status.checking")}
          {commandId ? (
            <span className="command-form__id">
              {" "}
              {tm(m, "common.command_status.short_id", { id: shortCommandId(commandId) })}
            </span>
          ) : null}
        </p>
      ) : null}
      {phase === "unknown" ? (
        <div className="banner banner--warn" role="alert">
          <p>{tm(m, "common.command_status.unknown")}</p>
          {problem && (problem.status ?? 0) >= 500 ? (
            problem.correlation_id && /^[\w-]{1,64}$/.test(problem.correlation_id) ? (
              <p>{tm(m, "common.command_status.ref", { code: problem.correlation_id })}</p>
            ) : null
          ) : problem ? (
            <p>{problemText(m, problem)}</p>
          ) : null}
          <Button variant="secondary" onClick={onResend}>
            {tm(m, "common.command_status.resend")}
          </Button>
        </div>
      ) : null}
      {phase === "processing" ? (
        <ResultUnknown
          commandId={firstNonEmpty(problem?.command_id, commandId) ?? ""}
          onRecheck={onRecheck}
        />
      ) : null}
      {general ? (
        <p className="field__error" role="alert">
          {general}
        </p>
      ) : null}
      {phase === "error" && problem?.code === CONTEXT_CHANGED_CODE ? (
        <Button variant="secondary" onClick={() => window.location.reload()}>
          {tm(m, "common.command_status.reload")}
        </Button>
      ) : null}
      {phase === "done" ? (
        <p className="command-form__status command-form__status--ok" role="status">
          {successText}
        </p>
      ) : null}
    </>
  );
}
