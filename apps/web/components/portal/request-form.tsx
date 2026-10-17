"use client";
// Gửi yêu cầu sửa chữa kèm ảnh (SPEC-portal S-008). Ảnh tải lên trước (POST /api/v1/files/upload, Idempotency-Key riêng, giữ
// nguyên khi thử lại), rồi gửi `portal/createRequest` với file_ids — cùng cơ chế chống gửi đúp/mất mạng của mọi command.
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import { orgContextHeaders } from "../command/org-context.ts";
import { problemText, useCommand } from "../command/use-command.ts";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/field.tsx";

export interface RentedUnit {
  unitId: string;
  propertyId: string;
  unitCode: string;
}

const MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_ERRORS: Record<number, string> = {
  413: "Ảnh quá lớn (tối đa 10 MB).",
  415: "Chỉ nhận ảnh JPEG, PNG, WebP.",
  503: "Chưa kiểm tra được ảnh, vui lòng thử lại sau.",
};

export function RequestForm({ units }: { units: RentedUnit[] }) {
  const router = useRouter();
  const cmd = useCommand("portal/createRequest");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // Một ảnh = một Idempotency-Key + một fileId: gửi lại cùng lệnh không tải ảnh lần hai.
  const uploaded = useRef<{ sig: string; key: string; fileId: string | null } | null>(null);

  async function uploadPhoto(file: File, propertyId: string): Promise<string | null> {
    const sig = `${file.name}:${file.size}:${file.lastModified}:${propertyId}`;
    if (uploaded.current?.sig !== sig) uploaded.current = { sig, key: crypto.randomUUID(), fileId: null };
    const u = uploaded.current;
    if (u.fileId) return u.fileId;
    setUploading(true);
    try {
      const res = await fetch(`/api/v1/files/upload?owner_type=work_order&property_id=${propertyId}`, {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "idempotency-key": u.key,
          ...orgContextHeaders(),
        },
        body: file,
        credentials: "same-origin",
      });
      const j = (await res.json().catch(() => null)) as {
        data?: { fileId: string; status: string };
        code?: string;
      } | null;
      if (res.status === 401) {
        window.location.assign("/dang-nhap/nguoi-thue");
        return null;
      }
      if (res.status === 409 && j?.code === "CONTEXT_CHANGED") {
        setPhotoError("Bạn vừa đổi tổ chức ở tab khác — tải lại trang");
        return null;
      }
      if (!res.ok || !j?.data) {
        uploaded.current = null;
        setPhotoError(UPLOAD_ERRORS[res.status] ?? "Không tải được ảnh. Vui lòng thử lại.");
        return null;
      }
      if (j.data.status !== "ready") {
        uploaded.current = null;
        setPhotoError("Ảnh không đạt kiểm tra an toàn. Hãy chọn ảnh khác.");
        return null;
      }
      u.fileId = j.data.fileId;
      return u.fileId;
    } catch {
      setPhotoError("Chưa tải được ảnh. Kiểm tra mạng rồi bấm gửi lại.");
      return null;
    } finally {
      setUploading(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const title = String(f.get("title") ?? "").trim();
    const description = String(f.get("description") ?? "").trim();
    const unit = units.find((u) => u.unitId === String(f.get("unit_id") ?? units[0]?.unitId)) ?? units[0];
    const photo = f.get("photo");
    const errs: Record<string, string> = {};
    if (!title) errs.title = "Bắt buộc nhập";
    if (title.length > 200) errs.title = "Tối đa 200 ký tự";
    if (!description) errs.description = "Bắt buộc nhập";
    if (description.length > 2000) errs.description = "Tối đa 2.000 ký tự";
    setErrors(errs);
    setPhotoError(null);
    if (Object.keys(errs).length > 0 || !unit) return;
    const file = photo instanceof File && photo.size > 0 ? photo : null;
    if (file && file.size > MAX_BYTES) return setPhotoError(UPLOAD_ERRORS[413] as string);
    let fileIds: string[] = [];
    if (file) {
      const id = await uploadPhoto(file, unit.propertyId);
      if (!id) return;
      fileIds = [id];
    }
    const r = await cmd.send({
      unit_id: unit.unitId,
      title,
      description,
      ...(fileIds.length ? { file_ids: fileIds } : {}),
    });
    if (r !== null) {
      form.reset();
      uploaded.current = null;
      router.refresh();
    }
  }

  const fieldError = (name: string) => {
    if (errors[name]) return errors[name];
    const hit = cmd.problem?.errors?.find((x) => x.field === name);
    return hit ? (problemText(cmd.problem) ?? undefined) : undefined;
  };
  const general =
    cmd.phase === "error" && !fieldError("title") && !fieldError("description")
      ? problemText(cmd.problem)
      : null;

  return (
    <form onSubmit={onSubmit} noValidate className="command-form" data-testid="request-form">
      <fieldset className="command-form__fields" disabled={cmd.locked || uploading}>
        {units.length > 1 ? (
          <div className="field">
            <label htmlFor="unit_id">Phòng</label>
            <select id="unit_id" name="unit_id">
              {units.map((u) => (
                <option key={u.unitId} value={u.unitId}>
                  Phòng {u.unitCode}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <TextField name="title" label="Việc cần sửa" required maxLength={200} error={fieldError("title")} />
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
        <div className="field">
          <label htmlFor="photo">Ảnh (tuỳ chọn)</label>
          <span id="photo-hint" className="field__hint">
            JPEG, PNG hoặc WebP, tối đa 10 MB.
          </span>
          <input
            id="photo"
            name="photo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-describedby={photoError ? "photo-hint photo-error" : "photo-hint"}
          />
          {photoError ? (
            <span id="photo-error" className="field__error" role="alert">
              {photoError}
            </span>
          ) : null}
        </div>
      </fieldset>
      <Button type="submit" loading={cmd.busy || uploading} disabled={cmd.locked || uploading}>
        Gửi yêu cầu
      </Button>
      {cmd.phase === "checking" ? (
        <p className="command-form__status" role="status">
          Đang kiểm tra kết quả…
        </p>
      ) : null}
      {cmd.phase === "unknown" ? (
        <div className="banner banner--warn" role="alert">
          <p>
            Chưa rõ máy chủ đã nhận yêu cầu chưa. Bấm "Gửi lại" để gửi đúng yêu cầu này (không bị ghi hai
            lần).
          </p>
          {cmd.problem ? <p>{problemText(cmd.problem)}</p> : null}
          <Button
            variant="secondary"
            onClick={() => void cmd.resend().then((r) => r !== null && router.refresh())}
          >
            Gửi lại
          </Button>
        </div>
      ) : null}
      {cmd.phase === "processing" ? (
        <div className="banner banner--info" role="status">
          <p>Máy chủ vẫn đang xử lý yêu cầu. Chờ một lát rồi kiểm tra lại.</p>
          <Button
            variant="secondary"
            onClick={() => void cmd.recheck().then((r) => r !== null && router.refresh())}
          >
            Kiểm tra lại
          </Button>
        </div>
      ) : null}
      {general ? (
        <p className="field__error" role="alert">
          {general}
        </p>
      ) : null}
      {cmd.problem?.code === "CONTEXT_CHANGED" ? (
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Tải lại trang
        </Button>
      ) : null}
      {cmd.phase === "done" ? (
        <p className="command-form__status command-form__status--ok" role="status">
          Đã gửi yêu cầu — trạng thái: Đã tiếp nhận.
        </p>
      ) : null}
    </form>
  );
}
