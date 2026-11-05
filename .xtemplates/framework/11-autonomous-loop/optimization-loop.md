---
title: Vòng tối ưu hiệu năng trong autopilot: đo → profile → một thay đổi → máy quyết giữ/hoàn tác
kind: module
prefix: LOOP-OPT
applies_to: [all]
updated: 2026-11-05
---

# Vòng tối ưu hiệu năng trong autopilot

> Tối ưu là việc agent **dễ làm giả nhất**: số đo là tín hiệu thưởng, và nghiên cứu về agent tối ưu mã đều ghi nhận
> chúng ăn gian khi có thể (cache kết quả, hard-code input, đổi đồng hồ, sửa hàm chấm). Module này đặt **một
> vòng cố định do máy quyết** cho task tối ưu. *Đo cái gì, ngưỡng bao nhiêu* là nhà của
> [`XC-PERF`](../18-cross-cutting/performance-engineering.md), [`QA-PERF`](../14-testing-quality/performance-and-load.md),
> [`FE-PERF`](../07-frontend/performance-web-vitals.md); module này chỉ là **quy trình trong vòng lặp** và công cụ `xt.py perf`.

## Vòng cho một task tối ưu

Mỗi task tối ưu là một dòng `T-NNN` thường trong `PLAN.md` (parser không đổi); mỗi lần thử do `xt.py perf trial` quản trọn
(ADR-0071 của khung), Gate của task là `perf trial status --check`.

1. **Mở task chỉ khi có mục tiêu số** (`XC-PERF-001`) hoặc ngân sách đang bị vượt. Không số thì không tối ưu (tránh tối ưu sớm, vi tối ưu không đo được).
2. **Khoá bộ đo trước khi sửa** (kiểu `prepare.py` của autoresearch): `perf/trial.json`, harness đo, test tương đương, bộ sinh held-out commit ở nhánh mặc định (PR riêng). Máy đọc cấu hình và `xt.py` từ **commit gốc** = đầu nhánh mặc định do máy chủ báo (agent không chọn được), khoá thêm cấu hình, `xt.py`, file khởi động trình chạy, manifest, lockfile, `.venv/`, `node_modules/`, `.gitignore`; candidate đụng file khoá → `tampered`, thu hồi.
3. **Baseline đo lại cùng lượt:** `finish` dựng ba cây (gốc, `start_head`, candidate) từ tree object ngoài cây agent, `setup` với môi trường allowlist, kiểm trỏ đúng cây, rồi đo **xen kẽ** (B K C, K C B…; A/A theo khối: 18 % `improved` sai, xen kẽ: 0 %), mỗi lần chạy `HOME`/`XDG_*`/`TMPDIR` mới. Ưu tiên số tất định (`kind: exact` — lệnh, byte, truy vấn, token; ≥ 3 lần phải trùng); `wall` ≥ 10 lần (máy tự đo thời gian; đầu ra lệnh so với gốc — lệnh đo chỉ in kết quả tất định, không in thời gian). Không file baseline nào agent sửa được.
4. **Profile, rồi mới chọn điểm nóng** (flamegraph, `EXPLAIN (ANALYZE, BUFFERS)`, `pg_stat_statements`, py-spy…). Chỉ nhận ứng viên có **trần tăng tốc** Amdahl `1/((1−p)+p/s)` đủ cho mục tiêu: tăng tốc 10 000× phần chiếm 10 % chỉ cho ≈ 1,11×.
5. **Một giả thuyết, một thay đổi:** `perf trial start --hotspot A --hotspot B --hypothesis … --falsifier '<chỉ số> <op> <%>'` (một cờ mỗi file) trên cây sạch — máy chứng minh giả thuyết và *falsifier* (số nào thì bỏ) có **trước** khi sửa; candidate chỉ được đổi file điểm nóng (`off-hotspot`).
6. **Máy quyết:** `perf trial finish` giữ ⇔ chỉ số chính `improved` (p < 0,05 **và** đổi ≥ max(2 %, MAD/trung vị) — nhiễu máy đo là sàn) so với gốc **và** `start_head` · `equiv` xanh, đầu ra chỉ số chính bằng gốc · held-out đạt · chỉ số phụ không vượt `ceiling`/`regress` · falsifier không trúng. Còn lại máy thu hồi (stash đúng danh sách file, vân tay = lúc `start`) — agent không tự hoàn tác, không `loop record` từng lần thử.
7. **Ghi sổ, siết ratchet:** thử nào cũng vào `.autopilot/perf-trials.jsonl` (giữ hay bỏ, lý do, số ba cây, ⚠); `perf trial log` dựng khối của vòng trong `docs/autopilot/PERF-LOG.md` để commit; giữ thì commit candidate, `start` kế đòi đúng cây đó; ngân sách mới commit, không nới.
8. **Dừng:** `status --check` exit 0 (chỉ số chính và held-out gộp đạt `target`) thì dừng, không tối ưu vượt; `start` exit 3 khi một đường 3 lần không giữ hoặc hết `budget` → đổi điểm nóng hoặc `loop defer`.

