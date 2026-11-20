---
title: File harness: PLAN · PROGRESS · BLUEPRINT · evidence · state
kind: module
prefix: LOOP-HARNESS
applies_to: [all]
updated: 2026-11-20
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
| `PROGRESS.md` | 4 mục: Đang làm · Tiếp theo · Quyết định · Bàn giao phiên | Agent, theo lát (commit cuối của lát) và cuối phiên (ADR-0033) | Có | `xt.py progress-check` (≤ 8 KB; SHA là tổ tiên HEAD) — luật ở `LOOP-HARNESS-004`/`005` |
| `.autopilot/state.json` | `active, plan, blueprint, scope, max_iterations, iterations, deadline, same_failure_count, last_failure_signature, blocked, rev, task_runs, max_task_runs, objective, deferred, attached, resolved, unblocked` (`attached[]`/`resolved[]`/`unblocked[]` = dấu vết `loop attach`/`resolve`/`unblock`, mang sang đợt kế — ADR-0051; `scope` = blueprint/profile/scale/rev/gate_floor khoá lúc `loop init`: blueprint mất/hỏng/đổi quy mô → `verify`, sàn Gate đọc từ đây; `rev` tăng mỗi lần ghi, `task_runs` đếm lần đỏ theo task, `objective.batches` = mốc đầu đợt cho `loop next-step` (dấu đợt xong do `loop verify --all` xanh/Stop hook ghi) — ADR-0052, D-228) | `xt.py loop` qua `update_state` (khoá `state.lock`, kiểm `rev`, ghi atomic qua `.tmp`; hook lỗi khoá → fail-open, ghi `hook-stop.log`/`hook-checkpoint.log`) | **Không** (gitignore, theo máy) | `loop status` |
| `.autopilot/evidence/T-NNN.json` | `task, cmd, cmd_sha256, exit_code, started, finished, head, output_tail` (40 dòng; `zero_tests_red: true` khi Gate exit 0 mà `Ran 0 tests`) | `xt.py loop record` | Không (bằng chứng cục bộ); bằng chứng chia sẻ = link CI/PR | `loop_verdict` so `cmd_sha256` rồi dạng chuẩn của `cmd` với Gate (nháy có nghĩa, chỉ khoảng trắng ngoài nháy tự do) |
| `xt.yaml` | Khoá `format · lint · typecheck · test · build · format_file` (dev-task chạy; `gate-fast` thêm `format_check · test_fast`, chọn bằng `commit_gate`) + khoá khai báo khác (`install`, `dev`, `e2e`, `format_check`, `coverage`, `migrate`, `init`, `smoke`, `audit`…) cho agent đọc | Người/agent ở G5 | Có | `dev-task.sh gate` đọc được (xem `LOOP-HARNESS-008`) |
| `AGENTS.md` (+ `CLAUDE.md` chứa `@AGENTS.md`) | Luật agent, lệnh, cấu trúc, điểm dừng | Người | Có | Script so bản gốc trong `docs/agents/` ([`XC-DOCAI-007`](../18-cross-cutting/docs-for-ai-agents.md)) |
| `.claude/settings.json` + `.claude/hooks/*.sh` | Quyền allow/ask/deny, 4 hook | Người; agent sửa được (ADR-0018 — `strict` thì `ask`), nêu lý do ở commit/PR, tắt/bỏ qua hook bị deny | Có | `bash -n`, test hook |
| `docs/adr/`, `docs/SPEC-*.md`, `THREAT-MODEL.md` | Quyết định, đặc tả, mối đe doạ | Agent soạn, người duyệt | Có | Link từ PR `feat:` |
| `TRAPS.md` (tuỳ chọn) | Bẫy đã mắc thật: triệu chứng → cách rà → chốt chặn → ngày/PR | Agent sau mỗi lỗi lặp | Có | Mỗi `fix:` lặp lại phải trỏ TRAPS |

### Giới hạn đã biết của guard và hook

Hook là lớp chặn sai lầm bằng phân tích tĩnh, không phải ranh giới cách ly (D-015). Lớp đỡ cho các chỗ dưới đây là sandbox
OS/devcontainer có egress allowlist (`LOOP-HARNESS-022`) và việc phiên chính chạy lại Gate (`loop record`):

- **Hàng rào qua lịch sử git** (AUD-SEC-988): không bị chặn như ghi hàng rào — (a) lệnh dời HEAD cả cây (`checkout
  <rev>`, `switch`, `reset [--hard|--soft] <rev>`, `symbolic-ref HEAD`, `pull`, `merge`) rồi khôi phục từ HEAD mới,
  `git apply`/`am`/`cherry-pick`/`revert -n`, `stash apply` (cả `stash store <commit>`), `git archive <rev> | tar -x`,
  `rm -rf .github` (cha của `.github/hooks`): lớp đỡ là diff PR (tệp cổng, không làn nhanh) và review; (b) hạ cấp chỉ ở
  cây làm việc, không để lại diff PR — `reset <rev> && checkout -- f && reset ORIG_HEAD`, `update-index --index-info`
  rồi `checkout -- f`: **chưa có lớp đỡ** ngoài sandbox OS (`LOOP-HARNESS-022`).

- **Cơ chế kiểm không dùng được** (ADR-0054): CLI/Gate chặn mã 126 khi guard lỗi nạp hoặc fallback hỏng;
  không dùng module nạp dở; `apply_policy` hỏng không cho raw `ask` thành allow. Runtime fallback khỏe giữ ADR-0002. State thiếu `fcntl` hoặc FS không hỗ trợ
  `flock` → exit 2, không gọi mutator/ghi state; Stop/PreCompact vẫn cho dừng/compaction và ghi log lỗi khóa.
  Dự án chưa cài harness giữ tương thích. Cài mới có thể chọn chính sách merge/review `--preset safe`
  (ADR-0055); preset không tạo sandbox hoặc thay cấu hình dự án đã có.
- **Guard chỉ hiểu dạng heredoc đơn giản; dạng khác bị chặn (BUDGET)** (D-270): dấu kết `[A-Za-z0-9_.-]+` trần, bọc trọn
  nháy hay một `\` đầu, ở cấp ngoài/`(…)`/`$(…)`/`"$(…)"`, dòng mở cân nháy/ngoặc — `<<` khác mà bộ đọc nhận ra là có
  thể là heredoc (dấu kết có `$`/backtick/nháy pha, `\<<`, trong backtick/`${…}`/`<(…)`/số học không đơn giản, lệnh có
  `case`…) không được đoán. Dòng kết so nguyên văn, trừ heredoc trong `$(…)`/`<(…)`: dòng thân bắt đầu bằng dấu kết rồi
  có `)` (bash 5.2 kết heredoc ở đó) → chặn (D-271), kể cả khi `\` nối dòng tách `$(`/`<<` (D-272). `)#` không khoảng trắng ngoài nháy bị chặn (AUD-SEC-195, review #368) — giới hạn: biến thể `x=$(true)# …`, `a=(1)# …` (AUD-SEC-242) và AUD-SEC-235/247 còn mở trong sổ.
