---
title: State, data fetching, cache phía client, đồng bộ server
kind: module
prefix: FE-STATE
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
---

# State, data fetching, cache phía client, đồng bộ server

> Phân biệt **server state** (dữ liệu của backend, có thể cũ, cần cache/invalidate), **client state** (UI: mở/đóng, nháp),
> **URL state** (điều hướng) và **form state**. Mỗi loại một công cụ; server state không chép vào store toàn cục; mọi mutation
> có invalidation và nhánh lỗi; optimistic có rollback. Hiển thị trạng thái → [`../06-design-ux/ui-states-and-feedback.md`](../06-design-ux/ui-states-and-feedback.md).

## Nguyên tắc

1. **Server state là cache, không phải sự thật.** Thư viện query (TanStack Query/SWR/framework-native) quản lý stale, refetch,
   dedupe, retry; component không tự `useEffect + fetch`.
2. **Một key, một nguồn**: query key sinh từ factory dùng chung; invalidation theo key/tag sau mỗi mutation.
3. **Client state tối thiểu và cục bộ.** Store toàn cục chỉ cho thứ thật sự xuyên màn hình (phiên, theme, giỏ tạm). Dữ liệu
   suy ra (derived) tính lúc render, không lưu.
4. **Mạng là không tin cậy**: timeout, huỷ request khi rời màn hình (AbortSignal), retry chỉ cho lỗi tạm thời (5xx/mạng),
   không retry 4xx; offline có hành vi định nghĩa.
5. **Mutation là hợp đồng**: idempotent khi có thể (key), rollback khi lỗi, không double-submit.
6. **Không lưu bí mật/PII trong state bền** (localStorage/IndexedDB) ngoài phạm vi đã quyết ở [`client-security.md`](client-security.md).

## Quyết định

| Loại state | Chọn | Khi nào | Không dùng khi |
|---|---|---|---|
| Server state (React) | **TanStack Query 5.104.2** (MIT) | Mọi app có API | App RSC thuần đọc qua server component + server action → dùng `use cache`/revalidate, Query chỉ cho phần client tương tác |
| Server state (Vue/Svelte/Solid) | TanStack Query bản Vue/Svelte/Solid, hoặc Nuxt `useFetch`/SvelteKit `load` | Theo framework | Tự viết cache |
| GraphQL | Apollo Client / urql với normalized cache | API GraphQL | REST → không ép GraphQL client |
| Client state toàn cục | zustand 5.0.15 / jotai 3.0.1 (React); Pinia (Vue); signals (Angular/Solid/Svelte 5 runes) | 2–3 mảng state xuyên màn hình | Mọi thứ vào Redux "cho chắc" |
| URL state | Router (search params có kiểu: TanStack Router/`nuqs`) | Bộ lọc, trang, tab | Nháp form dài |
| Form state | Thư viện form (xem [`forms-and-validation.md`](forms-and-validation.md)) | Form | Store toàn cục |
| Realtime | WebSocket/SSE cập nhật cache query (`setQueryData`) | Dữ liệu đổi liên tục | Polling ngắn < 5 s (xem [`../08-backend/realtime-and-streaming.md`](../08-backend/realtime-and-streaming.md)) |
| Offline-first | Persist cache + hàng đợi mutation (TanStack persist/`onlineManager`, PowerSync/RxDB tuỳ dự án) | Mobile/field app | Admin nội bộ luôn online |

**Mặc định TanStack Query v5 cần biết** (tài liệu): dữ liệu cache **stale ngay** (`staleTime` 0) → refetch khi mount/focus/
reconnect; `gcTime` 5 phút; retry 3 lần với backoff; structural sharing. Đặt `staleTime` có chủ đích theo loại dữ liệu.

## Checklist

