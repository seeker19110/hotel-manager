#!/usr/bin/env python3
"""guard.py — phân tích lệnh/đường dẫn cho hook PreToolUse của khung X-Templates (chỉ thư viện chuẩn).

Dùng (payload JSON của Claude Code trên stdin, kết quả JSON trên stdout):
  guard.py bash   → {"decision": "deny"|"ask"|"", "reason": "...", "commit": true|false, "no_verify": true|false,
                     "commit_dir": "<thư mục git commit chạy, rỗng nếu không biết>"}
  guard.py edit   → {"decision": "deny"|"ask"|"", "reason": "..."}  (file bí mật/cổng/migration; test ĐÃ CÓ bị làm yếu)
  guard.py mcp    → {"decision": "allow"|"ask"|"", "reason": "..."}  (tool MCP merge PR: allow chỉ khi merge-check cho phép)
  guard.py <mode> nul → cùng kết quả, dạng `ok\0<decision>\0<reason>\0<commit>\0<no_verify>\0<commit_dir>\0` để hook đọc
                     bằng `read -d ''` (bash 3.2 được), khỏi sinh thêm tiến trình python chỉ để tách trường JSON.

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
import urllib.parse
import sys
import tempfile
import time
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
    "exec": {"-a"},  # `exec -a <tên> git push --force` (AUD-SEC-024)
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


# Công tắc tắt hook ghi qua Edit/Write vào settings/`.env`/rc (AUD-SEC-046) — như `hook_bypass` cho Bash.
BYPASS_ON_RE = re.compile(r'"disableAllHooks"\s*:\s*true|\b(?:CLAUDE_CODE_SIMPLE|CLAUDE_CODE_SAFE_MODE)\b["\']?\s*[:=]')


def _bypass_edit(path: str, tool_input: Optional[Dict[str, object]]) -> str:
    """Công tắc tắt hook trong nội dung MỚI ghi vào file cấu hình (settings*.json, `.env`, rc của shell); không thì ''."""
    b = posixpath.basename(path)
    if not tool_input or not (b.endswith((".json", ".env")) or b in RC_FILES):
        return ""
    texts = [_text(tool_input.get("new_string")), _text(tool_input.get("content"))]
    edits = tool_input.get("edits")
    if isinstance(edits, list):
        texts += [_text(e.get("new_string")) for e in edits if isinstance(e, dict)]
    m = BYPASS_ON_RE.search("\n".join(texts))
    return m.group(0) if m else ""


# Git hook và cấu hình git của repo: không nằm trong commit (không có dấu vết PR) — sửa = tắt/bỏ qua hook của dự án.
GIT_HOOK_PATTERNS = (".git/hooks", ".git/hooks/*", ".git/config")
GIT_HOOK_WHY = "ghi {} — git hook/cấu hình git không vào commit, sửa là bỏ qua hook của dự án; người làm tay"


def edit_decision(path: str, root: str, tool_input: Optional[Dict[str, object]] = None) -> Tuple[str, str]:
    rel = rel_path(path, root)
    kind = path_kind(rel, root)
    bypass = _bypass_edit(path, tool_input)
    if bypass:
        return "deny", f"Không ghi công tắc tắt hook (`{bypass}`) vào {rel} — hàng rào của khung (ADR-0018)."
    if _match_any(rel, GIT_HOOK_PATTERNS):
        return "deny", GIT_HOOK_WHY.format(rel) + "."
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
            f"Ghi tay bằng chứng/trạng thái autopilot ({rel}) = bằng chứng giả (P1, ADR-0026). Dùng `xt.py loop …`/"
            "`xt.py pr reviewed`; cần sửa tay thì người làm."
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


def _quote_states(line: str, q: str) -> Tuple[List[str], str]:
    """Trạng thái từng ký tự của dòng: "" ngoài nháy, `'`/`"`/`` ` `` trong nháy/backtick, `#` trong comment; `q` = trạng
    thái mang từ dòng trước, trả trạng thái cuối dòng (comment hết ở cuối dòng)."""
    out: List[str] = []
    i = 0
    while i < len(line):
        c = line[i]
        if not q and c == "#" and (i == 0 or line[i - 1] in WORD_END):  # comment: `# don't` không mở nháy
            out += ["#"] * (len(line) - i)
            break
        out.append(q)
        if q == "'":
            q = "" if c == "'" else q
        elif c == "\\":
            out.append(q)
            i += 2
            continue
        elif q:
            q = "" if c == q else q
        elif c in "'\"`":
            q = c
        i += 1
    return out, q


def _unquoted_positions(line: str, q: str) -> Tuple[List[bool], str]:
    """Với từng ký tự của dòng: có nằm NGOÀI nháy/backtick/comment không. `<<` trong `sh -c "…"`/backtick thuộc script
    lồng, không phải heredoc của lệnh ngoài."""
    states, q = _quote_states(line, q)
    return [not st for st in states], q


SUBST_OPEN_RE = re.compile(r"\$\((?!\()")


def _subst_depth(text: str, depth: int) -> int:
    """Độ sâu `$(…)` sau khi đọc `text` (xuất phát từ `depth`); `$((…))` là số học, không tính."""
    return depth + len(SUBST_OPEN_RE.findall(text)) - text.count(")")


def _dq_run_start(states: List[str], pos: int) -> int:
    start = pos
    while start > 0 and states[start - 1] == '"':
        start -= 1
    return start


def _opens_body(line: str, states: List[str], m: "re.Match[str]", carried: int) -> bool:
    """`<<TAG` nằm TRONG nháy kép/backtick: có thật sự mở heredoc (thân ở các dòng sau) không? Trong `"…"` chỉ khi nó
    nằm trong `$(…)` còn mở sau cả dòng (`-m "$(cat <<'EOF'`); trong backtick chỉ khi backtick chưa đóng cùng dòng
    (bash phân tích riêng thân backtick: `` echo `cat <<E` `` đóng ngay thì thân rỗng, dòng sau là lệnh thật). `echo
    "<<E"` chỉ là chữ."""
    if states[m.start()] == "`":
        return "`" not in line[m.end() :]
    start = _dq_run_start(states, m.start())
    depth = _subst_depth(line[start : m.start()], carried if start == 0 else 0)
    return depth > 0 and _subst_depth(line[m.end() :], depth) > 0


def _heredocs(cmd: str) -> List[Tuple[str, "re.Match[str]", List[str]]]:
    """(dòng mở, match, thân) của mọi heredoc có thể thật: bỏ `<<` trong comment/nháy đơn và trong nháy kép ngoài `$(…)`
    (không mở heredoc); giữ trong `$(…)`/backtick (`-m "$(cat <<'EOF'`). Không thấy dấu kết → thân là phần còn lại."""
    out: List[Tuple[str, "re.Match[str]", List[str]]] = []
    lines = cmd.split("\n")
    q, i, carried = "", 0, 0
    while i < len(lines):
        line, i = lines[i], i + 1
        states, q = _quote_states(line, q)
        for m in HEREDOC_RE.finditer(line):
            if states[m.start()] in ("#", "'") or (
                states[m.start()] in ('"', "`") and not _opens_body(line, states, m, carried)
            ):
                continue
            # không thấy dấu kết: như bash, thân là phần còn lại (`bash <<E` ↵ `rm -rf ~` vẫn chạy)
            end = next((j for j in range(i, len(lines)) if lines[j].strip() == m.group(2)), len(lines))
            out.append((line, m, lines[i:end]))
            i = end + 1
        run = _dq_run_start(states, len(states))
        carried = _subst_depth(line[run:], carried if run == 0 else 0) if q == '"' else 0
    return out


def join_continuations(cmd: str) -> str:
    """Nối dòng như bash: `\\` + xuống dòng chỉ là nối dòng khi dãy `\\` liền trước dài LẺ — `\\\\` + xuống dòng là
    gạch chéo đã escape rồi xuống dòng thật (`sh -c "docker \\\\` ↵ `run …"`: shell trong mới nối thành `docker run`).
    Duyệt một lượt (không regex lặp lồng: dãy `\\` dài không làm thời gian bậc hai)."""
    out: List[str] = []
    i, n = 0, len(cmd)
    while i < n:
        j = i
        while j < n and cmd[j] == "\\":
            j += 1
        if j == i:
            out.append(cmd[i])
            i += 1
        elif j < n and cmd[j] == "\n" and (j - i) % 2:
            out.append(cmd[i : j - 1])
            i = j + 1
        else:
            out.append(cmd[i:j])
            i = j
    return "".join(out)


def strip_heredocs(cmd: str) -> str:
    """Bỏ thân heredoc (dữ liệu, không phải lệnh) — giữ dòng mở heredoc. Chỉ `<<` ngoài nháy/backtick mở heredoc của
    lệnh ngoài; `<<` trong chuỗi lồng (`sh -c "bash <<E …"`) giữ nguyên để script lồng được quét cả thân."""
    out: List[str] = []
    pending: List[str] = []
    q = ""
    for line in cmd.split("\n"):
        if pending:
            if line.strip() == pending[0]:
                pending.pop(0)
            continue
        out.append(line)
        free, q = _unquoted_positions(line, q)
        pending = [m.group(2) for m in HEREDOC_RE.finditer(line) if free[m.start()]]
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


ANSI_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "v": "\v"}
ANSI_ESCAPE_RE = re.compile(r"\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|.)", re.S)
IFS_RE = re.compile(r"\$\{IFS\}|\$IFS(?![A-Za-z0-9_])")


def _ansi_c_char(m: "re.Match[str]") -> str:
    e = m.group(1)
    if e[0] in "xuU" and len(e) > 1:
        return chr(int(e[1:], 16)) if int(e[1:], 16) < 0x110000 else ""
    if e[0] in "01234567":
        return chr(int(e, 8) % 256)
    return ANSI_ESCAPES.get(e, e)


def expand_ansi_c(cmd: str) -> str:
    """`$'…'` (ANSI-C quoting) ngoài nháy → chuỗi nháy đơn đã giải mã (`sh -c $'rm -rf ~'`: shlex đọc `$` là chữ và
    giữ nguyên chuỗi nên lệnh bên trong lọt)."""
    out: List[str] = []
    i, q = 0, ""
    while i < len(cmd):
        c = cmd[i]
        if c == "\\" and q != "'":
            out.append(cmd[i : i + 2])
            i += 2
        elif not q and cmd.startswith("$'", i):
            j = i + 2
            while j < len(cmd) and cmd[j] != "'":
                j += 2 if cmd[j] == "\\" else 1
            body = ANSI_ESCAPE_RE.sub(_ansi_c_char, cmd[i + 2 : j])
            out.append("'" + body.replace("'", "'\\''") + "'")
            i = j + 1
        else:
            if c == "'" and q in ("", "'") or c == '"' and q in ("", '"'):
                q = "" if q else c
            out.append(c)
            i += 1
    return "".join(out)


def tokenize(cmd: str) -> List[str]:
    cmd = IFS_RE.sub(" ", expand_ansi_c(strip_heredocs(join_continuations(cmd))))
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


def _split_words(text: str) -> List[str]:
    """`shlex.split`, nháy lẻ (`env -S "echo it's"`) thì tách theo khoảng trắng — ném lỗi ở đây làm cả hook cho qua."""
    try:
        return shlex.split(text)
    except ValueError:
        return text.split()


def _skip_env_args(a: List[str]) -> None:
    """Sau `env`: bỏ tuỳ chọn và gán biến tại chỗ (`-u`/`-C` kèm một giá trị); `-S '<lệnh>'` tách chuỗi thành lệnh
    thật (`env -S "git push --force"`, AUD-SEC-024)."""
    while a and (a[0].startswith("-") or "=" in a[0]):
        opt = a.pop(0)
        split = opt.split("=", 1)[1] if opt.startswith("--split-string=") else opt[2:] if opt[:2] == "-S" else None
        if opt in ("-S", "--split-string") and a:
            split = a.pop(0)
        if split:
            a[:0] = _split_words(split)
        elif opt in ("-u", "-C") and a:
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


# Cấu hình làm `git push` đẩy nhiều nhánh/nhánh chính mà lệnh không ghi refspec (AUD-SEC-047): `push.default=matching`,
# `remote.<r>.push`, `remote.<r>.mirror`. Đặt qua `git -c` → `normalize` chèn PUSH_CONFIG_FLAG sau lệnh con.
PUSH_CONFIG_RE = re.compile(r"(push\.default|remote\..+\.(push|mirror))(=.*)?", re.I)
# Giá trị làm push lan ra nhiều nhánh: `push.default=matching`, `remote.<r>.mirror=true`, `remote.<r>.push=<bất kỳ>`
# (`simple`/`current`/`upstream`/`nothing` chỉ đẩy nhánh hiện tại — luật refspec đã xét).
PUSH_SPREAD_RE = re.compile(r"push\.default=matching|remote\..+\.mirror=(true|yes|on|1)|remote\..+\.push=.*", re.I)
PUSH_CONFIG_FLAG = "--xt-push-config"


def _push_spread_opt(opt: str, nxt: str) -> bool:
    """Tuỳ chọn toàn cục đặt cấu hình push lan nhiều nhánh: `-c k=v`, `-ck=v` (viết liền), `--config-env[=]k=ENV` —
    giá trị nằm trong biến môi trường, guard không đọc được → khoá push nào cũng tính (review #97)."""
    if opt in ("-c", "--config-env") or opt.startswith("--config-env="):
        val = nxt if opt in ("-c", "--config-env") else opt.split("=", 1)[1]
        env = opt.startswith("--config-env")
        return bool((PUSH_CONFIG_RE if env else PUSH_SPREAD_RE).fullmatch(val))
    return opt.startswith("-c") and len(opt) > 2 and bool(PUSH_SPREAD_RE.fullmatch(opt[2:]))


def _strip_git_global_opts(a: List[str]) -> List[str]:
    """`git -C p -c k=v --no-pager sub …` → `git sub …` (tuỳ chọn có giá trị ăn thêm một token); `-c` cấu hình push →
    `git sub --xt-push-config …`."""
    rest = a[1:]
    i = 0
    push_cfg = False
    while i < len(rest) and rest[i].startswith("-"):
        nxt = rest[i + 1] if i + 1 < len(rest) else ""
        push_cfg = push_cfg or _push_spread_opt(rest[i], nxt)
        i += 2 if rest[i] in GIT_OPTS_WITH_VALUE else 1
    out = ["git", *rest[i:]]
    return [*out[:2], PUSH_CONFIG_FLAG, *out[2:]] if push_cfg and out[1:2] == ["push"] else out


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


SCRIPT_LANG_RE = re.compile(r"(python|ruby|perl|node)[0-9.]*")
SCRIPT_FILE_RE = re.compile(r"[\w./-]+\.(py|rb|pl|js|mjs|cjs)")
DATA_MODULES = {
    "json.tool"
}  # `python3 -m json.tool`: chỉ định dạng JSON — module khác (code, pdb, runpy, pip…) chạy được stdin


def _runs_stdin(argv: List[str]) -> bool:
    """Lệnh sau ống có chạy stdin như mã không. Chỉ nới theo danh sách cho phép (fail-closed): python/ruby/perl/node mà đối
    số ĐẦU là file script (`python3 parse.py`) hoặc `python3 -m json.tool` → stdin là dữ liệu; còn lại — `-c`/`-e` (mã có
    thể `exec(sys.stdin.read())`, `"$(cat)"`), cờ có giá trị (`-W ignore`), shell, `sudo` → coi là chạy mã (`xargs python3 -c` đã được `normalize` bỏ tiền tố `xargs`)."""
    n = normalize(argv)
    if not n:
        return False
    if SCRIPT_LANG_RE.fullmatch(n[0]):
        args = n[1:]
        if args[:1] and SCRIPT_FILE_RE.fullmatch(args[0]):
            return False
        return not (args[:1] == ["-m"] and args[1:2] and args[1] in DATA_MODULES)
    return n[0] in INTERPRETERS or n[0] == "sudo"


def remote_exec(cmd: str, tokens: List[str]) -> Optional[str]:
    """curl/wget đưa thẳng vào trình thông dịch: `curl … | sh`, `sh -c "$(curl …)"`, `bash <(curl …)`."""
    for group in pipelines(tokens):
        for i, c in enumerate(group):
            n = normalize(c)
            if n and n[0] in FETCHERS and any(_runs_stdin(x) for x in group[i + 1 :]):
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


PUSH_ALL_WHY = (
    "push --all/--tags đẩy mọi nhánh/tag (gồm nhánh chính, tag phát hành; refspec glob/`:`/cấu hình push) — người duyệt"
)
GIT_CONFIG_READ = {
    "--get",
    "--get-all",
    "--get-regexp",
    "--list",
    "-l",
    "get",
    "list",
    "--unset",
    "--unset-all",
    "unset",
}


def _git_config(args: List[str]) -> Tuple[str, str]:
    """config: đặt `push.default`/`remote.<r>.push|mirror` = push nhánh chính ngầm cho mọi `git push` sau (AUD-SEC-047)."""
    if set(args) & GIT_CONFIG_READ:
        return "", ""
    pos = [a for a in _positionals(args) if a not in ("set", "--add")]
    if pos[:1] and PUSH_SPREAD_RE.fullmatch("=".join(pos[:2]) if len(pos) > 1 else pos[0] + "=true"):
        return "ask", f"đặt cấu hình push — {PUSH_ALL_WHY}"
    return "", ""


def _git_remote(args: List[str]) -> Tuple[str, str]:
    """remote add --mirror=push: mọi `git push` tới remote đó là `--mirror` (ghi đè/xoá nhánh chính)."""
    if args[:1] == ["add"] and any(a.startswith("--mirror") for a in args):
        return "ask", f"remote --mirror — {PUSH_ALL_WHY}"
    return "", ""


def _push_ref_rule(ref: str, deleting: bool, cwd: Optional[str] = None) -> Tuple[str, str]:
    """Một refspec của push: đích là nhánh chính → deny nếu xoá, ask nếu đẩy thẳng. Đích `HEAD`/`@` = nhánh hiện tại."""
    dst = ref.split(":", 1)[1] if ":" in ref else ref
    dst = dst.removeprefix("refs/").removeprefix("heads/")  # git phân giải `heads/main` thành refs/heads/main
    if dst in ("HEAD", "@"):
        dst = _current_branch(cwd)
    if dst not in MAIN_BRANCHES:
        return "", ""
    if deleting or ref.startswith(":"):
        return "deny", "xoá nhánh chính trên remote"
    return "ask", "push thẳng nhánh chính — khung yêu cầu đi qua PR"


def _git_push(args: List[str], cwd: Optional[str] = None) -> Tuple[str, str]:
    """push: deny --force/--mirror/+refspec và xoá nhánh chính; ask khi đẩy thẳng nhánh chính — kể cả khi không có
    refspec hoặc đích là `HEAD` mà nhánh hiện tại (ở `cwd`) là nhánh chính — và khi `--all`/`--tags` (mọi nhánh/tag)."""
    flags = _short_flags(args)
    force = any(x.startswith("--force") and x != "--force-if-includes" or x == "--mirror" for x in args) or "f" in flags
    refs = _positionals(args, ("-o", "--push-option", "--repo", "--receive-pack", "--exec"))
    if force or any(r.startswith("+") for r in refs):
        return "deny", "push --force/--mirror/+refspec ghi đè lịch sử"
    spread = any("*" in r or r == ":" for r in refs[1:])  # refspec glob, `:` = matching (AUD-SEC-047)
    spread = spread or (PUSH_CONFIG_FLAG in args and not refs[1:])  # cấu hình push chỉ có hiệu lực khi không có refspec
    if spread or {"--all", "--branches", "--tags"} & set(args):
        return "ask", PUSH_ALL_WHY
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
    "config": _git_config,
    "remote": _git_remote,
}


