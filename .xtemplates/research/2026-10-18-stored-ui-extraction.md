---
title: Trích xuất đề xuất UI từ stored (06 §7c, §7d, §7g, §7h) — đối chiếu ba cột
kind: method
updated: 2026-10-18
---

# Trích xuất đề xuất UI từ catalog stored (đợt 2026-10-18)

Bổ sung cho [`2026-10-18-stored-delta-extraction.md`](2026-10-18-stored-delta-extraction.md). Nguồn: `seeker19110/stored`
mục 06 §7c (DESIGN.md), §7d (XIAS), §7g (bốn skill UI), §7h (layout mẫu), HEAD `907febf`. Đối chiếu từng đề xuất với
khung theo ba cột (WORKFLOW): **có và sâu hơn** · **có nhưng nông hơn** · **chưa có**. Dữ kiện nguồn ngoài xác minh lại từ
nguồn sống 2026-10-18 (mức F = đọc trực tiếp nguồn gốc).

## 1. Ba cột

| Đề xuất | Trước đợt này | Cột | Việc làm |
|---|---|---|---|
| A1 Kiểm tương phản token trong CI | `UX-DS-003` (MUST) đã đòi `check:contrast` nhưng **không kèm công cụ** ("script tự viết") | nông hơn | `xt.py contrast` (stdlib, đọc CSS token, mọi theme, không làm tròn lên, không cặp nào = đỏ) + sửa `Kiểm` của `UX-DS-003/011`, `UX-A11Y-002` |
| A2 Bắt buộc token `on-primary`/`action-text` | không có (`UX-DS-012` chỉ nói bộ token trạng thái) | chưa có | `UX-DS-020` (MUST@L) + `xt.py contrast` đỏ khi `--primary`/`--destructive` thiếu token chữ |
| A3 Lint `DESIGN.md` theo spec Google | không có | chưa có | `UX-DS-021` (SHOULD). Đã chạy thử `@google/design.md@0.4.0 lint`: tương phản chỉ là **cảnh báo** (exit 0) nên Kiểm đọc `summary` |
| A4 Cổng render XIAS: `verify_states` | `UX-A11Y-028` đã đòi tương phản theo hover/focus/disabled, không có mẫu chạy | nông hơn | `templates/ui-gates/verify-render.mjs` (tự viết, đã chạy trên fixture tốt/xấu) |
| A4 `verify_target_size` | `UX-A11Y-006` + axe `target-size` | **có và sâu hơn/đủ** | giữ; mẫu gọi axe với tag `wcag22aa` |
| A4 `verify_overflow` ở 280 px | `UX-A11Y-013` + `UX-RESP-001` ở 320 px (chuẩn WCAG) | có, 280 là phép thử căng | `UX-A11Y-029` (MAY), nêu rõ không phải chuẩn |
| A4 `axe_audit` | `UX-A11Y-001`, `QA-E2E-003` | **có và sâu hơn** | không thêm |
| A4 `lint_intent` (nút xoá không mang primary) | `UX-DS-019` (MUST@L) | **có** | không thêm |
| B Lớp skill UI (Refactoring UI, `frontend-design`, `ui-ux-pro-max`) | không có; `motion-and-visual-quality.md` nói chống "AI slop" chung | chưa có | `UX-DS-022` + 3 hàng ở bảng *Quyết định* của `design-system-and-tokens.md` |
| C Starter layout theo loại dự án | `design-system-and-tokens.md` chỉ nhắc shadcn/ui | chưa có | module mới `FE-START` (`07-frontend/starter-layouts.md`) |
| C Quy ước breakpoint | `UX-RESP-012` (breakpoint là token) không nêu số theo nền tảng | nông hơn | `UX-RESP-021` |
| D Guard license mã UI vendor | `CMP-LIC-001…004,021` (license phụ thuộc/runtime) nhưng không nói mã chép vào repo | nông hơn | `CMP-LIC-022` + `xt.py vendor-check` + `ui-vendor-watchlist.json` |

## 2. Điều chỉnh so với đề xuất gốc (kết quả xác minh nguồn sống)

- **280 px không gắn với Galaxy Fold.** Không xác nhận được bề rộng cover screen (cả 280 lẫn 320) từ nguồn chính thức; chỉ
  có thread diễn đàn Samsung về Fold đời 1 nêu cả hai số. Chuẩn là reflow 320 px (WCAG 2.2 SC 1.4.10, đọc từ w3.org) →
  280 px hạ thành MAY, ghi "không phải chuẩn".
