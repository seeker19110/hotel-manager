---
title: Agent tự sửa CI/review: giới hạn, cấm, bằng chứng
kind: module
prefix: LOOP-CI
applies_to: [all]
updated: 2026-10-16
---

# Agent tự sửa CI/review: giới hạn, cấm, bằng chứng

> Agent được phép đọc log CI, sửa code để cổng xanh và phản hồi review — trong **ranh giới cứng**: không làm cổng
> xanh bằng cách nới cổng, không chạy lại vô hạn, không rewrite history, mỗi lần sửa có bằng chứng. Module này đặt
> ranh giới đó và cách cấu hình CI khi agent là tác giả commit.

## Nguyên tắc

1. **Sửa nguyên nhân, không sửa cổng** (P8, `AGENTS.md` §3): test đỏ → sửa code; chỉ sửa test khi test sai so với
   SPEC và nói rõ trong commit. Skip/disable test, gắn `@flaky`/cách ly test, hạ ngưỡng coverage, nới lint = thay đổi
   cấu hình cổng → điểm dừng. Agent sửa lỗi không được làm yếu chính bài kiểm của đoạn code nó sửa: `pre-edit-guard.sh`
   hỏi khi lần sửa một file test **đã có** thêm skip/only/xfail/`@flaky` hoặc bớt assertion.
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
| Test đỏ, tái hiện được local | Sửa code; nếu test sai so với SPEC → sửa test, nêu SPEC trong commit | `skip`, `xfail`, `.only`, xoá test |
| Test flake (đỏ/xanh ngẫu nhiên, không đổi code) | Ghi bằng chứng (run đỏ và xanh trên cùng commit) + mở issue; **gắn `@flaky`/cách ly khỏi cổng là nới cổng** → `loop defer`, người duyệt theo [`QA-STRAT-009`](../14-testing-quality/test-strategy.md) | Retry vô hạn trong CI; agent tự gắn `@flaky` trong vòng tự động |
| Lint/format | Chạy formatter/linter fix cục bộ, commit riêng `style:` | Tắt rule, thêm `eslint-disable` diện rộng |
| Typecheck | Sửa kiểu; không `any`/`@ts-ignore` để qua | Nới `strict` trong tsconfig |
| Coverage dưới ngưỡng | Thêm test cho nhánh thiếu | Hạ ngưỡng trong config |
| Secret scan / SAST bắt lỗi | **Dừng**, `xt.py loop block`, người xem; xoay bí mật nếu đã lộ | Thêm vào allowlist của scanner |
| Dependency có CVE | Nâng lên phiên bản vá nếu semver tương thích; breaking → hỏi | Ghi đè audit level |
| Migration đỏ | Chỉ sửa migration **chưa áp**; migration đã áp → điểm dừng | Sửa file migration đã chạy ở môi trường chung |

### Cấu hình CI khi agent chạy headless

| Hạng mục | Quy định |
|---|---|
| Lệnh | `claude -p "..." --max-turns N --max-budget-usd X --output-format json`; **không** `--bare` (mất hook/CLAUDE.md/skill) |
| Hook trong CI | Truyền `--settings` trỏ `.claude/settings.json` của repo; kiểm `system/init` có `plugin_errors`/`mcp_server_errors` rỗng |
| Quyền job | `permissions:` tối thiểu; job đọc tách job ghi (chỉ job ghi có `contents: write`/`pull-requests: write`) |
| Kích hoạt | Chỉ khi actor là người (`author_association` ∈ OWNER/MEMBER/COLLABORATOR) hoặc nhãn do người gắn; không chạy trên PR từ fork với secret |
| Action | Pin theo SHA 40 ký tự; `claude-code-action@v1` dùng OIDC/WIF thay API key tĩnh khi nền tảng hỗ trợ |
| Kết thúc | Đọc `total_cost_usd` và `num_turns` từ JSON; vượt trần → fail job, không retry tự động |

## Checklist

