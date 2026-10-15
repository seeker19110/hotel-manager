---
title: DX: onboarding < 1 giờ, lệnh chuẩn, devcontainer, lỗi dễ hiểu
kind: module
prefix: XC-DX
applies_to: [all]
updated: 2026-10-14
---

# DX: onboarding < 1 giờ, lệnh chuẩn, devcontainer, lỗi dễ hiểu

> Trải nghiệm lập trình viên (và agent) làm việc với repo: từ clone đến test xanh trong < 1 giờ (người) hoặc < 10 phút
> (máy), một bộ lệnh chuẩn khai báo ở nơi máy đọc, môi trường tái lập (devcontainer/mise), phản hồi nhanh, lỗi công cụ
> nói cách sửa, đo bằng DORA/SPACE. Cổng chất lượng là nhà của [`../01-baseline/quality-gates.md`](../01-baseline/quality-gates.md);
> file hướng dẫn agent ở [`docs-for-ai-agents.md`](docs-for-ai-agents.md); quy trình đội ở
> [`../10-workflow/team-and-wip.md`](../10-workflow/team-and-wip.md).

## Nguyên tắc

- **Onboarding là tính năng có SLA**: clone → chạy → test xanh đo được bằng đồng hồ, không bằng "khá dễ".
- **Một cách làm mỗi việc** (`dev`, `test`, `lint`, `build`, `format`, `typecheck`, `migrate`): tên chuẩn, khai báo
  máy đọc, người và agent gọi cùng thứ.
- **Môi trường là mã**: runtime, công cụ, dịch vụ phụ (DB, cache) khai báo trong repo; "works on my machine" là lỗi.
- **Vòng phản hồi ngắn**: lint/format/test liên quan < 1 phút tại chỗ, CI < 10 phút; chậm hơn thì người bỏ qua cổng.
- **Lỗi công cụ nói cách sửa**: thông điệp nêu cái gì, ở đâu, làm gì tiếp — cho người lẫn agent.
- **Đo, không cảm nhận**: DORA (throughput/instability) + SPACE (satisfaction, performance, activity, communication,
  efficiency/flow); không tối ưu một chỉ số hoạt động đơn lẻ.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| Quản lý phiên bản công cụ | **mise** (`mise.toml`, đa runtime, MIT) hoặc file bản địa (`.nvmrc`, `.python-version`, `.tool-versions`); Nix khi cần tái lập tuyệt đối. | Cài runtime toàn cục bằng tay theo README. |
| Môi trường tái lập | **Dev Container** (`.devcontainer/devcontainer.json`, chuẩn mở containers.dev; chạy trong VS Code/Codespaces/CLI) + `docker compose` cho dịch vụ phụ. | Dự án CLI/lib thuần không dịch vụ phụ: mise + lockfile là đủ. |
| Điểm vào lệnh | `package.json#scripts` (JS) · `justfile`/`Makefile` (đa ngôn ngữ) · `noxfile`/`tox` (Python) · `Taskfile.yml`; **và** bản sao máy đọc phẳng (`xt.yaml`/`runtime.yaml`) cho agent. | Lệnh dài trong README; script shell rải rác không tên chuẩn. |
| Hook cục bộ | pre-commit/lefthook tự cài sau `install`; chỉ chạy file thay đổi. | Hook > 30 s → người dùng `--no-verify`. |
| Cấu hình editor | `.editorconfig` + cấu hình formatter trong repo + đề xuất extension (`.vscode/extensions.json`) — không ép IDE. | Commit `settings.json` cá nhân. |
| Đo DX | DORA 4 chỉ số (+ rework rate) từ CI/Git tự động; khảo sát SPACE định kỳ ngắn; thời gian onboarding đo thật với người mới. | Đếm commit/dòng code làm KPI. |

## Checklist