# git nhận tuỳ chọn dài viết tắt (`reset --ha`, `push --mirr`, `clean --fo`): viết tắt của tuỳ chọn nguy hiểm → coi là
# tuỳ chọn đó (AUD-SEC-023). Thứ tự: ngắn trước, để `--forc` thành `--force`.
GIT_DANGER_LONG = ("--all", "--hard", "--tags", "--force", "--delete", "--mirror", "--branches", "--discard-changes")


def _git_long(a: str) -> str:
    key, eq, val = a.partition("=")
    if not key.startswith("--") or len(key) < 4 or key in GIT_DANGER_LONG:
        return a
    full = next((d for d in GIT_DANGER_LONG if d.startswith(key)), "")
    return full + eq + val if full else a


def git_rules(n: List[str], cwd: Optional[str] = None) -> Tuple[str, str]:
    """Luật theo lệnh con của git (bảng GIT_RULES; `push` riêng vì cần thư mục để biết nhánh hiện tại); không có luật → cho qua."""
    if len(n) < 2:
        return "", ""
    args = [_git_long(a) for a in n[2:]]
    if n[1] == "push":
        return _git_push(args, cwd)
    rule = GIT_RULES.get(n[1])
    return rule(args) if rule else ("", "")


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
GH_DESTROY = {("secret",), ("repo", "delete"), ("repo", "archive"), ("release", "delete")}
# Lệnh con huỷ/xoá hạ tầng không đảo ngược: vẫn ask ở bộ luật, nhưng mang lý do DESTROY_ASK để `apply_policy` chặn.
DESTROY_CMDS: Dict[str, Tuple[str, ...]] = {
    "kubectl": ("delete",),
    "terraform": ("destroy",),
    "tofu": ("destroy",),
    "pulumi": ("destroy", "down"),
}
# `terraform|tofu apply -destroy` = destroy (AUD-SEC-048); `plan -destroy` chỉ in kế hoạch.
APPLY_DESTROY = {"-destroy", "--destroy", "-destroy=true", "--destroy=true"}
INFO_ONLY = {"--version", "-v", "version", "--help", "-h", "help"}


EXTERNAL_ASK = "hành động đối ngoại/triển khai thật (điểm dừng bắt buộc)"
DESTROY_ASK = "huỷ/xoá repo, bí mật hoặc hạ tầng (không đảo ngược)"
# Ngoại lệ cứng (ADR-0016): tiền/dữ liệu thật/auth/mật mã/bí mật người merge — ADR-0019 giữ chặn dưới ADR-0018; nhánh
# đích commit `merge_hard_exceptions: auto` thì merge-check không trả `hard` (ADR-0020).
HARD_ASK = "ngoại lệ cứng (LOOP-STOP-005): người merge"
# Merge/bật auto-merge mà guard không đọc được `hard` (merge-check lỗi, repo khác, PR không rõ số, graphql) → chặn như
# ngoại lệ cứng: không xác minh được thì không cho qua (AUD-SEC-044/045).
UNVERIFIED_ASK = "không xác minh được ngoại lệ cứng (ADR-0019): người merge"
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


# Như `py_run` của _lib.sh: chạy xt.py bằng import để dùng bytecode cache (chạy như script thì biên dịch lại ~4.000 dòng
# mỗi lần); sys.path[0] = thư mục của file, không lấy cwd.
IMPORT_RUNNER = (
    "import sys; d, _, f = sys.argv[1].rpartition('/'); sys.path[0] = d or '.'; sys.argv = sys.argv[1:]; "
    "sys.exit(__import__(f[:-3]).main())"
)


