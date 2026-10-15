---
title: Tài liệu sống: ADR, runbook, docs-as-code, tươi bằng máy
kind: module
prefix: WF-DOC
applies_to: [all]
updated: 2026-10-14
---

# Tài liệu sống: ADR, runbook, docs-as-code, tươi bằng máy

> Tài liệu là code: trong repo, qua PR, có lint, có link check, và **tươi bằng máy** — SHA ghi trong PROGRESS/STATUS
> phải là tổ tiên của HEAD, bảng cấu hình/API sinh từ nguồn. Bộ tài liệu tối thiểu ở
> [`../01-baseline/documentation-minimum.md`](../01-baseline/documentation-minimum.md); ADR ở
> [`../05-architecture/decision-records.md`](../05-architecture/decision-records.md); tài liệu cho agent ở
> [`../18-cross-cutting/docs-for-ai-agents.md`](../18-cross-cutting/docs-for-ai-agents.md).

## Nguyên tắc

1. **Docs-as-code.** Markdown trong repo, cùng PR với code thay đổi hành vi, cùng review, cùng CI.
2. **Sinh ra, đừng chép.** Cái gì có nguồn máy đọc (schema env, OpenAPI, CLI `--help`, danh sách job) thì tài liệu
   sinh từ đó; viết tay chỉ phần "vì sao" và "cách dùng".
3. **Tươi là điều kiện CI, không phải lời nhắc.** Link chết, SHA cũ, file được nhắc không tồn tại, lệnh trong
   README không chạy → CI đỏ.
4. **Tài liệu "tại sao" sống lâu hơn tài liệu "cái gì".** ADR cho quyết định, TRAPS/bài học cho lỗi lặp, runbook
   cho vận hành; đính chính giữ dấu vết, không xoá.
5. **Ngắn, một nhà, trỏ tới.** Một chủ đề một file; nơi khác link; `PROGRESS.md` ≤ 8 KB, 4 mục để phiên sau đọc
   nhanh (người hoặc agent).

## Quyết định

| Loại tài liệu | Ở đâu | Tươi bằng gì |
|---|---|---|
| `README.md` (chạy được trong 10 phút) | gốc repo | Lệnh trong README là lệnh CI chạy thật (smoke `README` block) |
| `PROGRESS.md` (trạng thái, 4 mục, ≤ 8 KB) | gốc repo | SHA ghi trong file là tổ tiên HEAD; đổi cùng code; kích thước |
| ADR | `docs/adr/NNNN-*.md` | Không sửa ADR cũ; status; link từ code/PR |
| Spec | `docs/specs/` | Lint + version ([`spec-driven-development.md`](spec-driven-development.md)) |
| Runbook/incident | `docs/ops/` | Diễn tập có ngày; lệnh chạy được |
| API/CLI/config reference | sinh vào `docs/reference/` | Job sinh + diff = rỗng trong CI |
| Tài liệu cho agent (`AGENTS.md`, `CLAUDE.md`, skill) | gốc/`.claude/` | Hợp đồng repo validator; "grep cổng đang chạy, đừng tin văn xuôi" |
| Tài liệu người dùng cuối | site docs (Docusaurus/MkDocs/VitePress) từ `docs/` | Build + link check; versioning theo release |
| Diagram | Mermaid/PlantUML/D2 dạng text trong repo | Render trong CI; không ảnh PNG không nguồn |

## Checklist