Cấu hình ví dụ (`perf/trial.json`, đường cố định, đọc từ blob gốc; khoá đầy đủ: ADR-0071 §1) và Gate của task trong PLAN-opt — ``Gate: `python3 -I <(git cat-file blob refs/remotes/origin/HEAD:.xtemplates/scripts/xt.py || echo 'raise SystemExit(2)') perf trial status --check` `` (repo khung: `scripts/xt.py`; công cụ chấm lấy từ gốc, không từ cây candidate; không đọc được blob → exit 2, không xanh vì script rỗng; mọi lệnh `perf trial` tự `exec` bản gốc khi byte khác). Đường sổ sách (`docs/autopilot/**` — PLAN-opt, DECISIONS, PERF-LOG — và `PROGRESS.md`) được miễn khi so cây neo: commit PLAN-opt/D-NNN trên nhánh trước `start`, tick sau lần giữ, squash-merge PR vào nhánh mặc định (Gate nhận lần giữ của vòng trước khi cây không đổi) không làm `start`/`status --check` đỏ; đổi lại `start` từ chối cấu hình có lệnh/khoá nhắc các đường đó (D-371):

```json
{"schema": 1, "setup": "uv sync --frozen", "locked": ["bench/**", "tests/equiv/**"],
 "metric": {"cmd": "python3 bench/count.py", "kind": "exact", "unit": "lệnh", "higher_is_better": false, "runs": 3},
 "secondary": [{"name": "rss", "cmd": "python3 bench/rss.py", "kind": "exact", "unit": "KiB", "ceiling": 200000, "regress": 0}],
 "target": "primary <= -20%", "budget": 20, "equiv": "python3 -m pytest -q tests/equiv",
 "heldout": {"gen": "python3 bench/gen.py", "cmd": "python3 bench/count.py {input}"}, "timeout": 300}
```

Lệnh (exit chung: 2 = từ chối trước khi đụng cây agent · 4 = thu hồi nhưng vân tay lệch → dừng, `loop defer`): `start` · `prepare` (dựng ba cây, chạy `setup`, kiểm trỏ đúng cây — thử cấu hình) · `finish [--json]` (0 giữ · 1 đã thu hồi) · `finish --no-apply` (quyết, ghi sổ, in lệnh thu hồi; `finish --resume` làm nốt) · `finish --resume` (chết giữa lượt: đo lại **một** lần nếu cây = candidate đã đóng băng, không thì `incomplete` và thu hồi; pha `decided`: làm nốt giữ/thu hồi) · `abort --reason` (thu hồi, tính vào ba lần) · `status [--check]` (pha, lệnh kế) · `log [--check]`. SIGTERM/SIGINT giữa lượt đo → dòng `interrupt`, pha về `started`, exit 2 — `finish` đo lại.