def pycache_prefix() -> str:
    """Thư mục cache bytecode ngoài dự án (như `_lib.sh`): giữ `PYTHONPYCACHEPREFIX` có sẵn, nếu không thì XDG/~/.cache."""
    if os.environ.get("PYTHONPYCACHEPREFIX"):
        return os.environ["PYTHONPYCACHEPREFIX"]
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "xtemplates", "pycache")


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
    cmd = [
        sys.executable,
        "-c",
        IMPORT_RUNNER,
        xt,
        "merge-check",
        "--json",
        *(["--pr", selector[0]] if selector else []),
    ]
    try:
        env = dict(os.environ, CLAUDE_PROJECT_DIR=root, PYTHONPYCACHEPREFIX=pycache_prefix())
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=MERGE_CHECK_TIMEOUT, env=env, check=False)
        data: Dict[str, object] = json.loads(r.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return {"verdict": "lỗi", "reasons": ["merge-check không chạy được"]}
    return data


def gh_pr_merge_rule(args: List[str], root: str) -> Tuple[str, str]:
    """`gh pr merge` (ADR-0013): mặc định hỏi người; `allow` chỉ khi `xt.py merge-check` = merge VÀ lệnh ghim đúng
    head đã kiểm (`--match-head-commit`). `--admin` (vượt ruleset) và `--repo` (repo khác) luôn hỏi."""
    selector = _positionals(args, GH_MERGE_VALUE_FLAGS)
    repo = _flag_value(args, "-R") or _flag_value(args, "--repo") or next((a[2:] for a in args if a[:2] == "-R"), "")
    if args and set(args) - set(selector) == {"--disable-auto"}:  # tắt auto-merge: LOOP-STOP-005 đòi, không chặn
        return "ask", f"{EXTERNAL_ASK} — tắt auto-merge"
    if "--auto" in args and not any(a.startswith("--admin") for a in args):
        flags = sorted({a.split("=", 1)[0] for a in args if a.startswith("-")} - MERGE_ALLOW_FLAGS - {"--auto"})
        if flags or repo:
            return _merge_ask(
                f"{EXTERNAL_ASK} — bật auto-merge chỉ nhận số PR/nhánh và cờ merge thường", selector, root, repo
            )
        return _auto_merge_verdict(selector, root)
    sha = _flag_value(args, "--match-head-commit")
    if sum(a == "--match-head-commit" or a.startswith("--match-head-commit=") for a in args) > 1:
        sha = None  # gh lấy lần cuối, guard đã kiểm lần đầu — hai pin là không pin
    flags = sorted({a.split("=", 1)[0] for a in args if a.startswith("-")} - MERGE_ALLOW_FLAGS)
    if not sha or flags or repo:
        why = "tự merge cần `--match-head-commit <sha>` từ `xt.py merge-check`, chỉ cờ"
        return _merge_ask(f"{EXTERNAL_ASK} — {why} {', '.join(sorted(MERGE_ALLOW_FLAGS))}", selector, root, repo)
    return _merge_verdict(selector, sha, root)


def _rm_rule(args: List[str], root: str = "", cwd: Optional[str] = None) -> Tuple[str, str]:
    """rm: deny --no-preserve-root và rm -rf trên đích nguy hiểm (gốc, home, cwd, glob, thư mục `.git`); xoá đệ quy
    ra ngoài gốc dự án (trừ thư mục tạm) → ask (xoá dữ liệu là điểm dừng bắt buộc — stored 01 §3c: `rm -rf ~/x`)."""
    flags = _short_flags(args)
    recursive = "r" in flags or "R" in flags or "--recursive" in args
    force = "f" in flags or "--force" in args
    targets = _positionals(args)
    if "--no-preserve-root" in args or (recursive and force and any(_dangerous_rm_target(t) for t in targets)):
        return "deny", "rm -rf trên /, ~, $HOME, ., .., *, .git"
    if recursive and force and not targets:  # `xargs rm -rf`, `… | xargs rm -rf`: đích đến từ stdin (AUD-SEC-024)
        return "ask", "rm -rf không có đích trên dòng lệnh (đích từ xargs/stdin) — xoá dữ liệu cần người duyệt"
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
    roots, i = _find_parts(args)
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
    if {a for a in args[i:] if not a.isdigit()} <= FIND_NO_FILTER and any(
        _dangerous_rm_target(r) for r in roots
    ):  # `find . -delete` = `rm -rf .`
        return "deny", "find -delete không lọc trên /, ~, ., .git — xoá cả cây"
    outside = [r for r in roots if _outside_project(r, root, cwd)]
    return ("ask", f"find xoá file ngoài thư mục dự án ({outside[0]})") if outside else ("", "")


def _find_parts(args: List[str]) -> Tuple[List[str], int]:
    """(gốc, vị trí bắt đầu biểu thức) của `find`: bỏ tuỳ chọn toàn cục đứng trước gốc (`-H`/`-L`/`-P`, `-D <opt>`,
    `-O<n>`) — `find -L .autopilot -delete` từng bị đọc thành gốc `.` (reviewer #132)."""
    i = 0
    while i < len(args) and (args[i] in ("-H", "-L", "-P") or re.fullmatch(r"-O\d", args[i])):
        i += 1
    if args[i : i + 1] == ["-D"]:
        i += 2
    j = i
    while j < len(args) and not args[j].startswith(("-", "(", "!")):
        j += 1
    return args[i:j] or ["."], j


def _find_delete_roots(args: List[str]) -> List[str]:
    """Gốc của `find … -delete` / `-exec rm|shred|unlink …`: lệnh xoá file dưới các gốc này (reviewer #132)."""
    roots, i = _find_parts(args)
    deleting = "-delete" in args[i:] or any(
        sub and posixpath.basename(sub[0]) in ("rm", "shred", "unlink") for sub in _find_exec_argvs(["find", *args[i:]])
    )
    return roots if deleting else []


# `find … -exec <lệnh>` chỉ ĐỌC file thì không đụng bằng chứng; lệnh khác (mv, sed -i, sh -c, tee…) coi là có thể ghi.
FIND_READONLY_EXEC = {
    *(
        "cat",
        "grep",
        "egrep",
        "fgrep",
        "head",
        "tail",
        "ls",
        "wc",
        "stat",
        "file",
        "jq",
        "diff",
        "cmp",
        "echo",
        "printf",
    ),
    *("sha256sum", "sha1sum", "md5sum", "basename", "dirname", "readlink", "realpath", "du", "test", "["),
}
FIND_FILE_OUT = {"-fprint", "-fprint0", "-fprintf", "-fls"}  # ghi kết quả vào file (đối số kế tiếp)
FIND_NAME_TESTS = {"-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-name", "-iname", "-lname"}
EVIDENCE_NAMES = {"verified.json", "runs.jsonl", "reviews.json"}  # tên đặc thù của file trong `.autopilot/`


def _find_name_hints(expr: List[str]) -> List[str]:
    """`-path './.autopilot/*'`, `-name verified.json`: gốc `.` nhưng bộ lọc chỉ trúng bằng chứng — trả đường dẫn giả
    `.autopilot/<tên>` để xét như đích ghi."""
    out: List[str] = []
    for k, a in enumerate(expr[:-1]):
        val = expr[k + 1]
        low = val.lower()
        if a in FIND_NAME_TESTS and ("autopilot" in low or posixpath.basename(low) in EVIDENCE_NAMES):
            out.append(posixpath.join(".autopilot", posixpath.basename(val) or "x"))
    return out


def _find_evidence_targets(args: List[str]) -> List[str]:
    """Đích mà `find` có thể ghi/sửa ngoài việc xoá: `-exec` chạy lệnh không chỉ-đọc dưới các gốc (kể cả bộ lọc trúng
    bằng chứng), `-fprint FILE`. Chỉ dùng để xét `.autopilot/` (ADR-0026) — gốc `.` thường không phải cổng."""
    roots, i = _find_parts(args)
    expr = args[i:]
    out = [expr[k + 1] for k, a in enumerate(expr[:-1]) if a in FIND_FILE_OUT]
    execs = _find_exec_argvs(["find", *expr])
    if "-delete" in expr or any(sub and posixpath.basename(sub[0]) not in FIND_READONLY_EXEC for sub in execs):
        out += [*roots, *_find_name_hints(expr)]
    return out


FIND_NO_FILTER = {"-delete", "-depth", "-print", "-xdev", "-mount", "-ignore_readdir_race", "-mindepth", "-maxdepth"}
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
        return _graphql_opaque(args) or "mutation" in " ".join(args).lower()
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
    d, gate = _hard_gate(selector, root, repo)
    if gate[0]:  # tiền/dữ liệu thật/auth/mật mã/bí mật người merge kể cả L3 (ADR-0016, AUD-HAR-042; trừ ADR-0020)
        return gate
    level = d.get("autonomy")
    if not isinstance(level, int) or level < 3:
        return "ask", f"{EXTERNAL_ASK} — bật auto-merge chỉ khi xt.yaml `merge_autonomy` ≥ L3 (ADR-0015)"
    if d.get("verdict") == "closed" or d.get("stacked"):
        return "ask", f"{EXTERNAL_ASK} — không bật auto-merge: PR {d.get('verdict')}/PR chồng (nhắm nhánh sắp bị xoá)"
    return "allow", f"merge_autonomy L{level}: bật auto-merge (GitHub merge khi required check xanh)"


def _mcp_auto_merge(tool_input: Dict[str, object], root: str) -> Tuple[str, str]:
    n, owner, repo = tool_input.get("pullNumber"), tool_input.get("owner"), tool_input.get("repo")
    ok = not set(tool_input) - MCP_AUTO_KEYS and type(n) is int and n > 0
    ok = ok and isinstance(owner, str) and isinstance(repo, str)
    if not ok or tool_input.get("mergeMethod", "SQUASH") not in ("SQUASH", "MERGE", "REBASE"):
        return _mcp_merge_ask(
            f"{EXTERNAL_ASK} — bật auto-merge qua MCP cần owner/repo/pullNumber hợp lệ", tool_input, root
        )
    return _auto_merge_verdict([str(n)], root, f"{owner}/{repo}")


def mcp_decision(tool_name: str, tool_input: Dict[str, object], root: str) -> Tuple[str, str]:
    if not MCP_MERGE_RE.fullmatch(tool_name):
        return "", ""
    if "disable" in tool_name:  # tắt auto-merge: LOOP-STOP-005 đòi khi chạm ngoại lệ cứng — không chặn
        return "ask", f"{EXTERNAL_ASK} — tắt auto-merge qua MCP ({tool_name})"
    # Chỉ server GitHub chính (`mcp__github__…`): server khác cùng tên tool có thể trỏ host khác với repo merge-check đọc.
    if not tool_name.startswith("mcp__github__"):
        return "ask", f"{EXTERNAL_ASK} — {UNVERIFIED_ASK}: merge qua server MCP khác ({tool_name})"
    if tool_name == "mcp__github__enable_pr_auto_merge":
        return _mcp_auto_merge(tool_input, root)
    ask = f"{EXTERNAL_ASK} — merge PR qua MCP ({tool_name}) cần `expectedHeadSha` + `xt.py merge-check` = merge"
    n, sha = tool_input.get("pullNumber"), tool_input.get("expectedHeadSha")
    owner, repo = tool_input.get("owner"), tool_input.get("repo")
    ok = tool_name == "mcp__github__merge_pull_request" and not set(tool_input) - MCP_MERGE_KEYS
    ok = ok and type(n) is int and n > 0 and isinstance(sha, str) and bool(sha)
    ok = ok and isinstance(owner, str) and isinstance(repo, str)
    if not ok or tool_input.get("merge_method", "squash") not in MERGE_METHODS:
        return _mcp_merge_ask(ask, tool_input, root)
    return _merge_verdict([str(n)], str(sha), root, f"{owner}/{repo}")


def _mcp_merge_ask(why: str, tool_input: Dict[str, object], root: str) -> Tuple[str, str]:
    """Tool MCP merge mà guard không tự cho phép: vẫn kiểm `hard` khi đọc được PR (số nguyên dương + owner/repo)."""
    n, owner, repo = tool_input.get("pullNumber"), tool_input.get("owner"), tool_input.get("repo")
    if type(n) is int and n > 0 and isinstance(owner, str) and isinstance(repo, str):
        return _merge_ask(why, [str(n)], root, f"{owner}/{repo}")
    return "ask", f"{EXTERNAL_ASK} — {UNVERIFIED_ASK}: tool MCP merge không rõ PR/repo"


def _hard_reasons(d: Dict[str, object]) -> str:
    raw = d.get("hard")
    return "; ".join(str(x) for x in raw) if isinstance(raw, list) else str(raw)


def _hard_gate(selector: List[str], root: str, repo: str = "") -> Tuple[Dict[str, object], Tuple[str, str]]:
    """(kết quả merge-check, chặn): `hard` → ask mang `HARD_ASK`; không xác minh được — selector lạ (URL, nhiều PR),
    merge-check không trả `hard` (lỗi mạng/không đọc được PR), repo khác repo merge-check kiểm — → ask mang
    `UNVERIFIED_ASK`; cả hai thành deny ở chính sách mặc định (ADR-0019). Không ngoại lệ cứng → ('', '')."""
    if len(selector) > 1 or not all(MERGE_SELECTOR_RE.fullmatch(s) for s in selector):
        return {}, ("ask", f"{EXTERNAL_ASK} — {UNVERIFIED_ASK}: PR không rõ ({' '.join(selector)[:80]})")
    d = merge_check(selector, root)
    if d.get("hard"):  # ADR-0019: kiểm trước verdict để chính sách ADR-0018 chặn thay vì cho qua
        return d, ("ask", f"{EXTERNAL_ASK} — {HARD_ASK}: {_hard_reasons(d)}")
    raw = d.get("reasons")
    if "hard" not in d:
        why = "; ".join(str(x) for x in raw) if isinstance(raw, list) else ""
        return d, ("ask", f"{EXTERNAL_ASK} — {UNVERIFIED_ASK}: merge-check {d.get('verdict')}: {why}")
    if repo and str(d.get("repo", "")).lower() != repo.lower():
        return d, (
            "ask",
            f"{EXTERNAL_ASK} — {UNVERIFIED_ASK}: merge-check kiểm repo {d.get('repo') or '?'}, không phải {repo}",
        )
    return d, ("", "")


def _merge_ask(why: str, selector: List[str], root: str, repo: str = "") -> Tuple[str, str]:
    """Merge mà guard không tự cho phép (thiếu ghim, cờ lạ, repo khác…): ask `why` — trừ khi chạm/không xác minh được
    ngoại lệ cứng thì ask mang dấu chặn (AUD-SEC-044)."""
    gate = _hard_gate(selector, root, repo)[1]
    return gate if gate[0] else ("ask", why)


def _merge_verdict(selector: List[str], sha: str, root: str, repo: str = "") -> Tuple[str, str]:
    """`allow` khi `xt.py merge-check` (PR theo selector; rỗng = nhánh hiện tại) trả merge, head đã kiểm = `sha` (và repo
    trùng nếu có), không thuộc/không mù ngoại lệ cứng (`_hard_gate` — mặc định thành deny, ADR-0019); không thì ask."""
    d, gate = _hard_gate(selector, root, repo)
    if gate[0]:
        return gate
    raw = d.get("reasons")
    reasons = "; ".join(str(x) for x in raw) if isinstance(raw, list) else ""
    if d.get("verdict") != "merge":
        return "ask", f"{EXTERNAL_ASK} — merge-check: {d.get('verdict')}: {reasons}"
    if d.get("head") != sha:
        return "ask", f"{EXTERNAL_ASK} — head đã kiểm {d.get('head')} khác {sha}"
    return "allow", f"merge-check: {reasons}"


def _gh_api_merge_rule(args: List[str], root: str) -> Tuple[str, str]:
    """`gh api` ghi → ask; trừ merge REST ghim head (`-X PUT repos/{owner}/{repo}/pulls/N/merge -f sha=… [-f
    merge_method=…]`, mỗi khoá một lần, không `@file`) mà merge-check cho phép (LOOP-STOP-022)."""
    ask = "ask", f"{EXTERNAL_ASK} — `gh api` ghi lên GitHub (merge/cấu hình phải qua lệnh có kiểm)"
    pos = _positionals(args, GH_API_VALUE_FLAGS)
    m = REST_MERGE_PATH_RE.fullmatch(pos[0]) if len(pos) == 1 else None  # dạng chuẩn: không giải mã
    pairs = [v.partition("=") for v in _gh_api_field_values(args)]
    fields = {k: v for k, _, v in pairs}
    flags = {a.split("=", 1)[0] for a in args if a.startswith("-")} - {"-X", "--method", "-f", "--raw-field"}
    bad = not m or _gh_api_methods(args) != ["PUT"] or flags or len(fields) != len(pairs) or not fields.get("sha")
    if bad or set(fields) - {"sha", "merge_method"} or fields.get("merge_method", "squash") not in MERGE_METHODS:
        return _gh_api_merge_like(args, pos, ask, root)
    return _merge_verdict([m[1]], fields["sha"], root) if m else ask


# Merge/bật auto-merge qua `gh api`: REST `repos/<chủ>/<repo>/pulls/N/merge` (cả `{owner}/{repo}`), mutation graphql.
ANY_REST_MERGE_RE = re.compile(r"/?repos/([^/\s]+/[^/\s]+)/pulls/(\d+)/merge/?")
GRAPHQL_MERGE_RE = re.compile(r"\b(mergePullRequest|enablePullRequestAutoMerge)\b")


def _api_path(p: str) -> str:
    """Đường dẫn REST như GitHub hiểu: giải mã `%xx`, bỏ query/fragment (`…/%6Derge?x=1` = `…/merge`)."""
    return urllib.parse.unquote(p.split("?", 1)[0].split("#", 1)[0])


def _graphql_opaque(args: List[str]) -> bool:
    """Query graphql guard không đọc được tại chỗ: `--input`, trường `@file`, giá trị là cả một biến shell (`query=$Q`),
    thay lệnh (`$(…)`, backtick). `$n` bên trong query là biến GraphQL — đọc được, không tính."""
    pairs = [v.partition("=") for v in _gh_api_field_values(args)]
    indirect = any(a.split("=", 1)[0] == "--input" for a in args) or any("$(" in a or "`" in a for a in args)
    return indirect or any(v.startswith("@") or (k == "query" and v.startswith("$")) for k, _, v in pairs)


def _gh_api_merge_like(args: List[str], pos: List[str], ask: Tuple[str, str], root: str) -> Tuple[str, str]:
    """`gh api` ghi không đúng dạng merge REST có kiểm: là merge (REST/graphql) → vẫn kiểm `hard` (AUD-SEC-044);
    graphql merge không ánh xạ được số PR → chặn như không xác minh được; ghi khác → `ask` (đối ngoại)."""
    if pos[:1] == ["graphql"]:  # mutation merge, hoặc query guard không đọc được (`@file`, `--input`, biến)
        if GRAPHQL_MERGE_RE.search(" ".join(args)) or _graphql_opaque(args):
            return "ask", f"{EXTERNAL_ASK} — {UNVERIFIED_ASK}: merge qua graphql (không đọc được số PR/nội dung)"
        return ask
    m = ANY_REST_MERGE_RE.fullmatch(_api_path(pos[0])) if len(pos) == 1 else None
    if not m:
        return ask
    repo = "" if m[1] == "{owner}/{repo}" else m[1]
    return _merge_ask(ask[1], [m[2]], root, repo)


GH_REPO_FLAGS = ("-R", "--repo")


def _gh_lift_repo(args: List[str]) -> List[str]:
    """`gh -R o/r pr merge …` / `gh --repo=o/r …`: chuyển cờ repo đứng TRƯỚC lệnh con ra sau (`pr merge … -R o/r`) để
    luật của lệnh con thấy repo (review #97: từng lọt cổng ngoại lệ cứng)."""
    moved: List[str] = []
    while args[:1] and args[0].split("=", 1)[0] in GH_REPO_FLAGS or args[:1] and args[0][:2] == "-R":
        a = args[0]
        if a in GH_REPO_FLAGS:
            moved, args = [*moved, "-R", *args[1:2]], args[2:]
        else:
            moved, args = [*moved, "-R", a.split("=", 1)[1] if "=" in a else a[2:]], args[1:]
    return [*args, *moved]


def _external_rule(name: str, args: List[str], root: str) -> Tuple[str, str]:
    """Hành động đối ngoại/triển khai thật → ask; `gh pr merge` qua `xt.py merge-check` (ADR-0013)."""
    if name == "gh":
        args = _gh_lift_repo(args)
    if name == "gh" and args[:2] == ["pr", "merge"] and not set(args[2:]) & HELP_FLAGS:
        return gh_pr_merge_rule(args[2:], root)
    if name == "gh" and args[:1] == ["pr"] and "merge" in args[2:4]:  # `gh pr -R o/r merge`: cờ repo của `pr`
        i = args.index("merge", 2)
        selector, repo = _pr_flag_merge(args, i)
        return _merge_ask(f"{EXTERNAL_ASK} — `gh pr <cờ> merge` không tự merge", selector, root, repo)
    if name == "gh" and args[:2] in (["alias", "set"], ["alias", "import"]):
        return "ask", "gh alias đặt lệnh tắt — guard không thấy lệnh thật khi alias chạy"
    if name == "gh" and args[:1] == ["api"] and _gh_api_writes(args[1:]):
        return ("ask", DESTROY_ASK) if _gh_api_destroy(args[1:]) else _gh_api_merge_rule(args[1:], root)
    verdict = _publish_rule(name, args)
    return verdict if verdict[0] else egress_rule(name, args, root)


# `gh api` huỷ repo/nhánh chính (AUD-SEC-048): DELETE repo hay ref nhánh chính, PATCH `archived=true` — như `gh repo
# delete|archive`; PATCH `private=`/`visibility=` hoặc thân `--input` — như `gh repo edit --visibility`.
GH_API_REPO_RE = re.compile(r"/?repos/[^/\s]+/[^/\s]+/?")
GH_API_MAIN_REF_RE = re.compile(r"/?repos/[^/\s]+/[^/\s]+/git/refs/heads/(main|master)/?")


# Ghi lên bí mật, quyền, bảo vệ nhánh, ruleset, webhook, chuyển chủ repo (review #97) — như `gh secret`/đổi ruleset.
GH_API_GUARDED_RE = re.compile(
    r"/?(repos|orgs)/[^/\s]+(/[^/\s]+)?/(actions|dependabot|codespaces)/secrets(/.*)?"
    r"|/?repos/[^/\s]+/[^/\s]+/(branches/[^\s]+/protection(/.*)?|rulesets(/.*)?|hooks(/.*)?|collaborators/.+|transfer)/?"
    r"|/?orgs/[^/\s]+/(rulesets|hooks|members|memberships)(/.*)?"
    # review #97 lần 2: environment (bí mật/biến/luật bảo vệ), deploy key, khoá SSH/GPG của tài khoản, biến Actions
    r"|/?repos/[^/\s]+/[^/\s]+/(environments/[^/\s]+(/.*)?|keys(/.*)?|actions/variables(/.*)?)/?"
    r"|/?orgs/[^/\s]+/actions/variables(/.*)?|/?user/(keys|gpg_keys|ssh_signing_keys)(/.*)?"
)
# Mutation graphql huỷ/chuyển repo — như `gh repo delete|archive`.
GRAPHQL_DESTROY_RE = re.compile(r"\b(deleteRepository|transferRepository|archiveRepository)\b")


def _gh_api_destroy(args: List[str]) -> bool:
    pos = _positionals(args, GH_API_VALUE_FLAGS)
    methods = _gh_api_methods(args)
    implicit = "POST" if _gh_api_field_values(args) or any(a.split("=", 1)[0] == "--input" for a in args) else "GET"
    method, path = (methods[-1] if methods else implicit), (_api_path(pos[0]) if len(pos) == 1 else "")
    if (
        method != "GET"
        and GH_API_GUARDED_RE.fullmatch(path)
        or path == "graphql"
        and GRAPHQL_DESTROY_RE.search(" ".join(args))
    ):
        return True
    if method == "DELETE":
        return bool(GH_API_REPO_RE.fullmatch(path) or GH_API_MAIN_REF_RE.fullmatch(path))
    fields = [v.replace(" ", "").lower() for v in _gh_api_field_values(args)]
    # Như `gh repo edit --visibility <bất kỳ>`: đổi `private`/`visibility` (kể cả sang private) là chặn; thân `--input`
    # không đọc được tại chỗ nên không xác minh được → chặn như `archived=true`.
    exposes = any(v == "archived=true" or v.startswith(("private=", "visibility=")) for v in fields)
    opaque = any(a.split("=", 1)[0] == "--input" for a in args)
    return method == "PATCH" and (exposes or opaque) and bool(GH_API_REPO_RE.fullmatch(path))


def _pr_flag_merge(args: List[str], i: int) -> Tuple[List[str], str]:
    """(selector, repo) của `gh pr <cờ…> merge <selector> …`: repo từ `-R`/`--repo` trước hoặc sau `merge`."""
    repo = _flag_value(args, "-R") or _flag_value(args, "--repo") or next((a[2:] for a in args if a[:2] == "-R"), "")
    return _positionals(args[i + 1 :], GH_MERGE_VALUE_FLAGS), repo


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
        destroy = tuple(args[:1]) in GH_DESTROY or tuple(args[:2]) in GH_DESTROY
        destroy = destroy or (args[:2] == ["repo", "edit"] and any(a.startswith("--visibility") for a in args))
        return ("ask", DESTROY_ASK if destroy else EXTERNAL_ASK) if hit else ("", "")
    if name not in ASK_CMDS:
        return "", ""
    subs = ASK_CMDS[name]
    words = set(_positionals(args)) | {a for a in args if a.startswith("--")}
    if name in ("terraform", "tofu") and "apply" in words and set(args) & APPLY_DESTROY:
        words.add("destroy")
    if words & set(DESTROY_CMDS.get(name, ())):
        return "ask", DESTROY_ASK
    return ("ask", EXTERNAL_ASK) if subs is None or words & set(subs) else ("", "")


# Ra khỏi máy dev (đề xuất chủ repo 2026-10-17): khi phiên chạy không hỏi quyền (`--permission-mode auto`, allow rộng ở
# settings người dùng), guard là lớp hỏi cuối — chạm máy chủ thật, gửi dữ liệu ra ngoài, kéo phụ thuộc mới, container
# có quyền máy chủ phải qua người. Máy cục bộ không hỏi (dev, test, CI hằng ngày).
EGRESS_ASK = "ra khỏi máy dev (điểm dừng bắt buộc)"
REMOTE_SHELLS = {"ssh", "sftp", "mosh", "telnet"}
REMOTE_COPY = {"scp", "rsync"}
REMOTE_VALUE_FLAGS = ("-e", "-i", "-P", "-p", "-F", "-o", "-J", "-l", "--rsh", "--port", "--exclude", "--include")
# Cờ ăn giá trị chỉ của ssh/sftp (`-L`/`-R`/`-D` của rsync là cờ boolean) — thiếu thì giá trị loopback bị lấy làm máy đích.
SSH_VALUE_FLAGS = (
    *REMOTE_VALUE_FLAGS,
    "-L",
    "-R",
    "-D",
    "-b",
    "-B",
    "-c",
    "-E",
    "-I",
    "-m",
    "-O",
    "-Q",
    "-S",
    "-W",
    "-w",
)
# `-o` của ssh chạy lệnh cục bộ hoặc đi qua máy khác dù đích là loopback.
SSH_INDIRECT_OPTS: Tuple[str, ...] = ("proxycommand", "proxyjump", "localcommand", "permitlocalcommand")
SSH_INDIRECT_OPTS += ("knownhostscommand", "remotecommand")
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
URL_RE = re.compile(r"(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*://[^\s'\"]*")  # lookbehind: tuyến tính
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
    "bundle": {"add": True},
    "conda": {"install": False},
    "mamba": {"install": False},
}
# Lệnh bọc chạy lệnh khác (`uv run pip install x`, `npx pnpm add x`): xét lệnh bên trong.
PKG_WRAPPERS = {"uv": "run", "poetry": "run", "pdm": "run", "pipenv": "run", "hatch": "run", "corepack": "", "npx": ""}
PKG_WRAPPERS.update({"pnpm": "exec", "npm": "exec", "yarn": "exec", "bunx": ""})
WRAPPER_VALUE_FLAGS: Tuple[str, ...] = ("--python", "-p", "--with", "--with-requirements", "--project", "--package")
WRAPPER_VALUE_FLAGS += ("--directory",)
WRAPPER_VALUE_FLAGS += ("--env-file", "--extra", "--group", "-c", "--call", "-e", "--env")
# Cờ trình thông dịch ăn giá trị (`python3 -W ignore -m pip`); `-c` là mã nguồn — dừng ở đó như cũ.
INTERP_VALUE_FLAGS = ("-W", "-X", "-Q")
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
    "conda": ("-c", "--channel", "-n", "--name", "-p", "--prefix", "--file"),
    "mamba": ("-c", "--channel", "-n", "--name", "-p", "--prefix", "--file"),
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
SENSITIVE_MOUNT_PREFIXES = ("/proc/", "/sys/", "/boot/", "/var/lib/docker/")


