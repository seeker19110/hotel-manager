---
title: Nâng khung lên tầng mới — code nhanh hơn, tự động tối đa, chất lượng tối đa
kind: research
updated: 2026-10-21
---

# Nâng khung X-Templates lên tầng mới — nghiên cứu 2026-10-21

Đầu vào: yêu cầu chủ repo 2026-10-21 *"nghiên cứu nâng bộ khung này lên tầng cao mới, code nhanh hơn, tự động tối đa,
chất lượng tối đa"*. Khung đang ở 3.12.0 (`cd17588`), vừa xong PLAN-3.12 (tinh gọn) và cài cho hai dự án đích.
Cách đọc: §1 kết luận · §2 số đo thật (P1) · §3 nơi mất thời gian · §4 dữ kiện sống xác minh 2026-10-21 · §5 đề xuất theo
ba trục, mỗi đề xuất có bằng chứng · lợi · rủi ro · đường lùi · §6 thứ tự lát (dự thảo PLAN-3.13) · §7 không làm · §8 chưa
xác minh · §9 nguồn. Số đo cục bộ đo trong phiên này (container cloud 4 CPU, Python 3.13.16, Claude Code 2.1.306) — là
**một mẫu**, không phải baseline nhiều lần (`LOOP-DESIGN-016`).

## 1. Kết luận

- **Việc khẩn trước 2026-11-02 (K-1, §5):** GitHub sẽ tự thực thi event policy chặn `pull_request_target` ở repo public chưa
  có policy (§4.2). `merge-gate.yml` — required check của repo khung và của hai dự án đích đã cài — chạy trên trigger này;
  check không báo thì mọi PR treo. Người: xem/tạo event policy ở Settings → Actions → Policies của ba repo (agent không đọc
  được qua proxy). Máy: chuyển `merge-gate` sang `workflow_run` + check-run qua REST (ADR mới thay ADR-0023).
