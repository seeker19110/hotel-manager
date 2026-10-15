---
title: Đội, WIP, định nghĩa sẵn sàng/hoàn thành, bàn giao
kind: module
prefix: WF-TEAM
applies_to: [all]
updated: 2026-10-15
---

# Đội, WIP, định nghĩa sẵn sàng/hoàn thành, bàn giao

> Quy ước làm việc để dòng chảy không nghẽn: **WIP cap thực thi bằng máy** (3 PR mở toàn repo kể cả bot/draft),
> merge **FIFO**, Definition of Ready trước khi bắt đầu, Definition of Done có bằng chứng, bàn giao qua file để
> phiên/người sau tiếp tục được, onboarding ≤ 1 ngày. Áp cho đội một người (kể cả người + agent) lẫn nhiều đội;
> quy ước đa agent chi tiết ở [`../11-autonomous-loop/orchestration-and-subagents.md`](../11-autonomous-loop/orchestration-and-subagents.md).

## Nguyên tắc

1. **Năng lực xác minh là trần của WIP (L4).** Hàng đợi review/verify nghẽn → ngừng nhận việc mới, không tăng
   người/agent viết code.
2. **Hoàn thành một việc tốt hơn bắt đầu mười việc.** FIFO: việc vào trước xong trước; không nhảy cóc trừ sự cố
   production có nhãn.
3. **Ready trước khi bắt đầu, Done có bằng chứng.** DoR tránh làm lại; DoD theo Scrum Guide là "mô tả chính thức
   trạng thái tăng trưởng" — máy kiểm được phần máy kiểm, người ký phần còn lại.
4. **Bàn giao là file, không phải trí nhớ.** PROGRESS/handover ghi đang dở gì, bước tiếp theo, lệnh để tiếp;
   người/agent sau đọc là làm được.
5. **Quy ước nhẹ cho một người, cứng dần khi thêm người.** Approval 0 → 1 khi có người thứ hai; WIP 2 → 3 → 6
   theo năng lực đo được, không theo cảm giác.

## Quyết định

| Tình huống | Chọn | Ghi chú |
|---|---|---|
| Đội một người (+ agent) | WIP = 2 (một đang code, một chờ CI/review); approval 0 (GitHub không cho tự duyệt); reviewer AI khác model; mọi cổng máy bật | Nâng approval ngay khi có người thứ hai |
| Đội 2–5 người | WIP cap 3 PR mở toàn repo (kể cả bot/draft) khởi điểm; tăng tới 6 khi hàng đợi review p95 < 24h trong 4 tuần | Dependabot gom nhóm để không lấp cap |
| Nhiều đội/monorepo | WIP theo miền (CODEOWNERS), cap toàn repo = tổng; merge queue khi > ~10 PR/ngày | — |
| Việc "khẩn" chen hàng | Chỉ sự cố production (nhãn `incident`) được nhảy FIFO; còn lại xếp hàng | "Sếp cần gấp" không phải incident |
| Ước lượng | Chia việc ≤ 1–2 ngày (DORA: > 1 tuần là quá lớn); không ước lượng ngày cho việc chưa Ready | Story point không có DoR |
| Họp | Async-first: PROGRESS/issue/PR là nơi trao đổi; đồng bộ ngắn cho quyết định | Họp hằng ngày thay cho tài liệu |
| Onboarding | Devcontainer/`make dev` + README 10 phút + "first good issue" có DoR; buddy review PR đầu | Tài liệu dài, không chạy được |

## Checklist

