---
title: Starter layout theo loại dự án và nguồn mã UI khởi đầu
kind: module
prefix: FE-START
applies_to: [web-app, mobile-app, static-site, desktop-app, monorepo]
updated: 2026-10-18
---

# Starter layout theo loại dự án và nguồn mã UI khởi đầu

> Chọn **điểm xuất phát** cho bố cục (landing, dashboard SaaS, app React Native/Flutter) từ nguồn có license rõ ràng, còn
> được bảo trì, rồi kéo nó qua cổng của dự án. Layout chỉ là khung; giá trị màu/khoảng cách/"gu" thuộc design system
> ([`../06-design-ux/design-system-and-tokens.md`](../06-design-ux/design-system-and-tokens.md)), breakpoint theo nền tảng thuộc
> [`UX-RESP-021`](../06-design-ux/responsive-and-mobile-first.md), license mã chép vào repo thuộc
> [`CMP-LIC-022`](../16-compliance-privacy/licensing-and-ip.md). Số liệu repo đọc từ bản clone/LICENSE ngày 2026-10-18 (stored
> 06 §7h, đối chiếu lại một phần bằng nguồn sống) — repo đổi nhanh, đọc lại trước khi chọn.

## Nguyên tắc

1. **Starter là mã của người khác trong repo của bạn.** Ghi nguồn + license + commit (`SOURCE`), bỏ phần không dùng, rồi
   coi như mã của dự án: qua lint, `xt.py contrast`, axe, test.
2. **License trước tính năng.** Bản "miễn phí trên README" thường chỉ là component; trang hoàn chỉnh nằm ở bản trả phí, và có
   template mang license khác thư viện lõi (CC BY-NC, Fair Use, Commons Clause) — `xt.py vendor-check` bắt phần dò được.
3. **Ngừng cập nhật thì không làm nền.** Mẫu không commit > 12 tháng hoặc kẹt ở major cũ của framework thì chỉ để tham khảo.
4. **Lấy từng block, không lấy cả starter** khi có thể (`npx shadcn add <block>`): bớt mã chết, bớt phụ thuộc (provider
   đăng nhập mặc định, analytics) mà dự án không dùng.

## Quyết định

| Loại dự án | Điểm xuất phát | Ghi chú đã kiểm (2026-10-18) | Không dùng khi |
|---|---|---|---|
| Trang marketing / landing (HTML + Tailwind) | **HyperUI** (`markmead/hyperui`, MIT): ~306 mẫu HTML bản sáng, 12 trang template | Chép HTML; Next.js có thể thêm **Once UI core** (MIT) | Preline (dual MIT + "Fair Use License") khi chưa đọc điều khoản; Tailwind Plus là license thương mại; `magic-portfolio` là CC BY-NC 4.0 |
| SaaS dashboard (React) | Khung từ **shadcn/ui blocks** (`dashboard-01`, `sidebar-07` còn trong registry `new-york-v4`) + starter **shadcn-admin** (Vite, React 19, TanStack Router, MIT) hoặc **next-shadcn-dashboard-starter** (Next 16, MIT) | Starter Next kèm Clerk: bỏ nếu không dùng; nhiều CRUD thì cân nhắc **Refine** (MIT) | Tremor Blocks (commit cuối 1/2025) và Flowbite Admin Dashboard (3/2025) chỉ để tham khảo KPI/chart/billing |
| App React Native | **React Native Reusables** (MIT) trên NativeWind/Uniwind; cần tab bar/drawer thì thêm **Tamagui Bento** | gluestack-ui v3 là phương án nhiều component hơn (license MIT chỉ nằm trong `packages/gluestack-ui/LICENSE`) | Cần giao diện native thuần từng nền tảng → dùng SwiftUI/Compose |
| App Flutter | **flutter/samples** (BSD-3): `material_3_demo`, `cupertino_gallery`, `compass_app`, `navigation_and_routing` | `flutter_adaptive_scaffold` **đã discontinued** trên pub.dev và không nêu gói thay thế chính thức: tự dựng list-detail bằng `LayoutBuilder`/`NavigationRail` | Best-Flutter-UI-Templates (5 app demo, không kiến trúc) chỉ để tham khảo giao diện |
| Chuẩn layout thích ứng | Material 3 canonical layouts (list-detail, supporting pane, feed) và Apple HIG Layout | Breakpoint và size class: [`UX-RESP-021`](../06-design-ux/responsive-and-mobile-first.md) | — |
| Cảm hứng màn hình thật | Mobbin | Chỉ là ảnh app thật, không có mã hay license để tái sử dụng | Không chép giao diện/asset |

## Checklist

