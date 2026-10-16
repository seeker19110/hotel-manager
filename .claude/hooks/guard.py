#!/usr/bin/env python3
"""guard.py — phân tích lệnh/đường dẫn cho hook PreToolUse của khung X-Templates (chỉ thư viện chuẩn).

Dùng (payload JSON của Claude Code trên stdin, kết quả JSON trên stdout):
  guard.py bash   → {"decision": "deny"|"ask"|"", "reason": "...", "commit": true|false, "no_verify": true|false,
                     "commit_dir": "<thư mục git commit chạy, rỗng nếu không biết>"}
  guard.py edit   → {"decision": "deny"|"ask"|"", "reason": "..."}  (file bí mật/cổng/migration; test ĐÃ CÓ bị làm yếu)

Vì sao Python thay regex trong bash (audit 2026-10-14, AUD-SEC-001…010):
- tách lệnh theo token shell (`shlex`): `|`/`;` trong nháy không phải ranh giới, thân heredoc là dữ liệu;
- chuẩn hoá trước khi so luật: bỏ gán biến đầu lệnh, `command`/`env`/`nohup`/`time`, tuỳ chọn toàn cục của git (`-C`, `-c`, …);
- đọc payload qua stdin, không qua argv (lệnh rất dài không còn làm hook lỗi rồi cho qua).
Hàng rào này chống TAI NẠN (agent gõ nhầm), không phải sandbox: lệnh cố ý né (eval chuỗi ghép, base64…) không nằm trong phạm vi.
Lỗi bất ngờ → in quyết định rỗng (fail-open về luồng); luật deny là fail-closed về hành động đã nhận ra.
"""

from __future__ import annotations

import json
import os
import posixpath
import re
import shlex
import subprocess
import sys
from typing import Callable, Dict, List, Optional, Set, Tuple

WRAPPERS = {"command", "builtin", "exec", "nohup", "time", "nice", "stdbuf", "xargs", "timeout", "setsid"}
# Tuỳ chọn của wrapper ăn thêm một token giá trị (`nice -n 5`) — không bóc thì giá trị bị hiểu là tên lệnh (AUD-SEC-011).
WRAPPER_OPTS_WITH_VALUE: Dict[str, Set[str]] = {
    "nice": {"-n", "--adjustment"},
    "stdbuf": {"-i", "-o", "-e", "--input", "--output", "--error"},
    "xargs": {"-n", "-I", "-L", "-P", "-d", "-s", "-E", "-a", "--max-args", "--max-procs", "--delimiter", "--max-chars"}
    | {"--arg-file"},  # `--replace`/`--eof`/`--max-lines`: giá trị chỉ đi dạng `--opt=v`, token sau là lệnh
    "time": {"-f", "-o", "--format", "--output"},
    "timeout": {"-s", "-k", "--signal", "--kill-after"},
}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "fish"}
INTERPRETERS = SHELLS | {"python", "python3", "node", "perl", "ruby", "php", "deno", "bun", "pwsh"}
FETCHERS = {"curl", "wget"}
MAIN_BRANCHES = {"main", "master"}
GIT_OPTS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}
DANGEROUS_RM_TARGETS = {"/", "~", "$HOME", "${HOME}", ".", "..", "*", "/*", "~/*", ".*"}