def _is_loopback(host: str) -> bool:
    h = host.strip().strip("[]").lower()
    if h.startswith("127."):  # chỉ địa chỉ IPv4 thật — `127.0.0.1.nip.io` là tên miền ngoài
        return all(p.isdigit() and int(p) < 256 for p in h.split(".")) and h.count(".") == 3
    return h in LOCAL_HOSTS or h == "localhost." or h.endswith(".localhost")


def _is_local_host(host: str) -> bool:
    """Máy cục bộ: loopback, socket unix, tên không có dấu chấm (dịch vụ compose/container: `db`, `postgres`); số thuần
    (`3627733118`, `0x7f000001`) là địa chỉ IP viết gọn, không phải tên dịch vụ."""
    h = host.strip().strip("[]").lower()
    if not h or h.startswith("/") or _is_loopback(h):
        return True
    return "." not in h and ":" not in h and not h.isdigit() and not h.startswith("0x")


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


def _db_rule(name: str, args: List[str]) -> str:
    """Client CSDL tới máy chủ không cục bộ: cờ host, URI/conninfo ở đối số vị trí hoặc `-d` (`PGHOST=`/`…_URL=` gán đầu
    lệnh xét ở `_scan_command`). Câu SQL (`-c`, `-f`) là dữ liệu, không quét."""
    hosts = _flag_values(args, DB_CLIENTS[name])
    for a in _positionals(args, (*DB_CLIENTS[name], *DB_URI_FLAGS, *DB_VALUE_FLAGS)) + _flag_values(args, DB_URI_FLAGS):
        hosts += _url_hosts(a) + CONNINFO_HOST_RE.findall(a)
    remote = next((h for h in hosts if not h.startswith("$") and not _is_local_host(h)), "")
    return f"{EGRESS_ASK} — {name} tới máy chủ {remote}" if remote else ""


def _ssh_forward_hosts(args: List[str]) -> List[str]:
    """Máy ở đầu kia đường hầm: `-W host:port`, `-L|-R [bind:]port:host:hostport` (`-D` là SOCKS, không có máy)."""
    hosts = [w.rsplit(":", 1)[0] for w in _flag_values(args, ("-W",))]
    hosts += [p[-2] for p in (v.split(":") for v in _flag_values(args, ("-L", "-R"))) if len(p) >= 3]
    return hosts


def _remote_rule(name: str, args: List[str]) -> str:
    """ssh/sftp/mosh/telnet vào máy không loopback; scp/rsync chép với máy không loopback (alias `~/.ssh/config` như
    `prod` không có dấu chấm vẫn là máy khác)."""
    pos = _positionals(args, SSH_VALUE_FLAGS if name in ("ssh", "sftp") else REMOTE_VALUE_FLAGS)
    if name in REMOTE_SHELLS:
        if set(args) <= INFO_ONLY | {"-V"} or not pos:  # không có máy đích: trợ giúp/truy vấn cục bộ (`ssh -Q cipher`)
            return ""
        if not (pos and _is_loopback(pos[0].rsplit("@", 1)[-1])):
            return f"{EGRESS_ASK} — {name} vào máy khác"
        opts = [o.lower().replace(" ", "=") for o in _flag_values(args, ("-o",))]
        indirect = _flag_values(args, ("-J", "-F")) or [o for o in opts if o.startswith(SSH_INDIRECT_OPTS)]
        tunnel = [h for h in _ssh_forward_hosts(args) if not _is_local_host(h)]
        if tunnel:
            return f"{EGRESS_ASK} — {name} loopback mở đường hầm tới {tunnel[0]}"
        if indirect or (name == "ssh" and len(pos) > 1):  # loopback vẫn là shell thật: lệnh bên trong không qua guard
            return f"{EGRESS_ASK} — {name} loopback chạy lệnh/ProxyCommand/ProxyJump"
        return ""
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


CURL_SHORT_VALUE = {f[1] for f in CURL_VALUE_FLAGS if len(f) == 2}


def _curl_short_send(a: str) -> str:
    """Chữ gửi dữ liệu trong cờ ngắn gộp của curl (`-sSd@a.json`, `-d'{…}'`, `-Fa=b`): đọc từng chữ tới cờ ăn giá trị
    đầu tiên; `-o-d` là tên file `-d`, không phải cờ."""
    if not a.startswith("-") or a.startswith("--"):
        return ""
    for c in a[1:]:
        if c in CURL_SEND_SHORT:
            return c
        if c in CURL_SHORT_VALUE:
            return ""
    return ""


def _curl_short_data(args: List[str]) -> List[str]:
    """Giá trị của `-d`/`-F` trong cờ ngắn gộp (`-sd@f`, `-sSd$TOKEN`, `-sd x`)."""
    out: List[str] = []
    for i, a in enumerate(args):
        c = _curl_short_send(a)
        if c in ("d", "F"):
            rest = a.split(c, 1)[1]
            out.append(rest or (args[i + 1] if i + 1 < len(args) else ""))
    return out


def _curl_get_leaks(args: List[str]) -> bool:
    """`-G` đổi dữ liệu thành query string của GET — vẫn là gửi khi kèm upload/phương thức ghi, hoặc dữ liệu là nội
    dung file (`@f`, `name@f`) hay biến môi trường (`$TOKEN`)."""
    if any(a.startswith("--upload-file") or _curl_short_send(a) == "T" for a in args):
        return True
    data = _flag_values(args, tuple(CURL_SEND_LONG)) + _curl_short_data(args)
    return any(re.match(r"[^=]*@", v) or "$" in v for v in data) or any(m in WRITE_METHODS for m in _curl_methods(args))


def _sends_data(name: str, args: List[str]) -> bool:
    if name == "wget":
        methods = _flag_values(args, ("--method",))
        return any(a.split("=", 1)[0] in WGET_SEND for a in args) or any(m.upper() != "GET" for m in methods)
    if "-G" in args or "--get" in args:
        return _curl_get_leaks(args)
    if any(a.split("=", 1)[0] in CURL_SEND_LONG or _curl_short_send(a) for a in args):
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
    if name == "uv" and args[:2] in (["pip", "install"], ["tool", "install"]):
        name, subs, args = f"uv {args[0]}", {"install": args[0] == "tool"}, args[1:]
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
    spec = spec.removeprefix("=")  # `-v=/:/h` (pflag nhận `-v=`)
    if spec.startswith(("type=", "source=", "src=")) or ",source=" in spec or ",src=" in spec:
        kv = dict(p.split("=", 1) for p in spec.split(",") if "=" in p)
        return kv.get("source") or kv.get("src") or ""
    return spec.split(":", 1)[0] if ":" in spec else ""


def _sensitive_mount(spec: str, root: str = "") -> str:
    """Nguồn mount nhạy cảm sau khi chuẩn hoá (`//`, `/tmp/..`, `/home/u/../..` → `/`). Đường dẫn trong dự án — tương
    đối, `$PWD`, hay tuyệt đối dưới gốc dự án (`./.docker/nginx.conf`, `<gốc>/etc/x`) — không xét theo mảnh tên."""
    src = _mount_source(spec)
    absolute = src.startswith("/")
    norm = posixpath.normpath(re.sub("/+", "/", src)) if absolute else src.rstrip("/") or src
    if norm in SAFE_RO_MOUNTS and (spec.endswith(":ro") or ",readonly" in spec or ",ro" in spec):
        return ""
    hit = norm in SENSITIVE_MOUNTS or HOME_DIR_RE.fullmatch(norm) or norm.endswith(".sock")
    hit = hit or (absolute and norm.startswith(SENSITIVE_MOUNT_PREFIXES))
    home_based = absolute or src.startswith(("~", "$HOME", "${HOME}")) or ".." in src.split("/")  # `../.ssh` ra ngoài
    base = root.rstrip("/")
    # Gốc dự án là home (`~`, `/home/u`) thì không miễn: `~/.ssh` "nằm trong dự án" vẫn là bí mật (review #83).
    exempt = base and not (base in SENSITIVE_MOUNTS or HOME_DIR_RE.fullmatch(base) or base == os.path.expanduser("~"))
    home_based = home_based and not (absolute and exempt and (norm == base or norm.startswith(base + "/")))
    return src if hit or (home_based and any(p in norm + "/" for p in SENSITIVE_MOUNT_PARTS)) else ""


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
# `docker run|create` thêm cờ ăn giá trị trước image (để tìm đúng image rồi lệnh chạy trong container).
RUN_VALUE_FLAGS: Tuple[str, ...] = (*EXEC_VALUE_FLAGS, *CONTAINER_HOST_NS, "--cap-add", "--cap-drop", "--security-opt")
RUN_VALUE_FLAGS += ("--device", "--mount", "-m", "--memory", "--cpus", "-h", "--hostname", "--add-host", "--dns")
RUN_VALUE_FLAGS += ("--platform", "--restart", "--pull", "--runtime", "--gpus", "--tmpfs", "--shm-size", "--ulimit")
RUN_VALUE_FLAGS += ("--group-add", "--log-driver", "--log-opt", "--cidfile", "--stop-signal", "--stop-timeout")
RUN_VALUE_FLAGS += ("--sysctl", "--dns-search", "--dns-option", "--health-cmd", "--label-file", "--expose")
RUN_VALUE_FLAGS += ("--mac-address", "--ip", "--ip6", "--link", "--volumes-from", "--workdir", "--user")
# Cờ toàn cục của docker/podman ăn giá trị (đứng trước lệnh con: `docker -l debug --context prod ps`).
DOCKER_GLOBAL_VALUE_FLAGS: Tuple[str, ...] = ("-H", "--host", "-c", "--context", "-l", "--log-level", "--config")
DOCKER_GLOBAL_VALUE_FLAGS += ("--tlscacert", "--tlscert", "--tlskey", "--url", "--connection", "--root", "--runroot")


def _skip_opts(rest: List[str], value_flags: Tuple[str, ...]) -> int:
    i = 0
    while i < len(rest) and rest[i].startswith("-"):
        i += 2 if rest[i] in value_flags else 1
    return i


def _exec_split(args: List[str]) -> Tuple[List[str], List[str]]:
    """(cờ, lệnh bên trong) của `docker exec|run|create [cờ] <ctr|image> <lệnh>` và `docker compose [cờ] exec|run [cờ]
    <dv> <lệnh>`; lệnh con khác → ([], [])."""
    if args[:1] == ["compose"]:
        i = _skip_opts(args[1:], COMPOSE_VALUE_FLAGS) + 1
        if args[i : i + 1] not in (["exec"], ["run"]):
            return [], []
    elif args[:1] not in (["exec"], ["run"], ["create"]):
        return [], []
    else:
        i = 0
    rest = args[i + 1 :]
    k = _skip_opts(rest, RUN_VALUE_FLAGS)
    return rest[:k], normalize(rest[k + 1 :])


def _host_power(opts: List[str], root: str = "") -> str:
    """Cờ trao quyền máy chủ: privileged, namespace của host, cap nguy hiểm, thiết bị, unconfined, mount nhạy cảm."""
    why = ""
    if "--privileged" in opts or any(a.startswith("--privileged=") and a != "--privileged=false" for a in opts):
        why = "--privileged"
    why = why or next((f"{f}=host" for f in CONTAINER_HOST_NS if "host" in _flag_values(opts, (f,))), "")
    caps = {c.upper().removeprefix("CAP_") for v in _flag_values(opts, ("--cap-add",)) for c in v.split(",")}
    why = why or ("--cap-add " + ",".join(sorted(caps & DANGEROUS_CAPS)) if caps & DANGEROUS_CAPS else "")
    why = why or ("--device" if _flag_values(opts, ("--device",)) else "")
    unconfined = any("unconfined" in v for v in _flag_values(opts, ("--security-opt",)))
    why = why or ("--security-opt unconfined" if unconfined else "")
    mounts = [m for v in _flag_values(opts, ("-v", "--volume", "--mount")) for m in [_sensitive_mount(v, root)] if m]
    return why or (f"mount {mounts[0]}" if mounts else "")


def _container_rule(args: List[str], root: str = "") -> str:
    """`docker|podman` điều khiển daemon máy khác (`-H`, `--context`), container có quyền máy chủ (`run|create`,
    `compose run`, `exec --privileged`), hoặc lệnh trong container ra khỏi máy dev."""
    k = _skip_opts(args, DOCKER_GLOBAL_VALUE_FLAGS)
    glob, args = args[:k], args[k:]
    remote = any(_docker_remote(h) for h in _flag_values(glob, ("-H", "--host")))
    if remote or _flag_values(glob, ("--context", "-c")):
        return f"{EGRESS_ASK} — container trên daemon máy khác"
    if args[:1] == ["container"]:
        args = args[1:]
    opts, _ = _exec_split(args)
    why = _host_power(opts, root)  # lệnh bên trong quét ở `_container_asks` (đủ luật, gốc giả)
    return f"container có quyền máy chủ ({why})" if why else ""


def _unwrap(name: str, args: List[str]) -> Tuple[str, List[str]]:
    """Lệnh thật sau trình thông dịch `-m` (`python3 -I -W x -m pip …`) và lệnh bọc (`uv run`, `npx`, `corepack`)."""
    if name in INTERPRETERS or PYTHON_RE.fullmatch(name):
        k = 0
        while k < len(args) and args[k].startswith("-") and args[k] != "-m":
            k += 2 if args[k] in INTERP_VALUE_FLAGS else 1
        if args[k : k + 1] == ["-m"] and len(args) > k + 1:
            return _unwrap(args[k + 1], args[k + 2 :])
    if name in PKG_WRAPPERS and (not PKG_WRAPPERS[name] or args[:1] == [PKG_WRAPPERS[name]]):
        rest = args[1:] if PKG_WRAPPERS[name] else args
        rest = normalize(rest[_skip_opts(rest, WRAPPER_VALUE_FLAGS) :])  # `/bin/bash`, `env bash` → `bash`
        if rest and (rest[0] in PKG_ADD or rest[0] in INTERPRETERS or PYTHON_RE.fullmatch(rest[0])):
            return _unwrap(rest[0], rest[1:])
    return name, args


def egress_rule(name: str, args: List[str], root: str = "") -> Tuple[str, str]:
    """Kết nối/gửi ra máy khác, thêm phụ thuộc, container có quyền máy chủ → ask (không deny: việc hợp lệ khi người duyệt)."""
    name, args = _unwrap(name, args)
    why = ""
    if name in REMOTE_SHELLS or name in REMOTE_COPY:
        why = _remote_rule(name, args)
    elif name in DB_CLIENTS:
        why = _db_rule(name, args)
    elif name in FETCHERS:
        why = _fetch_rule(name, args)
    elif name in PKG_ADD:
        why = _pkg_rule(name, args)
    elif name in ("docker", "podman", "nerdctl", "docker-compose", "podman-compose"):
        why = _container_rule(_container_cli([name, *args])[1:], root)
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