- [ ] `XC-DX-001` **MUST** Từ clone sạch đến test xanh bằng **≤ 3 lệnh** ghi ở đầu README (vd `mise install && npm ci && npm test`), không bước tay nào ngoài lấy bí mật dev từ nơi đã ghi. → Kiểm: job CI `onboarding-smoke` chạy đúng các lệnh đó trên runner mới, exit 0; thời gian đo ghi lại. · Nguồn: 12-factor II ("một lệnh build tất định"); OpenSSF Badge `documentation_basics`
- [ ] `XC-DX-002` **MUST** Bộ lệnh chuẩn (`dev`, `build`, `test`, `lint`, `format`, `typecheck`, `migrate` nếu có) khai báo **một nơi máy đọc** và được hook/CI/agent gọi nguyên văn; thêm bản phẳng `xt.yaml`/`runtime.yaml` (key: value) cho agent. → Kiểm: file tồn tại; grep workflow/hook/`AGENTS.md` dùng đúng tên lệnh; không có lệnh chỉ nằm trong văn xuôi. · Nguồn: catalog 23 §3.3 (`runtime.yaml` sau 11 lần `unverified`)
- [ ] `XC-DX-003` **MUST** Phiên bản runtime và công cụ **ghim trong repo** (`mise.toml`/`.tool-versions`/`.nvmrc`/`.python-version`/`go.mod`/`global.json`) và CI dùng đúng file đó (`setup-node` `node-version-file`, `setup-python` `python-version-file`, `mise-action`). → Kiểm: workflow không hard-code phiên bản khác file; `mise install` thành công từ clone. · Nguồn: [`../01-baseline/dependencies.md`](../01-baseline/dependencies.md) BASE-DEP-003
- [ ] `XC-DX-004` **MUST@L** Dịch vụ phụ cho dev (CSDL, cache, queue, mock API) khởi động bằng **một lệnh** từ cấu hình trong repo (`docker compose up -d` / devcontainer `features`), cùng loại và phiên bản major với prod (dev/prod parity). → Kiểm: `compose.yaml` tồn tại; image tag khớp phiên bản prod; `test` chạy được sau `compose up`. · Nguồn: 12-factor X (dev/prod parity)
- [ ] `XC-DX-005` **MUST@L** `.editorconfig` ở gốc (`root = true`, `charset = utf-8`, `end_of_line = lf`, `insert_final_newline = true`, `indent_*`) và formatter cấu hình trong repo; CI kiểm tuân thủ. → Kiểm: `editorconfig-checker` 0 lỗi; `format --check` 0 diff. · Nguồn: EditorConfig spec
- [ ] `XC-DX-006` **MUST** Hook cục bộ tự cài sau khi cài phụ thuộc và chạy **< 30 s** cho commit thường (chỉ file thay đổi); cổng đầy đủ để CI. → Kiểm: clone + install → `.git/hooks/pre-commit` tồn tại; `time` hook trên commit 5 file < 30 s. · Nguồn: [`../01-baseline/quality-gates.md`](../01-baseline/quality-gates.md) BASE-GATE-015/016
- [ ] `XC-DX-007` **MUST@L** Lỗi do công cụ/script của repo phát ra nói **cái gì sai, ở đâu, làm gì tiếp** (vd "Thiếu biến DATABASE_URL — chép .env.example thành .env"); exit code ≠ 0; không stack trace thô cho lỗi đã biết. → Kiểm: test script với input sai → stderr có gợi ý; review mẫu lỗi trong PR thêm script. · Nguồn: clig.dev (Errors)
- [ ] `XC-DX-008` **MUST@L** Thời gian CI cho PR thường **< 10 phút** đến kết quả cổng; job nặng (E2E đầy đủ, load, release) tách khỏi vòng nhanh; cache phụ thuộc theo lockfile. → Kiểm: `gh run list --json durationMs` trung vị 30 ngày < 600 s cho job `quality`. · Nguồn: DORA (lead time for changes)
- [ ] `XC-DX-009` **MUST@L** Đo **DORA** tự động từ Git/CI/deploy: deployment frequency, change lead time, change fail rate, failed deployment recovery time (+ rework rate); xem xét hằng tháng; không dùng làm KPI cá nhân. → Kiểm: dashboard/báo cáo tháng có 4–5 chỉ số với nguồn dữ liệu tự động. · Nguồn: DORA four keys
- [ ] `XC-DX-010` **SHOULD** Có **Dev Container** (`.devcontainer/devcontainer.json` với `image`/`build`, `features`, `postCreateCommand`, `forwardPorts`) để mở repo là có toàn bộ công cụ; CI có thể dùng cùng image (`devcontainers/ci`). → Kiểm: `devcontainer up --workspace-folder .` (CLI) thành công; `postCreateCommand` chạy `install` + hook. · Nguồn: Dev Container spec (containers.dev)
- [ ] `XC-DX-011` **SHOULD** Dữ liệu mẫu/seed và tài khoản thử cho dev được sinh bằng lệnh (`seed`), không dùng dữ liệu prod; fixture dùng chung với test. → Kiểm: lệnh `seed` tồn tại; không có file dump prod trong repo; xem [`../14-testing-quality/test-data-and-fixtures.md`](../14-testing-quality/test-data-and-fixtures.md). · Nguồn: P11 (quyền riêng tư)
- [ ] `XC-DX-012` **SHOULD** Test chạy được **một file/một case** nhanh (`test -- path`, `-k`, `--filter`) và watch mode; thời gian suite unit < 2 phút tại chỗ. → Kiểm: README DX ghi cách chạy một test; `time test` < 120 s. · Nguồn: SPACE (efficiency & flow)
- [ ] `XC-DX-013` **SHOULD** Onboarding được **đo thật** với người (hoặc agent) mới: thời gian clone → PR đầu tiên qua cổng; ghi lại điểm vướng thành issue; mục tiêu < 1 giờ đến test xanh, < 1 ngày đến PR đầu. → Kiểm: `docs/onboarding-log.md` có ≥ 1 lần đo với ngày và thời gian. · Nguồn: SPACE (satisfaction, performance)
- [ ] `XC-DX-014` **SHOULD** Khảo sát DX ngắn (5–7 câu theo SPACE) mỗi quý; kết quả thành ≤ 3 hành động có owner. → Kiểm: kết quả và hành động ghi trong `docs/dx/`. · Nguồn: SPACE framework (Forsgren et al., ACM Queue 2021)
- [ ] `XC-DX-015` **SHOULD** Tài liệu "cách làm việc" cho người **và** agent là một nguồn: `AGENTS.md` (lệnh, quy ước, ranh giới) được README trỏ tới; không hai bộ hướng dẫn lệch nhau. → Kiểm: README link `AGENTS.md`; lệnh trong `AGENTS.md` khớp `xt.yaml` (script so sánh). · Nguồn: [`docs-for-ai-agents.md`](docs-for-ai-agents.md)
- [ ] `XC-DX-016` **SHOULD** Cấu hình editor khuyến nghị commit ở dạng không ép buộc: `.vscode/extensions.json` (recommendations), `.vscode/settings.json` chỉ các khoá dự án (formatter mặc định), không khoá cá nhân. → Kiểm: `.vscode/settings.json` không chứa `window.*`/`workbench.colorTheme`. · Nguồn: EditorConfig (quy ước độc lập IDE)
- [ ] `XC-DX-017` **MAY** Script `doctor` kiểm môi trường (phiên bản runtime, biến env, dịch vụ phụ, hook) và in cách sửa từng mục. → Kiểm: `npm run doctor`/`just doctor` tồn tại, exit ≠ 0 khi thiếu. · Nguồn: clig.dev
- [ ] `XC-DX-018` **MAY** Review app/preview cho mỗi PR (web) hoặc artefact tải về (CLI/mobile) để người review và agent kiểm thật thay vì đọc diff. → Kiểm: PR có link preview/artefact tự động. · Nguồn: [`../10-workflow/ci-cd-pipeline.md`](../10-workflow/ci-cd-pipeline.md)
- [ ] `XC-DX-019` **MAY** Theo dõi thời gian build/test/CI theo tuần và đặt ngân sách (như hiệu năng sản phẩm); tăng > 20 % → issue. → Kiểm: biểu đồ thời lượng CI 90 ngày. · Nguồn: [`performance-engineering.md`](performance-engineering.md)

