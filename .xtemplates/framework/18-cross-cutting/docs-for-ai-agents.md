---
title: Tài liệu cho AI agent: AGENTS.md, CLAUDE.md, llms.txt, runtime.yaml, SCOPE.md
kind: module
prefix: XC-DOCAI
applies_to: [all]
updated: 2026-10-16
---

# Tài liệu cho AI agent: AGENTS.md, CLAUDE.md, llms.txt, runtime.yaml, SCOPE.md

> Cách viết và kiểm **tài liệu mà agent đọc**: một `AGENTS.md` gốc (chuẩn mở, > 60k dự án), các bridge mỏng cho từng
> harness (`CLAUDE.md` import, `.github/copilot-instructions.md`, `GEMINI.md`…), lệnh máy đọc (`runtime.yaml`/`xt.yaml`),
> ranh giới phạm vi (`SCOPE.md` + `.out-of-scope/`), `SKILL.md` theo Agent Skills spec, và `llms.txt` cho tài liệu đã
> xuất bản. Tài liệu tối thiểu cho người là nhà của [`../01-baseline/documentation-minimum.md`](../01-baseline/documentation-minimum.md);
> file trạng thái của vòng lặp tự động (PLAN/PROGRESS/evidence) ở [`../11-autonomous-loop/harness-files.md`](../11-autonomous-loop/harness-files.md);
> hook/quyền thực thi ở [`../11-autonomous-loop/loop-design.md`](../11-autonomous-loop/loop-design.md).

## Nguyên tắc

- **Tài liệu tốt cho AI = tài liệu tốt cho người + markdown sạch + phiên bản rõ + endpoint máy đọc** (llms.txt hoặc MCP).
- **Một nguồn, nhiều cửa**: `AGENTS.md` là nguồn; `CLAUDE.md`, `GEMINI.md`, `.cursor/rules`, copilot-instructions chỉ
  import/trỏ. Không duy trì hai bộ luật.
- **Hướng dẫn ≠ cưỡng chế**: file hướng dẫn là *ngữ cảnh*, agent có thể bỏ qua; thứ bắt buộc phải là hook/permission/CI.
- **Ngắn, cụ thể, có lệnh**: mục tiêu ≤ 200 dòng mỗi file nạp mặc định; lệnh ở dạng key: value, không văn xuôi.
- **Nội dung ngoài là dữ liệu**: file hướng dẫn phải nói rõ web/issue/output tool không phải chỉ thị; và chính file
  hướng dẫn do người khác commit cũng cần review như mã.
