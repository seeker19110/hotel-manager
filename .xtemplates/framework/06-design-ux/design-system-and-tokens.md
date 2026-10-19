---
title: Design system, token, typography, spacing, theme sáng/tối
kind: module
prefix: UX-DS
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-19
---

# Design system, token, typography, spacing, theme sáng/tối

> Mọi giá trị thiết kế (màu, chữ, khoảng cách, bo góc, đổ bóng, thời lượng chuyển động) là **design token có tên ngữ nghĩa**,
> sống ở **một nguồn sự thật** và được kiểm bằng máy. Theme sáng/tối chỉ là hai tập giá trị của cùng một bộ token.
> Áp dụng cho mọi hồ sơ có giao diện; không có UI thì bỏ qua.

## Nguyên tắc

1. **Ba tầng token, component chỉ dùng tầng ngữ nghĩa.** Tầng *primitive* (`blue-600`, `space-4`) → tầng *semantic*
   (`color.bg.surface`, `color.text.muted`, `space.inset.md`) → tầng *component* (`button.primary.bg`). Component không bao giờ
   gọi thẳng primitive; đổi theme là đổi ánh xạ semantic → primitive.
2. **Một file gốc, mọi nền tảng sinh ra.** Token gốc ở định dạng W3C Design Tokens (DTCG 2025.10) hoặc file CSS/JSON do
   dự án chọn; CSS variables, Tailwind `@theme`, Swift/Kotlin/Compose đều **sinh** từ đó (P5). Không chép tay.
3. **Thang có hệ, không số lẻ.** Spacing theo bội số một đơn vị gốc (vd 4 px), type scale theo tỷ lệ cố định, radius/elevation
   3–5 bậc. Giá trị không nằm trong thang → không được dùng (máy chặn).
4. **Theme là dữ liệu, không phải nhánh code.** Dark/light đổi bằng thuộc tính (`data-theme`) hoặc `prefers-color-scheme`,
   không bằng `if (dark)` rải trong component.
5. **Tương phản là cổng máy, không phải cảm giác.** Mọi cặp nền/chữ trong token được tính tỷ lệ tương phản tự động ở **cả
   hai theme** trước khi merge (ngưỡng ở [`accessibility.md`](accessibility.md)).
6. **Font phải có glyph tiếng Việt.** Chọn font có subset `vietnamese`; fallback stack cũng phải hiển thị đủ dấu.

## Quyết định

| Câu hỏi | Chọn | Khi nào | Không dùng khi |
|---|---|---|---|
| Định dạng token gốc | **DTCG JSON 2025.10** + Style Dictionary 5.6.1 sinh CSS/Swift/Kotlin | Đa nền tảng (web + mobile), có designer dùng Penpot/Figma | Chỉ một web app nhỏ → CSS variables thuần trong một file `theme.css` là đủ |
| Nối token vào Tailwind 4.3.3 | `@theme inline { --color-surface: var(--surface) }` | Token đổi lúc chạy theo `data-theme` | `@theme` (không `inline`) khi giá trị cố định, không đổi theme |
| Theme mặc định | Theo hệ điều hành (`prefers-color-scheme`) + cho người dùng ghi đè (`data-theme`, lưu lại) | Ứng dụng đại chúng | Sản phẩm thương hiệu bắt buộc một theme → cố định, vẫn giữ `color-scheme` đúng |
| Thư viện component web (React) | shadcn/ui 4.21.4 trên Base UI 1.9.0 (MIT, copy-source) | Dự án mới cần kiểm soát mã và token | Enterprise cần bộ đầy đủ sẵn → MUI 9.5.0 / Mantine 9.7.2; Vue → Vuetify; headless đa framework → Ark UI 5.39.3 |
| Mobile native | Token hệ thống của nền tảng (Dynamic Type, Material 3 color roles) ánh xạ từ token gốc | App native | Không bỏ Dynamic Type/font scale để "giữ layout" |
| Công cụ thiết kế | Penpot (MPL-2.0, self-host, có design tokens) | Cần OSS, dữ liệu nội bộ | Đội đã có Figma → giữ, nhưng token vẫn xuất về repo |
| Tài liệu component | Storybook 10.6.2 | Có ≥ 10 component dùng chung | Site tĩnh vài trang → không cần |
| Token khởi đầu + thang giá trị | `s0xDk/refactoring-ui-skill` (MIT): `SKILL.md` + `assets/tokens.css` — light mode đã tính lại khớp chú thích; **dark mode chưa kiểm** | Cần điểm xuất phát có thang spacing/type/màu hợp lý | Đã có design system → không chép; luôn chạy `xt.py contrast` hai theme trước khi dùng; repo chỉ 1 tác giả/1 commit — ghim SHA, chép vào repo kèm `SOURCE` |
| Hướng thẩm mỹ, chống "AI slop" | `frontend-design` của Anthropic (Apache-2.0) từ marketplace `claude-plugins-official` | Giao diện mới cần cá tính, tránh mặc định chung | Không thay cổng máy; không vendor bản sao (tự cập nhật qua plugin, theo dõi bằng SHA vì không có `version`); lệnh cài ghi theo hướng dẫn của marketplace (chưa xác minh cú pháp) |
| Lọc văn bản marketing và comment code | `antislop-copywriting` và `antislop-code` (chỉ sửa comment) của `miqdadbadjuber/anti-slop` (MIT, v3.2.21) | Agent viết nội dung trang/microcopy, hoặc comment sinh kèm code | Chép **riêng** hai skill này vào `.claude/skills/` kèm `LICENSE` + `SOURCE.md`; **không** nạp skill lõi `antislop` (~58 KB, "Load always") khi đã dùng `frontend-design`; phiên không người trông đặt chế độ trước (`npx antislop-ai --mode during`) vì mặc định agent dừng hỏi; bộ này ghi "chữ lớn = 18px+" là **sai** (`UX-A11Y-002`) |
| Gợi ý palette/font theo loại sản phẩm | `ui-ux-pro-max-skill` (MIT) | Cần ý tưởng ban đầu | Chỉ gợi ý; kết quả qua `xt.py contrast`; không vendor dữ liệu CSV của kho (lớn, trùng lặp) |