- [ ] `LOOP-CI-001` **MUST** Không skip/disable/xoá test, không hạ ngưỡng coverage, không tắt rule lint/type để cổng xanh. → Kiểm: diff không chứa `skip(`, `xfail`, `.only(`, `eslint-disable` mới, thay đổi `coverageThreshold`/`strict`; hook `pre-edit-guard.sh` hỏi khi chạm file cấu hình cổng và khi sửa file test đã có mà thêm skip/only/xfail/`@flaky` hoặc bớt assertion. · Nguồn: `AGENTS.md` §3
- [ ] `LOOP-CI-002` **MUST@L** Re-run CI tối đa 1 lần cho mỗi lần đỏ nghi do hạ tầng; đỏ lần hai được xử lý như lỗi thật. → Kiểm: log autopilot/PROGRESS ghi số lần re-run mỗi run ID ≤ 1.
- [ ] `LOOP-CI-003` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`LOOP-DESIGN-005`](loop-design.md) (cùng chữ ký lỗi lặp 3 lần → `blocked`).
- [ ] `LOOP-CI-004` **MUST** Không force-push, không rebase/rewrite history nhánh người khác, không empty commit để kích CI. → Kiểm: `.claude/settings.json` deny `git push --force*`; `pre-bash-guard.sh` chặn; `git log` không có commit rỗng (`git log --format=%H --diff-filter=A`… hoặc `git show --stat` rỗng). · Nguồn: [`../10-workflow/git-and-branching.md`](../10-workflow/git-and-branching.md)
- [ ] `LOOP-CI-005` **MUST@L** Trước mỗi lần sửa, agent trích đúng dòng lỗi từ log CI (assertion/stack trace) vào PROGRESS hoặc commit message; không sửa theo tên job. → Kiểm: commit `fix:` dẫn dòng lỗi hoặc link job log.
- [ ] `LOOP-CI-006` **MUST@L** Secret scan hoặc SAST đỏ → dừng và hỏi người; không thêm allowlist/ignore để qua. → Kiểm: `loop block --reason` được gọi; diff không sửa file cấu hình scanner. · Nguồn: [`../12-security/secrets-management.md`](../12-security/secrets-management.md)
- [ ] `LOOP-CI-007` **MUST@L** Không sửa migration đã áp ở môi trường chung; chỉ thêm migration mới. → Kiểm: `pre-edit-guard.sh` hỏi khi sửa file migration có sẵn; diff không chạm migration cũ. · Nguồn: [`../09-database/migrations.md`](../09-database/migrations.md)
- [ ] `LOOP-CI-008` **MUST** Workflow chạy agent chỉ kích hoạt bởi người (kiểm `author_association` hoặc nhãn do người gắn), không chạy với secret trên PR từ fork. → Kiểm: file workflow có điều kiện `if:` kiểm actor; `pull_request_target` không cấp secret cho code fork. · Nguồn: `research/2026-10-13-ai-agent-research.md` §3; stored 21 §9
- [ ] `LOOP-CI-009` **MUST@L** Job có agent dùng `permissions:` tối thiểu; job ghi (commit/comment) tách khỏi job đọc/suy luận. → Kiểm: workflow có khối `permissions:` tường minh; job chạy model không có `contents: write`. · Nguồn: stored 21 §9 (safe-outputs)
- [ ] `LOOP-CI-010` **MUST@L** Chạy headless không dùng `--bare`; có `--max-turns` và `--max-budget-usd`. → Kiểm: lệnh trong workflow; JSON kết quả có `total_cost_usd` ≤ trần. · Nguồn: Claude Code headless docs
- [ ] `LOOP-CI-011` **MUST@L** PR do agent mở dẫn link run CI xanh và lệnh Gate đã chạy; không ghi "đã test" bằng lời. → Kiểm: mô tả PR có URL run + exit code; `reviewer` từ chối PR thiếu link. · Nguồn: `AGENTS.md` §3
- [ ] `LOOP-CI-012` **SHOULD** Test nghi flake: agent ghi bằng chứng (run đỏ và xanh trên cùng commit) và mở issue; việc gắn `@flaky`/cách ly khỏi cổng là nới cổng nên đi qua người duyệt (`loop defer`), không tự làm trong vòng tự động; không retry nhiều lần trong CI để che. → Kiểm: issue có hai run ID cùng SHA; commit thêm `@flaky` có người duyệt PR. · Nguồn: [`../14-testing-quality/test-strategy.md`](../14-testing-quality/test-strategy.md) (`QA-STRAT-009`)
- [ ] `LOOP-CI-013` **SHOULD** Sửa lint/format đi commit riêng `style:`; sửa logic đi commit `fix:` để review tách bạch.
- [ ] `LOOP-CI-014` **SHOULD** Kiểm `system/init` của phiên headless: `plugin_errors`/`mcp_server_errors` không rỗng → fail job sớm thay vì chạy thiếu cổng. · Nguồn: Claude Code headless docs
- [ ] `LOOP-CI-015` **SHOULD** Pin mọi action/CLI trong workflow theo SHA hoặc phiên bản khoá; agent không tự nâng. · Nguồn: [`../12-security/supply-chain.md`](../12-security/supply-chain.md)
- [ ] `LOOP-CI-016` **SHOULD** Sau khi PR merge, agent quay về `main`, xoá nhánh đã merge, cập nhật `PROGRESS.md` với SHA merge.
- [ ] `LOOP-CI-017` **MAY** Dùng cơ chế theo dõi PR (webhook/`subscribe_pr_activity`) để phản hồi review và CI thay vì poll liên tục; mọi phản hồi vẫn qua trần ở mục 002–003.
- [ ] `LOOP-CI-018` **MAY** Đo tỉ lệ PR của agent merge không cần người sửa tay và thời gian đỏ→xanh theo tháng; làm baseline DORA trước khi nâng mức tự trị. · Nguồn: stored 23 §2.6

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| "Test này không liên quan, skip tạm" | Hồi quy lọt; cổng mất giá trị | Cấm skip; sửa hoặc hỏi |
| Re-run đến khi xanh | Che flake thật, tốn runner, bằng chứng giả | Trần 1 re-run; flake → issue |
| Sửa kỳ vọng của test cho khớp code sai, hoặc gắn `@flaky` cho test đỏ thật | Cổng xanh nhưng hồi quy lọt; lỗi bị "hợp thức hoá" | Hook hỏi khi test đã có bị bớt assertion/thêm skip; flake phải có hai run cùng SHA |
| Empty commit để kích lại CI | Lịch sử rác, ẩn lỗi cấu hình | Cấm theo `AGENTS.md` §3; hook `pre-bash-guard` deny `git commit --allow-empty`; dùng re-run của CI |
| Agent chạy trên PR từ fork với secret | Prompt injection từ PR lấy token | Kiểm actor; tách job ghi |
| `--bare` trong CI "cho nhanh" | Mất hook deny/ask, mất CLAUDE.md | Không `--bare`; truyền `--settings` |
| Thêm bí mật vào allowlist scanner để qua | Lộ bí mật được "hợp thức hoá" | Secret scan đỏ → dừng, xoay khoá |
| Sửa migration đã áp cho "khớp" | Môi trường lệch, không rollback được | Chỉ thêm migration mới |
| Nâng dependency major để hết CVE | Breaking change lặng lẽ | Minor/patch tự nâng; major → hỏi |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Chặn nới cổng | `pre-edit-guard.sh` (ask khi sửa eslint/tsconfig/coverage/workflows/migration, và khi test đã có bị thêm skip/only/xfail/`@flaky` hoặc bớt assertion); grep diff `skip(|xfail|\.only\(|eslint-disable` | PreToolUse Edit/Write/MultiEdit; job CI | 0 vi phạm không giải thích |
| Chặn lệnh phá huỷ | `pre-bash-guard.sh` deny `push --force`, `reset --hard`, `clean`; `settings.json` deny | PreToolUse Bash | Deny |
| Trần sửa cùng lỗi | `xt.py loop status --json` → `blocked` | Stop hook `stop-guard.sh` | `same_failure_count` ≥ 3 |
| Trần chi phí headless | `claude -p … --max-turns N --max-budget-usd X --output-format json` | Workflow | `total_cost_usd` ≤ X |
| Cổng commit | `scripts/dev-task.sh gate` (đọc `xt.yaml`) | Hook trước `git commit` | Exit 0 |
| Pin action | Linter workflow (vd `zizmor`/`actionlint`) | CI | 0 action chưa pin |