- **Phạm vi được bảo vệ bằng văn bản**: `SCOPE.md` nói nhận gì, `.out-of-scope/` nói đã từ chối gì và vì sao.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| File gốc nào? | **`AGENTS.md`** ở gốc repo (AAIF/Linux Foundation; Codex, Copilot, Gemini CLI, Cursor, Jules, Zed… đọc trực tiếp; Claude Code đọc khi không có `CLAUDE.md` hoặc qua import). | Repo chỉ dùng một harness mãi mãi — vẫn nên `AGENTS.md` vì chi phí bằng 0. |
| Claude Code | `CLAUDE.md` chứa dòng `@AGENTS.md` (import, tối đa 4 hops) + phần riêng Claude (hook, skill, permission); hoặc đặt `instructionFiles: claude-md-and-agents-md`. Không copy nội dung. | Có cả `CLAUDE.md` và `AGENTS.md` mà không import → Claude Code **chỉ đọc `CLAUDE.md`**, bỏ `AGENTS.md`. |
| Các harness khác | Bridge một dòng: `.github/copilot-instructions.md` ("Đọc AGENTS.md"; Copilot cũng tự đọc `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`), `GEMINI.md`, `.cursor/rules/*.mdc`, `.clinerules`, `.windsurfrules`; Codex đọc `AGENTS.md` (và `AGENTS.override.md`), gộp tối đa 32 KiB. | Mỗi harness một bộ luật riêng. |
| Luật theo vùng mã | Claude: `.claude/rules/*.md` với `paths:`; Copilot: `.github/instructions/*.instructions.md` với `applyTo`; monorepo: `AGENTS.md` lồng theo thư mục (gần nhất thắng). | Nhồi luật của mọi package vào file gốc. |
| Lệnh cho agent | `runtime.yaml`/`xt.yaml` phẳng (`test: pnpm vitest run`) được script kiểm khớp với `package.json`/`justfile`; `AGENTS.md` trích dẫn, không định nghĩa lại. | Văn xuôi "chạy test bằng lệnh thông thường". |
| Kỹ năng đóng gói | `SKILL.md` theo Agent Skills spec (`name` ≤ 64 ký tự, `description` ≤ 1024, thư mục trùng `name`, body < 500 dòng, `scripts/`/`references/`/`assets/`); vendor có lock (commit + sha256) thay vì plugin tự cập nhật khi cần hành vi ổn định. | Skill chứa bí mật, lệnh `curl \| sh`, hoặc sửa `~/.claude/settings.json` → không cài. |
| Tài liệu công khai cho LLM | `/llms.txt` (H1 bắt buộc, blockquote tóm tắt, H2 danh sách link, mục `Optional`), bản `.md` cho mỗi trang (`page.html.md`/`page.md`), `Link: rel="alternate" type="text/markdown"`. | Dùng llms.txt thay cho SEO/sitemap — Google/OpenAI không dùng; giá trị ở coding agent. |

## Checklist