- [ ] `FE-STATE-001` **MUST** Mọi fetch dữ liệu server đi qua một lớp (thư viện query hoặc loader/server component của framework); không `useEffect(() => fetch())` trong component. → Kiểm: lint `@tanstack/eslint-plugin-query` 5.104.2 bật; grep `useEffect[\s\S]{0,200}fetch\(` trong `src/components` = 0.
- [ ] `FE-STATE-002` **MUST@L** Query key sinh từ factory tập trung (`queryKeys.orders.detail(id)`), không chuỗi tự do. → Kiểm: grep `useQuery({ queryKey: \['` ngoài file factory = 0; test factory snapshot.
- [ ] `FE-STATE-003` **MUST** Mỗi mutation khai báo invalidation (key/tag) hoặc cập nhật cache trực tiếp; sau mutation thành công UI phản ánh dữ liệu mới không cần reload. → Kiểm: E2E tạo/sửa/xoá → danh sách cập nhật không `page.reload()`; review `onSuccess/onSettled` có `invalidateQueries`. · Nguồn: TanStack Query Optimistic Updates
- [ ] `FE-STATE-004` **MUST@L** Optimistic update theo mẫu: huỷ refetch đang chạy → snapshot → set cache → rollback ở `onError` → invalidate ở `onSettled`; không dùng cho tiền/quyền/xoá vĩnh viễn. → Kiểm: test đơn vị mutation lỗi → cache bằng snapshot; grep `onMutate` trong module thanh toán = 0. · Nguồn: TanStack Query Optimistic Updates
- [ ] `FE-STATE-005` **MUST** Retry chỉ với lỗi tạm thời (mạng, 408/429/5xx) có backoff và giới hạn; không retry 4xx (trừ 408/429); mutation không retry mặc định trừ khi idempotent. → Kiểm: cấu hình `retry: (count, err) => isTransient(err) && count < 3`; test 400 → không retry (đếm request). · Nguồn: [`../08-backend/reliability-and-errors.md`](../08-backend/reliability-and-errors.md)
- [ ] `FE-STATE-006` **MUST@L** Request bị huỷ khi component unmount/route đổi (AbortSignal truyền vào `fetch`); có timeout client. → Kiểm: E2E điều hướng nhanh → request trước bị abort (Playwright `request.failure()` = aborted); `fetch` nhận `signal`.
- [ ] `FE-STATE-007` **MUST@L** Lỗi fetch được chuẩn hoá thành một kiểu (`AppError { code, message, retryable }`) ở lớp API client; component không parse `error.response.data` rải rác. → Kiểm: file `api/client.ts` là nơi duy nhất xử lý `Response` → `AppError`; test map 401/403/404/422/500.
- [ ] `FE-STATE-008` **MUST** Không lưu token phiên, PII hay dữ liệu nhạy cảm trong store bền (localStorage/IndexedDB/persist) ngoài danh sách đã duyệt. → Kiểm: grep `persist(` / `localStorage.setItem` → danh sách key đối chiếu `docs/CLIENT-STORAGE.md`; test không có key chứa `token|session|email`. · Nguồn: [`client-security.md`](client-security.md)
- [ ] `FE-STATE-009` **MUST@L** Mutation tạo mới gửi idempotency key; gửi lại khi mạng lỗi không tạo bản ghi trùng. → Kiểm: test mô phỏng timeout → retry với cùng key → server trả cùng id. · Nguồn: [`../08-backend/api-design.md`](../08-backend/api-design.md)
- [ ] `FE-STATE-010` **SHOULD** `staleTime` đặt theo loại dữ liệu (tham chiếu: phút/giờ; giao dịch: ngắn), không giữ mặc định 0 cho mọi query. → Kiểm: `QueryClient` có `defaultOptions.queries.staleTime` và ghi chú; review query nóng có override. · Nguồn: TanStack Query Important Defaults
- [ ] `FE-STATE-011` **SHOULD** Dữ liệu suy ra không lưu trong state; tính bằng `useMemo`/computed/selector. → Kiểm: review store: không trường `total` tính được từ `items`; test selector.
- [ ] `FE-STATE-012` **SHOULD** Store toàn cục có ≤ một vài slice rõ tên; mỗi slice có test; không đặt server data vào store. → Kiểm: grep `setItems(data)` sau `useQuery` = 0; số slice liệt kê trong `docs/STATE.md`.
- [ ] `FE-STATE-013` **SHOULD** Danh sách dài dùng phân trang/infinite query có `getNextPageParam` và virtualization khi > vài trăm hàng. → Kiểm: E2E cuộn danh sách 1 000 mục không > N node DOM (ngưỡng dự án); Lighthouse `dom-size` không cảnh báo.
- [ ] `FE-STATE-014` **SHOULD** Offline/mất mạng: query dùng cache cũ + chỉ báo; mutation xếp hàng hoặc báo rõ; `networkMode` cấu hình có chủ đích. → Kiểm: Playwright `setOffline(true)` → không lỗi lạ; khôi phục mạng → tự refetch (`refetchOnReconnect`).
- [ ] `FE-STATE-015` **SHOULD** Realtime cập nhật cache query (`setQueryData`/invalidate theo sự kiện) thay vì duy trì bản sao riêng. → Kiểm: review handler WebSocket gọi `queryClient`; test sự kiện → UI cập nhật.
- [ ] `FE-STATE-016` **SHOULD** Prefetch dữ liệu cho route kế tiếp (hover/viewport) và dehydrate từ server vào client (SSR) để tránh fetch kép. → Kiểm: E2E lần render đầu không có request trùng dữ liệu đã có trong HTML; `HydrationBoundary`/tương đương dùng.
- [ ] `FE-STATE-017` **SHOULD** Dữ liệu từ API được validate ở biên (schema) trước khi vào cache (xem [`forms-and-validation.md`](forms-and-validation.md) cho schema dùng chung). → Kiểm: client API parse response bằng schema; test response sai kiểu → `AppError` thay vì crash. · Nguồn: P6
- [ ] `FE-STATE-018` **MAY** Persist cache query cho PWA/mobile với TTL và danh sách key cho phép. → Kiểm: cấu hình persister có `maxAge` và `shouldDehydrateQuery` lọc key.
- [ ] `FE-STATE-019` **MAY** Devtools của thư viện query chỉ nạp ở development. → Kiểm: bundle production không chứa devtools (analyzer).
- [ ] `FE-STATE-020` **MAY** Đo tỷ lệ cache hit/refetch bằng sự kiện `QueryCache` gửi về observability. → Kiểm: dashboard có metric.

