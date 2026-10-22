---
title: File harness: PLAN · PROGRESS · BLUEPRINT · evidence · state
kind: module
prefix: LOOP-HARNESS
applies_to: [all]
updated: 2026-10-22
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
| `.autopilot/state.json` | `active, plan, blueprint, scope, max_iterations, iterations, deadline, same_failure_count, last_failure_signature, blocked` (`scope` = blueprint/profile/scale/rev/gate_floor khoá lúc `loop init`: blueprint mất/hỏng/đổi quy mô → `verify`, sàn Gate đọc từ đây) | `xt.py loop` (ghi atomic qua `.tmp`) | **Không** (gitignore, theo máy) | `loop status` |
| `.autopilot/evidence/T-NNN.json` | `task, cmd, cmd_sha256, exit_code, started, finished, head, output_tail` (40 dòng; `zero_tests_red: true` khi Gate exit 0 mà `Ran 0 tests`) | `xt.py loop record` | Không (bằng chứng cục bộ); bằng chứng chia sẻ = link CI/PR | `loop_verdict` so `cmd_sha256` rồi dạng chuẩn của `cmd` với Gate (nháy có nghĩa, chỉ khoảng trắng ngoài nháy tự do) |
| `xt.yaml` | Khoá `format · lint · typecheck · test · build · format_file` (dev-task chạy; `gate-fast` thêm `format_check · test_fast`, chọn bằng `commit_gate`) + khoá khai báo khác (`install`, `dev`, `e2e`, `format_check`, `coverage`, `migrate`, `init`, `smoke`, `audit`…) cho agent đọc | Người/agent ở G5 | Có | `dev-task.sh gate` đọc được (xem `LOOP-HARNESS-008`) |
| `AGENTS.md` (+ `CLAUDE.md` chứa `@AGENTS.md`) | Luật agent, lệnh, cấu trúc, điểm dừng | Người | Có | Script so bản gốc trong `docs/agents/` ([`XC-DOCAI-007`](../18-cross-cutting/docs-for-ai-agents.md)) |
| `.claude/settings.json` + `.claude/hooks/*.sh` | Quyền allow/ask/deny, 4 hook | Người; agent sửa được (ADR-0018 — `strict` thì `ask`), nêu lý do ở commit/PR, tắt/bỏ qua hook bị deny | Có | `bash -n`, test hook |
| `docs/adr/`, `docs/SPEC-*.md`, `THREAT-MODEL.md` | Quyết định, đặc tả, mối đe doạ | Agent soạn, người duyệt | Có | Link từ PR `feat:` |
| `TRAPS.md` (tuỳ chọn) | Bẫy đã mắc thật: triệu chứng → cách rà → chốt chặn → ngày/PR | Agent sau mỗi lỗi lặp | Có | Mỗi `fix:` lặp lại phải trỏ TRAPS |

### Giới hạn đã biết của guard và hook

Hook là lớp chặn sai lầm bằng phân tích tĩnh, không phải ranh giới cách ly (D-015). Lớp đỡ cho các chỗ dưới đây là sandbox
OS/devcontainer có egress allowlist (`LOOP-HARNESS-022`) và việc phiên chính chạy lại Gate (`loop record`):

