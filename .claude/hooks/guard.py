#!/usr/bin/env python3
"""guard.py — phân tích lệnh/đường dẫn cho hook PreToolUse của khung X-Templates (chỉ thư viện chuẩn).

Dùng (payload JSON của Claude Code trên stdin, kết quả JSON trên stdout):
  guard.py bash   → {"decision": "deny"|"ask"|"", "reason": "...", "commit": true|false, "no_verify": true|false,
                     "commit_dir": "<thư mục git commit chạy, rỗng nếu không biết>"}
  guard.py edit   → {"decision": "deny"|"ask"|"", "reason": "..."}  (file bí mật/cổng/migration; test ĐÃ CÓ bị làm yếu)
  guard.py mcp    → {"decision": "allow"|"ask"|"", "reason": "..."}  (tool MCP merge PR: allow chỉ khi merge-check cho phép)

Vì sao Python thay regex trong bash (audit 2026-10-14, AUD-SEC-001…010):
- tách lệnh theo token shell (`shlex`): `|`/`;` trong nháy không phải ranh giới, thân heredoc là dữ liệu;
- chuẩn hoá trước khi so luật: bỏ gán biến đầu lệnh, `command`/`env`/`nohup`/`time`, tuỳ chọn toàn cục của git (`-C`, `-c`, …);
- đọc payload qua stdin, không qua argv (lệnh rất dài không còn làm hook lỗi rồi cho qua).
Hàng rào này chống TAI NẠN (agent gõ nhầm), không phải sandbox: lệnh cố ý né (chuỗi ghép lúc chạy, base64…) không nằm
trong phạm vi — `eval '…'`, backtick, `{ …; }` có chữ nguyên văn thì vẫn được quét (rà stored 2026-10-16).
Lỗi bất ngờ → in quyết định rỗng (fail-open về luồng); luật deny là fail-closed về hành động đã nhận ra.
"""

from __future__ import annotations

import contextlib
import itertools
import json
import os
import posixpath
import re
import shlex
import subprocess
import sys
import tempfile
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

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
    # AUD-HAR-027: cấu hình test/lint phổ biến khác (vite.config chứa cấu hình vitest; conftest.py bỏ/đổi test được)
    *("pytest.ini", "tox.ini", "noxfile.py", "conftest.py", "vite.config.*", ".flake8", ".golangci.y*ml"),
    *(".nycrc*", ".c8rc*", "phpunit.xml*", "karma.conf.*", ".mocharc*"),
    # Rà stored 2026-10-16: cổng của UX-DS-002/005 (stylelint) và baseline ảnh/snapshot — agent tự cập nhật baseline
    # là làm cổng visual xanh bằng cách đổi đáp án.
    *(".stylelintrc*", "stylelint.config.*", "*-snapshots/*", "__snapshots__/*"),
)
# Năng lực của agent (LOOP-STOP-023): cấu hình MCP server, plugin, tiện ích — thêm/đổi giữa phiên là tự cấp quyền mới
# cho chính mình (plugin/MCP chạy với quyền người dùng; `.mcp.json` ở gốc plugin tự đăng ký server từ xa — stored 19 §1d).
CAPABILITY_PATTERNS = (
    *(".mcp.json", "mcp.json", ".claude.json", ".claude-plugin/*", ".codex/config.toml", ".gemini/settings.json"),
    ".gemini/extensions/*",
)
# Agent/skill/lệnh tắt của Claude Code: ở dự án đích (có `.xtemplates/`) là harness đã cài → hỏi; ở repo khung là sản
# phẩm đang phát triển → không hỏi (sửa hằng ngày).
TARGET_CAPABILITY_PATTERNS = (".claude/agents/*", ".claude/skills/*", ".claude/commands/*")
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
    """'secret' | 'gate' | 'evidence' | 'capability' | 'migration' | ''."""
    if rel == ".autopilot" or rel.startswith(".autopilot/"):
        return "evidence"  # bằng chứng + trạng thái vòng: chỉ `xt.py loop …` ghi (AUD-HAR-024)
    if _match_any(rel, SECRET_PATTERNS) and not rel.endswith((".example", ".sample", ".template")):
        return "secret"
    if _match_any(rel, GATE_PATTERNS):
        return "gate"
    if _match_any(rel, CAPABILITY_PATTERNS):
        return "capability"
    if MIGRATION_RE.search(rel):
        return "migration"
    return ""


def is_target_project(root: str) -> bool:
    """Dự án đích (khung cài ở `.xtemplates/`), không phải repo khung."""
    return os.path.isdir(os.path.join(root, ".xtemplates"))


def path_kind(rel: str, root: str) -> str:
    """classify_path + agent/skill/lệnh của Claude Code ở dự án đích là 'capability'."""
    kind = classify_path(rel)
    if not kind and is_target_project(root) and _match_any(rel, TARGET_CAPABILITY_PATTERNS):
        return "capability"
    return kind