## Nguồn

- `AGENTS.md` §3 (không nới cổng, không force-push, không empty commit, không merge khi CI đỏ) và harness `.claude/hooks/pre-bash-guard.sh`, `pre-edit-guard.sh`, `.claude/settings.json` (deny/ask) — đọc 2026-10-13.
- Claude Code docs — headless (`--bare` bỏ hook/skill/CLAUDE.md; `--max-turns`, `--max-budget-usd`, `--output-format json`, `system/init` với `plugin_errors`/`mcp_server_errors`): <https://code.claude.com/docs/en/headless> · GitHub Actions (`claude-code-action@v1`, OIDC): <https://code.claude.com/docs/en/github-actions> — xác minh 2026-10-13 (`research/2026-10-13-claude-code-hooks-skills.md`).
- GitHub docs — `permissions` của `GITHUB_TOKEN` và rủi ro `pull_request_target`: <https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication> · <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions> — xác minh 2026-10-13.
- `seeker19110/stored` mục 21 §9 (self-healing CI: trần re-run, cấm skip test, safe-outputs tách job ghi, `author_association`), mục 23 §2.6 (DORA baseline trước tự trị) — đọc 2026-10-13 (`research/2026-10-13-stored-catalog-extraction.md`).
- Anthropic, *The AI-native SDLC playbook* (2026-08-21), stage 4 Test: hook chặn agent sửa file test trong task sửa lỗi để vòng kiểm không bị làm yếu; ví dụ stage 6 lại cho agent cách ly test flaky qua cổng review — khung chọn luật chặt hơn (cách ly = điểm dừng): <https://claude.com/blog/the-ai-native-sdlc-playbook> — xác minh 2026-10-16 (`seeker19110/stored` mục 21 §10c).
- Pin action theo SHA và kiểm supply chain: xem [`../12-security/supply-chain.md`](../12-security/supply-chain.md) (nhà của chủ đề).
