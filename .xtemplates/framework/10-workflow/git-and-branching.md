---
title: Git, nhánh, commit, PR nhỏ, lịch sử sạch
kind: module
prefix: WF-GIT
applies_to: [all]
updated: 2026-10-14
---

# Git, nhánh, commit, PR nhỏ, lịch sử sạch

> Trunk-based với nhánh ngắn, PR nhỏ, squash merge, Conventional Commits, **không ai push thẳng nhánh chính** —
> và bảo vệ nhánh là **code + máy kiểm**, không phải lời hứa: ruleset JSON trong repo, job guard đối chiếu rule
> đang áp qua API. Áp cho mọi loại dự án, kể cả một người.

## Nguyên tắc

1. **Trunk là nguồn sự thật, luôn phát hành được.** Nhánh sống ngắn (giờ–vài ngày), tích hợp về `main` ít nhất
   mỗi ngày; việc dở giấu sau feature flag thay vì nhánh dài.
2. **Thay đổi nhỏ, đảo ngược được (P8).** Một PR = một thay đổi logic, đọc được trong một lượt review; refactor
   tách khỏi feature/fix.
3. **Lịch sử là tài liệu.** Mỗi commit trên `main` là một đơn vị có nghĩa theo Conventional Commits → sinh
   CHANGELOG/phiên bản tự động; không "wip", "fix fix".
4. **Bảo vệ nhánh là cấu hình kiểm được.** Ruleset nằm trong repo, import vào GitHub; CI đỏ khi required check
   không khớp job thật và cảnh báo khi ruleset chưa hiệu lực trên nhánh mặc định.
5. **Hook local là tiện ích, CI là cổng.** `--no-verify` tồn tại; mọi kiểm ở hook phải chạy lại trong CI.

## Quyết định

| Câu hỏi | Chọn | Khi nào không |
|---|---|---|
| Mô hình nhánh | **Trunk-based + nhánh ngắn qua PR** (mặc định mọi quy mô) | Git-flow/nhánh `develop` dài chỉ khi phát hành theo phiên bản đóng gói nhiều bản song song (mobile store, thư viện) — ghi ADR |
| Cách merge | **Squash** (một PR = một commit conventional, lịch sử tuyến tính, hợp release-please) | Rebase-merge cho thư viện/monorepo cần giữ từng commit có nghĩa — **phải có ADR**, mọi commit phải conventional (ngoại lệ của `WF-GIT-005`); merge commit: không |
| Kích thước PR | ≤ ~400 dòng thay đổi (mức SmartBear/Cisco), lý tưởng ~100–200; > 1000 dòng → chia | Refactor tự động/sinh mã có thể lớn nhưng tách PR riêng, review theo diff ngữ nghĩa |
| Số approval | 0 khi repo **một người** (GitHub không cho tự duyệt → 1 approval = khoá vĩnh viễn); **≥ 1 ngay khi có người thứ hai**; 2 cho vùng nhạy cảm | Để 0 khi đã có ≥ 2 người |
| Bảo vệ nhánh | **Rulesets** (JSON import được, nhiều ruleset chồng, kiểm qua API) | Branch protection rule cổ điển chỉ khi nền tảng không có ruleset |
| Ký commit/tag | Ký SSH/GPG; bắt buộc (`required_signatures`) ở quy mô L hoặc repo công khai | Lưu ý rebase-merge trên GitHub không ký được → chọn squash |
| Nhánh phát hành | Không cần với web/dịch vụ deploy liên tục; cắt `release/x.y` ngắn cho sản phẩm đóng gói | — |

## Checklist