Giới hạn còn lại của `perf trial`: tiến trình cùng uid vẫn (1) sửa thẳng file trong `.git` (config, ref, object) ngoài kênh guard thấy — lớp hai là sandbox (ADR-0067); (2) đặt `git`/`python3` giả trên thư mục `PATH` ghi được đứng trước bản thật (`xt.py` gọi `git` theo `PATH`; mục `env.path` ghi được chỉ ⚠ vào dòng `decide`); (3) đọc hạt giống held-out/can thiệp cây tạm trong lúc đo; (4) đọc file sổ sách được miễn khi so cây (PLAN*/DECISIONS*/PERF-LOG trong `docs/autopilot/`, `PROGRESS.md`) qua đường dựng lúc chạy — symlink trỏ vào vùng sổ sách và dòng mã nhắc `docs/autopilot`/`PROGRESS.md` thì `tampered`/Gate 1, mã khác trong `docs/autopilot/` không được miễn (ADR-0071 §2, D-372). Candidate nhiều file vượt ARG_MAX: chính `git stash` chuyển danh sách qua argv cho tiến trình con, mục stash đủ nhưng cây chưa dọn → exit 4, không mất sửa (D-368). Gốc lỗi sau khi đóng băng (`setup`/`equiv`/`heldout.gen` đỏ ở cây gốc, exit 2) để lần thử ở pha `measuring`: sửa cấu hình ở nhánh mặc định không cứu lần thử đó — `abort --reason` (tính vào ba lần) hoặc `finish --resume` (một lần). `perf sample`/`compare`/`guard` dưới đây giữ cho **đo tay** và dự án chưa có `perf/trial.json` — đường lùi khi gỡ skill khỏi `perf trial` (ADR-0071 §Đường lùi, D-371), skill `/optimize` không dẫn đường này. Script mẫu dưới đây là **đo tay, không phải Gate của vòng**: Gate dạng `bash <(git show …:scripts/perf-gate.sh)` bị guard chặn (shell đọc script từ `<(…)`, AUD-SEC-310 — Gate do harness chạy cũng qua guard, LOOP-STOP-027); người chạy nó ở terminal của mình trên script lấy từ commit gốc. Nó đo baseline ở worktree gốc cùng lượt, công cụ chấm xuất lại từ SHA gốc chạy `python3 -I`; nhưng đo theo khối ở cây agent — file bị ignore, `PATH` ghi được, tráo bộ đo giữa các lần chạy, tiến trình cùng uid lừa được (ADR-0071 §Bối cảnh), không phải rào:

```bash
# scripts/perf-gate.sh (dự án tự viết; đo tay, không làm Gate của vòng — D-371)
set -euo pipefail
PY="$(command -v python3)" GIT="$(command -v git)" SHA="$(command -v sha256sum)"   # đường tuyệt đối, đầu Gate, trước mọi mã candidate
base="$("$GIT" rev-parse --verify 'refs/remotes/origin/main^{commit}')"   # SHA một lần, trước mọi mã candidate
wt="$(mktemp -d)"; out="$(mktemp -d)"; trap 'rm -rf "$out"; "$GIT" worktree remove --force "$wt"' EXIT
"$GIT" worktree add -q --detach "$wt" "$base"
XT="$PY -I $wt/.xtemplates/scripts/xt.py"   # chỉ để đo: candidate sửa được bản này khi chạy
(cd "$wt" && $XT perf sample --out "$out/before.json" --harness 'bench/*' -- ./bench/run.sh)   # baseline: commit gốc, ngoài hai cây
sum="$("$SHA" <"$out/before.json")"          # biến shell: candidate không sửa được
$XT perf sample --out "$out/after.json" --harness 'bench/*' -- ./bench/run.sh   # mã candidate chạy từ đây
tool="$(mktemp -d "$out/tool.XXXXXX")"; "$GIT" cat-file blob "$base:.xtemplates/scripts/xt.py" >"$tool/xt.py"
XT="$PY -I $tool/xt.py"                     # công cụ chấm xuất lại từ SHA gốc, không lấy từ $wt
$XT perf guard --base "$base" --locked 'bench/*' --locked 'tests/equiv/*' --locked 'scripts/perf-gate.sh' --strict
[ "$("$SHA" <"$out/before.json")" = "$sum" ] || { echo "✗ before.json bị sửa trong lượt đo" >&2; exit 1; }
$XT perf compare --base "$base" "$out/before.json" "$out/after.json"
```

