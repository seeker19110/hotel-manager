---
title: Đặc tả: user story, Given/When/Then, ca biên, hợp đồng API, truy vết
kind: module
prefix: PM-SPEC
applies_to: [all]
updated: 2026-10-15
---

# Đặc tả: user story, Given/When/Then, ca biên, hợp đồng API, truy vết

> Đầu ra của **G3 (Specify)**: mỗi tính năng MVP có một spec là **hợp đồng** giữa người đặt hàng, người xây và máy
> kiểm — tiêu chí chấp nhận dạng Given/When/Then, ca biên liệt kê trước, hợp đồng API chốt trước khi chia việc, và
> chuỗi truy vết yêu cầu → spec → task → PR → bằng chứng. Quy trình *dùng* spec để chạy (spec-driven, agent song
> song) ở [`../10-workflow/spec-driven-development.md`](../10-workflow/spec-driven-development.md); mẫu ở
> [`../templates/SPEC.md`](../templates/SPEC.md) và [`../templates/API-CONTRACT.md`](../templates/API-CONTRACT.md).

## Nguyên tắc

1. **Spec nói "cái gì" và "đúng là thế nào", không nói "code thế nào".** Cách triển khai thuộc ADR/PLAN.
2. **Tiêu chí chấp nhận là thứ máy chạy được.** Given/When/Then viết sao cho chuyển thẳng thành test; mỗi scenario có ID để test trỏ về.
3. **Ca biên liệt kê trước khi code**, không đợi QA tìm: rỗng, cực đại, trùng, song song, mất mạng giữa chừng, múi giờ, quyền, tiền/đơn vị.
4. **Hợp đồng trước, chia việc sau.** API/sự kiện/schema giữa hai phần (front–back, service–service, agent–tool) được viết và duyệt trước khi hai bên làm song song.
5. **Spec hở thì quyết tường minh.** Gặp điểm spec không nói → không lấp ngầm, không "route lại để tránh hỏi" (catalog 23 §2.3); ghi câu hỏi mở, phiên chính tự duyệt theo tiêu chí chất lượng cuối và ghi `D-NNN` cạnh câu hỏi ([`../11-autonomous-loop/stop-points-and-escalation.md`](../11-autonomous-loop/stop-points-and-escalation.md), ADR-0008).
6. **Truy vết hai chiều.** Từ `R-NNN` (yêu cầu) → `F-NNN` (tính năng/spec) → `T-NNN` (task) → PR → bằng chứng; ngược lại mỗi PR nêu spec nó phục vụ. Không có task "mồ côi".
7. **Spec có vòng đời.** Draft → Approved for implementation → Implemented → Superseded; sửa sau khi Approved phải tăng phiên bản và ghi lý do.

## Quyết định

| Độ phức tạp × độ rõ | Mức spec tối thiểu | Ghi chú |
|---|---|---|
| Nhỏ, rõ, một người làm trong ≤1 ngày | User story + ≥1 scenario Given/When/Then ngay trong issue/PR | Vẫn phải có ca biên và DoD |
| Trung bình, chạm dữ liệu hoặc ≥2 màn hình | `docs/specs/SPEC-<slug>.md` theo mẫu: story, scenario, ca biên, dữ liệu, trạng thái UI, lỗi | Mặc định cho tính năng MVP |
| Có ranh giới giữa hai thành phần/đội/agent | SPEC + `API-CONTRACT` (OpenAPI/JSON Schema/AsyncAPI/proto) duyệt trước khi chia việc | Contract test ở [`../14-testing-quality/integration-and-contract.md`](../14-testing-quality/integration-and-contract.md) |
| Đổi kiến trúc, đổi stack, không đảo ngược được | SPEC + ADR ([`../05-architecture/decision-records.md`](../05-architecture/decision-records.md)) + threat model nếu chạm auth/tiền/dữ liệu cá nhân | Điểm dừng bắt buộc: người duyệt |

