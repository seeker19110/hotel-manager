---
title: Phân tích khung cũ X-stored (commit 1b80fe4)
kind: research
updated: 2026-10-13
---

# Báo cáo phân tích khung cũ X-stored (`scratchpad/old`, 104 file)

## 1. Kiến trúc tổng thể

**Cấu trúc thư mục & luồng liên kết**

```
CLAUDE.md (109 dòng, "luật vận hành", 15 TRIGGER)  ──►  docs/framework/ (9 file, ~2.9k dòng)
   │                                                  01 quy trình · 02 luật AI+mẫu · 03 chọn công nghệ
   │                                                  runbook · adoption · completion · quality-supplements
   │                                                  models-and-automation · case-study · README (chỉ mục)
   ├──► .claude/commands/ (10 slash: consult, bootstrap, auto, gate, adr, ui-ux,
   │        audit-optimize, audit-full, completion, incident) — mỗi command là "wrapper mỏng"
   │        trỏ về đúng file docs/ và nhắc ràng buộc bất biến
   ├──► .claude/agents/ (lookup·version-check = Haiku, executor = Sonnet)
   ├──► .claude/settings.json + hooks/ (4 sự kiện) ──► scripts/dev-task.sh (lớp trung gian đa-stack)
   ├──► docs/ops/ (incident-response, 2 prompt audit, baseline Đ0)  ·  docs/adr/ (0000–0003)
   ├──► docs/specs/AI-HARNESS-AND-COMPANY-SPEC.md (2487 dòng, SPEC-AI-100 — tài liệu riêng)
   ├──► .github/ (5 workflow, rulesets/main.json, PR/issue template, CODEOWNERS, dependabot)
   └──► Lớp 2 scaffold web (eslint/prettier/vitest/playwright/lighthouserc/lib/env.ts/styles/theme.css/app/*/supabase/*)
copy-framework.sh/.ps1: Lớp 1 copy thẳng, file gốc copy-if-absent (.framework-new), Lớp 2 vào _framework-dropins/
```

**Triết lý cốt lõi (nhất quán xuyên suốt, là tài sản lớn nhất):**
- **9 giai đoạn + cổng** (`01-process-and-standards.md`): GĐ0 ý tưởng → GĐ8 sau ra mắt, mỗi GĐ có "Cổng" + "Đầu ra"; 7 nguyên tắc nền; **ba tầng phòng thủ** (AI kỷ luật → hook cục bộ → CI+branch protection).
- **Research-first** (`03-tech-selection…` Nguyên tắc số 1): không đề xuất phiên bản theo trí nhớ, xác minh nguồn sống, ghi ngày; 19 khía cạnh đề xuất chủ động (PHẦN A); heuristic "proven/boring ở lõi, cách tân 1 chỗ".
- **ADR** không sửa cũ, đổi ý viết mới (`docs/adr/0000-template.md`; ADR-0003 là ví dụ rất tốt).
- **Chống ảo giác** (CLAUDE.md §4, KHUNG-2): đọc file thật, chạy lệnh thật, với brownfield "không hỏi điều đã có trong code".
- **Báo cáo xác thực** trước commit/merge (CLAUDE.md §7, KHUNG-2 mẫu dài) + **có ❌ thì không commit**.
- **Chủ động góp ý là BẮT BUỘC** (CLAUDE.md §2) và **dừng-và-hỏi** (§9) — được tất cả command/agent nhắc lại.
- **opusplan** (`models-and-automation.md`): Opus plan → Sonnet code → Haiku subagent; "kỷ luật vận hành" §5 (plan một lần, ngữ cảnh gọn, phiên ngắn) được coi là cần tiết kiệm token lớn nhất.
- **Hai lớp** (`existing-project-adoption.md`): Lớp 1 quy trình áp mọi stack; Lớp 2 file cấu hình chỉ cho stack Next/Supabase/Vercel.
- **Bằng chứng, không cảm giác** (`project-completion.md`, spec §B1): truy vết F-xxx → W-xxx → PR → bằng chứng; "cổng chỉ đạt/không đạt".