## Bẫy thường gặp

- **Fetch trong `useEffect` + `useState`** tự chế: không dedupe, không huỷ, race condition khi đổi id nhanh → hiển thị dữ liệu của id cũ.
- **Chép dữ liệu query vào store toàn cục** → hai nguồn sự thật, cập nhật lệch.
- **Query key tự do** (`['orders']` ở một nơi, `['order-list']` ở nơi khác) → invalidate không trúng.
- **Retry 3 lần cho 401/403/422** → lỗi hiện chậm gấp 4, tăng tải; 429 bị retry không backoff → bị chặn.
- **Refetch storm** khi focus cửa sổ với hàng chục query `staleTime: 0` → backend bị dội.
- **Optimistic cho thanh toán** → hiển thị thành công rồi rollback (xem ui-states).
- **Không huỷ request khi unmount** → `setState` trên component đã gỡ, dữ liệu cũ ghi đè mới.
- **Lưu toàn bộ store vào localStorage** kể cả token và PII → rò rỉ qua XSS/thiết bị dùng chung.
- **Danh sách 5 000 hàng render thẳng** → INP tệ, trình duyệt treo. Phân trang/virtualize.
- **Parse response không validate** → `undefined is not a function` ở production khi backend đổi field.

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| `@tanstack/eslint-plugin-query` 5.104.2 (MIT) | `eslint .` (rules `exhaustive-deps`, `no-rest-destructuring`, `stable-query-client`) | pre-commit + CI | 0 lỗi |
| MSW 3.0.3 (MIT) | handler 200/4xx/5xx/timeout dùng chung cho unit + E2E | test | mọi query/mutation có test lỗi |
| Vitest 5.0.4 (MIT) | test optimistic rollback, retry policy, error mapping | CI | xanh |
| Playwright 1.64.0 (Apache-2.0) | `setOffline`, abort khi điều hướng, không reload sau mutation | CI E2E | xanh |
| Grep | `rg -n "useEffect[\s\S]{0,200}fetch\(" src/components` · `rg -n "localStorage.setItem" src` đối chiếu danh sách | pre-commit | 0 / khớp danh sách |
| Bundle analyzer + size-limit 14.2.0 | devtools không trong production | CI | không có chunk devtools |
| Lighthouse 13.5.0 | `dom-size`, INP proxy (TBT) | CI | không cảnh báo |

## Nguồn

- TanStack Query — Important Defaults (stale ngay, refetch khi mount/focus/reconnect, `gcTime` 5 phút, retry 3 lần backoff, structural sharing): <https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults>; Optimistic Updates (`onMutate` cancel+snapshot, `onError` rollback, `onSettled` invalidate; cách qua `variables`): <https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates> — xác minh 2026-10-13.
- React — `useOptimistic`: <https://react.dev/reference/react/useOptimistic> — xác minh 2026-10-13.
- Next.js — Caching/Revalidating (server-side data với `use cache`, `revalidate`): <https://nextjs.org/docs/app/getting-started/caching> — xác minh 2026-10-13.
- Phiên bản npm `latest` (2026-10-13): @tanstack/react-query 5.104.2 · @tanstack/eslint-plugin-query 5.104.2 · swr 2.5.1 · zustand 5.0.15 · jotai 3.0.1 · msw 3.0.3 · vitest 5.0.4 · @playwright/test 1.64.0 · size-limit 14.2.0 · lighthouse 13.5.0.
- Nguyên tắc P5 (một nguồn sự thật), P6 (không tin đầu vào): [`../00-method/principles.md`](../00-method/principles.md).
- Khung cũ `1b80fe4` `quality-supplements.md` Nhóm 2 mục 5–6 (optimistic có rollback; async race/idempotency).