| Hình thức tiêu chí chấp nhận | Dùng khi | Không dùng khi |
|---|---|---|
| Gherkin Given/When/Then (mặc định) | Hành vi quan sát được từ ngoài: UI, API, CLI | Logic thuần số học — dùng bảng ca ví dụ |
| Scenario Outline + bảng Examples | Cùng một luồng, nhiều bộ dữ liệu (ca biên, i18n, đơn vị) | Mỗi dòng cần bước khác nhau |
| Bảng đầu vào → đầu ra | Hàm tính toán, quy tắc nghiệp vụ, parser | Luồng nhiều bước |
| Sơ đồ sequence/state | Giao tiếp nhiều thành phần, máy trạng thái (đơn hàng, phiên) | Tính năng một bước |

## Checklist

- [ ] `PM-SPEC-001` **MUST** Mỗi tính năng MVP (`F-NNN` trong `PROJECT.md`) có spec theo mẫu, trạng thái "Approved for implementation" trước khi task đầu tiên bắt đầu. → Kiểm: `ls docs/specs/SPEC-*.md`; mỗi `F-NNN` có file chứa dòng `Trạng thái: Approved`.
- [ ] `PM-SPEC-002` **MUST@L** Mỗi user story đạt INVEST và có ≥1 scenario Given/When/Then có ID `S-NNN`. → Kiểm: `rg -c "^\s*(Given|Khi có|When|Then)" docs/specs/SPEC-*.md` > 0 cho mỗi file; ID scenario không trùng.
- [ ] `PM-SPEC-003` **MUST** Mục "Ca biên" không rỗng và rà đủ nhóm: rỗng/null, cực đại, trùng lặp/idempotency, song song, mất mạng giữa chừng, thời gian/múi giờ, quyền, tiền/đơn vị (cách làm đúng ở [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md)). → Kiểm: bảng ca biên có cột "nhóm" phủ ≥6/8 nhóm hoặc ghi "không áp dụng" có lý do.
- [ ] `PM-SPEC-004` **MUST** Mỗi scenario có ≥1 test tự động trỏ về ID của nó; scenario chưa có test thì tính năng chưa Done. → Kiểm: `rg -l "S-[0-9]{3}" tests/ e2e/ src/` phủ mọi `S-NNN` trong spec (script so khớp hai danh sách).
- [ ] `PM-SPEC-005` **MUST@L** Hợp đồng API/sự kiện/schema giữa hai thành phần được viết (OpenAPI 3.x, JSON Schema 2020-12, proto, AsyncAPI) và duyệt **trước** khi chia việc song song. → Kiểm: file contract có trong PR đầu tiên của tính năng; `redocly lint openapi.yaml` hoặc `spectral lint` xanh.
- [ ] `PM-SPEC-006` **MUST@L** Chuỗi truy vết đầy đủ: PR body ghi `Spec: SPEC-<slug> (F-NNN)`; task trong `PLAN.md` ghi `F-NNN`; bằng chứng ở `.autopilot/evidence/T-NNN.json` hoặc CI. → Kiểm: `rg -n "Spec: SPEC-" .github/pull_request_template.md`; CI job kiểm PR body có `Spec:` với PR `feat:`.
- [ ] `PM-SPEC-007` **MAY** Ngừng dùng 2026-10-15 — thay bằng `PM-SPEC-020` (ADR-0008: spec hở là điểm quyết định phiên chính tự duyệt, không `loop block`).
- [ ] `PM-SPEC-008` **MUST@L** Task chỉ bắt đầu khi đạt Definition of Ready: spec Approved, 0 câu hỏi mở chặn, phụ thuộc xác định, đủ nhỏ cho một PR, có Gate máy kiểm. → Kiểm: mục DoR trong spec tick đủ; task trong `PLAN.md` có `Gate:`.
- [ ] `PM-SPEC-009` **MUST@L** Definition of Done của tính năng gồm: mọi scenario xanh, ca biên có test, cổng commit/merge xanh, tài liệu người dùng/API cập nhật, chỉ số đo được gắn sự kiện. → Kiểm: PR template có mục DoD; CI `gate` xanh; `blueprint-status` không mở MUST liên quan.
- [ ] `PM-SPEC-010` **MUST@L** Nhánh lỗi được đặc tả: mỗi lỗi nghiệp vụ có mã, thông điệp cho người dùng, HTTP status/exit code; API trả lỗi theo RFC 9457 (`application/problem+json`). → Kiểm: bảng "Lỗi" trong spec; test gọi API lỗi kiểm `Content-Type: application/problem+json` và trường `type`/`title`/`status`. · Nguồn: RFC 9457 §3
- [ ] `PM-SPEC-011` **SHOULD** Spec có bảng dữ liệu: thực thể, trường, kiểu, ràng buộc, ai được đọc/ghi; thay đổi schema trỏ migration ([`../09-database/migrations.md`](../09-database/migrations.md)). → Kiểm: mục "Dữ liệu" + link migration trong PR.
- [ ] `PM-SPEC-012` **SHOULD** Tính năng có UI mô tả đủ 4 trạng thái (đang tải, rỗng, lỗi, thành công) và a11y tối thiểu; chi tiết ở [`../06-design-ux/ui-states-and-feedback.md`](../06-design-ux/ui-states-and-feedback.md). → Kiểm: mục "Trạng thái UI" có 4 dòng.
- [ ] `PM-SPEC-013` **SHOULD** Sửa spec sau Approved: tăng `Phiên bản`, ghi "Thay đổi" (gì, vì sao, ai duyệt), test tương ứng cập nhật trong cùng PR. → Kiểm: `git log -p docs/specs/SPEC-<slug>.md` cho thấy dòng phiên bản thay đổi cùng với test.
- [ ] `PM-SPEC-014` **SHOULD** Yêu cầu phi chức năng của tính năng ghi bằng số (giới hạn kích thước, rate limit, p95, kích thước bundle) để test hiệu năng có ngưỡng. → Kiểm: mục NFR có số + nguồn ngưỡng.
- [ ] `PM-SPEC-015` **SHOULD** Spec dùng thuật ngữ từ glossary; không có hai tên cho một khái niệm trong spec, code và UI. → Kiểm: review spec đối chiếu `docs/GLOSSARY.md`.
- [ ] `PM-SPEC-016` **SHOULD** Scenario "thử vượt quyền" (người dùng A truy cập dữ liệu B, khách truy cập tài nguyên cần đăng nhập) có trong mọi spec chạm dữ liệu người dùng. → Kiểm: `rg -n "vượt quyền|unauthorized|forbidden" docs/specs/` có kết quả cho các spec đó.
- [ ] `PM-SPEC-017` **MAY** Scenario viết bằng Gherkin thật và chạy bằng công cụ BDD (Cucumber, pytest-bdd, godog) để spec và test là một file. → Kiểm: `features/*.feature` chạy trong CI.
- [ ] `PM-SPEC-018` **MAY** Spec kèm sơ đồ sequence/state (Mermaid trong Markdown) cho luồng nhiều thành phần. → Kiểm: khối ```` ```mermaid ```` render được.
- [ ] `PM-SPEC-019` **MAY** Spec cho tính năng dùng AI ghi rõ đầu vào không tin cậy, hành vi khi model trả sai, và tiêu chí eval; chi tiết ở [`../13-ai-engineering/evaluation.md`](../13-ai-engineering/evaluation.md). → Kiểm: mục "Hành vi AI" trong spec.
- [ ] `PM-SPEC-020` **MUST** Spec hở (điểm không nói, nhiều cách hiểu, mâu thuẫn với code/spec khác) → ghi vào "Câu hỏi mở" kèm quyết định: `D-NNN` của phiên chính theo tiêu chí chất lượng cuối ([`LOOP-STOP-018`](../11-autonomous-loop/stop-points-and-escalation.md)) hoặc câu trả lời của người; không lấp ngầm, subagent không tự chọn. → Kiểm: mỗi câu hỏi mở đã đóng có "Đã quyết: D-NNN" hoặc tên người + ngày, `D-NNN` có trong `docs/autopilot/DECISIONS.md`. · Nguồn: catalog 23 §2.3, ADR-0008

## Bẫy thường gặp

| Bẫy | Dấu hiệu | Cách tránh |
|---|---|---|
| Scenario không kiểm được | "Then hệ thống hoạt động tốt" | Then phải là kết quả quan sát được: giá trị, trạng thái, thông điệp, mã lỗi |
| Given/When/Then trộn bước | Một scenario có 3 When | Mỗi scenario một hành động; nhiều dữ liệu → Scenario Outline |
| Ca biên để QA tìm sau | Bug "trống", "trùng", "múi giờ" sau phát hành | Bảng ca biên 8 nhóm là mục bắt buộc của spec (`PM-SPEC-003`) |
| Chia việc trước khi có hợp đồng | Front và back tự đoán payload, ghép lại không khớp | Contract first; mock server sinh từ OpenAPI để hai bên làm song song |
| AI/worker tự lấp chỗ spec hở | Code chạy nhưng làm điều không ai yêu cầu | Luật cứng "spec hở → quyết định tường minh": câu hỏi mở + `D-NNN` của phiên chính; subagent không tự lấp (catalog 23 §2.3) |
| Spec sống trong chat | Phiên sau không tìm thấy quyết định | Spec là file trong `docs/specs/`, chat chỉ là nháp |
| Spec thành tài liệu thiết kế kỹ thuật | Spec mô tả tên class, thư viện | Tách: spec = hành vi; ADR = quyết định kỹ thuật |
| Sửa spec ngầm khi code | Test đổi mà spec không đổi | `PM-SPEC-013`: cùng PR, tăng phiên bản, ghi lý do |
| Truy vết một chiều | Có PR nhưng không biết thuộc yêu cầu nào | PR template bắt buộc dòng `Spec:`; CI chặn `feat:` thiếu spec (catalog 23 §2.5) |

## Cổng tự động

| Việc | Công cụ / lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| OpenAPI hợp lệ, có ví dụ, có lỗi RFC 9457 | `npx @redocly/cli lint openapi.yaml` (MIT) hoặc `npx @stoplight/spectral-cli lint openapi.yaml` (Apache-2.0) | pre-commit + CI | 0 lỗi; cảnh báo theo ruleset dự án |
| JSON Schema hợp lệ | `npx ajv-cli compile -s schema.json` (MIT) / `check-jsonschema` (Apache-2.0, Python) | CI | 0 lỗi |
| PR `feat:` có dòng `Spec:` | Job CI đọc PR body (`gh pr view --json body`) | CI (pull_request) | Thiếu → đỏ |
| Mọi scenario có test trỏ về | Script so khớp `S-NNN` trong `docs/specs/` với `tests/` | CI | 0 scenario mồ côi |
| Contract test khớp spec | Pact / Schemathesis (MIT) chạy với OpenAPI | CI | 0 lệch |
| Spec còn chỗ điền | `rg -n "<ĐIỀN|\[chặn\]" docs/specs/` | pre-commit | 0 tại trạng thái Approved |

## Nguồn

- Gherkin reference (Given/When/Then, Scenario Outline, Background): <https://cucumber.io/docs/gherkin/reference/> — xác minh 2026-10-13.
- INVEST — Bill Wake (2003): <https://xp123.com/articles/invest-in-good-stories-and-smart-tasks/> — xác minh 2026-10-13.
- Scrum Guide 2020 — Definition of Done (lưu ý: Scrum Guide **không** định nghĩa "Definition of Ready"; DoR ở đây là quy ước của khung): <https://scrumguides.org/scrum-guide.html> — xác minh 2026-10-13.
- RFC 9457 Problem Details for HTTP APIs (thay RFC 7807): <https://www.rfc-editor.org/rfc/rfc9457> — xác minh 2026-10-13.
- OpenAPI Specification v3.2.1 (2026-09-10): <https://spec.openapis.org/oas/latest.html>; JSON Schema 2020-12: <https://json-schema.org/specification> — xác minh 2026-10-13.
- Khung cũ X-stored `project-completion.md` (truy vết F → W → PR → bằng chứng) và `01-process-and-standards.md` GĐ1 (DoD/DoR), commit `1b80fe4`.
- `seeker19110/stored` mục 13 §5 (spec-driven: OpenAPI trước khi chia việc), mục 23 §2.3 (spec hở → dừng), §2.5 (`feat:` phải link spec Approved) — đọc 2026-10-13.