- [ ] `WF-GIT-001` **MUST** Không push thẳng nhánh chính; mọi thay đổi qua PR (kể cả một người, kể cả bot/agent). → Kiểm: ruleset nhánh mặc định có rule `pull_request`; `git log --merges`/`--first-parent main` không có commit ngoài squash PR. · Nguồn: GitHub Rulesets
- [ ] `WF-GIT-002` **MUST** Ruleset nhánh chính lưu dưới dạng code (`.github/rulesets/main.json`), gồm: cấm xoá, cấm force-push (`non_fast_forward`), `pull_request` (resolve thread, chỉ squash — hoặc rebase theo ngoại lệ có ADR của `WF-GIT-005`), `required_status_checks` trỏ tới các job có thật `quality`, `protection-guard`, `gitleaks`, `dep-audit`; `bypass_actors: []`. → Kiểm: file tồn tại; `GET /repos/{o}/{r}/rules/branches/main` chứa đủ 4 loại rule. · Nguồn: GitHub REST Rules, khung cũ `rulesets/main.json`
- [ ] `WF-GIT-003` **MUST** Job CI `protection-guard` **đỏ** khi required check trong ruleset không khớp tên job thật trong `.github/workflows/` (chống khoá nhánh do đổi tên job) và **cảnh báo** (không đỏ) khi ruleset chưa hiệu lực trên nhánh mặc định; dự án đã import ruleset đổi `::warning` thành `exit 1` để ép. → Kiểm: job tồn tại; test đổi tên job `quality` trong nhánh thử → guard đỏ; nhánh mặc định thiếu rule → log có `::warning`. · Nguồn: khung cũ `ci.yml` job `protection-guard` (commit `1b80fe4`)
- [ ] `WF-GIT-004` **MUST@L** Commit message và tiêu đề PR theo Conventional Commits 1.0.0 (`type(scope)!: mô tả`), subject ≤ 72 ký tự, `BREAKING CHANGE:` footer hoặc `!` cho thay đổi phá vỡ; kiểm bằng commitlint ở hook **và** CI (PR title + mọi commit). → Kiểm: `commitlint --from origin/main` trong CI exit 0; PR title lint. · Nguồn: Conventional Commits 1.0.0; catalog 23 §2.5 (TRAPS 58: squash lấy title)
- [ ] `WF-GIT-005` **MUST@L** Squash merge là phương thức mặc định và duy nhất bật ở repo (tiêu đề squash = tiêu đề PR conventional); tắt merge commit; bật tự xoá nhánh sau merge. Ngoại lệ duy nhất: **rebase-merge** cho thư viện/monorepo cần giữ từng commit — phải có ADR, mọi commit conventional, vẫn tắt merge commit. → Kiểm: ruleset `allowed_merge_methods: ["squash"]` (hoặc `["rebase"]`/`["squash", "rebase"]` khi có ADR trong `docs/adr/`); settings repo "Allow merge commits" tắt; `git log --merges main` rỗng. · Nguồn: release-please README (khuyến nghị squash); [`../05-architecture/decision-records.md`](../05-architecture/decision-records.md)
- [ ] `WF-GIT-006` **MUST@L** PR nhỏ: mục tiêu ≤ 400 dòng thay đổi (không tính lockfile/snapshot/sinh mã); vượt → tách hoặc ghi lý do trong PR và reviewer chấp nhận rõ ràng. → Kiểm: job CI tính `git diff --shortstat` loại trừ file sinh → cảnh báo > 400, đỏ > 1000 nếu không có nhãn `large-change-approved`. · Nguồn: SmartBear/Cisco (200–400 LOC), Google eng-practices Small CLs
- [ ] `WF-GIT-007` **MUST@L** Nhánh sống ngắn: tích hợp về `main` ≤ vài ngày; nhánh > 7 ngày không hoạt động bị cảnh báo/đóng; việc dở dùng feature flag ([`environments-and-config.md`](environments-and-config.md)). → Kiểm: job tuần liệt kê nhánh/PR > 7 ngày và đăng cảnh báo. · Nguồn: Trunk Based Development, DORA Working in small batches
- [ ] `WF-GIT-008` **MUST@L** Hook local (pre-commit: lint/format/type nhanh; commit-msg: commitlint) cài tự động khi `install`; mọi kiểm ở hook chạy lại ở CI vì hook có thể bị `--no-verify`. → Kiểm: `package.json`/`pre-commit-config` có hook; CI chạy cùng lệnh; test commit sai format local bị chặn. · Nguồn: pre-commit docs; catalog 13 §4c
- [ ] `WF-GIT-009` **MUST@L** Không rewrite history nhánh người khác, không force-push nhánh đã có PR mở có review (dùng `--force-with-lease` chỉ trên nhánh của mình trước review); không empty commit để kích CI. → Kiểm: ruleset chặn force-push `main`; review PR không có commit rỗng (`git log --format=%h --diff-filter=A` so với `--stat` rỗng). · Nguồn: AGENTS.md §3
- [ ] `WF-GIT-010` **MUST** `.gitignore` đủ (build, env, secrets, IDE, OS); không commit `.env`, khoá, dump dữ liệu; secret scan ở hook + CI toàn lịch sử theo [`../12-security/secrets-management.md`](../12-security/secrets-management.md). → Kiểm: `gitleaks git --log-opts="--all"` sạch; `.env` không có trong `git ls-files`.
- [ ] `WF-GIT-011` **MUST@L** Ít nhất một approval từ người khác tác giả khi repo có ≥ 2 người; `dismiss_stale_reviews_on_push: true`; vùng nhạy cảm (`.github/`, auth, payment, migration, CI/hook) có CODEOWNERS và `require_code_owner_review`. → Kiểm: ruleset `required_approving_review_count ≥ 1` + CODEOWNERS có mục cho các đường dẫn; guard kiểm số người cộng tác ≥ 2 → approval ≥ 1. · Nguồn: GitHub CODEOWNERS, khung cũ `CONTRIBUTING.md` (lý do 0 approval khi một người)
- [ ] `WF-GIT-012` **MUST@L** Commit và tag phát hành được ký (SSH/GPG/S/MIME) và ruleset `required_signatures`; vigilant mode cho maintainer. → Kiểm: `git log --show-signature -5 main` toàn "Good signature"/Verified; ruleset có rule. · Nguồn: GitHub commit signature verification
- [ ] `WF-GIT-013` **SHOULD** Tên nhánh `type/mô-tả-ngắn` (`feat/`, `fix/`, `chore/`, `docs/`), có mã issue/spec khi có; ruleset `branch_name_pattern` nếu cần. → Kiểm: regex trong ruleset hoặc hook.
- [ ] `WF-GIT-014` **SHOULD** PR template có: mục tiêu, link spec/issue, cách xác minh (lệnh + kết quả), rủi ro/rollback, checklist DoD; PR `feat` link spec đã duyệt ([`spec-driven-development.md`](spec-driven-development.md)). → Kiểm: `.github/pull_request_template.md` tồn tại; `pr-policy` job kiểm mục bắt buộc.
- [ ] `WF-GIT-015` **SHOULD** Lịch sử tuyến tính: `required_linear_history` bật; `git pull --rebase` mặc định cho nhánh cá nhân. → Kiểm: ruleset có rule; `git config pull.rebase true` trong hướng dẫn onboarding.
- [ ] `WF-GIT-016` **SHOULD** Monorepo: CODEOWNERS theo thư mục; CI chỉ chạy phần bị ảnh hưởng (affected) nhưng cổng `quality` vẫn là một required check gom. → Kiểm: workflow dùng path filter/affected; không thêm required check rời cho job con.
- [ ] `WF-GIT-017` **SHOULD** Dependabot/Renovate gom nhóm (`groups`/`multi-ecosystem-groups`), lịch tuần, `open-pull-requests-limit` phù hợp WIP cap ([`team-and-wip.md`](team-and-wip.md)); bản vá bảo mật tách riêng. → Kiểm: `dependabot.yml` có `groups` và limit; xem [`../01-baseline/dependencies.md`](../01-baseline/dependencies.md). · Nguồn: Dependabot options reference
- [ ] `WF-GIT-018` **MAY** Merge queue khi > ~10 PR/ngày vào một nhánh; CI phải lắng nghe `merge_group`. → Kiểm: workflow có trigger `merge_group`; ruleset `merge_queue`. · Nguồn: GitHub Merge queue
- [ ] `WF-GIT-019` **MAY** Stacked PR (chuỗi PR nhỏ phụ thuộc) cho thay đổi lớn; mỗi PR vẫn qua cổng và merge FIFO. → Kiểm: PR base trỏ nhánh trước; sau merge rebase lên `main`.
- [ ] `WF-GIT-020` **MAY** Worktree riêng cho mỗi task khi chạy nhiều agent song song; nhánh A (một remote branch cho việc lớn) là mặc định, nhánh B chỉ khi song song thật không chồng path. → Kiểm: hướng dẫn trong [`../11-autonomous-loop/orchestration-and-subagents.md`](../11-autonomous-loop/orchestration-and-subagents.md). · Nguồn: catalog 23 §4.5