Vị trí trong vòng đời: **G5** khoá bộ đo + baseline · **G6** mỗi task tối ưu theo vòng trên, một PR mỗi lát · **G7** nhóm "hiệu năng" của `/audit` và số đo trong GO/NO-GO (`QA-PERF-006`) · **G8** field data/SLO dẫn dắt backlog tối ưu kế tiếp (`LOOP-DESIGN-019`). Skill `/optimize` (ADR-0048) nối các bước này; chỉ khi có ngân sách đỏ (giai đoạn sản phẩm 3: thêm mục tiêu `LOOP-OPT-017`).

## Công cụ `xt.py perf`

| Lệnh | Việc | Exit |
|---|---|---|
| `perf trial start/prepare/finish/status/abort/log` | một lần thử do máy quản: đo ba cây xen kẽ, quyết, giữ/thu hồi, sổ (§Vòng ở trên; hợp đồng đủ: ADR-0071 §2) | 0 · 1 · 2 · 3 (`start`/`--check` cạn) · 4 |
| `perf sample --out F [--runs 10 --warmup 2 --timeout 300] [--harness GLOB…] [--higher-is-better] -- <lệnh>` | chạy lệnh nhiều lần, ghi mẫu v2: thời gian tường (s), `env`, `head`/`dirty`/`tree_fp` đo trước lần chạy đầu, `harness_sha256` (lệnh + file khớp `--harness`); ngoài repo git → `head` rỗng, nhãn `unverified-manual`; lệnh lỗi/quá giờ thì không ghi | 0 · 1 lệnh lỗi · 2 thiếu lệnh, git lỗi trong repo, `--harness` ngoài repo git/không khớp/chứa `--out`/khớp gitlink |
| `perf compare B A [--base REF] [--exact] [--no-regress] [--higher-is-better] [--min-effect 0.02] [--json]` | so hai bộ mẫu bằng Mann-Whitney U + sàn nhiễu MAD; `--exact` cho đại lượng tất định. Không xét head/`dirty` của A (candidate). Lệch `env.python`/`env.nproc` → ⚠. File v1/mảng thô/mẫu đo ngoài repo (`dirty` null) → so như cũ, kèm `unverified-manual: true` | 0 = `improved` (`--no-regress`: cả `neutral`) · 1 còn lại · 2 file hỏng, mẫu v2 thiếu/sai kiểu trường, "không đủ điều kiện so" (bước 3; `higher_is_better` của mẫu ≠ cờ; `--base` không phân giải được thành commit, hoặc B không có `head` đúng commit đó) |
| `perf guard --base REF [--locked GLOB…] [--strict]` | worktree so với `REF`, gồm cả file chưa theo dõi: file khoá bị đụng/xoá → đỏ; dòng thêm đáng ngờ (cache/memoize, `sleep`, gán đè/patch đồng hồ, `_getframe`/`inspect.stack`, `-O3`) → ⚠ (`--strict`: đỏ) | 0 · 1 · 2 `--base` không phân giải được thành commit, `git diff` lỗi hoặc glob khoá không khớp file nào |