- **Guard không xét gửi bí mật ra mạng bằng thư viện của trình thông dịch** (AUD-SEC-086): luật "gửi file bí mật/biến môi
  trường ra mạng" chỉ nhận CLI (`curl`/`wget`, `scp`/`rsync`, `nc`/`socat`/`ssh`, `gh gist|release upload`) và `/dev/tcp`.
  `python3 -c` dùng `urllib`/`http.client`/`socket`, `node -e` dùng `fetch`/`http`/`net` gửi bí mật đi thì không bị xét
  như gửi ra mạng; script có chuỗi bí mật nguyên văn (`open('.env')`) bị chặn theo D-105 (không chỉ đọc) — còn hở khi bí
  mật lấy từ biến môi trường (`os.environ`, `process.env`) hay đường dẫn ghép (AUD-DOC-073). Không để bí mật thật trong
  máy/biến môi trường của phiên agent không người trực.
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
  không được bóc để trích script; lồng hơn 8 lớp lệnh chạy hộ cũng không; đích `rm -rf` là thay thế lệnh khác `$(pwd)` (`$(pwd -P)/..`,
  `$(dirname $PWD)`, `$(realpath ..)`) là không rõ nên cho qua — D-051 (AUD-SEC-101).
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
- **Thư mục không biết** (D-106): sau `cd "$X"`, `cd -`, `pushd +N`, `popd`, `cd` khi có `CDPATH`, `cd`/`pushd` tới
  toán hạng có glob (`cd .cl*`), đích ghi tương đối được thử ở gốc và mọi thư mục canh (`.claude`, `.claude/hooks`,
  `.autopilot`, `.git`, `.git/hooks`) — chặn khi file đã có ở đó hoặc tên là tên được canh (chặn oan: `cd "$X" && echo
  x > config` dù `$X` không phải `.git`). `env -C DIR`/`--chdir=DIR` dời thư mục của lệnh sau `env` như `cd` (kèm chuyển
  hướng thì thư mục là không biết; tuỳ chọn dài viết tắt duy nhất như `--ch=DIR` cũng tính); `dd of=<đích>`, lệnh chỉ
  gồm chuyển hướng (`exec 3> .env`) và chuyển hướng đọc-ghi `<>` (`exec 3<> .env`) là ghi.
- **Hook `TaskCompleted` chỉ chạy khi phiên có tool Task** (AUTO-02, D-068): `TaskCreate`/`TaskUpdate` không bật mặc định
  trên Opus 5.5/Sonnet 5.5/Haiku 5.5/Fable ở CLI — cần `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` hoặc nêu tool trong
  `--allowedTools`; phiên nền và phiên cloud luôn có. Thiếu tool thì không có sự kiện `TaskCompleted`, hook không bao giờ
  kích hoạt và cổng bằng chứng mức task im lặng; lớp đỡ vẫn là `loop record` + Stop hook. Nguồn: Claude Code docs
  tools-reference <https://code.claude.com/docs/en/tools-reference.md>, đọc 2026-10-21
  (`research/2026-10-21-next-level-speed-automation-quality.md` §4.1).

### Khoá của `xt.yaml` (nhà — mẫu: [`../templates/xt.yaml`](../templates/xt.yaml) chỉ còn một dòng chú thích mỗi khoá)

YAML phẳng `khoá: lệnh`; `""` = không có, thiếu khoá = tự dò từ manifest; chú thích sau `#` ngoài nháy bị bỏ. Hai nhóm:

