"use client";
// Form gửi một command (dùng `useCommand`): ô nhập có nhãn, lỗi theo trường gắn đúng ô (aria-describedby + role=alert),
// lỗi chung role=alert, trạng thái "đang kiểm tra kết quả" role=status, nút "Gửi lại" khi chưa rõ server đã nhận (S-011).
// Thành công ⇒ báo role=status rồi làm mới dữ liệu trang (Server Component) — không tự tạo kết quả phía client.
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/field.tsx";
import { problemText, useCommand } from "./use-command.ts";

export interface FieldSpec {
  name: string;
  label: string;
  type?: "text" | "money" | "decimal" | "date" | "integer";
  required?: boolean;
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
}: {
  path: string;
  fields?: FieldSpec[];
  fixed?: Record<string, unknown>;
  submitLabel: string;
  successText: string;
  variant?: "primary" | "secondary";
  testId?: string;
}) {
  const router = useRouter();
  const cmd = useCommand(path);
  const [local, setLocal] = useState<Record<string, string>>({});

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
    const r = await cmd.send(body);
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
      {fields.map((f) => (
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
        />
      ))}
      <Button type="submit" variant={variant} loading={cmd.busy}>
        {submitLabel}
      </Button>
      {cmd.phase === "checking" ? (
        <p className="command-form__status" role="status">
          Đang kiểm tra kết quả…
        </p>
      ) : null}
      {cmd.phase === "unknown" ? (
        <div className="banner banner--warn" role="alert">
          <p>Máy chủ chưa nhận được thao tác. Bấm "Gửi lại" để gửi đúng thao tác này một lần nữa.</p>
          <Button variant="secondary" onClick={onResend}>
            Gửi lại
          </Button>
        </div>
      ) : null}
      {general ? (
        <p className="field__error" role="alert">
          {general}
        </p>
      ) : null}
      {cmd.phase === "done" ? (
        <p className="command-form__status command-form__status--ok" role="status">
          {successText}
        </p>
      ) : null}
    </form>
  );
}