- **Guard chặn `\` cuối dòng sau `#` và mọi định nghĩa alias** (D-271, D-272): bash không nối dòng trong comment, đọc
  nháy để phân định `#` cũng lệch — dòng có `#` đầu từ (bất kể nháy) kết bằng `\` lẻ bị chặn (đưa `#NN` sang dòng không
  kết bằng `\`). Snapshot shell của Claude Code đã bật `expand_aliases`, nên định nghĩa alias (tên lệnh có thể thành
  `alias` sau bỏ nháy/nối dòng/`${…}`/glob, đối số không phải tên trơn) và `BASH_ALIASES` bị chặn bất kể cách bật;
  liệt kê (`alias`, `alias -p`) vẫn chạy. Tên lệnh hoàn toàn động (`$x`, `$(…)`) là giới hạn chung của phân tích tĩnh.
- **Guard không xét gửi bí mật ra mạng bằng thư viện của trình thông dịch** (AUD-SEC-086): luật "gửi file bí mật/biến môi
  trường ra mạng" chỉ nhận CLI (`curl`/`wget`, `scp`/`rsync`, `nc`/`socat`/`ssh`, `gh gist|release upload`) và `/dev/tcp`.
  `python3 -c` dùng `urllib`/`http.client`/`socket`, `node -e` dùng `fetch`/`http`/`net` gửi bí mật đi thì không bị xét
  như gửi ra mạng; script có chuỗi bí mật nguyên văn (`open('.env')`) bị chặn theo D-105 (không chỉ đọc) — còn hở khi bí
  mật lấy từ biến môi trường (`os.environ`, `process.env`) hay đường dẫn ghép (AUD-DOC-073). Không để bí mật thật trong
  máy/biến môi trường của phiên agent không người trực.
- **Phá dữ liệu: guard chỉ chặn tới máy chủ không cục bộ** (AUD-HAR-420, `DATA_DESTROY`): `psql`/`mysql`/`mariadb`/
  `sqlcmd`/`mongosh` có câu phá thấy được (cờ câu lệnh, heredoc có nháy, here-string), `dropdb`, `mysqladmin drop`,
  `redis-cli FLUSHALL|FLUSHDB` với máy chủ nêu ở cờ/URI/conninfo khác loopback/socket (máy chủ là biến: coi là không cục
  bộ). Cho chạy: không nêu máy chủ hay cục bộ, máy chủ từ biến môi trường (`PGHOST`, `DATABASE_URL`), câu trong tệp/stdin,
  `prisma migrate reset`, `rails db:drop`, `docker compose down -v` — dự án đích chặn thêm bằng `permissions.deny`. In
  biến token GitHub (`printenv GH_TOKEN`, `echo "$GH_TOKEN"`, `env | grep TOKEN`) chặn như `gh auth token` (AUD-SEC-818).
- **`subagent-stop.sh` chỉ khớp mẫu chữ "exit/rc + số"** (AUD-HAR-098): regex `exit`, `exit code`, `exit status`, `rc`,
  `mã thoát` theo sau là số. Lọt: báo cáo nhắc `exit 0` mà không chạy lệnh nào (hay trích log có `rc=1`) vẫn được cho
  dừng. Bắt sai: báo cáo ghi kết quả theo dạng khác (`→ 0`, "trả 0", "xanh") bị chặn một lần dù đã chạy. Hook chỉ là
  lời nhắc ghi bằng chứng; kết luận "xanh" vẫn từ evidence do `loop record` ghi.
- **Guard chỉ hiểu đường dẫn viết nguyên văn** (AUD-SEC-090): script trình thông dịch ghép đường dẫn (`'.git/' + 'config'`,
  f-string có biểu thức, `os.path.join('.git', 'config')`) không có chuỗi nào là đường dẫn được canh nên không bị xét
  (escape trong chuỗi Python như `'\x2eenv'` thì được giải qua AST; escape của ngôn ngữ khác chưa); script ở file
  (`python3 x.py`, `python3 < x.py`) và module cục bộ được `import` không được đọc; trên hệ file không phân biệt hoa thường
  (macOS, Windows) `.GIT/config` là `.git/config` nhưng không bị chặn; `.git/info/exclude` không nằm trong danh sách canh.
  Đích ghi dời bởi đổi thư mục bên trong script (`os.chdir('.git')`, `process.chdir`, `ruby -C .git`) hay đến từ argv
  (`python3 -c "open(sys.argv[1],'a')" .git/config`) cũng không được xét (AUD-SEC-096).
- **Thư mục tính theo thứ tự chữ, không theo luồng chạy** (AUD-SEC-095): hàm định nghĩa trước `cd` rồi gọi sau
  (`f(){ echo x > settings.json; }; cd .claude; f`), thân vòng lặp chạy lần 2 sau `cd` ở cuối thân, `trap … EXIT` — guard
  không mô phỏng luồng điều khiển của shell. `git -C ~+/x commit`: thư mục repo nhận commit hiểu `~+` là thư mục con
  (AUD-SEC-100) — cổng commit chạy ở gốc phiên thay vì repo `x`. `cd ~+/<đường>`/`cd $PWD/<đường>` là thư mục không
  biết (D-106) nên chỉ chặn tên file đã có hoặc tên được canh; lệnh chạy hộ ngoài danh sách (`mise exec --`,
  `pyenv exec`, `asdf exec`, `volta run`, `fnm exec`, `direnv exec`, `bundle exec`, `nix develop -c`, `pnpm exec`)
  không được bóc để trích script; lồng hơn 8 lớp lệnh chạy hộ cũng không. Đích `rm -rf` là thay lệnh guard không tính
  được (`$(dirname $PWD)`, `$(realpath ..)`, `$(pwd -P)/..`) → BUDGET (D-503); `..`, `$PWD/..` → luật `rm -rf`. Giá trị tính được
  (`$(date +FMT)`, `$(mktemp …)`, `$(cat TỆP)` trong sed) chỉ được tin khi cả lệnh, mọi tầng bọc, chỉ gồm cấu trúc trong
  danh sách đóng (D-506, T-3945): gán/ghi biến `PATH`/`BASH_CMDS`/`IFS`/`LD_*`/`GIT_*`… dưới mọi dạng (`read`, `printf -v`,
  `mapfile`, `declare`/`export` tên có nháy/thoát/brace/động, nameref, số học có tên biến — `[[ -eq ]]`, không `[ -eq ]`;
  nhắc chữ như `echo "PATH is set"` thì không), hàm/alias/`hash`/`enable`/
  `eval`/`source`, trap khác EXIT có thân ngoài danh sách, tên lệnh động → mất ưu đãi (BUDGET); `$(pwd)` (builtin) chỉ mất
  trước cấu trúc đổi được builtin (hàm, `BASH_FUNC_`, `BASH_ENV`, builtin lạ — `PATH=` thì không). T-3947: giá trị tính
  được chỉ là thành phần lá — `..` theo sau (cả `cd` vào nó rồi `cd ..`/`~+/..`/đường `../`) → BUDGET; `$(mktemp)` có
  `-p`/`--tmpdir`/mẫu có `/` trỏ `~`/`$HOME`/`..`, hay TMPDIR GÁN trong lệnh (gán, `read`/`export`/`for TMPDIR`,
  `${TMPDIR:=…}`) mất ưu đãi — chỉ đọc/nhắc (`ls "$TMPDIR"`, `mktemp -p "$TMPDIR"` = thư mục mặc định của mktemp) thì
  giữ; `$(date)` — viết thẳng hay qua biến gán từ nó (`d=$(date +%F); rm -rf ~/"$d"`) — chỉ ưu đãi khi thư mục đích dưới
  gốc dự án (tiền tố tương đối, `cd` vào thư mục con chữ trơn; không `env -C`/`--chdir`) hay `/tmp`, `/var/tmp` (cả `cd
  /tmp && rm -rf "b-$(date +%F)"`); đích ngoài gốc (`>> ~/logs/$(date +%F).log`, `cp -r d "$HOME/b-$(date +%F)"`) →
  BUDGET, viết lại bằng đường dưới `/tmp` hay trong dự án (T-3949). `for`/`select`/`coproc PATH`, `exec {PATH}>` cũng là
  ghi PATH. Truy vấn nhánh hiện tại (`$(git branch --show-current)`, HEAD tách rời → rỗng) chỉ tính ở vị trí tên-ref vô
  hại: refspec `git push` chiếm trọn hay vế đích sau nguồn chữ (`HEAD:"$(…)"`, `"HEAD:refs/heads/$(…)"` — rỗng thì git
  từ chối; `"$(…):dst"` thì không — rỗng thành xoá nhánh remote), đối số `pull`/`fetch`/`rebase`/`merge`/`checkout`/
  `switch`, `--set-upstream-to=`/`-u`, `gh pr create`.
- **Duyệt giai đoạn** (ADR-0058, AUD-SEC-155; ADR-0069: chỉ đúng MỘT lệnh đơn `python3 <xt.py của dự án> stage approve --sha … [--note …]` — không `env`/`unset`/gán biến/cờ trình thông dịch, không nối hay lồng lệnh, không token mờ — được cho qua khi xt.yaml ở cây **và** bản đã commit ở nhánh chính (`origin/main`, rồi `origin/master`) khai `stage_approval: agent`, `XT_GUARD_POLICY=strict` không nới): luật chữ (`xt.py … stage … approve`/`init … --adopt`) cộng luật token
  mờ: ở mọi vị trí script (`-m xt`/`-mxt`/`-m scripts.xt`, lồng trong `perf sample --`), bỏ chuyển hướng và fd
  (`2>/dev/null`, `{fd}>f`; đích bị cắt như `> >(cat)` là mờ), lệnh con, cờ/giá trị `--framework` (cả `=` rỗng) hay tuỳ
  chọn `init` mờ (`$(…)`, backtick, biến, glob), chuỗi thay chỗ (`xargs -I`/`-i`/`--replace`, mẫu `{…}`, `:::`) hay đến
  từ stdin. Lệnh con mờ không tính khi lệnh chỉ đọc file (`cat`/`grep`/`git`… `scripts/xt.py "$F"`); đường script mờ chỉ
  tính khi có `python` đứng trước hoặc nó là lệnh, và lệnh con là `stage`. `xt.py` coi biến phiên agent có mặt (kể cả
  rỗng) là agent. `--framework "$FW"` bị chặn với mọi lệnh con — dùng `XT_FRAMEWORK`. Đường script mờ sau
  trình chạy (`uv run "$XT" "$(…)"`) nay bị chặn (BUDGET, D-503). Còn lọt (AUD-SEC-161): bản sao/tên khác của `xt.py`,
  alias, script lồng.
  Nạp `xt` trong tiến trình (AUD-SEC-498): script trình thông dịch (`-c`, stdin, heredoc, ống) có `import xt` kèm
  `main`/`stage`/`approve`/`adopt`/biến môi trường/truy cập động, hàm nạp (`runpy`, `import_module`, `__import__`,
  `exec`/`eval`/`compile`, `spec_from_file_location`) với đối số không phải chữ nguyên văn hay trỏ `xt`, và
  `-m runpy xt` bị chặn; thư viện đọc (`xt.parse_plan`, `xt.review_debt`) vẫn qua. Còn lọt: tên dựng qua đường guard không
  thấy (tệp `.py` ghi bằng Write rồi chạy).
- **Chữ ký GO-NO-GO §5** (AUD-SEC-497, D-390; mẫu GO-NO-GO §5, ADR-0068 §Quyết định 3a; mã `GO_SIGN`): file tên
  `GO-NO-GO*.md` (mọi thư mục, không phân biệt hoa thường, cả qua symlink) chỉ sửa bằng **Write cả file** — mọi
  Edit/MultiEdit/NotebookEdit → deny, kể cả file chưa ký (D-417, D-418: mô phỏng tool Edit lệch tool thật). Write làm xuất
  hiện hay đổi dòng ký §5 (MỘT dòng, ô tên + ô ngày `YYYY-MM-DD` khác rỗng) theo văn bản thô HAY theo đúng phần
  `release-check` thấy (AUD-SEC-615: bản chép `_markdown_shown`, xuống dòng như `read_text`) → deny; nội dung có `\r` không
  kèm `\n`, BOM lệch file trên đĩa, file trên đĩa không đọc được/không phải UTF-8 → deny; xoá dòng ký, sửa phần khác, bảng
  mẫu trống → cho chạy. File đã ký mà Write đổi tiêu đề `# ` đầu tiên (ngoài frontmatter) hay tập dòng `subject:` — trên
  văn bản thô hay phần hiển thị — và kết quả còn dòng ký → deny cùng mã (D-392) — xoá dòng ký trước (cùng lần ghi cũng
  được), người ký lại. Agent ký: `xt.py release-sign` (ADR-0074). Bash ghi/dời/khôi phục file đó (chuyển hướng, `tee`, `sed -i`, đích `cp`/`mv`, `git checkout|restore
  <rev> --`, glob ở tên nở ra file có sẵn, symlink có sẵn, chuỗi nguyên văn trong script trình thông dịch không chỉ đọc)
  → deny, sửa bằng Write; đọc, xoá cả file (`rm`, `git rm`) và `touch` (chỉ mtime) cho chạy; `truncate` vẫn chặn (cắt đuôi
  hoàn thành được dòng ký `| … | YYYY-MM-DD |x`, như Write bỏ `x` bị chặn). Liên kết (AUD-SEC-533): `ln`/`link`/`cp -l|--link`
  có toán hạng là file đó (tên, symlink có sẵn; cả `ln -s`) → deny — liên kết cứng chung inode, ghi tên trung tính là ghi
  GO-NO-GO. Áp diff (AUD-SEC-534): `patch`/`git apply`/`git am` lấy diff từ tệp/stdin ở dự án có `GO-NO-GO*.md` trong
  `docs/ops`, `docs` hay gốc → deny, trừ khi mọi diff là tệp thường nêu ở đối số/`-i`/`< tệp` (≤ 1 MiB, đọc được ở mọi thư
  mục ứng viên) không có header `GO-NO-GO*.md` (mbox mã hoá base64/quoted-printable → deny; `--check`/`--stat`/
  `--dry-run`/`git am --abort` cho chạy); tệp diff đọc được có header `GO-NO-GO*.md` (tạo mới, đổi tên tới) → deny cả ở
  dự án chưa có GO-NO-GO (AUD-SEC-539) — ở đó diff không đọc được vẫn cho chạy (không chặn oan dự án không dùng
  GO-NO-GO; còn lọt: stdin/mbox mã hoá tạo GO-NO-GO đầu tiên). Lệnh lạ (AUD-SEC-535, theo ADR-0066): lệnh ngoài danh sách trắng chỉ đọc (của
  ADR-0066, thêm `less`/`more`, `git add|commit|diff|show|log|blame|status|ls-files|grep|cat-file|reset|restore|checkout`,
  `find` không hành động ghi, `prettier`/`markdownlint` không cờ sửa, lệnh đã mô hình đích `cp`/`mv`/`sed`/`tee`/`dd`/
  `rsync`/`curl`…) có từ khớp `go-no-go*.md` (không phân biệt hoa thường, sau bỏ nháy, phần sau `=`/`:`; phần thư mục có
  khoảng trắng là câu chữ, không tính; glob ở tên nở ra file có sẵn) → deny (`sponge`, `ruby -pi`, `ex`/`vim -es`, `gsed -i`, `python3 -c … F`, `tar -xf a.tar F`); họ đổi tên
  theo biểu thức (`rename`, `rename.ul`, `mmv`…) và `tar --transform`/`--xform`, `bsdtar`/`pax -s` có chữ `go-no-go` ở bất
  kỳ từ nào → deny. Mất miễn (chặn oan có chủ ý): gán `PATH`/`GIT_*`/`LESS*` đầu lệnh (`LESSOPEN=… less F`), lệnh bọc
  ngoài loại guard bóc (`env`/`command`/`nice`/`timeout` trong suốt; `npx prettier --check F` thì không), `git -c|-C`
  trước lệnh con (`git -C d diff F`). MCP (AUD-SEC-536): `mcp__*__create_or_update_file`/`push_files` ghi `GO-NO-GO*.md` có
  dòng ký §5 hay `\r` trần → deny (guard không so được với bản trên remote, cả dòng ký có sẵn); payload lạ → không phản đối. Còn lọt:
  tên dựng lúc chạy (biến, `$(…)`, đường ghép trong script, đích từ `xargs`/stdin — như AUD-SEC-406), glob ở thư mục
  (`docs/*/*.md`), symlink tạo trong cùng lệnh, thư mục quá `OUTSIDE_SCAN_MAX` mục; liên kết cứng tạo trước khi luật có
  (hay qua đường guard không thấy) — ghi tên trung tính cùng inode bằng Edit/Bash lọt (soát: `find . -samefile
  docs/ops/GO-NO-GO-x.md`); symlink có sẵn tên trung tính dưới lệnh lạ (luật lệnh lạ chỉ so tên); giải nén archive/chép
  thư mục vào thư mục có GO-NO-GO (`tar -xf a.tar -C docs/ops`, `unzip -d docs/ops`, `cp -r d/. docs/ops/`, `rsync -a d/
  docs/ops/` — guard không liệt kê thành viên/tệp con); tệp diff đổi giữa lúc guard đọc và lúc áp bởi chương trình khác
  trong cùng lệnh (ghi rồi áp tệp nêu tên do ADR-0066 chặn), header diff trỏ symlink/liên kết tên trung tính; tool MCP ghi
  file ngoài hai tool trên (server filesystem…); đổi tên file đã ký sang `-v<bản khác>.md` bằng Bash bị chặn (cả `mv`
  đi), nhưng nội dung khác ngoài tiêu đề/`subject:` của file đã ký không bị xét — lớp sau là review PR.
- **Dấu review đăng tay** (AUD-SEC-069/156/157): guard chặn lệnh `gh` đăng chữ khi dấu `xt-review v1` ở argv, ở bất
  kỳ đâu trong chuỗi lệnh (heredoc, `printf`), hay trong nguồn thân của chính lệnh đó (`-F f`, `--body-file`, `-F k=@f`,
  `--input`, `< f`, file đọc trong `$(…)`/backtick, `cat f |`, `$(cat)` đọc stdin; cả chuỗi JSON, cả khoá) — nguồn có mà
  không đọc được (glob, fd của shell `/dev/fd/N`, không phải file thường, > 256 KiB, quá 8 nguồn, lỗi đọc, JSON lồng quá
  sâu) bị chặn, lỗi khi quét cũng chặn; MCP quét mọi chuỗi thô. Mặc định chặn (D-503, mã BUDGET): dấu mã hoá lúc chạy
  đổ vào `-F -` (`printf '\74!-- …' | gh … -F -`), stdin chuyển hướng ở cấp shell (`exec < f; gh … -F -`), file tương
  đối sau `cd` (`cd docs && gh … -F body.md`); thay lệnh lồng (`$(cat $(echo f))`) → `REVIEW_FORGE`. Còn lọt: thân từ
  stdin của chương trình khác không mã hoá (`cmd | gh … -F -`), file do chương trình khác sinh trong cùng lệnh
  (`gen > f && gh -F f`, `$(xargs cat <<< f)`, `base64 -d`), heredoc không nháy chứa `$(cat f)`, `{ gh …; } < f`
  (AUD-SEC-180), tool MCP ngoài `MCP_REVIEW_POST_RE` (steward chỉ đọc comment issue).
