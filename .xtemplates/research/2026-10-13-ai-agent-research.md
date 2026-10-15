---
title: Nghiên cứu AI agent, agentic system và ứng dụng LLM production
kind: research
updated: 2026-10-13
---

# BÁO CÁO NGHIÊN CỨU: Xây dựng AI agent / agentic system / ứng dụng LLM đạt chất lượng production
**Ngày nghiên cứu:** 2026-10-13 · **Phương pháp:** WebFetch trực tiếp trang chính thống (Anthropic docs, MCP spec, A2A spec, OWASP, PyPI/GitHub releases…) + WebSearch (mode extended) cho tin mới. Mọi mục ghi rõ mức xác minh: **[F]** = fetch trực tiếp nguồn gốc; **[S]** = chỉ qua kết quả tìm kiếm/nguồn thứ cấp; **[K]** = từ kiến thức nền, chưa xác minh sống. *Lưu ý:* quota WebSearch của phiên đã hết ở bước cuối, nên vài chi tiết thứ cấp (ghi [S]) chưa được đối chiếu lần hai.

---

## 1. NỀN TẢNG ANTHROPIC

### 1.1 Claude Agent SDK (Claude Code đóng gói thành thư viện)
| Mục | Giá trị | Xác minh |
|---|---|---|
| Python `claude-agent-sdk` | **0.2.165** (2026-10-08) | [F] PyPI |
| TypeScript `@anthropic-ai/claude-agent-sdk` | **0.3.296** (CHANGELOG; npm trả 403 nên chưa thấy ngày) | [F] GitHub CHANGELOG |
| Claude Code CLI | **2.1.296** (2026-10-09) | [F] code.claude.com/docs/en/changelog |
| Docs | https://code.claude.com/docs/en/agent-sdk/overview | [F] |

**Khái niệm cốt lõi** [F]: built-in tools (Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch) · **Hooks** · **Subagents** · **MCP** · **Permissions** · **Sessions** (continue / resume theo `session_id` / fork; transcript tại `~/.claude/projects/<cwd-mã-hoá>/*.jsonl`; `SessionStore` adapter để resume xuyên máy; `persistSession:false` nếu không muốn ghi đĩa) · **Skills/commands/memory** nạp từ `.claude/` · **Plugins**. Bốn cách build agent: (1) Messages API vòng lặp tự viết, (2) Tool Runner trong SDK API, (3) **Managed Agents** (Anthropic host loop + sandbox), (4) **Agent SDK** (harness Claude Code, bạn tự host).

**Thứ tự đánh giá quyền (bắt buộc hiểu khi thiết kế)** [F]: **Hooks → deny rules → ask rules → permission mode → allow rules → `canUseTool` callback**. Hook `deny` có hiệu lực cả trong `bypassPermissions`; `allowed_tools` **không** thu hẹp `bypassPermissions` (muốn chặn phải dùng `disallowed_tools`); tool được auto-approve **không bao giờ** chạm `canUseTool` → kiểm tra bắt buộc phải đặt ở `PreToolUse` hook.

**Permission modes** [F]: `default` · `dontAsk` (từ chối thay vì hỏi — dùng cho headless) · `acceptEdits` · `bypassPermissions` (từ chối chạy dưới root/sudo ngoài sandbox) · `plan` · **`auto`** (classifier model duyệt từng hành động; là mode khởi động mặc định từ v2.1.283). Subagent kế thừa mode cha; không bao giờ tự nâng lên `bypassPermissions`.

**Auto mode (blog 2026-03-25, docs permission-modes)** [F]: classifier (Sonnet 4.6) 2 tầng (lọc nhanh thiên về chặn → chain-of-thought nếu bị cờ); **chỉ nhìn user messages + tool calls**, bỏ prose của assistant và tool output để agent không "lý luận" qua mặt; đánh giá **hành động thực tế** (payload, lệnh nối chuỗi) không phải chữ bề mặt; >20 rule chặn mặc định trong 4 nhóm: *phá hủy/exfiltrate, hạ thấp security posture, vượt ranh giới tin cậy, qua mặt review/ảnh hưởng người khác*; ranh giới người dùng nói trong hội thoại ("đừng push") được coi là tín hiệu chặn; số liệu công bố: FP 0.4%, FN 17%. Lệnh `claude auto-mode defaults` in JSON rule; admin tắt bằng `permissions.disableAutoMode: "disable"`.

**Sandbox Bash** [F] (docs/en/sandboxing): OS-level (macOS Seatbelt; Linux/WSL2 `bubblewrap`+`socat`); `sandbox.filesystem.allowWrite/denyWrite/denyRead/allowRead`, `sandbox.network.allowedDomains/deniedDomains` (qua proxy cục bộ, mặc định rỗng); `allowUnsandboxedCommands:false` = strict; `failIfUnavailable`; `credentials` masking; **ngoài sandbox**: tool Read/Edit/WebFetch, MCP server, hooks (tuân theo permission rules thay vì sandbox).

**Hooks** [F] (docs/en/hooks): **33 events** (SessionStart, Setup, SessionEnd, UserPromptSubmit, Stop, StopFailure, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, SubagentStart/Stop, TaskCreated/Completed, Elicitation/ElicitationResult, PreCompact/PostCompact, PreModelSwitch/PostModelSwitch, ConfigChange, FileChanged, WorktreeCreate/Remove, Notification, MessageDisplay…). Loại handler: `command`, `http`, `mcp_tool`, `prompt`, `agent` (experimental). Exit code: **0** OK (stdout JSON hoặc text), **2** block (stderr là lý do), khác = lỗi không chặn; `"onFailure":"block"` (≥2.1.295). JSON: `PreToolUse.hookSpecificOutput.permissionDecision` = allow/deny/ask/defer, `updatedInput`, `additionalContext` (cap 10.000 ký tự); `PostToolUse.updatedToolOutput`; `decision:"block"` cho Stop/UserPromptSubmit…