# Đường dẫn được bảo vệ (dùng chung cho Edit/Write và cho lệnh Bash ghi file).
SECRET_PATTERNS = (
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "secrets/*",
    "*id_rsa*",
    "*id_ed25519*",
    ".envrc",
    ".npmrc",
    ".pypirc",
    ".netrc",
)
GATE_PATTERNS = (
    ".github/workflows/*",
    ".github/rulesets/*",
    ".github/dependabot.yml",
    ".gitlab-ci.yml",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/hooks/*",
    ".xtemplates/*",
    "eslint.config.*",
    ".eslintrc*",
    "biome.json*",
    ".oxlintrc*",
    "tsconfig*.json",
    "jsconfig*.json",
    "vitest.config.*",
    "jest.config.*",
    "playwright.config.*",
    "lighthouserc*",
    ".lighthouserc*",
    "pyproject.toml",
    "setup.cfg",
    "mypy.ini",
    "pyrightconfig.json",
    "ruff.toml",
    ".coveragerc",
    "codecov.yml",
    ".codecov.yml",
    ".pre-commit-config.yaml",
    ".husky/*",
    "lefthook.yml",
    ".lintstagedrc*",
    "commitlint.config.*",
    "xt.yaml",
    "dev-task.sh",
    "Makefile",
    "justfile",
    ".gitleaks.toml",
    ".gitleaksignore",
    ".semgrep*",
    "sonar-project.properties",
    "requirements-dev.txt",
)
MIGRATION_RE = re.compile(r"(^|/)(migrations?|migrate)/|(^|/)db/schema\.|(^|/)prisma/schema\.prisma$")

# File test (đa ngôn ngữ). Sửa test ĐÃ CÓ theo hướng làm yếu bài kiểm = nới cổng (LOOP-CI-001): agent đang sửa lỗi
# không được làm yếu chính bài kiểm đoạn code nó sửa (Anthropic AI-native SDLC playbook 2026-08-21, stage Test).
TEST_PATTERNS = (
    "test_*.py",
    "*_test.py",
    "*_test.go",
    "*.test.*",
    "*.spec.*",
    "*_spec.rb",
    "*Test.java",
    "*Tests.java",
    "*Test.kt",
    "*Tests.cs",
    "tests/*",
    "test/*",
    "__tests__/*",
    "spec/*",
)
# Dấu bỏ qua / chỉ chạy một phần / chấp nhận đỏ / flaky: thêm mới = bớt phần được kiểm.
TEST_SKIP_RE = re.compile(
    r"\b(?:it|test|describe|context|suite)\.(?:skip|only|todo|fixme)\b"  # Jest/Vitest/Mocha/Playwright
    r"|\bx(?:it|test|describe)\s*\(|\bf(?:it|describe)\s*\("  # xit/fit của Jasmine/Jest
    r"|@pytest\.mark\.(?:skip|skipif|xfail|flaky)\b|\bpytest\.(?:skip|xfail)\s*\("
    r"|@unittest\.(?:skip\w*|expectedFailure)\b|\.skipTest\s*\("
    r"|\bt\.Skip(?:Now|f)?\s*\("  # Go
    r"|@(?:Disabled|Ignore)\b|\bSkip\s*="  # JUnit, xUnit
    r"|@flaky\b"  # nhãn flaky (QA-STRAT-009)
)
# Lời gọi kiểm: bớt đi = bài test kiểm ít hơn.
TEST_ASSERT_RE = re.compile(
    r"\bassert\w*\b|\bexpect\s*\(|\.should\b|\bt\.(?:Error|Fatal)f?\s*\(|\brequire\.\w+\s*\(|\bAssert\.\w+\s*\("
)


# --------------------------------------------------------------------------- đường dẫn


def rel_path(path: str, root: str) -> str:
    """Đường dẫn tương đối chuẩn hoá (realpath cả hai phía, bỏ ./ // ..); ngoài gốc → giữ đường dẫn chuẩn hoá."""
    p = path if os.path.isabs(path) else os.path.join(root, path)
    rp, rr = os.path.realpath(p), os.path.realpath(root)
    try:
        rel = os.path.relpath(rp, rr)
    except ValueError:
        return rp
    return rp if rel.startswith("..") else rel.replace(os.sep, "/")


def _match_any(rel: str, patterns: Tuple[str, ...]) -> bool:
    """Khớp mẫu ở gốc hoặc ở BẤT KỲ thư mục con (monorepo: frontend/tsconfig.json, packages/api/pyproject.toml)."""
    import fnmatch

    parts = rel.split("/")
    for i in range(len(parts)):
        tail = "/".join(parts[i:])
        if any(fnmatch.fnmatchcase(tail, pat) for pat in patterns):
            return True
    return False


def classify_path(rel: str) -> str:
    """'secret' | 'gate' | 'migration' | ''."""
    if _match_any(rel, SECRET_PATTERNS) and not rel.endswith((".example", ".sample", ".template")):
        return "secret"
    if _match_any(rel, GATE_PATTERNS):
        return "gate"
    if MIGRATION_RE.search(rel):
        return "migration"
    return ""


def weakens_test(old: str, new: str) -> str:
    """Lý do nếu `new` làm yếu bài test so với `old` (thêm dấu skip/only/xfail/flaky, hoặc bớt lời gọi kiểm); không thì ''."""
    if len(TEST_SKIP_RE.findall(new)) > len(TEST_SKIP_RE.findall(old)):
        return "thêm skip/only/xfail/flaky"
    if len(TEST_ASSERT_RE.findall(new)) < len(TEST_ASSERT_RE.findall(old)):
        return "bớt assertion"
    return ""


def _text(v: object) -> str:
    return v if isinstance(v, str) else ""


def _edit_texts(tool_input: Dict[str, object], full: str) -> Tuple[str, str]:
    """(trước, sau) của lần sửa: Edit `old_string`/`new_string`, MultiEdit `edits`, Write `content` (trước = file trên đĩa)."""
    edits = tool_input.get("edits")
    if isinstance(edits, list):
        pairs = [(_text(e.get("old_string")), _text(e.get("new_string"))) for e in edits if isinstance(e, dict)]
        return "\n".join(p[0] for p in pairs), "\n".join(p[1] for p in pairs)
    if "content" in tool_input:
        with open(full, encoding="utf-8", errors="replace") as f:
            return f.read(), _text(tool_input.get("content"))
    return _text(tool_input.get("old_string")), _text(tool_input.get("new_string"))


def _test_weakening(rel: str, root: str, tool_input: Optional[Dict[str, object]]) -> str:
    """Lý do nếu lần sửa làm yếu một file test ĐÃ CÓ; file mới, không phải test, không đọc được → ''."""
    full = os.path.join(root, rel)
    if not tool_input or not _match_any(rel, TEST_PATTERNS) or not os.path.isfile(full):
        return ""
    try:
        old, new = _edit_texts(tool_input, full)
    except OSError:  # fail-open: không đọc được file thì không kết luận
        return ""
    return weakens_test(old, new)


def edit_decision(path: str, root: str, tool_input: Optional[Dict[str, object]] = None) -> Tuple[str, str]:
    rel = rel_path(path, root)
    kind = classify_path(rel)
    if kind == "secret":
        return "deny", f"Không ghi file bí mật qua agent: {rel} (dùng secret manager/biến môi trường)."
    if kind == "gate":
        return (
            "ask",
            f"Sửa cấu hình cổng/CI/harness ({rel}). Khung coi đây là điểm dừng: nói rõ lý do trước khi nới hàng rào.",
        )
    if kind == "migration" and os.path.exists(os.path.join(root, rel)):
        return "ask", (
            f"Sửa migration/schema ĐÃ TỒN TẠI ({rel}). Migration đã áp không được sửa — tạo migration mới. "
            "Nếu chưa áp ở đâu, xác nhận rồi tiếp."
        )
    weak = _test_weakening(rel, root, tool_input)
    if weak:
        return "ask", (
            f"Sửa test ĐÃ CÓ theo hướng làm yếu bài kiểm ({weak}: {rel}). Khung coi đây là nới cổng (LOOP-CI-001): "
            "sửa code thay vì sửa test; chỉ sửa test khi test sai so với SPEC — nêu SPEC rồi xác nhận."
        )
    return "", ""


# --------------------------------------------------------------------------- tách lệnh


# `<<<` là here-string (không có thân, không có dấu kết) — chỉ `<<`/`<<-` đứng riêng mới là heredoc.
HEREDOC_RE = re.compile(r"(?<!<)<<(?!<)-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
# Ký tự kết thúc một từ trong bash: `#` đứng ngay sau chúng (hoặc đầu chuỗi) mới mở comment.
WORD_END = set(" \t\r\n;&|()<>")


def strip_heredocs(cmd: str) -> str:
    """Bỏ thân heredoc (dữ liệu, không phải lệnh) — giữ dòng mở heredoc."""
    lines = cmd.split("\n")
    out: List[str] = []
    pending: List[str] = []
    for line in lines:
        if pending:
            if line.strip() == pending[0]:
                pending.pop(0)
            continue
        out.append(line)
        pending = [m.group(2) for m in HEREDOC_RE.finditer(line)]
    return "\n".join(out)


def strip_comments(cmd: str) -> str:
    """Bỏ comment kiểu bash: `#` ở ĐẦU một từ (đầu chuỗi, sau khoảng trắng hoặc toán tử), ngoài nháy, tới hết dòng.
    `#` giữa từ (`${#A[@]}`, `$#`, `/#/rooms`, `a#b.ts`), trong nháy hoặc sau `\\` là chữ thường (shlex không phân biệt)."""
    out: List[str] = []
    quote, word_start, i = "", True, 0
    while i < len(cmd):
        c = cmd[i]
        if c == "#" and word_start and not quote:
            eol = cmd.find("\n", i)
            i = len(cmd) if eol < 0 else eol  # giữ `\n`: nó vẫn là ranh giới lệnh
            continue
        if c == "\\" and quote != "'" and i + 1 < len(cmd):
            out.append(cmd[i : i + 2])
            word_start, i = False, i + 2
            continue
        if quote:
            quote = "" if c == quote else quote
        elif c in "'\"":
            quote = c
        out.append(c)
        word_start = not quote and c in WORD_END
        i += 1
    return "".join(out)


def tokenize(cmd: str) -> List[str]:
    cmd = strip_heredocs(cmd.replace("\\\n", ""))
    lex = shlex.shlex(strip_comments(cmd), posix=True, punctuation_chars="();<>|&\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    lex.commenters = ""  # comment đã bỏ ở strip_comments; mặc định của shlex là "#" (mở comment cả giữa từ)
    try:
        return list(lex)
    except ValueError:  # nháy không đóng: tách thô để vẫn kiểm được (bảo thủ)
        return re.split(r"\s+|(?=[;&|\n])|(?<=[;&|\n])", cmd)


PUNCT = set("();<>|&\n")


def _is_punct(t: str) -> bool:
    return bool(t) and set(t) <= PUNCT


def _is_redirect(t: str) -> bool:
    return _is_punct(t) and ("<" in t or ">" in t) and "(" not in t and "|" not in t


def split_commands(tokens: List[str]) -> List[List[str]]:
    """Danh sách lệnh đơn (argv). `<(`/`>(`/`;`/`|`/`&&`/`(`… mở lệnh mới; chuyển hướng `>`/`<` giữ lại làm token."""
    cmds: List[List[str]] = [[]]
    for t in tokens:
        if _is_punct(t) and not _is_redirect(t):
            cmds.append([])
        else:
            cmds[-1].append(t)
    return [c for c in cmds if c]


def pipelines(tokens: List[str]) -> List[List[List[str]]]:
    """Nhóm lệnh theo ống `|` (để nhận `curl … | sh`)."""
    groups: List[List[List[str]]] = [[[]]]
    for t in tokens:
        if t in ("|", "|&"):
            groups[-1].append([])
        elif _is_punct(t) and not _is_redirect(t):
            groups.append([[]])
        else:
            groups[-1][-1].append(t)
    return [[c for c in g if c] for g in groups if any(g)]


ENV_ASSIGN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*")


def _skip_env_args(a: List[str]) -> None:
    """Sau `env`: bỏ tuỳ chọn và gán biến tại chỗ (`-u`/`-C`/`-S` kèm một giá trị)."""
    while a and (a[0].startswith("-") or "=" in a[0]):
        opt = a.pop(0)
        if opt in ("-u", "-C", "-S") and a:
            a.pop(0)


def _skip_wrapper_args(name: str, a: List[str]) -> None:
    """Sau wrapper: bỏ tuỳ chọn (kèm giá trị nếu có) và đối số thời lượng của `timeout`."""
    with_value = WRAPPER_OPTS_WITH_VALUE.get(name, set())
    while a and a[0].startswith("-") and a[0] != "-":
        opt = a.pop(0)
        if opt in with_value and a:
            a.pop(0)
    if name == "timeout" and a:
        a.pop(0)  # DURATION


def _skip_env_args_keep_assigns(a: List[str]) -> None:
    """Sau `env`: chỉ bỏ tuỳ chọn (`-u`/`-C`/`-S` kèm giá trị), giữ gán biến để còn đọc được tên biến."""
    while a and a[0].startswith("-"):
        opt = a.pop(0)
        if opt in ("-u", "-C", "-S") and a:
            a.pop(0)


def _strip_prefixes(argv: List[str]) -> List[str]:
    """Bỏ gán biến đầu lệnh và wrapper (`command`, `env -i`, `nohup`…) cho tới khi gặp lệnh thật."""
    a = list(argv)
    while a:
        head = a[0]
        if ENV_ASSIGN_RE.fullmatch(head):
            a.pop(0)
        elif posixpath.basename(head) == "env":
            a.pop(0)
            _skip_env_args(a)
        elif posixpath.basename(head) in WRAPPERS:
            a.pop(0)
            _skip_wrapper_args(posixpath.basename(head), a)
        else:
            break
    return a


def _strip_git_global_opts(a: List[str]) -> List[str]:
    """`git -C p -c k=v --no-pager sub …` → `git sub …` (tuỳ chọn có giá trị ăn thêm một token)."""
    rest = a[1:]
    i = 0
    while i < len(rest) and rest[i].startswith("-"):
        i += 2 if rest[i] in GIT_OPTS_WITH_VALUE else 1
    return ["git", *rest[i:]]


def _git_C_dirs(argv: List[str]) -> List[str]:
    """Giá trị các `-C <dir>` (tuỳ chọn toàn cục của git, theo thứ tự) — commit rơi vào repo ở đó, không phải cwd."""
    a = _strip_prefixes(argv)
    rest, dirs, i = a[1:], [], 0
    while i < len(rest) and rest[i].startswith("-"):
        if rest[i] == "-C":  # chỉ gọi khi lệnh là `git … commit`: sau `-C` luôn còn token
            dirs.append(rest[i + 1])
        i += 2 if rest[i] in GIT_OPTS_WITH_VALUE else 1
    return dirs


def _git_dir(argv: List[str], cwd: Optional[str]) -> Optional[str]:
    """Thư mục repo mà lệnh git (`git -C a -C b …`) tác động: `cwd` đi qua các `-C`; không biết (biến, `cd -`) → None."""
    gdir = cwd
    for d in _git_C_dirs(argv):
        gdir = posixpath.normpath(posixpath.join(gdir, posixpath.expanduser(d))) if gdir and "$" not in d else None
    return gdir


def _cd_target(n: List[str], cwd: Optional[str]) -> Optional[str]:
    """Thư mục sau `cd <dir>`; `cd`, `cd -`, `cd` kèm tuỳ chọn hay biến → None (không biết, hook dùng gốc dự án)."""
    args = n[1:]
    if cwd is None or len(args) != 1 or args[0].startswith("-") or "$" in args[0]:
        return None
    return posixpath.normpath(posixpath.join(cwd, posixpath.expanduser(args[0])))


def _commands_with_cwd(tokens: List[str], start: str) -> List[Tuple[List[str], Optional[str]]]:
    """Mỗi lệnh đơn kèm thư mục nó chạy: `cd`/`pushd` dời thư mục; `(`…`)` và `$(`…`)` là subshell — ra khỏi đó
    thì về thư mục cũ (`(cd ../b && git pull); git commit` vẫn commit ở chỗ cũ). `popd`/đích không rõ → None."""
    out: List[Tuple[List[str], Optional[str]]] = []
    stack: List[Optional[str]] = []
    here: Optional[str] = start
    cur: List[str] = []

    def flush() -> None:
        nonlocal here
        if cur:
            n = normalize(cur)
            if n[:1] in (["cd"], ["pushd"]):
                here = _cd_target(n, here)
            elif n[:1] == ["popd"]:
                here = None
            out.append((list(cur), here))
            cur.clear()

    for t in tokens:
        if _is_punct(t) and not _is_redirect(t):
            flush()
            stack.extend([here] * t.count("("))
            for _ in range(t.count(")")):
                here = stack.pop() if stack else None
        else:
            cur.append(t)
    flush()
    return out


def normalize(argv: List[str]) -> List[str]:
    """Bỏ gán biến đầu lệnh, wrapper (`command`, `env -i`, `nohup`…), đường dẫn của argv[0], tuỳ chọn toàn cục git."""
    a = _strip_prefixes(argv)
    if not a:
        return a
    a[0] = posixpath.basename(a[0])
    return _strip_git_global_opts(a) if a[0] == "git" else a


def _short_flags(args: List[str]) -> str:
    return "".join(x[1:] for x in args if re.fullmatch(r"-[A-Za-z]+", x))


def _positionals(args: List[str], with_value: Tuple[str, ...] = ()) -> List[str]:
    out, skip = [], False
    for x in args:
        if skip:
            skip = False
            continue
        if x in with_value:
            skip = True
            continue
        if x == "--" or x.startswith("-"):
            continue
        out.append(x)
    return out


def _rm_target(t: str) -> str:
    t = t.rstrip("/") or "/"
    return t[:-2] if t.endswith("/*") and len(t) > 2 else t


def _dangerous_rm_target(t: str) -> bool:
    """Đích `rm -rf` không được xoá: gốc/home/cwd/glob, hoặc thư mục `.git` ở bất kỳ đâu (mất toàn bộ lịch sử)."""
    r = _rm_target(t)
    return r in DANGEROUS_RM_TARGETS or posixpath.basename(r) == ".git"


# --------------------------------------------------------------------------- luật


def remote_exec(cmd: str, tokens: List[str]) -> Optional[str]:
    """curl/wget đưa thẳng vào trình thông dịch: `curl … | sh`, `sh -c "$(curl …)"`, `bash <(curl …)`."""
    for group in pipelines(tokens):
        names = [normalize(c)[0] if normalize(c) else "" for c in group]
        for i, name in enumerate(names):
            if name in FETCHERS and any(
                re.fullmatch(r"(python|ruby|perl|node)[0-9.]*|" + "|".join(INTERPRETERS), m) or m == "sudo"
                for m in names[i + 1 :]
            ):
                return "curl|sh"
    for c in split_commands(tokens):
        n = normalize(c)
        if n and (n[0] in INTERPRETERS or n[0] in ("eval", "source", ".")):
            if any(re.search(r"(\$\(|`)\s*(curl|wget)\b", x) for x in n[1:]):
                return "sh -c $(curl)"
    # Process substitution: shlex tách `<(` thành `<` `(`: tìm trình thông dịch ngay trước `<` `(` `curl`.
    for i, t in enumerate(tokens[:-1]):
        if t in ("<(", "<", "(") and "<" in "".join(tokens[max(0, i - 1) : i + 1]) and tokens[i + 1] in FETCHERS:
            return "bash <(curl)"
    return None


GitRule = Callable[[List[str]], Tuple[str, str]]
DISCARD_WHOLE_TREE_WHY = "{} . vứt toàn bộ thay đổi chưa commit"


def _current_branch(cwd: Optional[str]) -> str:
    """Nhánh đang checkout ở `cwd` (`git symbolic-ref --short -q HEAD`); lỗi/detached/không phải repo/quá hạn → rỗng."""
    try:
        r = subprocess.run(
            ["git", "-C", cwd or ".", "symbolic-ref", "--short", "-q", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def _push_ref_rule(ref: str, deleting: bool, cwd: Optional[str] = None) -> Tuple[str, str]:
    """Một refspec của push: đích là nhánh chính → deny nếu xoá, ask nếu đẩy thẳng. Đích `HEAD`/`@` = nhánh hiện tại."""
    dst = ref.split(":", 1)[1] if ":" in ref else ref
    dst = dst.removeprefix("refs/heads/")
    if dst in ("HEAD", "@"):
        dst = _current_branch(cwd)
    if dst not in MAIN_BRANCHES:
        return "", ""
    if deleting or ref.startswith(":"):
        return "deny", "xoá nhánh chính trên remote"
    return "ask", "push thẳng nhánh chính — khung yêu cầu đi qua PR"


def _git_push(args: List[str], cwd: Optional[str] = None) -> Tuple[str, str]:
    """push: deny --force/--mirror/+refspec và xoá nhánh chính; ask khi đẩy thẳng nhánh chính — kể cả khi không có
    refspec hoặc đích là `HEAD` mà nhánh hiện tại (ở `cwd`) là nhánh chính."""
    flags = _short_flags(args)
    force = any(x.startswith("--force") or x == "--mirror" for x in args) or "f" in flags
    refs = _positionals(args, ("-o", "--push-option", "--repo", "--receive-pack", "--exec"))
    if force or any(r.startswith("+") for r in refs):
        return "deny", "push --force/--mirror/+refspec ghi đè lịch sử"
    deleting = "--delete" in args or "d" in flags
    for r in refs[1:] or ["HEAD"]:  # không refspec: đẩy nhánh hiện tại
        verdict = _push_ref_rule(r, deleting, cwd)
        if verdict[0]:
            return verdict
    return "", ""


def _git_reset(args: List[str]) -> Tuple[str, str]:
    """reset: deny --hard."""
    if "--hard" in args:
        return "deny", "reset --hard làm mất thay đổi"
    return "", ""


def _git_clean(args: List[str]) -> Tuple[str, str]:
    """clean: deny -f/--force."""
    if "f" in _short_flags(args) or "--force" in args:
        return "deny", "clean -f xoá file chưa track"
    return "", ""


def _discards_whole_tree(args: List[str]) -> bool:
    """checkout/restore có đích là cả cây làm việc (`.`, `./`, `:/`, `*`) — đích nằm sau `--` hoặc là đối số vị trí."""
    if "--" in args:
        targets = args[args.index("--") + 1 :]
    else:
        targets = _positionals(args, ("-s", "--source", "-b", "-B"))
    return any(t in (".", "./", ":/", "*") for t in targets)


def _git_checkout(args: List[str]) -> Tuple[str, str]:
    """checkout: deny -f/--force và checkout cả cây."""
    if "f" in _short_flags(args) or "--force" in args:
        return "deny", "checkout -f vứt thay đổi"
    if _discards_whole_tree(args):
        return "deny", DISCARD_WHOLE_TREE_WHY.format("checkout")
    return "", ""


def _git_switch(args: List[str]) -> Tuple[str, str]:
    """switch: deny -f/--force/--discard-changes (vứt thay đổi như `checkout -f`); `-C` là force-create, không tính."""
    if "f" in _short_flags(args) or "--force" in args or "--discard-changes" in args:
        return "deny", "switch -f/--discard-changes vứt thay đổi"
    return "", ""


def _git_restore(args: List[str]) -> Tuple[str, str]:
    """restore: deny restore cả cây, trừ khi chỉ bỏ khỏi index (`--staged` không kèm worktree)."""
    index_only = "--staged" in args and "--worktree" not in args and "W" not in _short_flags(args)
    if _discards_whole_tree(args) and not index_only:
        return "deny", DISCARD_WHOLE_TREE_WHY.format("restore")
    return "", ""


def _git_stash(args: List[str]) -> Tuple[str, str]:
    """stash: ask khi drop/clear."""
    if args[:1] in (["drop"], ["clear"]):
        return "ask", f"stash {args[0]} xoá thay đổi đã cất"
    return "", ""


def _git_branch(args: List[str]) -> Tuple[str, str]:
    """branch: deny xoá cưỡng bức nhánh chính."""
    flags = _short_flags(args)
    deleting_force = "D" in flags or (("d" in flags or "--delete" in args) and ("f" in flags or "--force" in args))
    if deleting_force and any(x in MAIN_BRANCHES for x in _positionals(args)):
        return "deny", "xoá nhánh chính"
    return "", ""


GIT_RULES: Dict[str, GitRule] = {
    "reset": _git_reset,
    "clean": _git_clean,
    "checkout": _git_checkout,
    "switch": _git_switch,
    "restore": _git_restore,
    "stash": _git_stash,
    "branch": _git_branch,
}


def git_rules(n: List[str], cwd: Optional[str] = None) -> Tuple[str, str]:
    """Luật theo lệnh con của git (bảng GIT_RULES; `push` riêng vì cần thư mục để biết nhánh hiện tại); không có luật → cho qua."""
    if len(n) < 2:
        return "", ""
    if n[1] == "push":
        return _git_push(n[2:], cwd)
    rule = GIT_RULES.get(n[1])
    return rule(n[2:]) if rule else ("", "")


ASK_CMDS: Dict[str, Optional[Tuple[str, ...]]] = {
    "gh": ("release", "secret"),
    "npm": ("publish",),
    "pnpm": ("publish",),
    "yarn": ("publish",),
    "twine": ("upload",),
    "cargo": ("publish",),
    "docker": ("push",),
    "kubectl": ("apply", "delete"),
    "terraform": ("apply", "destroy"),
    "tofu": ("apply", "destroy"),
    "pulumi": ("up", "destroy"),
    "fly": ("deploy",),
    "vercel": ("deploy", "--prod"),
    "aws": None,
    "gcloud": None,
    "az": None,
}
INFO_ONLY = {"--version", "-v", "version", "--help", "-h", "help"}


EXTERNAL_ASK = "hành động đối ngoại/triển khai thật (điểm dừng bắt buộc)"
# Cờ của `gh pr merge` ăn thêm một token giá trị — không bóc thì giá trị bị hiểu là số PR.
GH_MERGE_VALUE_FLAGS: Tuple[str, ...] = (
    *("--match-head-commit", "-b", "--body", "-F", "--body-file", "-t", "--subject"),
    *("-A", "--author-email", "-R", "--repo"),
)
MERGE_CHECK_TIMEOUT = 90


def _flag_value(args: List[str], flag: str) -> Optional[str]:
    for i, a in enumerate(args):
        if a == flag and i + 1 < len(args):
            return args[i + 1]
        if a.startswith(flag + "="):
            return a.split("=", 1)[1]
    return None


def merge_check(selector: List[str], root: str) -> Dict[str, object]:
    """Chạy `xt.py merge-check --json` cài CÙNG khung với hook này (không theo PATH/biến môi trường agent đặt được)."""
    here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    xt = next(
        (
            p
            for p in (os.path.join(here, ".xtemplates", "scripts", "xt.py"), os.path.join(here, "scripts", "xt.py"))
            if os.path.isfile(p)
        ),
        "",
    )
    cmd = [sys.executable, xt, "merge-check", "--json", *(["--pr", selector[0]] if selector else [])]
    try:
        env = dict(os.environ, CLAUDE_PROJECT_DIR=root)
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=MERGE_CHECK_TIMEOUT, env=env, check=False)
        data: Dict[str, object] = json.loads(r.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return {"verdict": "lỗi", "reasons": ["merge-check không chạy được"]}
    return data


def gh_pr_merge_rule(args: List[str], root: str) -> Tuple[str, str]:
    """`gh pr merge` (ADR-0013): mặc định hỏi người; `allow` chỉ khi `xt.py merge-check` = merge VÀ lệnh ghim đúng
    head đã kiểm (`--match-head-commit`). `--admin` (vượt ruleset) và `--repo` (repo khác) luôn hỏi."""
    sha = _flag_value(args, "--match-head-commit")
    other_repo = any(a == "-R" or a.startswith(("-R", "--repo")) for a in args)
    if not sha or "--admin" in args or other_repo:
        return (
            "ask",
            f"{EXTERNAL_ASK} — tự merge cần `--match-head-commit <sha>` từ `xt.py merge-check`, không --admin/--repo",
        )
    d = merge_check(_positionals(args, GH_MERGE_VALUE_FLAGS)[:1], root)
    reasons = "; ".join(str(x) for x in d.get("reasons") or [])  # type: ignore[attr-defined]
    if d.get("verdict") != "merge":
        return "ask", f"{EXTERNAL_ASK} — merge-check: {d.get('verdict')}: {reasons}"
    if d.get("head") != sha:
        return "ask", f"{EXTERNAL_ASK} — head đã kiểm {d.get('head')} khác --match-head-commit {sha}"
    return "allow", f"merge-check: {reasons}"


def _rm_rule(args: List[str]) -> Tuple[str, str]:
    """rm: deny --no-preserve-root và rm -rf trên đích nguy hiểm (gốc, home, cwd, glob, thư mục `.git`)."""
    flags = _short_flags(args)
    recursive = "r" in flags or "R" in flags or "--recursive" in args
    force = "f" in flags or "--force" in args
    if "--no-preserve-root" in args or (
        recursive and force and any(_dangerous_rm_target(t) for t in _positionals(args))
    ):
        return "deny", "rm -rf trên /, ~, $HOME, ., .., *, .git"
    return "", ""


def command_rules(n: List[str], root: str, cwd: Optional[str] = None) -> Tuple[str, str]:
    name, args = n[0], n[1:]
    if name in ("sudo", "doas"):
        return "deny", "sudo/doas"
    if name == "rm":
        verdict = _rm_rule(args)
        if verdict[0]:
            return verdict
    if name == "dd" and any(x.startswith("if=") for x in args):
        return "deny", "dd ghi thô"
    if name.startswith("mkfs"):
        return "deny", "mkfs"
    if name == "chmod" and "777" in args:
        return "deny", "chmod 777"
    if name == "git":
        return git_rules(n, cwd)
    return _external_rule(name, args, root)


def _external_rule(name: str, args: List[str], root: str) -> Tuple[str, str]:
    """Hành động đối ngoại/triển khai thật → ask; `gh pr merge` qua `xt.py merge-check` (ADR-0013)."""
    if name == "gh" and args[:2] == ["pr", "merge"] and not set(args[2:]) & INFO_ONLY:
        return gh_pr_merge_rule(args[2:], root)
    if name in ASK_CMDS and not (set(args) and set(args) <= INFO_ONLY):
        subs = ASK_CMDS[name]
        if (
            subs is None
            or (args and args[0] in subs)
            or (name == "gh" and args[:2] == ["repo", "delete"])
            or (name == "vercel" and "--prod" in args)
        ):
            return "ask", EXTERNAL_ASK
    return "", ""


# Cách mở phiên Claude Code KHÔNG chạy hook của dự án (LOOP-HARNESS-018): agent tự đặt được → người phải xác nhận.
# Nguồn: Claude Code docs *CLI reference* (`--bare`, `--safe-mode`, `--settings`, `--setting-sources`, `--restricted`;
# `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_SAFE_MODE`) và *Hooks* (`disableAllHooks`), đọc 2026-10-15.
# Giới hạn đã biết (phân tích tĩnh): lệnh bọc trong `sh -c`/`eval`, alias, biến chứa cờ, chuỗi ghép lúc chạy.
HOOK_BYPASS_ENV = ("CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE")
HOOK_BYPASS_SETTING = "disableAllHooks"
HOOK_BYPASS_FLAGS = {"--bare", "--safe-mode", "--settings", "--setting-sources", "--restricted"}
CLAUDE_PKG = "@anthropic-ai/claude-code"
# Trình chạy gói: lệnh con đầu tiên (không phải cờ) là tên bin/gói được chạy (`npx claude`, `pnpm exec claude`).
PKG_RUNNERS: Set[Tuple[str, ...]] = {
    ("npx",),
    ("pnpx",),
    ("bunx",),
    ("npm", "exec"),
    ("pnpm", "exec"),
    ("pnpm", "dlx"),
    ("yarn", "dlx"),
    ("yarn", "exec"),
    ("npm", "x"),
    ("bun", "x"),
}
DECLARE_CMDS = {"export", "declare", "typeset", "readonly", "local"}
RC_FILES = {".bashrc", ".zshrc", ".profile", ".bash_profile", ".bash_login", ".bash_aliases", ".zprofile", ".zlogin"}
RC_FILES |= {".zshenv", ".envrc", "config.fish"}


def _is_claude_pkg(t: str) -> bool:
    """Gói/đường dẫn claude-code: tên gói (có thể kèm @phiên-bản) hoặc đường dẫn chứa thư mục gói."""
    return t == CLAUDE_PKG or t.startswith(CLAUDE_PKG + "@") or t.startswith(CLAUDE_PKG + "/") or f"/{CLAUDE_PKG}/" in t


def _runner_target(n: List[str]) -> int:
    """Chỉ số token được trình chạy gói thực thi (`npx -y claude` → 2); -1 nếu không phải trình chạy gói."""
    for prefix in PKG_RUNNERS:
        if tuple(n[: len(prefix)]) == prefix:
            i = len(prefix)
            while i < len(n) and n[i].startswith("-"):
                i += 1
            return i if i < len(n) else -1
    return -1


def _claude_args(n: List[str]) -> Optional[List[str]]:
    """Tham số của Claude Code trong lệnh (dừng ở `--`: sau đó là đối số vị trí/của chương trình khác); None nếu không gọi claude."""
    if n[0] == "claude":
        rest = n[1:]
    else:
        t = _runner_target(n)
        if t >= 0 and n[t] == "claude":
            rest = n[t + 1 :]
        else:
            i = next((k for k, tok in enumerate(n) if _is_claude_pkg(tok)), -1)
            if i < 0:
                return None
            rest = n[i + 1 :]
        if rest[:1] == ["--"]:  # `npm exec <pkg> -- <args>`: `--` của trình chạy, không phải của claude
            rest = rest[1:]
    return rest[: rest.index("--")] if "--" in rest else rest


def _env_assigns(argv: List[str]) -> List[str]:
    """Tên biến được gán thật: gán đầu lệnh (kể cả sau `env [-u X] [-C d]` và wrapper), hoặc đối số của `export`/`declare`…"""
    if argv and argv[0] in DECLARE_CMDS:
        return [t.split("=", 1)[0] for t in argv[1:] if ENV_ASSIGN_RE.fullmatch(t)]
    names: List[str] = []
    a = list(argv)
    while a:
        head = posixpath.basename(a[0])
        if ENV_ASSIGN_RE.fullmatch(a[0]):
            names.append(a.pop(0).split("=", 1)[0])
        elif head == "env":
            a.pop(0)
            _skip_env_args_keep_assigns(a)
        elif head in WRAPPERS:
            a.pop(0)
            _skip_wrapper_args(head, a)
        else:
            break
    return names


def _risky_write(n: List[str], argv: List[str]) -> bool:
    """Lệnh ghi vào file settings/JSON, `.env` hoặc rc của shell — nơi marker tắt hook có hiệu lực."""
    for t in write_targets(n, argv):
        b = posixpath.basename(t)
        if b.endswith(".json") or b.endswith(".env") or b in RC_FILES:
            return True
    return False


def _bypass_marker(argv: List[str], n: List[str], claude: List[str]) -> str:
    """Marker tắt hook ở vị trí có hiệu lực: gán biến môi trường, tham số của claude, hoặc nội dung ghi vào file cấu hình.
    Nhắc tên marker như dữ liệu (`grep`, `echo`, `git commit -m`, ghi file thường) không tính."""
    hit = next((v for v in _env_assigns(argv) if v in HOOK_BYPASS_ENV), "")
    if hit:
        return hit
    if any(HOOK_BYPASS_SETTING in t for t in claude):
        return HOOK_BYPASS_SETTING
    if _risky_write(n, argv):
        return next((m for m in (HOOK_BYPASS_SETTING, *HOOK_BYPASS_ENV) for t in argv if m in t), "")
    return ""


def _shell_c_bypass(n: List[str]) -> str:
    """`bash -c "<lệnh>"`: áp luật hook-bypass cho từng lệnh bên trong (đệ quy)."""
    if n[0] not in SHELLS or "-c" not in n[:-1]:
        return ""
    for sub in split_commands(tokenize(n[n.index("-c") + 1])):
        sn = normalize(sub)
        if sn:  # chuỗi bên trong luôn ngắn hơn → đệ quy dừng
            reason = hook_bypass(sub, sn)
            if reason:
                return reason
    return ""


def hook_bypass(argv: List[str], n: List[str]) -> str:
    """Lý do hỏi nếu lệnh tắt/bỏ qua hook của dự án; chuỗi rỗng nếu không."""
    inner = _shell_c_bypass(n)
    if inner:
        return inner
    claude = _claude_args(n) or []
    hit = _bypass_marker(argv, n, claude)
    if hit:
        return f"lệnh đặt `{hit}` (tắt hook của khung)"
    flag = next((a.split("=", 1)[0] for a in claude if a.split("=", 1)[0] in HOOK_BYPASS_FLAGS), "")
    return f"phiên Claude với `{flag}` có thể bỏ qua hook của dự án" if flag else ""


def write_targets(n: List[str], argv: List[str]) -> List[str]:
    """File mà lệnh có thể ghi: chuyển hướng `>`/`>>`, `sed -i`, `tee`, đích của cp/mv/install/truncate/ln."""
    out = [argv[i + 1] for i, t in enumerate(argv[:-1]) if t in (">", ">>", ">|", "&>")]
    name, args = (n[0], n[1:]) if n else ("", [])
    pos = _positionals(args, ("-e", "-f", "-s", "-t", "--target-directory", "-m", "--mode"))
    if name == "sed" and any(x == "-i" or x.startswith("-i") or x.startswith("--in-place") for x in args):
        out += pos[1:] if not any(x in ("-e", "-f") for x in args) else pos
    elif name == "tee":
        out += pos
    elif name in ("cp", "mv", "install", "ln") and len(pos) >= 2:
        out.append(pos[-1])
    elif name in ("truncate", "rm"):
        out += pos
    return out


COMMIT_LONG_OPTS_WITH_VALUE = ("--message", "--file", "--author", "--date", "--template", "--reuse-message")
# Cờ ngắn có giá trị: `-m`/`-F`/`-c`/`-C`/`-t` lấy token sau (hoặc phần dính liền: `-m"x"`, `-am"x"`);
# `-u<mode>`/`-S<keyid>` chỉ nhận giá trị dính liền. Phần từ chữ đó trở đi là dữ liệu, không phải cờ (`-uno` ≠ `-n`).
COMMIT_SHORT_VALUE_RE = re.compile(r"-([A-Za-z]*?)([mFcCtuS])")


def _commit_flag_args(args: List[str]) -> List[str]:
    """Đối số của `git commit` sau khi bỏ giá trị của -m/-F/… (nội dung message là dữ liệu, không phải cờ)."""
    out: List[str] = []
    skip = False
    for x in args:
        m = COMMIT_SHORT_VALUE_RE.match(x)
        if skip:
            skip = False
        elif x in COMMIT_LONG_OPTS_WITH_VALUE:
            skip = True
        elif m:
            skip = m.end() == len(x) and m.group(2) not in "uS"  # giá trị ở token kế
            if m.group(1):
                out.append("-" + m.group(1))
        else:
            out.append(x)
    return out


def _write_asks(n: List[str], argv: List[str], root: str) -> List[str]:
    """Câu hỏi xác nhận cho file bí mật/cổng/migration mà lệnh có thể ghi (bỏ qua /dev/*)."""
    asks: List[str] = []
    for target in write_targets(n, argv):
        kind = classify_path(rel_path(target, root)) if target and not target.startswith("/dev/") else ""
        if kind == "secret":
            asks.append(f"ghi file bí mật qua Bash: {target}")
        elif kind in ("gate", "migration"):
            asks.append(f"sửa cấu hình cổng/CI/harness/migration qua Bash ({target}) — nói rõ lý do")
    return asks


def _scan_commit(args: List[str], res: Dict[str, object], asks: List[str]) -> Optional[str]:
    """`git commit`: --allow-empty → trả lý do deny; còn lại đánh dấu commit, --no-verify thì thêm câu hỏi."""
    if "--allow-empty" in args:
        return "Commit rỗng bị khung chặn (không dùng empty commit để kích CI). Push thay đổi thật hoặc re-run job."
    flag_args = _commit_flag_args(args)
    res["commit"] = True
    if "--no-verify" in flag_args or "n" in _short_flags(flag_args):
        res["no_verify"] = True
        asks.append("commit --no-verify bỏ qua cổng chất lượng — cần người xác nhận lý do")
    return None


def _scan_command(
    argv: List[str], root: str, res: Dict[str, object], asks: List[str], cwd: Optional[str] = None
) -> Optional[str]:
    """Quét một lệnh đơn: thêm câu hỏi vào `asks`, ghi cờ commit (kèm thư mục commit) vào `res`; trả lý do deny nếu phải chặn."""
    n = normalize(argv)
    if not n:
        return None
    # `commit`/`push` tác động lên repo ở `cd …`/`git -C …`; thư mục không rõ → push dùng gốc dự án (hỏi > cho qua).
    gdir = _git_dir(argv, cwd) if n[:2] in (["git", "commit"], ["git", "push"]) else None
    decision, why = command_rules(n, root, gdir or root)
    if decision == "deny":
        return f"Lệnh bị khung chặn ({why}): {' '.join(argv)[:300]}. Muốn làm thật thì người dùng tự chạy."
    if decision == "ask":
        asks.append(f"{why}: {' '.join(argv)[:200]}")
    if decision == "allow":  # chỉ hiệu lực khi cả lệnh Bash là đúng một lệnh này (bash_decision)
        res["allow"] = why
    bypass = hook_bypass(argv, n)
    if bypass:
        asks.append(f"{bypass}: {' '.join(argv)[:200]}")
    asks.extend(_write_asks(n, argv, root))
    if n[:2] == ["git", "commit"]:
        # Cổng chạy ở repo NHẬN commit (`cd ../khac && git commit`, `git -C ../khac commit`), không phải gốc phiên.
        res["commit_dir"] = gdir or ""
        return _scan_commit(n[2:], res, asks)
    return None


def bash_decision(cmd: str, root: str, cwd: Optional[str] = None) -> Dict[str, object]:
    """Quyết định cho một lệnh Bash: deny/ask/"" kèm cờ `commit`, `no_verify`, `commit_dir` cho hook cổng commit.
    `cwd` = thư mục lệnh bắt đầu chạy (payload hook); `cd <dir>` trong lệnh dời nó để biết commit rơi vào repo nào."""
    tokens = tokenize(cmd)
    res: Dict[str, object] = {"decision": "", "reason": "", "commit": False, "no_verify": False, "commit_dir": ""}
    rx = remote_exec(cmd, tokens)
    if rx:
        res.update(
            decision="deny",
            reason=f"Cấm chạy script tải từ mạng ({rx}): tải về, kiểm checksum rồi mới chạy. Lệnh: {cmd[:300]}",
        )
        return res
    asks: List[str] = []
    commands = _commands_with_cwd(tokens, cwd or root)
    for argv, here in commands:
        deny_reason = _scan_command(argv, root, res, asks, here)
        if deny_reason:
            res.update(decision="deny", reason=deny_reason)
            return res
    allow = res.pop("allow", "")
    if allow and len(commands) > 1:  # `allow` bỏ hỏi cho CẢ lệnh Bash → chỉ khi merge đứng một mình
        asks.append(f"{EXTERNAL_ASK} — tự merge chỉ khi lệnh đứng một mình")
    if asks:
        res.update(decision="ask", reason="Khung cần xác nhận: " + "; ".join(dict.fromkeys(asks)))
    elif allow:
        res.update(decision="allow", reason=f"Khung cho tự merge (ADR-0013) — {allow}")
    return res


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        tool_input = payload.get("tool_input") or {}
        root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
        if mode == "bash":
            cmd = tool_input.get("command")
            cwd = payload.get("cwd")
            cwd = cwd if isinstance(cwd, str) and posixpath.isabs(cwd) else None
            out: Dict[str, object] = bash_decision(cmd, root, cwd) if isinstance(cmd, str) and cmd else {"decision": ""}
        elif mode == "edit":
            path = tool_input.get("file_path")
            d, r = edit_decision(path, root, tool_input) if isinstance(path, str) and path else ("", "")
            out = {"decision": d, "reason": r}
        else:
            out = {"decision": ""}
    except Exception:  # fail-open về luồng: lỗi của hook không được kẹt phiên
        out = {"decision": ""}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
