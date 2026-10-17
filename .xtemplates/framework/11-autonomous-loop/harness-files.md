---
title: File harness: PLAN · PROGRESS · BLUEPRINT · evidence · state
kind: module
prefix: LOOP-HARNESS
applies_to: [all]
updated: 2026-10-16
---

# File harness: PLAN · PROGRESS · BLUEPRINT · evidence · state

> Harness của khung là **một bộ file trên đĩa** mà cả người, hook và `xt.py` cùng đọc. Module này quy định từng file
> chứa gì, ai được ghi, máy kiểm thế nào, và cái gì commit vào repo. Áp dụng cho mọi dự án chạy agent theo khung.

## Nguyên tắc

1. **Mỗi loại sự thật có một file gốc** (P5): phạm vi chất lượng = `BLUEPRINT.md`; việc = `PLAN.md`; trạng thái phiên =
   `PROGRESS.md`; bằng chứng = `.autopilot/evidence/`; vòng chạy = `.autopilot/state.json`; luật agent = `AGENTS.md`.
2. **Code điền trường "đã làm"**: `exit_code`, `cmd`, `head`, `started/finished` do `xt.py loop record` ghi. Model chỉ
   đổi dấu `[ ]`→`[x]` sau khi code đã ghi bằng chứng (stored 23 §3.1 `verified_by`).
3. **Lệnh chạy không suy diễn từ văn xuôi**: `xt.yaml` (YAML phẳng `task: lệnh`) là nguồn cho `dev-task.sh`, `/gate`
   và Gate của PLAN. Agent từng suy diễn lệnh từ README và bị `unverified` 11 lần liên tiếp (stored 23 §3.3).
4. **Tài liệu trạng thái phải tươi bằng máy**: SHA ghi trong `PROGRESS.md` phải là tổ tiên của HEAD (luật ở `LOOP-HARNESS-004`/`005`); README chỉ là tuyên bố.
5. **Nhỏ và có cấu trúc**: `PROGRESS.md` ≤ 8 KB, 4 mục; SessionStart chỉ nạp các mục Đang làm/Tiếp theo/Quyết định/Bàn giao.

## Quyết định

### Bộ file và quyền ghi

| File | Chứa gì | Ai ghi | Commit? | Máy kiểm |
|---|---|---|---|---|
| `PROJECT.md` | Vấn đề, người dùng, chỉ số, "không làm" (G0) | Người + agent ở G0 | Có | Cổng G0 có ≥ 1 chỉ số đo được |
| `BLUEPRINT.md` | Mục có ID ghép từ khung (G1) | `xt.py compose` sinh; chỉ đổi trạng thái tick | Có | `blueprint-status --strict` (cổng phát hành G7) |
| `docs/autopilot/PLAN.md` | Task `T-NNN` + Gate; 4 con số theo [`LOOP-DESIGN-001`](loop-design.md); điểm dừng dự kiến | Agent soạn, **người duyệt** một lần | Có | `parse_plan` (regex `- [ ] \`T-\d{3,}\``, `Gate:`) |
| `PROGRESS.md` | 4 mục: Đang làm · Tiếp theo · Quyết định · Bàn giao phiên | Agent, cuối mỗi task/phiên | Có | `xt.py progress-check` (≤ 8 KB; SHA là tổ tiên HEAD) — luật ở `LOOP-HARNESS-004`/`005` |
| `.autopilot/state.json` | `active, plan, blueprint, max_iterations, iterations, deadline, same_failure_count, last_failure_signature, blocked` | `xt.py loop` (ghi atomic qua `.tmp`) | **Không** (gitignore, theo máy) | `loop status` |
| `.autopilot/evidence/T-NNN.json` | `task, cmd, exit_code, started, finished, head, output_tail` (40 dòng) | `xt.py loop record` | Không (bằng chứng cục bộ); bằng chứng chia sẻ = link CI/PR | `loop_verdict` so `cmd` với Gate |
| `xt.yaml` | Khoá `format · lint · typecheck · test · build · format_file` (dev-task chạy) + khoá khai báo khác (`install`, `dev`, `e2e`, `migrate`, `init`, `smoke`, `audit`…) cho agent đọc | Người/agent ở G5 | Có | `dev-task.sh gate` đọc được (xem `LOOP-HARNESS-008`) |
| `AGENTS.md` (+ `CLAUDE.md` chứa `@AGENTS.md`) | Luật agent, lệnh, cấu trúc, điểm dừng | Người | Có | Script so bản gốc trong `docs/agents/` ([`XC-DOCAI-007`](../18-cross-cutting/docs-for-ai-agents.md)) |
| `.claude/settings.json` + `.claude/hooks/*.sh` | Quyền allow/ask/deny, 4 hook | Người; agent sửa phải qua `ask` | Có | `bash -n`, test hook |
| `docs/adr/`, `docs/SPEC-*.md`, `THREAT-MODEL.md` | Quyết định, đặc tả, mối đe doạ | Agent soạn, người duyệt | Có | Link từ PR `feat:` |
| `TRAPS.md` (tuỳ chọn) | Bẫy đã mắc thật: triệu chứng → cách rà → chốt chặn → ngày/PR | Agent sau mỗi lỗi lặp | Có | Mỗi `fix:` lặp lại phải trỏ TRAPS |