- [ ] `FE-START-001` **SHOULD** Starter/block chép vào repo có `SOURCE` (hoặc `NOTICE`) ghi URL, commit và license; chọn bản có license OSI/rõ ràng. → Kiểm: `python3 .xtemplates/scripts/xt.py vendor-check` exit 0; thư mục chép nguyên có `LICENSE`. · Nguồn: `CMP-LIC-022`; `seeker19110/stored` 06 §7h.2
- [ ] `FE-START-002` **SHOULD** Chỉ giữ phần dự án dùng: kéo từng block thay vì cả starter, bỏ provider/analytics mặc định không dùng (vd Clerk trong starter Next), không để khoá của provider thừa trong `.env.example`. → Kiểm: `knip` (hoặc `depcheck`) không báo gói thừa từ starter; `.env.example` không có biến của provider đã bỏ. · Nguồn: `seeker19110/stored` 06 §7h.3
- [ ] `FE-START-003` **SHOULD** Không lấy mẫu **đã ngừng cập nhật** làm nền: ghi ngày commit cuối và major framework của nguồn trong `SOURCE`; cũ hơn 12 tháng hoặc đã discontinued → chỉ tham khảo, hoặc ADR nêu lý do giữ. → Kiểm: `SOURCE` có ngày commit cuối; ADR cho ngoại lệ. · Nguồn: pub.dev `flutter_adaptive_scaffold` (discontinued, đọc 2026-10-18); `seeker19110/stored` 06 §7h.2 (Tremor Blocks 1/2025, Flowbite Admin 3/2025)
- [ ] `FE-START-004` **SHOULD** Layout chép về **đi qua cổng của dự án trước khi merge**: thay token mẫu bằng token thật (không hex rải rác, `UX-DS-002`), `xt.py contrast` xanh hai theme, `verify-render`/axe 0 vi phạm, không `outline: none` thừa. → Kiểm: PR đưa starter vào có log `xt.py contrast` exit 0 và kết quả axe; E2E mobile + desktop (`UX-RESP-008`). · Nguồn: `seeker19110/stored` 06 §7g.1 (không bộ skill/starter nào tự có cổng đo bản render)
- [ ] `FE-START-005` **MAY** Dùng thư viện ảnh chụp app thật (Mobbin…) làm tham khảo bố cục: không chép giao diện, logo, asset hay văn bản — không có license tái sử dụng. → Kiểm: review PR: không file ảnh/asset lấy từ thư viện tham khảo. · Nguồn: `seeker19110/stored` 06 §7h.1

## Bẫy thường gặp

- **Starter "miễn phí" nhưng trang hoàn chỉnh trả phí**: Preline (theo stored 2026-10-18, chưa tự đếm lại: 204 block trên trang web, trong repo chỉ 29 plugin JS + 5 template), Flowbite Blocks, daisyUI store, TailAdmin Pro — kiểm số block thật trong repo trước khi hứa tiến độ.
- **License khác nhau giữa các phần của cùng một tổ chức**: Once UI core MIT nhưng `magic-portfolio` CC BY-NC; Tremor component Apache-2.0, repo blocks MIT.
- **Mẫu đẹp, token xấu**: bộ style mẫu có màu primary không đạt 4,5:1 với chữ trắng (stored: 40/67) — chạy `xt.py contrast` trước khi chép màu.
- **Layout chọn theo thiết bị**: `UIDevice`/`Build.MODEL` để chọn bố cục vỡ trên máy gập, split-screen, iPad đa cửa sổ — dùng size class/window size class (`UX-RESP-021`).

## Cổng tự động

| Công cụ | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| `xt.py vendor-check` (khung kèm sẵn) | `python3 .xtemplates/scripts/xt.py vendor-check --strict` | CI job `quality` | exit 0 |
| `xt.py contrast` | `python3 .xtemplates/scripts/xt.py contrast src/theme.css` | CI job `quality` | exit 0 |
| `verify-render.mjs` (mẫu ở `framework/templates/ui-gates/`) | `node scripts/verify-render.mjs <url>…` | CI E2E | exit 0 |
| knip (`FE-BUILD`) / depcheck | `npx knip` | CI | 0 gói thừa từ starter |

## Nguồn

- `seeker19110/stored` mục 06 §7h (layout mẫu cho web, dashboard, mobile; clone 21 repo ngày 2026-10-18, đếm bằng `git ls-tree`), §7g, §7d — đọc 2026-10-18; ghi chép và các điều chưa xác minh: [`research/2026-10-18-stored-ui-extraction.md`](../../research/2026-10-18-stored-ui-extraction.md).
- shadcn/ui registry `new-york-v4`: `dashboard-01`, `sidebar-07` HTTP 200 (<https://ui.shadcn.com/r/styles/new-york-v4/sidebar-07.json>, <https://ui.shadcn.com/r/styles/new-york-v4/dashboard-01.json>); npm `shadcn` 4.22.0 (MIT) — xác minh 2026-10-18. Cú pháp `npx shadcn add <block>` chưa đọc được từ docs (`/docs/blocks` trả 404) — (chưa xác minh).
- pub.dev `flutter_adaptive_scaffold` (discontinued, bản 0.3.3+1): <https://pub.dev/packages/flutter_adaptive_scaffold> — xác minh 2026-10-18.
- LICENSE đọc 2026-10-18: Preline `05ca599` (dual MIT + Fair Use License), once-ui-system/magic-portfolio `5321e5d` (CC BY-NC 4.0), React Bits `d965399` (MIT + Commons Clause).
- Android Developers — window size classes; Apple HIG — Layout: xem nguồn của [`UX-RESP-021`](../06-design-ux/responsive-and-mobile-first.md).
- Trạng thái bán Tailwind Plus cho khách mới: (chưa xác minh) — `tailwindcss.com/plus` chỉ trả trang đăng nhập khi đọc 2026-10-18; các bài thứ cấp nói ngừng nhận khách mới từ 9/9/2026 chưa đối chiếu với nguồn chính.
