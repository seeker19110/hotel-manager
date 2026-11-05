---
title: Agent tự sửa CI/review: giới hạn, cấm, bằng chứng
kind: module
prefix: LOOP-CI
applies_to: [all]
updated: 2026-11-01
---

# Agent tự sửa CI/review: giới hạn, cấm, bằng chứng

> Agent được phép đọc log CI, sửa code để cổng xanh và phản hồi review — trong **ranh giới cứng**: không làm cổng
> xanh bằng cách nới cổng, không chạy lại vô hạn, không rewrite history, mỗi lần sửa có bằng chứng. Module này đặt
> ranh giới đó và cách cấu hình CI khi agent là tác giả commit.

## Nguyên tắc

1. **Sửa nguyên nhân, không sửa cổng** (P8, `AGENTS.md` mục Luật bất biến): test đỏ → sửa code; chỉ sửa test khi test sai so với
   SPEC và nói rõ trong commit. Skip/disable test, gắn `@flaky`/cách ly test, hạ ngưỡng coverage, nới lint = thay đổi
   cấu hình cổng → cấm (`AGENTS.md` mục Luật bất biến). Agent sửa lỗi không được làm yếu chính bài kiểm của đoạn code nó sửa: `pre-edit-guard.sh`
   đánh dấu lần sửa một file test **đã có** thêm skip/only/xfail/`@flaky` hoặc bớt assertion (mặc định cho chạy — ADR-0018; `XT_GUARD_POLICY=strict` thì hỏi) — hook không
   chặn nên kỷ luật này là của agent, review và CI đỡ.
2. **Đọc log trước khi sửa**: không đoán lỗi từ tên job; lấy đúng dòng lỗi (stack trace, assertion) rồi mới sửa.
3. **Trần rõ ràng**: re-run tối đa 1 lần cho lỗi nghi flake; cùng chữ ký lỗi tối đa 3 lần sửa (máy chặn qua
   `same_failure_count`, xem [`loop-design.md`](loop-design.md)); vượt → `blocked`, người xem.
4. **Không chạm lịch sử người khác**: không force-push, không rebase nhánh không phải của mình, không empty commit để kích CI.
5. **CI với tác giả là AI phải được siết quyền**: token tối thiểu, tách job ghi, kiểm `author_association`, pin action
   theo SHA (chi tiết ở [`../12-security/supply-chain.md`](../12-security/supply-chain.md)).
6. **Bằng chứng chia sẻ là link CI/PR**: `.autopilot/evidence/` chỉ cục bộ; PR phải dẫn run CI xanh.

## Quyết định

### Loại lỗi CI → hành động được phép

| Lỗi | Hành động | Cấm |
|---|---|---|
| Hạ tầng (runner mất mạng, timeout tải dependency, 5xx registry) | Re-run **1 lần**; vẫn đỏ → coi là lỗi thật | Re-run lần 2 "cho chắc" |
| Test đỏ, tái hiện được local | Phân loại trước ([`QA-STRAT-021`](../14-testing-quality/test-strategy.md)); bug thật → sửa code, giữ test; nếu test sai so với SPEC → sửa test, nêu SPEC trong commit | `skip`, `xfail`, `.only`, xoá test |
| Test flake (đỏ/xanh ngẫu nhiên, không đổi code) | Ghi bằng chứng (run đỏ và xanh trên cùng commit) + mở issue; **gắn `@flaky`/cách ly khỏi cổng là nới cổng** → `loop defer`, người duyệt theo [`QA-STRAT-009`](../14-testing-quality/test-strategy.md) | Retry vô hạn trong CI; agent tự gắn `@flaky` trong vòng tự động |
| Lint/format | Chạy formatter/linter fix cục bộ, commit riêng `style:` | Tắt rule, thêm `eslint-disable` diện rộng |
| Typecheck | Sửa kiểu; không `any`/`@ts-ignore` để qua | Nới `strict` trong tsconfig |
| Coverage dưới ngưỡng | Thêm test cho nhánh thiếu | Hạ ngưỡng trong config |
| Secret scan / SAST bắt lỗi | **Dừng**, `xt.py loop block`, người xem; xoay bí mật nếu đã lộ | Thêm vào allowlist của scanner |
| Dependency có CVE | Nâng lên phiên bản vá nếu semver tương thích; breaking → hỏi | Ghi đè audit level |
| Migration đỏ | Chỉ sửa migration **chưa áp**; migration đã áp → điểm dừng | Sửa file migration đã chạy ở môi trường chung |