- [ ] `WF-TEAM-001` **MUST@L** WIP cap số PR mở toàn repo (mặc định 3, kể cả bot và draft) thực thi bằng CI: PR thứ N+1 đỏ với thông báo "merge/đóng PR cũ trước"; cap ghi trong `CONTRIBUTING.md`. → Kiểm: job `pr-policy` đếm `gh pr list --state open` > cap → đỏ; thử mở PR vượt cap ở nhánh thử → đỏ. · Nguồn: catalog 23 §2.5 (WIP cap 3 kể cả bot/draft)
- [ ] `WF-TEAM-002` **MUST@L** Merge FIFO: PR tạo trước merge trước; PR sau cập nhật với `main` sau khi PR trước merge; nhảy hàng chỉ với nhãn `incident` có link sự cố. → Kiểm: script so thứ tự `createdAt` ↔ `mergedAt` tháng qua, ngoại lệ phải có nhãn; AGENTS/CLAUDE quy định FIFO cho agent. · Nguồn: khung cũ CLAUDE.md §8 (FIFO không nhảy cóc), spec §B4.8
- [ ] `WF-TEAM-003` **MUST** Definition of Ready trước khi bắt đầu task: tiêu chí chấp nhận đo được, không câu hỏi mở quan trọng, phụ thuộc xác định, thiết kế/luồng đủ rõ (wireframe nếu UI), phạm vi gói trong một PR; chưa Ready → hỏi, không code. → Kiểm: issue template có checklist DoR; nhãn `ready` chỉ gán khi đủ; agent kiểm DoR ở đầu task (hook/skill). · Nguồn: khung cũ `01-process-and-standards.md` GĐ1 DoR
- [ ] `WF-TEAM-004` **MUST** Definition of Done có bằng chứng: tiêu chí chấp nhận có test xanh (link CI), cổng máy xanh, trạng thái lỗi/rỗng/tải xử lý, không secret/rác, tự review diff, docs cập nhật, deploy thử (staging/preview) OK; tick DoD không kèm bằng chứng = chưa Done. → Kiểm: PR template DoD mỗi mục có chỗ ghi bằng chứng; blueprint tick theo bằng chứng (`xt.py blueprint-status --strict`). · Nguồn: Scrum Guide 2020 (Definition of Done), P1
- [ ] `WF-TEAM-005` **MUST** Bàn giao (cuối phiên/cuối ngày/đổi người): cập nhật `PROGRESS.md` mục Đang làm / Tiếp theo / Bàn giao với lệnh để tiếp tục và những gì **chưa xác minh**; không bàn giao bằng chat. → Kiểm: `PROGRESS.md` thay đổi cùng commit cuối phiên; hook SessionStart nạp được; định dạng và độ tươi theo [`LOOP-HARNESS-004`](../11-autonomous-loop/harness-files.md)/[`005`](../11-autonomous-loop/harness-files.md). · Nguồn: [`documentation-workflow.md`](documentation-workflow.md), `/handover`
- [ ] `WF-TEAM-006` **MUST@L** Mỗi việc có **một** chủ (owner) và trạng thái máy đọc (issue/PLAN task `T-xxx`), không việc "của mọi người"; việc chờ người (gate) có hạn 24h và nhắc 12h, quá hạn leo thang, không tự pass. → Kiểm: PLAN/issue có trường owner; cron nhắc gate quá hạn. · Nguồn: catalog 23 §2.6 (gate 24h/12h), §3.1 (human gate)
- [ ] `WF-TEAM-007` **MUST@M** Khi có ≥ 2 người: approval ≥ 1 từ người khác tác giả; CODEOWNERS cho vùng nhạy cảm; luân phiên review để không một người là nút thắt. → Kiểm: ruleset `required_approving_review_count ≥ 1`; thống kê review phân bố (không > 70% một người). · Nguồn: [`git-and-branching.md`](git-and-branching.md), [`code-review.md`](code-review.md)
- [ ] `WF-TEAM-008` **MUST@L** Đo dòng chảy hàng tháng: WIP trung bình, thời gian chờ review p50/p95, lead time commit→prod, số PR > 7 ngày, tỉ lệ qua cổng lần đầu; vượt ngưỡng (review p95 > 48h, PR cũ > 3) → hạ WIP, không thêm việc. → Kiểm: báo cáo trong `docs/ops/` hoặc dashboard; quyết định điều chỉnh WIP ghi lại. · Nguồn: DORA metrics, khung cũ spec L4/ASC-FR-37 (quá 48h hạ WIP)
- [ ] `WF-TEAM-009` **MUST@L** Onboarding: người/agent mới chạy được app + test local ≤ 1 ngày (mục tiêu 30 phút) theo README, có "first good issue" đạt DoR, PR đầu có buddy review; lỗi gặp khi onboarding → sửa tài liệu trong cùng tuần. → Kiểm: checklist onboarding có ngày hoàn thành; issue `onboarding-friction` được đóng bằng PR docs.
- [ ] `WF-TEAM-010` **MUST@L** Nhiều đội: hợp đồng giữa đội (API/sự kiện) có chủ, phiên bản, SLA thay đổi; thay đổi phá vỡ thông báo trước ≥ 1 chu kỳ; DoD bao gồm cập nhật hợp đồng. → Kiểm: registry hợp đồng với owner; contract test chéo đội trong CI.
- [ ] `WF-TEAM-011` **SHOULD** Dependabot/Renovate gom thành ≤ 1 PR/tuần/nhóm để không lấp WIP cap; bản vá bảo mật tách riêng và ưu tiên FIFO đặc biệt (nhãn `security`). → Kiểm: `dependabot.yml` có `groups` + `open-pull-requests-limit` ≤ cap/2. · Nguồn: catalog 23 §2.5 (13 PR Dependabot lấp cap)
- [ ] `WF-TEAM-012` **SHOULD** Việc chia nhỏ ≤ 1–2 ngày công, lát dọc có giá trị kiểm được (INVEST); việc > 1 tuần → tách trước khi Ready. → Kiểm: PLAN task có ước lượng; task > 2 ngày phải có task con. · Nguồn: DORA Working in small batches
- [ ] `WF-TEAM-013` **SHOULD** Người + agent: agent nhận việc có DoR, làm trong worktree/nhánh riêng, không tự merge, không tự nâng quyền; người giữ cổng merge và các điểm dừng bắt buộc. → Kiểm: `AGENTS.md` ghi; ruleset không cho token bot merge; xem [`../11-autonomous-loop/stop-points-and-escalation.md`](../11-autonomous-loop/stop-points-and-escalation.md). · Nguồn: catalog 23 §4.5 (T0–T4, subagent không tự nâng tier)
- [ ] `WF-TEAM-014` **SHOULD** Quy ước giao tiếp: async-first, quyết định ghi vào issue/ADR/PROGRESS (không chỉ chat); thuật ngữ trong glossary; ngôn ngữ tài liệu thống nhất. → Kiểm: quyết định kỹ thuật tìm được trong repo (ADR/issue) không phải chỉ trong chat.
- [ ] `WF-TEAM-015` **SHOULD** Retro/nhìn lại mỗi 2–4 tuần với đầu ra là ≥ 1 hàng rào máy hoặc thay đổi quy ước có PR (P12); không retro chỉ để nói. → Kiểm: biên bản retro link PR hành động.
- [ ] `WF-TEAM-016` **SHOULD** Lịch trực/escalation khi có production: ai được gọi, trong bao lâu, kênh nào; agent cron chỉ đề xuất, không hành động đối ngoại khi không có người. → Kiểm: `docs/ops/ONCALL.md` hoặc mục trong runbook; routine prompt ghi "chỉ đề xuất". · Nguồn: catalog 21 §10 (routine chỉ đề xuất)
- [ ] `WF-TEAM-017` **MAY** Pairing/mobbing cho việc phức tạp hoặc onboarding; ghi kết quả vào PR như bình thường. → Kiểm: PR ghi co-author.
- [ ] `WF-TEAM-018` **MAY** Nâng WIP cap từ 3 lên 6 khi: review p95 < 24h trong 4 tuần, không PR > 7 ngày, tỉ lệ qua cổng lần đầu ổn định; hạ lại khi vi phạm. → Kiểm: quyết định có số liệu kèm trong `docs/ops/`. · Nguồn: khung cũ spec §B12 (WIP 3 → 6 khi đủ điều kiện)