- **Ref remote là ref cục bộ** (AUD-SEC-119): guard chặn lệnh git ghi `refs/remotes/…` hay tạo ref trùng `<remote>/…`
  (`REMOTE_REF_FORGE`) và ghi `refs/replace/…` (`git replace`, AUD-SEC-158 — `xt.py` cũng đọc git với
  `--no-replace-objects`, không theo grafts — AUD-SEC-168), và từ #442 (D-366) chặn cả ghi thẳng `.git/packed-refs`, `.git/refs/remotes/**` lẫn đổi gốc của remote:
  `remote set-url|set-branches` (mọi remote), `remote add|rename|remove|rm` khi tên cũ/mới là `origin`, `config remote.<r>.url|pushurl|fetch`
  và `url.<b>.insteadOf|pushInsteadOf` (kể cả `--unset`, `--remove-section`/`--rename-section`), `git -c`/`--config-env`/`GIT_CONFIG_*` một lần;
  `remote set-head <r> <nhánh>|-d` cũng chặn (`-a` hỏi máy chủ thì qua). Còn lọt: ghi thẳng file `.git/refs/heads|tags/…`, `.git/<remote>/…`
  (cùng uid sửa trực tiếp file trong `.git` ngoài guard — lớp hai là sandbox, ADR-0067), `remote add|rename|remove` tên khác `origin`;
  ghi thẳng `.git/refs/replace/…`, grafts (`.git/info/grafts`, `GIT_GRAFT_FILE`) với lệnh git ngoài `xt.py`, `fast-import`; ref là biến môi trường trần (`git update-ref "$R" …`). Ref là thay lệnh (`$(…)`) hay qua `xargs sh -c 'git update-ref "$@"'` nay bị chặn (BUDGET, D-503).
  Alias git: mọi lệnh con ngoài danh sách dựng sẵn (bất kể tên: `a.b`, `y_x.z`, `1.x`) được tra trong bảng alias do
  CHÍNH git dựng (`git -C <repo> [-c/--config-env/--git-dir của lệnh] config --list -z` với `GIT_CONFIG_COUNT/KEY_*/
  VALUE_*/PARAMETERS/GLOBAL/SYSTEM/NOSYSTEM`, `HOME`, `XDG_CONFIG_HOME`, `GIT_DIR` của lệnh hợp môi trường của guard —
  COUNT, include, thứ tự ưu tiên do git xử lý; tên so như git, không phân biệt hoa thường cả subsection), ngân sách đọc
  tổng 5 s mỗi quyết định; alias `!` quét như shell lồng; không giải được → `UNRESOLVED_TARGET`. Đối số từ stdin
  (`xargs`, `xargs -I`, `parallel`, `find -exec {}`) cho lệnh ghi ref → `UNRESOLVED_TARGET`, trừ dạng đã khoá chế độ
  không tạo ref (`branch -D`, `tag -d`, `checkout --`, `stash drop`, `worktree remove`); `xargs git branch -d` bị chặn vì
  stdin có thể thêm `--no-delete` (dùng `-D`). Tệp cấu hình tạo trong CÙNG lệnh Bash rồi mới dùng (`printf '[alias]…' >
  f && GIT_CONFIG_GLOBAL=f git y …`) → `HOOK_BYPASS`; lệnh con là biến (`git $S …`) → BUDGET (D-503). Còn lọt/lệch:
  lệnh xoá biến môi trường (`env -i`, `env -u`, `unset`) — guard vẫn đọc theo môi trường của nó; `includeIf "onbranch:"`
  định nghĩa alias (`git config --list` xét nhánh, lúc mở alias git chưa dựng repo nên không xét); thư mục repo là biến
  (`git -C "$D"`, lệnh lồng không rõ thư mục) → đọc alias ở gốc dự án; git cũ hơn 2.43 thiếu một lệnh dựng sẵn có trong
  danh sách của guard (alias trùng tên đó git vẫn chạy); alias `!` quét ở thư mục của lệnh, không ở gốc repo nơi git chạy
  nó. Khoá chạy lệnh (`core.fsmonitor`, `core.pager`, `include.path`…) đặt một lần qua `-c`, `--config-env`,
  `GIT_CONFIG_KEY_*`, `GIT_CONFIG_PARAMETERS` — gán ở đầu lệnh hay gán/`export` ở lệnh trước trong cùng chuỗi — là
  `HOOK_BYPASS`; `--config-env=<khoá chạy lệnh>=VAR` mà guard không thấy giá trị VAR cũng vậy; khoá là biến
  (`git -c "$K=$V" status`) và biến `export` ở shell cha của lệnh lồng (`export …; bash -c 'git status'`) thì chưa.
  Tuỳ chọn toàn cục của git đối chiếu `handle_options` (git.c 2.43 và master): đủ tuỳ chọn ăn token kế (`-C`, `-c`,
  `--git-dir`, `--work-tree`, `--namespace`, `--config-env`, `--shallow-file`, `--attr-source`); tuỳ chọn `--…` guard
  không biết đứng trước lệnh con → `UNRESOLVED_TARGET` (D-216). Gate đọc
  `origin/main` chỉ chống nhầm lẫn — rào thật của vòng tối ưu là `perf trial` (ADR-0052 §7).