File mẫu: mẫu v2 của `perf sample` (`dirty`/`tree_fp` bỏ `.autopilot/` và chính `--out` nếu nằm trong cây; `--harness` khớp như `--locked`, bỏ `.autopilot/`, symlink băm chuỗi đích), mảng JSON, `{"samples": [...]}` hoặc các số cách nhau bằng khoảng trắng/dấu phẩy. `--locked` khớp kiểu `fnmatch` (`*` đi qua `/`: `bench/*` khoá cả cây; `**/` nhận cả không thư mục con; bỏ `./` đầu). Giới hạn đã biết: p xấp xỉ chuẩn → **bảo thủ** với n = 10 so với p chính xác của `benchstat`; sàn nhiễu MAD như `criterion`; file chưa theo dõi lọc theo `.gitignore` đã commit ở `--base` (guard tin file này); `.gitignore` đổi/mới → kiểm khoá trên mọi file chưa theo dõi và báo ⚠; `.gitattributes` đổi/mới → ⚠ (diff chạy `--text`, đọc bytes tách theo `\n`: `-diff`, `\r`, U+2028 không giấu dòng); `working-tree-encoding`/`filter`/`ident` → ⚠ (git đổi nội dung trước diff), kể cả luật đã commit (`*.ps1 working-tree-encoding`) và `filter=lfs` — clean filter đến từ config global/system (git-lfs cài sẵn) hay `GIT_CONFIG_*`, không chỉ `.git/config` (hook guard chặn), nên sửa file LFS thật cũng ⚠, `--strict` đỏ (thà báo oan còn hơn lọt); clean filter đưa file về đúng nội dung base thì file biến khỏi danh sách đổi, kể cả file khoá; `assume-unchanged` che dòng thêm lẫn sửa file khoá (guard của harness chặn `update-index` vào vùng rào, không chặn ở file thường); file có NUL trong 8000 byte đầu (heuristic của git) không khớp mẫu — mã nguồn cố tình chứa NUL lọt, việc của `perf trial`; không dùng `core.excludesFile`/`.git/info/exclude` — file sinh khi đo (`__pycache__`…) phải trong `.gitignore` của repo; file chưa theo dõi quét 1 MiB đầu, symlink chỉ quét chuỗi đích; `perf sample` giết cả nhóm tiến trình khi xong/quá giờ/Ctrl-C, không bắt SIGTERM gửi thẳng `xt.py`; `dirty`/`tree_fp` (= vân tay của `loop verify`) còn tin `.git/info/exclude`, `core.excludesFile`, `diff.ignoreSubmodules`/`submodule.<tên>.ignore`, file chưa track trong submodule, clean filter, cờ assume-unchanged/skip-worktree (D-212/D-213); `perf guard` là heuristic báo dấu hiệu, không chứng minh vô tội — reviewer vẫn phải rà, rào thật là `perf trial`.

## Checklist