## Bẫy thường gặp

- **13 PR Dependabot lấp WIP cap → mọi PR người đỏ** (catalog 23 §2.5). Gom nhóm, giới hạn PR bot, bản vá bảo mật riêng.
- **5 PR bảo mật nằm 19 ngày vì bot không điền template** (catalog 23). FIFO + SLA + nhãn `security` ưu tiên có quy tắc.
- **WIP không trần → 20 việc dở, 0 việc xong.** Hàng đợi review nổ, merge ẩu (khung cũ §B10). Cap bằng máy.
- **"Done" = code đã push.** Chưa test, chưa deploy thử, chưa docs. DoD có bằng chứng, tick không bằng chứng là chưa done.
- **Bắt đầu việc mơ hồ "làm rồi hỏi".** Làm lại 2–3 lần. DoR trước; agent gặp mơ hồ thì quyết tường minh (D-NNN, [`LOOP-STOP-018`](../11-autonomous-loop/stop-points-and-escalation.md)), không lấp ngầm.
- **Bàn giao bằng chat/trí nhớ.** Phiên sau (người hoặc agent) hỏi lại điều đã quyết. PROGRESS 4 mục, hook nạp.
- **Gate quá hạn thì tự pass.** Lỗ hổng chính sách. Leo thang người.
- **Một người review 90% PR.** Nút thắt, bus factor 1. Luân phiên, CODEOWNERS theo miền.
- **Thêm agent khi review nghẽn.** Tăng đầu vào cho nút thắt. L4: WIP ≤ năng lực xác minh.
- **Mâu thuẫn nguồn:** Scrum Guide 2020 chỉ định nghĩa DoD, không có "Definition of Ready" (DoR là thực hành cộng đồng/khung cũ); khung vẫn giữ DoR như mục MUST vì nó là cổng chống việc mơ hồ cho agent — nguồn: khung cũ, không phải Scrum Guide.

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| WIP cap | `gh pr list --state open --json number \| jq length` > cap → đỏ (trừ nhãn `incident`) | CI `pr-policy` | 3 (S/M), 6 khi đủ điều kiện |
| FIFO audit | script so `createdAt`/`mergedAt` 30 ngày; ngoại lệ phải có nhãn | CI schedule | Báo cáo |
| DoR | issue template checklist; nhãn `ready` bắt buộc trước khi link PR; skill agent kiểm DoR đầu task | GitHub + hook | Thiếu → hỏi |
| DoD | PR template mỗi mục có bằng chứng; `xt.py blueprint-status --strict` cho release | CI | 0 MUST mở |
| Handover | `xt.py progress-check` (SHA tổ tiên HEAD, ≤ 8 KB, 4 mục) + nhánh tồn tại | pre-push + CI | Exit 0 |
| Gate SLA | cron nhắc 12h, leo thang 24h, hạ WIP khi > 48h | CI schedule | Thông báo |
| Dependabot | `groups` + `open-pull-requests-limit ≤ cap/2`, security update tách | GitHub | — |
| Review phân bố | script % review theo người | CI schedule | Cảnh báo > 70% |