## Bẫy thường gặp

- **1 approval trên repo một người.** GitHub không cho tự duyệt, `bypass_actors` rỗng → mọi PR khoá vĩnh viễn, kể cả PR sửa ruleset (đã xảy ra thật, khung cũ `CONTRIBUTING.md`). Lối thoát: đổi enforcement sang Disabled trong Settings, merge, bật lại.
- **Đổi tên job CI mà quên ruleset.** Required check không bao giờ xuất hiện → `main` khoá vĩnh viễn trong khi CI xanh. Guard đối chiếu tên job ↔ ruleset bắt ngay ở PR đổi tên.
- **Squash lấy message commit đơn thay vì title PR.** PR một commit không conventional → CHANGELOG sai (TRAPS 58). Lint cả title PR lẫn commit.
- **Nhánh dài "để làm cho xong".** Conflict khổng lồ, review không nổi, mất 2 ngày merge. Flag + lát dọc nhỏ.
- **`git push --force` lên nhánh có người khác đang review.** Mất review/commit của họ. `--force-with-lease`, chỉ trước review.
- **Hook pre-commit nặng (test toàn bộ 5 phút).** Dev dùng `--no-verify` thành thói quen. Hook chỉ việc < 10 giây; nặng để CI.
- **"Allow merge commits" vẫn bật.** Một lần bấm nhầm → lịch sử phi tuyến, release-please hỏng. Tắt ở settings và ruleset.
- **Strict "up to date" bật với nhiều PR mở.** Mỗi merge bắt mọi PR khác rebase + chạy lại CI. Dùng `strict: false` + merge FIFO, hoặc merge queue khi lưu lượng cao.
- **Rebase-merge với yêu cầu ký commit.** GitHub không ký hộ khi rebase → merge bị chặn. Chọn squash.
- **Mâu thuẫn nguồn về kích thước PR:** Google nói ~100 dòng hợp lý/1000 quá lớn, SmartBear nói 200–400 dòng; khung lấy **≤ 400 cảnh báo, > 1000 chặn** — hai ngưỡng máy kiểm, lý do ghi ở đây.

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| commitlint (MIT) @commitlint/cli 21.2.3 + config-conventional | `commitlint --edit` (hook commit-msg) · `commitlint --from origin/main --to HEAD` (CI) · lint PR title | hook + CI | 0 lỗi |
| Hook manager | husky 9.1.7 (MIT) / lefthook 2.2.1 (MIT, đa ngôn ngữ) / pre-commit 4.7.0 (MIT, Python) + lint-staged 17.6.0 | local | Hook < 10 s |
| protection-guard | so `required_status_checks` trong `.github/rulesets/main.json` với tên job từ `.github/workflows/*.yml`; `curl $API/repos/$R/rules/branches/$BRANCH` kiểm rule đang áp | CI (required) | Đỏ khi required check không khớp job; cảnh báo khi thiếu rule (đổi `::warning` thành `exit 1` để ép) |
| PR size | `git diff --shortstat origin/main...HEAD -- . ':!*.lock' ':!**/__snapshots__/**'` | CI | > 400 cảnh báo, > 1000 đỏ trừ nhãn duyệt |
| pr-policy | script kiểm title conventional, mục bắt buộc trong body, `feat` có link spec, WIP cap | CI | Đỏ khi thiếu |
| Secret scan | gitleaks v8.30.1 (MIT) `gitleaks git --log-opts=--all` | hook (`protect`) + CI | 0 |
| Nhánh cũ | job cron tuần: `gh pr list --state open --json createdAt` → cảnh báo > 7 ngày | CI schedule | Thông báo |
| Chữ ký | `git log --show-signature`; ruleset `required_signatures` | CI (L) | 100% verified |

