---
status: proposed — ghi nhận hiện trạng đã chạy, chờ chủ dự án xem lại
implementation-status: implemented
date: 2026-10-16
decision-makers: phiên chính (kỹ thuật); chủ dự án xem lại lúc nào cũng được (AGENTS §5)
consulted: apps/web/proxy.ts, apps/web/app/layout.tsx, SPEC-pwa S-005/S-007, THREAT-MODEL (CSP, bộ nhớ đệm)
informed: đội phát triển
---

# ADR-0004: Chiến lược render — mọi trang render động theo request và không lưu ở bộ nhớ đệm HTTP; chỉ asset có hash, icon và manifest được cache

Bổ sung cho [ADR-0001](0001-modular-monolith-typescript-postgres.md) (Next.js App Router). Bảng từng route nằm ở [`docs/ROUTES.md`](../ROUTES.md) và được test so với cây `apps/web/app`.

## Bối cảnh và vấn đề
Next.js cho chọn chế độ render theo route: tĩnh (SSG), tĩnh có làm mới (ISR / cache dùng chung), động theo request (SSR), hoặc client (CSR). Hotel Manager có ba đặc điểm làm hạn chế lựa chọn:
- Gần như mọi màn hiển thị dữ liệu theo người dùng và tổ chức (RLS, quyền theo vai trò, thông tin cá nhân, tiền). Cache dùng chung giữa người dùng có thể làm lộ dữ liệu chéo tổ chức.
- CSP dùng nonce theo từng request (`apps/web/proxy.ts`, `buildCsp`). Trang tĩnh hoặc đã cache không có nonce đúng nên script của Next bị CSP chặn.
- PWA chạy online, không cache dữ liệu nghiệp vụ ở thiết bị (SPEC-pwa S-005, S-007): HTML và API không được nằm trong HTTP cache, bfcache hay Cache Storage; chỉ asset tĩnh có hash, icon và trang `/offline` được precache.

## Yếu tố quyết định
- Không rò dữ liệu giữa người dùng/tổ chức qua cache (ưu tiên trên hiệu năng).
- CSP có nonce hoạt động trên mọi trang.
- Tiến trình web không giữ trạng thái giữa request, để chạy được từ 2 bản sao trở lên.
- Quy mô M (10–100 phòng mỗi tổ chức; tải kiểm thử 200 phiên đồng thời) chưa cần cache để đạt p95 API < 800 ms.
- Đơn giản, test được bằng một quy tắc: "mọi thứ qua proxy là `no-store`, trừ ngoại lệ có tên".

## Các phương án đã cân nhắc
1. **Mọi trang SSR động theo request, `Cache-Control: no-store` đặt ở proxy cho mọi đường dẫn trừ `/icons/*` và `/manifest.webmanifest`; layout gốc gọi `connection()`.**
2. Trang công khai (đăng nhập, `/offline`, huỷ đăng ký) tĩnh (SSG), trang có phiên động.
3. ISR / cache dùng chung (`revalidate`, `use cache`) cho phần dữ liệu ít đổi (danh mục phòng, loại phòng, báo cáo).
4. CSR toàn phần (SPA): vỏ tĩnh, mọi dữ liệu lấy qua `/api/v1`.

## Quyết định
Chọn **phương án 1**, theo nhóm route:

| Nhóm route | Chế độ render | Cache | Ghi chú |
|---|---|---|---|
| Trang nhân viên (`withActor`: hôm nay, phòng, lịch, hợp đồng, kỳ thu, thu tiền, lưu trú…) | SSR động | `no-store` | Quyền kiểm ở server mỗi request (`resolveActor` + RLS); chưa đăng nhập → chuyển hướng |
| Trang người thuê (`/portal/**`, `withPortal`) | SSR động | `no-store` | Chỉ vai trò `tenant`; tiêu đề luôn nêu tổ chức |
| Trang công khai có token (`/huy-dang-ky`, `/khach/luot-o/[id]`) và đăng nhập | SSR động (vỏ), dữ liệu lấy bằng API | `no-store`; `referrer: no-referrer`, `robots: noindex` cho trang có token | Token khách nằm ở fragment, không vào log hay `Referer` |
| Route handler `/api/**` | động (`force-dynamic`) | `no-store` | Cùng proxy; ghi cần cùng origin trừ webhook (chữ ký) |
| Asset `/_next/static/*` (tên có hash), `/icons/*`, `/manifest.webmanifest` | tĩnh | cache dài / công khai | Không chứa dữ liệu người dùng; `/_next/static` không đi qua proxy |
| `/serwist/sw.js`, `/offline` | bundle lúc build; `/offline` precache bởi service worker | theo service worker | `/offline` không chứa dữ liệu nghiệp vụ |