- [ ] `XC-DOCAI-001` **MUST** Có `AGENTS.md` ở gốc repo, Markdown thuần, gồm: tổng quan 3–5 dòng, lệnh cài/chạy/test/lint (trích từ file máy đọc), quy ước mã, luật PR/commit, ranh giới an toàn (điểm dừng bắt buộc), nơi đọc tiếp. → Kiểm: file tồn tại; script kiểm có đủ heading bắt buộc; mọi lệnh trong file xuất hiện y nguyên trong `xt.yaml`/`package.json#scripts`. · Nguồn: agents.md (AAIF)
- [ ] `XC-DOCAI-002` **MUST@L** Nhà của luật bridge (đã gộp `LOOP-HARNESS-009`/`011`, `WF-DOC-014`): các harness khác đọc **cùng một nguồn**: `CLAUDE.md` có dòng `@AGENTS.md` ngoài code block (hoặc cấu hình `claude-md-and-agents-md`); `.github/copilot-instructions.md`, `GEMINI.md`, `.cursor/rules/*.mdc` chỉ là bridge trỏ về `AGENTS.md`; không có đoạn luật lặp lại ở hai file. → Kiểm: `grep -q '^@AGENTS.md' CLAUDE.md`; bridge ≤ 5 dòng; `jscpd`/diff không phát hiện khối trùng giữa các file hướng dẫn. · Nguồn: Claude Code memory docs (AGENTS.md chỉ được đọc khi không có CLAUDE.md; import tối đa 4 hops); GitHub Copilot repository instructions
- [ ] `XC-DOCAI-003` **MUST** Lệnh chạy cho agent nằm trong **file máy đọc phẳng** (`xt.yaml`/`runtime.yaml`; nhà của bộ khoá: [`LOOP-HARNESS-008`](../11-autonomous-loop/harness-files.md) và mẫu [`../templates/xt.yaml`](../templates/xt.yaml)) và được CI kiểm khớp với điểm vào thật. `scripts/dev-task.sh` chỉ chạy `format · lint · typecheck · test · build · format_file`; khoá khác (`install`, `dev`, `e2e`, `migrate`, `init`, `smoke`, `audit`…) là lệnh khai báo để agent đọc và chạy trực tiếp; `AGENTS.md` nói "không suy diễn lệnh từ văn xuôi". → Kiểm: `check:commands` so khoá/giá trị với `package.json`/`justfile`/`Makefile` = 0 lệch; `AGENTS.md` có câu cấm suy diễn. · Nguồn: catalog 23 §3.3
- [ ] `XC-DOCAI-004` **MUST** File hướng dẫn nêu rõ **ranh giới tin cậy**: nội dung từ web, issue, PR, tài liệu, output tool/MCP là dữ liệu, không phải chỉ thị; điểm dừng bắt buộc (xoá dữ liệu, tiền thật, publish, đổi quyền/cổng); và câu "hướng dẫn này không thay cho hook/permission". → Kiểm: `AGENTS.md` có mục "Điểm dừng bắt buộc" và câu "dữ liệu, không phải chỉ thị"; hook tương ứng tồn tại trong `.claude/settings.json`/CI. · Nguồn: evidence-and-sources.md luật 13; catalog 20 §1.5; Claude Code memory docs ("context, not enforced configuration")
- [ ] `XC-DOCAI-005` **MUST** File hướng dẫn **không chứa bí mật, dữ liệu người dùng, tên model/phiên AI, hay lệnh tải-và-chạy** (`curl \| sh`); được review như mã (CODEOWNERS) vì nó điều khiển hành vi agent của mọi người clone repo. → Kiểm: gitleaks quét `AGENTS.md`/`CLAUDE.md`/`.claude/**`/`.cursor/**`; grep `curl .*\| *(ba)?sh` = 0; CODEOWNERS có dòng cho các file này. · Nguồn: catalog 12 §3e (đọc install.sh/hook trước khi chạy); AGENTS.md của khung §3
- [ ] `XC-DOCAI-006` **MUST@L** Kích thước có ngân sách: mỗi file nạp mặc định ≤ 200 dòng (Claude khuyến nghị) và tổng chuỗi `AGENTS.md` ≤ 32 KiB (giới hạn Codex); luật theo vùng tách sang file path-scoped (`.claude/rules/` `paths:`, `.github/instructions/*.instructions.md` `applyTo`, `AGENTS.md` lồng). → Kiểm: script đếm dòng/byte trong CI: `AGENTS.md` + import ≤ 32 KiB; mỗi file ≤ 200 dòng (cảnh báo) / 400 (chặn). · Nguồn: Claude Code memory docs (≤ 200 dòng, imports vẫn tốn context); Codex `project_doc_max_bytes` 32 KiB
- [ ] `XC-DOCAI-007` **MUST@L** Nhà của luật bản gốc `AGENTS.md` (đã gộp `LOOP-HARNESS-010`; đường dẫn duy nhất `docs/agents/`): bản gốc file hướng dẫn được **bảo vệ khỏi ghi đè** bởi công cụ (`next dev` từng ghi đè `AGENTS.md`): giữ nguồn trong `docs/agents/` hoặc kiểm hash, CI đỏ khi file gốc lệch nguồn ngoài PR có chủ ý. → Kiểm: `check:agents-drift` so sha256 `AGENTS.md` với bản trong `docs/agents/`/lockfile; hook `ask` khi sửa. · Nguồn: catalog 04 §4, 23 §2.4 (case-study-ft41)
- [ ] `XC-DOCAI-008` **MUST@L** Có `SCOPE.md` (nhận gì: tiêu chí issue/PR được chấp nhận, vd "mô tả failure quan sát được trong phiên thật") và `.out-of-scope/*.md` (mỗi ý tưởng bị từ chối một file, lý do, issue liên quan) để agent và người không mở lại việc đã từ chối. → Kiểm: hai đường dẫn tồn tại; `AGENTS.md` trỏ tới; workflow triage gắn nhãn `out-of-scope` tự đóng theo file. · Nguồn: catalog 20 §3c (mattpocock/skills)
- [ ] `XC-DOCAI-009` **MUST@L** Kỹ năng/plugin cài vào repo theo **Agent Skills spec**: `SKILL.md` có `name` (1–64, chữ thường/số/gạch nối, trùng tên thư mục) và `description` (1–1024, nêu *khi nào dùng*), body < 500 dòng, tài liệu phụ trong `references/` nạp theo tầng. Nguồn ngoài (vendor có lock, quét trước khi cài) theo [`SEC-SUPPLY-016`](../12-security/supply-chain.md). → Kiểm: `skills-ref validate ./.claude/skills/<x>` 0 lỗi; `wc -l SKILL.md` < 500. · Nguồn: Agent Skills specification; catalog 23 §3.1
- [ ] `XC-DOCAI-010` **SHOULD** Tài liệu công khai (site docs/API) xuất bản `/llms.txt` theo đề xuất v2: H1 tên dự án, blockquote tóm tắt, H2 nhóm link dạng `[tên](https://…): ghi chú`, mục `## Optional` cho link thứ yếu; mỗi trang có bản Markdown (`.md`/`.html.md`) và header `Link: <…>; rel="alternate"; type="text/markdown"`. → Kiểm: `curl -f <site>/llms.txt | head -1` bắt đầu bằng `# `; `curl -f <site>/docs/page.md` 200; link trong llms.txt qua lychee 0 chết. · Nguồn: llms.txt v2 (llmstxt.org, cập nhật 2026-08-10)
- [ ] `XC-DOCAI-011` **SHOULD** `AGENTS.md` lồng theo package trong monorepo (gần nhất thắng), mỗi file chỉ chứa khác biệt so với gốc; không lặp luật chung. → Kiểm: `find . -name AGENTS.md` mỗi file < 100 dòng ở package; jscpd 0 trùng. · Nguồn: agents.md (nested files, closest wins); Codex AGENTS.md (gộp từ gốc xuống)
- [ ] `XC-DOCAI-012` **SHOULD** Tài liệu nạp vào agent có **phiên bản và ngày**: frontmatter `updated`, mục "Thay đổi gần đây" hoặc CHANGELOG riêng cho harness; harness ghi giả định về model/ngày để xét lại khi đổi model (harness có hạn sử dụng). → Kiểm: `AGENTS.md`/`.claude/**` có `updated`; CI cảnh báo > 180 ngày không cập nhật. · Nguồn: catalog 21 §2.2 ("harness có hạn sử dụng")
- [ ] `XC-DOCAI-013` **SHOULD** Mã nguồn đưa cho agent đọc ngoài repo (repomix, gitingest, Context7) chạy ở chế độ hạn chế thư mục (`repomix --sandbox`, MCP `--sandbox`) và quét bí mật trước khi xuất; không gói `.env`/khoá. → Kiểm: lệnh đóng gói có `--sandbox`/`--ignore` cho `.env*`; output qua gitleaks = 0. · Nguồn: catalog 16 §2b (repomix `--sandbox`, Secretlint)
- [ ] `XC-DOCAI-014` **SHOULD** Mỗi quy tắc trong file hướng dẫn mà máy kiểm được đã thành **cổng** (hook/lint/CI) và file ghi chú "được cưỡng chế bởi X"; quy tắc không kiểm được ghi rõ là hướng dẫn. → Kiểm: bảng trong `AGENTS.md`/`docs/agents/enforcement.md`: luật → cơ chế cưỡng chế; luật "bắt buộc" không có cơ chế → issue. · Nguồn: P9; catalog 23 §4.3 (thang mức bền `/hoc`)
- [ ] `XC-DOCAI-015` **SHOULD** Audit định kỳ file hướng dẫn: mâu thuẫn, lệnh lỗi thời, luật trùng (`/doctor prompt-audit` của Claude Code hoặc checklist tay); kết quả thành PR. → Kiểm: nhật ký audit hằng quý trong `docs/agents/`. · Nguồn: Claude Code memory docs (consistency, prompt audit)
- [ ] `XC-DOCAI-016` **MAY** Cung cấp MCP server tài liệu/catalog cho agent (read-only, tool ít, tham số tra được) thay vì nhồi tài liệu vào context; ghi rõ không phải "production-ready" nếu chỉ dùng nội bộ. → Kiểm: `tools/list` thứ tự xác định; server bind loopback; xem [`../13-ai-engineering/protocols-mcp-a2a.md`](../13-ai-engineering/protocols-mcp-a2a.md). · Nguồn: MCP spec 2026-07-28; catalog 04 §2
- [ ] `XC-DOCAI-017` **MAY** Bản đồ tri thức mã sinh bằng máy (code graph, catalog từ mã) gắn nhãn `EXTRACTED`/`INFERRED` và có cổng drift so với mã thật. → Kiểm: job sinh lại + `git diff --exit-code`. · Nguồn: catalog 16 §2c–2d, 23 §6.4
- [ ] `XC-DOCAI-018` **SHOULD** Không bật đồng thời nhiều skill/plugin cùng chỉnh **giọng/hành vi trả lời** (vd ponytail + caveman + superpowers): nhiều prompt cùng ra lệnh về cách trả lời sẽ mâu thuẫn; mỗi vai chọn một pack, ghi trong `AGENTS.md`; plugin chạy binary ở hook phải ghim phiên bản, kiểm SHA và tắt telemetry (`DO_NOT_TRACK=1`). → Kiểm: danh sách plugin bật trong `.claude/settings.json` đối chiếu bảng vai trong `AGENTS.md`. · Nguồn: `seeker19110/stored` 20 §3g
- [ ] `XC-DOCAI-019` **SHOULD** Khi cấp skill cho agent **theo stack dự án**, ưu tiên installer dò stack có **cổng xuất xứ** — manifest + SHA-256 từng file, review nội dung skill trước khi nạp (injection/supply-chain), cảnh báo hiện trước khi cài, và ghi `skills-lock.json` (source + commit + hash) — hơn chép tay hoặc plugin marketplace tự cập nhật (xem `XC-DOCAI-009`, [`SEC-SUPPLY-016`](../12-security/supply-chain.md)). Mẫu tham chiếu: autoskills (midudev). Nhưng license của nó là **CC BY-NC 4.0** (phi thương mại): chỉ gọi CLI đã xuất bản (`npx autoskills`) như **bước dev tuỳ chọn**, không đưa vào `dependencies` hay bước build phân phối, và **không vendor registry/mã** của nó vào sản phẩm phân phối/thương mại — CC BY-NC nằm trong nhóm cấm mặc định của [`CMP-LIC`](../16-compliance-privacy/licensing-and-ip.md). → Kiểm: nếu dùng, có `skills-lock.json` với `source` + `sha256` mỗi skill; `grep -riE "autoskills" package.json` không thấy ở `dependencies`/`devDependencies` và không ở bước build phát hành (chỉ ở script dev hoặc tài liệu); nhúng registry/mã thì `license-policy.yaml` có ngoại lệ kèm `reason` và luật sư duyệt. · Nguồn: `seeker19110/stored` 20 §3h (autoskills: dò stack, registry review hai tầng bằng model + SHA-256 + `skills-lock.json`, license CC BY-NC 4.0)
- [ ] `XC-DOCAI-020` **SHOULD** Dự án để agent sinh UI có `DESIGN.md` theo spec DESIGN.md của `google-labs-code/design.md` (YAML front matter chứa token + văn xuôi giải thích; bản CLI đã đọc: `@google/design.md` 0.4.0, xác minh 2026-10-16 — **alpha; xác minh lại khi dùng**); phần token **sinh từ nguồn token gốc** (xem [`../06-design-ux/design-system-and-tokens.md`](../06-design-ux/design-system-and-tokens.md)) bằng script, không chép tay; không dùng/chép `DESIGN.md` của thương hiệu khác làm file của dự án. → Kiểm: `npx @google/design.md lint DESIGN.md` 0 lỗi; job sinh lại phần token + `git diff --exit-code` sạch. · Nguồn: `seeker19110/stored` 06 §7c (linter 0.4.0 chấm 11 `DESIGN.md` "chính chủ": chỉ 1/11 sạch hoàn toàn; đọc 2026-10-16)