## Nguồn

- Scrum Guide 2020 — Definition of Done (không có Definition of Ready): <https://scrumguides.org/scrum-guide.html> — xác minh 2026-10-13
- DORA — Working in small batches (INVEST; batch > 1 tuần là quá lớn; tích hợp hằng ngày): <https://dora.dev/capabilities/working-in-small-batches/> — xác minh 2026-10-13
- DORA — Metrics (5 chỉ số): <https://dora.dev/guides/dora-metrics-four-keys/> — xác minh 2026-10-13; DORA 2025 "State of AI-assisted Software Development" + AI Capabilities Model (7 năng lực: AI stance rõ, data ecosystem, dữ liệu nội bộ cho AI, version control mạnh, small batches, user-centric, platform chất lượng; 90% dùng AI; AI tăng cả throughput lẫn instability): <https://dora.dev/research/2025/dora-report/> · <https://dora.dev/research/2025/ai-capabilities-model/> — xác minh 2026-10-13; DORA 2024 "Accelerate State of DevOps Report 2024" (AI tăng năng suất cá nhân nhưng giảm ổn định/throughput giao hàng): <https://dora.dev/research/2024/dora-report/> — xác minh 2026-10-13
- Dependabot options reference (`groups`, `open-pull-requests-limit`): <https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference> — xác minh 2026-10-13
- Khung cũ X-stored commit `1b80fe4`: `CLAUDE.md` §8 (FIFO), `docs/framework/01-process-and-standards.md` (DoD/DoR GĐ1), `quality-supplements.md` N1.7 (DoR), `docs/specs/AI-HARNESS-AND-COMPANY-SPEC.md` L4 (WIP ≤ năng lực xác minh), §B4.8 (FIFO), ASC-FR-14/37 (gate 24h, hạ WIP sau 48h), §B12 (WIP 3 → 6), §B10 (chống chỉ định).
- `research/2026-10-13-stored-catalog-extraction.md` §2.7, §2.11, §4 (WIP cap 3 kể cả bot/draft; gate 24h/12h; chế độ n=1 WIP=2); catalog `23-own-repos-lessons` §2.5, §2.6, §3.1, §4.5; `21-autonomous-workflows` §10.