- [ ] `WF-DOC-001` **MUST** Tài liệu ở dạng text trong repo (Markdown/AsciiDoc), thay đổi hành vi đi cùng PR với cập nhật tài liệu liên quan; không có "sẽ cập nhật docs sau". → Kiểm: PR template mục "Docs cập nhật/không cần (lý do)"; `pr-policy` cảnh báo khi đổi public API/CLI/config mà không chạm `docs/`. · Nguồn: Write the Docs — Docs as Code
- [ ] `WF-DOC-002` **MUST** Link check nội bộ + ngoại trong CI: mọi link tương đối trỏ file có thật; link ngoài không 404 (cache, retry, allowlist domain chặn bot). → Kiểm: `lychee` hoặc `scripts/check-links.py` exit 0. · Nguồn: P5
- [ ] `WF-DOC-003` **MUST@L** Mọi đường dẫn/tên file/lệnh được nhắc trong tài liệu phải tồn tại/chạy được (docs-consistency); đổi tên file → CI bắt nơi còn nhắc tên cũ. → Kiểm: script quét backtick path ↔ filesystem; allowlist cho file sinh tại đích. · Nguồn: khung cũ `scripts/check-docs-consistency.sh`
- [ ] `WF-DOC-004` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`LOOP-HARNESS-004`](../11-autonomous-loop/harness-files.md)/[`005`](../11-autonomous-loop/harness-files.md): định dạng (4 mục, ≤ 8 KB) và độ tươi `PROGRESS.md` (SHA là tổ tiên HEAD và của nhánh chính). Điều kiện cũ "nhánh nêu tên còn trên remote" bỏ vì xung đột với squash-merge xoá nhánh.
- [ ] `WF-DOC-005` **MUST@L** Quyết định kiến trúc/công nghệ lớn có ADR (đánh số tăng, status, context, options, decision, consequences); không sửa ADR cũ, đổi ý = ADR mới `supersedes`. → Kiểm: `docs/adr/` có template + ADR; lint số liên tục + frontmatter; xem [`../05-architecture/decision-records.md`](../05-architecture/decision-records.md). · Nguồn: adr.github.io
- [ ] `WF-DOC-006` **MUST@L** README gốc có: mục đích 1 đoạn, cách chạy local ≤ 10 phút (lệnh thật), cách test, cấu trúc thư mục, link tới PROGRESS/ADR/spec/runbook; lệnh trong README được CI chạy thử (hoặc README gọi cùng script CI). → Kiểm: job "README smoke" chạy block lệnh đánh dấu; xem [`../01-baseline/documentation-minimum.md`](../01-baseline/documentation-minimum.md).
- [ ] `WF-DOC-007` **MUST@L** Tài liệu tham chiếu có nguồn máy đọc (bảng env, OpenAPI docs, CLI help, danh sách job/cron, danh sách flag) được **sinh** và CI kiểm `diff` = rỗng sau khi sinh lại. → Kiểm: job `docs:generate && git diff --exit-code docs/reference`. · Nguồn: P5
- [ ] `WF-DOC-008` **MUST@M** Runbook vận hành (`docs/ops/RUNBOOK.md` theo [`../templates/RUNBOOK.md`](../templates/RUNBOOK.md)) cho: deploy, rollback, khôi phục backup, xoay secret, sự cố thường gặp — mỗi mục có lệnh thật và ngày diễn tập gần nhất ≤ 6 tháng. → Kiểm: lint runbook có trường `last_drilled`; cảnh báo quá hạn. · Nguồn: lifecycle G8, [`../15-operations/incident-response.md`](../15-operations/incident-response.md)
- [ ] `WF-DOC-009` **MUST@L** Lỗi lặp/sự cố → mục trong `TRAPS.md` (bẫy, dấu hiệu, cách tránh, link PR/post-mortem) và/hoặc hàng rào máy; post-mortem theo [`../templates/POST-MORTEM.md`](../templates/POST-MORTEM.md). → Kiểm: mỗi post-mortem có ≥ 1 hành động là hàng rào (test/lint/hook/checklist) có link PR. · Nguồn: P12, catalog 23 §4.3 (`/hoc` thang mức bền)
- [ ] `WF-DOC-010` **MUST@L** Markdown lint (heading, link, code fence có ngôn ngữ, không trailing space) và kiểm chính tả/thuật ngữ cho tài liệu người dùng. → Kiểm: `markdownlint-cli2` exit 0; `cspell`/`typos` với từ điển dự án.
- [ ] `WF-DOC-011` **MUST@L** Tài liệu người dùng/API có phiên bản theo release (docs vX.Y), changelog người dùng, và quy trình review nội dung bởi người không viết code. → Kiểm: site docs có version switcher; PR docs có reviewer khác tác giả.
- [ ] `WF-DOC-012` **SHOULD** Đính chính giữ dấu vết: nội dung sai sửa kèm "đính chính ngày …", không xoá lịch sử; số liệu/phiên bản kèm ngày xác minh. → Kiểm: grep "đính chính" tồn tại khi có sửa số liệu; lint phiên bản thiếu ngày trong `docs/` (regex `v\d+\.\d+` không kèm `20\d\d-`). · Nguồn: `evidence-and-sources.md` §1 luật 4, 12
- [ ] `WF-DOC-013` **SHOULD** Diagram dạng text (Mermaid/D2/PlantUML) trong repo, render trong CI; C4 mức 1–2 cho kiến trúc, cập nhật cùng ADR. → Kiểm: file `.mmd`/`.d2` render không lỗi; không PNG không có nguồn text.
- [ ] `WF-DOC-014` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`XC-DOCAI-002`](../18-cross-cutting/docs-for-ai-agents.md) (bridge chỉ trỏ về `AGENTS.md`) và [`XC-DOCAI-003`](../18-cross-cutting/docs-for-ai-agents.md) (lệnh trong `xt.yaml` khớp điểm vào thật).
- [ ] `WF-DOC-015` **SHOULD** Mỗi thư mục tài liệu có `README.md` chỉ mục (file → nội dung → đọc khi nào); tài liệu không được link từ đâu → cảnh báo mồ côi. → Kiểm: script tìm `.md` không có inbound link.
- [ ] `WF-DOC-016` **SHOULD** Bàn giao phiên/người (handover) ghi vào `PROGRESS.md` mục "Bàn giao": đang dở gì, bước tiếp theo, lệnh để tiếp tục, cái gì chưa xác minh. → Kiểm: mục "Bàn giao" không rỗng khi có việc dở ([`team-and-wip.md`](team-and-wip.md)); định dạng và độ tươi theo [`LOOP-HARNESS-004`](../11-autonomous-loop/harness-files.md)/[`005`](../11-autonomous-loop/harness-files.md).
- [ ] `WF-DOC-017` **MAY** Site tài liệu build từ `docs/` (MkDocs/Docusaurus/VitePress) với search và link check; deploy preview cho PR docs. → Kiểm: job build docs + preview URL.
- [ ] `WF-DOC-018` **MAY** `llms.txt`/`docs-for-ai` tóm tắt kiến trúc cho agent, sinh từ chỉ mục; kiểm tươi như tài liệu khác. → Kiểm: file sinh, diff rỗng trong CI; xem [`../18-cross-cutting/docs-for-ai-agents.md`](../18-cross-cutting/docs-for-ai-agents.md).

