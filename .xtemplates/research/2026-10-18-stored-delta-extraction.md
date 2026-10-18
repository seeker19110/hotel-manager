---
title: Trích xuất phần mới của catalog seeker19110/stored (10ecf8b..a1a1f51)
kind: research
updated: 2026-10-18
---

# Trích xuất phần mới của catalog seeker19110/stored (đợt 2026-10-18)

Bổ sung cho [`2026-10-13-stored-catalog-extraction.md`](2026-10-13-stored-catalog-extraction.md) (không sửa file đó). Ký hiệu
`NN §x` là chuyên mục NN, mục x của catalog.

## 1. Phạm vi

- Khoảng commit của `seeker19110/stored`: `10ecf8b..a1a1f51`.
- Nguồn ngoài đã xác minh ngày 2026-10-18: polkit(8)/pkexec(1), Apple `setCodeSigningRequirement`, SPDX 3.0.1,
  CycloneDX ML-BOM, URL registry (npm, PyPI, crates.io, Go proxy), tester-army/e2e (`docs/cache.mdx`,
  `docs/security.mdx`), gitleaks, OpenSSF Scorecard, arXiv:2410.10813 và arXiv:2402.17753.
- Mọi mục sinh ra có ngày rà 2026-10-18 ở phần *Nguồn* của mục.

## 2. Bài học → ID

| Bài học (stored) | ID | Trạng thái |
|---|---|---|
| Phương pháp đánh giá nguồn: chính chủ qua hai phép thử, license tầng dưới, repo trùng tên, tuyên bố → tự đo, huy hiệu tĩnh, affiliate, SHA đã đọc (README §22–§27, 08 §2d.1–2d.3) | [`SEC-SUPPLY-027`](../framework/12-security/supply-chain.md) + `/research` + `researcher` | **Đã thêm**; nền là `SEC-SUPPLY-025`/`026` và `CMP-LIC-019` (đã có) — `SEC-SUPPLY-027` chỉ gom bốn ý còn thiếu và trỏ về ba mục đó |
| Thành phần tải lúc chạy nằm ngoài SBOM, license không-OSI tầng dưới (10 §4b) | [`CMP-LIC-021`](../framework/16-compliance-privacy/licensing-and-ip.md) | **Đã thêm** (liền kề `CMP-LIC-020` license model) |
| Lệnh cài ghim bản trỏ bản chưa phát hành (19 §1d) | [`WF-DOC-019`](../framework/10-workflow/documentation-workflow.md) | **Đã thêm** |
| Số/tuyên bố năng lực trong README do CI sinh, điều chưa kiểm ghi known-gaps (06 §7d–7e, 17 §2c) | `WF-DOC-020` (dự định) | **Đã có sẵn**: [`BASE-DOC-017`](../framework/01-baseline/documentation-minimum.md) (số công bố ↔ file kết quả, test so lệch) và `BASE-DOC-018` (`docs/limitations.md`). Không thêm `WF-DOC-020` (một chủ đề một nhà); bổ sung câu về tuyên bố năng lực và marker `<!-- ci:value:NAME -->` vào `BASE-DOC-017` |
| Test có bước agent: required chỉ phát lại cache (tester-army/e2e) | [`QA-E2E-027`](../framework/14-testing-quality/e2e-and-accessibility.md) | **Đã thêm** (MAY); bẫy "agent làm cổng" ở cùng file đã có |
| Video/download/cache agent không che giá trị đã gõ → `gitleaks dir` trước upload | `QA-E2E-028` | **Đã thêm**; `QA-E2E-008`/`WF-CI-019` (đã có) chỉ nói upload và không upload bí mật |
| So sánh số khác benchmark/metric (LongMemEval, LoCoMo; 10 §4b) | [`AI-EVAL-020`](../framework/13-ai-engineering/evaluation.md) | **Đã thêm**; luật chung "benchmark tự công bố" đã có ở `PM-RISK-014`, `XC-PERF-009`, `evidence-and-sources.md` luật 11 |
| Tool ghi của agent nhận `expected_version` (19 §1d, §1b) | [`AI-AGENT-023`](../framework/13-ai-engineering/agents-and-tools.md) | **Đã thêm**, trỏ `BE-API-014`, `DB-TX-014` |
| Helper nâng quyền chạy lệnh tuỳ ý, `auth_self_keep` (13 §6e) | [`PRF-DESK-018`](../framework/02-profiles/desktop-app.md) (MUST), [`PRF-CLI-021`](../framework/02-profiles/cli-tool.md) | **Đã thêm** |
| Reviewer rà Gate của PLAN trước khi duyệt (01 §3g.3) | [`LOOP-ORCH-018`](../framework/11-autonomous-loop/orchestration-and-subagents.md) | **Đã thêm**; tham chiếu `LOOP-STOP-027` (mục mới ở PR khác) ghi dạng chữ |
| Điểm/huy hiệu tự chấm không phải bằng chứng (09 §2b) | [`CMP-AUDIT-020`](../framework/16-compliance-privacy/records-and-audit-readiness.md) | **Đã thêm** (MAY) |
| Media trả phí: validate trước, sha256 đầu vào, `stale` (19 §1d) | [`IND-MEDIA-022`](../framework/03-industries/media-content.md) | **Đã thêm** |
| CLI agent nhúng dùng thư mục cấu hình riêng (19 §1b, 11 §1c) | [`PRF-AGENT-022`](../framework/02-profiles/ai-agent.md) | **Đã thêm** (MAY) |

## 3. Chưa xác minh / lưu ý

- **Tên binary của Cursor CLI** (`cursor-agent` hay tên khác): chưa xác minh từ nguồn chính thức; không đưa vào mục nào.
- **Amp `--dangerously-allow-all`**: chỉ thấy trong tài liệu E2B/SDK, chưa thấy trong tài liệu chính thức của Amp; không đưa vào mục nào.
- **Số liệu LoCoMo**: số trong arXiv v1 khác bản ACL 2024; `AI-EVAL-020` chỉ dẫn metric (F1 partial match) và giấy phép repo (CC BY-NC 4.0), không dẫn con số kết quả.
- Mục `PRF-DESK-018` đặt mức MUST (không bị trần 4 MUST/module vì áp cho `module`/`standard`, không cho `profile`); nếu muốn phù hợp quy mô nhỏ hơn, hạ thành `MUST@M` ở phiên sau.
- Các mô tả "stored NN §x" lấy từ nội dung phiên giao việc, chưa mở lại từng mục catalog trong phiên này (chưa xác minh trực tiếp).