- **Không vendor mã XIAS.** XIAS (MIT, `plugin87/ux-ui-agent-skills`, HEAD `62092bd`) có `scripts/verify_states.mjs`,
  `verify_target_size.mjs`, `verify_overflow.mjs`; stored §7d.2 ghi kho này chép nhiều dữ liệu từ hai kho MIT khác không ghi
  nguồn, và cổng của nó chạy `chromium.launch({ channel: 'chrome' })` (fail ở máy không có Chrome). Khung **tự viết** mẫu cổng
  render (không chép mã) và chỉ ghi XIAS là nguồn ý tưởng — không có nghĩa vụ giữ ghi chú bản quyền của mã chưa chép.
- **`design.md` lint không chặn tương phản.** `contrast-ratio` và `missing-primary` là *warning* (exit 0); chỉ `broken-ref`
  là *error*. Spec không định nghĩa cặp `primary`/`on-primary` (chỉ nói "ít nhất bảng màu `primary` phải khai báo") — nên quy
  ước token chữ đi kèm (`UX-DS-020`) đặt ở lớp token CSS do `xt.py contrast` kiểm, không phụ thuộc spec đó. Định dạng còn
  `alpha`; npm không khai trường `license` (Apache-2.0 theo file LICENSE trong repo).
- **Material 3 có thêm hai cỡ**: ngoài compact/medium/expanded còn large 1200–1599 dp và extra-large ≥ 1600 dp (phải bật
  `supportLargeAndXLargeWidth`) — đề xuất gốc chỉ có ba cỡ.
- **Tailwind Plus**: không xác minh được "ngừng bán cho khách mới" từ trang chính thức → ghi (chưa xác minh), vẫn đưa vào
  danh sách theo dõi vì license thương mại.
- **Cú pháp lệnh**: `npx shadcn add dashboard-01` — block tồn tại trong registry (HTTP 200) nhưng cú pháp lệnh chưa đọc được
  từ docs (404); lệnh cài plugin `frontend-design` chỉ suy luận từ cấu trúc repo — cả hai ghi (chưa xác minh).

## 3. Dữ kiện đã xác minh (2026-10-18)

| Dữ kiện | Kết quả | Nguồn | Mức |
|---|---|---|---|
| `@google/design.md` | 0.4.0 (2026-07-27); CLI `lint`/`diff`/`export`/`spec`; `lint` exit 1 khi có error; Apache-2.0 theo LICENSE | npm registry; README + LICENSE repo `google-labs-code/design.md` (HEAD `6e5da53`) | F; **đã tự chạy** `lint` trên mẫu: `contrast-ratio` 4,10:1 = warning |
| Window size classes | compact < 600 · medium 600–839 · expanded 840–1199 · large 1200–1599 · XL ≥ 1600 dp | developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes (cập nhật 2026-09-22) | F |
| Apple HIG Layout | "Determine layout based on size classes, not device type or orientation"; không có số safe area iOS | developer.apple.com/design/human-interface-guidelines/layout | F |
| Preline | LICENSE: dual "MIT" + "Preline UI Fair Use License" (© 2026 Preline Labs Ltd); nội dung Fair Use chưa tự đọc | htmlstreamofficial/preline `05ca599` | F |
| magic-portfolio | CC BY-NC 4.0 | once-ui-system/magic-portfolio `5321e5d` | F |
| React Bits | MIT + Commons Clause (© 2026 David Haz) | DavidHDev/react-bits `d965399` | F |
| `flutter_adaptive_scaffold` | discontinued; không nêu gói thay thế chính thức | pub.dev | F |
| `s0xDk/refactoring-ui-skill` | MIT (© 2026 s13k); 1 commit `4887214` 2026-08-27; `assets/tokens.css` còn | GitHub | F |
| `frontend-design` | `anthropics/claude-plugins-official/plugins/frontend-design`, Apache-2.0; `plugin.json` không có `version` | repo (SHA `ea10b21`, 2026-10-15) | F |
| shadcn | `dashboard-01`, `sidebar-07` HTTP 200 ở registry `new-york-v4`; npm `shadcn` 4.22.0 MIT | ui.shadcn.com/r/styles/new-york-v4/*.json; registry.npmjs.org | F |

## 4. Chưa xác minh

- Bề rộng CSS px cover screen của các đời Galaxy Z Fold; trang giá/trạng thái bán Tailwind Plus; nội dung "Preline UI Fair Use
  License"; ngày cập nhật trang Apple HIG Layout; cú pháp lệnh block shadcn và lệnh cài `frontend-design`; gói thay thế
  chính thức cho `flutter_adaptive_scaffold`; hiệu ứng `install.sh`/telemetry của repo bên thứ ba (không chạy mã nào của họ).
- Số sao, số block/trang của §7h lấy từ stored (clone 2026-10-18), chưa tự đếm lại — không đưa số sao vào mục checklist.
