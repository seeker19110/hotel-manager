"use client";
// Khối trạng thái dùng chung của mọi form gửi command (SPEC-pwa S-010…S-012): đang kiểm tra kết quả (role=status), chưa rõ
// server đã nhận (role=alert + "Gửi lại" cùng key), server còn đang xử lý ("Kiểm tra lại"), lỗi chung (role=alert), đổi tổ chức
// ở tab khác ("Tải lại trang"), thành công (role=status — chỉ sau phản hồi máy chủ).
import { Button } from "../ui/button.tsx";
import { CONTEXT_CHANGED_CODE } from "./org-context.ts";
import { type CommandPhase, type ProblemLike, problemText } from "./use-command.ts";

export function CommandStatus({
  phase,
  problem,
  general,
  successText,
  onResend,
  onRecheck,
}: {
  phase: CommandPhase;
  problem: ProblemLike | null;
  /** Lỗi chung cần hiện (đã loại lỗi gắn theo ô); null = không có. */
  general: string | null;
  successText: string;
  onResend: () => void;
  onRecheck: () => void;
}) {
  return (
    <>
      {phase === "checking" ? (
        <p className="command-form__status" role="status">
          Đang kiểm tra kết quả…
        </p>
      ) : null}
      {phase === "unknown" ? (
        <div className="banner banner--warn" role="alert">
          <p>
            Chưa rõ máy chủ đã nhận thao tác này chưa. Bấm "Gửi lại" để gửi đúng thao tác này một lần nữa
            (không bị ghi hai lần).
          </p>
          {problem ? <p>{problemText(problem)}</p> : null}
          <Button variant="secondary" onClick={onResend}>
            Gửi lại
          </Button>
        </div>
      ) : null}
      {phase === "processing" ? (
        <div className="banner banner--info" role="status">
          <p>Máy chủ vẫn đang xử lý thao tác này. Chờ một lát rồi kiểm tra lại — không gửi thao tác mới.</p>
          <Button variant="secondary" onClick={onRecheck}>
            Kiểm tra lại
          </Button>
        </div>
      ) : null}
      {general ? (
        <p className="field__error" role="alert">
          {general}
        </p>
      ) : null}
      {phase === "error" && problem?.code === CONTEXT_CHANGED_CODE ? (
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Tải lại trang
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
