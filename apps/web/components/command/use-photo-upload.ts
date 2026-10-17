"use client";
// Tải ảnh lên trước khi gửi command (POST /api/v1/files/upload, SPEC-portal S-008, SPEC-housekeeping-maintenance S-012…S-014).
// Mỗi ảnh = một Idempotency-Key + một fileId: gửi lại cùng lệnh (mất mạng, "Gửi lại") không tải ảnh lần hai. Ảnh chỉ dùng
// được khi máy chủ báo `ready` (đã qua kiểm tra an toàn) — trong lúc chờ UI hiện "Đang kiểm tra ảnh…" (role=status).
import { safeUrl } from "@hm/app/http";
import { mibToBytes } from "@hm/app/units";
import { useRef, useState } from "react";
import { timedFetch, UPLOAD_TIMEOUT_MS } from "../../lib/fetch-timeout.ts";
import { reportClientOutdated } from "../pwa/pwa-shell.tsx";
import { appVersionHeaders, CLIENT_OUTDATED_TEXT } from "./app-version.ts";
import { orgContextHeaders } from "./org-context.ts";

export const MAX_PHOTO_BYTES = mibToBytes(10);
export const MAX_PHOTOS = 5;
export const PHOTO_ERRORS: Record<number, string> = {
  413: "Ảnh quá lớn (tối đa 10 MB).",
  415: "Chỉ nhận ảnh JPEG, PNG, WebP.",
  429: "Bạn tải ảnh quá nhanh, vui lòng thử lại sau ít phút.",
  503: "Chưa kiểm tra được ảnh, vui lòng thử lại sau.",
};

interface Uploaded {
  key: string;
  fileId: string | null;
}

/** `loginPath`: nơi đưa người dùng về khi phiên hết hạn (nhân viên `/dang-nhap`, người thuê `/dang-nhap/nguoi-thue`). */
export function usePhotoUpload(loginPath: string) {
  const uploaded = useRef(new Map<string, Uploaded>());
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  /** Tải một ảnh; trả `fileId` khi `ready`, ngược lại `null` (đã đặt `error`). */
  async function upload(file: File, propertyId: string): Promise<string | null> {
    if (file.size > MAX_PHOTO_BYTES) {
      setError(PHOTO_ERRORS[413] as string);
      return null;
    }
    const sig = `${file.name}:${file.size}:${file.lastModified}:${propertyId}`;
    let u = uploaded.current.get(sig);
    if (!u) {
      u = { key: crypto.randomUUID(), fileId: null };
      uploaded.current.set(sig, u);
    }
    if (u.fileId) return u.fileId;
    setUploading(true);
    try {
      const res = await timedFetch(
        `/api/v1/files/upload?owner_type=work_order&property_id=${propertyId}`,
        {
          method: "POST",
          headers: {
            "content-type": file.type || "application/octet-stream",
            "idempotency-key": u.key,
            ...orgContextHeaders(),
            ...appVersionHeaders(),
          },
          body: file,
          credentials: "same-origin",
        },
        UPLOAD_TIMEOUT_MS,
      );
      const j = (await res.json().catch(() => null)) as {
        data?: { fileId: string; status: string };
        code?: string;
      } | null;
      // Client quá cũ (S-009): server không ghi gì ⇒ banner toàn cục "Cập nhật", không nhắc "thử lại".
      if (res.status === 426) {
        reportClientOutdated();
        uploaded.current.delete(sig);
        setError(CLIENT_OUTDATED_TEXT);
        return null;
      }
      if (res.status === 401) {
        window.location.assign(safeUrl(loginPath) ?? "/dang-nhap");
        return null;
      }
      if (res.status === 409 && j?.code === "CONTEXT_CHANGED") {
        setError("Bạn vừa đổi tổ chức ở tab khác — tải lại trang");
        return null;
      }
      if (!res.ok || !j?.data) {
        uploaded.current.delete(sig);
        setError(PHOTO_ERRORS[res.status] ?? "Không tải được ảnh. Vui lòng thử lại.");
        return null;
      }
      if (j.data.status !== "ready") {
        uploaded.current.delete(sig);
        setError("Ảnh không đạt kiểm tra an toàn. Hãy chọn ảnh khác.");
        return null;
      }
      u.fileId = j.data.fileId;
      return u.fileId;
    } catch {
      setError("Chưa tải được ảnh. Kiểm tra mạng rồi bấm gửi lại.");
      return null;
    } finally {
      setUploading(false);
    }
  }

  /** Quên các ảnh đã tải (sau khi lệnh thành công và form được làm trống). */
  function reset() {
    uploaded.current.clear();
    setError(null);
  }

  return { upload, uploading, error, setError, reset };
}
