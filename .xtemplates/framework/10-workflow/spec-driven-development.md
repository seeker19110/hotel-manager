---
title: Spec-driven: spec là hợp đồng, tiêu chí chấp nhận, truy vết
kind: module
prefix: WF-SDD
applies_to: [all]
updated: 2026-10-16
---

# Spec-driven: spec là hợp đồng, tiêu chí chấp nhận, truy vết

> Quy trình dùng spec làm **hợp đồng** giữa người, agent và test: không code tính năng khi spec chưa "Approved
> for implementation"; PR `feat` phải link spec; test chấp nhận viết **từ spec** (không từ diff); spec hở → dừng và
> hỏi, không tự đoán. Cách viết spec (cấu trúc, Given/When/Then, ca biên) là nhà của
> [`../17-product-project/specification.md`](../17-product-project/specification.md); mẫu ở [`../templates/SPEC.md`](../templates/SPEC.md).

## Nguyên tắc

1. **Spec là hợp đồng, không phải gợi ý.** Có trạng thái (`draft → review → approved → implemented → superseded`),
   người duyệt, ngày; chỉ `approved` mới được code.
2. **Spec trước test, test trước code.** Tiêu chí chấp nhận máy kiểm (Given/When/Then) chuyển thành test trước
   khi/đồng thời với implement; test là bằng chứng spec đã đạt.
3. **Spec hở thì quyết tường minh (luật cứng).** Thiếu dữ kiện quyết định → ghi câu hỏi vào spec; phiên chính tự
   duyệt theo tiêu chí chất lượng cuối và ghi `D-NNN` ([`LOOP-STOP-018`](../11-autonomous-loop/stop-points-and-escalation.md), ADR-0008); không lấp ngầm, không tự route lại.
4. **Truy vết hai chiều.** Spec ↔ task ↔ PR ↔ test ↔ bằng chứng; đổi spec sau khi approved = phiên bản mới + ghi lý
   do, PR cũ không bị "đổi nghĩa" âm thầm.
5. **Spec là tiêu chí dừng của agent.** Loop tự động chỉ được dừng khi mọi tiêu chí chấp nhận trong spec có test
   xanh; "goal met?" của model không phải bằng chứng.

## Quyết định

| Tình huống | Chọn | Ghi chú |
|---|---|---|
| Tính năng mới, > 1 ngày công hoặc chạm dữ liệu/API/quyền | **Spec đầy đủ** (mẫu SPEC.md: mục tiêu, phạm vi/không phạm vi, luồng, dữ liệu, API, ca biên, tiêu chí chấp nhận, rủi ro) → approved → code | — |
| Thay đổi nhỏ, rõ (fix, copy, refactor không đổi hành vi) | Issue/task có tiêu chí chấp nhận 1–3 dòng + test; không cần spec riêng | Bug sửa ≥ 3 lần cùng chỗ → viết spec, thường là spec sai |
| Thay đổi API/schema | Spec kèm hợp đồng (OpenAPI/migration plan) và ADR nếu là quyết định kiến trúc | — |
| Công cụ SDD cho agent | **Spec Kit** (MIT, trung lập, `specify`/`plan`/`tasks`/`implement`/`converge`) hoặc **OpenSpec** (MIT, nhẹ, change proposals); cả hai còn đổi nhanh — ghim phiên bản | Kiro (độc quyền, khoá AWS), BMAD (áp đặt quy trình) — chỉ khi đã chọn có ADR |
| Nhiều agent song song | Spec + hợp đồng API sinh trước khi chia việc; mỗi agent một lát dọc có spec con | Chia việc trước khi có hợp đồng |
| Spec mâu thuẫn code hiện có | Phiên chính tự quyết theo tiêu chí chất lượng cuối (ADR-0008), ghi D-NNN cạnh "Câu hỏi mở" của spec và cập nhật spec (phiên bản mới) hoặc ADR | Sửa code "cho khớp" mà không ghi quyết định |

## Checklist

