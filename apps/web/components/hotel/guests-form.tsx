"use client";
// Nhận phòng (`stay/checkIn`) và khách vãng lai (`stay/walkIn`): thông tin từng khách (Q-08: họ tên, SĐT khách chính, loại + số
// giấy tờ; khách nước ngoài thêm quốc tịch + hộ chiếu). Số giấy tờ chỉ đi tới máy chủ — không hiện lại trên danh sách.
// Khách chính của booking có thể để trống họ tên = chính người đặt. Thành công → mở folio của lượt ở.
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";
import { CommandStatus } from "../command/command-status.tsx";
import { problemText, useCommand } from "../command/use-command.ts";
import { Button } from "../ui/button.tsx";
import { SelectField, TextField } from "../ui/field.tsx";

/** Loại giấy tờ (dựng từ `m` — client không import catalog, D-098). */
function docTypes(m: Messages<"guests_form.">) {
  return [
    { value: "cccd", label: tm(m, "guests_form.doc.cccd") },
    { value: "passport", label: tm(m, "guests_form.doc.passport") },
    { value: "other", label: tm(m, "guests_form.doc.other") },
  ];
}
const MAX_GUESTS = 50;

export function GuestsForm({
  path,
  fixed,
  rooms,
  defaultDeparture,
  submitLabel,
  successText,
  m,
}: {
  path: "stay/checkIn" | "stay/walkIn";
  fixed: Record<string, unknown>;
  /** Walk-in: phòng chọn được. */
  rooms?: { unitId: string; label: string }[];
  defaultDeparture?: string;
  submitLabel: string;
  successText: string;
  m: Messages<"guests_form.">;
}) {
  const router = useRouter();
  const cmd = useCommand<{ stayId: string }>(path);
  const [count, setCount] = useState(1);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const walkIn = path === "stay/walkIn";

  const go = (r: { stayId: string } | null) => {
    if (r) router.push(`/luu-tru/${r.stayId}`);
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const errs: Record<string, string> = {};
    const guests: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      const v = (k: string) => String(f.get(`g${i}_${k}`) ?? "").trim();
      const g: Record<string, unknown> = { doc_type: v("doc_type"), doc_number: v("doc_number") };
      if (v("doc_number").length < 5) errs[`g${i}_doc_number`] = tm(m, "guests_form.error.doc_number_min");
      if (v("full_name")) g.full_name = v("full_name");
      else if (walkIn || i > 0) errs[`g${i}_full_name`] = tm(m, "guests_form.error.required");
      if (v("phone")) g.phone = v("phone");
      else if (i === 0 && walkIn) errs[`g${i}_phone`] = tm(m, "guests_form.error.phone_required");
      if (v("nationality")) g.nationality = v("nationality").toUpperCase();
      if (g.nationality && !/^[A-Z]{2}$/.test(String(g.nationality)))
        errs[`g${i}_nationality`] = tm(m, "guests_form.error.nationality");
      guests.push(g);
    }
    const body: Record<string, unknown> = { ...fixed, guests };
    if (walkIn) {
      body.unit_id = String(f.get("unit_id") ?? "");
      body.departure_date = String(f.get("departure_date") ?? "");
      if (!body.departure_date) errs.departure_date = tm(m, "guests_form.error.departure");
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    go(await cmd.send(body));
  }

  // Lỗi theo trường của máy chủ (guests.0.doc_number …) gắn đúng ô.
  const serverError = (i: number, k: string) => {
    const hit = cmd.problem?.errors?.find((x) => x.field === `guests.${i}.${k}`);
    return hit ? (problemText(cmd.problem) ?? undefined) : undefined;
  };
  const anyFieldError = cmd.problem?.errors?.some((x) => x.field.startsWith("guests."));
  const general = cmd.phase === "error" && !anyFieldError ? problemText(cmd.problem) : null;

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="command-form"
      data-testid={walkIn ? "walkin-form" : "checkin-form"}
    >
      <fieldset className="command-form__fields" disabled={cmd.locked}>
        {walkIn ? (
          <>
            <SelectField
              name="unit_id"
              label={tm(m, "guests_form.field.unit")}
              options={(rooms ?? []).map((r) => ({ value: r.unitId, label: r.label }))}
            />
            <TextField
              name="departure_date"
              label={tm(m, "guests_form.field.departure")}
              type="date"
              defaultValue={defaultDeparture}
              error={errors.departure_date}
            />
          </>
        ) : null}
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: khách theo thứ tự nhập; chỉ thêm/bớt ở cuối
          <fieldset key={i} className="guest-block">
            <legend>
              {i === 0 ? tm(m, "guests_form.guest.primary") : tm(m, "guests_form.guest.n", { n: i + 1 })}
            </legend>
            <TextField
              name={`g${i}_full_name`}
              label={
                i === 0 && !walkIn
                  ? tm(m, "guests_form.field.full_name_booker", { n: i + 1 })
                  : tm(m, "guests_form.field.full_name", { n: i + 1 })
              }
              maxLength={200}
              error={errors[`g${i}_full_name`] ?? serverError(i, "full_name")}
            />
            <TextField
              name={`g${i}_phone`}
              label={tm(m, "guests_form.field.phone", { n: i + 1 })}
              type="tel"
              inputMode="tel"
              maxLength={20}
              error={errors[`g${i}_phone`] ?? serverError(i, "phone")}
            />
            <SelectField
              name={`g${i}_doc_type`}
              label={tm(m, "guests_form.field.doc_type", { n: i + 1 })}
              options={docTypes(m)}
            />
            <TextField
              name={`g${i}_doc_number`}
              label={tm(m, "guests_form.field.doc_number", { n: i + 1 })}
              autoComplete="off"
              maxLength={40}
              error={errors[`g${i}_doc_number`] ?? serverError(i, "doc_number") ?? serverError(i, "doc_type")}
            />
            <TextField
              name={`g${i}_nationality`}
              label={tm(m, "guests_form.field.nationality", { n: i + 1 })}
              maxLength={2}
              error={errors[`g${i}_nationality`] ?? serverError(i, "nationality")}
            />
          </fieldset>
        ))}
        <div className="card__actions">
          <Button variant="secondary" onClick={() => setCount((n) => Math.min(MAX_GUESTS, n + 1))}>
            {tm(m, "guests_form.add")}
          </Button>
          {count > 1 ? (
            <Button variant="secondary" onClick={() => setCount((n) => Math.max(1, n - 1))}>
              {tm(m, "guests_form.remove")}
            </Button>
          ) : null}
        </div>
      </fieldset>
      <Button type="submit" loading={cmd.busy} disabled={cmd.locked}>
        {submitLabel}
      </Button>
      <CommandStatus
        phase={cmd.phase}
        commandId={cmd.commandId}
        problem={cmd.problem}
        general={general}
        successText={successText}
        onResend={() => void cmd.resend().then(go)}
        onRecheck={() => void cmd.recheck().then(go)}
      />
    </form>
  );
}