### Định dạng PLAN (parser thật trong `xt.py`)

```markdown
- [ ] `T-001` Dựng CI lint/type/test — Gate: `scripts/dev-task.sh gate`
- [ ] `T-002` API tạo đơn hàng theo SPEC-order — Gate: `python3 -m pytest tests/order -q`
```

Dòng task khớp `^- \[( |x|~)\] \`T-\d{3,}\``; Gate lấy từ `Gate:\s*\`...\`` (chuỗi phải **y nguyên** khi `loop record`; phần bí mật
được so ở dạng đã che như trong evidence). Dòng *giống* task mà sai định dạng (thụt lề, thiếu backtick, ID ngắn, ô lạ) → `verify`,
không bị bỏ qua im lặng; task `[~]` phải ghi `— Bỏ: <lý do>`.
Mẫu đầy đủ: [`../templates/PLAN.md`](../templates/PLAN.md); PROGRESS: [`../templates/PROGRESS.md`](../templates/PROGRESS.md).

### Context vs memory vs tài liệu

| Loại | Sống ở đâu | Ai sửa | Ví dụ |
|---|---|---|---|
| Context phiên | Cửa sổ model, compaction | Harness | Hội thoại, tool output |
| Trạng thái việc | `PLAN.md`, `PROGRESS.md`, `.autopilot/` | Code + agent | Task nào xong, chữ ký lỗi |
| Memory dài hạn | File trong repo (`docs/`, `TRAPS.md`, ADR) qua đề xuất → người duyệt → ghi | Người duyệt | Quy ước, bẫy, quyết định |
| Tài liệu tham chiếu | `.xtemplates/framework/` | Chỉ qua PR vào khung | Checklist có ID |
| Memory tra cứu (tuỳ chọn) | **Tối đa một** công cụ ngoài, kho ngoài repo ([`LOOP-HARNESS-019`](#checklist), [`LOOP-HARNESS-021`](#checklist)) | Agent ghi có chủ đích qua tool; không thay ba dòng trên | "Lần trước sửa lỗi X thế nào" qua nhiều phiên |

**Một hay nhiều công cụ memory ngoài? Một, hoặc không cần.** Nguồn sự thật của dự án vẫn là file harness ở trên, vì máy kiểm được (`progress-check`, Gate, evidence). Công cụ ngoài chỉ thêm khả năng tìm lại qua nhiều phiên. Không cài nhiều công cụ cùng lúc: engram, claude-mem, agentmemory đều hook SessionStart/UserPromptSubmit nên context chèn mỗi lượt nhân lên, chỉ thị của chúng chồng nhau, cùng một sự việc có nhiều bản ghi không rõ bản nào đúng, và mỗi công cụ giữ thêm một bản prompt nhạy cảm. Khi cần một công cụ:

| Công cụ | Chọn khi | Lưu ý |
|---|---|---|
| **engram** (MIT) — đề xuất mặc định | Muốn agent **ghi có chủ đích** qua tool `mem_save`, khớp [`AI-AGENT-009`](../13-ai-engineering/agents-and-tools.md) (ghi qua pipeline có nguồn) và [`PRF-AGENT-013`](../02-profiles/ai-agent.md) (ghi có cấu trúc qua tool tường minh); một binary Go, SQLite FTS5 tất định, chỉ nghe loopback, 14 agent | Hook lưu nguyên văn prompt và chèn chỉ thị mỗi lượt; Git Sync ghi `.engram/` vào repo — cấu hình theo `LOOP-HARNESS-021` |
| claude-mem (Apache-2.0) | Muốn ghi **tự động** mọi phiên, chấp nhận AI nén nội dung | Nội dung memory do AI chọn, khó duyệt trước khi ghi; thêm vector store |
| agentmemory (Apache-2.0) | Cần benchmark truy xuất, chấp nhận engine riêng | Engine iii theo Elastic License 2.0, không phải OSI |

Nguồn: catalog `seeker19110/stored` 10 §4b (agentmemory), §4c (engram), 03 §8b (claude-mem) — đọc 2026-10-16.

## Checklist

- [ ] `LOOP-HARNESS-001` **MUST** `PLAN.md` dùng đúng cú pháp parser: mỗi task một dòng bắt đầu bằng `- [ ]` rồi mã `T-NNN` trong backtick, việc, và `Gate:` theo sau là lệnh trong backtick; không lồng danh sách con. → Kiểm: `xt.py loop status` không báo "PLAN không có task"; số task parse được = số dòng `T-`.
- [ ] `LOOP-HARNESS-002` **MUST** Lệnh Gate của mỗi task lấy từ `xt.yaml`/`dev-task.sh` hoặc là lệnh test cụ thể, chạy được trên máy sạch; không ghi "kiểm tay". → Kiểm: `grep -c 'Gate: `' docs/autopilot/PLAN.md` = số task; mỗi Gate chạy được trong CI.
- [ ] `LOOP-HARNESS-003` **MUST** `PLAN.md` ghi đủ 4 con số theo [`LOOP-DESIGN-001`](loop-design.md) (trần vòng · ngân sách tiền/token · timeout mỗi lệnh kiểm · hạn chót) và danh sách điểm dừng bắt buộc dự kiến trước cổng duyệt. → Kiểm: mục "Ngân sách" và "Điểm dừng" tồn tại; trần vòng và hạn khớp tham số `loop init`.
- [ ] `LOOP-HARNESS-004` **MUST@L** Nhà của luật định dạng `PROGRESS.md` (mục sàn: [`BASE-DOC-008`](../01-baseline/documentation-minimum.md)): ≤ 8 KB, đúng 4 mục (Đang làm · Tiếp theo · Quyết định · Bàn giao phiên); lịch sử dài chuyển sang `CHANGELOG.md`/`docs/`. → Kiểm: `xt.py progress-check` exit 0 (≤ 8192 byte, đúng 4 mục theo thứ tự). · Nguồn: stored 23 §2.1
- [ ] `LOOP-HARNESS-005` **MUST@L** Nhà của luật độ tươi `PROGRESS.md`: mục Bàn giao ghi SHA commit cuối và nhánh; SHA phải là tổ tiên của HEAD và **đã có trên nhánh chính** (squash-merge xoá SHA của nhánh PR, nên không kiểm "nhánh còn trên remote"). → Kiểm: `xt.py progress-check` exit 0 trong CI (mọi SHA ở Bàn giao là tổ tiên HEAD và của nhánh chính: `XT_PROGRESS_BASE`, mặc định `origin/HEAD` → `origin/main` → `origin/master`; checkout `fetch-depth: 0`). · Nguồn: stored 21 §8 điểm 9
- [ ] `LOOP-HARNESS-006` **MUST@L** `.autopilot/` nằm trong `.gitignore`; bằng chứng chia sẻ cho người khác là link CI run/PR, không phải file cục bộ. → Kiểm: `git check-ignore .autopilot/state.json` exit 0; PR có link run CI.
- [ ] `LOOP-HARNESS-007` **MUST@L** `BLUEPRINT.md` được sinh bằng `xt.py compose`, commit ở G1; chữ của mục không bị sửa tay, chỉ đổi trạng thái. → Kiểm: diff với bản `compose` lại chỉ khác cột trạng thái và `— Miễn:`. · Nguồn: 00-method/composition.md
- [ ] `LOOP-HARNESS-008` **MUST** Nhà của bộ khoá `xt.yaml` (mẫu: [`../templates/xt.yaml`](../templates/xt.yaml)): khai `lint`, `test`, `typecheck`, `build` (chuỗi rỗng nếu không áp dụng); agent không suy diễn lệnh từ README. `scripts/dev-task.sh` chỉ chạy các khoá `format · lint · typecheck · test · build · format_file` (`gate` = build→typecheck→lint→test); khoá khác (`install`, `dev`, `e2e`, `migrate`, `init`, `smoke`, `audit`…) là lệnh khai báo để agent **đọc và chạy trực tiếp**, dev-task không chạy. Khi autopilot đang chạy, `lint`/`test` rỗng hoặc no-op (`true`, `:`, `exit 0`, `echo …`) làm cổng **đỏ** (ADR-0011 của repo khung). → Kiểm: `scripts/dev-task.sh gate` chạy đúng lệnh khai; `xt.yaml` tồn tại ở gốc; `xt.py loop init` không in `Cổng sẽ ĐỎ`. · Nguồn: stored 23 §3.3
- [ ] `LOOP-HARNESS-009` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`XC-DOCAI-002`](../18-cross-cutting/docs-for-ai-agents.md) (`CLAUDE.md` chứa dòng `@AGENTS.md` ngoài code block).
- [ ] `LOOP-HARNESS-010` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`XC-DOCAI-007`](../18-cross-cutting/docs-for-ai-agents.md) (bản gốc `AGENTS.md` giữ trong `docs/agents/`, CI so sánh).
- [ ] `LOOP-HARNESS-011` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`XC-DOCAI-002`](../18-cross-cutting/docs-for-ai-agents.md) (file bridge cho harness khác chỉ trỏ về `AGENTS.md`).
- [ ] `LOOP-HARNESS-012` **MAY** Ngừng dùng 2026-10-14 — thay bằng [`LOOP-HARNESS-018`](#checklist) (bỏ yêu cầu biến môi trường tắt hook: agent tự đặt được = nới hàng rào ADR-0002).
- [ ] `LOOP-HARNESS-013` **SHOULD** Bẫy đã mắc thật ghi vào `TRAPS.md` theo mẫu triệu chứng → nguyên nhân → cách rà → chốt chặn → ngày/PR; `fix:` lặp lại phải trỏ tới mục TRAPS. → Kiểm: PR `fix:` có link `TRAPS.md#...` khi lỗi tái phát. · Nguồn: stored 23 §2.4
- [ ] `LOOP-HARNESS-014` **SHOULD** Danh sách tính năng dạng máy đọc (`features.json` hoặc PLAN) chỉ cho phép agent đổi trường trạng thái, không xoá/sửa tiêu chí. → Kiểm: CI diff: số task không giảm; tiêu chí không đổi ngoài cột trạng thái. · Nguồn: Anthropic harness 2025-11-26
- [ ] `LOOP-HARNESS-015` **SHOULD** Bằng chứng chạy thật của mỗi mốc (đầu ra lệnh, ảnh, báo cáo) lưu `docs/bang-chung/<ngày>/`, tách khỏi tuyên bố trong README. → Kiểm: thư mục tồn tại cho mỗi G7; README trỏ tới.
- [ ] `LOOP-HARNESS-016` **MAY** Dùng `preflight`/`init.sh` chạy đầu phiên (cài dep, dev server, smoke test) để agent định vị lại trước khi làm. → Kiểm: `xt.yaml` có khoá `init` (lệnh khai báo: agent đọc và chạy trực tiếp, `dev-task.sh` không chạy khoá này); `AGENTS.md` hoặc SessionStart nhắc chạy.
- [ ] `LOOP-HARNESS-017` **MAY** Mọi tool cần `jq`/Python được khai trong `AGENTS.md` mục "Công cụ cần có" để phiên cloud không thiếu. → Kiểm: SessionStart hook in cảnh báo khi thiếu.
- [ ] `LOOP-HARNESS-018` **SHOULD** Hook **không** có biến môi trường tắt riêng (biến tắt guard = nới hàng rào, agent tự đặt được); tắt có chủ đích dùng cơ chế của harness mà người thấy (Claude Code: `"disableAllHooks": true` ở settings người dùng). Mọi hook fail-open về luồng khi stdin rỗng/không phải JSON hoặc thiếu công cụ (jq/python). → Kiểm: hook không đọc biến kiểu `*_DISABLE*`/`*_SKIP_HOOK*`; `tests/` chạy từng hook với stdin rỗng và rác → exit 0, không ra quyết định chặn; guard Bash hỏi người khi lệnh mở phiên agent bỏ qua hook (Claude Code: `--bare`, `--safe-mode`, `--settings`, `--setting-sources`, `--restricted`, `CLAUDE_CODE_SIMPLE`/`CLAUDE_CODE_SAFE_MODE`, chuỗi `disableAllHooks`). · Nguồn: Claude Code docs *Hooks* (`disableAllHooks`) và *CLI reference* (cờ/biến bỏ qua hook), đọc 2026-10-15
- [ ] `LOOP-HARNESS-019` **SHOULD** Công cụ memory ngoài cho coding agent (agentmemory, claude-mem…) chỉ dùng để **tra cứu**, không thay `PROGRESS.md`/`TRAPS.md`/`PLAN.md`; tắt chèn tự động đầu phiên ở repo nhạy cảm, bind loopback, bật lọc bí mật trước khi lưu. → Kiểm: cấu hình công cụ (`auto-inject` tắt, bind `127.0.0.1`); `PROGRESS.md` vẫn qua `xt.py progress-check`. · Nguồn: `seeker19110/stored` 10 §4b (agentmemory)
- [ ] `LOOP-HARNESS-020` **SHOULD** Mỗi lần chạy autopilot bắt đầu bằng audit khung đã cài và sửa phần an toàn trước khi lập kế hoạch: hook bắt buộc (SessionStart · PreCompact · PreToolUse · Stop) có trong settings và file hook (kể cả file chúng nạp) tồn tại, đúng cú pháp; `CLAUDE.md` import `AGENTS.md`; `xt.yaml` đủ khoá; `.autopilot/` bị gitignore; state không hỏng; khung `validate` xanh. Hook thiếu fail-open nên **không tự lộ** — chỉ máy kiểm mới thấy. Sửa tự động chỉ phần đảo ngược được; hook/settings là điểm dừng, để người cài lại. → Kiểm: `xt.py doctor --fix` exit 0 trước `loop init` (`loop init` cảnh báo trên stderr khi còn lỗi). · Nguồn: `scripts/xt.py` (`doctor_findings`), `.claude/hooks/_lib.sh` (fail-open) — đọc 2026-10-15
- [ ] `LOOP-HARNESS-021` **SHOULD** Bổ sung cho `LOOP-HARNESS-019` khi dùng công cụ memory ngoài: (1) chỉ bật **một** công cụ (engram, claude-mem, agentmemory… cùng hook SessionStart/UserPromptSubmit và cùng chèn context mỗi lượt); (2) kho memory nằm **ngoài repo**, quyền chỉ chủ sở hữu, coi là dữ liệu nhạy cảm vì có công cụ lưu **nguyên văn prompt**; nội dung nhạy cảm bọc thẻ loại trừ của công cụ (vd `<private>…</private>`); (3) tính năng đồng bộ memory **vào repo** (vd `engram sync` ghi `.engram/`) tắt ở repo công khai, ở repo riêng thì thư mục đó phải qua quét bí mật trước commit. → Kiểm: `xt.py doctor` không có cảnh báo `memory` (đếm công cụ memory theo tên trong `enabledPlugins` cấp người dùng/dự án/cục bộ và MCP server ở `~/.claude.json` + `.mcp.json`, ≤ 1; `.engram/` không nằm trong git); `stat -c %a` thư mục kho memory = `700`; repo riêng: gitleaks quét `.engram/` = 0 phát hiện. · Nguồn: `seeker19110/stored` 10 §4c (engram: hook lưu prompt cục bộ và chèn chỉ thị mỗi lượt, Git Sync ghi `.engram/` vào repo, `<private>` lọc hai tầng)
- [ ] `LOOP-HARNESS-022` **SHOULD** Phiên autopilot không người trực chạy trong sandbox mức hệ điều hành của host (ghi giới hạn trong workspace, mạng chặn mặc định + allowlist registry/git) hoặc trong devcontainer/VM có egress allowlist; guard hook không phải sandbox (chỉ thấy lệnh qua tool, không chặn tiến trình con hay mạng). Nâng thành **MUST@L** khi phiên chạy không người trực với quyền ghi và mạng. Tên khoá cấu hình sandbox cụ thể của Claude Code: (chưa xác minh) — đọc tài liệu hiện hành, không đoán tên. → Kiểm: từ trong phiên chạy `curl` tới domain ngoài allowlist → bị chặn; ghi lệnh + output làm bằng chứng (`loop record`); thử ghi ngoài workspace → bị từ chối. · Nguồn: stored 11 §3/§3b (`anthropics/sandbox-runtime`: Seatbelt/bubblewrap, proxy allowlist)

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Gate trong PLAN khác chuỗi khi `loop record` (thêm cờ, đổi đường dẫn) | verdict `verify` kẹt | Chép nguyên chuỗi; đổi Gate thì sửa PLAN trước |
| PROGRESS phình thành nhật ký 300 dòng, lẫn dự án khác | SessionStart nạp rác, tốn context, sai trạng thái | 4 mục, ≤ 8 KB; lịch sử ra CHANGELOG |
| Có `CLAUDE.md` nhưng không `@AGENTS.md` | Luật trong AGENTS.md không được nạp | Dòng import; CI grep |
| Hai bản copy hàm hook (`_lib.sh` trôi nhau) | Hook sửa một nơi, nơi kia cũ | Một `_lib.sh` dùng chung, test |
| Commit `.autopilot/state.json` | Xung đột, vòng chạy của máy này đè máy kia | gitignore; mỗi máy `loop init` |
| Agent "viết lại" todo/PLAN mỗi vòng | Tốn ~30 % token, mất lịch sử | Chỉ đổi trạng thái; kế hoạch mới = PR sửa PLAN |
| `.framework-dropins`/file sinh để lại trong repo đích | Hook crash, CI đỏ khó hiểu | Script cài có bước dọn; validate repo |
| Coi hook guard là sandbox | Tiến trình con, script tạm, `curl` ra mạng đi ngoài tầm hook | Sandbox OS hoặc devcontainer/VM có egress allowlist; thử `curl` ngoài allowlist phải bị chặn (`LOOP-HARNESS-022`) |

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Audit khung | `xt.py doctor --fix` | Đầu mỗi `/autopilot`; `loop init` chạy phần nhanh | 0 lỗi ✗ |
| Parser PLAN | `xt.py loop status --json` | SessionStart, CI | Không `blocked` vì PLAN |
| Định dạng PROGRESS | `xt.py progress-check` (≤ 8192 byte, 4 mục) | pre-commit, CI | exit 0 |
| Tươi SHA | `xt.py progress-check` (bên trong: `git merge-base --is-ancestor <SHA> HEAD` và nhánh chính cho mọi SHA ở Bàn giao) | thêm vào `lint` trong `xt.yaml` + CI | exit 0 |
| Blueprint | `xt.py blueprint-status BLUEPRINT.md --strict` | Cổng phát hành G7 (dự án tự thêm vào CI khi phát hành) | 0 MUST mở |
| Hợp đồng repo | `xt.py validate` (quy ước khung) | pre-commit + CI | 0 lỗi |
| Hook | `bash -n .claude/hooks/*.sh && python3 -m unittest discover -s tests` | CI | xanh |
| Sandbox phiên | `curl` tới domain ngoài allowlist từ trong phiên autopilot | Trước khi bật chạy không người trực | bị chặn; có evidence |

## Nguồn

- `scripts/xt.py` (`TASK_RE`, `GATE_RE`, `parse_plan`, `read_evidence`, `write_state`, `project_dir`) và `.claude/hooks/session-start.sh`, `.gitignore` của khung — đọc 2026-10-13.
- Claude Code docs — memory/CLAUDE.md và `AGENTS.md` (chỉ đọc khi không có CLAUDE.md; import `@file`): <https://code.claude.com/docs/en/memory> — theo `research/2026-10-13-claude-code-hooks-skills.md` (xác minh 2026-10-13).
- AGENTS.md (quy ước, không phải schema; >60k dự án; Agentic AI Foundation): <https://agents.md/> — xác minh 2026-10-13.
- Anthropic, *Effective harnesses for long-running agents* (feature list JSON chỉ sửa `passes`, `claude-progress.txt`, `init.sh`): <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents> — theo research [F].
- `seeker19110/stored` mục 21 §2, §8 điểm 9; mục 23 §2.1, §2.4, §3.3, §4.5 (`runtime.yaml`, `check_status_freshness`, `validate_repo`, TRAPS) — đọc 2026-10-13.
- Catalog `seeker19110/stored` 10 §4b (agentmemory: bind loopback, lọc bí mật, nên giữ vai tra cứu) — đọc 2026-10-15.
- Catalog `seeker19110/stored` 10 §4c (engram: một binary Go + SQLite FTS5; hook lưu nguyên văn prompt, chèn chỉ thị mỗi lượt; Git Sync ghi `.engram/` vào repo; thẻ `<private>` lọc ở plugin và store) — đọc 2026-10-16.
- Catalog `seeker19110/stored` mục 11 §3b (`anthropics/sandbox-runtime`, trước ở anthropic-experimental, 5,5k★, Apache-2.0: sandbox mức hệ điều hành không cần container — Seatbelt trên macOS, bubblewrap trên Linux; mạng chặn mặc định, chỉ mở domain allowlist qua proxy; beta research preview, định dạng config có thể đổi) và §3 — đọc 2026-10-16; tên khoá settings sandbox của Claude Code (chưa xác minh).