# CLI agent KHÁC Claude Code không chạy hook của khung; chạy nó với cờ tự duyệt = đường vòng quanh guard (LOOP-STOP-028,
# stored 01 §3g.4). Claude Code lồng vẫn nạp hook của dự án nên chỉ xét cờ tắt hook ở trên (bypass vẫn chịu hook exit 2
# và deny — docs permission-modes). Cờ dạng `--x giá-trị` so cả cặp `--x=giá-trị`. Đọc 2026-10-18 từ docs/mã nguồn:
# Codex (learn.chatgpt.com developer-commands, codex-rs shared_options.rs), Gemini CLI docs/cli/cli-reference.md,
# Copilot CLI command reference, opencode.ai/docs/cli, aider.chat config options, cursor.com/docs/cli/reference/parameters
# (tên binary `cursor-agent` chưa xác minh), Amp: docs E2B/SDK (`--dangerously-allow-all`, chưa thấy ở docs chính thức).
AGENT_CLI_PKGS = {
    "@openai/codex": "codex",
    "@google/gemini-cli": "gemini",
    "@github/copilot": "copilot",
    "opencode-ai": "opencode",
    "aider-chat": "aider",
}
# Trình chạy gói Python (gói npm ở PKG_RUNNERS): `uvx aider-chat …`, `pipx run aider-chat …`.
AGENT_PY_RUNNERS = {("uvx",), ("uv", "tool", "run"), ("pipx", "run")}
# Codex `-c/--config key=value` ghi đè cấu hình = cờ tự duyệt (`approval_policy=never`, `sandbox_mode=danger-full-access`).
CODEX_CONFIG_RE = re.compile(r"""(approval_policy|sandbox_mode)\s*=\s*['"]?(never|danger-full-access)['"]?""")
# CLI dùng argparse (cho viết tắt tiền tố cờ dài: `aider --yes` = `--yes-always`).
AGENT_PREFIX_ABBREV = {"aider"}
AGENT_SELF_APPROVE = {
    # `--full-auto` đã gỡ ở bản hiện hành — giữ để chặn bản cũ.
    "codex": {
        *("--dangerously-bypass-approvals-and-sandbox", "--yolo", "--approve-for-me", "--not-so-yolo", "--full-auto"),
        *("--sandbox=danger-full-access", "-s=danger-full-access", "--ask-for-approval=never", "-a=never"),
    },
    "gemini": {"--approval-mode=yolo", "--yolo", "-y"},  # `--yolo`/`-y` deprecated, vẫn chạy
    "copilot": {"--allow-all-tools", "--allow-all", "--yolo"},
    "opencode": {"--auto"},
    "aider": {"--yes-always"},
    "cursor-agent": {"--force", "-f", "--yolo", "--approve-mcps"},
    "amp": {"--dangerously-allow-all"},
}
AGENT_SELF_APPROVE_ENV = {"copilot": "COPILOT_ALLOW_ALL", "aider": "AIDER_YES_ALWAYS"}


def _pkg_base(t: str) -> str:
    """Tên gói bỏ hậu tố phiên bản: `@openai/codex@0.5` → `@openai/codex`, `opencode-ai@latest` → `opencode-ai`."""
    if t.startswith("@"):
        return "@" + t[1:].partition("@")[0]
    return t.partition("@")[0]


def _py_runner_target(n: List[str]) -> int:
    """Chỉ số gói được `uvx`/`uv tool run`/`pipx run` chạy (bỏ qua cờ, `--from <gói>` → lệnh sau nó); -1 nếu không."""
    for prefix in AGENT_PY_RUNNERS:
        if tuple(n[: len(prefix)]) == prefix:
            i = len(prefix)
            while i < len(n) and n[i].startswith("-"):
                i += 2 if n[i] in ("--from", "--with", "--python", "-p", "--spec") else 1
            return i if i < len(n) else -1
    return -1


def _agent_cli(n: List[str]) -> Tuple[str, List[str]]:
    """(tên CLI agent, tham số) khi lệnh gọi một CLI agent khác Claude Code (trực tiếp hoặc qua npx/uvx/pipx…)."""
    name, i = posixpath.basename(n[0]), 1
    t = max(_runner_target(n), _py_runner_target(n))
    if t >= 0:
        name, i = n[t], t + 1
    name = AGENT_CLI_PKGS.get(_pkg_base(name), _pkg_base(name))
    args = n[i:]
    if t >= 0 and args[:1] == ["--"]:  # `npx <gói> -- <args>`: `--` của trình chạy, không phải của CLI
        args = args[1:]
    return (name, args) if name in AGENT_SELF_APPROVE else ("", [])


def _self_approve_flag(name: str, a: str, nxt: str) -> str:
    """Cờ tự duyệt khớp với token `a` (kèm giá trị `nxt` cho dạng `--x giá-trị`); rỗng nếu không."""
    flags = AGENT_SELF_APPROVE[name]
    pair = a if "=" in a or not nxt else f"{a}={nxt}"
    if a in flags or pair in flags:
        return a if a in flags else pair
    if name == "codex" and a.split("=", 1)[0] in ("-c", "--config"):
        val = a.split("=", 1)[1] if "=" in a else nxt
        return f"{a} {val}".strip() if CODEX_CONFIG_RE.search(val) else ""
    if a.startswith("--") and len(a) >= 5 and name in AGENT_PREFIX_ABBREV:
        return next((f for f in sorted(flags) if f.startswith(a.split("=", 1)[0])), "")
    if len(a) > 2 and a[0] == "-" and a[1] != "-":  # cụm cờ ngắn `-yp` (yargs/commander)
        return next((f"-{c}" for c in a[1:] if f"-{c}" in flags), "")
    return ""


def agent_self_approve(argv: List[str], n: List[str], exported: Tuple[str, ...] = ()) -> str:
    """Lý do chặn khi lệnh mở CLI agent khác với cờ (hoặc biến môi trường — gán trong lệnh hoặc `export` trước đó trong
    cùng chuỗi lệnh) tự duyệt mọi công cụ; rỗng nếu không."""
    name, args = _agent_cli(n)
    if not name:
        return ""
    env = AGENT_SELF_APPROVE_ENV.get(name, "")
    if env and (env in _env_assigns(argv) or env in exported):
        return f"CLI agent `{name}` với `{env}` tự duyệt mọi lệnh ngoài guard — bỏ qua hook của dự án (LOOP-STOP-028)"
    for k, a in enumerate(args):
        if a == "--":
            break
        hit = _self_approve_flag(name, a, args[k + 1] if k + 1 < len(args) else "")
        if hit:
            return (
                f"CLI agent `{name}` với `{hit}` tự duyệt mọi lệnh ngoài guard — bỏ qua hook của dự án (LOOP-STOP-028)"
            )
    return ""


def hook_bypass(argv: List[str], n: List[str], exported: Tuple[str, ...] = ()) -> str:
    """Lý do hỏi nếu lệnh tắt/bỏ qua hook của dự án; chuỗi rỗng nếu không."""
    claude = _claude_args(n) or []
    hit = _bypass_marker(argv, n, claude)
    if hit:
        return f"lệnh đặt `{hit}` (tắt hook của khung)"
    if _git_hooks_off(n):
        return "tắt git hook của dự án (`core.hooksPath`) — bỏ qua hook của dự án"
    key = _git_exec_config(n, argv) if n[:1] == ["git"] else ""
    if key:
        return f"cấu hình git `{key}` chạy lệnh ngầm ngoài guard — bỏ qua hook của dự án"
    flag = next((a.split("=", 1)[0] for a in claude if a.split("=", 1)[0] in HOOK_BYPASS_FLAGS), "")
    return f"phiên Claude với `{flag}` có thể bỏ qua hook của dự án" if flag else agent_self_approve(argv, n, exported)


GIT_CONFIG_UNSET = {"--unset", "--unset-all", "unset"}
# Khoá git chạy lệnh tuỳ ý ở các lệnh git sau (fsmonitor chạy ở `git status`…), đặt bằng `git config` hoặc một lần qua
# `git -c`: ghi = lệnh chạy ngoài guard. Liệt kê theo MẪU (hậu tố `.cmd`/`.program`/`.command`/`.helper`…) vì danh sách
# từng khoá cứ sót (review #117: `include.path`, `core.gitProxy`, `mergetool.*.cmd`, `gpg.ssh.program`, `uploadpack`).
GIT_EXEC_KEY_RE = re.compile(
    r"core\.(fsmonitor|sshcommand|gitproxy|pager|editor|askpass|alternaterefscommand)|sequence\.editor"
    r"|diff\.external|pager\..+|alias\..+|protocol(\..+)?\.allow|gpg(\..+)?\.(program|defaultkeycommand)"
    r"|sendemail\.(\w*cmd|smtpserver)|init\.templatedir|uploadpack\.packobjectshook|submodule\..+\.update|delta\.pager"
    r"|.+\.(textconv|clean|smudge|process|driver|cmd|command|program|helper|uploadpack|receivepack|path)",
    re.I,
)
# Giao thức `ext::` chạy lệnh tuỳ ý (git mặc định cấm); URL `ext::` ở bất kỳ lệnh git nào → chặn.
GIT_URL_SUBCMDS = {"fetch", "clone", "pull", "push", "ls-remote", "remote", "submodule", "archive", "config"}
GIT_EXT_URL_RE = re.compile(r"(^|[=\s'\".])ext::", re.I)
# Giá trị cho qua theo loại khoá — so NGUYÊN VĂN, không theo tên chương trình (`vim -S x.vim`, `ssh -F cfg` chạy lệnh
# tuỳ ý qua đối số). Không khớp → chặn; giá trị khác thì người đặt tay.
GIT_SAFE_VALUES: Tuple[Tuple["re.Pattern[str]", "re.Pattern[str]"], ...] = (
    (re.compile(r"alias\..+", re.I), re.compile(r"[^!].*|", re.S)),  # alias không bắt đầu `!` = lệnh git
    (
        re.compile(r"credential(\..+)?\.helper", re.I),
        re.compile(
            r"|store|cache( --timeout[= ]\d+)?|osxkeychain|wincred|manager(-core)?|libsecret"
            r"|/usr/[\w/.-]*git-credential-[\w-]+|!(/usr/(local/)?bin/)?gh auth git-credential"
        ),
    ),
    (
        re.compile(r"core\.pager|pager\..+", re.I),
        re.compile(r"|cat|less( -[FRSXK]+)*|more|delta( --[\w-]+)*|true|false"),
    ),
    (
        re.compile(r"core\.editor|sequence\.editor", re.I),
        re.compile(r"vim?|nvim|nano( -w)?|emacs|code (--wait|-w)|subl( -[nw])*|true|:"),
    ),
    (
        re.compile(r"core\.sshcommand", re.I),
        re.compile(
            r"ssh( -i [\w~/.@-]+| -o ?(StrictHostKeyChecking|UserKnownHostsFile|IdentitiesOnly|BatchMode)=[\w~/.-]+)*"
        ),
    ),
    (re.compile(r"core\.fsmonitor", re.I), re.compile(r"true|false")),
    (re.compile(r"merge\..+\.driver", re.I), re.compile(r"true")),
    (re.compile(r"submodule\..+\.update", re.I), re.compile(r"checkout|rebase|merge|none")),
    (
        re.compile(r"sendemail\.smtpserver", re.I),
        re.compile(r"[\w.-]+"),
    ),  # tên máy; đường dẫn = chương trình  # chiến lược "ours" của .gitattributes
    (re.compile(r"gpg\.program", re.I), re.compile(r"gpg2?")),
    # `user`/`always` chỉ cho giao thức thường — `ext::` (chạy lệnh) không bao giờ (review #117 lần 4).
    (re.compile(r"protocol\.(https?|ssh|git|file)\.allow", re.I), re.compile(r"never|user|always")),
    (re.compile(r"protocol(\..+)?\.allow", re.I), re.compile(r"never")),
)


GIT_CONFIG_VALUE_OPTS = ("-f", "--file", "--blob", "--type", "--default", "--comment", "--value")


def _git_config_write(n: List[str]) -> List[str]:
    """[khoá, giá trị…] của lệnh `git config` GHI (cả `--unset`; `-f <tệp>` không phải khoá); [] nếu chỉ đọc."""
    if n[:2] != ["git", "config"] or set(n[2:]) & (GIT_CONFIG_READ - GIT_CONFIG_UNSET):
        return []
    return [a for a in _positionals(n[2:], GIT_CONFIG_VALUE_OPTS) if a not in ("set", "--add", "unset")]


def _git_config_file(n: List[str]) -> str:
    """Tệp cấu hình mà `git config -f/--file <tệp>` ghi (`.git/config` → đích ghi hàng rào); rỗng nếu không."""
    if n[:2] != ["git", "config"]:
        return ""
    for k, a in enumerate(n[2:-1], start=2):
        if a in ("-f", "--file"):
            return n[k + 1]
    return next((a.split("=", 1)[1] for a in n[2:] if a.startswith("--file=")), "")


def _git_exec_value_unsafe(key: str, value: str) -> bool:
    """Giá trị đặt cho khoá chạy lệnh có thể chạy lệnh tuỳ ý: chỉ giá trị khớp nguyên văn `GIT_SAFE_VALUES` là an toàn."""
    v = value.strip()
    return not any(k.fullmatch(key) and ok.fullmatch(v) for k, ok in GIT_SAFE_VALUES)


def _git_hooks_off(n: List[str]) -> bool:
    """`git config [--global] core.hooksPath <x>` hoặc `--unset core.hooksPath` (husky `.husky/_` mất): git hook của dự
    án thôi chạy cho mọi commit sau."""
    pos = _git_config_write(n)
    return bool(pos) and pos[0].lower() == "core.hookspath" and (len(pos) > 1 or bool(set(n) & GIT_CONFIG_UNSET))


def _git_exec_config(n: List[str], argv: Optional[List[str]] = None) -> str:
    """Khoá git chạy lệnh tuỳ ý: đặt bằng `git config` hoặc một lần qua `git -c k=v …`; rỗng nếu không."""
    pos = _git_config_write(n)
    if len(pos) >= 2 and GIT_EXEC_KEY_RE.fullmatch(pos[0]) and _git_exec_value_unsafe(pos[0], pos[1]):
        return pos[0]
    one_shot = argv or []
    # URL `ext::` chỉ ở lệnh con nhận URL/cấu hình và ở giá trị `-c` — không quét `commit -m "… ext:: …"`.
    scan = n[2:] if n[1:2] and n[1] in GIT_URL_SUBCMDS else []
    scan += [one_shot[k + 1] for k, a in enumerate(one_shot[:-1]) if a == "-c"]
    if any(GIT_EXT_URL_RE.search(a) for a in scan):  # `git fetch ext::…`, `remote add x ext::…`, `insteadOf`
        return "ext::"
    for k, a in enumerate(one_shot[:-1]):
        key, _, val = one_shot[k + 1].partition("=") if a == "-c" else ("", "", "")
        if key and GIT_EXEC_KEY_RE.fullmatch(key) and _git_exec_value_unsafe(key, val):
            return key
    return ""


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


def _url_name(u: str) -> str:
    """Tên file mà `curl -O`/`wget` lưu: phần cuối đường dẫn của URL (bỏ query/fragment)."""
    path = u.split("://", 1)[-1].split("?", 1)[0].split("#", 1)[0]
    return posixpath.basename(path.rstrip("/")) if "/" in path else ""


def _curl_outputs(args: List[str]) -> List[str]:
    """Đích ghi của curl: `-o f`, `--output f|=f`, cờ gộp `-sSo f`; `-O`/`--remote-name` = tên cuối URL (AUD-SEC-049)."""
    out = _flag_values(args, ("--output",))
    remote = "--remote-name" in args or "--remote-name-all" in args
    for i, a in enumerate(args):
        for j, c in enumerate(a[1:] if a.startswith("-") and not a.startswith("--") else "", 1):
            remote = remote or c == "O"
            if c in CURL_SHORT_VALUE:
                if c == "o":
                    out.append(a[j + 1 :] or (args[i + 1] if i + 1 < len(args) else ""))
                break
    names = [_url_name(u) for u in args if "://" in u] if remote else []
    d = (_flag_values(args, ("--output-dir",)) or [""])[-1]  # `--output-dir D` ghép với tên của `-O`/`-o`
    return [posixpath.join(d, f) for f in out + names] if d else out + names


def _wget_outputs(args: List[str]) -> List[str]:
    """Đích ghi của wget: `-O f`/`-qO f`/`--output-document=f`; không có thì tên cuối của từng URL (AUD-SEC-049)."""
    out = _flag_values(args, ("-O", "--output-document"))
    out += [
        args[i + 1] for i, a in enumerate(args[:-1]) if a[:1] == "-" and a[1:2] != "-" and len(a) > 2 and a[-1] == "O"
    ]
    d = (_flag_values(args, ("-P", "--directory-prefix")) or [""])[-1]
    names = out or [_url_name(u) for u in args if "://" in u]
    return [posixpath.join(d, f) for f in names] if d else names


def _rsync_dest(args: List[str]) -> List[str]:
    pos = _positionals(args, REMOTE_VALUE_FLAGS)
    return pos[-1:] if len(pos) >= 2 and ":" not in pos[-1] else []


def _patch_targets(args: List[str]) -> List[str]:
    """patch [tuỳ chọn] [file gốc [file patch]]: file gốc bị sửa tại chỗ; `-o f` ghi ra f."""
    pos = _positionals(args, ("-i", "-o", "-d", "-B", "-r", "-z", "-V", "-D", "-F", "-g", "--output", "--input"))
    return pos[:1] + _flag_values(args, ("-o", "--output"))


FILE_WRITERS: Dict[str, Callable[[List[str]], List[str]]] = {
    "curl": _curl_outputs,
    "wget": _wget_outputs,
    "rsync": _rsync_dest,
    "patch": _patch_targets,
}


