---
title: Harness đa nhà cung cấp — hook, sandbox, file hướng dẫn của 7 agent CLI (nghiên cứu 2026-11-02)
kind: research
updated: 2026-11-03
---

# Harness đa nhà cung cấp: đối chiếu hook · sandbox · file hướng dẫn của 7 agent CLI — nghiên cứu 2026-11-02

> Đầu vào: câu hỏi của chủ dự án (2026-11-02, sau audit toàn bộ `docs/ops/AUDIT-REPORT-2026-11-02-full.md`): "harness áp
> dụng cho cả các nhà cung cấp khác được không — OpenAI, Grok… harness toàn diện cho mọi model AI?". Phương pháp: 9 mục,
> mỗi mục một `researcher` đọc nguồn sống (docs chính chủ, registry, `git ls-remote`), rồi một `researcher` đối chiếu chéo và
> kiểm lại điểm quan trọng cho thiết kế (ADR-0049, khuôn `/research` bước 3). Mọi dữ kiện ghi ngày **2026-11-02**. Điều
> không mở được nguồn ghi **(chưa xác minh)** — §6. Không đề xuất ở đây; đề xuất ở ADR-0064
> (`docs/adr/0064-multi-provider-harness.md` của repo khung;
> <https://github.com/seeker19110/X-Templates/blob/main/docs/adr/0064-multi-provider-harness.md>).

## 1. Kết luận dữ kiện

1. **Sáu trong bảy công cụ có hook chặn tool call trước khi chạy** với hợp đồng gần giống nhau (JSON qua stdin, exit 2 =
   chặn, hoặc JSON `permissionDecision`/`decision: deny`): Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot CLI, Grok
   Build. OpenCode khác hẳn: plugin JS/TS, chặn bằng `throw` trong `tool.execute.before`.
2. **Ngữ nghĩa lỗi hook không đồng nhất**: exit code ≠ 0/2 → Claude không chặn; Gemini cảnh báo rồi chạy; Cursor fail-open
   trừ `failClosed`; Grok fail-open; **Copilot riêng `preToolUse` là fail-closed**. Timeout: Claude không chặn trừ
   `onFailure: block`; Copilot/Grok fail-open. Codex nhận `ask` nhưng **không hỗ trợ** (hook coi là failed, tool chạy tiếp).
   → Lõi chính sách không được dựa vào exit code; phải in JSON deny tường minh cho lớp nguy hiểm.
3. **Hook "kết thúc lượt" chỉ có ở 4/7**: Claude `Stop` (chặn, trần 8 lần), Codex `Stop` (`decision: block` → prompt tiếp),
   Copilot `agentStop` (trần 8), Cursor `stop` (`followup_message`, `loop_limit` 5). Gemini chỉ có `AfterAgent` ép retry;
   Grok có `Stop` nhưng **không chặn**; OpenCode chỉ `session.idle`.
4. **Nhiều công cụ nạp thẳng `.claude/settings.json`**: Cursor (mặc định bật, ánh xạ PreToolUse→preToolUse, Stop→stop,
   không hỗ trợ Notification/PermissionRequest), Grok Build (đọc `.claude/settings.json` và `.cursor/hooks.json`), Copilot
   (mục 5 ghi; trang hooks-configuration lượt kiểm lại không liệt kê — **chưa xác minh lại**). Hệ quả: cùng một file hook
   có thể được nhiều công cụ chạy với ánh xạ trường khác nhau (Grok dùng khoá camelCase `toolName`/`toolInput`).
5. **Sandbox OS**: chỉ **Codex bật mặc định** (thư mục Git: workspace-write + mạng tắt). Claude Code, Gemini, Copilot, Grok
   tắt mặc định; Cursor theo chế độ chạy; **OpenCode không có sandbox OS chính chủ**. Allowlist tên miền chỉ có ở
   sandbox-runtime của Claude Code (`allowedDomains`) và Cursor (`sandbox.json`); Codex chặn mạng hoàn toàn; Grok chặn mạng
   tiến trình con chỉ trên Linux. Mọi công cụ: sandbox chỉ bọc lệnh shell, **không bọc file tool/MCP/hook** (Claude Code nói
   rõ; Copilot "tool file built-in chạy in-process").
6. **`AGENTS.md` là mẫu số chung**: Codex, Cursor, Copilot, Grok Build, OpenCode đọc native (OpenCode: AGENTS.md trước,
   CLAUDE.md fallback). Claude Code đọc AGENTS.md native từ v2.1.277 **nhưng chỉ khi không có CLAUDE.md** — cầu nối
   `@AGENTS.md` (import sâu ≤ 4 bước) vẫn cần. Gemini CLI mặc định `GEMINI.md`, đọc AGENTS.md khi thêm vào
   `context.fileName`. Spec agents.md (Agentic AI Foundation, Linux Foundation) không có import/include, không phiên bản.
7. **Headless có ở cả 7**: `claude -p`, `codex exec`, `gemini -p`, `agent -p --force`, `copilot -p`, `grok -p`,
   `opencode run`. Shell tool có tôn trọng `SHELL`/`PATH` để bọc lệnh hay không: **chưa xác minh ở mọi công cụ** (Gemini
   docs: `bash -c`; grok-cli cộng đồng `spawn("sh", ["-c"])`).
8. **Giấy phép**: Codex, Gemini CLI, Grok Build, sandbox-runtime Apache-2.0; OpenCode MIT; **Claude Code, Cursor, Copilot CLI
   proprietary** (Copilot license tuỳ chỉnh đổi 3 lần trong 2026-01). Tên lệnh `grok` trùng giữa chính chủ
   (`@xai-official/grok`) và cộng đồng (`grok-dev`).

## 2. Ma trận (đã đối chiếu chéo; ô "—" = không có; "?" = chưa xác minh)

| Công cụ | Bản (2026-11-02) · giấy phép | File hướng dẫn | Hook chặn trước tool | Hook kết thúc lượt | Sandbox OS (mặc định) | Egress | Headless |
|---|---|---|---|---|---|---|---|
| Claude Code | 2.1.316 (npm) · proprietary | CLAUDE.md (+`@AGENTS.md`), `.claude/rules/`; AGENTS.md native v2.1.277+ chỉ khi không có CLAUDE.md | `PreToolUse`: exit 2 hoặc `permissionDecision allow\|deny\|ask\|defer`; exit khác không chặn; timeout không chặn trừ `onFailure: block` (v2.1.295+) | `Stop` chặn (exit 2/`decision: block`), trần 8 | Seatbelt · bubblewrap (Linux/WSL2); **tắt**; chỉ bọc Bash | `allowedDomains` (rỗng mặc định) | `-p`, hook/skill vẫn nạp khi không `--bare` |
| Codex CLI | 0.166.0 · Apache-2.0 | AGENTS.md (override > AGENTS.md > fallback; nối root→cwd; 32 KiB) | `PreToolUse`: exit 2 hoặc `permissionDecision: deny`; `ask` không hỗ trợ; không phủ hosted tool | `Stop` `decision: block` → prompt tiếp | Seatbelt · bwrap+seccomp · Windows MXC; **bật** (Git: workspace-write) | mạng **tắt** mặc định | `codex exec` (read-only mặc định, `--json`) |
| Gemini CLI | 0.66.0 · Apache-2.0 (README: chuyển Antigravity CLI 2026-06-18) | GEMINI.md, `@file.md`; AGENTS.md qua `context.fileName` | `BeforeTool`: exit 2 hoặc `decision: deny`; exit khác cảnh báo rồi chạy | — (`AfterAgent` ép retry) | Seatbelt · Docker/Podman · runsc · LXC; **tắt** | không thấy allowlist domain | non-TTY hoặc `-p`; `-o json\|stream-json` |
| Cursor (Agent CLI/IDE) | CLI 2026.10.22 · proprietary | AGENTS.md (lồng), CLAUDE.md, `.cursor/rules/*.mdc` | `beforeShellExecution` `permission allow\|deny\|ask`; `preToolUse` allow\|deny; exit 2 deny; fail-open trừ `failClosed`; nạp hook từ `.claude/settings*.json` | `stop` → `followup_message` (loop 5) | Seatbelt · Landlock+seccomp (kernel ≥ 6.2); theo chế độ chạy | chặn mặc định; `sandbox.json` + Defaults | `agent -p` (ghi file cần `--force`); hook trong CLI **?** |
| Copilot CLI | 1.0.105 · license tuỳ chỉnh, không OSI | `.github/copilot-instructions.md`, `.github/instructions/**`, AGENTS.md, CLAUDE.md, GEMINI.md (gộp hết) | `preToolUse` `permissionDecision allow\|deny\|ask`; exit 2 deny; exit khác **deny** (fail-closed); timeout 30 s fail-open | `agentStop` `decision: block`, trần 8 | Seatbelt · bubblewrap ≥ 0.5 · Windows ProcessContainer; **tắt** (`/sandbox enable`) | kiểm soát host **?** | `copilot -p`; payload stdin **?** |
| Grok Build (xai-org) | 1.0.70 · Apache-2.0 | AGENTS.md, CLAUDE.md, `.grok/rules/`, `.claude/rules/`, `.cursor/rules/` | **chỉ** `PreToolUse` chặn: exit 2 hoặc `{decision: deny}`; fail-open; timeout 5 s; khoá camelCase; đọc `.claude/settings.json`, `.cursor/hooks.json` | `Stop` có nhưng **không chặn** | Landlock · Seatbelt; **tắt** | chặn mạng tiến trình con chỉ Linux | `grok -p`, `--output-format json` |
| OpenCode (anomalyco) | 1.19.5 · MIT | AGENTS.md rồi CLAUDE.md; `instructions[]` (glob/URL) | plugin JS/TS `tool.execute.before` chặn bằng `throw` (ngữ nghĩa không định nghĩa riêng) | — (`session.idle`) | **không có** chính chủ; `permission` allow/ask/deny | — | `opencode run --format json`, `opencode serve` |

Sandbox độc lập: `@anthropic-ai/sandbox-runtime` 0.0.81 (Apache-2.0, "Beta Research Preview"; Seatbelt/bubblewrap +
netns + proxy có allowlist domain, CLI `srt`), bubblewrap 0.13.1 (LGPL-2.1-or-later từ 0.12.0), Landlock ABI 1–12 (lọc FS +
cổng TCP/UDP, không lọc tên miền), `sandbox-exec` (Apple đánh dấu DEPRECATED).

## 3. Chi tiết theo công cụ (dữ kiện, nguồn, ngày)

### Claude Code
- 33 sự kiện hook (gồm SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse(+Failure), Stop,
  StopFailure, SubagentStart/Stop, PreCompact, PostCompact, SessionEnd); handler `command`/`http`/`mcp_tool`/`prompt`/`agent`.
  Stdin: `session_id`, `cwd`, `permission_mode`, `hook_event_name`, `transcript_path`, `tool_name`, `tool_input`,
  `tool_use_id`. Ưu tiên khi nhiều hook: deny > defer > ask > allow; rule `deny`/`ask` của permission vẫn áp.
  `PostToolUse` không chặn; `PermissionRequest` không tôn trọng exit 2.
- Sandbox tắt mặc định, fail-open khi thiếu phụ thuộc (`failIfUnavailable`); `.claude/settings*.json`, `.mcp.json`,
  `.git/hooks`, `.bashrc` cấm ghi; `dangerouslyDisableSandbox` (tắt bằng `allowUnsandboxedCommands: false`).
- Nguồn: code.claude.com/docs/en/hooks, /sandboxing, /memory, /headless (fetch trực tiếp 2026-11-02);
  registry.npmjs.org/@anthropic-ai/claude-code/latest → 2.1.316 (2026-11-02).

### OpenAI Codex CLI
- Hook: 12 sự kiện; cấu hình `~/.codex/hooks.json|config.toml`, `<repo>/.codex/hooks.json` (chỉ khi lớp `.codex` dự án được
  tin cậy); bật mặc định (`features.hooks = false` để tắt). Docs: "a useful guardrail, not a complete enforcement boundary".
- Sandbox: `approval_policy` on-request/never/granular; `sandbox_mode` read-only/workspace-write/danger-full-access;
  `.git/.agents/.codex/.aws` chỉ đọc trong workspace-write; `[features.network_proxy]` tắt mặc định.
- Nguồn: learn.chatgpt.com/docs/hooks, /agent-approvals-security, /agent-configuration/agents-md, /non-interactive-mode
  (redirect từ developers.openai.com/codex, 2026-11-02); registry npm `@openai/codex` 0.166.0; `git ls-remote` tag
  `rust-v0.166.0` = `6ff1e1ca…` (2026-11-02).

### Gemini CLI
- 11 sự kiện (`SessionStart`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`,
  `AfterTool`, `PreCompress`, `Notification`, `SessionEnd`); `hooksConfig.enabled` mặc định true; hook dự án có fingerprint,
  đổi → cảnh báo; env `GEMINI_PROJECT_DIR` và alias `CLAUDE_PROJECT_DIR`.
- Policy engine TOML (`~/.gemini/policies/`, `allow|deny|ask_user`, `ask_user` = deny khi non-interactive) tách khỏi hook.
- Nguồn: raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/{index,reference}.md, docs/cli/{gemini-md,
  sandbox,headless}.md, docs/reference/policy-engine.md (2026-11-02); npm `@google/gemini-cli` 0.66.0; SHA đọc
  `6814e00d6b148c3a1d57244d5d7040f7c541009d`.

### Cursor
- `.cursor/hooks.json` (`version: 1`); sự kiện: `sessionStart/End`, `preToolUse`, `postToolUse(+Failure)`,
  `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `afterFileEdit`,
  `beforeSubmitPrompt`, `preCompact`, `stop`, `workspaceOpen`…; khoá `matcher`, `timeout`, `failClosed`, `loop_limit`.
  Nạp hook Claude Code từ `.claude/settings*.json` khi bật "Include Third-Party Plugins, Skills, and Other Configs" (mặc
  định bật). Hook agent có chạy trong CLI/`-p` không: docs chỉ khẳng định `workspaceOpen`; forum (thứ cấp) báo vài hook
  không chạy ở CLI → **chưa xác minh**.
- Nguồn: cursor.com/docs/hooks, /docs/reference/third-party-hooks, /docs/context/rules, /docs/cli/{headless,using,
  reference/permissions}, /docs/agent/security/run-modes, cursor.com/install (đọc, không chạy) — 2026-11-02.

### GitHub Copilot CLI
- Hook: `.github/hooks/*.json`, `~/.copilot/hooks/`, `.github/copilot/settings(.local).json`, policy
  `/etc/github-copilot/policy.d/`; 14 sự kiện; `preToolUse` trả `permissionDecision` + `permissionDecisionReason` (bắt
  buộc khi deny) + `modifiedArgs`; `ask` dưới cloud agent = deny.
- Phê duyệt: `--allow-tool/--deny-tool` (deny thắng), `--allow-all`, `--assisted-approval` (LLM duyệt, non-interactive);
  `copilot --cloud` chạy môi trường cô lập GitHub.
- Nguồn: docs.github.com/en/copilot/reference/hooks-configuration, /how-tos/copilot-cli/customize-copilot/{use-hooks,
  add-custom-instructions}, /reference/copilot-cli-reference/cli-programmatic-reference (2026-11-02); npm `@github/copilot`
  1.0.105 (publish 2026-10-28T00:44Z); repo github/copilot-cli HEAD `e1928292498b` (chỉ README/LICENSE/install.sh).

### Grok Build (xAI) và grok-cli cộng đồng
- Chính chủ: repo xai-org/grok-build (Rust, Apache-2.0, "Synced from monorepo", không nhận đóng góp ngoài); 14 sự kiện
  hook, **chỉ `PreToolUse` chặn**; hook dự án cần `/hooks-trust` hoặc `--trust`. Quyền `ask`/`auto`/`always-approve`; sandbox
  profile `workspace|devbox|read-only|strict` + `.grok/sandbox.toml`; `requirements.toml` khoá chính sách; auto-update mặc
  định bật (`--no-auto-update` cho CI); `install.sh` dạng `curl | bash`, chưa kiểm checksum.
- Cộng đồng superagent-ai/grok-cli (MIT, "không liên kết với xAI", HEAD 2026-05-15): sandbox microVM chỉ macOS Apple Silicon;
  bash tool `spawn("sh", ["-c", …])`.
- Nguồn: docs.x.ai/build/{overview,features/hooks,features/sandbox,features/permissions,features/project-rules,cli/reference,
  cli/headless-scripting}, x.ai/news/grok-build-cli; npm `@xai-official/grok` 1.0.70 (2026-10-23), `grok-dev` 1.1.7;
  `git ls-remote` hai repo (2026-11-02).

### OpenCode
- Hai repo cùng tên: anomalyco/opencode (trước là sst/opencode; MIT; v1.19.5) và opencode-ai/opencode (**archived
  2025-09-18**, thành charmbracelet/crush). Plugin từ `.opencode/plugins/`, `~/.config/opencode/plugins/`, mảng `plugin`
  (npm, cài bằng Bun); sự kiện `tool.execute.before/after`, `session.idle`, `permission.asked/replied`, `file.edited`,
  `shell.env`. Permission `allow/ask/deny` theo tool + glob trong `opencode.json`; `--auto` duyệt mọi thứ không bị deny;
  `OPENCODE_DISABLE_CLAUDE_CODE=1` tắt tương thích Claude. `OPENCODE_PURE` không nạp plugin ngoài.
- Nguồn: opencode.ai/docs/{plugins,permissions,rules,cli,config,mcp-servers,agents} (2026-11-02); npm `opencode-ai` 1.19.5
  (có `postinstall`); tag `v1.19.5` = `810c0eba…`.

### Chuẩn AGENTS.md
- agents.md (MIT, 38 commit, không Releases), do Agentic AI Foundation (Linux Foundation) quản lý từ 2025-12-09; OpenAI phát
  hành 2025-08. Spec: Markdown thuần, gần-nhất thắng, prompt người dùng ghi đè; **không** import/include, không phiên bản.
  Danh sách công cụ đọc AGENTS.md trên site là tự công bố; đã tự đối chiếu docs chính thức cho Codex, Claude Code, Cursor,
  Copilot, Gemini CLI, Grok Build, OpenCode. Nguồn: agents.md, github.com/agentsmd/agents.md, linuxfoundation.org/press
  (2026-11-02).

### Sandbox độc lập
- sandbox-runtime (anthropics/sandbox-runtime, HEAD `98a4016d` 2026-10-25): Seatbelt (macOS), bubblewrap + netns + seccomp
  (Linux x64/arm64), Windows alpha; proxy HTTP + SOCKS5 với `allowedDomains`/`deniedDomains` (deny thắng), kiểm địa chỉ đã
  phân giải; cần `bwrap`, `socat`, `ripgrep`; `srt "<lệnh>"`. bubblewrap v0.13.1 (tag 2026-10-14). Landlock từ Linux 5.13,
  ABI4 (TCP theo cổng) = 6.7, ABI6 = 6.12. Nguồn: README/LICENSE/package.json qua `git show`, registry npm, docs.kernel.org,
  man7.org, keith.github.io (bản sao man Apple) — 2026-11-02.

## 4. Hệ quả dữ kiện cho thiết kế (không phải đề xuất)

- Hợp đồng "JSON stdin → exit 2 hoặc JSON deny" là mẫu số chung đủ rộng để **một lõi** phục vụ 6 công cụ qua adapter mỏng;
  khác biệt nằm ở tên sự kiện, tên trường (`tool_input` vs `toolInput`), trường quyết định (`permissionDecision` vs
  `decision` vs `permission`), và ngữ nghĩa lỗi (fail-open/closed).
- Guard hiện tại của khung (`.claude/hooks/guard.py bash|edit|mcp|permission`) đã nhận payload dạng Claude và đã có cửa trung
  lập `xt.py guard-check -- <lệnh>` (ADR-0054); `policy_action()` biến `ask` nguy hiểm thành `deny` — khớp với việc Codex và
  Cursor `preToolUse` không cưỡng chế `ask`.
- Vì ba công cụ nạp `.claude/settings.json` trực tiếp, mọi thay đổi hợp đồng của guard phải giữ tương thích đầu ra Claude và
  kiểm bằng payload giả **của từng công cụ** (khoá camelCase của Grok, `beforeShellExecution` của Cursor).
- Vòng "chạy đến khi xong" dựa vào Stop hook (ADR-0009) chỉ chuyển được sang Codex, Copilot, Cursor; Gemini, Grok, OpenCode cần
  vòng lặp **bên ngoài** agent (gọi headless từng lượt).
- Sandbox OS mặc định tắt ở 5/7 công cụ và không bọc file tool/MCP/hook ở mọi công cụ → `LOOP-HARNESS-022` (SHOULD) là lớp
  bắt buộc phải kiểm bằng máy nếu muốn autopilot không người trực ở công cụ khác Claude Code.

## 5. Bảng theo khuôn `/research`

| Thành phần | Chọn (chưa — chỉ dữ kiện) | Phiên bản | Nguồn + ngày xác minh | Thay thế | Lý do/điều kiện |
|---|---|---|---|---|---|
| Hợp đồng hook lõi | JSON stdin → JSON deny tường minh + exit 2 | — | 6 trang hooks chính chủ, 2026-11-02 | plugin JS (OpenCode) | exit code ≠ 0/2 không chặn ở 4/6 công cụ |
| File hướng dẫn chung | AGENTS.md + cầu nối | spec không phiên bản | agents.md, docs 7 công cụ, 2026-11-02 | file riêng từng công cụ | 5/7 đọc native, Claude cần `@AGENTS.md`, Gemini cần `context.fileName` |
| Sandbox tham chiếu | sandbox-runtime (`srt`) | 0.0.81 (2026-10-19) | registry npm, repo, 2026-11-02 | bubblewrap trần, Landlock, Codex sandbox | duy nhất có allowlist domain độc lập công cụ; "Beta Research Preview" |

## 6. Chưa xác minh (ghi để lần sau tra)

> Cập nhật 2026-11-02: bốn mục — `SHELL`/`PATH` của shell tool, mã thoát headless, hook Cursor trong CLI/`-p`, Copilot
> đọc `.claude/settings.json` và payload stdin — đã xác minh lại ở **§8** (phần còn mở ghi rõ ở đó). Các dòng dưới giữ
> nguyên để thấy lịch sử.

- Mọi công cụ: shell tool có tôn trọng `SHELL`/`PATH` để bọc lệnh; mã thoát của chế độ headless (trừ Gemini: 0/1/42/53);
  cờ `archived`/`pushed_at` qua API GitHub (403 trong phiên — không vượt rào); chưa chạy validator/test nào; hook có chạy
  trong sandbox hay ngoài (chỉ Claude Code nói rõ: ngoài).
- Claude Code: `onFailure` với `Stop`; matcher `SessionStart`; changelog chỉ đọc 100 000/1 150 200 ký tự.
- Codex: approval mặc định của `codex exec`; Landlock có là backend thật không (docs chỉ nêu bwrap + seccomp).
- Gemini CLI: `telemetry.enabled` mặc định; allowlist egress theo domain; ngày publish 0.66.0.
- Cursor: hook agent trong CLI/`-p`; fallback bubblewrap (docs lượt kiểm lại chỉ nêu "hỏi duyệt"); ngày phát hành IDE 3.27.
- Copilot CLI: payload hook qua stdin (docs không nêu tường minh); `.claude/settings.json` làm nguồn hook; exit code `-p`.
- Grok Build: `GROK.md`; telemetry; checksum trong `install.sh`; license tầng dưới `third_party/`; sự cố "upload thư mục"
  chỉ từ nguồn thứ cấp.
- OpenCode: ngữ nghĩa chặn ngoài ví dụ `throw`; chữ ký TypeScript; telemetry/share; đổi tên sst → anomalyco chỉ suy từ
  WebFetch.
- Landlock GPL-2.0 (theo trí nhớ); kernel của ABI 7–12; telemetry sandbox-runtime.
- Mốc "Copilot CLI GA 02/2026" và "Grok Build beta 05/2026" ở §7 (thêm 2026-11-03, AUD-DOC-191): không có nguồn ở §3 (chỉ có bản npm 1.0.105).

## 7. Rủi ro giấy phép/trạng thái

- Claude Code, Cursor, Copilot CLI **proprietary**: adapter cho ba công cụ này phụ thuộc docs, không đọc được mã; Copilot đổi
  license 3 lần trong 3 ngày (2026-01-20…22). Codex/Gemini/Grok Build/sandbox-runtime Apache-2.0, OpenCode MIT.
- Gemini CLI README ghi gói cá nhân chuyển sang Antigravity CLI (`agy`) từ 2026-06-18 — tên lệnh/đường dẫn cấu hình có thể đổi.
- Grok Build: auto-update bật mặc định, `install.sh` `curl | bash`; xung đột tên lệnh `grok` với gói cộng đồng.
- sandbox-runtime "Beta Research Preview": API/cấu hình có thể đổi; `sandbox-exec` đã DEPRECATED theo Apple.
- Tốc độ đổi API hook rất nhanh (Claude 33 sự kiện, Copilot GA 02/2026, Grok beta 05/2026 — hai mốc sau: (chưa xác minh) — không có nguồn ở §3, AUD-DOC-191): mọi adapter cần mốc xét lại —
  trùng mốc hàng rào 2027-01-21 (`LOOP-DESIGN-014`).

## 8. Bổ sung 2026-11-02 — xác minh lại bốn mục chưa xác minh (T-3647)

> 4 `researcher` + 1 đối chiếu chéo; nguồn chính chủ và mã nguồn mở đọc bằng `git grep`/`git show` hay bản raw ở SHA ghi
> dưới (không chạy mã). Mục còn chưa chắc giữ nhãn **(chưa xác minh)**; nguồn diễn đàn ghi **thứ cấp**.

**Shell tool và `SHELL`/`PATH` (wrapper trên PATH có chặn được lệnh không):**
- Claude Code: `CLAUDE_CODE_SHELL` nhận bash/zsh; tự dò dùng `$SHELL` nếu là bash/zsh, không thì zsh rồi bash trên `PATH`;
  `CLAUDE_CODE_SHELL_PREFIX` bọc lệnh Bash tool, hook, MCP stdio (docs ghi "logging or auditing", hook PowerShell và dạng
  exec không qua prefix) — code.claude.com/docs/en/env-vars.
- Codex CLI (SHA `05c08d7`, `codex-rs/shell-command/src/shell_detect.rs`): **không đọc `SHELL`**; lấy shell từ `passwd`
  (`getpwuid_r`) theo đường tuyệt đối, chỉ tra `PATH` khi không có → wrapper trên `PATH` thường **không** được gọi.
- Gemini CLI (SHA `6814e00`, `packages/core/src/utils/shell-utils.ts`): Unix gọi `bash -c` bằng tên trần (tra theo `PATH`
  của tiến trình con); `PATH` có còn sau `sanitizeEnvironment` không: (chưa xác minh).
- Copilot CLI (changelog thứ cấp): lệnh `!` dùng `$SHELL`; shell của tool nội bộ: (chưa xác minh). Cursor, Grok Build,
  OpenCode: cơ chế chọn shell (chưa xác minh; OpenCode có khoá `shell` trong `opencode.json`).
- **Hệ quả dữ kiện:** wrapper trên `PATH` không phải lớp chặn chung (Codex bỏ qua) — khớp quyết định ADR-0064 lát C.

**Hook của Cursor trong CLI và `-p`:** docs chính thức (cursor.com/docs/hooks, /docs/cli/*) **không** có bảng hook theo
CLI; chỉ `workspaceOpen` ghi chạy ở CLI. Diễn đàn (thứ cấp, nhân viên Cursor): CLI chạy hook mức tool (`postToolUse`,
`afterFileEdit`, `before/afterShellExecution`); ở `-p` **không phát** `beforeSubmitPrompt`, `afterAgentResponse`, `stop`
(21/8/2026, "known gap"); `preToolUse` trong CLI/`-p`: (chưa xác minh). → Cursor headless cần vòng lặp ngoài và sàn git hook.

**Copilot CLI:** payload hook là JSON, ví dụ chính thức đọc bằng `INPUT="$(cat)"` (stdin suy ra từ ví dụ, không có câu quy
định); **đọc cả `.claude/settings.json` và `.claude/settings.local.json` của repo** ("Cross-tool … are also read" —
hooks-configuration, hooks-reference); tên sự kiện PascalCase (`PreToolUse`) nhận payload kiểu Claude (`tool_name`,
`tool_input`); `preToolUse` exit 2 = deny kể cả JSON ghi allow; exit khác 0 = deny; timeout = fail-open. → hook Claude
của khung **đã chạy** dưới Copilot: adapter Copilot (T-3643) phải tránh chạy guard hai lần.

**Mã thoát headless:** `claude -p` 0/khác 0 (SIGTERM 143); `codex exec` 1 khi lỗi hay bị từ chối duyệt quyền (mã nguồn);
`gemini -p` 0 · 1 · 42 (đầu vào) · 53 (vượt lượt), thêm 41/44/52/54/55/130 chỉ thấy ở mã; `opencode run` đặt 1 khi lỗi,
bị từ chối quyền thì model tiếp tục (không đổi mã); Cursor `agent -p`, `copilot -p`, `grok -p`: docs không nêu (chưa xác
minh). → khớp ADR-0064 lát D: vòng ngoài tin `loop verify`, không tin mã thoát của agent.

Nguồn (2026-11-02): code.claude.com/docs/en/env-vars, /headless · github.com/openai/codex @`05c08d7` · raw
google-gemini/gemini-cli @`6814e00` (shell-utils.ts, shellExecutionService.ts, docs/cli/headless.md) · cursor.com/docs/hooks,
/docs/cli/overview, /docs/cli/headless, cursor.com/changelog/cli-jan-08-2026, forum.cursor.com (thứ cấp) ·
docs.github.com/en/copilot/reference/hooks-configuration, /hooks-reference, /tutorials/copilot-cli-hooks · raw
github/copilot-cli changelog.md (đọc 100 000/290 368 ký tự) · github.com/anomalyco/opencode @`ff90ed9`
(packages/cli/src/run/noninteractive.ts) · docs.x.ai/build/cli/headless-scripting.

## 9. Hợp đồng hook cho adapter (T-3642…3644, đọc 2026-11-02)

> 1 `researcher`; docs chính chủ dạng raw, mã/schema ở SHA ghi dưới, registry npm. Dùng cho `scripts/xt_adapter.py` và
> `framework/templates/harness/`. Mục chưa xác minh giữ nhãn.

| Host (bản npm, license) | File dự án · sự kiện · matcher | Tool (shell · sửa file · MCP) | Payload stdin | Chặn | Lỗi khác · hết giờ | Đọc `.claude/settings.json`? |
|---|---|---|---|---|---|---|
| Codex 0.166.0, Apache-2.0 | `.codex/hooks.json` · `PreToolUse` · regex | `Bash` · `apply_patch` (thân patch ở `tool_input.command`) · `mcp__<server>__<tool>` | `tool_name`, `tool_input`, `cwd`, `session_id` (schema `pre-tool-use.command.input`, `additionalProperties:false`) | JSON `hookSpecificOutput.permissionDecision: deny`; hoặc exit 2 + lý do stderr (exit 2 stderr rỗng = KHÔNG chặn) | cho chạy (fail-open); `ask` không hỗ trợ; hook dự án cần `/hooks` tin cậy theo hash | không nêu trong docs |
| Gemini CLI 0.66.0, Apache-2.0 | `.gemini/settings.json` `hooks` · `BeforeTool` · regex | `run_shell_command` · `write_file`, `replace` (`file_path`) · `mcp_<server>_<tool>` | `tool_name`, `tool_input`, `cwd`, `session_id`, `timestamp` | stdout `{"decision":"deny","reason"}` exit 0; hoặc exit 2 | exit khác: cảnh báo rồi chạy; hết giờ: (chưa xác minh); hook dự án có fingerprint | không thấy |
| Cursor (proprietary) | `.cursor/hooks.json` `version:1` · `preToolUse` · regex | `Shell` · `Write`, `Delete` · `MCP:<tool>` | `tool_name`, `tool_input`, `cwd`, `conversation_id`, `workspace_roots` | `{"permission":"deny","user_message","agent_message"}`; exit 2 | fail-open trừ `failClosed:true`; JSON hỏng = chặn | có — Third-Party Imports bật mặc định, không khử trùng |
| Copilot CLI 1.0.105, license riêng | `.github/hooks/*.json` `version:1` · `preToolUse` (camelCase) | `bash`/`powershell` · `create`/`edit` · (tên MCP: chưa xác minh) | `toolName`, `toolArgs`, `cwd`, `sessionId` | `{"permissionDecision":"deny","permissionDecisionReason"}`; exit 2 | exit khác 0 = chặn; hết giờ = cho qua; JSON hỏng = mặc định | có — chạy mọi nguồn, không khử trùng |
| Grok Build 1.0.70, Apache-2.0 | `.grok/hooks/*.json` · `PreToolUse` · regex (bí danh tên Claude) | `run_terminal_command` · `search_replace` (+ `write_file`: chưa xác minh bí danh) · `server__tool` | `toolName`, `toolInput`, `cwd`, `sessionId`, `workspaceRoot` | `{"decision":"deny","reason"}` (mọi mã thoát); exit 2 | mọi lỗi/hết giờ/JSON hỏng = cho qua; hook dự án cần `/hooks-trust` | có (khi đã tin cậy), khử trùng handler giống hệt |
| OpenCode 1.19.5, MIT | `.opencode/plugins/*.ts` · `tool.execute.before` · lọc trong mã | `bash` · `edit`/`write`/`apply_patch` (`filePath`, `patchText`) · `<server>_<tool>` | đối số hàm `(input:{tool,sessionID,callID}, output:{args})` | `throw new Error(…)` | không định nghĩa; hook có thể không chạy ở `opencode run` (issue #41422, thứ cấp) | không (chỉ CLAUDE.md, skills) |

Nguồn (2026-11-02): learn.chatgpt.com/docs/hooks.md · raw openai/codex @`3026a8e5` (`codex-rs/hooks/src/events/pre_tool_use.rs`,
`engine/command_runner.rs`, `hooks/schema/generated/pre-tool-use.command.{input,output}.schema.json`) · raw
google-gemini/gemini-cli `main` @`6814e00` (`docs/hooks/{index,reference,best-practices}.md`, `docs/reference/tools.md`) ·
cursor.com/docs/hooks.md, /docs/reference/third-party-hooks.md · docs.github.com/en/copilot/reference/hooks-reference,
/copilot-cli-reference/cli-config-dir-reference · docs.x.ai/build/features/hooks.md, raw xai-org/grok-build @`2bdd1d6a`
(`docs/user-guide/{05,10,22,26}-*.md`) · raw anomalyco/opencode @`ff90ed91` (`packages/web/src/content/docs/{plugins,
tools,mcp-servers,rules}.mdx`), `@opencode-ai/plugin@1.19.5` `dist/index.d.ts` · registry.npmjs.org (bản/ngày/license).
Chưa xác minh: payload PreToolUse nguyên văn của Codex/Gemini/Cursor (dựng từ schema/bảng trường); bản docs theo tag
phát hành (đọc `main`); tên MCP trong hook của Copilot; Cursor `preToolUse` ở `-p`.
