---
title: Công cụ dòng lệnh
kind: profile
slug: cli-tool
prefix: PRF-CLI
modules: [04-standards/*, 05-architecture/*, 08-backend/reliability-and-errors, 10-workflow/*, 11-autonomous-loop/*, 12-security/*, 14-testing-quality/*, 15-operations/observability, 15-operations/maintenance-and-lifecycle, 16-compliance-privacy/*, 17-product-project/*, 18-cross-cutting/*]
updated: 2026-10-14
---

# Hồ sơ: Công cụ dòng lệnh

> Chương trình chạy trong terminal, bởi người **và** bởi script/CI/agent. Giao diện là **tham số, stdin/stdout/stderr,
> exit code, biến môi trường**. Cổng chất lượng: hợp đồng I/O ổn định (golden test), thời gian khởi động, kích
> thước binary, cài đặt có checksum/chữ ký, không gây hại khi chạy trong pipeline.

## Khi nào dùng

- Tự động hóa, công cụ dev, migration/ETL chạy tay hoặc trong CI, wrapper quanh API, công cụ cho AI agent gọi.
- Không dùng khi: cần UI đồ họa → [`desktop-app.md`](desktop-app.md); là package để `import` chứ không chạy → [`library-sdk.md`](library-sdk.md) (CLI kèm thư viện: ghép cả hai, CLI là lớp mỏng trên thư viện); dịch vụ chạy dài có HTTP → [`api-service.md`](api-service.md).

## Kiến trúc tham chiếu (C4 mức 1)

```text
[Người dùng / script / CI / AI agent]
      │ argv, env, stdin, TTY?
[CLI entry] → parse (subcommand, flag) → config (flag > env > project > user > system) → [Core library: logic thuần, không in ra màn hình]
      │ stdout: kết quả (text cho người | --json/--plain cho máy)
      │ stderr: log, tiến trình, lỗi có mã
      │ exit code: 0 ok | ≠0 theo loại lỗi
[Phân phối] binary theo OS/arch + checksums.txt + chữ ký → GitHub Releases / npm / PyPI / Homebrew / scoop / winget
[Cập nhật] thông báo phiên bản mới (opt-in, có cache, không chặn), KHÔNG tự cập nhật ngầm
```

- Tách **core library** khỏi **lớp CLI**: core có test đơn vị; CLI chỉ map argv ↔ hàm và định dạng đầu ra. Cho phép tái dùng core trong [`library-sdk.md`](library-sdk.md).
- Nội dung từ stdin/file/mạng là dữ liệu không tin cậy (xem [`../00-method/principles.md`](../00-method/principles.md) P6).

## Stack mặc định khuyến nghị

Xác minh ngày **2026-10-13** — **xác minh lại trước khi dùng**. Chọn ngôn ngữ theo **nơi người dùng chạy**: không muốn cài runtime → Go/Rust (binary tĩnh); hệ sinh thái Node → TS; data/ML → Python.

| Thành phần | Mặc định | Phiên bản (xác minh 2026-10-13) | Thay thế + điều kiện |
|---|---|---|---|
| Ngôn ngữ (binary tĩnh) | Go | 1.27.2 (1.26.9 vẫn hỗ trợ) | Rust 1.99.0 khi cần hiệu năng/an toàn bộ nhớ tối đa |
| Ngôn ngữ (hệ Node) | TypeScript 7.0.2 trên Node 24 LTS (24.21.0) | — | Bun single-file executable (chưa xác minh phiên bản) |
| Ngôn ngữ (Python) | Python 3.14.8 (3.15.0 vừa ra 2026-10-09 — né `x.0`) | — | — |
| Parser argv | Go: `cobra` (chưa xác minh phiên bản) · Rust: `clap` 4.6.7 · TS: `commander` 15.0.0 · Python: `typer` 0.27.3 / `click` 8.5.0 | — | `@oclif/core` 5.1.7 khi CLI nhiều plugin; stdlib `flag`/`argparse` khi 1–2 lệnh |
| Đóng gói/phát hành | Go: GoReleaser v2.18.3 (checksums SHA-256 mặc định) · Rust: `cargo-dist` 0.32.0 · TS: `tsdown` 0.23.1 (hoặc `tsup` 8.5.1) + npm · Python: `uv` 0.13.0 + `hatch` 1.18.1 | — | Nix/Homebrew formula sinh từ release |
| Ký/attest | Sigstore `cosign` v3.1.3; GitHub artifact attestation; npm provenance; PyPI Trusted Publishers | — | GPG khi người dùng yêu cầu |
| Test | Golden/snapshot test cho output + exit code (`cargo insta`, Go `testscript`, Vitest snapshot, pytest `syrupy` — chưa xác minh phiên bản trừ Vitest 5.0.4) | — | Property test (`fast-check`, `proptest`, `hypothesis` — chưa xác minh) cho parser |
| Benchmark | `hyperfine` (chưa xác minh phiên bản) đo thời gian khởi động | — | `perf`/`criterion` |
| Lint | Go: `golangci-lint` · Rust: `clippy` + `cargo deny` 0.20.2 · TS: Biome 2.5.15 · Python: `ruff` + `pyright` (phiên bản đã xác minh ở [`../01-baseline/quality-gates.md`](../01-baseline/quality-gates.md): ruff 0.17.0, pyright 1.1.414, pre-commit 4.7.0) | — | — |
| Audit dep | `govulncheck`, `cargo audit`, `pnpm audit`, `pip-audit` 2.10.1 | — | OSV-Scanner |

## Checklist

- [ ] `PRF-CLI-001` **MUST** Exit code: `0` thành công, khác `0` thất bại, mã khác nhau cho các loại lỗi chính (vd `1` lỗi chung, `2` sai cách dùng, `3` lỗi mạng…) và ghi trong `--help`/docs; không `exit 0` khi có lỗi bị nuốt. → Kiểm: golden test mỗi lệnh assert exit code; test lỗi cố ý → code đúng. · Nguồn: clig.dev (Exit codes)
- [ ] `PRF-CLI-002` **MUST** `--help`/`-h` ở mọi lệnh và lệnh con, mở đầu bằng ví dụ, flag hay dùng trước; chạy không tham số khi thiếu tham số bắt buộc → in trợ giúp ngắn và exit ≠ 0, không treo. → Kiểm: test `cmd --help` exit 0 có chuỗi "Usage"/"Examples"; test `cmd` không tham số không chờ stdin. · Nguồn: clig.dev (Help)
- [ ] `PRF-CLI-003` **MUST** Kết quả ra **stdout**, log/tiến trình/lỗi ra **stderr**; có `--json` (hoặc `--plain`) cho máy đọc, định dạng đó là **hợp đồng** được versioning. → Kiểm: test `cmd --json | jq .` parse được, stderr không lẫn vào stdout; schema JSON output có test snapshot. · Nguồn: clig.dev (Output)
- [ ] `PRF-CLI-004` **MUST** Không màu/animation khi stdout **không phải TTY**, khi `NO_COLOR` có giá trị không rỗng, `TERM=dumb`, hoặc `--no-color`; `FORCE_COLOR` bật lại. → Kiểm: test `cmd | cat` không chứa mã ANSI (`grep -P '\x1b\['` rỗng); test với `NO_COLOR=1`. · Nguồn: no-color.org; clig.dev
- [ ] `PRF-CLI-005` **MUST** `--version` in phiên bản (semver) + commit + ngày build, lấy từ build (ldflags/`env!`/`package.json`) hoặc, với ngôn ngữ thông dịch, từ file `VERSION`/manifest gói/`git describe`; không hard-code. → Kiểm: test `cmd --version` khớp tag release; CI release kiểm chuỗi.
- [ ] `PRF-CLI-006` **MUST** Chỉ nhắc (prompt) khi stdin là TTY; có `--yes`/`--confirm` cho script; đọc được từ stdin khi tham số là `-`. → Kiểm: test chạy với stdin đóng (`< /dev/null`) không treo; test `echo x | cmd -`. · Nguồn: clig.dev (Interactivity)
- [ ] `PRF-CLI-007` **MUST** Hành động phá hủy (xoá, ghi đè, gửi tiền/dữ liệu ra ngoài) có `--dry-run` và xác nhận; hành động nặng yêu cầu gõ tên đối tượng hoặc flag rõ ràng. → Kiểm: test `--dry-run` không đổi trạng thái (so hash thư mục/DB trước-sau); test không có `--yes` + không TTY → từ chối với exit ≠ 0. · Nguồn: clig.dev (Confirm before doing anything dangerous)
- [ ] `PRF-CLI-008` **MUST@M** Cài đặt an toàn: artifact kèm `checksums.txt` SHA-256 và chữ ký/attestation (cosign/Sigstore, GitHub attestation, npm provenance, PyPI trusted publishing); hướng dẫn cài không dùng `curl | sh` không kiểm checksum. → Kiểm: release có checksum + chữ ký; `cosign verify-blob`/`gh attestation verify`/`npm audit signatures` xanh trong job verify sau publish. · Nguồn: SLSA v1.2 L1–L2; [`../12-security/supply-chain.md`](../12-security/supply-chain.md)
- [ ] `PRF-CLI-009` **MUST@M** Khi phát hành binary/gói cài đặt: build tái lập trong CI cho ma trận OS/arch hỗ trợ (ít nhất linux/amd64, linux/arm64, darwin/arm64, windows/amd64 nếu claim hỗ trợ); binary release không build từ máy cá nhân. → Kiểm: workflow matrix; `file`/`uname` smoke test mỗi artifact; so hash build 2 lần (Go/Rust) khi claim reproducible.
- [ ] `PRF-CLI-010` **MUST** Bí mật CLI lưu trên máy (token sau `login`, file credential) chỉ ở keychain hệ điều hành hoặc file quyền `0600`; cách nhận bí mật (không qua tham số dòng lệnh) theo [`BASE-CFG-006`](../01-baseline/configuration-and-secrets.md). → Kiểm: test file credential do CLI ghi có quyền `0600` (`stat -c %a`) hoặc bí mật nằm trong keychain. · Nguồn: [`../12-security/secrets-management.md`](../12-security/secrets-management.md)
- [ ] `PRF-CLI-011` **MUST@M** Golden test (output + exit code) cho mọi lệnh công khai, chạy trên ma trận OS trong CI; đổi output người đọc được phép, đổi `--json`/`--plain` là breaking. → Kiểm: thư mục `testdata/`/snapshot có mỗi lệnh; CI 3 OS xanh. · Nguồn: [`../14-testing-quality/unit-and-logic-edge-cases.md`](../14-testing-quality/unit-and-logic-edge-cases.md)
- [ ] `PRF-CLI-012` **SHOULD** Phản hồi trong < 100 ms (in gì đó ra màn hình, kể cả spinner trên stderr) và thời gian khởi động `--help`/`--version` có ngân sách trong `PROJECT.md`, đo mỗi bản bằng `hyperfine`. → Kiểm: benchmark CI lưu số theo commit; đỏ khi hồi quy > ngưỡng dự án đặt. · Nguồn: clig.dev (Responsive is more important than fast)
- [ ] `PRF-CLI-013` **SHOULD** Kích thước binary/package có ngân sách; tránh kéo dependency nặng chỉ cho một flag; TS: `tsdown` bundle + `size-limit` 14.2.0; Go: `-ldflags="-s -w"`. → Kiểm: CI in kích thước mỗi artifact và so ngân sách.
- [ ] `PRF-CLI-014` **SHOULD** Cấu hình theo thứ tự ưu tiên flag > env > project > user > system; file cấu hình theo XDG (`$XDG_CONFIG_HOME/<app>/`), Windows `%APPDATA%`, macOS `~/Library/Application Support` hoặc XDG nếu người dùng đặt; có `--config` để ghi đè. → Kiểm: test ưu tiên 5 tầng; test đường dẫn mặc định mỗi OS. · Nguồn: clig.dev (Configuration); XDG 0.8
- [ ] `PRF-CLI-015` **SHOULD** Thông báo lỗi nói **cái gì sai + làm gì tiếp** (gợi ý lệnh/flag), có mã lỗi tra được; stack trace chỉ khi `--verbose`/`DEBUG`. → Kiểm: golden test cho 5 lỗi hay gặp nhất; không có stack trace trong output mặc định.
- [ ] `PRF-CLI-016` **SHOULD** Tín hiệu: `Ctrl-C` dọn dẹp (tệp tạm, tiến trình con) và exit 130; thao tác dài có tiến trình trên stderr và có thể tiếp tục/idempotent khi chạy lại. → Kiểm: test gửi SIGINT giữa chừng → không để lại tệp tạm; chạy lại không nhân đôi.
- [ ] `PRF-CLI-017` **SHOULD** Kiểm tra phiên bản mới **opt-in** (hoặc tắt bằng env), không chặn lệnh, cache ≥ 24 h, không gửi telemetry mặc định; nếu có telemetry phải opt-in và tài liệu rõ gửi gì. → Kiểm: test chạy offline không chậm/không lỗi; test không có request mạng khi tắt. · Nguồn: bài học catalog (telemetry mặc định) `research/2026-10-13-stored-catalog-extraction.md` §2.6
- [ ] `PRF-CLI-018` **SHOULD** Phân phối qua package manager phổ biến của nền tảng đích (Homebrew tap, scoop/winget, apt/rpm, `npx`/`uvx`) với manifest sinh tự động từ release. → Kiểm: formula/manifest cập nhật cùng tag; smoke install trong CI.
- [ ] `PRF-CLI-019` **MAY** Shell completion (bash/zsh/fish/pwsh) sinh từ parser; man page sinh từ cùng nguồn `--help`. → Kiểm: `cmd completion zsh` xuất file hợp lệ; test man page build.
- [ ] `PRF-CLI-020` **MAY** Chế độ cho AI agent: `--json` đầy đủ, `--non-interactive`, thông điệp lỗi có cấu trúc, `--help` ngắn gọn đủ để model gọi đúng (xem [`../18-cross-cutting/docs-for-ai-agents.md`](../18-cross-cutting/docs-for-ai-agents.md)). → Kiểm: test chạy dưới `CI=1` + stdin đóng qua mọi lệnh.

## Cổng chất lượng tương đương

| Cổng chung (web) | Cổng của cli-tool | Ngưỡng | Công cụ / nơi đặt |
|---|---|---|---|
| Core Web Vitals | Thời gian khởi động (`--help`, `--version`, lệnh chính trên dữ liệu mẫu) | Phản hồi đầu tiên < 100 ms (clig.dev); ngân sách tuyệt đối dự án đặt; đỏ khi hồi quy | `hyperfine` trong CI, lưu theo commit |
| Bundle budget | Kích thước binary/package mỗi OS-arch | Dự án đặt trong `PROJECT.md` | CI đo artifact; `size-limit`; `-ldflags -s -w` |
| axe/a11y | Khả năng dùng không màu, không TTY, screen reader đọc output thuần | 0 mã ANSI khi không TTY; `--plain` có | Test `| cat`, `NO_COLOR` |
| E2E Playwright | Golden test output + exit code trên ma trận OS | 100 % lệnh công khai có golden; 3 OS xanh | `testscript`/`insta`/snapshot; GitHub matrix |
| Security headers/CSP | Cài đặt có checksum + chữ ký; không secret trong argv | 100 % artifact có SHA-256 + attestation | GoReleaser/cargo-dist checksums, cosign, `gh attestation verify` |
| Contract API | Hợp đồng `--json`/`--plain` + exit code (semver) | Đổi schema = major | Snapshot schema; CHANGELOG |
| Preview deployment | Pre-release tag (`-rc.N`) + kênh `@next`/`--pre` | Mỗi major có ≥ 1 RC | GitHub pre-release; npm dist-tag |
| Rollback | Người dùng ghim phiên bản cũ | Mọi bản cũ vẫn tải được + checksum | Giữ artifact; không xoá release |

## Bẫy

- **In lỗi ra stdout, kết quả ra stderr (hoặc lẫn lộn)** → pipeline hỏng âm thầm. Hàng rào: golden test tách 2 luồng.
- **Prompt khi không có TTY** → CI treo vô hạn. Hàng rào: PRF-CLI-006 test với stdin đóng.
- **Nhận bí mật qua flag** `--token sk_...` → lộ trong `ps aux`, shell history, log CI. Hàng rào: BASE-CFG-006 (lưu bền: PRF-CLI-010).
- **`curl https://… | sh` trong README** không checksum → chuỗi cung ứng mở toang (bài học catalog: tool bị cài backdoor). Hàng rào: PRF-CLI-008; hướng dẫn `sha256sum -c`.
- **Đổi định dạng output "cho đẹp"** làm vỡ script người dùng. Hàng rào: `--json`/`--plain` là hợp đồng semver; output người đọc mới được đổi.
- **Tự cập nhật ngầm / telemetry mặc định** → mất lòng tin, vi phạm chính sách doanh nghiệp. Hàng rào: PRF-CLI-017.
- **Logic nằm trong lớp CLI** → không test được, không tái dùng. Hàng rào: core library riêng, CLI mỏng.
- **Exit 0 mọi trường hợp** vì bắt lỗi rồi chỉ in ra. Hàng rào: PRF-CLI-001 test lỗi cố ý.
- **Chỉ test trên Linux** → đường dẫn/encoding/CRLF vỡ trên Windows. Hàng rào: ma trận 3 OS.

## Nguồn

- Command Line Interface Guidelines (exit code, help, output, NO_COLOR, config precedence, < 100 ms, confirm/dry-run, XDG): <https://clig.dev/> — xác minh 2026-10-13.
- NO_COLOR: <https://no-color.org/> — xác minh 2026-10-13. XDG Base Directory 0.8: <https://specifications.freedesktop.org/basedir/latest/> — xác minh 2026-10-13.
- SLSA v1.2: <https://slsa.dev/spec/v1.2/> (mức Build theo nhà [`../12-security/supply-chain.md`](../12-security/supply-chain.md): L2 @M, L3 @L) — xác minh 2026-10-13.
- npm provenance / trusted publishing: <https://docs.npmjs.com/generating-provenance-statements> — xác minh 2026-10-13. PyPI Trusted Publishers: <https://docs.pypi.org/trusted-publishers/> — xác minh 2026-10-13.
- GoReleaser checksums (SHA-256 mặc định): <https://goreleaser.com/customization/checksum/> — xác minh 2026-10-13; GoReleaser v2.18.3, cosign v3.1.3 (GitHub releases, không hiển thị năm) — xác minh 2026-10-13.
- Phiên bản: endoflife.date `go`, `rust`, `python`, `nodejs`; crates.io `clap`, `cargo-dist`, `cargo-deny`; npm `commander`, `@oclif/core`, `tsdown`, `tsup`, `size-limit`, `vitest`, `@biomejs/biome`; PyPI `typer`, `click`, `uv`, `hatch`, `pip-audit` — xác minh 2026-10-13.
- (chưa xác minh) `cobra`, `hyperfine`, `golangci-lint`, `ruff`/`pyright` phiên bản, `insta`, `testscript`, `syrupy`, `fast-check`/`proptest`/`hypothesis`, Bun — không tra ngày 2026-10-13.
- Catalog: §2.6 (checksum, cấm `curl | sh`, telemetry mặc định), §3 — `research/2026-10-13-stored-catalog-extraction.md`; khung cũ KHUNG-3 C6 (commit `1b80fe4`).
