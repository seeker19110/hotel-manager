---
title: Trần phát triển của khung với công nghệ hiện tại — đơn giản · chất lượng · tốc độ
kind: research
updated: 2026-10-23
---

# Khung X-Templates phát triển được đến đâu với công nghệ hiện tại? — nghiên cứu 2026-10-23

Đầu vào: câu hỏi chủ repo 2026-10-23 *"dự án khung này có thể phát triển đến mức nào với công nghệ hiện tại, giữ mục tiêu
đơn giản, chất lượng cao, phát triển phần mềm nhanh nhất"*. Khung ở 3.15.6 (`59e0731`), pha `harden`, vừa xong PLAN-3.16
(audit delta, `release-check` GO trừ chữ ký người).

Cách đọc: §1 kết luận · §2 cách làm · §3 số đo thật (P1) · §4 luận điểm trụ / bị bác · §5 phát hiện mới · §6 trần cứng ·
§7 ba chặng · §8 không làm · §9 chưa xác minh · §10 nguồn. Kế hoạch suy ra: `docs/autopilot/PLAN-3.16.0-ceiling.md` (D-142).

## 1. Kết luận

- **Khung đã sát trần của mô hình "một người · một phiên · một nhánh · GitHub + Claude Code" về tốc độ.** 174 PR merge
  trong 7 ngày, lead time trung vị 9,4 phút, khoảng cách giữa hai lần merge trung vị 19,3 phút (≈ 3 PR/giờ). Thứ chiếm
  phần lớn một lát là lượt model, không phải CI (94–162 s) hay hook (≈ 150 ms/lệnh) — và lượt model **chưa đo được**
  (`.autopilot/` là trạng thái cục bộ; `loop stats` trên clone này = 0).
- **Dư địa còn lại không nằm ở thêm tính năng.** Ba việc: (a) cắt lãng phí máy tự gây — ¾ số run CI bị huỷ là chạy lại
  *cùng commit* vì sự kiện `edited`; ba commit mới nhất trên `main` chưa qua CI; (b) chuyển "chất lượng" từ hình thức
  (validate/coverage xanh) sang nội dung (nguồn có ngày, MUST có lệnh kiểm, bằng chứng do máy chạy); (c) đo ở dự án đích
  trước khi nói "nhanh nhất".
- **"Đơn giản" đang thua và repo tự thừa nhận**: `xt.py` 3.682 → 10.586 dòng trong ~1 tuần, `guard.py` 6.170 dòng, 42 ADR
  trong 10 ngày, nhịp 7–8 bản phát hành/ngày. Vượt trần tốc độ (nhiều phiên/worktree song song, người thứ hai, hàng rào
  ngoài Claude Code) đều trả giá bằng đơn giản — nên **chặng tới là đóng băng bề mặt và cắt**, không mở rộng.

## 2. Cách làm (để tái lập)

Workflow 44 agent, 6 pha, chạy 2 lần (lần 1 hết hạn mức phiên giữa pha 5, lần 2 nối lại từ cache): 7 người đọc theo mảng
(method · harness · tooling · ADR · ops · thư viện · dự án đích) → 3 tra cứu nguồn sống (Claude Code, GitHub, agentic SWE)
→ 5 góc đề xuất độc lập (tối giản · chất lượng · tốc độ · hoài nghi · áp dụng) → 3 giám khảo + tổng hợp → **8 luận điểm
then chốt, mỗi luận điểm 3 người phản biện độc lập cố bác bỏ** (bằng chứng trong repo · khả thi với công nghệ · nhất quán
mục tiêu) → soát thiếu. Luận điểm trụ khi ≤ 1/3 phiếu bác. Kết quả: 4 trụ, 4 bị bác (§4). Mọi số đo của §3 do ≥ 2 agent
tái lập độc lập qua REST hoặc do phiên chính chạy lại; số chỉ một nguồn ghi rõ ở §9.

## 3. Số đo thật (2026-10-23, HEAD `59e0731`)