- [ ] `WF-SDD-001` **MUST** Mỗi tính năng (user-visible hoặc chạm dữ liệu/API/quyền) có file spec theo [`../templates/SPEC.md`](../templates/SPEC.md) với frontmatter `status`, `approved_by`, `approved_at`; chỉ `status: approved` (hoặc "Approved for implementation") mới được bắt đầu code. → Kiểm: script liệt kê spec thiếu trường/status; PR `feat:` link spec có `status: approved`. · Nguồn: catalog 23 §2.5 (`pr-policy`: feat phải link spec Approved)
- [ ] `WF-SDD-002` **MUST** Tiêu chí chấp nhận viết dạng máy kiểm được (Given/When/Then hoặc bảng input→output), mỗi tiêu chí có ID (`AC-xx`), bao gồm ca biên (rỗng/null/quá dài/race/UTC/tiền) và ca lỗi. → Kiểm: lint spec: mục "Tiêu chí chấp nhận" có ≥ 1 `AC-` và ≥ 1 ca lỗi; xem [`../17-product-project/specification.md`](../17-product-project/specification.md). · Nguồn: lifecycle G3
- [ ] `WF-SDD-003` **MUST** Mỗi `AC-xx` có test tham chiếu ID (tên test hoặc tag) **viết từ spec**, không chỉ test agent sinh từ diff; PR `feat` liệt kê map AC → test. → Kiểm: script grep `AC-\d+` trong test ↔ spec = phủ 100% AC bắt buộc; `pr-policy` kiểm mục map. · Nguồn: khung cũ spec §B3.1a (test viết mù từ spec), P1
- [ ] `WF-SDD-004` **MAY** Ngừng dùng 2026-10-15 — gộp vào [`PM-SPEC-020`](../17-product-project/specification.md) (spec hở → quyết định tường minh D-NNN, ADR-0008).
- [ ] `WF-SDD-005` **MUST@L** Thay đổi spec sau approved → tăng `version`, ghi "Thay đổi" (gì, vì sao, ai duyệt), trạng thái về `review` cho tới khi duyệt lại; PR đang mở theo bản cũ phải cập nhật hoặc ghi rõ dùng bản nào. → Kiểm: diff spec approved mà không tăng version → lint đỏ; PR link spec kèm version. · Nguồn: P5
- [ ] `WF-SDD-006` **MUST@L** Spec nằm trong repo (`docs/specs/` hoặc cạnh code), đi qua PR/review như code; không chỉ trong tool ngoài (Notion/Jira) mà không có bản trong repo. → Kiểm: thư mục spec tồn tại; link từ PR trỏ đường dẫn repo. · Nguồn: docs-as-code ([`documentation-workflow.md`](documentation-workflow.md))
- [ ] `WF-SDD-007` **MUST@L** Mục "Không phạm vi" (out of scope) và "Giả định" bắt buộc có nội dung; ý tưởng bị từ chối ghi lý do (vd `SCOPE.md`/`.out-of-scope/`) để không hỏi lại. → Kiểm: lint spec: hai mục không rỗng. · Nguồn: catalog 20 §3c (SCOPE.md + .out-of-scope/)
- [ ] `WF-SDD-008` **MUST@L** Vòng lặp tự động dùng spec làm tiêu chí dừng: PLAN task `T-xxx` tham chiếu `AC-xx`, `Gate:` là lệnh test tương ứng; không dừng khi còn AC chưa có bằng chứng xanh. → Kiểm: `PLAN.md` mỗi task có `Gate:`; `xt.py loop status` không `done` khi AC thiếu bằng chứng; xem [`../11-autonomous-loop/loop-design.md`](../11-autonomous-loop/loop-design.md). · Nguồn: catalog 03 §5, 13 §5
- [ ] `WF-SDD-009` **MUST@L** Thay đổi API/schema: spec kèm hợp đồng máy đọc (OpenAPI/proto/migration plan) sinh **trước** khi chia việc cho nhiều người/agent; contract test từ hợp đồng. → Kiểm: PR spec chứa/ link file hợp đồng; xem [`../08-backend/api-design.md`](../08-backend/api-design.md).
- [ ] `WF-SDD-010` **MUST@L** Người duyệt spec ≠ người viết khi đội ≥ 2; vùng nhạy cảm (auth, payment, PII) có review bảo mật/threat model trước approved ([`../12-security/threat-modeling.md`](../12-security/threat-modeling.md)). → Kiểm: `approved_by` ≠ `author`; spec vùng nhạy cảm link threat model.
- [ ] `WF-SDD-011` **SHOULD** "Sprint contract" cho agent: trước mỗi lát, generator đề xuất phạm vi + cách xác minh, evaluator/người duyệt; cầu nối giữa spec cao cấp và việc kiểm được. → Kiểm: PLAN task có mục "cách xác minh" được duyệt trước khi code. · Nguồn: Anthropic harness design (catalog 21 §2.2)
- [ ] `WF-SDD-012` **SHOULD** Spec có mục "Bằng chứng hoàn thành" điền sau khi xong: link PR, CI run, test AC, demo/preview; `status: implemented` chỉ khi mục này đủ. → Kiểm: lint: `implemented` mà thiếu link PR/CI → đỏ. · Nguồn: P1
- [ ] `WF-SDD-013` **SHOULD** Bug lặp ≥ 3 lần cùng chỗ hoặc sửa vòng thứ 4 → dừng sửa code, mở lại spec (thường spec sai), ghi ADR/TRAPS. → Kiểm: `fix:` PR thứ 3 cùng module trong 30 ngày → nhãn `spec-review`. · Nguồn: khung cũ spec §B6.3 (rework cap 3), catalog 23 §2.6
- [ ] `WF-SDD-014` **SHOULD** Spec viết ngắn, một tính năng một file, ≤ ~300 dòng; lớn hơn → tách epic thành spec con có phụ thuộc. → Kiểm: lint độ dài; spec lớn có mục "Spec con".
- [ ] `WF-SDD-015` **SHOULD** Dùng công cụ SDD có ghim phiên bản (Spec Kit `specify-cli` / OpenSpec) hoặc skill `/research` + template của khung; không trộn hai quy trình trong một repo. → Kiểm: ADR chọn công cụ; lockfile/phiên bản ghi.
- [ ] `WF-SDD-016` **MAY** Sinh test khung (skeleton) từ AC bằng agent, người/evaluator duyệt trước khi implement. → Kiểm: test skeleton có `AC-` tag, trạng thái `todo/skip` có lý do cho tới khi implement.
- [ ] `WF-SDD-017` **MAY** Spec song ngữ/thuật ngữ thống nhất (glossary) cho đội đa ngôn ngữ; thuật ngữ nghiệp vụ là một nguồn. → Kiểm: `docs/GLOSSARY.md` tồn tại và được link từ spec.

