"use client";
// Tải ảnh lên trước khi gửi command (POST /api/v1/files/upload, SPEC-portal S-008, SPEC-housekeeping-maintenance S-012…S-014).
// Mỗi ảnh = một Idempotency-Key + một fileId: gửi lại cùng lệnh (mất mạng, "Gửi lại") không tải ảnh lần hai. Ảnh chỉ dùng
// được khi máy chủ báo `ready` (đã qua kiểm tra an toàn) — trong lúc chờ UI hiện "Đang kiểm tra ảnh…" (role=status).
import { safeUrl } from "@hm/app/http";
import { mibToBytes } from "@hm/app/units";
import { useRef, useState } from "react";
import { timedFetch, UPLOAD_TIMEOUT_MS } from "../../lib/fetch-timeout.ts";
import { type CommonMessages, useMessages } from "../../lib/i18n-context.tsx";
import { tm } from "../../lib/i18n-format.ts";
import { reportClientOutdated } from "../pwa/pwa-shell.tsx";
import { appVersionHeaders } from "./app-version.ts";
import { IN_PROGRESS_CODE } from "./in-progress.ts";
import { orgContextHeaders } from "./org-context.ts";

export const MAX_PHOTO_BYTES = mibToBytes(10);
export const MAX_PHOTOS = 5;
/** Câu lỗi theo mã HTTP của lần tải ảnh; mã khác → câu chung. */
export function photoError(m: CommonMessages, status: number): string {
  switch (status) {
    case 413:
      return tm(m, "common.photo.too_large");
    case 415:
      return tm(m, "common.photo.bad_type");
    case 429:
      return tm(m, "common.photo.rate_limited");
    case 503:
      return tm(m, "common.photo.scan_unavailable");
    default:
      return tm(m, "common.photo.failed");
  }
}

interface Uploaded {
  key: string;
  fileId: string | null;
}

/** `loginPath`: nơi đưa người dùng về khi phiên hết hạn (nhân viên `/dang-nhap`, người thuê `/dang-nhap/nguoi-thue`). */
export function usePhotoUpload(loginPath: string) {
  const m = useMessages();
  const uploaded = useRef(new Map<string, Uploaded>());
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  /** Tải một ảnh; trả `fileId` khi `ready`, ngược lại `null` (đã đặt `error`). */
  async function upload(file: File, propertyId: string): Promise<string | null> {
    if (file.size > MAX_PHOTO_BYTES) {
      setError(photoError(m, 413));
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
        setError(tm(m, "common.command.client_outdated"));
        return null;
      }
      if (res.status === 401) {
        window.location.assign(safeUrl(loginPath) ?? "/dang-nhap");
        return null;
      }
      if (res.status === 409 && j?.code === "CONTEXT_CHANGED") {
        setError(tm(m, "common.command.context_changed"));
        return null;
      }
      if (res.status === 409 && j?.code === IN_PROGRESS_CODE) {
        // D-043: lần tải trước cùng key còn đang xử lý — GIỮ key để lần gửi lại nhận đúng file đó, không tải bản thứ hai.
        setError(tm(m, "common.photo.in_progress"));
        return null;
      }
      if (!res.ok || !j?.data) {
        uploaded.current.delete(sig);
        setError(photoError(m, res.status));
        return null;
      }
      if (j.data.status !== "ready") {
        uploaded.current.delete(sig);
        setError(tm(m, "common.photo.unsafe"));
        return null;
      }
      u.fileId = j.data.fileId;
      return u.fileId;
    } catch {
      setError(tm(m, "common.photo.network"));
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