| Khoá | Ai chạy | Ý nghĩa |
|---|---|---|
| `lint` · `typecheck` · `test` · `build` | `dev-task.sh gate` (= CI) | Cổng đầy đủ theo thứ tự build → typecheck → lint → test; `lint` nên gồm kiểm format. Autopilot đang chạy mà `lint`/`test` rỗng hay no-op (`true`, `:`, `exit 0`, `echo …`) = cổng **đỏ** (ADR-0011); CI mẫu đỏ tới khi có lệnh thật (D-096). Ở M/L còn sàn `LOOP-HARNESS-023` |
| `format` · `format_file` | `dev-task.sh format` · hook PostToolUse | Format cả repo · format MỘT file (`{}` = đường dẫn); `format_file` trống → mẫu dựng sẵn (prettier/ruff/black/gofmt/rustfmt), không qua guard; lệnh khai báo qua guard (LOOP-STOP-027) |
| `format_check` · `coverage` | `loop verify` (sàn M/L) | Kiểm format không ghi file; test có ngưỡng coverage — artefact ra `mktemp`, không `\|\| true` |
| `commit_gate` · `test_fast` | hook trước `git commit` | `fast` (mặc định dự án mới) = `gate-fast` (format_check → lint → typecheck → `test_fast` với `XT_CHANGED_FILES`, trống → `test`); `full`/vắng = `gate`. Diff đụng cấu hình cổng (xt.yaml, xt.py, dev-task.sh, hook, ruff/coverage/requirements) → mọi lớp test qua `test_list`/`test_unit` không coverage, chưa khai hai khoá đó → `test` (D-112). Giá trị khác `fast`/`full` → `doctor` (lỗi `xt-yaml`) và `ci-check` từ chối |
| `setup` · `test_list` · `test_unit` · `test_combine` · `test_weights` | `setup`: CI mẫu (`install.py --with-github`); bốn khoá chia test: `dev-task.sh test-shard`/`test-combine`, `gate-fast` khi diff đụng cấu hình cổng, CI tự tách test thành shard | `setup` cài phụ thuộc mỗi job CI. CI mẫu 3 job (ADR-0039) không chia shard: job `gate` chạy `dev-task.sh gate-par` (typecheck ∥ lint ∥ build → test song song trong job, D-128) nên ngưỡng coverage nằm trong `test`. Chia shard — chỉ khi đo thấy test là đường dài nhất — cần đủ `test_list` (mỗi dòng một id), `test_unit` (chạy `"$1"`, coverage vào `"$XT_COV_DIR"` nếu có), `test_combine` (gộp, đòi ngưỡng); `test_weights` = file trọng số LPT (`dev-task.sh test-weights`) |
| `merge_autonomy` · `merge_risk_paths` · `merge_hard_exceptions` · `delivery_phase` · `pr_title_check` | `merge-check`/`pr next`/guard — đọc ở **nhánh đích đã commit** (PR không tự đổi luật cho mình) | L3 (mặc định) máy merge ghim head theo làn (ADR-0015, ADR-0036), L2 chỉ làn nhanh, L1 người merge · glob thêm vào đường dẫn nhạy cảm (hợp của cây làm việc và nhánh đích) · `human` người merge ngoại lệ cứng (ADR-0016), `auto` máy merge khi CI xanh (ADR-0020; PR đổi khoá này luôn người merge) · `build` PR làn chuẩn chỉ cần CI xanh, review ghi nợ, `harden`/vắng cần review sạch ở head (ADR-0031; có hiệu lực khi cả nhánh đích lẫn cây làm việc đều `build`; trước G7 đặt `harden`) · `off` tắt kiểm tiêu đề PR Conventional Commits |
| `review_identity` · `author_model_family` · `reviewer_model_family` | `merge-check`, `ci-check` (T-1508) | Chỉ dấu review của đúng tài khoản mở được merge; hai họ model khai cùng nhau phải khác nhau; `reviewer_model_family` là họ THẬT của model reviewer (workflow `pr-review` chạy model trong `XT_REVIEWER_MODEL`), không phải nhãn tuỳ ý |
| `e2e` · `e2e_setup` | `dev-task.sh e2e [I N]` — job `e2e` của CI mẫu, agent chạy tay | `e2e_setup` (cài trình duyệt) rồi `e2e` với `XT_SHARD=I/N` (mặc định `1/1`); lệnh dùng `$XT_SHARD` thì mỗi shard một phần, không thì shard 1 chạy cả suite; rỗng → bỏ qua có log (D-115, `QA-E2E-029`). Từ 3.12.0 CI chạy `e2e` (trước: chỉ agent chạy tay) — lệnh cần trình duyệt/server thì khai `e2e_setup`, chưa sẵn thì để `e2e: ""` |
| `e2e_affected` · `audit` · `migrate` · `init` · `smoke` · `install` · `dev`… | Agent đọc và chạy trực tiếp | Khai báo; `dev-task.sh` không chạy. `e2e_affected` = chỉ spec của lát đang làm (Gate mỗi task), suite đầy đủ `e2e` khi push `main`/trước phát hành (`QA-E2E-023`) |
| `attack` · `perf` | `release-check` (pha harden, ADR-0042) | Tấn công thử (DAST như ZAP baseline/API scan, fuzz API như Schemathesis, kịch bản khai thác) trên bản chạy cục bộ/staging · kiểm tải có ngưỡng (vd k6 `thresholds`) — đỏ khi có lỗ/vượt ngân sách; chưa khai ở M/L → người ký lý do |
| `claude_min_version` · `ai_attribution` | `doctor` · guard | Cảnh báo Claude Code thấp hơn (`LOOP-HARNESS-026`) · `forbid` chặn commit/PR ghi tên model hay URL phiên AI (`LOOP-HARNESS-027`) |

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
- [ ] `LOOP-HARNESS-008` **MUST** Nhà của bộ khoá `xt.yaml` (mẫu: [`../templates/xt.yaml`](../templates/xt.yaml)): khai `lint`, `test`, `typecheck`, `build` (chuỗi rỗng nếu không áp dụng); agent không suy diễn lệnh từ README. `scripts/dev-task.sh` chỉ chạy các khoá `format · lint · typecheck · test · build · format_file` (`gate` = build→typecheck→lint→test — cổng đầy đủ, CI chạy đúng lệnh này) và `format_check · test_fast` (`gate-fast` = format_check→lint→typecheck→test_fast, test liên quan file đổi qua `XT_CHANGED_FILES`, test_fast trống → `test`; hook commit chạy nó khi `commit_gate: fast`, vắng = `full` = `gate`; cổng đầy đủ chạy một lần trước khi mở PR/đẩy); `e2e`/`e2e_setup` (`dev-task.sh e2e`) do CI mẫu gọi (D-115); khoá khác (`install`, `dev`, `coverage`, `migrate`, `init`, `smoke`, `audit`…) là lệnh khai báo để agent **đọc và chạy trực tiếp**, dev-task không chạy. Khi autopilot đang chạy, `lint`/`test` rỗng hoặc no-op (`true`, `:`, `exit 0`, `echo …`) làm cổng **đỏ** (ADR-0011 của repo khung). Ở quy mô M/L cổng còn phải đạt sàn `LOOP-HARNESS-023`. → Kiểm: `scripts/dev-task.sh gate` chạy đúng lệnh khai; `xt.yaml` tồn tại ở gốc; `xt.py loop init` không in `Cổng sẽ ĐỎ`. · Nguồn: stored 23 §3.3
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
- [ ] `LOOP-HARNESS-020` **SHOULD** Mỗi lần chạy autopilot bắt đầu bằng audit khung đã cài và sửa phần an toàn trước khi lập kế hoạch: hook bắt buộc (SessionStart · PreCompact · PreToolUse · Stop) có trong settings và file hook (kể cả file chúng nạp) tồn tại, đúng cú pháp; `CLAUDE.md` import `AGENTS.md`; `xt.yaml` đủ khoá; `.autopilot/` bị gitignore; state không hỏng; khung `validate` xanh; bản khung đã cài (`.xtemplates/VERSION`) không cũ hơn tag phát hành `vX.Y.Z` mới nhất của repo khung (đọc qua `gh api`, fail-open khi không có `gh`/mạng; cũ → cảnh báo chạy lại `install.py`). Hook thiếu fail-open nên **không tự lộ** — chỉ máy kiểm mới thấy. Sửa tự động chỉ phần đảo ngược được; hook/settings là điểm dừng, để người cài lại. → Kiểm: `xt.py doctor --fix` exit 0 trước `loop init` (`loop init` cảnh báo trên stderr khi còn lỗi). · Nguồn: `scripts/xt.py` (`doctor_findings`), `.claude/hooks/_lib.sh` (fail-open) — đọc 2026-10-15
- [ ] `LOOP-HARNESS-021` **SHOULD** Bổ sung cho `LOOP-HARNESS-019` khi dùng công cụ memory ngoài: (1) chỉ bật **một** công cụ (engram, claude-mem, agentmemory… cùng hook SessionStart/UserPromptSubmit và cùng chèn context mỗi lượt); (2) kho memory nằm **ngoài repo**, quyền chỉ chủ sở hữu, coi là dữ liệu nhạy cảm vì có công cụ lưu **nguyên văn prompt**; nội dung nhạy cảm bọc thẻ loại trừ của công cụ (vd `<private>…</private>`); (3) tính năng đồng bộ memory **vào repo** (vd `engram sync` ghi `.engram/`) tắt ở repo công khai, ở repo riêng thì thư mục đó phải qua quét bí mật trước commit. → Kiểm: `xt.py doctor` không có cảnh báo `memory` (đếm công cụ memory theo tên trong `enabledPlugins` cấp người dùng/dự án/cục bộ và MCP server ở `~/.claude.json` + `.mcp.json`, ≤ 1; `.engram/` không nằm trong git); `stat -c %a` thư mục kho memory = `700`; repo riêng: gitleaks quét `.engram/` = 0 phát hiện. · Nguồn: `seeker19110/stored` 10 §4c (engram: hook lưu prompt cục bộ và chèn chỉ thị mỗi lượt, Git Sync ghi `.engram/` vào repo, `<private>` lọc hai tầng)
- [ ] `LOOP-HARNESS-022` **SHOULD** Phiên autopilot không người trực chạy trong sandbox mức hệ điều hành của host (ghi giới hạn trong workspace, mạng chặn mặc định + allowlist registry/git) hoặc trong devcontainer/VM có egress allowlist; guard hook không phải sandbox (chỉ thấy lệnh qua tool, không chặn tiến trình con hay mạng). Nâng thành **MUST@L** khi phiên chạy không người trực với quyền ghi và mạng. Claude Code (đọc 2026-10-22, <https://code.claude.com/docs/en/sandboxing>): `sandbox.enabled` (ghi chỉ trong thư mục làm việc + `$TMPDIR` + `sandbox.filesystem.allowWrite`), `sandbox.network.allowedDomains`, `sandbox.failIfUnavailable: true` (thiếu sandbox — Linux cần `bubblewrap`, `socat` — thì không chạy trần), `sandbox.allowUnsandboxedCommands: false` đặt ở settings người dùng/`--settings` (chặn lệnh thử lại ngoài sandbox); cache ở home (`~/.npm`, `~/.cache`) phải khai thêm vào `allowWrite`. Khung không bật mặc định (ADR-0040). → Kiểm: từ trong phiên chạy `curl` tới domain ngoài allowlist → bị chặn; ghi lệnh + output làm bằng chứng (`loop record`); thử ghi ngoài workspace → bị từ chối. · Nguồn: stored 11 §3/§3b (`anthropics/sandbox-runtime`: Seatbelt/bubblewrap, proxy allowlist)
- [ ] `LOOP-HARNESS-023` **MUST@L** **Sàn Gate theo quy mô**: ở M/L (frontmatter `scale:` của `BLUEPRINT.md`; pha `delivery_phase: build` không áp — ADR-0041, áp lại ở `harden`), `xt.yaml` khai lệnh thật — không rỗng, không no-op (`true`, `:`, `exit 0`, `echo …`) — cho (1) `format_check`: kiểm format không ghi file, đỏ khi lệch; (2) `coverage`: chạy test có ngưỡng coverage, đỏ khi dưới ngưỡng; (3) `typecheck` khi repo có `tsconfig.json`/`pyproject.toml`/`setup.cfg`, `build` khi có `go.mod`/`Cargo.toml`; (4) `e2e` khi hồ sơ web-app/mobile-app/desktop-app/static-site/game. Máy **không đoán tên công cụ** (đoán thì đỏ oan với stack lạ, lọt với cờ trùng tên): dự án khai, `xt.py loop verify` **chạy** các lệnh đó (trừ lệnh trùng Gate) — thiếu khoá hoặc lệnh đỏ thì kiểm lại cuối ĐỎ, autopilot không ra `done`; `xt.py doctor` cảnh báo `gate-floor`, `loop init` nhắc. ADR-0011 chỉ chặn cổng rỗng nên `test: pytest tests/smoke.py` vẫn "xanh" — sàn này là máy kiểm thay cho kỷ luật. Lệnh sàn chạy ở gốc dự án và không được ghi vào repo (artefact như `.coverage`, `c.out` ra `mktemp` — ghi vào cây thì `loop verify` đỏ vì cây đổi); thiếu cả `xt.yaml` ở M/L = mọi khoá đều thiếu. Máy không kiểm được ngưỡng có hợp lý không (ngưỡng 1 % vẫn qua) và chỉ bắt no-op dạng `true`/`:`/`exit 0`/`echo …`: lệnh sàn không được có `|| true` hay dạng nuốt lỗi khác — reviewer soát lệnh sàn ở PR đổi `xt.yaml`. Quy mô S hoặc không có blueprint: không áp. → Kiểm: `xt.py doctor --json` không có finding `gate-floor`; `.autopilot/verified.json` có `gate_floor: []` và `gate_floor_runs` exit 0; test `DoctorGateFloorTest`, `test_gate_floor_blocks_final_verify`. · Nguồn: ADR-0011; [`../14-testing-quality/test-strategy.md`](../14-testing-quality/test-strategy.md) `QA-STRAT-001`; [`../14-testing-quality/e2e-and-accessibility.md`](../14-testing-quality/e2e-and-accessibility.md) `QA-E2E-023` — rà 2026-10-18
- [ ] `LOOP-HARNESS-024` **SHOULD** `loop init` **không ghi đè vòng đang chạy**: `state.json` còn `active` và chưa hết vòng/hạn → exit 2, chỉ ghi đè khi `--force` (cố ý đổi PLAN/ngân sách hoặc vòng cũ đã chết); tiếp vòng cũ bằng `loop resume`. Hai phiên cùng dự án từng xoá trạng thái, bằng chứng đếm vòng của nhau. → Kiểm: test `test_init_refuses_live_loop`. · Nguồn: seeker19110/stored mục 01 §3h (Agent_Board: `BATON.json` ghi đè vô điều kiện, `expires_at` không kiểm — "gậy" là quy ước, không phải khoá; rà 2026-10-18)
- [ ] `LOOP-HARNESS-025` **SHOULD** `xt.py doctor` (đủ, không `loop init`) **thử guard bằng lệnh nguy hiểm mẫu** (push ép nhánh chính, `curl | sh`, tắt `core.hooksPath`, CLI agent `--yolo`) qua đúng luật của hook (chỉ phân tích, không chạy): guard có mặt, đúng cú pháp mà không chặn → lỗi `hooks`. File hook còn chưa đủ: guard hỏng giữa chừng fail-open lặng lẽ. → Kiểm: test `DoctorGuardAndClaudeVersionTest` (guard giả cho qua mọi lệnh → lỗi). · Nguồn: seeker19110/stored mục 03 §8b (context-mode: chạy `ctx-doctor` ngay sau cài vì hook hỏng thì plugin lặng lẽ tụt mức; rà 2026-10-18)
- [ ] `LOOP-HARNESS-026` **MAY** Dự án khai `claude_min_version` trong `xt.yaml` khi hook/quyền dựa vào tính năng theo phiên bản Claude Code; `xt.py doctor` cảnh báo khi `claude --version` thấp hơn. Tổ chức ép bằng managed settings `requiredMinimumVersion` (chỉ phạm vi Managed, Claude Code ≥ 2.1.163; bản thấp hơn thoát lúc khởi động; giá trị sai bị bỏ qua — fail open) — đặt ở `/etc/claude-code/managed-settings.json` (Linux/WSL), `/Library/Application Support/ClaudeCode/` (macOS), `C:\Program Files\ClaudeCode\` (Windows). → Kiểm: `xt.py doctor` báo `runtime` khi bản cài thấp hơn khoá. · Nguồn: https://code.claude.com/docs/en/settings-reference.md, https://code.claude.com/docs/en/managed-settings (đọc 2026-10-18); seeker19110/stored mục 21 §10c (playbook AI-native SDLC)
- [ ] `LOOP-HARNESS-027` **MAY** Dự án không muốn ghi công AI trong lịch sử git (luật nội bộ, repo công khai) khai `ai_attribution: forbid` trong `xt.yaml` (gần nhất từ thư mục commit đi lên, không vượt gốc repo — dự án trong monorepo `apps/web` dùng được): guard chặn `git commit` mà message — `-m`/`--message`, `--trailer`, `--author`, file của `-F`/`--file`, thân heredoc trong cùng lệnh (`-F - <<E`, `-m "$(cat <<E …)"`) — có tên model (`Claude Opus …`, `claude-sonnet-…`) hay URL/trailer phiên (`claude.ai/code/session_…`, `Claude-Session:`); cùng luật cho tiêu đề/thân PR và commit squash qua `gh pr create|edit|merge` (`--title/-t`, `--subject`, `--body/-b`, `--body-file/-F` kể cả heredoc) và tool MCP ghi PR/commit (`create_pull_request`, `update_pull_request`, `create_or_update_file`, `push_files`, `delete_file`, `merge_pull_request` — khoá đọc ở `xt.yaml` của dự án; guard không chạy được thì cho qua, D-057); trailer chung `Co-authored-by: Claude <…>` vẫn được. Repo nhận commit quyết định (`git -C khac commit` đọc `xt.yaml` của `khac`). Giới hạn (guard chỉ thấy lệnh lúc quyết định): message qua ống (`echo … | git commit -F -`), file `-F` do lệnh trước tạo, `git commit` cách heredoc hơn 4 KiB trong cùng pipeline, nháy lồng trong `$(…)`/`$'…'` trước heredoc, `git merge -m`/`git tag -m`, URL phiên do chính máy chủ MCP gắn thêm vào thân PR sau khi hook cho qua, `gh api …/pulls -f body=…` không bị bắt — CI/review là lớp sau. Tên model ở bất kỳ đâu trong message/tiêu đề/thân bị chặn, kể cả khi nhắc như tên sản phẩm — diễn đạt khác. Lịch sử đã có không viết lại; squash-merge lấy message từ commit đã sạch. → Kiểm: test `GuardAiAttributionTest` (`tests/test_hooks.py`); thân PR đã mở không có `claude.ai/code/session_`; `git log --format=%B <base>..HEAD | grep -cE "Claude-Session|claude\.ai/code/session_"` = 0. · Nguồn: repo khung AGENTS.md mục Luật bất biến và AUD-HAR-017 (trailer phiên/model lọt vào commit dù có luật — 2026-10-15, lặp lại 2026-10-18)
- [ ] `LOOP-HARNESS-028` **SHOULD** Mỗi phiên agent mang tên `<Tên repo> — <tên nhánh>`: tên repo GitHub (không kèm owner) của repo chính đang sửa; tên nhánh làm việc do agent tự đặt theo `<type>/<mô-tả-ngắn>` (type của Conventional Commits, chữ thường, gạch nối — vd `X-Templates — feat/dat-ten-phien`); đặt ngay khi đã có nhánh, đổi nhánh chính thì đổi tên phiên; phiên làm nhiều repo lấy repo đang sửa chính. Cách đặt: Claude Code `/rename`, phiên cloud tool `set_session_title`. Mục đích: danh sách phiên đọc được, biết phiên nào đang giữ nhánh/PR nào. → Kiểm: hook SessionStart in gợi ý `Tên phiên: "<repo> — <nhánh>"` (repo lấy từ remote `origin`, không có thì tên thư mục; đang ở `main` thì nhắc tạo nhánh trước) — test `test_session_start_suggests_session_name` (`tests/test_hooks.py`); tên các phiên (`list_sessions`) khớp `^\S+ — \S+$`. · Nguồn: yêu cầu chủ repo 2026-10-19

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
| Audit khung | `xt.py doctor --fix` | Đầu mỗi `/autopilot`; `loop init` chạy phần nhanh | 0 lỗi ✗; cảnh báo `gate-floor` thành task PLAN (`LOOP-HARNESS-023`) |
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
- `seeker19110/stored` mục 21 §2, §8 điểm 9; mục 23 §2.1, §2.4, §3.3, §4.5 (`runtime.yaml`, `check_status_freshness`, `validate_repo`, TRAPS) — đọc 2026-10-13.
- Catalog `seeker19110/stored` 10 §4b (agentmemory: bind loopback, lọc bí mật, nên giữ vai tra cứu) — đọc 2026-10-15.
- Catalog `seeker19110/stored` 10 §4c (engram: một binary Go + SQLite FTS5; hook lưu nguyên văn prompt, chèn chỉ thị mỗi lượt; Git Sync ghi `.engram/` vào repo; thẻ `<private>` lọc ở plugin và store) — đọc 2026-10-16.
- Catalog `seeker19110/stored` mục 11 §3b (`anthropics/sandbox-runtime`, trước ở anthropic-experimental, 5,5k★, Apache-2.0: sandbox mức hệ điều hành không cần container — Seatbelt trên macOS, bubblewrap trên Linux; mạng chặn mặc định, chỉ mở domain allowlist qua proxy; beta research preview, định dạng config có thể đổi) và §3 — đọc 2026-10-16; tên khoá settings sandbox của Claude Code (chưa xác minh).