- [ ] `LOOP-OPT-001` **MUST** Task tối ưu chỉ mở khi có **mục tiêu số kèm điều kiện đo** ([`XC-PERF-001`](../18-cross-cutting/performance-engineering.md)) hoặc ngân sách đang bị vượt; không có số thì không tối ưu. → Kiểm: dòng task trong `PLAN.md` nêu mục tiêu số và Gate là `perf trial status --check` (`target` của `perf/trial.json` ở gốc). · Nguồn: ý "ngân sách trước, đo sau" của `QA-PERF`.
- [ ] `LOOP-OPT-002` **MUST** **Bộ đo khoá:** harness đo, bộ test tương đương hành vi, input đo, **script Gate và công cụ chấm (`xt.py perf`)** nằm ngoài quyền sửa của agent trong task tối ưu — Gate chạy bản của commit gốc và `perf guard --locked …`, đỏ khi diff đụng chúng (kể cả xoá). → Kiểm: `perf/trial.json` ở gốc khai `locked` cho bộ đo; Gate chạy `xt.py` từ blob gốc (`git cat-file blob origin/HEAD:…`); không dòng `decide` nào `kept` khi đụng file khoá (`tampered`). · Nguồn: autoresearch (`prepare.py` "không sửa"); METR 2025-06-05 (hàm chấm bị ghi đè/thay stub).
- [ ] `LOOP-OPT-003` **MUST** **Máy quyết giữ hay hoàn tác:** chỉ giữ thay đổi khi `perf compare` = `improved` trên ≥ 10 mẫu mỗi bên (hoặc `--exact` cho đại lượng tất định), baseline đo lại trên commit gốc cùng lượt và cùng máy, **và** toàn bộ test xanh; còn lại hoàn tác — agent không tự nhận "nhanh hơn". → Kiểm: lần giữ có dòng `decide` `kept` trong `.autopilot/perf-trials.jsonl` (phép so với gốc và `start_head`, `equiv`); evidence `loop record` của Gate `perf trial status --check` exit 0. · Nguồn: benchstat (Mann-Whitney U, α = 0,05, ≥ 10 lần); autoresearch (giữ nếu metric tốt hơn).
- [ ] `LOOP-OPT-004` **MUST@L** **Một giả thuyết, một thay đổi, một lần đo:** ghi kỳ vọng và falsifier trước khi đo ([`LOOP-DESIGN-021`](loop-design.md) áp dụng cho số đo); gộp nhiều thay đổi thì không biết cái nào có tác dụng, cái nào gây hại. → Kiểm: mô tả PR/`PERF-LOG.md` có giả thuyết + falsifier có trước số đo (đối chiếu thứ tự commit).
- [ ] `LOOP-OPT-005` **MUST@M** **Chống gian lận số đo:** mọi dòng `perf guard` báo ⚠ phải được `reviewer` (năng lực cao hơn người viết, `LOOP-ORCH-005`) trả lời từng dòng trước khi giữ; ngoài ra reviewer **tự rà** các kiểu máy không bắt được — hard-code shape/giá trị input, thoát sớm, tắt đồng bộ, hàm kiểm bị thay bằng stub, kết quả tái dùng giữa các lần đo. Lời nhắc "đừng gian lận" không đủ — chỉ giảm tỉ lệ, không loại bỏ. → Kiểm: `pr reviewed --clean` có ghi chú trả lời từng ⚠ và từng kiểu tự rà. · Nguồn: METR 2025-06-05 (30,4 % lượt RE-Bench có hack; nhắc không gian lận chỉ giảm nhẹ); GSO/SWE-fficiency (memoize, hard-code shape/dtype, monkey-patch).
- [ ] `LOOP-OPT-006` **SHOULD** **Profile trước khi sửa:** điểm nóng lấy từ profile/`EXPLAIN (ANALYZE, BUFFERS)`/`pg_stat_statements`, và trần tăng tốc Amdahl của nó đủ cho mục tiêu; không sửa chỗ không chiếm thời gian. → Kiểm: PR đính kèm profile hoặc ghi lý do không áp dụng ([`XC-PERF-005`](../18-cross-cutting/performance-engineering.md)). · Nguồn: định luật Amdahl.
- [ ] `LOOP-OPT-007` **SHOULD** **Đo trên input chưa thấy:** trước khi giữ, đo lại trên tập input/shape không nằm trong bộ đo mà agent đã nhìn (held-out), để bắt đường tắt chỉ đúng với input cũ. → Kiểm: `perf/trial.json` khai `heldout` (`gen` đọc hạt giống, `cmd` có `{input}`); dòng `decide` ghi `heldout` (hạt giống, input, phép so) — không khai thì ghi "LOOP-OPT-007 không áp dụng". · Nguồn: GSO, SWE-fficiency (đường tắt theo shape).
- [ ] `LOOP-OPT-008` **SHOULD** **Chỉ số phụ không xấu đi:** bộ nhớ, p99, kích thước, chi phí được đo cùng lượt và không vượt ngưỡng ghi trong `PROJECT.md`; không đổi chỉ số này lấy chỉ số kia. → Kiểm: `perf/trial.json` khai `secondary[]` (`ceiling`, `regress`) cho từng chỉ số phụ; dòng `decide` có phép so của chúng.
- [ ] `LOOP-OPT-009` **SHOULD** **Ưu tiên đại lượng tất định:** số lệnh (Cachegrind `Ir`), byte, số truy vấn, số token đo bằng `--exact`; thời gian tường chỉ dùng khi nhiễu được kiểm soát (ghim máy/lõi, xen kẽ trước/sau, MAD nhỏ). → Kiểm: Gate nêu đại lượng và cách kiểm soát nhiễu. · Nguồn: Valgrind Cachegrind (đếm lệnh lặp lại cao, thời gian lệch vài phần trăm); SWE-fficiency (ghim lõi, biến thiên < 0,5 %).
- [ ] `LOOP-OPT-010` **SHOULD** **Sổ thử:** `docs/autopilot/PERF-LOG.md` ghi mỗi lần thử (giả thuyết, số trước/sau, giữ hay bỏ, lý do); thử thất bại cũng ghi để vòng sau không thử lại. → Kiểm: file có dòng cho mỗi task tối ưu đã chạy.
- [ ] `LOOP-OPT-011` **SHOULD** **Trần và điều kiện dừng:** đạt mục tiêu thì dừng; 3 lần liên tiếp không `improved` cùng điểm nóng → đổi điểm nóng hoặc `loop defer`. → Kiểm: `loop stats`/`PERF-LOG.md` không có > 3 lần liên tiếp cùng điểm nóng. · Nguồn: nguyên tắc 4 của [`loop-design.md`](loop-design.md) (cùng chữ ký lỗi 3 lần → dừng).
- [ ] `LOOP-OPT-012` **SHOULD** **Siết ratchet, không nới:** sau khi giữ, baseline/ngân sách commit lại theo kết quả mới; nới ngân sách để xanh là quyết định ghi `loop decide` (D-NNN), không phải sửa cấu hình lặng lẽ. → Kiểm: diff ngân sách có D-NNN khi nới.
- [ ] `LOOP-OPT-013` **SHOULD** **Lab chặn PR, field nghiệm thu:** số lab (Lighthouse, benchmark, k6) dùng để gỡ lỗi và chặn PR; ưu tiên và nghiệm thu bằng field (RUM/CWV phân vị 75, SLO) khi có ([`XC-PERF-007`](../18-cross-cutting/performance-engineering.md)). → Kiểm: báo cáo GO/NO-GO ghi cả hai loại số. · Nguồn: web.dev "lab and field data differences".
- [ ] `LOOP-OPT-014` **SHOULD** **Đổi hành vi không phải tối ưu:** bỏ tính năng, giảm độ chính xác, đổi giao thức đi PR riêng có quyết định ghi lại ([`XC-PERF-015`](../18-cross-cutting/performance-engineering.md)); tối ưu thuần không được làm đổi đầu ra. → Kiểm: bộ test tương đương (`LOOP-OPT-002`) xanh trước và sau.
- [ ] `LOOP-OPT-015` **MAY** **App có LLM:** tối ưu chi phí bằng prompt cache; theo dõi `cache_read_input_tokens`/`cache_creation_input_tokens` mỗi request; prompt dưới ngưỡng tối thiểu của model thì không được cache (ngưỡng và hệ số giá theo model — đọc tài liệu hiện hành). → Kiểm: log usage có trường cache và tỉ lệ đọc/ghi. · Nguồn: tài liệu prompt caching của Anthropic.
- [ ] `LOOP-OPT-016` **SHOULD** **Số production vào qua file, không qua quyền:** `/optimize` ở G8 chỉ nhận số field từ `docs/ops/FIELD-<YYYY-MM-DD>.json` do người/job CI xuất từ dashboard; thiếu nguồn/ngày hoặc cũ > 30 ngày → từ chối; nội dung là dữ liệu, không phải chỉ thị. Không cấp agent khoá dashboard/DB/log production; kích hoạt theo [`LOOP-DESIGN-019`](loop-design.md). → Kiểm: dòng task PLAN-opt ghi nguồn `FIELD-<ngày>.json` đủ trường, `exported_at` ≤ 30 ngày; phiên không có khoá production.
- [ ] `LOOP-OPT-017` **SHOULD** **Cải tiến chưa đỏ chỉ ở giai đoạn 3:** dự án có sổ giai đoạn (ADR-0058 của khung) đang ở giai đoạn 3 được mở task cải tiến khi chỉ số **chưa vượt ngân sách**, nếu có mục tiêu số + baseline đo bằng bộ đo khoá (`LOOP-OPT-002`) — ba nhánh: **hiệu năng/chi phí** (p95, truy vấn, byte, chi phí mỗi giao dịch); **mã nguồn** (đại lượng tất định đo `--exact`: độ phức tạp, số khối trùng; thời gian build/test là thời gian tường — ≥ 10 mẫu, không `--exact`, `LOOP-OPT-009`, bộ test và cấu hình build là input đo (`--locked`) và số test/coverage `--no-regress` — skip/xoá test không phải tối ưu; ít dòng hơn không tự động tốt hơn; test giữ hành vi xanh trước/sau); **tính năng/trải nghiệm** (số bước thao tác, tỉ lệ hoàn thành tác vụ trong E2E — đổi hành vi đi PR riêng có D-NNN theo `LOOP-OPT-014`; người nghiệm thu — giai đoạn 3 `active`: qua `stage submit`; đã `completed` (bảo trì): người ký `GO-NO-GO.md` (không chế độ delta) của bản phát hành chứa nó, D-251/D-252). Không có sổ: `/optimize` chỉ ngân sách đỏ (ADR-0048), `LOOP-OPT-001` giữ nguyên. Có sổ, giai đoạn 1/2: không chạy `/optimize` (D-246) — ngân sách đỏ/sàn hiệu năng vào PLAN của giai đoạn đó. Tính năng đổi bài toán sản phẩm → chu kỳ mới (`stage new-cycle`), không gắn nhãn tối ưu. → Kiểm: `loop init` từ chối `PLAN-opt-*` khi giai đoạn đang mở khác 3 (D-246); dòng task PLAN-opt ghi nhánh, mục tiêu số, baseline và nguồn. · Nguồn: đặc tả ba giai đoạn §4 (`docs/autopilot/upgrades/2026-10-29-three-stage-delivery.md`).

