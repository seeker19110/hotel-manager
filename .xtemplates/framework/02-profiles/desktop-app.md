---
title: Ứng dụng desktop (Electron/Tauri/native)
kind: profile
slug: desktop-app
prefix: PRF-DESK
modules: [04-standards/*, 05-architecture/*, 06-design-ux/*, 07-frontend/*, 08-backend/*, 09-database/*, 10-workflow/*, 11-autonomous-loop/*, 12-security/*, 14-testing-quality/*, 15-operations/*, 16-compliance-privacy/*, 17-product-project/*, 18-cross-cutting/*]
updated: 2026-10-13
---

# Hồ sơ: Ứng dụng desktop (Electron/Tauri/native)

> App cài trên Windows/macOS/Linux, chạy với **quyền của người dùng trên máy thật**: truy cập hệ thống tệp,
> phần cứng, mạng nội bộ. Bốn việc web không có: **ký mã** (Authenticode/notarization), **auto-update an toàn**,
> **sandbox/IPC** giữa UI và hệ thống, **đóng gói** cho từng OS.

## Khi nào dùng

- Cần truy cập tệp cục bộ sâu, phần cứng (USB, serial, máy in), chạy nền/tray, offline hoàn toàn, hoặc tích hợp OS (menu, shortcut toàn cục, giao thức tùy chỉnh).
- Người dùng doanh nghiệp cài qua MSI/pkg/AppImage; không muốn phụ thuộc trình duyệt.
- Không dùng khi web app + PWA đủ → [`web-app.md`](web-app.md); công cụ không cần UI → [`cli-tool.md`](cli-tool.md).

## Kiến trúc tham chiếu (C4 mức 1)

```text
[Người dùng] → [App desktop]
   ├─ Process UI (WebView/renderer): KHÔNG có quyền hệ thống, CSP chặt, sandbox bật
   │      │ IPC có allowlist lệnh + kiểm tham số (capabilities / contextBridge)
   ├─ Process lõi (Rust/Node main/native): tệp, mạng, keychain, tiến trình con
   ├─ Updater: tải manifest có ký → xác minh chữ ký → cài → khởi động lại
   └─ Crash/telemetry (opt-in) → [Dịch vụ error tracking]
Phân phối: CI build theo OS → ký (Authenticode / Developer ID + notarize) → cài đặt (MSI/MSIX, dmg/pkg, AppImage/deb/rpm) → feed update
```

- Ranh giới tin cậy: nội dung web/remote trong WebView là **không tin cậy**; chỉ process lõi được gọi API hệ thống qua IPC có allowlist (Tauri capabilities; Electron `contextIsolation` + `contextBridge`).
- Dữ liệu người dùng lưu theo quy ước OS (`%APPDATA%`, `~/Library/Application Support`, XDG); bí mật trong keychain hệ điều hành.

## Stack mặc định khuyến nghị

Xác minh ngày **2026-10-13** — **xác minh lại trước khi dùng**.

| Thành phần | Mặc định | Phiên bản (xác minh 2026-10-13) | Thay thế + điều kiện |
|---|---|---|---|
| Khung | Tauri 2 (Rust lõi + WebView hệ thống) | `tauri` crate 2.12.3; `@tauri-apps/cli` 2.12.2; Rust 1.99.0 | Electron 44.7.0 (EOL 2027-03-02; dòng 42 EOL 2026-10-20; chỉ 3 dòng mới nhất được vá) khi cần Chromium đồng nhất, module Node native hoặc đội Node thuần |
| Native thuần | Swift/SwiftUI (macOS), WinUI 3/.NET (Windows), GTK/Qt (Linux) | Swift 6.4.1; .NET/WinUI chưa xác minh phiên bản | Khi chỉ 1 OS và cần tích hợp sâu nhất |
| UI | React 19.3.0 / Svelte 5.57.2 + Vite 8.3.4 + TypeScript 7.0.2 | — | Theo kỹ năng đội; tokens xem [`../06-design-ux/design-system-and-tokens.md`](../06-design-ux/design-system-and-tokens.md) |
| Đóng gói Electron | electron-builder | 26.15.3 (`electron-updater` 6.8.9) | Electron Forge `@electron-forge/cli` 8.0.1 (chính chủ) |
| Đóng gói Tauri | `tauri bundle` (msi/nsis, dmg/app, AppImage/deb/rpm) | theo CLI 2.12.2 | — |
| Ký Windows | Authenticode qua Azure Artifact Signing (tên mới của Trusted Signing; HSM FIPS 140-3 L3) hoặc EV cert trên token | — | `signtool` + cert OV/EV tự quản (chưa xác minh giá/điều kiện) |
| Ký macOS | Developer ID + Hardened Runtime + `notarytool` + `stapler` | notarytool bắt buộc từ 2023-11-01 (altool bị bỏ) | Mac App Store (sandbox App Store, review) |
| Auto-update | Tauri updater (ký bắt buộc, `TAURI_SIGNING_PRIVATE_KEY`) / electron-updater (feed HTTPS) | — | Squirrel/Sparkle cho native (chưa xác minh phiên bản) |
| Crash | Sentry Electron / Sentry Rust | `@sentry/electron` 8.1.0; Rust SDK chưa xác minh | Crashpad/Breakpad tự host |
| Unit test | Vitest (UI) + `cargo test` (lõi) | 5.0.4 | Jest 30.5.2 |
| E2E | Playwright (Electron qua `_electron`), WebDriver (`tauri-driver`) cho Tauri | Playwright 1.64.0; `tauri-driver` chưa xác minh phiên bản | — |
| Lint | Biome 2.5.15 + `cargo clippy`/`cargo deny` 0.20.2 | — | oxlint 1.87.0 |
| Node CI | 24 LTS | 24.21.0 | — |

## Checklist

- [ ] `PRF-DESK-001` **MUST** Mọi bản phát hành được **ký mã**: Windows Authenticode (timestamp RFC 3161), macOS Developer ID + Hardened Runtime + **notarize + staple**; khóa ký ở HSM/dịch vụ ký, không nằm trong repo hay máy cá nhân. → Kiểm: CI chạy `signtool verify /pa /v` và `spctl --assess --type execute -vv` + `xcrun stapler validate` trên artifact; `git ls-files | grep -Ei '\.(pfx|p12)$'` rỗng. · Nguồn: Apple notarization (notarytool); Azure Artifact Signing
- [ ] `PRF-DESK-002` **MUST** Auto-update chỉ cài bản có **chữ ký hợp lệ** từ khóa riêng của dự án, tải qua HTTPS, không cho hạ cấp (version phải tăng); khóa ký update tách khỏi khóa ký mã. → Kiểm: Tauri `plugins.updater.pubkey` + `createUpdaterArtifacts: true`; Electron: test giả mạo manifest/binary → updater từ chối; test version thấp hơn → bỏ qua. · Nguồn: Tauri updater (ký không thể tắt)
- [ ] `PRF-DESK-003` **MUST** Process UI chạy sandbox: Electron `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity` không tắt, chỉ expose hàm cụ thể qua `contextBridge` (không expose `ipcRenderer` thô); Tauri dùng capabilities/permissions tối thiểu cho từng cửa sổ. → Kiểm: test đọc `webPreferences` của mọi `BrowserWindow`; lint cấm `nodeIntegration: true`; file `capabilities/*.json` không có `core:default` thừa/`allow-all`. · Nguồn: Electron security checklist 2–4, 20; Tauri security
- [ ] `PRF-DESK-004` **MUST** IPC validate: mỗi handler kiểm `sender` (origin/frame) và validate tham số bằng schema; đường dẫn tệp từ UI phải nằm trong thư mục cho phép (chống path traversal); không truyền chuỗi lệnh shell. → Kiểm: test gọi IPC với `../../etc/passwd` → từ chối; Tauri scope `fs`/`shell` giới hạn; `grep -r "shell.openExternal\|exec(" src/main` có review. · Nguồn: Electron security checklist 13–15, 17
- [ ] `PRF-DESK-005` **MUST** CSP cho UI (`default-src 'self'`; không `unsafe-inline` cho script); chỉ tải nội dung remote qua HTTPS/WSS; không dùng `file://` cho trang app (dùng custom protocol). → Kiểm: test đọc header/meta CSP của cửa sổ chính; `grep -r "loadURL('http:" ` rỗng. · Nguồn: Electron security checklist 1, 7, 18
- [ ] `PRF-DESK-006` **MUST** Electron: ghim 1 trong 3 dòng major đang được vá và có lịch nâng; Electron fuses tắt `runAsNode`, `nodeOptions`, `nodeCliInspect`; bật `embeddedAsarIntegrityValidation` + `onlyLoadAppFromAsar`. (Tauri: cập nhật patch trong 30 ngày khi có advisory.) → Kiểm: `electron --version` ∈ 3 dòng mới nhất theo endoflife.date; script `@electron/fuses` chạy trong build; `cargo audit`/`cargo deny` xanh. · Nguồn: Electron fuses; Electron EOL
- [ ] `PRF-DESK-007` **MUST** Bí mật người dùng (token, mật khẩu) lưu trong keychain hệ điều hành (Keychain, Credential Manager, Secret Service), không ghi plaintext vào config/log. → Kiểm: test tìm chuỗi token trong thư mục dữ liệu app sau đăng nhập → không có; dùng `keyring`/`keytar`-tương đương (chưa xác minh phiên bản). · Nguồn: [`../12-security/secrets-management.md`](../12-security/secrets-management.md)
- [ ] `PRF-DESK-008` **MUST@M** Build phát hành **tái lập từ CI** cho cả 3 OS (hoặc các OS hỗ trợ), kèm `checksums.txt` SHA-256 và SBOM; không phát hành binary build từ máy cá nhân. → Kiểm: workflow matrix OS; release có file checksum + SBOM (syft/CycloneDX). · Nguồn: [`../12-security/supply-chain.md`](../12-security/supply-chain.md)
- [ ] `PRF-DESK-009` **MUST@M** Crash reporting có symbol (PDB/dSYM/Rust debug info) upload tự động; telemetry/analytics **opt-in**, có màn hình cho phép tắt, không gửi nội dung tệp người dùng. → Kiểm: bước CI upload symbol; cấu hình mặc định `telemetry: false`; test tắt telemetry → không có request ra ngoài.
- [ ] `PRF-DESK-010` **SHOULD** Dữ liệu và cấu hình theo quy ước OS: Windows `%APPDATA%`/`%LOCALAPPDATA%`, macOS `~/Library/Application Support`, Linux XDG (`$XDG_CONFIG_HOME` mặc định `~/.config`, `$XDG_DATA_HOME` `~/.local/share`, `$XDG_STATE_HOME` `~/.local/state`); gỡ cài đặt dọn sạch hoặc hỏi người dùng. → Kiểm: test đường dẫn trên 3 OS; script gỡ cài kiểm thư mục còn lại. · Nguồn: XDG Base Directory 0.8
- [ ] `PRF-DESK-011` **SHOULD** Cài đặt đúng chuẩn OS: Windows MSI/MSIX hoặc NSIS có nâng cấp tại chỗ (không cài chồng), macOS dmg/pkg có `LSMinimumSystemVersion`, Linux AppImage + deb/rpm hoặc Flatpak; cài không cần admin khi có thể (per-user). → Kiểm: E2E cài → nâng cấp → gỡ trên máy ảo sạch mỗi OS.
- [ ] `PRF-DESK-012` **SHOULD** Thời gian khởi động và bộ nhớ có ngân sách trong `PROJECT.md`, đo mỗi bản trên máy ảo CI (cold start đến cửa sổ tương tác được, RSS sau 60 s idle). → Kiểm: script đo lưu số theo commit; đỏ khi hồi quy > ngưỡng dự án đặt.
- [ ] `PRF-DESK-013` **SHOULD** A11y: điều hướng bàn phím toàn bộ, screen reader (NVDA/VoiceOver) đọc được luồng chính, tôn trọng theme/tương phản/giảm chuyển động của OS. → Kiểm: axe trên WebView (0 `critical`/`serious`); test bàn phím E2E. · Nguồn: [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md)
- [ ] `PRF-DESK-014` **SHOULD** Phát hành có kênh (stable/beta) và rollout từng phần cho auto-update; rollback bằng cách đẩy lại bản trước lên feed. → Kiểm: feed update có trường kênh; đã diễn tập rollback. · Nguồn: [`../15-operations/deployment-strategies.md`](../15-operations/deployment-strategies.md)
- [ ] `PRF-DESK-015` **SHOULD** Deep link/giao thức tùy chỉnh (`myapp://`) validate URL đầu vào như dữ liệu không tin cậy; không tự động chạy hành động phá hủy từ link. → Kiểm: test fuzz URL vào handler; hành động nhạy cảm đòi xác nhận.
- [ ] `PRF-DESK-016` **MAY** Phân phối qua store/package manager (Microsoft Store, Mac App Store, winget, Homebrew cask, Flathub, Snap) với manifest tự động cập nhật từ CI. → Kiểm: manifest sinh từ release workflow.
- [ ] `PRF-DESK-017` **MAY** Hỗ trợ cài đặt im lặng và cấu hình doanh nghiệp (MSI `/quiet`, policy/MDM, proxy hệ thống) khi bán cho tổ chức. → Kiểm: tài liệu + test cài im lặng trên VM.

## Cổng chất lượng tương đương

| Cổng chung (web) | Cổng của desktop-app | Ngưỡng | Công cụ / nơi đặt |
|---|---|---|---|
| Core Web Vitals | Cold start → cửa sổ tương tác được; RSS idle; kích thước cài đặt | Ngân sách dự án đặt, đo mỗi bản, đỏ khi hồi quy | Script benchmark trên VM CI; `ps`/`Get-Process` |
| Lighthouse | Crash-free sessions + tỷ lệ update thành công | Ngưỡng SLO dự án; update fail > 1 % (gợi ý dự án đặt) → điều tra | Sentry; log updater |
| axe/WCAG | axe trên WebView + bàn phím + screen reader OS | 0 `critical`/`serious`; luồng chính không cần chuột | `@axe-core/playwright`, NVDA/VoiceOver thủ công |
| Security headers | CSP WebView + sandbox/IPC allowlist + fuses | 0 `nodeIntegration`; capabilities tối thiểu; fuses đúng | Test cấu hình; `@electron/fuses`; Tauri capabilities |
| Playwright E2E | E2E app thật trên 3 OS + luồng cài/nâng cấp/gỡ | Xanh trên ma trận OS hỗ trợ | Playwright `_electron`, `tauri-driver`, VM sạch |
| Supply chain | Ký mã + notarize + checksum + SBOM | 100 % artifact ký + staple; checksum khớp | `signtool verify`, `spctl`, `stapler validate`, syft |
| Preview deployment | Kênh beta auto-update | Mỗi RC lên beta ≥ N ngày (dự án đặt) trước stable | Feed update theo kênh |
| Rollback | Đẩy lại bản trước lên feed | ≤ 1 thao tác; đã diễn tập | Feed/manifest update |

## Bẫy

- **Ký mà không timestamp** → chữ ký "hết hạn" cùng cert; Windows SmartScreen cảnh báo. Hàng rào: luôn `/tr <RFC3161> /td sha256`; macOS `--timestamp`.
- **Notarize nhưng không staple** → máy offline vẫn bị Gatekeeper chặn. Hàng rào: `stapler staple` + `stapler validate` trong CI.
- **Updater tải HTTP hoặc không kiểm chữ ký** → kẻ chen giữa cài mã độc. Hàng rào: PRF-DESK-002; Tauri đã ép ký; Electron phải tự kiểm.
- **`nodeIntegration: true` "cho tiện"** → XSS trong UI = RCE trên máy người dùng. Hàng rào: PRF-DESK-003 bằng test cấu hình, không bằng review.
- **`shell.openExternal(userInput)`** → mở `file://`/`smb://` tùy ý. Hàng rào: allowlist scheme `https:` + `mailto:`.
- **Electron lệch nhiều major** vì sợ breaking → tích lũy CVE Chromium. Hàng rào: nâng từng major một theo lịch; endoflife.date làm nguồn.
- **Khóa ký trong CI secret dạng file `.pfx`** → rò rỉ là mất danh tính. Hàng rào: HSM/dịch vụ ký (Azure Artifact Signing), OIDC từ CI.
- **Telemetry bật mặc định** gửi đường dẫn tệp/URL → vi phạm quyền riêng tư (bài học catalog: tool bật telemetry mặc định). Hàng rào: opt-in + test không có egress khi tắt.
- **Đính chính nguồn:** Microsoft đổi tên "Trusted Signing" thành **Artifact Signing** (trang docs chuyển hướng, cập nhật 2026-08-03); tài liệu cũ dùng tên cũ.

## Nguồn

- Electron security checklist (20 mục): <https://www.electronjs.org/docs/latest/tutorial/security> — xác minh 2026-10-13. Electron fuses: <https://www.electronjs.org/docs/latest/tutorial/fuses> — xác minh 2026-10-13. Electron EOL: <https://endoflife.date/api/electron.json> — xác minh 2026-10-13.
- Tauri security model: <https://tauri.app/security/> — xác minh 2026-10-13. Tauri updater (ký bắt buộc, `TAURI_SIGNING_PRIVATE_KEY`): <https://v2.tauri.app/plugin/updater/> — xác minh 2026-10-13. crates.io `tauri` 2.12.3, `cargo-deny` 0.20.2 — xác minh 2026-10-13.
- Apple: notarytool bắt buộc từ 2023-11-01, quarantine attribute: <https://developer.apple.com/news/upcoming-requirements/> — xác minh 2026-10-13. (chưa xác minh — trang không trả nội dung ngày 2026-10-13) chi tiết Hardened Runtime/stapler tại <https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>.
- Azure Artifact Signing (Authenticode, HSM FIPS 140-3 L3): <https://learn.microsoft.com/en-us/azure/artifact-signing/overview> — xác minh 2026-10-13.
- XDG Base Directory Specification 0.8: <https://specifications.freedesktop.org/basedir/latest/> — xác minh 2026-10-13.
- Phiên bản npm (`electron`, `@tauri-apps/cli`, `electron-builder`, `electron-updater`, `@electron-forge/cli`, `@sentry/electron`, `vite`, `react`, `svelte`, `typescript`, `vitest`, `@playwright/test`, `@biomejs/biome`), endoflife.date `rust`, swift.org — xác minh 2026-10-13.
- (chưa xác minh) `tauri-driver`, Sentry Rust SDK, keyring/keytar, Sparkle/Squirrel, WinUI/.NET — không tra ngày 2026-10-13.
- Catalog: Inno Setup + Authenticode (23 §4.4), telemetry mặc định (§2.6) — `research/2026-10-13-stored-catalog-extraction.md`; khung cũ KHUNG-3 C3 (commit `1b80fe4`).
