---
title: Trích xuất phần mới của catalog seeker19110/stored (fa02a75..e3fdcb0) và nghiên cứu tự chủ, kỹ năng theo tác vụ
kind: research
updated: 2026-10-31
---

# Trích xuất stored (đợt 2026-10-31) và nghiên cứu tự chủ, kỹ năng theo tác vụ

Bổ sung cho [`2026-10-30-stored-delta-and-web.md`](2026-10-30-stored-delta-and-web.md) (không sửa file đó). Ký hiệu `NN §x` là
chuyên mục NN, mục x của catalog.

## 1. Phạm vi

- `seeker19110/stored` `fa02a75..e3fdcb0` (15 commit nội dung, 30–31/10/2026): 01 §3b.5 · 03 §8e (Advisor Tool), §8f (Agent Teams) ·
  06 §7n · 10 §4e · 11 §1c, §1e–§1i (công cụ trình duyệt cho agent) · 16 §2e–§2f · 19 §1.6 · 20 §3g.6, §3k–§3s (pack skill/plugin lớn).
  Phía `stored` đã đối chiếu sẵn với ID khung ở commit `0b90230`: `X-TEMPLATES.md` §4 và `data/xt-handoff.json` (18 mục, `XT-H-001…018`).
- Nguồn sống tra 2026-10-31 (subagent `researcher`; F = đọc trang nguồn, T = nguồn thứ cấp): docs hook, plugin eval, skill của Claude Code;
  Anthropic engineering (harness dài hạn 11/2025 và 3/2026, C compiler bằng agent team 2/2026); best practices skill (platform docs,
  agentskills.io); skill mẫu theo tác vụ ở `claude-plugins-official`, `obra/superpowers`, `mattpocock/skills`, `addyosmani/agent-skills`,
  `microsoft/playwright-cli`.

## 2. Bài học stored → ID

| Bài học (stored) | ID | Cột | Trạng thái |
|---|---|---|---|
| Agent Teams: subagent có `name` thành teammate không hỏi, teammate kế thừa quyền lead, plan tự duyệt (03 §8f; docs F) | [`LOOP-ORCH-021`](../framework/11-autonomous-loop/orchestration-and-subagents.md) | chưa có | **Đã thêm** (SHOULD) |
| Agent bên thứ ba ghim `model: opus` (54/202, 20 §3q.2) | [`LOOP-ORCH-022`](../framework/11-autonomous-loop/orchestration-and-subagents.md) | nông hơn (`LOOP-ORCH-019`, `XC-DOCAI-022`) | **Đã thêm** (SHOULD) |
| Advisor Tool: không tool, không thay reviewer; `DISABLE_TELEMETRY` tắt advisor (03 §8e; docs F) | [`LOOP-ORCH-023`](../framework/11-autonomous-loop/orchestration-and-subagents.md) | chưa có | **Đã thêm** (MAY) |
| `DO_NOT_TRACK` không phủ mọi công cụ; công tắc riêng theo công cụ (stored `X-TEMPLATES.md` §2) | [`SEC-INFRA-027`](../framework/12-security/infrastructure-and-network.md) | nông hơn (`SEC-INFRA-018`) | **Đã thêm** (SHOULD) + bẫy 11 |
| Skill tải chỉ dẫn từ nhánh `main` mỗi lần chạy (20 §3n.2) | [`SEC-AI-028`](../framework/12-security/ai-security.md) | nông hơn (`AI-PROTO-008`, `SEC-SUPPLY-016`, `SEC-AI-018`) | **Đã thêm** (SHOULD) + bẫy 14 |
| Marketplace chính thức bump SHA plugin ngoài hằng đêm (20 §3q.1) | bẫy 12 `supply-chain.md` | nông hơn (`SEC-SUPPLY-016` "nguồn kiểm duyệt") | **Bổ sung bẫy** |
| Trình duyệt cho agent: profile bền mặc định, `--autoConnect` thấy mọi tab (11 §1e–§1g) | [`QA-E2E-030`](../framework/14-testing-quality/e2e-and-accessibility.md) | chưa có | **Đã thêm** (SHOULD) |
| CLI + skill rẻ ngữ cảnh hơn MCP (Microsoft tự khuyên, 11 §1f–§1g.1) | [`XC-DOCAI-024`](../framework/18-cross-cutting/docs-for-ai-agents.md) | nông hơn | **Đã thêm** (SHOULD) |
| Test kích hoạt skill tất định trong CI + sổ thay đổi bị loại (20 §3o.2) | [`XC-DOCAI-025`](../framework/18-cross-cutting/docs-for-ai-agents.md) | nông hơn (`AI-EVAL-021`, `XC-DOCAI-021`) | **Đã thêm** (SHOULD) |
| License theo từng thư mục skill (`anthropics/skills`, 20 §3s.4) | bẫy `licensing-and-ip.md` | nông hơn (`CMP-LIC-004`) | **Bổ sung bẫy** |
| Nâng nền lên bản ổn định: bot chỉ nhận stable, theo dõi cả toolchain (yêu cầu chủ dự án 2026-10-31) | [`BASE-DEP-019`](../framework/01-baseline/dependencies.md) | nông hơn (`BASE-DEP-003/007/016`) | **Đã thêm** (SHOULD) + bẫy |
| Autopilot tự làm PR nâng major khi chủ dự án chọn L3 + `merge_hard_exceptions: auto` (yêu cầu "tự chủ ở mức cao nhất", 2026-10-31) | [`BASE-DEP-020`](../framework/01-baseline/dependencies.md) | chưa có | **Đã thêm** (SHOULD); runtime, engine CSDL, thư viện auth/mật mã vẫn theo `BASE-DEP-012` |
| MCP chính chủ archive (Browserbase, 11 §1i.1) | `AI-PROTO-001` | sâu hơn | Đã có |
| `curl \| sh` không checksum vs manifest checksum (16 §2f, 20 §3n.1) | `SEC-SUPPLY-019`, `LOOP-HARNESS-025` | sâu hơn | Đã có |
| Hook plugin chạy cả khi lệnh model bị từ chối (20 §3n.1) | `SEC-SUPPLY-016`, `LOOP-STOP-023` | sâu hơn | Đã có |
| Mutation/CRAP (20 §3m, §3r.3) | `QA-COV-005/006`, `QA-STATIC-009` | sâu hơn | Đã có |
| Badge tự lưu, sao tăng không kèm commit (19 §1.6, 01 §3b.5) | `SEC-SUPPLY-026` | sâu hơn | Đã có |
| Engine trình duyệt anti-detect cho scraping (Obscura, 11 §1i.2) | — | — | **Không thêm**: ngoài phạm vi khung |