## Checklist

- [ ] `UX-DS-001` **MUST** Token gốc nằm ở đúng một file/thư mục trong repo (DTCG JSON hoặc `theme.css`); mọi đầu ra khác được sinh bằng script. → Kiểm: lệnh `build:tokens` chạy trong CI; diff đầu ra sinh = 0 sau khi chạy lại. · Nguồn: DTCG 2025.10
- [ ] `UX-DS-002` **MUST** Component không hard-code mã màu (`#hex`, `rgb()`, tên màu) hay class màu primitive (`bg-blue-500`); chỉ dùng token ngữ nghĩa. → Kiểm: stylelint `color-no-hex` + script `check:hex-hardcode` (grep `#[0-9a-fA-F]{3,8}` trong `src/components`) = 0 kết quả. · Nguồn: WCAG 2.2 SC 1.4.3 (gián tiếp)
- [ ] `UX-DS-003` **MUST** Mọi cặp nền/chữ và nền/viền-điều-khiển trong bộ token đạt tương phản AA ở **cả hai theme**. → Kiểm: `python3 .xtemplates/scripts/xt.py contrast <theme.css> [--pairs contrast-pairs.txt]` exit 0 — đọc custom properties `:root` và `.dark`/`[data-theme=dark]`/`prefers-color-scheme: dark`, tự suy cặp (`--X-foreground`/`--on-X` trên `--X`, `--foreground` trên `--background`, `--ring` ≥ 3:1), cặp khác khai ở `--pairs`; chữ < 4,5:1 hoặc phi văn bản < 3:1 → đỏ (không làm tròn lên), không có cặp nào để kiểm cũng đỏ; đọc cả thân `@theme`/`@theme inline` của Tailwind v4; token gốc là DTCG JSON thì chạy trên CSS đã sinh (`UX-DS-001`). · Nguồn: WCAG 2.2 SC 1.4.3, 1.4.11
- [ ] `UX-DS-004` **MUST@L** Theme được đặt trước khi trang vẽ lần đầu (không "nháy" theme): script đồng bộ trong `<head>` đọc lựa chọn đã lưu, kèm `color-scheme` tương ứng. → Kiểm: Playwright chụp frame đầu sau `goto` với `data-theme=dark` đã lưu; màu nền khớp token dark. · Nguồn: MDN `prefers-color-scheme`
- [ ] `UX-DS-005` **MUST@L** Thang spacing, type, radius, elevation, duration khai báo thành token; không có giá trị ngoài thang trong CSS component. → Kiểm: stylelint `declaration-property-value-allowed-list` (hoặc `scale-unlimited/declaration-strict-value`) cho `margin|padding|gap|font-size|border-radius|box-shadow`. · Nguồn: DTCG 2025.10
- [ ] `UX-DS-006` **MUST** Font chính có subset tiếng Việt (`unicode-range` U+1EA0–1EF9, U+0102–0103, U+0110–0111, U+01A0–01B0…) và fallback stack hiển thị đủ dấu. → Kiểm: E2E render chuỗi "Tiếng Việt có dấu: ắ ầ ẩ ẫ ậ ờ ỡ ợ ừ ữ ự" chụp ảnh so với baseline; không ô vuông/tofu. · Nguồn: MDN `unicode-range`
- [ ] `UX-DS-007` **MUST@L** Lựa chọn theme của người dùng được nhớ (storage hoặc hồ sơ) và không gửi theme kèm dữ liệu cá nhân cho bên thứ ba. → Kiểm: E2E đổi theme → reload → giữ nguyên; rà script analytics không gửi `theme`. · Nguồn: khung cũ `quality-supplements.md` PHẦN 3
- [ ] `UX-DS-008` **SHOULD** Theo lựa chọn hệ điều hành khi người dùng chưa tự chọn (`@media (prefers-color-scheme)` + `:root:not([data-theme])`). → Kiểm: Playwright `emulateMedia({ colorScheme: 'dark' })` → nền tối khi chưa có lựa chọn lưu. · Nguồn: MDN `prefers-color-scheme`
- [ ] `UX-DS-009` **SHOULD** Đặt `<meta name="color-scheme" content="light dark">` và `color-scheme` trên `:root` để form control, scrollbar, nền mặc định của trình duyệt khớp theme. → Kiểm: grep `color-scheme` trong layout gốc và `theme.css`. · Nguồn: MDN `prefers-color-scheme` (mục embedded elements)
- [ ] `UX-DS-010` **SHOULD** Tên token mô tả **vai trò**, không mô tả giá trị (`color.text.danger`, không `color.red`). → Kiểm: script lint tên token theo regex `^(color|space|font|radius|shadow|motion)\.[a-z-]+(\.[a-z-]+)+$` và danh sách từ cấm (`red|blue|dark|light`) ở tầng semantic.
- [ ] `UX-DS-011` **SHOULD** Viền focus (`--ring`) là token riêng, tương phản ≥ 3:1 với nền ở cả hai theme. → Kiểm: `xt.py contrast` (tự suy cặp `--ring` trên `--background` ≥ 3:1, cả hai theme). · Nguồn: WCAG 2.2 SC 1.4.11, 2.4.7
- [ ] `UX-DS-012` **SHOULD** Trạng thái (success/warning/danger/info) có đủ bộ token nền + chữ + viền; không truyền tải ý nghĩa chỉ bằng màu (kèm icon/chữ). → Kiểm: review Storybook story `Status`; axe rule `color-contrast` không vi phạm. · Nguồn: WCAG 2.2 SC 1.4.1
- [ ] `UX-DS-013` **SHOULD** Mỗi component dùng chung có story trong Storybook với đủ biến thể và cả hai theme (toolbar đổi `data-theme`). → Kiểm: `storybook build` xanh; số story ≥ số component trong `src/components/ui`.
- [ ] `UX-DS-014` **SHOULD** Thay đổi token đi qua PR riêng, có ảnh trước/sau (visual regression) và ghi `CHANGELOG`. → Kiểm: PR đổi `tokens/` phải kèm cập nhật snapshot ảnh (CI fail nếu snapshot lệch chưa duyệt).
- [ ] `UX-DS-015` **SHOULD** Token sinh cho mobile native (Swift/Kotlin/Compose) từ cùng file gốc; không có hằng màu viết tay trong mã native. → Kiểm: grep `UIColor(red:|Color(0x` ngoài thư mục sinh = 0.
- [ ] `UX-DS-016` **MAY** Dùng Style Dictionary (Apache-2.0) làm bộ sinh; ghim phiên bản trong lockfile. → Kiểm: `package.json` có `style-dictionary` ghim exact.
- [ ] `UX-DS-017` **MAY** Hỗ trợ `prefers-contrast: more` bằng bộ token tương phản cao. → Kiểm: `emulateMedia({ contrast: 'more' })` đổi token.
- [ ] `UX-DS-018` **MAY** Xuất token sang Penpot/Figma để designer và dev cùng một bộ. → Kiểm: file token được import trong dự án thiết kế; ngày đồng bộ ghi trong `docs/`.
- [ ] `UX-DS-019` **MUST@L** Mã UI (nhất là do agent sinh) dùng component của design system khi đã có component tương ứng; không import primitive headless (Radix, Base UI…) ngoài thư mục `components/ui/**`; biến thể theo ý định được khai bằng luật lint (hành động phá huỷ dùng `destructive`, không `primary`). → Kiểm: ESLint `no-restricted-imports` (primitive headless) + `react/forbid-elements` cho `button|input|select|dialog` ngoài thư mục ui + luật ý định; CI 0 lỗi. · Nguồn: stored 06 §7f (Zen DS: 205 luật usage, `guidelines:check`, `usage:check`), §7d (XIAS `lint_intent`)
- [ ] `UX-DS-020` **MUST@L** Mỗi token **nền hành động** (`primary`, `destructive`…) có token **chữ đi kèm** (`--on-primary` hoặc `--primary-foreground`), và component dùng token đó — không đặt chữ `white`/`#fff`/`text-white` trực tiếp lên nền token. → Kiểm: `xt.py contrast` đỏ khi `--primary`/`--destructive` thiếu token chữ (đổi danh sách bằng `--require-on`; bộ shadcn mặc định không khai `--destructive-foreground` — khai thêm hoặc chạy `--require-on primary`) và khi cặp chữ/nền dưới 4,5:1; grep `text-white|color:\s*(#fff|white)` trong `src/components` = 0 (ngoại lệ ghi lý do). · Nguồn: WCAG 2.2 SC 1.4.3; `seeker19110/stored` 06 §7c.3 (Ant Design: nút chính chữ trắng trên `#1677ff` = 4,10:1) và §7g.1 (40/67 màu primary của một bộ 67 style không đạt 4,5:1 với chữ trắng), đọc 2026-10-18
- [ ] `UX-DS-021` **SHOULD** Repo có `DESIGN.md` (hệ thiết kế viết cho agent đọc) thì theo spec `google-labs-code/design.md` — YAML front matter với `colors:`, `typography:`, `components:` (`backgroundColor`/`textColor` tham chiếu `{colors.x}`) — và lint trong CI bằng bản ghim. `lint` thoát 0 khi chỉ có cảnh báo, mà tương phản (`contrast-ratio`) và thiếu `primary` chỉ là cảnh báo nên phải đọc `summary` của JSON đầu ra và đỏ khi `errors` hoặc `warnings` > 0. → Kiểm: `npx --yes @google/design.md@0.4.0 lint DESIGN.md > lint.json; node -e 'const s=require("./lint.json").summary;process.exit(s.errors+s.warnings?1:0)'` exit 0. · Nguồn: <https://github.com/google-labs-code/design.md> (Apache-2.0 theo file LICENSE; npm `0.4.0` 2026-07-27; định dạng còn `alpha`); đã chạy thử 2026-10-18: `contrast-ratio` 4,10:1 → cảnh báo, `broken-ref` → lỗi, exit 1 chỉ khi có lỗi
- [ ] `UX-DS-022` **SHOULD** Skill/plugin định hướng thẩm mỹ (`frontend-design`, Refactoring UI Skill, `ui-ux-pro-max`…) chỉ **gợi ý đầu vào**, không thay cổng: lấy bản chính chủ cập nhật được (plugin của marketplace, ghim commit) thay vì vendor bản sao; token khởi đầu chép từ skill được đo lại bằng `xt.py contrast` ở **cả hai theme** trước khi dùng; palette/font gợi ý từ kho tra cứu phải qua cùng cổng. Skill chép vào `.claude/skills/` có `LICENSE` của repo gốc và `SOURCE.md` ghi repo, commit, ngày, `License:`; skill có câu hỏi chặn phiên (chọn chế độ…) được đặt sẵn trước khi chạy tự động; ngưỡng tương phản trong skill phải khớp WCAG (chữ lớn ≥ 24 px hoặc ≥ 18,66 px đậm). → Kiểm: `xt.py contrast` xanh trên token khởi đầu của dự án; `python3 .xtemplates/scripts/xt.py vendor-check --dirs .claude/skills [--own <skill tự viết>] --strict` exit 0 (skill của khung trong manifest được bỏ qua). · Nguồn: `seeker19110/stored` 06 §7g (Refactoring UI Skill `s0xDk`: light mode khớp chú thích, dark mode chưa kiểm — MIT, 1 commit 2026-08-27; `frontend-design`: Apache-2.0, `anthropics/claude-plugins-official`, `plugin.json` không có trường version nên theo dõi bằng SHA); xem [bảng chọn](#quyết-định)

## Bẫy thường gặp

- **Hai tầng token** (primitive → component) khiến đổi theme phải sửa từng component. Thêm tầng semantic ngay từ đầu.
- **Dark mode = đảo màu.** Nền tối cần surface có bậc nổi (surface/elevated), chữ phụ giảm độ sáng, bóng đổ thay bằng viền.
  Tính lại tương phản cho dark riêng; nhiều màu "thương hiệu" đạt AA trên trắng nhưng không đạt trên tối (vd xanh dương đậm).
- **Theme flash khi tải:** đặt theme trong `useEffect`/sau hydrate → nháy trắng rồi tối. Script phải chạy đồng bộ trong `<head>`.
- **`@theme` thay vì `@theme inline`** trong Tailwind 4: giá trị bị "nướng cứng" lúc build, `data-theme` không có tác dụng.
- **Kiểm tương phản chỉ trên `background`** nhưng chữ thực tế nằm trên `surface-elevated`/`accent` → vi phạm không thấy. Kiểm theo
  **ma trận** nền × chữ thực có dùng.
- **Font không có dấu tiếng Việt** (hoặc chỉ tải subset latin) → chữ "ỡ, ậ" rơi về font fallback khác hình. Khai báo subset
  `vietnamese` và kiểm bằng ảnh.
- **Token đặt tên theo màu** (`--blue-500` trong button) → đổi thương hiệu phải đổi tên khắp nơi.
- **Hai nguồn sự thật**: designer sửa trong Figma, dev sửa trong CSS, không ai đồng bộ. Chốt một chiều: repo là gốc, công cụ thiết kế import.
- **Chữ trắng mặc định trên màu primary**: agent và bộ style mẫu hay đặt `text-white` lên màu thương hiệu mà không tính tỷ lệ (Ant Design 4,10:1; 40/67 primary của một bộ style mẫu không đạt). Có token `on-primary` riêng và để `xt.py contrast` kiểm (`UX-DS-020`).
- **Nạp cả bộ luật "chống AI slop" vào mọi phiên**: skill lõi `antislop` ~58 KB (~14k token) nạp mọi lúc, trùng việc với `frontend-design`; chỉ lấy phần ít bộ khác phủ (văn bản, comment code) và giữ cổng máy làm chốt (`UX-DS-022`).
- **Đọc huy hiệu skill là bằng chứng chất lượng**: "Skills 32K" của antislop là tổng lượt cài 6 skill (cài cả bộ một lần), không phải số người dùng; số sao/lượt cài không thay việc tự chạy cổng của chính repo.
- **Agent dựng nút/hộp thoại từ primitive hoặc thẻ gốc** (`<button>`, `Dialog` của Radix import thẳng) vì "nhanh hơn" → lệch biến thể, focus, a11y so với component chuẩn; nút xoá mang màu `primary`. Tránh: luật lint cấm import/thẻ ngoài `components/ui/**` và luật ý định (`UX-DS-019`).

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| stylelint 17.16.0 (MIT) + `color-no-hex`, `declaration-property-value-allowed-list` | `stylelint "src/**/*.css"` | pre-commit + CI | 0 lỗi |
| `xt.py contrast` (stdlib Python, khung kèm sẵn; đọc CSS token, công thức WCAG) | `python3 .xtemplates/scripts/xt.py contrast src/theme.css --pairs contrast-pairs.txt` | CI job `quality` | mọi cặp ≥ 4.5:1 chữ / ≥ 3:1 phi văn bản, cả 2 theme; token nền hành động có token chữ (`UX-DS-020`) |
| `@google/design.md` 0.4.0 (Apache-2.0, định dạng alpha) | `npx --yes @google/design.md@0.4.0 lint DESIGN.md` + đọc `summary` | CI (nếu có `DESIGN.md`) | `errors` = 0 và `warnings` = 0 (`UX-DS-021`) |
| Script `check:hex-hardcode` (grep) | `rg -n '#[0-9a-fA-F]{3,8}\b' src/components` | pre-commit | 0 kết quả ngoài `tokens/` |
| Style Dictionary 5.6.1 (Apache-2.0) | `style-dictionary build` rồi `git diff --exit-code` | CI | đầu ra sinh không lệch |
| Storybook 10.6.2 (MIT) + `@storybook/addon-a11y` 10.6.2 | `storybook build` · `vitest --project=storybook` | CI | build xanh; a11y 0 vi phạm |
| Playwright 1.64.0 (Apache-2.0) | test no-flash + ảnh chuỗi tiếng Việt + `emulateMedia` | CI E2E | ảnh khớp baseline |
| axe-core 4.14.0 (MPL-2.0) qua `@axe-core/playwright` | quét `color-contrast` ở cả hai theme | CI E2E | 0 vi phạm |
| ESLint (`no-restricted-imports`, `react/forbid-elements`) + luật ý định tự viết | `eslint . --max-warnings 0` | CI | 0 lỗi; fixture xấu phải đỏ (`QA-STATIC-021`) |

Cách kiểm theme sáng/tối ở zoom lớn và chống "AI slop" → [`motion-and-visual-quality.md`](motion-and-visual-quality.md).
Ngưỡng và cách chứng minh a11y → [`accessibility.md`](accessibility.md). Hiệu năng font (`font-display`, preload) →
[`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md).

## Nguồn

- W3C Design Tokens Community Group — Design Tokens Specification 2025.10 (final, 28/10/2025): <https://www.designtokens.org/tr/2025.10/> và <https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/> — xác minh 2026-10-13.
- WCAG 2.2 (W3C Recommendation 05/10/2023, bản cập nhật 12/12/2024) SC 1.4.1, 1.4.3, 1.4.11, 2.4.7: <https://www.w3.org/TR/WCAG22/> — xác minh 2026-10-13.
- MDN `prefers-color-scheme` (giá trị, `color-scheme` cho embedded content): <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme> — xác minh 2026-10-13.
- MDN `unicode-range` (subset font theo dải ký tự): <https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/unicode-range> — xác minh 2026-10-13.
- Tailwind CSS v4.3 — `@theme` vs `@theme inline`: <https://tailwindcss.com/docs/theme> — xác minh 2026-10-13.
- Phiên bản npm `latest` (registry.npmjs.org, 2026-10-13): tailwindcss 4.3.3 · shadcn 4.21.4 · @base-ui/react 1.9.0 · @mui/material 9.5.0 · @mantine/core 9.7.2 · @ark-ui/react 5.39.3 · storybook 10.6.2 · stylelint 17.16.0 · style-dictionary 5.6.1 · axe-core 4.14.0 · @playwright/test 1.64.0. Penpot: license MPL-2.0 (README GitHub, xác minh 2026-10-13); phiên bản mới nhất **(chưa xác minh)**.
- Khung cũ X-stored commit `1b80fe4`: `styles/theme.css` (bộ token dark-blue/light, `--ring`, no-flash) và `docs/framework/quality-supplements.md` PHẦN 3.
- Catalog `seeker19110/stored` mục 06 §1 (shadcn/ui + Base UI, Storybook), §2 (Penpot), đọc 2026-10-13; `research/2026-10-13-stored-catalog-extraction.md` §2.12.
- Catalog `seeker19110/stored` mục 06 §7c.3 (linter `@google/design.md` 0.4.0 chấm 11 `DESIGN.md`: 1/11 sạch), §7g (skill UI), §7h (layout mẫu), đọc 2026-10-18; xác minh nguồn sống 2026-10-18: npm `@google/design.md` 0.4.0 (<https://registry.npmjs.org/@google%2fdesign.md>), LICENSE Apache-2.0 (<https://raw.githubusercontent.com/google-labs-code/design.md/main/LICENSE>), `anthropics/claude-plugins-official` (SHA `ea10b21`, 2026-10-15), `s0xDk/refactoring-ui-skill` (MIT, commit `4887214` 2026-08-27); ghi chép: [`research/2026-10-18-stored-ui-extraction.md`](../../research/2026-10-18-stored-ui-extraction.md).
- Catalog `seeker19110/stored` mục 06 §7i (`miqdadbadjuber/anti-slop`: MIT, v3.2.21, HEAD `439a2ef` 2026-10-16; 6 skill, lõi ~58 KB "Load always"; mặc định hỏi chế độ DURING/AFTER mỗi phiên; ghi chữ lớn "18px+" trái WCAG; skills.sh 32,0K = tổng lượt cài 6 skill), §4 (skill "taste" chỉ bền khi có cổng máy đi kèm), đọc 2026-10-19; ghi chép: [`research/2026-10-19-stored-ui-7i.md`](../../research/2026-10-19-stored-ui-7i.md).
- Catalog `seeker19110/stored` mục 06 §7f (Zen Design System: 205 luật dùng component kiểm bằng máy, có plugin ESLint; `guidelines:check`, `usage:check`, self-test mỗi luật), §7d (XIAS: `lint_intent.mjs` — nút xoá không được mang màu primary) — đọc 2026-10-16.