### Máy phân loại và giữ ngân sách: `loop ci-triage`

`python3 scripts/xt.py loop ci-triage --run <id> [--task T-NNN] [--cost-usd X] [--json]` đọc log bước đỏ
(`gh run view <id> --log-failed`; `--log FILE` khi ngoại tuyến), phân loại theo bảng trên — thứ tự
secret/SAST → migration → type → coverage → lint → test → hạ tầng (hạ tầng xét cuối: log có cả lỗi thật lẫn dấu mạng là
lỗi thật), không khớp → `unknown`. Secret/SAST chỉ tính khi dòng báo **phát hiện** (`leaks detected`, `3 blocking
findings`, `>> Issue: [B105…]`); công cụ tự lỗi (`codeql-action upload failed`), báo sạch (`no issues`) hay dòng test đỏ
nhắc chữ "secret" không block — rồi trả **một** hành động:

| Hành động | Khi nào | Máy làm |
|---|---|---|
| `block` (exit 1) | secret scan/SAST đỏ | state `blocked` (`LOOP-CI-006`); dòng log không in/ghi — có thể chứa chính bí mật |
| `defer` (exit 1) | cùng chữ ký lỗi lần thứ 3 trong episode | có `--task` → task vào `deferred` (vòng làm việc khác, gom cho người) |
| `rerun` (exit 0) | nghi hạ tầng, episode chưa re-run | `rerun_used` = 1; lần đỏ sau là lỗi thật (`LOOP-CI-002`) |
| `fix` (exit 0) | còn lại | `fix_attempts` + 1; kèm dòng lỗi trích từ log (`LOOP-CI-005`) |

Ngân sách sống qua restart trong `.autopilot/state.json` khoá `episode` (theo `--task`; task khác → episode mới):
`rerun_used` (≤ 1), `fix_attempts`, `cost_usd` (chưa đo → `null`, không ghi 0), `signature`/`same_signature` và kết quả
mỗi run. Chữ ký = loại + dòng lỗi đã thay số bằng `N` (không phụ thuộc thời điểm/số dòng). Triage lại run đã thấy trả
kết quả cũ, không đếm lại, không cộng lại chi phí. Lỗi `gh` → exit 3.

### Liên kết ngoài: phân loại lỗi (`check-links.py --external`, REC-13)

Link ngoài đỏ vì **mạng** khác với đỏ vì **nội dung đã đổi**; gộp chung thì hoặc báo giả hoặc bỏ sót. `links.yml` (hằng tuần)
chạy `python3 scripts/check-links.py --external` — chỉ stdlib, mỗi URL một lần, HEAD rồi GET khi HEAD trả 4xx khác 404/410 (hoặc 501) — nhiều máy chủ từ chối HEAD dù trang còn:

| Loại | Tín hiệu | Xử lý |
|---|---|---|
| tạm | 5xx · 408 · timeout · lỗi mạng | thử lại `--retries` lần (mặc định 2, lùi 1 s, 2 s); còn lỗi → cảnh báo, không đỏ |
| đổi | 3xx (301/308…) — không đi theo chuyển hướng | cảnh báo: cập nhật URL; không đỏ |
| chết | 404 · 410 (HEAD) · 4xx khác sau khi GET xác nhận | **lỗi**, exit 1: sửa hoặc bỏ nguồn |
| chưa xác minh | 401 · 403 · 429 (trang đòi đăng nhập/chặn bot) | cảnh báo, không kết luận nội dung; 429 được thử lại, 401/403 thì không |

