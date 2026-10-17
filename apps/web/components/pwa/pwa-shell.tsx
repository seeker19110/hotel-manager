"use client";
// Vỏ PWA (SPEC-pwa): đăng ký SW, banner mất mạng, banner có bản mới. Chỉ chạy online — không cache trang/dữ liệu.
import { SerwistProvider, useSerwist } from "@serwist/turbopack/react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { CLIENT_OUTDATED_TEXT } from "../command/app-version.ts";
import { ReauthDialog } from "../command/reauth-dialog.tsx";
import { Icon } from "../ui/icon.tsx";

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
      <Icon name="warning" />
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

// ───────── Client quá cũ (S-009) ─────────
// Một lệnh nhận 426 CLIENT_OUTDATED ⇒ mọi form dừng ghi; banner toàn cục hiện câu + nút "Cập nhật" (đến khi tải lại trang).
let outdated = false;
const outdatedListeners = new Set<() => void>();

/** Gọi khi server trả 426 CLIENT_OUTDATED. */
export function reportClientOutdated(): void {
  if (outdated) return;
  outdated = true;
  for (const l of outdatedListeners) l();
}

function subscribeOutdated(cb: () => void): () => void {
  outdatedListeners.add(cb);
  return () => outdatedListeners.delete(cb);
}

/** Nhận bản mới: có SW đang chờ ⇒ cho nó nắm quyền; rồi tải lại trang (HTML luôn lấy mới từ máy chủ, no-store). */
export async function applyUpdate(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    if (reg?.waiting) {
      const changed = new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
        setTimeout(resolve, 3_000);
      });
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
      await changed;
    }
  } catch {
    // không cập nhật được SW (mạng/SW bị chặn) — tải lại trang vẫn lấy HTML + JS mới
  }
  window.location.reload();
}

function OutdatedBanner() {
  const isOutdated = useSyncExternalStore(
    subscribeOutdated,
    () => outdated,
    () => false,
  );
  if (!isOutdated) return null;
  return (
    <div className="banner banner--warn" role="alert" data-testid="outdated-banner">
      <p>{CLIENT_OUTDATED_TEXT}</p>
      <button type="button" className="btn" onClick={() => void applyUpdate()}>
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
      <OutdatedBanner />
      <InstallCapture />
      <ReauthDialog />
      {children}
    </SerwistProvider>
  );
}

/** Tiền tố cache precache của Serwist (app shell) — giữ lại; mọi cache khác có thể chứa dữ liệu người dùng. */
const PRECACHE_PREFIX = "serwist-precache";

/**
 * S-007/S-020: đăng xuất / đổi tổ chức — xoá mọi Cache Storage trừ precache, IndexedDB `hm-*`, storage của ứng dụng.
 * Xoá ngay ở trang (trang có thể chưa được SW điều khiển) và báo SW làm lại phía nó. Đăng xuất: server trả thêm
 * `Clear-Site-Data`.
 */
export async function clearUserData(): Promise<void> {
  navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_USER_DATA" });
  try {
    const keys = (await globalThis.caches?.keys()) ?? [];
    await Promise.all(keys.filter((k) => !k.startsWith(PRECACHE_PREFIX)).map((k) => caches.delete(k)));
  } catch {
    // Cache Storage bị chặn (chế độ riêng tư) — không có gì để xoá
  }
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

// ───────── Cài ứng dụng (S-002/S-003) ─────────
// `beforeinstallprompt` chỉ bắn MỘT lần, thường trước khi trang "Thêm" dựng ⇒ bắt ở vỏ gốc và giữ lại. Safari iOS không có sự kiện
// này: chỉ hướng dẫn bằng chữ + hình, không hiện nút cài giả.
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
let installEvent: InstallPromptEvent | null = null;
let installedFlag = false;
const installListeners = new Set<() => void>();
const notifyInstall = () => {
  for (const l of installListeners) l();
};

function InstallCapture() {
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault(); // dùng nút "Cài ứng dụng" của mình thay vì thanh mặc định
      installEvent = e as InstallPromptEvent;
      notifyInstall();
    };
    const onInstalled = () => {
      installEvent = null;
      installedFlag = true;
      notifyInstall();
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return null;
}

export type InstallState = "unknown" | "installed" | "prompt" | "ios" | "unsupported";

/** Máy iPhone/iPad (kể cả iPadOS giả danh Mac) — nơi không có `beforeinstallprompt`. */
export function isIosDevice(ua: string, platform: string, touchPoints: number): boolean {
  return /iphone|ipad|ipod/i.test(ua) || (platform === "MacIntel" && touchPoints > 1);
}

function installState(): InstallState {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone || installedFlag) return "installed";
  if (installEvent) return "prompt";
  if (isIosDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)) return "ios";
  return "unsupported";
}

function subscribeInstall(cb: () => void): () => void {
  installListeners.add(cb);
  return () => installListeners.delete(cb);
}

export function useInstall(): { state: InstallState; install: () => Promise<void> } {
  const state = useSyncExternalStore(subscribeInstall, installState, () => "unknown" as const);
  const install = async () => {
    const e = installEvent;
    if (!e) return;
    await e.prompt();
    await e.userChoice.catch(() => null);
    installEvent = null; // sự kiện chỉ dùng được một lần
    notifyInstall();
  };
  return { state, install };
}