## Bẫy thường gặp

- **Có `CLAUDE.md` và `AGENTS.md` nhưng không import** → Claude Code chỉ đọc `CLAUDE.md`; đội tưởng luật ở `AGENTS.md` đang được áp. Thêm `@AGENTS.md`.
- **`@AGENTS.md` nằm trong code block hoặc trong dấu backtick** → không import (parser bỏ qua code span). Để ở dòng riêng, không backtick.
- **Dán luật vào 5 file cho 5 harness** → lệch sau tuần đầu. Bridge một dòng.
- **File hướng dẫn 1.500 dòng** → tốn context mỗi lượt, agent bám kém; Codex cắt ở 32 KiB. Tách path-scoped.
- **"Chạy test như bình thường"** → agent đoán sai lệnh, đánh dấu `unverified` 11 lần. `runtime.yaml`.
- **Coi `AGENTS.md` là cổng bảo mật** ("không được push main") — agent vẫn có thể làm. Hook deny + ruleset.
- **Skill từ marketplace tự cập nhật** đổi hành vi giữa hai phiên. Vendor có lock khi cần ổn định.
- **Cài skill có `install.sh` sửa `~/.claude/settings.json`** hoặc MCP stdio chạy mã khi quét. Đọc trước, chạy trong sandbox.
- **`next dev` ghi đè `AGENTS.md`** — mất luật mà không ai thấy. Kiểm hash trong CI.
- **llms.txt liệt kê 400 link không ghi chú** → agent không biết chọn. Nhóm, ghi chú một dòng, mục `Optional`.
- **`AGENTS.md` ghi tên model/phiên AI** → lỗi thời sau một tháng và vi phạm quy ước khung. Ghi năng lực cần, không ghi tên.
- **Chép `DESIGN.md` của thương hiệu khác** làm file dự án ("Copy it into your project root") → logo/màu/font có thể có quyền riêng, và file văn xuôi không có token thì không lint được. Tự viết theo spec, token sinh từ nguồn gốc (`XC-DOCAI-020`).

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Import đúng | script | `grep -q '^@AGENTS.md' CLAUDE.md` | CI | có |
| Lệnh khớp | script `check:commands` | so `xt.yaml`/`runtime.yaml` ↔ `package.json`/`justfile` ↔ `AGENTS.md` | CI | 0 lệch |
| Kích thước | script | `wc -l`, `wc -c` theo chuỗi import | CI | ≤ 200 dòng/file (cảnh báo), ≤ 32 KiB tổng |
| Trùng luật | jscpd 5.4.1 (MIT) | `jscpd AGENTS.md CLAUDE.md GEMINI.md .cursor .github/copilot-instructions.md` | CI | 0 khối trùng |
| Drift | sha256 so với `docs/agents/` | `check:agents-drift` | CI + hook `ask` khi sửa | 0 lệch ngoài PR |
| Bí mật/lệnh nguy hiểm | gitleaks v8.30.1 (MIT) · grep `curl \| sh` | `gitleaks detect --no-git --source=.claude` | CI | 0 |
| SKILL.md hợp lệ | `skills-ref validate` (agentskills, Apache-2.0) | `skills-ref validate .claude/skills/*` | CI | 0 lỗi |
| Vendor lock | script `verify-vendor` | so sha256 từng file với lock | CI | 0 lệch |
| llms.txt | lychee v0.24.2 + curl | `curl -f /llms.txt`; `lychee llms.txt` | cron | 200; 0 link chết |
| Markdown sạch | markdownlint-cli2 (MIT) | `markdownlint-cli2 "AGENTS.md" ".claude/**/*.md"` | CI | 0 |
| `DESIGN.md` hợp lệ | `@google/design.md` (alpha) + script sinh token | `npx @google/design.md lint DESIGN.md`; sinh lại phần token rồi `git diff --exit-code` | CI | 0 lỗi; 0 diff |