Nguồn trong `research/` ghi ngày rà lại; "chưa xác minh" không phải bằng chứng link còn đúng.

### Cấu hình CI khi agent chạy headless

| Hạng mục | Quy định |
|---|---|
| Lệnh | `claude -p "..." --permission-mode dontAsk --allowedTools "<danh sách>" --settings .claude/settings.json --max-turns N --max-budget-usd X --output-format json`; **không** `--bare` (mất hook/CLAUDE.md/skill) |
| Chế độ quyền | Luôn truyền `--permission-mode` tường minh: `dontAsk` (CI khoá chặt — lệnh ngoài `--allowedTools`/`permissions.allow` bị từ chối, không treo chờ người) hoặc `auto` (bộ phân loại duyệt; thêm `--permission-prompts none` để việc cần hỏi bị từ chối thay vì chờ). Từ 2.1.302 `-p` khởi đầu ở `default` (Manual): lệnh cần duyệt bị từ chối nếu không có gì duyệt |
| Hook trong CI | Truyền `--settings .claude/settings.json` của repo tường minh: docs ghi `--bare` "will become the default for `-p` in a future release" (bỏ hook/CLAUDE.md/skill) — không dựa vào mặc định của bản CLI; kiểm `system/init` có `plugin_errors`/`mcp_server_errors` rỗng |
| Quyền job | `permissions:` tối thiểu; job đọc tách job ghi (chỉ job ghi có `contents: write`/`pull-requests: write`) |
| Kích hoạt | Chỉ khi actor là người (`author_association` ∈ OWNER/MEMBER/COLLABORATOR) hoặc nhãn do người gắn; không chạy trên PR từ fork với secret |
| Action | Pin theo SHA 40 ký tự; `claude-code-action@v1` dùng OIDC/WIF thay API key tĩnh khi nền tảng hỗ trợ |
| Kết thúc | Đọc `total_cost_usd` và `num_turns` từ JSON; vượt trần → fail job, không retry tự động |

## Checklist