## 2. Danh mục nội dung đã có

| Chủ đề | File | Độ sâu | Điểm mạnh |
|---|---|---|---|
| Quy trình 9 GĐ + cổng + DoD/DoR | `docs/framework/01-process-and-standards.md` | **Sâu** | Checklist từng GĐ, bảng thời gian, ba tầng phòng thủ |
| Luật AI, 2 cổng commit/merge, mẫu PROJECT.md, quy trình sinh file | `02-ai-rules-and-project-template.md` | Vừa | Mẫu báo cáo xác thực đầy đủ; sơ đồ quan hệ file |
| Chọn công nghệ research-first, 19 khía cạnh, B2 tiêu chí, B4 quy tắc phiên bản | `03-tech-selection-and-proactive-advice.md` | **Sâu** ở phương pháp | Heuristic cân bằng phổ biến↔năng lực rất thực dụng |
| Hồ sơ loại dự án C1–C10 | `03-…` PHẦN C | **Nông** (C1 sâu; C2–C10 mỗi cái 1 bảng 3–5 dòng) | Có "cổng tương đương" cho mỗi hồ sơ |
| Runbook greenfield (0→9) + Phần D 14 bước hàng rào + Phần E dự án thật | `new-project-runbook.md` (728 dòng) | **Sâu** (web) | Cấu hình copy được; đã chạy thật (case-study) |
| Brownfield: tự dò stack, hàng rào tăng dần, bản đồ "dùng ngay vs thay" | `existing-project-adoption.md` | Vừa–sâu | Bảng "đọc gì → suy ra gì" rất tốt |
| Hoàn thiện dự án: FEATURE-MAP, CONVENTIONS, COMPLETION-PLAN, vòng hội tụ, DoC | `project-completion.md` | **Sâu** | Truy vết F→W→PR; 3 mẫu file trạng thái; tiêu chí thoát rõ |
| Quality Nhóm 1 (env, migration Supabase, PR template, ADR, npm audit, Vercel staging, DoR) | `quality-supplements.md` PHẦN 1 | Vừa | Giải thích đúng "rollback" của Supabase |
| Quality Nhóm 2 (mobile-first, CWV/Lighthouse, a11y 2 tầng, E2E+coverage, 4 trạng thái UI, **chống lỗi logic**, Sentry, tối ưu mã nguồn) | PHẦN 2 | **Sâu** | Mục 6 (lỗi logic) và mục 9 (refactor không đổi hành vi) rất giá trị |
| Theme Dark blue + Light, tokens, no-flash, toggle | PHẦN 3 + `styles/theme.css` + `components/theme-toggle.tsx` | Vừa | Có code dùng ngay, nối Tailwind v4 `@theme inline` |
| i18n/PWA/Sentry/SEO/Analytics | PHẦN 4 + `app/*`, `i18n/*` | Nông–vừa | Bảng ứng viên analytics kèm quyền riêng tư |
| Audit tối ưu mã nguồn (knip/depcheck/jscpd) | `docs/ops/code-optimization-audit-prompt.md` + `/audit-optimize` | Vừa | 2 giai đoạn đo → dừng chờ duyệt |
| Audit toàn diện 12 nhóm, resume qua phiên, Bước -1 chống audit khung trống | `docs/ops/comprehensive-audit-prompt.md` + `/audit-full` | **Sâu** | Nhóm 12 "thống nhất chéo tính năng" là ý độc đáo |
| Incident + post-mortem | `docs/ops/incident-response.md` + `/incident` + `ISSUE_TEMPLATE/incident.md` | Vừa | SEV, blameless, "mỗi sự cố ≥1 hàng rào mới" |
| Model & automation (opusplan, effort, kỷ luật token, sơ đồ tự động, ranh giới trung thực) | `models-and-automation.md` (325 dòng) | **Sâu** | §8 "sự thật kỹ thuật" rất thẳng thắn |
| UI/UX chuyên gia | `.claude/commands/ui-ux.md` | Nông (36 dòng, chủ yếu trỏ về supplements) | Checklist 7 mục cuối |
| CI/CD | `.github/workflows/*` (ci 6 job, codeql, lighthouse, release-please, gitleaks) | **Sâu** | `protection-guard` kiểm ruleset thật qua API + đối chiếu job có thật |
| Branch protection | `.github/rulesets/main.json` + `CONTRIBUTING.md` | Sâu | Giải thích vì sao approval=0 (thế kẹt 1 người) |
| AI harness 7 cấu phần + công ty AI (vai R0–R9, cổng G0–G8, L0–L4, OWASP ASI01–10) | `docs/specs/AI-HARNESS-AND-COMPANY-SPEC.md` + ADR-0002/0003 + `docs/ops/BASELINE-…` | **Rất sâu** | Nguyên tắc P1–P12, luật L1–L7, vị từ "làn nhanh", "máy kiểm gì/người tự kiểm gì" |
| Case-study chạy thật | `case-study-greenfield-dry-run.md` | Vừa | 3 lỗi thật đã vá, bài học "chạy thật mới lộ" |

