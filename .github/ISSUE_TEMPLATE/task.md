---
name: Việc cần làm (task)
about: Việc phát triển có tiêu chí chấp nhận; chỉ gán nhãn `ready` khi checklist Definition of Ready đủ
labels: ["task"]
---

## Mục tiêu
<!-- Vì sao làm; SPEC (`docs/specs/…`, mã S-NNN), tính năng F-NNN, task PLAN T-NNN, quyết định D-NNN. -->

## Tiêu chí chấp nhận
<!-- Given/When/Then đo được, có ID; gồm ca biên (rỗng/null/quá dài/race/UTC/tiền) và ca lỗi. -->
- [ ] …

## Definition of Ready
<!-- Gán nhãn `ready` chỉ khi đủ các mục. Chưa đủ → hỏi, chưa code (WF-TEAM-003). Workflow `dor-check.yml` gỡ nhãn `ready` nếu còn mục chưa tick. -->
- [ ] Tiêu chí chấp nhận đo được, mỗi tiêu chí có ID
- [ ] Không còn câu hỏi mở chặn việc (hoặc đã có quyết định D-NNN / câu trả lời của người)
- [ ] Phụ thuộc đã xác định (task/PR trước, dịch vụ ngoài, quyền cần người duyệt)
- [ ] Thiết kế/luồng đủ rõ (có wireframe nếu là giao diện); bảng/cột/API liên quan khớp `docs/design/DOMAIN-MODEL.md`
- [ ] Phạm vi gói trong một PR nhỏ, có lệnh Gate để chứng minh xong
- [ ] Dữ liệu cá nhân mới: dự kiến dòng trong `docs/privacy/data-map.yaml`

## Gate
<!-- Lệnh chạy y nguyên để chứng minh xong, ví dụ `pnpm vitest run --project db <mẫu>`. -->