Quy tắc kèm theo:
- Route mới phải có dòng trong `docs/ROUTES.md`; test so danh sách với cây `apps/web/app` (thiếu hoặc thừa → đỏ).
- Route theo người dùng không dùng cache dùng chung; muốn cache thì mở ADR mới, nêu khoá cache gồm người dùng và tổ chức.

### Hệ quả
- Tốt:
  - Một quy tắc dễ kiểm: mọi phản hồi qua proxy là `no-store` trừ hai ngoại lệ có tên (`isCacheablePublicPath`).
  - Không có đường rò dữ liệu qua cache HTTP, CDN hay bfcache; CSP nonce luôn khớp.
  - Web không giữ trạng thái, scale ngang được (phiên, rate limit và idempotency nằm ở Postgres).
- Xấu / chấp nhận:
  - Mọi lượt xem đều chạm server và CSDL; không hưởng lợi từ CDN cho HTML. Chấp nhận ở quy mô M; chưa đo LCP/TTFB thật (chưa có Lighthouse CI/RUM).
  - Trang công khai ít đổi (đăng nhập) vẫn render mỗi request.
  - Mất lợi thế `prefetch` tĩnh của Next cho điều hướng.
- Việc còn mở: chưa đo LCP/TTFB thật (xem trên). E2E hai người dùng khác tổ chức không thấy dữ liệu của nhau đã có ở mức giao diện (đợt 6, T-506).

### Xác nhận
- E2E `apps/web/e2e/isolation.spec.ts`: hai nhân viên ở hai tổ chức không thấy cơ sở/mã tổ chức của nhau ở trang lẫn `/api/v1/me`, `Cache-Control` no-store/private, đổi người dùng trên cùng trình duyệt không lộ trang cũ, mượn phiên gọi vào tổ chức kia → 404.
- E2E `apps/web/e2e/pwa.spec.ts` («S-005 trang và API mang Cache-Control: no-store») và `smoke.spec.ts` («trang đã đăng nhập mang Cache-Control: no-store»).
- `packages/app/src/http/security.test.ts` kiểm `isCacheablePublicPath` và CSP nonce.
- `scripts/process-docs.test.mjs`: `docs/ROUTES.md` khớp cây `apps/web/app`; ADR đủ mục bắt buộc.
- Bộ kiểm cách ly tenant ở `packages/app/src/tenancy/tenancy.db.test.ts`.

## Ưu / nhược từng phương án
### 1. SSR động + no-store
- Tốt: an toàn mặc định, hợp CSP nonce, đơn giản.
- Xấu: không tận dụng cache; tải dồn về server.

### 2. Trang công khai tĩnh
- Tốt: nhanh hơn cho vài trang công khai.
- Xấu: thiếu nonce nên phải nới CSP hoặc thêm cơ chế riêng cho từng loại trang; lợi ích nhỏ vì chỉ vài trang.

### 3. ISR / cache dùng chung
- Tốt: giảm tải khi đọc nhiều.
- Xấu: rủi ro lộ dữ liệu chéo tổ chức nếu khoá cache sai; khó chứng minh bằng test; không cần ở quy mô M.

### 4. CSR toàn phần
- Tốt: tách giao diện khỏi server.
- Xấu: lần tải đầu chậm hơn, vẫn cần nonce cho script, mất kiểm quyền ở server khi dựng trang.

## Điều kiện xem lại
Mở ADR mới (thay hoặc bổ sung) khi một trong các điều kiện sau xảy ra:
- LCP p75 trên thiết bị mục tiêu vượt 2,5 s mà nguyên nhân là thời gian phản hồi HTML (TTFB), đã đo bằng Lighthouse CI/RUM.
- Thêm trang công khai có lưu lượng lớn (giới thiệu, đặt phòng công khai) — cân nhắc phương án 2 riêng cho nhóm đó.
- Next.js hỗ trợ nonce cho trang tĩnh/render một phần (PPR) ổn định, hoặc đổi cách gắn nonce vào script.
- Có dữ liệu chỉ đọc, không theo người dùng và đắt để tính (báo cáo tổng hợp lớn) — cân nhắc cache có khoá theo tổ chức.
- Triển khai CDN hoặc reverse proxy có cache phía trước ứng dụng.

## Thông tin thêm
- Liên quan: [`docs/ROUTES.md`](../ROUTES.md), [ADR-0001](0001-modular-monolith-typescript-postgres.md), `docs/specs/SPEC-pwa.md`, `docs/design/THREAT-MODEL.md`.