def _git_file_targets(n: List[str]) -> List[str]:
    """File mà `git checkout <rev> -- f`/`git restore -s <rev> f` ghi đè từ commit khác — chỉ xét bí mật: khôi phục file
    cổng/hàng rào bằng git là đường lùi chuẩn, không chặn."""
    if n[:2] in (["git", "checkout"], ["git", "restore"]):
        return _positionals(n[2:], ("-s", "--source", "-b", "-B", "--orphan", "--conflict", "--pathspec-from-file"))
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
    if name == "find":
        return out + _find_delete_roots(args)
    if name == "truncate":
        return out + _positionals(args, ("-s", "--size", "-r", "--reference"))
    if name == "touch":
        return out + _positionals(args, ("-d", "-t", "-r", "--date", "--reference"))
    if name in FILE_WRITERS:
        return out + FILE_WRITERS[name](args)
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


# Hàng rào của harness (AUD-SEC-046): Bash ghi đè/xoá/dời = gỡ hàng rào mà không để lại diff đọc được → chặn. Sửa hook
# bằng Edit/Write vẫn được (ADR-0018: sửa cấu hình hook cho chạy, nêu lý do); khôi phục bằng `git checkout -- <file>`.
FENCE_PATTERNS = (".claude/hooks/*", ".claude/settings.json", ".claude/settings.local.json")
FENCE_DIRS = {".claude", ".claude/hooks"}
FENCE_WHY = "ghi/xoá hàng rào qua Bash ({}) — tắt hook của khung; sửa bằng Edit/Write, khôi phục bằng git checkout"


def _is_fence(target: str, root: str) -> bool:
    if not target or target.startswith("/dev/"):
        return False
    rel = rel_path(target, root).rstrip("/")
    return rel in FENCE_DIRS or _match_any(rel, FENCE_PATTERNS)


def _at(target: str, cwd: Optional[str]) -> str:
    """Đích ghi tương đối tính từ thư mục lệnh đang đứng (`cd .claude/hooks && echo x > guard.py`)."""
    if not cwd or not target or target.startswith(("/", "~", "$")):
        return target
    return posixpath.normpath(posixpath.join(cwd, target))


EVIDENCE_WHY = "ghi/xoá tay bằng chứng autopilot qua Bash ({}) — chỉ `xt.py loop …` được ghi (P1)"


PWD_REF_RE = re.compile(r"^(\$PWD|\$\{PWD\}|\$\(pwd\)|`pwd`)(?=/|$)")
PROJECT_REF_RE = re.compile(r"^(\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\})(?=/|$)")


def _resolve_target(t: str, root: str, cwd: Optional[str]) -> str:
    """Đích ghi với `$PWD`/`$(pwd)`/`$CLAUDE_PROJECT_DIR` đứng đầu được mở ra thư mục thật, rồi tính từ thư mục đang đứng
    (`rm -rf $PWD/.autopilot` từng lọt: dấu `$` làm đích bị coi là không rõ)."""
    t = PROJECT_REF_RE.sub(lambda _: root, PWD_REF_RE.sub(lambda _: cwd or root, t, count=1), count=1)
    return _at(t, cwd)


def _write_asks(n: List[str], argv: List[str], root: str, cwd: Optional[str] = None) -> List[str]:
    """Câu hỏi xác nhận cho file hàng rào/bí mật/cổng/migration mà lệnh có thể ghi (bỏ qua /dev/*)."""
    asks: List[str] = []
    if n and n[0] in ("chmod", "chown", "chattr"):  # bỏ quyền thực thi = git bỏ qua hook
        asks += [
            GIT_HOOK_WHY.format(t)
            for t in _positionals(n[1:])
            if _match_any(rel_path(_at(t, cwd), root), GIT_HOOK_PATTERNS)
        ]
    cfg = _git_config_file(n)
    find_evidence = _find_evidence_targets(n[1:]) if n[:1] == ["find"] else []
    targets = [*write_targets(n, argv), *([cfg] if cfg else [])]
    asks += [
        EVIDENCE_WHY.format(t)
        for t in (_resolve_target(t, root, cwd) for t in find_evidence)
        if t not in targets and _target_kind(t, root) == "evidence"
    ]
    for target in (_resolve_target(t, root, cwd) for t in targets):
        kind = _target_kind(target, root)
        if _is_fence(target, root):
            asks.append(FENCE_WHY.format(target))
        elif target and _match_any(rel_path(target, root), GIT_HOOK_PATTERNS):
            asks.append(GIT_HOOK_WHY.format(target))
        elif kind == "secret":
            asks.append(f"ghi file bí mật qua Bash: {target}")
        elif kind in ("gate", "migration"):
            asks.append(f"sửa cấu hình cổng/CI/harness/migration qua Bash ({target}) — nói rõ lý do")
        elif kind == "evidence":
            asks.append(EVIDENCE_WHY.format(target))
        elif kind == "capability":
            asks.append(CAPABILITY_WHY.format(f"ghi {target} qua Bash"))
        elif _existing_test(target, root):
            asks.append(f"sửa/xoá test ĐÃ CÓ qua Bash ({target}) — làm yếu test là nới cổng (LOOP-CI-001)")
    secrets = [t for t in _git_file_targets(n) if _target_kind(t, root) == "secret"]
    return asks + [f"ghi file bí mật qua Bash (git lấy từ commit khác): {t}" for t in secrets]


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


def _commit_hooks_path(argv: List[str]) -> bool:
    """Lệnh commit đặt `core.hooksPath` qua `-c` hoặc biến `GIT_CONFIG_KEY_<n>` (git ≥ 2.31)."""
    low = [a.lower() for a in argv]
    return any(a.startswith("core.hookspath=") for a in low) or any(
        re.fullmatch(r"git_config_key_\d+=core\.hookspath", a) for a in low
    )


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


# Ghi công AI trong commit (LOOP-HARNESS-027): repo khai `ai_attribution: forbid` trong xt.yaml (repo khung: AGENTS.md §3)
# → commit mà message có tên model hay URL phiên AI bị chặn. Message = `-m`/`--message`, file của `-F`/`--file`, thân
# heredoc trong cùng lệnh Bash (`-F - <<E`, `-m "$(cat <<E …)"` — tokenize bỏ thân heredoc nên đọc từ chuỗi gốc).
AI_ATTRIBUTION_RE = re.compile(
    r"claude-session\s*:|claude\.ai/code/session_|"
    r"\bclaude(?:[\s_-]+[\d.]+)*[\s_-]+(?:opus|sonnet|haiku|fable|instant)\b",  # `Claude Opus 5`, `claude-3-5-sonnet`
    re.I,
)
AI_ATTRIBUTION_KEY_RE = re.compile(r"^ai_attribution:[ \t]*([\"']?)forbid\1[ \t]*(?:#.*)?$", re.M)
COMMIT_TEXT_MAX = 1 << 16  # đọc tối đa 64 KiB mỗi file (xt.yaml, file message)
COMMIT_MSG_OPTS = {"-m": "m", "--message": "m", "--trailer": "m", "--author": "m", "-F": "F", "--file": "F"}


def _read_head(path: str) -> str:
    """Tối đa COMMIT_TEXT_MAX ký tự đầu FILE THƯỜNG; không đọc được/FIFO/thiết bị → rỗng (fail-open, không treo hook)."""
    if not os.path.isfile(path):
        return ""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read(COMMIT_TEXT_MAX)
    except OSError:
        return ""


def _commit_msg_args(args: List[str]) -> List[Tuple[str, str]]:
    """(loại, giá trị) của message trong đối số `git commit`: `m` = chữ, `F` = đường dẫn file (`-am"x"`, `--file=f`)."""
    out: List[Tuple[str, str]] = []
    for i, x in enumerate(args):
        nxt = args[i + 1] if i + 1 < len(args) else ""
        key, sep, val = x.partition("=")
        m = COMMIT_SHORT_VALUE_RE.match(x)
        if x in COMMIT_MSG_OPTS:
            out.append((COMMIT_MSG_OPTS[x], nxt))
        elif key in ("--message", "--file", "--trailer", "--author") and sep:
            out.append((COMMIT_MSG_OPTS[key], val))
        elif m and m.group(2) in "mF" and not x.startswith("--"):
            out.append((m.group(2), x[m.end() :] or nxt))
    return out


# `git [cờ toàn cục…] commit`: `-C "a b"`, `-c k=v`, `--no-pager`, `--git-dir=…` (văn bản thô — `$(cat <<E` chưa đóng nháy).
# Các nhánh tách bạch (giá trị không nháy không mở đầu bằng nháy) — trùng nhau thì backtrack hàm mũ (CodeQL, #125).
GIT_COMMIT_TEXT_RE = re.compile(
    r"(?<![\w-])git(?:\s+(?:-[Cc]\s+(?:\"[^\"]*\"|'[^']*'|[^\s\"']\S*)|--[\w-]+(?:=\S+)?|-[pP]))*\s+commit\b"
)
GIT_TOP_MAX = 64  # số cấp thư mục cha tối đa khi tìm xt.yaml
COMMIT_LINE_MAX = 4096  # regex quanh heredoc trên dòng mở: mỗi phía tối đa chừng này để thời gian có trần (review #125)


def _unquoted_seps(line: str) -> List[Tuple[int, int]]:
    """Vị trí `;`/`&&`/`||`/`&` nằm NGOÀI nháy: `git commit -m "fix: a; b" -m "$(cat <<E` vẫn là một pipeline."""
    seps: List[Tuple[int, int]] = []
    i, q, n = 0, "", len(line)
    while i < n:
        c = line[i]
        if q == "'":
            q = "" if c == "'" else q
        elif c == "\\":
            i += 2
            continue
        elif q:
            q = "" if c == '"' else q
        elif c in "'\"":
            q = c
        else:
            sep = LIST_SEP_RE.match(line, i)
            if sep:
                seps.append(sep.span())
                i = sep.end()
                continue
        i += 1
    return seps


def _segment_at(line: str, pos: int, seps: List[Tuple[int, int]]) -> Tuple[int, int]:
    """(đầu, cuối) của pipeline chứa `pos`, tách theo dấu nối ngoài nháy/escape (`seps` từ `_unquoted_seps`)."""
    start = max((e for s, e in seps if e <= pos), default=0)
    end = min((s for s, e in seps if s >= pos), default=len(line))
    return start, end


def _commit_window(line: str, pos: int, seps: List[Tuple[int, int]]) -> str:
    """Pipeline chứa heredoc ở `pos` (tách theo dấu nối ngoài nháy), cắt còn ≤ COMMIT_LINE_MAX mỗi phía QUANH heredoc —
    lệnh commit thường ngay trước heredoc, nên tiền tố dài (`X=…4 KiB… git commit -F - <<E`) không đẩy nó ra ngoài."""
    start, end = _segment_at(line, pos, seps)
    return line[max(start, pos - COMMIT_LINE_MAX) : min(end, pos + COMMIT_LINE_MAX)]


def _heredoc_bodies(cmd: str) -> List[str]:
    """Thân heredoc thuộc pipeline có `git commit` (`git commit -F - <<E`, `-m "$(cat <<E`, `cat <<E | git commit -F -`);
    heredoc của lệnh khác trong cùng chuỗi (`python3 - <<E …; git commit`) là dữ liệu của lệnh đó, không quét."""
    out: List[str] = []
    for opener, m, body in _heredocs(join_continuations(cmd)):  # nối dòng `\` như shell (`git commit \` ↵ `-F - <<E`)
        if GIT_COMMIT_TEXT_RE.search(_commit_window(opener, m.start(), _unquoted_seps(opener))):
            out.append("\n".join(body))
    return out


def _xt_yaml_for(d: str) -> str:
    """`xt.yaml` gần nhất từ `d` đi lên (đường dẫn thật — symlink theo git), dừng ở gốc repo (thư mục có `.git`, tính cả
    nó): dự án trong repo cha (monorepo `apps/web`) và commit từ thư mục con đều thấy khoá. Không có → rỗng."""
    cur = os.path.realpath(d)
    for _ in range(GIT_TOP_MAX):
        if os.path.isfile(os.path.join(cur, "xt.yaml")):
            return os.path.join(cur, "xt.yaml")
        parent = os.path.dirname(cur)
        if os.path.exists(os.path.join(cur, ".git")) or parent == cur:
            break
        cur = parent
    return ""


def ai_attribution(cmd: str, commands: List[Tuple[List[str], Optional[str]]], root: str) -> str:
    """Lý do chặn khi lệnh commit vào repo cấm ghi công AI mà message chứa tên model/URL phiên; không thì rỗng.
    Chỉ xét `git commit` qua Bash, message thấy được lúc quyết định — không thấy: `echo … | git commit -F -`, file `-F`
    do lệnh trước trong chuỗi tạo, commit qua tool MCP/`git merge -m`/`git tag -m` (LOOP-HARNESS-027)."""
    for argv, here in commands:
        n = normalize(argv)
        gdir = (_git_dir(argv, here) if n[:2] == ["git", "commit"] else None) or root
        if n[:2] != ["git", "commit"] or not AI_ATTRIBUTION_KEY_RE.search(_read_head(_xt_yaml_for(gdir))):
            continue
        # `-F` tương đối tính từ thư mục git chạy (sau `-C`), như git.
        texts = [v if k == "m" else _read_head(posixpath.join(gdir, v)) for k, v in _commit_msg_args(n[2:])]
        hit = next(
            (m.group(0) for t in [*texts, *_heredoc_bodies(cmd)] for m in [AI_ATTRIBUTION_RE.search(t)] if m), ""
        )
        if hit:
            return (
                f"Commit ghi công AI bị khung chặn (`{hit}` — xt.yaml `ai_attribution: forbid`, LOOP-HARNESS-027): bỏ "
                "dòng tên model/URL phiên khỏi message rồi commit lại."
            )
    return ""


def _track_exports(res: Dict[str, object], argv: List[str], n: List[str]) -> Tuple[str, ...]:
    """Biến đã `export`/`declare` ở lệnh trước trong cùng chuỗi (`export X=1; cmd`), cộng lệnh hiện tại nếu là export."""
    prev = res.get("exported")
    names = tuple(str(x) for x in prev) if isinstance(prev, tuple) else ()
    if n[0] in DECLARE_CMDS:
        names += tuple(_env_assigns(argv))
        res["exported"] = names
    return names


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
    bypass = hook_bypass(argv, n, _track_exports(res, argv, n))
    if bypass:
        asks.append(f"{bypass}: {' '.join(argv)[:200]}")
    asks.extend(_write_asks(n, argv, root, cwd))
    if n[0] in (*DB_CLIENTS, "docker", "podman") and decision != "ask":  # `PGHOST=… psql`: normalize đã bóc phần gán
        assigns = [t for t in argv[: len(argv) - len(n)] if ENV_ASSIGN_RE.fullmatch(t)]
        docker = [v for k, _, v in (a.partition("=") for a in assigns) if k == "DOCKER_HOST" and _docker_remote(v)]
        remote = next((h for h in _env_hosts(assigns) if not _is_local_host(h)), "") or next(iter(docker), "")
        if remote:
            asks.append(f"{EGRESS_ASK} — {n[0]} tới máy chủ {remote}: {' '.join(argv)[:200]}")
    if n[:2] == ["git", "commit"] and _commit_hooks_path(argv):
        # `git -c core.hooksPath=… commit`, `GIT_CONFIG_KEY_n=core.hooksPath … git commit` = --no-verify: git hook của
        # dự án không chạy — cùng câu hỏi như --no-verify (strict hỏi người; mặc định cổng của khung vẫn chạy).
        res["no_verify"] = True
        asks.append("commit với `core.hooksPath` bỏ qua git hook — cần người xác nhận lý do")
    if n[:2] == ["git", "commit"]:
        # Cổng chạy ở repo NHẬN commit (`cd ../khac && git commit`, `git -C ../khac commit`), không phải gốc phiên.
        res["commit_dir"] = gdir or ""
        return _scan_commit(n[2:], res, asks)
    return None


SCAN_CALLS = 600  # số lệnh con tối đa MỖI quyết định (lệnh bình thường dùng < 20)
SCAN_SECONDS = 8.0  # hạn giờ quét một quyết định; hook có timeout 600 s — quá hạn thì lệnh chạy không qua guard
MAX_REWRITE = 8  # số lần viết lại CÙNG lệnh (thay biến, lệnh bọc) lồng nhau; vượt → chặn (`flock l ` ×10 + lệnh)
CMD_MAX_CHARS = 262144  # lệnh dài hơn → chặn: quét gần bậc hai theo độ dài (4 MB từng mất > 600 s, quá timeout hook)
REWRITE_MAX_CHARS = 65536  # bản viết lại dài hơn (biến 4 KB nhân lên nhiều lần) → chặn, không quét chậm hay bỏ qua


