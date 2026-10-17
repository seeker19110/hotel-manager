"use client";
// Báo sự cố có ảnh (SPEC-housekeeping-maintenance S-012…S-014): ảnh tải lên trước (chụp trực tiếp từ camera trên điện thoại,
// tối đa 5 ảnh, 10 MB/ảnh, JPEG/PNG/WebP), hiện "Đang kiểm tra ảnh…" trong lúc máy chủ quét; chỉ ảnh `ready` mới đính kèm.
// Rồi gửi `maintenance/createWorkOrder` với file_ids — cùng cơ chế chống gửi đúp/mất mạng của mọi command.
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { CommandStatus } from "../command/command-status.tsx";
import { problemText, useCommand } from "../command/use-command.ts";
import { MAX_PHOTOS, usePhotoUpload } from "../command/use-photo-upload.ts";
import { Button } from "../ui/button.tsx";
import { SelectField, TextField } from "../ui/field.tsx";

export interface IncidentRoom {
  unitId: string;
  propertyId: string;
  label: string;
}

const SEVERITIES = [
  { value: "low", label: "Thấp" },
  { value: "medium", label: "Trung bình" },
  { value: "high", label: "Cao" },
  { value: "critical", label: "Nghiêm trọng" },
];

export function IncidentForm({ rooms }: { rooms: IncidentRoom[] }) {
  const router = useRouter();
  const cmd = useCommand("maintenance/createWorkOrder");
  const photos = usePhotoUpload("/dang-nhap");
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const title = String(f.get("title") ?? "").trim();
    const description = String(f.get("description") ?? "").trim();
    const unit = rooms.find((r) => r.unitId === String(f.get("unit_id") ?? "")) ?? rooms[0];
    const errs: Record<string, string> = {};
    if (!title) errs.title = "Bắt buộc nhập";
    if (title.length > 200) errs.title = "Tối đa 200 ký tự";
    if (!description) errs.description = "Bắt buộc nhập";
    if (description.length > 2000) errs.description = "Tối đa 2.000 ký tự";
    const files = f.getAll("photo").filter((x): x is File => x instanceof File && x.size > 0);
    if (files.length > MAX_PHOTOS) errs.photo = `Tối đa ${MAX_PHOTOS} ảnh mỗi phiếu.`;
    setErrors(errs);
    photos.setError(null);
    if (Object.keys(errs).length > 0 || !unit) return;
    const fileIds: string[] = [];
    for (const file of files) {
      const id = await photos.upload(file, unit.propertyId);
      if (!id) return;
      fileIds.push(id);
    }
    const r = await cmd.send({
      unit_id: unit.unitId,
      title,
      description,
      severity: String(f.get("severity") ?? "medium"),
      file_ids: fileIds,
    });
    if (r !== null) {
      form.reset();
      photos.reset();
      router.refresh();
    }
  }

  const fieldError = (name: string) => {
    if (errors[name]) return errors[name];
    const hit = cmd.problem?.errors?.find((x) => x.field === name);
    return hit ? (problemText(cmd.problem) ?? undefined) : undefined;
  };
  const general =
    cmd.phase === "error" && !["title", "description"].some((n) => fieldError(n))
      ? problemText(cmd.problem)
      : null;
  const photoError = errors.photo ?? photos.error;

  return (
    <form onSubmit={onSubmit} noValidate className="command-form" data-testid="incident-form">
      <fieldset className="command-form__fields" disabled={cmd.locked || photos.uploading}>
        <SelectField
          name="unit_id"
          label="Phòng"
          options={rooms.map((r) => ({ value: r.unitId, label: r.label }))}
        />
        <TextField name="title" label="Sự cố" required maxLength={200} error={fieldError("title")} />
        <div className="field">
          <label htmlFor="description">Mô tả</label>
          <textarea
            id="description"
            name="description"
            rows={4}
            required
            maxLength={2000}
            aria-invalid={fieldError("description") ? true : undefined}
            aria-describedby={fieldError("description") ? "description-error" : undefined}
          />
          {fieldError("description") ? (
            <span id="description-error" className="field__error" role="alert">
              {fieldError("description")}
            </span>
          ) : null}
        </div>
        <SelectField name="severity" label="Mức độ" options={SEVERITIES} defaultValue="medium" />
        <div className="field">
          <label htmlFor="photo">Ảnh (tuỳ chọn, tối đa {MAX_PHOTOS})</label>
          <span id="photo-hint" className="field__hint">
            Chụp trực tiếp hoặc chọn ảnh JPEG, PNG, WebP, tối đa 10 MB mỗi ảnh.
          </span>
          <input
            id="photo"
            name="photo"
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            aria-describedby={photoError ? "photo-hint photo-error" : "photo-hint"}
          />
          {photoError ? (
            <span id="photo-error" className="field__error" role="alert">
              {photoError}
            </span>
          ) : null}
        </div>
      </fieldset>
      <Button type="submit" loading={cmd.busy || photos.uploading} disabled={cmd.locked || photos.uploading}>
        Gửi báo sự cố
      </Button>
      {photos.uploading ? (
        <p className="command-form__status" role="status">
          Đang kiểm tra ảnh…
        </p>
      ) : null}
      <CommandStatus
        phase={cmd.phase}
        commandId={cmd.commandId}
        problem={cmd.problem}
        general={general}
        successText="Đã ghi nhận sự cố — trạng thái: Mới báo."
        onResend={() => void cmd.resend().then((r) => r !== null && router.refresh())}
        onRecheck={() => void cmd.recheck().then((r) => r !== null && router.refresh())}
      />
    </form>
  );
}
