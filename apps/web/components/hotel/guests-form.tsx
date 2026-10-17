"use client";
// Nhận phòng (`stay/checkIn`) và khách vãng lai (`stay/walkIn`): thông tin từng khách (Q-08: họ tên, SĐT khách chính, loại + số
// giấy tờ; khách nước ngoài thêm quốc tịch + hộ chiếu). Số giấy tờ chỉ đi tới máy chủ — không hiện lại trên danh sách.
// Khách chính của booking có thể để trống họ tên = chính người đặt. Thành công → mở folio của lượt ở.
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { CommandStatus } from "../command/command-status.tsx";
import { problemText, useCommand } from "../command/use-command.ts";
import { Button } from "../ui/button.tsx";
import { SelectField, TextField } from "../ui/field.tsx";

const DOC_TYPES = [
  { value: "cccd", label: "CCCD" },
  { value: "passport", label: "Hộ chiếu" },
  { value: "other", label: "Giấy tờ khác" },
];
const MAX_GUESTS = 50;

export function GuestsForm({
  path,
  fixed,
  rooms,
  defaultDeparture,
  submitLabel,
  successText,
}: {
  path: "stay/checkIn" | "stay/walkIn";
  fixed: Record<string, unknown>;
  /** Walk-in: phòng chọn được. */
  rooms?: { unitId: string; label: string }[];
  defaultDeparture?: string;
  submitLabel: string;
  successText: string;
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
      if (v("doc_number").length < 5) errs[`g${i}_doc_number`] = "Số giấy tờ tối thiểu 5 ký tự";
      if (v("full_name")) g.full_name = v("full_name");
      else if (walkIn || i > 0) errs[`g${i}_full_name`] = "Bắt buộc nhập";
      if (v("phone")) g.phone = v("phone");
      else if (i === 0 && walkIn) errs[`g${i}_phone`] = "Khách chính cần số điện thoại";
      if (v("nationality")) g.nationality = v("nationality").toUpperCase();
      if (g.nationality && !/^[A-Z]{2}$/.test(String(g.nationality)))
        errs[`g${i}_nationality`] = "Mã quốc gia 2 chữ cái, vd VN";
      guests.push(g);
    }
    const body: Record<string, unknown> = { ...fixed, guests };
    if (walkIn) {
      body.unit_id = String(f.get("unit_id") ?? "");
      body.departure_date = String(f.get("departure_date") ?? "");
      if (!body.departure_date) errs.departure_date = "Chọn ngày đi";
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
              label="Phòng"
              options={(rooms ?? []).map((r) => ({ value: r.unitId, label: r.label }))}
            />
            <TextField
              name="departure_date"
              label="Ngày đi"
              type="date"
              defaultValue={defaultDeparture}
              error={errors.departure_date}
            />
          </>
        ) : null}
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: khách theo thứ tự nhập; chỉ thêm/bớt ở cuối
          <fieldset key={i} className="guest-block">
            <legend>{i === 0 ? "Khách chính" : `Khách ${i + 1}`}</legend>
            <TextField
              name={`g${i}_full_name`}
              label={
                i === 0 && !walkIn
                  ? `Họ tên khách ${i + 1} (bỏ trống nếu là người đặt)`
                  : `Họ tên khách ${i + 1}`
              }
              maxLength={200}
              error={errors[`g${i}_full_name`] ?? serverError(i, "full_name")}
            />
            <TextField
              name={`g${i}_phone`}
              label={`Số điện thoại khách ${i + 1}`}
              type="tel"
              inputMode="tel"
              maxLength={20}
              error={errors[`g${i}_phone`] ?? serverError(i, "phone")}
            />
            <SelectField name={`g${i}_doc_type`} label={`Loại giấy tờ khách ${i + 1}`} options={DOC_TYPES} />
            <TextField
              name={`g${i}_doc_number`}
              label={`Số giấy tờ khách ${i + 1}`}
              autoComplete="off"
              maxLength={40}
              error={errors[`g${i}_doc_number`] ?? serverError(i, "doc_number") ?? serverError(i, "doc_type")}
            />
            <TextField
              name={`g${i}_nationality`}
              label={`Quốc tịch khách ${i + 1} (mã 2 chữ, mặc định VN)`}
              maxLength={2}
              error={errors[`g${i}_nationality`] ?? serverError(i, "nationality")}
            />
          </fieldset>
        ))}
        <div className="card__actions">
          <Button variant="secondary" onClick={() => setCount((n) => Math.min(MAX_GUESTS, n + 1))}>
            Thêm khách
          </Button>
          {count > 1 ? (
            <Button variant="secondary" onClick={() => setCount((n) => Math.max(1, n - 1))}>
              Bớt khách cuối
            </Button>
          ) : null}
        </div>
      </fieldset>
      <Button type="submit" loading={cmd.busy} disabled={cmd.locked}>
        {submitLabel}
      </Button>
      <CommandStatus
        phase={cmd.phase}
        problem={cmd.problem}
        general={general}
        successText={successText}
        onResend={() => void cmd.resend().then(go)}
        onRecheck={() => void cmd.recheck().then(go)}
      />
    </form>
  );
}