## 3. Nguồn sống → hướng nâng cấp (chưa thành ID ở đợt này)

| Dữ kiện | Hướng dùng | Mức |
|---|---|---|
| 33 sự kiện hook; chặn bằng exit 2 gồm `TaskCompleted`, `TeammateIdle`, `SubagentStop`, `PostToolBatch`, `PreCompact`, `Stop`; `onFailure` (2.1.295) | Khung đã dùng `TaskCompleted`/`Stop`/`PreCompact`; `PostToolBatch` là chỗ dừng rẻ trước lượt model kế — cân nhắc cho ngân sách vòng | F <https://code.claude.com/docs/en/hooks> |
| `claude plugin eval` ≥ 2.1.269: case `evals/<case>/prompt.md` + `graders/`, 6 loại grader (4 miễn phí), 3 lần/case, `--ablation with-without`, `--max-cost-usd` | Phương tiện cho eval bật/tắt `LOOP-DESIGN-025` và cho skill mới | F <https://code.claude.com/docs/en/plugin-evals> |
| Harness dài hạn: initializer viết `init.sh` + file tiến độ; feature list **JSON** (agent chỉ đổi `passes`); một tính năng mỗi phiên; khởi động bằng smoke E2E; kiểm bằng trình duyệt | Khung đã có PLAN + `loop record` + Gate; điểm mới đáng thử: smoke E2E ở đầu mỗi phiên autopilot | F <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents> (2025-11-26) |
| Planner / generator / **evaluator hoài nghi** tách riêng; "sprint contract" chốt tiêu chí kiểm được trước khi code; bỏ bớt harness khi model mạnh lên | Trùng hướng `LOOP-ORCH-005/018`; "sprint contract" ≈ Given/When/Then của PLAN | F <https://www.anthropic.com/engineering/harness-design-long-running-apps> (2026-03-24) |
| C compiler bằng 16 agent: oracle test gần hoàn hảo, khoá file nhận task, log ngắn có `ERROR` cùng dòng, mẫu test `--fast` 1–10 % tất định | `test_fast`/`test-select` của khung cùng ý; log `ERROR` một dòng cho `triage-local` | F <https://www.anthropic.com/engineering/building-c-compiler> (2026-02-05) |
| Skill: `description` mệnh lệnh, nêu ý định người dùng, "pushy"; listing cắt ở 1.536 ký tự (`description` + `when_to_use`); body < 500 dòng; trigger test ~20 truy vấn (8–10 nên/không nên kích hoạt), 3 lần, chia 60/40 | Bổ sung tầng hành vi cho `XC-DOCAI-025` (tầng tất định) khi có ngân sách | F <https://agentskills.io/skill-creation/optimizing-descriptions.md>, <https://code.claude.com/docs/en/skills> |
| Code review nhiều agent (blog 2026-03-09): PR có nhận xét thực chất 16 % → 54 %, < 1 % phát hiện bị đánh dấu sai, $15–25/review; plugin `code-review` xác thực **từng** phát hiện bằng subagent riêng | Nâng `/review`: lượt xác thực theo phát hiện trước khi đăng | F <https://claude.com/blog/code-review> |
| Skill mẫu theo tác vụ: `systematic-debugging` (không sửa khi chưa có nguyên nhân gốc; 3 lần sửa hỏng → xem lại kiến trúc), `diagnosing-bugs` (không có lệnh tái hiện đỏ thì chưa sang pha 2; 3–5 giả thuyết bác bỏ được), `test-driven-development`, `verification-before-completion`, `playwright-cli` | Mẫu cho skill tác vụ của khung (PR riêng) | F (trang GitHub) |
| Không tìm thấy skill tốt cho **migration CSDL an toàn, nâng phụ thuộc, sự cố/RCA** trong các repo trên | Khoảng trống khung có thể dẫn đầu | F (không thấy) |

## 4. Chưa xác minh / lưu ý

- Ngưỡng tin cậy thật của plugin `feature-dev` (README tự mâu thuẫn ≥ 80 và bậc từ 50); `security-guidance` chặn hay chỉ cảnh báo; plugin `claude-security`, `code-modernization` chưa đọc.
- Số Terminal-Bench của Advisor chỉ có trong biểu đồ; hiệu quả Agent Teams chưa có benchmark có đối chứng (dữ kiện duy nhất là dự án C compiler).
- Đọc docs hook/skill đến 100k ký tự đầu; có thể thiếu vài trường.
- Mục mới đều SHOULD/MAY: áp theo điều kiện hoặc chưa đủ bằng chứng để buộc mọi dự án; không đụng trần 4 MUST/module (ADR-0004).
- Đợt trích kế tiếp của `stored` bắt đầu từ commit sau `e3fdcb0`.
