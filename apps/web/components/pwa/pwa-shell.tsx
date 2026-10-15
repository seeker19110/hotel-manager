"use client";
// Vỏ PWA (SPEC-pwa): đăng ký SW, banner mất mạng, banner có bản mới. Chỉ chạy online — không cache trang/dữ liệu.
import { SerwistProvider, useSerwist } from "@serwist/turbopack/react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

/** Trạng thái mạng của trình duyệt; phía server coi như có mạng. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/** S-004: banner mất mạng — role="status" (đọc lịch sự), chữ rõ ràng, không chỉ dựa vào màu. */
export function NetworkBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="banner banner--warn" role="status" aria-live="polite" data-testid="network-banner">
      <span aria-hidden="true">⚠</span>
      Mất kết nối — thao tác chưa được gửi
    </div>
  );
}

/**
 * S-008: SW mới ở trạng thái `waiting` → KHÔNG tự skipWaiting; người dùng bấm "Cập nhật" khi đã lưu xong thao tác,
 * SW mới nắm quyền thì tải lại trang.
 */
function UpdateBanner() {
  const { serwist } = useSerwist();
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!serwist) return;
    const onWaiting = () => setWaiting(true);
    const onControlling = () => window.location.reload();
    serwist.addEventListener("waiting", onWaiting);
    serwist.addEventListener("controlling", onControlling);
    return () => {
      serwist.removeEventListener("waiting", onWaiting);
      serwist.removeEventListener("controlling", onControlling);
    };
  }, [serwist]);
  if (!waiting) return null;
  return (
    <div className="banner banner--info" role="status" aria-live="polite">
      Đã có phiên bản mới. Lưu xong thao tác rồi bấm Cập nhật.
      <button type="button" className="btn btn--secondary" onClick={() => serwist?.messageSkipWaiting()}>
        Cập nhật
      </button>
    </div>
  );
}

export function PwaShell({ children }: { children: ReactNode }) {
  return (
    <SerwistProvider
      swUrl="/serwist/sw.js"
      // Không gửi URL trang vào SW để cache (mặc định của Serwist) — trang có thể chứa PII (S-005).
      cacheOnNavigation={false}
      // Không tự tải lại khi có mạng trở lại — tránh mất dữ liệu đang nhập (S-008).
      reloadOnOnline={false}
      disable={process.env.NODE_ENV !== "production"}
    >
      <NetworkBanner />
      <UpdateBanner />
      {children}
    </SerwistProvider>
  );
}

/**
 * S-007: đăng xuất / đổi tổ chức — nhờ SW xoá mọi cache trừ precache, xoá IndexedDB `hm-*` và storage của ứng dụng.
 * Server trả thêm `Clear-Site-Data` khi đăng xuất.
 */
export async function clearUserData(): Promise<void> {
  navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_USER_DATA" });
  try {
    const dbs = (await indexedDB.databases?.()) ?? [];
    await Promise.all(
      dbs.filter((d) => d.name?.startsWith("hm-")).map((d) => indexedDB.deleteDatabase(d.name as string)),
    );
  } catch {
    // trình duyệt không hỗ trợ liệt kê IndexedDB — pilot không dùng IndexedDB cho dữ liệu nghiệp vụ
  }
  sessionStorage.clear();
  localStorage.clear();
}