- [ ] `LOOP-CI-001` **MUST** Không skip/disable/xoá test, không hạ ngưỡng coverage, không tắt rule lint/type để cổng xanh. → Kiểm: diff không chứa `skip(`, `xfail`, `.only(`, `eslint-disable` mới, thay đổi `coverageThreshold`/`strict`; hook `pre-edit-guard.sh` đánh dấu khi chạm file cấu hình cổng và khi sửa file test đã có mà thêm skip/only/xfail/`@flaky` hoặc bớt assertion (mặc định cho chạy — ADR-0018; `XT_GUARD_POLICY=strict` thì hỏi). · Nguồn: `AGENTS.md` mục Luật bất biến
- [ ] `LOOP-CI-002` **MUST@L** Re-run CI tối đa 1 lần cho mỗi lần đỏ nghi do hạ tầng; đỏ lần hai được xử lý như lỗi thật. → Kiểm: `loop ci-triage` trả `rerun` tối đa 1 lần mỗi episode (`state.json` `episode.rerun_used` ≤ 1); log autopilot/PROGRESS ghi số lần re-run mỗi run ID ≤ 1.
- [ ] `LOOP-CI-003` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`LOOP-DESIGN-005`](loop-design.md) (cùng chữ ký lỗi lặp 3 lần → `blocked`).
- [ ] `LOOP-CI-004` **MUST** Không force-push, không rebase/rewrite history nhánh người khác, không empty commit để kích CI. → Kiểm: `.claude/settings.json` deny `git push --force*`; `pre-bash-guard.sh` chặn; `git log` không có commit rỗng (`git log --format=%H --diff-filter=A`… hoặc `git show --stat` rỗng). · Nguồn: [`../10-workflow/git-and-branching.md`](../10-workflow/git-and-branching.md)
- [ ] `LOOP-CI-005` **MUST@L** Trước mỗi lần sửa, agent trích đúng dòng lỗi từ log CI (assertion/stack trace) vào PROGRESS hoặc commit message; không sửa theo tên job. → Kiểm: commit `fix:` dẫn dòng lỗi hoặc link job log.
- [ ] `LOOP-CI-006` **MUST@L** Secret scan hoặc SAST đỏ → dừng và hỏi người; không thêm allowlist/ignore để qua. → Kiểm: `loop block --reason` được gọi; diff không sửa file cấu hình scanner. · Nguồn: [`../12-security/secrets-management.md`](../12-security/secrets-management.md)
- [ ] `LOOP-CI-007` **MUST@L** Không sửa migration đã áp ở môi trường chung; chỉ thêm migration mới. → Kiểm: diff không chạm migration cũ; `pre-edit-guard.sh` đánh dấu khi sửa file migration có sẵn (mặc định cho chạy — ADR-0018; `XT_GUARD_POLICY=strict` thì hỏi). · Nguồn: [`../09-database/migrations.md`](../09-database/migrations.md)
- [ ] `LOOP-CI-008` **MUST** Workflow chạy agent chỉ kích hoạt bởi người (kiểm `author_association` hoặc nhãn do người gắn), không chạy với secret trên PR từ fork. → Kiểm: file workflow có điều kiện `if:` kiểm actor; `pull_request_target` không cấp secret cho code fork. · Nguồn: `research/2026-10-13-ai-agent-research.md` §3; stored 21 §9
- [ ] `LOOP-CI-009` **MUST@L** Job có agent dùng `permissions:` tối thiểu; job ghi (commit/comment) tách khỏi job đọc/suy luận. → Kiểm: workflow có khối `permissions:` tường minh; job chạy model không có `contents: write`. · Nguồn: stored 21 §9 (safe-outputs)
- [ ] `LOOP-CI-010` **MUST@L** Chạy headless không dùng `--bare`, truyền `--permission-mode` và `--settings .claude/settings.json` tường minh; có `--max-turns` và `--max-budget-usd`. → Kiểm: lệnh trong workflow; JSON kết quả có `total_cost_usd` ≤ trần. · Nguồn: Claude Code headless docs, permission-modes docs
- [ ] `LOOP-CI-011` **MUST@L** PR do agent mở dẫn link run CI xanh và lệnh Gate đã chạy; không ghi "đã test" bằng lời. Link run CI chỉ sống ≤ 90 ngày (retention log/artifact của GitHub Actions): số đo cần giữ lâu hơn (thời lượng, số run, kết quả) chụp vào `docs/ops/`. → Kiểm: mô tả PR có URL run + exit code; `reviewer` từ chối PR thiếu link. · Nguồn: `AGENTS.md` mục Luật bất biến; `research/2026-10-21-next-level-speed-automation-quality.md` CL-8 (retention 90 ngày, §4.2)
- [ ] `LOOP-CI-012` **SHOULD** Test nghi flake: agent ghi bằng chứng (run đỏ và xanh trên cùng commit) và mở issue; việc gắn `@flaky`/cách ly khỏi cổng là nới cổng nên đi qua người duyệt (`loop defer`), không tự làm trong vòng tự động; không retry nhiều lần trong CI để che. → Kiểm: issue có hai run ID cùng SHA; commit thêm `@flaky` có người duyệt PR. · Nguồn: [`../14-testing-quality/test-strategy.md`](../14-testing-quality/test-strategy.md) (`QA-STRAT-009`)
- [ ] `LOOP-CI-013` **SHOULD** Sửa lint/format đi commit riêng `style:`; sửa logic đi commit `fix:` để review tách bạch.
- [ ] `LOOP-CI-014` **SHOULD** Kiểm `system/init` của phiên headless: `plugin_errors`/`mcp_server_errors` không rỗng → fail job sớm thay vì chạy thiếu cổng. · Nguồn: Claude Code headless docs
- [ ] `LOOP-CI-015` **SHOULD** Pin mọi action/CLI trong workflow theo SHA hoặc phiên bản khoá; agent không tự nâng. · Nguồn: [`../12-security/supply-chain.md`](../12-security/supply-chain.md)
- [ ] `LOOP-CI-016` **SHOULD** Sau khi PR merge, agent quay về `main`, xoá nhánh đã merge, cập nhật `PROGRESS.md` với SHA merge.
- [ ] `LOOP-CI-017` **MAY** Dùng cơ chế theo dõi PR (webhook/`subscribe_pr_activity`) để phản hồi review và CI thay vì poll liên tục; mọi phản hồi vẫn qua trần ở mục 002–003.
- [ ] `LOOP-CI-018` **MAY** Đo tỉ lệ PR của agent merge không cần người sửa tay và thời gian đỏ→xanh theo tháng; làm baseline DORA trước khi nâng mức tự trị. · Nguồn: stored 23 §2.6
- [ ] `LOOP-CI-019` **SHOULD** Kiểm link ngoài theo lịch phân loại lỗi tạm/đổi/chết/chưa xác minh, thử lại hữu hạn; chỉ link chết làm đỏ. → Kiểm: `python3 scripts/check-links.py --external` trong `.github/workflows/links.yml`; test `link_classification`.
- [ ] `LOOP-CI-020` **MUST@L** Workflow chạy agent trên PR nạp harness **chỉ từ nhánh base**: `.claude/**`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` và mọi file `CLAUDE.md` import, `.mcp.json`, `.claude.json`. Checkout base vào gốc workspace — với trigger `pull_request`/`pull_request_review*` đặt tường minh `ref: ${{ github.event.pull_request.base.sha }}` (checkout mặc định là merge commit `refs/pull/N/merge` chứa harness của PR; `pull_request_target`, `issue_comment`, `workflow_run` checkout mặc định **nhánh mặc định** của repo — không phải base của PR, PR nhắm nhánh khác vẫn phải đặt `ref:` — xem `WF-CI-023`); code PR chỉ vào phiên dưới dạng diff qua REST, hoặc checkout ra `$RUNNER_TEMP/pr-head` rồi **xoá** `.claude/`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.mcp.json` của bản đó trước bước agent và cấp quyền đọc bằng `permissions.additionalDirectories` — **không** dùng `--add-dir`: thư mục thêm bằng `--add-dir` vẫn nạp `.claude/skills/`, `.claude/agents/`, `.claude/commands/` của nó. `claude-code-action` khôi phục từ base `.claude/`, `.mcp.json`, `.claude.json`, `CLAUDE.md`, `CLAUDE.local.md` (bản PR để ở `.claude-pr/`) nhưng **không** khôi phục `AGENTS.md` — workflow tự lấy `AGENTS.md` từ base; `claude-code-base-action` và `claude -p` trần không khôi phục gì. Hook/`apiKeyHelper`/`statusLine` của base không gọi script của gói (`npm run`, `make`, script tương đối trong repo) vì `package.json`/lockfile/cấu hình linter vẫn ở head PR; gọi công cụ trực tiếp với phiên bản ghim. → Kiểm: checkout ở gốc workspace có `ref:` trỏ base SHA, không checkout head vào gốc, không `--add-dir` trỏ vào code PR; PR thử sửa `AGENTS.md`, thêm `.claude/skills/x/SKILL.md`, `.claude/agents/x.md` — mỗi file một chỉ thị dùng công cụ agent **được cấp** (agent chỉ đọc: "`Read` file `canary-<nonce>`", nonce riêng mỗi file, đường không tồn tại; chỉ thị "tạo file" không phân biệt được "không nạp" với "nạp nhưng không có quyền ghi") — và hook trong `.claude/settings.json` ghi `$RUNNER_TEMP/canary-hook` → bước kiểm **cùng job**, `if: always()` (runner GitHub-hosted bị huỷ sau job): không có `$RUNNER_TEMP/canary-hook`, log `--output-format stream-json` không có `tool_use` nào mang đường `canary-<nonce>`, log khởi tạo phiên không có skill/agent `x` (kiểm hiệu ứng, không grep chuỗi canary trong văn bản — chuỗi đó nằm trong diff agent được đọc). · Nguồn: `anthropics/claude-code-action` docs/security.md; GitHub docs *Events that trigger workflows* (ref mặc định theo trigger, đọc 2026-10-31); Claude Code docs *Permissions* (§Additional directories), *Memory* (AGENTS.md); CVE-2025-59536, CVE-2026-21852 (NVD)

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| "Test này không liên quan, skip tạm" | Hồi quy lọt; cổng mất giá trị | Cấm skip; sửa hoặc hỏi |
| Re-run đến khi xanh | Che flake thật, tốn runner, bằng chứng giả | Trần 1 re-run; flake → issue |
| Sửa kỳ vọng của test cho khớp code sai, hoặc gắn `@flaky` cho test đỏ thật | Cổng xanh nhưng hồi quy lọt; lỗi bị "hợp thức hoá" | Hook hỏi khi test đã có bị bớt assertion/thêm skip; flake phải có hai run cùng SHA |
| Empty commit để kích lại CI | Lịch sử rác, ẩn lỗi cấu hình | Cấm theo `AGENTS.md` mục Luật bất biến; hook `pre-bash-guard` deny `git commit --allow-empty`; dùng re-run của CI |
| Agent chạy trên PR từ fork với secret | Prompt injection từ PR lấy token | Kiểm actor; tách job ghi |
| `--bare` trong CI "cho nhanh", hoặc dựa vào mặc định của `-p` | Mất hook deny/ask, mất CLAUDE.md; mặc định của `-p` đổi theo bản CLI (2.1.302 → `default`; `--bare` sắp thành mặc định) | Không `--bare`; truyền `--settings` và `--permission-mode` tường minh |
| Thêm bí mật vào allowlist scanner để qua | Lộ bí mật được "hợp thức hoá" | Secret scan đỏ → dừng, xoay khoá |
| Sửa migration đã áp cho "khớp" | Môi trường lệch, không rollback được | Chỉ thêm migration mới |
| Nâng dependency major để hết CVE | Breaking change lặng lẽ | Minor/patch tự nâng; major → hỏi |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Chặn nới cổng | `pre-edit-guard.sh` (đánh dấu khi sửa eslint/tsconfig/coverage/workflows/migration, và khi test đã có bị thêm skip/only/xfail/`@flaky` hoặc bớt assertion — mặc định cho chạy, `strict` thì ask); grep diff `skip(|xfail|\.only\(|eslint-disable` | PreToolUse Edit/Write/MultiEdit; job CI | 0 vi phạm không giải thích |
| Chặn lệnh phá huỷ | `pre-bash-guard.sh` deny `push --force`, `reset --hard`, `clean`; `settings.json` deny | PreToolUse Bash | Deny |
| Trần sửa cùng lỗi | `xt.py loop status --json` → `blocked` | Stop hook `stop-guard.sh` | `same_failure_count` ≥ 3 |
| Phân loại lỗi CI + ngân sách episode | `xt.py loop ci-triage --run <id> --json` | Trước mỗi lần sửa CI | re-run ≤ 1; cùng chữ ký 3 lần → `defer`; secret/SAST → `block` |
| Trần chi phí headless | `claude -p … --permission-mode dontAsk --settings .claude/settings.json --max-turns N --max-budget-usd X --output-format json` | Workflow | `total_cost_usd` ≤ X |
| Cổng commit | `scripts/dev-task.sh gate-fast` khi `xt.yaml` `commit_gate: fast` (lint · typecheck · test liên quan), ngược lại `gate` | Hook trước `git commit` | Exit 0 |
| Cổng đầy đủ | `scripts/dev-task.sh gate` (build · typecheck · lint · test + ngưỡng của dự án) | Job CI `quality` (cục bộ trước cắt bản — ADR-0056) | Exit 0 |
| Pin action | Linter workflow (vd `zizmor`/`actionlint`) | CI | 0 action chưa pin |