## 3. Điểm yếu / lỗ hổng

**3a. Trùng lặp nặng (cùng nội dung ở ≥4 chỗ):**
- Cổng commit/merge: CLAUDE.md §5–§6, KHUNG-2 Phần A, `gate.md`, `CONTRIBUTING.md`, runbook Phần B, PR template.
- DoD: KHUNG-1 GĐ1, PR template, CONTRIBUTING, PROJECT.md §8. DoR: KHUNG-1, supplements N1.7, CONTRIBUTING, runbook B.
- "Dự án cấm": CLAUDE.md §0b, README, KHUNG-3 A0, runbook đầu file, consult.md.
- Theme Dark blue+Light: CLAUDE.md §3.10, KHUNG-1 GĐ2, KHUNG-3 A.11, supplements PHẦN 3, ui-ux.md, PROJECT.md §3, PR template.
- Tối ưu mã nguồn: CLAUDE.md §3.7, KHUNG-1 GĐ4+GĐ8, supplements N2.9, adoption B2/B3, audit-optimize prompt+command.
- Ghi chú "💡 Model/effort" lặp ở 6 command.
- `.claude/settings.json` và `settings-shared-opusplan.json` **giống hệt** (đã diff).
- Runbook Phần A Bước 4 ≈ Phần D ≈ Phần E §1 (ba lần cùng danh sách gói/hàng rào).