## Nguồn

- AGENTS.md (quy ước mở, > 60k dự án, AAIF/Linux Foundation; nested closest-wins; prompt người dùng thắng file): <https://agents.md/> — xác minh 2026-10-13
- Claude Code — How Claude remembers your project (`@path` import ≤ 4 hops, bỏ qua code span; ≤ 200 dòng; AGENTS.md chỉ đọc khi không có CLAUDE.md, cần v2.1.277+; `.claude/rules/` `paths:`; "context, not enforced configuration"): <https://code.claude.com/docs/en/memory.md> — xác minh 2026-10-13
- OpenAI Codex — AGENTS.md (global → gốc → lồng; `AGENTS.override.md`; `project_doc_max_bytes` 32 KiB): <https://learn.chatgpt.com/docs/agent-configuration/agents-md> — xác minh 2026-10-13
- GitHub Copilot — repository custom instructions (`.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` `applyTo`; đọc `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`): <https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions> — xác minh 2026-10-13
- Agent Skills specification (`name` ≤ 64, `description` ≤ 1024, thư mục trùng tên, < 500 dòng, `skills-ref validate`): <https://agentskills.io/specification> — xác minh 2026-10-13
- llms.txt v2 (Jeremy Howard; 2024-09-03, cập nhật 2026-08-10): <https://llmstxt.org/> — xác minh 2026-10-13
- MCP specification 2026-07-28 (`tools/list` thứ tự xác định, trace context trong `_meta`) theo [`../../research/2026-10-13-ai-agent-research.md`](../../research/2026-10-13-ai-agent-research.md) — xác minh 2026-10-13
- [`../../research/2026-10-13-claude-code-hooks-skills.md`](../../research/2026-10-13-claude-code-hooks-skills.md) (AGENTS.md trong Claude Code, `--bare` bỏ hook/CLAUDE.md) — 2026-10-13
- Catalog `seeker19110/stored` 04 §4 (bộ file đa harness; `next dev` ghi đè), 16 §2–2d (llms.txt adoption 2–10 %, repomix `--sandbox`, EXTRACTED/INFERRED), 20 §1.5/§3b/§3c (SKILL.md tốt; vendor-with-lock; `SCOPE.md` + `.out-of-scope/`), 23 §3.1/§3.3/§4.3 (`runtime.yaml`, thang mức bền) theo [`../../research/2026-10-13-stored-catalog-extraction.md`](../../research/2026-10-13-stored-catalog-extraction.md), đọc 2026-10-13.
- Catalog `seeker19110/stored` 20 §3g (bảng "Top Claude Code": chồng pack chỉnh giọng, impeccable chạy engine ở hook, `DO_NOT_TRACK`) — đọc 2026-10-15.
- Catalog `seeker19110/stored` 20 §3h (midudev/autoskills: dò stack → cài skill từ registry vendor có review hai tầng bằng model + SHA-256 + `skills-lock.json`; license CC BY-NC 4.0 phi thương mại) — đọc 2026-10-15.
- `google-labs-code/design.md` — spec DESIGN.md + CLI `@google/design.md`: <https://github.com/google-labs-code/design.md> · <https://www.npmjs.com/package/@google/design.md> — npm `latest` 0.4.0 (phát hành 2026-07-27) xác minh 2026-10-16; trạng thái alpha theo stored 06 §7c (chưa xác minh lại trên repo). Catalog `seeker19110/stored` 06 §7c, đọc 2026-10-16.