## Nguồn

- Conventional Commits 1.0.0: <https://www.conventionalcommits.org/en/v1.0.0/> — xác minh 2026-10-13
- Trunk Based Development: <https://trunkbaseddevelopment.com/> — xác minh 2026-10-13
- Google Engineering Practices — Small CLs (~100 dòng hợp lý, ~1000 quá lớn): <https://google.github.io/eng-practices/review/developer/small-cls.html> — xác minh 2026-10-13
- SmartBear — Best Practices for Peer Code Review (200–400 LOC, ≤ 500 LOC/giờ, ≤ 60 phút): <https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/> — xác minh 2026-10-13
- GitHub — About rulesets: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets> · Managing rulesets (import JSON): <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/managing-rulesets-for-a-repository> · REST Rules (`GET /repos/{owner}/{repo}/rules/branches/{branch}`, rule types): <https://docs.github.com/en/rest/repos/rules> — xác minh 2026-10-13
- GitHub — About protected branches (strict up-to-date, linear history, signed commits, bypass): <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches> — xác minh 2026-10-13
- GitHub — About code owners: <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners> — xác minh 2026-10-13
- GitHub — About commit signature verification (rebase-merge không ký): <https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification> — xác minh 2026-10-13
- GitHub — Managing a merge queue (`merge_group`): <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue> — xác minh 2026-10-13
- Dependabot options reference (`groups`, `multi-ecosystem-groups`, `open-pull-requests-limit` mặc định 5): <https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference> — xác minh 2026-10-13
- pre-commit (chạy lại trong CI, `--no-verify`): <https://pre-commit.com/> — xác minh 2026-10-13
- Phiên bản (npm/PyPI, xác minh 2026-10-13): @commitlint/cli 21.2.3, husky 9.1.7, lefthook 2.2.1, lint-staged 17.6.0, pre-commit 4.7.0, gitleaks v8.30.1 — xác minh lại trước khi dùng.
- Khung cũ X-stored commit `1b80fe4`: `.github/workflows/ci.yml` (job `protection-guard`), `.github/rulesets/main.json`, `CONTRIBUTING.md` (lý do approval = 0).
- `research/2026-10-13-stored-catalog-extraction.md` §2.7, §4 (WIP cap 3, subject ≤ 72, TRAPS 58); catalog `23-own-repos-lessons` §2.5, §4.5.