## Bẫy thường gặp

- **README liệt kê 14 bước cài tay** → mỗi người mới mất một ngày và cài một kiểu. Ba lệnh + mise/devcontainer.
- **"Works on my machine"**: runtime khác minor, dịch vụ phụ khác phiên bản. Ghim trong repo, parity với prod.
- **Hook 2 phút** → cả đội dùng `--no-verify`, cổng chỉ còn ở CI (nếu còn). Hook chỉ file thay đổi, < 30 s.
- **Lệnh chỉ trong văn xuôi**: agent suy diễn `npm test` trong khi repo dùng `pnpm vitest run` → 11 lần `unverified` (catalog 23). Khai báo máy đọc.
- **Lỗi script là stack trace Python 40 dòng** cho việc "thiếu file .env". Bắt lỗi đã biết, in cách sửa.
- **CI 25 phút** → người mở PR rồi đi làm việc khác, context switch, batch PR to. Tách job nặng khỏi vòng nhanh.
- **DORA làm KPI cá nhân** → người chia nhỏ deploy vô nghĩa, giấu sự cố. DORA là chỉ số hệ thống; SPACE cảnh báo đừng dùng một chỉ số.
- **Seed bằng dump prod** → PII trên laptop dev, vi phạm luật dữ liệu. Sinh seed.
- **Hai bộ hướng dẫn** (README cho người, `AGENTS.md` cho agent) lệch nhau sau một tháng. Một nguồn, hai cửa.
- **`next dev` ghi đè `AGENTS.md`** (case-study catalog 04 §4) — giữ bản gốc trong `docs/` và kiểm drift.

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Onboarding smoke | job CI chạy 3 lệnh README trên runner mới | theo README | CI tuần + khi README/lockfile đổi | exit 0; thời gian ghi artefact |
| Lệnh chuẩn khớp | script so `xt.yaml`/`runtime.yaml` ↔ `package.json#scripts`/`justfile` ↔ workflow | `check:commands` | CI | 0 lệch |
| Phiên bản công cụ | mise v2026.10.8 (MIT) · `setup-*` với `*-version-file` | `mise install && mise doctor` | CI | thành công |
| EditorConfig | editorconfig-checker 7.0.0 (MIT) | `editorconfig-checker` | hook + CI | 0 |
| Devcontainer | devcontainers/cli (MIT; không có release tag ngày 2026-10-13) · `devcontainers/ci` action | `devcontainer up --workspace-folder .` | CI tuần | thành công |
| Thời gian hook/CI | `time`; `gh run list --json durationMs` | script báo cáo | CI/cron | hook < 30 s; CI < 10 phút |
| DORA | Four Keys (Apache-2.0) · dora-metrics từ GitHub API · nền tảng CI | script tháng | cron | báo cáo 4–5 chỉ số |
| Lỗi script | test script với input sai | `test` | CI | stderr có gợi ý, exit ≠ 0 |

