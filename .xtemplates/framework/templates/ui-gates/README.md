---
title: Mẫu cổng render UI (Playwright + axe)
kind: template
updated: 2026-10-18
---

# Mẫu cổng render UI

> Cổng **đo trên bản render thật** (không đọc CSS) cho dự án có giao diện web: axe-core theo tag WCAG 2.2, tràn ngang ở
> 320 px và 280 px, tương phản chữ của điều khiển ở trạng thái mặc định / hover / focus. Bổ sung cho `xt.py contrast`
> (đọc token) — token đạt chưa chắc bản render đạt (nền ảnh, lớp phủ, hover nhạt hơn nền). Mục tiêu:
> [`UX-A11Y-001`](../../06-design-ux/accessibility.md), `UX-A11Y-013`, `UX-A11Y-028`, `UX-A11Y-029`.

| File | Việc |
|---|---|
| `verify-render.mjs` | Chạy `node verify-render.mjs <url\|file.html>… [--widths 320,280] [--limit 60] [--tags …] [--strict]`; exit 0 đạt · 1 vi phạm (hoặc UNMEASURED khi `--strict`) · 2 không chạy được (goto lỗi, không mở được Chromium) |

## Cách dùng

1. Chép `verify-render.mjs` vào `scripts/` của dự án (không chạy thẳng từ `.xtemplates/`: `import` cần `node_modules` của dự án).
2. `npm i -D playwright@1.64.0 @axe-core/playwright@4.13.0` (ghim exact) rồi `npx playwright install chromium` trong CI.
   Sandbox đã có Chromium khác bản Playwright: đặt `XT_CHROMIUM=/đường/dẫn/chromium` thay vì cài lại.
3. Thêm vào CI sau bước build/dev-server: `node scripts/verify-render.mjs http://localhost:3000/ http://localhost:3000/login`
   (mỗi trang chính, cả trạng thái lỗi/dialog — `UX-A11Y-001`).
4. Phép đo không thực hiện được — nền ảnh/gradient, điều khiển bị che nên không hover được — in `UNMEASURED` và dòng kết quả không ghi "đạt"; mặc định exit 0, thêm `--strict` để đỏ. Đo tay và ghi vào PR.

## Giới hạn đã biết

- Đo chữ của `a[href]`, `button`, `input`, `select`, `textarea`, `[role=button]`, `[tabindex]` (mặc định 60 phần tử đầu mỗi
  trang, `--limit`); không đo viền/icon (≥ 3:1) — dùng `xt.py contrast --pairs` cho token viền và axe cho phần còn lại.
- Trạng thái `disabled` được miễn (WCAG 1.4.3); `active`/`selected` chưa đo.
- `--widths 280` là phép thử căng, **không phải chuẩn** (chuẩn là reflow 320 px, WCAG 2.2 SC 1.4.10).
- Mã tự viết cho khung; ý "cổng đo trên bản render" tham khảo `plugin87/ux-ui-agent-skills` (MIT) qua stored 06 §7d — không chép mã.
  Bản đó chạy `chromium.launch({ channel: 'chrome' })` nên thất bại ở máy không có Chrome; mẫu này dùng Chromium của Playwright.