class ScanBudget:
    """Ngân sách quét MỘT quyết định: số lệnh con, hạn giờ, tập script đã quét (chặn nổ tổ hợp của bản viết lại như
    `a="$a$a"` lặp, `flock l flock l …`). Hết ngân sách → chặn (fail-closed), không để guard chạy quá hạn rồi bị bỏ qua."""

    def __init__(self) -> None:
        self.calls = SCAN_CALLS
        self.deadline = time.monotonic() + SCAN_SECONDS
        self.seen: Set[str] = set()

    def exhausted(self) -> bool:
        self.calls -= 1
        return self.calls < 0 or time.monotonic() > self.deadline


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


def _find_exec_argvs(n: List[str]) -> List[List[str]]:
    """Lệnh con của `find … -exec|-execdir|-ok|-okdir <lệnh> … ;|+` — nó thừa hưởng stdin của find."""
    out: List[List[str]] = []
    for i, a in enumerate(n):
        if a in ("-exec", "-execdir", "-ok", "-okdir"):
            sub = list(itertools.takewhile(lambda x: x not in (";", "\\;", "+"), n[i + 1 :]))
            out.append(sub)
    return out


def _stdin_shell(argv: List[str]) -> bool:
    """Shell đọc script từ stdin: tên shell, không `-c`, không file script (bỏ chuyển hướng `<<E`, `< f` cùng đích);
    cả shell chạy qua `find -exec` (thừa hưởng stdin của find: `find . -exec bash \\; <<E`)."""
    n = normalize(argv)
    if n and n[0] == "find":
        return any(_stdin_shell(sub) for sub in _find_exec_argvs(n))
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
    for opener, m, body in _heredocs(join_continuations(cmd)):
        start, end = _segment_at(opener, m.start(), _unquoted_seps(opener))
        if any(pred(c) for c in split_commands(tokenize(opener[start:end]))):
            out.append("\n".join(body))
    return out


# Ranh giới giữa các pipeline trên một dòng: `;`, `&&`, `||`, `&` đứng riêng (không phải `&>`, `>&`, `|&`).
LIST_SEP_RE = re.compile(r";|&&|\|\||(?<![>|&])&(?![>&])")


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


def _dollar_scripts(cmd: str) -> List[str]:
    """Thân `$(…)` ngoài nháy đơn — kể cả trong nháy kép (`git commit -m "$(rm -rf ~)"`), nơi shlex coi là chữ; bỏ
    `$((…))` (số học)."""
    out: List[str] = []
    quote, i = "", 0
    while i < len(cmd):
        c = cmd[i]
        if c == "\\" and quote != "'":
            i += 2
            continue
        if c in "'\"" and quote in ("", c) and (c == '"' or quote != '"'):
            quote = "" if quote == c else c
        elif quote != "'" and cmd.startswith("$(", i) and not cmd.startswith("$((", i):
            depth, j = 1, i + 2
            while j < len(cmd) and depth:
                depth += {"(": 1, ")": -1}.get(cmd[j], 0)
                j += 1
            out.append(cmd[i + 2 : j - 1])
            i = j
            continue
        i += 1
    return out


def _expanded_heredocs(cmd: str) -> List[str]:
    """Thân heredoc có dấu kết KHÔNG nháy (`<<A`): bash thay `$(…)`/backtick trong thân trước khi đưa vào lệnh."""
    out: List[str] = []
    lines = join_continuations(cmd).split("\n")
    i = 0
    while i < len(lines):
        opener, i = lines[i], i + 1
        for m in HEREDOC_RE.finditer(opener):
            body: List[str] = []
            while i < len(lines) and lines[i].strip() != m.group(2):
                body.append(lines[i])
                i += 1
            i += 1
            if not m.group(1):
                out.append("\n".join(body))
    return out


def _eval_scripts(tokens: List[str]) -> List[str]:
    """`eval '<lệnh>'`: shell ghép các đối số rồi chạy như một dòng lệnh."""
    return [" ".join(n[1:]) for c in split_commands(tokens) for n in [normalize(c)] if n[:1] == ["eval"] and n[1:]]


def _nested_scripts(cmd: str, tokens: List[str]) -> List[str]:
    """Lệnh chạy lồng (AUD-SEC-017): `sh -c '…'`, heredoc/here-string vào shell, `echo/printf '…' | sh`, `eval '…'`,
    backtick."""
    out = [s for c in split_commands(tokens) for s in [_shell_c_script(c)] if s]
    out += _eval_scripts(tokens) + _backtick_scripts(strip_heredocs(cmd)) + _dollar_scripts(strip_heredocs(cmd))
    out += _procsub_scripts(tokens)
    out += [s for body in _expanded_heredocs(cmd) for s in _dollar_scripts(body) + _backtick_scripts(body)]
    for pipe in pipelines(tokens):
        for up, down in zip(pipe, pipe[1:]):
            src = normalize(up)
            if src[:1] in (["echo"], ["printf"]) and _stdin_shell(down):
                out += _echoed_scripts(src)
    return out + _here_strings(tokens) + _heredoc_scripts(cmd)


# Lệnh có thể ghi/xoá file khi đích đến từ stdin qua `xargs` (`find .autopilot -print0 | xargs -0 rm`).
XARGS_WRITERS = {
    *("rm", "mv", "cp", "shred", "truncate", "unlink", "tee", "sed", "install", "ln", "dd", "touch", "perl", "ruby"),
    *("sh", "bash", "zsh", "dash", "ksh", "python", "python3", "node"),
}


def _xargs_evidence(tokens: List[str]) -> List[str]:
    """`<nguồn nhắc .autopilot> | xargs <lệnh ghi/xoá>`: đích đến từ stdin nên guard không thấy file — nguồn đã nói rõ
    là bằng chứng của autopilot thì chặn như ghi tay (ADR-0026)."""
    asks: List[str] = []
    for pipe in pipelines(tokens):
        for up, down in zip(pipe, pipe[1:]):
            inner = normalize(down)
            if (
                posixpath.basename(down[0]) == "xargs"
                and inner[:1]
                and posixpath.basename(inner[0]) in XARGS_WRITERS
                and any(".autopilot" in t.lower() or posixpath.basename(t.lower()) in EVIDENCE_NAMES for t in up)
            ):
                asks.append(EVIDENCE_WHY.format(f"đích từ ống `{' '.join(up)[:60]}` vào xargs {inner[0]}"))
    return asks


def _join_tokens(words: List[str]) -> str:
    """Ghép argv lại thành dòng lệnh: token dấu câu (chuyển hướng `>`, `<`…) để trần, từ khác được trích nháy."""
    return " ".join(t if _is_punct(t) else shlex.quote(t) for t in words)


ASSIGN_ANY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*", re.S)  # giá trị có thể nhiều dòng (`x='bash <<E …'`)
VAR_REF_RE = re.compile(r"\$(\w+)|\$\{(\w+)\}")


def _sub_vars(text: str, env: Dict[str, str]) -> str:
    return VAR_REF_RE.sub(lambda m: env.get(m.group(1) or m.group(2), m.group(0)), text)


VAR_VALUE_MAX = 4096  # giá trị biến dài hơn không được ghi nhận (chặn nhân đôi `a="$a$a"`)
VAR_FOR_PICKS = 64  # số từ tối đa của `for x in …` được thử làm giá trị của x (nhiều hơn → chỉ 64 từ đầu)


def _record_assigns(c: List[str], env: Dict[str, str], pick: int = 0) -> None:
    """`x='…'`, `export x=…`: gán đứng riêng (không kèm lệnh) có hiệu lực cho các lệnh sau; `for x in a b`: x lấy từ thứ
    `pick` của danh sách."""
    c = [t for t in c if t not in SHELL_KEYWORDS] if c[0] in SHELL_KEYWORDS else c  # `then x=…`, `do x=…`, `{ x=…`
    if c[:1] == ["for"] and len(c) > 3 and c[2] == "in":
        env[c[1]] = _sub_vars(c[3:][min(pick, len(c) - 4)], env)[:VAR_VALUE_MAX]
        return
    words = c[1:] if c[:1] and c[0] in DECLARE_CMDS else c
    if words and all(ASSIGN_ANY_RE.fullmatch(t) for t in words):
        for t in words:
            k, _, v = t.partition("=")
            val = _sub_vars(v, env)
            if len(val) <= VAR_VALUE_MAX:
                env[k] = val


def _for_words(c: List[str]) -> int:
    """Số từ trong danh sách của `for x in a b c` (0 nếu không phải vòng for)."""
    c = [t for t in c if t not in SHELL_KEYWORDS] if c[:1] and c[0] in SHELL_KEYWORDS else c
    return len(c) - 3 if c[:1] == ["for"] and len(c) > 3 and c[2] == "in" else 0


def _expand_tokens(tokens: List[str], pick: int, split: bool) -> List[str]:
    """Dòng token với biến đã gán thay bằng giá trị theo thứ tự xuất hiện; dấu `;`/`&&`/`|`/chuyển hướng giữ nguyên nên
    `cd $D`, `echo "$x" | sh` còn đủ ngữ cảnh. `split`: token chỉ là `$x` được tách từ như shell không nháy."""
    env: Dict[str, str] = {}
    out: List[str] = []
    cur: List[str] = []
    for t in tokens:
        if _is_punct(t) and not _is_redirect(t):
            if cur:
                _record_assigns(cur, env, pick)
            cur = []
            out.append(t)
            continue
        cur.append(t)
        sub = _sub_vars(t, env) if env else t
        out += _split_words(sub) if split and VAR_REF_RE.fullmatch(t) and sub != t else [sub]
    return out


def _var_scripts(tokens: List[str]) -> List[str]:
    """Cả dòng lệnh sau khi thay biến đã gán bằng chữ nguyên văn (`x='rm -rf ~'; eval "$x"`, `D=.autopilot; cd $D`,
    `cmd=…; echo "$cmd" | sh`, `for d in a b; do rm $d`): quét lại như một lệnh. Không thấy gán từ `read`/thay lệnh."""
    base = _join_tokens(tokens)
    picks = min(VAR_FOR_PICKS, max([1, *(_for_words(c) for c in split_commands(tokens))]))
    seen = {base}
    out: List[str] = []
    for pick, split in itertools.product(range(picks), (False, True)):
        script = _join_tokens(_expand_tokens(tokens, pick, split))
        if script not in seen:
            seen.add(script)
            out.append(script)
    return out


# Lệnh chạy phần còn lại của dòng lệnh (hoặc một chuỗi lệnh sau cờ `-c`) — tuỳ chọn mỗi lệnh khác nhau nên quét MỌI
# hậu tố của đối số như một lệnh (cả dạng ghép chuỗi: `script -qc 'rm -rf ~' /dev/null`, `watch 'rm -rf ~'`).
RUNNERS = {
    *("flock", "watch", "script", "su", "busybox", "coproc", "ionice", "chrt", "taskset", "fakeroot", "unshare"),
    *("nsenter", "runuser", "systemd-run", "pkexec", "strace", "ltrace", "chroot", "sg", "newgrp", "at", "parallel"),
}
RUNNER_SUFFIXES = 12  # số hậu tố đối số tối đa mỗi lệnh (chặn số lần quét lồng)


RUNNER_CMD_FLAG_RE = re.compile(r"-[A-Za-z]*c|--command|--run")  # `-c`, `-qc`, `-lc`: đối số kế tiếp là chuỗi lệnh


def _runner_scripts(tokens: List[str]) -> List[str]:
    """Phần còn lại của lệnh bọc quét như một lệnh (mọi hậu tố đối số). Một đối số chứa khoảng trắng chỉ coi là CHUỖI LỆNH
    khi nó đứng đầu (sau các cờ/số) hoặc ngay sau cờ `-c`: `watch 'rm -rf ~'`, `script -qc '…'` — còn `-m "rm -rf ~ x"`,
    `-t "…"`, `::: "…"` là dữ liệu (reviewer #134: chặn nhầm `flock l git commit -m "rm -rf ~ is bad"`)."""
    out: List[str] = []
    for c in split_commands(tokens):
        a = _strip_prefixes(c)
        if a and posixpath.basename(a[0]) in RUNNERS:
            rest = a[1:]
            for k in range(min(len(rest), RUNNER_SUFFIXES)):
                out.append(_join_tokens(rest[k:]))
                lead = all(t.startswith("-") or t.isdigit() for t in rest[:k]) or bool(
                    k and RUNNER_CMD_FLAG_RE.fullmatch(rest[k - 1])
                )
                if lead and re.search(r"\s", rest[k]):
                    out += [rest[k], " ".join(rest[k:])]
    return out


def _procsub_scripts(tokens: List[str]) -> List[str]:
    """`sh <(echo '…')`, `source <(printf '…')`, `bash < <(echo '…')`: shell đọc script do lệnh trong `<( )` sinh ra."""
    out: List[str] = []
    for i, t in enumerate(tokens):
        if t != "<(":
            continue
        j = i - 1
        while j >= 0 and (tokens[j].startswith("-") or tokens[j] == "<"):
            j -= 1
        if j < 0 or posixpath.basename(tokens[j]) not in {*SHELLS, "source", "."}:
            continue
        depth, k = 1, i + 1
        while k < len(tokens) and depth:
            depth += tokens[k].count("(") - tokens[k].count(")") if _is_punct(tokens[k]) else 0
            k += 1
        inner = normalize(tokens[i + 1 : k - 1])
        if inner[:1] in (["echo"], ["printf"]):
            out += _echoed_scripts(inner)
    return out


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


KUBECTL_VALUE_FLAGS = ("-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server")


def _container_cli(n: List[str]) -> List[str]:
    """CLI container cùng cú pháp docker: `docker-compose …`/`podman-compose …` → `docker compose …`, `nerdctl` → docker."""
    if n[:1] in (["docker-compose"], ["podman-compose"]):
        return ["docker", "compose", *n[1:]]
    return ["docker", *n[1:]] if n[:1] == ["nerdctl"] else n


def _container_exec(argv: List[str]) -> Tuple[List[str], List[str]]:
    """(cờ, lệnh) chạy trong container: `docker exec ctr sh -c …`, `docker run img bash -c …`, `compose run
    --entrypoint sh dv -c …` (entrypoint shell nhận phần còn lại làm đối số)."""
    n = _container_cli(normalize(argv))
    if n[:1] == ["kubectl"]:  # `kubectl [cờ toàn cục] exec [cờ] pod -- <lệnh>` (AUD-SEC-042)
        k = 1 + _skip_opts(n[1:], KUBECTL_VALUE_FLAGS)
        return [], n[n.index("--") + 1 :] if n[k : k + 1] == ["exec"] and "--" in n else []
    if n[:1] not in (["docker"], ["podman"]):
        return [], []
    args = n[1:][_skip_opts(n[1:], DOCKER_GLOBAL_VALUE_FLAGS) :]
    opts, inner = _exec_split(args[1:] if args[:1] == ["container"] else args)
    entry = [posixpath.basename(e) for e in _flag_values(opts, ("--entrypoint",))]
    return opts, [entry[-1], *inner] if entry and entry[-1] in SHELLS else inner


BIND_SRC_PREFIXES = ("/", ".", "~", "$PWD", "${PWD}", "$(pwd)", "$HOME", "${HOME}")


def _bind_dests(opts: List[str]) -> List[str]:
    """Đích trong container của mount thư mục máy (`-v $PWD:/w`, `-v .:/w`, `--mount type=bind,src=…,dst=…`); named
    volume (`data`, `$VOLNAME`) không tính."""
    out: List[str] = []
    for v in _flag_values(opts, ("-v", "--volume", "--mount")):
        v = v.removeprefix("=")
        if not _mount_source(v).startswith(BIND_SRC_PREFIXES):
            continue
        kv = dict(p.split("=", 1) for p in v.split(",") if "=" in p)
        dst = kv.get("target") or kv.get("dst") or kv.get("destination") or (v.split(":")[1] if v.count(":") else "")
        out += [posixpath.normpath(dst)] if dst.startswith("/") else []
    return out


def _wipes_bind(script: str, dests: List[str]) -> str:
    """`rm -r` đúng thư mục gắn máy (`rm -rf /app` khi `-v $PWD:/app`) — xoá cả dự án trên máy."""
    for c in split_commands(tokenize(script)):
        n = normalize(c)
        recursive = any(a == "--recursive" or (a[:1] == "-" and a[1:2] != "-" and set(a[1:]) & {"r", "R"}) for a in n)
        hit = (
            [t for t in _positionals(n[1:]) if posixpath.normpath(t) in dests] if n[:1] == ["rm"] and recursive else []
        )
        if hit:
            return f"xoá thư mục gắn từ máy ({hit[0]}) trong container"
    return ""


# Gốc giả cho lệnh trong container: đường dẫn là của container (luật xoá/ghi "ngoài dự án" không áp), luật đối ngoại,
# merge, tải-rồi-chạy, `rm -rf /`/`.git` vẫn áp; xoá đúng thư mục gắn từ máy thì hỏi riêng (`_wipes_bind`).
# Giới hạn: mount khai trong compose yaml, `docker exec` vào container đang chạy, `--volumes-from` — guard không thấy.
CONTAINER_ROOT = "/"


