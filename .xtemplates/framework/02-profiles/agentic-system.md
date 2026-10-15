---
title: Hệ agentic (đa agent, tự trị có giới hạn, chạy dài)
kind: profile
slug: agentic-system
prefix: PRF-AGENTIC
modules: [04-standards/*, 05-architecture/*, 08-backend/*, 09-database/*, 10-workflow/*, 11-autonomous-loop/*, 12-security/*, 13-ai-engineering/*, 14-testing-quality/*, 15-operations/*, 16-compliance-privacy/*, 17-product-project/*, 18-cross-cutting/*]
updated: 2026-10-14
---

# Hồ sơ: Hệ agentic (đa agent, tự trị có giới hạn, chạy dài)

> Sản phẩm gồm **nhiều agent** phối hợp (orchestrator–worker, handoff, evaluator), chạy **nhiều giờ/ngày**, được
> **trigger không có người** (lịch, webhook, sự kiện) và tạo **side effect đối ngoại** (gửi mail, đăng bài, giao dịch,
> sửa hệ thống). Cổng chất lượng thêm so với `ai-agent`: **topology = ranh giới ủy quyền, durable execution, outbox,
> HITL theo mức rủi ro, ngân sách + circuit breaker toàn hệ, kill switch, eval pass^k end-to-end, audit ledger,
> chống cascading failure**. Mỗi agent thành phần vẫn phải đạt [`ai-agent.md`](ai-agent.md) (ghép thêm blueprint `ai-agent`).

## Khi nào dùng

| Dấu hiệu | Hồ sơ |
|---|---|
| ≥ 2 agent gọi nhau, hoặc 1 agent sinh subagent động | **`agentic-system`** |
| Phiên chạy quá một context window / qua restart / chờ người duyệt nhiều ngày | **`agentic-system`** |
| Chạy theo lịch hoặc sự kiện, không người mở phiên | **`agentic-system`** |
| Một agent, một phiên ngắn, người giám sát trực tiếp | `ai-agent` |
| Autopilot cho chính việc **phát triển phần mềm** | [`../11-autonomous-loop/README.md`](../11-autonomous-loop/README.md) (harness dev, không phải sản phẩm) |

Giới hạn năng lực để đặt kỳ vọng (METR, dẫn qua catalog 21 §8): 95 % đúng mỗi bước × 30 bước ≈ 21 % chạy sạch → chia
nhỏ, kiểm từng bước, resume thay vì chạy lại.

## Kiến trúc tham chiếu

```text
[Trigger: cron · webhook · sự kiện repo/CRM · API]        [Operator console: topology · budget · kill switch · approval queue]
        │                                                              ▲
        ▼                                                              │ approval (T3–T4) · escalation sau timeout
[Durable runtime: Temporal / Restate / DBOS / LangGraph checkpoint (sync)]
   │ workflow state ngoài process · resume từ bước lỗi · 4 số giới hạn/run
   ▼
[Orchestrator agent] ──assign_task(mission, acceptance, assignee)──► [Worker agent A] [Worker agent B] ... (depth khuyến nghị 2, trần 3 — AI-AGENTIC-007)
   │   topology.yaml = ai được gọi ai, tool nào thuộc ai                │ identity riêng · scope riêng · message có schema + chữ ký
   │                                                                     ▼
   │                                               [Evaluator (model khác)] → verified_by do code điền
   ▼
[Outbox] ─ intent → lease/fencing → gọi API ngoài → receipt read-back ─► [Hệ ngoài: mail · CRM · git · thanh toán]
   │
[Audit ledger append-only (HMAC chain)] · [Trace OTel GenAI] · [Spend circuit breaker 80/90/100 %]
```

Bốn tầng (catalog 21 §1): **loop** quyết khi nào dừng · **harness** quyết nhớ gì/kiểm gì · **trigger** quyết khi nào bắt đầu ·
**durable runtime** quyết sống sót thế nào. Chọn tầng trước khi chọn công cụ.

## Stack mặc định khuyến nghị

Phiên bản xác minh **2026-10-13** — **xác minh lại trước khi dùng**. Nền tảng agent/giao thức kế thừa bảng ở [`ai-agent.md`](ai-agent.md).

| Thành phần | Mặc định | Phiên bản (xác minh 2026-10-13) | Thay thế + điều kiện |
|---|---|---|---|
| Durable execution | Temporal (Signals/Updates, đa ngôn ngữ, worker sống lâu) | server v1.32.1 (2026-10-08) · `temporalio` 1.34.0 (ngày phát hành chưa xác minh) | Restate v1.7.13 (2026-10-01) khi muốn một binary tự host; DBOS khi Postgres là sổ cái; LangGraph 1.2.15 checkpointer (đặt **sync**) khi agent đã là graph; Vercel `@ai-sdk/workflow` (AI SDK 7) khi ở Vercel |
| Điều phối đa agent | Claude Agent SDK subagents hoặc LangGraph supervisor (độ sâu lồng theo `AI-AGENTIC-007`: khuyến nghị 2, trần 3) | Agent SDK 0.2.165 · LangGraph 1.2.15 | Microsoft Agent Framework 1.21.0 (.NET/Azure); Google ADK 2.x (Gemini); CrewAI Flows (event-driven) |
| Giao tiếp agent–agent xuyên hệ | A2A (Agent Card ký số, Task state, Artifact) | v1.0.1 (2026-05-26) | Message queue nội bộ có schema khi cùng một hệ |
| Tool | MCP spec 2026-07-28 (stateless, handle server cấp, Tasks extension) | `mcp` 2.3.0 | — |
| Outbox/queue | PostgreSQL outbox table + worker (hoặc Temporal Activity lũy đẳng) | PostgreSQL 18.6 | Kafka/NATS khi khối lượng lớn |
| Trigger | GitHub Actions `schedule`/gh-aw (`safe-outputs`) · Claude Routines (≥ 1 giờ) · cron trong Temporal | `anthropics/claude-code-action@v1` | n8n/Activepieces/Kestra cho pipeline no-code (kiểm license: n8n không OSI) |
| Eval end-to-end | Inspect AI (sandbox, agentic) + Promptfoo (CI) + record/replay fixture | inspect-ai 0.3.279 · promptfoo 0.124.1 | Harbor/τ²-bench cho benchmark; Langfuse 4.17.0 trace |
| Guardrail + audit | NeMo Guardrails rail + ledger HMAC tự viết | nemoguardrails 0.24.1 | — |

## Checklist

- [ ] `PRF-AGENTIC-001` **MUST** Topology là ranh giới ủy quyền, khai báo trong file (`topology.yaml`): agent nào gọi agent nào, mỗi tool có đúng **một** agent sở hữu, độ sâu lồng khuyến nghị 2, trần 3 (theo [`AI-AGENTIC-007`](../13-ai-engineering/agentic-systems.md)), tool ủy quyền ẩn khỏi model (chỉ thấy roster). → Kiểm: test static đọc topology: không tool hai chủ, không chu trình, depth ≤ giới hạn; runtime từ chối lời gọi ngoài topology (test). · Nguồn: OWASP ASI03, ASI07; catalog 02 §4 (OpenCompany), 23 §2.3
- [ ] `PRF-AGENTIC-002` **MUST** Trạng thái workflow nằm ngoài tiến trình (durable runtime hoặc checkpoint sync); crash/deploy giữa chừng → resume đúng bước, không lặp side effect đã xong. → Kiểm: test kill worker sau bước k → khởi động lại tiếp từ k+1; số side effect = 1; checkpoint LangGraph (nếu dùng) cấu hình sync. · Nguồn: Anthropic multi-agent research (resume thay vì chạy lại); catalog 21 §5
- [ ] `PRF-AGENTIC-003` **MUST** Mọi side effect đối ngoại đi qua **outbox**: ghi intent trước khi gọi, lease + fencing token, kết quả `outcome_unknown` → reconcile bằng đọc lại (read-back), không retry mù; "đã gửi" chỉ tính khi có receipt. → Kiểm: test crash sau gọi API nhưng trước ghi receipt → không gửi lần hai, trạng thái `outcome_unknown` rồi reconcile; test 504 → không retry tự động. · Nguồn: catalog 21 §8 mục 8 (Sales-Hunter ADR-0010), 23 §4.5
- [ ] `PRF-AGENTIC-004` **MUST** HITL theo mức rủi ro T0–T4 (enum `external_side_effects` trong schema hành động): tiền, publish, xoá, đổi quyền, gửi ra ngoài ≥ T3 cần người duyệt; cổng là code; subagent không tự nâng tier; gate quá hạn → **leo thang**, không tự pass. → Kiểm: test action T3 không approval → chờ, không thực thi; test sau timeout → sự kiện escalation, trạng thái WAITING; test subagent gửi tier thấp hơn thực tế → bị validator nâng lại. · Nguồn: OWASP ASI09; catalog 23 §4.5 (T0–T4, human gate 24h)
- [ ] `PRF-AGENTIC-005` **MUST** Mỗi run có 4 số (max vòng, ngân sách tiền, timeout, hạn) và toàn hệ có **spend circuit breaker** 80 % cảnh báo / 90 % bóp / 100 % dừng, sống qua restart. → Kiểm: cấu hình 4 số bắt buộc (run không có → từ chối khởi động); test chi tiêu giả vượt 100 % → mọi agent dừng, trạng thái lưu trên đĩa/DB. · Nguồn: OWASP LLM 2026 LLM06, ASI08; catalog 21 §8, §10
- [ ] `PRF-AGENTIC-006` **MUST** Kill switch toàn hệ: một lệnh dừng mọi agent/subagent, thu hồi credential ngắn hạn, dừng trigger; đã diễn tập và ghi log. → Kiểm: runbook `KILL.md` + log diễn tập có ngày; test `interrupt` lan tới subagent trong ≤ thời gian ADR; trigger (cron/routine) bị vô hiệu sau kill. · Nguồn: OWASP ASI10 Rogue Agents
- [ ] `PRF-AGENTIC-007` **MUST** Thông điệp giữa agent có schema, có danh tính nguồn xác thực được (credential riêng từng agent; Agent Card ký số/mTLS khi xuyên hệ); nội dung từ agent khác là **untrusted** như tool output. → Kiểm: test message giả mạo nguồn → từ chối; test message sai schema → từ chối; handoff hai chiều qua classifier injection (nếu có). · Nguồn: OWASP ASI07; A2A v1.0.1 (security schemes, Agent Card)
- [ ] `PRF-AGENTIC-008` **MUST** Phát hiện không-tiến-triển: cùng chữ ký lỗi ≥ 3 lần → BLOCKED; lặp tool call/vòng không sinh thông tin mới → dừng; chuỗi đỏ lần 2 cảnh báo, lần 3 chặn. → Kiểm: test task trả cùng lỗi 3 lần → trạng thái `blocked`, cần người; không có vòng thứ 4. · Nguồn: OWASP ASI08; catalog 23 §2.2 (ba cổng máy)
- [ ] `PRF-AGENTIC-009` **MUST** Eval end-to-end cả hệ (không chỉ từng agent) với **pass^k**, có negative control (ca cố ý sai phải bị phát hiện), record/replay trong CI không gọi model; ghi lại fixture chỉ qua `workflow_dispatch`. → Kiểm: job CI `eval-replay` xanh không có API key; báo cáo pass^k ≥ ngưỡng ADR; claim matrix gắn nhãn `real-path`/`faithful-fixture`/`asserted-not-measured`. · Nguồn: catalog 07, 23 §3.1
- [ ] `PRF-AGENTIC-010` **MUST** "Đã xong" do **code** điền (`verified_by`, exit code, receipt), không tin lời model; evaluator tách generator và dùng **model khác**; `unverified` tính là failed ở cổng. → Kiểm: schema trạng thái task có `verified_by ∈ {ci, test, receipt}`; test task model khai "done" không bằng chứng → verdict `verify`, không `done`. · Nguồn: P1; catalog 23 §3.1
- [ ] `PRF-AGENTIC-011` **MUST** Chống cascading failure: timeout + bulkhead + retry budget cho từng agent/tool; backpressure khi hàng đợi đầy; lỗi một agent không kéo cả hệ gọi lại vô hạn. → Kiểm: chaos test một worker trả lỗi liên tục → breaker mở, các agent khác tiếp tục hoặc hệ dừng có kiểm soát; không có "400 lần gọi trong 5 phút". · Nguồn: OWASP ASI08; mẫu ở [`../05-architecture/resilience-and-scalability.md`](../05-architecture/resilience-and-scalability.md)
- [ ] `PRF-AGENTIC-012` **MUST** Audit ledger append-only cho mọi hành động: agent, tool, hash input, approval (ai/khi nào), kết quả, correlation id; chống sửa (HMAC chain hoặc WORM). → Kiểm: test sửa một bản ghi → verify chain fail; truy vết được một side effect ngược về approval và trigger (chi tiết → [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md)). · Nguồn: catalog 12 §3g ("một định nghĩa scope, hai điểm thực thi")
- [ ] `PRF-AGENTIC-013` **MUST** Mỗi agent có identity và credential **riêng**, ngắn hạn, scope theo task (Vault/WIF/OIDC); không chia sẻ API key người dùng giữa agent; secret không vào context. → Kiểm: test agent A dùng credential của B → 403; danh sách credential theo agent trong IaC; gitleaks trên transcript mẫu. · Nguồn: OWASP ASI03; NIST AI Agent Identity & Authorization concept paper (2026)
- [ ] `PRF-AGENTIC-014` **MUST** Trạng thái chia sẻ (blackboard/memory/file) có **một người ghi** mỗi artifact, ghi qua tool có validate, cách ly tenant; chỉ harness commit git khi nhiều agent cùng repo. → Kiểm: test hai agent ghi cùng artifact → một bị từ chối/hàng đợi; test memory chứa chỉ thị → gắn cờ. · Nguồn: OWASP ASI06; catalog 02 §4b (hive single-committer)
- [ ] `PRF-AGENTIC-015` **MUST** Harness có hạn sử dụng: mỗi thành phần harness ghi `model` + `verified_on` + giả định nó bù; khi đổi model phải chạy lại eval và xét bỏ thành phần không còn chịu lực. → Kiểm: file `harness.yaml` có hai trường; CI eval kích hoạt khi `model` đổi; ADR cho lần đổi model gần nhất. · Nguồn: Anthropic *Harness design* (2026-03-24); catalog 21 §2.2
- [ ] `PRF-AGENTIC-016` **MUST@M** Run theo lịch/trigger không người: prompt **tự đủ** (không kế thừa phiên), hành động đối ngoại chỉ **đề xuất** vào hàng chờ duyệt, agent trong CI read-only và ghi qua job tách quyền (`safe-outputs`), kiểm `author_association`/human actor. → Kiểm: workflow CI: job có model không có `contents: write`; job ghi không có model; test comment từ bot không kích hoạt. · Nguồn: catalog 21 §4, §10; 23 §8.1
- [ ] `PRF-AGENTIC-017` **MUST@L** Red-team độc lập trước khi ra mắt (injection xuyên agent, leo thang quyền, rogue agent, exfiltration qua outbox) theo OWASP AI Testing Guide; mọi phát hiện cao đã đóng. → Kiểm: báo cáo red-team trong repo + issue đã đóng; lịch red-team định kỳ. · Nguồn: OWASP AI Testing Guide v1 (2025-11-26, chưa xác minh trực tiếp)
- [ ] `PRF-AGENTIC-018` **SHOULD** Context reset có handoff có cấu trúc (progress file, feature list JSON chỉ đổi trường `passes`, git) thay vì để tràn context; compaction ở ngưỡng cấu hình. → Kiểm: file handoff tồn tại và được đọc ở đầu phiên mới (test).
- [ ] `PRF-AGENTIC-019` **SHOULD** Đo baseline (DORA/thời gian/chi phí/chất lượng) **trước** khi bật tự trị; A/B khi đủ traffic; quality metrics theo phiên bản harness. → Kiểm: báo cáo baseline có ngày; dashboard theo `harness_version`.
- [ ] `PRF-AGENTIC-020` **SHOULD** Rollout rainbow: chuyển traffic dần, không ngắt run đang chạy; rollback giữ được state durable. → Kiểm: diễn tập rollback trên run đang chạy → resume đúng.
- [ ] `PRF-AGENTIC-021` **MAY** A2A cho agent của tổ chức khác; MCP Tasks extension cho tool chạy dài; Managed Agents hoặc nền tảng host khi không muốn tự vận hành runtime. → Kiểm: ADR ghi lựa chọn và ranh giới dữ liệu (ZDR/HIPAA không áp dụng cho Managed Agents).

## Ánh xạ OWASP Top 10 for Agentic Applications 2026 → mục

| ASI | Mục (hồ sơ này) | Kế thừa từ `ai-agent` |
|---|---|---|
| ASI01 Goal Hijack | 007, 014 | PRF-AGENT-003 |
| ASI02 Tool Misuse | 001, 005 | PRF-AGENT-002/004 |
| ASI03 Identity & Privilege Abuse | 001, 013 | PRF-AGENT-006 |
| ASI04 Agentic Supply Chain | — | `SEC-SUPPLY-016/017` (PRF-AGENT-015 ngừng dùng) |
| ASI05 Unexpected Code Execution | — | PRF-AGENT-007 |
| ASI06 Memory & Context Poisoning | 014 | PRF-AGENT-013 |
| ASI07 Insecure Inter-Agent Communication | 001, 007 | — |
| ASI08 Cascading Failures | 005, 008, 011 | PRF-AGENT-005 |
| ASI09 Human-Agent Trust Exploitation | 004, 010 | PRF-AGENT-004/012 |
| ASI10 Rogue Agents | 006, 012, 015 | PRF-AGENT-011 |

## Cổng chất lượng tương đương

| Cổng chung | Tương đương hệ agentic | Công cụ |
|---|---|---|
| Core Web Vitals | Thời gian hoàn thành/run, cost/run, tỷ lệ run cần người, tỷ lệ resume thành công | Trace OTel + metric durable runtime |
| E2E trình duyệt | Eval end-to-end pass^k + replay + chaos test | Inspect, Promptfoo, fixture, chaos job |
| Security scan | Red-team xuyên agent + verify audit chain + test outbox | Job `audit-verify`, promptfoo red-team |
| Rollback DB | Resume từ checkpoint + reconcile outbox | Diễn tập có log |
| Coverage | Tỷ lệ hành động có tier + tỷ lệ tool có owner | Test static topology |
| Lighthouse CI | Báo cáo eval theo `harness_version` so baseline | CI artifact |

## Bẫy

1. **Cổng duyệt trong prompt của agent điều phối** ("tune the prompt, not the code") — injection thì hành động phá huỷ vẫn chạy (catalog 02 §4b).
2. **Retry mù sau 504/timeout** — gửi mail/đăng bài hai lần; `outcome_unknown` phải reconcile (003).
3. **Checkpoint async** — crash cứng mất checkpoint mới nhất; đặt sync (002).
4. **Lồng agent không trần, tool ủy quyền lộ cho model** — mất kiểm soát ủy quyền; độ sâu khuyến nghị 2, trần 3 (`AI-AGENTIC-007`), roster thay tool (001). Luật "subagent không lồng" của vòng lặp phát triển ([`../11-autonomous-loop/orchestration-and-subagents.md`](../11-autonomous-loop/orchestration-and-subagents.md)) không áp cho sản phẩm.
5. **Multi-agent cho việc cần chia sẻ context chặt (đa số coding)** — tốn ~15× token, chất lượng không hơn; chỉ dùng breadth-first (Anthropic multi-agent research).
6. **Judge/evaluator cùng model với generator** — thiên lệch; khác model, tách tiến trình (010).
7. **"Goal met?" do model tự khai** — dừng theo ngân sách + kiểm máy (010; catalog 03 §8c).
8. **Routine/cron kế thừa ngữ cảnh ảo** — prompt không tự đủ, agent đoán; viết prompt standalone (016).
9. **Harness viết cho model cũ giữ mãi** — thành phần thừa làm chậm và tốn; ghi ngày + model, xét lại (015).
10. **Telemetry/gateway mặc định bật, fail-open, bind 0.0.0.0** — rò task/URL, lộ cổng; kiểm cấu hình mặc định trước khi chạy (catalog 12 §3i).

## Nguồn

- `research/2026-10-13-ai-agent-research.md` §1.1 (subagent depth, hooks, permission order), §2.1–2.2 (MCP 2026-07-28, A2A v1.0.1), §3.3–3.5 (HITL, long-running, checkpointing), §4.1 (pass^k), §5.1 (ASI01–10, tên mục từ nguồn thứ cấp — bản gốc 403 ngày 2026-10-13), §6 — xác minh 2026-10-13
- Anthropic *Effective harnesses for long-running agents* (2025-11-26): <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>; *Harness design for long-running application development* (2026-03-24): <https://www.anthropic.com/engineering/harness-design-long-running-apps>; *How we built our multi-agent research system* (2025-06-13): <https://www.anthropic.com/engineering/multi-agent-research-system> — xác minh 2026-10-13 (research §1.3)
- Catalog `seeker19110/stored` 21 (bốn tầng, 4 số, circuit breaker 80/90/100, outbox, durable execution, gh-aw safe-outputs), 02 §4/§4b (topology, hive single-committer, cổng bằng prompt), 23 §2.2/§3.1/§4.5 (ba cổng máy, verified_by, T0–T4), 12 §3g (ledger HMAC) — đọc 2026-10-13; tóm tắt `research/2026-10-13-stored-catalog-extraction.md` §2.10–2.11
- A2A spec: <https://a2a-protocol.org/latest/specification/> (v1.0.1, 2026-05-26) — xác minh 2026-10-13
- NIST AI Agent Standards Initiative (2026-02-17) + Agent Identity & Authorization concept paper: <https://www.nist.gov/> — xác minh 2026-10-13 (research §5.5)
- Phiên bản: <https://github.com/temporalio/temporal/releases/latest> v1.32.1; <https://pypi.org/project/temporalio/> 1.34.0 (ngày chưa xác minh — JSON quá lớn); <https://github.com/restatedev/restate/releases/latest> v1.7.13; `langgraph` 1.2.15; `inspect-ai` 0.3.279; `promptfoo` 0.124.1 — xác minh 2026-10-13
- (chưa xác minh) OWASP AI Testing Guide v1 — chỉ qua research §5.1 [S].