- **Xoá ref remote / viết lại mọi ref** (AUD-SEC-551, D-407): `push --delete|-d`, `:<ref>`, `--prune`, `gh api -X DELETE …/git/refs/…`, graphql `deleteRef`/`updateRefs`/`updateRef` (đích không đọc → luôn chặn, AUD-SEC-622) với đích khác nhánh hiện tại (đọc như PUSH_MAIN; không biết → chặn; cụm cờ có chữ số `-4d`/`-4f` đọc như `-d`/`-f`, AUD-SEC-556/557), `gh pr close|merge --delete-branch|-d` (head của PR không biết → luôn chặn, AUD-SEC-558/565; mọi luật đọc lệnh `gh` — huỷ/xoá ref/merge/đối ngoại (xoá/thu hồi `repo deploy-key|ssh-key|gpg-key|run|label|issue|gist|codespace|project delete`, `cache delete --all`, `auth logout` → DESTROY, in token `auth token|status -t|git-credential`, `config get oauth_token` → chặn, AUD-SEC-580/589; tên lệnh/tên cờ có `$`/backtick hay glob — `gh pr merge$Z`, `--input$Z`, `gh pr merg?` — và ở lệnh có luật cờ token bash tách/bung thành cờ — `gh pr merge 5 $X`, `-d$Z`, `gh pr close 5 -*` — → BUDGET trừ khi luật khác đã deny, AUD-SEC-587/590; DELETE REST của các lệnh xoá đó cũng DESTROY, AUD-SEC-583), dấu review, alias/extension/lệnh lạ, ghi công AI/tiêu đề PR, gửi bí mật — đọc qua một điểm vào: nguyên văn, dạng bỏ chuyển hướng như bash đưa cho gh (`gh pr 2>/dev/null merge 5`; thêm cách giữ chữ số liền trước chuyển hướng — số PR) và dạng cobra chạy khi cờ đứng trước lệnh con, token đầu không cần bảng nhóm, `--version` gốc không ăn token kế — `gh -X DELETE api …`, `gh --help=false alias set …`, `gh --version zz`, `gh -R o/r pr create …`, AUD-SEC-571/575/577/578/579/581/582, D-409; cách đọc chặt hơn thắng) và `filter-branch --all|--branches|--tags|--remotes|--glob|--stdin`/nhiều ref, `filter-repo`, plumbing đẩy `send-pack`/`http-push`/remote helper `remote-<x>` (refspec từ stdin; cả `git-<tên>` chạy thẳng, tên so sau casefold; không qua luật push, không chạy pre-push — mọi dạng trừ in cách dùng `-h` đứng một mình, `send-pack --help`, AUD-SEC-621) → `REMOTE_DELETE`; `fetch --prune` qua. Còn lọt: `checkout`/`switch <nhánh người khác>` rồi xoá nó — nó thành nhánh hiện tại (cả trong cùng lệnh: `HEAD` đọc lúc guard xét, như PUSH_MAIN). `gh api` ghi `…/git/refs/…` với `force` khác `false` hay thân `--input` bị chặn như `push --force` (AUD-SEC-555). Mở rộng trong nháy kép đứng riêng (`gh pr close 5 "$X"`) hay sau chữ nguyên văn (`5$X`, `-F n=$N`) vẫn có thể thành cờ — chặn BUDGET (ADR-0076).
- **Gán `TÊN+=v` và `parallel :::`** (AUD-SEC-125/121): `X+=1 cmd` xét `cmd`; giá trị nối thêm là không biết (khoá cấu
  hình git nối thêm → `HOOK_BYPASS`). `parallel`/`sem`/`env_parallel`/`parset` (GNU): lệnh đơn tên đó — sau gán/trình
  bọc/`env -S`, trong shell lồng, tên có nháy/thoát/đường dẫn/glob, argv `["parallel", …]` của `subprocess`/`os.spawn*`
  (T-3945) — bị chặn, mã BUDGET trừ khi luật cũ chặn trước (AUD-SEC-887, D-503): lệnh đến từ `:::`/`::::`/stdin/tệp/
  đối số, mẫu là shell/`eval`, tuỳ chọn từ `$PARALLEL`/`~/.parallel/config`/`-J`; không có dạng hẹp an toàn (cả
  `--version`). `source`/`.` tên không có `/` mà có trong PATH hay lệnh ghi PATH (`. env_parallel.bash`) →
  BUDGET. Luật cũ (mỗi tổ hợp `:::` quét
  như shell lồng) chạy trước nên lệnh nguy hiểm giữ mã của nó. Gán phần tử mảng đầu lệnh (`a[0]=1 cmd`) và
  `x+=$(echo …)` dùng ở lệnh sau đều bị chặn (RULE_DENY/BUDGET, AUD-HAR-430). Công cụ ngoài danh sách đóng đọc-dữ-liệu
  (`cat`/`grep`/`jq`/`git`/`gh`…) đọc chương trình từ stdin/heredoc/here-string/ống chữ hay cờ chương trình (`-e`/`--eval`
  cả viết tắt `--eva=`, dính giá trị `-e'…'`; `-c`/`--cmd`/`+cmd` ở client CSDL, vi/ex/vim, expect, cả trong cụm cờ ngắn
  `ex -sc`/`vim -Nesc`/`psql -Atc`/`mysql -Be`; `mysql --pager=`; đối số vị trí sqlite3) mà thân, so sau khi bỏ nháy kiểu
  shell, chạy lệnh có luật → BUDGET: công cụ biết lối thoát (ed/ex/vim/dc `!`, vim `system()`/`systemlist()`/
  `job_start()`, psql `\!`/`\o |`/`\g |`/`to program`, sqlite3 `.shell`/`.system`/`.once |`/`.output |`/`.import "|…"`,
  mysql `system`/`pager`, gdb `shell`/`pipe … |`, tcl/expect `exec`) chỉ xét chữ sau lối thoát (có `$` cũng tính) —
  SQL/manifest/Dockerfile là dữ liệu; `at`/`crontab` xét cả thân; công cụ khác xét mọi từ. Here-string/ống có `$` là
  chương trình lúc chạy → BUDGET chỉ với công cụ đọc chương trình (ed/ex/vim/dc/gdb/tclsh/expect, client CSDL psql/
  sqlite3/mysql/mongosh/redis-cli, `at`/`crontab`, lua, sed/awk/make `-f -`); công cụ khác đọc dữ liệu (`echo "$TOKEN" |
  docker login --password-stdin`, `bc <<< "$x * 2"`) — T-3949. Chữ echo có thoát vào công cụ đọc chương trình xét mọi
  cách đọc (nguyên văn, giải `-e`, bỏ `\`); stdin gắn vào lệnh ghép (`{ python3; } <<< '…'`, `( ed ) <<<`, `done <<E`)
  hay nhóm ra ống (`(crontab -l; echo '…') | crontab -`) xét với mọi lệnh đọc chương trình bên trong (chặt: `echo
  "… $HOME/…"` vào `crontab -` qua nhóm → BUDGET như dạng thẳng). Nguồn không phải chữ (`<(…)`, fd khác 0 `<&3`,
  `/dev/fd/N`, `-f /dev/fd/3` của sed/awk/make, ống từ khâu đọc chúng) vào shell/trình thông dịch/công cụ đọc chương
  trình → BUDGET, trừ `<(…)` chỉ đọc nội dung đã lưu (`git cat-file`/`git show`/`cat tệp`, dự phòng chỉ thoát — Gate
  `/optimize`). `make` đọc makefile từ stdin hay `--eval`/`-E` → BUDGET (T-3945, T-3947, T-3949, D-503 b, D-507, D-508).
  Xoá không đệ quy bên trong thư mục git (`rm -f .git/HEAD`, `.git/*`, `cd .git && rm -f *`, `unlink`, `shred`; lệnh bật
  dotglob — `shopt -s dotglob`, `-O dotglob`, đặt `GLOBIGNORE`; nhắc chữ thì không — thì `*/index` cũng tính; biến vòng
  `for f in …` xét theo mẫu) → WIPE_OUTSIDE; GHI vào đó (`>`, `: >`, `cp`, `mv`, `tee`, `truncate`, `sed -i`, `ln`,
  `install`, `dd`, `rsync`) → HOOK_BYPASS. Thư mục git: `.git` của gốc, gốc là worktree liên kết thì cả gitdir riêng
  (`<chung>/worktrees/<tên>/HEAD|index`) và `.git` chung, mọi `.git` của repo con dưới gốc (`sub/.git/objects`); trừ
  `*.lock` và (chỉ ghi) `info/exclude`. `find` có gốc trong `.git` hay duyệt vào `.git` khớp tên mẫu vào xargs → BUDGET.
  **Giới hạn chấp nhận** (D-507, D-508, hạn xét lại 2027-01-21 cùng mốc sandbox ADR-0072): (a) trồng lệnh vào thư mục
  PATH qua nhiều lệnh rồi `$(date)`/`$(mktemp)`; (b) argv `parallel` dựng bằng nối chuỗi/biến/`exec {"parallel"}` của
  perl, `pcntl_exec`/`proc_open` của php; (c) chương trình nguy hiểm viết tường minh rồi che bằng biến: heredoc không
  nháy chỉ có `$x` vào công cụ đọc chương trình (`x='!rm …'; ed <<E` + `$x`), `r${Z}m` trong chuỗi `system()` của
  `gawk -e`/`perl -e`, `mktemp` lỗi trả rỗng (`"$(mktemp -d -p nonexist)"/etc`) — cần chủ ý nhiều bước/chuỗi động, hàng
  rào là sandbox.
- **Lớp bọc / ghép lệnh / hành động ra ngoài** (T-3952, D-503, D-508): `git commit` lồng (shell con, heredoc, trình thông
  dịch, `$(…)`, `npx -c`) → chặn "tách lệnh" (cổng commit chỉ chạy cho commit ngoài cùng); commit sau trình chạy/alias
  (`uv run`, `flock`, `git -c alias.ci=commit ci`) đứng một mình là commit ngoài cùng (cổng chạy), kèm lệnh khác → chặn.
  `git push` với khoá push đặt một lần (`-c k` không giá trị là true, hoa-thường, `--config-env`, `GIT_CONFIG_*`, `export`;
  `remote.*.push|mirror|pushurl`, `push.*` trừ `autoSetupRemote`, `branch.*.merge|remote|pushRemote`,
  `remote.pushDefault`) → chặn khi không refspec (`pushurl`: luôn); không refspec thì đọc cấu hình hiệu lực của repo
  (`git config --get-regexp`, hạn 5 s): mirror, `remote.*.push`/`matching`, `upstream` khác tên nhánh → chặn. REST/GraphQL
  GitHub qua curl/wget/httpie/xh/`requests` (host `api|uploads.github.com`, GHES `/api/v3`, `/api/graphql`) dựng lại
  thành `gh api` và qua cùng bảng luật; `POST …/merges`, `mergeBranch` là merge không qua PR. Biến token GitHub trong argv
  của trình mạng/git chỉ tới host GitHub; biến bí mật (`*TOKEN`, `*_KEY`, `*SECRET`, `*PASSWORD`, `*_PAT`) vào message
  commit/tag, `gh` (trừ `secret`/`auth`, header `gh api`), URL userinfo của trình mạng/git/trình quản lý gói (`pip`,
  `uv`, `npm`, `pnpm`, `yarn`, `go`, `cargo`… — T-3955 B7), hay gửi tới dịch vụ trút dữ liệu (paste, `webhook.site`,
  requestbin, pipedream, ngrok, trycloudflare, OAST, webhook Discord/Telegram/Slack — kể cả bot token Telegram tới
  `api.telegram.org`) → chặn; bí mật khác tới API của chính nó (`$OPENAI_API_KEY` → `api.openai.com`) cho qua. Biến chỉ
  tính khi mở rộng thật: trong nháy đơn, `$'…'` hay thoát `\$` là chữ (`git commit -m 'docs: set $GH_TOKEN'`) — T-3955
  B2. Hậu tố
  trình chạy gói/tên lạ bóc thêm tại tên trình mạng/in/đọc tệp/CLI đám mây (`uv run curl -d @.env`, `valgrind printenv
  GH_TOKEN`); `env -S` quét như lệnh. Chuỗi `-c`/`--call` của `npx`, `npm exec|x`, `pnpm exec|dlx` quét như `sh -c`.
  Lệnh ở máy xa/container đang chạy (`ssh host …`, `docker|podman|nerdctl exec`, `kubectl exec`, `lxc|incus exec`,
  `limactl shell`) quét đủ luật (vi phạm → mã REMOTE_EXEC; CSDL không nêu host là máy chủ không cục bộ). `ssh`/`kubectl
  exec` (máy xa/cụm): xoá đường dẫn tuyệt đối chặn trừ thư mục tạm/cache (`/tmp`, `/var/tmp`, `/var/cache`,
  `/var/lib/apt/lists`, `~/.cache`, `node_modules`, `__pycache__`, `.pytest_cache`, `dist`, `build`, `.next`). Container
  cục bộ (`docker|podman|nerdctl exec|run`, lima) giữ gốc `/`: xoá đường dẫn trong đó không chặn — **giới hạn chấp
  nhận (d)** (T-3952, hạn xét lại 2027-01-21 cùng (a)–(c)): `docker exec app rm -rf /data` còn qua; `lxc|incus exec c --
  rm -rf /data` vẫn chặn (luật lệnh lồng — remote của lxc có thể là máy khác). Ở máy xa (T-3955 B3/B4) `sudo`/`doas` là
  trình bọc (luật sudo là chính sách máy dev — lệnh sau nó quét theo luật huỷ), heuristic BUDGET của máy dev (tệp ghi rồi
  nhắc lại khi không chạy tệp, `$(…)`/biến máy xa ở đối số lệnh lành) không áp; giá trị không tính được ở tên lệnh hay
  đối số của lệnh có luật huỷ (`rm -rf $DIR`, `rm $FLAG /data`) → REMOTE_EXEC. CLI đám mây/PaaS huỷ hạ tầng (`aws …
  delete-*|terminate-*|s3 rb|rm|sync --delete`, `gcloud|gsutil|az|helm|doctl|heroku|fly|vercel|netlify|wrangler` xoá) →
  DESTROY; thanh toán/thư/SMS (`stripe` ghi, `sendmail`, `mail <người nhận>`, `twilio …:create`, `aws ses|sns` gửi) →
  chặn. In tệp chứa token (`~/.config/gh/hosts.yml`, `.git-credentials`, `.netrc`) → chặn như `gh auth token`. Tên lệnh
  glob xét ở mọi thư mục không glob (`/usr/lib/git-core/gi[t]`; ngoài thư mục bin chỉ mẫu độ dài cố định), tên trần
  (`gi[t]`) theo tệp ở thư mục đang đứng.
  T-3951 (cổng ký 10): `>&TỪ`/`1>&TỪ` (TỪ không phải số fd/`-`) là ghi như `&>TỪ`. Lệnh xoá/ghi có biến guard không tính
  chắc đọc thêm bản RỖNG (shell không giữ biến giữa các lần gọi: `rm -rf "$TMPDIR"/*` = `rm -rf /*`; `${X:-chữ}` → chữ;
  không đọc lại: biến luôn có như `HOME`/`PWD`, gán chữ, `${X:?}`, biến vòng, gán từ `$(mktemp …)`/`$(date …)`) và bản
  GIÁ TRỊ BẤT KỲ: đích bản rỗng là `/`, mục cấp một đang có của `/` hay home → chặn; tiền tố tuyệt đối/`~` ngoài gốc trước
  mở rộng (`/home/$USER/x`, `~/../$USER`) → WIPE_OUTSIDE; bản rỗng là đường tuyệt đối chưa có (`"$TMPDIR/x"`) vô hại.
  Tuỳ chọn đặt thư mục của trình chạy (`--directory`, `--dir`, `-C`, `--cwd`, `--prefix`, `-p`, `-w`, `-d`,
  `--working-directory`…) đứng trước lệnh có luật là `cd` (`uv run --directory ~ rm -rf x`). Chuỗi template JS là chuỗi
  chữ (`${…}` đọc như thay lệnh); Python nhập mô-đun chạy lệnh qua bí danh/`from … import`/`__import__` → mọi chuỗi chữ
  quét như lệnh. `git push` đọc nhánh hiện tại (không refspec, `HEAD`/`@`, truy vấn nhánh viết thẳng hay qua biến) sau
  lệnh ĐỔI NHÁNH cùng lệnh (`switch`, `checkout <nhánh>`/`--detach`, `checkout -b|-B`/`switch -c|-C` tên nhánh chính
  hay tên dựng lúc chạy, `rebase <upstream> <nhánh>`/`--root <nhánh>`/`--abort`, `stash branch`, `gh pr checkout`) →
  BUDGET; `pull`/`merge`/`reset`/`rebase <upstream>`/`worktree`/`checkout -- <tệp>` không đổi nhánh: push không refspec
  sau chúng cho qua, đích do cấu hình hiệu lực (F3) và luật nhánh chính xét (T-3955 B1). Glob (`rm -rf lnk_*/`, `*/.config`, `rsync --delete e/ l*/`, biến vòng `for d in
  lnk_*`) mở ra từng phần tử rồi realpath (có `/` cuối: cả đường; không: thư mục cha + tên; không khớp gì: thư mục cha
  glob). Lệnh ngoài danh sách chỉ đọc (như GO-NO-GO; trừ công cụ kiểm không cờ sửa, `python -m json.tool`…) có đối số
  giải vào `.claude/**`, `.autopilot/**`, bên trong thư mục git → chặn với mã của đích (`gsed -i`, `vim -es`, `sponge`,
  `gzip`/`zstd --rm`, `tar --remove-files`; trình thông dịch chỉ khi `-i` hay có lời gọi ghi). Ghi/xoá `~/.ssh/**`,
  `~/.gnupg/**`, `~/.aws/**`, `~/.kube/**`, `~/.netrc`, `~/.npmrc`, `/etc/**` và `>` vào tệp khởi động shell (`~/.bashrc`…)
  → WIPE_OUTSIDE; nối thêm `>>`/`tee -a` vào rc và `~/.ssh/known_hosts` cho chạy (AUD-SEC-060, T-3955 B5). Nguồn xargs `grep -rl`/`rg -l`/`git grep -l`/`ag
  -l` với đường chữ dưới gốc, không phải gốc/hàng rào, không chứa `.git` → như `find src`. Stdin từ `< <(…)`/`<&N`/nhóm
  vào lệnh ngoài `STDIN_DATA_OK` (`Rscript -`, `julia`) → BUDGET. Lối thoát theo từng công cụ: `!` (ed/ex/vim/dc), `\!`
  (psql/mysql), `pager`/`system` đầu câu (mysql), `pipe`/`shell` (gdb), `to program` (psql), `exec`/`spawn`/`open "|…"`
  (tcl/expect); `Deno.Command`/`Deno.run` là lời gọi chạy lệnh. Giữ BUDGET có chủ (D-503): `sed -n "$(grep -n …)…"`,
  `cd "$T" && … && cd - && rm -rf "$T"`, `rm -rf "$(git rev-parse --show-toplevel)/dist"`, `rm -f "$(basename "$f"
  .c).o"`. Họ (c) mở rộng (hạn xét lại 2027-01-21): payload che bằng biến/`getattr(os, "system")`/`` `r${"m"} -rf ~` ``
  trong template JS (cả `${process.env.HOME}` trong `execSync` — cố ý, T-3955 B9). Họ `trap 'cd ~' DEBUG` là 🟢 cố ý.
  T-3955 (cổng ký 11, D-509): bí mật vào artefact — mọi lệnh `gh` (thân/ghi chú/`<`/`-F -`), message `git commit|tag|notes`
  (`-m`, `-F tệp`), thân `curl`: thay lệnh đọc tệp chứng thực (`classify_path` 'secret', `CRED_FILE_RE`,
  `~/.aws/credentials`, `~/.docker/config.json`, `~/.kube/config`, `*.tfstate`, `.dev.vars`, `secrets.*`) hay in môi
  trường (`env`, `printenv`, `set`, `export -p`, `declare -p`) → chặn (C1); in tệp đó ra transcript (`cat|head|sed|grep …`,
  trừ `.pub`/`.example`/`.sample`/`.template`, `grep -c|-l|-q`, stdout ra tệp) → chặn (C3; giới hạn chọn chặt:
  thân thay lệnh không biết có bị ghi ra tệp hay in, nên `echo "$(cat .env)" > out.txt` vẫn chặn). Interop WSL: `wsl --unregister` → DESTROY;
  `cmd /c`, `powershell.exe|pwsh.exe -c|-File|-EncodedCommand` (bản Linux: luật T-3954 B4) là shell mờ (BUDGET) trừ lệnh đọc đứng một mình; `rd /s`, `del
  /s|/q`, `Remove-Item`, `rm -r`, `robocopy /MIR|/PURGE` → WIPE_OUTSIDE (C2). Huỷ thêm (C4, DESTROY): `terragrunt|cdk
  destroy`, `sls remove`, `sam|eksctl|neonctl delete`, `turso … destroy`, `rclone sync|purge|delete`, `s3cmd del`, `mc rm`,
  `firebase …:delete`, đồng bộ có cờ xoá (`gsutil rsync -d`, `gcloud storage rsync --delete-unmatched…`, `azcopy sync
  --delete-destination=true`, `s3cmd sync --delete-removed`, `mc mirror --remove`), `supabase db reset --linked`. Cờ đầu ra
  của trình sinh khoá (`ssh-keygen -f`, `openssl -out|-keyout`, `age-keygen -o`) vào `~/.ssh`/`~/.gnupg`/`~/.aws`/`~/.kube`
  → SECRET_WRITE; `gpg --delete-secret*` → DESTROY (C5). `chmod|chown|chgrp|setfacl -R` trên đích nguy hiểm của `rm` → chặn,
  ngoài gốc (trừ thư mục tạm) → WIPE_OUTSIDE (C6). `crontab -r`/`/dev/null`/nguồn rỗng qua ống → chặn (C7). `git read-tree
  -u --reset`, `checkout-index -f`, `rm -f`, `reset --merge`, `switch -C <nhánh chính>`, `submodule deinit -f` như `reset
  --hard` (nới ở pha build); `reflog expire --expire=now`, `reflog delete`, `gc --prune=now` → chặn (C8). `npm|pnpm|yarn
  unpublish`, `gem yank`, `skopeo|crane delete`, `regctl tag delete`, `gh release delete-asset`, `gh api -X DELETE
  …/packages/…` → DESTROY (C9). Trình xem/kiểm chỉ đọc trên hàng rào (`tree`, `xxd`, `od`, `hexdump`, `bat`, `pyflakes`,
  `yq` không `-i`, `black|isort --check|--diff`) cho qua (B8); `gh secret list` không còn DESTROY (B11). Fuzz cổng ký sau dùng gốc ngoài /tmp (fz6–fz9 từng dùng gốc
  dưới /tmp nên `..` của gốc bị coi là thư mục tạm, che vài ca — C3).
- **Lô A cổng ký 11 — đợt sửa cuối** (T-3954, D-503, D-509): sed đọc cờ như getopt (`-Ei`, `-ni`, `-sEi`: `i` ở mọi
  vị trí là sửa tại chỗ; cả `gsed`); đích home quy `$HOME`/`${HOME}`/`"$HOME"` về `~` trước luật dotfile, công cụ sửa tại
  chỗ ngoài bảng (`sponge` không `-a`, `vim -es`, `ed`, `dos2unix`, trình nén không `-c`/`-k`) vào dotfile → chặn; curl
  đọc cụm cờ ngắn theo bảng cờ nhận giá trị (`-sSfXPUT`), `curlie` như httpie; khâu ống in biến bí mật (`echo`/`printf`
  `$GH_TOKEN`, `$API_KEY`…) trước khâu mạng, kể cả mở đầu lệnh ghép (`{`, `do`, `then`) → chặn; tuỳ chọn chung của
  npm/pnpm trước `x`/`exec`/`dlx`; script GẮN TÊN KHÁC cho API chạy tiến trình (destructure/gán `require("child_process")`,
  `from os import`, `import subprocess as`, tham chiếu không gọi, `getattr(os…)`, Bun Shell) → mọi chuỗi và danh sách
  chuỗi quét như lệnh (lời gọi trực tiếp giữ luật cũ: chuỗi khác là dữ liệu); `$@`/`$*` rỗng ở đích xoá; `python -m
  json.tool IN OUT` ghi OUT; `bun exec` như `sh -c`; autossh/mosh/`kubectl|oc run|debug|exec` quét như máy xa; `pwsh`/
  `powershell` (`-c`: câu xoá dịch sang `rm -rf`, câu ngoài danh sách chỉ đọc → BUDGET; `-File`/`-EncodedCommand` →
  BUDGET; `*.exe` thuộc T-3955); biến chạy lệnh `*PAGER`/`BROWSER`/`GH_EDITOR` có giá trị không phải chương trình + cờ
  trơn, `npm_config_script_shell` không phải shell, `TAR_OPTIONS` có cờ nhận lệnh, `NODE_OPTIONS` nạp `data:`/URL →
  BUDGET (`PAGER=less`, `PAGER=sh` trơn qua — AUD-SEC-419/420); script nội tuyến chạy stdin MỜ (`cat f | perl -ne
  system`, `os.system(sys.stdin.read())`, `< f`) → BUDGET (thân heredoc/echo đã quét thì không); lối thoát: psql `\w |`,
  sqlite3 `.read '|…'`, vim `:terminal`/`jobstart()`/`:python3`…, gdb `python`/`guile`, lldb `-o 'platform shell …'`,
  mongosh `require("child_process")`, `less +'!…'`, `wget --use-askpass`, `rsync --rsync-path` (đầu kia `host:` → luật máy xa, T-3956), `git bisect run`;
  `pdm --project D` như `-p D`; `gcloud billing projects unlink` → DESTROY; đích ghi glob `[…]`/`?` mở theo tệp có thật;
  `python3 - release-sign` (script từ stdin) → GO_SIGN. **Giới hạn** (hạn xét lại 2027-01-21): `kubectl run … -- 'lệnh có
  khoảng'` là argv một từ (vô hại); cụm `*` ở đối số công cụ ngoài bảng không mở (danh sách `for`); che giấu nhiều bước
  qua tên hàm tính lúc chạy không gắn tên (`globals()[…]`) và lối thoát công cụ ngoài danh sách vẫn ngoài mô hình.
  Test: `tests/test_guard_signoff13.py`, ca `guard-t3954-*`, họ `T13|*` của `d503_invariant.jsonl`.
- **`merge-check` so giờ sổ review cục bộ với giờ GitHub** (AUD-XFEAT-019, D-104): review chặn chỉ có ở sổ cục bộ được
  tính khi ghi sau dấu đã đăng mới nhất ở cùng head; đồng hồ máy chậm hơn GitHub thì review chặn ghi ngay sau một dấu sạch
  bị coi là cũ hơn. Lớp đỡ: `pr reviewed` đăng ngay kết luận (dấu đã đăng là nguồn của `merge-check`/steward/guard).
- **Script nhắc đường dẫn được canh: mặc định chặn** (D-105): script `-c`/`-e`/`-r`, heredoc, here-string hay ống vào
  trình thông dịch có chuỗi là hàng rào (`.claude/hooks/*`, `.claude/settings*.json`), `.git/hooks`/`.git/config`, bí mật
  hay `.autopilot/` bị chặn với mã của đích, trừ khi TOÀN script chỉ gồm thao tác đọc trong danh sách nhỏ (`open` mode
  đọc tối đa 2 đối số vị trí, `.read*()`, `Path(…).read_text/exists/stat/glob/rglob/iterdir`, `os.path.<hàm đọc>`,
  `os.listdir/scandir/walk`, `json.load(s)`, `json.dump(x, sys.stdout)`, `.get/.keys/.values/.items`, `sorted/min/max`
  không `key=`, `ast.parse`, `hashlib`, `print`; `readFileSync`/`existsSync`/`statSync`). D-105 **kích hoạt theo chuỗi
  nguyên văn**: chỉ khi script có chuỗi là đường dẫn được canh — đường dẫn ghép (`'.e' + 'nv'`) không làm script bị xét
  (giới hạn ở mục trên). Chuỗi lấy bằng regex (cả chuỗi giữa hai nháy bất kỳ, bắt f-string cùng nháy của 3.12+) hợp với
  hằng str/bytes của AST khi script là Python (escape đã giải, phần hằng của f-string); script chuẩn hoá NFKC trước khi
  quét (`os.ｒemove` là `os.remove`). Trình thông dịch nhận: python, pypy, ipython (họ python), node, deno (`-e`,
  `deno eval`), bun, perl, ruby, php, lua (`--`/`[[…]]` là không chỉ đọc), tclsh. Magic chạy shell của ipython (`!cmd`,
  `!!cmd`, `x = !cmd`, `%sx`, `%system`, ô `%%bash`/`%%sh`/`%%script <shell>`) quét như `sh -c`; magic lạ: từ trên dòng
  magic là ứng viên đường dẫn (`%%writefile .env` bị chặn). Tcl không cần nháy nên `file delete .env` không bị xét;
  escape trong chuỗi node/ruby/perl chưa được giải. Bộ che chuỗi/comment (D-107): Python che
  bằng `tokenize` (cú pháp sai → không chỉ đọc; biểu thức f-string kiểm đệ quy); node/ruby/perl/php chỉ che chuỗi một
  dòng, phần mã còn `#`, `/`, `%`, `<<`, quote-like Perl (`q{}`, `qq{}`, `m{}`, `s{}{}`…), nháy dính biến (`$'`, `?'`) hay
  chuỗi nháy kép có `$`/`@` là không chỉ đọc; script có sẵn byte `\x01`/`\x02` (trùng dấu che) cũng vậy (AUD-SEC-091).
  Script có dấu hiệu API ghi mà nhắc hơn 64 đường dẫn canh khác nhau bị coi như ghi (trần dò, AUD-SEC-092). Chặn oan đã biết: script vừa đọc `.env` vừa làm việc khác (gọi
  `requests.get`, ghi file khác, hàm tự viết), script sửa tài liệu có chuỗi `'.env'` đứng riêng, Perl/PHP đọc file bằng
  hàm ngoài danh sách, JS template string; theo D-107 thêm: script node/ruby/perl/php nhắc đường dẫn được canh mà có
  comment, phép chia, `%`, heredoc, chuỗi nhiều dòng; `open(p, 'r', -1)` (đối số thứ 3); deno/lua/tclsh đọc file canh
  bằng API riêng (`Deno.readTextFileSync`, Lua `f:read`, Tcl `read`); script chỉ nạp module hàng rào
  (`sys.path.insert(0, '.claude/hooks'); import guard`) hay heredoc python ghi tài liệu có nhắc `.env`/`.claude/hooks`
  (AUD-HAR-100 — dùng `python3 -m unittest`, Edit/Write). Sửa file canh thì dùng
  Edit/Write; đọc thì dùng `cat`/Read hoặc script chỉ đọc.
- **Thư mục không biết** (D-106): sau `cd "$X"`, `cd -`, `pushd +N`, `popd` (trừ `popd` trần sau đúng một `pushd <chữ
  trơn>`, ngoài vòng lặp/hàm — guard xét cả thư mục trước và sau `pushd` (tập thư mục, không mô hình ngăn xếp), T-3945),
  `cd` khi có `CDPATH`, `cd`/`pushd` tới
  toán hạng có glob (`cd .cl*`), đích ghi tương đối được thử ở gốc và mọi thư mục canh (`.claude`, `.claude/hooks`,
  `.autopilot`, `.git`, `.git/hooks`) — chặn khi file đã có ở đó hoặc tên là tên được canh (chặn oan: `cd "$X" && echo
  x > config` dù `$X` không phải `.git`). `env -C DIR`/`--chdir=DIR` dời thư mục của lệnh sau `env` như `cd` (kèm chuyển
  hướng thì thư mục là không biết; tuỳ chọn dài viết tắt duy nhất như `--ch=DIR` cũng tính); `dd of=<đích>`, lệnh chỉ
  gồm chuyển hướng (`exec 3> .env`) và chuyển hướng đọc-ghi `<>` (`exec 3<> .env`) là ghi.
- **Thân lệnh dựng lúc chạy bị chặn theo thiết kế — viết thay** (ADR-0063 lát B, AUD-SEC-322): `eval`/`sh -c` có thân lấy từ
  `$(…)`/biến và hàm gọi `"$@"` không chứng minh được lệnh sẽ chạy nên bị chặn. Cách viết thay qua guard:
  `eval "$(ssh-agent -s)"` → `ssh-agent -a "$HOME/.ssh/agent.sock" >/dev/null; export SSH_AUTH_SOCK="$HOME/.ssh/agent.sock"`;
  `bash -c "cd $TMP"` (thân chỉ `cd` — guard cho qua) hay thân có lệnh có luật → truyền đối số
  `bash -c 'cd "$1" && …' _ "$TMP"`; `retry(){ "$@"; }; retry ls` → vòng lặp tường minh
  `for i in 1 2 3; do ls && break; sleep 1; done` (khoá bằng `tests/test_guard_strict.py`).
- **Hook `TaskCompleted` chỉ chạy khi phiên có tool Task** (AUTO-02, D-068): `TaskCreate`/`TaskUpdate` không bật mặc định
  trên Opus 5.5/Sonnet 5.5/Haiku 5.5/Fable ở CLI — cần `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` hoặc nêu tool trong
  `--allowedTools`; phiên nền và phiên cloud luôn có. Thiếu tool thì không có sự kiện `TaskCompleted`, hook không bao giờ
  kích hoạt và cổng bằng chứng mức task im lặng; lớp đỡ vẫn là `loop record` + Stop hook. Nguồn: Claude Code docs
  tools-reference <https://code.claude.com/docs/en/tools-reference.md>, đọc 2026-10-21
  (`research/2026-10-21-next-level-speed-automation-quality.md` §4.1).

### Agent khác Claude Code (ADR-0064)

Lõi chặn là `guard.py` chế độ trung lập (`guard.py core`: JSON `{tool, command|path|tool_name, input, cwd, project_dir}` vào (`project_dir` vắng → gốc lấy từ `CLAUDE_PROJECT_DIR` rồi `cwd`), `{decision,
code, reason}` ra, exit 2 khi deny); mỗi công cụ một adapter mỏng. Ma trận đầy đủ, nguồn và ngày:
`research/2026-11-02-multi-provider-harness.md` §2 và §8. Adapter, sàn git hook và vòng lặp ngoài `loop run --agent` làm
theo lát của ADR-0064 — trạng thái ở dòng *Trạng thái triển khai* của ADR. Điều harness dựa vào:

| Công cụ | Lớp chặn trước tool | Cuối lượt khi headless | Lưu ý cho adapter |
|---|---|---|---|
| Claude Code | `PreToolUse` (harness gốc) | `Stop` | — |
| Codex CLI | `PreToolUse` exit 2 / deny | `Stop` | shell lấy từ `passwd` theo đường tuyệt đối: wrapper trên `PATH` không chặn được |
| Gemini CLI | `BeforeTool` exit 2 / deny | không (`AfterAgent`) | vòng lặp ngoài thay Stop hook; sandbox tắt mặc định |
| Cursor CLI | `beforeShellExecution` (`preToolUse` ở `-p`: chưa xác minh) | `-p` không phát `stop` (thứ cấp) | cần vòng lặp ngoài và sàn git hook |
| Copilot CLI | `preToolUse` (exit khác 0 = deny, timeout fail-open) | `agentStop` | **tự đọc `.claude/settings.json`**: hook Claude đã chạy, adapter không nạp guard lần hai |
| Grok Build | `PreToolUse` (fail-open, timeout 5 s) | `Stop` không chặn | đọc `.claude/settings.json`; vòng lặp ngoài |
| OpenCode | plugin `tool.execute.before` (`throw`) | không (`session.idle`) | không sandbox chính chủ: `doctor` nhóm `sandbox` cảnh báo |

Mã thoát headless không phản ánh việc bị từ chối quyền ở mọi công cụ (`opencode run` giữ mã khi quyền bị từ chối; Cursor,
Copilot, Grok chưa xác minh) → vòng lặp ngoài tin `loop verify`, không tin mã thoát của agent.

Cài và chạy (lát B–D đã làm): `install.py --harness codex,gemini,cursor,copilot,grok,opencode` chép cấu hình hook mẫu
([`../templates/harness/`](../templates/harness/README.md)) gọi `xt_adapter.py`; git hook sàn ([`../templates/git-hooks/`](../templates/git-hooks/README.md)) cài
mặc định; công cụ không có Stop hook chặn (Gemini, Grok, OpenCode, Cursor `-p`) chạy vòng ngoài `xt.py loop run --agent
<host>` — mỗi lượt một task do `loop_verdict` chọn, dừng khi xong/chặn hay 3 lượt không tiến triển. Codex còn nhận skill
`.agents/skills/` và agent `.codex/agents/*.toml` sinh từ `.claude/` (ADR-0082; chi tiết ở README của `harness/`).

### Khoá của `xt.yaml` (nhà — mẫu: [`../templates/xt.yaml`](../templates/xt.yaml) chỉ còn một dòng chú thích mỗi khoá)

YAML phẳng `khoá: lệnh`; `""` = không có, thiếu khoá = tự dò từ manifest; chú thích sau `#` ngoài nháy bị bỏ. Hai nhóm:

| Khoá | Ai chạy | Ý nghĩa |
|---|---|---|
| `lint` · `typecheck` · `test` · `build` | `dev-task.sh gate` (= CI) | Cổng đầy đủ theo thứ tự build → typecheck → lint → test; `lint` nên gồm kiểm format. Autopilot đang chạy mà `lint`/`test` rỗng hay no-op (`true`, `:`, `exit 0`, `echo …`) = cổng **đỏ** (ADR-0011); CI mẫu đỏ tới khi có lệnh thật (D-096). Ở M/L còn sàn `LOOP-HARNESS-023` |
| `format` · `format_file` | `dev-task.sh format` · hook PostToolUse | Format cả repo · format MỘT file (`{}` = đường dẫn); `format_file` trống → mẫu dựng sẵn (prettier/ruff/black/gofmt/rustfmt), không qua guard; lệnh khai báo qua guard (LOOP-STOP-027). `dev-task.sh format` chụp mọi `GO-NO-GO*.md` dưới gốc dự án trước khi chạy và khôi phục file bị formatter đổi; **giới hạn**: thư mục là symlink trỏ ra ngoài gốc dự án không được chụp (khôi phục sẽ ghi ngoài dự án) — GO-NO-GO phải nằm trong cây dự án. Thư mục user không đi xuyên được (thiếu `x`, tên Unicode/có nháy) bị bỏ qua có log, lỗi find lạ vẫn dừng |
| `format_check` · `coverage` | `loop verify` (sàn M/L) | Kiểm format không ghi file; test có ngưỡng coverage — artefact ra `mktemp`, không `\|\| true` |
| `commit_gate` · `test_fast` | hook trước `git commit` | `fast` (mặc định dự án mới) = `gate-fast` (format_check → lint → typecheck → `test_fast` với `XT_CHANGED_FILES`, trống → `test`); `full`/vắng = `gate`. Diff đụng cấu hình cổng (xt.yaml, xt.py, dev-task.sh, hook, ruff/coverage/requirements) → mọi lớp test qua `test_list`/`test_unit` không coverage, chưa khai hai khoá đó → `test` (D-112). Commit trong worktree của chính repo (cùng common-dir và liên kết ngược tới gitdir đã đăng ký, trong hay ngoài gốc) → cổng chạy trên worktree đó (dev-task.sh, xt.yaml, tệp đổi của nó); repo khác không tự chạy cổng (AUD-SEC-015); git không trả lời được → luật cũ kèm cảnh báo stderr. Giá trị khác `fast`/`full` → `doctor` (lỗi `xt-yaml`) và `ci-check` từ chối |
| `setup` · `test_list` · `test_unit` · `test_combine` · `test_weights` | `setup`: CI mẫu (`install.py --with-github`); bốn khoá chia test: `dev-task.sh test-shard`/`test-combine`, `gate-fast` khi diff đụng cấu hình cổng, CI tự tách test thành shard | `setup` cài phụ thuộc mỗi job CI. CI mẫu 3 job (ADR-0039) không chia shard: job `gate` chạy `dev-task.sh gate-par` (typecheck ∥ lint ∥ build → test song song trong job, D-128) nên ngưỡng coverage nằm trong `test`. Chia shard — chỉ khi đo thấy test là đường dài nhất — cần đủ `test_list` (mỗi dòng một id), `test_unit` (chạy `"$1"`, coverage vào `"$XT_COV_DIR"` nếu có), `test_combine` (gộp, đòi ngưỡng); `test_weights` = file trọng số LPT (`dev-task.sh test-weights`) |
| `merge_autonomy` · `merge_risk_paths` · `merge_hard_exceptions` · `delivery_phase` · `pr_title_check` | `merge-check`/`pr next`/guard — đọc ở **nhánh đích đã commit** (PR không tự đổi luật cho mình) | L3 (mặc định) máy merge ghim head theo làn (ADR-0015, ADR-0036), L2 chỉ làn nhanh, L1 người merge · glob thêm vào đường dẫn nhạy cảm (hợp của cây làm việc và nhánh đích) · `human` người merge ngoại lệ cứng (ADR-0016), `auto` máy merge khi CI xanh (ADR-0020; PR đổi khoá này luôn người merge) · `build`/`harden` quyết pha giao hàng; cổng review theo `merge_review` (ADR-0079) · `off` tắt kiểm tiêu đề PR Conventional Commits |
| `merge_review` | `merge-check`/`pr next`/`pr steward` | `optional` hoặc vắng: CI xanh, không bắt buộc review và steward xét theo số PR tăng dần; `required`: dùng cổng review theo làn. Đọc cấu hình tại nhánh đích (ADR-0079). |
| `review_identity` · `author_model_family` · `reviewer_model_family` · `author_effort` · `reviewer_effort` | `merge-check`, `ci-check` (T-1508, D-161) | Chỉ dấu review của đúng tài khoản mở được merge; model reviewer phải năng lực cao hơn tác giả (bậc cao hơn, cùng họ thì effort `low`…`max` cao hơn — `LOOP-ORCH-005`); effort cấu hình của một phía chỉ dùng khi model phía đó cũng lấy từ cấu hình (job `pr-review` truyền model thật → cùng họ bị từ chối); `reviewer_model_family` là họ THẬT của model reviewer (workflow `pr-review` chạy model trong `XT_REVIEWER_MODEL`), không phải nhãn tuỳ ý |
| `e2e` · `e2e_setup` | `dev-task.sh e2e [I N]` — job `e2e` của CI mẫu, agent chạy tay | `e2e_setup` (cài trình duyệt) rồi `e2e` với `XT_SHARD=I/N` (mặc định `1/1`); lệnh dùng `$XT_SHARD` thì mỗi shard một phần, không thì shard 1 chạy cả suite; rỗng → bỏ qua có log (D-115, `QA-E2E-029`). Từ 3.12.0 CI chạy `e2e` (trước: chỉ agent chạy tay) — lệnh cần trình duyệt/server thì khai `e2e_setup`, chưa sẵn thì để `e2e: ""` |
| `e2e_affected` · `audit` · `migrate` · `init` · `smoke` · `install` · `dev`… | Agent đọc và chạy trực tiếp | Khai báo; `dev-task.sh` không chạy. `e2e_affected` = chỉ spec của lát đang làm (Gate mỗi task), suite đầy đủ `e2e` khi push `main`/trước phát hành (`QA-E2E-023`) |
| `attack` · `perf` | `release-check` (pha harden, ADR-0042) | Tấn công thử (DAST như ZAP baseline/API scan, fuzz API như Schemathesis, kịch bản khai thác) trên bản chạy cục bộ/staging · kiểm tải có ngưỡng (vd k6 `thresholds`) — đỏ khi có lỗ/vượt ngân sách; chưa khai ở M/L → người ký lý do |
| `migration_check` · `rollback` · `acceptance` | `release-check` (cổng production, ADR-0062 §6) | Migration tiến + lùi trên bản sao dữ liệu/staging · diễn tập quay về bản trước (tag/artifact cũ + migration lùi) · kiểm thử nghiệm thu tự động theo tiêu chí chấp nhận — đỏ = NO-GO, chặn `prod_switch`; chưa khai ở M/L → người ký lý do |
| `preview` | `xt.py stage submit` (ghi, không chạy) | Cách chạy thử bản trình người duyệt giai đoạn (ADR-0058) — chỉ ghi vào sổ và in ở `stage status` |
| `preview_smoke` | `xt.py stage submit` (chạy qua guard) | Gate bản trình (D-247): exit ≠ 0, để lại thay đổi trong cây hay HEAD đổi trong lúc chạy → không trình; trống → sổ ghi "không có smoke" |
| `stage_approval` | `xt.py stage approve` · `loop next-step` · guard — đọc ở **cây và bản đã commit ở nhánh chính** | `agent` = agent tự nghiệm thu giai đoạn (ADR-0069): duyệt bản trình còn nguyên, `next-step` trả `stage-approve`; vắng/`human` = chỉ người, ngoài phiên agent (ADR-0058). `init --adopt` luôn chỉ người |
| `release_signoff` | `xt.py release-sign` · `release-check` · guard — đọc ở **cây và bản đã commit ở nhánh chính** | `agent` = agent ký §5 GO-NO-GO (ADR-0074): chỉ khi `release-check` (blueprint/sổ ở đường mặc định) không FAIL BLOCKER, việc người còn lại chỉ là chữ ký, `BLUEPRINT.md` `scale: S`, không còn `loop defer` ở sổ máy của dự án tại mọi worktree của repo (không worktree nào có `.autopilot/state.json` — clone riêng, chưa `loop init` — hay sổ hỏng → không ký, AUD-HAR-340), dòng `subject:` khớp; ô tên ghi `agent`, `promotion.by` liệt kê người ký; guard chỉ cho một lệnh đơn chữ rõ, ghi dòng ký bằng tay vẫn chặn (`GO_SIGN`). Vắng/`human` = người ký |
| `claude_min_version` · `ai_attribution` | `doctor` · guard | Cảnh báo Claude Code thấp hơn (`LOOP-HARNESS-026`) · `forbid` chặn commit/PR ghi tên model hay URL phiên AI (`LOOP-HARNESS-027`) |
| `harness_permissions` | `install.py` | `own` = dự án giữ mô hình quyền riêng: không thêm `allow: Bash`/`deny` của khung, lệnh hook của khung theo dạng dự án đang dùng — có lệnh khung dạng `${CLAUDE_PROJECT_DIR}/.claude/hooks/…` thì giữ tuyệt đối, không có thì tương đối `bash .claude/hooks/x.sh` (giao ước dhcb — chủ repo 2026-10-22; ADR-0073, D-383); guard vẫn chạy trong hook. Vắng = gộp quyền theo ADR-0018 |

Mẫu theo stack (giữ MỘT bộ): **Node** `lint: npm run lint` · `typecheck: npm run typecheck` · `test: npm test -- --run` · `build: npm run build` · `format: npm run format` · `format_file: npx --no-install prettier --write "{}"` · `format_check: npx --no-install prettier --check .` · `coverage: npx --no-install vitest run --coverage` · `test_fast: npx --no-install vitest related --run $XT_CHANGED_FILES`. **Python** `lint: ruff check .` · `typecheck: pyright` · `test: pytest -q` · `format: ruff format .` · `format_file: case "{}" in *.py) ruff format "{}" ;; esac` · `format_check: ruff format --check .` · `coverage: COVERAGE_FILE="$(mktemp)" PYTHONDONTWRITEBYTECODE=1 pytest -p no:cacheprovider --cov --cov-fail-under=80` · `test_fast: pytest -q $(python3 .xtemplates/scripts/xt.py test-select)`. **Go** `lint: go vet ./...` · `test: go test ./...` · `build: go build ./...` · `format: gofmt -l -w .` · `format_file: gofmt -w "{}"` · `format_check: test -z "$(gofmt -l .)"` · `coverage: f="$(mktemp)" && go test -coverprofile="$f" ./... && go tool cover -func="$f" | awk '/^total:/{exit ($3+0 < 80)}'` · `test_fast: p="$(printf '%s\n' $XT_CHANGED_FILES | sed -n 's|^\(.*\)/[^/]*\.go$|./\1/...|p' | sort -u)"; go test ${p:-./...}`. **Java (Maven)** `test: mvn -q test` · `test_fast: c="$(printf '%s\n' $XT_CHANGED_FILES | sed -n 's|.*/\([A-Za-z0-9_]*\)\.java$|\1*|p' | sort -u | paste -sd, -)"; mvn -q test ${c:+-Dtest="$c" -Dsurefire.failIfNoSpecifiedTests=false}`. **.NET** `test: dotnet test` · `test_fast: c="$(printf '%s\n' $XT_CHANGED_FILES | sed -n 's|.*/\([A-Za-z0-9_]*\)\.cs$|FullyQualifiedName~\1|p' | sort -u | paste -sd'|' -)"; dotnet test ${c:+--filter "$c"}`. Ba mẫu `test_fast` này lọc theo gói (Go) hoặc tên lớp (Java `Foo*`, .NET `~Foo`); không khớp file nào → chạy cả suite (không yếu hơn `test`); chưa chạy ở dự án đích thật — kiểm một lần khi áp (research `research/2026-10-21-next-level-speed-automation-quality.md` NH-6).

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
| claude-mem (Apache-2.0) | Muốn ghi **tự động** mọi phiên, chấp nhận AI nén nội dung | Nội dung memory do AI chọn, khó duyệt trước khi ghi; thêm vector store; telemetry bật mặc định và model nén nhận transcript (mặc định API Anthropic, tốn quota gói) — cấu hình theo `LOOP-HARNESS-030` |
| agentmemory (Apache-2.0) | Cần benchmark truy xuất, chấp nhận engine riêng | Engine iii theo Elastic License 2.0, không phải OSI |

Nguồn: catalog `www-donghanhcungban-org/stored` 10 §4b (agentmemory), §4c (engram), 03 §8b (claude-mem) — đọc 2026-10-16; 10 §4e (claude-mem v15.6.0) — đọc 2026-10-30.

## Checklist

- [ ] `LOOP-HARNESS-001` **MUST** `PLAN.md` dùng đúng cú pháp parser: mỗi task một dòng bắt đầu bằng `- [ ]` rồi mã `T-NNN` trong backtick, việc, và `Gate:` theo sau là lệnh trong backtick; không lồng danh sách con. → Kiểm: `xt.py loop status` không báo "PLAN không có task"; số task parse được = số dòng `T-`.
- [ ] `LOOP-HARNESS-002` **MUST** Lệnh Gate của mỗi task lấy từ `xt.yaml`/`dev-task.sh` hoặc là lệnh test cụ thể, chạy được trên máy sạch; không ghi "kiểm tay". → Kiểm: `grep -c 'Gate: `' docs/autopilot/PLAN.md` = số task; mỗi Gate chạy được trong CI.
- [ ] `LOOP-HARNESS-003` **MUST** `PLAN.md` ghi đủ 4 con số theo [`LOOP-DESIGN-001`](loop-design.md) (trần vòng · ngân sách tiền/token · timeout mỗi lệnh kiểm · hạn chót) và danh sách điểm dừng bắt buộc dự kiến trước cổng duyệt. → Kiểm: mục "Ngân sách" và "Điểm dừng" tồn tại; trần vòng và hạn khớp tham số `loop init`.
- [ ] `LOOP-HARNESS-004` **MUST@L** Nhà của luật định dạng `PROGRESS.md` (mục sàn: [`BASE-DOC-008`](../01-baseline/documentation-minimum.md)): ≤ 8 KB, đúng 4 mục (Đang làm · Tiếp theo · Quyết định · Bàn giao phiên); lịch sử dài chuyển sang `CHANGELOG.md`/`docs/`. → Kiểm: `xt.py progress-check` exit 0 (≤ 8192 byte, đúng 4 mục theo thứ tự). · Nguồn: stored 23 §2.1
- [ ] `LOOP-HARNESS-005` **MUST@L** Nhà của luật độ tươi `PROGRESS.md`: mục Bàn giao ghi SHA commit cuối và nhánh; SHA phải là tổ tiên của HEAD và **đã có trên nhánh chính** (squash-merge xoá SHA của nhánh PR, nên không kiểm "nhánh còn trên remote"). → Kiểm: `xt.py progress-check` exit 0 trong CI (mọi SHA ở Bàn giao là tổ tiên HEAD và của nhánh chính: `XT_PROGRESS_BASE`, mặc định `origin/HEAD` → `origin/main` → `origin/master`; checkout `fetch-depth: 0`). · Nguồn: stored 21 §8 điểm 9
- [ ] `LOOP-HARNESS-006` **MUST@L** `.autopilot/` nằm trong `.gitignore`; bằng chứng chia sẻ cho người khác là link CI run/PR, không phải file cục bộ. → Kiểm: `git check-ignore .autopilot/state.json` exit 0; PR có link run CI.
- [ ] `LOOP-HARNESS-007` **MUST@L** `BLUEPRINT.md` được sinh bằng `xt.py compose`, commit ở G1; chữ của mục không bị sửa tay, chỉ đổi trạng thái. → Kiểm: diff với bản `compose` lại chỉ khác cột trạng thái và `— Miễn:`. · Nguồn: 00-method/composition.md
- [ ] `LOOP-HARNESS-008` **MUST** Nhà của bộ khoá `xt.yaml` (mẫu: [`../templates/xt.yaml`](../templates/xt.yaml)): khai `lint`, `test`, `typecheck`, `build` (chuỗi rỗng nếu không áp dụng); agent không suy diễn lệnh từ README. `scripts/dev-task.sh` chỉ chạy các khoá `format · lint · typecheck · test · build · format_file` (`gate` = build→typecheck→lint→test — cổng đầy đủ, CI chạy đúng lệnh này) và `format_check · test_fast` (`gate-fast` = format_check→lint→typecheck→test_fast, test liên quan file đổi qua `XT_CHANGED_FILES`, test_fast trống → `test`; hook commit chạy nó khi `commit_gate: fast`, vắng = `full` = `gate`; cổng đầy đủ là CI, cục bộ trước cắt bản/khi không có CI — ADR-0056); `e2e`/`e2e_setup` (`dev-task.sh e2e`) do CI mẫu gọi (D-115); khoá khác (`install`, `dev`, `coverage`, `migrate`, `init`, `smoke`, `audit`…) là lệnh khai báo để agent **đọc và chạy trực tiếp**, dev-task không chạy. Khi autopilot đang chạy, `lint`/`test` rỗng hoặc no-op (`true`, `:`, `exit 0`, `echo …`) làm cổng **đỏ** (ADR-0011 của repo khung). Ở quy mô M/L cổng còn phải đạt sàn `LOOP-HARNESS-023`. → Kiểm: `scripts/dev-task.sh gate` chạy đúng lệnh khai; `xt.yaml` tồn tại ở gốc; `xt.py loop init` không in `Cổng sẽ ĐỎ`. · Nguồn: stored 23 §3.3
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
- [ ] `LOOP-HARNESS-019` **SHOULD** Công cụ memory ngoài cho coding agent (agentmemory, claude-mem…) chỉ dùng để **tra cứu**, không thay `PROGRESS.md`/`TRAPS.md`/`PLAN.md`; tắt chèn tự động đầu phiên ở repo nhạy cảm, bind loopback, bật lọc bí mật trước khi lưu. → Kiểm: cấu hình công cụ (`auto-inject` tắt, bind `127.0.0.1`); `PROGRESS.md` vẫn qua `xt.py progress-check`. · Nguồn: `www-donghanhcungban-org/stored` 10 §4b (agentmemory)
- [ ] `LOOP-HARNESS-020` **SHOULD** Mỗi lần chạy autopilot bắt đầu bằng audit khung đã cài và sửa phần an toàn trước khi lập kế hoạch: hook bắt buộc (SessionStart · PreCompact · PreToolUse · Stop) có trong settings và file hook (kể cả file chúng nạp) tồn tại, đúng cú pháp; `CLAUDE.md` import `AGENTS.md`; `xt.yaml` đủ khoá; `.autopilot/` bị gitignore; state không hỏng; khung `validate` xanh; bản khung đã cài (`.xtemplates/VERSION`) không cũ hơn tag phát hành `vX.Y.Z` mới nhất của repo khung (đọc qua `gh api`, fail-open khi không có `gh`/mạng; cũ → cảnh báo chạy lại `install.py`; ở `delivery_phase: build` chỉ báo khi chậm MAJOR — pha build ghim khung, `/complete` nâng ở ranh giới pha, ADR-0081). Hook thiếu fail-open nên **không tự lộ** — chỉ máy kiểm mới thấy. Sửa tự động chỉ phần đảo ngược được; hook/settings là điểm dừng, để người cài lại. → Kiểm: `xt.py doctor --fix` exit 0 trước `loop init` (`loop init` cảnh báo trên stderr khi còn lỗi). · Nguồn: `scripts/xt.py` (`doctor_findings`), `.claude/hooks/_lib.sh` (fail-open) — đọc 2026-10-15
- [ ] `LOOP-HARNESS-021` **SHOULD** Bổ sung cho `LOOP-HARNESS-019` khi dùng công cụ memory ngoài: (1) chỉ bật **một** công cụ (engram, claude-mem, agentmemory… cùng hook SessionStart/UserPromptSubmit và cùng chèn context mỗi lượt); (2) kho memory nằm **ngoài repo**, quyền chỉ chủ sở hữu, coi là dữ liệu nhạy cảm vì có công cụ lưu **nguyên văn prompt**; nội dung nhạy cảm bọc thẻ loại trừ của công cụ (vd `<private>…</private>`); (3) tính năng đồng bộ memory **vào repo** (vd `engram sync` ghi `.engram/`) tắt ở repo công khai, ở repo riêng thì thư mục đó phải qua quét bí mật trước commit. → Kiểm: `xt.py doctor` không có cảnh báo `memory` (đếm công cụ memory theo tên trong `enabledPlugins` cấp người dùng/dự án/cục bộ và MCP server ở `~/.claude.json` + `.mcp.json`, ≤ 1; `.engram/` không nằm trong git); `stat -c %a` thư mục kho memory = `700`; repo riêng: gitleaks quét `.engram/` = 0 phát hiện. · Nguồn: `www-donghanhcungban-org/stored` 10 §4c (engram: hook lưu prompt cục bộ và chèn chỉ thị mỗi lượt, Git Sync ghi `.engram/` vào repo, `<private>` lọc hai tầng)
- [ ] `LOOP-HARNESS-022` **MUST@L** Phiên autopilot không người trực chạy trong sandbox mức hệ điều hành của host (ghi giới hạn trong workspace, mạng chặn mặc định + allowlist registry/git) hoặc trong devcontainer/VM có egress allowlist; guard hook không phải sandbox (chỉ thấy lệnh qua tool, không chặn tiến trình con hay mạng). Mức MUST@L từ 2026-11-02 (ADR-0064, D-303; trước là SHOULD): trần 4 MUST/module ở quy mô M đã đầy (ADR-0004) nên không đặt MUST@M; ở S/M máy hạ thành SHOULD nhưng `xt.py doctor` nhóm `sandbox` cảnh báo đỏ khi phiên không người trực chạy ngoài sandbox (lát E của ADR-0064). Claude Code (đọc 2026-10-22, <https://code.claude.com/docs/en/sandboxing>): `sandbox.enabled` (ghi chỉ trong thư mục làm việc + `$TMPDIR` + `sandbox.filesystem.allowWrite`), `sandbox.network.allowedDomains`, `sandbox.failIfUnavailable: true` (thiếu sandbox — Linux cần `bubblewrap`, `socat` — thì không chạy trần), `sandbox.allowUnsandboxedCommands: false` đặt ở settings người dùng/`--settings` (chặn lệnh thử lại ngoài sandbox); cache ở home (`~/.npm`, `~/.cache`) phải khai thêm vào `allowWrite`. Khung không bật mặc định (ADR-0040). → Kiểm: `xt.py doctor` nhóm `sandbox` (máy — T-3641: không thấy sandbox nào của công cụ hay container → cảnh báo; autopilot đang chạy một phiên → lỗi; OpenCode luôn cảnh báo vì không có sandbox chính chủ; file devcontainer chỉ tính khi tiến trình chạy trong container, `.cursor/sandbox.json` không tính (chỉ cấu hình phạm vi; lệnh trong sandbox Cursor có `CURSOR_SANDBOX`); `sandbox` của `settings.local.json` đè `settings.json`; `sandbox.enabled` thiếu `failIfUnavailable: true` → cảnh báo — AUD-HAR-202/203) không còn mục; người: từ trong phiên chạy `curl` tới domain ngoài allowlist → bị chặn; ghi lệnh + output làm bằng chứng (`loop record`); thử ghi ngoài workspace → bị từ chối. · Nguồn: stored 11 §3/§3b (`anthropics/sandbox-runtime`: Seatbelt/bubblewrap, proxy allowlist)
- [ ] `LOOP-HARNESS-023` **MUST@L** **Sàn Gate theo quy mô**: ở M/L (frontmatter `scale:` của `BLUEPRINT.md`; pha `delivery_phase: build` không áp — ADR-0041, áp lại ở `harden`), `xt.yaml` khai lệnh thật — không rỗng, không no-op (`true`, `:`, `exit 0`, `echo …`) — cho (1) `format_check`: kiểm format không ghi file, đỏ khi lệch; (2) `coverage`: chạy test có ngưỡng coverage, đỏ khi dưới ngưỡng; (3) `typecheck` khi repo có `tsconfig.json`/`pyproject.toml`/`setup.cfg`, `build` khi có `go.mod`/`Cargo.toml`; (4) `e2e` khi hồ sơ web-app/mobile-app/desktop-app/static-site/game. Máy **không đoán tên công cụ** (đoán thì đỏ oan với stack lạ, lọt với cờ trùng tên): dự án khai, `xt.py loop verify` **chạy** các lệnh đó (trừ lệnh trùng Gate) — thiếu khoá hoặc lệnh đỏ thì kiểm lại cuối ĐỎ, autopilot không ra `done`; `xt.py doctor` cảnh báo `gate-floor`, `loop init` nhắc. ADR-0011 chỉ chặn cổng rỗng nên `test: pytest tests/smoke.py` vẫn "xanh" — sàn này là máy kiểm thay cho kỷ luật. Lệnh sàn chạy ở gốc dự án và không được ghi vào repo (artefact như `.coverage`, `c.out` ra `mktemp` — ghi vào cây thì `loop verify` đỏ vì cây đổi); thiếu cả `xt.yaml` ở M/L = mọi khoá đều thiếu. Máy không kiểm được ngưỡng có hợp lý không (ngưỡng 1 % vẫn qua) và chỉ bắt no-op dạng `true`/`:`/`exit 0`/`echo …`: lệnh sàn không được có `|| true` hay dạng nuốt lỗi khác — reviewer soát lệnh sàn ở PR đổi `xt.yaml`. Quy mô S hoặc không có blueprint: không áp. → Kiểm: `xt.py doctor --json` không có finding `gate-floor`; `.autopilot/verified.json` có `gate_floor: []` và `gate_floor_runs` exit 0; test `DoctorGateFloorTest`, `test_gate_floor_blocks_final_verify`. · Nguồn: ADR-0011; [`../14-testing-quality/test-strategy.md`](../14-testing-quality/test-strategy.md) `QA-STRAT-001`; [`../14-testing-quality/e2e-and-accessibility.md`](../14-testing-quality/e2e-and-accessibility.md) `QA-E2E-023` — rà 2026-10-18
- [ ] `LOOP-HARNESS-024` **SHOULD** `loop init` **không ghi đè vòng đang chạy**: `state.json` còn `active`, chưa hết vòng/hạn và đợt chưa `done`/`done-pending-human` đã kiểm lại cuối trên cây hiện tại (`loop verify --all`, LOOP-DESIGN-022; ADR-0047) → exit 2, chỉ ghi đè khi `--force` (cố ý đổi PLAN/ngân sách hoặc vòng cũ đã chết); đổi phiên vòng cũ bằng `loop attach`, mở vòng bị chặn bằng `loop unblock --reason …`; đợt đã xong → `loop init --plan PLAN-<đợt>.md` kế. Hai phiên cùng dự án từng xoá trạng thái, bằng chứng đếm vòng của nhau. → Kiểm: test `test_init_refuses_live_loop`, `test_init_after_done_starts_next_batch`, `test_loop_init_after_done_needs_final_verify`, `test_loop_init_after_budget_needs_no_verify`. · Nguồn: www-donghanhcungban-org/stored mục 01 §3h (Agent_Board: `BATON.json` ghi đè vô điều kiện, `expires_at` không kiểm — "gậy" là quy ước, không phải khoá; rà 2026-10-18)
- [ ] `LOOP-HARNESS-025` **SHOULD** `xt.py doctor` (đủ, không `loop init`) **thử guard bằng lệnh nguy hiểm mẫu** (push ép nhánh chính, `curl | sh`, tắt `core.hooksPath`, CLI agent `--yolo`) qua đúng luật của hook (chỉ phân tích, không chạy): guard có mặt, đúng cú pháp mà không chặn → lỗi `hooks`. File hook còn chưa đủ: guard hỏng giữa chừng fail-open lặng lẽ. → Kiểm: test `DoctorGuardAndClaudeVersionTest` (guard giả cho qua mọi lệnh → lỗi). · Nguồn: www-donghanhcungban-org/stored mục 03 §8b (context-mode: chạy `ctx-doctor` ngay sau cài vì hook hỏng thì plugin lặng lẽ tụt mức; rà 2026-10-18)
- [ ] `LOOP-HARNESS-026` **MAY** Dự án khai `claude_min_version` trong `xt.yaml` khi hook/quyền dựa vào tính năng theo phiên bản Claude Code; `xt.py doctor` cảnh báo khi `claude --version` thấp hơn. Tổ chức ép bằng managed settings `requiredMinimumVersion` (chỉ phạm vi Managed, Claude Code ≥ 2.1.163; bản thấp hơn thoát lúc khởi động; giá trị sai bị bỏ qua — fail open) — đặt ở `/etc/claude-code/managed-settings.json` (Linux/WSL), `/Library/Application Support/ClaudeCode/` (macOS), `C:\Program Files\ClaudeCode\` (Windows). → Kiểm: `xt.py doctor` báo `runtime` khi bản cài thấp hơn khoá. · Nguồn: https://code.claude.com/docs/en/settings-reference.md, https://code.claude.com/docs/en/managed-settings (đọc 2026-10-18); www-donghanhcungban-org/stored mục 21 §10c (playbook AI-native SDLC)
- [ ] `LOOP-HARNESS-027` **MAY** Dự án không muốn ghi công AI trong lịch sử git (luật nội bộ, repo công khai) khai `ai_attribution: forbid` trong `xt.yaml` (gần nhất từ thư mục commit đi lên, không vượt gốc repo — dự án trong monorepo `apps/web` dùng được): guard chặn `git commit` mà message — `-m`/`--message`, `--trailer`, `--author`, file của `-F`/`--file`, thân heredoc trong cùng lệnh (`-F - <<E`, `-m "$(cat <<E …)"`) — có tên model (`Claude Opus …`, `claude-sonnet-…`) hay URL/trailer phiên (`claude.ai/code/session_…`, `Claude-Session:`); cùng luật cho tiêu đề/thân PR và commit squash qua `gh pr create|edit|merge` (`--title/-t`, `--subject`, `--body/-b`, `--body-file/-F` kể cả heredoc) và tool MCP ghi PR/commit (`create_pull_request`, `update_pull_request`, `create_or_update_file`, `push_files`, `delete_file`, `merge_pull_request` — khoá đọc ở `xt.yaml` của dự án; guard không chạy được thì cho qua, D-057); trailer chung `Co-authored-by: Claude <…>` vẫn được. Repo nhận commit quyết định (`git -C khac commit` đọc `xt.yaml` của `khac`). Giới hạn (guard chỉ thấy lệnh lúc quyết định): message qua ống (`echo … | git commit -F -`), file `-F` do lệnh trước tạo, `git commit` cách heredoc hơn 4 KiB trong cùng pipeline, nháy lồng trong `$(…)`/`$'…'` trước heredoc, `git merge -m`/`git tag -m`, URL phiên do chính máy chủ MCP gắn thêm vào thân PR sau khi hook cho qua, `gh api …/pulls -f body=…` không bị bắt — CI/review là lớp sau. Tên model ở bất kỳ đâu trong message/tiêu đề/thân bị chặn, kể cả khi nhắc như tên sản phẩm — diễn đạt khác. Lịch sử đã có không viết lại; squash-merge lấy message từ commit đã sạch. → Kiểm: test `GuardAiAttributionTest` (`tests/test_hooks.py`); thân PR đã mở không có `claude.ai/code/session_`; `git log --format=%B <base>..HEAD | grep -cE "Claude-Session|claude\.ai/code/session_"` = 0. · Nguồn: repo khung AGENTS.md mục Luật bất biến và AUD-HAR-017 (trailer phiên/model lọt vào commit dù có luật — 2026-10-15, lặp lại 2026-10-18)
- [ ] `LOOP-HARNESS-028` **SHOULD** Mỗi phiên agent mang tên `<Tên repo> — <tên nhánh>`: tên repo GitHub (không kèm owner) của repo chính đang sửa; tên nhánh làm việc do agent tự đặt theo `<type>/<mô-tả-ngắn>` (type của Conventional Commits, chữ thường, gạch nối — vd `X-Templates — feat/dat-ten-phien`); đặt ngay khi đã có nhánh, đổi nhánh chính thì đổi tên phiên; phiên làm nhiều repo lấy repo đang sửa chính. Cách đặt: Claude Code `/rename`, phiên cloud tool `set_session_title`. Mục đích: danh sách phiên đọc được, biết phiên nào đang giữ nhánh/PR nào. → Kiểm: hook SessionStart in gợi ý `Tên phiên: "<repo> — <nhánh>"` (repo lấy từ remote `origin`, không có thì tên thư mục; đang ở `main` thì nhắc tạo nhánh trước) — test `test_session_start_suggests_session_name` (`tests/test_hooks.py`); tên các phiên (`list_sessions`) khớp `^\S+ — \S+$`. · Nguồn: yêu cầu chủ repo 2026-10-19
- [ ] `LOOP-HARNESS-029` **SHOULD** Tiêu đề PR và subject commit bị kiểm **lúc đặt**, không đợi CI: guard chặn `gh pr create|edit --title/-t` và tool MCP `create_pull_request`/`update_pull_request` có tiêu đề sai luật workflow `pr-title` (Conventional Commits `<type>(scope): mô tả`, ≤ 100 ký tự — `Revert "…"` của nút Revert được miễn), `git commit` (`-m`, `-F` file, heredoc) và tool MCP ghi commit có subject > 100 ký tự (chỉ độ dài: commit merge/revert của git không theo type), và subject commit squash tường minh (`gh pr merge --subject/-t`, REST/MCP `commit_title`) — subject squash do thiết lập repo `squash_merge_commit_title: PR_TITLE` (D-254). `pr_title_check: off` ở `xt.yaml` gần nhất tắt luật tiêu đề/subject lúc đặt; chặn subject merge tường minh là hàng rào merge, không tắt. Đọc cả dạng pflag (`-dt x`, `-t=x`, `-st'x'`) và alias `gh pr new`. Giới hạn: giá trị guard không đọc được lúc quyết định (`$…`, backtick, `--fill`, message qua ống) cho qua — CI `pr-title`/`merge-check` là lớp sau. → Kiểm: test `GuardTitleRuleTest` (`tests/test_hooks.py`, gồm đối chiếu luật với `xt.py pr title-check`); ca corpus `guard-har029-*`, `guard-har128-*`. · Nguồn: D-255; AUD-HAR-126 (#340: subject commit 83 ký tự lên `main`), AUD-HAR-128 (review #342)
- [ ] `LOOP-HARNESS-030` **SHOULD** Trước khi bật công cụ memory/quan sát cho coding agent, lập **bảng kênh dữ liệu rời máy** đọc từ mã và `SECURITY.md` của nó, không từ câu "lưu cục bộ" của README: telemetry (thường bật mặc định), model nén/tóm tắt nhận prompt + transcript (đường gửi và quota bị tiêu), lời mời đăng nhập dịch vụ hosted lúc cài, đồng bộ đám mây, kiểm phiên bản; cài non-interactive với provider khai tường minh, `DO_NOT_TRACK=1` (nhà của luật telemetry tắt mặc định: [`SEC-INFRA-018`](../12-security/infrastructure-and-network.md)), đồng bộ đám mây tắt; repo có dữ liệu khách hàng/bí mật chỉ dùng model nén chạy cục bộ hoặc không dùng công cụ. Context công cụ chèn lại là **lời khai** về mã cũ — kiểm bằng file hiện tại trước khi dựa vào. → Kiểm: bảng kênh rời máy trong PR/ADR thêm công cụ; env phiên có `DO_NOT_TRACK=1` và biến provider; cấu hình công cụ không bật cloud sync. · Nguồn: `www-donghanhcungban-org/stored` 10 §4e (claude-mem v15.6.0: telemetry PostHog bật mặc định; nén qua Agent SDK bằng token OAuth đọc từ keychain; installer mời đăng nhập cmem.ai, dùng thử 30 ngày)
- [ ] `LOOP-HARNESS-031` **SHOULD** Vòng autopilot chạy trong Claude Code chỉ bắt đầu khi có **bằng chứng hook của khung đã chạy trong chính phiên này** (vd hook SessionStart ghi dấu theo `session_id`), không chỉ khi file hook tồn tại: thread cloud trong Projects (một hay nhiều repo) không chạy hook, không áp permission/env của `.claude/settings.json`, không nạp skill của repo; phiên cloud nhiều repo chỉ đọc `enabledPlugins`/`extraKnownMarketplaces` — hook không được nạp nên guard và `deny` vắng mà không báo. Thiếu dấu → không bật vòng, hướng dẫn chuyển sang phiên một repo hoặc chạy trên máy (Remote Control); ngoài Claude Code → cảnh báo, không chặn. → Kiểm: test: khởi động vòng khi chưa có dấu SessionStart của `session_id` hiện tại → exit ≠ 0 kèm thông báo "hook chưa nạp"; có dấu → exit 0 (harness khung chưa có — dự án tự thêm dấu + test). · Nguồn: Claude Code docs *Claude Projects*, *Settings* §cloud, *Cloud environments*
- [ ] `LOOP-HARNESS-032` **SHOULD** Cấu hình harness của dự án đích **không rò và không tự mở rộng quyền**: `.claude/settings.local.json` (quyền `allow` và đường dẫn máy cá nhân) nằm trong `.gitignore` (`install.py` thêm dòng); settings dự án không đặt `enableAllProjectMcpServers: true` (bật mọi server của `.mcp.json` không hỏi — liệt kê `enabledMcpjsonServers`, cùng luật không tự thêm năng lực [`LOOP-STOP-023`](stop-points-and-escalation.md)); khoá `model` nếu khai thuộc họ của khung ([`LOOP-ORCH-019`](orchestration-and-subagents.md)), không ghim ID ngoài allowlist. → Kiểm: `git ls-files '*settings.local.json'` rỗng; `xt.py doctor` không có cảnh báo `orchestration` về `enableAllProjectMcpServers`/`model`/`settings.local.json` (test `test_harness_settings_mcp_all_model_and_gitignore_warn`). · Nguồn: stored 08 §2j, 09 §3b, 23 §8b (rà 2026-11-01, `stored§XT-H-021`); Claude Code docs *Settings* (`enableAllProjectMcpServers`, `enabledMcpjsonServers`)

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
| Harness dựa vào plugin bật bằng `enabledPlugins` | Phiên Claude Code on the web không cài plugin repo bật (kể cả `extraKnownMarketplaces`), không có `/plugin` — hook/skill của plugin vắng mà không báo | Vendor phần cần vào `.claude/` của repo có lock ([`SEC-SUPPLY-016`](../12-security/supply-chain.md)); `.claude/settings.json` của repo (hook, permission) chỉ được đọc ở phiên cloud **một repo**; phiên nhiều repo chỉ đọc `enabledPlugins` (plugin khai ở đó vẫn không nạp), thread trong Projects không đọc — guard vắng mà không báo (`LOOP-HARNESS-031`; docs *Cloud environments*, *Claude Projects*, xác minh 2026-10-30) |
| Coi hook guard là sandbox | Tiến trình con, script tạm, `curl` ra mạng đi ngoài tầm hook | Sandbox OS hoặc devcontainer/VM có egress allowlist; thử `curl` ngoài allowlist phải bị chặn (`LOOP-HARNESS-022`) |
| Không dựng được sandbox thì chạy tiếp ở chế độ mở | Chạy trần trên host, secret và mạng lộ hết | Fail-closed: từ chối chạy (vd `sandbox.failIfUnavailable: true`); thao tác "floor" không mode auto-approve nào hạ được (docs Claude Code *Settings*, *Permission modes*, tra 2026-11-04); ghi mức enforcement và provenance quyết định (auto/user/denied + lý do) vào audit từng tool-call (chưa xác minh) |

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Audit khung | `xt.py doctor --fix` | Đầu mỗi `/autopilot`, `/complete`; `loop init` chạy phần nhanh | 0 lỗi ✗; cảnh báo `gate-floor` thành task PLAN (`LOOP-HARNESS-023`) |
| Parser PLAN | `xt.py loop status --json` | SessionStart, CI | Không `blocked` vì PLAN |
| Định dạng PROGRESS | `xt.py progress-check` (≤ 8192 byte, 4 mục) | pre-commit, CI | exit 0 |
| Tươi SHA | `xt.py progress-check` (bên trong: `git merge-base --is-ancestor <SHA> HEAD` và nhánh chính cho mọi SHA ở Bàn giao) | thêm vào `lint` trong `xt.yaml` + CI | exit 0 |
| Blueprint | `xt.py blueprint-status BLUEPRINT.md --strict --run` | Cổng phát hành G7 (dự án tự thêm vào CI khi phát hành) | 0 MUST mở, 0 lệnh `— Kiểm:` đỏ |
| Hợp đồng repo | `xt.py validate` (quy ước khung) | pre-commit + CI | 0 lỗi |
| Hook | `bash -n .claude/hooks/*.sh && python3 -m unittest discover -s tests` | CI | xanh |
| Sandbox phiên | `curl` tới domain ngoài allowlist từ trong phiên autopilot | Trước khi bật chạy không người trực | bị chặn; có evidence |

## Nguồn

- `scripts/xt.py` (`TASK_RE`, `GATE_RE`, `parse_plan`, `read_evidence`, `write_state`, `project_dir`) và `.claude/hooks/session-start.sh`, `.gitignore` của khung — đọc 2026-10-13.
- Claude Code docs — memory/CLAUDE.md và `AGENTS.md` (chỉ đọc khi không có CLAUDE.md; import `@file`): <https://code.claude.com/docs/en/memory> — theo `research/2026-10-13-claude-code-hooks-skills.md` (xác minh 2026-10-13).
- AGENTS.md (quy ước, không phải schema; >60k dự án; Agentic AI Foundation): <https://agents.md/> — xác minh 2026-10-13.
- Anthropic, *Effective harnesses for long-running agents* (feature list JSON chỉ sửa `passes`, `claude-progress.txt`, `init.sh`): <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents> — theo research [F].
- `www-donghanhcungban-org/stored` mục 21 §2, §8 điểm 9; mục 23 §2.1, §2.4, §3.3, §4.5 (`runtime.yaml`, `check_status_freshness`, `validate_repo`, TRAPS) — đọc 2026-10-13.
- Catalog `www-donghanhcungban-org/stored` 10 §4b (agentmemory: bind loopback, lọc bí mật, nên giữ vai tra cứu) — đọc 2026-10-15.
- Catalog `www-donghanhcungban-org/stored` 10 §4e (claude-mem: kênh dữ liệu rời máy theo `SECURITY.md` + mã telemetry; File Read Gate có eval bật/tắt) — đọc 2026-10-30.
- Catalog `www-donghanhcungban-org/stored` 10 §4c (engram: một binary Go + SQLite FTS5; hook lưu nguyên văn prompt, chèn chỉ thị mỗi lượt; Git Sync ghi `.engram/` vào repo; thẻ `<private>` lọc ở plugin và store) — đọc 2026-10-16.
- Catalog `www-donghanhcungban-org/stored` mục 11 §3b (`anthropics/sandbox-runtime`, trước ở anthropic-experimental, 5,5k★, Apache-2.0: sandbox mức hệ điều hành không cần container — Seatbelt trên macOS, bubblewrap trên Linux; mạng chặn mặc định, chỉ mở domain allowlist qua proxy; beta research preview, định dạng config có thể đổi) và §3 — đọc 2026-10-16; tên khoá settings sandbox của Claude Code (chưa xác minh).
- Claude Code docs — *Cloud environments* §What carries over (phiên cloud không cài plugin repo bật qua `enabledPlugins`/`extraKnownMarketplaces`, không có `/plugin`): <https://code.claude.com/docs/en/cloud-environments> — xác minh 2026-10-30.
- Cloud threads trong Projects nạp CLAUDE.md của mỗi repo nhưng không nạp skills, `.mcp.json`, `.claude/settings.json` (một hay nhiều repo): permission rules không áp, hooks không chạy, env không áp; muốn dùng hook thì chạy thread trên máy mình (`LOOP-HARNESS-031`): <https://code.claude.com/docs/en/claude-projects> — xác minh 2026-10-30.
- Phiên cloud nhiều repo (Anthropic-hosted) khởi động phía trên các clone, chỉ đọc `enabledPlugins`/`extraKnownMarketplaces` từ `.claude/settings.json` của mỗi repo, không đọc permission rules, hooks, env (`LOOP-HARNESS-031`): <https://code.claude.com/docs/en/settings> — xác minh 2026-10-30.
- Hooks và permission rules trong `.claude/settings.json` của repo được nạp 'Yes, in a session with one repository' (`LOOP-HARNESS-031`): <https://code.claude.com/docs/en/cloud-environments> — xác minh 2026-10-30.