**Skills** [F] (code.claude.com/docs/en/skills + platform docs agent-skills): `SKILL.md` + frontmatter (`name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `hooks`, `paths`, `shell`). Vị trí: enterprise > personal `~/.claude/skills/` > project `.claude/skills/` > nested > plugin (namespaced). **Progressive disclosure 3 tầng**: metadata luôn nạp (~100 token) → thân SKILL.md khi kích hoạt (<5k token) → tài nguyên/script khi cần (script chạy qua bash, chỉ output vào context). Giữ SKILL.md < 500 dòng. Qua API: `name` ≤64 ký tự chữ thường-số-gạch, `description` ≤1024; sandbox API **không có mạng**. Anthropic cảnh báo: chỉ dùng Skill từ nguồn tin cậy, audit như cài phần mềm.

**Subagents** [F]: file Markdown + frontmatter (`name`, `description` bắt buộc; `tools`, `disallowedTools`, `model` sonnet/opus/haiku/fable/inherit, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory` user/project/local, `background`, `effort`, `isolation: worktree`, `autoCompactWindow` (mới 2.1.296), `omitClaudeMd`). Ưu tiên: managed > `--agents` CLI > `.claude/agents/` > `~/.claude/agents/` > plugin. Context cách ly, chỉ summary trả về; độ sâu lồng tối đa 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`); `CLAUDE_CODE_SUBAGENT_MODEL`.

**Plugins** [F]: `.claude-plugin/plugin.json` + skills/agents/hooks/hooks-module (mod)/`.mcp.json`; marketplace = repo có `.claude-plugin/marketplace.json`; scope user/project/local; official `claude-plugins-official`; plugin chạy với quyền của bạn → review trước khi cài; có "Context cost" ước tính.

**Headless / CI** [F] (docs/en/headless): `claude -p "…"`; **`--bare`** (bỏ hook/skill/plugin/MCP/CLAUDE.md tự động — khuyến nghị cho CI, sẽ thành mặc định); `--output-format json|stream-json` (+`--json-schema` → `structured_output`); `--allowedTools "Bash(git diff *)"`; `--permission-mode dontAsk|auto|acceptEdits`; `--permission-prompts none` (≥2.1.259); `--max-turns`, `--max-budget-usd`; `--continue/--resume <id>`; exit 0/non-zero; stdin cap 10 MB; event `system/api_retry` (attempt, retry_delay_ms, error…); `system/init` có `plugin_errors`, `mcp_server_errors` → **gate CI fail nếu non-empty**; SIGTERM → exit 143, chạy `SessionEnd` hooks.

**GitHub Actions** [F]: `anthropics/claude-code-action@v1`; setup `/install-github-app`; secret `ANTHROPIC_API_KEY` hoặc `CLAUDE_CODE_OAUTH_TOKEN`; **WIF/OIDC** (`anthropic_federation_rule_id`, `anthropic_organization_id`, `id-token: write`) để không lưu secret dài hạn; chế độ interactive (`@claude`) vs automation (`prompt`); kiểm tra **write access + human actor** (`allowed_bots`, `allowed_non_write_users`) chống loop bot; `claude_args: --max-turns …`; `use_bedrock/use_vertex/use_foundry` qua OIDC.

**Claude Managed Agents (beta `managed-agents-2026-04-01`)** [F]: Agent (model/system/tools/MCP/skills, versioned) → Environment (cloud sandbox hoặc **self-hosted sandbox**) → Session (SSE events, steer/interrupt) → Events; thêm Vaults (credential thay thế tại egress), scheduled deployments (cron), outcomes (grader theo rubric), multiagent/dynamic workflows, memory stores (`agent-memory-2026-07-22`); **không** eligible ZDR/HIPAA BAA; rate limit 300 create/1.200 read rpm.

### 1.2 Claude API (Messages) — trạng thái 2026-10-13 [F] (platform.claude.com/docs/en/about-claude/models/overview + skill `claude-api` cache 2026-10-06)
| Model | ID | Giá in/out $/MTok | Ghi chú |
|---|---|---|---|
| Claude Fable 5.1 | `claude-fable-5-1` | 10 / 50 | thinking luôn bật, effort mặc định `high`, cache read 2.5% |
| Claude Opus 5.5 (mặc định khuyến nghị) | `claude-opus-5-5` | 4 / 20 | thinking luôn bật, effort mặc định **`medium`**, cache read 5% |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 2 / 10 | effort mặc định `high`; tắt thinking bằng `{type:"between_tools"}` |
| Claude Haiku 5.5 | `claude-haiku-5-5` | từ 0.10 / 0.50 (≤100K prompt) | effort mặc định `medium` |
Tất cả: **1M context, 128K output**, knowledge cutoff Jun 2026, retirement không sớm hơn 9–10/2027. Legacy còn dùng: Fable 5, Opus 5/4.8/4.7/4.6/4.5, Sonnet 5/4.6, Haiku 4.5. ID là snapshot pinned, **không thêm hậu tố ngày**. Models API trả `max_input_tokens`, `max_tokens`, `capabilities`, `line`.

**Quy tắc API có thể biến thành checklist:**
- ☐ **Thinking**: dùng `thinking: {type:"adaptive"}` (hoặc bỏ qua); `budget_tokens` **bị 400** trên 5.x; điều khiển bằng `output_config.effort` = low/medium/high/xhigh/max; `display` mặc định `"omitted"` → đặt `"summarized"` nếu UI cần hiện reasoning; `"updates"` (beta `thinking-display-updates-2026-08-18`) cho progress notes.
- ☐ **Không prefill assistant** (400 từ 4.6+); dùng structured outputs.
- ☐ **Forced `tool_choice` any/tool → 400** trên Fable 5.1 / Opus 5.5 / Sonnet 5.5 → dùng `auto` + `strict:true` + chỉ dẫn trong prompt.
- ☐ **Preserved thinking**: thinking block gắn với model+hội thoại; sửa lịch sử cũ làm vô hiệu block (tài khoản tạo sau 2026-08-31 bị 400) → harness phải **append-only**; dùng mid-conversation `{"role":"system"}` trong `messages` để thêm chỉ dẫn mà không phá cache; `clear_at:"next_user_message"` (beta) cho nhắc 1 lượt.
- ☐ **Prompt caching** (docs prompt-caching): `cache_control:{type:"ephemeral"}` (auto ở top-level hoặc breakpoint tường minh, tối đa 4, lookback 20 block); TTL 5 phút mặc định / `ttl:"1h"`; tối thiểu **512 token** trên 5.x; giá write 1.25× (5m) / 2× (1h), read 0.1× (0.025× Fable 5.1; 0.05× Opus/Sonnet 5.5); thứ tự prefix `tools → system → messages`, đổi tools làm mất toàn bộ; **đặt breakpoint ở block cuối cùng giống nhau giữa các request**, không chứa timestamp; giữ thứ tự key JSON ổn định; pre-warm với `max_tokens:0`; kiểm bằng `usage.cache_read_input_tokens`.
- ☐ **Structured outputs GA** (không beta): `output_config.format={type:"json_schema",schema}`; `strict:true` trên tool (yêu cầu `additionalProperties:false` + `required`); `output_format` cũ đã deprecated; giới hạn: không recursive, không `minimum/maximum/minLength/maxLength`, `minItems` ≤1, ≤20 strict tools/request; dùng `client.messages.parse()` với Pydantic/Zod.
- ☐ **Compaction**: ưu tiên **on-demand** (beta `compact-2026-09-04`, tham số top-level `compaction`; giữ recent turns; chạy background); threshold compaction (beta `compact-2026-01-12`, trigger mặc định 150K) — luôn append nguyên `response.content` (gồm compaction block) vào messages; **Context editing** (beta `context-management-2025-06-27`: `clear_tool_uses_20250919`, `clear_thinking_20251015`) để xoá theo rule.
- ☐ **Tool use**: parallel tool use mặc định → trả **tất cả** `tool_result` trong **một** user message, lỗi dùng `is_error:true`; luôn `json.loads` input; `eager_input_streaming:true` cho tool client khi streaming (tự validate schema); **Tool Runner** (`client.beta.messages.tool_runner`, `@beta_tool`/`betaZodTool`); **programmatic tool calling** (`code_execution_20260120` + `allowed_callers`); **tool search** (`tool_search_tool_regex_20251119`/bm25 + `defer_loading:true`, không defer tất cả); **memory tool** `memory_20250818`; server tools `web_search_20260209`, `web_fetch_20260209`, `code_execution_20260521` (lỗi trả về trong content, không raise); **MCP connector** cần cả `mcp_servers` + `tools:[{type:"mcp_toolset"}]` (beta `mcp-client-2025-11-20`); advisor tool.
- ☐ **Computer use**: `computer_toolset_20260801` GA trên Claude API/Google Cloud, không beta header, 17 member tools, batch actions dừng ở lỗi đầu tiên; **bảo mật**: VM/container riêng, không đưa credential, allowlist domain, xác nhận người trước hành động hệ quả, classifier Anthropic quét screenshot chống injection, thông báo & lấy consent người dùng cuối.
- ☐ **Batch**: 50% giá, kết quả **không theo thứ tự → key bằng `custom_id`**, 100K request/batch, 300K output với beta `output-300k-2026-03-24`. **Files API GA** (`client.files.*`, không beta). **Citations** `citations:{enabled:true}` trên document (không kết hợp `output_config.format`).
- ☐ **An toàn**: luôn kiểm `stop_reason` (`refusal`, `max_tokens`, `pause_turn`) trước khi đọc content; `stop_details.category` (cyber/bio/reasoning_extraction/frontier_llm/general_harms); bật **server-side fallbacks** `fallbacks:"default"` (beta `server-side-fallback-2026-07-01`).
- ☐ **Khác**: task budgets (beta `task-budgets-2026-03-13`, min 20.000), fast mode (beta `fast-mode-2026-02-01`, Opus 5/5.5/4.8), `inference_geo`, Admin API beta (từ 2026-08-26), WIF; SDK `max_retries` mặc định 2, timeout 10 phút (TS tính **ms**); streaming cho `max_tokens` lớn.

### 1.3 Hướng dẫn kỹ thuật của Anthropic (ngày xác minh [F] từ anthropic.com/engineering)
| Bài | Ngày | URL |
|---|---|---|
| Building effective agents | 2024-12-19 | anthropic.com/engineering/building-effective-agents |
| Introducing Contextual Retrieval | 2024-09-19 | …/contextual-retrieval |
| Claude Code: best practices for agentic coding | 2025-04-18 | …/claude-code-best-practices |
| How we built our multi-agent research system | 2025-06-13 | …/multi-agent-research-system |
| Writing effective tools for agents — with agents | 2025-09-11 | …/writing-tools-for-agents |
| Effective context engineering for AI agents | 2025-09-29 | …/effective-context-engineering-for-ai-agents |
| Equipping agents for the real world with Agent Skills | 2025-10-16 | …/equipping-agents-for-the-real-world-with-agent-skills |
| Beyond permission prompts (sandboxing) | 2025-10-20 | …/claude-code-sandboxing |
| Code execution with MCP | 2025-11-04 | …/code-execution-with-mcp |
| Advanced tool use (tool search, PTC, examples) | 2025-11-24 | …/advanced-tool-use |
| Mitigating the risk of prompt injections in browser use | 2025-11-24 | anthropic.com/research/prompt-injection-defenses |
| Effective harnesses for long-running agents | 2025-11-26 | …/effective-harnesses-for-long-running-agents |
| Demystifying evals for AI agents | 2026-01-09 | …/demystifying-evals-for-ai-agents |
| Designing AI-resistant technical evaluations | 2026-01-21 | …/AI-resistant-technical-evaluations |
| Building a C compiler with a team of parallel Claudes | 2026-02-05 | …/building-c-compiler |
| Quantifying infrastructure noise in agentic coding evals | 2026-02-05 | …/infrastructure-noise |
| Harness design for long-running application development | 2026-03-24 | …/harness-design-long-running-apps |
| How we built Claude Code auto mode | 2026-03-25 | …/claude-code-auto-mode |
| Scaling Managed Agents: decoupling the brain from the hands | 2026-04-08 | …/managed-agents |
| An update on recent Claude Code quality reports (postmortem) | 2026-04-23 | …/april-23-postmortem |
| A harness for every task: dynamic workflows in Claude Code | 2026-06-02 | claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code |

**Checklist rút ra (Building effective agents + Context engineering + Writing tools):**
- ☐ Bắt đầu từ cách đơn giản nhất: 1 lời gọi → workflow → agent; chỉ nâng cấp khi đo thấy cần (4 tiêu chí: complexity, value, viability, cost of error).
- ☐ 3 nguyên tắc agent: **đơn giản, minh bạch (hiện bước lập kế hoạch), ACI (giao diện agent–máy tính) được thiết kế & test như HCI**.
- ☐ System prompt ở "độ cao đúng": không if-else cứng, không mơ hồ; bắt đầu tối thiểu rồi bổ sung theo lỗi quan sát được; ví dụ canonical thay vì liệt kê mọi edge case.
- ☐ Context là tài nguyên hữu hạn ("context rot"): tìm **tập token tín hiệu cao nhỏ nhất**; just-in-time retrieval (đường dẫn/truy vấn nhẹ, nạp khi cần); compaction (recall trước, precision sau; xoá tool result cũ là compaction an toàn nhất); note-taking có cấu trúc ngoài context; sub-agent với context sạch trả về summary cô đọng.
- ☐ Tool: thiết kế quanh việc agent cần làm (không bọc 1:1 endpoint); gộp bước (vd `schedule_event`); ưu tiên search hơn list-all; namespacing theo service/resource; trả trường ý nghĩa (tên thay UUID), tham số `response_format` concise/detailed; phân trang/truncate có hướng dẫn thu hẹp; **lỗi nói rõ cái gì sai + cách sửa + ví dụ input hợp lệ**; tên tham số không mơ hồ (`user_id`); schema chặt; dùng MCP annotations cho tool phá hủy/open-world; **mọi thay đổi description phải đo bằng eval** (đường dẫn tuyệt đối thay tương đối là ví dụ "poka-yoke").

### 1.4 Chính sách & hiến pháp
- **Claude's constitution** (2026-01-22, CC0) [S — anthropic.com/news/claude-new-constitution]: thứ tự ưu tiên *broadly safe → ethical → tuân thủ guideline Anthropic → helpful*; có "hard constraints" (vd không hỗ trợ vũ khí hủy diệt hàng loạt, không phá hoại giám sát của con người).
- **Usage Policy update** (công bố 2026-10-08, **hiệu lực 2026-11-12**) [F — anthropic.com/news/2026-usage-policy-update]: yêu cầu khi Claude điều khiển **phần cứng vật lý** (operator quan sát & dừng được; thiết bị về trạng thái an toàn khi mất kết nối; "Model Hardware Standard"); **high-risk use** (y tế, pháp lý, tài chính, sinh kế, dịch vụ thiết yếu) phải có **người có chuyên môn review & sửa**, và thông báo cho người bị ảnh hưởng rằng có AI; mục mới "Do Not Engage in Deceptive Campaigns or Artificial Activity"; cấm dùng để quyết định điều tra/bắt/truy tố, cấm xây công cụ giám sát; cấm hành vi lạm dụng kéo dài với model.
- **Agent SDK terms** [F]: không được cung cấp claude.ai login/rate limit cho bên thứ ba; không dùng thương hiệu "Claude Code"; Commercial Terms áp dụng.

---

## 2. GIAO THỨC & FRAMEWORK

### 2.1 MCP — Model Context Protocol
- **Spec hiện hành: `2026-07-28`** [F] (trước đó 2025-11-25, 2025-06-18, 2025-03-26). URL: https://modelcontextprotocol.io/specification/2026-07-28 · changelog: …/2026-07-28/changelog. Quản trị: **Agentic AI Foundation (AAIF, Linux Foundation)**, thành lập 2025-12-09 (Anthropic, OpenAI, Block; dự án khởi đầu MCP, AGENTS.md, goose) [S].
- **Thay đổi lớn 2026-07-28** [F]: (1) **Stateless** — bỏ `Mcp-Session-Id` và handshake `initialize`; mỗi request mang `_meta` `io.modelcontextprotocol/protocolVersion` + `clientCapabilities`; state xuyên request dùng **handle server cấp** truyền như tham số tool; (2) `server/discover` bắt buộc; (3) `subscriptions/listen` thay HTTP GET + `resources/subscribe`; (4) bỏ `ping`, `logging/setLevel`, `notifications/roots/list_changed`; (5) **Tasks** thành extension `io.modelcontextprotocol/tasks` (polling `tasks/get`, `tasks/update`); (6) **MRTR** (Multi Round-Trip Requests: `resultType:"input_required"` + `inputRequests`) thay cho server-initiated `sampling/createMessage`, `elicitation/create`, `roots/list`; (7) mọi result có `resultType` (`complete`/`input_required`); (8) bỏ SSE resumability/`Last-Event-ID` → client phải re-issue request mới; (9) `extensions` trong capabilities; (10) **OTel trace context trong `_meta`** (`traceparent/tracestate/baggage`); (11) `tools/list` phải **thứ tự xác định** (tăng cache hit); (12) header `Mcp-Method`, `Mcp-Name`; (13) `CacheableResult` (`ttlMs`, `cacheScope`); (14) auth: validate `iss` (RFC 9207), `application_type` khi DCR, credential key theo issuer; (15) JSON Schema 2020-12 đầy đủ cho `inputSchema/outputSchema`; (16) phân vùng error code (-32020…-32099 dành cho spec). **Deprecated**: Roots, Sampling, Logging; HTTP+SSE transport; `includeContext` thisServer/allServers; **Dynamic Client Registration (RFC 7591) → Client ID Metadata Documents (CIMD)**. Chính sách vòng đời: deprecation tối thiểu 12 tháng.
- **Transports**: stdio; Streamable HTTP (HTTP+SSE deprecated từ 2025-03-26). **Auth**: OAuth 2.1 + Protected Resource Metadata (RFC 9728) + resource indicators + PKCE + CIMD + `iss`. **Extensions**: Tasks, **MCP Apps** (UI inline), Skills over MCP.
- **Registry** [F GitHub]: preview từ 2025-09-08; API **v0.1 freeze** 2025-10-24; **chưa GA**; publish bằng `mcp-publisher` CLI; namespace `io.github.<user>/…` (GitHub OAuth/OIDC) hoặc `me.<domain>/…` (DNS/HTTP verify).
- **Security Best Practices (spec page)** [F] — checklist cho MCP server/client:
  - ☐ **Confused deputy**: proxy MCP dùng static client_id **phải** có consent per-client trước khi chuyển sang 3rd-party AS; redirect_uri so khớp chuỗi chính xác; `state` ngẫu nhiên, một lần, hết hạn ~10 phút; cookie `__Host-`, Secure/HttpOnly/SameSite.
  - ☐ **Token passthrough bị cấm**: server **MUST NOT** nhận token không phát hành cho chính nó (kiểm `aud`).
  - ☐ **SSRF**: bắt buộc HTTPS cho URL OAuth (trừ loopback dev), chặn dải IP private/link-local/metadata (169.254.169.254), dùng egress proxy (vd Smokescreen), cảnh giác DNS rebinding/TOCTOU.
  - ☐ **State handle hijacking**: handle không phải xác thực; ngẫu nhiên, hết hạn, bind `<user_id>:<handle>` từ token đã verify.
  - ☐ **Local server**: hiển thị **đầy đủ lệnh** trước khi chạy, cảnh báo `sudo`/`rm -rf`, chạy sandbox tối thiểu quyền; server local dùng stdio hoặc yêu cầu token/IPC.
  - ☐ **OAuth URL**: chỉ cho `http(s)`, cấm `javascript:/data:/file:`; không mở URL qua shell; CSP cho client web.
  - ☐ **Mix-up attack**: validate `iss`; **localhost redirect impersonation**: cảnh báo & hiển thị hostname; **CIMD trust policy** (allowlist/reputation).
  - ☐ **Scope minimization**: scope khởi đầu tối thiểu, step-up qua `WWW-Authenticate scope=`, không wildcard/omnibus, log elevation.
  - ☐ **Tool description/annotations là untrusted** trừ khi từ server tin cậy (nguyên tắc spec) — nền tảng chống *tool poisoning* / *rug pull*; cố định & review tool list, pin version server, so hash description.

### 2.2 A2A — Agent2Agent
- **v1.0.0** (2026-03-12), **v1.0.1** (2026-05-26, bug fix) [F GitHub releases]; spec https://a2a-protocol.org/latest/specification/ [F]. Trước đó 0.3.0 (2025-07-30). Banner spec: "A2A joins the Agentic AI Foundation" (blog 2026-08-27) [F banner; chi tiết [S]].
- Bindings: **JSON-RPC 2.0/HTTPS, gRPC, HTTP+JSON/REST**; khái niệm: **Agent Card** (có thể ký số), **Task** (submitted→working→input-required→completed/failed), **Message/Part**, **Artifact** (kết quả phải vào Artifact), `contextId`, streaming (`TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`, giữ thứ tự), push notifications (webhook), header `A2A-Version`, extensions qua `A2A-Extensions` (có `required`). Security schemes: API key, HTTP auth, OAuth2, OIDC, mTLS; server không được lộ sự tồn tại tài nguyên không được phép. SDK: `a2a-sdk` (Python), `@a2a-js/sdk`, Java, Go, .NET [S].

### 2.3 AG-UI (Agent–User Interaction, CopilotKit)
- https://docs.ag-ui.com [F]: giao thức **event-based** trên HTTP/WebSocket; tích hợp first-party: Microsoft Agent Framework, Google ADK, AWS Strands/Bedrock AgentCore, Mastra, Pydantic AI, Agno, LlamaIndex, AG2; partnership LangChain, CrewAI; community: Claude Agent SDK, Claude Managed Agents SDK. Release tag mới nhất `release/2026-10-12` [F GitHub]. Tuyên bố "AG-UI 1.0 spec ổn định" (bài CopilotKit 2026-10-05) **[S – chưa xác minh trên docs]**.

### 2.4 OpenAI Agents SDK / Responses API
- `openai-agents` **0.23.1** (2026-10-02) [F PyPI]; docs https://openai.github.io/openai-agents-python/ [F]: primitives **Agents, Handoffs/agents-as-tools, Guardrails (input/output, chạy song song, fail-fast), Sessions (memory layer), Tracing**; dùng **Responses API** mặc định; realtime agents (`gpt-realtime-2.1`).

### 2.5 Vercel AI SDK
- **AI SDK 7 GA 2026-06-25** [F vercel.com/blog/ai-sdk-7]: `@ai-sdk/workflow` **WorkflowAgent** (durable, resume sau restart/deploy/approval chậm), **tool approvals** per-tool (approve/deny/escalate function; **HMAC-signed approvals**), telemetry đăng ký 1 lần (OTel GenAI semconv, Node tracing channel; Datadog/Langfuse/Sentry), **timeouts** (run/step/chunk/tool → `TimeoutError`), **HarnessAgent** experimental (chạy Claude Code/Codex/Pi…), codemod `npx @ai-sdk/codemod v7`. npm `ai` mới nhất **7.0.138** (12 Oct, năm không hiện) + 6.0.304 + 5.0.274 còn bảo trì [F GitHub releases]. **AI SDK 6** (blog vercel.com/blog/ai-sdk-6): `ToolLoopAgent` (mặc định 20 bước), `instructions` thay `system`, LanguageModel spec v3, DevTools [S].

### 2.6 LangGraph / LangChain
- LangGraph 1.0 & LangChain 1.0 ra 2025-10-22 (LTS, không breaking tới 2.0) [S langchain.com]; **`langgraph` 1.2.15** (2026-10-12) [F PyPI]. LangChain `create_agent` trên runtime LangGraph. Persistence [F docs]: **checkpointer** (short-term, theo `thread_id`), **store** (long-term, cross-thread), time-travel, human-in-the-loop (interrupt), fault tolerance.

### 2.7 CrewAI
- **1.15.26** (2026-10-08) [S PyPI/GitHub qua search]; hai mô hình **Crews** (tự trị, cộng tác) và **Flows** (event-driven, có state, điều kiện — khuyên dùng cho production).

### 2.8 Google ADK
- **ADK 2.0 GA**: Python 2026-05-19, Go 2026-06-30, TypeScript 2026-08-21 [F adk.dev/2.0]; chuyển sang **graph-based Workflow Runtime** (agent/tool/function là node; `BaseAgent` kế thừa `BaseNode`); `adk-python` **v2.11.0** (2026-10-01) [S GitHub]; Java 1.0.0 (2026-03-30) [S]; Kotlin/Android 0.1.0 (I/O 2026) [S].

### 2.9 Microsoft Agent Framework (hợp nhất Semantic Kernel + AutoGen)
- **1.0 GA 2026-04-03** [S nhiều nguồn]; Python `agent-framework` **1.21.0** (2026-10-08) [F PyPI]; .NET `Microsoft.Agents.AI`; Go preview (repo riêng) [F GitHub README]. Tính năng: agents (YAML declarative, Agent Skills), **workflows** graph (sequential/concurrent/handoff/group) + checkpointing + streaming + HITL + time-travel, middleware, **OTel tích hợp sẵn**, A2A hosting samples, Foundry Hosted Agents. AutoGen → maintenance; SK vẫn 1.x [S].

---

## 3. KIẾN TRÚC AGENT — nguyên tắc có thể áp làm quy tắc

**3.1 Workflow vs Agent (Anthropic)** [F]: Workflow = LLM + tool theo đường code định trước; Agent = LLM tự điều khiển quy trình & tool. 5 workflow: **prompt chaining** (có gate lập trình giữa bước), **routing** (phân loại → prompt/model chuyên biệt), **parallelization** (sectioning / voting), **orchestrator-workers** (orchestrator chia việc động), **evaluator-optimizer** (vòng sinh–chấm). Agent tự trị: cần "ground truth" từ tool result mỗi bước, checkpoint hỏi người, **điều kiện dừng** (max iterations), test sandbox + guardrail.

**3.2 Các pattern khác (tổng hợp [K] + nguồn ở trên):** ReAct (reason→act→observe) là vòng lặp tool-use mặc định của Messages API; plan-and-execute (planner tách executor — Anthropic harness 2026-03-24: planner/generator/evaluator); reflection (= evaluator-optimizer, giữ evaluator **tách biệt** khỏi generator, chấm bằng tương tác thật qua Playwright, ngưỡng cứng từng tiêu chí, few-shot hiệu chuẩn); multi-agent **supervisor/orchestrator-worker** (Anthropic research system: lead lưu plan ra memory, subagent có objective/output format/tool guidance/boundary rõ, effort-scaling rule, "start wide then narrow", song song hoá spawn & tool call giảm 90% thời gian; **tốn ~15× token** so với chat, token usage giải thích 80% variance → chỉ dùng cho việc breadth-first, không cho việc cần chia sẻ context chặt như đa số coding); swarm/handoff (OpenAI Agents SDK handoffs, MS AF handoff pattern); hierarchical (Claude Code subagent depth ≤3; dynamic workflows = JS spawn subagent: fan-out-synthesize, adversarial verification, classify-and-act, generate-and-filter, tournament, loop-until-done).

**3.3 Human-in-the-loop**: mọi framework lớn đều có primitive: Agent SDK `canUseTool` + `ask` rules + `PreToolUse` hook + `AskUserQuestion`; Managed Agents permission policies `always_allow/always_ask/auto`; MCP elicitation → nay là **MRTR** `input_required`; A2A task state `input-required`; LangGraph `interrupt`; Vercel tool approvals (HMAC-signed); ADK 2.x tool confirmation; 12-factor #7 "contact humans with tool calls".

**3.4 Vòng lặp agent & long-running**
- ☐ **Ralph loop** (Geoffrey Huntley, 2025-07) [S]: `while :; do cat PROMPT.md | claude -p; done` — **context mới mỗi vòng**, tiến độ ở file + git; plugin Anthropic `ralph-wiggum@claude-plugins-official` (2025-12) dùng Stop hook giữ 1 session (tranh luận về chất lượng); luôn chạy trong sandbox/worktree/VM, có `--max-iterations` + completion promise.
- ☐ **Harness long-running (Anthropic 2025-11-26)** [F]: initializer agent + coding agent; giả định mỗi session **không nhớ gì** → state ở file & git; `feature list` JSON (agent chỉ đổi pass/fail, không xoá test); `init.sh`; `claude-progress.txt`; mở đầu session: đọc log, git log, feature list, smoke test E2E; **1 feature/session**; test như người dùng (browser automation); kết thúc ở trạng thái mergeable; dùng git để rollback.
- ☐ **Harness design 2026-03-24** [F]: "context anxiety" → reset context với handoff có cấu trúc; **sprint contract** (generator đề xuất + evaluator duyệt trước khi code); **mỗi thành phần harness là một giả định về cái model chưa làm được** → gỡ từng cái, đo lại khi đổi model; chi phí harness đầy đủ ~20× solo.
- ☐ **Checkpointing**: Agent SDK sessions (resume/fork/SessionStore) + file checkpointing; LangGraph checkpointer/time-travel; MS AF checkpointing; Vercel WorkflowAgent durable; Managed Agents session persisted server-side; Anthropic khuyên **resume từ điểm lỗi thay vì chạy lại** (multi-agent post).

**3.5 Memory**: short-term = context window + compaction/context editing; episodic/long-term = memory tool `memory_20250818` (file-based), Managed Agents memory stores, Claude Code `memory: user/project/local` cho subagent, LangGraph `store`, OpenAI Sessions; vector memory = RAG store. Quy tắc: ghi **có cấu trúc** (notes/JSON), nạp just-in-time, coi memory là bề mặt tấn công (OWASP ASI06 Memory & Context Poisoning) → validate & cách ly theo user.

**3.6 RAG 2025–2026** [S + Anthropic Contextual Retrieval 2024-09-19]: hybrid (BM25 + dense, hợp nhất RRF) là baseline; **reranker** (cross-encoder) giai đoạn precision (lấy ~20–100 → rerank → 3–5 đưa vào LLM); **contextual retrieval** (thêm ngữ cảnh chunk trước khi embed/BM25); **GraphRAG** chỉ cho multi-hop/metadata có cấu trúc (LazyGraphRAG giảm chi phí index); **agentic RAG** = agent quyết định nguồn/công cụ/index + plan-then-search; "RAG retrieves, long context refines"; với 1M context, ưu tiên **just-in-time retrieval qua tool** hơn nhồi sẵn (Anthropic context engineering).

**3.7 Tool design** (mục 1.3): idempotent (MCP stateless: handle server cấp, request lỗi phải re-issue được), schema chặt (`strict`, JSON Schema 2020-12), lỗi có hướng dẫn, annotation destructive/open-world, trả toàn bộ tool_result song song trong một message.

**3.8 12-Factor Agents (HumanLayer)** [F github.com/humanlayer/12-factor-agents]: 1 NL→tool calls; 2 own your prompts; 3 own your context window; 4 tools = structured outputs; 5 unify execution & business state; 6 launch/pause/resume bằng API đơn giản; 7 contact humans với tool calls; 8 own your control flow; 9 compact errors vào context; 10 agent nhỏ, tập trung; 11 trigger từ bất cứ đâu; 12 agent là **stateless reducer**; 13 (phụ lục) pre-fetch context.

**3.9 Structured output & state machine**: dùng `output_config.format`/`strict` để tool call = transition có kiểm tra schema; LangGraph/ADK 2.0/MS AF workflows = graph/state machine tường minh; Vercel `stopWhen`; giữ **control flow trong code** (12-factor #8), LLM chỉ chọn transition.

---

## 4. CHẤT LƯỢNG & EVAL

**4.1 Eval-driven development (Anthropic "Demystifying evals" 2026-01-09 + docs define-success)** [F] — checklist:
- ☐ Viết tiêu chí **trước** prompt: specific, measurable, achievable, relevant; đa chiều (task fidelity, consistency, relevance, tone, privacy, context use, latency, price).
- ☐ **Capability evals** bắt đầu pass rate thấp (mục tiêu); **regression evals** ~100%; chuyển eval đã ổn định sang regression.
- ☐ Grader: ưu tiên **code-based** (exact match, unit test, state check) → **model-based** cho mở (hiệu chuẩn với chuyên gia; cho judge lựa chọn "Unknown"; **một judge cho mỗi chiều rubric**; judge khác model sinh) → human để hiệu chuẩn.
- ☐ Chấm **outcome/end-state**, không chấm chuỗi bước cứng; partial credit; chống loophole.
- ☐ 20–50 task đầu từ lỗi thật; 2 chuyên gia phải cùng verdict; có reference solution; có cả case "nên làm" và "không nên làm"; pass rate ~0% nhiều lần = task hỏng.
- ☐ **pass@k** khi 1 lần thành công là đủ; **pass^k** khi mọi lần phải đúng (customer-facing).
- ☐ Môi trường sạch, cách ly mỗi trial; agent eval ≈ agent production; đọc transcript, không tin điểm số; thêm task khi bão hoà; chủ sở hữu eval rõ.
- ☐ Kết hợp: eval pre-launch/CI → monitoring sau launch → A/B khi đủ traffic → user feedback, transcript sampling.
- ☐ Golden dataset có holdout; chạy eval **mỗi lần đổi prompt/tool description/model** (regression test cho prompt); eval infra noise (Anthropic 2026-02-05) và eval awareness (2026-03-06) là nguồn sai số cần tính.

**4.2 Framework eval (phiên bản [F] PyPI/GitHub trừ ghi chú)**
| Công cụ | Phiên bản | Ngày | Ghi chú |
|---|---|---|---|
| Promptfoo | 0.124.1 | 2026-10-08 | CLI/YAML, CI-first, red-team; tin "OpenAI mua Promptfoo" **chưa xác minh** [S] |
| Braintrust (py SDK) | 0.45.0 | 2026-10-07 | SaaS, human review, experiments |
| LangSmith (py) | 0.14.8 | 2026-10-13 | mạnh nhất với LangChain/LangGraph |
| Inspect AI (UK AISI) | 0.3.279 | 2026-10-13 | eval agentic/safety |
| DeepEval | 4.2.8 | 2026-10-02 | pytest-native, >50 metric |
| Ragas | 0.4.3 | 2026-01-13 | chuyên RAG |
| Langfuse (py) | 4.17.0 | 2026-10-05 | tracing/eval OSS |
| OpenLLMetry `traceloop-sdk` | 0.62.4 | 2026-09-29 | OTel auto-instrumentation |

**4.3 Observability**: **OTel GenAI semantic conventions** đã **chuyển sang repo `open-telemetry/semantic-conventions-genai`** (opentelemetry.io/docs/specs/semconv/gen-ai chỉ còn thông báo) [F]; trạng thái **Development** (tên attribute có thể đổi) [S]; span: inference (chat/embeddings), **`invoke_agent`, `create_agent`, `execute_tool`** (tên tool trong span name); `gen_ai.provider.name` thay `gen_ai.system` (phát cả hai khi chuyển tiếp); `gen_ai.usage.input_tokens/output_tokens`; **ghi prompt/completion là opt-in** → PII do app xử lý [S]. MCP 2026-07-28 chuẩn hoá `traceparent` trong `_meta` [F]; Vercel AI SDK 7 và MS AF phát OTel GenAI sẵn [F].

**4.4 Cost/latency budget, routing, caching**: đo `usage` mỗi response; `total_cost_usd` trong `claude -p --output-format json`; Usage & Cost Admin API; task budgets; `--max-budget-usd`; chọn effort trước khi đổi model (Anthropic: effort thấp trên model mới thường ≥ model cũ effort cao, và 1 model = 1 namespace cache); routing/fallback: `fallbacks:"default"`, Models API `line`; cache: prompt caching + MCP `CacheableResult`/tool list deterministic.

---

## 5. BẢO MẬT & AN TOÀN AI

**5.1 OWASP** [F genai.owasp.org]
- **Top 10 for LLM Applications 2025** (công bố 2024-11-17): LLM01 Prompt Injection · 02 Sensitive Information Disclosure · 03 Supply Chain · 04 Data & Model Poisoning · 05 Improper Output Handling · 06 Excessive Agency · 07 System Prompt Leakage · 08 Vector & Embedding Weaknesses · 09 Misinformation · 10 Unbounded Consumption. Chưa có bản 2026. **Đính chính 2026-10-14:** ấn bản **2026** đã công bố 04/08/2026 (README repo chính chủ <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10>): LLM01 Prompt Injection · 02 Sensitive Information Disclosure · 03 Excessive Agency · 04 Supply Chain · 05 Data and Model Poisoning · 06 Unbounded Consumption · 07 Misinformation · 08 Hidden Context Exposure · 09 Vector and Embedding Weaknesses · 10 Improper Output Handling.
- **Top 10 for Agentic Applications 2026** (công bố **2025-12-09**, OWASP GenAI Agentic Security Initiative) [F ngày; danh mục [S] nhiều nguồn nhất quán]: **ASI01 Agent Goal Hijack · ASI02 Tool Misuse & Exploitation · ASI03 Identity & Privilege Abuse · ASI04 Agentic Supply Chain · ASI05 Unexpected Code Execution · ASI06 Memory & Context Poisoning · ASI07 Insecure Inter-Agent Communication · ASI08 Cascading Failures · ASI09 Human-Agent Trust Exploitation · ASI10 Rogue Agents**.
- **Agentic AI Threats & Mitigations** v1.0 (2025-02-17) [F]; v1.1 phát hành cùng Top 10 Agentic (12/2025) [S].
- **OWASP AI Testing Guide v1** (2025-11-26) [S owasp.github.io/www-project-ai-testing-guide].

**5.2 Prompt injection — lớp phòng thủ (checklist tổng hợp)**
- Anthropic (2025-11-24, Opus 4.5 + Claude for Chrome: ASR ~1% trước Best-of-N 100 lần) [F]: RL chống injection trong huấn luyện; **classifier quét mọi nội dung untrusted vào context** (hidden text, ảnh, UI lừa); red team liên tục; "không browser agent nào miễn nhiễm". Claude for Chrome (08/2025): site-level permission, confirm trước hành động rủi ro cao [S]. Auto mode: classifier **bỏ qua tool output** để không bị nội dung thù địch lái; **check subagent handoff hai chiều** [F].
- Google DeepMind (paper 05/2025) & Chrome (12/2025) [S]: không có đơn giải pháp; model-level + system-level (CaMeL-style) + user-level; **User Alignment Critic** (model thứ hai không nhìn web content), classifier chạy song song, markdown sanitization, xác nhận hành động rủi ro.
- Microsoft (MSRC 07/2025; Learn "Defend against indirect prompt injection") [S]: **phòng ngừa** (hardened system prompt, **spotlighting**: delimiting/datamarking/encoding) → **phát hiện** (Prompt Shields classifier) → **giảm tác động** (data governance, consent, chặn kênh exfiltration như markdown image, plan-drift detection, critic agent).
- ☐ Quy tắc cho AI: coi **mọi tool output/web/email/file là dữ liệu, không phải lệnh**; tách kênh operator (`role:system` mid-conversation) khỏi dữ liệu; least privilege theo tác vụ; xác nhận người trước hành động không hoàn tác/tiền/chia sẻ dữ liệu; chặn exfiltration (allowlist domain, sandbox network); log & giám sát; không chỉ dựa vào mô hình.

**5.3 Tool permission / sandbox / least privilege**: Claude Code sandbox + permission modes + hooks (mục 1.1); Managed Agents vault (secret thay tại egress, không vào sandbox) + `limited` networking `allowed_hosts`; Skills API không mạng; MCP: scope tối thiểu, no token passthrough; computer use: VM riêng, allowlist domain; GitHub Action: quyền tối thiểu, human-actor check, WIF thay secret.

**5.4 MCP security (tool poisoning, rug pull)** [K + spec]: tool poisoning = chỉ dẫn độc trong description/annotation; rug pull = server đổi description/tool sau khi được duyệt. Spec: description/annotation **untrusted**; host phải lấy consent; 2026-07-28 yêu cầu tool list deterministic + `ttlMs` → client nên **pin & diff** tool list, cảnh báo khi đổi, cách ly server theo quyền, chạy local server trong sandbox.

**5.5 Khung quản trị**
- **NIST AI RMF 1.0** (01/2023) + **AI 600-1 Generative AI Profile** (07/2024) — không có revision 2026 [S]; **NIST AI Agent Standards Initiative** (2026-02-17) [F nist.gov]: 3 trụ cột (chuẩn do ngành dẫn dắt; giao thức mã nguồn mở; nghiên cứu bảo mật & **danh tính agent**); CAISI RFI về AI agent security (hạn 2026-03-09); ITL **AI Agent Identity & Authorization Concept Paper** (hạn góp ý 2026-04-02); overlay SP 800-53 cho AI (COSAiS) đang soạn [S].
- **ISO/IEC 42001:2023** (AI management system) — được chấp nhận thành EN ISO/IEC 42001:2026 ở châu Âu (03–07/2026) nhưng **không phải harmonised standard** của AI Act; chưa có amendment agentic [S]; ISO/IEC FDIS 27090 (cybersecurity for AI) đang FDIS 03/2026 [S].
- **EU AI Act** [F artificialintelligenceact.eu + Orrick 2026-07-29]: 2025-02-02 cấm & AI literacy; **2025-08-02 nghĩa vụ GPAI** (Ch. V), governance, penalties; **2026-08-02**: phần còn lại gồm **Art. 50 minh bạch** (chatbot phải tiết lộ AI, deepfake/synthetic content đánh dấu); **Digital Omnibus (Reg. (EU) 2026/1744, hiệu lực cuối 07/2026)**: high-risk **Annex III → 2027-12-02**, **Annex I → 2028-08-02**, cơ quan công quyền → 2030-08-02; Art. 50(2) cho hệ thống đã lên thị trường trước 2026-08-02: **ân hạn đến 2026-12-02**; cấm mới (nudifier/NCII/CSAM) từ 2026-12-02; GPAI model lên thị trường trước 2025-08-02 phải tuân thủ trước **2027-08-02**; thêm "small mid-cap", AI Office tập trung giám sát hệ thống dựa trên GPAI.

**5.6 Guardrails & moderation**: **Llama Guard 4** (12B, multimodal, 04/2025) vẫn là bản hiện hành [S]; **NeMo Guardrails 0.24.1** (2026-09-16) [F PyPI]; Anthropic: classifier nội bộ (`stop_reason:"refusal"`), Skill content scanning (Enterprise), auto-mode classifier. ☐ Quy tắc: input rail + output rail + tool-call rail; PII: không ghi content trace mặc định (OTel opt-in), redact trước khi lưu, ZDR không áp dụng cho Managed Agents/Skills; red team định kỳ (Anthropic Best-of-N, OWASP AI Testing Guide).

---

## 6. VẬN HÀNH AGENT (checklist)
- ☐ **Rate limits** [F]: RPM/ITPM/OTPM theo model & tier (Start/Build/Scale/Custom; spend cap $500/$1k/$200k); **cache read không tính ITPM** → caching tăng throughput; headers `anthropic-ratelimit-{requests,input-tokens,output-tokens}-{limit,remaining,reset}`, `retry-after`; 429 spend-cap có `error_code: enforced_spend_limit_reached` **không retry**; acceleration limits → tăng traffic từ từ; `max_tokens` không ảnh hưởng OTPM.
- ☐ **Retries/backoff**: SDK retry 408/409/429/5xx + connection (mặc định 2 lần); tôn trọng `retry-after`; 529 overloaded → backoff dài (Claude Code `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS`); bắt lỗi theo chuỗi cụ thể → tổng quát (NotFound → RateLimit → APIStatus → APIConnection); không retry refusal/400.
- ☐ **Idempotent tools**: thiết kế tool có idempotency key; MCP stateless → request bị đứt phải re-issue bằng request id mới; batch key theo `custom_id`.
- ☐ **Streaming**: SSE; `stream()` + `get_final_message()`; eager tool-input streaming; AG-UI/Vercel `useChat`; stream-json trong CLI.
- ☐ **Cost tracking**: `usage` (input/cache_creation/cache_read/output), `total_cost_usd` CLI, Usage & Cost Admin API, Langfuse/Braintrust; ngân sách theo **cost per completed task**.
- ☐ **Human approval gates**: `ask` rules + `canUseTool` + `PreToolUse`; Managed Agents `always_ask`; Vercel HMAC approvals; dừng sau nhiều lần bị deny (auto mode lesson).
- ☐ **Audit log**: hooks ghi mọi tool call (PostToolUse/PostToolBatch), OTel trace, Skills API audit logging, MCP log elevation events với correlation id; giữ transcript; không ghi content nhạy cảm.
- ☐ **Kill switch**: `interrupt()`/SIGINT, `--max-turns`, `--max-budget-usd`, task budget, Managed Agents session budget & interrupt, spend limit workspace, `disableAutoMode` managed; `continue:false` từ hook.
- ☐ **Versioning prompts**: prompt/tool list là code (12-factor #2), ADR cho đổi model/effort; model ID pinned; eval regression trước khi phát hành; cache prefix thay đổi = release.
- ☐ **A/B & rollout**: rainbow deployment (chuyển traffic dần, không ngắt agent đang chạy — Anthropic); eval gate trong CI; monitoring sau launch; Anthropic postmortem 2026-04-23 cho thấy đổi mặc định effort/caching bug gây suy giảm chất lượng → **theo dõi quality metrics khi đổi harness**.
- ☐ **Fallback models**: `fallbacks:"default"` server-side (Claude API/AWS); client-side middleware trên Bedrock/Vertex/Foundry; lưu ý thinking block không chuyển giữa model, cache theo model.
- ☐ **Secrets cho tools**: Managed Agents Vaults; env vars; WIF/OIDC (GitHub Action, SDK); sandbox `credentials` masking; không commit `.env`; MCP token audience-bound, scope tối thiểu.

---

## 7. UX CHO AI
- **Streaming UI**: SSE/stream-json; AG-UI events (text, tool, state diff, HITL pause) [F]; Vercel `useChat`/TUI; thinking `display:"summarized"|"updates"` để tránh "pause dài" [F].
- **Generative UI**: **MCP Apps** extension (UI inline trong hội thoại) [F]; AG-UI generative UI; CopilotKit; A2UI [S].
- **Confidence/citation**: Claude **Citations API** (`citations:{enabled:true}` → `cited_text`, `page_location`) [F]; Shape of AI patterns *Citations, Verification, Caveat, Disclosure*; HAX G2 "make clear how well the system can do" [K].
- **Undo/rollback**: Agent SDK **file checkpointing** + session fork; LangGraph time-travel; git worktree isolation; Shape of AI *Branches, Draft mode, Variations*.
- **Pattern libraries**:
  - **Shape of AI** (Emily Campbell, CC-BY-NC-SA) [F shapeof.ai]: 6 nhóm — *Wayfinders* (example gallery, follow up, nudges, suggestions, templates…), *Inputs/Prompt actions* (auto-fill, chained action, inline action, regenerate, restyle…), *Tuners* (attachments, connectors, filters, model management, modes, parameters, prompt enhancer…), *Governors* (**action plan, branches, citations, controls, cost estimates, draft mode, memory, references, sample response, stream of thought, variations, verification**), *Trust builders* (caveat, consent, data ownership, disclosure, footprints, incognito, watermark), *Identifiers* (avatar, name, personality…).
  - **Microsoft HAX Toolkit** [F microsoft.com/en-us/haxtoolkit]: Guidelines (18), Design Library, Patterns, Workbook, Playbook (NLP); 4 pha: *initial, during interaction, when wrong, over time*. 18 guideline (Amershi et al. 2019) [K]: G1 làm rõ hệ thống làm được gì; G2 làm rõ làm tốt đến đâu; G3 đúng thời điểm; G4 thông tin đúng ngữ cảnh; G5 hợp chuẩn mực xã hội; G6 giảm thiên kiến; G7 gọi dễ; G8 bỏ qua dễ; G9 sửa dễ; G10 thu hẹp phạm vi khi không chắc; G11 giải thích vì sao; G12 nhớ tương tác gần; G13 học từ hành vi; G14 cập nhật thận trọng; G15 khuyến khích feedback chi tiết; G16 nêu hệ quả hành động; G17 điều khiển toàn cục; G18 thông báo khi thay đổi.
  - **Google PAIR People + AI Guidebook** (2nd ed.) [S; trang JS-render không đọc được]: 6 chương (User needs + success, Data + evaluation, Mental models, Explainability + trust, Feedback + control, Errors + graceful failure) + ~23 design patterns [K].
- ☐ Quy tắc UX cho agent: hiển thị **kế hoạch & bước đang làm** (minh bạch — Anthropic), trạng thái tool call, **confirm trước hành động hệ quả**, cho phép dừng/undo, hiện citation & caveat, báo giới hạn/độ tin cậy, có trạng thái loading/empty/error/partial, giữ consent & data ownership rõ ràng.

---

## BẢNG TỔNG HỢP: Công nghệ/chuẩn → phiên bản → ngày xác minh (2026-10-13) → URL
| Công nghệ / chuẩn | Phiên bản / trạng thái | Mức xác minh | URL |
|---|---|---|---|
| Claude Agent SDK (Python) | 0.2.165 (2026-10-08) | F | pypi.org/project/claude-agent-sdk |
| Claude Agent SDK (TS) | 0.3.296 (ngày chưa thấy) | F (CHANGELOG) | github.com/anthropics/claude-agent-sdk-typescript |
| Claude Code CLI | 2.1.296 (2026-10-09) | F | code.claude.com/docs/en/changelog |
| Claude models | Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5 (1M ctx, 128K out) | F | platform.claude.com/docs/en/about-claude/models/overview |
| Prompt caching | GA; min 512 tok trên 5.x | F | platform.claude.com/docs/en/build-with-claude/prompt-caching |
| Structured outputs | GA (`output_config.format`, `strict`) | F | platform.claude.com/docs/en/build-with-claude/structured-outputs |
| Compaction | beta `compact-2026-09-04` (on-demand) / `compact-2026-01-12` (threshold) | F | platform.claude.com/docs/en/build-with-claude/compaction |
| Computer use | `computer_toolset_20260801` GA (API/GCP) | F | platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool |
| Managed Agents | beta `managed-agents-2026-04-01` | F | platform.claude.com/docs/en/managed-agents/overview |
| Agent Skills / Skills API | GA (không beta) | F | platform.claude.com/docs/en/agents-and-tools/agent-skills/overview |
| Claude Code GitHub Action | `anthropics/claude-code-action@v1` | F | code.claude.com/docs/en/github-actions |
| Anthropic Usage Policy | cập nhật 2026-10-08, hiệu lực 2026-11-12 | F | anthropic.com/news/2026-usage-policy-update |
| Claude constitution | 2026-01-22 | S | anthropic.com/news/claude-new-constitution |
| MCP spec | **2026-07-28** (prev 2025-11-25) | F | modelcontextprotocol.io/specification/2026-07-28 |
| MCP Registry | preview, API v0.1 freeze (2025-10-24), chưa GA | F | github.com/modelcontextprotocol/registry |
| Agentic AI Foundation | thành lập 2025-12-09 | S | aaif.io |
| A2A | v1.0.1 (2026-05-26); v1.0.0 (2026-03-12) | F | a2a-protocol.org/latest/specification · github.com/a2aproject/A2A/releases |
| AG-UI | release/2026-10-12; "1.0" chưa xác minh | F/S | docs.ag-ui.com · github.com/ag-ui-protocol/ag-ui |
| OpenAI Agents SDK | openai-agents 0.23.1 (2026-10-02) | F | pypi.org/project/openai-agents |
| Vercel AI SDK | AI SDK 7 GA 2026-06-25; ai@7.0.138 | F | vercel.com/blog/ai-sdk-7 · github.com/vercel/ai/releases |
| LangGraph | 1.2.15 (2026-10-12); 1.0 từ 2025-10-22 | F/S | pypi.org/project/langgraph |
| CrewAI | 1.15.26 (2026-10-08) | S | pypi.org/project/crewai |
| Google ADK | 2.0 GA (Py 2026-05-19, Go 06-30, TS 08-21); adk-python 2.11.0 | F/S | adk.dev/2.0 · github.com/google/adk-python/releases |
| Microsoft Agent Framework | 1.0 GA 2026-04-03; agent-framework 1.21.0 (2026-10-08) | S/F | github.com/microsoft/agent-framework · pypi.org/project/agent-framework |
| 12-Factor Agents | 12 factor + phụ lục 13 (không đánh số phiên bản) | F | github.com/humanlayer/12-factor-agents |
| OTel GenAI semconv | repo mới, trạng thái Development | F/S | github.com/open-telemetry/semantic-conventions-genai |
| Promptfoo | 0.124.1 (2026-10-08) | F | github.com/promptfoo/promptfoo/releases |
| Braintrust SDK | 0.45.0 (2026-10-07) | F | pypi.org/project/braintrust |
| LangSmith SDK | 0.14.8 (2026-10-13) | F | pypi.org/project/langsmith |
| Inspect AI | 0.3.279 (2026-10-13) | F | pypi.org/project/inspect-ai |
| DeepEval | 4.2.8 (2026-10-02) | F | pypi.org/project/deepeval |
| Ragas | 0.4.3 (2026-01-13) | F | pypi.org/project/ragas |
| Langfuse SDK | 4.17.0 (2026-10-05) | F | pypi.org/project/langfuse |
| OpenLLMetry (traceloop-sdk) | 0.62.4 (2026-09-29) | F | pypi.org/project/traceloop-sdk |
| OWASP Top 10 LLM Apps | 2025 (2024-11-17) | F | genai.owasp.org/llm-top-10 |
| OWASP Top 10 Agentic Apps | 2026 (2025-12-09) | F | genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026 |
| OWASP Agentic Threats & Mitigations | v1.0 (2025-02-17); v1.1 (12/2025) | F/S | genai.owasp.org/resource/agentic-ai-threats-and-mitigations |
| OWASP AI Testing Guide | v1 (2025-11-26) | S | owasp.github.io/www-project-ai-testing-guide |
| NIST AI RMF 1.0 / AI 600-1 | 01/2023 / 07/2024 (không revision 2026) | S | nist.gov |
| NIST AI Agent Standards Initiative | 2026-02-17 | F | nist.gov/node/1906621 |
| ISO/IEC 42001 | 2023 (EN 2026 adoption) | S | iso.org |
| EU AI Act + Digital Omnibus | Reg. (EU) 2026/1744; Annex III 2027-12-02; Annex I 2028-08-02 | F (2 nguồn thứ cấp uy tín) | artificialintelligenceact.eu/implementation-timeline |
| Llama Guard | 4 (04/2025) | S | huggingface.co/meta-llama/Llama-Guard-4-12B |
| NeMo Guardrails | 0.24.1 (2026-09-16) | F | pypi.org/project/nemoguardrails |
| Shape of AI | 6 nhóm pattern (© 2025) | F | shapeof.ai |
| Microsoft HAX Toolkit | 18 guidelines, 4 pha | F (tên guideline: K) | microsoft.com/en-us/haxtoolkit |
| Google PAIR Guidebook | 2nd edition | S/K | pair.withgoogle.com/guidebook |

**Mục chưa xác minh được / cần kiểm lại sau:** ngày phát hành TS Agent SDK 0.3.296 (npm 403); AG-UI "1.0"; A2A gia nhập AAIF (chỉ thấy banner); Promptfoo–OpenAI; tên chính thức 18 HAX guidelines & danh sách pattern PAIR (trang JS-render); danh mục ASI01–10 lấy từ nhiều nguồn thứ cấp nhất quán (PDF gốc không đọc được qua fetch); OTel GenAI attribute hiện hành (repo không có release tag).
