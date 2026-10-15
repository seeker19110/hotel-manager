/// <reference lib="webworker" />
// Service worker (SPEC-pwa §5, PLAN T-013) — bundle bằng esbuild qua app/serwist/[path]/route.ts.
// Chính sách: precache CHỈ asset tĩnh có hash + icon + /offline; điều hướng NetworkOnly (lỗi mạng → /offline);
// không đăng ký route cache cho /api/* hay object storage; không tự skipWaiting/clientsClaim (S-008).
import { NetworkOnly, type PrecacheEntry, Serwist, type SerwistGlobalConfig } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST ?? [],
  skipWaiting: false,
  clientsClaim: false,
  navigationPreload: true,
  runtimeCaching: [{ matcher: ({ request }) => request.mode === "navigate", handler: new NetworkOnly() }],
  fallbacks: {
    entries: [{ url: "/offline", matcher: ({ request }) => request.destination === "document" }],
  },
});

// S-007: xoá mọi cache trừ precache của bản hiện tại (app shell) khi đăng xuất / đổi tổ chức.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "CLEAR_USER_DATA") return;
  const keep = serwist.precacheStrategy.cacheName;
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== keep).map((k) => caches.delete(k)))),
  );
});

serwist.addEventListeners();