def _wrapped_scripts(tokens: List[str]) -> Tuple[List[str], List[Tuple[str, List[str]]]]:
    """Lệnh lồng sau lệnh bọc chạy trên máy (`uv run bash -c …`, `npm exec -c …`, `nix-shell --run …`) và trong container
    (AUD-SEC-041; review #83: cả lệnh gọi thẳng, kèm đích mount thư mục máy): (máy, [(container, đích gắn máy)])."""
    host: List[str] = []
    ctr: List[Tuple[str, List[str]]] = []
    for c in split_commands(tokens):
        n = normalize(c)
        if not n:
            continue
        opts, inner = _container_exec(c)
        if inner:
            ctr.append((_shell_c_script(inner) or shlex.join(inner), _bind_dests(opts)))
            continue
        name, args = _unwrap(n[0], n[1:])
        script = _shell_c_script([name, *args]) if name != n[0] else None
        host += [script] if script else []
        if n[0] == "nix-shell":
            host += _flag_values(n[1:], ("--run", "--command"))
        if n[0] in ("npm", "pnpm") and n[1:2] == ["exec"]:
            host += _flag_values(n[2:], ("-c", "--call"))
    return host, ctr


def _container_asks(ctr: List[Tuple[str, List[str]]], depth: int, budget: Optional[ScanBudget] = None) -> List[str]:
    """Lệnh trong container quét bằng đủ luật với gốc giả `/`; chặn/hỏi của nó thành hỏi."""
    if ctr and depth >= MAX_NEST:
        return ["shell lồng quá sâu — guard không quét hết lệnh trong container"]
    out: List[str] = []
    for script, dests in ctr:
        sub = bash_decision(script, CONTAINER_ROOT, CONTAINER_ROOT, depth + 1, budget)
        why = str(sub["reason"]).removeprefix(ASK_PREFIX) if sub["decision"] in ("deny", "ask") else ""
        why = why or _wipes_bind(script, dests)
        out += [f"lệnh trong container: {why}"] if why else []
    return out


def _scan_scripts(
    scripts: List[str],
    root: str,
    cwd: Optional[str],
    depth: int,
    asks: List[str],
    deeper: int,
    budget: ScanBudget,
    rewrites: int = 0,
) -> str:
    """Quét từng script con ở độ sâu `depth + deeper`; trả lý do deny (rỗng nếu không). `deeper=0` cho bản viết lại CÙNG
    lệnh (thay biến, hậu tố của lệnh bọc) — không phải shell lồng, không tốn độ sâu nhưng tốn `rewrites`. Script đã quét
    trong quyết định này bị bỏ qua (cùng chuỗi → cùng kết quả)."""
    for script in scripts:
        if deeper and depth >= MAX_NEST:
            asks.append("shell lồng quá sâu — guard không quét hết")
            break
        if not deeper and rewrites >= MAX_REWRITE:  # chỉ HỎI thì chính sách mặc định cho qua (reviewer #136)
            return "Lệnh quá phức tạp để guard quét hết (lệnh bọc/thay biến lồng quá sâu): chia nhỏ lệnh."
        if script in budget.seen:
            continue
        if not deeper and len(script) > REWRITE_MAX_CHARS:
            return f"Lệnh quá phức tạp để guard quét hết (bản thay biến dài {len(script)} ký tự): chia nhỏ lệnh."
        budget.seen.add(script)
        sub = bash_decision(script, root, cwd, depth + deeper, budget, 0 if deeper else rewrites + 1)
        if sub["decision"] == "deny":
            return str(sub["reason"])
        if sub["decision"] in ("ask", "allow") or sub["commit"]:
            asks.append(f"lệnh lồng trong shell: {str(sub['reason']) or 'git commit (cổng commit không chạy được)'}")
    return ""


def _scan_nested(
    cmd: str,
    tokens: List[str],
    root: str,
    cwd: Optional[str],
    depth: int,
    asks: List[str],
    budget: ScanBudget,
    rewrites: int,
) -> str:
    """Quét đệ quy lệnh lồng; trả lý do deny (rỗng nếu không), thêm câu hỏi vào `asks`. Lệnh trong container không
    đụng file máy → chặn/hỏi của nó thành hỏi (ra mạng, thêm gói vẫn là việc thật)."""
    asks += _opaque_shells(tokens) + _xargs_evidence(tokens)
    host, ctr = _wrapped_scripts(tokens)
    asks += _container_asks(ctr, depth, budget)  # mọi lệnh, không cắt theo số lượng (review #82)
    rewritten = _var_scripts(tokens) + _runner_scripts(tokens)
    nested = _nested_scripts(cmd, tokens) + host + _exec_api_scripts(_interp_scripts(cmd, tokens))
    return _scan_scripts(rewritten, root, cwd, depth, asks, 0, budget, rewrites) or _scan_scripts(
        nested, root, cwd, depth, asks, 1, budget
    )


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


# Lời gọi chạy lệnh shell từ trình thông dịch (`os.system('…')`, `subprocess.run(['rm','-rf','~'])`, `execSync('…')`):
# chuỗi nguyên văn trong đối số là lệnh thật. Chỉ xét chuỗi nằm trong lời gọi này (không phải mọi chuỗi trong script).
EXEC_CALL_RE = re.compile(
    r"\b(?:os\.(?:system|popen|exec\w*|spawn\w*)|subprocess\.\w+|Popen|check_output|check_call|getoutput"
    r"|execSync|execFileSync|spawnSync|execFile|spawn|exec|system|popen)\s*\("
)
# Chuỗi nguồn của Python/JS/Ruby: tiền tố r/b/f/u, nháy ba trước nháy đơn; mỗi nhánh khớp tuyến tính.
LITERAL_RE = re.compile(
    r"""[rRbBfFuU]{0,2}(?:'\'\'(.*?)'\'\'|\"\"\"(.*?)\"\"\"|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")""", re.S
)
STR_ANY_RE = re.compile(
    r"""'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)\"""", re.S
)  # mỗi ký tự khớp đúng một nhánh: không backtracking lũy thừa
EXEC_ARG_WINDOW = 400


def _balanced(text: str, start: int, opener: str, closer: str) -> str:
    """Phần `text[start:]` tới `closer` khớp với `opener` đã mở trước `start` (bỏ qua ngoặc nằm trong chuỗi), tối đa
    EXEC_ARG_WINDOW ký tự; không khớp → phần còn lại trong cửa sổ."""
    depth, i, end = 1, start, min(len(text), start + EXEC_ARG_WINDOW)
    while i < end:
        m = STR_ANY_RE.match(text, i)
        if m:
            i = m.end()
            continue
        depth += (text[i] == opener) - (text[i] == closer)
        if not depth:
            return text[start:i]
        i += 1
    return text[start:end]


def _literal(m: "re.Match[str]") -> str:
    return ANSI_ESCAPE_RE.sub(_ansi_c_char, m.group(m.lastindex or 0))  # `\"`, `\\n` trong chuỗi nguồn → ký tự thật


def _first_arg(args: str) -> str:
    """Đối số đầu của lời gọi (tới dấu phẩy ngoài ngoặc/chuỗi): `'rm' + ' -rf ~', shell=True` → `'rm' + ' -rf ~'`."""
    depth, i = 0, 0
    while i < len(args):
        m = LITERAL_RE.match(args, i) if args[i] in "'\"rRbBfFuU" else None
        if m and m.end() > i + 1:
            i = m.end()
            continue
        depth += (args[i] in "([{") - (args[i] in ")]}")
        if depth < 0 or (args[i] == "," and not depth):
            return args[:i]
        i += 1
    return args


def _exec_api_scripts(scripts: List[str]) -> List[str]:
    """Chuỗi lệnh trong đối số ĐẦU của lời gọi thực thi: `os.system('…')` (kể cả `f'…'`, `r'…'`, nháy ba, ghép
    `'rm' + ' -rf ~'`) → lệnh shell; `subprocess.run([…])` → các phần tử ghép thành một lệnh. Chuỗi khác trong script
    (`print('…')`, đối số sau) là dữ liệu, không quét."""
    out: List[str] = []
    for script in scripts:
        spans = [x.span() for x in STR_ANY_RE.finditer(script)]
        for m in EXEC_CALL_RE.finditer(script):
            if any(
                a <= m.start() < b for a, b in spans
            ):  # `.write("os.system('…')")`: chữ trong chuỗi, không phải lời gọi
                continue
            first = _first_arg(_balanced(script, m.end(), "(", ")").lstrip())
            if first[:1] == "[":
                out.append(shlex.join(_literal(x) for x in LITERAL_RE.finditer(_balanced(first, 1, "[", "]"))))
            elif LITERAL_RE.search(first):
                out.append("".join(_literal(x) for x in LITERAL_RE.finditer(first)))
    return out


def interp_write_asks(cmd: str, tokens: List[str], root: str) -> List[str]:
    """Script trình thông dịch ghi/xoá file bí mật/cổng/bằng chứng/năng lực agent → hỏi, như Edit/chuyển hướng
    (LOOP-STOP-025: bị chặn ở Edit thì không đổi sang `python -c` để lách). Phân tích tĩnh, chỉ chữ nguyên văn."""
    asks: List[str] = []
    for script in _interp_scripts(cmd, tokens):
        if not WRITE_HINT_RE.search(script):
            continue
        for lit in STR_LITERAL_RE.findall(script):
            kind = path_kind(rel_path(lit, root), root) if ("/" in lit or "." in lit) and lit not in ("..",) else ""
            direct = _direct_write(script, lit)
            if direct and _is_fence(lit, root):
                asks.append(FENCE_WHY.format(f"{lit} — script trình thông dịch"))
            elif direct and kind == "secret":  # AUD-SEC-049: dấu chặn như chuyển hướng, không chỉ hỏi
                asks.append(f"ghi file bí mật qua Bash (script trình thông dịch): {lit}")
            elif direct and kind == "evidence":  # ADR-0026: như ghi tay qua chuyển hướng
                asks.append(f"ghi/xoá tay bằng chứng autopilot qua script trình thông dịch: {lit}")
            elif kind in GUARDED_KINDS:
                asks.append(f"script trình thông dịch ghi/xoá {lit} ({kind}) — dùng đúng công cụ hoặc người duyệt")
    return asks


# Đường dẫn là đối số của chính lời gọi ghi/xoá (`open('.env','w')`, `os.remove('…')`, `Path('…').write_text(`,
# `shutil.copy(a, '…')`, `fs.writeFileSync('…'`): chỉ khi đó mới CHẶN — script chỉ nhắc tên file (ghi file khác) vẫn
# theo hỏi/cho qua, tránh chặn oan script sửa tài liệu/test có nhắc `.env` hay `.claude/hooks/…`.
DIRECT_WRITE_FMT = (
    r"open\(\s*{q}\s*,\s*(?:mode\s*=\s*)?['\"][rbt]?[wax+]"
    r"|(?:\bos\.(?:remove|unlink|rename|replace|truncate)|\bshutil\.\w+|writeFile\w*|appendFile\w*|unlinkSync|rmSync"
    r"|renameSync|copyFile\w*|File\.write|IO\.write|file_put_contents|\bunlink)\(\s*(?:[^)]*,\s*)?{q}"
    r"|Path\(\s*{q}\s*\)\s*\.(?:write_text|write_bytes|unlink|rename|replace|touch|open)\("
)


def _direct_write(script: str, lit: str) -> bool:
    q = "['\"]" + re.escape(lit) + "['\"]"
    return bool(re.search(DIRECT_WRITE_FMT.format(q=q), script))


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


ASK_PREFIX = "Khung cần xác nhận: "


def bash_decision(
    cmd: str,
    root: str,
    cwd: Optional[str] = None,
    depth: int = 0,
    budget: Optional[ScanBudget] = None,
    rewrites: int = 0,
) -> Dict[str, object]:
    """Quyết định cho một lệnh Bash: deny/ask/"" kèm cờ `commit`, `no_verify`, `commit_dir` cho hook cổng commit.
    `cwd` = thư mục lệnh bắt đầu chạy (payload hook); `cd <dir>` trong lệnh dời nó để biết commit rơi vào repo nào.
    `depth` = độ sâu shell lồng (`sh -c`, heredoc/pipe vào shell) đang quét."""
    budget = budget or ScanBudget()
    res: Dict[str, object] = {"decision": "", "reason": "", "commit": False, "no_verify": False, "commit_dir": ""}
    if budget.exhausted() or len(cmd) > CMD_MAX_CHARS:
        res.update(decision="deny", reason=f"Lệnh quá phức tạp để guard quét hết (vượt ngân sách quét): {cmd[:200]}")
        return res
    tokens = tokenize(cmd)
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
    nested_deny = _scan_nested(cmd, tokens, root, cwd, depth, asks, budget, rewrites)
    if nested_deny:
        res.update(decision="deny", reason=nested_deny)
        return res
    commands = _commands_with_cwd(tokens, cwd or root)
    deny_reason = next((r for argv, here in commands if (r := _scan_command(argv, root, res, asks, here))), "")
    deny_reason = deny_reason or (ai_attribution(cmd, commands, root) if res["commit"] else "")
    if deny_reason:
        res.update(decision="deny", reason=deny_reason)
        return res
    res.pop("exported", None)
    allow = res.pop("allow", "")
    # `allow` bỏ hỏi cho CẢ lệnh Bash → chỉ khi merge đứng một mình và trơn (không gì shell còn mở rộng/chạy thêm).
    if allow and (len(commands) > 1 or not PLAIN_MERGE_RE.fullmatch(cmd.strip())):
        asks.append(f"{EXTERNAL_ASK} — tự merge chỉ khi lệnh đứng một mình")
    if asks:
        res.update(decision="ask", reason=ASK_PREFIX + "; ".join(dict.fromkeys(asks)))
    elif allow:
        res.update(decision="allow", reason=f"Khung cho tự merge (ADR-0013) — {allow}")
    return res


# Chính sách đầu ra (ADR-0018, chủ repo 2026-10-17): chỉ CẤM lệnh nguy hiểm/không đảo ngược, còn lại cho chạy. Bộ luật
# ở trên vẫn tính `ask` đầy đủ; `XT_GUARD_POLICY=strict` giữ hành vi cũ (hỏi). Ask mang dấu dưới đây → deny, khác → cho qua.
DANGER_MARKERS = (
    "push thẳng nhánh chính",
    "push --all/--tags",
    "xoá đệ quy ngoài thư mục dự án",
    "rm -rf không có đích",
    "find xoá file ngoài thư mục dự án",
    "xoá thay đổi đã cất",
    DESTROY_ASK,
    HARD_ASK,
    UNVERIFIED_ASK,
    "container có quyền máy chủ",
    "xoá thư mục gắn từ máy",
    "tắt hook của khung",
    "bỏ qua hook của dự án",
    "ghi file bí mật qua Bash",
    "tay bằng chứng",  # ghi/xoá tay `.autopilot/` = bằng chứng giả (ADR-0026)
)


def apply_policy(out: Dict[str, object]) -> Dict[str, object]:
    """ask nguy hiểm (DANGER_MARKERS) → deny; ask khác → cho qua (quyết định rỗng); deny/allow/rỗng giữ nguyên."""
    if out.get("decision") != "ask":
        return out
    reason = str(out.get("reason", "")).removeprefix(ASK_PREFIX)
    hit = next((m for m in DANGER_MARKERS if m in reason), "")
    if hit:
        return {**out, "decision": "deny", "reason": f"Lệnh bị khung chặn (nguy hiểm — {hit}): {reason[:400]}"}
    return {**out, "decision": "", "reason": ""}


# Lệnh merge/ghi GitHub: guard lỗi giữa chừng với lệnh này thì hỏi thay vì cho qua (fail-closed cho merge).
MERGE_CMD_RE = re.compile(r"\bgh\s+(pr\b.*\bmerge|api)\b", re.S)


def _failure_decision(mode: str, payload: object, cmd: object) -> Dict[str, object]:
    """Quyết định khi guard ném lỗi: fail-open về luồng (ADR-0002), trừ merge/`gh api` và tool MCP merge (payload đọc
    được — stdin rác không phải lời gọi tool, LOOP-HARNESS-018) → hỏi."""
    if (mode == "mcp" and isinstance(payload, dict)) or (
        mode == "bash" and isinstance(cmd, str) and MERGE_CMD_RE.search(cmd)
    ):
        return {"decision": "ask", "reason": f"guard lỗi khi kiểm merge/ghi GitHub — {UNVERIFIED_ASK}"}
    return {"decision": ""}


NUL_FIELDS = ("decision", "reason", "commit", "no_verify", "commit_dir")


def _sh_field(v: object) -> str:
    """Giá trị cho hook bash: bool → `true`/`false` (như `json_field` cũ), thiếu → rỗng; NUL trong chuỗi bị bỏ."""
    if isinstance(v, bool):
        return "true" if v else "false"
    return "" if v is None else str(v).replace("\0", "")


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
    # strict = hành vi cũ (hỏi): chỉ chặt hơn, không phải công tắc tắt hook.
    if os.environ.get("XT_GUARD_POLICY") != "strict":
        out = apply_policy(out)
    if sys.argv[2:3] == ["nul"]:
        sys.stdout.write("".join(f"{v}\0" for v in ["ok", *(_sh_field(out.get(k)) for k in NUL_FIELDS)]))
    else:
        sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