**3b. Mâu thuẫn thật:**
- **Tên model**: CLAUDE.md §1 và `models-and-automation.md` nói **Opus 4.8** (`claude-opus-4-8`, 7 lần); spec §A11.2 và ADR-0002 nói **Opus 5** (`claude-opus-5`, 8 lần). Giá Sonnet 5: supplements/models nói $3/$15 (2026-07), spec nói $2/$10 (2026-09).
- Spec dòng 6 ghi "hồ sơ **C3 + C7**" cho Backend/API — theo KHUNG-3, C3 là Desktop, Backend/API là **C4**.
- `PROGRESS.md` (376 dòng) ghi "Giai đoạn hiện tại: GĐ 7" cho một repo khung (mô hình 9 GĐ không khớp); nửa sau là nhật ký của repo **Claude-Agents** (PR #40/#45/#47, ADR-0028) chứ không phải khung này; "Nợ kỹ thuật: (không có)" trong khi "Tiếp theo" còn ≥3 việc treo; bullet đầu "Đã xong" vẫn nhắc file `CONG-CU-OPUSPLAN-CHO-DU-AN.md` và `thuc-thi` (tên đã xóa).
- README "File đã sẵn sàng" không liệt kê `.claude/`, `scripts/`, `docs/specs/`, `.github/rulesets/`.
- `copy-framework.sh` **không copy** `.github/rulesets/main.json` dù CONTRIBUTING bắt buộc import nó; không copy `docs/specs/`, ADR 0001–0003.
- Vết dự án gốc của tác giả lọt vào khung chung: supplements N1.4 "cách tổ chức cache **TTS**"; adoption PHẦN B "Riêng cho dự án **SONG NGỮ (EN–VI)**"; CODEOWNERS/LICENSE hard-code `@seeker19110`.

**3c. Còn `[ĐIỀN]`:** CLAUDE.md 9 chỗ (§3.1, §5 ×5, §10 ×6 dòng), runbook 7, README 2, gate/bootstrap/adoption/audit mỗi file 1 (nhắc tới placeholder). CI chỉ chặn `[ĐIỀN` khi đã có `package.json`.

**3d. Chỉ nói chung chung:** hồ sơ C2–C10 (mỗi cái 1 bảng, không checklist, không file cấu hình); `ui-ux.md`; KHUNG-1 GĐ7 ra mắt (7 dòng); Phần A mục 6 pháp lý (1 dòng "GDPR/Nghị định 13"); observability ngoài Sentry; test data (3 dòng); `01-process` còn trỏ "xem file hướng dẫn pre-commit + CI" (tên cũ, mơ hồ).

**3e. Chủ đề thiếu hẳn:**
- **AI agent/agentic như một hồ sơ dự án**: KHUNG-3 C7 chỉ có 1 câu "dùng model Claude mới nhất (xem skill claude-api)". Spec 2487 dòng rất sâu nhưng là đặc tả cho *một* hệ nội bộ (Claude-Agents), chưa được tích hợp thành hồ sơ C11 + checklist cổng (eval, prompt-as-code, tool gateway, OWASP ASI) dùng được cho dự án khác.
- **Ngành nghề đặc thù**: không có (e-commerce/thanh toán, fintech, y tế, giáo dục, SaaS multi-tenant); chỉ 1 dòng "ngành đặc thù phải rà trước" ở spec §A4.6.3.
- **Backend/database chi tiết**: không có quy ước API (dạng lỗi, phân trang, versioning, OpenAPI), auth patterns (session/JWT/OAuth), caching/queue/job nền, N+1/index/transaction, data modeling ngoài 5 gạch đầu dòng GĐ2; migration chỉ cho Supabase.
- **Workflow/loop đa phiên**: `/auto` + 3 subagent; không có hướng dẫn worktree song song, vòng lặp sửa-đến-xanh, điều phối nhiều session (spec Phần B mô tả vai nhưng không cài vào `.claude/`).
- **Bảo mật sâu**: chỉ cơ bản web (RLS/XSS/SQLi/secrets) + CodeQL/gitleaks/audit; không có threat modeling (STRIDE chỉ trong spec), rate limit/abuse, quản lý & xoay bí mật, SBOM/provenance, ghim SHA action (0/20 — đã đếm), `permissions:` cấp đầu thiếu ở `ci.yml`, `codeql.yml`, `lighthouse-ci.yml` (đã đếm).
- **Design system**: `theme.css` chỉ có token màu — không typography/spacing/radius/elevation, không component library, không handoff thiết kế.
- **Mobile native**: C2 một bảng; không checklist store/offline/push/quyền.
- **Ngoài JS**: `dev-task.sh` dò Python/Go/Rust nhưng toàn bộ doc/CI/lint/format chỉ viết cho Node.
- Khác: load/perf test backend, logging/metrics/tracing cho web, Docker/IaC/DR, kiểm thử contract, cost management, tài liệu người dùng/API, quy trình team >1 người (KHUNG-1 ghi "Thời gian (solo)").

## 4. Cơ chế tự động hóa đã có

| Cơ chế | Làm gì (chính xác) | Giữ | Bỏ/sửa |
|---|---|---|---|
| `.claude/settings.json` | `model: opusplan`, fallback [sonnet-5, haiku-4-5], `effortLevel: medium`; allow Edit/Write/Read + `scripts/dev-task.sh *` + git an toàn (kể cả push/pull/checkout) + npm/pnpm/yarn/pytest/ruff/black/mypy/go/cargo; deny `rm -rf`, force-push, `reset --hard`, `git clean`, sudo, chmod 777, dd, đọc `.env*`/`secrets/**`; 4 hook | Deny-list, allow đa-stack | Xoá bản trùng `settings-shared-opusplan.json`; cân nhắc `opusplan` (gợi ý nâng cấp đánh dấu là lỗi thời) |
| `hooks/session-resume.sh` (SessionStart) | Xoá marker wind-down; đọc toàn bộ `PROGRESS.md` + branch/status/5 commit → `additionalContext` | **Giữ** — nền của "tiếp tục" | Nạp cả file PROGRESS (376 dòng ở repo khung) = tốn ngữ cảnh; nên chỉ nạp mục Đang làm/Tiếp theo/Bàn giao |
| `hooks/session-guide.sh` (SessionStart) | Chỉ chạy nếu có `docs/framework`/`auto.md`; trích "Giai đoạn hiện tại", dirty git; đọc `.model` từ stdin, cảnh báo nếu không phải opusplan và tiêm `additionalContext` bắt AI nhắc `/model opusplan` | Gợi ý "làm gì tiếp" | Phần cảnh báo model gắn chặt opusplan — bỏ hoặc làm tuỳ chọn |
| `hooks/pre-commit-gate.sh` (PreToolUse Bash) | Regex bắt `git commit`; bỏ qua nếu `--no-verify`; gọi `dev-task.sh gate`; đỏ → `exit 2` chặn; diff staged ≥80 dòng/≥5 file → nudge `/code-review` | **Giữ nguyên** | — |
| `hooks/auto-format.sh` (PostToolUse Edit\|Write) | Lấy `file_path` qua jq → `dev-task.sh format-file`; luôn exit 0 | **Giữ** | — |
| `hooks/usage-guard.sh` (Stop) + `scripts/usage-estimate.sh` + `usage-budget.example.sh` | Python đọc transcript JSONL, cộng token theo model trong 5h (cache_read ×0.1), chia cho budget tự khai (gợi ý Pro: Opus 3M…) → ≥70% nhắc wind-down 1 lần/phiên | Ý tưởng wind-down + "Bàn giao phiên" | Cơ chế ước tính thủ công, tự nhận là "ước tính tự hiệu chỉnh", chỉ 1 phiên — mong manh; nên bỏ hoặc thay bằng tín hiệu chính thức nếu có |
| `scripts/dev-task.sh` | Điểm vào `format\|lint\|typecheck\|test\|build\|gate\|format-file`; phân giải 3 tầng: `.claude/project-commands.sh` → tự dò (package.json script, pyproject+ruff/mypy/pytest, go, cargo, Makefile) → no-op exit 0 | **Giữ nguyên** — thiết kế đúng | — |
| `scripts/check-docs-consistency.sh` + job `docs-consistency` | Mọi đường dẫn trong backtick phải tồn tại (allowlist file sinh tại đích); tên cũ không còn sót | Giữ cho repo khung | Danh sách tên cũ sẽ lỗi thời sau lần đổi tên mới |
| `scripts/test-copy-framework.sh` + job `copy-framework-smoke` | Chạy thật copy-framework.sh/.ps1 vào scratch, kiểm cấu trúc + không đè + chạy 2 lần | Giữ | — |
| `copy-framework.sh/.ps1` | 4 bước: Lớp 1 copy thẳng (`docs/framework`, `docs/ops`, `.claude/commands`); file gốc copy-if-absent; PROGRESS từ template; settings/hooks/agents/scripts copy-if-absent; Lớp 2 vào `_framework-dropins/` | Mẫu copy-if-absent, `.framework-new` | Thiếu `rulesets/main.json`, `docs/specs`, ADR mẫu; `_framework-dropins/` gây crash hook nếu không xoá (case-study) |
| Agents `lookup`/`version-check` (Haiku) / `executor` (Sonnet) | Read-only tra cứu; xác minh phiên bản nguồn sống (WebFetch); thực thi việc rõ phạm vi, không commit | **Giữ** cả 3 — mô tả ranh giới rất rõ | `version-check` phụ thuộc WebFetch (spec ghi proxy chặn nhiều domain) |
| 10 commands | Wrapper mỏng: trỏ file docs + ràng buộc + "Bắt đầu Bước X ngay"; `/gate` tự dò script từ package.json; `/audit-full`, `/completion` có Bước -1 và hỏi "quét lại hay tiếp tục" | **Giữ** mô hình wrapper | Gom 6 ghi chú 💡 model/effort về 1 chỗ; `/gate` chỉ biết Node |
| `ci.yml` | 6 job: `protection-guard` (gọi API rules/branches, đối chiếu ruleset ↔ job thật), `framework-lint` (bash -n, shellcheck, jq), `docs-consistency`, `copy-framework-smoke`, `quality` (skip nếu không có package.json; chặn `[ĐIỀN]`; audit/lint/type/format/coverage/build), `e2e` (cache Playwright, desktop+mobile+axe, upload report) | **Giữ** `protection-guard` + framework-lint | Thiếu `permissions:` cấp đầu; action không ghim SHA; quality/e2e "xanh rỗng" khi chưa có app |
| `codeql.yml`/`lighthouse-ci.yml`/`release.yml`/`secret-scan.yml` | SAST + cron tuần; CWV gate trên PR; release-please node; gitleaks fetch-depth 0 | Giữ | Pin SHA, permissions |
| `rulesets/main.json` | Cấm xoá/force-push, PR bắt buộc (0 approval, resolve thread, chỉ squash), 8 required check, không bypass | **Giữ** + lý do approval=0 trong CONTRIBUTING | Required `lighthouse` chỉ chạy trên PR (ổn), `analyze` CodeQL không required |
| husky/lint-staged/commitlint, dependabot (npm), CODEOWNERS, PR/issue template | Hàng rào cục bộ + GitHub | Giữ | Dependabot thiếu `github-actions`; CODEOWNERS hard-code user |

## 5. Giữ nguyên văn/gần nguyên văn vs viết lại

**Giữ (gần nguyên văn):**
- CLAUDE.md §2 (quản lý), §4 (chống ảo giác), §7 (báo cáo), §9 (dừng & hỏi), §8 quy trình PR→merge FIFO.
- `01-process`: 7 nguyên tắc nền, bảng 9 GĐ + cổng, DoD/DoR, ba tầng phòng thủ.
- `02-ai-rules` Phần A toàn bộ; mẫu PROJECT.md Phần B.
- `03-tech-selection`: Nguyên tắc số 1, bảng A0, PHẦN A 19 khía cạnh, B2–B4.
- `quality-supplements` N2 mục 1, 5, 6, 9; PHẦN 3 theme.
- `project-completion.md` toàn bộ; `comprehensive-audit-prompt.md` (12 nhóm, Bước -1, cơ chế resume); `incident-response.md` + post-mortem.
- `existing-project-adoption.md`: nguyên tắc 0–4, Bước 0 bảng "đọc gì → suy ra gì", khái niệm 2 lớp, PHẦN C.
- ADR template + 0001 (ví dụ điền) + 0003 (mẫu viết ADR tốt).
- `dev-task.sh`, `pre-commit-gate.sh`, `auto-format.sh`, `session-resume.sh`; 3 agent; `ci.yml` job `protection-guard`; `rulesets/main.json` + khối giải thích trong CONTRIBUTING.
- Lớp 2: `lib/env.ts`, `styles/theme.css`, `playwright.config.ts`, `e2e/smoke.spec.ts`, `supabase/migrations/*init_example.sql`, `pull_request_template.md`, `lighthouserc.json`.
- Spec: §A2 P1–P12, §A4.5.2 ánh xạ ASI01–10, §B1.3 L1–L7, §B3.1a vị từ làn nhanh, §B6.1 + "máy kiểm gì/người tự kiểm gì", §B7 bốn vòng học + "lỗi lần thứ ba", §B10 chống chỉ định, §B11 L0–L4, §C4.2 checklist.
- `case-study-greenfield-dry-run.md` (giữ làm bằng chứng lịch sử).

**Nên viết lại:**
- CLAUDE.md §1 (15 bullet TRIGGER dày đặc), §3/§5/§6 (web-bias + `[ĐIỀN]`), §10.
- README (web-centric, danh sách file lỗi thời).
- Runbook: gộp Phần A/D/E, tách phần web ra hồ sơ C1.
- KHUNG-3 PHẦN C: C2–C10 cần checklist + cổng thật; phiên bản 2026-06-29 lỗi thời.
- `models-and-automation.md`: tên/giá model, phần usage-guard; `session-guide.sh` phần opusplan.
- `quality-supplements` N1 (gần như Supabase/Vercel-only), PHẦN 4 (Next-only); xoá vết TTS/song ngữ.
- `PROGRESS.md`: reset về template, chuyển lịch sử sang CHANGELOG; tách nhật ký Claude-Agents ra.
- Spec: sửa nhãn C3→C4; chưng cất thành hồ sơ "AI agent" + checklist cổng tái dùng; phần còn lại giữ làm tham khảo.
- `copy-framework.sh`: thêm rulesets/specs; xử lý `_framework-dropins/`.
- Gom 6 ghi chú 💡 model/effort về một bảng; xoá settings trùng.

## 6. Gợi ý nâng cấp đã ghi sẵn

**`docs/2026-10-13-goi-y-nang-cap.md`** (đo trên HEAD `09c3c3c`): 0/20 action ghim SHA; `ci.yml`, `codeql.yml`, `lighthouse-ci.yml` thiếu `permissions:` cấp đầu; Dependabot chỉ npm; 1 file test. Đề xuất: (1) 🟠 quyết định **archive** (khung đã chuyển sang `projects-template`) hoặc đồng bộ như Xgold; (2) 🟢 nếu giữ: ghim SHA bằng pinact/ratchet, thêm `permissions:`, Dependabot `github-actions`. Giữ nguyên spec làm tài liệu tra cứu. Gợi ý tích hợp: đối chiếu C1–C7/G0–G8 với cổng RoE hai lớp của Decepticon + OWASP Agentic Top 10. Chuẩn tham chiếu: `seeker19110/projects-template` (25/25 ghim SHA, mọi workflow có permissions, Dependabot npm+actions+pip).

**`PROGRESS.md` "Tiếp theo" / nợ:** Tuần 2 lộ trình §B12.2.9 (chờ PR #40 Claude-Agents xanh sau khi import ruleset); **thực thi vị từ làn nhanh §B3.1a** vào `BASE_REVIEWS`/`RISK_REVIEWS` (đã chốt đặc tả, chưa có code) + đếm `first_pass_gate_rate` + đường lùi L1; mô tả nguyên văn ASI vẫn chưa lấy được (genai.owasp.org bị chặn); case-study mới chạy Phần D — Bước 6–8 (branch protection/Supabase/Vercel) chưa kiểm chứng; dự án copy khung bản cũ cần chạy lại script mới. Mục "Nợ kỹ thuật" ghi "(không có)" — mâu thuẫn với các mục trên. Hồ sơ cục bộ của spec (§A11.1.a) tự ghi nợ: sandbox `subprocess` không cách ly mức nhân.