CAPABILITY_WHY = (
    "thêm/đổi năng lực agent ({}) — MCP server/plugin/skill mới chạy với quyền người dùng; người duyệt (LOOP-STOP-023)"
)


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
    kind = path_kind(rel, root)
    if kind == "capability":
        return "ask", "Sửa cấu hình " + CAPABILITY_WHY.format(rel) + "."
    if kind == "secret":
        return "deny", f"Không ghi file bí mật qua agent: {rel} (dùng secret manager/biến môi trường)."
    if kind == "gate":
        return (
            "ask",
            f"Sửa cấu hình cổng/CI/harness ({rel}). Khung coi đây là điểm dừng: nói rõ lý do trước khi nới hàng rào.",
        )
    if kind == "evidence":
        return "ask", (
            f"Ghi tay bằng chứng/trạng thái autopilot ({rel}) = bằng chứng giả (P1). Dùng `xt.py loop record/…`; "
            "chỉ sửa tay khi người yêu cầu."
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
    """`>`, `>>`, `<`, `&>`, `>|` (ghi đè noclobber) — `|`, `<(`, `>(` không phải chuyển hướng."""
    return _is_punct(t) and ("<" in t or ">" in t) and "(" not in t and ("|" not in t or t == ">|")


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


# Từ khoá/nhóm lệnh của shell đứng đầu lệnh đơn (`{ rm -rf ~; }`, `if …; then rm …`, `! cmd`) — rà stored 2026-10-16:
# trước đây `{`/`then` bị hiểu là tên lệnh nên lệnh thật phía sau lọt.
SHELL_KEYWORDS = {"{", "}", "!", "if", "then", "else", "elif", "while", "until", "do"}


def _strip_prefixes(argv: List[str]) -> List[str]:
    """Bỏ từ khoá shell, gán biến đầu lệnh và wrapper (`command`, `env -i`, `nohup`…) cho tới khi gặp lệnh thật."""
    a = list(argv)
    while a:
        head = a[0]
        if head in SHELL_KEYWORDS:
            a.pop(0)
        elif ENV_ASSIGN_RE.fullmatch(head):
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


# Hành động đối ngoại: lệnh → lệnh con (ở BẤT KỲ vị trí positional: `pnpm -r publish`, `yarn npm publish`,
# `dotnet nuget push`) hoặc cờ (`docker build --push`, `vercel --prod`); None = mọi lệnh con (AUD-SEC-018).
ASK_CMDS: Dict[str, Optional[Tuple[str, ...]]] = {
    "npm": ("publish", "unpublish", "deprecate", "dist-tag"),
    "pnpm": ("publish",),
    "yarn": ("publish",),
    "bun": ("publish",),
    "uv": ("publish",),
    "poetry": ("publish",),
    "twine": ("upload",),
    "gem": ("push",),
    "dotnet": ("push",),
    "cargo": ("publish",),
    "docker": ("push", "--push"),
    "podman": ("push", "--push"),
    "helm": ("install", "upgrade", "uninstall", "push"),
    "kubectl": ("apply", "delete", "create", "replace", "patch"),
    "terraform": ("apply", "destroy"),
    "tofu": ("apply", "destroy"),
    "pulumi": ("up", "destroy"),
    "fly": ("deploy",),
    "flyctl": ("deploy",),
    "wrangler": ("deploy", "publish"),
    "firebase": ("deploy",),
    "netlify": ("deploy",),
    "vercel": ("deploy", "--prod"),
    "aws": None,
    "gcloud": None,
    "az": None,
}
# `gh <nhóm> <lệnh>` đối ngoại (đổi repo/CI/biến/bí mật); `gh release`, `gh secret` ở mọi lệnh con.
GH_ASK = {("release",), ("secret",), ("workflow", "run"), ("variable", "set"), ("variable", "delete")}
GH_ASK |= {("repo", "edit"), ("repo", "sync"), ("repo", "rename"), ("repo", "archive"), ("repo", "delete")}
GH_ASK |= {("repo", "set-default")}  # đổi repo mà `gh pr merge`/`{owner}/{repo}` trỏ tới, như `-R` (AUD-SEC-030)
INFO_ONLY = {"--version", "-v", "version", "--help", "-h", "help"}


EXTERNAL_ASK = "hành động đối ngoại/triển khai thật (điểm dừng bắt buộc)"
# Cờ của `gh pr merge` ăn thêm một token giá trị — không bóc thì giá trị bị hiểu là số PR.
GH_MERGE_VALUE_FLAGS: Tuple[str, ...] = (
    *("--match-head-commit", "-b", "--body", "-F", "--body-file", "-t", "--subject"),
    *("-A", "--author-email", "-R", "--repo"),
)
MERGE_CHECK_TIMEOUT = 90
# Cờ được phép khi tự merge (AUD-SEC-016): cờ khác (`--admin…`, `--repo`, `--body-file`, `-b`…) → hỏi người.
MERGE_ALLOW_FLAGS = {
    "--squash",
    "-s",
    "--merge",
    "-m",
    "--rebase",
    "-r",
    "--delete-branch",
    "-d",
    "--match-head-commit",
}
MERGE_SELECTOR_RE = re.compile(r"#?\d+|[A-Za-z0-9._/-]+")
# Lệnh merge "trơn": một dòng, chỉ chữ/số/dấu an toàn — không `$(…)`, backtick, nháy, heredoc, chuyển hướng, gán biến.
PLAIN_MERGE_RE = re.compile(r"gh[ \t]+(pr[ \t]+merge|api)([ \t]+[A-Za-z0-9_./#:=@+{}-]+)*")
# Merge qua REST (phiên chặn GraphQL — `gh pr merge` không chạy được): đúng repo hiện tại, ghim `sha` (409 nếu lệch).
REST_MERGE_PATH_RE = re.compile(r"repos/\{owner\}/\{repo\}/pulls/(\d+)/merge")
MERGE_METHODS = {"squash", "merge", "rebase"}
# `gh api` ghi (khác GET; `-f`/`-F`/`--input` ngầm là POST) = hành động đối ngoại, kể cả merge qua REST (AUD-SEC-020).
GH_API_FIELD_FLAGS = ("-f", "-F", "--field", "--raw-field", "--input")
GH_API_VALUE_FLAGS: Tuple[str, ...] = (
    *GH_API_FIELD_FLAGS,
    *("-X", "--method", "-H", "--header", "-q", "--jq", "-t", "--template", "-p", "--preview", "--cache", "--hostname"),
)
HELP_FLAGS = {"--help", "-h"}


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
    if "--auto" in args and not any(a.startswith("--admin") for a in args):
        flags = sorted({a.split("=", 1)[0] for a in args if a.startswith("-")} - MERGE_ALLOW_FLAGS - {"--auto"})
        selector = _positionals(args, GH_MERGE_VALUE_FLAGS)
        if flags or len(selector) > 1 or not all(MERGE_SELECTOR_RE.fullmatch(s) for s in selector):
            return "ask", f"{EXTERNAL_ASK} — bật auto-merge chỉ nhận số PR/nhánh và cờ merge thường"
        return _auto_merge_verdict(selector[:1], root)
    sha = _flag_value(args, "--match-head-commit")
    if sum(a == "--match-head-commit" or a.startswith("--match-head-commit=") for a in args) > 1:
        sha = None  # gh lấy lần cuối, guard đã kiểm lần đầu — hai pin là không pin
    other_repo = any(a == "-R" or a.startswith(("-R", "--repo")) for a in args)
    if not sha or any(a.startswith("--admin") for a in args) or other_repo:
        return (
            "ask",
            f"{EXTERNAL_ASK} — tự merge cần `--match-head-commit <sha>` từ `xt.py merge-check`, không --admin/--repo",
        )
    flags = sorted({a.split("=", 1)[0] for a in args if a.startswith("-")} - MERGE_ALLOW_FLAGS)
    selector = _positionals(args, GH_MERGE_VALUE_FLAGS)
    if flags or len(selector) > 1 or not all(MERGE_SELECTOR_RE.fullmatch(s) for s in selector):
        return "ask", f"{EXTERNAL_ASK} — tự merge chỉ nhận số PR/nhánh và cờ {', '.join(sorted(MERGE_ALLOW_FLAGS))}"
    return _merge_verdict(selector[:1], sha, root)


def _rm_rule(args: List[str], root: str = "", cwd: Optional[str] = None) -> Tuple[str, str]:
    """rm: deny --no-preserve-root và rm -rf trên đích nguy hiểm (gốc, home, cwd, glob, thư mục `.git`); xoá đệ quy
    ra ngoài gốc dự án (trừ thư mục tạm) → ask (xoá dữ liệu là điểm dừng bắt buộc — stored 01 §3c: `rm -rf ~/x`)."""
    flags = _short_flags(args)
    recursive = "r" in flags or "R" in flags or "--recursive" in args
    force = "f" in flags or "--force" in args
    targets = _positionals(args)
    if "--no-preserve-root" in args or (recursive and force and any(_dangerous_rm_target(t) for t in targets)):
        return "deny", "rm -rf trên /, ~, $HOME, ., .., *, .git"
    outside = [t for t in targets if recursive and root and _outside_project(t, root, cwd)]
    if outside:
        return "ask", f"xoá đệ quy ngoài thư mục dự án ({outside[0]}) — xoá dữ liệu cần người duyệt"
    return "", ""


TEMP_DIRS = ("/tmp", "/var/tmp", "/private/tmp", "/private/var/folders")


def _outside_project(target: str, root: str, cwd: Optional[str]) -> bool:
    """Đích (đã mở `~`/`$HOME`) nằm ngoài gốc dự án và ngoài thư mục tạm; biến khác/không rõ → False (fail-open)."""
    t = re.sub(r"^(\$HOME|\$\{HOME\})(?=/|$)", "~", target)
    if "$" in t or "`" in t:
        return False
    p = os.path.realpath(os.path.join(cwd or root, os.path.expanduser(t)))
    temps = [os.path.realpath(d) for d in (*TEMP_DIRS, tempfile.gettempdir(), os.environ.get("TMPDIR", "/tmp"))]
    inside = [os.path.realpath(root), *temps]
    return not any(p == d or p.startswith(d.rstrip("/") + "/") for d in inside)


FIND_EXEC = {"-exec", "-execdir", "-ok", "-okdir"}


def _find_rule(args: List[str], root: str, cwd: Optional[str]) -> Tuple[str, str]:
    """`find <gốc…> -delete` / `-exec rm … {}`: xoá các file khớp dưới gốc — gốc là `/`, `~` → deny; gốc ngoài dự án
    → ask. Lệnh trong `-exec … ;|+` còn được quét như lệnh thường (`{}` = một file tìm thấy)."""
    i = 0
    while i < len(args) and not args[i].startswith(("-", "(", "!")):
        i += 1
    roots = args[:i] or ["."]
    deleting = "-delete" in args[i:]
    for k, a in enumerate(args):
        if a not in FIND_EXEC:
            continue
        sub = [
            FIND_FOUND if t == "{}" else t for t in itertools.takewhile(lambda t: t not in (";", "+"), args[k + 1 :])
        ]
        verdict = bash_decision(shlex.join(sub), root, cwd, MAX_NEST - 1)
        if verdict["decision"] in ("deny", "ask"):
            return str(verdict["decision"]), f"find {a}: {verdict['reason']}"
        deleting = deleting or bool(sub) and posixpath.basename(sub[0]) in ("rm", "shred", "unlink")
    if not deleting:
        return "", ""
    if any(_rm_target(r) in SYSTEM_ROOTS for r in roots):
        return "deny", "find xoá file dưới /, ~, $HOME"
    outside = [r for r in roots if _outside_project(r, root, cwd)]
    return ("ask", f"find xoá file ngoài thư mục dự án ({outside[0]})") if outside else ("", "")


FIND_FOUND = "xt-find-match"  # thay `{}` khi quét lệnh `-exec`: một file bên dưới gốc của find
SYSTEM_ROOTS = {"/", "~", "$HOME", "${HOME}"}


SKILL_RUNNER_NAMES = {"skills"}


def _capability_rule(n: List[str]) -> Tuple[str, str]:
    """Lệnh cài MCP server/plugin/skill cho agent (`claude mcp add`, `claude plugin install`, `npx skills add`…) → ask."""
    claude = _claude_args(n)
    words = [a for a in (claude or n[1:]) if not a.startswith("-")]
    hit = ""
    if claude is not None and (
        words[:2] in (["mcp", "add"], ["mcp", "add-json"], ["mcp", "add-from-claude-desktop"])
        or words[:2] in (["plugin", "install"], ["plugin", "enable"])
        or words[:3] == ["plugin", "marketplace", "add"]
    ):
        hit = "claude " + " ".join(words[:3] if words[1:2] == ["marketplace"] else words[:2])
    elif n[0] in ("codex", "gemini") and (words[:2] == ["mcp", "add"] or words[:2] == ["extensions", "install"]):
        hit = f"{n[0]} {' '.join(words[:2])}"
    else:
        idx = _runner_target(n)
        target = posixpath.basename(n[idx]) if idx >= 0 else n[0]
        rest = n[idx + 1 :] if idx >= 0 else n[1:]
        if target in SKILL_RUNNER_NAMES and rest[:1] == ["add"]:
            hit = f"{target} add"
    return ("ask", CAPABILITY_WHY.format(hit)) if hit else ("", "")


SNAPSHOT_RUNNERS = ("playwright", "jest", "vitest")
SNAPSHOT_UPDATE_FLAGS = {"-u", "--update-snapshots", "--updateSnapshot", "--update"}


def _snapshot_update_rule(n: List[str]) -> Tuple[str, str]:
    """Chạy test kèm cập nhật snapshot/baseline ảnh → ask: đổi đáp án để cổng visual xanh (LOOP-DESIGN-021)."""
    if any(r in posixpath.basename(t) for t in n for r in SNAPSHOT_RUNNERS) and (
        set(n) & SNAPSHOT_UPDATE_FLAGS or any(t.startswith("--update-snapshots=") for t in n)
    ):
        return "ask", "cập nhật snapshot/baseline ảnh = đổi đáp án của cổng visual; kèm ảnh trước/sau cho người duyệt"
    return "", ""


def _delete_rule(name: str, args: List[str], root: str, cwd: Optional[str]) -> Tuple[str, str]:
    if name == "rm":
        return _rm_rule(args, root, cwd)
    return _find_rule(args, root, cwd) if name == "find" else ("", "")


def command_rules(n: List[str], root: str, cwd: Optional[str] = None) -> Tuple[str, str]:
    name, args = n[0], n[1:]
    if name in ("sudo", "doas"):
        return "deny", "sudo/doas"
    verdict = _delete_rule(name, args, root, cwd)
    if verdict[0]:
        return verdict
    for rule in (_capability_rule, _snapshot_update_rule):
        verdict = rule(n)
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


def _gh_api_methods(args: List[str]) -> List[str]:
    """Mọi giá trị `-X`/`--method` theo thứ tự (`-X PUT`, `-XPUT`, `-X=PUT`, `--method=PUT`) — gh lấy giá trị CUỐI."""
    out: List[str] = []
    for i, a in enumerate(args):
        if a in ("-X", "--method") and i + 1 < len(args):
            out.append(args[i + 1])
        elif a.startswith("--method="):
            out.append(a.split("=", 1)[1])
        elif a.startswith("-X") and len(a) > 2:
            out.append(a[2:].lstrip("="))
    return [m.upper() for m in out]


def _gh_api_field_values(args: List[str]) -> List[str]:
    """Giá trị `key=value` của `-f`/`-F`/`--field`/`--raw-field` (cả dạng dính `-fk=v`, `--field=k=v`)."""
    out: List[str] = []
    for i, a in enumerate(args):
        if a in ("-f", "-F", "--field", "--raw-field") and i + 1 < len(args):
            out.append(args[i + 1])
        elif a.startswith(("--field=", "--raw-field=")):
            out.append(a.split("=", 1)[1])
        elif a[:2] in ("-f", "-F") and len(a) > 2:
            out.append(a[2:])
    return out


def _gh_api_writes(args: List[str]) -> bool:
    """`gh api` ghi lên GitHub: phương thức khác GET (cờ cuối thắng; nhiều phương thức khác nhau = ghi), mặc định POST
    khi có trường; endpoint `graphql`: mutation, hoặc query không đọc được tại chỗ (`@file`, `--input`, `$(…)`)."""
    methods = _gh_api_methods(args)
    fields = _gh_api_field_values(args)
    has_input = any(a.split("=", 1)[0] == "--input" for a in args)
    if _positionals(args, GH_API_VALUE_FLAGS)[:1] == ["graphql"]:
        indirect = has_input or any("$(" in a or "`" in a for a in args)
        return (
            indirect or any(v.partition("=")[2].startswith("@") for v in fields) or "mutation" in " ".join(args).lower()
        )
    if len(set(methods)) > 1:
        return True
    return (methods[-1] if methods else ("POST" if fields or has_input else "GET")) != "GET"  # AUD-SEC-029


# Tool MCP merge/bật auto-merge PR (vd `mcp__github__merge_pull_request`). Merge ghim `expectedHeadSha` mà merge-check
# cho phép → allow (ADR-0014); bật auto-merge (không ghim head) chỉ allow ở `merge_autonomy` L3 (ADR-0015), dưới L3 hỏi.
MCP_MERGE_RE = re.compile(r"mcp__.+__\w*(merge_pull_request|auto_merge)\w*")
MCP_MERGE_KEYS = {"owner", "repo", "pullNumber", "expectedHeadSha", "merge_method", "commit_title", "commit_message"}


MCP_AUTO_KEYS = {"owner", "repo", "pullNumber", "mergeMethod"}


def _auto_merge_verdict(selector: List[str], root: str, repo: str = "") -> Tuple[str, str]:
    """Bật auto-merge của GitHub (ADR-0015): allow khi `merge_autonomy` ≥ L3, PR còn mở, không phải PR chồng (nhắm nhánh
    khác nhánh mặc định), không thuộc ngoại lệ cứng (`hard`, ADR-0016) và (MCP) đúng repo. GitHub vẫn chỉ merge khi
    required check/ruleset đạt; không ghim head."""
    d = merge_check(selector, root)
    level = d.get("autonomy")
    if not isinstance(level, int) or level < 3:
        return "ask", f"{EXTERNAL_ASK} — bật auto-merge chỉ khi xt.yaml `merge_autonomy` ≥ L3 (ADR-0015)"
    if d.get("verdict") in ("closed", "lỗi") or d.get("stacked"):
        return "ask", f"{EXTERNAL_ASK} — không bật auto-merge: PR {d.get('verdict')}/PR chồng (nhắm nhánh sắp bị xoá)"
    if d.get("hard"):  # tiền/dữ liệu thật/auth/mật mã/bí mật luôn người merge, kể cả L3 (ADR-0016, AUD-HAR-042)
        return "ask", f"{EXTERNAL_ASK} — ngoại lệ cứng (LOOP-STOP-005): người merge, không bật auto-merge"
    if repo and str(d.get("repo", "")).lower() != repo.lower():
        return "ask", f"{EXTERNAL_ASK} — merge-check kiểm repo {d.get('repo') or '?'}, không phải {repo}"
    return "allow", f"merge_autonomy L{level}: bật auto-merge (GitHub merge khi required check xanh)"


def _mcp_auto_merge(tool_input: Dict[str, object], root: str) -> Tuple[str, str]:
    n, owner, repo = tool_input.get("pullNumber"), tool_input.get("owner"), tool_input.get("repo")
    ok = not set(tool_input) - MCP_AUTO_KEYS and type(n) is int and n > 0
    ok = ok and isinstance(owner, str) and isinstance(repo, str)
    if not ok or tool_input.get("mergeMethod", "SQUASH") not in ("SQUASH", "MERGE", "REBASE"):
        return "ask", f"{EXTERNAL_ASK} — bật auto-merge qua MCP cần owner/repo/pullNumber hợp lệ"
    return _auto_merge_verdict([str(n)], root, f"{owner}/{repo}")


def mcp_decision(tool_name: str, tool_input: Dict[str, object], root: str) -> Tuple[str, str]:
    if not MCP_MERGE_RE.fullmatch(tool_name):
        return "", ""
    if tool_name == "mcp__github__enable_pr_auto_merge":
        return _mcp_auto_merge(tool_input, root)
    ask = "ask", f"{EXTERNAL_ASK} — merge PR qua MCP ({tool_name}) cần `expectedHeadSha` + `xt.py merge-check` = merge"
    n, sha = tool_input.get("pullNumber"), tool_input.get("expectedHeadSha")
    owner, repo = tool_input.get("owner"), tool_input.get("repo")
    # Chỉ server GitHub chính (`mcp__github__…`): server khác cùng tên tool có thể trỏ host khác với repo merge-check đọc.
    if tool_name != "mcp__github__merge_pull_request" or set(tool_input) - MCP_MERGE_KEYS:
        return ask
    if not (type(n) is int and n > 0 and isinstance(sha, str) and sha):
        return ask
    if not (isinstance(owner, str) and isinstance(repo, str)):
        return ask
    if tool_input.get("merge_method", "squash") not in MERGE_METHODS:
        return ask
    return _merge_verdict([str(n)], sha, root, f"{owner}/{repo}")


def _merge_verdict(selector: List[str], sha: str, root: str, repo: str = "") -> Tuple[str, str]:
    """`allow` khi `xt.py merge-check` (PR theo selector; rỗng = nhánh hiện tại) trả merge, head đã kiểm = `sha` (và repo
    trùng nếu có); không thì ask."""
    d = merge_check(selector, root)
    raw = d.get("reasons")
    reasons = "; ".join(str(x) for x in raw) if isinstance(raw, list) else ""
    if d.get("verdict") != "merge":
        return "ask", f"{EXTERNAL_ASK} — merge-check: {d.get('verdict')}: {reasons}"
    if d.get("head") != sha:
        return "ask", f"{EXTERNAL_ASK} — head đã kiểm {d.get('head')} khác {sha}"
    if repo and str(d.get("repo", "")).lower() != repo.lower():
        return "ask", f"{EXTERNAL_ASK} — merge-check kiểm repo {d.get('repo') or '?'}, không phải {repo}"
    return "allow", f"merge-check: {reasons}"


def _gh_api_merge_rule(args: List[str], root: str) -> Tuple[str, str]:
    """`gh api` ghi → ask; trừ merge REST ghim head (`-X PUT repos/{owner}/{repo}/pulls/N/merge -f sha=… [-f
    merge_method=…]`, mỗi khoá một lần, không `@file`) mà merge-check cho phép (LOOP-STOP-022)."""
    ask = "ask", f"{EXTERNAL_ASK} — `gh api` ghi lên GitHub (merge/cấu hình phải qua lệnh có kiểm)"
    pos = _positionals(args, GH_API_VALUE_FLAGS)
    m = REST_MERGE_PATH_RE.fullmatch(pos[0]) if len(pos) == 1 else None
    pairs = [v.partition("=") for v in _gh_api_field_values(args)]
    fields = {k: v for k, _, v in pairs}
    flags = {a.split("=", 1)[0] for a in args if a.startswith("-")} - {"-X", "--method", "-f", "--raw-field"}
    if not m or _gh_api_methods(args) != ["PUT"] or flags or len(fields) != len(pairs) or not fields.get("sha"):
        return ask
    if set(fields) - {"sha", "merge_method"} or fields.get("merge_method", "squash") not in MERGE_METHODS:
        return ask
    return _merge_verdict([m[1]], fields["sha"], root)


def _external_rule(name: str, args: List[str], root: str) -> Tuple[str, str]:
    """Hành động đối ngoại/triển khai thật → ask; `gh pr merge` qua `xt.py merge-check` (ADR-0013)."""
    if name == "gh" and args[:2] == ["pr", "merge"] and not set(args[2:]) & HELP_FLAGS:
        return gh_pr_merge_rule(args[2:], root)
    if name == "gh" and args[:1] == ["pr"] and "merge" in args[2:4]:  # `gh pr -R o/r merge`: cờ repo của `pr`
        return "ask", f"{EXTERNAL_ASK} — `gh pr <cờ> merge` (repo khác) không tự merge"
    if name == "gh" and args[:2] in (["alias", "set"], ["alias", "import"]):
        return "ask", "gh alias đặt lệnh tắt — guard không thấy lệnh thật khi alias chạy"
    if name == "gh" and args[:1] == ["api"] and _gh_api_writes(args[1:]):
        return _gh_api_merge_rule(args[1:], root)
    verdict = _publish_rule(name, args)
    return verdict if verdict[0] else egress_rule(name, args)


def _publish_rule(name: str, args: List[str]) -> Tuple[str, str]:
    """publish/deploy/push ra ngoài → ask; nhận cả `python -m <mô-đun>` và trình chạy gói (`npx wrangler deploy`)."""
    if name in INTERPRETERS and args[:1] == ["-m"] and len(args) > 1:
        name, args = args[1], args[2:]
    idx = _runner_target([name, *args])
    if idx > 0:
        name, args = posixpath.basename([name, *args][idx]), [name, *args][idx + 1 :]
    if set(args) and set(args) <= INFO_ONLY:
        return "", ""
    if name == "gh":
        hit = tuple(args[:1]) in GH_ASK or tuple(args[:2]) in GH_ASK
        return ("ask", EXTERNAL_ASK) if hit else ("", "")
    if name not in ASK_CMDS:
        return "", ""
    subs = ASK_CMDS[name]
    words = set(_positionals(args)) | {a for a in args if a.startswith("--")}
    return ("ask", EXTERNAL_ASK) if subs is None or words & set(subs) else ("", "")


# Ra khỏi máy dev (đề xuất chủ repo 2026-10-17): khi phiên chạy không hỏi quyền (`--permission-mode auto`, allow rộng ở
# settings người dùng), guard là lớp hỏi cuối — chạm máy chủ thật, gửi dữ liệu ra ngoài, kéo phụ thuộc mới, container
# có quyền máy chủ phải qua người. Máy cục bộ không hỏi (dev, test, CI hằng ngày).
EGRESS_ASK = "ra khỏi máy dev (điểm dừng bắt buộc)"
REMOTE_SHELLS = {"ssh", "sftp", "mosh", "telnet"}
REMOTE_COPY = {"scp", "rsync"}
REMOTE_VALUE_FLAGS = ("-e", "-i", "-P", "-p", "-F", "-o", "-J", "-l", "--rsh", "--port", "--exclude", "--include")
# Client CSDL → cờ chỉ máy chủ (`-h` của mongosh là trợ giúp nên không có); cờ chứa URI/conninfo.
DB_CLIENTS: Dict[str, Tuple[str, ...]] = {
    **dict.fromkeys(("psql", "pg_dump", "pg_dumpall", "pg_restore", "pg_basebackup"), ("-h", "--host")),
    **dict.fromkeys(("mysql", "mysqldump", "mariadb", "mariadb-dump", "redis-cli"), ("-h", "--host")),
    **dict.fromkeys(("mongosh", "mongo", "mongodump", "mongorestore"), ("--host",)),
}
DB_URI_FLAGS = ("-d", "--dbname", "-u", "--uri")
DB_VALUE_FLAGS = ("-c", "--command", "-f", "--file", "-e", "--execute", "--eval", "-U", "-p", "--port", "-o", "-v")
DB_HOST_ENV = {"PGHOST", "PGHOSTADDR", "MYSQL_HOST"}
LOCAL_HOSTS = {"localhost", "0.0.0.0", "::1", "host.docker.internal", "host.containers.internal"}
URL_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s'\"]*")
CONNINFO_HOST_RE = re.compile(r"(?:^|\s)host\s*=\s*([^\s'\"]+)")
SCP_REMOTE_RE = re.compile(r"(?:[^/@:\s]+@)?(\[[^\]]+\]|[^/:\s]+):")
PYTHON_RE = re.compile(r"python[0-9.]*")
# curl: cờ gửi dữ liệu + chữ của cờ ngắn gửi dữ liệu; cờ ăn giá trị để không hiểu nhầm giá trị là đích.
CURL_SEND_LONG = {"--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "--form"}
CURL_SEND_LONG |= {"--form-string", "--upload-file"}
CURL_SEND_SHORT = set("dFT")
CURL_VALUE_FLAGS: Tuple[str, ...] = (
    *("-d", "-F", "-T", "-H", "-o", "-u", "-X", "-A", "-e", "-b", "-c", "-w", "-x", "-m", "-r", "-K", "-E", "-U"),
    *("-C", "-Y", "-y", "-z", *CURL_SEND_LONG, "--header", "--output", "--user", "--request", "--user-agent"),
    *("--referer", "--cookie", "--cookie-jar", "--write-out", "--proxy", "--max-time", "--connect-timeout"),
    *("--retry", "--range", "--config", "--cacert", "--cert", "--key", "--resolve", "--connect-to", "--proxy-user"),
    *("--output-dir", "--limit-rate", "--max-filesize", "--retry-delay", "--retry-max-time", "--interface"),
    *("--trace", "--trace-ascii", "--stderr", "--dump-header", "-D", "--variable", "--url-query"),
)
WGET_SEND = ("--post-data", "--post-file", "--body-data", "--body-file")
WGET_VALUE_FLAGS: Tuple[str, ...] = (
    *WGET_SEND,
    "-O",
    "-o",
    "-a",
    "-P",
    "-U",
    "--header",
    "--method",
    "--output-document",
)
WGET_VALUE_FLAGS += ("--output-file", "--append-output", "--directory-prefix", "--user-agent", "--user", "--password")
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
# Trình quản lý gói → lệnh con thêm phụ thuộc; `True` = luôn là thêm, `False` = chỉ khi có tên gói (`npm install x`).
PKG_ADD: Dict[str, Dict[str, bool]] = {
    "npm": {"install": False, "i": False, "add": False, "isntall": False, "in": False},
    "pnpm": {"add": True, "install": False, "i": False},
    "yarn": {"add": True},
    "bun": {"add": True, "install": False, "i": False},
    "uv": {"add": True},
    "poetry": {"add": True},
    "pip": {"install": False},
    "pip3": {"install": False},
    "pipx": {"install": True},
    "cargo": {"add": True, "install": True},
    "go": {"get": True, "install": False},
    "gem": {"install": True},
    "composer": {"require": True},
    "deno": {"add": True, "install": False},
}
# Cờ ăn giá trị theo TỪNG trình quản lý (`-w` của npm là workspace, của pnpm là cờ boolean; `-r` của pip là file).
NODE_VALUE_FLAGS: Tuple[str, ...] = (
    "--filter",
    "-F",
    "-C",
    "--dir",
    "--prefix",
    "--cwd",
    "--registry",
    "--omit",
    "--include",
)
NODE_VALUE_FLAGS += ("--loglevel", "--reporter", "--workspace", "--tag", "--save-prefix")
PIP_VALUE_FLAGS: Tuple[str, ...] = (
    "-r",
    "--requirement",
    "-c",
    "--constraint",
    "-e",
    "--editable",
    "-t",
    "--target",
    "-i",
    "-f",
)
PIP_VALUE_FLAGS += ("--index-url", "--extra-index-url", "--find-links", "--python", "-p", "--platform", "--root")
PKG_VALUE_FLAGS: Dict[str, Tuple[str, ...]] = {
    "npm": (*NODE_VALUE_FLAGS, "-w"),
    "pnpm": NODE_VALUE_FLAGS,
    "yarn": NODE_VALUE_FLAGS,
    "bun": NODE_VALUE_FLAGS,
    "pip": PIP_VALUE_FLAGS,
    "pip3": PIP_VALUE_FLAGS,
    "uv": (*PIP_VALUE_FLAGS, "--package", "--group", "--optional"),
    "poetry": ("--group", "-G", "-C", "--directory", "--source"),
    "cargo": ("--path", "--git", "--branch", "--tag", "--rev", "--root", "-p", "--package", "--features", "-F"),
}
PKG_HELP = {"--help", "-h", "--version", "help"}
LOCAL_PKG_PREFIXES = (".", "/", "~", "file:", "link:", "workspace:", "portal:")
LOCAL_PKG_SUFFIXES = (".whl", ".tar.gz", ".tgz", ".zip")
# docker/podman: cờ trao quyền máy chủ, nguồn mount nhạy cảm, điều khiển daemon máy khác.
CONTAINER_HOST_NS = ("--pid", "--network", "--net", "--ipc", "--uts", "--userns", "--cgroupns")
DANGEROUS_CAPS = {"ALL", "SYS_ADMIN", "SYS_PTRACE", "SYS_MODULE", "SYS_RAWIO", "NET_ADMIN", "DAC_READ_SEARCH"}
SENSITIVE_MOUNTS = {"/", "/home", "/Users", "/root", "~", "$HOME", "${HOME}", "/etc", "/proc", "/sys", "/dev", "/boot"}
SENSITIVE_MOUNTS |= {"/run", "/var/run", "/var/lib/docker"}
SENSITIVE_MOUNT_PARTS = ("/.ssh", "/.aws", "/.kube", "/.docker", "/.gnupg", "/etc/", "/.config/gh", "/.claude")
HOME_DIR_RE = re.compile(r"/(home|Users)/[^/]+")
SAFE_RO_MOUNTS = {"/etc/localtime", "/etc/timezone"}


def _is_loopback(host: str) -> bool:
    h = host.strip().strip("[]").lower()
    return h in LOCAL_HOSTS or h.startswith("127.") or h == "localhost." or h.endswith(".localhost")


def _is_local_host(host: str) -> bool:
    """Máy cục bộ: loopback, socket unix, tên không có dấu chấm (dịch vụ compose/container: `db`, `postgres`)."""
    h = host.strip().strip("[]").lower()
    if not h or h.startswith("/") or _is_loopback(h):
        return True
    return "." not in h and ":" not in h


def _url_hosts(text: str) -> List[str]:
    """Máy chủ trong mọi URL của chuỗi (`postgres://u@h1,h2:5432/db` → h1, h2); bỏ cổng, thông tin đăng nhập."""
    out: List[str] = []
    for url in URL_RE.findall(text):
        netloc = url.split("://", 1)[1].split("/", 1)[0].split("?", 1)[0].rsplit("@", 1)[-1]
        for part in netloc.split(","):
            out.append(part.split("]", 1)[0] + "]" if part.startswith("[") else part.rsplit(":", 1)[0])
    return out


def _target_hosts(t: str) -> List[str]:
    """Máy chủ của đích curl/wget: URL có scheme, hoặc `host[:port]/path` không scheme."""
    return _url_hosts(t if "://" in t else "http://" + t)


def _flag_values(args: List[str], flags: Tuple[str, ...]) -> List[str]:
    """Mọi giá trị của cờ: `-h x`, `--host x`, `--host=x`, `-hx`."""
    out: List[str] = []
    for i, a in enumerate(args):
        for f in flags:
            if a == f and i + 1 < len(args):
                out.append(args[i + 1])
            elif f.startswith("--") and a.startswith(f + "="):
                out.append(a.split("=", 1)[1])
            elif not f.startswith("--") and a.startswith(f) and len(a) > len(f):
                out.append(a[len(f) :])
    return out


def _env_hosts(env: List[str]) -> List[str]:
    hosts: List[str] = []
    for k, _, v in (a.partition("=") for a in env):
        hosts += _url_hosts(v) if "://" in v and k != "DOCKER_HOST" else [v] if k in DB_HOST_ENV else []
    return hosts


def _docker_remote(endpoint: str) -> bool:
    """Daemon docker ở máy khác: `ssh://…` (kể cả alias), `tcp://` tới máy không loopback; `unix://`/`npipe://` cục bộ."""
    if endpoint.startswith(("unix://", "npipe://", "/")) or not endpoint:
        return False
    return endpoint.startswith("ssh://") or not all(_is_loopback(h) for h in _url_hosts(endpoint) or [endpoint])


def _db_rule(name: str, args: List[str], env: Optional[List[str]] = None) -> str:
    """Client CSDL tới máy chủ không cục bộ: cờ host, URI/conninfo ở đối số vị trí hoặc `-d`, `PGHOST=`/`…_URL=` gán đầu
    lệnh. Câu SQL (`-c`, `-f`) là dữ liệu, không quét."""
    hosts = _flag_values(args, DB_CLIENTS[name]) + _env_hosts(env or [])
    for a in _positionals(args, (*DB_CLIENTS[name], *DB_URI_FLAGS, *DB_VALUE_FLAGS)) + _flag_values(args, DB_URI_FLAGS):
        hosts += _url_hosts(a) + CONNINFO_HOST_RE.findall(a)
    remote = next((h for h in hosts if not h.startswith("$") and not _is_local_host(h)), "")
    return f"{EGRESS_ASK} — {name} tới máy chủ {remote}" if remote else ""


def _remote_rule(name: str, args: List[str]) -> str:
    """ssh/sftp/mosh/telnet vào máy không loopback; scp/rsync chép với máy không loopback (alias `~/.ssh/config` như
    `prod` không có dấu chấm vẫn là máy khác)."""
    pos = _positionals(args, REMOTE_VALUE_FLAGS)
    if name in REMOTE_SHELLS:
        if set(args) <= INFO_ONLY | {"-V"} or (pos and _is_loopback(pos[0].rsplit("@", 1)[-1])):
            return ""
        return f"{EGRESS_ASK} — {name} vào máy khác"
    for p in pos:
        if p.startswith(("/", ".", "~")):
            continue
        m = SCP_REMOTE_RE.match(p)
        host = next(iter(_url_hosts(p)), "") or (m.group(1) if m else "")
        if host and not _is_loopback(host):
            return f"{EGRESS_ASK} — {name} chép với máy {host}"
    return ""


def _curl_methods(args: List[str]) -> List[str]:
    """Phương thức của curl: `-X M`, `-XM`, `--request[=]M`, và cờ gộp `-sX M`/`-sXM`."""
    out = _flag_values(args, ("-X", "--request"))
    for i, a in enumerate(args):
        if re.fullmatch(r"-[A-Za-z]+X[A-Za-z]*", a) and not a.startswith("-X"):
            rest = a.split("X", 1)[1]
            out.append(rest or (args[i + 1] if i + 1 < len(args) else ""))
    return [m.upper() for m in out]


def _sends_data(name: str, args: List[str]) -> bool:
    if name == "wget":
        methods = _flag_values(args, ("--method",))
        return any(a.split("=", 1)[0] in WGET_SEND for a in args) or any(m.upper() != "GET" for m in methods)
    if "-G" in args or "--get" in args:  # dữ liệu thành query string của GET
        return False
    for a in args:
        if a.split("=", 1)[0] in CURL_SEND_LONG:
            return True
        if re.fullmatch(r"-[A-Za-z]+", a) and CURL_SEND_SHORT & set(a[1:].split("X", 1)[0]):
            return True
    return any(m in WRITE_METHODS for m in _curl_methods(args))


def _fetch_rule(name: str, args: List[str]) -> str:
    """curl/wget gửi dữ liệu tới máy ngoài; không đọc được đích (`$URL`) mà có gửi → hỏi."""
    if not _sends_data(name, args):
        return ""
    targets = _flag_values(args, ("--url",)) + _positionals(
        args, CURL_VALUE_FLAGS if name == "curl" else WGET_VALUE_FLAGS
    )
    hosts = [h for t in targets for h in _target_hosts(t)]
    remote = [h for h in hosts if h.startswith("$") or not _is_local_host(h)]
    return (
        f"{EGRESS_ASK} — {name} gửi dữ liệu tới {remote[0] if remote else 'đích không rõ'}"
        if remote or not hosts
        else ""
    )


def _is_local_pkg(p: str) -> bool:
    return p.startswith(LOCAL_PKG_PREFIXES) or "@workspace:" in p or ("://" not in p and p.endswith(LOCAL_PKG_SUFFIXES))


def _pkg_rule(name: str, args: List[str]) -> str:
    """Thêm phụ thuộc mới (chuỗi cung ứng — /research trước); cài theo lockfile/đường dẫn/gói nội bộ không hỏi."""
    subs = PKG_ADD[name]
    if name == "uv" and args[:2] == ["pip", "install"]:
        name, subs, args = "uv pip", {"install": False}, args[1:]
    if name == "cargo" and "--path" in args:
        return ""
    pos = _positionals(args, PKG_VALUE_FLAGS.get(name.split()[0], ()))
    i = next((k for k, p in enumerate(pos) if p in subs), -1)
    if i < 0 or any(a in PKG_HELP for a in args):
        return ""
    pkgs = [p for p in pos[i + 1 :] if not _is_local_pkg(p)]
    if not pkgs and (not subs[pos[i]] or pos[i + 1 :]):
        return ""
    return f"thêm phụ thuộc mới ({name} {pos[i]} {' '.join(pkgs[:3])}".rstrip() + ") — /research trước khi cài"


def _mount_source(spec: str) -> str:
    if spec.startswith(("type=", "source=", "src=")) or ",source=" in spec or ",src=" in spec:
        kv = dict(p.split("=", 1) for p in spec.split(",") if "=" in p)
        return kv.get("source") or kv.get("src") or ""
    return spec.split(":", 1)[0] if ":" in spec else ""


def _sensitive_mount(spec: str) -> str:
    src = _mount_source(spec)
    norm = src.rstrip("/") or src
    if norm in SAFE_RO_MOUNTS and (spec.endswith(":ro") or ",readonly" in spec or ",ro" in spec):
        return ""
    hit = norm in SENSITIVE_MOUNTS or HOME_DIR_RE.fullmatch(norm) or norm.endswith(".sock")
    return src if hit or any(p in src for p in SENSITIVE_MOUNT_PARTS) else ""


# `docker exec`/`docker compose exec|run`: cờ ăn giá trị trước tên container/dịch vụ (lệnh bên trong vẫn ra mạng thật).
EXEC_VALUE_FLAGS: Tuple[str, ...] = (
    "-u",
    "--user",
    "-w",
    "--workdir",
    "-e",
    "--env",
    "--env-file",
    "--detach-keys",
    "--entrypoint",
)
EXEC_VALUE_FLAGS += ("-v", "--volume", "-p", "--publish", "--name", "-l", "--label", "--index")
COMPOSE_VALUE_FLAGS = ("-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory")


def _skip_opts(rest: List[str], value_flags: Tuple[str, ...]) -> int:
    i = 0
    while i < len(rest) and rest[i].startswith("-"):
        i += 2 if rest[i] in value_flags else 1
    return i


def _exec_inner(args: List[str]) -> List[str]:
    """Lệnh chạy trong container: `docker exec [cờ] <ctr> <lệnh>`, `docker compose [cờ] exec|run [cờ] <dv> <lệnh>`."""
    if args[:1] == ["compose"]:
        i = _skip_opts(args[1:], COMPOSE_VALUE_FLAGS) + 1
        if args[i : i + 1] not in (["exec"], ["run"]):
            return []
    elif args[:1] != ["exec"]:
        return []
    else:
        i = 0
    rest = args[i + 1 :]
    return normalize(rest[_skip_opts(rest, EXEC_VALUE_FLAGS) + 1 :])


def _container_rule(args: List[str]) -> str:
    """`docker|podman` điều khiển daemon máy khác (`-H`, `--context`), hoặc `[container] run|create` có quyền máy chủ:
    privileged, namespace của host, cap nguy hiểm, thiết bị, unconfined, mount gốc/home/bí mật/socket."""
    remote = any(_docker_remote(h) for h in _flag_values(args[:2], ("-H", "--host")))
    if remote or _flag_values(args[:2], ("--context", "-c")):
        return f"{EGRESS_ASK} — container trên daemon máy khác"
    if args[:1] == ["container"]:
        args = args[1:]
    inner = _exec_inner(args)
    if inner:
        verdict = egress_rule(inner[0], inner[1:])
        return f"{verdict[1]} (trong container)" if verdict[0] else ""
    if args[:1] not in (["run"], ["create"]):
        return ""
    opts = args[1:]
    why = ""
    if "--privileged" in opts or any(a.startswith("--privileged=") and a != "--privileged=false" for a in opts):
        why = "--privileged"
    why = why or next((f"{f}=host" for f in CONTAINER_HOST_NS if "host" in _flag_values(opts, (f,))), "")
    caps = {c.upper().removeprefix("CAP_") for v in _flag_values(opts, ("--cap-add",)) for c in v.split(",")}
    why = why or ("--cap-add " + ",".join(sorted(caps & DANGEROUS_CAPS)) if caps & DANGEROUS_CAPS else "")
    why = why or ("--device" if _flag_values(opts, ("--device",)) else "")
    unconfined = any("unconfined" in v for v in _flag_values(opts, ("--security-opt",)))
    why = why or ("--security-opt unconfined" if unconfined else "")
    mounts = [m for m in map(_sensitive_mount, _flag_values(opts, ("-v", "--volume", "--mount"))) if m]
    why = why or (f"mount {mounts[0]}" if mounts else "")
    return f"container có quyền máy chủ ({why})" if why else ""


def egress_rule(name: str, args: List[str]) -> Tuple[str, str]:
    """Kết nối/gửi ra máy khác, thêm phụ thuộc, container có quyền máy chủ → ask (không deny: việc hợp lệ khi người duyệt)."""
    if (name in INTERPRETERS or PYTHON_RE.fullmatch(name)) and args[:1] == ["-m"] and len(args) > 1:
        name, args = args[1], args[2:]
    why = ""
    if name in REMOTE_SHELLS or name in REMOTE_COPY:
        why = _remote_rule(name, args)
    elif name in DB_CLIENTS:
        why = _db_rule(name, args)
    elif name in FETCHERS:
        why = _fetch_rule(name, args)
    elif name in PKG_ADD:
        why = _pkg_rule(name, args)
    elif name in ("docker", "podman"):
        why = _container_rule(args)
    return ("ask", why) if why else ("", "")


# Cách mở phiên Claude Code KHÔNG chạy hook của dự án (LOOP-HARNESS-018): agent tự đặt được → người phải xác nhận.
# Nguồn: Claude Code docs *CLI reference* (`--bare`, `--safe-mode`, `--settings`, `--setting-sources`, `--restricted`;
# `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_SAFE_MODE`) và *Hooks* (`disableAllHooks`), đọc 2026-10-15.
# Giới hạn đã biết (phân tích tĩnh): `eval`, alias, biến chứa cờ, chuỗi ghép lúc chạy (`sh -c`, heredoc/pipe vào shell
# được quét đệ quy ở `bash_decision` — AUD-SEC-017).
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


def hook_bypass(argv: List[str], n: List[str]) -> str:
    """Lý do hỏi nếu lệnh tắt/bỏ qua hook của dự án; chuỗi rỗng nếu không."""
    claude = _claude_args(n) or []
    hit = _bypass_marker(argv, n, claude)
    if hit:
        return f"lệnh đặt `{hit}` (tắt hook của khung)"
    flag = next((a.split("=", 1)[0] for a in claude if a.split("=", 1)[0] in HOOK_BYPASS_FLAGS), "")
    return f"phiên Claude với `{flag}` có thể bỏ qua hook của dự án" if flag else ""


REDIRECTS = (">", ">>", ">|", "&>", "&>>")


def _copy_targets(name: str, args: List[str]) -> List[str]:
    """cp/install/ln: thư mục `-t` hoặc đích cuối; mv: cả nguồn (bị dời đi = xoá ở chỗ cũ) lẫn đích (AUD-SEC-019)."""
    t_dir = _flag_value(args, "-t") or _flag_value(args, "--target-directory")
    pos = _positionals(args, ("-t", "--target-directory", "-m", "--mode", "-S", "--suffix"))
    if t_dir:  # `-t DIR nguồn…`: file đích là DIR/<tên nguồn>
        dests = [posixpath.join(t_dir, posixpath.basename(s)) for s in pos]
        return dests + (pos if name == "mv" else [])
    if name == "mv":
        return pos
    return pos[-1:] if len(pos) >= 2 else []


def _inplace_targets(name: str, args: List[str]) -> List[str]:
    """sed -i / perl -i: file được sửa tại chỗ (bỏ script `-e`/`-f`, và script đầu khi không có `-e`)."""
    if name == "sed" and any(x == "-i" or x.startswith(("-i", "--in-place")) for x in args):
        pos = _positionals(args, ("-e", "-f", "--expression", "--file"))
        return pos if any(x in ("-e", "-f") or x.startswith(("--expression", "--file")) for x in args) else pos[1:]
    if name == "perl" and any(x.startswith("-") and not x.startswith("--") and "i" in x[1:] for x in args):
        return _positionals(args, ("-e", "-E", "-M", "-I"))
    return []


def write_targets(n: List[str], argv: List[str]) -> List[str]:
    """File mà lệnh có thể ghi/xoá: chuyển hướng, `sed -i`/`perl -i`, `tee`, cp/mv/install/ln, truncate/rm, `git rm/mv`."""
    out = [argv[i + 1] for i, t in enumerate(argv[:-1]) if t in REDIRECTS]
    name, args = (n[0], n[1:]) if n else ("", [])
    if name == "git" and args[:1] in (["rm"], ["mv"]):
        return out + _positionals(args[1:])
    if name == "tee":
        return out + _positionals(args)
    if name in ("cp", "mv", "install", "ln"):
        return out + _copy_targets(name, args)
    if name in ("rm", "unlink", "shred"):
        return out + _positionals(args)  # `-f` của rm là cờ, không ăn giá trị (từng nuốt đường dẫn)
    if name == "truncate":
        return out + _positionals(args, ("-s", "--size", "-r", "--reference"))
    return out + _inplace_targets(name, args)


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
        kind = _target_kind(target, root)
        if kind == "secret":
            asks.append(f"ghi file bí mật qua Bash: {target}")
        elif kind in ("gate", "migration"):
            asks.append(f"sửa cấu hình cổng/CI/harness/migration qua Bash ({target}) — nói rõ lý do")
        elif kind == "evidence":
            asks.append(f"ghi/xoá tay bằng chứng autopilot qua Bash ({target}) — chỉ `xt.py loop …` được ghi (P1)")
        elif kind == "capability":
            asks.append(CAPABILITY_WHY.format(f"ghi {target} qua Bash"))
        elif _existing_test(target, root):
            asks.append(f"sửa/xoá test ĐÃ CÓ qua Bash ({target}) — làm yếu test là nới cổng (LOOP-CI-001)")
    return asks


def _target_kind(target: str, root: str) -> str:
    """classify_path của đích ghi; đích là THƯ MỤC cổng (`cp x .claude/hooks/`) cũng là cổng."""
    if not target or target.startswith("/dev/"):
        return ""
    rel = rel_path(target, root).rstrip("/")
    return path_kind(rel, root) or ("gate" if _dir_holds_gate(rel, root) else "")


def _dir_holds_gate(rel: str, root: str) -> bool:
    """Đích là THƯ MỤC chứa file cổng (`cp x .claude/hooks/`, `rm -rf .claude`, `mv scripts …`) — reviewer #60."""
    if classify_path(rel + "/_") == "gate" or any(p.startswith(rel + "/") for p in GATE_PATTERNS):
        return True
    d, names = os.path.join(root, rel), []
    with contextlib.suppress(OSError):  # không đọc được thư mục → coi như không chứa file cổng
        names = os.listdir(d) if os.path.isdir(d) and not os.path.islink(d) else []
    return any(classify_path(f"{rel}/{name}") == "gate" for name in names)


def _existing_test(target: str, root: str) -> bool:
    """File test đã có (AUD-HAR-026): Bash xoá/dời/sửa tại chỗ thì không thấy được nội dung đổi → hỏi."""
    if not target or target.startswith("/dev/"):
        return False
    rel = rel_path(target, root)
    return _match_any(rel, TEST_PATTERNS) and os.path.isfile(os.path.join(root, rel))


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
    # Lệnh khác git (rm/find) xét đích theo thư mục đang đứng sau `cd` (`cd ~ && rm -rf projects`).
    decision, why = command_rules(n, root, (gdir if n[0] == "git" else cwd) or root)
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
    if n[0] in (*DB_CLIENTS, "docker", "podman") and decision != "ask":  # `PGHOST=… psql`: normalize đã bóc phần gán
        assigns = [t for t in argv[: len(argv) - len(n)] if ENV_ASSIGN_RE.fullmatch(t)]
        docker = [v for k, _, v in (a.partition("=") for a in assigns) if k == "DOCKER_HOST" and _docker_remote(v)]
        remote = next((h for h in _env_hosts(assigns) if not _is_local_host(h)), "") or next(iter(docker), "")
        if remote:
            asks.append(f"{EGRESS_ASK} — {n[0]} tới máy chủ {remote}: {' '.join(argv)[:200]}")
    if n[:2] == ["git", "commit"]:
        # Cổng chạy ở repo NHẬN commit (`cd ../khac && git commit`, `git -C ../khac commit`), không phải gốc phiên.
        res["commit_dir"] = gdir or ""
        return _scan_commit(n[2:], res, asks)
    return None


MAX_NEST = 3  # độ sâu shell lồng được quét (`bash -c "bash -c '…'"`); sâu hơn → hỏi


SHELL_OPTS_WITH_VALUE = {"-o", "+o", "-O", "+O", "--rcfile", "--init-file"}
# Đường dẫn tới chính stdin: `bash /dev/stdin <<E` đọc lệnh từ heredoc như `bash <<E` (AUD-SEC-028).
STDIN_SCRIPTS = {"/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"}


def _shell_opt_width(a: str) -> int:
    """Số token một cờ shell chiếm (`-o pipefail`/`-eo pipefail` = 2, `--norc`/`-e`/`+x` = 1); 0 = không phải cờ."""
    if a in SHELL_OPTS_WITH_VALUE or (len(a) > 2 and a[0] in "-+" and a[1] != "-" and a[-1] in "oO"):
        return 2
    return 1 if len(a) > 1 and a[0] in "-+" else 0


def _shell_script_arg(n: List[str]) -> Tuple[bool, Optional[str]]:
    """Duyệt cờ của shell như bash: (có `-c`, đối số không-phải-cờ ĐẦU TIÊN = chuỗi lệnh khi có `-c`, tên file script
    khi không; None khi đọc stdin). Cờ đứng SAU `-c` vẫn là cờ (`bash -c -e '…'`), `--`/`-` kết thúc tuỳ chọn, `-s` đọc
    stdin (AUD-SEC-028). Reviewer #60: dừng ở cờ dài/`-o` từng làm lọt `bash -o pipefail -c`."""
    has_c = has_s = False
    i = 1
    while i < len(n):
        a = n[i]
        if a in ("--", "-"):
            i += 1
            break
        width = _shell_opt_width(a)
        if not width:
            break
        if width == 1 and a[0] == "-" and a[1] != "-":
            has_c, has_s = has_c or "c" in a[1:], has_s or "s" in a[1:]
        i += width
    script = n[i] if i < len(n) else None
    return has_c, None if has_s and not has_c else script


def _stdin_shell(argv: List[str]) -> bool:
    """Shell đọc script từ stdin: tên shell, không `-c`, không file script (bỏ chuyển hướng `<<E`, `< f` cùng đích)."""
    n = normalize(argv)
    if not n or n[0] not in SHELLS:
        return False
    rest = [a for i, a in enumerate(n) if not _is_redirect(a) and not (i > 0 and _is_redirect(n[i - 1]))]
    has_c, script = _shell_script_arg(rest)
    stdin = script is None or script in STDIN_SCRIPTS
    return not has_c and stdin and "-n" not in rest  # `bash -n`: chỉ kiểm cú pháp


def _shell_c_script(argv: List[str]) -> Optional[str]:
    """Chuỗi lệnh của `sh -c '<lệnh>'` (cả cờ gộp `-lc`, `-ec`, sau `-o pipefail`, `--norc`…); None nếu không phải."""
    n = normalize(argv)
    if not n or n[0] not in SHELLS:
        return None
    has_c, script = _shell_script_arg(n)
    return script if has_c else None


def _heredoc_scripts(cmd: str, pred: Callable[[List[str]], bool] = _stdin_shell) -> List[str]:
    """Thân heredoc đưa vào shell (`bash <<'E'` … `E`; `pred` chọn lệnh nhận) — là lệnh, không phải dữ liệu."""
    out: List[str] = []
    lines = cmd.replace("\\\n", "").split("\n")
    i = 0
    while i < len(lines):
        delims = [m.group(2) for m in HEREDOC_RE.finditer(lines[i])]
        opener, i = lines[i], i + 1
        for d in delims:
            body: List[str] = []
            while i < len(lines) and lines[i].strip() != d:
                body.append(lines[i])
                i += 1
            i += 1
            if any(pred(c) for c in split_commands(tokenize(opener))):
                out.append("\n".join(body))
    return out


def _echoed_scripts(src: List[str]) -> List[str]:
    """Chuỗi `echo …`/`printf …` sẽ thành lệnh khi vào shell. printf có `%`: định dạng và từng đối số được quét riêng
    (`printf '%s\\n' 'rm -rf ~' | sh`, AUD-SEC-028); `\\n` trong định dạng là xuống dòng."""
    words = src[1:]
    if src[0] == "printf":
        if words and "%" in words[0]:
            return [words[0].replace("\\n", "\n"), *words[1:]]
        return [" ".join(words).replace("\\n", "\n")]
    while words and words[0] in ("-n", "-e", "-E", "-ne", "-en"):
        words = words[1:]  # cờ của echo; phần còn lại (kể cả `--hard`) là lệnh sẽ chạy
    return [" ".join(words)]


def _here_strings(tokens: List[str]) -> List[str]:
    """Here-string vào shell (`bash <<< '…'`): chuỗi là lệnh (AUD-SEC-028)."""
    return [c[i + 1] for c in split_commands(tokens) if _stdin_shell(c) for i, t in enumerate(c[:-1]) if t == "<<<"]


def _backtick_scripts(cmd: str) -> List[str]:
    """Thân `` `…` `` (thay lệnh kiểu cũ) ngoài nháy đơn — shlex không tách backtick nên lệnh bên trong từng lọt."""
    out: List[str] = []
    quote, start, i = "", -1, 0
    while i < len(cmd):
        c = cmd[i]
        if c == "\\" and quote != "'":
            i += 2
            continue
        if c == "'" and start < 0 and quote != '"':
            quote = "" if quote == "'" else "'"
        elif c == '"' and quote != "'" and start < 0:
            quote = "" if quote == '"' else '"'
        elif c == "`" and quote != "'":
            if start < 0:
                start = i + 1
            else:
                out.append(cmd[start:i])
                start = -1
        i += 1
    return out


def _eval_scripts(tokens: List[str]) -> List[str]:
    """`eval '<lệnh>'`: shell ghép các đối số rồi chạy như một dòng lệnh."""
    return [" ".join(n[1:]) for c in split_commands(tokens) for n in [normalize(c)] if n[:1] == ["eval"] and n[1:]]


def _nested_scripts(cmd: str, tokens: List[str]) -> List[str]:
    """Lệnh chạy lồng (AUD-SEC-017): `sh -c '…'`, heredoc/here-string vào shell, `echo/printf '…' | sh`, `eval '…'`,
    backtick."""
    out = [s for c in split_commands(tokens) for s in [_shell_c_script(c)] if s]
    out += _eval_scripts(tokens) + _backtick_scripts(strip_heredocs(cmd))
    for pipe in pipelines(tokens):
        for up, down in zip(pipe, pipe[1:]):
            src = normalize(up)
            if src[:1] in (["echo"], ["printf"]) and _stdin_shell(down):
                out += _echoed_scripts(src)
    return out + _here_strings(tokens) + _heredoc_scripts(cmd)


def _opaque_shells(tokens: List[str]) -> List[str]:
    """Shell chạy lệnh guard không đọc được (AUD-SEC-028): ống từ nguồn khác echo/printf/heredoc vào shell
    (`… | tee /dev/null | bash`, `cat run.sh | bash`), `bash -c` không kèm chuỗi lệnh (`xargs bash -c`)."""
    asks: List[str] = []
    for pipe in pipelines(tokens):
        for up, down in zip(pipe, pipe[1:]):
            src = normalize(up)
            known = src[:1] in (["echo"], ["printf"]) or "<<" in up
            if _stdin_shell(down) and not known:
                asks.append(f"shell đọc lệnh từ ống `{' '.join(up)[:80]}` — guard không thấy lệnh sẽ chạy")
    for c in split_commands(tokens):
        n = normalize(c)
        if n and n[0] in SHELLS and _shell_script_arg(n) == (True, None):
            asks.append("`sh -c` không kèm chuỗi lệnh (lệnh đến từ stdin/xargs) — guard không thấy lệnh sẽ chạy")
    return asks


def _scan_nested(cmd: str, tokens: List[str], root: str, cwd: Optional[str], depth: int, asks: List[str]) -> str:
    """Quét đệ quy lệnh lồng; trả lý do deny (rỗng nếu không), thêm câu hỏi vào `asks`."""
    asks += _opaque_shells(tokens)
    for script in _nested_scripts(cmd, tokens):
        if depth >= MAX_NEST:
            asks.append("shell lồng quá sâu — guard không quét hết")
            break
        sub = bash_decision(script, root, cwd, depth + 1)
        if sub["decision"] == "deny":
            return str(sub["reason"])
        if sub["decision"] in ("ask", "allow") or sub["commit"]:
            asks.append(f"lệnh lồng trong shell: {str(sub['reason']) or 'git commit (cổng commit không chạy được)'}")
    return ""


# --------------------------------------------------------------------------- rà stored 2026-10-16

INTERP_RE = re.compile(r"(python|node|perl|ruby|php|deno|bun)[0-9.]*")
INTERP_SCRIPT_FLAGS = {"-c", "-e", "-E", "--eval", "-p", "--print", "-r"}
# Dấu hiệu script GHI/XOÁ file (đọc thì không hỏi): open(..., "w"), .write_text(, os.remove, shutil.*, fs.writeFileSync…
WRITE_HINT_RE = re.compile(
    r"open\([^)]*,\s*(?:mode\s*=\s*)?[rbt]?['\"][rbt]?[wax+]|\.(?:write_text|write_bytes|unlink|rmdir|rename|replace|touch)\("
    r"|\b(?:os\.(?:remove|unlink|rename|replace|truncate)|shutil\.\w+|writeFile\w*|appendFile\w*|rmSync|unlinkSync"
    r"|renameSync|copyFile\w*|File\.write|IO\.write|file_put_contents|unlink)\b"
)
STR_LITERAL_RE = re.compile(r"""['"]([^'"\s]{2,})['"]""")
GUARDED_KINDS = {"secret", "gate", "evidence", "capability"}


def _stdin_interp(argv: List[str]) -> bool:
    n = normalize(argv)
    return bool(n) and bool(INTERP_RE.fullmatch(n[0])) and not set(n[1:]) & INTERP_SCRIPT_FLAGS


def _interp_scripts(cmd: str, tokens: List[str]) -> List[str]:
    """Script trình thông dịch viết ngay trong lệnh: `python3 -c '…'`, `node -e '…'`, `python3 - <<'PY'` … `PY`."""
    out: List[str] = []
    for c in split_commands(tokens):
        n = normalize(c)
        if n and INTERP_RE.fullmatch(n[0]):
            out += [n[i + 1] for i, a in enumerate(n[:-1]) if a in INTERP_SCRIPT_FLAGS]
    return out + _heredoc_scripts(cmd, _stdin_interp)


def interp_write_asks(cmd: str, tokens: List[str], root: str) -> List[str]:
    """Script trình thông dịch ghi/xoá file bí mật/cổng/bằng chứng/năng lực agent → hỏi, như Edit/chuyển hướng
    (LOOP-STOP-025: bị chặn ở Edit thì không đổi sang `python -c` để lách). Phân tích tĩnh, chỉ chữ nguyên văn."""
    asks: List[str] = []
    for script in _interp_scripts(cmd, tokens):
        if not WRITE_HINT_RE.search(script):
            continue
        for lit in STR_LITERAL_RE.findall(script):
            kind = path_kind(rel_path(lit, root), root) if ("/" in lit or "." in lit) and lit not in ("..",) else ""
            if kind in GUARDED_KINDS:
                asks.append(f"script trình thông dịch ghi/xoá {lit} ({kind}) — dùng đúng công cụ hoặc người duyệt")
    return asks


CURL_FILE_FLAGS = {"-T", "--upload-file", "--post-file", "--body-file"}  # giá trị là đường dẫn file
CURL_DATA_FLAGS = {"-d", "--data", "--data-binary", "--data-urlencode", "--json", "-F", "--form"}


def _fetch_values(args: List[str]) -> List[Tuple[str, str]]:
    """(cờ, giá trị) của các cờ gửi dữ liệu/tải lên của curl/wget: `-d @f`, `-d@f`, `--data=@f`, `-F a=@f`, `-T f`."""
    out: List[Tuple[str, str]] = []
    flags = CURL_FILE_FLAGS | CURL_DATA_FLAGS
    for i, a in enumerate(args):
        if a in flags and i + 1 < len(args):
            out.append((a, args[i + 1]))
        elif a.startswith("--") and "=" in a and a.split("=", 1)[0] in flags:
            out.append(tuple(a.split("=", 1)))  # type: ignore[arg-type]
        elif a[:2] in ("-d", "-F", "-T") and len(a) > 2 and not a.startswith("--"):
            out.append((a[:2], a[2:]))
    return out


def _fetch_files(args: List[str]) -> List[str]:
    """File mà curl/wget đọc để gửi đi (`-` = stdin)."""
    files: List[str] = []
    for flag, val in _fetch_values(args):
        if flag in CURL_FILE_FLAGS:
            files.append(val)
        elif flag in ("-F", "--form"):
            part = val.split("=", 1)[-1]
            files += [part[1:].split(";")[0]] if part[:1] in ("@", "<") else []
        elif flag == "--data-urlencode" and "@" in val:
            files.append(val.split("@", 1)[1])
        elif val.startswith("@"):
            files.append(val[1:])
    redirect_in = [args[i + 1] for i, t in enumerate(args[:-1]) if t == "<"]
    return files + redirect_in


def _is_secret_file(path: str, root: str) -> bool:
    return path not in ("-", "") and classify_path(rel_path(path, root)) == "secret"


def secret_exfil(tokens: List[str], root: str) -> Optional[str]:
    """Gửi file bí mật/biến môi trường ra mạng: `curl -d @.env …`, `curl -T .env …`, `cat .env | curl -d @- …`,
    `env | curl --data-binary @- …` (rà stored 2026-10-16: Read(.env) bị chặn nhưng Bash thì không)."""
    for group in pipelines(tokens):
        for i, c in enumerate(group):
            n = normalize(c)
            if not n or n[0] not in FETCHERS:
                continue
            files = _fetch_files(c[1:])
            leaked = [f for f in files if _is_secret_file(f, root)]
            if not leaked and "-" in files:  # đọc stdin: xem lệnh phía trước trong ống
                for up in group[:i]:
                    head = posixpath.basename(up[0]) if up else ""
                    nu = normalize(up)
                    if (
                        (head == "env" and not nu)
                        or head == "printenv"
                        or any(_is_secret_file(a, root) for a in up[1:])
                    ):
                        leaked.append(" ".join(up)[:60])
            if leaked:
                return f"gửi bí mật ra mạng ({leaked[0]})"
    return None


def bash_decision(cmd: str, root: str, cwd: Optional[str] = None, depth: int = 0) -> Dict[str, object]:
    """Quyết định cho một lệnh Bash: deny/ask/"" kèm cờ `commit`, `no_verify`, `commit_dir` cho hook cổng commit.
    `cwd` = thư mục lệnh bắt đầu chạy (payload hook); `cd <dir>` trong lệnh dời nó để biết commit rơi vào repo nào.
    `depth` = độ sâu shell lồng (`sh -c`, heredoc/pipe vào shell) đang quét."""
    tokens = tokenize(cmd)
    res: Dict[str, object] = {"decision": "", "reason": "", "commit": False, "no_verify": False, "commit_dir": ""}
    rx = remote_exec(cmd, tokens)
    if rx:
        res.update(
            decision="deny",
            reason=f"Cấm chạy script tải từ mạng ({rx}): tải về, kiểm checksum rồi mới chạy. Lệnh: {cmd[:300]}",
        )
        return res
    leak = secret_exfil(tokens, root)
    if leak:
        res.update(decision="deny", reason=f"Lệnh bị khung chặn ({leak}): {cmd[:300]}")
        return res
    asks: List[str] = interp_write_asks(cmd, tokens, root)
    nested_deny = _scan_nested(cmd, tokens, root, cwd, depth, asks)
    if nested_deny:
        res.update(decision="deny", reason=nested_deny)
        return res
    commands = _commands_with_cwd(tokens, cwd or root)
    for argv, here in commands:
        deny_reason = _scan_command(argv, root, res, asks, here)
        if deny_reason:
            res.update(decision="deny", reason=deny_reason)
            return res
    allow = res.pop("allow", "")
    # `allow` bỏ hỏi cho CẢ lệnh Bash → chỉ khi merge đứng một mình và trơn (không gì shell còn mở rộng/chạy thêm).
    if allow and (len(commands) > 1 or not PLAIN_MERGE_RE.fullmatch(cmd.strip())):
        asks.append(f"{EXTERNAL_ASK} — tự merge chỉ khi lệnh đứng một mình")
    if asks:
        res.update(decision="ask", reason="Khung cần xác nhận: " + "; ".join(dict.fromkeys(asks)))
    elif allow:
        res.update(decision="allow", reason=f"Khung cho tự merge (ADR-0013) — {allow}")
    return res


# Lệnh merge/ghi GitHub: guard lỗi giữa chừng với lệnh này thì hỏi thay vì cho qua (fail-closed cho merge).
MERGE_CMD_RE = re.compile(r"\bgh\s+(pr\b.*\bmerge|api)\b", re.S)


def _failure_decision(mode: str, payload: object, cmd: object) -> Dict[str, object]:
    """Quyết định khi guard ném lỗi: fail-open về luồng (ADR-0002), trừ merge/`gh api` và tool MCP merge (payload đọc
    được — stdin rác không phải lời gọi tool, LOOP-HARNESS-018) → hỏi."""
    if (mode == "mcp" and isinstance(payload, dict)) or (
        mode == "bash" and isinstance(cmd, str) and MERGE_CMD_RE.search(cmd)
    ):
        return {"decision": "ask", "reason": "guard lỗi khi kiểm merge/ghi GitHub — cần người xác nhận"}
    return {"decision": ""}


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    payload: Any = None
    cmd: object = None
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
        elif mode == "mcp":
            name = payload.get("tool_name")
            d, r = mcp_decision(name, tool_input, root) if isinstance(name, str) else ("", "")
            out = {"decision": d, "reason": r}
        else:
            out = {"decision": ""}
    except Exception:  # fail-open về luồng: lỗi của hook không được kẹt phiên — trừ merge (AUD-SEC-032)
        out = _failure_decision(mode, payload, cmd)
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
