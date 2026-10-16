"use client";
// Form gửi một command (dùng `useCommand`): ô nhập có nhãn, lỗi theo trường gắn đúng ô (aria-describedby + role=alert),
// lỗi chung role=alert, trạng thái "đang kiểm tra kết quả" role=status, nút "Gửi lại" khi chưa rõ server đã nhận (S-011).
// Thành công ⇒ báo role=status rồi làm mới dữ liệu trang (Server Component) — không tự tạo kết quả phía client.
// `confirm` (PLAN đợt 4 T-310, UX-STATE-008): thao tác không hoàn tác (ký, phát hành, thu tiền, trả phòng, huỷ…) mở hộp
// thoại modal `<dialog>` nêu hậu quả; chỉ gửi khi bấm "Đồng ý" — Esc/"Quay lại" không gửi gì, focus trả về nút gửi.
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useRef, useState } from "react";
import { Button } from "../ui/button.tsx";
import { SelectField, TextField } from "../ui/field.tsx";
import { CommandStatus } from "./command-status.tsx";
import { problemText, useCommand } from "./use-command.ts";

export interface FieldSpec {
  name: string;
  label: string;
  type?: "text" | "money" | "decimal" | "date" | "integer" | "select";
  /** Lựa chọn của ô `select` (giá trị gửi lên là `value`). */
  options?: { value: string; label: string }[];
  required?: boolean;
  maxLength?: number;
  defaultValue?: string | number;
  hint?: string;
  /** Đặt giá trị vào đường dẫn lồng (vd `readings.electric`). */
  path?: string;
}

function setPath(o: Record<string, unknown>, path: string, v: unknown) {
  const parts = path.split(".");
  let cur = o;
  for (const p of parts.slice(0, -1)) {
    cur[p] ??= {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts.at(-1) as string] = v;
}

/** Tiền nhập kiểu VN: chỉ chữ số, cho phép dấu chấm phân cách nghìn đúng nhóm 3 (3.580.000). */
function parseMoney(s: string): number | null {
  const t = s.trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replaceAll(".", ""));
  return null;
}

export function CommandForm({
  path,
  fields = [],
  fixed = {},
  submitLabel,
  successText,
  variant = "primary",
  testId,
  className,
  confirm,
}: {
  path: string;
  fields?: FieldSpec[];
  fixed?: Record<string, unknown>;
  submitLabel: string;
  successText: string;
  variant?: "primary" | "secondary";
  testId?: string;
  /** Lớp CSS thêm cho nút gửi (vd `btn--large` cho màn buồng phòng trên điện thoại). */
  className?: string;
  /** Thao tác không hoàn tác: câu nêu hậu quả hiện trong hộp xác nhận trước khi gửi. */
  confirm?: string;
}) {
  const router = useRouter();
  const cmd = useCommand(path);
  const [local, setLocal] = useState<Record<string, string>>({});
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pending = useRef<Record<string, unknown> | null>(null);
  const titleId = useId();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: Record<string, unknown> = structuredClone(fixed);
    const errs: Record<string, string> = {};
    for (const f of fields) {
      const raw = String(form.get(f.name) ?? "").trim();
      if (raw === "") {
        if (f.required) errs[f.name] = "Bắt buộc nhập";
        continue;
      }
      let v: unknown = raw;
      if (f.type === "money") {
        v = parseMoney(raw);
        if (v === null) errs[f.name] = "Nhập số nguyên đồng, vd 3580000 hoặc 3.580.000";
      } else if (f.type === "decimal") {
        v = /^\d+(\.\d{1,3})?$/.test(raw) ? Number(raw) : null;
        if (v === null) errs[f.name] = "Số ≥ 0, tối đa 3 chữ số thập phân (dấu chấm)";
      } else if (f.type === "integer") {
        v = /^\d+$/.test(raw) ? Number(raw) : null;
        if (v === null) errs[f.name] = "Nhập số nguyên";
      }
      setPath(body, f.path ?? f.name, v);
    }
    setLocal(errs);
    if (Object.keys(errs).length > 0) return;
    if (confirm && dialogRef.current) {
      pending.current = body;
      dialogRef.current.showModal();
      return;
    }
    await sendBody(body);
  }

  async function sendBody(body: Record<string, unknown>) {
    const r = await cmd.send(body);
    if (r !== null) router.refresh();
  }

  async function onConfirm() {
    const body = pending.current;
    pending.current = null;
    dialogRef.current?.close();
    if (body) await sendBody(body);
  }

  async function onRecheck() {
    const r = await cmd.recheck();
    if (r !== null) router.refresh();
  }

  async function onResend() {
    const r = await cmd.resend();
    if (r !== null) router.refresh();
  }

  const fieldError = (f: FieldSpec) => {
    if (local[f.name]) return local[f.name];
    const hit = cmd.problem?.errors?.find((x) => x.field === (f.path ?? f.name) || x.field === f.name);
    return hit ? (problemText(cmd.problem) ?? undefined) : undefined;
  };
  const general =
    cmd.phase === "error" && !fields.some((f) => fieldError(f)) ? problemText(cmd.problem) : null;

  return (
    <form onSubmit={onSubmit} noValidate className="command-form" data-testid={testId}>
      {/* Khoá ô nhập khi thao tác trước chưa rõ kết quả: không sửa payload dưới key cũ (review lát 4 🟠2). */}
      <fieldset className="command-form__fields" disabled={cmd.locked}>
        {fields.map((f) =>
          f.type === "select" ? (
            <SelectField
              key={f.name}
              name={f.name}
              label={f.label}
              hint={f.hint}
              error={fieldError(f)}
              options={f.options ?? []}
              defaultValue={f.defaultValue}
              required={f.required}
            />
          ) : (
            <TextField
              key={f.name}
              name={f.name}
              label={f.label}
              hint={f.hint}
              error={fieldError(f)}
              type={f.type === "date" ? "date" : "text"}
              inputMode={
                f.type === "money" || f.type === "integer"
                  ? "numeric"
                  : f.type === "decimal"
                    ? "decimal"
                    : undefined
              }
              defaultValue={f.defaultValue}
              required={f.required}
              maxLength={f.maxLength}
            />
          ),
        )}
      </fieldset>
      <Button
        type="submit"
        variant={variant}
        loading={cmd.busy}
        disabled={cmd.locked}
        {...(className ? { className } : {})}
      >
        {submitLabel}
      </Button>
      {confirm ? (
        <dialog
          ref={dialogRef}
          className="confirm-dialog"
          aria-labelledby={titleId}
          onClose={() => {
            pending.current = null;
          }}
        >
          <h2 id={titleId} className="confirm-dialog__title">
            {submitLabel}?
          </h2>
          <p>{confirm}</p>
          <div className="confirm-dialog__actions">
            <Button variant="secondary" onClick={() => dialogRef.current?.close()}>
              Quay lại
            </Button>
            <Button onClick={onConfirm}>Đồng ý</Button>
          </div>
        </dialog>
      ) : null}
      <CommandStatus
        phase={cmd.phase}
        problem={cmd.problem}
        general={general}
        successText={successText}
        onResend={onResend}
        onRecheck={onRecheck}
      />
    </form>
  );
}