## Nguồn

- `AGENTS.md` mục Luật bất biến (không nới cổng, không force-push, không empty commit, không merge khi CI đỏ) và harness `.claude/hooks/pre-bash-guard.sh`, `pre-edit-guard.sh`, `.claude/settings.json` (deny/ask) — đọc 2026-10-13.
- Claude Code docs — headless (`--bare` bỏ hook/skill/CLAUDE.md và "will become the default for `-p` in a future release"; nạp cấu hình bằng `--settings`; `--permission-mode`/`--allowedTools`; `--max-turns`, `--max-budget-usd`, `--output-format json`, `system/init` với `plugin_errors`/`mcp_server_errors`): <https://code.claude.com/docs/en/headless.md> · permission modes (`-p` khởi đầu `default` từ 2.1.302; `dontAsk` từ chối mọi lệnh cần duyệt): <https://code.claude.com/docs/en/permission-modes.md> · GitHub Actions (`claude-code-action@v1`, OIDC): <https://code.claude.com/docs/en/github-actions> — xác minh 2026-10-21 (`research/2026-10-21-next-level-speed-automation-quality.md` §4.1; trước đó 2026-10-13, `research/2026-10-13-claude-code-hooks-skills.md`).
- GitHub docs — `permissions` của `GITHUB_TOKEN` và rủi ro `pull_request_target`: <https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication> · <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions> — xác minh 2026-10-13.
- `seeker19110/stored` mục 21 §9 (self-healing CI: trần re-run, cấm skip test, safe-outputs tách job ghi, `author_association`), mục 23 §2.6 (DORA baseline trước tự trị) — đọc 2026-10-13 (`research/2026-10-13-stored-catalog-extraction.md`).
- Anthropic, *The AI-native SDLC playbook* (2026-08-21), stage 4 Test: hook chặn agent sửa file test trong task sửa lỗi để vòng kiểm không bị làm yếu; ví dụ stage 6 lại cho agent cách ly test flaky qua cổng review — khung chọn luật chặt hơn (cách ly = điểm dừng): <https://claude.com/blog/the-ai-native-sdlc-playbook> — xác minh 2026-10-16 (`seeker19110/stored` mục 21 §10c).
- Pin action theo SHA và kiểm supply chain: xem [`../12-security/supply-chain.md`](../12-security/supply-chain.md) (nhà của chủ đề).
- Không checkout ref không tin cậy vào gốc workspace trước action; trên PR, action khôi phục từ nhánh base `.claude/`, `.mcp.json`, `.claude.json`, `.gitmodules`, `.ripgreprc`, `CLAUDE.md`, `CLAUDE.local.md`, `.husky/`, bản PR giữ ở `.claude-pr/` chỉ để tham khảo; package.json/lockfile/Makefile/linter config vẫn ở head PR nên hook gọi `npm run`/`make` chạy qua file PR cung cấp; `claude-code-base-action` không khôi phục cấu hình từ base (`LOOP-CI-020`): <https://raw.githubusercontent.com/anthropics/claude-code-action/main/docs/security.md> — xác minh 2026-10-30.
- CVE-2026-21852 (công bố 2026-01-21): Claude Code < 2.0.65, repo độc hại đặt ANTHROPIC_BASE_URL trong file settings làm lộ API key trước khi hỏi tin cậy (`LOOP-CI-020`): <https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-21852> — xác minh 2026-10-30.
- CVE-2025-59536 (công bố 2025-10-03): Claude Code < 1.0.111 chạy mã trong project trước khi người dùng chấp nhận hộp thoại tin cậy (`LOOP-CI-020`): <https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2025-59536> — xác minh 2026-10-30.
- Claude Code docs — *Permissions* §"Additional directories grant file access, not configuration" (thư mục `--add-dir` vẫn nạp `.claude/skills/`, `.claude/agents/`, `.claude/commands/`; `permissions.additionalDirectories` chỉ cấp quyền file) và *Memory* §AGENTS.md (`LOOP-CI-020`): <https://code.claude.com/docs/en/permissions> · <https://code.claude.com/docs/en/memory> — xác minh 2026-10-30.