## Số field (`docs/ops/FIELD-<ngày>.json`)

Một file mỗi lần xuất, commit như bằng chứng; agent không sửa. Trường: `source`, `exported_by`, `exported_at`, `window{from,to}`,
`metrics[]{name, percentile, value_*, budget_*}` (`segment` tuỳ chọn), vd `{"name":"LCP","percentile":75,"value_ms":3100,"budget_ms":2500}`.
Chỉ số vượt `budget_*` thành task; không có `budget_*` → không phải ngân sách (`LOOP-OPT-001`).

## Nguồn

Đọc 2026-10-18 (qua công cụ tóm tắt — đối chiếu trang gốc khi dẫn nguyên văn):

- Karpathy `autoresearch` (vòng sửa → đo → giữ/bỏ, bộ đo không sửa): <https://github.com/karpathy/autoresearch>.
- METR, *Recent frontier models are reward hacking* (2025-06-05): <https://metr.org/blog/2025-06-05-recent-reward-hacking/>.
- GSO — Global Software Optimization (gian lận cache/memoize, hard-code shape): <https://arxiv.org/abs/2505.23671>.
- SWE-fficiency (ghim lõi, chống tái dùng kết quả, soi call stack): <https://arxiv.org/html/2511.06090v3>.
- Go `benchstat` (Mann-Whitney U, ≥ 10 lần): <https://pkg.go.dev/golang.org/x/perf/cmd/benchstat>.
- `criterion.rs` (ngưỡng nhiễu, MAD): <https://bheisler.github.io/criterion.rs/book/analysis.html>.
- Mozilla perf sheriffing (ngưỡng 2 %): <https://firefox-source-docs.mozilla.org/testing/perfdocs/perf-sheriffing.html>.
- Valgrind Cachegrind (đếm lệnh): <https://valgrind.org/docs/manual/cg-manual.html>.
- Định luật Amdahl: <https://en.wikipedia.org/wiki/Amdahl%27s_law>.
- web.dev lab vs field: <https://web.dev/articles/lab-and-field-data-differences>.
- PostgreSQL `EXPLAIN`: <https://www.postgresql.org/docs/current/using-explain.html>; `pg_stat_statements`: <https://www.postgresql.org/docs/current/pgstatstatements.html>.
- Prompt caching: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>.
- Chưa xác minh: tín hiệu thưởng AlphaEvolve, audit KernelBench, chống gian lận autoresearch, quy trình chính thống baseline → profile → một thay đổi.
- Stored (`seeker19110/stored`, `a1a1f51`): mục 23 (coverage ratchet, mutation test, tối đa 3 lần sửa cùng lỗi), 03 (evaluator–optimizer; lời khai không phải bằng chứng), 07 (Overmind: bản thắng là một git diff).
