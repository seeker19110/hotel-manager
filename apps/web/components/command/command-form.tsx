"use client";
// Form gửi một command (dùng `useCommand`): ô nhập có nhãn, lỗi theo trường gắn đúng ô (aria-describedby + role=alert),
// lỗi chung role=alert, trạng thái "đang kiểm tra kết quả" role=status, nút "Gửi lại" khi chưa rõ server đã nhận (S-011).
// Thành công ⇒ báo role=status rồi làm mới dữ liệu trang (Server Component) — không tự tạo kết quả phía client.
// `confirm` (PLAN đợt 4 T-310, UX-STATE-008): thao tác không hoàn tác (ký, phát hành, thu tiền, trả phòng, huỷ…) mở hộp
// thoại modal `<dialog>` nêu hậu quả; chỉ gửi khi bấm nút xác nhận — Esc/"Quay lại" không gửi gì, focus trả về nút gửi.
// `confirmLabel` (đợt 5 T-411): nút xác nhận ghi ĐÚNG động từ + đối tượng ("Ký hợp đồng HD-000001", "Thu {amount}"); chỗ
// `{tên_ô}` được thay bằng giá trị người dùng vừa nhập (ô tiền định dạng "930.000 đ") nên hộp nêu đúng số sắp ghi sổ.
// Quy tắc đọc ô nhập dùng chung với schema server (`@hm/app/form-rules`, FE-FORM-001); sau khi đọc ô, thân lệnh được kiểm
// bằng CHÍNH schema `input` của lệnh trong registry (`@hm/app/command-inputs`) và lỗi gắn đúng ô theo đường dẫn trường;
// server vẫn validate lại tất cả.
import { checkCommandInput } from "@hm/app/command-inputs";
import { fillConfirmLabel, parseDecimalInput, parseIntegerInput, parseMoneyInput } from "@hm/app/form-rules";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useRef, useState } from "react";
import { day, vnd } from "../../lib/format.ts";
import { Button } from "../ui/button.tsx";
import { SelectField, TextField } from "../ui/field.tsx";
import { CommandStatus } from "./command-status.tsx";
import { INVALID_INPUT_TEXT, problemText, useCommand } from "./use-command.ts";

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
  /** Gói giá trị đã nhập thành mảng một phần tử (vd chọn một cơ sở cho `property_ids`); để trống = bỏ trường. */
  array?: boolean;
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

type ConfirmProps =
  | { confirm?: undefined; confirmLabel?: undefined }
  | {
      /** Thao tác không hoàn tác: câu nêu hậu quả hiện trong hộp xác nhận trước khi gửi. */
      confirm: string;
      /** Nhãn nút xác nhận = động từ + đối tượng; `{tên_ô}` được thay bằng giá trị đã nhập. */
      confirmLabel: string;
    };

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
  confirmLabel,
}: ConfirmProps & {
  path: string;
  fields?: FieldSpec[];
  fixed?: Record<string, unknown>;
  submitLabel: string;
  successText: string;
  variant?: "primary" | "secondary";
  testId?: string;
  /** Lớp CSS thêm cho nút gửi (vd `btn--large` cho màn buồng phòng trên điện thoại). */
  className?: string;
}) {
  const router = useRouter();
  const cmd = useCommand(path);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [localGeneral, setLocalGeneral] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pending = useRef<Record<string, unknown> | null>(null);
  const [asking, setAsking] = useState("");
  const titleId = useId();
  const descId = useId();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: Record<string, unknown> = structuredClone(fixed);
    const errs: Record<string, string> = {};
    const shown: Record<string, string> = {};
    for (const f of fields) {
      const raw = String(form.get(f.name) ?? "").trim();
      if (raw === "") {
        if (f.required) errs[f.name] = "Bắt buộc nhập";
        continue;
      }
      let v: unknown = raw;
      shown[f.name] = raw;
      if (f.type === "money") {
        const n = parseMoneyInput(raw);
        v = n;
        if (n === null) errs[f.name] = "Nhập số nguyên đồng, vd 3580000 hoặc 3.580.000";
        else shown[f.name] = vnd(n);
      } else if (f.type === "decimal") {
        v = parseDecimalInput(raw);
        if (v === null) errs[f.name] = "Số ≥ 0, tối đa 3 chữ số thập phân (dấu chấm)";
      } else if (f.type === "date") {
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) shown[f.name] = day(raw);
      } else if (f.type === "integer") {
        v = parseIntegerInput(raw);
        if (v === null) errs[f.name] = "Nhập số nguyên";
      }
      setPath(body, f.path ?? f.name, f.array ? [v] : v);
    }
    // Một nguồn schema với server: lỗi theo ô (đường dẫn trùng `path ?? name`) gắn vào ô; lỗi còn lại (ô ẩn/cấp thân) là lỗi chung.
    let general: string | null = null;
    if (Object.keys(errs).length === 0) {
      for (const issue of checkCommandInput(path, body) ?? []) {
        const f = fields.find((x) => (x.path ?? x.name) === issue.field);
        if (f) errs[f.name] ??= issue.message;
        else general ??= INVALID_INPUT_TEXT;
      }
    }
    setLocal(errs);
    setLocalGeneral(general);
    if (Object.keys(errs).length > 0 || general) return;
    if (confirm) {
      // Đóng khi lỗi: chưa có hộp thoại thì không gửi (không bao giờ bỏ qua bước xác nhận).
      if (!dialogRef.current) return;
      pending.current = body;
      setAsking(fillConfirmLabel(confirmLabel, shown));
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
    localGeneral ??
    (cmd.phase === "error" && !fields.some((f) => fieldError(f)) ? problemText(cmd.problem) : null);

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
          aria-describedby={descId}
          onClose={() => {
            // Sự kiện `close` đến SAU một task: đóng rồi mở lại thật nhanh (Quay lại → Enter) thì sự kiện của lần đóng cũ tới khi
            // hộp đã mở lại — chỉ xoá payload khi hộp thật sự đang đóng, không xoá payload của lần mở mới.
            if (!dialogRef.current?.open) pending.current = null;
          }}
        >
          <h2 id={titleId} className="confirm-dialog__title">
            {asking}?
          </h2>
          <p id={descId}>{confirm}</p>
          <div className="confirm-dialog__actions">
            <Button variant="secondary" onClick={() => dialogRef.current?.close()}>
              Quay lại
            </Button>
            <Button onClick={onConfirm}>{asking}</Button>
          </div>
        </dialog>
      ) : null}
      <CommandStatus
        phase={cmd.phase}
        commandId={cmd.commandId}
        problem={cmd.problem}
        general={general}
        successText={successText}
        onResend={onResend}
        onRecheck={onRecheck}
      />
    </form>
  );
}
