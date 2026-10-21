#!/usr/bin/env python3
"""guard.py — phân tích lệnh/đường dẫn cho hook PreToolUse của khung X-Templates (chỉ thư viện chuẩn).

Dùng (payload JSON của Claude Code trên stdin, kết quả JSON trên stdout):
  guard.py bash   → {"decision": "deny"|"ask"|"", "reason": "...", "commit": true|false, "no_verify": true|false,
                     "commit_dir": "<thư mục git commit chạy, rỗng nếu không biết>"}
  guard.py edit   → {"decision": "deny"|"ask"|"", "reason": "..."}  (file bí mật/cổng/migration; test ĐÃ CÓ bị làm yếu)
  guard.py mcp    → {"decision": "deny"|"allow"|"ask"|"", "reason": "..."}  (tool MCP merge PR: allow chỉ khi
                     merge-check cho phép; tool bật auto-merge → deny ở mọi mức tự chủ và mọi chính sách — ADR-0036)
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

import base64
import binascii
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
import unicodedata
from typing import Any, Callable, Dict, FrozenSet, Iterator, List, Optional, Set, Tuple

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
    try:
        rp, rr = os.path.realpath(p), os.path.realpath(root)
    except ValueError:  # NUL, surrogate lẻ (UnicodeEncodeError): chuẩn hoá theo chữ — không làm guard sập (AUD-SEC-077)
        rp, rr = os.path.normpath(p), os.path.normpath(root)
    try:
        rel = os.path.relpath(rp, rr)
    except ValueError:
        return rp
    return rp if rel.startswith("..") else rel.replace(os.sep, "/")


# Surrogate lẻ (`\ud800` từ JSON `"\ud800"`) không mã hoá được ra hệ điều hành/stdout: từng làm guard sập giữa chừng →
# fail-open, cả danh sách "máy chặn" lọt (AUD-SEC-077). Thay bằng U+FFFD; NUL (C cắt chuỗi ở đó) thay bằng khoảng trắng —
# phần sau NUL vẫn được quét (chiều chặt).
SURROGATE_RE = re.compile("[\ud800-\udfff]")


def clean_text(s: str) -> str:
    return SURROGATE_RE.sub("\ufffd", s).replace("\0", " ")  # escape: không ghi U+FFFD thật


def clean_payload(v: Any) -> Any:
    """`clean_text` cho mọi chuỗi (cả khoá) trong payload JSON."""
    if isinstance(v, str):
        return clean_text(v)
    if isinstance(v, dict):
        return {clean_payload(k): clean_payload(x) for k, x in v.items()}
    if isinstance(v, list):
        return [clean_payload(x) for x in v]
    return v


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
    lines = cmd.split("\n")
    return [(lines[o], m, lines[a:b]) for o, m, a, b in _heredoc_spans(lines)]


def literal_bodies_masked(cmd: str) -> str:
    """Dòng lệnh bỏ thân heredoc có dấu kết trong nháy (`<<'EOF'`): bash không thay `` `…` ``/`$(…)` trong thân đó —
    code span trong message commit (`-m "$(cat <<'EOF'` ↵ ``chặn `rm -rf ~` `` ↵ `EOF`) là chữ, không phải lệnh."""
    lines = cmd.split("\n")
    drop = {j for _, m, a, b in _heredoc_spans(lines) if m.group(1) for j in range(a, b)}  # giữ dòng dấu kết
    return "\n".join(line for j, line in enumerate(lines) if j not in drop)


def _heredoc_spans(lines: List[str]) -> List[Tuple[int, "re.Match[str]", int, int]]:
    """(chỉ số dòng mở, match, đầu thân, cuối thân) — xem `_heredocs`."""
    out: List[Tuple[int, "re.Match[str]", int, int]] = []
    q, i, carried = "", 0, 0
    while i < len(lines):
        line, opener, i = lines[i], i, i + 1
        states, q = _quote_states(line, q)
        for m in HEREDOC_RE.finditer(line):
            if states[m.start()] in ("#", "'") or (
                states[m.start()] in ('"', "`") and not _opens_body(line, states, m, carried)
            ):
                continue
            # không thấy dấu kết: như bash, thân là phần còn lại (`bash <<E` ↵ `rm -rf ~` vẫn chạy)
            end = next((j for j in range(i, len(lines)) if lines[j].strip() == m.group(2)), len(lines))
            out.append((opener, m, i, end))
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


BRACE_MAX_OPEN = 512  # `{` ngoài nháy tối đa được dò; hơn → không quét hết → chặn (review #159: chống bậc hai)
BRACE_SCAN_MAX = 4096  # độ dài tối đa một từ có `{` được dò; dài hơn mà chưa đóng/hết từ → không quét hết → chặn


class BraceTooComplex(Exception):
    """Nhóm brace dài quá trần dò: guard không biết bash bung ra gì → chặn (không phải "không phải brace")."""


BRACE_SEQ_RE = re.compile(r"(-?\w+)\.\.(-?\w+)(?:\.\.([-+]?\d+))?")
BRACE_NUM_RE = re.compile(r"[-+]?\d+")
BRACE_SEQ_MAX = 4096  # phần tử tối đa một dãy `{x..y}` được bung; hơn → không quét hết → chặn (AUD-SEC-073)


def _brace_sequence(lo: str, hi: str, step: Optional[str]) -> List[str]:
    """Dãy `{x..y[..s]}` bung ĐỦ như bash (AUD-SEC-073: `mai{m..o}` → `maim main maio`, không chỉ hai đầu mút): số
    nguyên (đệm 0 khi một đầu mút có số 0 đứng đầu) hoặc một chữ cái mỗi đầu (ký tự không phải chữ/số trong khoảng
    `Z..a` được thoát để guard đọc lại như chữ); bước lấy trị tuyệt đối, 0 = 1. Dạng bash để nguyên chữ (`{ab..cd}`) →
    giữ hai đầu mút như trước (bảo thủ). Quá `BRACE_SEQ_MAX` phần tử → `BraceTooComplex`."""
    inc = abs(int(step)) if step else 1
    inc = inc or 1
    if BRACE_NUM_RE.fullmatch(lo) and BRACE_NUM_RE.fullmatch(hi):
        a, b = int(lo), int(hi)
        if abs(b - a) // inc >= BRACE_SEQ_MAX:
            raise BraceTooComplex(f"{{{lo}..{hi}}}")
        pad = max(len(lo), len(hi)) if any(re.match(r"[-+]?0\d", x) for x in (lo, hi)) else 0
        return [f"{n:0{pad}d}" for n in range(a, b + (1 if b >= a else -1), inc if b >= a else -inc)]
    if len(lo) == len(hi) == 1 and lo.isascii() and hi.isascii() and lo.isalpha() and hi.isalpha():
        a, b = ord(lo), ord(hi)
        chars = [chr(n) for n in range(a, b + (1 if b >= a else -1), inc if b >= a else -inc)]
        return [ch if ch.isalnum() or ch == "_" else "\\" + ch for ch in chars]
    return [lo, hi]


WORD_END = set(" \t\n;&|()<>")


def _skip_single(s: str, j: int) -> int:
    """Vị trí sau chuỗi nháy đơn `'…'` hoặc ANSI-C `$'…'` (`\\'` trong `$'…'` là ký tự, không đóng nháy) mở ở `s[j]`."""
    ansi = s.startswith("$'", j)
    k = j + (2 if ansi else 1)
    while k < len(s) and s[k] != "'":
        k += 2 if ansi and s[k] == "\\" else 1
    return k + 1


def _in_double(s: str, j: int, stack: List[str]) -> int:
    """Một bước trong nháy kép: `$(` mở thay lệnh — bên trong là ngữ cảnh mới, nháy tính lại từ đầu (bash) —, `"` đóng."""
    if s.startswith("$(", j):
        stack.append("(")
        return j + 2
    if s[j] == '"':
        stack.pop()
    return j + 1


def _unquoted(s: str, i: int = 0) -> Iterator[Tuple[int, str]]:
    """(vị trí, ký tự) ngoài nháy từ `s[i]`; ký tự thoát `\\x`, nội dung nháy (cả `$'…'`) bị bỏ qua; thân `$(…)` trong
    nháy kép là ngoài nháy (AUD-SEC-072: `$'\\''`, `"$(echo "'")"` từng làm lệch trạng thái nháy tới cuối lệnh)."""
    stack: List[str] = []  # '"' = trong nháy kép; "(" = trong ngoặc/thay lệnh (ngữ cảnh ngoài nháy)
    j = i
    while j < len(s):
        c = s[j]
        if c == "\\":
            j += 2
        elif stack[-1:] == ['"']:
            j = _in_double(s, j, stack)
        elif c == "'" or s.startswith("$'", j):
            j = _skip_single(s, j)
        elif c == '"':
            stack.append(c)
            j += 1
        else:
            if c == "(":
                stack.append(c)
            elif c == ")" and stack:
                stack.pop()
            yield j, c
            j += 1


def _brace_group(s: str, i: int) -> Optional[Tuple[int, List[str]]]:
    """Nhóm `{a,b}`/`{x..y}` bắt đầu ở `s[i]`: (vị trí `}`, các phương án) — dãy `x..y` bung đủ. Khoảng trắng
    ngoài nháy, không dấu phẩy cấp đầu, không đóng trong `BRACE_SCAN_MAX` ký tự → không phải brace expansion (`{ cmd; }`,
    `{}` của `find`)."""
    depth, start, parts = 0, i + 1, []
    for j, c in _unquoted(s, i):
        if c.isspace():
            return None
        if j - i > BRACE_SCAN_MAX:  # bash vẫn bung nhóm dài — không bỏ qua (re-review #159: đệm 1100 ký tự từng lọt)
            raise BraceTooComplex(s[i : i + 80])
        depth += {"{": 1, "}": -1}.get(c, 0)
        if depth == 0:
            parts.append(s[start:j])
            break
        if c == "," and depth == 1:
            parts.append(s[start:j])
            start = j + 1
    else:
        return None
    if len(parts) > 1:
        return j, parts
    m = BRACE_SEQ_RE.fullmatch(parts[0])
    return (j, _brace_sequence(*m.groups())) if m else None


def _first_brace(s: str, start: int = 0) -> Optional[Tuple[int, int, List[str]]]:
    """Nhóm brace expansion đầu tiên ngoài nháy từ `start` (bỏ `${…}` và `\\{`)."""
    for i, c in _unquoted(s, start):
        if c == "{" and s[i - 1 : i] != "$" and (g := _brace_group(s, i)):
            return i, g[0], g[1]
    return None


def _brace_word(t: str, i: int, end: int, alts: List[str]) -> Tuple[str, int]:
    """(lệnh sau khi bung từ chứa nhóm, vị trí đầu từ): `p{a,b}s` → `pas pbs` (từ rỗng bị bỏ như bash)."""
    lo = i
    while lo > 0 and t[lo - 1] not in WORD_END:
        lo -= 1
    hi = end + 1
    while hi < len(t) and t[hi] not in WORD_END:
        hi += 1
    if len(alts) * (i - lo + hi - end) + sum(map(len, alts)) > REWRITE_MAX_CHARS:  # ước trước khi dựng (AUD-SEC-073)
        raise BraceTooComplex(t[lo : lo + 80])
    words = [w for a in alts if (w := t[lo:i] + a + t[end + 1 : hi])]
    return t[:lo] + " ".join(words) + t[hi:], lo


def brace_variants(cmd: str) -> Optional[List[str]]:
    """Lệnh bash thật sự chạy sau brace expansion (`git push origin {feat/x,main}` → `git push origin feat/x main`):
    `[bản bung]`; không có nhóm → []; quá nhiều `{` hoặc bản bung dài quá `REWRITE_MAX_CHARS` → None (không quét hết
    → chặn). Dò một lượt từ trái sang (nhóm lồng lộ ra sau khi bung nhóm ngoài). Heredoc/comment là dữ liệu."""
    s = strip_comments(strip_heredocs(join_continuations(cmd)))
    if "{" not in s:
        return []
    # Chỉ `{` có thể mở nhóm: không phải `${`, không `{}`/`{ ` (xargs -I{}, find {}, `{ …; }`) — re-review #159.
    opens = sum(
        c == "{" and s[i - 1 : i] != "$" and s[i + 1 : i + 2] not in ("", "}", " ", "\t", "\n") for i, c in _unquoted(s)
    )
    if opens > BRACE_MAX_OPEN:
        return None
    t, pos = s, 0
    try:
        while f := _first_brace(t, pos):
            t, pos = _brace_word(t, *f)
            if len(t) > REWRITE_MAX_CHARS:
                return None
    except BraceTooComplex:
        return None
    return [t] if t != s else []


PWD_SUBST_RE = re.compile(
    r"\$\(\s*pwd\s*\)|`\s*pwd\s*`"
)  # `$(pwd)`/`` `pwd` `` = `$PWD` (review #187: không nháy bị tách token)


def tokenize(cmd: str) -> List[str]:
    cmd = IFS_RE.sub(" ", expand_ansi_c(strip_heredocs(join_continuations(cmd))))
    cmd = PWD_SUBST_RE.sub("$PWD", cmd)
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


def _skip_env_args(a: List[str], dirs: Optional[List[str]] = None) -> None:
    """Sau `env`: bỏ tuỳ chọn và gán biến tại chỗ (`-u`/`-C`/`--unset`/`--chdir` kèm một giá trị); `-S '<lệnh>'` tách
    chuỗi thành lệnh thật (`env -S "git push --force"`, AUD-SEC-024). Thư mục của `-C DIR`/`-CDIR`/`--chdir[=]DIR` ghi
    vào `dirs` (lệnh sau `env` chạy ở đó — review #186 lần 2)."""
    while a and (a[0].startswith("-") or "=" in a[0]):
        opt = a.pop(0)
        key, val = _env_opt(opt)
        if key and val is None:
            val = a.pop(0) if a else ""
        if key == "S" and val:
            a[:0] = _split_words(val)
        if key == "C" and val and dirs is not None:
            dirs.append(val)


ENV_LONG_OPTS = {"--split-string": "S", "--chdir": "C", "--unset": "u", "--argv0": "a"}
# Mọi tuỳ chọn dài của GNU env (coreutils 9.x) — để nhận viết tắt duy nhất như getopt_long (`--ch=` → `--chdir`)
ENV_LONG_ALL = (
    *ENV_LONG_OPTS,
    "--ignore-environment",
    "--null",
    "--block-signal",
    "--default-signal",
    "--ignore-signal",
    "--list-signal-handling",
    "--debug",
    "--help",
    "--version",
)


def _env_long_name(name: str) -> str:
    """Tên đầy đủ của tuỳ chọn dài `name` (viết đủ, hoặc viết tắt khớp đúng một tuỳ chọn — review #186 lần 3);
    mơ hồ/lạ → giữ nguyên."""
    if not name.startswith("--") or len(name) < 3 or name in ENV_LONG_ALL:
        return name
    hits = [o for o in ENV_LONG_ALL if o.startswith(name)]
    return hits[0] if len(hits) == 1 else name


def _env_opt(opt: str) -> Tuple[str, Optional[str]]:
    """Tuỳ chọn có giá trị của `env`: (khoá S/C/u/a, giá trị dính liền hoặc None = ở token kế). Cờ ngắn ghép
    (`-iC dir`, `-iCdir`, `-iS'…'`) tách như getopt; tuỳ chọn dài nhận viết tắt duy nhất (`--ch=`, `--spl`); tuỳ
    chọn khác/gán biến → ('', None)."""
    name, eq, rest = opt.partition("=")
    name = _env_long_name(name)
    if name in ENV_LONG_OPTS:
        return ENV_LONG_OPTS[name], (rest if eq else None)
    m = re.fullmatch(r"-[^-CSua]*([CSua])(.*)", opt, re.S)
    return (m[1], m[2] or None) if m else ("", None)


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


def _strip_prefixes(argv: List[str], dirs: Optional[List[str]] = None) -> List[str]:
    """Bỏ từ khoá shell, gán biến đầu lệnh, chuyển hướng đặt đầu lệnh (`2>/dev/null cd x`, `>/dev/null rm …` — review
    #186) và wrapper (`command`, `env -i`, `nohup`…) cho tới khi gặp lệnh thật. Đích của chuyển hướng vẫn được
    `write_targets` đọc từ argv gốc. `dirs`: nhận thư mục của `env -C` (theo thứ tự)."""
    a = list(argv)
    while a:
        head = a[0]
        if _is_redirect(head):
            del a[:2]  # toán tử + đích
        elif head.isdigit() and len(a) > 1 and _is_redirect(a[1]):
            a.pop(0)  # số fd (`2>`)
        elif head in SHELL_KEYWORDS:
            a.pop(0)
        elif ENV_ASSIGN_RE.fullmatch(head):
            a.pop(0)
        elif posixpath.basename(head) == "env":
            a.pop(0)
            _skip_env_args(a, dirs)
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


# Cờ của `cd`/`pushd` không đổi đích (AUD-SEC-088), cả dạng ghép `-LP`, `-Pe@` (review #186, D-106)
CD_FLAG_RE = re.compile(r"-[LPe@]+")
# `~+`/`~-` đứng đầu: bash mở thành `$PWD`/`$OLDPWD` (biến gán lại được) — `cd` tới đó như `cd $PWD`: không biết
TILDE_DIR_RE = re.compile(r"~[+-](?=/|$)")


def _cd_operands(args: List[str]) -> Tuple[List[str], bool]:
    """(đối số, có `--`) của `cd`/`pushd` sau khi bỏ chuyển hướng (`2>/dev/null` tách thành `2`, `>`, `/dev/null`;
    `>&1`) và cờ `-P`/`-L`/`-e`/`-@` (cả ghép `-LP`) đứng trước `--` (AUD-SEC-088). Cờ lạ giữ lại để bên gọi coi là
    không biết."""
    plain: List[str] = []
    i = 0
    while i < len(args):
        if _is_redirect(args[i]):
            i += 2  # toán tử + đích
        elif args[i].isdigit() and i + 1 < len(args) and _is_redirect(args[i + 1]):
            i += 1  # số fd đứng trước toán tử (`2>`)
        else:
            plain.append(args[i])
            i += 1
    j = 0
    while j < len(plain) and CD_FLAG_RE.fullmatch(plain[j]):
        j += 1
    if plain[j : j + 1] == ["--"]:
        return plain[j + 1 :], True
    return plain[j:], False


def _cd_target(n: List[str], cwd: Optional[str], cdpath: bool = False) -> Optional[str]:
    """Thư mục sau `cd <dir>`; `cd`, `cd -`, `pushd +N`, `cd` kèm cờ lạ hay biến → None (không biết — D-106: đích ghi
    tương đối sau đó thử ở mọi thư mục canh). Chuyển hướng và cờ `-P`/`-L`/`-e`/`--` không đổi đích (AUD-SEC-088).
    Có `CDPATH` (`cdpath`) hay thư mục trước đó không biết: chỉ đích tuyệt đối/`~` giải được."""
    args, dashdash = _cd_operands(n[1:])
    if len(args) != 1 or "$" in args[0] or re.search(r"[*?\[]", args[0]) or TILDE_DIR_RE.match(args[0]):
        return None  # biến, glob (`cd .cl*`), `~+`/`~-` (= `$PWD`/`$OLDPWD` — AUD-SEC-097): không biết (D-106)
    if (args[0].startswith("-") and not dashdash) or (n[0] == "pushd" and re.fullmatch(r"[+-]\d+", args[0])):
        return None
    target = posixpath.expanduser(args[0])
    if target.startswith("/"):
        return posixpath.normpath(target)
    if cwd is None or cdpath:
        return None
    return posixpath.normpath(posixpath.join(cwd, target))


def _env_dirs(argv: List[str]) -> List[str]:
    """Thư mục của `env -C DIR`/`--chdir=DIR` (theo thứ tự, kể cả `env` lồng) trước lệnh thật."""
    dirs: List[str] = []
    _strip_prefixes(argv, dirs)
    return dirs


def _run_dir(argv: List[str], here: Optional[str]) -> Optional[str]:
    """Thư mục lệnh `argv` chạy: `here`, dời theo `env -C` như `cd` (review #186 lần 2). Lệnh có chuyển hướng mà thư mục
    đã dời: shell mở đích chuyển hướng ở `here`, lệnh ghi file ở thư mục mới → không biết (D-106 thử mọi thư mục canh)."""
    run = here
    for d in _env_dirs(argv):
        run = _cd_target(["cd", "--", d], run)
    moved = run != here
    return None if moved and any(_is_redirect(t) for t in argv) else run


def _sets_cdpath(argv: List[str]) -> bool:
    """Lệnh đặt/xuất `CDPATH` (`CDPATH=… cd x`, `CDPATH=…;`, `export CDPATH[=…]`): `cd` tương đối sau đó tìm trong
    CDPATH, guard không đoán (D-106)."""
    return any(t == "CDPATH" or t.startswith("CDPATH=") for t in argv)


def _commands_with_cwd(tokens: List[str], start: Optional[str]) -> List[Tuple[List[str], Optional[str]]]:
    """Mỗi lệnh đơn kèm thư mục nó chạy: `cd`/`pushd` dời thư mục; `(`…`)` và `$(`…`)` là subshell — ra khỏi đó
    thì về thư mục cũ (`(cd ../b && git pull); git commit` vẫn commit ở chỗ cũ). `popd`/đích không rõ → None.
    `CDPATH` có trong môi trường hay được đặt trong lệnh → `cd` tương đối là không rõ (D-106)."""
    out: List[Tuple[List[str], Optional[str]]] = []
    stack: List[Optional[str]] = []
    here: Optional[str] = start
    cur: List[str] = []
    cdpath = bool(os.environ.get("CDPATH"))

    def flush() -> None:
        nonlocal here, cdpath
        if cur:
            n = normalize(cur)
            cdpath = cdpath or _sets_cdpath(cur)
            if n[:1] in (["cd"], ["pushd"]):
                here = _cd_target(n, here, cdpath)
            elif n[:1] == ["popd"]:
                here = None
            out.append((list(cur), _run_dir(cur, here)))
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
    # `$PWD`/`~+` là thư mục đang đứng; `..` chuẩn hoá (`$PWD/..`, `x/../..` — AUD-SEC-099)
    t = posixpath.normpath(PWD_REF_RE.sub(".", t))  # rỗng → `.` (trước đây `/`): vẫn là đích nguy hiểm
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
    return n[0] in INTERPRETERS or n[0] == "sudo" or _stdin_shell(argv)  # `| source /dev/stdin` (AUD-SEC-098)


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


PUSH_VALUE_OPTS = ("-o", "--push-option", "--repo", "--receive-pack", "--exec")


def _git_push(args: List[str], cwd: Optional[str] = None) -> Tuple[str, str]:
    """push: deny --force/--mirror/+refspec và xoá nhánh chính; ask khi đẩy thẳng nhánh chính — kể cả khi không có
    refspec hoặc đích là `HEAD` mà nhánh hiện tại (ở `cwd`) là nhánh chính — và khi `--all`/`--tags` (mọi nhánh/tag)."""
    flags = _short_flags(args)
    force = any(x.startswith("--force") and x != "--force-if-includes" or x == "--mirror" for x in args) or "f" in flags
    refs = _positionals(args, PUSH_VALUE_OPTS)
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
# Merge mà guard không đọc được `hard` (merge-check lỗi, repo khác, PR không rõ số, graphql) → chặn như ngoại lệ cứng:
# không xác minh được thì không cho qua (AUD-SEC-044/045).
UNVERIFIED_ASK = "không xác minh được ngoại lệ cứng (ADR-0019): người merge"
# Merge khi `merge-check` báo chưa có review hợp lệ ở head (`eligible` false — ADR-0028; pha build hoãn review nên không
# rơi vào đây, ADR-0031) → chặn ở chính sách mặc định (AUD-DOC-054).
REVIEW_MISSING_ASK = "chưa có review hợp lệ ở head (ADR-0028)"
# Bật auto-merge của GitHub (`gh pr merge --auto`, graphql `enablePullRequestAutoMerge`, tool MCP `enable…auto_merge`):
# GitHub merge khi check xanh mà không ghim head đã đánh giá → deny phẳng ở mọi mức tự chủ, mọi PR, mọi chính sách (kể
# cả strict), không gọi merge-check (ADR-0036 §3). Tắt auto-merge vẫn cho qua. Chuỗi là dấu của mã `AUTO_MERGE_ENABLE`.
AUTO_MERGE_WHY = (
    "bật auto-merge của GitHub (không ghim head) — máy chỉ merge ghim head sau `xt.py merge-check` (ADR-0036)"
)
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


# Bộ nạp của `py_run` (_lib.sh — giữ GIỐNG HỆT, test so): chạy `main()` của file .py như một module (sys.path[0] = thư
# mục của file, không lấy cwd). Đối số: <file.py> <đối số…>. Chạy với `-I -B`: cách ly (bỏ PYTHON*, user-site, cwd —
# AUD-SEC-065) và Python không đọc/ghi bytecode ở chỗ agent ghi được. Bộ nạp KHÔNG cache bytecode: biên dịch từ nguồn
# mỗi lần. Thư mục agent ghi được không thể tin — header pyc (checked-hash) tính được từ mã nguồn công khai còn phần
# marshal thì không ai kiểm, nên pyc giả khớp header vẫn chạy thay guard (AUD-SEC-074, review PR #182). Đo: thêm
# ~80–100 ms mỗi lần gọi `pre-bash-guard.sh` (guard.py ~4.900 dòng).
PY_LOADER = """import sys
p = sys.argv[1]
d, _, f = p.rpartition("/")
sys.path.insert(0, d or ".")
code = compile(open(p, "rb").read(), p, "exec", dont_inherit=True)
m = type(sys)(f[:-3])
m.__file__ = p
sys.modules[m.__name__] = m
sys.argv = sys.argv[1:]
exec(code, m.__dict__)
sys.exit(m.main())
"""


def isolated_python() -> List[str]:
    """Đầu lệnh python chạy `main()` của một file cho tiến trình con của guard — như `py_run` của _lib.sh: cách ly,
    biên dịch từ nguồn (không cache bytecode)."""
    return [sys.executable, "-I", "-B", "-c", PY_LOADER]


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
        *isolated_python(),
        xt,
        "merge-check",
        "--json",
        *(["--pr", selector[0]] if selector else []),
    ]
    try:
        env = dict(os.environ, CLAUDE_PROJECT_DIR=root)
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=MERGE_CHECK_TIMEOUT, env=env, check=False)
        data: Dict[str, object] = json.loads(r.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return {"verdict": "lỗi", "reasons": ["merge-check không chạy được"]}
    return data


def _gh_auto_flag(args: List[str]) -> bool:
    """Cờ bật auto-merge của `gh pr merge` (`--auto`, cả dạng gán `--auto=…`) ở bất kỳ vị trí nào — kể cả là giá trị
    của cờ khác (`-b --auto`): chặn thừa an toàn hơn đoán sai cách gh tách cờ."""
    return any(a == "--auto" or a.startswith("--auto=") for a in args)


def gh_pr_merge_rule(args: List[str], root: str) -> Tuple[str, str]:
    """`gh pr merge` (ADR-0013): mặc định hỏi người; `allow` chỉ khi `xt.py merge-check` = merge VÀ lệnh ghim đúng
    head đã kiểm (`--match-head-commit`). `--admin` (vượt ruleset) và `--repo` (repo khác) luôn hỏi. Bật auto-merge
    (`--auto`, mọi vị trí cờ, kể cả kèm `--admin`/`-R`) → deny phẳng, không gọi merge-check (ADR-0036 §3)."""
    selector = _positionals(args, GH_MERGE_VALUE_FLAGS)
    repo = _flag_value(args, "-R") or _flag_value(args, "--repo") or next((a[2:] for a in args if a[:2] == "-R"), "")
    # Tắt auto-merge (chỉ người bật được): máy phải tắt được — `pr next`/steward `disable-auto-merge` (ADR-0036,
    # LOOP-STOP-005) — không chặn.
    if args and set(args) - set(selector) == {"--disable-auto"}:
        return "ask", f"{EXTERNAL_ASK} — tắt auto-merge"
    if _gh_auto_flag(args):
        return "deny", AUTO_MERGE_WHY
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
    """Đích (đã mở `~`/`$HOME`, `$PWD`/`~+` = thư mục đang đứng) nằm ngoài gốc dự án và ngoài thư mục tạm; `~-`/
    `$OLDPWD` (thư mục trước, không biết) → True (fail-closed, AUD-SEC-099); biến khác/không rõ → False (fail-open)."""
    if OLDPWD_REF_RE.match(target):
        return True
    t = PWD_REF_RE.sub(".", re.sub(r"^(\$HOME|\$\{HOME\})(?=/|$)", "~", target))
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
        # lệnh của -exec bắt đầu ở độ sâu 2: còn hai lớp shell lồng (`bash -c '… sh -c "…"'`, review #159)
        verdict = bash_decision(shlex.join(sub), root, cwd, MAX_NEST - 2)
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


RSYNC_DELETE_RE = re.compile(r"--(?:del|delete(?:-\w+)?)(?:=.*)?")
HOME_ROOT_TARGETS = {"/", "~", "$HOME", "${HOME}"}  # dời đi đâu cũng là mất (`mv ~ ./x`)
MV_VALUE_OPTS = ("-t", "--target-directory", "-S", "--suffix")


def _drop_redirects(args: List[str]) -> List[str]:
    """Bỏ chuyển hướng và đích của nó (`2>/dev/null`, `>/dev/null 2>&1`, `&>f`) — không phải đối số của lệnh (review
    #159: `rm -rf build 2>/dev/null` từng bị coi là xoá `/dev/null`)."""
    out: List[str] = []
    skip = False
    for i, a in enumerate(args):
        if skip or _is_redirect(a):
            skip = not skip and _is_redirect(a)
            continue
        if not (a.isdigit() and i + 1 < len(args) and _is_redirect(args[i + 1])):
            out.append(a)
    return out


def _rsync_wipes(args: List[str], root: str, cwd: Optional[str]) -> List[str]:
    """`rsync --delete` lên đích local ngoài dự án; `--remove-source-files` xoá nguồn ngoài dự án."""
    pos = _positionals(args, COPY_VALUE_OPTS["rsync"])
    out = [s for s in pos[:-1] if _outside_project(s, root, cwd)] if "--remove-source-files" in args else []
    deleting = pos and any(RSYNC_DELETE_RE.fullmatch(a) for a in args) and not REMOTE_SPEC_RE.match(pos[-1])
    return out + ([pos[-1]] if deleting and _outside_project(pos[-1], root, cwd) else [])


def _mv_wipes(args: List[str], root: str, cwd: Optional[str]) -> List[str]:
    """`mv` dời gốc/home (đi đâu cũng mất) hoặc dời thư mục ngoài dự án sang chỗ khác ngoài dự án (`mv ~/x /tmp/y`);
    dời một file ngoài dự án (`mv ~/Downloads/a.zip /tmp/`) là đổi chỗ, không phải xoá."""
    pos = _positionals(args, MV_VALUE_OPTS)
    target = _flag_value(args, "-t") or _flag_value(args, "--target-directory")
    srcs, dest = (pos, target) if target else (pos[:-1], pos[-1] if pos else "")
    away = bool(dest) and not _inside_root(dest, root, cwd)
    return [
        s
        for s in srcs
        if _rm_target(s) in HOME_ROOT_TARGETS
        or (away and _outside_project(s, root, cwd) and os.path.isdir(os.path.join(cwd or root, os.path.expanduser(s))))
    ]


def _wipe_outside(name: str, args: List[str], root: str, cwd: Optional[str]) -> List[str]:
    """Đích ngoài dự án mà lệnh khác `rm`/`find` xoá/huỷ (AUD-SEC-068): `rsync --delete`/`--remove-source-files`,
    `shred`, `mv` gốc/home hoặc thư mục ngoài dự án đi chỗ khác ngoài dự án."""
    if name == "rsync":
        return _rsync_wipes(args, root, cwd)
    if name == "shred":
        return [t for t in _positionals(args) if _outside_project(t, root, cwd)]
    return _mv_wipes(args, root, cwd) if name == "mv" else []


def _inside_root(target: str, root: str, cwd: Optional[str]) -> bool:
    t = os.path.realpath(os.path.join(cwd or root, os.path.expanduser(target)))
    r = os.path.realpath(root)
    return t == r or t.startswith(r.rstrip("/") + "/")


def _delete_rule(name: str, args: List[str], root: str, cwd: Optional[str]) -> Tuple[str, str]:
    args = _drop_redirects(args)
    if name == "rm":
        return _rm_rule(args, root, cwd)
    wiped = _wipe_outside(name, args, root, cwd) if root else []
    if wiped:
        return "ask", f"xoá đệ quy ngoài thư mục dự án ({name} {wiped[0]}) — xoá dữ liệu cần người duyệt"
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


# Tool MCP merge PR (vd `mcp__github__merge_pull_request`): merge ghim `expectedHeadSha` mà merge-check cho phép → allow
# (ADR-0014). Tool bật auto-merge (tên có `enable` và `auto_merge`, mọi server, mọi input) → deny phẳng, không gọi
# merge-check (ADR-0036 §3). Regex vẫn khớp `auto_merge`: tool bật/tắt đi qua guard; guard lỗi thì chặn
# (`_failure_decision`).
MCP_MERGE_RE = re.compile(r"mcp__.+__\w*(merge_pull_request|auto_merge)\w*")
MCP_MERGE_KEYS = {"owner", "repo", "pullNumber", "expectedHeadSha", "merge_method", "commit_title", "commit_message"}


# Dấu review trên PR mà steward/`pr next` tin (ADR-0027) — chỉ `xt.py pr reviewed` đăng (gọi `gh api` từ tiến trình
# python, không qua tool Bash/MCP). Đăng tay = bằng chứng review giả, né "reviewer khác họ model" (D-045, AUD-SEC-069).
# Đúng dạng dấu mà `xt.py` đọc (`head=<40 hex> verdict=…`) hoặc head ghép lúc chạy (`head=$(git rev-parse HEAD)`,
# `$H`, backtick — re-review #159); mã nguồn/tài liệu nhắc dạng dấu (`head={head}`, `head=<sha>`) không khớp.
REVIEW_MARK_RE = re.compile(
    r"<!--\s*xt-review\s+v1\s+head=(?:[0-9a-f]{40}|[$`][^>]{0,200}?)\s+verdict=(?:clean|blocking)"
)
# `gh api` chỉ khi GHI (cờ trường/`--input`/phương thức ghi) — `gh api … --jq` đọc comment không bị chặn (review #159).
GH_POST_RE = re.compile(
    r"\bgh\b.*?\b(?:(?:pr|issue)\s+(?:comment|review|create|edit)\b"
    r"|api\b.*?(?:\s-[fF]\b|\s--(?:field|raw-field|input)\b|\s(?:-X\s*|--method[=\s]+)(?:POST|PATCH|PUT)\b))",
    re.S,
)
# Tool MCP đăng chữ lên PR/issue mà steward đọc dấu từ đó (commit file nhắc dấu thì không — review #159).
MCP_REVIEW_POST_RE = re.compile(
    r"mcp__.+__\w*(?:issue_comment|pull_request_review_write|comment_to_pending_review|reply_to_pull_request_comment"
    r"|create_pull_request|update_pull_request)\w*"
)
REVIEW_FORGE_WHY = (
    "ghi tay bằng chứng review (dấu `xt-review v1` trên PR) — chỉ `xt.py pr reviewed` đăng (ADR-0026/0027)"
)


def _forges_review(argv: List[str]) -> bool:
    """Lệnh `gh` đăng/sửa comment, review, thân PR/issue (hoặc `gh api`) mang dấu review — chỉ argv của lệnh thật,
    không phải chữ trong heredoc/chuỗi của lệnh khác (script sửa tài liệu nhắc tới dấu)."""
    n = normalize(argv)
    return (
        bool(n) and n[0] == "gh" and bool(GH_POST_RE.search(" ".join(n))) and bool(REVIEW_MARK_RE.search(" ".join(n)))
    )


def mcp_decision(tool_name: str, tool_input: Dict[str, object], root: str) -> Tuple[str, str]:
    if MCP_REVIEW_POST_RE.fullmatch(tool_name) and REVIEW_MARK_RE.search(json.dumps(tool_input, ensure_ascii=False)):
        return "deny", f"Lệnh bị khung chặn ({REVIEW_FORGE_WHY}): {tool_name}"
    hit = mcp_attribution(tool_name, tool_input, root)
    if hit:
        return "deny", hit
    if not MCP_MERGE_RE.fullmatch(tool_name):
        return "", ""
    if "enable" in tool_name and "auto_merge" in tool_name:  # bật auto-merge: chặn phẳng (ADR-0036 §3)
        return "deny", f"Lệnh bị khung chặn ({AUTO_MERGE_WHY}): {tool_name}"
    if "disable" in tool_name:  # tắt auto-merge do người bật: máy phải tắt được (ADR-0036, LOOP-STOP-005) — không chặn
        return "ask", f"{EXTERNAL_ASK} — tắt auto-merge qua MCP ({tool_name})"
    # Chỉ server GitHub chính (`mcp__github__…`): server khác cùng tên tool có thể trỏ host khác với repo merge-check đọc.
    if not tool_name.startswith("mcp__github__"):
        return "ask", f"{EXTERNAL_ASK} — {UNVERIFIED_ASK}: merge qua server MCP khác ({tool_name})"
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


def _review_block(d: Dict[str, object]) -> str:
    """Lý do chặn vì review (ADR-0028) theo kết quả merge-check; '' khi không chặn. CI/làn cho merge (`merge`/`review`)
    mà review ở head chưa hợp lệ (`eligible` false; khung cũ trả `merge` kèm `eligible: false`), hoặc ở L3 PR chưa
    review/review chặn dù CI đang chạy/PR nháp (`wait`) hay conflict (`fix`) — review PR #182. Làn nhanh/pha build
    (`na`/`deferred`) và dưới L3 → ''."""
    level = d.get("autonomy")
    not_reviewed = isinstance(level, int) and level >= 3 and d.get("review") in ("missing", "blocking")
    if d.get("eligible") is False and (d.get("verdict") in ("merge", "review") or not_reviewed):
        return f"{EXTERNAL_ASK} — {REVIEW_MISSING_ASK}: {d.get('review')} — `xt.py pr next` rồi merge"
    return ""


def _merge_ask(why: str, selector: List[str], root: str, repo: str = "") -> Tuple[str, str]:
    """Merge mà guard không tự cho phép (thiếu ghim, cờ lạ, repo khác…): ask `why` — trừ khi chạm/không xác minh được
    ngoại lệ cứng (AUD-SEC-044) hoặc PR chưa có review hợp lệ ở head (AUD-HAR-093: cùng luật với merge ghim head) thì
    ask mang dấu chặn."""
    d, gate = _hard_gate(selector, root, repo)
    if gate[0]:
        return gate
    block = _review_block(d)
    return ("ask", block) if block else ("ask", why)


def _merge_verdict(selector: List[str], sha: str, root: str, repo: str = "") -> Tuple[str, str]:
    """`allow` khi `xt.py merge-check` (PR theo selector; rỗng = nhánh hiện tại) trả merge, head đã kiểm = `sha` (và repo
    trùng nếu có), không thuộc/không mù ngoại lệ cứng (`_hard_gate` — mặc định thành deny, ADR-0019); không thì ask."""
    d, gate = _hard_gate(selector, root, repo)
    if gate[0]:
        return gate
    raw = d.get("reasons")
    reasons = "; ".join(str(x) for x in raw) if isinstance(raw, list) else ""
    # Điều kiện merge một nhà (ADR-0028): thiếu review hợp lệ ở head → mã chặn, không phải ask thường bị chính sách mặc
    # định cho qua (AUD-DOC-054). Kiểm trước nhánh `verdict != merge` (`_review_block`).
    block = _review_block(d)
    if block:
        return "ask", block
    if d.get("verdict") != "merge":
        return "ask", f"{EXTERNAL_ASK} — merge-check: {d.get('verdict')}: {reasons}"
    if d.get("head") != sha:
        return "ask", f"{EXTERNAL_ASK} — head đã kiểm {d.get('head')} khác {sha}"
    return "allow", f"merge-check: {reasons}"


def _gh_api_merge_rule(args: List[str], root: str) -> Tuple[str, str]:
    """`gh api` ghi → ask; trừ merge REST ghim head (`-X PUT repos/{owner}/{repo}/pulls/N/merge -f sha=… [-f
    merge_method=…]`, mỗi khoá một lần, không `@file`) mà merge-check cho phép (LOOP-STOP-022). Bật auto-merge qua
    graphql (`enablePullRequestAutoMerge`, ở endpoint nào cũng vậy — `gh api /graphql` cũng tới GraphQL) → deny phẳng
    (ADR-0036 §3)."""
    if GRAPHQL_AUTO_MERGE_RE.search(" ".join(args)):
        return "deny", AUTO_MERGE_WHY
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


# Merge qua `gh api`: REST `repos/<chủ>/<repo>/pulls/N/merge` (cả `{owner}/{repo}`), mutation graphql. Bật auto-merge
# (`enablePullRequestAutoMerge`) → deny phẳng (ADR-0036 §3); tắt (`disablePullRequestAutoMerge`) là ghi thường.
ANY_REST_MERGE_RE = re.compile(r"/?repos/([^/\s]+/[^/\s]+)/pulls/(\d+)/merge/?")
GRAPHQL_MERGE_RE = re.compile(r"\bmergePullRequest\b")
GRAPHQL_AUTO_MERGE_RE = re.compile(r"\benablePullRequestAutoMerge\b")


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
    # Endpoint graphql ở mọi dạng `gh api` nhận: `graphql`, `/graphql`, `https://api.github.com/graphql` — dạng `/graphql`
    # từng rơi xuống nhánh REST và thành `ask` thường (T-1806 câu hỏi mở 2, 2026-10-21).
    if len(pos) == 1 and _api_path(pos[0]).rstrip("/").rsplit("/", 1)[-1] == "graphql":  # mutation merge, hoặc query mờ
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
        return _pr_flag_merge_rule(args, root)
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
        or path.rstrip("/").rsplit("/", 1)[-1] == "graphql"  # cả `/graphql`, URL đầy đủ (review #198)
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


def _pr_flag_merge_rule(args: List[str], root: str) -> Tuple[str, str]:
    """`gh pr <cờ…> merge …` (`gh pr -R o/r merge 7`): bật auto-merge → deny phẳng (ADR-0036 §3); còn lại không tự
    merge — vẫn kiểm `hard`/review như merge thiếu ghim."""
    if _gh_auto_flag(args[1:]):
        return "deny", AUTO_MERGE_WHY
    selector, repo = _pr_flag_merge(args, args.index("merge", 2))
    return _merge_ask(f"{EXTERNAL_ASK} — `gh pr <cờ> merge` không tự merge", selector, root, repo)


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


# Tuỳ chọn `-o` của ssh chạy lệnh shell trên CHÍNH máy này, máy đích nào cũng vậy (ProxyCommand, LocalCommand…).
SSH_LOCAL_CMD_OPTS = ("proxycommand", "localcommand", "knownhostscommand")


def _ssh_target(args: List[str]) -> Tuple[str, List[str]]:
    """(máy đích, lệnh từ xa) của `ssh [opts] host [opts] [lệnh…]` — ssh đọc tuỳ chọn cả sau tên máy, tới từ đầu tiên của
    lệnh."""
    host, i = "", 0
    while i < len(args) and (not host or args[i].startswith("-")):
        a = args[i]
        if a.startswith("-"):
            i += 2 if a in SSH_VALUE_FLAGS else 1
            continue
        host, i = a, i + 1
    return host, args[i:]


def _ssh_local_scripts(tokens: List[str]) -> List[str]:
    """Lệnh ssh chạy trên máy này (AUD-SEC-035, T-1523): `-o ProxyCommand=…`/`LocalCommand`, và lệnh từ xa khi đích là
    loopback — một shell thật ở `~` (`ssh localhost 'rm -rf ~'` = `rm -rf ~` tại đây). Máy khác: lệnh chạy ở đó, không
    quét (ra khỏi máy dev là việc của `egress_rule`)."""
    out: List[str] = []
    for c in split_commands(tokens):
        n = normalize(c)
        if n[:1] != ["ssh"]:
            continue
        for opt in _flag_values(n[1:], ("-o",)):
            key, val = [*re.split(r"[=\s]", opt.strip(), maxsplit=1), ""][:2]  # `Key=giá trị` hoặc `Key giá trị`
            out += [val] if key.lower() in SSH_LOCAL_CMD_OPTS and val.strip() else []
        host, remote = _ssh_target(n[1:])
        if remote and _is_loopback(host.rsplit("@", 1)[-1]):
            out.append("cd ~ && " + " ".join(remote))
    return out


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


# `<>`: mở đọc-ghi (tạo file nếu chưa có) — `exec 3<> .env`, `1<> .env` là ghi (review #186 lần 3); số fd đứng trước
# (`3<>`) là token riêng sau khi tách
REDIRECTS = (">", ">>", ">|", "&>", "&>>", "<>")


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


# `w f`, `1w f`, `$w f`, `/a/!w f`, `s/a/b/w f`, `s|a|b|w f`: lệnh `w` của sed (sau địa chỉ/cờ của `s`) ghi file
SED_WRITE_RE = re.compile(r"(?:^|[0-9]|[^\w\s][gpIiMme0-9]*)[ \t]*w[ \t]+([^;\n}]+)")
AWK_WRITE_RE = re.compile(r">>?[ \t]*\"([^\"\n]+)\"")  # `print > "f"` trong chương trình awk


def _sed_scripts(args: List[str]) -> List[str]:
    """Script của sed: giá trị `-e`/`--expression`, không có thì đối số vị trí đầu."""
    exprs = _flag_values(args, ("-e", "--expression"))
    return exprs or _positionals(args, ("-f", "--file", "-l", "--line-length"))[:1]


def _sed_writes(args: List[str]) -> List[str]:
    return [m.group(1).strip() for sc in _sed_scripts(args) for m in SED_WRITE_RE.finditer(sc)]


def _awk_targets(args: List[str]) -> List[str]:
    """awk: `-i inplace` sửa tại chỗ các file đầu vào; `print > "f"` trong chương trình ghi f."""
    pos = _positionals(args, ("-f", "-v", "-F", "-i", "--include", "--file", "--assign", "--field-separator"))
    prog = [] if _flag_values(args, ("-f", "--file")) else pos[:1]
    out = [m.group(1) for p in prog for m in AWK_WRITE_RE.finditer(p)]
    inplace = "inplace" in _flag_values(args, ("-i", "--include"))
    return out + (pos[len(prog) :] if inplace else [])


def _tar_dest(args: List[str]) -> List[str]:
    """Thư mục giải nén của `tar -x … -C d` (tạo/liệt kê lưu trữ với `-C` chỉ đọc thư mục đó)."""
    short = "".join(a[1:] for a in args if a[:1] == "-" and a[1:2] != "-") + (
        args[0] if args and args[0][:1] != "-" else ""
    )
    extract = "x" in short or any(a in ("--extract", "--get") for a in args)
    return _flag_values(args, ("-C", "--directory")) if extract else []


FILE_WRITERS: Dict[str, Callable[[List[str]], List[str]]] = {
    "curl": _curl_outputs,
    "wget": _wget_outputs,
    "rsync": _rsync_dest,
    "patch": _patch_targets,
    "sort": lambda a: _flag_values(a, ("-o", "--output")),
    "awk": _awk_targets,
    "gawk": _awk_targets,
    "tar": _tar_dest,
    "unzip": lambda a: _flag_values(a, ("-d",)),
    "split": lambda a: _positionals(a, ("-l", "-b", "-C", "-n", "-a", "-t", "--additional-suffix"))[1:2],
    "csplit": lambda a: _flag_values(a, ("-f", "--prefix")),
    "dd": lambda a: [x[3:] for x in a if x.startswith("of=")],  # review #186 lần 2: `dd of=.env` là ghi
}


def _git_file_targets(n: List[str]) -> List[str]:
    """File mà `git checkout <rev> -- f`/`git restore -s <rev> f` ghi đè từ commit khác — chỉ xét bí mật và bằng chứng:
    khôi phục file cổng/hàng rào bằng git là đường lùi chuẩn, không chặn."""
    if n[:2] == ["git", "restore"] and "--staged" in n and not {"--worktree", "-W"} & set(n):
        return []  # chỉ đổi chỉ mục, không ghi cây làm việc
    if n[:2] in (["git", "checkout"], ["git", "restore"]):
        return _positionals(n[2:], ("-s", "--source", "-b", "-B", "--orphan", "--conflict", "--pathspec-from-file"))
    return []


PYCACHE_ENV_RE = re.compile(r"PYTHONPYCACHEPREFIX=(.+)")


def _checkout_index_targets(args: List[str]) -> List[str]:
    """`git checkout-index [--prefix=P] [path…]` ghi `P` + đường dẫn trong chỉ mục (nối CHUỖI, không nối thư mục):
    đích là P, từng P+path, và `.autopilot` khi P là tiền tố chữ của nó (`--prefix=.auto` + path `pilot/…`) — AUD-SEC-074
    (`--prefix=.autopilot/…` từng ghi file vào vùng rào mà guard không thấy)."""
    vals = _flag_values(args, ("--prefix",))
    prefix = vals[-1] if vals else ""
    pos = _positionals(args, ("--prefix",))
    head, _, tail = prefix.rpartition("/")
    partial = [f"{head}/.autopilot" if head else ".autopilot"] if tail and ".autopilot".startswith(tail) else []
    return ([prefix] if prefix else []) + [prefix + p for p in pos] + partial


GIT_WRITERS: Dict[str, Callable[[List[str]], List[str]]] = {
    "rm": _positionals,
    "mv": _positionals,
    "checkout-index": _checkout_index_targets,
}


def _pycache_targets(n: List[str], argv: List[str]) -> List[str]:
    """Thư mục bytecode mà Python sẽ ghi: `-X pycache_prefix=P`/`-Xpycache_prefix=P`, `PYTHONPYCACHEPREFIX=P` (gán đầu
    lệnh, `env`, `export`) — AUD-SEC-074. Hook không còn nạp bytecode từ cache (review PR #182) nên đây chỉ là một
    đường ghi file như mọi đường khác: prefix trỏ vào vùng rào (`.autopilot/`, hook, cổng) vẫn là ghi tay vào đó."""
    out = [m.group(1) for t in argv if (m := PYCACHE_ENV_RE.fullmatch(t))]
    if n and INTERP_RE.fullmatch(n[0]):
        xs = [n[i + 1] for i, a in enumerate(n[:-1]) if a == "-X"] + [a[2:] for a in n if a.startswith("-X")]
        out += [x.split("=", 1)[1] for x in xs if x.startswith("pycache_prefix=")]
    return out


def write_targets(n: List[str], argv: List[str]) -> List[str]:
    """File mà lệnh có thể ghi/xoá: chuyển hướng, `sed -i`/`perl -i`, `tee`, cp/mv/install/ln, truncate/rm, `git rm/mv`,
    `git checkout-index --prefix`, thư mục bytecode của Python."""
    out = [argv[i + 1] for i, t in enumerate(argv[:-1]) if t in REDIRECTS] + _pycache_targets(n, argv)
    name, args = (n[0], n[1:]) if n else ("", [])
    if name == "git" and args[:1] and args[0] in GIT_WRITERS:
        return out + GIT_WRITERS[args[0]](args[1:])
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
    if name == "sed":
        out += _sed_writes(args)
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
    rel = _rel_dir(target, root)
    return rel in FENCE_DIRS or _match_any(rel, FENCE_PATTERNS)


def _at(target: str, cwd: Optional[str]) -> str:
    """Đích ghi tương đối tính từ thư mục lệnh đang đứng (`cd .claude/hooks && echo x > guard.py`)."""
    if not cwd or not target or target.startswith(("/", "~", "$")):
        return target
    return posixpath.normpath(posixpath.join(cwd, target))


EVIDENCE_WHY = "ghi/xoá tay bằng chứng autopilot qua Bash ({}) — chỉ `xt.py loop …` được ghi (P1)"


# `~+` là `$PWD` với bash (tilde expansion — AUD-SEC-097); `~-` là `$OLDPWD`: thư mục trước đó, guard không biết (D-106)
PWD_REF_RE = re.compile(r"^(\$PWD|\$\{PWD\}|\$\(pwd\)|`pwd`|~\+)(?=/|$)")
OLDPWD_REF_RE = re.compile(r"^(~-|\$OLDPWD|\$\{OLDPWD\})(?=/|$)")
PROJECT_REF_RE = re.compile(r"^(\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\})(?=/|$)")


def _resolve_target(t: str, root: str, cwd: Optional[str]) -> str:
    """Đích ghi với `$PWD`/`$(pwd)`/`$CLAUDE_PROJECT_DIR` đứng đầu được mở ra thư mục thật, rồi tính từ thư mục đang đứng
    (`rm -rf $PWD/.autopilot` từng lọt: dấu `$` làm đích bị coi là không rõ)."""
    t = PROJECT_REF_RE.sub(lambda _: root, PWD_REF_RE.sub(lambda _: cwd or root, t, count=1), count=1)
    return _at(t, cwd)


# D-106: thư mục đang đứng không biết (`cd "$X"`, `cd -`, `pushd +1`, `popd`, CDPATH) → đích tương đối thử ở gốc và
# mọi thư mục canh. Ở thư mục canh chỉ tính khi file đã có hoặc tên là tên được canh ở đó — `cd "$X" && echo > a.txt`
# không bị chặn chỉ vì `.claude/hooks/a.txt` khớp mẫu `.claude/hooks/*`.
GIT_HOOK_NAMES = frozenset(
    "applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg commit-msg post-commit "
    "pre-rebase post-checkout post-merge pre-push pre-receive update proc-receive post-receive post-update "
    "reference-transaction push-to-checkout pre-auto-gc post-rewrite sendemail-validate fsmonitor-watchman "
    "p4-changelist p4-prepare-changelist p4-post-changelist p4-pre-submit post-index-change".split()
)
UNKNOWN_CWD_DIRS: Tuple[Tuple[str, FrozenSet[str]], ...] = (
    (".claude", frozenset({"settings.json", "settings.local.json", "hooks"})),
    (".claude/hooks", frozenset()),
    (".autopilot", frozenset(EVIDENCE_NAMES)),
    (".git", frozenset({"config", "hooks"})),
    (".git/hooks", GIT_HOOK_NAMES),
)


def _where(t: str, root: str, cwd: Optional[str]) -> List[str]:
    """Các đích có thể của `t`: thư mục biết → một đích (`_resolve_target`); không biết (None) → gốc dự án cộng thư mục
    canh nào có file đó hoặc tên được canh (D-106). `~-/x`, `$OLDPWD/x` = `x` ở thư mục không biết (AUD-SEC-097)."""
    old = OLDPWD_REF_RE.match(t)
    if old:
        return _where(t[old.end() :].lstrip("/") or ".", root, None)
    if cwd is not None:
        return [_resolve_target(t, root, cwd)]
    t = PROJECT_REF_RE.sub(lambda _: root, t, count=1)
    pwd = PWD_REF_RE.match(t)  # `$PWD/x` khi thư mục không biết = `x` tương đối
    t = (t[pwd.end() :].lstrip("/") or ".") if pwd else t
    if not t or t.startswith(("/", "~", "$")):
        return [t]
    out = [posixpath.normpath(posixpath.join(root, t))]
    for d, names in UNKNOWN_CWD_DIRS:
        p = posixpath.normpath(posixpath.join(root, d, t))
        if os.path.lexists(p) or t.split("/", 1)[0] in names:
            out.append(p)
    return out


def _write_asks(n: List[str], argv: List[str], root: str, cwd: Optional[str] = None) -> List[str]:
    """Câu hỏi xác nhận cho file hàng rào/bí mật/cổng/migration mà lệnh có thể ghi (bỏ qua /dev/*). `cwd` None = thư
    mục đang đứng không biết (D-106, `_where`)."""
    asks: List[str] = []
    if n and n[0] in ("chmod", "chown", "chattr"):  # bỏ quyền thực thi = git bỏ qua hook
        asks += [
            GIT_HOOK_WHY.format(t)
            for t in _positionals(n[1:])
            if any(_match_any(rel_path(x, root), GIT_HOOK_PATTERNS) for x in _where(t, root, cwd))
        ]
    cfg = _git_config_file(n)
    find_evidence = _find_evidence_targets(n[1:]) if n[:1] == ["find"] else []
    targets = [*write_targets(n, argv), *([cfg] if cfg else [])]
    asks += [
        EVIDENCE_WHY.format(t)
        for t in (x for t in find_evidence for x in _where(t, root, cwd))
        if t not in targets and _target_kind(t, root) == "evidence"
    ]
    for target in (x for t in targets for x in _where(t, root, cwd)):
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
    restored = [(t, _target_kind(x, root)) for t in _git_file_targets(n) for x in _where(t, root, cwd)]
    asks += [f"ghi file bí mật qua Bash (git lấy từ commit khác): {t}" for t, k in restored if k == "secret"]
    return asks + [EVIDENCE_WHY.format(f"git {n[1]} {t}") for t, k in restored if k == "evidence"]


def _rel_dir(target: str, root: str) -> str:
    """`rel_path` bỏ `/` cuối; đích `/` (hay `//`) giữ là `/` — rỗng từng bị coi là gốc dự án (`cp x /` thành cổng)."""
    rel = rel_path(target, root)
    return rel.rstrip("/") or rel[:1]


def _target_kind(target: str, root: str) -> str:
    """classify_path của đích ghi; đích là THƯ MỤC cổng (`cp x .claude/hooks/`) cũng là cổng."""
    if not target or target.startswith("/dev/"):
        return ""
    rel = _rel_dir(target, root)
    return path_kind(rel, root) or ("gate" if _dir_holds_gate(rel, root) else "")


# Thư mục NGOÀI dự án (`mv x /tmp`) đọc tối đa chừng này mục (D-097): /tmp ≈ 20k mục làm mỗi lệnh chậm ~2,5 s; thư mục
# nhỏ hơn thì xét đủ như trong dự án, kể cả mẫu wildcard (`tsconfig*.json`) — strict vẫn hỏi `cp x OUT/ts/`.
OUTSIDE_SCAN_MAX = 256


def _outside_names(d: str) -> Optional[List[str]]:
    """Tên mục của thư mục ngoài dự án `d`; None khi quá OUTSIDE_SCAN_MAX mục hoặc không đọc được (chỉ kiểm tên đích
    danh); không phải thư mục → rỗng."""
    if not os.path.isdir(d) or os.path.islink(d):
        return []
    names: List[str] = []
    try:
        with os.scandir(d) as it:
            for entry in it:
                if len(names) >= OUTSIDE_SCAN_MAX:
                    return None
                names.append(entry.name)
    except OSError:
        return None
    return names


def _dir_holds_gate(rel: str, root: str) -> bool:
    """Đích là THƯ MỤC chứa file cổng (`cp x .claude/hooks/`, `rm -rf .claude`, `mv scripts …`) — reviewer #60."""
    base = rel.rstrip("/")  # `/` → nối thành `/Makefile`, không `//Makefile`
    if classify_path(base + "/_") == "gate" or any(p.startswith(base + "/") for p in GATE_PATTERNS):
        return True
    if os.path.isabs(rel):  # ngoài gốc dự án: đọc có giới hạn, quá ngưỡng thì chỉ tên đích danh (D-097)
        names = _outside_names(rel)
        if names is None:
            return any(
                classify_path(f"{base}/{n}") == "gate" and os.path.lexists(f"{base}/{n}") for n in _gate_names(rel)
            )
        return any(classify_path(f"{base}/{name}") == "gate" for name in names)
    d, names = os.path.join(root, rel), []
    with contextlib.suppress(OSError):  # không đọc được thư mục → coi như không chứa file cổng
        names = os.listdir(d) if os.path.isdir(d) and not os.path.islink(d) else []
    return any(classify_path(f"{rel}/{name}") == "gate" for name in names)


def _gate_names(rel: str) -> List[str]:
    """Tên file cổng đích danh có thể nằm ngay trong thư mục `rel`: mẫu chữ (không `*?[`) có phần thư mục khớp đuôi
    `rel` — `Makefile`, `pyproject.toml` ở mọi nơi; `settings.json` trong `~/.claude`; `dependabot.yml` trong `.github`."""
    names = []
    for pat in GATE_PATTERNS:
        if any(c in pat for c in "*?["):
            continue
        head, _, name = pat.rpartition("/")
        if not head or (rel + "/").endswith("/" + head + "/"):
            names.append(name)
    return names


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


def _heredoc_bodies(cmd: str, pat: "re.Pattern[str]" = GIT_COMMIT_TEXT_RE) -> List[str]:
    """Thân heredoc thuộc pipeline có `git commit` (`git commit -F - <<E`, `-m "$(cat <<E`, `cat <<E | git commit -F -`)
    — hay lệnh khớp `pat` (`gh pr create --body-file - <<E`); heredoc của lệnh khác trong cùng chuỗi
    (`python3 - <<E …; git commit`) là dữ liệu của lệnh đó, không quét."""
    out: List[str] = []
    for opener, m, body in _heredocs(join_continuations(cmd)):  # nối dòng `\` như shell (`git commit \` ↵ `-F - <<E`)
        if pat.search(_commit_window(opener, m.start(), _unquoted_seps(opener))):
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


# `gh pr create|edit|merge` (D-057): tiêu đề/thân PR và tiêu đề/thân commit squash (`merge --subject/--body`).
GH_PR_TEXT_RE = re.compile(r"(?<![\w-])gh\s+pr(?:\s+(?:-R|--repo)(?:\s+|=)\S+)?\s+(?:create|edit|merge)\b")
GH_PR_TEXT_OPTS = {"-t": "m", "--title": "m", "--subject": "m", "-b": "m", "--body": "m", "-F": "F", "--body-file": "F"}


def _gh_pr_text_args(args: List[str]) -> Optional[List[Tuple[str, str]]]:
    """(loại, giá trị) của tiêu đề/thân trong `gh pr …` (sau `pr`, bỏ `-R/--repo x`); không phải create/edit/merge → None."""
    rest = list(args)
    while rest[:1] in (["-R"], ["--repo"]) or rest[:1] and rest[0].startswith("--repo="):
        rest = rest[2:] if rest[0] in ("-R", "--repo") else rest[1:]
    if rest[:1] not in (["create"], ["edit"], ["merge"]):
        return None
    out: List[Tuple[str, str]] = []
    for i, x in enumerate(rest[1:], 1):
        nxt = rest[i + 1] if i + 1 < len(rest) else ""
        key, sep, val = x.partition("=")
        if x in GH_PR_TEXT_OPTS:
            out.append((GH_PR_TEXT_OPTS[x], nxt))
        elif sep and key in GH_PR_TEXT_OPTS:
            out.append((GH_PR_TEXT_OPTS[key], val))
        elif x[:2] in ("-t", "-b", "-F") and len(x) > 2:  # `-tfeat: x` (pflag)
            out.append((GH_PR_TEXT_OPTS[x[:2]], x[2:]))
    return out


def _attribution_target(
    argv: List[str], here: Optional[str], root: str
) -> Optional[Tuple[str, List[Tuple[str, str]], str]]:
    """(thư mục, cặp (loại, giá trị), loại lệnh) khi argv là `git commit` hoặc `gh pr create|edit|merge`; không → None."""
    n = normalize(argv)
    if n[:2] == ["git", "commit"]:
        return _git_dir(argv, here) or root, _commit_msg_args(n[2:]), "commit"
    pairs = _gh_pr_text_args(n[2:]) if n[:2] == ["gh", "pr"] else None
    return (here or root, pairs, "pr") if pairs is not None else None


def ai_attribution(cmd: str, commands: List[Tuple[List[str], Optional[str]]], root: str) -> str:
    """Lý do chặn khi lệnh commit vào repo cấm ghi công AI mà message chứa tên model/URL phiên; không thì rỗng.
    Xét `git commit` và `gh pr create|edit|merge` qua Bash, chữ thấy được lúc quyết định — không thấy: `echo … | git
    commit -F -`, file `-F` do lệnh trước trong chuỗi tạo, `git merge -m`/`git tag -m` (tool MCP: `mcp_attribution`)
    (LOOP-HARNESS-027)."""
    for argv, here in commands:
        target = _attribution_target(argv, here, root)
        if target is None or not AI_ATTRIBUTION_KEY_RE.search(_read_head(_xt_yaml_for(target[0]))):
            continue
        gdir, pairs, kind = target
        # `-F` tương đối tính từ thư mục git chạy (sau `-C`), như git.
        texts = [v if k == "m" else _read_head(posixpath.join(gdir, v)) for k, v in pairs]
        bodies = _heredoc_bodies(cmd, GIT_COMMIT_TEXT_RE if kind == "commit" else GH_PR_TEXT_RE)
        hit = next((m.group(0) for t in [*texts, *bodies] for m in [AI_ATTRIBUTION_RE.search(t)] if m), "")
        if hit:
            what = "Commit" if kind == "commit" else "PR"
            return (
                f"{what} ghi công AI bị khung chặn (`{hit}` — xt.yaml `ai_attribution: forbid`, LOOP-HARNESS-027): bỏ "
                "dòng tên model/URL phiên khỏi message/tiêu đề/thân rồi chạy lại."
            )
    return ""


# Tool MCP ghi chữ lên PR/lịch sử git (LOOP-HARNESS-027, D-057): tiêu đề/thân PR, message commit (kể cả commit squash
# của merge). Khoá đọc từ `xt.yaml` của dự án (repo đích của tool là chuỗi owner/repo, không có thư mục để dò).
MCP_TEXT_RE = re.compile(
    r"mcp__.+__(create_pull_request|update_pull_request|create_or_update_file|push_files|delete_file|merge_pull_request)"
)
MCP_TEXT_KEYS = ("title", "body", "message", "commit_title", "commit_message")


def mcp_attribution(tool_name: str, tool_input: Dict[str, object], root: str) -> str:
    """Lý do chặn khi tool MCP ghi PR/commit mang tên model/URL phiên ở dự án `ai_attribution: forbid`; không thì rỗng.
    URL phiên do chính máy chủ MCP gắn thêm sau khi hook cho qua thì guard không thấy — CI/review là lớp sau."""
    if not MCP_TEXT_RE.fullmatch(tool_name) or not AI_ATTRIBUTION_KEY_RE.search(_read_head(_xt_yaml_for(root))):
        return ""
    texts = [v for v in (tool_input.get(k) for k in MCP_TEXT_KEYS) if isinstance(v, str)]
    hit = next((m.group(0) for t in texts for m in [AI_ATTRIBUTION_RE.search(t)] if m), "")
    if not hit:
        return ""
    return (
        f"Ghi công AI qua {tool_name} bị khung chặn (`{hit}` — xt.yaml `ai_attribution: forbid`, LOOP-HARNESS-027): "
        "bỏ dòng tên model/URL phiên khỏi tiêu đề/thân/message rồi gọi lại."
    )


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
    if not n:  # chỉ chuyển hướng: `exec 3> .env`, `> .env` (review #186 lần 2) — vẫn là ghi
        asks.extend(_write_asks(n, argv, root, cwd))
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
        self.seen: Set[Tuple[str, Optional[str]]] = set()  # (script, thư mục chạy): cùng chuỗi ở thư mục khác vẫn quét

    def exhausted(self) -> bool:
        self.calls -= 1
        return self.calls < 0 or time.monotonic() > self.deadline


# Độ sâu shell lồng được quét (`bash -c "bash -c '…'"`); sâu hơn → hỏi (mặc định: chặn — AUD-SEC-063). 4: `find -exec`
# tốn một bậc, `find … -exec bash -c '… sh -c "…"'` thật vẫn quét được (review #159).
MAX_NEST = 4
NEST_ASK = "shell lồng quá sâu"


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
    if n[:1] in (["source"], ["."]):
        return _stdin_source(n)
    if not n or n[0] not in SHELLS:
        return False
    rest = [a for i, a in enumerate(n) if not _is_redirect(a) and not (i > 0 and _is_redirect(n[i - 1]))]
    has_c, script = _shell_script_arg(rest)
    stdin = script is None or script in STDIN_SCRIPTS
    return not has_c and stdin and "-n" not in rest  # `bash -n`: chỉ kiểm cú pháp


def _stdin_source(n: List[str]) -> bool:
    """`source /dev/stdin`, `. /dev/fd/0` (cả sau `--`): shell hiện tại chạy chữ từ stdin như `bash <<<`/`bash <<E`
    (AUD-SEC-098)."""
    args = n[2:] if n[1:2] == ["--"] else n[1:]
    return bool(args) and args[0] in STDIN_SCRIPTS


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


Span = Tuple[int, int, str]  # (đầu, sau cuối, thân) của một thay lệnh trong chuỗi


def _backtick_scripts(cmd: str) -> List[str]:
    """Thân `` `…` `` (thay lệnh kiểu cũ) ngoài nháy đơn — shlex không tách backtick nên lệnh bên trong từng lọt."""
    return [body for _, _, body in _backtick_spans(cmd)]


def _backtick_spans(cmd: str) -> List[Span]:
    out: List[Span] = []
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
                out.append((start - 1, i + 1, cmd[start:i]))
                start = -1
        i += 1
    return out


def _dollar_scripts(cmd: str) -> List[str]:
    """Thân `$(…)` ngoài nháy đơn — kể cả trong nháy kép (`git commit -m "$(rm -rf ~)"`), nơi shlex coi là chữ; bỏ
    `$((…))` (số học)."""
    return [body for _, _, body in _dollar_spans(cmd)]


def _dollar_spans(cmd: str) -> List[Span]:
    out: List[Span] = []
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
            out.append((i, j, cmd[i + 2 : j - 1]))
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


def _cat_heredoc_bodies(script: str) -> List[str]:
    """`bash -c "$(cat <<'E'` ↵ … ↵ `E` ↵ `)"`, `eval "$(cat <<E …)"`: chuỗi lệnh là thân heredoc mà `cat` in ra."""
    out: List[str] = []
    for inner in _dollar_scripts(script):
        for opener, m, body in _heredocs(inner):
            if normalize(tokenize(opener[: m.start()]))[:1] == ["cat"]:
                out.append("\n".join(body))
    return out


Placed = List[Tuple[str, Optional[str]]]  # (script, thư mục nó chạy; None = không biết — D-106)
PlacedCmds = List[Tuple[List[str], Optional[str]]]  # kết quả `_commands_with_cwd`
SPAN_MARK = "$__xt_span_{}_"  # có `$`: `cd "$(…)"` thành đích không biết
SPAN_MARK_RE = re.compile(r"\$__xt_span_(\d+)_")


def _nested_pairs(cmd: str, tokens: List[str], placed: PlacedCmds, start: Optional[str]) -> Placed:
    """Lệnh chạy lồng (AUD-SEC-017) kèm thư mục nó chạy (AUD-SEC-094): `sh -c '…'`, `eval '…'`, backtick, `$(…)`,
    `$(cat <<E …)`, `<( )`, thân heredoc mở rộng, `echo/printf '…' | sh`, here-string/heredoc vào shell."""
    moved = any(here != start for _, here in placed)
    out: Placed = [(s, here) for c, here in placed for s in [_shell_c_script(c)] if s]
    out += [(s, here) for c, here in placed for s in _eval_scripts(c)]
    out += _span_pairs(strip_heredocs(literal_bodies_masked(cmd)), _backtick_spans, start, moved)
    out += _span_pairs(strip_heredocs(cmd), _dollar_spans, start, moved)
    out += [(b, here) for sc, here in list(out) for b in _cat_heredoc_bodies(sc)]
    out += _procsub_scripts(tokens, _token_dirs(tokens, placed))
    visited = list(dict.fromkeys([start, *(here for _, here in placed)]))
    bodies = [s for body in _expanded_heredocs(cmd) for s in _dollar_scripts(body) + _backtick_scripts(body)]
    out += [(s, d) for s in bodies for d in visited]  # thân heredoc mở rộng: thư mục mọi lệnh (chiều chặt)
    out += _shell_feeds(tokens, placed)
    out += [(s, here) for c, here in placed for s in _here_strings(c)]
    shells = dict.fromkeys([start, *(here for c, here in placed if _stdin_shell(c))])
    return out + [(body, d) for body in _heredoc_scripts(cmd) for d in shells]


def _span_pairs(text: str, finder: Callable[[str], List[Span]], start: Optional[str], moved: bool) -> Placed:
    """Thân thay lệnh (`finder` = `_dollar_spans`/`_backtick_spans`) kèm thư mục lệnh chứa nó; không lệnh nào dời thư
    mục → mọi thân ở `start`."""
    spans = finder(text)
    dirs = _span_dirs(text, spans, start) if moved and spans else [start] * len(spans)
    return [(body, d) for (_, _, body), d in zip(spans, dirs)]


def _span_dirs(text: str, spans: List[Span], start: Optional[str]) -> List[Optional[str]]:
    """Thư mục của lệnh chứa mỗi thay lệnh trong `text`: thay span thứ K bằng dấu `$__xt_span_K_`, tách lệnh, đọc dấu
    trong argv của `_commands_with_cwd` (`cd .claude && echo "$(…)"` chạy trong `.claude`). Không thấy dấu (span trong
    comment) → `start`."""
    parts: List[str] = []
    pos = 0
    for k, (a, b, _) in enumerate(spans):
        parts += [text[pos:a], SPAN_MARK.format(k)]
        pos = b
    found: Dict[int, Optional[str]] = {}
    for c, here in _commands_with_cwd(tokenize("".join(parts) + text[pos:]), start):
        for m in SPAN_MARK_RE.finditer(" ".join(c)):
            found.setdefault(int(m[1]), here)
    return [found.get(k, start) for k in range(len(spans))]


def _token_dirs(tokens: List[str], placed: PlacedCmds) -> List[Optional[str]]:
    """Thư mục của lệnh chứa từng token (`placed` = `_commands_with_cwd(tokens, …)`); token tách lệnh mang thư mục
    của lệnh trước nó (None khi chưa có lệnh)."""
    out: List[Optional[str]] = []
    k, fresh = -1, True
    for t in tokens:
        sep = _is_punct(t) and not _is_redirect(t)
        if not sep and fresh:
            k += 1
        fresh = sep
        out.append(placed[k][1] if k >= 0 else None)
    return out


def _shell_feeds(tokens: List[str], placed: PlacedCmds) -> Placed:
    """Chữ đi qua ống vào shell (`echo '…' | tee /dev/null | sh`, `… | xargs sh -c`) kèm thư mục của shell nhận."""
    out: Placed = []
    dirs = [here for _, here in placed]
    i = 0
    for pipe in pipelines(tokens):
        for feed, down, here in zip(_pipe_feeds(pipe), pipe[1:], dirs[i + 1 :]):
            if feed and (_stdin_shell(down) or _argless_shell_c(down)):
                out += [(s, here) for s in feed]
        i += len(pipe)
    return out


# Lệnh chuyển nguyên stdin ra stdout (khi không có file đầu vào): chữ echo đi qua vẫn là chữ đó (`echo … | tee x | sh`).
# Giá trị: cờ ăn thêm một token. `head`/`tail` cắt bớt dòng — quét cả chữ là chiều chặt.
PIPE_FILTERS: Dict[str, Tuple[str, ...]] = {
    "cat": (),
    "head": ("-n", "-c", "--lines", "--bytes"),
    "tail": ("-n", "-c", "--lines", "--bytes"),
}


def _pipe_feed(stage: List[str], prev: Optional[List[str]]) -> Optional[List[str]]:
    """Chữ (script) ra khỏi một khâu của ống: echo/printf → chữ của nó; heredoc → [] (thân đã quét ở `_heredoc_scripts`);
    here-string vào bộ lọc → chữ đó; `tee`/bộ lọc không file → chữ vào; khâu khác → None (guard không biết)."""
    n = normalize(stage)
    if n[:1] in (["echo"], ["printf"]):
        return _echoed_scripts(n)
    if "<<" in stage:
        return []
    if n[:1] == ["tee"]:
        return prev
    if not n or n[0] not in PIPE_FILTERS:
        return None
    if "<<<" in n[:-1]:
        return [n[n.index("<<<") + 1]]
    return prev if all(p == "-" for p in _positionals(n[1:], PIPE_FILTERS[n[0]])) else None


def _pipe_feeds(pipe: List[List[str]]) -> List[Optional[List[str]]]:
    """Chữ ra khỏi từng khâu của một ống (T-1523: `echo 'rm -rf ~' | tee /dev/null | bash` từng lọt)."""
    feeds: List[Optional[List[str]]] = []
    prev: Optional[List[str]] = None
    for stage in pipe:
        prev = _pipe_feed(stage, prev)
        feeds.append(prev)
    return feeds


def _argless_shell_c(argv: List[str]) -> bool:
    """`sh -c` không kèm chuỗi lệnh — lệnh đến từ đối số xargs nối thêm (`… | xargs -0 bash -c`)."""
    n = normalize(argv)
    return bool(n) and n[0] in SHELLS and _shell_script_arg(n) == (True, None)


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


# `git push` mà guard không biết đích (T-1523): push là hành động không đảo ngược ở nhánh chính, nên đích không giải được
# → chặn có mã unsure (REC-04), không đoán "không phải main".
UNRESOLVED_PUSH_WHY = "guard không biết đích của push"
SUBST_MARK = "xt-unresolved-subst"  # thay cho `$(…)`/backtick guard không tính được giá trị
SUBST_PLAIN_RE = re.compile(r"[\w./@:+^~-]+(?:[ \t\n]+[\w./@:+^~-]+)*")
# Thay lệnh trả nhánh hiện tại = `HEAD` của push (luật refspec tra nhánh thật ở thư mục repo).
CURRENT_BRANCH_QUERIES = {
    ("git", "branch", "--show-current"),
    ("git", "rev-parse", "--abbrev-ref", "HEAD"),
    ("git", "symbolic-ref", "--short", "HEAD"),
    ("git", "symbolic-ref", "--short", "-q", "HEAD"),
    ("git", "symbolic-ref", "-q", "--short", "HEAD"),
}


def _xargs_wrapped(argv: List[str]) -> bool:
    """Lệnh chạy qua `xargs` (đối số nối thêm từ stdin, guard không thấy)."""
    head = argv[: len(argv) - len(_strip_prefixes(argv))]
    return any(posixpath.basename(t) == "xargs" for t in head)


def _subst_words(body: str) -> List[str]:
    """Giá trị thay cho một `$(…)`: echo/printf chữ thường → chữ đó; truy vấn nhánh hiện tại → `HEAD`; còn lại → dấu
    không biết."""
    words = tokenize(body)
    n = normalize(words)
    if any(_is_punct(w) for w in words) or "$" in body or "`" in body:
        return [SUBST_MARK]
    if tuple(n) in CURRENT_BRANCH_QUERIES:
        return ["HEAD"]
    vals = _echoed_scripts(n)[:LIFT_PICKS] if n[:1] in (["echo"], ["printf"]) and n[1:] else []
    return vals if vals and all(SUBST_PLAIN_RE.fullmatch(v) for v in vals) else [SUBST_MARK]


def _subst_variants(base: str) -> List[str]:
    """Dòng lệnh với mỗi thay lệnh ngoài cùng đổi thành giá trị của nó (`_subst_words`) — tối đa LIFT_PICKS² bản."""
    spans = sorted(_dollar_spans(base) + _backtick_spans(base))
    outer = [sp for k, sp in enumerate(spans) if not any(o[0] <= sp[0] and sp[1] <= o[1] for o in spans[:k])]
    variants = [base]
    for start, end, body in reversed(outer):
        vals = _subst_words(body)
        variants = [v[:start] + val + v[end:] for v in variants for val in vals][: LIFT_PICKS * LIFT_PICKS]
    return variants if outer else []


def _push_subst_rule(cmd: str, root: str, cwd: str) -> Tuple[str, List[str]]:
    """`git push origin $(echo main)`: luật push trên bản đã thay giá trị; đích là thay lệnh không tính được → hỏi
    (unsure → chặn). Trả (lý do deny, câu hỏi)."""
    base = strip_heredocs(cmd)
    variants = _subst_variants(base) if "push" in base else []
    seen = {tuple(a) for a, _ in _commands_with_cwd(tokenize(base), cwd)} if variants else set()
    asks: List[str] = []
    for argv, here in (c for v in variants for c in _commands_with_cwd(tokenize(v), cwd)):
        n = normalize(argv)
        if n[:2] != ["git", "push"] or tuple(argv) in seen:
            continue
        if any(SUBST_MARK in r for r in _positionals(n[2:], PUSH_VALUE_OPTS)[1:]):
            asks.append(f"{UNRESOLVED_PUSH_WHY} (đích là thay lệnh): {' '.join(argv)[:200]}")
            continue
        d, why = git_rules(n, _git_dir(argv, here) or root)
        if d == "deny":
            return f"Lệnh bị khung chặn ({why}, giá trị của thay lệnh): {' '.join(argv)[:300]}", asks
        asks += [f"{why} (giá trị của thay lệnh): {' '.join(argv)[:200]}"] if d else []
    return "", asks


VAR_USE_RE = re.compile(r"\$[\w{@*#?!$-]")  # dùng biến/tham số (`$B`, `${B}`, `$1`, `$@`); `$` đứng riêng là chữ


def _known_vars(text: str, env: Dict[str, str]) -> str:
    """Thay CHỈ biến đã gán chữ trong cùng lệnh; biến lạ (`$B` từ `read`/môi trường, `${B:-x}` khi B chưa gán) giữ nguyên."""
    text = VAR_DEFAULT_RE.sub(lambda m: env.get(m.group(1), m.group(0)), text)
    return VAR_REF_RE.sub(lambda m: env.get(m.group(1) or m.group(2), m.group(0)), text)


def _push_var_refspec(n: List[str], env: Dict[str, str], gdir: str) -> Tuple[str, List[str]]:
    """Một `git push` có refspec chứa biến: giải bằng gán chữ đã thấy rồi áp luật push; không giải được → hỏi (unsure).
    Giá trị không nháy có thể tách nhiều từ (`B='feat main'`) → mỗi từ là một refspec."""
    for r in (r for r in _positionals(n[2:], PUSH_VALUE_OPTS)[1:] if VAR_USE_RE.search(r)):
        val = _known_vars(r, env)
        if VAR_USE_RE.search(val) or SUBST_MARK in val or not val.split():
            return "", [f"{UNRESOLVED_PUSH_WHY} (đích là biến không giải được): {' '.join(n)[:200]}"]
        d, why = git_rules([w for t in n for w in (val.split() if t == r else [t])], gdir)
        if d == "deny":
            return f"Lệnh bị khung chặn ({why}, giá trị của biến): {' '.join(n)[:300]}", []
        if d:
            return "", [f"{why} (giá trị của biến): {' '.join(n)[:200]}"]
    return "", []


def _push_var_rule(cmd: str, root: str, cwd: str) -> Tuple[str, List[str]]:
    """`B=$(cat f); git push origin $B`, `read B; git push origin "$B"`: đích là biến (T-1524). Thay lệnh được thay giá trị
    trước (`$(git branch --show-current)` → HEAD, không tính được → dấu không biết), rồi theo dõi gán chữ từng lệnh."""
    base = strip_heredocs(cmd)
    if "push" not in base or "$" not in base:
        return "", []
    asks: List[str] = []
    for variant in _subst_variants(base) or [base]:
        env: Dict[str, str] = {}
        for argv, here in _commands_with_cwd(tokenize(variant), cwd):
            n = normalize(argv)
            if n[:2] == ["git", "push"]:
                deny, more = _push_var_refspec(n, env, _git_dir(argv, here) or root)
                if deny:
                    return deny, asks
                asks += more
            _record_assigns(argv, env)
    return "", asks


def _unresolved_push(cmd: str, tokens: List[str], root: str, cwd: str) -> Tuple[str, List[str]]:
    """`… | xargs git push …` (đích nối thêm từ stdin), `git push … $(…)` và `git push origin $B`: (lý do deny, câu hỏi)."""
    asks = [
        f"{UNRESOLVED_PUSH_WHY} (đối số nối thêm từ xargs): {' '.join(c)[:200]}"
        for c in split_commands(tokens)
        if normalize(c)[:2] == ["git", "push"] and _xargs_wrapped(c)
    ]
    deny, more = _push_subst_rule(cmd, root, cwd)
    var_deny, var_asks = ("", []) if deny else _push_var_rule(cmd, root, cwd)
    return deny or var_deny, asks + more + var_asks


def _join_tokens(words: List[str]) -> str:
    """Ghép argv lại thành dòng lệnh: token dấu câu (chuyển hướng `>`, `<`…) để trần, từ khác được trích nháy."""
    return " ".join(t if _is_punct(t) else shlex.quote(t) for t in words)


ASSIGN_ANY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*", re.S)  # giá trị có thể nhiều dòng (`x='bash <<E …'`)
VAR_REF_RE = re.compile(r"\$(\w+)|\$\{(\w+)\}")
VAR_DEFAULT_RE = re.compile(r"\$\{(\w+):?[-=]([^{}$`]*)\}")  # `${y:-rm}`, `${y=rm}`: chưa gán thì lấy giá trị mặc định


def _sub_vars(text: str, env: Dict[str, str]) -> str:
    text = VAR_DEFAULT_RE.sub(lambda m: env.get(m.group(1), m.group(2)), text)
    return VAR_REF_RE.sub(lambda m: env.get(m.group(1) or m.group(2), m.group(0)), text)


VAR_VALUE_MAX = 4096  # giá trị biến dài hơn không được ghi nhận (chặn nhân đôi `a="$a$a"`)
VAR_FOR_PICKS = 64  # số từ KHÁC NHAU tối đa của `for x in …` được thử làm giá trị của x (nhiều hơn → chặn)
# D-098: vòng `for` mà MỌI giá trị là số nguyên thuần (`for i in {1..100}`, `for i in 1 2 3`) không theo trần trên — số
# không tạo tên lệnh/đường dẫn/nhánh nguy hiểm khác nhau giữa các lần lặp, nên thử một mẫu đại diện (đầu, cuối, giữa
# cách đều) là đủ. Trần tổng an toàn: hơn `BRACE_SEQ_MAX` giá trị → không lấy mẫu, theo trần `VAR_FOR_PICKS` (chặn).
FOR_NUM_SAMPLE = 8
FOR_NUM_RE = re.compile(r"-?[0-9]+")


def _record_assigns(c: List[str], env: Dict[str, str], pick: int = 0) -> None:
    """`x='…'`, `export x=…`: gán đứng riêng (không kèm lệnh) có hiệu lực cho các lệnh sau; `for x in a b`: x lấy từ thứ
    `pick` của danh sách."""
    c = [t for t in c if t not in SHELL_KEYWORDS] if c[0] in SHELL_KEYWORDS else c  # `then x=…`, `do x=…`, `{ x=…`
    words = _for_values(c)
    if words:
        env[c[1]] = _sub_vars(words[min(pick, len(words) - 1)], env)[:VAR_VALUE_MAX]
        return
    words = c[1:] if c[:1] and c[0] in DECLARE_CMDS else c
    if words and all(ASSIGN_ANY_RE.fullmatch(t) for t in words):
        for t in words:
            k, _, v = t.partition("=")
            val = _sub_vars(v, env)
            if len(val) <= VAR_VALUE_MAX:
                env[k] = val


def _for_values(c: List[str]) -> List[str]:
    """Giá trị cần thử cho biến của `for x in a b c` (đã bỏ từ khoá đầu dòng; rỗng nếu không phải vòng for): từ khác
    nhau theo thứ tự (từ trùng chỉ thử một lần — `for x in a a … a rm`); toàn số nguyên thuần và không quá
    `BRACE_SEQ_MAX` giá trị → mẫu đại diện `FOR_NUM_SAMPLE` giá trị gồm đầu, cuối và giữa cách đều (D-098)."""
    if not (c[:1] == ["for"] and len(c) > 3 and c[2] == "in"):
        return []
    words = list(dict.fromkeys(c[3:]))
    n = len(words)
    if n <= FOR_NUM_SAMPLE or n > BRACE_SEQ_MAX or not all(FOR_NUM_RE.fullmatch(w) for w in words):
        return words
    return list(dict.fromkeys(words[(n - 1) * k // (FOR_NUM_SAMPLE - 1)] for k in range(FOR_NUM_SAMPLE)))


def _for_words(c: List[str]) -> int:
    """Số giá trị guard phải thử cho `for x in a b c` (0 nếu không phải vòng for) — xem `_for_values`."""
    c = [t for t in c if t not in SHELL_KEYWORDS] if c[:1] and c[0] in SHELL_KEYWORDS else c
    return len(_for_values(c))


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
        sub = _sub_vars(t, env) if env or "${" in t else t
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


# Gán từ nguồn guard tính được giá trị: `x=$(echo '…')`, `x="$(printf '…')"`, `` x=`echo …` ``, `read [-r] x <<< '…'`.
SUBST_ASSIGN_RE = re.compile(r"(?<![\w$])([A-Za-z_]\w*)=(\"?)(?:\$\(|`)[ \t]*(echo|printf)[ \t]([^()`\n]*)[)`]\2")
READ_HERE_RE = re.compile(
    r"(?<![\w$-])read((?:[ \t]+-[A-Za-z]+)*)((?:[ \t]+[A-Za-z_]\w*)+)[ \t]*<<<[ \t]*('[^'\n]*'|\"[^\"\n]*\"|[^\s;&|<>]+)"
)
LIFT_PICKS = 4  # số giá trị thử cho một gán từ `printf '%s…' a b` (định dạng và từng đối số)


def _subst_values(m: "re.Match[str]") -> List[str]:
    try:
        words = shlex.split(m.group(4))
    except ValueError:
        return []
    return _echoed_scripts([m.group(3), *words])[:LIFT_PICKS] if words else []


def _read_assign(m: "re.Match[str]") -> str:
    names = m.group(2).split()
    try:
        word = (shlex.split(m.group(3)) or [""])[0]
    except ValueError:
        return m.group(0)
    parts = word.split(None, len(names) - 1) if len(names) > 1 else [word]
    vals = parts + [""] * (len(names) - len(parts))
    return " ".join(f"{k}={shlex.quote(v)}" for k, v in zip(names, vals))


def _lifted_scripts(cmd: str) -> List[str]:
    """Dòng lệnh với gán từ thay lệnh `echo`/`printf` và từ `read … <<< '…'` đổi thành gán chữ nguyên văn — rồi quét lại
    (`_var_scripts` thay biến): `x=$(echo 'rm -rf ~'); $x`, `read x <<< 'rm -rf ~'; eval "$x"` (KNOWN_GAPS 3.4.0)."""
    base = strip_heredocs(cmd)
    text = READ_HERE_RE.sub(_read_assign, base)
    variants = [text]
    for m in list(SUBST_ASSIGN_RE.finditer(text))[:LIFT_PICKS]:
        vals = _subst_values(m)  # rỗng (shlex lỗi): giữ nguyên gán, không đoán
        variants = [v.replace(m.group(0), f"{m.group(1)}={shlex.quote(val)}", 1) for v in variants for val in vals][
            : LIFT_PICKS * LIFT_PICKS
        ] or variants
    return [v for v in dict.fromkeys(variants) if v != base]


# Bộ giải mã: lệnh đã mã hoá đi qua nó rồi vào shell (`echo cm0g… | base64 -d | sh`). Giải được từ chữ (echo/printf) thì
# quét lệnh thật; không thì shell chạy thứ guard không đọc được — chặn.
DECODE_FLAGS = {"base64": {"-d", "--decode", "-D"}, "basenc": {"-d", "--decode"}, "xxd": {"-r", "-rp", "-pr"}}
DECOMPRESSORS = {"gunzip", "zcat", "bzcat", "xzcat", "unxz", "bunzip2", "zstdcat", "unzstd"}
DECOMPRESS_FLAGS = {"gzip", "bzip2", "xz", "zstd", "lzma", "lz4"}
OPAQUE_EXEC_WHY = "shell chạy lệnh đã mã hoá/nén (`{}`) — guard không đọc được lệnh thật"


def _decoder(argv: List[str]) -> str:
    """Tên bộ giải mã nếu `argv` giải mã/giải nén stdin: `base64 -d`, `xxd -r -p`, `openssl base64 -d`, `rev`, `gzip -d`…"""
    n = normalize(argv)
    if not n:
        return ""
    name, args = n[0], n[1:]
    flags = {f for a in args if a.startswith("-") for f in ([a] + [f"-{c}" for c in a[1:]] if a[1:2] != "-" else [a])}
    if name in DECODE_FLAGS and flags & DECODE_FLAGS[name]:
        return name
    if name == "openssl" and "-d" in flags and args[:1] in (["base64"], ["enc"]):
        return name
    if name == "rev" or name in DECOMPRESSORS or (name in DECOMPRESS_FLAGS and flags & {"-d", "--decompress"}):
        return name
    return ""


def _decode(name: str, data: str) -> Optional[str]:
    """Giải chữ `data` như bộ giải mã `name`; None nếu không giải được trong guard (nén, sai định dạng)."""
    try:
        if name in ("base64", "basenc", "openssl"):
            return base64.b64decode("".join(data.split()), validate=True).decode()
        if name == "xxd":
            return bytes.fromhex("".join(data.split())).decode()
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    if name == "rev":
        return "\n".join(line[::-1] for line in data.split("\n"))
    return None


def _decoded_feed(pipe: List[List[str]], i: int) -> Tuple[List[str], Optional[str]]:
    """(chuỗi bộ giải mã, lệnh giải được) của ống vào shell ở khâu `i` (`echo cm0g… | base64 -d | sh`); khâu không phải
    shell sau bộ giải mã → ([], None); nguồn không phải echo/printf chữ → (chuỗi, None)."""
    if i == 0 or not _stdin_shell(pipe[i]):
        return [], None
    j = i - 1
    chain: List[str] = []
    while j >= 0 and _decoder(pipe[j]):
        chain.insert(0, _decoder(pipe[j]))
        j -= 1
    src = normalize(pipe[j]) if j >= 0 else []
    text: Optional[str] = _echoed_scripts(src)[0] if chain and src[:1] in (["echo"], ["printf"]) else None
    for name in chain:
        text = _decode(name, text) if text is not None else None
    return chain, text


def _decoded_pipes(tokens: List[str], dirs: List[Optional[str]]) -> Tuple[Placed, List[str]]:
    """(lệnh giải được kèm thư mục shell nhận — `dirs` theo từng lệnh, câu hỏi chặn) cho mỗi ống `… | <giải mã>… |
    sh`: nguồn là echo/printf chữ → giải và quét."""
    scripts: Placed = []
    asks: List[str] = []
    i = 0
    for pipe in pipelines(tokens):
        for k in range(len(pipe)):
            chain, text = _decoded_feed(pipe, k)
            if text is not None:
                scripts.append((text, dirs[i + k]))
            elif chain:
                asks.append(OPAQUE_EXEC_WHY.format(" | ".join(chain)))
        i += len(pipe)
    return scripts, asks


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


def _procsub_scripts(tokens: List[str], dirs: List[Optional[str]]) -> Placed:
    """`sh <(echo '…')`, `source <(printf '…')`, `bash < <(echo '…')`: shell đọc script do lệnh trong `<( )` sinh ra —
    kèm thư mục của shell (`dirs` theo từng token, `_token_dirs`)."""
    out: Placed = []
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
            out += [(s, dirs[j]) for s in _echoed_scripts(inner)]
    return out


def _opaque_shells(tokens: List[str]) -> List[str]:
    """Shell chạy lệnh guard không đọc được (AUD-SEC-028): ống từ nguồn khác echo/printf/heredoc vào shell
    (`… | tee /dev/null | bash`, `cat run.sh | bash`), `bash -c` không kèm chuỗi lệnh (`xargs bash -c`)."""
    asks: List[str] = []
    for pipe in pipelines(tokens):
        for feed, up, down in zip(_pipe_feeds(pipe), pipe, pipe[1:]):
            if _stdin_shell(down) and feed is None:
                asks.append(f"shell đọc lệnh từ ống `{' '.join(up)[:80]}` — guard không thấy lệnh sẽ chạy")
    for c in split_commands(tokens):
        if _argless_shell_c(c):
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
        return [f"{NEST_ASK} — guard không quét hết lệnh trong container"]
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
            asks.append(f"{NEST_ASK} — guard không quét hết")
            break
        if not deeper and rewrites >= MAX_REWRITE:  # chỉ HỎI thì chính sách mặc định cho qua (reviewer #136)
            return "Lệnh quá phức tạp để guard quét hết (lệnh bọc/thay biến lồng quá sâu): chia nhỏ lệnh."
        if (script, cwd) in budget.seen:
            continue
        if not deeper and len(script) > REWRITE_MAX_CHARS:
            return f"Lệnh quá phức tạp để guard quét hết (bản thay biến dài {len(script)} ký tự): chia nhỏ lệnh."
        budget.seen.add((script, cwd))
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
    if max([0, *(_for_words(c) for c in split_commands(tokens))]) > VAR_FOR_PICKS:
        return f"Lệnh quá phức tạp để guard quét hết (vòng `for` hơn {VAR_FOR_PICKS} giá trị khác nhau): chia nhỏ lệnh."
    asks += _opaque_shells(tokens) + _xargs_evidence(tokens)
    push_deny, push_asks = _unresolved_push(cmd, tokens, root, cwd or root)
    if push_deny:
        return push_deny
    asks += push_asks
    asks += _container_asks(_wrapped_scripts(tokens)[1], depth, budget)  # mọi lệnh, không cắt (review #82)
    rewritten, nested, opaque = _nested_sources(cmd, tokens, cwd)
    asks += opaque
    for here, (rw, ns) in _moved_groups(rewritten, nested, cwd).items():
        moved = _scan_scripts(rw, root, here, depth, asks, 0, budget, rewrites)
        moved = moved or _scan_scripts(ns, root, here, depth, asks, 1, budget)
        if moved:
            return moved
    return _scan_scripts([s for s, _ in rewritten], root, cwd, depth, asks, 0, budget, rewrites) or _scan_scripts(
        [s for s, _ in nested], root, cwd, depth, asks, 1, budget
    )


def _nested_sources(cmd: str, tokens: List[str], start: Optional[str]) -> Tuple[Placed, Placed, List[str]]:
    """MỘT danh sách nguồn lệnh lồng cho cả lượt quét ở thư mục ban đầu lẫn sau `cd`/`pushd`/`env -C` (AUD-SEC-087,
    AUD-SEC-094 — hai danh sách riêng từng lệch nhau): (bản viết lại cùng lệnh, lệnh lồng, câu hỏi chặn), mỗi script
    kèm thư mục nó chạy. Bản viết lại: thay biến/gán thay lệnh (cả dòng, gồm `cd`) và hậu tố lệnh bọc (`flock`,
    `script -qc`, `su -c`, `watch`…). Lệnh lồng: `_nested_pairs`, lệnh bọc trên máy (`uv run bash -c`), `os.system`
    trong script trình thông dịch, ống giải mã vào shell, ssh chạy tại máy này, magic ipython."""
    placed = _commands_with_cwd(tokens, start)
    rewritten: Placed = [(s, start) for s in _var_scripts(tokens)]
    rewritten += [(s, here) for c, here in placed for s in _runner_scripts(c)]
    rewritten += [(s, start) for s in _lifted_scripts(cmd)]
    decoded, opaque = _decoded_pipes(tokens, [here for _, here in placed])
    nested = _nested_pairs(cmd, tokens, placed, start)
    nested += [(s, here) for c, here in placed for s in _wrapped_scripts(c)[0]]
    nested += [(s, here) for raw, here in _interp_scripts_at(cmd, tokens, start) for s in _exec_api_scripts([raw])]
    nested += decoded + [(s, here) for c, here in placed for s in _ssh_local_scripts(c)]
    return rewritten, nested + _ipython_nested(cmd, tokens, start), opaque


def _moved_groups(
    rewritten: Placed, nested: Placed, start: Optional[str]
) -> Dict[Optional[str], Tuple[List[str], List[str]]]:
    """Script chạy ở thư mục khác `start`, nhóm theo thư mục: (bản viết lại, lệnh lồng). Thư mục không rõ (None) quét
    với cwd không biết — đích tương đối thử ở mọi thư mục canh (D-106). Mọi script còn được quét ở `start` (chiều chặt,
    như trước)."""
    out: Dict[Optional[str], Tuple[List[str], List[str]]] = {}
    for idx, pairs in enumerate((rewritten, nested)):
        for script, here in pairs:
            if here != start:
                out.setdefault(here, ([], []))[idx].append(script)
    return out


# --------------------------------------------------------------------------- rà stored 2026-10-16

# Tên biến thể (AUD-SEC-093): `python3.13t` (free-threaded), `python3.6m`, `nodejs` (Debian)
INTERP_RE = re.compile(r"(python|pypy|ipython|nodejs|node|perl|ruby|php|deno|bun|lua|tclsh)(?:[0-9.]+[dmt]?)?")
INTERP_SCRIPT_FLAGS = {"-c", "-e", "-E", "--eval", "-p", "--print", "-r"}
# Họ của trình thông dịch cùng ngôn ngữ (review #186 lần 3): pypy/ipython chạy Python — ipython còn có magic `!cmd`,
# `%…` mà `ast.parse` không nhận nên script có magic không bao giờ là chỉ đọc
INTERP_FAMILY = {"pypy": "python", "ipython": "python", "nodejs": "node"}
# Cờ ngắn theo họ (AUD-SEC-093) — (chữ nhận script, chữ ăn phần còn lại của token làm giá trị, chữ trong số đó ăn token
# kế khi không dính, chữ kết thúc phần cờ): `-Ic '…'`, `-c'…'` dính, `-nr`, `perl -lne'…'`, `node -p'…'`; `-m` của
# Python là module — phần sau không phải script.
INTERP_SHORT_OPTS: Dict[str, Tuple[str, str, str, str]] = {
    "python": ("c", "WXQ", "WXQ", "m"),
    "node": ("ep", "rC", "rC", ""),
    "bun": ("ep", "r", "r", ""),
    "perl": ("eE", "IMmiFxdDC", "", ""),
    "ruby": ("e", "IrCEFKWxT", "IrCE", ""),
    "php": ("rBRE", "cdfzF", "cdfzF", ""),
    "lua": ("e", "l", "l", ""),
}
INTERP_LONG_SCRIPT = {"--eval", "--print"}  # `node --eval='…'`, `--eval '…'`
INTERP_LONG_VALUE = {"--require", "--import", "--loader", "--experimental-loader", "--input-type", "--conditions"}
INTERP_LONG_VALUE |= {"--check-hash-based-pycs", "--title"}
# Lệnh chạy hộ trình thông dịch (AUD-SEC-093): `uv run [cờ] python -c …`, `conda run -n x python -c …`, `npx node -e …`
INTERP_RUNNERS = {
    *PKG_RUNNERS,
    *(("uv", "run"), ("poetry", "run"), ("pdm", "run"), ("pipenv", "run"), ("hatch", "run"), ("rye", "run")),
    *(("conda", "run"), ("mamba", "run"), ("micromamba", "run"), ("pixi", "run")),
    *(("pipx", "run"), ("uvx",), ("uv", "tool", "run")),
}
INTERP_RUNNER_DEPTH = (
    8  # số lớp chạy hộ lồng được bóc (`uv run npx node -e …`); sâu hơn → không coi là trình thông dịch
)
# Lệnh con nhận script làm đối số: `deno eval '…'` (review #186 lần 3)
INTERP_EVAL_SUBCMDS = {"deno": "eval"}
PERL_E_FLAG_RE = re.compile(r"-[a-zA-DF-Z]+[eE]")  # cờ gộp `-ne`, `-pe`, `-lne`: đối số kế tiếp là script
# Dấu hiệu script GHI/XOÁ file (đọc thì không hỏi): open(..., "w"), .write_text(, os.remove, shutil.*, fs.writeFileSync…
WRITE_HINT_RE = re.compile(
    r"open\([^)]*,\s*(?:mode\s*=\s*)?[rbt]?['\"][rbt]?[wax+]|\.(?:write_text|write_bytes|unlink|rmdir|rename|replace|touch)\("
    r"|\b(?:os\.(?:remove|unlink|rename|replace|truncate)|shutil\.\w+|writeFile\w*|appendFile\w*|rmSync|unlinkSync"
    r"|renameSync|copyFile\w*|File\.write|IO\.write|file_put_contents|unlink|rename|truncate)\b"
    r"|\bopen\b[^;\n]{0,200}['\"]\+?>"  # perl `open(F, '>', …)`, `open(F, ">f")` (trần độ dài: tuyến tính)
    r"|\b(?:py_compile|compileall|pycache_prefix)\b"  # trình biên dịch ghi bytecode (AUD-SEC-074)
    # AUD-SEC-089: luồng ghi, `os.open`, liên kết, đổi quyền, `Path(…).open('a')` (mode là đối số đầu)
    r"|\b(?:createWriteStream|openSync|os\.open)\b|\b(?:symlink|link|l?chmod|l?chown)(?:Sync)?\("
    r"|\.open\(\s*(?:mode\s*=\s*)?['\"][rbt]?[wax+]"
)
# Mọi dạng ghi mà `_direct_write`/`_alias_write` bắt được đều khớp regex này (test giữ): script không khớp thì không chuỗi
# nào là đích ghi trực tiếp — bỏ hẳn regex theo từng chuỗi (AUD-SEC-092).
WRITE_ANY_RE = re.compile(
    WRITE_HINT_RE.pattern + r"|\bcompile\w*\(|\btruncate\w*|\bO_(?:WRONLY|RDWR|APPEND|CREAT|TRUNC)\b"
)
DIRECT_PROBES = 64  # số chuỗi canh được dò API ghi mỗi script (mỗi chuỗi một regex quét cả script); hơn → coi như ghi
PERL_OPEN_MODE_RE = re.compile(r"^\+?(?:>>?|<)[ \t]*")
RMTREE_RE = re.compile(r"\b(?:rmtree|remove_tree|rm_rf|rmSync|rimraf)\b")  # xoá đệ quy trong script (AUD-SEC-068)
HOME_EXPR_RE = re.compile(
    r"expanduser\(\s*['\"]~/?['\"]\s*\)|Path\.home\(\)|environ\[\s*['\"]HOME['\"]|getenv\(\s*['\"]HOME['\"]|homedir\(\)"
)
STR_LITERAL_RE = re.compile(r"""['"]([^'"\s]{2,})['"]""")
GUARDED_KINDS = {"secret", "gate", "evidence", "capability"}


def _stdin_interp(argv: List[str]) -> bool:
    n = _interp_argv(argv)
    return bool(n) and bool(INTERP_RE.fullmatch(n[0])) and not _inline_scripts(n)


def _runner_cmd_index(rest: List[str]) -> Optional[int]:
    """Vị trí lệnh thật trong đối số của lệnh chạy hộ: tên trình thông dịch đầu tiên, hoặc từ đầu tiên không phải cờ
    và không phải giá trị ngay sau cờ (`conda run -n x python`, `uv run -n python`, `npm exec -- node`); không có → None."""
    after_flag = False
    for i, t in enumerate(rest):  # dò hết: trần 6 rồi 64 token đều né được bằng `--with x` lặp (review #187)
        if INTERP_RE.fullmatch(posixpath.basename(t)) or not (t.startswith("-") or after_flag):
            return i
        after_flag = t.startswith("-")
    return None


def _interp_argv(argv: List[str]) -> List[str]:
    """argv đã chuẩn hoá, bóc lệnh chạy hộ phía trước (`uv run --with x python -c …` → `python -c …`) — AUD-SEC-093."""
    n = normalize(argv)
    for _ in range(INTERP_RUNNER_DEPTH):
        k = next((len(p) for p in INTERP_RUNNERS if tuple(n[: len(p)]) == p), 0)
        j = _runner_cmd_index(n[k:]) if k else None
        if j is None:
            break
        n = normalize(n[k + j :])
    return n


def _short_opt(a: str, nxt: Optional[str], spec: Tuple[str, str, str, str]) -> Tuple[Optional[str], int, bool]:
    """(script, số token đã dùng, kết thúc phần cờ) của một cụm cờ ngắn (`-Ic`, `-c'…'` dính, `-W x`, `-mpip`)."""
    script, value, takes_next, stop = spec
    for k, ch in enumerate(a[1:], 2):
        rest = a[k:]
        if ch in stop:
            return None, 1, True
        if ch in script:
            return (rest, 1, False) if rest else (nxt, 2, False)
        if ch in value:
            return None, 1 if rest or ch not in takes_next else 2, False
    return None, 1, False


def _long_opt(a: str, nxt: Optional[str]) -> Tuple[Optional[str], int]:
    """(script, số token đã dùng) của một cờ dài: `--eval='…'`, `--eval '…'`, `--require mod`."""
    key, eq, val = a.partition("=")
    if key in INTERP_LONG_SCRIPT:
        return (val, 1) if eq else (nxt, 2)
    return None, 2 if not eq and key in INTERP_LONG_VALUE else 1


def _interp_opt_scripts(n: List[str]) -> List[str]:
    """Script trong phần cờ của trình thông dịch theo cú pháp từng họ (AUD-SEC-093): cờ gộp/dính `-Ic`, `-c"…"`,
    `-nr`, `-e'…'`, `--eval=…`. Dừng ở đối số đầu không phải cờ (file script), `-`, `--`, `-m`."""
    m = INTERP_RE.fullmatch(n[0]) if n else None
    spec = INTERP_SHORT_OPTS.get(INTERP_FAMILY.get(m[1], m[1])) if m else None
    out: List[str] = []
    i = 1
    while spec and i < len(n) and n[i][:1] == "-" and n[i] not in ("-", "--"):
        nxt = n[i + 1] if i + 1 < len(n) else None
        stop = False
        if n[i].startswith("--"):
            script, width = _long_opt(n[i], nxt)
        else:
            script, width, stop = _short_opt(n[i], nxt, spec)
        out += [script] if script is not None else []
        i = len(n) if stop else i + width
    return out


def _inline_scripts(n: List[str]) -> List[str]:
    """Script viết ngay trong argv trình thông dịch (đã chuẩn hoá): đối số sau cờ script ở bất kỳ đâu (chiều chặt), cờ
    gộp/dính theo họ, `deno eval '…'` (mọi đối số không phải cờ sau lệnh con — chặt: cả giá trị cờ)."""
    flags = [i for i, a in enumerate(n[:-1]) if a in INTERP_SCRIPT_FLAGS or PERL_E_FLAG_RE.fullmatch(a)]
    scripts = [n[i + 1] for i in flags]
    k = _eval_subcmd(n)
    scripts += [a for a in (n[k + 1 :] if k is not None else []) if a[:1] != "-"]
    return list(dict.fromkeys(scripts + _interp_opt_scripts(n)))


def _eval_subcmd(n: List[str]) -> Optional[int]:
    """Vị trí lệnh con nhận script (`deno [cờ…] eval '…'`) trong argv đã chuẩn hoá; không có → None."""
    m = INTERP_RE.fullmatch(n[0]) if n else None
    sub = INTERP_EVAL_SUBCMDS.get(m[1]) if m else None
    k = 1
    while sub and k < len(n) and n[k].startswith("-"):
        k += 1
    return k if sub and n[k : k + 1] == [sub] else None


def _interp_scripts_at(cmd: str, tokens: List[str], cwd: Optional[str]) -> List[Tuple[str, Optional[str]]]:
    """(script, thư mục nó chạy) — `cd .claude && python3 -c '…'` chạy trong `.claude` (AUD-SEC-085). Thân heredoc gắn
    với thư mục của mọi lệnh trình thông dịch đọc stdin trong lệnh (không có thì `cwd`). Script qua stdin bằng
    here-string (`python3 <<< '…'`) hay ống (`echo '…' | node`) cũng tính (D-105)."""
    out: List[Tuple[str, Optional[str]]] = []
    stdin_dirs: List[Optional[str]] = []
    placed = _commands_with_cwd(tokens, cwd)
    for c, here in placed:
        n = _interp_argv(c)  # cả sau lệnh chạy hộ (`uv run python -c …` — AUD-SEC-093)
        if n and INTERP_RE.fullmatch(n[0]):
            out += [(s, here) for s in _inline_scripts(n)]
        if _stdin_interp(c):
            stdin_dirs.append(here)
            out += [(c[i + 1], here) for i, a in enumerate(c[:-1]) if a == "<<<"]
    i = 0
    for pipe in pipelines(tokens):
        for feed, down, here in zip(_pipe_feeds(pipe), pipe[1:], [d for _, d in placed][i + 1 :]):
            out += [(s, here) for s in feed or [] if _stdin_interp(down)]
        i += len(pipe)
    dirs = list(dict.fromkeys(stdin_dirs)) or [cwd]
    return out + [(body, d) for body in _heredoc_scripts(cmd, _stdin_interp) for d in dirs]


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


def _nfkc(script: str) -> str:
    """Script chuẩn hoá NFKC trước khi che, quét lời gọi và trích literal (review #186 lần 3): Python chuẩn hoá định
    danh theo NFKC (PEP 3131) nên `os.ｒemove`, `Path(…).ｗrite_text` toàn-rộng là lời gọi ghi thật."""
    return unicodedata.normalize("NFKC", script)


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
    for script in map(_nfkc, scripts):
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


# ipython (review #186 lần 3, phần E): magic chạy shell — `!cmd`, `!!cmd`, `%sx cmd`, `%system cmd` (đầu dòng, sau thụt
# lề, hoặc vế phải phép gán `x = !cmd`) và ô `%%bash`/`%%sh`/`%%script <shell>` (thân ô là phần còn lại của script).
IPY_LINE_SHELL_RE = re.compile(r"(?:^|=)[ \t]*(?:!!?|%(?:sx|system)(?![\w.]))[ \t]*([^\n]*)", re.M)
IPY_CELL_SHELL_RE = re.compile(
    r"^[ \t]*%%(?:bash|sh|script[ \t]+(?:\S*/)?(?:ba|da|k|z)?sh)(?![\w.])[^\n]*\n(.*)", re.M | re.S
)
IPY_MAGIC_LINE_RE = re.compile(r"(?:^|=)[ \t]*(%[^\n]*)", re.M)  # mọi dòng magic `%…`/`%%…` (cả lạ)


def _has_ipython(tokens: List[str]) -> bool:
    """Lệnh có chạy ipython (script trong lệnh có thể chứa magic)."""
    found = (INTERP_RE.fullmatch(n[0]) for n in map(_interp_argv, split_commands(tokens)) if n)
    return any(m and m[1] == "ipython" for m in found)


def _ipython_shell_scripts(script: str) -> List[str]:
    """Lệnh shell mà magic của ipython chạy, để quét bằng chính bộ quét lệnh như `sh -c`."""
    script = _nfkc(script)
    out = [m[1] for m in IPY_LINE_SHELL_RE.finditer(script) if m[1].strip()]
    return out + [m[1] for m in IPY_CELL_SHELL_RE.finditer(script) if m[1].strip()]


def _ipython_magic_words(script: str) -> List[str]:
    """Từ trên các dòng magic `%…` (magic lạ như `%%writefile .env`, `%store x > f` không phân tích chắc được): là ứng
    viên đường dẫn; script có magic không qua `ast.parse` nên không bao giờ chỉ đọc → nhắc đường dẫn canh là chặn."""
    return [w for m in IPY_MAGIC_LINE_RE.finditer(_nfkc(script)) for w in _split_words(m[1])]


def _ipython_nested(cmd: str, tokens: List[str], start: Optional[str]) -> List[Tuple[str, Optional[str]]]:
    """(lệnh shell từ magic, thư mục chạy) của mọi script trình thông dịch trong lệnh có ipython."""
    if not _has_ipython(tokens):
        return []
    return [
        (s, here) for script, here in _interp_scripts_at(cmd, tokens, start) for s in _ipython_shell_scripts(script)
    ]


def interp_write_asks(cmd: str, tokens: List[str], root: str, cwd: Optional[str] = None) -> List[str]:
    """Script trình thông dịch ghi/xoá file bí mật/cổng/bằng chứng/năng lực agent → hỏi, như Edit/chuyển hướng
    (LOOP-STOP-025: bị chặn ở Edit thì không đổi sang `python -c` để lách). Phân tích tĩnh, chỉ chữ nguyên văn; đích
    tương đối tính từ thư mục lệnh đang đứng (`cwd`, `cd` trước đó — AUD-SEC-085), như đường shell."""
    asks: List[str] = []
    families = _interp_families(tokens, cwd or root)
    ipython = _has_ipython(tokens)
    for raw_script, here in _interp_scripts_at(cmd, tokens, cwd or root):
        script = _nfkc(raw_script)  # `os.ｒemove` là `os.remove` với Python (định danh chuẩn hoá NFKC, PEP 3131)
        asks += [
            f"xoá đệ quy ngoài thư mục dự án ({lit} — script trình thông dịch)"
            for lit in (STR_LITERAL_RE.findall(script) if RMTREE_RE.search(script) else [])
            if lit[:1] in ("/", "~", "$") and _outside_project(lit, root, None)
        ]  # AUD-SEC-068: `shutil.rmtree("/home/x")`, perl `rmtree(...)`
        if RMTREE_RE.search(script) and HOME_EXPR_RE.search(script):  # `rmtree(Path.home())`, `expanduser("~")`
            asks.append("xoá đệ quy ngoài thư mục dự án (thư mục home — script trình thông dịch)")
        hint, ro, probe = bool(WRITE_HINT_RE.search(script)), _ReadOnly(script, families), _WriteProbe(script)
        asks += [
            a
            for raw in _script_literals(script, families) + (_ipython_magic_words(script) if ipython else [])
            if (a := _interp_literal_ask(script, raw, root, here, hint, ro, probe))
        ]
    return asks


def _script_literals(script: str, families: Optional[FrozenSet[str]] = None) -> List[str]:
    """Chuỗi nguyên văn không khoảng trắng trong script (ứng viên đường dẫn): cả chuỗi lồng trong chuỗi (f-string
    `f'{open(".env","w")}'`, nội suy Ruby `"#{File.delete('.env')}"`) — một tầng; chuỗi giữa hai nháy bất kỳ (chồng
    lấn: f-string cùng nháy `f"{open(".env","w")}"` của 3.12+ cả khi guard chạy 3.11). Script là Python (cách xác định
    như `_read_only_script`) và `ast.parse` qua → thêm mọi hằng str/bytes của AST, gồm phần hằng của f-string, escape
    đã giải (`'\\x2eenv'` → `.env`) — review #186 lần 3. Lấy hợp, không thay thế."""
    out = dict.fromkeys(STR_LITERAL_RE.findall(script))
    out.update(dict.fromkeys(STR_OVERLAP_RE.findall(script)))
    for m in LITERAL_RE.finditer(script):
        v = m.group(m.lastindex or 0)
        for x in [v, *(n.group(n.lastindex or 0) for n in LITERAL_RE.finditer(v))]:
            if len(x) >= 2 and not any(ch.isspace() for ch in x):
                out[x] = None
    if not families or families == frozenset({"python"}):
        out.update(dict.fromkeys(_ast_literals(script)))
    return list(out)


STR_OVERLAP_RE = re.compile(r"""(?<=['"])([^'"\s]{2,})(?=['"])""")  # mỗi vị trí thử một lần: tuyến tính theo nhánh


def _ast_literals(script: str) -> List[str]:
    """Hằng str/bytes (giải escape) trong AST của script Python; không phải Python hợp lệ → []."""
    import ast

    try:
        tree = ast.parse(script)
    except Exception:  # SyntaxError, ValueError (NUL), RecursionError…: không phải Python — regex vẫn chạy
        return []
    out: List[str] = []
    for node in ast.walk(tree):
        v = getattr(node, "value", None) if isinstance(node, ast.Constant) else None
        if isinstance(v, bytes):
            v = os.fsdecode(v)
        if isinstance(v, str) and v:
            out.append(v)
    return out


class _ReadOnly:
    """Kết quả `_read_only_script` tính một lần cho mỗi script, chỉ khi có chuỗi là đường dẫn được canh."""

    def __init__(self, script: str, families: FrozenSet[str]) -> None:
        self.script = script
        self.families = families
        self.value: Optional[bool] = None

    def __bool__(self) -> bool:
        if self.value is None:
            self.value = _read_only_script(self.script, self.families)
        return self.value


def _interp_families(tokens: List[str], cwd: Optional[str]) -> FrozenSet[str]:
    """Họ trình thông dịch có trong lệnh (`python`, `node`, `perl`…): script trong lệnh có thể chạy bởi bất kỳ ai trong
    số đó, nên chỉ coi là Python khi mọi trình thông dịch đều là Python (D-107)."""
    found = (INTERP_RE.fullmatch(n[0]) for n in (_interp_argv(c) for c, _ in _commands_with_cwd(tokens, cwd)) if n)
    return frozenset(INTERP_FAMILY.get(m[1], m[1]) for m in found if m)


class _WriteProbe:
    """`_direct_write`/`_alias_write` cho các chuỗi canh của MỘT script (AUD-SEC-092: mỗi chuỗi dựng một regex quét cả
    script — bậc hai theo số chuỗi): script không khớp `WRITE_ANY_RE` → không chuỗi nào là đích ghi, bỏ regex; quá
    `DIRECT_PROBES` chuỗi → coi như ghi (fail-closed: chặn, không quét quá hạn hook)."""

    def __init__(self, script: str) -> None:
        self.script = script
        self.writes = bool(WRITE_ANY_RE.search(script))
        self.left = DIRECT_PROBES

    def __call__(self, raw: str) -> bool:
        if not self.writes:
            return False
        self.left -= 1
        return self.left < 0 or _direct_write(self.script, raw) or _alias_write(self.script, raw)


def _interp_literal_ask(
    script: str,
    raw: str,
    root: str,
    here: Optional[str],
    hint: bool = True,
    ro: object = False,
    probe: Optional[_WriteProbe] = None,
) -> str:
    """Câu hỏi cho chuỗi `raw` trong script. Là hàng rào/cấu hình git/bí mật/bằng chứng (thử ở mọi thư mục canh khi
    `here` không biết — D-106) → câu mang dấu chặn, TRỪ khi toàn script chỉ gồm thao tác đọc (`ro`, D-105: mặc định
    chặn, không liệt kê API ghi). Cổng/năng lực mà script có dấu hiệu ghi (`hint`) → hỏi thường; khác → ''."""
    lit = PERL_OPEN_MODE_RE.sub("", raw)  # perl 2 đối số `open(F, ">f")`: chế độ dính vào tên file
    for target in _where(lit, root, here):
        rel = rel_path(target, root)
        kind = path_kind(rel, root) if ("/" in lit or "." in lit) and lit not in ("..", ".") else ""
        fence, git_hook = _is_fence(target, root), _match_any(rel, GIT_HOOK_PATTERNS)
        if not (fence or git_hook or kind in ("secret", "evidence")):
            continue
        # Mã lý do chính xác khi khớp API ghi đã biết; còn lại theo D-105: script không chỉ đọc → chặn như ghi
        # AUD-SEC-084: qua biến/bí danh (`_alias_write`, trong `probe`)
        direct = (lit != raw and ">" in raw[: len(raw) - len(lit)]) or (probe or _WriteProbe(script))(raw)
        how = "script trình thông dịch" if direct else "script trình thông dịch không chỉ đọc — D-105"
        if not (direct or not ro):
            continue
        if fence:
            return FENCE_WHY.format(f"{lit} — {how}")
        if git_hook:  # AUD-SEC-083: như `>> .git/config`
            return GIT_HOOK_WHY.format(f"{lit} — {how}")
        if kind == "secret":  # AUD-SEC-049: dấu chặn như chuyển hướng, không chỉ hỏi
            return f"ghi file bí mật qua Bash ({how}): {lit}"
        return f"ghi/xoá tay bằng chứng autopilot qua {how}: {lit}"  # ADR-0026: như ghi tay qua chuyển hướng
    kind = (
        path_kind(rel_path(_at(lit, here), root), root) if ("/" in lit or "." in lit) and lit not in ("..", ".") else ""
    )
    if hint and kind in GUARDED_KINDS:
        return f"script trình thông dịch ghi/xoá {lit} ({kind}) — dùng đúng công cụ hoặc người duyệt"
    return ""


# D-105: thao tác ĐỌC được phép trong script nhắc đường dẫn được canh. Mọi lời gọi khác (kể cả hàm tự viết, gọi qua
# biến, `getattr`, `eval`), gọi không ngoặc ngoài từ khoá, gán thuộc tính, chuỗi nội suy/f-string có biểu thức, backtick,
# tuỳ chọn `flag(s)`, mode ghi → script không chỉ đọc → chặn. Phân tích theo từ (không phải AST): đa ngôn ngữ, chặt.
# Chống mượn tên: tên trong danh sách chỉ được GỌI (`print = os.remove`, `as open`, `{unlinkSync: open}` → chặn); gọi
# trên biểu thức (`(os.remove)(…)`, `{…}.read(…)`), dunder, gán phần tử, đối tượng có giá trị là hàm → chặn. Hàm nhận
# hàm gọi lại (`sorted(key=…)`, `JSON.parse(t, reviver)`, `json.dumps(default=…)`) không có trong danh sách hoặc bị
# giới hạn đối số.
RO_FUNCS = frozenset(
    "open print len str int float bool repr list dict tuple set range enumerate zip isinstance sum any all exit Path "
    "PurePath PurePosixPath PosixPath require puts file_get_contents file_exists is_file is_dir sorted min max".split()
)
RO_METHODS = frozenset(
    "read readline readlines read_text read_bytes exists is_file is_dir stat lstat close open openSync readFileSync "
    "existsSync statSync lstatSync createReadStream readlinkSync exist? exists? file? directory? strip lstrip rstrip "
    "split splitlines startswith endswith decode encode lower upper keys values items join toString trim exit "
    "ConfigParser get glob rglob iterdir update hexdigest".split()
)
RO_JSON = frozenset({"json.load", "json.loads", "json.dump", "json.dumps", "JSON.parse", "JSON.stringify"})
RO_CHAINS = frozenset(
    {"console.log", "pathlib.Path", "pathlib.PurePath", "os.listdir", "os.scandir", "os.walk", "ast.parse"}
    | {"hashlib.sha256", "hashlib.md5"}
)
# Giới hạn đối số (review #186 lần 2, bớt chặn oan theo D-107): (tối đa đối số vị trí, từ khoá được phép) — chỗ nhận
# hàm gọi lại (`key=`, `onerror=`, `default=` của json) không có. Khoá: tên gọi trần, chuỗi `a.b`, hay `.m` (phương thức).
RO_ARG_RULES: Dict[str, Tuple[int, FrozenSet[str]]] = {
    "sorted": (1, frozenset({"reverse"})),
    "min": (10**6, frozenset({"default"})),
    "max": (10**6, frozenset({"default"})),
    "os.listdir": (1, frozenset()),
    "os.scandir": (1, frozenset()),
    "os.walk": (1, frozenset({"topdown", "followlinks"})),
    ".glob": (1, frozenset({"recursive", "case_sensitive", "recurse_symlinks", "include_hidden", "root_dir"})),
    ".rglob": (1, frozenset({"case_sensitive", "recurse_symlinks"})),
    ".iterdir": (0, frozenset()),
    "ast.parse": (3, frozenset({"filename", "mode", "type_comments", "feature_version"})),
    "hashlib.sha256": (1, frozenset({"usedforsecurity"})),
    "hashlib.md5": (1, frozenset({"usedforsecurity"})),
    ".update": (1, frozenset()),
    ".hexdigest": (0, frozenset()),
    ".get": (2, frozenset()),
}
# `.get(` của thư viện mạng (`requests.get(url)`) không phải đọc dict: script nhắc mạng thì `.get` không chỉ đọc.
RO_NET_RE = re.compile(
    r"\b(?:requests|httpx|urllib\d?|urlopen|https?|aiohttp|socket|net|axios|fetch|ftplib|smtplib|LWP|HTTP|curl)\b"
)
# `os.path.<hàm>(`: chỉ đúng bên nhận `os.path` và hàm trong danh sách — `os.path.os.rmdir(` không phải (review #186 lần 2)
RO_OS_PATH = frozenset(
    "exists lexists isfile isdir islink ismount isabs join basename dirname split splitext splitdrive abspath realpath "
    "normpath normcase relpath commonpath commonprefix expanduser expandvars getsize getmtime getatime getctime "
    "samefile".split()
)
# Hàm trong danh sách đọc nhận hàm gọi lại → giới hạn số đối số (đủ để không còn chỗ cho hàm): Node `fs.stat(p, cb)`,
# `fs.exists(p, cb)`, `fs.read(fd, cb)`, `fs.close(fd, cb)` (chỉ khi script có thể chạy bởi Node/Deno/Bun);
# `ConfigParser(dict_type=…, converters=…, interpolation=…)` — không đối số.
RO_JS_CALLBACK = frozenset({"stat", "lstat", "exists", "read", "close"})
RO_ARGS_MAX = {**{n: 2 for n in RO_JS_CALLBACK}, "ConfigParser": 1}
RO_ARG_NAMES = frozenset(  # lời gọi cần tách đối số để xét
    {"open", "openSync", "require", *RO_ARGS_MAX, *(k.rsplit(".", 1)[-1] for k in RO_ARG_RULES)}
)
JSON_DUMPS_KWARGS = frozenset({"indent", "sort_keys", "ensure_ascii", "separators"})
# Tên module/đối tượng mà danh sách cho phép dựa vào (`os.path.*`, `json.load`, `console.log`, `fs.readFileSync`):
# chỉ được dùng làm bên nhận (`os.`) — gán lại (`console = {log: …}`) là mượn tên.
RO_RECEIVERS = frozenset(
    {"os", "json", "JSON", "console", "fs", "File", "io", "codecs", "sys", "process", "pathlib", "ast", "hashlib"}
)
RO_FS_MODULES = frozenset({"fs", "node:fs", "path", "node:path"})
RO_PRINTERS = frozenset({"print", "puts"})  # in không ngoặc (`print "x"`, `puts File.read(…)`)
# Từ khoá/toán tử chữ (Python, JS, Ruby, Perl, PHP) — đứng trước `(` hay trước từ khác không phải lời gọi hàm.
RO_KEYWORDS = frozenset(
    "if elif else while for in not and or is return import from as with lambda assert try except finally raise pass "
    "None True False del global nonlocal yield async await class def const let var new typeof instanceof of function "
    "throw catch case default break continue switch do then end unless until elsif begin rescue ensure nil true false "
    "null undefined self this my our local use sub foreach eq ne lt gt le ge cmp echo".split()
)
READ_MODES = frozenset({"r", "rb", "rt", "br", "tr", "rs", "sr"})
FS_RECEIVERS = frozenset({"fs", "File", "io", "codecs", "fsp", "promises"})  # `.open(path, mode)`: đường dẫn trước
OPEN_KWARGS = frozenset({"encoding", "errors", "newline"})
RO_MASK_RE = re.compile(r"\x01(\d+)\x02")
RO_MARK_CHARS_RE = re.compile(r"[\x01\x02]")  # script có sẵn byte dấu che → không chỉ đọc (AUD-SEC-091)
RO_NEXT_LIT_RE = re.compile(r"[ \t]*\x01(\d+)\x02")
RO_CALL_RE = re.compile(r"(\.\s*)?(?<![\w$])([A-Za-z_]\w*[?!]?)\s*\(")
RO_BARE_CALL_RE = re.compile(r"(\.\s*)?(?<![\w$@%&])([A-Za-z_]\w*[?!]?)[ \t]+(?=([\x01$@\[\d]|[A-Za-z_]\w*))")
RO_NAME_RE = re.compile(r"(?<![\w$@%&.])([A-Za-z_]\w*)(?=[ \t]*(.?))")
# Từ khoá gắn tên (`as print`, `for open in`, `lambda print:`, `def open(`, `let open`) — tên trong danh sách đứng sau
# là bị gán lại.
RO_BINDERS_RE = re.compile(
    r"\b(?:as|for|lambda|def|function|class|let|const|var|global|nonlocal|local|my|our|sub)[ \t]+(?:[\w$]+[ \t]*,[ \t]*)*$"
)
RO_DENY_RE = re.compile(
    r"[`'\"]"  # nháy lẻ/backtick (Ruby/Perl chạy lệnh, JS template)
    r"|(?:\$\{?\w+\}?|&\w+)\s*\(|->"  # gọi qua biến/tham chiếu (`$f(…)`, `&f(…)`, `$f->(…)`, `$o->m(…)`)
    r"|\b(?:flags?|mode)\s*:"  # `{flag: 'w'}` của fs, Ruby `File.read(p, mode: 'w')`
    r"|[.\]]\s*[A-Za-z_]?\w*\s*(?:[-+*/%|&^]|<<|>>|\*\*|//)?=(?![=~>])"  # gán thuộc tính/phần tử
    r"|[)\]}]\s*\("  # gọi trên biểu thức
    r"|(?!__(?:name|main|file)__)__\w+__"  # dunder (`__builtins__`, `__import__`, `__dict__`)
    r"|[{,]\s*(?:[\w$]+|\x01\d+\x02)\s*:\s*[A-Za-z_$]"  # đối tượng/dict có giá trị là tên (hàm mượn tên)
)
RO_RECEIVER_RE = re.compile(r"([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\.\s*$")
RO_IMPORT_RE = re.compile(
    r"(?m)(?:^|(?<=;))[ \t]*(?:from[ \t]+[\w.]+[ \t]+)?import[ \t]+[\w.]+(?:[ \t]*,[ \t]*[\w.]+)*"
)
RO_FS_REQUIRE_RE = re.compile(r"\b(?:const|let|var)\s+(?:fs|path)\s*=\s*require\(\x01(\d+)\x02\)")
RO_ARG_SCANS = 256  # số lời gọi được tách đối số tối đa mỗi script (chống bậc hai) — hơn → coi là không chỉ đọc


Masked = Optional[Tuple[str, List[Tuple[str, str]]]]
# Bộ che chuỗi/comment (review #186 lần 2): che lệch là mã ghi thật nằm trong "chuỗi" → script bị coi là chỉ đọc. Python:
# `tokenize` của thư viện chuẩn (đúng lexer của Python); lỗi tách → không chỉ đọc. Ngôn ngữ khác (D-107): chỉ che chuỗi
# một dòng `'…'`/`"…"`; phần mã còn lại có ký tự mà bộ che không hiểu chắc (comment, regex, quote-like, heredoc, nháy dính
# biến/tên) → không chỉ đọc.
RO_FSTRING_DEPTH = 3  # độ sâu f-string lồng được kiểm đệ quy; sâu hơn → không chỉ đọc
RO_SIMPLE_STR_RE = re.compile(r"""'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)\"""")
RO_GENERIC_DENY_RE = re.compile(
    r"[#/%]|<<|<\?|\?>"  # comment `#`, `//`, regex `/…/`, Ruby `%q{}`, heredoc `<<`, thẻ PHP
    r"|[\w$?@&\\]\x01"  # nháy dính tên/ký hiệu: Perl `$'`, `pkg'name`, Ruby `?'`, tiền tố `rb'…'`
)
RO_PERL_QUOTE_RE = re.compile(r"(?<![\w$@%&])(?:qq|qw|qr|qx|q|m|s|tr|y)(?!\w)(?:\s*[^\w\s]|\s+\w)")
RO_LUA_DENY_RE = re.compile(r"--|\[=*\[")  # Lua: comment `--`, chuỗi dài `[[…]]`/`[==[…]==]` (review #186 lần 3)
RO_INTERP_RE = re.compile(r"[$@]|#\{")  # nội suy trong nháy kép: Perl `$h{…}`/`@a[…]`, PHP `{$o->m()}`, Ruby `#{…}`


def _ro_mask(script: str, families: Optional[FrozenSet[str]] = None) -> Masked:
    """Ngôn ngữ khác Python (D-107): chuỗi một dòng thay bằng `\\x01N\\x02`, danh sách (nháy, nội dung). Phần còn lại
    có ký tự che không chắc, chuỗi nháy kép có nội suy, chuỗi là ống lệnh (`'|cmd'`) → None (không chỉ đọc)."""
    lits: List[Tuple[str, str]] = []

    def sub(m: "re.Match[str]") -> str:
        lits.append((m[0][0], m[m.lastindex or 1]))
        return f"\x01{len(lits) - 1}\x02"

    if RO_MARK_CHARS_RE.search(script):  # AUD-SEC-091: byte dấu che có sẵn trong script giả làm chuỗi đã che
        return None
    masked = RO_SIMPLE_STR_RE.sub(sub, script)
    perl = not families or "perl" in families
    lua = not families or "lua" in families
    if (
        RO_GENERIC_DENY_RE.search(masked)
        or (perl and RO_PERL_QUOTE_RE.search(masked))
        or (lua and RO_LUA_DENY_RE.search(masked))
        or any(q == '"' and RO_INTERP_RE.search(v) for q, v in lits)
        or any(len(v.strip()) > 1 and "|" in (v.strip()[0], v.strip()[-1]) for _, v in lits)
    ):
        return None
    return masked, lits


def _ro_py_spans(script: str, depth: int) -> Optional[List[Tuple[int, int]]]:
    """Vị trí (đầu, cuối) của chuỗi, f-string (trọn cả lồng) và comment theo `tokenize`; None khi không chắc: quá độ
    sâu, `\\r` (vị trí token không chắc), ERRORTOKEN, token không khớp vị trí. Cú pháp sai/TokenError → ngoại lệ."""
    import ast
    import io
    import tokenize as pytok

    opens = {getattr(pytok, n) for n in ("FSTRING_START", "TSTRING_START") if hasattr(pytok, n)}
    closes = {getattr(pytok, n) for n in ("FSTRING_END", "TSTRING_END") if hasattr(pytok, n)}
    ast.parse(script)
    toks = list(pytok.generate_tokens(io.StringIO(script).readline))
    starts = list(itertools.accumulate((len(x) + 1 for x in script.split("\n")), initial=0))
    spans: List[Tuple[int, int]] = []
    seen: List[Tuple[int, str]] = []
    level, begin = 0, 0
    for t in toks:
        a, b = starts[t.start[0] - 1] + t.start[1], starts[t.end[0] - 1] + t.end[1]
        if t.type in opens:
            begin, level = (begin if level else a), level + 1
            seen.append((a, t.string))
        elif t.type in closes:
            level -= 1
            seen.append((a, t.string))
            spans += [(begin, b)] if not level else []
        elif not level and t.type in (pytok.STRING, pytok.COMMENT):
            spans.append((a, b))
            seen.append((a, t.string))
    bad = (
        depth > RO_FSTRING_DEPTH
        or "\r" in script
        or any(t.type == pytok.ERRORTOKEN for t in toks)
        or any(script[a : a + len(s)] != s for a, s in seen)
    )
    return None if bad else spans


def _ro_fstring_ok(text: str, depth: int) -> bool:
    """Mọi biểu thức trong f-string/t-string `text` chỉ đọc (kiểm đệ quy, tầng `depth + 1`)."""
    import ast

    tree = ast.parse(text, mode="eval")
    exprs = [n for n in ast.walk(tree) if type(n).__name__ in ("FormattedValue", "Interpolation")]
    return all(_read_only_script(ast.unparse(getattr(e, "value")), frozenset({"python"}), depth + 1) for e in exprs)


def _ro_mask_py(script: str, depth: int = 0) -> Masked:
    """Python: chuỗi (cả f-string) thay bằng `\\x01N\\x02`, comment bỏ đi — theo `tokenize`. Biểu thức trong f-string
    kiểm đệ quy bằng `_read_only_script` (tối đa RO_FSTRING_DEPTH tầng). Không tách chắc được → None (không chỉ đọc)."""
    try:
        spans = None if RO_MARK_CHARS_RE.search(script) else _ro_py_spans(script, depth)  # AUD-SEC-091
        if spans is None:
            return None
        out: List[str] = []
        lits: List[Tuple[str, str]] = []
        i = 0
        for a, b in spans:
            out.append(script[i:a])
            i, text = b, script[a:b]
            if text[0] == "#":
                continue
            prefix = text[: len(text) - len(text.lstrip("rRbBfFuUtT"))]
            q = 3 if text[len(prefix) : len(prefix) + 3] in ("'''", '"""') else 1
            if set(prefix.lower()) & {"f", "t"} and not _ro_fstring_ok(text, depth):
                return None
            lits.append((prefix.lower().replace("f", "").replace("t", ""), text[len(prefix) + q : len(text) - q]))
            out.append(f"\x01{len(lits) - 1}\x02")
        out.append(script[i:])
        return "".join(out), lits
    except Exception:  # SyntaxError, TokenError, ValueError (NUL), RecursionError…: không phân tích được → chặt
        return None


def _ro_parens(masked: str) -> Optional[Dict[int, int]]:
    """Vị trí `(` → `)` khớp với nó (chuỗi đã che nên chỉ đếm ngoặc); ngoặc lẻ/sai thứ tự → None."""
    stack: List[int] = []
    close: Dict[int, int] = {}
    for i, ch in enumerate(masked):
        if ch == "(":
            stack.append(i)
        elif ch == ")":
            if not stack:
                return None
            close[stack.pop()] = i
    return None if stack else close


def _paren_args(masked: str, start: int, end: int) -> List[str]:
    """Đối số cấp ngoài cùng trong `masked[start:end]` (phần giữa hai ngoặc của lời gọi), tách theo `,` ngoài ngoặc."""
    args: List[str] = []
    depth, cur = 0, start
    for i in range(start, end):
        depth += (masked[i] in "([{") - (masked[i] in ")]}")
        if masked[i] == "," and not depth:
            args.append(masked[cur:i].strip())
            cur = i + 1
    return [a for a in [*args, masked[cur:end].strip()] if a]


def _ro_lit(a: str, lits: List[Tuple[str, str]]) -> Optional[str]:
    m = RO_MASK_RE.fullmatch(a)
    return lits[int(m[1])][1] if m and int(m[1]) < len(lits) else None


def _ro_kwargs(args: List[str]) -> Tuple[List[str], List[Tuple[str, str]]]:
    """(đối số vị trí, [(tên, giá trị)] của đối số từ khoá)."""
    pos, kws = [], []
    for a in args:
        m = re.match(r"([A-Za-z_]\w*)\s*=(?!=)\s*", a)
        if m:
            kws.append((m[1], a[m.end() :]))
        else:
            pos.append(a)
    return pos, kws


def _ro_read_mode(a: str, lits: List[Tuple[str, str]]) -> bool:
    return _ro_lit(a, lits) in READ_MODES or a in ("os.O_RDONLY", "O_RDONLY", "0")


def _ro_open(kind: str, args: List[str], lits: List[Tuple[str, str]]) -> bool:
    """`open` chỉ đọc: `kind` = path (đường dẫn trước, mode sau) | mode (`Path.open(mode)`) | os (`os.open(p, cờ)`)."""
    pos, kws = _ro_kwargs(args)
    for name, val in kws:  # từ khoá: chỉ encoding/errors/newline và mode đọc (`os.open`: cả flags) — không opener=…
        if name in (("mode", "flag", "flags") if kind == "os" else ("mode",)):
            if not _ro_read_mode(val, lits):
                return False
        elif name not in OPEN_KWARGS:
            return False
    if kind == "os":
        return all(_ro_read_mode(a, lits) for a in pos[1:2]) and all(re.fullmatch(r"0o?[0-7]*", a) for a in pos[2:])
    if any(lit[:1] == "|" or lit.rstrip()[-1:] == "|" for lit in (_ro_lit(a, lits) or "" for a in pos)):
        return False  # Ruby/Perl `open('|lệnh')`, `open(F, 'lệnh|')`: chạy lệnh
    if kind == "mode":
        return all(_ro_lit(a, lits) in READ_MODES for a in pos[:1]) and all(re.fullmatch(r"-?\d+", a) for a in pos[1:])
    # path: `open(p[, mode])`, `fs.openSync(p, 'r')`, perl `open(F, '<', p)`/`open(F, '<p')` — đối số vị trí thứ 3 trở
    # đi của Python `open` (buffering … closefd, opener) không nhận: opener là hàm gọi lại (review #186 lần 2)
    mode = _ro_lit(pos[1], lits) if len(pos) > 1 else "r"
    if mode is None or not (mode in READ_MODES or re.fullmatch(r"<(?![&=+]).*", mode, re.S)):
        return False
    return len(pos) <= 2 or (mode == "<" and len(pos) == 3)


def _ro_json(chain: str, args: List[str]) -> bool:
    """JSON không kèm hàm gọi lại: `JSON.parse(t)`, `JSON.stringify(v[, null[, 2]])`, `json.load(s)(x)` không từ khoá,
    `json.dumps(v, indent=…)` (không `default=`/`cls=`)."""
    pos, kws = _ro_kwargs(args)
    if chain == "JSON.stringify":
        return pos[1:2] in ([], ["null"], ["undefined"])
    if chain in ("json.dumps", "json.dump"):  # `json.dump(v, sys.stdout)`: chỉ ra stdout
        want = [pos[0], "sys.stdout"] if chain == "json.dump" and pos else pos[:1]
        return pos == want and len(pos) >= 1 and all(k in JSON_DUMPS_KWARGS for k, _ in kws)
    return len(pos) == 1 and not kws


def _ro_names_ok(masked: str, lits: List[Tuple[str, str]]) -> bool:
    """Tên trong danh sách chỉ được gọi (hàm) hay làm bên nhận (module) — không gán lại/truyền làm giá trị. Câu
    `import a, b` (không `as`) và `const fs = require('fs')` không tính là gán."""
    body = RO_FS_REQUIRE_RE.sub(lambda m: " " if lits[int(m[1])][1] in RO_FS_MODULES else m[0], masked)
    body = RO_IMPORT_RE.sub(" ", body)
    for m in RO_NAME_RE.finditer(body):
        name, nxt = m[1], m[2]
        if name not in RO_FUNCS and name not in RO_RECEIVERS:
            continue
        if RO_BINDERS_RE.search(body[max(0, m.start() - 80) : m.start()]):
            return False
        if name in RO_RECEIVERS:
            allowed = "."
        elif name in RO_PRINTERS:
            allowed = "($@<\x01" if not nxt or not (nxt.isalpha() or nxt == "_") else nxt  # perl `print <$fh>`
        else:
            allowed = "(\x01" if name == "require" else "("
        if not nxt or nxt not in allowed:
            return False
        lm = RO_NEXT_LIT_RE.match(body, m.end()) if name == "require" else None
        if lm and lits[int(lm[1])][1].startswith((".", "/")):
            return False  # Ruby `require './x'`: chạy mã từ file khác
    return True


def _ro_args_ok(key: Optional[str], args: List[str]) -> bool:
    """Đối số trong giới hạn của RO_ARG_RULES[key] (không có luật → đúng)."""
    rule = RO_ARG_RULES.get(key or "")
    pos, kws = _ro_kwargs(args)
    return not rule or (len(pos) <= rule[0] and all(k in rule[1] for k, _ in kws))


def _ro_call_ok(
    name: str, recv: Optional[str], args: List[str], lits: List[Tuple[str, str]], flags: FrozenSet[str] = frozenset()
) -> bool:
    """Một lời gọi thuộc danh sách đọc: `recv` None = gọi trần `f(…)`, "" = phương thức trên biểu thức (`).m(`).
    `flags`: `js` — script có thể chạy bởi Node/Deno/Bun (`fs.stat(p, cb)`… nhận hàm gọi lại); `py` — chỉ Python
    (`.update` của hashlib/dict); `net` — script nhắc thư viện mạng (`.get` không phải đọc dict)."""
    chain = f"{recv}.{name}" if recv else name
    if name in ("open", "openSync"):
        path_first = recv is None or name == "openSync" or recv in FS_RECEIVERS
        return _ro_open("os" if recv == "os" else "path" if path_first else "mode", args, lits)
    if chain in RO_JSON:
        return _ro_json(chain, args)
    if name == "ConfigParser" or ("js" in flags and name in RO_JS_CALLBACK):
        bare_ok = recv is not None or name == "ConfigParser"
        return bare_ok and len(args) < RO_ARGS_MAX[name]  # `ConfigParser(dict_type=…)`, `fs.stat(p, cb)`: hàm gọi lại
    if (name == "update" and "py" not in flags) or (name == "get" and "net" in flags):
        return False
    if not _ro_args_ok(chain if chain in RO_ARG_RULES or recv is None else f".{name}", args):
        return False  # `sorted(key=…)`, `os.walk(onerror=…)`: hàm gọi lại
    if recv is not None:
        return name in RO_METHODS or chain in RO_CHAINS or (recv == "os.path" and name in RO_OS_PATH)
    if name not in RO_FUNCS and name not in RO_KEYWORDS:
        return False
    module = (_ro_lit(args[0], lits) or "") if name == "require" and args else "fs"
    return bool(module) and not module.startswith((".", "/"))  # `require('./x')`, `require(x)`: mã từ file khác


def _ro_calls_ok(
    masked: str, lits: List[Tuple[str, str]], close: Dict[int, int], flags: FrozenSet[str] = frozenset()
) -> bool:
    """Mọi lời gọi `f(…)`/`x.m(…)` thuộc danh sách đọc; `open` chỉ với mode đọc; JSON/hàm khác không hàm gọi lại."""
    scans = 0
    for m in RO_CALL_RE.finditer(masked):
        name, recv = m[2], None
        if m[1]:
            recv_m = RO_RECEIVER_RE.search(masked[max(0, m.start() - 200) : m.start() + 1])
            recv = re.sub(r"\s+", "", recv_m[1]) if recv_m else ""
        special = name in RO_ARG_NAMES or f"{recv}.{name}" in RO_JSON
        scans += special
        if scans > RO_ARG_SCANS:
            return False
        args = _paren_args(masked, m.end(), close[m.end() - 1]) if special else []
        if not _ro_call_ok(name, recv, args, lits, flags):
            return False
    return True


def _read_only_script(script: str, families: Optional[FrozenSet[str]] = None, depth: int = 0) -> bool:
    """Toàn script chỉ gồm thao tác đọc trong danh sách cho phép (D-105). Không phân tích được → False (chặt).
    `families` = họ trình thông dịch chạy script (`python`, `node`, `perl`…): chỉ `{python}` → che bằng `tokenize`;
    khác/rỗng → bộ che chung chặt (D-107); None (không truyền) → script Python hợp lệ thì như Python."""
    python = families == frozenset({"python"})
    found = _ro_mask_py(script, depth) if python or families is None else None
    py = found is not None
    found = found if python else (found or _ro_mask(script, families))
    if found is None:
        return False
    masked, lits = found
    close = _ro_parens(masked)
    if close is None or RO_DENY_RE.search(masked):
        return False  # ngoặc lẻ, nháy lẻ, backtick, gọi qua biến, tuỳ chọn flag, gán, gọi trên biểu thức
    for m in RO_BARE_CALL_RE.finditer(masked):  # gọi không ngoặc: `unlink '.env'`, `File.delete '.env'`
        name, nxt = m[2], m[3]
        if name not in RO_KEYWORDS and nxt not in RO_KEYWORDS and name not in (*RO_PRINTERS, "require"):
            return False
    js = not families or bool(families & {"node", "deno", "bun"})
    flags = frozenset(f for f, on in (("js", js), ("py", py), ("net", bool(RO_NET_RE.search(script)))) if on)
    return _ro_names_ok(masked, lits) and _ro_calls_ok(masked, lits, close, flags)


# Đường dẫn là đối số của chính lời gọi ghi/xoá (`open('.env','w')`, `os.remove('…')`, `Path('…').write_text(`,
# `shutil.copy(a, '…')`, `fs.writeFileSync('…'`): chỉ khi đó mới CHẶN — script chỉ nhắc tên file (ghi file khác) vẫn
# theo hỏi/cho qua, tránh chặn oan script sửa tài liệu/test có nhắc `.env` hay `.claude/hooks/…`.
DIRECT_WRITE_FMT = (
    r"open\(\s*{q}\s*,\s*(?:mode\s*=\s*)?['\"][rbt]?[wax+]"
    r"|(?:\bos\.(?:remove|unlink|rename|replace|truncate)|\bshutil\.\w+|writeFile\w*|appendFile\w*|unlinkSync|rmSync"
    r"|renameSync|copyFile\w*|File\.write|IO\.write|file_put_contents|\bunlink)\(\s*(?:[^)]*,\s*)?{q}"
    r"|Path\(\s*{q}\s*\)\s*\.(?:write_text|write_bytes|unlink|rename|replace|touch)\("
    # AUD-SEC-084: bí danh của Path (`from pathlib import Path as P; P('…').write_text(`) — `.replace(` của hàm khác
    # (str) không phải ghi, chỉ nhận với `Path`
    r"|\b[A-Za-z_][\w.]*\(\s*{q}\s*\)\s*\.(?:write_text|write_bytes|unlink|rmdir|rename|touch|chmod)\("
    # AUD-SEC-089: `Path('…').open('a')` chỉ là ghi khi có mode ghi — `.open()`/`.open('r')` là đọc
    r"|\b[A-Za-z_][\w.]*\(\s*{q}\s*\)\s*\.open\(\s*(?:mode\s*=\s*)?['\"][rbt]?[wax+]"
    # AUD-SEC-089: luồng ghi; `os.open` với cờ ghi; `fs.openSync(…, 'a'|'r+'|số)`; liên kết/đổi quyền/chủ (như đường
    # shell `ln -s`/`chmod` bị chặn) — mọi vị trí đối số, gồm cả đích của `symlink(src, dst)`
    r"|\bcreateWriteStream\(\s*{q}"
    r"|\bos\.open\(\s*{q}\s*,[^)]*\bO_(?:WRONLY|RDWR|APPEND|CREAT|TRUNC)\b"
    r"|\bopen(?:Sync)?\(\s*{q}\s*,\s*(?:['\"][^'\"]*[wa+]|[^)'\"]*\bO_(?:WRONLY|RDWR|APPEND|CREAT|TRUNC)\b)"
    r"|\b(?:symlink|link|l?chmod|l?chown)(?:Sync)?\(\s*(?:[^)]*,\s*)?{q}"
    r"|\b(?:unlink|rename|truncate)[ \t]+(?:[^;\n)]*,[ \t]*)?{q}"  # perl/ruby/php gọi không ngoặc: `unlink ".autopilot/x"`
    r"|\bopen[ \t]*\(?[^,;\n]*,[ \t]*['\"]\+?(?:>|>>|w|a)['\"][ \t]*,[ \t]*{q}"  # perl `open(F, '>', '…')`
    # AUD-SEC-074: `py_compile.compile(f, cfile='…')`, `p.compile(f, '…')`, `compile_dir(d, …)`, `sys.pycache_prefix = '…'`
    r"|\bcompile\w*\(\s*(?:[^)]*,\s*)?(?:\w+\s*=\s*)?{q}|\bpycache_prefix\s*=\s*{q}"
)


def _direct_write(script: str, lit: str) -> bool:
    q = "['\"]" + re.escape(lit) + "['\"]"
    return bool(re.search(DIRECT_WRITE_FMT.format(q=q), script))


# AUD-SEC-084: đường dẫn gán cho biến (`f='.env'`, `p = Path('…')`, `my $f = '…'`, `const f = '…'`, `for f in ['…']`) rồi
# biến đó (hoặc biến gán lại từ nó, `b = a`) là đối số ĐƯỜNG DẪN của lời gọi ghi/xoá → chặn như ghi trực tiếp. Biến chỉ
# được in ra, đọc, hay làm NỘI DUNG ghi vào file khác (`writeFileSync('out', 'x' + f)`) không tính — tránh chặn oan
# script sửa tài liệu/test nhắc `.env`. Còn hở: đường dẫn ghép chuỗi/format, nằm trong dict/đối số hàm tự viết.
ALIAS_NAME = r"\$?[A-Za-z_]\w*"
ALIAS_BIND_FMT = (
    r"(?<![\w.$])(" + ALIAS_NAME + r")\s*(?::\s*[\w.\[\]]+\s*)?=(?![=~>])[^;\n=]{{0,200}}?{q}"
    r"|\bfor(?:each)?\s*\(?\s*(?:(?:const|let|var|my|our)\s+)?(" + ALIAS_NAME + r")\b[^;\n:{{]{{0,200}}?{q}"
)
ALIAS_WRITE_FMT = (
    r"open\(\s*{n}\s*,\s*(?:mode\s*=\s*)?['\"][rbt]?[wax+]"  # python/ruby `open(f, 'w')`, `File.open(f, 'a')`
    r"|(?:writeFile\w*|appendFile\w*|unlinkSync|rmSync|truncate\w*|File\.write|IO\.write|file_put_contents|\bunlink"
    r"|\bos\.(?:remove|unlink|truncate))\(\s*{n}\s*[,)]"  # đối số đầu là đường dẫn
    r"|(?:\bos\.(?:rename|replace)|\bshutil\.\w+|renameSync|copyFile\w*|\brename"
    r"|\b(?:symlink|link|l?chmod|l?chown)(?:Sync)?|\bcreateWriteStream)\(\s*(?:[^,()]*,\s*)?{n}\s*[,)]"  # AUD-SEC-089
    r"|\bos\.open\(\s*{n}\s*,[^)]*\bO_(?:WRONLY|RDWR|APPEND|CREAT|TRUNC)\b"
    r"|{n}\s*\.\s*(?:write_text|write_bytes|unlink|rmdir|rename|touch|chmod)\(|{n}\s*\.\s*open\(\s*['\"][rbt]?[wax+]"
    r"|\bopen\s*\(?[^;\n]*?['\"]\+?>{{1,2}}['\"]\s*,\s*{n}"  # perl `open(my $h, '>', $f)`
    r"|\bopen\s*\(?[^,;\n]*,\s*['\"]\+?>{{1,2}}\s*{n}"  # perl 2 đối số `open(F, ">$f")`
    r"|\b(?:unlink|rename|truncate)[ \t(]+(?:[^;\n)]*,[ \t]*)?{n}"  # perl/ruby/php không ngoặc
)
ALIAS_MAX = 16


def _alias_ref(name: str) -> str:
    return r"(?<![\w.$])" + re.escape(name) + r"(?![\w(])"


def _alias_write(script: str, lit: str) -> bool:
    """Chuỗi `lit` được gán cho một biến (trực tiếp hoặc qua chuỗi gán lại) mà biến đó là đường dẫn của lời gọi
    ghi/xoá trong `script`."""
    q = "['\"]" + re.escape(lit) + "['\"]"
    script = script.replace("\\$", "$")  # `"\$f"` trong nháy kép của shell: bash bỏ `\`, bộ tách token giữ lại
    names = {g for m in re.finditer(ALIAS_BIND_FMT.format(q=q), script) for g in m.groups() if g}
    todo = list(names)
    while todo and len(names) < ALIAS_MAX:  # `b = a`, `p = Path(a)`: biến gán từ biến đã là bí danh
        ref = _alias_ref(todo.pop())
        bind = r"(?<![\w.$])(" + ALIAS_NAME + r")\s*(?::\s*[\w.\[\]]+\s*)?=(?![=~>])[^;\n=]{0,200}?" + ref
        for m in re.finditer(bind, script):
            if m[1] not in names:
                names.add(m[1])
                todo.append(m[1])
    return any(re.search(ALIAS_WRITE_FMT.format(n=_alias_ref(n)), script) for n in names)


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


# `host:`, `u@h:path` của scp/rsync, URL `scp://`/`sftp://`/`rsync://` (review #159).
REMOTE_SPEC_RE = re.compile(r"(?:[\w.-]+@)?[\w.-]+:(?!//)|(?:scp|sftp|rsync)://")
STREAM_SENDERS = {"nc", "ncat", "netcat", "socat", "telnet", "ssh"}
NET_REDIRECT_RE = re.compile(r"/dev/(?:tcp|udp)/")


def _redirect_targets(args: List[str], ops: Tuple[str, ...]) -> List[str]:
    return [args[i + 1] for i, t in enumerate(args[:-1]) if t in ops]


# Tuỳ chọn `gh` ăn một giá trị không phải file gửi đi (`gh -R o/r release upload …` — AUD-SEC-075: `o/r` từng bị coi là
# lệnh con nên `release upload` không được nhận ra). Theo lệnh con: `-d` của gist là mô tả, của release là `--draft`.
GH_GLOBAL_VALUE_OPTS = ("-R", "--repo", "--hostname")
# Lệnh con tải file (đối số vị trí sau `<nhóm> <lệnh>`) → tuỳ chọn ăn giá trị của nó (review PR #182: `release create`).
GH_UPLOADS: Dict[Tuple[str, ...], Tuple[str, ...]] = {
    ("gist", "create"): ("-d", "--desc", "-f", "--filename"),
    ("gist", "edit"): ("-d", "--desc", "-f", "--filename"),
    ("release", "upload"): (),
    ("release", "create"): (
        *("-t", "--title", "-n", "--notes", "-F", "--notes-file", "--target", "--discussion-category"),
        "--notes-start-tag",
    ),
}
GH_UPLOAD_VALUE_OPTS = (*GH_GLOBAL_VALUE_OPTS, *{o for v in GH_UPLOADS.values() for o in v})
# Cờ `gh` đọc file để đăng (`--body-file`/`--notes-file`/`-F` của issue/pr/release; `-F k=@f` của `workflow run`).
GH_FILE_FLAGS = ("--body-file", "--notes-file", "-F")


def _gh_api_files(args: List[str]) -> List[str]:
    """File `gh api` đọc để gửi đi: `-F k=@f`/`--field k=@f`/`-Fk=@f`/`--field=k=@f`, `--input f` (AUD-SEC-075)."""
    out: List[str] = []
    for i, a in enumerate(args):
        flag, val = (a, args[i + 1] if i + 1 < len(args) else "") if a in GH_API_FIELD_FLAGS else ("", "")
        if not flag and a.startswith("--") and a.split("=", 1)[0] in GH_API_FIELD_FLAGS and "=" in a:
            flag, val = a.split("=", 1)
        elif not flag and a[:2] == "-F" and len(a) > 2:
            flag, val = "-F", a[2:]
        if flag == "--input":
            out.append(val)
        elif flag in ("-F", "--field") and val.split("=", 1)[-1].startswith("@"):
            out.append(val.split("=", 1)[-1][1:])
    return out


def _gh_flag_files(args: List[str]) -> List[str]:
    """Giá trị của cờ đọc file (`GH_FILE_FLAGS`) ở mọi dạng: `--body-file f`, `--body-file=f`, `-F f`, `-Ff`, `-F=f`
    (review PR #182); giá trị `k=@f` thêm cả `f`."""
    out: List[str] = []
    for i, a in enumerate(args):
        if a in GH_FILE_FLAGS:
            val = args[i + 1] if i + 1 < len(args) else ""
        elif a.startswith("--") and a.split("=", 1)[0] in GH_FILE_FLAGS and "=" in a:
            val = a.split("=", 1)[1]
        elif a[:2] == "-F" and len(a) > 2:
            val = a[3:] if a[2] == "=" else a[2:]
        else:
            continue
        out += [val, val.split("@", 1)[1]] if "=@" in val else [val]
    return out


def _gh_upload_files(args: List[str]) -> List[str]:
    """File `gh` đăng lên GitHub: `gh gist create|edit` (không file hoặc `-` = stdin), `gh release upload|create`
    (bỏ hậu tố `#nhãn` của tài sản — review PR #182), `gh api -F k=@f`/`--input f`, cờ đọc file (`_gh_flag_files`)."""
    head = tuple(_positionals(args, GH_UPLOAD_VALUE_OPTS)[:2])
    if head[:1] == ("api",):
        return _gh_api_files(args)
    opts = GH_UPLOADS.get(head)
    files = [] if opts is None else [f.split("#", 1)[0] for f in _positionals(args, (*GH_GLOBAL_VALUE_OPTS, *opts))[2:]]
    if head == ("gist", "create") and (not files or "-" in args):  # `cat .env | gh gist create` (AUD-SEC-075)
        files.append("-")
    return files + _gh_flag_files(args)


# Tuỳ chọn ăn một giá trị (giá trị không phải file gửi đi: `scp -i key.pem`, `rsync -e "ssh -i k"`, `--exclude .env`).
COPY_VALUE_OPTS = {
    "scp": ("-c", "-F", "-i", "-J", "-l", "-o", "-P", "-S", "-D", "-X"),
    "sftp": ("-c", "-F", "-i", "-J", "-l", "-o", "-P", "-S", "-D", "-B", "-R", "-s"),
    "rsync": (
        *("-e", "--rsh", "--exclude", "--include", "--filter", "-f", "--exclude-from", "--include-from"),
        *("--files-from", "--port", "--password-file", "--log-file", "--partial-dir", "--temp-dir", "-T"),
        *("--compare-dest", "--link-dest", "--copy-dest", "--backup-dir", "--suffix", "--chmod", "--chown", "-M"),
        *("--remote-option", "--out-format", "--info", "--debug", "--timeout", "--contimeout", "--bwlimit"),
        *("--max-size", "--min-size", "--rsync-path", "--usermap", "--groupmap"),
    ),
}
CLOUD_URL_RE = re.compile(r"(?:s3|gs|az|r2|b2)://")
CLOUD_COPIERS = ("aws", "gsutil", "rclone", "gcloud", "azcopy")


def _copy_files(n: List[str]) -> Optional[List[str]]:
    """File scp/rsync/sftp gửi tới máy khác (`host:`, `scp://`) hoặc lệnh cloud tải lên (`aws s3 cp f s3://…`,
    `rclone copy f remote:`); None nếu không gửi đi đâu."""
    pos = _positionals(n[1:], COPY_VALUE_OPTS.get(n[0], ()))
    if n[0] in COPY_VALUE_OPTS and any(REMOTE_SPEC_RE.match(a) for a in pos):
        return pos
    if n[0] in CLOUD_COPIERS and any(CLOUD_URL_RE.match(a) or REMOTE_SPEC_RE.match(a) for a in pos):
        return pos
    return None


NET_WRITE_OPS = (">", ">>", ">|", "&>", "<>")  # `<>` mở socket hai chiều (`exec 3<>/dev/tcp/h/80` — AUD-SEC-075)


FD_VAR_RE = re.compile(r"\{([A-Za-z_]\w*)\}")  # `exec {fd}<>/dev/tcp/…`: bash cấp số fd, lưu vào biến `fd`
DEV_FD_RE = re.compile(r"/dev/fd/(\d+)")


def _net_fd_names(prev: str, op: str) -> Set[str]:
    m = FD_VAR_RE.fullmatch(prev)
    if m:
        return {f"${m.group(1)}", f"${{{m.group(1)}}}"}
    return {prev if prev.isdigit() else ("0" if op == "<>" else "1")}


def _net_fds(tokens: List[str]) -> Set[str]:
    """Tên fd mở tới `/dev/tcp|udp/…` ở bất kỳ lệnh nào trong chuỗi (`exec 3<>/dev/tcp/h/80`, `3>/dev/tcp/…`, `exec
    {fd}<>/dev/tcp/…` → `$fd`/`${fd}`): lệnh sau ghi `>&3`, `>&$fd`, `>/dev/fd/3` là gửi ra mạng (AUD-SEC-075)."""
    return {
        name
        for i, t in enumerate(tokens[:-1])
        if t in NET_WRITE_OPS and NET_REDIRECT_RE.match(tokens[i + 1])
        for name in _net_fd_names(tokens[i - 1] if i else "", t)
    }


def _fd_ref(target: str) -> str:
    """Đích chuyển hướng quy về tên fd: `/dev/fd/3` → `3` (cùng fd với `>&3`)."""
    m = DEV_FD_RE.fullmatch(target)
    return m.group(1) if m else target


def _subst_secrets(args: List[str], root: str) -> List[str]:
    """File bí mật đọc trong thay lệnh của đối số (`printf %s "$(cat .env)" >/dev/tcp/…`, `curl -d "\\`cat .env\\`"`)."""
    line = " ".join(args)  # thay lệnh không nháy bị tách thành nhiều token (`` echo `cat .env` ``)
    bodies = [sp[2] for sp in (*_dollar_spans(line), *_backtick_spans(line))] if "$(" in line or "`" in line else []
    return [w for body in bodies for w in tokenize(body) if _is_secret_file(w, root)]


def _socat_files(n: List[str]) -> List[str]:
    """Địa chỉ socat là file: `FILE:f`, `OPEN:f,rdonly`, hoặc đường dẫn trơn (`socat -u ./.env TCP:…` — kiểu
    GOPEN ngầm, AUD-SEC-075)."""
    return [a.split(":", 1)[-1].split(",", 1)[0] for a in _positionals(n[1:])]


def _net_files(c: List[str], n: List[str], net_fds: Optional[Set[str]] = None) -> Optional[List[str]]:
    """File một lệnh gửi ra mạng (`-` = stdin của nó), None nếu lệnh không gửi ra mạng (AUD-SEC-067): curl/wget,
    scp/rsync tới máy khác, lệnh cloud, nc/socat/ssh (stdin, `<`, `FILE:`, đường dẫn trơn của socat), `gh gist|release
    upload`/`gh api -F k=@f`, `/dev/tcp/…` (cả `>&N` tới fd đã mở vào socket — `net_fds`)."""
    args = c[1:]
    if n[0] in FETCHERS:
        return _fetch_files(args)
    if n[0] in COPY_VALUE_OPTS or n[0] in CLOUD_COPIERS:
        return _copy_files(n)
    if n[0] == "socat":
        return ["-", *_redirect_targets(args, ("<",)), *_socat_files(n)]
    if n[0] in STREAM_SENDERS:
        return ["-", *_redirect_targets(args, ("<",)), *[a.split(":", 1)[1] for a in n[1:] if ":" in a]]
    if n[0] == "gh":
        return _gh_upload_files(n[1:]) or None
    to_fd = [t for t in _redirect_targets(args, (">&", "&>", ">", ">>")) if _fd_ref(t) in (net_fds or set())]
    if to_fd or any(NET_REDIRECT_RE.match(t) for t in _redirect_targets(args, NET_WRITE_OPS)):
        return ["-", *_positionals(n[1:]), *_redirect_targets(args, ("<",))]
    return None


def secret_exfil(tokens: List[str], root: str) -> Optional[str]:
    """Gửi file bí mật/biến môi trường ra mạng: `curl -d @.env …`, `curl -T .env …`, `cat .env | curl -d @- …`,
    `env | curl --data-binary @- …` (rà stored 2026-10-16: Read(.env) bị chặn nhưng Bash thì không); kênh khác ở
    `_net_files` (AUD-SEC-067)."""
    net_fds = _net_fds(tokens)
    for group in pipelines(tokens):
        for i, c in enumerate(group):
            n = normalize(c)
            files = _net_files(c, n, net_fds) if n else None
            if files is None:
                continue
            leaked = [f for f in files if _is_secret_file(f, root) and not f.endswith(".pub")]  # khoá công khai
            leaked += _subst_secrets(c[1:], root)
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
    if budget is None:  # lời gọi gốc: không có `cwd` = gốc dự án; lệnh lồng nhận None = thư mục không biết (D-106)
        cwd = cwd or root
    budget = budget or ScanBudget()
    cmd = clean_text(cmd)
    res: Dict[str, object] = {"decision": "", "reason": "", "commit": False, "no_verify": False, "commit_dir": ""}
    if budget.exhausted() or len(cmd) > CMD_MAX_CHARS:
        res.update(
            decision="deny",
            reason=f"Lệnh quá phức tạp để guard quét hết (vượt ngân sách quét): {cmd[:200]}",
            code=BUDGET,
        )
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
    asks: List[str] = interp_write_asks(cmd, tokens, root, cwd)
    asks += [REVIEW_FORGE_WHY] if any(_forges_review(c) for c in split_commands(tokens)) else []
    braces = brace_variants(cmd)
    nested_deny = (
        "Lệnh quá phức tạp để guard quét hết (brace expansion quá nhiều biến thể): chia nhỏ lệnh."
        if braces is None
        else _scan_scripts(braces, root, cwd, depth, asks, 0, budget, rewrites)
    ) or _scan_nested(cmd, tokens, root, cwd, depth, asks, budget, rewrites)
    if nested_deny:
        res.update(decision="deny", reason=nested_deny)
        return res
    commands = _commands_with_cwd(tokens, cwd)
    deny_reason = next((r for argv, here in commands if (r := _scan_command(argv, root, res, asks, here))), "")
    deny_reason = deny_reason or (
        ai_attribution(cmd, commands, root) if res["commit"] or GH_PR_TEXT_RE.search(cmd) else ""
    )
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
# ở trên vẫn tính `ask` đầy đủ; `XT_GUARD_POLICY=strict` giữ hành vi cũ (hỏi). Quyết định có kiểu (REC-04): mỗi kết quả
# mang MÃ lý do; `apply_policy` ánh xạ theo mã qua bảng `POLICY`, không theo chuỗi rải rác. Mã do nơi sinh quyết định
# đặt (`code`), hoặc suy MỘT lần từ lý do qua `REASON_CODES` (luật cũ chưa đặt mã). Regex/hook cùng UID không phải ranh
# giới cách ly (D-015) — đây là lớp chặn sai lầm, không chặn kẻ tấn công có quyền ghi.
OTHER_ASK = "OTHER_ASK"  # ask không nguy hiểm → cho qua (mặc định)
RULE_DENY = "RULE_DENY"  # deny của bộ luật chưa có mã riêng
NO_OBJECTION = "NONE"  # guard không phản đối
RULE_ALLOW = "RULE_ALLOW"  # allow rõ ràng (merge đã qua merge-check)
UNPARSED = "UNPARSED"  # guard lỗi giữa chừng với hành động phải kiểm
BUDGET = "BUDGET"
BRACE_OVERFLOW = "BRACE_OVERFLOW"
NEST_TOO_DEEP = "NEST_TOO_DEEP"
UNRESOLVED_TARGET = "UNRESOLVED_TARGET"  # đích của hành động không đảo ngược guard không giải được (T-1523)
# (dấu trong lý do, mã) — thứ tự: dấu cụ thể trước dấu chung ("bằng chứng review" trước "tay bằng chứng").
REASON_CODES: Tuple[Tuple[str, str], ...] = (
    ("push thẳng nhánh chính", "PUSH_MAIN"),
    ("push --all/--tags", "PUSH_ALL"),
    ("xoá đệ quy ngoài thư mục dự án", "WIPE_OUTSIDE"),
    ("rm -rf không có đích", "WIPE_OUTSIDE"),
    ("find xoá file ngoài thư mục dự án", "WIPE_OUTSIDE"),
    ("xoá thư mục gắn từ máy", "WIPE_OUTSIDE"),
    ("xoá thay đổi đã cất", "STASH_DROP"),
    (DESTROY_ASK, "DESTROY"),
    (AUTO_MERGE_WHY, "AUTO_MERGE_ENABLE"),  # bật auto-merge: deny phẳng ở mọi chính sách (ADR-0036)
    (HARD_ASK, "HARD_EXCEPTION"),
    (UNVERIFIED_ASK, "UNVERIFIED"),
    (REVIEW_MISSING_ASK, "REVIEW_MISSING"),
    ("container có quyền máy chủ", "HOST_CONTAINER"),
    ("tắt hook của khung", "HOOK_BYPASS"),
    ("bỏ qua hook của dự án", "HOOK_BYPASS"),
    ("ghi file bí mật qua Bash", "SECRET_WRITE"),
    ("bằng chứng review", "REVIEW_FORGE"),
    ("tay bằng chứng", "EVIDENCE_HANDWRITE"),  # ghi/xoá tay `.autopilot/` = bằng chứng giả (ADR-0026)
    ("lệnh đã mã hoá/nén", "OPAQUE_EXEC"),  # `… | base64 -d | sh` từ nguồn guard không giải được
    (NEST_ASK, NEST_TOO_DEEP),  # lớp lồng không quét được có thể chứa bất kỳ lệnh nào (AUD-SEC-063)
    (UNRESOLVED_PUSH_WHY, UNRESOLVED_TARGET),  # `xargs git push`, `git push origin $(…)` (T-1523)
    ("vượt ngân sách quét", BUDGET),
    ("brace expansion quá nhiều", BRACE_OVERFLOW),
)
# Giữ tên cũ cho mã/ test đọc danh sách dấu nguy hiểm.
DANGER_MARKERS = tuple(m for m, _ in REASON_CODES)
# Mã mà guard không đọc hết được hành động: luôn `unsure`.
UNSURE_CODES = frozenset(
    {UNPARSED, BUDGET, BRACE_OVERFLOW, NEST_TOO_DEEP, UNRESOLVED_TARGET, "OPAQUE_EXEC", "UNVERIFIED"}
)
# Bảng chính sách mặc định: mã → hành động. Mã vắng bảng giữ hành động gốc. ask không nguy hiểm → "" (cho qua).
POLICY: Dict[str, str] = {**{c: "deny" for _, c in REASON_CODES}, UNPARSED: "deny", OTHER_ASK: "", RULE_DENY: "deny"}
# Nhóm chặn: hành động gốc ask/deny. `unsure` trong nhóm chặn → deny ở mọi adapter (bash/mcp/edit/permission).
BLOCKING = frozenset({"ask", "deny"})


class Decision:
    """Quyết định có kiểu: `action` allow|deny|ask|"" (không phản đối), `code` mã lý do, `confidence` sure|unsure,
    `missing` = phần guard không kiểm được (rỗng khi sure)."""

    __slots__ = ("action", "code", "confidence", "missing", "reason")

    def __init__(self, action: str, code: str, confidence: str, missing: Tuple[str, ...], reason: str = "") -> None:
        self.action = action
        self.code = code
        self.confidence = confidence
        self.missing = missing
        self.reason = reason

    def as_dict(self) -> Dict[str, object]:
        return {"code": self.code, "confidence": self.confidence, "missing": list(self.missing)}


def reason_code(action: str, reason: str) -> str:
    """Mã lý do suy từ lý do (chỉ dùng khi nơi sinh chưa đặt `code`)."""
    hit = next((c for m, c in REASON_CODES if m in reason), "")
    if hit:
        return hit
    return {"ask": OTHER_ASK, "deny": RULE_DENY, "allow": RULE_ALLOW}.get(action, NO_OBJECTION)


def decide(out: Dict[str, object]) -> Decision:
    """Dựng `Decision` từ kết quả bộ luật (dict của bash/edit/mcp)."""
    action = str(out.get("decision") or "")
    reason = str(out.get("reason", "")).removeprefix(ASK_PREFIX)
    code = str(out.get("code") or reason_code(action, reason))
    unsure = code in UNSURE_CODES or out.get("confidence") == "unsure"
    missing = (code,) if unsure else ()
    return Decision(action, code, "unsure" if unsure else "sure", missing, reason)


def policy_action(d: Decision) -> str:
    """Hành động sau chính sách mặc định: unsure trong nhóm chặn → deny; còn lại tra bảng theo mã."""
    if d.action in BLOCKING and d.confidence == "unsure":
        return "deny"
    if d.action == "ask":
        return POLICY.get(d.code, "")
    return d.action


def apply_policy(out: Dict[str, object]) -> Dict[str, object]:
    """Chính sách mặc định theo mã: ask nguy hiểm/unsure → deny; ask khác → cho qua (quyết định rỗng); deny/allow/rỗng
    giữ nguyên. Kết quả mang `code`/`confidence`/`missing`."""
    d = decide(out)
    act = policy_action(d)
    res = {**out, **d.as_dict(), "decision": act}
    if act == "deny" and d.action == "ask":
        res["reason"] = f"Lệnh bị khung chặn (nguy hiểm — {d.code}): {d.reason[:400]}"
    elif act == "" and d.action == "ask":
        res["reason"] = ""
    return res


PERMISSION_MODES = {"Bash": "bash", "Edit": "edit", "Write": "edit", "MultiEdit": "edit"}


def permission_mode(tool: object) -> str:
    """Chế độ guard cho tool của sự kiện PermissionRequest; tool khác → rỗng (không quyết)."""
    if not isinstance(tool, str):
        return ""
    return PERMISSION_MODES.get(tool) or ("mcp" if tool.startswith("mcp__") else "")


def permission_output(out: Dict[str, object]) -> str:
    """JSON cho hook PermissionRequest (headless) từ CÙNG quyết định: deny/allow → `decision.behavior`; còn lại (ask,
    rỗng) → không in gì: Claude Code hiện hộp thoại, headless thì deny (chiều chặt)."""
    act = str(out.get("decision") or "")
    if act not in ("allow", "deny"):
        return ""
    behavior: Dict[str, object] = {"behavior": act}
    if act == "deny":
        behavior["message"] = str(out.get("reason", ""))[:600]
    return json.dumps(
        {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": behavior}}, ensure_ascii=False
    )


# Lệnh merge/ghi GitHub: guard lỗi giữa chừng với lệnh này thì hỏi thay vì cho qua (fail-closed cho merge).
MERGE_CMD_RE = re.compile(r"\bgh\s+(pr\b.*\bmerge|api)\b", re.S)


def _failure_decision(mode: str, payload: object, cmd: object) -> Dict[str, object]:
    """Quyết định khi guard ném lỗi: fail-open về luồng (ADR-0002), trừ merge/`gh api` và tool MCP merge (payload đọc
    được — stdin rác không phải lời gọi tool, LOOP-HARNESS-018) → hỏi; tool MCP ghi PR/commit khác cho qua (D-057)."""
    tool = payload.get("tool_name") if isinstance(payload, dict) else None
    if (mode == "mcp" and isinstance(tool, str) and MCP_MERGE_RE.fullmatch(tool)) or (
        mode == "bash" and isinstance(cmd, str) and MERGE_CMD_RE.search(cmd)
    ):
        return {
            "decision": "ask",
            "reason": f"guard lỗi khi kiểm merge/ghi GitHub — {UNVERIFIED_ASK}",
            "code": UNPARSED,
            "confidence": "unsure",
        }
    return {"decision": ""}


NUL_FIELDS = ("decision", "reason", "commit", "no_verify", "commit_dir")


def _sh_field(v: object) -> str:
    """Giá trị cho hook bash: bool → `true`/`false` (như `json_field` cũ), thiếu → rỗng; NUL trong chuỗi bị bỏ."""
    if isinstance(v, bool):
        return "true" if v else "false"
    return "" if v is None else str(v).replace("\0", "")


def _rule_decision(mode: str, payload: Any, root: str) -> Dict[str, object]:
    """Kết quả bộ luật cho một payload hook theo chế độ bash|edit|mcp; chế độ khác → không phản đối. Payload được làm
    sạch trước (surrogate lẻ, NUL — AUD-SEC-077) để lý do in ra cũng ghi được."""
    payload = clean_payload(payload)
    tool_input = payload.get("tool_input") or {}
    if mode == "bash":
        cmd = tool_input.get("command")
        cwd = payload.get("cwd")
        cwd = cwd if isinstance(cwd, str) and posixpath.isabs(cwd) else None
        return bash_decision(cmd, root, cwd) if isinstance(cmd, str) and cmd else {"decision": ""}
    if mode == "edit":
        path = tool_input.get("file_path")
        d, r = edit_decision(path, root, tool_input) if isinstance(path, str) and path else ("", "")
        return {"decision": d, "reason": r}
    if mode == "mcp":
        name = payload.get("tool_name")
        d, r = mcp_decision(name, tool_input, root) if isinstance(name, str) else ("", "")
        return {"decision": d, "reason": r}
    return {"decision": ""}


def _payload_cmd(payload: Any) -> object:
    """`tool_input.command` nếu payload đọc được (cho quyết định khi guard lỗi giữa chừng)."""
    ti = payload.get("tool_input") if isinstance(payload, dict) else None
    return ti.get("command") if isinstance(ti, dict) else None


def main() -> int:
    """`guard.py bash|edit|mcp [nul]` cho PreToolUse; `guard.py permission` cho PermissionRequest (chế độ suy từ
    `tool_name`; in JSON của hook hoặc không in gì)."""
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    payload: Any = None
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if mode == "permission":
            mode = permission_mode(payload.get("tool_name"))
        out = _rule_decision(mode, payload, os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    except Exception:  # fail-open về luồng: lỗi của hook không được kẹt phiên — trừ merge (AUD-SEC-032)
        out = _failure_decision(mode, payload, _payload_cmd(payload))
    # strict = hành vi cũ (hỏi): chỉ chặt hơn, không phải công tắc tắt hook.
    if os.environ.get("XT_GUARD_POLICY") != "strict":
        out = apply_policy(out)
    if sys.argv[1:2] == ["permission"]:
        sys.stdout.write(permission_output(out))
    elif sys.argv[2:3] == ["nul"]:
        sys.stdout.write("".join(f"{v}\0" for v in ["ok", *(_sh_field(out.get(k)) for k in NUL_FIELDS)]))
    else:
        sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