## Bẫy thường gặp

- **PROGRESS ghi "GĐ 7, nợ kỹ thuật: không có" trong khi còn 3 việc treo** (khung cũ, `old-framework-analysis.md` §3b). Nhật ký tự khai không ai kiểm → máy kiểm SHA tổ tiên + đổi cùng code.
- **README nhắc file đã đổi tên.** Người mới chạy lệnh không tồn tại. docs-consistency trong CI.
- **Bảng cấu hình viết tay.** Lệch schema sau 2 tuần. Sinh từ schema, diff rỗng.
- **ADR bị sửa để "cập nhật".** Mất lý do lịch sử. ADR mới supersedes.
- **Runbook chưa bao giờ chạy.** Lệnh sai ở lần sự cố đầu. Diễn tập có ngày ≤ 6 tháng.
- **Tài liệu ở Notion, code ở repo.** Agent và CI không thấy; lệch âm thầm. Bản trong repo là gốc, Notion là bản sao (nếu cần).
- **Link check bị tắt vì "ngoài hay 403".** Mất luôn kiểm link nội bộ. Tách: nội bộ fail-closed, ngoài allowlist/retry.
- **PROGRESS 376 dòng chứa nhật ký repo khác** (khung cũ). Phiên sau nạp hết context. ≤ 8 KB, 4 mục, lịch sử sang CHANGELOG.
- **Xoá số liệu sai để "cho sạch".** Mất bằng chứng đã sai ở đâu. Đính chính có ngày.

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| Link check | lychee 0.24.2 (MIT/Apache-2.0) `lychee --no-progress --cache --max-cache-age 1d docs/ README.md` hoặc `python3 scripts/check-links.py` | CI | Nội bộ 0 lỗi; ngoài 0 lỗi trừ allowlist |
| docs-consistency | script quét backtick path trong `*.md` ↔ filesystem; danh sách tên cũ | CI | 0 |
| progress-check | `xt.py progress-check` (luật ở [`LOOP-HARNESS-004`](../11-autonomous-loop/harness-files.md)/[`005`](../11-autonomous-loop/harness-files.md)) | pre-push + CI | Exit 0 |
| markdownlint-cli2 (MIT) 0.23.3 | `markdownlint-cli2 "**/*.md"` | pre-commit + CI | 0 lỗi |
| Reference docs | `docs:generate && git diff --exit-code docs/reference` | CI | Diff rỗng |
| ADR lint | script: số liên tục, frontmatter status, không sửa ADR có status accepted (diff chỉ cho phép đổi status → superseded) | CI | 0 |
| README smoke | chạy block lệnh đánh dấu `<!-- ci:run -->` | CI | Exit 0 |
| Runbook drill | lint `last_drilled` ≤ 180 ngày | CI schedule | Cảnh báo |
| Mồ côi | script inbound-link cho `docs/**/*.md` | CI | Cảnh báo |

## Nguồn

- Write the Docs — Docs as Code: <https://www.writethedocs.org/guide/docs-as-code/> — xác minh 2026-10-13
- adr.github.io — Architectural Decision Records: <https://adr.github.io/> — xác minh 2026-10-13
- git-merge-base `--is-ancestor` (exit 0/1): <https://git-scm.com/docs/git-merge-base> — xác minh 2026-10-13
- Keep a Changelog 1.1.0 (lịch sử ↔ CHANGELOG): <https://keepachangelog.com/en/1.1.0/> — xác minh 2026-10-13
- Phiên bản (crates.io/npm, xác minh 2026-10-13): lychee 0.24.2, markdownlint-cli2 0.23.3. (chưa xác minh) cspell, typos, MkDocs/Docusaurus/VitePress.
- Khung cũ X-stored commit `1b80fe4`: `scripts/check-docs-consistency.sh` + job `docs-consistency`; `research/2026-10-13-old-framework-analysis.md` §3b (PROGRESS mâu thuẫn, README liệt kê lỗi thời), §4.
- `research/2026-10-13-stored-catalog-extraction.md` §2.7 (SHA tổ tiên HEAD, `validate_repo.py`), §2.11 (`/hoc` thang mức bền), §4 (PROGRESS ≤ 8 KB, 4 mục), §5 (giữ đính chính); catalog `21-autonomous-workflows` §8 mục 9; `23-own-repos-lessons` §2.4, §4.3, §4.5; `16-docs-tools` (docs-for-AI, theo research §2.14).