| Số đo | Giá trị | Nguồn |
|---|---|---|
| Thư viện | 186 file `.md`, 2.751 mục (MUST 1.533 · SHOULD 848 · MAY 370), 119 module, 14 hồ sơ, 8 gói ngành, `framework/` 2,6 MB | `xt.py validate`, `du`, `grep` |
| Mã | `xt.py` 10.586 dòng · `guard.py` 6.170 · `install.py` 1.172 · `xt_app` ~1.300 | `wc -l` |
| Quyết định | 42 ADR (2026-10-13 → 22), 3 bị thay toàn bộ; D-001…D-141 | `docs/adr/`, `DECISIONS.md` |
| Nhịp phát hành | 8 bản ngày 18/10, 7 ngày 19/10, 7 ngày 22/10 (3.15.0 → 3.15.6) | `CHANGELOG.md`, `git log` |
| PR 7 ngày (174 merge từ 2026-10-16) | lead trung vị 9,4 phút · P95 1,58 h; 1 push 42–43 % (lead 3,4 phút) · ≥ 2 push 57–58 % (19,2–19,6 phút) | REST `pulls` + `actions/workflows/ci.yml/runs` |
| Xanh lần đầu | push đầu **không** đỏ 84 %; chỉ 17 % PR từng có run đỏ; 75 % PR ≥ 2 push chưa bao giờ đỏ (push lại do review/cập nhật nhánh) | như trên |
| Run CI bị huỷ | 83–84/≈440 run 7 ngày; **57–62 cùng head SHA** (re-trigger sau 11–53 s), chỉ 22–23 do push mới; 40 % PR chạy CI ≥ 2 lần cho cùng SHA; ≈ 100 phút runner | như trên; ví dụ PR #224 run 39736564081 huỷ 06:51:14 → 39736587650 xanh 06:51:28, SHA `e895c449` |
| Wall CI | 94,5 s trung vị 20 run xanh (đo 10-21) → trung vị 7 ngày 136 s → **162 s ngày 10-22** (n = 26, max 336 s) sau job `app-e2e` (#210) | `docs/ops/CI-TIMING-2026-10-21.md`, REST |
| `pr stats` | `runs_seen: 1000` trong khi API `total_count` = 1.529 → 62/174 PR ghi `runs: 0` (trần 1.000 của listing) | `scripts/xt.py` quanh dòng 5296 (`GH_MAX_PAGES`), 8931 |
| Steward | cron `*/10` thực chạy n = 8 lần/7 ngày, cách nhau trung vị 238,6 phút; 2 lượt trả `wait` khi check đã xong (#207, #208 chờ 2,57 h) | `gh run list --workflow pr-steward.yml`; run 39619253401, 39630751648 |
| Ruleset sống `main` | `strict: false`; required = quality · protection-guard · dep-audit · gitleaks (không còn `merge-gate`); 0 approval; bypass rỗng | `gh api repos/seeker19110/X-Templates/rules/branches/main` |
| CI trên `main` | run `push` gần nhất `1139662` (#226, 2026-10-22T09:28Z); `15a8c11` #227 · `9e1d6f3` #228 · `59e0731` #229 **không có run** | REST `actions/workflows/ci.yml/runs?event=push&branch=main` |
| Chất lượng nội dung | 58 MUST của `BLUEPRINT.md` tick không có lệnh kiểm (chỉ in ℹ); `validate` chỉ kiểm *có* mục `## Nguồn`; 940 dấu "xác minh 2026-10-13", 189 "(chưa xác minh"; 0 ca `adversarial-reviewer` | `docs/ops/GO-NO-GO-2026-10-22.md` §2b, `scripts/xt.py` `_check_sections`, `docs/ops/AUTONOMY-BASELINE.md` §5 |
| Vòng phản hồi | `docs/ops/TARGETS.md` 1 dòng; Routine tuần không tồn tại (`list_triggers` rỗng); LOOP-FB-001…005 chưa tick | `framework/11-autonomous-loop/framework-feedback.md` |

## 4. Luận điểm: trụ và bị bác

| # | Luận điểm | Phiếu bác | Kết quả |
|---|---|---|---|
| C1 | Nút thắt là vòng push lại (36 % xanh lần đầu, 27 % run huỷ do push đè) | 3/3 | **Bác**: số lấy từ `pr stats` bị cắt ở 1.000 run; đếm đủ → 84 % push đầu không đỏ; huỷ chủ yếu cùng SHA (`edited`) |
| C2 | "Đơn giản" đang thua và tự thừa nhận | 0/3 | **Trụ** (đính chính số nhỏ: mục dài nhất 4.258 ký tự, 15–17 ADR về merge) |
| C3 | Chất lượng mới cưỡng chế ở hình thức, nội dung còn lời khai | 1/3 | **Trụ**; phản chứng đúng: `release-check` FAIL khi lệnh Kiểm đỏ, `stale_evidence` đã bắt 9 lệch + 3 sai, `links.yml` quét URL tuần — máy kiểm *hành vi*, chưa kiểm *nội dung* |
| C4 | Review LLM F1 0,066 là trần; làn review sạch không chạy | 3/3 | **Bác**: số của 5 model nhỏ/50 PR, preprint; làn review đang chạy (10 PR #220–#229 có `xt-review v1 clean` đúng head) |
| C5 | Đuôi lead time do chờ người/GitHub; chưa được bỏ `strict` khi chưa có token | 3/3 | **Bác**: 81 % đuôi là việc của phiên; ruleset sống đã `strict: false` — file và PROGRESS cũ |
| C6 | Cưỡng chế chỉ sống trong Claude Code, có hạn sử dụng | 1/3 | **Trụ** (là lựa chọn có chủ đích ADR-0002; LOOP-DESIGN-014 chưa có lịch xét lại) |
| C7 | Chi phí nâng bản × số repo × số bản × bước tay | 3/3 | **Bác**: `install.py` gộp mọi bản trong một lần chạy (3.13.0 → 3.15.6 còn 12 mệnh đề); chi phí theo số *lần* nâng |
| C8 | Bus factor = 1; luật sinh nhanh hơn luật được kiểm | 1/3 | **Trụ** (0 approval là thiết kế cho repo một người — WF-GIT-011; `bypass: []` là chặt hơn) |

## 5. Phát hiện mới (từ phản biện và soát thiếu — đều kiểm lại trực tiếp)

1. **`edited` tự huỷ CI của chính mình.** `.github/workflows/ci.yml` dòng 9 có `edited` (để chạy lại kiểm tiêu đề trong job
   `quality`); dòng 16–18 `cancel-in-progress` theo PR. Máy chủ MCP sửa thân PR ngay sau khi mở (chân trang) → `edited`
   → run `opened` bị huỷ và chạy lại cùng SHA. Hệ quả §3. Sửa = tách kiểm tiêu đề ra workflow vài giây, bỏ `edited`
   khỏi CI nặng (cả mẫu `framework/templates/ci.yml` dòng 20).
2. **Commit trên `main` không qua CI.** Steward merge bằng `GITHUB_TOKEN` → không kích workflow `push` (docs GitHub, §10);
   `strict: false` sống → commit squash chưa từng chạy CI trên base mới nhất. `pr-steward.yml` dòng 17–23 đã mô tả, đợi
   `XT_STEWARD_TOKEN`. Đường máy làm được: `GITHUB_TOKEN` **được** tạo `workflow_dispatch` → steward gọi dispatch CI trên
   `main` sau merge.
3. **File ruleset và PROGRESS cũ hơn ruleset sống**; `protection-guard` chỉ `::warning` khi so API sống nên trôi không đỏ.
4. **CI vừa tăng +70 %/run** (94,5 → 162 s) sau `app-e2e` cài Playwright mỗi run — không cache là chủ ý (D-133, docs
   Playwright), nhưng số 94,5 s trong tài liệu không còn đúng.
5. **Steward trả `wait` giả** cho #207/#208 khi check đã `completed`, không có sự kiện kích lại → #208 chờ 2,57 h.
6. **`check-links.py` ở dự án đích bỏ qua `.xtemplates/`** → link `framework → research` trong bản cài vỡ im lặng (chỉ
   `lint` repo khung bắt).
7. **`claude_min_version`** có trong mẫu `framework/templates/xt.yaml` dòng 43 và `doctor` (LOOP-HARNESS-026) nhưng `xt.yaml`
   của repo khung chưa khai; LOOP-DESIGN-014 (xét lại hàng rào 90 ngày) không có lịch trong PROGRESS.

## 6. Trần cứng (không mở được bằng mã)

- **Một phiên, một nhánh** (ADR-0009): phiên chính `loop record` từng Gate + một PR/lát + CI ⇒ ~3 PR/h thực đo; trần lý
  thuyết ≈ 10 PR/h. Vượt = song song worktree/nhiều phiên — token ước ~15× (research 2026-10-21), chưa đo, và thêm
  phức tạp điều phối.
- **Merge queue không có cho repo thuộc tài khoản cá nhân** (docs GitHub, §10); `GITHUB_TOKEN` không thêm PR vào queue →
  tuần tự hoá merge mãi là việc của `pr next`/steward + ruleset.
- **Hàng rào sống trong một CLI độc quyền**: 33 sự kiện hook của Claude Code (docs 2026-10-23), `--bare` sẽ thành mặc
  định của `-p`, `onFailure: block` từ 2.1.295, `-p` khởi động Manual từ 2.1.302; agent khác chỉ đọc AGENTS.md. Luật hook
  phải xét lại theo phiên bản.
- **Verifier gap là trần công nghệ**: thư viện tự chạy được 0 mục (Kiểm là mô tả); G0/G2/G3/G4/G8 chỉ có mẫu; METR
  2026-03-10: PR qua SWE-bench vẫn bị maintainer từ chối với tỉ lệ đáng kể; Sonar 2026-01: 96 % dev không tin hoàn toàn
  mã AI đúng chức năng. G7 vẫn cần người ký.
- **Vật lý ngữ cảnh**: blueprint M ≈ 229 KB (CHANGELOG 1198), thư viện 2,6 MB để *ghép* không để *đọc*; SessionStart gần
  trần 12 KB. Thêm mục/thêm ngữ cảnh vào hook chỉ làm tệ hơn.
- **Một người bảo trì**: mọi điểm "cần người" (token, ruleset 2 repo đích, App reviewer) hội tụ về một người; 4 repo đích
  → ~5 repo cùng loại là trần thực tế nếu chi phí nâng bản không về gần 0.

## 7. Ba chặng

| Chặng | Làm | Giới hạn |
|---|---|---|
| Tháng tới (PLAN-3.16.0) | §5 mục 1–3, 5, 7 bằng cấu hình/sửa nhỏ; checker Nguồn (≈ 1 regex; 134/135 module đã đạt); `unchecked_must` có cờ `fail` cho harden; trần tổng byte thư mục do CI giữ; `pr stats` đếm push theo head SHA và vượt trần 1.000; TARGETS/feedback | Không thêm lệnh/hook/module/hồ sơ; không bật song song worktree; không thu nhỏ guard |
| 2–3 tháng | Đo 30 ngày ở ≥ 2 repo đích (xanh lần đầu, PR bị người sửa sau merge, run huỷ, tuần chậm bản); gỡ 10 hàm private `xt_app` → `xt.py` (AUD-ARCH-003) rồi mới bàn tách; gộp 11 ADR merge bị 0036 đổi thành một trang chỉ mục; xét lại hàng rào theo LOOP-DESIGN-014 | 3–4 PR/h là mục tiêu, không hơn; reviewer LLM chỉ ở `merge_risk_paths` |
| Trần | Giữ: L3 một nhánh một phiên, subagent sâu 1, merge ghim head dưới ruleset, stdlib-only, guard một file, tiếng Việt, GitHub-only | Mọi lát mới trả lời "ai bảo trì nếu tác giả nghỉ 30 ngày" |

## 8. Không làm (và vì sao)

- Tách `xt.py` thành gói: AUD-ARCH-003 (xt_app gọi 10 hàm private) và danh sách copy của `install.py` làm việc này rủi ro
  hơn giá trị khi chưa có trần byte giữ kích thước không mọc lại.
- Song song worktree nhiều lát, agent teams, mods: thử nghiệm hoặc tốn token chưa đo; subagent worktree không nạp đủ ngữ
  cảnh (chưa xác minh — §9).
- Thêm vòng review LLM cho mọi PR; Copilot code review làm "reviewer khác họ" (docs: "mix of models", không chọn model).
- Xoá stub `merge-gate.yml`: ruleset X-Templates đã gỡ context, nhưng stub vẫn phát cho dự án đích tới khi hotel-manager
  và X-Company gỡ (T-1834) — xoá sớm làm PR ở đó treo.
- Thu `guard.py` về nhỏ dựa vào bộ phân loại Auto: docs ghi Auto "does not guarantee safety".
- Thêm module/ID; dịch sang tiếng Anh; cache Playwright (D-133).

## 9. Chưa xác minh / giới hạn của phân tích

- "Tự động hoá 95–98 %" trong bản tổng hợp của agent **không có nguồn** — bỏ khỏi kết luận; AUTONOMY-BASELINE §5 ghi chưa
  đo tỉ lệ tự hoàn tất.
- Thời lượng một lát và tỉ trọng lượt model: không có số (`.autopilot/` cục bộ, `loop stats` = 0 trên clone).
- Trạng thái PR nâng bản ở dự án đích (API 403 từ phiên); `XT_STEWARD_TOKEN` suy từ `XT_STEWARD_UPDATE: off` trong log.
- Ngưỡng bộ phân loại Auto, "Codex cắt AGENTS.md 32 KiB", "subagent worktree không nạp CLAUDE.md gốc", token ×12–15 cho
  song song — chỉ từ nguồn tổng hợp hoặc chưa có nguồn.
- Số đo CI/REST đo trên clone nông 50 commit, cửa sổ 7 ngày; `gh api --paginate`/GraphQL bị proxy chặn → phân trang tay.
- Nguyên nhân `edited` quy cho chân trang do máy chủ MCP gắn: suy từ SHA không đổi + PROGRESS/harness-files ghi, chưa đọc
  payload sự kiện.

## 10. Nguồn (xác minh 2026-10-23 trừ khi ghi khác)

- GitHub — `GITHUB_TOKEN` không tạo workflow run, trừ `workflow_dispatch`/`repository_dispatch`:
  https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
- GitHub — merge queue chỉ cho repo public của tổ chức hoặc private Enterprise Cloud:
  https://docs.github.com/en/pull-requests/concepts/deploying-code · `GITHUB_TOKEN` không thêm PR vào queue:
  https://docs.github.com/en/code-security/dependabot/working-with-dependabot/automating-dependabot-with-github-actions
- GitHub — concurrency/cancel-in-progress:
  https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency ·
  retention check/run repo public ≤ 90 ngày (changelog 2026-10-01):
  https://github.blog/changelog/2026-10-01-actions-retention-now-covers-checks-runs-and-statuses/ · async merge API GA
  (2026-10-01): https://github.blog/changelog/2026-10-01-github-async-merge-api-generally-available/
- GitHub — Copilot code review "mix of models", không chọn model: https://docs.github.com/en/copilot/concepts/agents/code-review
- Claude Code — hooks (33 sự kiện, exit 2/`permissionDecision`): https://code.claude.com/docs/en/hooks · permission modes
  (Auto "does not guarantee safety"; `defaultMode: auto` trong settings dự án không có tác dụng):
  https://code.claude.com/docs/en/permission-modes · headless (`-p` Manual từ 2.1.302; `--bare` sẽ thành mặc định):
  https://code.claude.com/docs/en/headless · context window (sau compaction chỉ nạp lại CLAUDE.md gốc, rules, memory):
  https://code.claude.com/docs/en/context-window · changelog (onFailure block 2.1.295; 2.1.309 ngày 2026-10-22):
  https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md · sub-agents (độ sâu mặc định 3):
  https://code.claude.com/docs/en/sub-agents · agent teams (thử nghiệm): https://code.claude.com/docs/en/agent-teams
- Agentic SWE — METR, PR qua SWE-bench không được merge (2026-03-10):
  https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/ · METR uplift RCT
  (2026-02-24): https://metr.org/blog/2026-02-24-uplift-update/ · Epoch đánh giá SWE-bench Verified/Pro "Flawed"
  (2026-09): https://epoch.ai/benchmarks/swe-bench-verified/review · Terminal-Bench 3.0 (2026-07-30):
  https://www.tbench.ai/news/terminal-bench-3-0 · Sonar verification gap (2026-01-08):
  https://www.sonarsource.com/company/press-releases/sonar-data-reveals-critical-verification-gap-in-ai-coding/ ·
  "Reality Is the Final Verifier" (arXiv 2609.12039, 2026-09-10): https://arxiv.org/abs/2609.12039 · review LLM F1 thấp
  trên PR thật (arXiv 2606.15689, preprint, 5 model nhỏ): https://arxiv.org/abs/2606.15689
- Chuẩn — MCP 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/changelog · OWASP GenAI LLM Top 10
  2026 (2026-08-03): https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/ · EU AI Act Đ.50 áp dụng 2026-08-02
  (số điều/phạt chưa đối chiếu bản gốc).
- Trong repo: `docs/ops/CI-TIMING-2026-10-21.md`, `docs/ops/GO-NO-GO-2026-10-22.md`, `docs/ops/AUTONOMY-BASELINE.md`,
  `docs/adr/0036-pinned-merge-no-auto-merge-drop-merge-gate.md`, `docs/adr/0037-reviewers-only-in-harden.md`,
  `2026-10-21-next-level-speed-automation-quality.md` (nghiên cứu trước, số CI 92–94 s lúc đó).