## Nguồn

- DORA — The four keys (+ rework rate; failed deployment recovery time thay MTTR): <https://dora.dev/guides/dora-metrics-four-keys/> — xác minh 2026-10-13
- SPACE framework (Forsgren, Storey, Maddila, Zimmermann, Butler, Houck; ACM Queue 2021): <https://queue.acm.org/detail.cfm?id=3454124> — **(chưa xác minh — queue.acm.org trả 403 ngày 2026-10-13; nội dung năm chiều theo kiến thức chung)**
- Dev Container specification (open spec, `devcontainer.json`, features, `postCreateCommand`): <https://containers.dev/>, <https://containers.dev/implementors/json_reference/> — xác minh 2026-10-13
- EditorConfig (`root`, `charset`, `end_of_line`, `insert_final_newline`): <https://editorconfig.org/> — xác minh 2026-10-13; editorconfig-checker 7.0.0 (npm) — xác minh 2026-10-13
- The Twelve-Factor App II Dependencies, X Dev/prod parity: <https://12factor.net/dependencies>, <https://12factor.net/dev-prod-parity> — xác minh 2026-10-13
- Command Line Interface Guidelines (errors, help, exit codes): <https://clig.dev/> — xác minh 2026-10-13
- mise v2026.10.8: <https://github.com/jdx/mise/releases/latest> — xác minh 2026-10-13
- OpenSSF Best Practices Badge `documentation_basics`, `test_invocation`: <https://www.bestpractices.dev/en/criteria/0> — xác minh 2026-10-13
- Catalog `seeker19110/stored` 23 §3.3 (`runtime.yaml` flat key:value; `unverified` 11 lần), 04 §4 (`next dev` ghi đè `AGENTS.md`), 13 §4b (`node:test` thay vitest — "agent chạy test được ngay") theo [`../../research/2026-10-13-stored-catalog-extraction.md`](../../research/2026-10-13-stored-catalog-extraction.md), đọc 2026-10-13; khung cũ X-stored `scripts/dev-task.sh` (phân giải lệnh 3 tầng), commit `1b80fe4`.