## Bẫy thường gặp

- **Code trước, spec "viết lại cho khớp" sau.** Spec thành tài liệu mô tả code, mất chức năng hợp đồng. Trạng thái approved trước PR.
- **Test sinh từ diff.** Agent viết code rồi viết test cho code đó → luôn xanh, không chứng minh spec. Test từ AC, viết mù.
- **Agent tự đoán khi spec hở.** "Chắc ý là X" → làm sai → sửa 3 vòng. Dừng và hỏi là luật cứng; chi phí hỏi < chi phí làm sai.
- **Spec đổi trong Jira, repo không biết.** PR link spec bản cũ. Spec trong repo, version tăng.
- **Tiêu chí chấp nhận "hệ thống phải nhanh và an toàn".** Không kiểm được. Số đo + Given/When/Then.
- **Spec 2.000 dòng cho một epic.** Không ai đọc hết; agent mất context. Tách spec con.
- **Sửa code vòng thứ 4.** Gần như luôn là spec sai (khung cũ §B6.3). Quay về G3.
- **Chọn Kiro/BMAD vì "có sẵn quy trình".** Khoá vendor/áp đặt quy trình trái với khung. Spec Kit/OpenSpec trung lập hoặc template khung.
- **Mâu thuẫn nguồn:** research `13 §5` ghi Spec Kit "còn breaking changes"; README Spec Kit hiện ghi phase `converge` mới (xác minh 2026-10-13) — xác nhận công cụ đổi nhanh, khung yêu cầu **ghim phiên bản** (`specify-cli` 1.1.3, `@fission-ai/openspec` 1.14.1 ngày 2026-10-13).

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| Spec lint (tự viết) | script kiểm frontmatter (`status`, `version`, `approved_by`), mục bắt buộc không rỗng, ≥ 1 `AC-`, độ dài | pre-commit + CI | 0 lỗi |
| pr-policy | `feat:` phải link spec `status: approved`; body có map AC → test | CI | Đỏ khi thiếu |
| AC coverage | grep `AC-\d+` trong tests ↔ spec | CI | 100% AC bắt buộc |
| Autopilot | `xt.py loop status` — task có `Gate:` xanh mới `done`; spec hở → `loop block` | Stop hook | Fail-closed |
| Spec version guard | diff file spec approved mà `version` không tăng → đỏ | CI | — |
| Công cụ SDD (xác minh 2026-10-13, xác minh lại trước khi dùng) | Spec Kit `specify-cli` 1.1.3 (MIT) · OpenSpec `@fission-ai/openspec` 1.14.1 (MIT) | dev | Ghim phiên bản |
| Rework cap | nhãn `spec-review` khi ≥ 3 `fix:` cùng module/30 ngày | CI schedule | Thông báo |

## Nguồn

- GitHub Spec Kit README (MIT; constitution/specify/plan/tasks/implement/converge; `uv tool install specify-cli`): <https://github.com/github/spec-kit#readme> — xác minh 2026-10-13; `specify-cli` 1.1.3 (PyPI) — xác minh 2026-10-13
- OpenSpec `@fission-ai/openspec` 1.14.1 (npm) — xác minh 2026-10-13; (chưa xác minh) README OpenSpec — không fetch ngày 2026-10-13.
- Anthropic — Harness design for long-running application development (sprint contract, generator/evaluator): <https://www.anthropic.com/engineering/harness-design-long-running-apps> — theo `research/2026-10-13-stored-catalog-extraction.md` §2.10 và catalog 21 §2.2 (đọc 2026-10-12); không fetch lại ngày 2026-10-13.
- DORA — Working in small batches (INVEST, batch > 1 tuần là quá lớn): <https://dora.dev/capabilities/working-in-small-batches/> — xác minh 2026-10-13
- Khung cũ X-stored commit `1b80fe4`: `docs/specs/AI-HARNESS-AND-COMPANY-SPEC.md` §B3.1a (test viết mù từ spec), §B6.3 (rework cap 3 → leo thang), `docs/framework/project-completion.md` (truy vết F→W→PR→bằng chứng).
- `research/2026-10-13-stored-catalog-extraction.md` §2.8 (Spec Kit/Kiro/BMAD/OpenSpec; spec là hợp đồng và tiêu chí dừng; PR feat link spec; spec hở thì dừng; grill: sự thật tự tra, quyết định hỏi người), §2.9 (SCOPE.md); catalog `13-dev-stack-devops` §5; `23-own-repos-lessons` §2.3, §2.5, §4.3 (AI Delivery Loop).