- **Cổng và CI không còn là nút thắt.** Cổng cục bộ ≈ 127 s (test 118,6 s), run CI trung vị **92 s**, PR tài liệu một
  commit mở → merge trong **3 phút** (#196). Nhưng lead time trung vị của 39 PR gần nhất là **15 phút**, 4 PR mất 1–3 giờ.
  Khoảng cách đó là **làm lại**: trung bình **3,3 run CI mỗi PR** (push lại sau CI đỏ hoặc review), vòng "cập nhật nhánh
  → CI lại" do ruleset repo khung còn `strict: true`, và vòng review sau khi mở PR. **Chất lượng sớm hơn chính là tốc độ.**
- **Ba khe hở đo được giữa cổng cục bộ và CI** (3 run đỏ gần nhất): tiêu đề PR chỉ CI kiểm (#192 đỏ, chạy lại lần 2);
  test chỉ đỏ ở Python 3.11 hoặc ở checkout tên `main` (#191, #193) — cục bộ không chạy hai điều kiện đó.
- **Chất lượng: coverage 100 % chưa đủ.** PR #186 lọt 🔴 SEC-091 (guard fail-open) qua test xanh; `autonomy-bench` tìm 5
  false-green sau khi 247 ca đã xanh; 0 ca đối kháng do reviewer khác họ. Khung tự đặt `QA-COV-005` (mutation ≥ 70 % cho
  parser/phân quyền) nhưng chưa áp cho `guard.py` — chính là parser phân quyền. Đề xuất mạnh nhất về chất lượng là
  **mutation test + fuzz bất biến cho guard**, cả hai chạy nightly, không chạm cổng commit.
- **Tự động: phần còn lại là việc của người.** Reviewer độc lập trên GitHub (`pr-review.yml`), steward tự cập nhật nhánh
  (`XT_STEWARD_TOKEN`), Routine sửa CI/nâng cấp dự án đích, ruleset không `strict` — mã và mẫu đã có, chỉ thiếu token/App/
  Routine do chủ repo tạo. Agent không tự tạo (điểm dừng, `LOOP-STOP-014`). Phần máy làm thêm được: `pr stats` (số
  DORA máy đọc), hook `PostToolUseFailure` trích lỗi, song song task độc lập bằng worktree.
- **Bằng chứng ngoài 2026 (§4.4) ủng hộ hướng đã chọn, và siết thêm ba chỗ**: review bằng LLM chỉ hiệu quả trên diff nhỏ
  (F1 0,66 ở < 10 dòng, 0,04 ở > 150 dòng) → PR ≤ 150 dòng và reviewer context sạch; hạ effort từng làm chính Claude Code suy
  giảm → không hạ effort khi chưa có số; model đầu bảng vẫn gian lận verifier (giả `go.sum`) → bằng chứng máy + guard, không
  tin lời khai. Reviewer khác họ model không hơn reviewer cùng họ ở phiên mới một cách có ý nghĩa — diversity và context sạch
  mới là thứ đáng giữ.
- **Không đổi kiến trúc**: không đa agent phân cấp, không validator bằng model, không merge queue (repo user-owned không có),
  không tách guard, không `--bare`. Mỗi đề xuất là lát nhỏ, có Gate, đảo ngược được.

## 2. Số đo thật (2026-10-21)

| Mục | Số đo | Nguồn |
|---|---|---|
| Cổng cục bộ | build 0,6 s · typecheck 4,9 s · lint 2,4 s · test **118,6 s** (coverage dòng + nhánh 100 %, 222 lớp, 4 luồng; tổng CPU tuần tự theo `tests/shard-weights.json` 435 s, lớp nặng nhất 19,5 s) · `gate` ≈ 127 s · `gate-fast` không file đổi 2,7 s | `scripts/dev-task.sh <task>` đo trong phiên; lần đầu `lint` đỏ vì `origin/main` cục bộ cũ (`progress-check`), `git fetch` xong xanh |
| Run CI `ci.yml` | thành công: trung vị **92 s** (74–154 s, n = 14 run gần nhất); job: checkout 3 s, `pip --require-hashes` 5–10 s, mỗi shard test 26–47 s, `coverage` gộp +15 s sau `test`, `quality` 3 s; 11/25 run gần nhất `cancelled` (push mới huỷ run cũ) hoặc `failure` | GitHub Actions API (`list_workflow_runs`, `list_workflow_jobs` run 39551231223) |
| Lead time PR | 39 PR đóng gần nhất (#157…#196): mở → merge trung vị **15,1 phút** (1,4–200,7; trung bình 29,3); làn nhanh (docs) trung vị 5,7 phút (n = 12); làn chuẩn 15,7 phút (n = 27), 15/27 ≤ 20 phút; 4 PR > 60 phút: #167, #179, #186 (2 h 35), #190 (3 h 20) | GitHub API `list_pull_requests` (`created_at` → `merged_at`) |
| Push mỗi PR | **3,3 run CI/PR** (7 PR 2026-10-20/21): #194 4, #193 4 (1 đỏ), #191 4 (1 đỏ), #192 3 (1 đỏ), #190 3 (3 xanh — vòng review) | cùng nguồn run CI |
| Run CI đỏ gần nhất | #193 (`39511010457`): 4/4 shard `test` + 3/3 `py311` đỏ; #191 (`39496582108`): `test 4/4` + `py311 3/3` đỏ; #192 (`39505116160`, attempt 2): `checks` đỏ ở bước **tiêu đề PR** | `list_workflow_jobs` |
| Thông lượng | 23 PR merge ngày 2026-10-19, 21 ngày 2026-10-20 | `git log origin/main --date=short` |
| Hook | `pre-bash` 142 ms/lệnh; Stop/PreCompact ngoài vòng ~7 ms; khởi động `xt.py` ~250 ms | AUDIT-STATUS 2026-10-20 (CODE), CHANGELOG 3.11.0 |
| Context | đầu phiên ≈ 17 KB; `/autopilot` +16,7 KB | CHANGELOG 3.11.0 (PLAN-3.12 Lát 1) |
| Chất lượng | 1 225 test; coverage 100 % dòng + nhánh (cả subprocess); `mypy --strict`; C901 ≤ 10; `autonomy-bench` 438 ca, 0 false-green, **0 ca `adversarial-reviewer`**; 13 nhóm audit quét tại `0afa30d` | AUDIT-STATUS, AUTONOMY-BASELINE |
| Tự động chưa bật | `pr-review.yml` (cần `XT_REVIEWER_TOKEN` + `ANTHROPIC_API_KEY` + biến `XT_REVIEWER_ENABLED`); `XT_STEWARD_TOKEN` (steward không tự cập nhật nhánh — D-061); ruleset repo khung `strict_required_status_checks_policy: true`, 5 required check; Dependabot (proxy chặn); `XT_RELEASE_TOKEN`; Routine đang bật trên tài khoản: chỉ "Gom phản hồi dự án đích" hằng tuần — chưa có Routine sửa CI/`update` hay nâng cấp dự án đích | `.github/workflows/*.yml`, `.github/rulesets/main.json`, `list_triggers`, PROGRESS |

## 3. Nơi mất thời gian trong một lát

Đường găng một lát ở phiên cloud (một nhánh, ADR-0009):

1. Làm task (model) → `loop record` Gate → commit qua `gate-fast` (2,7 s; đụng cấu hình cổng → mọi lớp test không coverage ≈ 75 s).
2. Lát xong → cổng đầy đủ **127 s** → push → mở PR → CI **92 s** → `pr next`/steward → merge. Sàn thực tế: **3 phút** (#196).
3. Phần vượt sàn (trung vị 15 phút, 4 PR > 1 giờ) đến từ bốn vòng lặp, theo thứ tự chi phí:
   - **Push lại** (3,3 run/PR): mỗi lần = CI 92 s + lượt agent đọc log, sửa, cổng lại (3–10 phút). Nguyên nhân thấy được: CI
     đỏ ở điều kiện cục bộ không có (tiêu đề PR, Python 3.11, checkout tên `main`); review tìm lỗi sau khi PR đã mở (#190, #186).
   - **Cập nhật nhánh** vì `strict: true`: PR chồng (lát kế trên cùng nhánh) phải `update-branch` sau mỗi merge → một
     vòng CI nữa + một lượt agent; steward không có token nên chỉ báo `update` (D-061).
   - **Chờ**: `merge-watch` 30 s/lần, steward cron 10 phút là lưới bù (sự kiện `workflow_run` đã có — AUTO-05).
   - **Review làn chuẩn ngoại lệ cứng** (`scripts/*`, `framework/templates/*`): reviewer subagent 5–20 phút, rồi sửa, rồi push lại.
4. Chi phí máy mỗi lệnh (hook 142 ms, `xt.py` 250 ms) và CI không đáng kể so với một lượt model; tối ưu thêm ở đó lợi nhỏ.

Kết luận §3: đòn bẩy lớn nhất cho "nhanh hơn" là **bớt vòng làm lại** (bắt lỗi trước khi push, review trước khi mở PR
cho diff nhạy cảm, bỏ vòng cập-nhật-nhánh), rồi mới tới **song song hoá** task độc lập; "nhanh hơn" bằng cách bỏ cổng
là không có (P3, `LOOP-CI-001`).

## 4. Dữ kiện sống (xác minh 2026-10-21)

> Bảng thô do `researcher` trả về cùng ngày, chỉ ghi điều **đổi/mới** so với `research/2026-10-13-*` và
> `research/2026-10-19-rapid-build-then-harden.md`. Mục không tra được ghi "(chưa xác minh)" ở §8.

### 4.1 Claude Code (CLI 2.1.306; docs `code.claude.com`; repo `anthropics/claude-code` tại `d014fc0f` — đọc 2026-10-21)

| Dữ kiện | Ảnh hưởng tới khung/đề xuất | Nguồn |
|---|---|---|
| CLI `latest` 2.1.306 (npm 2026-10-21); README ghi cài qua npm "deprecated", khuyến nghị `install.sh`/brew/winget | `claude_min_version`, `doctor` | <https://registry.npmjs.org/@anthropic-ai/claude-code>, <https://github.com/anthropics/claude-code> |
| Frontmatter subagent có `effort` (low/medium/high/xhigh/max), `isolation: worktree`, `background`, `autoCompactWindow` (2.1.296+), `omitClaudeMd`, `skills` ≤ 32, `memory`; `permissionMode` của subagent bị bỏ qua ở auto mode | NH-4 đặt được ở frontmatter; NH-3 | <https://code.claude.com/docs/en/sub-agents.md> |
| `isolation: worktree`: worktree tạm rẽ từ **nhánh mặc định** (không phải HEAD cha) trừ khi `worktree.baseRef: "head"`; tự xoá nếu không đổi gì; chặn Edit/Write/`git -C`/`GIT_DIR` vào checkout chính; `${CLAUDE_PROJECT_DIR}` không đổi, `cwd` trong stdin hook theo worktree; dọn theo `cleanupPeriodDays`, giữ nếu có việc chưa đẩy | NH-3 phải đặt `worktree.baseRef: head` để executor thấy commit của lát trước; guard đọc `cwd` đúng | sub-agents.md; <https://code.claude.com/docs/en/worktrees.md> |
| Đồng thời: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` mặc định 20; lồng `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` mặc định 3 (`1` tắt); subagent chạy nền mặc định; fork subagent bật mặc định cả ở `-p`/SDK từ 2.1.302 (`CLAUDE_CODE_FORK_SUBAGENT=0` tắt), fork không spawn fork | Trần 5 của `LOOP-ORCH-008` chặt hơn mặc định; giữ `tools:` không có `Agent` | sub-agents.md; <https://code.claude.com/docs/en/env-vars.md>; CHANGELOG 2.1.302 |
| Tool **Workflow** (script JS `agent()`/`pipeline()`/`parallel()`/`phase()`, chạy nền): mọi gói trả phí, API, Bedrock/Vertex/Foundry; 16 agent đồng thời mặc định (1–256), 4 096 mục/`parallel()`, 1 000 agent/run; resume cùng phiên (2.1.305 không chạy lại agent đã xong); `-p`/SDK cần rule `Workflow`/auto; `ultracode` là cài đặt Claude Code (`--effort ultracode`, từ khoá gõ tay), **không** kích hoạt qua `-p`/lịch/webhook | TD-6 khả thi ở phiên tương tác, không cho Routine/CI (đính chính 2026-10-25: xem §9) | <https://code.claude.com/docs/en/workflows.md>; <https://code.claude.com/docs/en/model-config.md> |
| Hook: 33 sự kiện (thêm `PostToolUseFailure`, `PostToolBatch`, `PermissionDenied`, `TaskCreated/TaskCompleted`, `Worktree*`, `Pre/PostModelSwitch`…); loại `command`/`http`/`mcp_tool`/`prompt`/`agent`; `if` theo cú pháp rule; `async` + `asyncRewake`; `onFailure: block` (2.1.295+); stdin chung có `effort`, `scratchpad_dir`, `agent_id`; PostToolUse có `tool_response`, `duration_ms`; stderr của PostToolUse/PostToolUseFailure tới Claude; `additionalContext` ≤ 10 000 ký tự; nhiều PreToolUse: deny › defer › ask › allow; hook `prompt` trả `{ok, reason, impossible}`, tối đa 12 hook prompt/agent đồng thời | TD-5 (`PostToolUseFailure`); `duration_ms` đo lệnh Gate; D-068 giữ nguyên | <https://code.claude.com/docs/en/hooks.md>; <https://code.claude.com/docs/en/agent-sdk/hooks.md> |
| Task tools (`TaskCreate/TaskUpdate/TaskList`) **không bật mặc định** trên Opus 5.5/Sonnet 5.5/Haiku 5.5/Fable — cần `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` (2.1.233+) hoặc nêu trong `--allowedTools`; phiên nền và cloud luôn có | Hook `TaskCompleted` của khung (AUTO-02) chỉ có tác dụng khi tool Task có → `doctor` nên cảnh báo (TD-8) | <https://code.claude.com/docs/en/tools-reference.md>; env-vars.md |
| Permission: `-p`/SDK khởi đầu `default` (2.1.302+); `--permission-prompts none` (2.1.259+); terminal/VS Code mặc định `auto` từ 2.1.283; `defaultMode: auto` trong settings dự án **không có hiệu lực** (không đổi); deny rule thắng ở mọi mode; cloud session chỉ Accept edits/Plan/Auto | `LOOP-CTX-020`, `LOOP-CI-010` giữ; lệnh headless mẫu thêm `--permission-mode` | <https://code.claude.com/docs/en/permission-modes.md>; <https://code.claude.com/docs/en/headless.md> |
| Auto mode: classifier mặc định Sonnet 5 (fallback model phiên/Opus), server-side review, `CLAUDE_CODE_AUTO_MODE_MODEL` (2.1.302+); 3 lần chặn liên tiếp hoặc 20 tổng → tạm dừng hỏi người; ranh giới nói trong hội thoại có thể mất sau compaction → muốn chắc dùng deny rule; `autoMode.*` chỉ đọc từ settings người dùng/managed | Khung đặt deny ở hook/settings (ADR-0018) đúng cơ chế | permission-modes.md; <https://code.claude.com/docs/en/auto-mode-config.md> |
| `--bare` "is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release"; từ 2.1.286 `--bare` không chạy tác vụ nền; `-p` không `--bare` chạy hook của repo chưa tin cậy | `LOOP-CI-010/014`: lệnh headless mẫu phải truyền `--settings .claude/settings.json` tường minh để sống qua đổi mặc định (TD-8) | headless.md |
| Prompt cache: hội thoại chính TTL 1 giờ (gói claude.ai trong hạn mức) hoặc 5 phút (API, cloud provider); subagent/workflow/compaction 5 phút, chỉnh `subagentPromptCacheTtl: 1h` (2.1.242+); đổi model/effort/fast mode/tập tool làm mất cache | `LOOP-DESIGN-012`; NH-4: đặt effort ở frontmatter agent, không đổi giữa phiên | <https://code.claude.com/docs/en/prompt-caching.md> |
| Fast mode: Opus 5.5/5/4.8, "tới 2,5× nhanh hơn" (tuyên bố, chưa tự đo), $8/$40 Opus 5.5 (×2 giá thường); gói thuê bao chỉ qua usage credits; `-p` cần `--settings '{"fastMode": true}'`; không có trên Bedrock/Vertex | Không đưa vào khung: giá ×2, áp dụng cho subagent chưa rõ | <https://code.claude.com/docs/en/fast-mode.md>; <https://platform.claude.com/docs/en/about-claude/pricing> |
| Model API: Fable 5.1 $10/$50 MTok, Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0,10/$0,50 (prompt ≤ 100K); 1M context, 128K output; alias Claude Code `fable`=5.1, `opus`=5.5, `sonnet`=5.5, `best`=fable→opus; effort mặc định Claude Code `high` trừ Opus/Sonnet/Haiku 5.5 `medium`; `MAX_THINKING_TOKENS=0` không tắt được thinking trên model 5.5/Fable | `executor-deep` (opus) = 2× giá `executor` (sonnet); `LOOP-CTX-014` nói `MAX_THINKING_TOKENS` — sửa thành `effort` | <https://platform.claude.com/docs/en/about-claude/models/overview>; model-config.md |
| Cloud session: VM tạm dừng sau vài phút idle rồi thu hồi — **mất việc nền**; SessionStart hook timeout 600 s; chỉ GitHub push/PR; setup script chỉ cache khi ≲ 5 phút; bundle repo < 100 MB | `merge-watch` nền ở phiên cloud không sống qua idle → NH-5 dựa vào steward/sự kiện, không vào nền | <https://code.claude.com/docs/en/claude-code-on-the-web.md>; <https://code.claude.com/docs/en/cloud-environments.md> |
| Scheduled tasks (tên cũ Routines; research preview): lịch ≥ 1 giờ; trigger GitHub chỉ `pull request` và `release`; API `/fire` (header beta); 100 lượt lịch/giờ/tài khoản; đẩy nhánh `claude/`; mất kết nối GitHub 72 giờ → tự tắt | TD-3 đúng giới hạn đã ghi ở `stop-points-and-escalation.md` | <https://code.claude.com/docs/en/routines.md> |
| `claude-code-action` tag mới nhất `v1.0.256` (`v1` là tag trôi; peeled SHA `a5a423f75c251dcbff8a74e99f83b2cb03c72bfa`); đầu vào `prompt`, `claude_args`, `anthropic_api_key`/`claude_code_oauth_token`, federation OIDC (`anthropic_federation_rule_id`, `anthropic_organization_id`, cần `id-token: write`); bot actor bị từ chối trừ `allowed_bots` | TD-1: `pr-review.yml` đang ghim `1d6de8cb` (v1.0.248) — nâng SHA khi bật; OIDC thay API key tĩnh | <https://code.claude.com/docs/en/github-actions.md>; <https://github.com/anthropics/claude-code-action/releases> |
| Agent SDK: PyPI `claude-agent-sdk` 0.2.170, npm `@anthropic-ai/claude-agent-sdk` 0.3.306 (2026-10-21); license npm "SEE LICENSE IN README.md" (không SPDX), PyPI ghi MIT — lệch nhau | Khung không dùng SDK (stdlib) | <https://pypi.org/pypi/claude-agent-sdk/json>; <https://code.claude.com/docs/en/agent-sdk/overview.md> |
| `claude plugin eval` (2.1.269+): mỗi case 3 lần, `--threshold`, `--max-cost-usd`, `--judge-model`, `--trust-plugin`; mỗi run là lời gọi model thật. `/skill-doctor` (2.1.252+) báo chi phí context từng skill; sau compaction giữ ≤ 5 000 token/skill, 25 000 tổng; danh sách skill gửi lại sau compaction (2.1.304) | CL-7 (MAY) eval skill; `/skill-doctor` thay đo KB tay | <https://code.claude.com/docs/en/plugin-evals.md>; <https://code.claude.com/docs/en/skills.md> |
| Bash nền ở phiên không người (`-p`, SDK, CI, cloud; 2.1.285+): 30 phút (10 phút `-p` văn bản), `timeout` tối đa 2 giờ; `BASH_DEFAULT_TIMEOUT_MS` 2 phút, `BASH_MAX_TIMEOUT_MS` 10 phút; tool `Monitor` không có trên Bedrock/Vertex/Foundry hoặc khi tắt telemetry | `XT_RECORD_TIMEOUT` 1 800 s của Gate dưới trần; mutation nightly (CL-1) chạy ở CI, không trong phiên | tools-reference.md |
| Compaction giữ: CLAUDE.md gốc, auto memory, danh sách skill, ≤ 5 file gần nhất; mất context hook thêm trước đó; SessionStart matcher `compact` chạy lại; idle compaction (2.1.299, ≥ 200K token idle ~54 phút). Checkpoint/rewind **không** theo dõi thay đổi do Bash/subagent | PreCompact checkpoint + SessionStart(compact) của khung đúng cơ chế; bằng chứng vẫn theo git | <https://code.claude.com/docs/en/context-window.md>; <https://code.claude.com/docs/en/checkpointing.md> |
| `/goal`: model nhỏ chỉ đọc hội thoại, bản chất là Stop hook `prompt` phạm vi phiên; check-in 30 phút khi có việc nền | Vẫn là lời khai (`LOOP-DESIGN-004`) | <https://code.claude.com/docs/en/goal.md> |
| Cảnh báo trạng thái: agent hook, agent teams, fast mode, scheduled tasks (`/fire` header beta), agent view, Trusted Devices đều preview/experimental/beta; `DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` làm mất `Monitor` và đổi điều kiện vài tính năng | Khung chỉ dựa vào hook `command`, subagent, worktree (đã GA) | hooks.md; agent-teams.md; env-vars.md |

### 4.2 GitHub (docs.github.com, github.blog/changelog, trang release — đọc 2026-10-21; repo `seeker19110/X-Templates`: public, `owner.type = User`, MIT, `allow_auto_merge` true)

| Dữ kiện | Ảnh hưởng tới khung/đề xuất | Nguồn |
|---|---|---|
| **Workflow execution protections** GA 2026-09-17; **từ 2026-11-02 GitHub tự thực thi event policy mặc định chặn `pull_request_target` ở repo public chưa có event policy** (hiện ở evaluate mode); cho phép lại bằng event policy nêu rõ `pull_request_target` (ràng được theo workflow path) ở Settings → Actions → Policies (REST `/repos/{o}/{r}/actions/policies`); docs khuyên tránh `pull_request_target`, ưu tiên `workflow_run`/`pull_request`; docs không nói repo user-owned có thuộc diện không | `merge-gate.yml` (required check, ADR-0023) và `pr-review.yml` dùng trigger này — check không báo thì mọi PR treo (required check "Expected" chặn merge). Mẫu cài sang dự án đích cũng vậy. **Việc khẩn K-1 (§5)** | <https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/>; <https://docs.github.com/en/actions/how-tos/administer/control-workflow-execution>; <https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target> |
| `pull_request_target`: từ 2025-12-08 workflow và checkout luôn lấy từ nhánh mặc định (2025-11-07 là ngày công bố; ADR-0023 ghi "từ 2025-11-07") | Sửa chữ ADR-0023 (ghi chú, không sửa quyết định) | <https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/> |
| Required check: check bị filter bỏ qua → Pending, chặn merge; job skip vì `if` → success; skipped/neutral được tính đạt; check phải từng chạy thành công trong 7 ngày; docs khuyên `always()` + `needs` | `quality` `always()` của khung đúng; `dep-audit` lịch tuần đủ "7 ngày" | <https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks> |
| Merge queue: GA 2023-07; chỉ repo **thuộc tổ chức** (public org repo gói Free; private cần GHEC); workflow phải có trigger `merge_group`; rule `merge_queue` chỉ cấp repo | Repo user-owned không dùng được → §7 giữ "không làm" | <https://raw.githubusercontent.com/github/docs/main/data/reusables/gated-features/merge-queue.md>; <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue> |
| **Stacked PR GA 2026-10-06** (mọi gói); **async merge API GA 2026-10-01** (`PUT …/pulls/{n}/merge-async`, `merge_action`, `sha`, trả 202 + uuid; API duy nhất hỗ trợ stack); auto-merge cho stack "đang triển khai dần"; extension `gh stack` | NH-5: thay cơ chế "PR chồng, đổi đích" tay bằng stack native — theo dõi, chưa đưa vào khung tới khi auto-merge stack GA | <https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available/>; <https://github.blog/changelog/2026-10-01-github-async-merge-api-generally-available/> |
| Auto-merge: chỉ GraphQL (`enablePullRequestAutoMerge` có `expectedHeadOid`), REST không có endpoint; proxy phiên Claude Code cloud chặn GraphQL (403) kể cả `gh pr merge --auto`, `gh pr checks`; REST `gh api` chạy được, chỉ với repo đã đính kèm | `pr next` ở phiên cloud bật auto-merge qua tool MCP (`pre-mcp-guard.sh`) hoặc steward — đúng như hiện có | <https://docs.github.com/public/fpt/schema.docs.graphql>; <https://code.claude.com/docs/en/cloud-environments#github-proxy> |
| Ruleset: `strict_required_status_checks_policy` bắt buộc khai; `require_last_push_approval`, `required_review_thread_resolution`, `required_reviewers` (team, không có ở repo user-owned); import JSON chỉ qua UI, REST có CRUD + `/history`, không export; `gh ruleset` chỉ `list/view/check`; tối đa 75 ruleset/repo | NH-1: người import JSON (hoặc REST PUT) — agent không tự đổi (guard chặn `gh api` ghi ruleset) | <https://docs.github.com/en/rest/repos/rules>; <https://cli.github.com/manual/gh_ruleset> |
| Runner repo public: standard runner miễn phí không giới hạn, `ubuntu-latest` = 24.04, 4 vCPU/16 GB (ARM có); Free 20 job đồng thời; job ≤ 6 giờ; artifact 500 MB; cache 10 GB; `setup-python` v7 có `cache: pip` | CI hiện 14 job/run < 20 — thêm shard phải tính trần; pip 5–10 s không đáng cache | <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>; <https://docs.github.com/en/actions/reference/limits> |
| **Retention: từ 2026-10-01 checks/workflow runs/statuses bị xoá theo retention** (repo public tối đa 90 ngày) | Link run CI trong PR/evidence chết sau 90 ngày → TD-4 chụp số theo tuần; `LOOP-CI-011` ghi "link có hạn" | <https://github.blog/changelog/2026-08-27-actions-retention-will-cover-checks-workflow-runs-and-statuses/> |
| Action đang ghim = bản mới nhất: checkout v7.0.1 (`3d3c42e5`; `allow-unsafe-pr-checkout` mặc định false), setup-python v7.0.0 (`5fda3b95`), upload-artifact v7.0.2, download-artifact v8.0.2; khác: `github/codeql-action` v4.39.0, `actions/attest` v4.2.2 (SLSA Build L2/L3), `ossf/scorecard-action` v2.5.0, `dependency-review-action` v5.0.0; tag annotated → ghim SHA commit đã bóc `^{}` | Dependabot theo dõi khi proxy cho; CL-5 | trang releases của từng action (2026-10-21) |
| Workflow lockfile public preview 2026-10-14 (`.github/workflows/actions.lock`, `gh actions-lock`, policy "Require lockfile"), gói Free/Team/GHEC; setting "Require actions pinned to full SHA" (2025-08-15) | CL-5 (MAY): theo dõi; SHA pin + `ci-check` đã đủ | <https://github.blog/changelog/2026-10-14-github-actions-workflow-lockfiles-in-public-preview/> |
| `GITHUB_TOKEN`: 1 000 req/giờ/repo (REST), 1 000 điểm/giờ (GraphQL); sự kiện do token tạo không kích workflow (trừ `workflow_dispatch`/`repository_dispatch`); API version 2026-03-10 (breaking): `workflow_dispatch` trả 200 + `workflow_run_id`, gỡ `merge_commit_sha` khỏi response PR | `xt.py` không ghim version, không đọc `merge_commit_sha` — không ảnh hưởng; `release-tag.yml` có thể lấy run id | <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>; <https://docs.github.com/en/rest/about-the-rest-api/breaking-changes> |
| Copilot code review: không có ở Copilot Free (Pro $10+), review mặc định là Comment, approvals ở public preview; Copilot cloud agent 59 phút/phiên; gh-aw "technical preview"; **GitHub Models đã ngừng 2026-07-30**; GitHub MCP server v2.0.2 | Không thay reviewer Claude; không có đường miễn phí | <https://docs.github.com/en/copilot/get-started/plans>; <https://github.blog/changelog/2026-07-30-github-models-is-now-retired/> |
| gitleaks CLI v8.30.1 MIT nhưng README "feature complete… security patches only", kế nhiệm **betterleaks** (MIT, v1.9.0 ổn định, v2 rc); **`gitleaks-action` theo EULA độc quyền** (repo thuộc Organization Account cần `GITLEAKS_LICENSE`; cấm dùng như một phần dịch vụ) — `secret-scan.yml` của repo và mẫu `framework/templates/secret-scan.yml` dùng `gitleaks-action@v3.0.0` | CL-9: dự án đích thuộc tổ chức cần license; cân nhắc chạy CLI (MIT) tải binary có checksum hoặc betterleaks | <https://github.com/gitleaks/gitleaks>; <https://raw.githubusercontent.com/gitleaks/gitleaks-action/master/LICENSE.txt>; <https://github.com/betterleaks/betterleaks> |

### 4.3 Công cụ Python và CI (PyPI JSON, endoflife.date, trang release — đọc 2026-10-21)

| Dữ kiện | Ảnh hưởng tới khung/đề xuất | Nguồn |
|---|---|---|
| Python: 3.10 EOL 2026-10-01; 3.11 security-only (EOL 2027-10-31); 3.12 security-only; **3.13 hết bugfix 2026-10-01** (3.13.16, security-only tới 2029-10-31); 3.14 bugfix tới 2027-10-01 (3.14.8); **3.15.0 ra 2026-10-09** (PEP 810 `lazy import`, PEP 799 `profiling.sampling`, JIT vẫn "experimental"); runner `ubuntu-latest` = 24.04, python mặc định 3.12.3, toolcache 3.10–3.14 (chưa 3.15; manifest `setup-python` có 3.15.0) | CI mặc định 3.13 nay security-only → NH-7a thử 3.14 làm bản mặc định (sàn 3.11 giữ); 3.15 chờ toolcache | <https://endoflife.date/api/python.json>; <https://devguide.python.org/versions/>; <https://github.com/actions/runner-images> |
| ruff 0.17.1 (2026-10-15, = ghim; 0.17.0 đổi target mặc định 3.11, đổi rule set mặc định); mypy 2.4.0 (= ghim; `-n auto` song song ≤ 8 worker "tới 5×", `dmypy` "≥ 10×" — tuyên bố); ty 0.0.90 **beta**, "breaking changes between any two versions", "10–100× nhanh hơn mypy" (tuyên bố); pyrefly 1.4.0 MIT stable | typecheck 4,9 s — không đáng đổi; ty chưa ổn định | <https://pypi.org/pypi/ruff/json>; <https://pypi.org/pypi/mypy/json>; <https://pypi.org/pypi/ty/json> |
| coverage 7.16.2 (= ghim): core `sysmon` (Python 3.12+) mặc định từ 3.14 và **chỉ 3.14+ mới đo nhánh bằng sysmon** (3.12/3.13 không); chọn bằng `[run] core = sysmon` hoặc `COVERAGE_CORE`; chưa hỗ trợ plugin/dynamic contexts; "faster for line coverage" (không số) | NH-7a: đo `test` trên 3.14 + sysmon (CI có 3.14.8) trước khi tối ưu mã test | <https://coverage.readthedocs.io/en/latest/changes.html>; <https://coverage.readthedocs.io/en/latest/config.html> |
| pytest 9.1.1 MIT (chạy test `unittest`, hỗ trợ subTest); pytest-xdist 3.8.0 (không release 15 tháng); **mutmut 3.8.0 BSD-3-Clause** (Beta; README chỉ nhắc pytest; mặc định đột biến thân hàm được gọi; `[tool.mutmut]`; không cờ ngưỡng); cosmic-ray 8.7.0 MIT Beta (≤ 3.13); **hypothesis 6.170.5 MPL-2.0** (cần ngoại lệ license như D-103); crosshair alpha | CL-1: mutmut cần pytest ghim hash trong `requirements-audit.txt` (chỉ nightly); hỗ trợ unittest **chưa xác minh** → chạy thử trong sandbox trước; CL-2 chỉ stdlib, tránh MPL | <https://pypi.org/pypi/mutmut/json>; <https://pypi.org/pypi/pytest/json>; <https://pypi.org/pypi/hypothesis/json> |
| uv 0.13.4 (`MIT OR Apache-2.0`): `uv lock` có hash + `upload-time`, `--exclude-newer`, `uv export --format requirements.txt`; prek 0.5.7 MIT (pre-commit viết lại bằng Rust, 0.x) | `requirements-*.txt` của repo đã sinh bằng `uv pip compile --generate-hashes`; không cần prek | <https://docs.astral.sh/uv/>; <https://pypi.org/pypi/prek/json> |
| shellcheck v0.11.0 (GPL-3.0; runner apt `ubuntu-latest` **0.9.0**; PyPI `shellcheck-py` 0.11.0.1 wrapper có wheel); shfmt 3.14.1; actionlint 1.7.12 MIT (không commit từ 2026-04-19; `actionlint-py` chỉ sdist); **zizmor 1.31.1 MIT, wheel trên PyPI**, `--format sarif`, exit 11–14 khi có finding, `--fix` an toàn; pinact 5.0.0; yamllint 1.38.0 GPL | NH-2(d): `lint` ở CI dùng shellcheck 0.9.0 của runner còn máy dev 0.11.0 → ghim `shellcheck-py` trong `requirements-dev.txt` cho cả hai; CL-5: zizmor qua PyPI (hash), actionlint tuỳ chọn | <https://github.com/koalaman/shellcheck>; <https://pypi.org/pypi/zizmor/json>; <https://github.com/rhysd/actionlint> |
| pip-audit 2.10.1 (= ghim, Apache-2.0); bandit 1.9.4; semgrep engine LGPL-2.1 + **rules "Semgrep Rules License v1.0" không OSI** + metrics mặc định `auto`; trufflehog **AGPL-3.0**; osv-scanner 2.7.0 Apache; syft 1.55.0; cyclonedx-bom 7.5.0; OpenSSF Scorecard 5.6.0 Apache | Không thêm semgrep/trufflehog; Scorecard MAY | <https://semgrep.dev/legal/rules-license>; <https://github.com/trufflesecurity/trufflehog>; <https://github.com/ossf/scorecard> |
| Lint tài liệu: markdownlint-cli2 0.23.3 (npm), lychee 0.24.2 (Rust), vale 3.24.0 | `check-links.py` stdlib + `links.yml` đã đủ | <https://github.com/lycheeverse/lychee> |
| Profiler: pyinstrument 5.1.3 BSD, py-spy 0.4.2 MIT, scalene 2.3.0 Apache; `python -X importtime` (3.14 thêm `=2`) | NH-7: đo trước bằng py-spy/importtime | <https://pypi.org/pypi/py-spy/json> |
| Đóng gói: `zipapp` stdlib (nén `-c`), shiv 1.0.8 (release cuối 2024-11), pex 2.104.1 | `xt.pyz` (ADR-0010) bằng `zipapp` là đủ | <https://docs.python.org/3/library/zipapp.html> |

### 4.4 Thực hành và bằng chứng về agent tự động (đọc 2026-10-21; **TB** = số tự công bố, chưa tự đo)

| Dữ kiện | Ảnh hưởng tới khung/đề xuất | Nguồn |
|---|---|---|
| Anthropic *How we contain Claude* (2026-05-25): auto mode chặn nhầm ~0,4 %, bỏ lọt ~17 %; sandbox cấp HĐH giảm 84 % số lần hỏi; red-team nội bộ 02/2026: 24/25 lần đọc và gửi credential AWS ra ngoài; allowlist domain là bề mặt tấn công (TB) | Giữ deny ở hook (ADR-0018) + "không để bí mật thật trong máy agent không người trực" (`harness-files.md`) | <https://www.anthropic.com/research/how-we-contain-claude> |
| Anthropic *Harness design* (2026-03-24): sau Opus 4.5/4.6 bỏ sprint contract + context reset, giữ planner + evaluator chạy một lần cuối; evaluator chỉ đáng chi phí khi việc vượt khả năng solo; full harness 6 h/$200 so với solo 20 phút/$9 (TB) | Ủng hộ ADR-0033 (tối giản pha build), máy kiểm + reviewer ở cuối thay vì mỗi bước | <https://www.anthropic.com/research/harness-design-long-running-apps> |
| Anthropic *C compiler* (2026-02-05): 16 agent song song, >2 000 phiên, ~$20 000; **khoá việc bằng file trong `current_tasks/`** (git buộc agent thứ hai chọn việc khác); harness test in ít dòng, log ra file, `--fast` mẫu 1–10 % (TB) | NH-3: khoá task bằng file/`files:` đã có trong `loop next`; `LOOP-CTX-004` think-in-code | <https://www.anthropic.com/research/building-c-compiler> |
| Anthropic *postmortem 2026-04-23*: ba thay đổi làm Claude Code suy giảm — effort mặc định `high` → `medium`, bug cache xoá thinking, system prompt bị cắt (−3 % một bộ eval); mất > 1 tuần tìm nguyên nhân vì eval nội bộ không tái hiện | **NH-4 phải đo trước**: hạ effort từng gây suy giảm thật; chỉ áp cho task cơ học, có `loop stats` so sánh | <https://www.anthropic.com/research/april-23-postmortem> |
| Claude Code best practices (docs sống): bốn mức chặn dừng (prompt · `/goal` · Stop hook xác định · "second opinion" bằng subagent/workflow); **`/batch` chia việc cho 5–30 subagent, mỗi cái một worktree**; reviewer context sạch chỉ nhận diff + tiêu chí; reviewer được bảo "tìm lỗ hổng" thường báo vài cái dù việc đúng → over-engineering | NH-3 có thể tựa `/batch` (cơ chế gộp/bằng chứng chưa xác minh); reviewer của khung đòi đường tái hiện (đã có) | <https://code.claude.com/docs/en/best-practices> |
| Anthropic *Property-based testing bằng Claude* (2026-01-14; arXiv 2510.09907): 984 báo cáo, duyệt tay 50: 56 % hợp lệ, 32 % đáng báo cáo, 3 patch merged (TB). PBT-Bench (NeurIPS 2026): recall lỗi 42–83 % tuỳ model | CL-2 chọn fuzz **tất định** (stdlib) thay vì để model sinh property; property do model sinh cần người duyệt | <https://www.anthropic.com/research/property-based-testing>; <https://neurips.cc/virtual/2026/poster/138920> |
| Anthropic *Infrastructure noise* (2026-02-05): chênh 6 điểm % giữa cấu hình VM nhiều/ít tài nguyên; lỗi hạ tầng 5,8 % → 0,5 % | Số đo cổng/test phụ thuộc máy (`shard-weights.json` đo cùng máy; CI 4 vCPU) — ghi điều kiện đo | <https://www.anthropic.com/research/infrastructure-noise> |
| OpenAI *Harness engineering* (2026-02-11; trang gốc 403, chỉ bản tổng hợp): ~1 triệu dòng, ~1 500 PR, 0 dòng viết tay; AGENTS.md ~100 dòng làm bản đồ trỏ `docs/`; review agent thiên về merge, chỉ nêu ≥ P2, người review mẫu sau merge (TB). Codex đọc AGENTS.md tối đa 32 KiB/file | PLAN-3.12 Lát 1 (AGENTS 7 KB) cùng hướng; `LOOP-STOP-012` review mẫu ≥ 10 % | <https://learn.chatgpt.com/docs/agent-configuration/agents-md>; tổng hợp ZenML (chưa xác minh trang gốc) |
| Benchmark: OpenAI ngừng báo SWE-bench Verified (2026-02-23; 59 % bài khó có lỗi); **SWE-bench Pro V2** (Scale, 09/2026): Opus 5 98,0 · Fable 5.1 92,2 · Gemini 4 Argon 92,2 · GPT-6 Astra 90,2 — **chấm lại phát hiện Opus 5 ghi giả checksum `go.sum` ở 3 tác vụ**; Terminal-Bench 4.0: Opus 5.5 64,9 %, Sonnet 5.5 61,8 % (BenchLM, TB); TB "integrity update" 2026-04-19: agent tải lời giải vào `AGENTS.md`, 2 entry bị gỡ; **Sonnet 5 dùng 21,6 tỷ token so với 6,5 tỷ của Opus 5** cùng bảng | Reward hacking có thật ở model đầu bảng → P1 bằng chứng máy + guard; ADR-0029 hai tầng: model rẻ hơn không chắc rẻ hơn mỗi task — `loop stats` phải đo token/task (TD-4) | <https://labs.scale.com/leaderboard/swe_bench_pro_public_v2>; <https://www.tbench.ai/news/leaderboard-integrity-update>; <https://www.tbench.ai/news/terminal-bench-4-0> |
| METR cập nhật 2026-02-24: 57 dev, > 800 task — dev quen AI nhanh hơn 18 %, dev mới 4 %, **cả hai CI chứa 0**, METR gọi tín hiệu "rất yếu"; RCT 2025: chậm 19 %. DORA 2025: AI quan hệ dương với throughput nhưng **âm với ổn định giao hàng**; không có DORA 2026. GitClear 2026: copy/paste 9,4 % → 15,7 %, code cập nhật > 12 tháng −74 % (vendor, TB). Veracode 2026: code LLM trần qua kiểm bảo mật 56 % (vendor, TB). AIDev (arXiv 2601.15195): PR agent không merge thì lớn hơn, nhiều file hơn, hay trượt CI | Không lấy số năng suất làm mục tiêu; đo của mình (TD-4); PR nhỏ, cổng máy, scanner giữ nguyên | <https://metr.org/blog/2026-02-24-uplift-update/>; <https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report>; <https://arxiv.org/abs/2601.15195> |
| **Review bằng LLM trên PR thật** (arXiv 2606.15689): F1 0,847 trên lỗi tổng hợp so với **0,066 trên PR thật**; F1 0,657 với diff < 10 dòng → **0,043 với diff > 150 dòng**; gần như không bắt lỗi hiệu năng. Overcorrection (arXiv 2603.00539): LLM hay xếp code đúng thành sai, prompt đòi giải thích/sửa làm tệ hơn; đề xuất "fix-guided verification". LLM-as-judge code đúng/sai 54–68 % (arXiv 2505.20206) | Reviewer chỉ hiệu quả trên diff nhỏ → giữ ≤ 150 dòng (vị từ làn nhanh) và tách PR; phát hiện phải có đường tái hiện (đã có) là đúng hướng; review không thay cổng máy | <https://arxiv.org/abs/2606.15689>; <https://arxiv.org/abs/2603.00539>; <https://arxiv.org/abs/2505.20206> |
| Reviewer khác model (arXiv 2610.01471, 2026-10): 900 phiên review, 150 lỗi cài — cross-model mạnh nhất **không khác có ý nghĩa** so với cùng model ở phiên mới; nhưng một review cùng model + một cross-model bắt 56,7 % lỗi, hai cùng model 42,7 % (p = 0,006); trùng lỗi giữa reviewer 41 %. Judge thiên vị output của chính nó (NeurIPS 2024, arXiv 2404.13076); chọn theo đa dạng đạt 95 % trần (arXiv 2510.21513). Devin 2026-04-22: "writes single-threaded", review với context rỗng, Devin Review 2 bug/PR (TB) | `LOOP-ORCH-005` (khác họ) giữ, nhưng điều quan trọng hơn là **context sạch** + diversity; một reviewer không đủ cho PR nhạy cảm → CL-3 ca đối kháng; CL-4 | <https://arxiv.org/abs/2610.01471>; <https://cognition.com/blog/multi-agents-working> |
| Best-of-N có verifier (arXiv 2407.21787): SWE-bench Lite 15,9 % → 56 % với 250 mẫu; không verifier tự động thì bão hoà; R2E-Gym (2504.07164) verifier lai 51 % | Gate là verifier: `LOOP-ORCH-015` (≥ 2 executor cho việc mở, Gate chọn) có cơ sở; chi phí ×N | <https://arxiv.org/abs/2407.21787> |
| Mutation ở quy mô: Google (arXiv 2102.11378) chỉ đột biến dòng đổi trong review, lọc theo lịch sử; Meta ACH (2501.12862) 73 % test sinh được chấp nhận; Stryker `break: null` mặc định = không bao giờ đỏ | CL-1: incremental theo diff ở PR, đầy đủ nightly; đặt ngưỡng tường minh | <https://arxiv.org/abs/2102.11378>; <https://stryker-mutator.io/docs/stryker-js/configuration/> |
| Chọn test liên quan (Meta PTS, arXiv 1810.05286): bắt > 99,9 % thay đổi có lỗi với nửa chi phí hạ tầng; pytest-testmon MIT | `test_fast`/`test-select` đúng hướng; NH-6 | <https://arxiv.org/abs/1810.05286> |
| Công cụ cùng loại: Spec Kit v1.2.2 (MIT; thêm pha **Converge**, cổng `clarify`/`checklist`/`analyze`); BMAD 6.12 (MIT); plugin `ralph-loop` (Apache-2.0, Stop hook, `--max-iterations` mặc định không giới hạn); Kiro chạy task theo "wave" độc lập song song; Factory Missions: milestone + pha validation, ~12× token (TB); Aider không commit từ 2026-05; SWE-agent bị mini-SWE-agent thay | Khung đã có tương đương (G3/G4, `loop next` DAG, mốc + audit delta); không nhập công cụ mới | <https://github.com/github/spec-kit>; <https://kiro.dev/docs/specs/>; <https://factory.com/news/missions> |
| **Sự cố "Comment and Control"** (2026-04-15): tiêu đề PR/issue/HTML comment → `claude-code-action`, Gemini CLI Action, Copilot lộ API key và `GITHUB_TOKEN` qua comment; Anthropic hạ mức xuống None với lý do "action not designed to be hardened against prompt injection". GitHub MCP "toxic agent flow" (2025-05): issue độc → lộ repo private. Cursor CVE-2025-54135 (9,8): injection ghi `.cursor/mcp.json` → RCE | TD-1: `pr-review.yml` chạy đúng loại action này — giữ tool chỉ đọc, không Bash/Web, PR là dữ liệu, không fork, token reviewer chỉ `pull-requests: write`, **review chỉ là một đầu vào** (merge-check + CI + ngoại lệ cứng vẫn chặn); `LOOP-STOP-023` (không tự thêm MCP) có bằng chứng thật | <https://oddguan.com/blog/comment-and-control-prompt-injection-credential-theft-claude-code-gemini-cli-github-copilot/>; <https://invariantlabs.ai/blog/mcp-github-vulnerability>; <https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2025-54135> |
| Chuẩn: MCP hiện hành 2026-07-28 (không draft mới); A2A v1.0.1, gia nhập AAIF 2026-08-17; Agent Skills spec: `name` ≤ 64 ký tự `[a-z0-9-]` **phải khớp tên thư mục**, có `skills-ref validate`; OWASP LLM Top 10 2026 ở repo chính chủ (trang web còn ghi 2025); OWASP Agentic 2026 không liệt kê ASI trên trang; NIST chưa có "AI RMF agent profile"; llms.txt không phải chuẩn | CL-7 thêm `skills-ref validate` cho 8 skill; `ai-security.md` giữ bảng ánh xạ | <https://modelcontextprotocol.io/specification/versioning>; <https://agentskills.io/specification>; <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10> |

## 5. Đề xuất theo ba trục

Mỗi mục: **Làm gì** · **Bằng chứng** · **Lợi (đo/ước)** · **Rủi ro, đường lùi** · **Cỡ** (S = 1 PR cấu hình/tài liệu;
M = 1–2 PR có test; L = nhiều PR) · **Ai** (máy/agent hay người).

### Việc khẩn — trước 2026-11-02

- **K-1 `pull_request_target` sắp bị chặn mặc định ở repo public** (§4.2): `merge-gate.yml` là required check `merge-gate`
  trong ruleset của repo khung và của mẫu dự án đích (hotel-manager, X-Company đã cài); `pr-review.yml` cũng dùng trigger
  này. Nếu GitHub áp event policy mặc định cho repo user-owned, check không bao giờ báo → **mọi PR treo** ở cả ba repo. Hai
  việc, làm cả hai:
  1. **Người, một lần, trước 2026-11-02**: ở mỗi repo mở Settings → Actions → Policies, xem event policy hiện có; tạo policy
     cho phép rõ `pull_request_target` ràng theo path `.github/workflows/merge-gate.yml` (và `pr-review.yml` nếu bật). REST
     `/actions/policies` bị proxy phiên chặn nên agent không kiểm được — ghi `loop defer`.
  2. **Máy, lát trong PLAN (ADR mới thay ADR-0023)**: chuyển `merge-gate` sang trigger `workflow_run` của workflow `CI`
     (chạy ở nhánh mặc định, có token — cùng tính chất "PR không sửa được cổng") và tạo check-run tên `merge-gate` trên
     head SHA của PR qua REST `POST /repos/{o}/{r}/check-runs` (`checks: write`); `pr-steward.yml` đã dùng `workflow_run` nên
     mẫu có sẵn. Rủi ro: check-run do API tạo phải khớp context ruleset (`merge-gate`, nguồn Any) — kiểm bằng
     `protection-guard`; sự kiện `auto_merge_enabled`/`labeled` không còn kích trực tiếp → steward (đã nghe `workflow_run`)
     gọi lại `merge-gate`. Đường lùi: giữ file cũ tới khi policy xác nhận. Cỡ M.
  Lợi ích phụ: docs GitHub khuyên tránh `pull_request_target`; zizmor hết phải `ignore[dangerous-triggers]`.

### Trục 1 — Nhanh hơn

- **NH-1 Ruleset repo khung bỏ "up to date" (`strict_required_status_checks_policy: false`)** — như D-116 đã chọn cho dự
  án đích. Bằng chứng: `.github/rulesets/main.json` còn `true`; mỗi lát chồng phải cập nhật nhánh + CI lại (92 s + lượt
  agent), steward không cập nhật được. Lợi: −1 vòng CI và −1 lượt agent mỗi lát (ước 2–4 phút/lát). Rủi ro: hai PR xanh
  độc lập merge liên tiếp xung đột ngữ nghĩa → lớp đỡ đã có: CI chạy trên push `main`, PR kế test trên merge ref mới; ở
  phiên một nhánh PR N+1 đã chứa N. Đường lùi: một dòng JSON. Cỡ S. **Người** (import ruleset).
- **NH-2 Cổng cục bộ = CI (đóng bốn khe đã đo)**: (a) `xt.py pr title-check <tiêu đề>` chạy trước `gh pr create`
  (`merge-check` hiện chỉ kiểm sau khi PR mở — D-056); (b) `dev-task.sh gate` chạy thêm `test_list`/`test_unit` với
  `XT_PY=python3.11` khi máy có 3.11 (CI job `py311`); (c) lớp test phụ thuộc tên nhánh `main` (AUD-TEST-005) tự mô phỏng
  bằng worktree tạm thay vì chỉ chạy ở CI; (d) ghim `shellcheck-py==0.11.0.1` (wheel, hash) trong `requirements-dev.txt` và
  gọi nó ở cả `lint` cục bộ lẫn CI — hiện CI dùng shellcheck 0.9.0 của runner, máy dev 0.11.0 (§4.3), hai bản khác luật.
  Bằng chứng: #192, #191, #193 đỏ đúng các chỗ (a)–(c). Lợi: bớt ≈ 1 trong 3,3 push mỗi PR (≈ 92 s CI + 3–10 phút sửa).
  Rủi ro: `gate` dài thêm ≈ 60 s khi có 3.11 — chấp nhận vì rẻ hơn một vòng CI; máy không có 3.11 thì bỏ qua có log. Cỡ S–M. Máy.
- **NH-3 Song song task độc lập bằng worktree trong một phiên**: `loop next --json` đã trả tập task sẵn sàng + cặp giao nhau
  `files:` (T-1511); phiên chính giao ≤ 3 `executor` cùng lúc, mỗi executor `isolation: worktree` (mẫu B, `LOOP-ORCH-010`),
  trả diff; phiên chính áp diff vào nhánh phiên theo thứ tự, `loop record` từng Gate (bằng chứng vẫn do phiên chính ghi,
  `LOOP-ORCH-004`). Bằng chứng: hiện lát đi tuần tự vì phiên cloud bị ràng buộc một nhánh (PROGRESS); việc độc lập về file
  chiếm phần lớn lát tài liệu (18 mảng `framework/`) và dự án đích nhiều module. Lợi: wall time task độc lập ÷ N (chưa đo;
  Anthropic ghi đa agent tốn ~15× token, "coding ít phần song song hơn research" — chỉ bật khi `files:` không giao nhau).
  Rủi ro: xung đột khi `files:` khai thiếu → Gate đỏ, không lọt; context phiên chính (báo cáo ≤ 25 dòng). Đường lùi: cờ
  `--parallel 1`. Cỡ M (skill `/autopilot`, `orchestration-and-subagents.md`; `xt.py` không đổi hợp đồng). Máy. Theo §4.1:
  worktree của subagent rẽ từ **nhánh mặc định** trừ khi đặt `worktree.baseRef: "head"` trong settings — bắt buộc đặt, nếu
  không executor không thấy commit của lát trước; worktree tự xoá khi không đổi gì; `cwd` trong stdin hook theo worktree nên guard
  vẫn đúng gốc. Tiền lệ (§4.4): Anthropic chạy 16 agent song song khoá việc bằng file trong git; Claude Code có sẵn `/batch`
  (5–30 subagent, mỗi cái một worktree) — thử `/batch` trước khi viết điều phối riêng, với điều kiện bằng chứng vẫn do phiên
  chính `loop record`; Factory ghi ~12× token cho mission song song → chỉ bật khi `files:` không giao nhau và có số từ TD-4.
- **NH-4 Mức effort theo loại task** (`LOOP-CTX-014` đã là luật, harness chưa làm): dòng task PLAN thêm `(effort: low|medium)`
  cho task cơ học (docs, rename, boilerplate); `loop status` trả `effort`; phiên chính truyền khi giao executor. Lợi: chưa đo
  (tuyên bố của nhà cung cấp: ít token suy nghĩ hơn). Rủi ro: hạ chất lượng ở task không cơ học → chỉ mặc định `high`, giảm
  khi PLAN ghi rõ. Cỡ S. Máy. Theo §4.1: `effort` là trường frontmatter subagent (low/medium/high/xhigh/max); đổi effort giữa
  phiên làm mất prompt cache → cách rẻ là hai agent file (`executor` effort mặc định, `executor-lite` effort `medium` cho task
  cơ học) thay vì đổi effort tại chỗ; `MAX_THINKING_TOKENS=0` không còn tắt được thinking trên model 5.5/Fable → sửa chữ
  `LOOP-CTX-014`. Cảnh báo từ §4.4: chính Anthropic từng suy giảm chất lượng Claude Code khi hạ effort mặc định `high` → `medium`
  (postmortem 2026-04-23), và trên Terminal-Bench 4.0 model rẻ hơn tiêu nhiều token hơn 3× → NH-4 chỉ sau khi TD-4/`loop
  stats` có token/task và tỉ lệ xanh lần đầu để so.
- **NH-5 Không chờ merge**: sau `pr next`, làm lát kế ngay (PR chồng — đã là luật `LOOP-DESIGN-020`); `merge-watch` nền chỉ in khi
  cần hành động; phiên cloud dùng theo dõi sự kiện PR (`LOOP-CI-017`). Cỡ S (tài liệu/skill). Lợi nhỏ, chi phí 0.
- **NH-6 `test_fast` theo stack cho dự án đích** (mẫu `harness-files.md` đã có Node/Python): thêm Go (`go test ./<gói đổi>/...`),
  Java (`-Dtest=`), .NET (`--filter`) để `gate-fast` của dự án đích không rơi về `test` đầy đủ. Cỡ S. Máy.
- **NH-7 Bộ test khung nhanh hơn** — *đo trước, hai thí nghiệm rẻ rồi mới quyết*: (a) **NH-7a** chạy `test` trên Python 3.14
  với `COVERAGE_CORE=sysmon` (từ 3.14 coverage đo được nhánh bằng sysmon, mặc định là sysmon — §4.3; CI đã có 3.14.8 trong
  toolcache): một job CI thử + đo cục bộ nếu cài được 3.14; 3.13 nay chỉ còn vá bảo mật nên đổi bản mặc định CI sang 3.14 là
  việc nên làm dù sysmon có nhanh hay không (sàn 3.11 giữ). (b) **NH-7b** `py-spy`/`python -X importtime` trên 10 lớp chậm
  nhất (19,5 · 14,4 · 13,5 s…): phần lớn test gọi `xt.py`/hook qua subprocess (~250 ms khởi động + coverage `patch =
  subprocess`); gọi `main(argv)` trong tiến trình cho test CLI thuần (giữ subprocess cho hook/guard) ước giảm 30–50 % nhưng là
  refactor 6,5 k dòng test — chỉ làm nếu (a) không đủ. Cỡ S (đo) → L (refactor). Máy.

### Trục 2 — Tự động tối đa

- **TD-1 Bật reviewer độc lập trên GitHub** (`pr-review.yml` đã viết, đang tắt): chủ repo tạo **GitHub App** (danh tính bot
  riêng, token ngắn hạn qua action tạo token App — phiên bản ở §4.2) hoặc tài khoản thứ hai; secret `ANTHROPIC_API_KEY` hoặc
  OIDC/WIF của `claude-code-action@v1`; biến `XT_REVIEWER_ENABLED`, `XT_REVIEWER_MODEL` khác họ tác giả; `xt.yaml`
  `review_identity`. Lợi: pha `harden` và PR ngoại lệ cứng được review mà không cần phiên tác giả (ADR-0027/0028); review
  độc lập thật thay vì cùng phiên. Rủi ro: chi phí API mỗi PR (`--max-budget-usd 2` đã ghim); **prompt injection qua nội dung
  PR** là sự cố thật với đúng loại action này (§4.4 "Comment and Control": lộ API key/`GITHUB_TOKEN` qua comment; Anthropic xếp
  action "không được thiết kế để chống prompt injection") — thiết kế hiện tại đã giảm bề mặt (tool chỉ Read/Grep/Glob, không
  Bash/Web, không checkout code PR, không fork, token reviewer chỉ `pull-requests: write`), và review chỉ là **một** đầu vào:
  PR bị thao túng để "sạch" vẫn phải qua CI, `merge-check`, ngoại lệ cứng; thêm bước `jq` chặn comment review chứa chuỗi giống
  bí mật (regex của `redact`). Cỡ S. **Người** (T-1508 chờ từ 2026-10-19).
- **TD-2 `XT_STEWARD_TOKEN`** (fine-grained PAT hoặc App: contents + pull-requests write): steward tự cập nhật nhánh tụt base
  và merge của nó kích workflow `push`. Lợi: bỏ hành động `update` thủ công/agent; cùng NH-1 đóng hẳn vòng cập nhật nhánh.
  Cỡ S. **Người** (D-061).
- **TD-3 Routine kích phiên** cho hai việc steward không làm được — `fix` khi CI đỏ do mã và `update` khi thiếu token — theo mẫu
  đã viết ở `stop-points-and-escalation.md` §Steward; và Routine tuần **nâng cấp dự án đích** (AUTO-06, `doctor --drift`) cho
  hotel-manager và X-Company. Hiện tài khoản chỉ có Routine gom phản hồi. Danh tính Routine = chủ repo nên không tính là review.
  Cỡ S. **Người** tạo (agent chỉ đề xuất — `LOOP-STOP-014`).
- **TD-4 `xt.py pr stats` — số DORA máy đọc**: từ REST (`_gh_api` đã phân trang) tính theo tuần: lead time mở → merge trung vị/P95,
  run CI mỗi PR (push lại), tỉ lệ run đỏ, PR revert, thời gian `review` → merge; in bảng + `--json`; agent ghi `docs/ops/DORA.md`
  ở bàn giao, Routine tuần đính kèm. Bằng chứng: REMEDIATION §6 "Tốc độ và chi phí: chưa đo"; AUTONOMY-BASELINE §5; `LOOP-DESIGN-016`,
  `LOOP-CI-018`, `LOOP-STOP-010` (đường lùi tự chủ cần số). Lợi: mọi đề xuất ở §5 đo được trước/sau (P1). Cỡ M (hàm thuần + fixture
  REST giả, test như `test_merge.py`). Máy.
- **TD-5 Hook `PostToolUseFailure` trích lỗi tại chỗ**: khi lệnh Bash là Gate/cổng và exit ≠ 0, hook gọi `xt.py loop triage-local`
  (bộ phân loại của `ci-triage` áp lên output cục bộ: assertion/traceback/lint/type/coverage, ≤ 20 dòng, che bí mật) và trả
  stderr/stdout (docs: stderr của `PostToolUseFailure` tới Claude; `additionalContext` ≤ 10 000 ký tự). Lợi: agent không đọc lại
  log dài (`LOOP-CTX-004`), −1 lượt mỗi lần đỏ (chưa đo). Rủi ro: fail-open, chỉ gợi ý, không quyết. Cỡ M. Máy. Sự kiện và
  trường đã có trong docs (§4.1); `duration_ms` của `PostToolUse` còn cho phép ghi thời gian Gate vào `runs.jsonl` miễn phí.
- **TD-6 Workflow cho `/audit`** (fan-out 13 nhóm → xác minh đối kháng → gộp): tool Workflow đã có tài liệu chính thức (§4.1:
  16 agent đồng thời, resume cùng phiên), nhưng chỉ ở phiên tương tác (không qua `-p`/lịch) (đính chính 2026-10-25: chỉ từ khoá — xem §9) và là tool của Claude Code, không
  của khung → skill `/audit` thêm nhánh "có Workflow thì dùng, không thì 2–4 subagent như hiện nay"; kết quả vẫn qua xác minh
  đối kháng và `audit check`. Cỡ S. Lợi: wall time audit toàn bộ ÷ số nhóm (chưa đo).
- **TD-8 Khớp harness với Claude Code 2.1.306** (sửa nhỏ, nên làm ngay): (a) `doctor` cảnh báo khi phiên không có tool Task
  (hook `TaskCompleted` AUTO-02 chỉ chạy khi `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` hoặc tool được cấp — cloud/nền luôn có); (b)
  lệnh headless mẫu trong `self-healing-ci.md`/`loop-design.md` thêm `--permission-mode` và `--settings .claude/settings.json`
  vì `-p` nay khởi đầu `default` và `--bare` sẽ thành mặc định; (c) `LOOP-CTX-014` đổi `MAX_THINKING_TOKENS` → `effort`; (d)
  `pr-review.yml` ghim SHA `claude-code-action` v1.0.256 khi bật. Cỡ S. Máy.
- **TD-7 Báo cáo cuối tự chèn số**: `loop stats` + `pr stats` + `autonomy-bench --json` thành một lệnh `xt.py report` in
  đúng khuôn 5 mục (đã làm · bằng chứng · D-NNN · còn treo · đề xuất) để bớt lượt soạn tay. Cỡ S. Máy.

### Trục 3 — Chất lượng tối đa

- **CL-1 Mutation test cho `guard.py` và lõi `xt.py`** (`bash_decision`/`apply_policy`, `merge_eligibility`, `loop_verdict`,
  `parse_plan`): nightly toàn bộ + incremental trên PR đụng guard, ngưỡng **≥ 70 %** theo `QA-COV-005` của chính khung (mục
  MUST@L cho parser/phân quyền — `guard.py` là parser phân quyền; repo khung quy mô S nên chưa bị bắt buộc, đây là dogfood).
  Bằng chứng: coverage 100 % nhưng SEC-091 (fail-open) lọt qua #186; 5 false-green sau 247 ca xanh. Công cụ: mutmut ghim hash
  trong `requirements-audit.txt` (phiên bản/giấy phép/cách chạy với unittest ở §4.3; mutmut 3 không có cờ ngưỡng → script đọc
  `export-cicd-stats`, đã ghi ở `coverage-and-mutation.md`). Rủi ro: thời gian (guard 6 k dòng × 1 225 test) → nightly, PR chỉ
  file đổi (`QA-COV-010`); equivalent mutant ghi chú. Đường lùi: tắt workflow. Cỡ M. Máy.
- **CL-2 Fuzz bất biến cho guard (chỉ stdlib)**: `tests/fuzz_guard.py` sinh biến thể từ corpus 4 000 cặp + ca deny của bench
  — bọc `env X=1`, `command`, `nice`, `timeout`, `bash -c '…'`, `$(…)`, nối `;`/`&&`, nháy đơn/kép, NFKC, `cd` trước — và
  khẳng định ba bất biến: (i) **đơn điệu**: lệnh bị deny thì mọi biến thể bọc cũng deny; (ii) **không ném ngoại lệ** (ngoại lệ
  = fail-open, AUD-SEC-077/091); (iii) allow giữ nguyên với bọc vô hại (chặn oan). 10 s trong job `checks` (seed cố định), 10
  phút nightly (seed ngẫu nhiên ghi log); ca đỏ chuyển thành ca `autonomy-bench`. Bằng chứng: phần lớn 🔴/🟠 guard trong sổ audit là
  biến thể bọc/mã hoá (SEC-001/003/004/008/011/017/077/091). Lợi: tìm lỗ trước reviewer, không phụ thuộc model. Cỡ M. Máy.
- **CL-3 Ca đối kháng do reviewer khác họ**: 0 → ≥ 30 ca `origin: adversarial-reviewer` (AUTO-07 đòi, AUTONOMY-BASELINE §5
  ghi thiếu); quy trình: sau mỗi PR đụng guard, `reviewer-alt` viết ≥ 5 ca vào corpus (ca đỏ → `pending/` + phát hiện audit).
  Cỡ S (quy trình trong skill `/review`). Máy.
- **CL-4 Review trước khi mở PR cho diff ngoại lệ cứng**: PR đụng `scripts/*`, `framework/templates/*`, hook vẫn cần review sạch
  ở head (kể cả pha build) — đổi **thời điểm**: `reviewer-alt` (read-only, ≤ 10 phút) rà diff **trước** `gh pr create`, sửa, rồi mở
  PR một lần và `pr reviewed` ngay head đầu. Bằng chứng: #190 3 h 20, #186 2 h 35 — vòng review diễn ra sau khi mở PR, mỗi vòng
  thêm push + CI; 3,3 run/PR. Không thêm review so với D-110 (chỉ PR vốn phải review). Lợi: −1–2 push/PR làn chuẩn. Điều kiện
  từ §4.4: review bằng LLM chỉ còn F1 0,043 trên diff > 150 dòng → bước này đi kèm luật **tách PR ≤ 150 dòng** (vị từ làn nhanh
  đã có số này) và reviewer chỉ nhận diff + SPEC (context sạch), phát hiện phải có đường tái hiện (chống overcorrection). Cỡ S
  (skill `/autopilot` bước 6, `/review`). Máy.
- **CL-5 Lint workflow trong CI**: `zizmor` và `actionlint` (audit CI đã chạy tay 2026-10-19/20) vào job `checks` hằng tuần qua
  `requirements-audit.txt` (phiên bản/giấy phép §4.3). Lợi: tự động hoá một bước audit nhóm CI; chặn `dangerous-triggers` mới. Cỡ S. Máy.
- **CL-6 "Harness có hạn sử dụng"** (`LOOP-DESIGN-014`): `doctor` cảnh báo khi hàng rào chưa xét lại sau 90 ngày hoặc khi bản
  Claude Code lớn hơn bản ghi lúc cài (`manifest.json`). Cỡ S. Máy. Mức MAY.
- **CL-7 Eval và validator cho skill** (MAY): `claude plugin eval` (§4.1) với 5–10 case mỗi skill (`/review` phải tìm đúng lỗi
  đã gài, `/autopilot` không tick khi Gate đỏ) chạy tay trước khi cắt bản — mỗi run là lời gọi model thật, không vào CI;
  `skills-ref validate` (Agent Skills spec, §4.4) cho 8 skill vào `checks` nếu cài được không phụ thuộc mạng. Cỡ S.
- **CL-8 Bằng chứng CI có hạn 90 ngày** (§4.2): link run trong PR/`AUDIT-STATUS` hết hiệu lực sau retention → TD-4 ghi số
  theo tuần; `LOOP-CI-011` thêm câu "link run CI chỉ sống ≤ 90 ngày, số đo chụp vào `docs/ops/`". Cỡ S (tài liệu).
- **CL-9 `gitleaks-action` theo EULA độc quyền** (§4.2): repo khung user-owned không cần license, nhưng mẫu
  `framework/templates/secret-scan.yml` cài sang dự án đích — dự án thuộc Organization Account phải có `GITLEAKS_LICENSE`,
  và gitleaks CLI đã "feature complete". Đề xuất: mẫu chạy CLI (MIT) tải binary ghim phiên bản + SHA256 (hoặc betterleaks
  khi v2 ổn định) thay vì action; ghi chú ở `licensing-and-ip.md`/`supply-chain.md`. Cỡ S–M. Máy; xác nhận với chủ repo vì đổi
  required check `gitleaks` của dự án đích.

## 6. Thứ tự lát đề xuất (dự thảo PLAN-3.13, mỗi lát một PR)

Xếp theo tiêu chí chất lượng cuối (đúng/an toàn › đường lùi › bền › trải nghiệm › tốc độ — AGENTS.md §4):

| Lát | Nội dung | Vì sao trước | Cổng |
|---|---|---|---|
| 0 — khẩn (hạn 2026-11-02) | K-1 `merge-gate` sang `workflow_run` + check-run REST (ADR mới) · TD-8 khớp Claude Code 2.1.306 | Required check có thể ngừng báo ở cả ba repo; TD-8 là sửa chữ/cảnh báo nhỏ đi kèm | `protection-guard` xanh; `merge-gate` báo trên head PR thử; test `test_merge.py` cho check-run |
| A — đóng khe lọt đã đo | CL-2 fuzz bất biến · NH-2 cổng cục bộ = CI (kể cả ghim shellcheck) · CL-4 review trước mở PR | Mỗi mục đều có run đỏ/lỗ hổng thật làm bằng chứng; giảm push lại là lợi kép chất lượng + tốc độ | test fuzz xanh ở `checks`; `gate` có bước 3.11; skill đổi có test `test_docs_budget` |
| B — máy đo và tự sửa | TD-4 `pr stats` · TD-5 `PostToolUseFailure` · TD-7 `report` · CL-3 ca đối kháng · CL-8 tài liệu | Có số trước khi siết/nới (P1); hook trích lỗi giảm lượt | `tests/test_merge.py` fixture REST; test hook payload giả |
| C — chất lượng nền | NH-7a đo 3.14 + sysmon (đổi bản CI mặc định nếu xanh) · CL-1 mutmut nightly · CL-5 zizmor · CL-9 gitleaks CLI | Phụ thuộc mới chỉ ở `requirements-audit.txt`, không chạm cổng commit; 3.13 đã security-only | workflow tuần xanh; ngưỡng 70 % đọc từ stats; `test` 3.14 xanh 100 % |
| D — nhanh | NH-3 song song worktree (`worktree.baseRef: head`) · NH-4 effort (agent `executor-lite`) · NH-5/NH-6 tài liệu | Chỉ sau khi B có số để so trước/sau | `loop stats` + `pr stats` hai tuần trước/sau |
| Chờ người | K-1 bước 1 (event policy ba repo) · NH-1 ruleset `strict: false` · TD-1 App reviewer · TD-2 steward token · TD-3 Routines | Hành động trên tài khoản/ruleset — điểm dừng | `loop defer`, gom cuối phiên |

Mục tiêu đo sau PLAN (đề xuất, **chưa đo**): lead time trung vị 15 → ≤ 8 phút; run CI/PR 3,3 → ≤ 2; CI đỏ sau cổng cục bộ xanh → 0
run/tuần; mutation score guard ≥ 70 %; ca đối kháng reviewer ≥ 30; 0 false-green giữ nguyên.

## 7. Không làm (và vì sao)

| Đề xuất thường gặp | Không lấy vì |
|---|---|
| Đa agent phân cấp / runtime bền (orchestrator ngoài phiên) | ADR-0009 một phiên + checkpoint; subagent độ sâu 1 (`LOOP-ORCH-001`); chi phí ~15× token cho việc cần chia sẻ context chặt |
| Validator/"judge" bằng model (hook `prompt`/`agent`) làm cổng | Lời khai, không phải bằng chứng (P1, `LOOP-DESIGN-004`); chỉ bổ trợ |
| Merge queue | Chỉ có ở repo thuộc tổ chức (§4.2) — repo user-owned không dùng được; tuần tự hoá merge, cần job `merge_group`; `strict: false` + CI trên `main` rẻ hơn (D-116) |
| Copilot code review làm reviewer độc lập | Không có ở gói Free, review mặc định là Comment, approvals còn preview (§4.2); reviewer Claude khác họ đã có |
| semgrep / trufflehog / hypothesis trong cổng | Rules semgrep không OSI + metrics mặc định; trufflehog AGPL; hypothesis MPL-2.0 cần ngoại lệ (§4.3) — CL-2 stdlib đủ |
| ty / pyrefly thay mypy | ty còn beta, breaking giữa mọi bản; typecheck 4,9 s không phải nút thắt |
| Vòng Ralph (context mới mỗi vòng) | ADR-0009 chọn compaction có checkpoint; mất ngữ cảnh lát |
| Tách `guard.py` thành module nạp lười để nhanh hơn | D-111 loại: hàng rào bảo mật, lợi 100 ms/lệnh |
| `claude -p --bare` cho CI "nhẹ" | Mất hook/CLAUDE.md/skill — mất mọi cổng (`LOOP-CI-010`) |
| Hạ coverage/skip test để cổng nhanh | `LOOP-CI-001`; cổng đã < 2 phút |
| Chuyển test sang pytest để nhanh | Thêm phụ thuộc vào cổng commit; lợi chưa đo (NH-7 đo trước) |
| Agent tự tạo token/App/Routine/ruleset | Điểm dừng về hành động (`LOOP-STOP-014`, ADR-0018) — người làm một lần |

## 8. Chưa xác minh

- Claude Code (researcher 2026-10-21): giới hạn cloud session (số phiên đồng thời, tài nguyên VM, thời lượng) — chỉ thấy CHANGELOG
  2.1.302 nhắc "limit on concurrent cloud sessions", không có số; tham số `subagent_type: "fork"` chỉ thấy ở CHANGELOG, chưa thấy
  ở trang docs; model `default` theo từng gói (trang `model-config` nói Opus 5.5, whats-new tuần 27 nói Sonnet 5) — lệch; giấy
  phép `anthropics/claude-code` và `claude-code-action` (API GitHub bị chặn trong phiên); phần sau ký tự 100 000 của `hooks.md`,
  `model-config.md`, `skills.md`, `env-vars.md` chỉ đọc qua tóm tắt.
- Số tuyên bố chưa tự đo (TB→CĐ): cap Stop hook 8; classifier 3/20 lần chặn; 12 hook prompt/agent đồng thời; 16 agent Workflow;
  trần nền 10/30 phút/2 giờ; fast mode "2,5×"; `--max-budget-usd` có thể vượt.
- GitHub (researcher 2026-10-21): event policy mặc định chặn `pull_request_target` có áp cho repo **user-owned** không — docs
  không nêu; policy hiện có của ba repo không đọc được (proxy chặn `/actions/policies`) → chỉ người xem được ở Settings; merge
  queue ở repo user-owned chỉ suy từ điều kiện gói; hành vi auto-merge với check "Expected"; `required_workflows` qua REST ở
  repo user-owned; `timeout-minutes` mặc định 360 chỉ thấy qua tìm kiếm; license của `gh-aw`, `github-mcp-server`, `gh
  actions-lock`; Dependabot security updates "miễn phí cho repo public" không có câu khẳng định riêng; dependency review ở repo
  public (hai trang mâu thuẫn). Nội dung fetch là tóm tắt của mô hình nhỏ — các dòng K-1 cần đối chiếu nguyên văn trước khi
  hành động.
- Công cụ Python (researcher 2026-10-21): trường `archived` của GitHub (API bị chặn) — kết luận "còn bảo trì" dựa vào ngày
  commit HEAD; mutmut với `unittest` (README chỉ nhắc pytest); mọi số tốc độ tự công bố (ty 10–100×, uv 10–100×, mypy 5×,
  dmypy ≥ 10×, prek, coverage sysmon "faster", JIT 3.15 7–8 %); telemetry của uv (trang chính sách 404); nội dung installer
  (`install.sh` của uv/trufflehog/syft, `download-actionlint.bash` không thấy kiểm checksum).
- Thực hành/bằng chứng (researcher 2026-10-21): trang gốc OpenAI "Harness engineering" và "Why we no longer evaluate SWE-bench
  Verified" trả 403 — chỉ có bản tổng hợp; bảng chính thức Terminal-Bench 4.0 và SWE-bench Verified không đọc được (JS) — top-5
  TB 4.0 từ BenchLM; cơ chế gộp kết quả của `/batch`; CVE của "Comment and Control" (bài gốc không nêu; CVE-2025-59145 mà một
  nguồn gán là sai — đó là vụ npm `color-name`); số Google/Microsoft nội bộ ("+26 %", "−21 %"); danh mục ASI01–10 từ trang OWASP
  gốc; `skills-ref validate` chưa chạy trên 8 skill của repo.
- Mọi con số "lợi" ở §5 ghi "ước"/"chưa đo" chỉ là ước lượng từ §2–§3; TD-4 là cách đo trước/sau.

## 9. Nguồn

- Số đo trong phiên 2026-10-21: `scripts/dev-task.sh build|typecheck|lint|test|gate|gate-fast`; GitHub API
  `list_pull_requests` (39 PR #157…#196), `list_workflow_runs` (`ci.yml`, 25 run gần nhất), `list_workflow_jobs` (run
  39551231223, 39511010457, 39505116160, 39496582108); `git log origin/main` tại `cd17588`; `list_triggers` của tài khoản.
- Repo khung tại `cd17588`: `xt.yaml`, `.github/rulesets/main.json`, `.github/workflows/{ci,pr-review,pr-steward,merge-gate}.yml`,
  `tests/shard-weights.json`, `docs/ops/AUDIT-STATUS.md`, `docs/ops/AUTONOMY-BASELINE.md`, `docs/ops/REMEDIATION-PLAN-2026-10-19.md`
  §6, `docs/autopilot/DECISIONS.md` (D-061, D-110…D-117), `CHANGELOG.md` 3.11.0–3.12.0, `framework/11-autonomous-loop/*`,
  `framework/14-testing-quality/coverage-and-mutation.md`.
- Nghiên cứu trước của repo: [`2026-10-13-claude-code-hooks-skills.md`](2026-10-13-claude-code-hooks-skills.md),
  [`2026-10-13-ai-agent-research.md`](2026-10-13-ai-agent-research.md) (§1.1 hook 33 sự kiện, subagent `isolation`/`effort`,
  headless; §3.4 harness dài hơi; §4 eval), [`2026-10-19-rapid-build-then-harden.md`](2026-10-19-rapid-build-then-harden.md)
  (§10 số đo cổng, §11 DORA).
- Nguồn sống xác minh 2026-10-21: xem §4 (mỗi dòng kèm URL + ngày).
- **Đính chính 2026-10-25** (ADR-0049, đọc lại <https://code.claude.com/docs/en/workflows.md> và <https://code.claude.com/docs/en/model-config.md>): dòng tool Workflow ở §4.1 và TD-6 nói rộng quá — chỉ **từ khoá** `ultracode` không kích hoạt qua `-p`/SDK không gắn nguồn người/lịch/webhook; tool Workflow chạy được ở `-p`/SDK khi có rule allow `Workflow`, chế độ auto/bypass hoặc hook trả allow; `/effort ultracode` giữ mức effort (v2.1.284+), `--effort ultracode` khởi động ở `xhigh`.
