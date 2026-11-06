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
import bisect
import contextlib
import contextvars
import fnmatch
import functools
import itertools
import json
import os
import posixpath
import re
import shlex
import stat
import subprocess
import urllib.parse
import sys
import tempfile
import time
import unicodedata
from typing import Any, Callable, Dict, FrozenSet, Iterator, List, NamedTuple, Optional, Set, Tuple, cast

# `busybox <applet>`/`toybox <applet>`: applet là lệnh thật (`busybox sh`, `toybox rm …` — AUD-SEC-332/341)
WRAPPERS = {"command", "builtin", "exec", "nohup", "time", "nice", "stdbuf", "xargs", "timeout", "setsid", "busybox"}
WRAPPERS |= {"toybox"}
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
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "fish", "mksh", "ash"}  # mksh khớp cả `STRICT_SH` (AUD-SEC-332)
# Shell họ khác cũng đọc script từ stdin/`-c` (AUD-SEC-341): quét như bash là chiều chặt (cú pháp csh khác — lệnh nguy
# hiểm vẫn là lệnh nguy hiểm); `STRICT_SH` liệt kê cùng tập. `rbash` (bash hạn chế, symlink tới bash trên Debian/
# Ubuntu), `osh`/`ysh` (Oils) — review lượt 2.
SHELLS |= {"hush", "yash", "posh", "oksh", "loksh", "lksh", "pdksh", "csh", "tcsh", "rbash", "osh", "ysh"}
INTERPRETERS = SHELLS | {"python", "python3", "node", "perl", "ruby", "php", "deno", "bun", "pwsh"}
FETCHERS = {"curl", "wget"}
MAIN_BRANCHES = {"main", "master"}
# Tuỳ chọn toàn cục của git theo `handle_options` (git.c, đối chiếu v2.43.0 và master ngày 2026-10-28 — D-216). Ăn
# token kế làm giá trị: thiếu một tên là giá trị bị coi là lệnh con, mọi luật git bỏ qua (`git --attr-source HEAD push
# --force …`). `--exec-path` trần in đường dẫn rồi thoát — giá trị chỉ ở dạng `--exec-path=…`, không ăn token kế.
GIT_OPTS_WITH_VALUE = {
    *("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--shallow-file", "--attr-source"),
}
# Tuỳ chọn dài nhận giá trị dạng `--opt=v` (git không nhận `--shallow-file=v` — lỗi, vô hại) và cờ dài không giá trị
# (`--no-lazy-fetch`, `--no-advice` của git sau 2.43). Tuỳ chọn `--…` ngoài hai tập này đứng trước lệnh con → guard không
# biết nó có ăn token kế không: UNRESOLVED_TARGET (fail-closed, `_git_unknown_global`).
GIT_LONG_OPTS_EQ = {o for o in GIT_OPTS_WITH_VALUE if o.startswith("--")} | {"--exec-path", "--list-cmds"}
GIT_LONG_FLAGS = {
    *("--help", "--version", "--exec-path", "--html-path", "--man-path", "--info-path", "--paginate", "--no-pager"),
    *("--no-replace-objects", "--bare", "--literal-pathspecs", "--no-literal-pathspecs", "--glob-pathspecs"),
    *("--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch", "--no-advice"),
}
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


def _glob_is_ledger(rel: str) -> bool:
    """Đích ghi là glob mà shell bung ra được sổ giai đoạn (`docs/autopilot/*`, `STAGE.jso?` — AUD-SEC-248): khớp từng cấp."""
    if not any(c in rel for c in "*?["):
        return False
    parts, want = rel.split("/"), STAGE_LEDGER.split("/")
    return len(parts) == len(want) and all(map(fnmatch.fnmatchcase, want, parts))


def classify_path(rel: str) -> str:
    """'secret' | 'gate' | 'evidence' | 'capability' | 'migration' | ''."""
    if rel == ".autopilot" or rel.startswith(".autopilot/") or rel == STAGE_LEDGER or _glob_is_ledger(rel):
        return (
            "evidence"  # bằng chứng + trạng thái vòng/giai đoạn: chỉ `xt.py loop|stage …` ghi (AUD-HAR-024, ADR-0058)
        )
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
# AUD-SEC-429: cả `config.worktree` (git đọc khi `extensions.worktreeConfig` bật — `core.hooksPath` lấy từ đó, git 2.43)
GIT_HOOK_PATTERNS = (
    ".git/hooks",
    ".git/hooks/*",
    ".git/config",
    ".git/config.worktree",
    ".git/worktrees/*/config.worktree",
    # D-366 (AUD-SEC-523): ref theo dõi remote — `perf trial` ngoại tuyến đọc `refs/remotes/origin/HEAD` làm gốc vòng
    ".git/packed-refs",
    ".git/refs/remotes",
    ".git/refs/remotes/*",
)
GIT_HOOK_WHY = (
    "ghi {} — git hook/cấu hình git/ref theo dõi remote không vào commit, sửa là bỏ qua hook của dự án; người làm tay"
)
# AUD-SEC-424: cấu hình git toàn cục/hệ thống mang cùng khoá chạy lệnh/hooksPath như `.git/config` (`diff.external`,
# `core.hooksPath`, `alias.x = !…`, `core.fsmonitor`) — git đọc `$HOME/.gitconfig`, `$XDG_CONFIG_HOME/git/config`
# (mặc định `~/.config/git/config`), `/etc/gitconfig` (git-config(1) FILES). Ghi thô (chuyển hướng/trình ghi) vào MỌI tệp
# tên `.gitconfig` hay đuôi `git/config` (cả HOME giả `HOME=/tmp/h` có `/tmp/h/.gitconfig`) → như ghi `.git/config`.
# AUD-SEC-428: cả `$(prefix)/etc/gitconfig` (git-config(1) FILES: "System-wide configuration file" — `/usr/local/etc/`,
# `/opt/homebrew/etc/`). Review #432: KHÔNG miễn tệp trong cây dự án — `HOME=$PWD`/`~+`/symlink tới HOME biến tệp dự án
# thành cấu hình toàn cục mà guard không theo được hết.
GLOBAL_GIT_CONFIG_RE = re.compile(r"(?:^|/)(?:\.gitconfig|git/config|etc/gitconfig)$")
GIT_CONFIG_ENV_RE = re.compile(r"(?<![\w$])GIT_CONFIG_(?:GLOBAL|SYSTEM)=(\S+)")  # tệp cấu hình chỉ định bằng biến
GIT_CONFIG_NULL = "/dev/null"  # AUD-SEC-426: chỉ đúng `/dev/null` (rỗng) — `/dev/fd/N` là tệp thật (review #432)


def _global_git_config(path: str) -> bool:
    return bool(path) and bool(GLOBAL_GIT_CONFIG_RE.search(_norm_path(path)))


def _git_config_env_asks(tokens: List[str], commands: List[Tuple[List[str], Optional[str]]], root: str) -> List[str]:
    """AUD-SEC-424: lệnh đặt `GIT_CONFIG_GLOBAL=F`/`GIT_CONFIG_SYSTEM=F` và ghi F trong cùng lệnh Bash — đích ghi xét cả
    dạng đã giải theo thư mục đang đứng (`cd /tmp && printf x > gc`, review #431). `/dev/null` không là tệp cấu hình
    (AUD-SEC-426) — chỉ đúng `/dev/null`, `/dev/fd/3` vẫn tính."""
    files = {_norm_path(_dequote(m[1])) for t in tokens for m in [GIT_CONFIG_ENV_RE.match(t)] if m}
    files.discard(GIT_CONFIG_NULL)
    links = _git_config_links(commands, root)  # AUD-SEC-435: `ln -s ~/.gitconfig lnk` rồi ghi `lnk`
    if not files and not links:
        return []
    hits = [
        w
        for argv, here in commands
        for w in write_targets(normalize(argv), argv)
        if w
        and _norm_path(w) != GIT_CONFIG_NULL
        # AUD-SEC-438: `ln` không tự khớp đích link của CHÍNH nó, nhưng `ln -sf X gc` thay tệp `GIT_CONFIG_GLOBAL` vẫn tính
        and {_norm_path(x) for x in [w, *_where(w, root, here)]} & (files | (set() if _is_ln(argv) else links))
    ]
    return [GIT_HOOK_WHY.format(w) for w in hits]


def _is_ln(argv: List[str]) -> bool:
    return normalize(argv)[:1] == ["ln"]


# AUD-SEC-434 (D-337): luật PHÍA ĐỌC — biến làm git đọc TỆP cấu hình/hook/lệnh con khác (tệp có thể đã ghi ở lệnh Bash
# TRƯỚC, guard không thấy): `HOME`, `XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL|SYSTEM` (trừ đúng `/dev/null`); AUD-SEC-439:
# `GIT_DIR`, `GIT_COMMON_DIR` (cấu hình của thư mục git khác — trừ `.git` của dự án); AUD-SEC-440: `GIT_TEMPLATE_DIR`
# (hook mẫu), `GIT_EXEC_PATH` (lệnh con git) — gán đầu lệnh, `env VAR=`, `export`/`declare -x`/gán trần trước đó.
# AUD-SEC-446: `GIT_OBJECT_DIRECTORY` làm Git nhận repo trần ngay cả khi không có thư mục `objects` tại chỗ.
# Giá trị một lần (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT|KEY_n|VALUE_n`) guard đọc được và đã xét bằng luật khoá
# (`_commit_hooks_path`, `_git_exec_config`, alias — AUD-SEC-352, review #306), D-337.
GIT_READ_ENV_RE = re.compile(
    r"HOME|XDG_CONFIG_HOME|GIT_CONFIG_(?:GLOBAL|SYSTEM)|GIT_DIR|GIT_COMMON_DIR|GIT_TEMPLATE_DIR|GIT_EXEC_PATH"
    r"|GIT_OBJECT_DIRECTORY"
)
GIT_DIR_VARS = ("GIT_DIR", "GIT_COMMON_DIR")
GIT_HOOK_SUBCMDS = frozenset("commit push merge rebase am cherry-pick revert".split())  # lệnh con chạy git hook
GIT_CFG_ENV_ASK = (
    "git {} với biến cấu hình git ({}) — tệp cấu hình khác có thể bỏ git hook (AUD-SEC-434); cần người xác nhận"
)
GIT_CFG_ENV_WHY = (
    "lệnh git chạy với biến/cờ trỏ tệp cấu hình, hook hay lệnh con git khác (`HOME`, `XDG_CONFIG_HOME`,"
    " `GIT_CONFIG_GLOBAL|SYSTEM`, `GIT_DIR`/`--git-dir`, `GIT_TEMPLATE_DIR`/`--template`, `GIT_EXEC_PATH`/`--exec-path`,"
    " `GIT_OBJECT_DIRECTORY`)"
    " — git đọc tệp guard không thấy (khoá chạy lệnh, hooksPath — AUD-SEC-434/439/440, D-337); viết lại: bỏ gán biến/cờ"
    " đó (cô lập bằng `GIT_CONFIG_GLOBAL=/dev/null` nếu cần)"
)


def _own_git_dir(value: str, root: str, cwd: Optional[str]) -> bool:
    """`.git` của dự án (`$ROOT/.git`, `.git` khi đứng ở gốc). AUD-SEC-452: chuẩn hoá `/` thừa, `./` (`$ROOT/.git/`)
    trước khi so — không chuẩn hoá `..` (symlink làm `x/..` khác thư mục chữ)."""
    path = _dequote(value)
    if path and ".." not in path.split("/"):
        path = _norm_path(path)
    own = posixpath.join(root, ".git")
    return bool(root) and (path in (own, _norm_path(own)) or (path in (".git", "./.git") and cwd == root))


def _git_cfg_vars(env: Dict[str, str], root: str, cwd: Optional[str]) -> List[str]:
    """Tên biến cấu hình git trong `env` (AUD-SEC-434); không tính: `GIT_CONFIG_GLOBAL|SYSTEM=/dev/null`; `GIT_DIR`/
    `GIT_COMMON_DIR` là `.git` của dự án. `HOME`/`XDG_CONFIG_HOME` LUÔN tính — review #434 thu hồi miễn 438c
    (`GIT_CONFIG_GLOBAL=/dev/null` có thể không tới git: `env -u`, `env -i`, `export -n`, `unset`, subshell…)."""

    def null(k: str) -> bool:
        return k in env and env[k] != GIT_CFG_DYN and _norm_path(_dequote(env[k]) or "x") == GIT_CONFIG_NULL

    return sorted(
        k
        for k, v in env.items()
        if GIT_READ_ENV_RE.fullmatch(k)
        and not (k in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM") and null(k))
        and not (k in GIT_DIR_VARS and _own_git_dir(v, root, cwd))
    )


def _git_cfg_opts(s: List[str], root: str, cwd: Optional[str]) -> List[str]:
    """Cờ của lệnh git `s` (đã bỏ tiền tố) trỏ tệp cấu hình/hook/lệnh con khác: `--git-dir` (khác `.git` của dự án —
    AUD-SEC-439), `--exec-path=X`, `init|clone --template[=]X` (AUD-SEC-440)."""
    opts = _git_globals(s)
    out = [o for o, v in opts if o == "--git-dir" and not _own_git_dir(v, root, cwd)]
    # AUD-SEC-442: một override, kể cả rỗng, có thể đổi chương trình Git tìm thấy.
    out += ["--exec-path" for o, _ in opts if o == "--exec-path="]
    n = normalize(s)
    if n[1:2] and n[1] in ("init", "clone") and any(a == "--template" or a.startswith("--template=") for a in n[2:]):
        out.append("--template")
    return out


GIT_CFG_NAMES = (
    "HOME",
    "XDG_CONFIG_HOME",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_TEMPLATE_DIR",
    "GIT_EXEC_PATH",
    "GIT_OBJECT_DIRECTORY",
)
GIT_CFG_NAME_RE = re.compile(  # lọc nhanh trên chữ thô
    r"HOME|XDG_CONFIG_HOME|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_DIR|GIT_COMMON_DIR|GIT_TEMPLATE_DIR|GIT_EXEC_PATH"
    r"|GIT_OBJECT_DIRECTORY|--git-dir|--exec-path|--template"
)
GIT_CFG_VAR_HEADS = frozenset({"read", "mapfile", "readarray", "getopts"})  # nhận TÊN biến làm đối số
GIT_CFG_DYN = "$?"  # giá trị không biết (đặt bằng `for`/`read`/`printf -v`/`eval`)


def _git_cfg_set(words: List[str]) -> Dict[str, str]:
    """Biến cấu hình git mà lệnh đơn đặt ngoài phép gán trần (review #433 R2b): `for V in`, `read V`, `printf -v V`,
    `wait -p V`, `eval '…V=…'` → giá trị không biết."""
    if words[:1] in (["for"], ["select"]):
        return {words[1]: GIT_CFG_DYN} if words[1:2] and words[1] in GIT_CFG_NAMES else {}
    head, args = (posixpath.basename(words[0]), words[1:]) if words else ("", [])
    names = [a for a in args if a in GIT_CFG_NAMES] if head in GIT_CFG_VAR_HEADS else []
    flag = HOME_VAR_FLAG_HEADS.get(head)
    names += [w for p, w in zip(args, args[1:]) if flag and p == flag and w in GIT_CFG_NAMES]
    names += [v for v in GIT_CFG_NAMES for a in args if head == "eval" and re.search(rf"(?<![\w$]){v}\+?=", a)]
    return dict.fromkeys(names, GIT_CFG_DYN)


def _git_cfg_body_git(s: List[str]) -> bool:
    """Lệnh `sh|bash -c BODY`/`eval BODY` mà BODY có lệnh git (R2c: gán tiền tố đi vào shell con)."""
    bodies = [b for b in [_shell_c_script(s)] if b] + (_eval_scripts(s) if s[:1] == ["eval"] else [])
    return any(normalize(cc)[:1] == ["git"] for b in bodies for cc in split_commands(tokenize(b)))


def _git_cfg_env_why(cmd: str, root: str = "", cwd: Optional[str] = None) -> str:
    """AUD-SEC-434: lệnh git (mọi lệnh con — review #433 R1; câu hỏi/cờ bỏ hook ở `_scan_command`) có biến cấu hình git;
    lọc trên token đã chuẩn hoá (`g''it`), cả phép gán qua `for`/`read`/`printf -v`/`eval` và gán tiền tố đi vào
    `sh -c`/`eval` có git (review #433 R2)."""
    if not GIT_CFG_NAME_RE.search(cmd):
        return ""
    env: Dict[str, str] = {}
    for c, here in _commands_each_cwd(tokenize(cmd), cwd):  # mọi thư mục ứng viên (D-347)
        c = list(itertools.dropwhile(lambda t: t in SHELL_KEYWORDS, c))  # `do git …`, `then git …`
        s = _strip_prefixes(c)
        env.update(_git_cfg_set(s))
        if not s or s[0] in DECLARE_CMDS:
            env.update(_assign_values(c))
            continue
        is_git = normalize(c)[:1] == ["git"]
        git_cwd = _git_dir(c, here) if is_git else None
        risky = _git_cfg_vars({**env, **_assign_values(c[: len(c) - len(s)])}, root, git_cwd)
        if risky and (is_git or _git_cfg_body_git(s)):
            return GIT_CFG_ENV_WHY
        if is_git and _git_cfg_opts(s, root, git_cwd):
            return GIT_CFG_ENV_WHY
    return ""


def _git_cfg_hook_ask(
    n: List[str],
    argv: List[str],
    env: Dict[str, str],
    res: Dict[str, object],
    asks: List[str],
    root: str,
    cwd: Optional[str],
) -> None:
    """AUD-SEC-434 (D-336): commit/push/merge… với biến cấu hình git (`env` của chuỗi + gán đầu lệnh) = có thể bỏ git
    hook — như `--no-verify`: cờ `no_verify`/`push_no_verify` và câu hỏi."""
    if n[:1] != ["git"] or not n[1:2] or n[1] not in GIT_HOOK_SUBCMDS:
        return
    s = _strip_prefixes(argv)
    git_cwd = _git_dir(argv, cwd)
    cfg_vars = _git_cfg_vars({**env, **_assign_values(argv[: len(argv) - len(s)])}, root, git_cwd)
    cfg_vars += _git_cfg_opts(s, root, git_cwd)
    if cfg_vars:
        res["no_verify"] = True
        res["push_no_verify"] = bool(res.get("push_no_verify")) or n[1] == "push"
        asks.append(GIT_CFG_ENV_ASK.format(n[1], ", ".join(cfg_vars)))


def _real_targets(t: str, root: str, cwd: Optional[str]) -> List[str]:
    """Realpath của các đích có thể (`_where`, `~` mở) — khác đích thì là qua symlink (AUD-SEC-435)."""
    out = []
    for x in _where(t, root, cwd):
        p = os.path.expanduser(x)
        if p.startswith("/") and "$" not in p:
            r = _realpath_safe(p)
            out += [r] if r != _norm_path(p) else []
    return out


def _realpath_safe(p: str) -> str:
    """`os.path.realpath`; tên không mã hoá được (surrogate) hay lỗi hệ tệp → giữ nguyên (fail-open về luồng)."""
    try:
        return os.path.realpath(p)
    except (OSError, ValueError):
        return p


# Phần đuôi từ thư mục cha tới tệp cấu hình git: `/etc`+`gitconfig`, `~`+`.gitconfig`/`.config/git/config`,
# `~/.config`+`git/config`, `~/.config/git`+`config` (review #433 R3)
GIT_CFG_TAILS = ("gitconfig", ".gitconfig", ".config/git/config", "git/config", "config")


def _git_config_links(commands: List[Tuple[List[str], Optional[str]]], root: str) -> Set[str]:
    """Đường dẫn của symlink mà `ln -s NGUỒN ĐÍCH` trong lệnh tạo tới tệp cấu hình git (đích, và đích/tên nguồn khi
    đích là thư mục) — dạng nguyên văn và đã giải theo thư mục đang đứng (AUD-SEC-435)."""
    out: Set[str] = set()
    for argv, here in commands:
        n = normalize(argv)
        if n[:1] != ["ln"]:
            continue
        symbolic = any(a[:1] == "-" and a[1:2] != "-" and "s" in a for a in n[1:]) or "--symbolic" in n
        pos = _positionals(n[1:], ("-t", "--target-directory", "-S", "--suffix"))
        src, dsts = (pos[0], pos[1:]) if len(pos) > 1 else (pos[0], ["."]) if pos else ("", [])
        if not src:
            continue
        # AUD-SEC-440: link CỨNG tới tệp cấu hình (toàn cục hay `.git/config` của repo) cũng ghi chung nội dung
        is_cfg = _global_git_config(src) or bool(REPO_GIT_CONFIG_RE.search(_norm_path(src)))
        # review #433 R3: NGUỒN là thư mục cha của tệp cấu hình (`/etc`, `$(prefix)/etc`, `~/.config/git`) → `ĐÍCH/<đuôi>`
        tails = [t for t in GIT_CFG_TAILS if _global_git_config(posixpath.join(src, t))] if symbolic else []
        cands = dsts + [posixpath.join(x, posixpath.basename(src)) for x in dsts]
        cands = cands if is_cfg else [posixpath.join(x, t) for x in cands for t in tails]
        for d in cands:
            out |= {_norm_path(x) for x in [d, *_where(d, root, here)]}
    return out


REPO_GIT_CONFIG_RE = re.compile(r"(?:^|/)\.git/(?:config|config\.worktree|worktrees/[^/]+/config\.worktree)$")
GIT_METADATA_TAIL_RE = re.compile(
    r"/(?=(?:config(?:\.worktree)?|commondir|hooks(?:/.*)?|worktrees/[^/]+/config\.worktree|packed-refs"
    r"|refs/remotes(?:/.*)?)$)"
)
GIT_KEYED_TAIL_RE = re.compile(r"/(?:config(?:\.worktree)?|worktrees/[^/]+/config\.worktree)")  # tệp cấu hình


def _git_metadata_dir(path: str, objdir: Optional[bool] = None) -> bool:
    """Nhận Git dir trần, tách riêng và worktree bằng cấu trúc metadata thay vì tên thư mục `.git`. `objects` chỉ cần tồn
    tại ở mọi dạng — git chỉ kiểm `access(objects, X_OK)`, tệp thường có bit chạy cũng qua (review #435 R1); nhận rộng
    hơn git chỉ làm guard canh thêm tệp `config`/`hooks` cạnh `HEAD` (hướng an toàn). AUD-SEC-496: có
    `GIT_OBJECT_DIRECTORY` (`objdir`; None = môi trường guard thừa hưởng) git kiểm biến đó thay `objects` — `HEAD` +
    `refs` là đủ."""
    objdir = OBJECT_DIR_ENV in os.environ if objdir is None else objdir
    marks = ("objects", "refs") if objdir else ("objects",)
    return os.path.lexists(os.path.join(path, "HEAD")) and (
        any(os.path.lexists(os.path.join(path, m)) for m in marks) or os.path.isfile(os.path.join(path, "commondir"))
    )


OBJECT_DIR_ENV = "GIT_OBJECT_DIRECTORY"


GIT_HEADREF_RE = re.compile(rb"ref:\s*refs/|[0-9a-fA-F]{40}")  # `validate_headref`: ref tượng trưng hay mã băm


def _git_dir_accepted(path: str) -> bool:
    """AUD-SEC-487: `path` chắc là Git dir mà git DỪNG DÒ ở đó (`is_git_directory`, đo git 2.53): HEAD hợp lệ (symlink
    tới `refs/…`, tệp thường `ref: refs/…` hay mã băm hex), `objects` và `refs` vào được. Hẹp hơn git (commondir, tệp
    đặc biệt → False) — chỉ dùng để MIỄN; nhận diện rộng là `_git_metadata_dir`."""
    with contextlib.suppress(OSError):
        heads = _git_headref_ok(os.path.join(path, "HEAD"))
        return heads and all(os.access(os.path.join(path, d), os.X_OK) for d in ("objects", "refs"))
    return False


def _git_headref_ok(head: str) -> bool:
    """`validate_headref` của git: symlink tới `refs/…`, hay tệp thường bắt đầu bằng `ref: refs/…`/mã băm hex. Tệp đặc
    biệt (FIFO…) không mở — guard không treo; coi là không hợp lệ."""
    if os.path.islink(head):
        return os.readlink(head).startswith("refs/")
    if not os.path.isfile(head):
        return False
    with open(head, "rb") as file:
        return bool(GIT_HEADREF_RE.match(file.read(255)))


def _stops_git_discovery(dot_git: str) -> bool:
    """`.git` làm git dừng dò lên trên/không xét thư mục chứa nó như repo trần: gitfile (kể cả hỏng — git báo lỗi) hay
    Git dir hợp lệ (`_git_dir_accepted`)."""
    return os.path.isfile(dot_git) or _git_dir_accepted(dot_git)


def _repo_git_metadata(path: str, root: str, keyed: bool = False) -> bool:
    """AUD-SEC-445/446: đích ghi nằm trong Git dir có thật, kể cả dir trần bên ngoài dự án. `keyed`: đích là tệp của
    `git config --file` — bỏ qua đuôi tệp cấu hình (luật khoá của git config xét, như `git -C <dir> config` — AUD-SEC-452);
    đuôi hook/commondir vẫn tính."""
    absolute = os.path.normpath(os.path.join(root, os.path.expanduser(path)))
    return any(
        _git_metadata_dir(absolute[: m.start()] or "/")
        and not (keyed and GIT_KEYED_TAIL_RE.fullmatch(absolute, m.start()))
        for m in GIT_METADATA_TAIL_RE.finditer(absolute)
    )


def _git_dir_pointer(path: str, prefix: bytes = b"") -> str:
    """Đọc gitfile hoặc commondir của worktree, không mở tệp đặc biệt hay đọc quá 4 KiB."""
    with contextlib.suppress(OSError, ValueError):
        if os.path.isfile(path):
            with open(path, "rb") as file:
                raw = file.read(4097).rstrip(b"\r\n")
            if raw.startswith(prefix) and len(prefix) < len(raw) <= 4096:
                return os.path.join(os.path.dirname(path), os.fsdecode(raw[len(prefix) :]))
    return ""


def _project_dotgit(root: str) -> str:
    """`.git` mà git dùng cho dự án: dò từ gốc lên cha như git (AUD-SEC-450 — dự án `mono/apps/web` trong repo cha
    `mono/`); không ceiling — canh thêm là hướng an toàn. Không thấy → `$ROOT/.git` như cũ."""
    directory = _realpath_safe(os.path.abspath(root))  # gốc qua symlink: git dò theo đường vật lý (review #438)
    while True:
        dot_git = os.path.join(directory, ".git")
        if os.path.lexists(dot_git):
            return dot_git
        parent = os.path.dirname(directory)
        if parent == directory:
            return os.path.join(root, ".git")
        directory = parent


def _git_config_inodes(root: str) -> Set[Tuple[int, int]]:
    """Inode của cấu hình Git và gitfile, commondir, hook của dự án (AUD-SEC-440/443/447), kể cả repo cha (AUD-SEC-450)."""
    xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    paths = [os.path.expanduser("~/.gitconfig"), os.path.join(xdg, "git", "config"), "/etc/gitconfig"]
    paths += ["/usr/local/etc/gitconfig", "/opt/homebrew/etc/gitconfig"]
    dotgit = _project_dotgit(root)
    gitdir = _git_dir_pointer(dotgit, b"gitdir: ") or dotgit
    common_file = os.path.join(gitdir, "commondir")
    common = _git_dir_pointer(common_file) or gitdir
    paths += [dotgit, common_file, os.path.join(common, "config"), os.path.join(gitdir, "config.worktree")]
    with contextlib.suppress(OSError, ValueError), os.scandir(os.path.join(common, "hooks")) as hooks:
        paths.extend(hook.path for hook in hooks)
    out: Set[Tuple[int, int]] = set()
    for p in paths:
        with contextlib.suppress(OSError, ValueError):
            st = os.stat(p)
            out.add((st.st_dev, st.st_ino))
    return out


def _hardlink_git_config(path: str, root: str) -> bool:
    """`path` có thật, `st_nlink > 1` và cùng inode với tệp Git được bảo vệ."""
    try:
        st = os.stat(os.path.expanduser(path))
    except (OSError, ValueError):
        return False
    return stat.S_ISREG(st.st_mode) and st.st_nlink > 1 and (st.st_dev, st.st_ino) in _git_config_inodes(root)


def _git_hook_target(path: str, root: str, keyed: bool = False) -> bool:
    """Đích hook/cấu hình git, kể cả đường dẫn vật lý qua symlink hoặc hard link. `keyed`: tệp của `git config --file`
    (`_repo_git_metadata`, AUD-SEC-452)."""
    path = os.path.expanduser(path)
    real = rel_path(path, root)
    return (
        _match_any(_norm_path(path), GIT_HOOK_PATTERNS)
        or _match_any(real, GIT_HOOK_PATTERNS)
        or _repo_git_metadata(real, root, keyed)
        or _hardlink_git_config(os.path.join(root, path), root)
    )


def _git_dir_target(path: str, root: str) -> bool:
    """AUD-SEC-449: `path` là chính một Git dir có thật (trần, tách riêng, worktree — `_git_metadata_dir`): trình ghi đặt
    tệp vào đó (`cp f gd/`, `tar -C gd`) ghi được `config`/`hooks` như `.git` của dự án."""
    p = os.path.expanduser(path)  # realpath trên đường thô: `lnk/../../bare` theo symlink như kernel (review #438)
    return "$" not in p and _git_metadata_dir(_realpath_safe(os.path.join(root, p)))


def _gitfile_target(path: str, root: str) -> bool:
    path = os.path.expanduser(path)
    return posixpath.basename(_norm_path(path)) == ".git" or posixpath.basename(rel_path(path, root)) == ".git"


def edit_decision(path: str, root: str, tool_input: Optional[Dict[str, object]] = None) -> Tuple[str, str]:
    rel = rel_path(path, root)
    kind = path_kind(rel, root)
    bypass = _bypass_edit(path, tool_input)
    if bypass:
        return "deny", f"Không ghi công tắc tắt hook (`{bypass}`) vào {rel} — hàng rào của khung (ADR-0018)."
    if (
        _gitfile_target(path, root)
        or _global_git_config(path)
        or _global_git_config(_realpath_safe(path))
        or _git_hook_target(path, root)
    ):
        return "deny", GIT_HOOK_WHY.format(rel) + "."
    if kind == "capability":
        return "ask", "Sửa cấu hình " + CAPABILITY_WHY.format(rel) + "."
    if kind == "secret" and not build_local_secret(path, root, root):
        return "deny", f"Không ghi file bí mật qua agent: {rel} (dùng secret manager/biến môi trường)."
    if kind == "gate":
        return (
            "ask",
            f"Sửa cấu hình cổng/CI/harness ({rel}). Khung coi đây là điểm dừng: nói rõ lý do trước khi nới hàng rào.",
        )
    if kind == "evidence":
        return "ask", (
            f"Ghi tay bằng chứng/trạng thái autopilot ({rel}) = bằng chứng giả (P1, ADR-0026). Dùng `xt.py loop …`/"
            "`xt.py stage …`/`xt.py pr reviewed`; cần sửa tay thì người làm."
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


class ScanTooComplex(Exception):
    """Guard không phân định được bash đọc lệnh thế nào → `bash_decision` chặn (fail-closed, mã BUDGET), không đoán.
    Heredoc theo danh sách cho phép (D-270): `<<` mà bash có thể đọc là heredoc nhưng ngoài dạng guard hiểu → lỗi này."""


# Heredoc guard hiểu (D-270): `<<`/`<<-`, khoảng trắng, dấu kết `[A-Za-z0-9_.-]+` trần, bọc trọn `'…'`/`"…"` hay một
# `\` đầu, rồi hết từ (ký tự meta hay cuối dòng). Dạng khác (`$`, backtick, nháy pha, `\` giữa từ, Unicode…) → chặn.
HERE_WORD = r"[A-Za-z0-9_.-]+"
HEREDOC_RE = re.compile(
    rf"<<-?[ \t]*(?:({HERE_WORD})|'({HERE_WORD})'|\"({HERE_WORD})\"|\\({HERE_WORD}))(?=[ \t;&|()<>]|$)"
)
HERE_WORD_HINT_RE = re.compile(r"<<-?[ \t'\"\\]*([A-Za-z0-9_.-]+)")  # từ có thể là dấu kết, kể cả trong chuỗi lồng
HERE_WORD_RUN_RE = re.compile(r"[A-Za-z0-9_.-]+")  # dãy ký tự có thể của dấu kết ở đầu dòng (`_paren_terminator`)
CODE_PLAIN_RE = re.compile(r"[^\\'\"`$()<>#]+")
CASE_WORD_RE = re.compile(r"(?:^|[\s;&|])case(?=\s|$)")
ARRAY_BAD_RE = re.compile(r"[;|&<>]|(?<!\$)\(")  # trần trong gán mảng `x=(…)`: bash báo lỗi rồi bỏ cả dòng
DQ_PLAIN_RE = re.compile(r'[^"\\$`]+')
ANSI_PLAIN_RE = re.compile(r"[^'\\]+")
TICK_PLAIN_RE = re.compile(r"[^`\\'\"$<]+")
BRACE_PLAIN_RE = re.compile(r"[^}{\\'\"`$<]+")
ARITH_PLAIN_RE = {"A(": re.compile(r"[^'\"\\`$()<{}]+"), "A[": re.compile(r"[^'\"\\`$\[\]<{}]+")}
ARITH_PAIR = {"A(": ("(", ")"), "A[": ("[", "]")}
SIMPLE_VAR_RE = re.compile(r"\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9#@?*!$-])")
HERE_OP_RE = re.compile(r"(?<!<)<<(?!<)")  # `<<`/`<<-` có thể là heredoc (không phải `<<<`)
SUBST_KINDS = ("$(", "<(")  # thay lệnh/thay tiến trình: bash đọc heredoc trong đó theo luật tương thích cũ (D-271)
Frame = Tuple[str, int]  # (loại: `(` `$(` `<(` `"` `'` `$'` backtick `${` `A(` `A[`, số ngoặc còn mở của `A…`)
HereSpan = Tuple[int, "re.Match[str]", int, int, bool]  # (dòng mở, match, đầu thân, cuối thân, nằm trong `"$(`)


def _heredoc_word(m: "re.Match[str]") -> Tuple[str, bool]:
    """(dấu kết, có nháy/`\\`) của heredoc khớp `HEREDOC_RE` — có nháy: thân là chữ (không thay `$(…)`/backtick)."""
    return m.group(cast(int, m.lastindex)), m.lastindex != 1


def _arith_end(line: str, k: int, kind: str) -> int:
    """Cuối vùng số học bắt đầu ở `line[k]` (sau `((`/`$((`/`$[`) khi nó đơn giản và đóng trên dòng: chỉ chữ/toán tử/
    `$tên`, ngoặc cân, `((…))` đóng bằng `))` liền (như bash) — `<<` trong đó là dịch bit. Không đơn giản → 0."""
    opener, closer = ARITH_PAIR[kind]
    depth = 0
    while k < len(line):
        var = SIMPLE_VAR_RE.match(line, k)
        run = ARITH_PLAIN_RE[kind].match(line, k) or var
        c = line[k]
        if run or c == "<":
            k = run.end() if run else k + 1
            continue
        if c == opener:
            depth += 1
        elif c != closer:
            return 0
        elif depth:
            depth -= 1
        else:
            return k + 1 if kind == "A[" else (k + 2 if line.startswith("))", k) else 0)
        k += 1
    return 0


class _HereScan:
    """Đọc heredoc theo danh sách cho phép (D-270), một lượt trên mọi dòng: ngăn xếp ngữ cảnh (nháy, `$(`, `(`,
    backtick, `${`, số học) mang qua dòng; thân heredoc bỏ qua theo dòng kết. `<<` trong nháy đơn/kép, comment hay số
    học đơn giản là chữ/dịch bit; `<<` ở chỗ khác ngoài dạng cho phép → `ScanTooComplex`. Gặp chỗ không đọc chắc
    (`case`, gán mảng lỗi cú pháp, nháy/`\\`/thay lệnh trong backtick, `${…}`, số học không đơn giản) → `taint`: lệnh có
    heredoc thì chặn."""

    def __init__(self, lines: List[str]) -> None:
        self.lines = lines
        self.stack: List[Frame] = []
        # `struct[i]`: ngăn xếp tới khung i là ngữ cảnh guard hiểu cho heredoc — cấp ngoài, subshell `(`, thay lệnh `$(`,
        # nháy kép chỉ khi ngay trong nó là `$(` (`-m "$(cat <<'EOF'`); giữ theo push/pop để mỗi lần hỏi O(1)
        self.struct: List[bool] = []
        self.dq = 0  # số khung nháy kép đang mở
        self.subst = 0  # số khung `$(`/`<(` đang mở
        self.taint = False
        self.ops: List[Tuple["re.Match[str]", int]] = []
        self.low = 0  # độ sâu ngăn xếp thấp nhất từ heredoc đầu tiên của dòng
        self.esc = -1  # vị trí ngay sau ký tự thoát `\x` gần nhất
        self.handlers: Dict[str, Callable[[str, int], int]] = {
            "": self._code,
            "(": self._code,
            "$(": self._code,
            "<(": self._code,
            "=(": self._array,
            '"': self._dq,
            "'": self._sq,
            "$'": self._ansi,
            "`": self._tick,
            "${": self._brace,
            "A(": self._arith,
            "A[": self._arith,
        }

    def spans(self) -> List[HereSpan]:
        out: List[HereSpan] = []
        i, ends = 0, _HereEnds(self.lines)
        while i < len(self.lines):
            line, opener, i = self.lines[i], i, i + 1
            start_ok, self.ops, self.esc = self._structural(), [], -1
            j = 0
            while j < len(line):
                j = self.handlers[self.stack[-1][0] if self.stack else ""](line, j)
            self._check_opener(line, start_ok)
            in_dq = self.dq > 0
            for m, _ in self.ops:
                end = ends.find(m, i)
                end = len(self.lines) if end is None else end
                if self.subst:
                    _check_subst_body(self.lines, m, i, end)
                out.append((opener, m, i, end, in_dq))
                i = end + 1
        # `case` trong `$(…)`: mẫu `a)` đóng khung `$(` nên `<<` sau đó bị đọc như chữ — có `<<` ở đâu cũng chặn (D-271)
        if self.taint and any(HERE_OP_RE.search(line) for line in self.lines):
            raise ScanTooComplex("heredoc cùng chỗ guard không đọc chắc (`case`, gán mảng, backtick, `${…}`, số học)")
        return out

    def _check_opener(self, line: str, start_ok: bool) -> None:
        """Dòng mở heredoc phải trọn: đầu dòng, chỗ `<<` và cuối dòng cùng ngữ cảnh cho phép, ngữ cảnh chứa `<<` không
        đóng trên dòng (`(cat <<E)`, `<<E "` → chặn)."""
        depth = len(self.stack)
        if self.ops and (not start_ok or self.low < depth or any(d != depth for _, d in self.ops)):
            raise ScanTooComplex(f"dòng mở heredoc chưa trọn: {line[:80]}")

    def _structural(self) -> bool:
        return not self.struct or self.struct[-1]

    def _push(self, kind: str, j: int, depth: int = 0) -> int:
        dq_below = bool(self.stack) and self.stack[-1][0] == '"'
        below = self.struct[-2] if dq_below and len(self.struct) > 1 else (dq_below or self._structural())
        self.struct.append(kind in ("(", "$(") and below and (kind == "$(" or not dq_below))
        self.stack.append((kind, depth))
        self.dq += kind == '"'
        self.subst += kind in SUBST_KINDS
        return j

    def _pop(self, j: int) -> int:
        kind = self.stack.pop()[0]
        self.dq -= kind == '"'
        self.subst -= kind in SUBST_KINDS
        self.struct.pop()
        self.low = min(self.low, len(self.stack))
        return j

    def _code(self, line: str, j: int) -> int:
        run = CODE_PLAIN_RE.match(line, j)
        if run:  # `case`: mẫu `a)` đóng ngoặc lẻ — ngăn xếp lệch so với bash
            self.taint = self.taint or bool(CASE_WORD_RE.search(run.group()))
            return run.end()
        c = line[j]
        if c == "\\":
            if line.startswith("<<", j + 1):
                raise ScanTooComplex(f"`\\<<` không phân định: {line[j : j + 80]}")
            self.esc = j + 2
            return j + 2
        if c == "#":
            word_start = j == 0 or (line[j - 1] in WORD_END and self.esc != j)
            if word_start and j and line[j - 1] == ")":
                raise ScanTooComplex(PAREN_HASH_WHY)
            return len(line) if word_start else j + 1
        if c == "<":
            return self._lt(line, j)
        if c == "$":
            return self._dollar(line, j, True)
        if c == ">":
            return self._push("<(", j + 2) if line.startswith(">(", j) else j + 1
        if c in "()":
            return self._paren(line, j)
        return self._push(c, j + 1)  # `'`, `"`, backtick

    def _lt(self, line: str, j: int) -> int:
        if line.startswith("<<<", j):
            return j + 3
        if line.startswith("<<", j):
            m = HEREDOC_RE.match(line, j)
            if not m or not self._structural():
                raise ScanTooComplex(f"heredoc ngoài danh sách cho phép: {line[j : j + 80]}")
            if not self.ops:
                self.low = len(self.stack)
            self.ops.append((m, len(self.stack)))
            return m.end()
        return self._push("<(", j + 2) if line.startswith("<(", j) else j + 1

    def _paren(self, line: str, j: int) -> int:
        if line[j] == ")":  # `)` lẻ ở cấp ngoài: lỗi cú pháp, bash dừng ở đó (mẫu `case` đã `taint` ở `_code`)
            return self._pop(j + 1) if self.stack else j + 1
        if j and line[j - 1] == "=":
            return self._push("=(", j + 1)
        if line.startswith("((", j):
            return self._arith_open(line, j, 2, "A(")
        return self._push("(", j + 1)

    def _array(self, line: str, j: int) -> int:
        """Gán mảng `x=(…)`, `declare -a x=(…)`: đọc như mã; `(`, `;`, `|`, `&`, `<`, `>` trần trong đó là lỗi cú pháp
        mà bash -c báo rồi bỏ phần còn lại của dòng — kể cả `<<` sau đó, thân heredoc thành lệnh (`x=((1)) <<X` ↵
        `rm -rf ~` ↵ `X`) → `taint`."""
        end = self._code(line, j)
        self.taint = self.taint or bool(ARRAY_BAD_RE.search(line, j, end))
        return end

    def _arith_open(self, line: str, j: int, n: int, kind: str) -> int:
        end = _arith_end(line, j + n, kind)
        return end or self._push(kind, j + n, 1 if kind == "A[" else 2)

    def _dollar(self, line: str, j: int, code: bool) -> int:
        if line.startswith("$((", j):
            return self._arith_open(line, j, 3, "A(")
        two = line[j : j + 2]
        if two == "$[":
            return self._arith_open(line, j, 2, "A[")
        if two in ("$(", "${") or (code and two == "$'"):
            return self._push(two, j + 2)
        if code and two == '$"':
            return self._push('"', j + 2)
        return j + (2 if two == "$$" else 1)

    def _dq(self, line: str, j: int) -> int:
        run = DQ_PLAIN_RE.match(line, j)
        if run:
            return run.end()
        c = line[j]
        if c == '"':
            return self._pop(j + 1)
        if c == "\\":
            return j + 2
        if c == "`":
            return self._push("`", j + 1)
        return self._dollar(line, j, False)

    def _sq(self, line: str, j: int) -> int:
        k = line.find("'", j)
        return len(line) if k < 0 else self._pop(k + 1)

    def _ansi(self, line: str, j: int) -> int:
        run = ANSI_PLAIN_RE.match(line, j)
        if run:
            return run.end()
        return j + 2 if line[j] == "\\" else self._pop(j + 1)

    def _opaque(self, line: str, j: int, closer: str) -> int:
        """Trong backtick/`${…}`/số học không đơn giản: `closer` đóng; `<<` → chặn; `$tên` được; nháy, `\\`, thay lệnh
        lồng → `taint`."""
        c = line[j]
        if c == closer:
            return self._pop(j + 1)
        if line.startswith("<<", j):
            raise ScanTooComplex(f"`<<` trong backtick/`${{…}}`/số học không đơn giản: {line[j : j + 80]}")
        var = SIMPLE_VAR_RE.match(line, j)
        if var:
            return var.end()
        self.taint = self.taint or c != "<"
        return j + (2 if c == "\\" else 1)

    def _tick(self, line: str, j: int) -> int:
        run = TICK_PLAIN_RE.match(line, j)
        return run.end() if run else self._opaque(line, j, "`")

    def _brace(self, line: str, j: int) -> int:
        run = BRACE_PLAIN_RE.match(line, j)
        return run.end() if run else self._opaque(line, j, "}")

    def _arith(self, line: str, j: int) -> int:
        """Số học không đơn giản/nhiều dòng: đếm ngoặc tới khi đóng; `<<` trong đó → chặn."""
        kind, depth = self.stack[-1]
        run = ARITH_PLAIN_RE[kind].match(line, j)
        if run:
            return run.end()
        opener, closer = ARITH_PAIR[kind]
        c = line[j]
        if c in (opener, closer):
            depth += 1 if c == opener else -1
            self.stack[-1] = (kind, depth)
            return j + 1 if depth else self._pop(j + 1)
        return self._opaque(line, j, opener)  # `opener` đã xét ở trên: chỉ còn `<<`, `$tên`, ký tự làm `taint`


def _check_subst_body(lines: List[str], m: "re.Match[str]", start: int, end: int) -> None:
    """Heredoc trong `$(…)`/`<(…)`: bash 5.2 (tương thích cũ) kết thân ở dòng BẮT ĐẦU bằng dấu kết mà sau đó có `)` —
    phần còn lại của dòng là lệnh (`-m "$(cat <<'EOF'` ↵ `EOF)"; rm -rf ~` ↵ `EOF` ↵ `)"`). Guard không mô phỏng →
    chặn (D-271). Dòng chỉ bắt đầu bằng dấu kết mà không có `)` (`EOF handling`) vẫn là thân."""
    word, tabs = _heredoc_word(m)[0], m.group().startswith("<<-")
    for line in lines[start:end]:
        body = line.lstrip("\t") if tabs else line
        if body.startswith(word) and ")" in body[len(word) :]:
            raise ScanTooComplex(f"dòng thân heredoc trong `$(…)` bắt đầu bằng dấu kết rồi `)`: {line[:80]}")


def _here_scan(cmd: str) -> Tuple[HereSpan, ...]:
    """Heredoc của chuỗi lệnh (`_HereScan`); một quyết định đọc cùng chuỗi nhiều lần (tách token, nguồn thân, lệnh lồng)
    → nhớ vài chuỗi gần nhất."""
    return _here_scan_cached(cmd) if "<<" in cmd else ()


@functools.lru_cache(maxsize=16)
def _here_scan_cached(cmd: str) -> Tuple[HereSpan, ...]:
    return tuple(_HereScan(cmd.split("\n")).spans())


def _joined_terminator(cmd: str) -> bool:
    """Có chuỗi dòng nối bằng `\\` lẻ mà dòng thô cuối chuỗi, hay cả chuỗi đã nối, trông như dấu kết heredoc của
    lệnh không: bash không nối dòng trong thân heredoc có nháy (`foo\\` ↵ `X`: `X` là dòng kết; `X\\` ↵ ``: không) mà
    guard đọc trên chữ đã nối — hai cách đọc lệch nhau đúng ở dòng kết. Từ gợi ý lấy từ cả chuỗi thô lẫn chuỗi đã nối
    (`<\\` ↵ `<'EOF'`, `$\\` ↵ `(cat <<'EOF'`: chỉ chuỗi đã nối có `<<EOF`); dòng thô ngay sau `\\` lẻ bắt đầu bằng dấu
    kết rồi `)` (`foo\\` ↵ `EOF)"; rm -rf ~` — luật `EOF)` của `$(…)` mà guard không thấy vì đã nối) cũng tính (D-272)."""
    words = set(HERE_WORD_HINT_RE.findall(cmd)) | set(HERE_WORD_HINT_RE.findall(join_continuations(cmd)))
    lens = {len(w) for w in words}
    chain: List[str] = []
    for line in cmd.split("\n"):
        if chain and _paren_terminator(line.lstrip("\t"), words, lens):
            return True
        chain.append(line)
        if (len(line) - len(line.rstrip("\\"))) % 2:
            continue  # dòng giữa chuỗi kết bằng `\\` lẻ: không thể bằng dấu kết (chỉ `[A-Za-z0-9_.-]`)
        if len(chain) > 1 and any(c.lstrip("\t") in words for c in (line, join_continuations("\n".join(chain)))):
            return True
        chain = []
    return False


def _paren_terminator(line: str, words: Set[str], lens: Set[int]) -> bool:
    """`line` bắt đầu bằng một từ trong `words` (tiền tố của dãy `[A-Za-z0-9_.-]` đầu dòng) rồi sau đó có `)`. Chỉ xét
    độ dài có trong `lens` (không cắt chuỗi mọi độ dài: dòng dài không bậc hai)."""
    run = HERE_WORD_RUN_RE.match(line)
    if not run:
        return False
    end = min(run.end(), line.rfind(")"))
    return any(k <= end and line[:k] in words for k in lens)


HERE_BODY_MAX = 1 << 16  # AUD-PERF-017: tổng byte thân heredoc mỗi lệnh — quét chuỗi của script bậc hai theo độ dài
HERE_BODY_WHY = "thân heredoc tổng > 64 KiB — thời gian quét không có trần (AUD-PERF-017)"


def _heredoc_precheck(cmd: str, root: bool) -> None:
    """Trước khi quét (D-270): dòng nối bằng `\\` chạm dấu kết heredoc (`_joined_terminator`) → chặn; thân heredoc tổng
    quá `HERE_BODY_MAX` → chặn; lời gọi gốc (`root`): heredoc không có dòng kết → chặn (lệnh lồng/mảnh do guard cắt: thân
    là phần còn lại như bash)."""
    joined = join_continuations(cmd)
    if "<<" not in joined:  # `<\\` ↵ `<'EOF'`: chỉ chuỗi đã nối có `<<` (D-272)
        return
    if _joined_terminator(cmd):
        raise ScanTooComplex("dòng nối `\\` chạm dòng kết heredoc")
    if not root:  # lệnh lồng/mảnh do guard cắt: thân là phần còn lại như bash; trần thân đã xét ở lệnh gốc
        return
    spans, lines = _here_scan(joined), joined.split("\n")
    if sum(len(x) + 1 for *_, a, b, _ in spans for x in lines[a:b]) > HERE_BODY_MAX:
        raise ScanTooComplex(HERE_BODY_WHY)
    if any(b > len(lines) - 1 for *_, b, _ in spans):  # thân kết sau dòng cuối = không có dòng kết
        raise ScanTooComplex("heredoc không có dòng kết")


# `#` có thể mở comment (đầu dòng hay sau ký tự kết từ — bất kể nháy) trên dòng kết bằng `\\` lẻ (D-271)
COMMENT_START_RE = re.compile(r"(?:^|[\s;&|()<>`])#")  # backtick mở từ (D-275)
PAREN_HASH_WHY = "`)#` không khoảng trắng: guard và bash có thể đọc `#` khác nhau — thêm khoảng trắng trước `#`"
COMMENT_CONTINUED_WHY = (
    "`\\` cuối dòng sau `#` (bash không nối dòng trong comment) — đưa `#NN`/`#…` sang dòng không kết bằng `\\`"
    " (đặt cuối lệnh hay bỏ `\\` nối dòng)"
)
# D-272: Claude Code chạy lệnh trong snapshot shell đã `shopt -s expand_aliases` → định nghĩa alias nào cũng đổi nghĩa
# lệnh sau mà guard không thấy (AUD-SEC-220/222). Tên lệnh có thể thành `alias` sau mở rộng (`al${v}ias`, glob `al?as`)
# cũng tính; tên hoàn toàn động (`$x`, `$(…)`) là giới hạn chung của phân tích tĩnh (biến gán trong cùng lệnh đã được
# viết lại thành chữ). Đối số chỉ là tên trơn (`alias`, `alias -p`, `alias ll`: in) thì cho chạy.
HEAD_EXPANSION_RE = re.compile(r"\$\{[^}]*\}?|\$\((?:[^()]|\([^()]*\))*\)?|`[^`]*`?|\$[A-Za-z_]\w*|\$.?")
# D-274: định nghĩa alias cần `=` (hoặc mở rộng/glob tạo ra nó); liệt kê (`alias ll`, kèm chuyển hướng) không có — xét
# trên token đã bỏ nháy nên `'>'` có nháy không che được `c=…` như phép bỏ chuyển hướng cũ (review #361 sau D-273).
ALIAS_ARG_OK_RE = re.compile(r"[\w.:%,/<>&-]+")  # danh sách cho phép (D-275): ngoài ra = tilde/glob/mở rộng/`=`
ALIAS_TABLE = "BASH_ALIASES"  # gán phần tử mảng này (`BASH_ALIASES[c]=…`, `printf -v`, `read`) = định nghĩa alias
ALIAS_TABLE_LETTERS = "BASHALIASES"


def _letter_forms(cmd: str) -> List[str]:
    """D-274: các dạng chỉ-chữ-số của lệnh (đã nối dòng) — thô, bỏ mở rộng `$x`/`${…}`/`$(…)`, và sau giải ANSI-C:
    không phụ thuộc trạng thái nháy/comment/heredoc, nên ghép `$''`, `\\E`, `"$x"`, `$'\\x45'`, `{ES,}` sau nháy lẻ
    hay `$'` trong comment đều không che được tên (review #361 sau D-273)."""
    j = join_continuations(cmd)
    bases = (j, expand_ansi_c(j), ANSI_ESCAPE_RE.sub(_ansi_c_char, j), re.sub(r"\\(.)", r"\1", j))
    return [re.sub(r"[^A-Za-z0-9]", "", y) for x in bases for y in (x, HEAD_EXPANSION_RE.sub("", x))]  # 8 dạng (D-276)


def _shell_precheck(cmd: str, strict: bool = True, cwd: Optional[str] = None) -> None:
    """Trước khi quét (D-271), chỗ guard không đọc như bash → chặn:
    - dòng có `#` có thể mở comment mà kết bằng `\\` lẻ: bash KHÔNG nối dòng trong comment (`true # \\` ↵
      `git push --force origin main` chạy `push`) còn guard nối; đọc nháy để phân định cũng lệch (`"$(true # \\`, nháy
      lẻ trong thân heredoc) — không đoán;
    - `BASH_ALIASES` ở đâu cũng vậy, so trên dạng chỉ-chữ-số (`_letter_forms`, D-274): thân alias thành lệnh mà guard
      không thấy. Định nghĩa `alias NAME=…` xét theo từng lệnh (`_alias_rule`, D-272/D-274)."""
    if "\\" in cmd and "#" in cmd and any(_comment_continued(line) for line in cmd.split("\n")):
        raise ScanTooComplex(COMMENT_CONTINUED_WHY)
    if "\n" in cmd and "#" in cmd and _comment_desyncs_ansi(cmd):
        raise ScanTooComplex("comment/nháy lẻ làm lệch `$'…'` của dòng sau (guard giải ANSI-C trước khi bỏ comment)")
    if any(ALIAS_TABLE_LETTERS in f for f in _letter_forms(cmd)):
        raise ScanTooComplex(f"`{ALIAS_TABLE}` định nghĩa alias")
    why = _strict_why(cmd, cwd) if strict else ""
    if why:
        raise ScanTooComplex(f"ngoài tập con guard đọc chắc — {why} (ADR-0063)")


# ADR-0063 (D-299): tập con chuẩn — chỗ bash đọc khác cách guard mô phỏng (nháy, comment, backtick, brace, tilde, IFS…)
# → chặn BUDGET thay vì vá từng ca (AUD-SEC-196…246). Đo 2026-11-01 trên 1567 lệnh Bash thật của các phiên: chỉ backtick
# trong thân commit nháy kép chạm luật — bash thực thi chúng thật, tức lỗi của chính lệnh đó.
STRICT_PLAIN = {
    "c": re.compile(r"[^\\`$'\"#()]+"),
    '"': re.compile(r"[^\\`$\"]+"),
    "${": re.compile(r"[^\\`$'\"}]+"),
}
STRICT_WORD_BREAK = " \t\n;&|()<>"
STRICT_BRACE_RE = re.compile(r"\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}")
STRICT_LIVE = (
    (re.compile(r"\$\$\("), "`$$(` (AUD-SEC-243)"),
    (re.compile(r"\$\{?[!#]?IFS\b"), "mở rộng `IFS` (AUD-SEC-232/238/239)"),
)
# Chữ thô (cả trong nháy): chuỗi nháy gán vào biến có thể được đánh giá lại khi số học.
STRICT_RAW = ((re.compile(r"\w\[[^\]\n]*\$\((?!\()"), "thay lệnh trong chỉ số mảng (AUD-SEC-249)"),)
# `tokenize` thay `$IFS` trên toàn chuỗi, kể cả script nháy của shell lồng (`bash -c '…$IFS…'`, ghép nháy `'"'"'`): guard
# nhận script đã đổi. `$IFS` ở đâu cũng vậy (cả trong nháy) mà lệnh có gọi shell/`eval` → chặn; thân commit nhắc `$IFS`
# không gọi shell thì vẫn chạy.
STRICT_IFS_RE = re.compile(r"(?<!\\)\$\{?[!#]?IFS\b")
STRICT_SH_NAME = r"(?:ba|da|z|k|mk|a|fi|hu|ya|po|ok|lok|lk|pdk|c|tc|rba|o|y)?sh"  # tên trong `SHELLS` (AUD-SEC-341)
STRICT_SHELL_RE = re.compile(rf"(?:^|[^\w.-])(?:{STRICT_SH_NAME}|eval|source)(?![\w.-])")
STRICT_SH = rf"(?:\S*/)?{STRICT_SH_NAME}"
# `-o pipefail`/`-eo pipefail` (cờ gộp kết bằng `o` ăn giá trị — như `_shell_opt_width`), `--norc`, `-e`, `+x` (AUD-SEC-309)
STRICT_SH_OPT = r"(?:[-+][A-Za-z]*[oO]\s+\S+|--[\w-]+(?:=\S*)?|[-+][A-Za-z]+)"
STRICT_DYN_HEAD_RE = re.compile(
    rf"(?:^|[\s;&|(])(?:{STRICT_SH}(?:\s+{STRICT_SH_OPT})*?\s+-[A-Za-z]*c[A-Za-z]*(?:\s+(?:--|[-+][A-Za-z]+))*"
    r"|(?P<eval>eval))(?:\s+|(?=[;&|)\n])|$)"  # đầu đứng cuối lệnh (`eval`, `xargs bash -c`) vẫn là một đầu
)
STRICT_ARGV_CMD_RE = re.compile(r"(?:^|[;&|{(\n]|\b(?:then|do|else|elif)\b)\s*\"?\$\{?[@*0-9]")
# Shell đọc script từ ống mà bên ghi là nhóm `{…}`/subshell `(…)` (guard không ghép được chữ — AUD-SEC-290) hoặc từ
# thay tiến trình `>(…)` (AUD-SEC-301); ống từ lệnh guard thấy chữ (`echo …`, `cat f`) giữ luật quét cũ.
STRICT_PIPE_SHELL_RE = re.compile(
    rf"(?:[}})]\s*\|&?|>\()\s*(?:env\s+(?:-\S+\s+|\w+=\S*\s+)*)?{STRICT_SH}(?:\s+-[A-Za-z]*)*\s*(?:$|[;&|)\n]|-[A-Za-z]*s\b)"
)
STRICT_DYN_WORD_RE = re.compile(r"\$\(|\$'|`")  # trên vùng sống của từ (nháy đơn thật đã trống)
STRICT_DYN_ESC_RE = re.compile(r"\\\$['({]")  # `\$'…'`, `\$(…)` trong nháy kép: shell trong mở rộng lại (AUD-SEC-235)
# thân heredoc có nháy, `cat`/`tee` không đối số tệp (`$(cat <<'X' f` đọc f — review lát B): thấy được
STRICT_CAT_HEREDOC_RE = re.compile(r"\$\(\s*(?:cat|tee)\s+<<-?\s*(['\"])\w+\1[ \t]*\n[^)]*\)")
STRICT_DYN_MAX = 64  # số đầu `sh -c`/`eval` và số tên biến xét tối đa mỗi lệnh; vượt → chặn (review lát B, hiệu năng)
# Biến bash tự chạy cùng ngữ cảnh kích hoạt nó trong lệnh này (review lát B 🔴: `printf -vPS4`, `declare -n`,
# `read -aPS4`, `${PS4:=…}`, `BASH_FUNC_x%%`): PS4 + xtrace; BASH_ENV/ENV/BASH_FUNC_ + gọi shell; PS0/PS1/PROMPT_COMMAND
# + shell tương tác. Gán chữ nguyên văn (`PS4='+ '`) không tính.
STRICT_SAFE_PROMPT_RE = re.compile(
    r"\bPS[0-4]=(?:'[^'$`\\]*'|\"[^\"$`\\]*\"|[^\s;&|$`\\'\"]*)(?=[\s;&|]|$)|\b(?:BASH_ENV|ENV)=(?=[\s;&|]|$)"
)  # gán chữ nguyên văn cho prompt, gán RỖNG cho BASH_ENV/ENV (`BASH_ENV= bash -c true`)
STRICT_SPECIAL = (
    # tên không đòi ranh giới trước: `read -raPS4`
    (re.compile(r"PS4\b"), re.compile(r"\bset\s+[-+]\w*x|\bxtrace\b|\bSHELLOPTS\b|\b(?:ba)?sh\s+(?:-\w+\s+)*-\w*x")),
    (re.compile(r"\b(?:BASH_ENV|ENV|BASH_FUNC_\w*)"), STRICT_SHELL_RE),
    (re.compile(r"(?:PS[0-3]|PROMPT_COMMAND)\b"), re.compile(r"\s-\w*i\b")),
)
STRICT_BARE = (
    (re.compile(r"(?:^|[\s=:;&|(<>])~[+-]?\d"), "`~N` ngăn xếp thư mục (AUD-SEC-240)"),  # `~+`/`~-`: guard đã giải
    (re.compile(r"[{,]#|#[,}]"), "brace bung ra `#` (AUD-SEC-233)"),
)


class _CodeView:
    """Đọc chuỗi (đã nối dòng, đã gấp heredoc) theo ngữ cảnh nháy của bash. `kind[i]`: `c` mã ngoài nháy (bash tách
    từ, bung brace/tilde) · `d` chữ trong nháy kép · `p` trong `${…}` · `q` chữ nháy đơn/`$'…'`/`\\x`/comment. `why`: chỗ
    đầu tiên guard không mô phỏng chắc (rỗng = trong tập con)."""

    def __init__(self, s: str) -> None:
        self.s, self.kind, self.stack, self.why = s, ["q"] * len(s), [""], ""
        self.opens: List[int] = []  # vị trí `"` mở đang chờ đóng
        self.top = [False] * len(s)  # ký tự ở tầng ngoài cùng (không trong `$(`/`(`/nháy/`${`)
        self.dq_dollars: Set[int] = set()  # `$` (không thoát) nằm TRỰC TIẾP trong chuỗi nháy kép (ADR-0065)
        self.ansi_opens: Set[int] = set()  # `$` mở `$'…'` ở tầng mã — nháy, không phải mở rộng
        self.comments: List[Tuple[int, int]] = []  # vùng comment `#…` (kind `q` như nháy đơn — tách riêng cho lớp B)
        i = 0
        while i < len(s) and not self.why:
            top = len(self.stack) == 1
            j = self._step(i)
            self.top[i:j] = [top] * (min(j, len(s)) - i)
            i = j
        if not self.why and len(self.stack) > 1:
            self.why = "nháy/ngoặc không đóng (AUD-SEC-214)"

    def _step(self, i: int) -> int:
        s, ctx = self.s, self.stack[-1]
        m = STRICT_PLAIN.get(ctx, STRICT_PLAIN["c"]).match(s, i)
        if m:
            self.kind[i : m.end()] = [{'"': "d", "${": "p"}.get(ctx, "c")] * (m.end() - i)
            if ctx in ("$(", "(") and CASE_WORD_RE.search(m[0]):  # `)` của mẫu `case` đóng ngoặc sớm (review lát A 🔴)
                self.why = "`case` trong `$(…)`/`(…)` — dùng `if`/`[[ ]]` hoặc tách lệnh"
            return m.end()
        if ctx == '"' and s[i] == "$":  # `\$` không tính: chữ `$` mà `mapfile -C`/`${x@P}`/eval đọc lại thành mở rộng
            self.dq_dollars.add(i)
        if s[i] == "`":
            self.why = "backtick — dùng `$(…)` (AUD-SEC-181/231/245)"
        if s[i] == "\\" or self.why:
            return i + 2
        if s.startswith(("$(", "${"), i):
            self.kind[i : i + 2] = ["c" if ctx in ("", "(", "$(") else "d"] * 2
            self.stack.append(s[i : i + 2])
            return i + 2
        return self._in_dq(i) if ctx == '"' else self._in_param(i) if ctx == "${" else self._in_code(i)

    def _in_dq(self, i: int) -> int:
        if self.s[i] == '"':
            self.stack.pop()
            self._paren_check(self.s[self.opens.pop() : i])
        self.kind[i] = "d"
        return i + 1

    def _paren_check(self, body: str) -> None:
        """Chuỗi nháy bên trong `$(…)` có `)` thừa: bộ tìm thay lệnh của guard đếm ngoặc thô nên đóng `$(` sớm (AUD-SEC-202);
        `(` thừa (`grep 'fix('`) chỉ làm bộ đếm cũ quét rộng hơn — không chặn."""
        if "$(" in self.stack and body.count(")") > body.count("("):
            self.why = "ngoặc lẻ trong chuỗi nháy bên trong `$(…)` (AUD-SEC-202)"

    def _in_param(self, i: int) -> int:
        c = self.s[i]
        if c in "'\"":
            self.why = "nháy lồng trong `${…}` (AUD-SEC-246)"
        elif c == "}":
            self.stack.pop()
        self.kind[i] = "p"
        return i + 1

    def _in_code(self, i: int) -> int:
        s, c = self.s, self.s[i]
        if s.startswith("$$", i):  # PID — `$$'…'` là PID + nháy đơn thường, không phải ANSI-C (review lát A 🔴)
            self.kind[i : i + 2] = ["c", "c"]
            return i + 2
        if c == "'" or s.startswith("$'", i):
            if c == "$":
                self.ansi_opens.add(i)
            return self._quoted(i, c == "$")
        if c == "#":
            return self._hash(i)
        self.kind[i] = "c"
        if c == '"':
            self.opens.append(i)
        if c == '"' or c == "(":
            self.stack.append(c)
        elif c == ")" and len(self.stack) > 1:
            self.stack.pop()
        return i + 1

    def _quoted(self, i: int, ansi: bool) -> int:
        s, k = self.s, i + 1 + ansi
        while k < len(s) and s[k] != "'":
            k += 1 + (ansi and s[k] == "\\")
        body = s[i + 1 + ansi : k]
        if k >= len(s):
            self.why = "nháy không đóng (AUD-SEC-214)"
        elif ansi and "\\'" in body and "#" in s and STRICT_BRACE_RE.search(s):
            self.why = "`$'…\\'…'` cùng brace và `#` (AUD-SEC-234)"
        else:
            self._paren_check(body)
        return k + 1

    def _hash(self, i: int) -> int:
        s = self.s
        if i and (s[i - 1] not in STRICT_WORD_BREAK or self.kind[i - 1] != "c"):  # `a#b`, `\)#`: chữ thường
            self.kind[i] = "c"
            return i + 1
        end = s.find("\n", i)
        end = len(s) if end < 0 else end
        if i and s[i - 1] == ")":  # nháy trong comment: D-274…D-276 (`_comment_desyncs_ansi`) đã đóng AUD-SEC-229/230
            self.why = "`#` ngay sau `)` (AUD-SEC-242)"
        self.comments.append((i, end))
        return end


def _strict_why(cmd: str, cwd: Optional[str] = None) -> str:
    """ADR-0063: lý do lệnh ra ngoài tập con guard đọc chắc như bash (rỗng = trong tập con)."""
    lines = join_continuations(cmd).split("\n")
    for _, m, a, b, _ in _here_scan("\n".join(lines)):
        body = "\n".join(lines[a:b])
        if _heredoc_word(m)[1]:
            continue
        if "`" in body:
            return "backtick trong thân heredoc không nháy — dùng `$(…)` (AUD-SEC-181/231/245)"
        if "'" in body and "$(" in body:
            return "thân heredoc không nháy có `'` cùng thay lệnh (AUD-SEC-196)"
        lines[a:b] = [" " * len(x) for x in lines[a:b]]  # chữ (thay lệnh trong thân: `_heredoc_feed` của luật cũ)
    v = _CodeView(_fold_heredocs("\n".join(lines), True))
    if v.why:
        return v.why
    live, bare = _code_views(v)
    checks = ((STRICT_RAW, v.s), (STRICT_LIVE, live), (STRICT_BARE, bare))
    why = next((why for rules, text in checks for rx, why in rules if rx.search(text)), "")
    if not why and STRICT_IFS_RE.search(v.s) and STRICT_SHELL_RE.search(v.s):
        why = "`$IFS` trong script của shell lồng (AUD-SEC-239)"
    return why or _ifs_split_why(cmd, live, bare) or _dyn_text_why(v, live, bare) or _gh_strict_why(v.s, live, cwd)


def _code_views(v: _CodeView) -> Tuple[str, str]:
    """(`live`: chữ bash còn mở rộng — bỏ nháy đơn/comment; `bare`: chỉ mã ngoài nháy), cùng độ dài với `v.s`."""
    live = "".join(ch if k != "q" else " " for ch, k in zip(v.s, v.kind))
    return live, "".join(ch if k == "c" else " " for ch, k in zip(v.s, v.kind))


# AUD-SEC-388: bash tách mở rộng không nháy theo `IFS` hiện hành, guard tách theo khoảng trắng (`IFS=/; c=git/push/…;
# $c`). OR với luật `$IFS` ở trên (bài học #372), không thay. Lượt 2 (review blk-guard): xét trên CẤU TRÚC lệnh (token, vị
# trí lệnh), không trên chữ thô — chữ nhắc `IFS` trong grep/commit/heredoc dữ liệu không tính. `IFS` có thể bị gán khi:
# là đích gán ở vị trí mã (gán đầu lệnh trừ `IFS=… read`; đối số declare/export/local/readonly/typeset; tên của read/
# mapfile/printf -v/wait -p/getopts; biến của for/select/coproc — mọi dạng chỉ-chữ-số, cả sau bung brace); tên đích không
# nguyên văn (`"$n"=`, `declare -$f`); nameref `-n`, thuộc tính số `-i`; `${!n:=…}`; ngữ cảnh số học — bash đánh giá ĐỆ
# QUY giá trị biến (`n=IFS=4; (( i < n ))` gán IFS; cả chỉ số mảng, `${x:n}`, `[[ n -eq 1 ]]`, `let`) — nhắc tên/biến khi
# lệnh đưa vào biến giá trị có thể chứa `IFS` (`_ifs_tainted`), hay lấy chữ lúc chạy (`$(…)`, `$1`); mã cùng
# shell guard không đọc (`source`/`.`, `mapfile -C`); thân `eval`/`trap`/`sh -c` xét như mã và chữ nháy của lệnh có
# chúng cũng tính là mở rộng (`sh -c "IFS=/; …; \$c"`). Shell con không nhận IFS từ môi trường (đã thử bash 5.2, dash).
IFS_SPLIT_WHY = (
    "mở rộng không nháy khi `IFS` có thể bị gán — bash tách từ khác guard (AUD-SEC-388): đặt mở rộng trong nháy kép"
    ' (`"$c"`, `"${a[@]}"`); nạp `.env` bằng `set -a; . ./.env; set +a` rồi dùng biến trong nháy'
)
STRICT_SPLIT_RE = re.compile(r"\$(?!\{#)[A-Za-z_{(@*0-9]")  # `$?`/`$#`/`$$`/`$!`/`$-`/`${#x}` ra số/cờ: không tính
# Lệnh mà đối số tầng ngoài là dữ liệu gán, không chạy: danh sách `for/select NAME in`, đối số declare/export/… — chỉ khi ở
# VỊ TRÍ LỆNH (đầu, sau `;` `&` `|` `(` xuống dòng — không phải `>&` —, hay sau `do`/`then`/`else`/`elif`/`!`/`{`).
STRICT_CMD_POS = r"(?:(?:^|(?<![<>])[;&|(\n])[ \t]*|(?:^|[\s;&|(])(?:do|then|else|elif|!|\{)[ \t]+)"
STRICT_LIST_HEAD_RE = re.compile(
    STRICT_CMD_POS + r"(?:(?:for|select)[ \t]+[A-Za-z_]\w*[ \t]+in|declare|typeset|local|export|readonly)(?=[\s;&|)]|$)"
)
# Giá trị gán đầu lệnh (`n=$(…)`, `A=1 B=$x cmd`) không bị tách từ.
STRICT_ASSIGN_WORD = r"[A-Za-z_]\w*(?:\[[^\[\]\n]*\])?\+?="
STRICT_ASSIGN_HEAD_RE = re.compile(STRICT_CMD_POS + STRICT_ASSIGN_WORD)
STRICT_ASSIGN_NEXT_RE = re.compile(r"[ \t]+" + STRICT_ASSIGN_WORD)
# `read` có thể bị định nghĩa lại (hàm `tên()`/`function`, `enable`, `alias`) → `IFS=… read` không còn chỉ gán cho builtin
STRICT_REDEF_RE = re.compile(
    r"[^\s;&|()<>=$`'\"][ \t]*\([ \t]*\)|\bfunction\s|(?:^|[\s;&|(])(?:enable|alias)(?=[\s;&|)]|$)"
)
ARITH_NAME_RE = re.compile(r"[$`]|(?<![0-9A-Za-z_#])[A-Za-z_]")  # tên/mở rộng; `0x1f`, `16#ff` là số
ARITH_SAFE_RE = re.compile(r"\$[$#?!-]")  # tham số đặc biệt ra số/cờ
ARITH_TEST_OP_RE = re.compile(r"(?<![\w$])-[A-Za-z]+\b")  # toán tử `[[ … ]]` (`-eq`, `-f`): không phải tên
ARITH_TEST_RE = re.compile(r"-(?:eq|ne|lt|le|gt|ge)\b")  # `[[ a -eq b ]]`: toán hạng là biểu thức số học
ARITH_LIVE_RES = (  # mỗi lớp `[^…\[\]$]` dừng ở dấu mở kế: một lượt quét tuyến tính
    re.compile(r"\$\{[!#]?[A-Za-z_]\w*\[([^\[\]\n]*)\]"),  # chỉ số trong `${a[i]}`, `${#a[i]}` (review #423)
    re.compile(r"\$\[([^\[\]\n]*)\]"),  # `$[…]` cũ
    re.compile(r"\$\{[A-Za-z_@*0-9]\w*(?:\[[^\[\]\n$]*\])?:(?![-=+?])([^}$\n]*\$?)"),  # `${x:off:len}`
)
ARITH_BARE_RES = (
    re.compile(r"\w\[([^\[\]\n]*)\]"),
    re.compile(r"\[([^\[\]\n]*)\]\+?="),
)  # `a[i]=`, `a=([k]=v)`
ARITH_INDIRECT_RE = re.compile(r"\$\{![A-Za-z_]\w*(?:\[[^\[\]\n$]*\])?:?=")  # `${!n:=v}`: gán tên động
ARITH_DEFAULT_RE = re.compile(r"\$\{[A-Za-z_]\w*(?:\[[^\[\]\n$]*\])?:?=")  # `${x:=v}`: gán giá trị mặc định
ARITH_RAW_RE = re.compile(r"`|\$\((?!\()|\$\{?[0-9@*]")  # chữ lấy lúc chạy: thay lệnh, tham số vị trí
IFS_ASSIGN_WORD_RE = re.compile(r"([A-Za-z_]\w*)(?:\[([^\]]*)\])?\+?=")  # gán đầu lệnh (cả `a[i]=`, `IFS[0]=`)
IFS_DECLARERS = frozenset("declare typeset local".split())  # nhận `-n` (nameref) và `-i` (số học)
IFS_SAME_SHELL = frozenset("eval trap source .".split())  # chữ nháy là mã chạy trong shell hiện hành
# lệnh → (chữ cờ ăn toán hạng, chữ cờ mà toán hạng là tên đích, từ vị trí là tên đích)
IFS_OPT_TARGETS: Dict[str, Tuple[str, str, bool]] = {
    "read": ("dinNptu", "a", True),
    "mapfile": ("dnOsucC", "", True),
    "readarray": ("dnOsucC", "", True),
    "printf": ("", "v", False),
    "wait": ("", "p", False),
    "unset": ("", "", True),
}
STRICT_EVAL_DEPTH = 4  # số tầng `eval`/`trap` lồng xét thân; sâu hơn → coi như gán được
IFS_TAINT_HEADS = frozenset("read mapfile readarray getopts select coproc".split())  # gán chữ từ input


def _ifs_split_why(cmd: str, live: str, bare: str) -> str:
    """AUD-SEC-388: lý do chặn khi có mở rộng không nháy mà `IFS` có thể bị gán (rỗng = qua). Có `eval`/`trap`/`source`
    (mã cùng shell, như AUD-SEC-239): mở rộng ở đâu cũng tính, cả trong nháy và thân heredoc."""
    argvs = _ifs_argvs(cmd)
    same = argvs is not None and any(_ifs_head(a)[0] in IFS_SAME_SHELL | SHELLS for a in argvs)
    if not STRICT_SPLIT_RE.search(cmd if same else _split_free(live, bare)):
        return ""
    return IFS_SPLIT_WHY if argvs is None or _ifs_may_assign(argvs, live, bare, 0) else ""


def _ifs_argvs(cmd: str) -> Optional[List[List[str]]]:
    raw = _raw_tokens(cmd)
    return None if raw is None else split_commands(raw)


def _ifs_head(argv: List[str]) -> Tuple[str, List[str]]:
    """(tên lệnh đã chuẩn hoá, đối số còn nháy) — sau từ khoá, gán, chuyển hướng, lệnh bọc đứng đầu."""
    rest = _ifs_prefix(argv)[1]
    plain = [_dequote(t) for t in rest]
    n = normalize(plain)
    return (n[0], rest[len(rest) - len(_strip_prefixes(plain)) + 1 :]) if n else ("", [])


def _ifs_prefix(argv: List[str]) -> Tuple[List["re.Match[str]"], List[str]]:
    """(các gán đầu lệnh, phần còn lại) — bỏ từ khoá/chuyển hướng đứng trước. Gán đọc trên token còn nháy (giá trị
    `$'\\n'` đã giải thành xuống dòng — `ENV_ASSIGN_RE` không qua được)."""
    words = _no_redirects(argv)
    assigns: List["re.Match[str]"] = []
    for i, w in enumerate(words):
        m = IFS_ASSIGN_WORD_RE.match(w)
        if m:
            assigns.append(m)
        elif _dequote(w) not in (*SHELL_KEYWORDS, "time", "-p"):
            return assigns, words[i:]
    return assigns, []


def _split_free(live: str, bare: str) -> str:
    """`bare` bỏ các `$` mà bash không tách từ khác guard: trong số học (`$((…))` ra số, tên bên trong; `$(…)` lồng là mã —
    giữ), giá trị gán đầu lệnh, danh sách `for … in` và đối số declare/export/… ở tầng ngoài (dữ liệu gán; `$` trong
    `$(…)`/`(…)` là mã — giữ)."""
    chars = list(bare)
    for a, b in _arith_spans(live):
        _blank_arith(live, chars, a - (a > 0 and live[a - 1] == "$"), b)
    pos = 0
    while m := STRICT_LIST_HEAD_RE.search(bare, pos):
        pos = _blank_list(bare, chars, m.end(), ";&|\n)")
    pos = 0
    while m := STRICT_ASSIGN_HEAD_RE.search(bare, pos):
        pos = _blank_list(bare, chars, m.end(), ";&|\n) \t")
        while n := STRICT_ASSIGN_NEXT_RE.match(bare, pos):
            pos = _blank_list(bare, chars, n.end(), ";&|\n) \t")
    return "".join(chars)


def _blank_arith(s: str, chars: List[str], i: int, end: int) -> None:
    """Xoá `$` ở tầng số học của `s[i:end]` — trừ bên trong thay lệnh `$(…)` lồng (lệnh thật, từ của nó vẫn bị tách)."""
    sub = 0
    while i < end:
        opens = not sub and s.startswith("$(", i) and not s.startswith("$((", i)
        if sub or opens:
            sub += (s[i + opens] == "(") - (s[i + opens] == ")")
        if s[i] == "$" and (opens or not sub):
            chars[i] = " "
        i += 1 + opens


def _blank_list(s: str, chars: List[str], i: int, stop: str) -> int:
    """Xoá `$` tầng ngoài của dãy từ bắt đầu ở `s[i]`, tới ký tự `stop` cùng tầng (toán tử điều khiển; với giá trị gán:
    cả khoảng trắng); trả vị trí kết."""
    depth = 0
    while i < len(s) and (depth or s[i] not in stop):
        depth += (s[i] == "(") - (s[i] == ")")
        if s[i] == "$" and not depth:
            chars[i] = " "
        i += 1
    return i


def _arith_spans(s: str) -> List[Tuple[int, int]]:
    """Vùng `((…))` ngoài cùng (cả `$((…))`; đóng bằng `))` — `((a) b)` là hai ngoặc thường) — một lượt, tuyến tính."""
    stack: List[Tuple[bool, int]] = []
    spans: List[Tuple[int, int]] = []
    depth = i = 0  # số `((` số học đang mở
    while i < len(s):
        step = 1
        if s.startswith("((", i):
            stack.append((True, i))
            depth, step = depth + 1, 2
        elif s[i] == "(":
            stack.append((False, i))
        elif s[i] == ")" and stack:
            arith, start = stack.pop()
            depth -= arith
            if arith and s.startswith(")", i + 1):
                spans += [] if depth else [(start, i + 2)]
                step = 2
            elif arith:
                stack.append((False, start))
        i += step
    return spans


def _double_brackets(s: str) -> List[str]:
    """Nội dung các `[[ … ]]` (tới `]]` kế tiếp hay hết chuỗi) — tuyến tính."""
    out: List[str] = []
    i = s.find("[[")
    while i >= 0:
        j = s.find("]]", i + 2)
        out.append(s[i + 2 : j if j >= 0 else len(s)])
        i = s.find("[[", j + 2) if j >= 0 else -1
    return out


def _arith_dyn(text: str) -> bool:
    """Biểu thức số học nhắc tên biến/mở rộng (`$` đặc biệt ra số không tính)."""
    return bool(ARITH_NAME_RE.search(ARITH_SAFE_RE.sub("0", text)))


def _arith_assigns(argvs: List[List[str]], live: str, bare: str) -> bool:
    """Ngữ cảnh số học có thể gán `IFS` — bash đánh giá ĐỆ QUY giá trị biến (`n=IFS=4; (( i < n ))`): nhắc `IFS`, chữ
    lấy lúc chạy (thay lệnh, backtick, tham số vị trí — `bash -c '(( $1 ))' _ IFS=4`), hay nhắc tên/biến khi lệnh đưa vào
    biến một giá trị có thể chứa `IFS` (`_ifs_tainted`); `${!n:=…}`. Biến môi trường (không gán trong lệnh) là của người
    dùng — tin như shell khởi đầu với `IFS` mặc định."""
    if ARITH_INDIRECT_RE.search(live):
        return True
    dyn = [t for t in _arith_texts(argvs, live, bare) if _arith_dyn(t)]
    if any(ARITH_RAW_RE.search(t) or any("IFS" in f for f in _letter_forms(t)) for t in dyn):
        return True
    return bool(dyn) and _ifs_tainted(argvs, live, bare)


def _arith_texts(argvs: List[List[str]], live: str, bare: str) -> List[str]:
    """Biểu thức số học của lệnh: `((…))`/`$((…))`, `[[ … -eq … ]]`, chỉ số mảng, `${x:off:len}`, `$[…]`, đối số `let`."""
    texts = [live[a:b] for a, b in _arith_spans(live)]
    texts += [ARITH_TEST_OP_RE.sub(" ", t) for t in _double_brackets(live) if ARITH_TEST_RE.search(t)]
    texts += [m[1] for rx in ARITH_LIVE_RES for m in rx.finditer(live)]
    texts += [m[1] for rx in ARITH_BARE_RES for m in rx.finditer(bare)]
    texts += [m[2] for argv in argvs for m in _ifs_prefix(argv)[0] if m[2]]  # `a["$k"]=1`: nháy che khỏi `bare`
    return texts + [w for head, args in map(_ifs_head, argvs) if head == "let" for w in args]


def _ifs_tainted(argvs: List[List[str]], live: str, bare: str) -> bool:
    """Lệnh đưa vào biến giá trị có thể chứa `IFS`: giá trị gán không nguyên văn (`$`/backtick ngoài `$((…))`), có chữ
    `IFS` (mọi hoa/thường), nối `+=`; đích của read/mapfile/getopts/select/coproc/printf -v/wait -p (chữ từ input);
    danh sách `for` có mở rộng/glob/chữ `IFS`; thuộc tính đổi chữ `-u`/`-l`/`-c`; `${x:=…}`; hàm (đối số vị trí)."""
    if STRICT_REDEF_RE.search(bare) or ARITH_DEFAULT_RE.search(live):
        return True
    return any(map(_argv_tainted, argvs))


def _argv_tainted(argv: List[str]) -> bool:
    head, args = _ifs_head(argv)
    if any(_value_tainted(m.string) for m in _ifs_prefix(argv)[0]) or head in IFS_TAINT_HEADS:
        return True
    rule = IFS_TAINT_RULES.get(head)
    return rule is not None and rule(head, args)


def _value_tainted(word: str) -> bool:
    """Từ gán `NAME[+]=VALUE`: nối `+=`, hay giá trị có thể chứa `IFS`."""
    name, _, value = word.partition("=")
    return name.endswith("+") or _text_tainted(value)


def _text_tainted(text: str) -> bool:
    """Chữ có thể chứa `IFS`: mở rộng/thay lệnh (ngoài `$((…))` ra số), hay chữ `IFS` ở dạng chỉ-chữ-số (mọi hoa/thường)."""
    spans = _arith_spans(text)
    cuts = zip([0, *(b for _, b in spans)], [a - (a > 0 and text[a - 1] == "$") for a, _ in spans] + [len(text)])
    rest = "".join(text[x:y] for x, y in cuts)
    return bool(re.search(r"[$`]", rest)) or any("IFS" in f.upper() for f in _letter_forms(text))


def _taint_declare(head: str, args: List[str]) -> bool:
    words = _no_redirects(args)
    if re.search(r"[ulc]", "".join(_dequote(w)[1:] for w in words if _is_opt(w))):
        return True  # `declare -u n=ifs=4` → `IFS=4`
    return any(_value_tainted(_dequote(w)) for w in words if not _is_opt(w) and "=" in w)


def _taint_opts(head: str, args: List[str]) -> bool:
    _, names, _ = IFS_OPT_TARGETS[head]
    return bool(_opt_targets(_no_redirects(args), names, names, False))


def _taint_for(head: str, args: List[str]) -> bool:
    words = args[2:] if [_dequote(w) for w in args[1:2]] == ["in"] else []
    return any(_text_tainted(w) or bool(re.search(r"[*?\[]", w)) for w in words)


def _ifs_may_assign(argvs: List[List[str]], live: str, bare: str, depth: int) -> bool:
    """`IFS` có thể bị gán ở đâu đó trong lệnh (ngữ cảnh số học, hay một lệnh đơn gán nó)."""
    if _arith_assigns(argvs, live, bare):
        return True
    read_ok = not STRICT_REDEF_RE.search(bare)
    return any(_argv_may_assign(a, read_ok, depth) for a in argvs)


def _argv_may_assign(argv: List[str], read_ok: bool, depth: int) -> bool:
    head, args = _ifs_head(argv)
    if _prefix_may_assign(argv, read_ok and head == "read"):
        return True
    rule = IFS_HEAD_RULES.get(head)
    return rule is not None and rule(head, args, depth)


def _prefix_may_assign(argv: List[str], read_only: bool) -> bool:
    """Gán đầu lệnh (sau từ khoá/chuyển hướng) `IFS=`/`IFS[0]=`, trừ khi lệnh là `read` (`read_only` — gán chỉ cho lần
    chạy đó). Chỉ số mảng (số học) xét ở `_arith_texts`."""
    return not read_only and any(m[1] == "IFS" for m in _ifs_prefix(argv)[0])


def _is_opt(w: str) -> bool:
    d = _dequote(w)
    return len(d) > 1 and d[0] in "-+"


def _ifs_target(word: str, subs_only: bool = False) -> bool:
    """Từ là đích gán có thể là `IFS`: tên không nguyên văn (`$`/backtick), tên dạng chỉ-chữ-số `IFS` (cả sau bung
    brace), hay chỉ số nhắc tên/biến (đánh giá số học). `subs_only` (`unset`): chỉ xét chỉ số."""
    name, _, sub = _dequote(word).partition("=")[0].partition("[")
    if _arith_dyn(sub):
        return True
    return not subs_only and (bool(re.search(r"[$`]", name)) or _names_ifs(name))


def _names_ifs(name: str) -> bool:
    variants = brace_variants(name)
    if variants is None:
        return True
    return any(f == "IFS" for v in variants or [name] for p in v.split() or [v] for f in _letter_forms(p))


def _rule_var_name(head: str, args: List[str], depth: int) -> bool:
    """`for/select/coproc NAME`: biến vòng/tên coproc."""
    return bool(args) and _ifs_target(args[0])


def _rule_declare(head: str, args: List[str], depth: int) -> bool:
    """declare/typeset/local/export/readonly: cờ động, `-n`/`-i` (declare/typeset/local), hay từ đích có thể là IFS."""
    words = _no_redirects(args)
    flags = "".join(_dequote(w)[1:] for w in words if _is_opt(w))
    if re.search(r"[$`]", flags) or (head in IFS_DECLARERS and re.search(r"[in]", flags)):
        return True
    return any(_ifs_target(w) for w in words if not _is_opt(w))


def _rule_opts(head: str, args: List[str], depth: int) -> bool:
    """read/mapfile/printf -v/wait -p/unset: tên đích theo bảng `IFS_OPT_TARGETS`; `mapfile -C`: callback là mã."""
    takes, names, positional = IFS_OPT_TARGETS[head]
    words = _no_redirects(args)
    if "C" in takes and any("C" in _dequote(w)[1:] for w in words if _is_opt(w)):
        return True
    return any(_ifs_target(w, head == "unset") for w in _opt_targets(words, takes + names, names, positional))


def _opt_targets(words: List[str], takes: str, names: str, positional: bool) -> List[str]:
    """Tên đích: toán hạng của cờ trong `names` (`-a NAME`, `-vNAME`), từ vị trí nếu `positional`."""
    out: List[str] = []
    rest = iter(words)
    for w in rest:
        if _is_opt(w):
            out += _cluster_target(_dequote(w), rest, takes, names)
        elif positional:
            out.append(w)
    return out


def _cluster_target(d: str, rest: Iterator[str], takes: str, names: str) -> List[str]:
    """Cờ gộp (`-rp …`, `-ra NAME`): chữ đầu tiên ăn toán hạng (phần còn lại của từ hay từ kế) — tên đích nếu chữ thuộc
    `names`."""
    for j, ch in enumerate(d[1:], 2):
        if ch in takes:
            val = d[j:] or next(rest, "")
            return [val] if ch in names else []
    return []


def _rule_getopts(head: str, args: List[str], depth: int) -> bool:
    words = _no_redirects(args)
    return len(words) > 1 and _ifs_target(words[1])


def _rule_body(head: str, args: List[str], depth: int) -> bool:
    """Thân `eval`/`trap` là mã chạy trong shell này: xét như một lệnh (tối đa `STRICT_EVAL_DEPTH` tầng)."""
    words = [d for d in map(_dequote, _no_redirects(args)) if d != "--"]
    if head == "trap":
        words = words[:1] if len(words) > 1 and words[0] not in ("-", "-p", "-l") else []
    return bool(words) and _body_may_assign(" ".join(words), depth)


def _rule_shell(head: str, args: List[str], depth: int) -> bool:
    """`sh -c BODY`: thân là script (dòng lệnh thô của nó cũng là mở rộng — `_ifs_split_why`); file/stdin: lớp lồng xét."""
    has_c, script = _shell_script_arg([head, *map(_dequote, _no_redirects(args))])
    return has_c and (script is None or _body_may_assign(script, depth))


def _body_may_assign(body: str, depth: int) -> bool:
    return depth >= STRICT_EVAL_DEPTH or _text_may_assign(body, depth + 1)


def _rule_unseen(head: str, args: List[str], depth: int) -> bool:
    """`source`/`.`: script chạy trong shell này mà guard không đọc."""
    return True


def _text_may_assign(text: str, depth: int) -> bool:
    v = _CodeView(_fold_heredocs(join_continuations(text), True))
    argvs = _ifs_argvs(text)
    if v.why or argvs is None:
        return True
    live, bare = _code_views(v)
    return _ifs_may_assign(argvs, live, bare, depth)


IFS_HEAD_RULES: Dict[str, Callable[[str, List[str], int], bool]] = {
    **dict.fromkeys(("for", "select", "coproc"), _rule_var_name),
    **dict.fromkeys(("declare", "typeset", "local", "export", "readonly"), _rule_declare),
    **dict.fromkeys(IFS_OPT_TARGETS, _rule_opts),
    **dict.fromkeys(("eval", "trap"), _rule_body),
    **dict.fromkeys(("source", "."), _rule_unseen),
    **dict.fromkeys(SHELLS, _rule_shell),
    "getopts": _rule_getopts,
}
IFS_TAINT_RULES: Dict[str, Callable[[str, List[str]], bool]] = {
    **dict.fromkeys(("declare", "typeset", "local", "export", "readonly"), _taint_declare),
    **dict.fromkeys(("printf", "wait"), _taint_opts),
    "for": _taint_for,
}


def _dyn_text_why(v: _CodeView, live: str, bare: str) -> str:
    """ADR-0063 lớp mã động trên chữ: thân `sh -c`/`eval` không phải chữ nguyên văn (thay lệnh, biến, `\\`), lệnh
    `"$@"`/`$N`, shell đọc script từ ống hay `>(…)` (AUD-SEC-235/237/246/252/290/301)."""
    heads = list(STRICT_DYN_HEAD_RE.finditer(bare))
    if len(heads) > STRICT_DYN_MAX:
        raise ScanTooComplex(f"hơn {STRICT_DYN_MAX} lời gọi `sh -c`/`eval` trong một lệnh")
    for m in heads:
        a, b = m.end(), _word_end(v, m.end(), m["eval"] is not None)
        cut = [h.span() for h in STRICT_CAT_HEREDOC_RE.finditer(v.s, a, b)]
        word = "".join(" " if any(x <= i < y for x, y in cut) else live[i] for i in range(a, b))
        if STRICT_DYN_ESC_RE.search(v.s, a, b) or _dyn_word(word, v.s):
            return "thân `sh -c`/`eval` dựng lúc chạy (AUD-SEC-235/237/246/252)"
    if STRICT_ARGV_CMD_RE.search(live):
        return 'lệnh là `"$@"`/`$N` (AUD-SEC-252)'
    if STRICT_PIPE_SHELL_RE.search(bare):
        return "shell đọc script từ ống/`>(…)` (AUD-SEC-290/301)"
    text = STRICT_SAFE_PROMPT_RE.sub("", v.s)  # tên: cả trong nháy (`env 'BASH_FUNC_x%%=…'`); ngữ cảnh: chỉ mã
    hit = any(name.search(text) and ctx.search(bare) for name, ctx in STRICT_SPECIAL)
    return "biến bash tự chạy cùng ngữ cảnh kích hoạt (AUD-SEC-287/291/299/300)" if hit else ""


# ADR-0065 (D-322): lớp mở rộng động theo DANH SÁCH TRẮNG. Ba lượt vá AUD-SEC-388 theo cấu trúc lệnh đều lọt dạng mới
# (#372, review #422: hàm `function`, `((` giả trong nháy, từ lệnh có nháy, `read` định nghĩa trong `eval`, `exec read`).
# OR với mọi luật cũ (bài học #352/#372); không suy cấu trúc (hàm, vòng `for`, vùng số học…) để miễn:
# (A) từ lệnh — sau gán đầu lệnh, từ khoá, lệnh bọc guard biết — có `$`/backtick, kể cả trong nháy → chặn (AUD-SEC-391);
# (B) chữ thô nhắc `IFS` (mọi dạng chỉ-chữ-số) hay có gán tên-đích-động (tên đích không nguyên văn, nameref, `${!x}`,
#     đổi hoa từ dữ liệu, biểu thức số học nhắc tên/mở rộng — bash đánh giá ĐỆ QUY giá trị biến nên `(( a ))` với `a`
#     đọc từ tệp trong `eval` gán được `IFS`, mã cùng shell guard không đọc) → mọi `$` KHÔNG nằm trực tiếp trong nháy kép
#     (không nháy, nháy đơn — thân eval/trap/sh -c —, trong `${…}`/`$(…)`, `\\$` kể cả trong nháy kép — chữ mà
#     `mapfile -C`/`${x@P}` đọc lại, review adr-guard) → chặn (AUD-SEC-388); giá trị cờ không nháy của
#     read/mapfile/printf/wait/unset (bash tách thành thêm cờ/tên đích) và thân heredoc không nháy cũng bật (B). Chỉ miễn
#     theo GIÁ TRỊ: `$?`/`$#`/`$$`/`$!`/`${#…}` (số), mở `$((…))` đóng như bash (số), mở `$'…'` (nháy, không mở rộng);
# (C) heredoc dấu kết không nháy có `$`/backtick khi lệnh có shell đọc stdin (cả `bash 0<<E`) → chặn: thân mở rộng hai
#     lần (AUD-SEC-392); trình thông dịch (perl/python/ruby…) cùng thân có dấu mở rộng lần hai (`\\$`, backtick) → chặn;
# (D) chữ dữ liệu chạy như mã trong shell này mà guard không đọc: `mapfile`/`readarray -C`, `${x@P}` → luôn chặn.
DYN_HEAD_WHY = (
    'từ lệnh dựng lúc chạy (`$c`, `"${a[@]}"`, `$(…)`) — guard không biết lệnh nào chạy (AUD-SEC-391, ADR-0065);'
    " viết lại: gọi lệnh bằng tên nguyên văn (`git push …`), dữ liệu để ở đối số trong nháy kép"
)
SPLIT_WHY = (
    "mở rộng ngoài nháy kép khi lệnh nhắc `IFS` hay gán tên-đích-động — bash tách/đánh giá khác guard (AUD-SEC-388,"
    ' ADR-0065); viết lại: đặt mọi mở rộng trong nháy kép (`"$c"`, `"${a[@]}"`, `"$(…)"`), tên đích nguyên văn'
    " (`printf -v out`), tách phần nhắc `IFS` sang lệnh riêng"
)
# `for i in $(…)` không nháy được (nháy làm cả kết quả thành MỘT từ) — câu viết lại riêng (review adr-guard lượt 2 🟠)
SPLIT_FOR_SUBST_RE = re.compile(r"(?:^|[\s;&|(])for[ \t]+\w+[ \t]+in[ \t][^;\n]*\$\(")
SPLIT_FOR_HINT = (
    "; vòng `for … in $(…)`: `for ((i=1; i<=N; i++))`, danh sách nguyên văn (`for i in 1 2 3`) hay"
    " `cmd | while read -r i; do …; done`"
)
HERE_SHELL_WHY = (
    "heredoc không nháy có `$`/backtick đi vào shell/trình thông dịch — thân mở rộng hai lần (AUD-SEC-392, ADR-0065);"
    " viết lại: `<<'EOF'` có nháy, dữ liệu truyền qua biến môi trường/đối số"
)
REREAD_WHY = (
    "chữ dữ liệu chạy như mã trong shell này (`mapfile -C`, `${x@P}`) — guard không đọc được (AUD-SEC-388, ADR-0065);"
    " viết lại: vòng `while IFS= read -r l; do …; done` gọi lệnh nguyên văn, in chữ bằng `printf '%s' \"$x\"`"
)
REREAD_PROMPT_RE = re.compile(r"\$\{[^{}]*@P\}")  # `${x@P}`: mở rộng giá trị như dấu nhắc — chạy `$(…)` trong đó
SPLIT_DECLARERS = frozenset("declare typeset local export readonly".split())
SPLIT_NAME_RE = re.compile(r"[A-Za-z_]\w*(?:\[[^\[\]$`]*\])?\+?")  # đích nguyên văn: tên, chỉ số không mở rộng
SPLIT_CASE_RE = re.compile(r"\$\{[#!]?\w+(?:\[[^\]]*\])?(?:\^|~|@[Uu])")  # đổi chữ thường từ dữ liệu thành hoa
SPLIT_NUM_RE = re.compile(r"\$(?:[?#$!]|\{#)")  # `$?`/`$#`/`$$`/`$!`, độ dài `${#…}`: ra số


def _allowlist_why(cmd: str, root: str = "", cwd: Optional[str] = None) -> str:
    """ADR-0065: lý do chặn của lớp danh sách trắng (rỗng = qua); nợ cùng họ: mảng nhiễm làm đối số, ghi rồi chạy
    script, script từ đường dẫn fd (AUD-SEC-399/400/402)."""
    why = _dyn_head_why(cmd) or _reread_why(cmd) or _split_why(cmd) or _here_shell_why(cmd)
    why = why or _array_arg_why(cmd) or _script_run_why(cmd) or _reuse_why(cmd) or _fd_script_why(cmd)
    why = why or _home_dyn_why(cmd) or _run_named_why(cmd) or _implicit_load_why(cmd) or _patch_file_why(cmd)
    return why or _git_cfg_env_why(cmd, root, cwd)


def _reread_why(cmd: str) -> str:
    """(D) `mapfile`/`readarray -C` (callback là chữ chạy như mã) hay `${x@P}` (mở rộng dấu nhắc chạy `$(…)` trong giá
    trị) — chữ dữ liệu chạy trong shell này, không lớp lồng nào quét (review adr-guard). `@P` xét trên chữ bash còn mở
    rộng (cả thân heredoc không nháy); trong nháy đơn là chữ — thân eval/`sh -c` do lớp lồng quét như script."""
    v, bodies = _split_view(cmd)
    if REREAD_PROMPT_RE.search("\n".join([_code_views(v)[0], *bodies])):
        return REREAD_WHY
    for head, args in map(_ifs_head, _ifs_argvs(cmd) or []):
        opts = "".join(_dequote(w)[1:] for w in _no_redirects(args) if _is_opt(w))
        if head in ("mapfile", "readarray") and "C" in opts:
            return REREAD_WHY
    return ""


def _dyn_head_why(cmd: str) -> str:
    """(A) Từ lệnh không phải chữ nguyên văn (AUD-SEC-391: `read -ra a …; "${a[@]}"`)."""
    heads = _command_heads(cmd)
    return DYN_HEAD_WHY if heads is None or any(re.search(r"[$`]", h) for h in heads) else ""


def _command_heads(cmd: str) -> Optional[List[str]]:
    """Từ lệnh còn nháy của mọi lệnh đơn; None = không tách chắc. `$` trơn là token mờ của `_no_redirects` (đích chuyển
    hướng bị cắt ở `>(`), không phải từ lệnh. `$(cat <<'X'`…`X)` làm từ lệnh cũng tính: ở lệnh gốc guard không quét thân
    như script (base cho chạy `$(cat <<'E'` ↵ `git push --force origin main` ↵ `E` ↵ `)`). Mọi từ ngay sau `{` trơn cũng là
    từ lệnh — không suy `function NAME {`/`coproc NAME {` là cấu trúc gì (review adr-guard: `function f { "${a[@]}"; }`);
    lệnh bọc không kèm lệnh (`exec >log`, `env A=1`) thì chính nó là từ lệnh."""
    raw = _raw_tokens(cmd, True)
    argvs = None if raw is None else _plain_argvs(raw)
    if argvs is None:
        return None
    heads: List[str] = []
    for seg in (s for argv in argvs for s in _brace_segments(argv)):
        rest = _ifs_prefix(seg)[1]
        k = len(rest) - len(_strip_prefixes([_dequote(t) for t in rest]))
        heads += [] if _command_query(rest[:k]) else [h for h in rest[k : k + 1] or rest[:1] if h != "$"]
    return heads


COMMAND_QUERY_RE = re.compile(r"-[pvV]*[vV][pvV]*")  # `command -v`/`-V`/`-pv`: tra tên, không chạy


def _command_query(prefix: List[str]) -> bool:
    """Phần lệnh bọc có `command` mà cờ NGAY SAU nó (tới `--`/từ đầu tiên không phải cờ) có `-v`/`-V` (cả gộp `-pv`):
    mọi tên sau đó chỉ được tra (như `type -P`, `which`), không chạy — không phải từ lệnh (review adr-guard lượt 2 🟠).
    `command NAME`/`command -p NAME`, cờ `-v` của lệnh bọc khác (`command -p env -v "$x"`) vẫn chạy NAME."""
    plain = [_dequote(w) for w in prefix]
    at = [i for i, w in enumerate(plain) if posixpath.basename(w) == "command"]
    flags = itertools.takewhile(lambda w: w.startswith("-") and w != "--", plain[at[-1] + 1 :] if at else [])
    return any(COMMAND_QUERY_RE.fullmatch(w) for w in flags)


def _brace_segments(argv: List[str]) -> List[List[str]]:
    """argv cắt ở mỗi token `{` trơn (không nháy): phần sau `{` đọc như một lệnh đơn mới."""
    segs: List[List[str]] = [[]]
    for t in argv:
        if t == "{":
            segs.append([])
        else:
            segs[-1].append(t)
    return segs


def _plain_argvs(tokens: List[str]) -> Optional[List[List[str]]]:
    """Lệnh đơn trên token còn nháy (`_ArgvSplit`), bỏ phần tử mảng `a=(…)` (dữ liệu) và biểu thức của lệnh số học
    `((…))` (luật số học xét riêng). `((` mà bash không đọc là số học (không đóng bằng `))` liền) hay mảng không đóng →
    None."""
    st = _ArgvSplit()
    it = iter(tokens)
    for t in it:
        if not _is_punct(t):
            st.cur.append(t)
            continue
        rest: Optional[str] = t
        if t.startswith("(") and st.cur and st.cur[-1].endswith("="):
            rest = _skip_array(it)
        elif t.startswith("((") and all(_dequote(w) in (*SHELL_KEYWORDS, *ARITH_LEADS) for w in st.cur):
            st.cur.append("((")
            rest = _skip_arith(t, it)
        if rest is None:
            return None
        st.punct(rest)
    return [c for c in [*st.out, st.cur] if c]


ARITH_LEADS = ("for", "time")  # cùng `SHELL_KEYWORDS`: `((` sau các từ này vẫn ở vị trí lệnh (`if ((`, `for ((`)
# Mảnh của một dãy dấu: mở thay tiến trình, ngoặc, chuyển hướng (`>&`, `>|`, `&>>`, `<<<`), toán tử điều khiển.
PUNCT_PIECE_RE = re.compile(r"[<>]\(|[()]|&>>?|[<>]+[&|]?|[;&|\n]+")
PROCSUB_WORD = "_procsub_"  # chỗ của `<(…)`/`>(…)` trong argv lệnh ngoài (đích chuyển hướng, đối số)


class _ArgvSplit:
    """Tách lệnh đơn như `split_commands`, trừ thay tiến trình: `<(`/`>(` mở lệnh trong, `)` đóng nó thì từ sau vẫn là
    đối số của lệnh ngoài (`diff <(cat a) $S/b` — `$S/b` không phải từ lệnh; `< <(x) $c` — `$c` là từ lệnh)."""

    def __init__(self) -> None:
        self.out: List[List[str]] = []
        self.cur: List[str] = []
        self.outer: List[Optional[List[str]]] = []  # mỗi `(` đang mở: argv ngoài của `<(`/`>(`, None với subshell

    def new(self) -> None:
        self.out.append(self.cur)
        self.cur = []

    def punct(self, p: str) -> None:
        for piece in PUNCT_PIECE_RE.findall(p):
            if piece in ("<(", ">("):
                self.outer.append(self.cur)
                self.cur = []
            elif piece == "(":
                self.outer.append(None)
                self.new()
            elif piece == ")":
                back = self.outer.pop() if self.outer else None
                self.new()
                self.cur = self.cur if back is None else [*back, PROCSUB_WORD]
            elif _is_redirect(piece):
                self.cur.append(piece)
            else:
                self.new()


def _skip_array(it: Iterator[str]) -> Optional[str]:
    """Bỏ phần tử mảng tới token dấu có `)`; trả phần dấu sau `)` (None = không đóng)."""
    for t in it:
        if _is_punct(t) and ")" in t:
            return t[t.index(")") + 1 :]
    return None


def _skip_arith(first: str, it: Iterator[str]) -> Optional[str]:
    """Bỏ lệnh số học mở ở `first` (`((`…) như bash: đếm ngoặc tới `)` hạ về tầng `((` mà ký tự kế là `)`; trả phần dấu
    sau `))` — `)` khác ở tầng đó (bash đọc lại thành subshell lồng) hay không đóng → None."""
    depth = 0
    for t in itertools.chain([first], it):
        for k, ch in enumerate(t if _is_punct(t) else ""):
            if ch == "(":
                depth += 1
            elif ch == ")" and depth == 2:
                return t[k + 2 :] if t[k + 1 : k + 2] == ")" else None
            elif ch == ")":
                depth -= 1
    return None


def _split_why(cmd: str) -> str:
    """(B) Có thể đổi `IFS`/gán biến tên lúc chạy mà còn `$` ngoài nháy kép trực tiếp (AUD-SEC-388)."""
    if not _split_trigger(cmd, 0):
        return ""
    v, bodies = _split_view(cmd)
    if not (v.why or _unsafe_dollar(v) or any(map(_here_body_unsafe, bodies))):
        return ""
    return SPLIT_WHY + (SPLIT_FOR_HINT if SPLIT_FOR_SUBST_RE.search(_code_views(v)[1]) else "")


def _split_trigger(text: str, depth: int) -> bool:
    """Chữ thô nhắc `IFS` (dạng chỉ-chữ-số, cả trong nháy/thân heredoc); trên chữ bash còn mở rộng (ngoài nháy đơn và
    thân heredoc có nháy): `${!…}`, đổi hoa từ dữ liệu (`${x^^}`); tên đích không nguyên văn, nameref `-n`, `declare -u`,
    gán có `$` trong số học, mã cùng shell guard không đọc (`source`/`.`, `mapfile -C`); thân `eval`/`trap` xét như lệnh
    (sâu quá `STRICT_EVAL_DEPTH` tầng = có). Thân heredoc không nháy là chữ bash còn mở rộng — với builtin (`: <<E` ↵
    `${!y:=/}`) mở rộng ngay trong shell này (review adr-guard)."""
    if depth > STRICT_EVAL_DEPTH or _mentions_ifs(text):
        return True
    argvs = _ifs_argvs(text)
    v = _CodeView(_fold_heredocs(join_continuations(text), True))
    if argvs is None or v.why:
        return True
    live, bare = _code_views(v)
    live = "\n".join([live, *_split_view(text)[1]])
    if "${!" in live or SPLIT_CASE_RE.search(live):
        return True
    if any(map(_arith_dyn, _arith_texts(argvs, live, bare) + _unquoted_arith_texts(v, argvs))):
        return True
    return any(_argv_split_trigger(a, depth) for a in argvs)


SPLIT_TEST_V_RE = re.compile(r"(?<![\w-])-v[ \t]")  # `[[ -v NAME[sub] ]]`/`test -v`: chỉ số mảng là biểu thức số học


def _unquoted_arith_texts(v: _CodeView, argvs: List[List[str]]) -> List[str]:
    """Toán hạng số học bash BỎ NHÁY rồi mới đánh giá (review adr-guard lượt 2 🔴): toán hạng `[[ … -eq … ]]` và chỉ số
    của `-v` ở `[[ ]]`/`test`/`[` — `[[ 'k' -eq 0 ]]`, `[[ $'\\153' -eq 0 ]]`, `[[ \\k -eq 0 ]]`, `test -v 'a[k]'` đánh
    giá đệ quy giá trị `k` (`IFS=4` đọc từ tệp gán `IFS` — đã chạy bash 5.2.21). Đọc trên chữ GIỮ nháy đơn/`$'…'`/ký tự
    thoát (chỉ bỏ comment): nháy không làm toán hạng thành chữ. Toán hạng `-v` có `$`/backtick (tên đích lúc chạy) cả
    chuỗi tính; không có `[`/`$` (`-v HOME`) thì chỉ tra biến, không đánh giá gì. Chỉ số khởi tạo mảng `[k]=` (cả trong
    nháy của đối số `declare -a 'a=([k]=v)'`, `a=(['k']=v)`) cũng đánh giá đệ quy (review #423)."""
    chars = list(v.s)
    for a, b in v.comments:
        chars[a:b] = [" "] * (b - a)
    raw = "".join(chars)
    tests = _double_brackets(raw)
    texts = [ARITH_TEST_OP_RE.sub(" ", t) for t in tests if ARITH_TEST_RE.search(t)]
    texts += [m[1] for m in ARITH_BARE_RES[1].finditer(raw)]
    ops = [t[m.end() :] for t in tests for m in SPLIT_TEST_V_RE.finditer(t)]
    for head, args in map(_ifs_head, argvs):
        words = args if head in ("test", "[") else []
        ops += [w for p, w in zip(words, words[1:]) if _dequote(p) == "-v"]
    return texts + [op if re.search(r"[$`]", op) else op.partition("[")[2] for op in ops]


def _mentions_ifs(text: str) -> bool:
    """Chữ thô có `IFS` (cả trong nháy, comment, thân heredoc), hay một TỪ có `IFS` ở dạng chỉ-chữ-số (`I""FS`, `I\\FS`,
    `$'\\x49'FS`, `{I,}FS`, `I${x}FS`) — không ghép chữ qua ranh giới từ (`grep -rIF "SELECT"` không tính)."""
    if "IFS" in text:
        return True
    raw = _raw_tokens(text)
    return any("IFS" in f for w in ([text] if raw is None else raw) for f in _letter_forms(w))


def _argv_split_trigger(argv: List[str], depth: int) -> bool:
    head, args = _ifs_head(argv)
    words = _no_redirects(args)
    opts = "".join(_dequote(w)[1:] for w in words if _is_opt(w))
    if head in SPLIT_DECLARERS:
        if re.search(r"[$`]", opts) or (head in IFS_DECLARERS and re.search(r"[nu]", opts)):
            return True
        return not all(_split_name(w) for w in words if not _is_opt(w))
    if head in IFS_OPT_TARGETS:
        takes, names, positional = IFS_OPT_TARGETS[head]
        if ("C" in takes and "C" in opts) or any(map(_word_splits, _opt_words(head, words))):
            return True
        return not all(map(_split_name, _opt_targets(words, takes + names, names, positional)))
    if head in ("for", "select", "coproc"):
        return bool(words) and not _split_name(words[0])
    if head == "getopts":
        return len(words) > 1 and not _split_name(words[1])
    if head in ("eval", "trap"):
        return _split_trigger(" ".join(d for d in map(_dequote, words) if d != "--"), depth + 1)
    return head in ("source", ".")


def _opt_words(head: str, words: List[str]) -> List[str]:
    """Từ mà bash còn đọc làm cờ/tên đích của read/mapfile/readarray/wait/unset/printf: mọi từ; với `printf` chỉ phần cờ
    tới hết định dạng (từ đầu tiên không phải cờ — sau đó là đối số in ra, `printf '%s' $x` không gán gì; `-v` ăn một
    từ; `--` hết cờ)."""
    if head != "printf":
        return [w for w in words if w != "$"]
    i = 0
    while i < len(words) and _is_opt(words[i]) and _dequote(words[i]) != "--":
        i += 1 + (_dequote(words[i]) == "-v")
    return words[: i + (i < len(words) and _dequote(words[i]) != "--")]


def _word_splits(word: str) -> bool:
    """Từ có mở rộng bash còn tách từ — `$` ở tầng ngoài, không nháy (nháy đơn/kép, `\\$` là chữ hay một từ), trừ giá
    trị ra số (`$?`, `$((…))`); backtick/không đọc chắc cũng tính: giá trị cờ `read -t $T v` với T=`1 IFS` thành
    `read -t 1 IFS v` (review adr-guard)."""
    v = _CodeView(word)
    arith = {a for a, _ in _arith_spans(_code_views(v)[0])}
    bare = (i for i, c in enumerate(word) if c == "$" and v.top[i] and v.kind[i] == "c")
    return bool(v.why) or any(not SPLIT_NUM_RE.match(word, i) and i + 1 not in arith for i in bare)


def _split_name(word: str) -> bool:
    """Đích gán nguyên văn: `NAME`, `NAME[chỉ số không mở rộng]`, có thể kèm `+`/`=giá trị` (giá trị không xét). Khoảng
    trắng (trong nháy/thoát) ở phần tên: không phải tên (`_dequote` ghép `"a b"` thành `ab`)."""
    name = word.partition("=")[0]
    return not re.search(r"\s", name) and bool(SPLIT_NAME_RE.fullmatch(_dequote(word).partition("=")[0]))


def _split_view(cmd: str) -> Tuple[_CodeView, List[str]]:
    """(chữ mã — thân heredoc đã bỏ, thân các heredoc dấu kết không nháy)."""
    lines = join_continuations(cmd).split("\n")
    bodies: List[str] = []
    for _, m, a, b, _ in _here_scan("\n".join(lines)):
        if not _heredoc_word(m)[1]:
            bodies.append("\n".join(lines[a:b]))
            lines[a:b] = [" " * len(x) for x in lines[a:b]]
    return _CodeView(_fold_heredocs("\n".join(lines), True)), bodies


def _unsafe_dollar(v: _CodeView) -> bool:
    """Có `$` không nằm trực tiếp trong nháy kép, trừ tham số ra số, mở `$((…))` số học, mở `$'…'`."""
    live = _code_views(v)[0]
    arith = {a for a, _ in _arith_spans(live)}
    s, i = v.s, v.s.find("$")
    while i >= 0:
        num = SPLIT_NUM_RE.match(s, i)
        if num:
            i = s.find("$", num.end())
            continue
        if i not in v.dq_dollars and i not in v.ansi_opens and i + 1 not in arith:
            return True
        i = s.find("$", i + 1)
    return False


def _here_body_unsafe(body: str) -> bool:
    """Thân heredoc không nháy (mở rộng như trong nháy kép): `$` bên trong `$(…)`/`${…}` (mã/biểu thức), `\\$`/`\\``
    (thành mở rộng nếu thân bị đọc lại), backtick."""
    depth = i = 0
    while i < len(body):
        c = body[i]
        if c == "`" or (c == "\\" and body[i + 1 : i + 2] in ("$", "`")) or (c == "$" and depth):
            return True
        if c == "$" and body.startswith(("$(", "${"), i):
            depth, i = 1, i + 2
            continue
        depth += (c in "({") - (c in ")}") if depth else 0
        i += 2 if c == "\\" else 1
    return False


def _here_shell_why(cmd: str) -> str:
    """(C) Heredoc dấu kết không nháy có `$`/backtick mà lệnh có shell đọc stdin (`| bash`, `bash <<E`, `. /dev/stdin`,
    `| xargs sh -c`, cả fd tường minh `bash 0<<E`) — AUD-SEC-392: `cat <<EOF | bash` với `\\$(…)`. Lệnh có trình thông
    dịch (perl/python/ruby… — có thể chạy chữ stdin qua shell: `perl -e 'system(<STDIN>)'`) mà thân có dấu mở rộng lần
    hai (`_here_body_unsafe`: `\\$`, backtick, `$` trong `$(…)`/`${…}`) cũng chặn (review adr-guard)."""
    bodies = [b for b in _split_view(cmd)[1] if re.search(r"[$`]", b)]
    if not bodies:
        return ""
    raw = _raw_tokens(cmd)
    argvs = [] if raw is None else [[_dequote(t) for t in c] for c in split_commands(raw)]
    shell = raw is None or any(_stdin_shell(c) or _argless_shell_c(c) or _xargs_replace_shell(c) for c in argvs)
    interp = any(INTERP_RE.fullmatch(posixpath.basename(h)) for c in argvs for h in normalize(c)[:1])
    return HERE_SHELL_WHY if shell or (interp and any(map(_here_body_unsafe, bodies))) else ""


# AUD-SEC-399: guard không giải mảng — `read -ra a <<< "push --force origin main"; git "${a[@]}"` chạy push mà guard thấy
# `git "${a[@]}"` (biến vô hướng cùng nguồn thì được giải → RULE_DENY). Mảng làm đối số của lệnh có luật theo đối số
# (`GLOB_COMMANDS`) chỉ qua khi MỌI gán của nó trong lệnh là mảng chữ nguyên văn `a=(x 'y z')` và không lệnh nào ghi vào
# nó (read/mapfile/printf -v…); nguồn không thấy (hàm, `source`, `eval`) cũng chặn.
ARRAY_ARG_WHY = (
    "mảng dựng từ dữ liệu (`read -a`, `mapfile`, phần tử là mở rộng, nguồn không thấy) làm đối số của lệnh guard xét"
    " đối số — guard không biết đối số thật (AUD-SEC-399, ADR-0065); viết lại: đối số nguyên văn (`git add a b`), hay"
    ' một lệnh mỗi phần tử: `for x in "${a[@]}"; do git add -- "$x"; done`'
)
ARRAY_USE_RE = re.compile(r"\$\{!?([A-Za-z_]\w*)\[")  # `${a[@]}`, `${a[*]}`, `${a[k]}`, `${!a[@]}` — không `${#…}`
ARRAY_SET_RE = re.compile(r"(?<![\w$\[.-])([A-Za-z_]\w*)(\[[^\]\n]*\])?\+?=(\([^()]*\))?")
ARRAY_LITERAL_RE = re.compile(r"\([^$`*?\\]*\)")  # phần tử nguyên văn: không mở rộng/glob/thoát
ARRAY_TARGET_HEADS = frozenset({"read", "mapfile", "readarray", "printf", "getopts", "wait"})


# Review #426 🔴 (AUD-SEC-405): mảng chữ nguyên văn không được MIỄN mà được GIẢI — dạng dùng cả từ `"${a[@]}"`,
# `${a[@]}`/`${a[*]}` (phần tử không khoảng trắng/ký tự đặc biệt), `"${a[*]}"` một phần tử, `${a[N]}` thay bằng phần tử
# như viết (`~` mở như lúc gán) rồi quét lại (`_lifted_scripts`) — luật áp như dạng nguyên văn; dạng khác → BUDGET. Tham
# số vị trí (`"$@"`, `$*`, `${@…}`, `$1`) là mảng guard không giải khi lệnh có `set` đặt chúng hay định nghĩa hàm.
ARRAY_WORD_RE = re.compile(r'(")?\$\{([A-Za-z_]\w*)\[(@|\*|\d+)\]\}(?(1)")')
ARRAY_PLAIN_RE = re.compile(r"[\w./@%+=:,~^-]+")  # phần tử giữ nguyên khi tách từ không nháy
POSITIONAL_USE_RE = re.compile(r"\$(?:[@*1-9]|\{[@*1-9])")
FUNC_DEF_RE = re.compile(r"(?:^|[\s;&|(){}])(?:function[ \t]+[^\s(){};&|]+|[A-Za-z_][\w.:-]*[ \t]*\([ \t]*\))")
SET_VALUE_OPTS = ("-o", "+o")


def _array_arg_why(cmd: str) -> str:
    """Mảng/tham số vị trí guard không giải được làm đối số của lệnh trong `GLOB_COMMANDS` (cả sau `sudo`/`env`…)."""
    argvs = _ifs_argvs(cmd) or []
    heads = [_ifs_head(s) for a in argvs for s in _brace_segments(a)]  # `function f { git "$@"; }`: từ sau `{` là lệnh
    words = [w for head, args in heads if head in GLOB_COMMANDS for w in args]
    lits = _array_literals(cmd, heads)
    arrays = any(ARRAY_USE_RE.search(w) and _array_word(w, lits) is None for w in words)
    positional = any(map(POSITIONAL_USE_RE.search, words)) and (
        bool(FUNC_DEF_RE.search(strip_heredocs(cmd))) or any(_sets_positional(h, a) for h, a in heads)
    )
    return ARRAY_ARG_WHY if arrays or positional else ""


def _array_literals(cmd: str, heads: List[Tuple[str, List[str]]]) -> Dict[str, Optional[List[str]]]:
    """Tên mảng → phần tử như viết (token còn nháy) khi gán DUY NHẤT một lần bằng mảng chữ nguyên văn và không lệnh
    nào ghi vào nó (read/mapfile/printf -v…), không có mã cùng shell (`source`/`eval`); khác → None."""
    out: Dict[str, Optional[List[str]]] = {}
    for m in ARRAY_SET_RE.finditer(cmd):
        lit = not m[2] and m[3] is not None and bool(ARRAY_LITERAL_RE.fullmatch(m[3])) and m[1] not in out
        elems = _raw_tokens(m[3][1:-1]) if lit else None
        out[m[1]] = elems if elems is not None and not any(_is_punct(e) or e[:1] == "[" for e in elems) else None
    written = {_dequote(w).partition("[")[0] for head, args in heads if head in ARRAY_TARGET_HEADS for w in args}
    same = any(head in IFS_SAME_SHELL for head, _ in heads)
    return {k: None if same or k in written else v for k, v in out.items()}


def _array_word(word: str, lits: Dict[str, Optional[List[str]]]) -> Optional[str]:
    """Chữ thay cho TỪ `word` dùng mảng chữ nguyên văn (`"${a[@]}"` → `x 'y z'`); None = không giải được."""
    m = ARRAY_WORD_RE.fullmatch(word)
    elems = lits.get(m[2]) if m else None
    if m is None or elems is None:
        return None
    if m[3].isdigit():
        return elems[int(m[3])] if int(m[3]) < len(elems) else '""'
    if m[1] and m[3] == "@":
        return " ".join(elems)
    if m[1]:
        return elems[0] if len(elems) == 1 else None  # `"${a[*]}"` nhiều phần tử: nối theo IFS — không giải
    return " ".join(elems) if all(ARRAY_PLAIN_RE.fullmatch(e) for e in elems) else None


def _sets_positional(head: str, args: List[str]) -> bool:
    """`set --`, `set a b` đặt tham số vị trí (cờ `-e`/`-o pipefail` thì không)."""
    words = [_dequote(w) for w in _no_redirects(args)]
    after_o = [i > 0 and words[i - 1] in SET_VALUE_OPTS for i in range(len(words))]
    return head == "set" and any(w == "--" or (w[:1] not in "-+" and not o) for w, o in zip(words, after_o))


def _array_lifted(cmd: str) -> str:
    """Dòng lệnh với mọi từ dùng mảng chữ nguyên văn đã thay bằng phần tử (`_array_word`) — rỗng nếu không có gì thay."""
    lits = _array_literals(cmd, [_ifs_head(a) for a in _ifs_argvs(cmd) or []])
    if not any(lits.values()):
        return ""
    out = ARRAY_WORD_RE.sub(lambda m: _array_word(m[0], lits) or m[0], cmd)
    return "" if out == cmd else out


# AUD-SEC-400: guard không đọc tệp script lúc chạy (`bash s.sh` đứng riêng cũng vậy) — tệp do chính lệnh ghi rồi chạy thì
# guard không biết lệnh nào chạy: `printf 'git push --force origin main' > s.sh; bash s.sh`. So theo tên tệp (bỏ thư mục:
# `cd` giữa chừng), đích/đường dẫn có mở rộng thì coi như có thể trùng; ghi vào `/dev/…` không tính.
SCRIPT_RUN_WHY = (
    "tệp do chính lệnh ghi (`>`, `tee`, `cp`, heredoc `> f`) được chạy như script trong cùng lệnh — guard không đọc tệp"
    " lúc chạy (AUD-SEC-400, ADR-0065); viết lại: chạy lệnh nguyên văn, hay ghi tệp bằng công cụ Write rồi chạy ở lệnh"
    " Bash riêng"
)
SCRIPT_RUN_DEPTH = 3  # số tầng `$(…)`/backtick/`sh -c`/`eval` lồng được đọc tìm tệp chạy
SCRIPT_RUN_DEEP = "./$"  # tầng sâu hơn không đọc: coi như chạy một tệp tên có mở rộng (trùng mọi tệp đã ghi)
SCRIPT_NAME_DYN_RE = re.compile(r"[$`*?\[{}()]")  # `}`/`)`: đuôi của mở rộng có `/` bên trong (`${x/a/s.sh}`)
# Đường fd (và stdin) mà shell/`source` đọc ra script: `/proc/<mọi tiến trình>/fd/N` — `$$`, `thread-self`, số (AUD-SEC-515:
# một định nghĩa; so trên đường đã `_norm_path`)
FD_SCRIPT_RE = re.compile(r"/dev/(?:stdin|fd/\d+)|/proc/[^/]+/fd/\d+")
FD_SCRIPT_WHY = (
    "shell/`source`/trình thông dịch đọc script từ đường dẫn fd (`/dev/fd/N`, `/proc/self/fd/N`) — thân heredoc/"
    "here-string gắn fd đó chạy như script mà guard không quét (AUD-SEC-402, ADR-0065); viết lại: heredoc vào stdin"
    " (`bash <<'EOF'`) hay lệnh nguyên văn"
)


def _script_run_why(cmd: str) -> str:
    """Lệnh đơn này ghi tệp mà lệnh đơn KHÁC chạy (`python3 x.py > "$LOG"`: chuyển hướng mở trước khi chạy — không tính).
    Dạng `_heredoc_run` (D-324) không chặn: thân được quét như script của trình chạy (`_nested_sources`)."""
    if _heredoc_run(cmd) is not None:
        return ""
    argvs = _nested_argvs(cmd, 0)
    writes = _file_index([[w for w in write_targets(normalize(a), a) if not _dev_sink(w)] for a in argvs])
    runs = _file_index([_run_files(a) for a in argvs] if writes else [])
    dyn_w, dyn_r = writes.pop(SCRIPT_NAME_DYN, set()), runs.pop(SCRIPT_NAME_DYN, set())
    any_w, any_r = dyn_w.union(*writes.values()), dyn_r.union(*runs.values())
    pairs = [(dyn_w, any_r), (any_w, dyn_r)] + [(writes[k], runs[k]) for k in writes.keys() & runs.keys()]
    return SCRIPT_RUN_WHY if any(a and b and len(a | b) > 1 for a, b in pairs) else ""


SCRIPT_NAME_DYN = "$"  # khoá chung của mọi tên có mở rộng/glob (không biết tên: có thể trùng mọi tệp)


def _file_index(files: List[List[str]]) -> Dict[str, Set[int]]:
    """Tên tệp (bỏ thư mục — `cd` giữa chừng) → các lệnh đơn có nó; tên có mở rộng/glob gom về `SCRIPT_NAME_DYN` (chỉ
    phần thư mục có mở rộng — `$S/x.py` — thì tên vẫn biết). Một cặp (ghi, chạy) chỉ tính khi ở hai lệnh đơn khác nhau:
    `len(a | b) > 1`."""
    out: Dict[str, Set[int]] = {}
    for i, names in enumerate(files):
        for name in map(_file_name, names):
            out.setdefault(SCRIPT_NAME_DYN if SCRIPT_NAME_DYN_RE.search(name) else name, set()).add(i)
    return out


def _file_name(path: str) -> str:
    return posixpath.basename(posixpath.normpath(path))


# Review #426 🔴: chỉ các thiết bị không phải tệp mới bỏ khỏi đích ghi — `/dev/shm/s.sh` là tệp thật (tmpfs).
DEV_SINK_RE = re.compile(r"/dev/(?:null|stdin|stdout|stderr|tty|fd/\d+)")


def _norm_path(path: str) -> str:
    """normpath + gộp `//` đầu (POSIX giữ `//x`, Linux đọc như `/x`)."""
    return re.sub(r"^/+", "/", posixpath.normpath(path))


def _dev_sink(path: str) -> bool:
    return bool(DEV_SINK_RE.fullmatch(_norm_path(path)))


DEV_ROOTS = ("/dev", "/proc")  # tệp thiết bị/của tiến trình: nội dung phụ thuộc tiến trình mở nó
SYMLINK_HOPS = 40  # như MAXSYMLINKS của Linux: quá thì kernel báo ELOOP


def _dev_path(path: str) -> bool:
    """AUD-SEC-511: `path` sau `_norm_path` là `/dev`, `/proc` hay nằm dưới chúng (`/dev/./stdin`, `//proc/self/fd/0`);
    `/dev/../tmp/x` thì không."""
    p = _norm_path(path)
    return any(p == d or p.startswith(d + "/") for d in DEV_ROOTS)


def _via_dev(path: str) -> bool:
    """AUD-SEC-513: đường tuyệt đối `path` tới `/dev`/`/proc` khi theo symlink từng thành phần như kernel (`ln -s /dev
    d; . d/stdin`, `ln -s /dev/stdin s`) — không `stat`/`open` phần nằm dưới đó, nên kết quả không phụ thuộc stdin của
    chính guard. Đọc link lỗi → True (không biết); vòng symlink → False (kernel báo ELOOP, tệp không mở được)."""
    todo, here, hops = path.split("/"), "/", 0
    while todo:
        part = todo.pop(0)
        here = posixpath.dirname(here) if part == ".." else here if part in ("", ".") else posixpath.join(here, part)
        if _dev_path(here):
            return True
        if hops < SYMLINK_HOPS and os.path.islink(here):
            hops += 1
            try:
                link = os.readlink(here)
            except OSError:
                return True
            todo[:0] = link.split("/")
            here = "/" if link.startswith("/") else posixpath.dirname(here)
    return False


# D-324 (AUD-SEC-400 phương án B): nội dung tệp biết chắc khi `cat > F`/`tee F` chép một heredoc CÓ NHÁY (không mở rộng)
# — guard quét thân như script của trình chạy (`bash <<'D'`, `python3 - <<'D'`) thay vì chặn. Chỉ miễn theo giá trị khi
# lệnh có đúng một heredoc, không script lồng, writer là nơi duy nhất ghi (`>`/`>|`, không `>>`/`tee -a`/`<<-`), đúng
# một lệnh đơn chạy F bằng shell/`source`/trình thông dịch SAU writer (nối bằng `;`/`&&`/`||`/xuống dòng — không ống),
# lệnh còn lại trong `HEREDOC_RUN_SAFE` hay chỉ là gán biến, không lệnh nào khác ghi tệp, tên F không nhắc ở chỗ khác
# (cả trong thân). So theo TÊN tệp (thư mục có mở rộng — `$S/x.py` — vẫn được): trình chạy mở tệp khác cùng tên (thư mục
# khác, writer lỗi) là chạy tệp có sẵn — như `bash x.sh` đứng riêng, không phải nội dung guard chưa quét do lệnh này tạo.
HEREDOC_RUN_SAFE = (
    frozenset(  # review #426: không `cd`/`pushd`/`popd` (thân quét ở thư mục khác chỗ chạy), không `uniq`
        "chmod mkdir echo printf true false : ls cat head tail grep wc sort diff pwd cut tr date basename dirname"
        " realpath".split()
        + [""]  # chỉ gán biến SAU trình chạy (`…; S=1`); trước đó thì không miễn — `CDPATH=`/`HOME=` đổi đích (D-329)
    )
)
HEREDOC_RUN_SEP_RE = re.compile(r"(?:&&|\|\||[;\n])+")


def _heredoc_run(cmd: str) -> Optional[str]:
    """Script tương đương để quét (`<trình> <<'D'` ↵ thân ↵ `D`) khi lệnh là dạng ghi heredoc có nháy rồi chạy; None nếu
    không đúng dạng (khi đó `_script_run_why` chặn như cũ)."""
    raw = _raw_tokens(cmd) if "<<" in cmd else None
    heres = _heredocs(join_continuations(cmd)) if raw is not None else []
    if raw is None or len(heres) != 1 or len(_nested_argvs(cmd, 0)) != len(split_commands(raw)):
        return None
    cmds, seps = _sep_commands(raw)
    argvs = [[_dequote(t) for t in c] for c in cmds]
    writers = [k for k, a in enumerate(argvs) if "<<" in a]
    name = _heredoc_writer(argvs[writers[0]], heres[0][1]) if len(writers) == 1 else ""
    j = _heredoc_runner(argvs, writers, name) if name else -1
    if j < 0 or not all(HEREDOC_RUN_SEP_RE.fullmatch(s) for s in seps[writers[0] + 1 : j + 1]):
        return None
    base = _file_name(
        name
    )  # tên nhắc ở chỗ khác (thân heredoc, lệnh khác) — kể cả dạng đường dẫn khác — thì không miễn
    mentions = sum(t.count(base) for k, a in enumerate(argvs) if k in (writers[0], j) or a[:1] == ["chmod"] for t in a)
    return None if cmd.count(base) > mentions else _heredoc_script(_interp_argv(argvs[j])[0], heres[0][2])


def _heredoc_head(argv: List[str]) -> str:
    return (_interp_argv(argv)[:1] or [""])[0]


def _sep_commands(raw: List[str]) -> Tuple[List[List[str]], List[str]]:
    """Lệnh đơn như `split_commands` kèm dấu nối đứng trước mỗi lệnh (gộp các dấu liền nhau)."""
    cmds: List[List[str]] = []
    seps: List[str] = []
    cur: List[str] = []
    sep = ""
    for t in raw + [";"]:
        if not (_is_punct(t) and not _is_redirect(t)):
            cur.append(t)
        elif cur:
            cmds, seps, cur, sep = cmds + [cur], seps + [sep], [], t
        else:
            sep += t
    return cmds, seps


def _heredoc_writer(a: List[str], m: "re.Match[str]") -> str:
    """Tệp F mà lệnh đơn `a` (`cat > F <<'D'`, `tee F <<'D'`) ghi từ heredoc có nháy; rỗng nếu khác dạng."""
    ops = [t for t in a if _is_redirect(t)]
    outs = [a[k + 1] for k, t in enumerate(a[:-1]) if t in (">", ">|") and not _dev_sink(a[k + 1])]
    words = _no_redirects(normalize(a))
    files = outs if words == ["cat"] else words[1:] if words[:1] == ["tee"] and not outs else []
    plain = _heredoc_word(m)[1] and not m.group(0).startswith("<<-") and set(ops) <= {"<<", ">", ">|"}
    return files[0] if plain and len(files) == 1 and not SCRIPT_NAME_DYN_RE.search(_file_name(files[0])) else ""


def _heredoc_runner(argvs: List[List[str]], writers: List[int], name: str) -> int:
    """Chỉ số lệnh đơn DUY NHẤT chạy `name` bằng shell/`source`/trình thông dịch, sau writer; -1 nếu không đúng dạng (có
    lệnh khác ngoài `HEREDOC_RUN_SAFE`, lệnh khác ghi tệp, trình chạy ghi chính F; review #426: trình chạy có chuyển
    hướng vào/here-string hay đối số sau F — thân có thể đọc lệnh từ đó)."""
    rest = [k for k in range(len(argvs)) if k != writers[0]]
    runs = [k for k in rest if _heredoc_head(argvs[k]) not in HEREDOC_RUN_SAFE]
    k = runs[0] if len(runs) == 1 else -1
    if any(_heredoc_head(argvs[m]) == "" for m in range(k)):
        return (
            -1
        )  # D-329: gán biến trước trình chạy (`CDPATH=`, `HOME=`, `PYTHONPATH=`) đổi chỗ/cách chạy mà guard không biết
    n = _interp_argv(argvs[k])
    files = _script_file(n) if k > writers[0] else None
    others = [w for i in rest if i != k for w in write_targets(normalize(argvs[i]), argvs[i]) if not _dev_sink(w)]
    own = [w for w in write_targets(normalize(argvs[k]), argvs[k]) if _file_name(w) == _file_name(name)]
    same = files is not None and [_file_name(f) for f in files] == [_file_name(name)]
    last = [a for a in _no_redirects(n) if a != "$"][-1:] == files  # F là đối số cuối: không đối số vị trí sau nó
    fed = any(t[:1] == "<" for t in argvs[k] if _is_redirect(t))
    return k if same and last and not fed and not others and not own else -1


def _heredoc_script(head: str, body: List[str]) -> str:
    """`<trình> <<'D'` ↵ thân ↵ `D` — dấu kết không trùng dòng nào của thân; trình thông dịch đọc stdin bằng `-`."""
    end = "XTEOF"
    while end in body:
        end += "_"
    head = "bash" if head in ("source", ".") else head
    return f"{head}{' -' if INTERP_RE.fullmatch(head) else ''} <<'{end}'\n" + "\n".join(body) + f"\n{end}"


def _nested_argvs(cmd: str, depth: int) -> List[List[str]]:
    """Lệnh đơn (đã bỏ nháy) của `cmd` và của script lồng có chữ trong lệnh: `$(…)`/backtick (ngoài thân heredoc có nháy
    — dữ liệu), `sh -c`, `eval`/`trap`. Sâu hơn `SCRIPT_RUN_DEPTH` tầng: một lệnh chạy tệp không biết tên."""
    raw = _raw_tokens(cmd)
    out = [] if raw is None else [[_dequote(t) for t in c] for c in split_commands(raw)]
    code = [strip_heredocs(cmd), *_expanded_heredocs(cmd)]
    inner = [body for text in code for *_, body in _dollar_spans(text) + _backtick_spans(text)]
    inner += [s for a in out if (s := _shell_c_script(a))]
    inner += _eval_scripts([t for a in out for t in [*a, ";"]])
    if depth >= SCRIPT_RUN_DEPTH:
        return out + ([[SCRIPT_RUN_DEEP]] if inner else [])
    return out + [a for text in inner for a in _nested_argvs(text, depth + 1)]


def _run_files(argv: List[str]) -> List[str]:
    """Tệp mà lệnh đơn chạy như script: từ lệnh là đường dẫn (`./s.sh`), script của shell/`source`/trình thông dịch,
    tệp đổ vào stdin của chúng (`sh < f`)."""
    words, n = _strip_prefixes(argv), _interp_argv(argv)
    script, from_stdin = _program(n)
    stdin = (
        _redirect_targets(n, ("<",)) if from_stdin else []
    )  # review #426: stdin là script chỉ khi không có chương trình khác
    return [w for w in words[:1] if "/" in w] + (script or []) + stdin


def _script_file(n: List[str]) -> Optional[List[str]]:
    """Tệp script của lệnh đã chuẩn hoá `n` (rỗng: đọc stdin/`-c`/`-m`); None = không phải shell/`source`/trình thông dịch."""
    return _program(n)[0]


def _program(n: List[str]) -> Tuple[Optional[List[str]], bool]:
    """(tệp script — `_script_file`, chương trình đọc từ stdin)."""
    rest = [a for a in _no_redirects(n) if a != "$"]
    head = rest[0] if rest else ""
    if head in ("source", "."):
        return (rest[2:3] if rest[1:2] == ["--"] else rest[1:2]), False
    if head in SHELLS:
        has_c, script = _shell_script_arg(rest)
        return ([] if has_c or script is None else [script]), not has_c and script is None
    return _interp_program(rest) if INTERP_RE.fullmatch(head) else (None, False)


def _interp_program(rest: List[str]) -> Tuple[List[str], bool]:
    """Trình thông dịch: đối số đầu sau phần cờ là tệp script (`deno run FILE`); `-c`/`-e` đã cấp chương trình, `-m`, `-`
    (stdin) thì đối số sau là dữ liệu (review #426 🟠: `python3 -c '…' p.json` không chạy `p.json`)."""
    inline, i, stopped = _interp_opts(rest)
    if inline or stopped or rest[i : i + 1] == ["-"]:
        return [], not inline and not stopped
    files = [a for a in rest[i:] if a[:1] != "-"]
    files = files[:2] if files[:1] == ["run"] else files[:1]
    return files, not files


def _fd_script_why(cmd: str) -> str:
    """Shell/`source`/trình thông dịch chạy script từ đường dẫn fd khác stdin (`bash /dev/fd/3 3<<E`, `exec 3<<E …;
    bash /dev/fd/3`) — stdin (`/dev/stdin`, `/dev/fd/0`) do luật cũ quét như `bash <<E`."""
    raw = _raw_tokens(cmd)
    argvs = [] if raw is None else [[_dequote(t) for t in c] for c in split_commands(raw)]
    files = [_norm_path(f) for a in argvs for f in _script_file(_interp_argv(a)) or []]  # `/dev/./fd/3`, `//dev/fd/3`
    return FD_SCRIPT_WHY if any(FD_SCRIPT_RE.fullmatch(f) and f not in STDIN_SCRIPTS for f in files) else ""


# ADR-0066 (AUD-SEC-406): theo TÊN, không theo danh sách trình chạy — tệp F là đích ghi của một lệnh đơn (mọi cách guard
# nhận ra, `-o`/`--output`, `open(…,'w')`/`writeFile` trong `-c`/`-e`) mà đường dẫn, tên gốc hay tên gốc bỏ đuôi của F
# xuất hiện ở lệnh đơn KHÁC (từ, chữ `-c`/`-e`, thân heredoc, gán `PATH=`/`PYTHONSTARTUP=`, mẫu glob khớp F, thư mục của
# F trong biến danh sách đường dẫn) → BUDGET. OR với `_script_run_why`; miễn D-324 giữ (thân quét như script).
REUSE_WHY = (
    "tệp do chính lệnh ghi (`>`, `tee`, `-o`, `open(…,'w')`…) được nhắc lại ở lệnh đơn khác của cùng lệnh — guard không"
    " đọc tệp lúc chạy nên không biết lệnh đó có chạy nó không (AUD-SEC-406, ADR-0066); viết lại: ghi tệp bằng công cụ"
    " Write rồi chạy ở lệnh Bash riêng"
)
REUSE_SCRIPT_RE = re.compile(r".*\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|lua|awk|sed|mk)|(?:GNU)?[Mm]akefile", re.I)
# Lệnh chỉ đọc không chạy mã: nhắc tên tệp KHÔNG đuôi script ở đây không tính (trừ cờ chạy chương trình ngoài).
REUSE_READERS = frozenset(
    "cat head tail grep rg wc diff cmp sort cut ls stat file jq"  # không `less` (LESSOPEN chạy lệnh — D-329)
    # D-328: lệnh không chạy mã theo tên tệp (in tên, tạo thư mục/tệp rỗng, đổi quyền, băm) — `chmod +x F` rồi chạy F
    # vẫn bị bắt ở lệnh chạy
    " mkdir echo touch chmod md5sum sha1sum sha224sum sha256sum sha384sum sha512sum"
    # review #429 (phiên chính): phép thử tệp không mở/chạy tệp — `[ -f s.sh ] && bash s.sh`, `test -f .env && source`
    " [ [[ test"
    # AUD-SEC-419 (nợ review #429): `shellcheck` chỉ đọc/phân tích tệp (cả nguồn `-x`), `which`/`type` in đường dẫn
    " shellcheck which type".split()
)
REUSE_READER_EXEC = ("--compress-program", "--pre")  # `sort`/`rg` chạy chương trình theo giá trị cờ
# AUD-SEC-419: `git log` đọc lịch sử; chạy chương trình ngoài chỉ qua cấu hình (`-c`/`GIT_*`/PAGER — mất miễn ở
# `_reuse_reader`/`_reuse_shadowed`) hay textconv của cấu hình có sẵn — như `git show`/`git diff` đã có
REUSE_GIT_READS = (["add"], ["diff"], ["show"], ["log"], ["apply", "--check"])
# Lệnh mà `-o` không phải tệp ra (tên tuỳ chọn, cờ bật/tắt): giá trị sau nó không là đích ghi
REUSE_O_NOT_FILE = (
    frozenset("set shopt grep egrep fgrep zgrep rg ls ps pgrep pkill ssh scp mount unzip".split()) | SHELLS
)
# gán biến đổi chương trình lệnh đọc chạy. AUD-SEC-420: bỏ `*PAGER` (#430) — git/gh chỉ mở pager khi stdout là TTY,
# lệnh Bash của agent không có TTY; `GIT_PAGER` vẫn thuộc `GIT_*`
REUSE_ENV_RE = re.compile(r"(?:PATH|GIT_\w*|LESS\w*)\+?=.*", re.S)
REUSE_HOME_RE = re.compile(r"~|\$\{?(?:HOME|PWD)\b")  # tệp dưới home/thư mục hiện tại viết theo biến
REUSE_DELETERS = frozenset("rm unlink shred rmdir find".split())  # đích của `write_targets` là tệp bị xoá
REUSE_OUT_OPS = (">", ">>", ">|", "&>", "&>>")  # đích chuyển hướng ghi ở lệnh khác: chỉ ghi, không đọc/chạy
REUSE_PATHLIST_RE = re.compile(r"(?:[A-Za-z_]\w*)?(?:PATH|LIB|PRELOAD)\+?=(.*)", re.S)
REUSE_SHORT_RE = re.compile(r"-[A-Za-z0-9]{1,8}")  # cụm cờ ngắn dính giá trị: `-mx`, `-fp.awk`
REUSE_ANY = "*"  # tầng lồng sâu hơn `SCRIPT_RUN_DEPTH`: mẫu glob khớp mọi tệp
# Tên gốc bỏ đuôi chỉ để bắt trình nạp theo tên mô-đun (`-m x`, `import x`, `require("./x")`, `java X`, luật ngầm của
# `make x`); không trình nạp nào tìm `x` ra tệp dữ liệu này — `echo audit=$?` sau `> audit.log` không phải nhắc lại.
REUSE_DATA_EXT_RE = re.compile(r"\.(?:txt|log|md|json|jsonl|diff|patch|html|xml|csv|ya?ml|toml|out|err)$", re.I)


class _ReuseCmd(NamedTuple):
    argv: List[str]  # đã bỏ nháy; `$(…)`/backtick thay bằng `$_` (thân là lệnh đơn riêng)
    texts: List[str]  # chữ có thể nhắc tên: từ (trừ đích `>`, thân `sh -c`/`eval`/`trap`) + thân heredoc của lệnh
    bodies: List[str]  # thân heredoc gắn lệnh này
    pipe: bool  # stdout đổ vào lệnh đơn kế (`|`)
    top: bool  # tầng ngoài cùng (không trong `$(…)`/`sh -c`/`eval`)


def _reuse_why(cmd: str) -> str:
    if _heredoc_run(cmd) is not None:
        return ""
    cmds = _reuse_cmds(cmd, 0)
    writes = [(i, w) for i, c in enumerate(cmds) for w in _reuse_writes(c)]
    writes += [(i, w) for i in range(len(cmds)) for w in _patch_targets_at(cmds, i)]  # diff qua ống (AUD-SEC-414)
    for i, f in dict.fromkeys(writes):
        pat = _reuse_pattern(f)
        if pat is not None and any(_reuse_counts(cmds, j, f, pat) for j in range(len(cmds)) if j != i):
            return REUSE_WHY
    return ""


def _reuse_cmds(cmd: str, depth: int) -> List[_ReuseCmd]:
    """Lệnh đơn của `cmd` và của script lồng (như `_nested_argvs`), mỗi lệnh kèm chữ có thể nhắc tên tệp."""
    raw = _raw_tokens(cmd)
    if raw is None:
        return []
    bodies = ["\n".join(b) for _, _, b in _heredocs(join_continuations(cmd))] if "<<" in cmd else []
    inner = [body for text in _expanded_heredocs(cmd) for *_, body in _dollar_spans(text) + _backtick_spans(text)]
    out: List[_ReuseCmd] = []
    cmds, seps = _sep_commands(raw)
    ops = sum(_dequote(t) == "<<" for c in cmds for t in c)
    k = arith = 0
    for c, before, sep in zip(cmds, seps, seps[1:] + [""]):
        arith += before.count("((") - before.count("))")
        if arith > 0:  # trong `((…))`/`for ((…))`: `>` là so sánh, không phải chuyển hướng
            continue
        words: List[str] = []
        for t in c:
            spans: List["Span"] = []
            end = -1
            for s in sorted(_dollar_spans(t) + _backtick_spans(t)):
                spans, end = (spans + [s], s[1]) if s[0] >= end else (spans, end)
            inner += [body for *_, body in spans]
            for a, b, _ in reversed(spans):
                t = t[:a] + "$_" + t[b:]
            words.append(_dequote(t))
        n = sum(w == "<<" for w in words)
        mine = bodies[k : k + n] if ops == len(bodies) else bodies
        k += n
        scripts = [s for s in [_shell_c_script(words)] if s] + _eval_scripts(words)
        inner += scripts
        drop = set(scripts) | (set(normalize(words)[1:]) if normalize(words)[:1] == ["eval"] else set())
        texts = [w for p, w in zip([""] + words, words) if p not in REUSE_OUT_OPS and w not in drop]
        out.append(_ReuseCmd(words, texts + mine, mine, sep in ("|", "|&"), depth == 0))
    if depth >= SCRIPT_RUN_DEPTH:
        return out + ([_ReuseCmd(["$_"], [REUSE_ANY], [], False, False)] if inner else [])
    return out + [c for text in inner for c in _reuse_cmds(text, depth + 1)]


def _reuse_writes(c: _ReuseCmd) -> List[str]:
    """Đích ghi của lệnh đơn: `write_targets`, giá trị `-o`/`--output[=]`, chuỗi là đích ghi của script trình thông
    dịch (`-c`/`-e`/thân heredoc/here-string — bộ dò `_WriteProbe` sẵn có)."""
    n = normalize(c.argv)
    out = [c.argv[k + 1] for k, t in enumerate(c.argv[:-1]) if t in REDIRECTS]
    if (n[:1] or [""])[0] not in REUSE_DELETERS and n[:2] != ["git", "rm"]:  # xoá tệp: không tạo nội dung
        out += write_targets(n, c.argv) + write_targets(_no_redirects(n), [])  # `install … f <<< x`: toán hạng là f
        out += _patch_heredoc_targets(c)  # AUD-SEC-414: `patch`/`git apply` có đích trong thân heredoc
        out += _decompress_targets(n)  # review #429: `gunzip s.sh.gz` ghi `s.sh`
    if n and n[0] not in REUSE_O_NOT_FILE and n[:2] != ["git", "grep"]:  # `git grep -o`: in phần khớp (D-329)
        out += _reuse_o_values(n[1:]) + [v for v in _flag_values(n[1:], ("--output",)) if v[:1] != "-"]
    p = _interp_argv(c.argv)
    if p and INTERP_RE.fullmatch(p[0]):
        inline = _inline_scripts(p)
        here = [c.argv[k + 1] for k, a in enumerate(c.argv[:-1]) if a == "<<<"]
        for s in inline or c.bodies + here:
            probe = _WriteProbe(s)
            out += [PERL_OPEN_MODE_RE.sub("", x) for x in _script_literals(s) if probe(x)]
    return [w for w in out if w not in ("", "-") and not _dev_sink(w)]


DECOMPRESS_SUFFIX_RE = re.compile(r"\.(?:gz|z|xz|lzma|bz2|zst|lz4|lz|(t)(?:gz|bz2?|xz|zst))$", re.I)
UNPACK_HEADS = frozenset("gunzip unxz bunzip2 unzstd unlzma uncompress unlz4".split())


def _decompress_targets(n: List[str]) -> List[str]:
    """Tệp mà bộ giải nén suy ra từ tên nguồn (review #429): `gunzip F.gz`, `gzip -d`, `xz -d`/`unxz`, `bzip2 -d`/
    `bunzip2`, `zstd -d`/`unzstd` → F (bỏ đuôi; `.tgz` → `.tar`). Bản `*cat` ghi ra stdout — không có đích."""
    if not n:
        return []
    args = n[1:]
    short = "".join(a[1:] for a in args if a[:1] == "-" and a[1:2] != "-")
    long_dec = any(a in ("--decompress", "--uncompress") for a in args)
    if n[0] not in UNPACK_HEADS and not (n[0] in DECOMPRESS_FLAGS | {"lzip"} and ("d" in short or long_dec)):
        return []
    out = []
    for a in _positionals(args, ("-S", "--suffix")):
        m = DECOMPRESS_SUFFIX_RE.search(a)
        out += [a[: m.start()] + (".tar" if m[1] else "")] if m else []
    return out


def _reuse_o_values(args: List[str]) -> List[str]:
    """Giá trị `-o` đọc cụm cờ ngắn như getopt (D-329): `-o F`, `-oF` dính, `o` cuối cụm lấy từ kế (`-cso F`), `o` giữa
    cụm lấy phần còn lại (`-cosF`). Không biết chữ nào trước `o` ăn giá trị → coi mọi `o` là cờ tệp ra (chiều chặt)."""
    out: List[str] = []
    for k, a in enumerate(args):
        if a == "--":
            break
        i = a.find("o", 1) if a[:1] == "-" and a[1:2] != "-" else -1
        if i > 0 and a[1:i].isalnum() or i == 1:  # chỉ trong cụm chữ cờ (`-I/opt` không có cờ `o`)
            out += [a[i + 1 :] or (args[k + 1] if k + 1 < len(args) else "")]
    return [v for v in out if v and v[:1] != "-"]


def _reuse_pattern(f: str) -> Optional["re.Pattern[str]"]:
    """Mẫu tìm đường dẫn, tên gốc, tên gốc bỏ đuôi (`x.py` → `x` của `-m x`/`import x`) của F; None khi tên có mở rộng
    (luật `_script_run_why` xét) hay F là `.`/`..`/`/`."""
    np = _norm_path(f)
    b = posixpath.basename(np)
    if b in ("", ".", "..") or SCRIPT_NAME_DYN_RE.search(b):
        return None
    stem = b.rsplit(".", 1)[0] if "." in b[1:] and not REUSE_DATA_EXT_RE.search(b) else b
    forms = {b, stem} | {x for x in (f, np) if not SCRIPT_NAME_DYN_RE.search(x)}
    alt = "|".join(map(re.escape, sorted(forms, key=len, reverse=True)))
    return re.compile(rf"(?<![\w-])(?:{alt})(?![\w-])")


def _reuse_counts(cmds: List[_ReuseCmd], j: int, f: str, pat: "re.Pattern[str]") -> bool:
    """Lệnh đơn `j` nhắc F và không thuộc ngoại lệ: lệnh chỉ đọc (F không đuôi script), hay tệp dữ liệu là đối số sau
    chương trình `-c`/`-` CHỈ ĐỌC (`_read_only_script`) của trình thông dịch — stdout không đổ vào lệnh lạ."""
    c = cmds[j]
    if not any(_reuse_hit(pat, f, t) for t in c.texts):
        return False
    script = REUSE_SCRIPT_RE.fullmatch(posixpath.basename(_norm_path(f)))
    safe_out = c.top and all(_reuse_reader(d.argv) for d in _pipe_tail(cmds, j))
    if script or not safe_out or _reuse_shadowed(cmds, c, f):
        return True
    if _reuse_reader(c.argv) or _reuse_gh_body(c, f, pat):
        return False
    return not _reuse_data_arg(c, f, pat)


def _reuse_shadowed(cmds: List[_ReuseCmd], c: _ReuseCmd, f: str) -> bool:
    """D-329: miễn không áp khi chính lệnh có thể là tệp vừa ghi (từ lệnh trùng tên gốc F — `> ~/.local/bin/ls; ls`), F
    nằm dưới `~`/`$HOME`/`$PWD` (thư mục PATH/tệp khởi động), hay lệnh gán biến làm lệnh đọc chạy chương trình ngoài
    (`PATH`, `GIT_*`, `LESS*` — `GIT_EXTERNAL_DIFF=sh`, `LESSOPEN='|sh %s'`)."""
    head = posixpath.basename(c.argv[0]) if c.argv else ""
    if head == posixpath.basename(_norm_path(f)) or REUSE_HOME_RE.match(f):
        return True
    return any(REUSE_ENV_RE.fullmatch(w) for d in cmds for w in d.argv)


def _reuse_gh_body(c: _ReuseCmd, f: str, pat: "re.Pattern[str]") -> bool:
    """F chỉ là tệp nội dung của `gh pr|issue …` (`-F F`, `--body-file F`, `-F - < F`) — gh gửi chữ, không chạy; nội
    dung do luật đăng bài của guard xét (D-270, `_gh_body_why`)."""
    if normalize(c.argv)[:2] not in (["gh", "pr"], ["gh", "issue"]):
        return False
    a = c.argv
    body = {k + 1 for k, w in enumerate(a[:-1]) if w in ("-F", "--body-file", "<")}
    body |= {k for k, w in enumerate(a) if w.startswith("--body-file=")}
    left = [w for k, (p, w) in enumerate(zip([""] + a, a)) if k not in body and p not in REUSE_OUT_OPS]
    return not any(_reuse_hit(pat, f, t) for t in left + c.bodies)


def _pipe_tail(cmds: List[_ReuseCmd], j: int) -> List[_ReuseCmd]:
    """Các lệnh đơn nhận stdout của lệnh `j` qua ống."""
    out: List[_ReuseCmd] = []
    while j < len(cmds) - 1 and cmds[j].pipe:
        j += 1
        out.append(cmds[j])
    return out


def _reuse_hit(pat: "re.Pattern[str]", f: str, t: str) -> bool:
    """Chữ `t` nhắc F: tên/đường dẫn có biên, cụm cờ ngắn dính (`-mx`), mẫu glob khớp F, thư mục của F trong biến danh
    sách đường dẫn (`PATH=.:$PATH`)."""
    if pat.search(t):
        return True
    m = REUSE_SHORT_RE.match(t)
    if m and any(pat.match(t[k:]) for k in range(2, m.end() + 1)):
        return True
    np = _norm_path(f)
    if any(ch in t for ch in "*?[") and not any(ch.isspace() for ch in t):
        if fnmatch.fnmatchcase(posixpath.basename(np), posixpath.basename(t)) or fnmatch.fnmatchcase(np, _norm_path(t)):
            return True
    m = REUSE_PATHLIST_RE.fullmatch(t)
    d = posixpath.dirname(np) or "."
    for e in m[1].split(":") if m else []:
        e = _norm_path(e) if e else "."
        if e == d or d != "." and posixpath.basename(e) == posixpath.basename(d):
            return True
    return False


def _reuse_reader(argv: List[str]) -> bool:
    """Lệnh trong danh sách trắng chỉ đọc (ADR-0066), không gán biến đầu lệnh, không cờ chạy chương trình ngoài."""
    if not argv or ENV_ASSIGN_RE.fullmatch(argv[0]) or any(a.startswith(REUSE_READER_EXEC) for a in argv):
        return False
    head, args = posixpath.basename(argv[0]), argv[1:]
    if head == "git":
        return any(args[: len(s)] == s for s in REUSE_GIT_READS)
    if head == "printf":
        return not any(a.startswith("-v") for a in args)  # `printf -v x`: gán biến
    if head in SED_NAMES:
        return _reuse_sed_print(args)
    if head == "command":  # AUD-SEC-419: `command -v|-V X` chỉ in cách tìm X; `command X` là CHẠY X — không miễn
        return args[:1] in (["-v"], ["-V"])
    return not _uniq_output(args) if head == "uniq" else head in REUSE_READERS


def _reuse_sed_print(args: List[str]) -> bool:
    """D-328: `sed -n` chỉ in — không `-i`/`-f`, chương trình không có lệnh `w`/`W`/`e`/`r`/`R` (bộ đọc `_sed_has_write`)
    và không chạy pattern space (`_sed_runs_input`, đọc chặt mọi dạng cờ)."""
    opts = [a for a in args if a[:1] == "-" and not a.startswith("--")]
    quiet = any("n" in a[1:] for a in opts) or any(a in ("--quiet", "--silent") for a in args)
    edits = any("i" in a[1:] or "f" in a[1:] for a in opts) or any(a.startswith(("--in", "--fi")) for a in args)
    scripts = _sed_scripts(args)
    return (
        quiet
        and not edits
        and bool(scripts)
        and not _sed_runs_input(args)
        and not any(_sed_has_write(s, "wWerR") for s in scripts)
    )


def _reuse_data_arg(c: _ReuseCmd, f: str, pat: "re.Pattern[str]") -> bool:
    """F chỉ là ĐỐI SỐ dữ liệu sau chương trình `-c`/`-e` hay `-` (thân heredoc) của trình thông dịch, chương trình chỉ
    đọc (`_read_only_script`: không exec/import động/ghi) và không nhắc F — `python3 -c '…json.load(open(sys.argv[1]))'
    p.json`. Không áp cho `-m` (mã mô-đun không thấy), chữ trong `-c`, stdin của script có sẵn. Chỉ họ python (D-329:
    `_read_only_script` không đọc chắc perl/ruby/php — `perl -e 'do $ARGV[0]'` chạy tệp dữ liệu)."""
    n = _interp_argv(c.argv)
    m = INTERP_RE.fullmatch(n[0]) if n else None
    if not m or n != c.argv or INTERP_FAMILY.get(m[1], m[1]) != "python":
        return False
    rest = [a for a in _no_redirects(n) if a != "$"]
    inline, i, stopped = _interp_opts(rest)
    if stopped:
        return False
    if inline:
        program, data = "\n".join(inline), rest[i:]
    elif rest[i : i + 1] == ["-"] and len(c.bodies) == 1:
        program, data = c.bodies[0], rest[i + 1 :]
    else:
        return False
    left = list(c.texts)
    for a in data:
        if _norm_path(a) == _norm_path(f) and a in left:
            left.remove(a)
    return not any(_reuse_hit(pat, f, t) for t in left) and _read_only_script(program, frozenset({"python"}))


# T-3663 (D-332, ADR-0067 §Quyết định): dạng NGUYÊN VĂN guard còn cho qua — luật tĩnh OR với luật cũ, KHÔNG miễn trừ mới
# (bài học #426/#427). AUD-SEC-414: `HOME` không chữ + `~`/`$HOME`; `patch`/`git apply` (đích trong thân heredoc → đích
# ghi; diff từ tệp + lệnh chạy tệp → BUDGET). AUD-SEC-415: lệnh lạ có đối số trùng tên tệp/mô-đun lệnh khác CHẠY.
# AUD-SEC-416: tệp NẠP NGẦM của công cụ bị ghi rồi công cụ chạy.
HOME_DYN_WHY = (
    "`HOME` gán bằng giá trị không phải chữ (mở rộng, `read`, `unset`, `+=`) mà lệnh dùng `~`/`$HOME` — guard không biết"
    " thư mục đích (AUD-SEC-414, ADR-0067); viết lại: đường dẫn nguyên văn thay cho `~`/`$HOME`, hay `HOME=<chữ>`"
)
HOME_USE_RE = re.compile(r"(?<![^\s=:;&|(`'\"])~(?=/|$|[\s;&|)`:'\"])|\$\{?HOME(?!\w)", re.M)
HOME_NAME_RE = re.compile(r"(?<![\w$.{/-])HOME(?![\w}])")  # tên trần: gán, `read HOME`, `unset HOME`, `for HOME in`
# Đọc, không gán — phần còn lại của lệnh vẫn xét (`printf -v` gán): phép thử biến đã đặt (`[[ -v HOME ]]`, `test -v
# HOME`); mở rộng `${HOME…}` (thông điệp `${HOME:?HOME unset}`, mặc định — `:=` chỉ gán khi HOME chưa đặt, mà bỏ đặt
# HOME là tên trần `unset HOME` vẫn bị bắt)
HOME_TEST_RE = re.compile(r"(?:\[\[?|\btest)[ \t][^;&|\n\]]*?-v[ \t]+['\"]?HOME\b|\$\{HOME\b[^{}]*\}")


def _home_dyn_why(cmd: str) -> str:
    """Lệnh dùng `~`/`$HOME` và GHI `HOME` bằng giá trị không phải chữ nguyên văn (`HOME=$X`, `read HOME`); hay ghi
    `HOME` (cả chữ) mà `~`/`$HOME` nằm trong thân heredoc — bản thay biến (`_var_scripts`) không mang thân. Chữ HOME
    trong dữ liệu (`echo "HOME=$HOME"`, `printenv HOME`, `[[ -v HOME ]]`) không phải ghi (review #429 🟢)."""
    if "HOME" not in cmd or not HOME_USE_RE.search(cmd):
        return ""
    # ghi HOME xét trên mã của lệnh, không trong thân heredoc (dữ liệu; thân chạy bằng shell được quét như script riêng)
    code = HOME_TEST_RE.sub("", strip_heredocs(cmd) if "<<" in cmd else cmd)
    writes = _home_writes(code) if HOME_NAME_RE.search(code) else []
    bodies = ["\n".join(b) for _, _, b in _heredocs(join_continuations(cmd))] if writes and "<<" in cmd else []
    if any(HOME_USE_RE.search(b) for b in bodies):
        return HOME_DYN_WHY
    return HOME_DYN_WHY if HOME_USE_RE.search(code) and not all(writes) else ""


HOME_DYN_VALUE_RE = re.compile(r"[$`]")
HOME_VAR_HEADS = frozenset("read mapfile readarray unset getopts coproc".split())  # nhận TÊN biến làm đối số


def _home_writes(code: str) -> List[bool]:
    """Mỗi lần mã ghi `HOME` (gán đầu lệnh/`env`/`export`/`declare -x`…, `read`/`unset`/`printf -v`/`for HOME in`/
    `eval`/số học): True khi giá trị là chữ nguyên văn (`HOME=.claude`), False khi không biết. Dữ liệu (`echo HOME`)
    không tính."""
    out: List[bool] = []
    if re.search(r"\(\([^)]*\bHOME\b", code):  # `(( HOME = … ))`, `$(( HOME=… ))`
        out.append(False)
    for c in split_commands(tokenize(code)):
        words = [t for t in c if t not in SHELL_KEYWORDS and not _is_redirect(t)]
        if words[:1] in (["for"], ["select"]):
            out += [False] if words[1:2] == ["HOME"] else []
            continue
        i = 0
        while i < len(words) and (ENV_ASSIGN_RE.fullmatch(words[i]) or words[i] == "env"):
            i += 1  # gán đầu lệnh, `env A=x …`
        head, args = (posixpath.basename(words[i]), words[i + 1 :]) if i < len(words) else ("", [])
        assigns = words[:i] + (args if head in DECLARE_CMDS or head == "let" else [])
        out += [
            not t.startswith("HOME+=") and not HOME_DYN_VALUE_RE.search(t)
            for t in assigns
            if t.startswith("HOME") and t.split("=", 1)[0].rstrip("+") == "HOME" and "=" in t
        ]
        flag = HOME_VAR_FLAG_HEADS.get(head)
        named = any(p == flag and w == "HOME" for p, w in zip(args, args[1:])) if flag else False
        named = named or head in HOME_VAR_HEADS and "HOME" in args
        named = (
            named
            or head in ("declare", "typeset", "local", "readonly")
            and ("HOME" in args or any(a.endswith("=HOME") for a in args))
        )  # `local HOME` (rỗng), `declare -n r=HOME`
        named = named or head == "eval" and any("HOME" in a for a in args)
        out += [False] if named else []
    return out


PATCH_FILE_WHY = (
    "`patch`/`git apply` đọc diff từ tệp (guard không đọc được đích) cùng lệnh có lệnh chạy tệp/công cụ nạp tệp ngầm"
    " (AUD-SEC-414, ADR-0066); viết lại: áp diff ở một lệnh Bash, chạy ở lệnh riêng"
)
# Dòng đầu tệp của diff: unified (`--- `/`+++ `), context (`*** `), `Index: ` (GNU patch đọc làm tên dự phòng), git
# (`rename to`/`copy to`, `diff --git a/x b/y`). Chiều chặt: dòng thân bắt đầu bằng `--- ` cũng thành tên (thừa, vô hại).
PATCH_HEADER_RE = re.compile(
    r"^(?:(?:\+\+\+|---|\*\*\*|Index:) |(?:rename|copy) to )(?:\"((?:[^\"\\\n]|\\.)*)\"|([^\t\n]*?))[ \t]*(?:\t.*)?$"
    r"|^diff --git (\S+) (\S+)",
    re.M,
)


PATCH_WORD_RE = re.compile(r"\b(?:g?patch|apply|am)\b")  # lọc nhanh: lệnh có thể là patch/gpatch/git apply/git am


def _patch_cmd(argv: List[str]) -> bool:
    """`patch`/`gpatch`, `git apply`, `git am` (review #429: mbox cũng mang `diff --git`/`+++` như diff)."""
    n = normalize(argv)
    return n[:1] in (["patch"], ["gpatch"]) or n[:2] in (["git", "apply"], ["git", "am"])


def _patch_header_paths(text: str) -> List[str]:
    out = [g for m in PATCH_HEADER_RE.finditer(text) for g in m.groups() if g]
    return [p for p in dict.fromkeys(out) if _norm_path(p) != "/dev/null"]


def _patch_candidates(path: str) -> List[str]:
    """Đích có thể của một tên trong diff: mọi mức bỏ thành phần đầu (`-pN` — GNU patch không `-p` lấy tên gốc; git
    apply mặc định `-p1`)."""
    parts = [x for x in path.split("/") if x]
    return list(dict.fromkeys([path] + ["/".join(parts[k:]) for k in range(1, len(parts))]))


def _patch_heredoc_targets(c: "_ReuseCmd") -> List[str]:
    """Đích ghi của `patch`/`git apply` lấy từ thân heredoc/here-string gắn lệnh (kèm `-d`/`--directory`)."""
    return _patch_targets_at([c], 0)


def _patch_targets_at(cmds: List["_ReuseCmd"], j: int) -> List[str]:
    """Như `_patch_heredoc_targets`, cả chữ của các lệnh đổ vào stdin của patch qua ống (`cat <<'D' | patch`,
    `printf '--- …\\n+++ …' | git apply` — `\\n` đọc như xuống dòng)."""
    c = cmds[j]
    if not _patch_cmd(c.argv):
        return []
    texts = c.bodies + [c.argv[k + 1] for k, a in enumerate(c.argv[:-1]) if a == "<<<"]
    k = j - 1
    while k >= 0 and cmds[k].pipe:
        texts += cmds[k].texts
        k -= 1
    cands = [x for t in texts for p in _patch_header_paths(t.replace("\\n", "\n")) for x in _patch_candidates(p)]
    gdir = ""
    for d in _git_C_dirs(c.argv):  # review #429: `git -C .claude apply` (lặp được, nối như `cd`)
        gdir = posixpath.join(gdir, d)
    dirs = _flag_values(normalize(c.argv)[1:], ("-d", "--directory"))
    bases = [posixpath.join(gdir, d) for d in dirs] or ([gdir] if gdir else [])
    return list(dict.fromkeys(cands + [posixpath.join(d, x) for d in bases for x in cands]))


def _patch_fence_scripts(
    cmd: str, placed: List[Tuple[List[str], Optional[str]]], start: Optional[str]
) -> List[Tuple[str, Optional[str]]]:
    """Bản viết lại `: > 'đích'` của mọi đích `patch`/`git apply` trong thân heredoc/chữ đổ vào qua ống, đặt ở thư mục
    lệnh patch chạy — quét lại để luật hàng rào/bằng chứng sẵn có áp lên đích (AUD-SEC-414)."""
    if not PATCH_WORD_RE.search(cmd):
        return []
    cmds = _reuse_cmds(cmd, 0)
    targets = [t for j, c in enumerate(cmds) if c.top for t in _patch_targets_at(cmds, j)]
    if not targets:
        return []
    script = "; ".join(": > " + shlex.quote(t) for t in dict.fromkeys(targets))
    heres = [here for c, here in placed if _patch_cmd(c)] or [start]
    return [(script, here) for here in dict.fromkeys(heres)]


def _patch_file_why(cmd: str) -> str:
    """`patch`/`git apply` không có diff trong thân heredoc/here-string (đọc từ tệp/stdin không thấy) và lệnh đơn khác
    chạy tệp hay công cụ nạp tệp ngầm (trừ `.gitattributes` của git)."""
    if not PATCH_WORD_RE.search(cmd):
        return ""
    cmds = _reuse_cmds(cmd, 0)
    blind = [j for j, c in enumerate(cmds) if _patch_cmd(c.argv) and not _patch_targets_at(cmds, j)]
    runs = [j for j, c in enumerate(cmds) if _run_refs(c, ("git",))]
    return PATCH_FILE_WHY if any(j != k for j in blind for k in runs) else ""


RUN_NAMED_WHY = (
    "đối số của lệnh ngoài danh sách trắng chỉ đọc trùng tên tệp/mô-đun mà lệnh đơn khác CHẠY (`sponge s.sh`, `tar -xf"
    " a.tar s.sh`, `unzip … x.py` rồi `bash s.sh`/`python3 -m x`) — lệnh lạ có thể ghi tệp đó (AUD-SEC-415, ADR-0066);"
    " viết lại: tạo/giải nén tệp ở một lệnh Bash, chạy ở lệnh riêng"
)
IMPLICIT_LOAD_WHY = (
    "tệp mà công cụ NẠP NGẦM (Makefile, package.json, conftest.py, ~/.bashrc…) bị ghi rồi công cụ đó chạy trong cùng"
    " lệnh — guard không đọc tệp lúc chạy (AUD-SEC-416, ADR-0067); viết lại: ghi tệp bằng công cụ Write rồi chạy ở lệnh"
    " Bash riêng"
)
# Tệp công cụ nạp NGẦM (không nhắc trên dòng lệnh) — danh sách đếm được; nguồn (đọc 2026-11-03): GNU make manual §3.2
# "What Name to Give Your Makefile"; npm docs `package.json` (scripts) + `npmrc` (per-project config); pytest docs
# "Configuration" (rootdir/inifile: pytest.ini, pyproject.toml, tox.ini, setup.cfg) + "conftest.py"; Python `site`
# module (sitecustomize, usercustomize, `.pth`); bash(1) INVOCATION (login: ~/.bash_profile, ~/.bash_login,
# ~/.profile, ~/.bash_logout; tương tác: ~/.bashrc); zsh(1) STARTUP/SHUTDOWN FILES (`.zshenv` mọi lần chạy); Cargo Book
# "Build Scripts" (build.rs) + "Configuration" (.cargo/config.toml, .cargo/config); gitattributes(5) (filter/diff
# driver); pip `install .` (setup.py, pyproject.toml build backend, setup.cfg); tox (tox.ini/tox.toml `commands`),
# pre-commit (`repo: local` chạy lệnh), just (justfile), rake (Rakefile), Bundler (Gemfile là mã Ruby), Gradle (build
# script Groovy/Kotlin), Maven (pom.xml — plugin exec). Không thêm tsc (không chắc). AUD-SEC-418 (review #429): `node
# --run` (Node ≥ 22 chạy `scripts` của package.json); Bun (`bun run`/`test`/`install` — package.json scripts, bunfig.toml
# `preload`); nox (noxfile.py là mã Python); invoke (tasks.py); Composer (composer.json `scripts` chạy khi install/update);
# CMake (CMakeLists.txt — `execute_process`); Go `test`/`generate`/`run` (biên dịch và chạy mọi `*.go` của gói,
# `//go:generate`; go.mod không chạy mã — không thêm, `go build` không chạy mã — không tính); `deno task`
# (deno.json/deno.jsonc `tasks`); go-task `task` (Taskfile.yml…); `script -c CMD` chạy CMD qua shell (`script -qc 'bash
# -i'` nạp ~/.bashrc).
IMPLICIT_LOADS: Dict[str, Tuple[str, ...]] = {
    "make": ("GNUmakefile", "makefile", "Makefile"),
    "npm": ("package.json", ".npmrc"),
    "pytest": ("conftest.py", "pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"),
    "python": ("sitecustomize.py", "usercustomize.py", "*.pth"),
    "pip": ("setup.py", "pyproject.toml", "setup.cfg"),
    "login": (".bashrc", ".bash_profile", ".bash_login", ".profile", ".bash_logout", ".zshrc", ".zprofile", ".zlogin"),
    "zsh": (".zshenv",),
    "cargo": ("build.rs", ".cargo/config.toml", ".cargo/config"),
    "git": (".gitattributes",),
    "tox": ("tox.ini", "tox.toml", "pyproject.toml", "setup.cfg"),
    "pre-commit": (".pre-commit-config.yaml",),
    "just": ("justfile", "Justfile", ".justfile"),
    "rake": ("Rakefile", "rakefile", "Rakefile.rb"),
    "bundle": ("Gemfile",),
    "gradle": ("build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"),
    "mvn": ("pom.xml",),
    "bun": ("package.json", "bunfig.toml"),
    "nox": ("noxfile.py",),
    "invoke": ("tasks.py",),
    "composer": ("composer.json",),
    "cmake": ("CMakeLists.txt",),
    "go": ("*.go",),
    "deno": ("deno.json", "deno.jsonc"),
    # AUD-SEC-422: đủ 8 tên mặc định của go-task (taskfile.go `DefaultTaskfiles`, đọc 2026-11-03 qua review #430)
    "task": (
        "Taskfile.yml",
        "taskfile.yml",
        "Taskfile.yaml",
        "taskfile.yaml",
        "Taskfile.dist.yml",
        "taskfile.dist.yml",
        "Taskfile.dist.yaml",
        "taskfile.dist.yaml",
    ),
    # AUD-SEC-423 (phần chắc): tệp test tự dò — pytest `python_files` mặc định `test_*.py`/`*_test.py`; unittest
    # discover mặc định `test*.py` (docs.python.org unittest "Test Discovery"); Cargo biên dịch và chạy gói từ `src/`,
    # `tests/`… (`cargo run|test`)
    "unittest": ("test*.py",),
    "cargo-src": ("*.rs",),
}
IMPLICIT_LOADS["pytest"] += ("test_*.py", "*_test.py")
GO_RUN_SUBCMDS = frozenset({"test", "generate", "run"})  # lệnh con của `go` chạy mã của gói
PY_TOOL_MODULES = {"pytest": "pytest", "pip": "pip", "nox": "nox", "invoke": "invoke", "tox": "tox"}  # `python3 -m X`
IMPLICIT_TOOL_HEADS = {
    **dict.fromkeys(("invoke", "inv"), "invoke"),
    **{k: k for k in ("bun", "nox", "composer", "cmake", "task")},
    **{"go-task": "task", "bunx": "bun", "composer.phar": "composer"},  # AUD-SEC-422/423
    **dict.fromkeys(("make", "gmake"), "make"),
    **dict.fromkeys(("npm", "npx", "yarn", "yarnpkg", "pnpm", "pnpx", "corepack"), "npm"),  # `corepack pnpm test`
    **dict.fromkeys(("pytest", "py.test"), "pytest"),
    **dict.fromkeys(("gradle", "gradlew"), "gradle"),
    **dict.fromkeys(("mvn", "mvnw"), "mvn"),
    **{k: k for k in ("cargo", "git", "tox", "pre-commit", "just", "rake", "bundle")},
    **dict.fromkeys(("uv", "poetry"), "pip"),  # dựng gói dự án qua build backend (setup.py/pyproject.toml)
}
PIP_HEAD_RE = re.compile(r"pip[0-9.]*")
SHELL_LOGIN_RE = re.compile(r"-[A-Za-z]*[il][A-Za-z]*|--login")  # `bash -ic`, `bash -l`, `bash --login`
PY_MODULE_RUNNERS = frozenset({"coverage", "cProfile", "profile", "pdb", "trace"})  # chạy mô-đun `-m X` thứ hai
PY_MODULE_RE = re.compile(r"[A-Za-z_][\w.]*")  # `coverage report -m` (cờ "missing") không ăn `2` của `2>&1`
RUN_F_FLAG_HEADS = frozenset("awk gawk mawk nawk sed gsed make gmake".split())  # `-f FILE`: chương trình/makefile
PY_IMPORT_RE = re.compile(
    r"(?:^|[\s;(])(?:import|from)[ \t]+([A-Za-z_][\w.]*)|(?:__import__|import_module)\(\s*['\"]([\w.]+)"
)
JS_REQUIRE_RE = re.compile(r"(?:require|import)\s*\(\s*['\"]([^'\"]+)['\"]|\bfrom\s+['\"]([^'\"]+)['\"]")
CODE_STR_RE = re.compile(r"['\"]([^'\"\s]+)['\"]")  # chữ trong code `-c`/`-e`: tên tệp script (`exec(open('s.py'))`)


class _RunRef(NamedTuple):
    path: str
    stem: bool  # nạp theo tên mô-đun: so cả tên gốc bỏ đuôi (`-m x` ↔ `x.py`, `require("./x")` ↔ `x.js`)
    implicit: bool = False  # tệp nạp ngầm (`IMPLICIT_LOADS`): chỉ so tên nguyên văn, không so mẫu glob của đối số


def _implicit_tools(c: "_ReuseCmd") -> Set[str]:
    """Công cụ (khoá của `IMPLICIT_LOADS`) mà lệnh đơn chạy; tầng lồng không đọc (`$_` đầu lệnh) = mọi công cụ."""
    n, p = normalize(c.argv), _interp_argv(c.argv)
    heads = {posixpath.basename(h) for h in (n[:1] + p[:1])}
    if "$_" in heads:
        return set(IMPLICIT_LOADS)
    out = {IMPLICIT_TOOL_HEADS[h] for h in heads if h in IMPLICIT_TOOL_HEADS}
    out |= {"pip" for h in heads if PIP_HEAD_RE.fullmatch(h)}
    m = INTERP_RE.fullmatch(p[0]) if p else None
    mods = _run_modules(n, p)  # review #429: cả `coverage run -m pytest`, `python3 -m coverage run -m pytest`
    out |= {"python"} if m and INTERP_FAMILY.get(m[1], m[1]) == "python" or n[:1] == ["coverage"] else set()
    out |= {PY_TOOL_MODULES[x] for x in mods if x in PY_TOOL_MODULES}  # #430: cả `python3 -m nox|invoke`
    if "unittest" in mods and _unittest_discovers(p):
        out.add("unittest")
    if n and n[0] in SHELLS:
        out |= {"zsh"} if n[0] == "zsh" else set()
        opts = list(itertools.takewhile(lambda a: a[:1] == "-" and a != "--", n[1:]))
        out |= {"login"} if any(SHELL_LOGIN_RE.fullmatch(a) for a in opts) else set()
    # AUD-SEC-418: `node --run X` (scripts của package.json), `go test|generate|run`, `deno task`; #430: `nodejs`,
    # `go -C DIR test`, `php composer.phar`, `cargo run|test|build` biên dịch/chạy `*.rs`
    node = m is not None and INTERP_FAMILY.get(m[1], m[1]) == "node"
    out |= {"npm"} if node and any(a.startswith("--run") for a in n[1:]) else set()
    out |= {"go"} if n[:1] == ["go"] and _go_subcmd(n) in GO_RUN_SUBCMDS else set()
    out |= {"deno"} if n[:1] == ["deno"] and "task" in n[1:] else set()
    out |= {"composer"} if any(posixpath.basename(a) == "composer.phar" for a in p[:2]) else set()
    out |= (
        {"cargo-src"} if n[:1] == ["cargo"] and set(n[1:]) & {"run", "test", "build", "bench", "r", "t", "b"} else set()
    )
    out |= {"login"} if n and n[0] in SHELLS and _exec_login(c.argv) else set()  # AUD-SEC-430
    if n[:1] == ["script"]:  # AUD-SEC-418/421: `script` chạy CMD qua shell; không `-c` = `$SHELL -i` (nạp rc)
        cmds, has_c = _script_c_commands(n)
        out |= set() if has_c else {"login", "zsh"}
        for d in (d for inner in cmds for d in _reuse_cmds(inner, 1)):
            out |= _implicit_tools(d)
            dn = normalize(d.argv)
            if dn and dn[0] in SHELLS and _shell_script_arg(dn) == (False, None):  # shell trần dưới tty: tương tác
                out |= {"login", "zsh"}
    return out


def _exec_login(argv: List[str]) -> bool:
    """`exec -l CMD` (đặt `-` đầu argv[0]) hay `exec -a -NAME CMD` — bash coi là login shell, nạp ~/.bash_profile/
    ~/.profile (bash(1) `exec`, INVOCATION; AUD-SEC-430). Cờ gộp `-cl`, `-la NAME`."""
    words = [a for a in argv if not ENV_ASSIGN_RE.fullmatch(a)]
    if words[:1] != ["exec"]:
        return False
    i = argv.index("exec") + 1
    while i < len(argv) and argv[i][:1] == "-" and argv[i] != "--":
        a = argv[i]
        for k, ch in enumerate(a[1:], 2):  # getopt (AUD-SEC-432): `-a-bash` dính, `-al` = `-a l` (không login)
            if ch == "l":
                return True
            if ch == "a":
                name = a[k:] or (argv[i + 1] if i + 1 < len(argv) else "")
                if name[:1] == "-":
                    return True
                i += 0 if a[k:] else 1
                break
        i += 1
    return False


def _go_subcmd(n: List[str]) -> str:
    """Lệnh con của `go` sau cờ toàn cục `-C DIR`/`-C=DIR`/`-CDIR` (go1.20+, AUD-SEC-422) và `--C`/`--C=DIR` (flag của
    Go nhận một hay hai gạch — AUD-SEC-427)."""
    i = 1
    while i < len(n) and n[i].startswith(("-C", "--C")):
        i += 2 if n[i] in ("-C", "--C") else 1
    return n[i] if i < len(n) else ""


# `python -m unittest` (unittest.main) và `discover`: cờ ăn giá trị — `-k PAT`, `--durations N`, `-s/-p/-t` (docs.python.org
# unittest "Command-line options"/"Test Discovery") — giá trị không phải tên test (AUD-SEC-428)
UNITTEST_VALUE_OPTS = ("-k", "--durations", "-s", "-p", "-t", "--start-directory", "--pattern", "--top-level-directory")


def _unittest_discovers(p: List[str]) -> bool:
    """`python -m unittest` không tên test (hay `discover`) thì tự dò `test*.py` (AUD-SEC-423)."""
    k = p.index("unittest") + 1 if "unittest" in p else len(p)
    rest = _positionals(p[k:], UNITTEST_VALUE_OPTS)
    return not rest or rest[0] == "discover"


SCRIPT_VALUE_SHORT = "cEIOBTmo"  # util-linux script(1) 2.39: cờ ngắn ăn giá trị (`-c CMD`, `-E auto`, `-O f`…)
SCRIPT_VALUE_LONG = (
    "--echo",
    "--log-in",
    "--log-out",
    "--log-io",
    "--log-timing",
    "--logging-format",
    "--output-limit",
)


def _script_c_commands(n: List[str]) -> Tuple[List[str], bool]:
    """(chuỗi lệnh, có `-c`) của `script` đọc như getopt (AUD-SEC-421): cụm `-qc CMD`, dính `-qcCMD`, `--command[=]CMD`
    và mọi tiền tố duy nhất `--c…` của nó; tham số vị trí đứng trước cờ (getopt hoán vị)."""
    out: List[str] = []
    has_c, i = False, 1
    while i < len(n):
        a, nxt = n[i], (n[i + 1] if i + 1 < len(n) else "")
        if a == "--":
            break
        if a.startswith("--"):
            key, eq, val = a.partition("=")
            if len(key) > 2 and "--command".startswith(key):
                has_c = True
                out.append(val if eq else nxt)
                i += 1 if eq else 2
                continue
            takes = len(key) > 3 and any(o.startswith(key) for o in SCRIPT_VALUE_LONG)
            i += 2 if takes and not eq else 1
            continue
        if a[:1] == "-" and len(a) > 1:
            for k, ch in enumerate(a[1:], 2):
                if ch in SCRIPT_VALUE_SHORT:
                    if ch == "c":
                        has_c = True
                        out.append(a[k:] or nxt)
                    i += 0 if a[k:] else 1
                    break
        i += 1
    return out, has_c


def _run_modules(n: List[str], p: List[str]) -> List[str]:
    """Mô-đun Python lệnh đơn chạy: `python -m X`; trình chạy mô-đun (`PY_MODULE_RUNNERS`) chạy thêm `-m Y` sau nó —
    `python3 -m coverage run -m Y`, `python3 -m pdb -m Y`, lệnh `coverage run -m Y` (chỉ Y)."""
    m = INTERP_RE.fullmatch(p[0]) if p else None
    if m and INTERP_FAMILY.get(m[1], m[1]) == "python":
        seq, mods = p, _py_modules(p)
        k = p.index("-m", 1) + 2 if "-m" in p[1:] else len(p)
    elif n[:1] == ["coverage"]:
        seq, mods, k = n, ["coverage"], 1
    else:
        return []
    if mods[:1] and mods[0] in PY_MODULE_RUNNERS:
        if mods[0] == "coverage":
            k = k + 1 if seq[k : k + 1] == ["run"] else len(seq)
        mods = mods + [b for a, b in zip(seq[k:], seq[k + 1 :]) if a == "-m" and PY_MODULE_RE.fullmatch(b)][:1]
    return mods if seq is p else mods[1:]


def _py_modules(n: List[str]) -> List[str]:
    """Mô-đun của `python -m MOD` (cả `-mMOD`, cụm `-Im MOD`); dừng ở `-c`, tệp script, `-`/`--`."""
    i = 1
    while i < len(n):
        a = n[i]
        if a in ("-", "--") or a[:1] != "-":
            return []
        if a.startswith("--"):  # tuỳ chọn dài duy nhất ăn giá trị: `--check-hash-based-pycs MODE`
            i += 2 if a == "--check-hash-based-pycs" else 1
            continue
        for k, ch in enumerate(a[1:], 2):
            rest = a[k:]
            if ch == "m":
                return [x for x in [rest or (n[i + 1] if i + 1 < len(n) else "")] if x]
            if ch == "c":
                return []
            if ch in "WXQ":
                i += 0 if rest else 1
                break
        i += 1
    return []


def _run_refs(c: "_ReuseCmd", skip: Tuple[str, ...] = ()) -> List[_RunRef]:
    """Tệp/mô-đun lệnh đơn CHẠY theo tên nguyên văn: script của shell/`source`/trình thông dịch, `./f`, `-m MOD`,
    `import`/`require` và tên tệp script trong code `-c`/`-e`/stdin, `-f` của awk/sed/make, `--rcfile`, tệp nạp ngầm
    (`IMPLICIT_LOADS`, trừ công cụ trong `skip`)."""
    out = [_RunRef(f, False) for f in _run_files(c.argv) if f not in ("", "-", "$_")]
    n, p = normalize(c.argv), _interp_argv(c.argv)
    m = INTERP_RE.fullmatch(p[0]) if p else None
    fam = INTERP_FAMILY.get(m[1], m[1]) if m else ""
    if m:
        here = [c.argv[k + 1] for k, a in enumerate(c.argv[:-1]) if a == "<<<"]
        codes = _inline_scripts(p) or c.bodies + here
        out += [_RunRef(x, False) for s in codes for x in CODE_STR_RE.findall(s) if REUSE_SCRIPT_RE.fullmatch(x)]
        if fam == "python":
            out += [_RunRef(g.replace(".", "/"), True) for s in codes for t in PY_IMPORT_RE.findall(s) for g in t if g]
        else:
            out += [_RunRef(g, True) for s in codes for t in JS_REQUIRE_RE.findall(s) for g in t if g]
    out += [_RunRef(x.replace(".", "/"), True) for x in _run_modules(n, p)]
    if n and n[0] in RUN_F_FLAG_HEADS:
        out += [_RunRef(f, False) for f in _flag_values(n[1:], ("-f", "--file", "--makefile"))]
    if n and n[0] in SHELLS:
        out += [_RunRef(f, False) for f in _flag_values(n[1:], ("--rcfile", "--init-file"))]
    tools = _implicit_tools(c) - set(skip)
    return out + [_RunRef(f, False, True) for t in sorted(tools) for f in IMPLICIT_LOADS[t]]


def _run_ref_hit(ref: _RunRef, arg: str) -> bool:
    """Đối số `arg` trùng tệp `ref`: đường dẫn, tên gốc (mẫu `*.pth` theo glob); nạp theo mô-đun thì cả tên gốc bỏ đuôi
    (đuôi không phải dữ liệu) hay thư mục trùng thành phần mô-đun. Không so thư mục chứa tệp chạy (`ruff check scripts
    && python3 scripts/xt.py` — lệnh Kiểm của chính repo)."""
    a, r = _norm_path(arg or "."), _norm_path(ref.path)
    ab, rb = posixpath.basename(a), posixpath.basename(r)
    if re.search(r"[*?\[]", arg) and "$" not in arg and "*" not in rb:  # mẫu glob nguyên văn (`--wildcards '*.sh'`)
        return not (ref.stem or ref.implicit) and (fnmatch.fnmatchcase(rb, ab) or fnmatch.fnmatchcase(r, a))
    if not arg or SCRIPT_NAME_DYN_RE.search(arg) and "*" not in ref.path:
        return False
    if a == r or ab == rb or ("*" in rb and fnmatch.fnmatchcase(ab, rb)):
        return True
    if not ref.stem:
        return False
    stem = ab.rsplit(".", 1)[0] if "." in ab[1:] and not REUSE_DATA_EXT_RE.search(ab) else ab
    parts = [x for x in r.split("/") if x not in ("", ".", "..")]
    last = parts[-1].rsplit(".", 1)[0] if parts else ""
    return stem == last or ("." not in ab and ab in parts)


def _cmd_args(c: "_ReuseCmd") -> List[str]:
    """Đối số của lệnh đơn để so tên: từ sau từ lệnh (cả đích chuyển hướng), giá trị sau `=` (`-out=F`, `X=F`)."""
    words = [w for w in c.argv[1:] if not _is_punct(w)] + [w for w in c.argv[:1] if ENV_ASSIGN_RE.fullmatch(w)]
    return words + [w.split("=", 1)[1] for w in words if "=" in w]


def _run_named_why(cmd: str) -> str:
    """AUD-SEC-415: lệnh đơn ngoài danh sách trắng chỉ đọc (`_reuse_reader`, mất miễn khi `_reuse_shadowed`) có đối số
    trùng tệp mà lệnh đơn KHÁC chạy (`_run_refs`). Miễn D-324 giữ (`_heredoc_run`: thân quét như script)."""
    if _heredoc_run(cmd) is not None:
        return ""
    cmds = _reuse_cmds(cmd, 0)
    per = [_run_refs(c) for c in cmds]
    if any(w.startswith(("PATH=", "PATH+=")) or w == "PATH" for c in cmds for w in c.argv):  # `PATH=.:$PATH s.sh`
        per = [rs + [_RunRef(h, False) for h in _strip_prefixes(c.argv)[:1]] for c, rs in zip(cmds, per)]
    refs = [(i, r) for i, rs in enumerate(per) for r in rs]
    for j, c in enumerate(cmds):
        own = {_norm_path(x.path) for x in per[j] if not x.stem}  # tệp chương trình của chính lệnh: không là đối số
        args = [a for a in _cmd_args(c) if _norm_path(a or ".") not in own]
        for i, r in refs:
            if i == j or r in per[j] or not any(_run_ref_hit(r, a) for a in args):
                continue
            # lệnh đọc không ghi gì: chỉ xét nó bị thay tên/biến môi trường; tệp chạy dưới `~` (`[ -f ~/.bashrc ] && .
            # ~/.bashrc`) không làm mất miễn — điều đó chỉ đúng với tệp VỪA GHI (D-329)
            if not _reuse_reader(c.argv) or _reuse_shadowed(cmds, c, posixpath.basename(r.path)):
                return RUN_NAMED_WHY
    return ""


def _implicit_hit(name: str, path: str) -> bool:
    p = _norm_path(path)
    b = posixpath.basename(p)
    if "/" in name:
        return p == name or p.endswith("/" + name)
    return fnmatch.fnmatchcase(b, name) if "*" in name else b == name


def _implicit_load_why(cmd: str) -> str:
    """AUD-SEC-416: đích ghi (mọi cách `_reuse_writes` nhận ra) là tệp nạp ngầm của công cụ mà lệnh đơn KHÁC chạy."""
    cmds = _reuse_cmds(cmd, 0)
    tools = [_implicit_tools(c) for c in cmds]
    for i, c in enumerate(cmds):
        for w in _reuse_writes(c):
            need = {t for t, names in IMPLICIT_LOADS.items() if any(_implicit_hit(x, w) for x in names)}
            if need and any(need & ts for j, ts in enumerate(tools) if j != i):
                return IMPLICIT_LOAD_WHY
    return ""


# ADR-0063 T-3637 — shell lồng theo argv đã chuẩn hoá (AUD-SEC-309…311): chữ và argv là hai cách đọc cùng lệnh; guard
# chỉ cho chạy khi hai cách đọc khớp nhau. Lớp này chạy SAU luật cũ nên lệnh luật cũ đã chặn giữ mã của luật cũ.
STRICT_DYN_HERE_RE = re.compile(r"\$[({\w]|`")  # mở rộng trong thân heredoc/here-string không nháy


def _argv_shell_why(cmd: str, tokens: List[str], root: str, cwd: Optional[str]) -> str:
    """Lý do chặn (rỗng = qua): (a) một đầu `sh -c`/`eval` theo argv đã chuẩn hoá (cả tên có nháy/thoát `\\bash`,
    `"bash"`, `$'bash'`, `'eval'`) có thân dựng lúc chạy — xét TỪNG đầu trên token còn giữ nháy (`_raw_heads_why`), không so
    tổng số đầu (đầu mồi `echo eval; "bash" -c …` — review #404 🔴); (b) shell đọc script từ `<(…)`, here-string hay heredoc
    không nháy có mở rộng; (c) ống vào shell (`| sh 2>&1`, `| command sh`, `| cat | sh`, `g | sh`, `| xargs sh -c`) mà
    guard không biết chữ đi vào."""
    for argv in split_commands(tokens):
        if _stdin_shell(argv) and "<<<" in argv[:-1] and STRICT_DYN_HERE_RE.search(argv[argv.index("<<<") + 1]):
            return "shell đọc here-string có mở rộng (AUD-SEC-310)"
    old = _raw_heads_why(cmd) or _procsub_shell_why(tokens) or _heredoc_shell_why(cmd) or _pipe_shell_why(tokens)
    return old or _allowlist_why(cmd, root, cwd)


def _raw_tokens(cmd: str, subst: bool = False) -> Optional[List[str]]:
    """Token GIỮ nháy/thoát (shlex không POSIX) của chữ đã nối dòng, gấp heredoc, giải `$'…'` thành chữ nháy, bỏ comment
    — cùng tiền xử lý `tokenize` trừ viết lại `$IFS`/`$(pwd)`; nháy không đóng → None. `subst`: gấp heredoc như
    `_ShellScan` (thân có nháy trong `"$(…)"` thành dòng trống — chữ, ngoặc lẻ trong đó không làm hỏng tách từ)."""
    s = strip_comments(expand_ansi_c(_fold_heredocs(join_continuations(cmd), subst, True)), True)
    out: List[str] = []
    word: List[str] = []
    i = 0
    while i < len(s):
        c = s[i]
        if c in " \t\r" or c in PUNCT:
            out += ["".join(word)] if word else []
            word = []
            j = i
            while j < len(s) and s[j] in PUNCT:  # dãy dấu liền nhau là một token (như shlex `punctuation_chars`)
                j += 1
            out += [s[i:j]] if j > i else []
            i = max(j, i + 1)
            continue
        j = _raw_word_part(s, i)
        if j < 0:
            return None
        word.append(s[i:j])
        i = j
    return out + (["".join(word)] if word else [])


def _raw_word_part(s: str, i: int) -> int:
    """Cuối một mảnh từ bắt đầu ở `s[i]`: `\\x`, `'…'`, `"…"` (có `\\` và `$(…)` bên trong), `$(…)`/`${…}` cân ngoặc, hay
    một ký tự; không đóng → -1."""
    c = s[i]
    if c == "\\":
        return min(i + 2, len(s))
    if c == "'":
        j = s.find("'", i + 1)
        return j + 1 if j >= 0 else -1
    if c == '"':
        return _raw_dq_end(s, i + 1)
    if s.startswith(("$(", "${"), i):
        return _raw_group_end(s, i + 2, "(" if s[i + 1] == "(" else "{")
    return i + 1


def _raw_dq_end(s: str, i: int) -> int:
    """Vị trí ngay sau `"` đóng của chuỗi nháy kép bắt đầu ở `s[i]` (sau `"` mở); không đóng → -1."""
    while i < len(s):
        if s[i] == "\\":
            i += 2
        elif s[i] == '"':
            return i + 1
        elif s.startswith(("$(", "${"), i):
            i = _raw_group_end(s, i + 2, "(" if s[i + 1] == "(" else "{")
            if i < 0:
                return -1
        else:
            i += 1
    return -1


def _raw_group_end(s: str, i: int, opener: str) -> int:
    """Vị trí ngay sau ngoặc đóng của `$(`/`${` (đã qua phần mở): đếm ngoặc cùng loại, bỏ qua nháy và `\\`; không đóng → -1."""
    closer, depth = ")" if opener == "(" else "}", 1
    while i < len(s):
        c = s[i]
        if c in "\\'\"" or s.startswith(("$(", "${"), i):
            i = _raw_word_part(s, i)
            if i < 0:
                return -1
            continue
        depth += (c == opener) - (c == closer)
        i += 1
        if not depth:
            return i
    return -1


def _dequote(t: str) -> str:
    """Từ bash sau khi bỏ nháy/thoát (`"bash"`, `\\bash`, `$'bash'`, `ev"al"` → tên lệnh)."""
    try:
        return "".join(shlex.split(expand_ansi_c(t)))
    except ValueError:
        return t


def _raw_heads_why(cmd: str) -> str:
    """AUD-SEC-309: mỗi lệnh đơn mà đầu (sau lệnh bọc/gán) là shell có `-c` hay `eval` — thân (chuỗi lệnh của `-c`; mọi
    đối số của `eval`) đọc trên token còn nháy: thay lệnh/`$'…'`/backtick/biến gán từ thay lệnh ngoài nháy đơn → chặn."""
    raw = _raw_tokens(cmd)
    if raw is None:
        return "nháy không tách được để xét đầu `sh -c`/`eval` (AUD-SEC-309)" if STRICT_SHELL_RE.search(cmd) else ""
    for argv in split_commands(raw):
        plain = [_dequote(t) for t in argv]
        n = normalize(plain)
        at = len(argv) - len(_strip_prefixes(plain))
        if not n or not (n[0] == "eval" or (n[0] in SHELLS and _shell_script_arg(n)[0])):
            continue
        body = argv[at + 1 :] if n[0] == "eval" else argv[at + _shell_c_index(n) : at + _shell_c_index(n) + 1]
        if any(_raw_word_dynamic(w, cmd) for w in body):
            return "thân `sh -c`/`eval` dựng lúc chạy (đầu theo argv, tên có nháy/thoát) (AUD-SEC-309)"
    return ""


def _shell_c_index(n: List[str]) -> int:
    """Vị trí chuỗi lệnh của `sh -c` trong argv đã chuẩn hoá (cùng cách duyệt cờ của `_shell_script_arg`)."""
    i = 1
    while i < len(n) and n[i] not in ("--", "-") and _shell_opt_width(n[i]):
        i += _shell_opt_width(n[i])
    return i + (i < len(n) and n[i] in ("--", "-"))


def _raw_word_dynamic(word: str, whole: str) -> bool:
    """Từ còn nháy là chữ dựng lúc chạy: ngoài nháy đơn có thay lệnh/`$'…'`/backtick, `\\$(` trong nháy kép, hay biến gán
    từ thay lệnh trong lệnh này (`_dyn_word`). `$(cat <<'X' … X)` (thân heredoc có nháy) là chữ thấy được — như lớp chữ."""
    v = _CodeView(STRICT_CAT_HEREDOC_RE.sub(lambda m: " " * len(m.group()), word))
    live = "".join(ch if k != "q" else " " for ch, k in zip(v.s, v.kind))
    return bool(v.why) or bool(STRICT_DYN_ESC_RE.search(word)) or _dyn_word(live, whole)


def _argv_shell_check(
    cmd: str, tokens: List[str], strict: bool, asks: List[str], res: Dict[str, object], root: str, cwd: Optional[str]
) -> None:
    """Chặn (BUDGET) khi `_argv_shell_why` có lý do — trừ khi câu hỏi nguy hiểm của luật cũ đã làm lệnh bị chặn (giữ mã
    của luật cũ: HOOK_BYPASS…). Chữ lỏng (guard tự dựng) không qua tập con. Cờ bỏ hook đã đặt trong `res` đi theo lỗi
    (review #433 R1 — adapter host khác đọc `push_no_verify`)."""
    why = _argv_shell_why(cmd, tokens, root, cwd) if strict else ""
    if why and not _asks_denied(asks):
        err = ScanTooComplex(f"ngoài tập con guard đọc chắc — {why} (ADR-0063)")
        setattr(err, "flags", {k: True for k in ("no_verify", "push_no_verify") if res.get(k)})
        raise err


def _asks_denied(asks: List[str]) -> bool:
    """Các câu hỏi đã gom mà chính sách mặc định biến thành chặn (ask nguy hiểm/unsure)."""
    return (
        bool(asks) and apply_policy({"decision": "ask", "reason": ASK_PREFIX + "; ".join(asks)})["decision"] == "deny"
    )


def _drop_fd_words(argv: List[str]) -> List[str]:
    """Bỏ số fd đứng trước chuyển hướng (`2>&1` tách thành `2`, `>&`, `1`): không thì `2` bị đọc là tên script."""
    return [a for i, a in enumerate(argv) if not (a.isdigit() and i + 1 < len(argv) and _is_redirect(argv[i + 1]))]


def _procsub_shell_why(tokens: List[str]) -> str:
    """Shell/`source` đọc script từ thay tiến trình: `bash <(…)`, `bash < <(…)`, `source <(…)`, `. <(…)`."""
    start = 0
    for i, t in enumerate(tokens):
        if t != "<(":
            start = i + 1 if _is_punct(t) and not _is_redirect(t) else start
            continue
        words, fed = _procsub_fd(tokens[start:i])
        head = normalize(_drop_fd_words([a for a in words if a != "<"]))
        n = _eval_tail(head)
        if _procsub_known(tokens, i):  # `bash <(echo '…')`: chữ guard thấy, luật cũ đã quét
            start = i + 1
            continue
        # `eval <(…)` (AUD-SEC-333), `eval . <(…)`, `. /dev/stdin < <(…)` — stdin là thay tiến trình (AUD-SEC-341)
        if (n[:1] in (["source"], ["."]) or (head and not n)) and (len(n) <= 1 or _stdin_source(n, fed)):
            return "`source`/`.` đọc script từ `<(…)` (AUD-SEC-310)"
        if n and n[0] in SHELLS and _procsub_shell_script(n, fed):
            return "shell đọc script từ `<(…)` (AUD-SEC-310)"
        start = i + 1
    return ""


def _procsub_fd(words: List[str]) -> Tuple[List[str], FrozenSet[str]]:
    """(từ của lệnh bỏ số fd nhận thay tiến trình, các tên file đọc ra chữ của thay tiến trình): `N< <(…)` cuối lệnh →
    `/dev/fd/N`, `/proc/self/fd/N` cùng stdin (review lượt 2: `. /dev/fd/3 3< <(cat f)`)."""
    if len(words) > 1 and words[-1] == "<" and words[-2].isdigit():
        n = words[-2]
        return words[:-2] + words[-1:], STDIN_SCRIPTS | {f"/dev/fd/{n}", f"/proc/self/fd/{n}"}
    return words, STDIN_SCRIPTS


def _eval_tail(n: List[str]) -> List[str]:
    """Bỏ các `eval` đứng đầu (đã chuẩn hoá, cả `--` sau `eval`): `eval . <(…)`, `eval -- . <(…)` chạy `. /dev/fd/63`
    như gõ trực tiếp (AUD-SEC-341)."""
    while n[:1] == ["eval"]:
        n = normalize(n[2:] if n[1:2] == ["--"] else n[1:])
    return n


def _procsub_shell_script(n: List[str], fed: FrozenSet[str]) -> bool:
    """Shell không `-c` mà script là thay tiến trình kế (không đối số) hay file đọc ra nó (`bash /dev/stdin < <(…)`,
    `bash /dev/fd/3 3< <(…)`)."""
    has_c, script = _shell_script_arg(n)
    return not has_c and (script is None or _norm_path(script) in fed)  # `/dev/./stdin` (AUD-SEC-511)


def _procsub_known(tokens: List[str], i: int) -> bool:
    """Thay tiến trình mở ở `tokens[i]` chỉ là MỘT lệnh ra chữ guard biết (`echo`/`printf` chữ — `_pipe_feed`)."""
    depth, inner = 1, []
    for t in tokens[i + 1 :]:
        depth += t.endswith("(") - (t == ")")
        if not depth:
            break
        inner.append(t)
    cmds = split_commands(inner)
    literal = not any(STRICT_DYN_HERE_RE.search(t) for t in inner)  # `<(echo "$(cat f)")`: chữ động (review #404 🔴)
    return (
        depth == 0
        and literal
        and len(cmds) == 1
        and len(pipelines(inner)) == 1
        and _pipe_feed(cmds[0], None) is not None
    )


def _heredoc_shell_why(cmd: str) -> str:
    """Heredoc KHÔNG nháy vào shell mà thân có mở rộng (`$(…)`, `$X`, `${…}`, backtick): bash dựng script lúc chạy."""
    lines = join_continuations(cmd).split("\n")
    for opener, m, a, b, _ in _here_scan("\n".join(lines)):
        if _heredoc_word(m)[1] or not STRICT_DYN_HERE_RE.search("\n".join(lines[a:b])):
            continue
        if any(_stdin_shell(c) for c in split_commands(tokenize(lines[opener][: m.start()]))):
            return "shell đọc heredoc không nháy có mở rộng — dùng `<<'X'` (AUD-SEC-310)"
    return ""


def _xargs_replace_script(argv: List[str]) -> Optional[Tuple[str, str]]:
    """`xargs -I X|-IX|-i[X]|-0I X|--replace[=X] … sh -c '…X…'` → (X, chuỗi lệnh): xargs thay X bằng từng dòng stdin rồi
    chạy `sh -c` — chuỗi lệnh đến từ stdin như `xargs sh -c` không chuỗi lệnh (AUD-SEC-334; cụm `-0I{}`, `--replace`
    trần = `{}` — review #405). Không phải dạng này → None."""
    heads = [i for i, x in enumerate(argv) if posixpath.basename(x) == "xargs"]
    rest: List[str] = argv[heads[0] + 1 :] if heads else []
    opts: List[str] = []
    while rest and rest[0].startswith("-") and rest[0] != "-":
        opts.append(rest.pop(0))
        m = XARGS_REPLACE_RE.fullmatch(opts[-1])
        if ((m and m.group(1) == "I" and not m.group(2)) or opts[-1] in WRAPPER_OPTS_WITH_VALUE["xargs"]) and rest:
            opts.append(rest.pop(0))
    rep, n = _xargs_replace(opts), normalize(rest)
    has_c, script = _shell_script_arg(n) if n and n[0] in SHELLS else (False, None)
    return (rep, script) if rep and has_c and script and rep in script else None


def _xargs_replace_shell(argv: List[str]) -> bool:
    return _xargs_replace_script(argv) is not None


def _pipe_shell_why(tokens: List[str]) -> str:
    """Ống vào shell (stdin hay `xargs sh -c` không chuỗi lệnh) mà khâu trước không ra chữ guard biết (`_pipe_feeds`)."""
    for pipe in pipelines(tokens):
        feeds = _pipe_feeds(pipe)
        for k in range(1, len(pipe)):
            down = _drop_fd_words(pipe[k])
            known = feeds[k - 1] is not None or _decoded_feed([*pipe[:k], down], k)[1] is not None  # giải mã: đã quét
            if not known and (_stdin_shell(down) or _argless_shell_c(down) or _xargs_replace_shell(down)):
                return "ống vào shell mà guard không biết chữ đi vào — chạy `bash <tệp>` (AUD-SEC-311)"
    return ""


def _dyn_word(word: str, whole: str) -> bool:
    """Thân `sh -c`/`eval` dựng lúc chạy (vùng sống — nháy đơn thật đã trống): thay lệnh, `$'…'`, hoặc biến được gán
    (`=`/`+=`) từ thay lệnh ngay trong lệnh này (`L=$(…); bash -c "$L"`). Biến khác (`$f` của vòng lặp) là giới hạn
    chung (D-051)."""
    if STRICT_DYN_WORD_RE.search(word):
        return True
    names = {a or b for a, b in re.findall(r"\$\{(\w+)\}|\$(\w+)", word)}
    if len(names) > STRICT_DYN_MAX:
        raise ScanTooComplex(f"thân `sh -c`/`eval` có hơn {STRICT_DYN_MAX} biến")
    return any(re.search(rf"(?:^|[\s;&|(]){re.escape(n)}\+?=(?:\$\(|`)", whole) for n in names)


def _word_end(v: _CodeView, i: int, whole_command: bool) -> int:
    """Cuối từ (hoặc cả lệnh đơn với `eval`) bắt đầu ở `i`: ký tự mã (ngoài nháy) là ranh giới."""
    stops = ";&|\n" if whole_command else STRICT_WORD_BREAK
    while i < len(v.s) and not (v.kind[i] == "c" and v.top[i] and v.s[i] in stops):
        i += 1
    return i


# ADR-0063 lớp đăng review — DANH SÁCH TRẮNG nguồn thân của `gh` có thể đăng (review lát C trước PR: vá từng dạng
# không hội tụ). Thân chỉ được là chữ nguyên văn (`-b/--body/-c/--comment/-f '…'`), `$(cat <<'EOF' … EOF)`, hoặc tệp
# (`-F`/`--body-file`/`--input`/`-F k=@tệp`) là đường dẫn nguyên văn mà guard biết thư mục; còn lại → chặn: stdin
# (`-`, `/dev/*`, `/proc/*`, `@-`), `$(…)`/backtick/`$biến` trong thân, `-e/--editor`, hàm/`coproc`/`xargs` bọc `gh`,
# đường tương đối sau khi đổi thư mục (`cd`, `env -C`), `~` khi gán `HOME`, `gh alias`/`extension`/lệnh con lạ (alias
# người dùng), tên `gh` dựng lúc chạy (AUD-SEC-180/186/191/192/193/244/253). Dấu nguyên văn: luật cũ (`REVIEW_MARK_RE`).
GH_TOPICS = frozenset({"pr", "issue", "api", "alias", "extension", "ext", "release", "repo", "gist", "label"})
GH_BUILTINS = GH_TOPICS | {
    "a11y", "accessibility", "agent-task", "attestation", "auth", "browse", "cache", "co", "codespace", "completion",
    "config", "copilot", "gpg-key", "help", "licenses", "org", "preview", "project", "ruleset", "run", "search",
    "secret", "skill", "ssh-key", "status", "variable", "version", "workflow",
}  # fmt: skip
GH_POST_VERBS = frozenset({"comment", "review", "create", "edit", "close", "reopen"})
GH_API_WRITE = ("-f", "--raw-field", "-F", "--field", "--input")
GH_TEXT_FLAGS = ("-b", "--body", "-c", "--comment", "--body-file") + GH_API_WRITE
GH_SAFE_SUB = {"alias": ("list", "ls"), "extension": ("list", "ls", "search", "browse")}
GH_CAT_HEREDOC_RE = re.compile(r"\$\(\s*cat\s+<<-?\s*(['\"])(\w+)\1[ \t]*\n.*\n[ \t]*\2[ \t]*\n\s*\)", re.S)
GH_DYN_RE = re.compile(r"\$[A-Za-z_{(]|`")
# Khâu sinh chữ guard thấy được (trong `$(…)` của thân, hoặc trước `gh -F -` trong ống): đọc tệp nguyên văn và lọc
# dòng/đếm (luật cũ đọc tệp thật, bắt dấu trong đó), chữ nguyên văn, ngày, `git rev-parse`. KHÔNG (D-301): liệt kê tên
# tệp (`ls`/`find`/`du`/`git status` — tên tệp mang được dấu), thông điệp commit (`git log/show`), biến đổi chữ
# (`awk`/`sed`/`tr`/`printf '\x…'`), trình thông dịch/`pytest`/`make`, `$biến`.
GH_READERS = frozenset({"cat", "head", "tail", "grep", "wc", "sort", "uniq"})
GH_LITERALS = frozenset({"echo", "printf", "date", "true", "nproc"})
GH_API_MARK_RE = re.compile(r"(?:^|/)(?:comments|reviews)(?:/|$|\?)|^/?graphql$|[$`]")
GH_FUNC_RE = re.compile(r"\(\s*\)\s*[{(]|\bfunction\s+\S")
GH_CWD = "\0xt-cwd"  # thư mục đầu khi không biết `cwd`: khác nó = lệnh chạy sau khi đổi thư mục
GH_STDIN_PATHS = ("-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0")


def _gh_flag_values(args: List[str], flags: Tuple[str, ...]) -> List[Tuple[str, str]]:
    """(cờ, giá trị) của các cờ trong `flags`: `-F v`, `-Fv`, `-F=v`, `--body-file=v`."""
    out = []
    for i, x in enumerate(args):
        for f in flags:
            if x == f:
                out.append((f, args[i + 1] if i + 1 < len(args) else ""))
            elif x.startswith(f + "=") or (len(f) == 2 and x.startswith(f) and len(x) > 2):
                out.append((f, x[len(f) :].removeprefix("=")))
    return out


def _gh_kind(n: List[str], line: "_GhLine") -> str:
    """`deny` (alias/extension/lệnh con lạ), `post` (`gh` có thể đăng thân), rỗng (chỉ đọc/khác)."""
    topic = n[1]
    topic = "extension" if topic == "ext" else topic
    if topic in GH_SAFE_SUB:
        return "" if n[2:3] and n[2] in GH_SAFE_SUB[topic] else "deny"
    if topic[:1] != "-" and topic not in GH_BUILTINS:
        return "deny"
    if topic == "api":
        return "post" if _gh_api_posts(n[2:], line) else ""
    if topic not in ("pr", "issue"):
        return ""
    return "post" if _gh_verb(n[2:]) in GH_POST_VERBS else ""


def _gh_api_posts(args: List[str], line: "_GhLine") -> bool:
    """`gh api` ghi vào endpoint đọc dấu (comment/review, graphql) hoặc endpoint dựng lúc chạy — releases/rulesets/merge
    để luật cũ. graphql chỉ đọc (trường `query` là chữ nguyên văn không `mutation`, không phương thức/`--input`) thì
    biến khác (`-F n=$N`) không biến nó thành ghi."""
    method = [v.upper() for _, v in _gh_flag_values(args, ("-X", "--method"))]
    fields = _gh_flag_values(args, GH_API_WRITE)
    if not (fields or {"POST", "PATCH", "PUT"} & set(method)):
        return False
    if not any(GH_API_MARK_RE.search(x) for x in args if x[:1] != "-"):
        return False
    queries = [v for f, v in fields if v.startswith("query=")]
    read_gql = "graphql" in args and not method and all(f != "--input" for f, _ in fields)
    read_gql = (
        read_gql
        and bool(queries)
        and not any("mutation" in q or "=@" in q or any(m in q for m in line.live_dyn) for q in queries)
    )
    return not read_gql


def _gh_verb(args: List[str]) -> str:
    """Lệnh con sau nhóm `pr`/`issue`, bỏ cờ toàn cục `-R/--repo <repo>` (`gh pr -R o/r comment`)."""
    skip = False
    for x in args:
        if skip or x in ("-R", "--repo"):
            skip = not skip
        elif x[:1] != "-":
            return x
    return ""


class _GhLine(NamedTuple):
    """Ngữ cảnh cả dòng lệnh cho luật `gh`: gán `HOME`, có định nghĩa hàm, dạng mở rộng ngoài nháy đơn."""

    home: bool
    func: bool
    live_dyn: Set[str]


class _GhCmd(NamedTuple):
    """Một lệnh `gh` có thể đăng: argv chuẩn hoá, chạy sau khi đổi thư mục, các khâu trước nó trong ống."""

    n: List[str]
    moved: bool
    up: List[List[str]]
    line: _GhLine


def _gh_path_bad(path: str, moved: bool, home: bool) -> bool:
    """Tệp guard không lần được: stdin, `/dev`/`/proc`, đường tương đối sau khi đổi thư mục, `~` khi gán `HOME`, rỗng."""
    return (
        not path
        or path in GH_STDIN_PATHS
        or _dev_path(path)  # cả `//dev/stdin`, `/dev/./fd/3` (AUD-SEC-511)
        or (moved and not path.startswith("/"))
        or (home and path.startswith("~"))
    )


def _gh_operands(args: List[str]) -> List[str]:
    """Đối số không phải cờ và đích `<` của một khâu (đích `>`/`>&` bỏ) — những thứ khâu đọc như tệp."""
    out, skip = [], False
    for a in args:
        if skip:
            skip = False
        elif _is_redirect(a):
            skip = "<" not in a
        elif a[:1] != "-" or a == "-":
            out.append(a)
    return out


def _gh_stage_seen(n: List[str], moved: bool, home: bool, first: bool) -> bool:
    """Khâu sinh chữ guard thấy được (`GH_READERS`/`GH_LITERALS`, `git rev-parse`); khâu lọc không tệp chỉ khi không
    đứng đầu (đầu ống đọc stdin của shell — `exec < f`)."""
    if not n:
        return True
    if any(GH_DYN_RE.search(a) for a in n[1:]):
        return False
    if n[0] in GH_READERS:
        files = _gh_operands(n[1:])
        return bool(files or not first) and not any(_gh_path_bad(f, moved, home) for f in files)
    if n[0] in GH_LITERALS:
        return not any("\\" in a or "%b" in a for a in n[1:]) and "-e" not in n
    return n[:2] == ["git", "rev-parse"]


def _gh_text_seen(script: str, moved: bool, home: bool) -> bool:
    for pipe in pipelines(tokenize(script)):
        stages = [normalize(s) for s in pipe if s]
        if not all(_gh_stage_seen(st, moved, home, i == 0) for i, st in enumerate(stages)):
            return False
    return True


def _gh_substs(s: str) -> Optional[Tuple[str, List[str]]]:
    """(chữ ngoài `$(…)`, các script trong `$(…)`) của thân; ngoặc không cân → None."""
    rest, inner, i = [], [], 0
    while (j := s.find("$(", i)) >= 0:
        depth, k = 0, j + 1
        while k < len(s):
            depth += {"(": 1, ")": -1}.get(s[k], 0)
            if depth == 0:
                break
            k += 1
        if k >= len(s):
            return None
        rest.append(s[i:j])
        inner.append(s[j + 2 : k])
        i = k + 1
    rest.append(s[i:])
    return "".join(rest), inner


def _gh_body_dynamic(val: str, c: _GhCmd) -> bool:
    """Thân dựng lúc chạy: có dạng mở rộng mà chữ ngoài nháy đơn cũng có (`'query($n: …)'` là chữ), trừ
    `$(cat <<'EOF' …)` và `$(…)` chỉ gồm khâu thấy chữ (`_gh_stage_seen`)."""
    if not any(m in val for m in c.line.live_dyn):
        return False
    body = val.strip().split("=", 1)[1] if c.n[1] == "api" and "=" in val else val.strip()
    if GH_CAT_HEREDOC_RE.fullmatch(body):
        return False
    parts = _gh_substs(body)
    if parts is None or GH_DYN_RE.search(parts[0]):
        return True
    return not all(_gh_text_seen(x, c.moved, c.line.home) for x in parts[1])


def _gh_stdin_seen(c: _GhCmd) -> bool:
    """stdin của `gh`: chuyển hướng trên chính `gh` (heredoc gập — thân thay lệnh để lại `<<< $(…)` —, `< tệp` nguyên
    văn ở thư mục biết, `<&-`), hoặc ống mà mọi khâu trước thấy chữ; nhóm/hàm/`exec <`/`>(…)` → không."""
    n = c.n
    redirs = [(op, w) for op, w in zip(n, n[1:]) if op in ("<", "<<", "<<-", "<<<", "<&")]
    for op, w in redirs:
        dyn = bool(GH_DYN_RE.search(w))
        if (op == "<" and _gh_path_bad(w, c.moved, c.line.home)) or (op == "<<<" and dyn) or (op == "<&" and w != "-"):
            return False
    if redirs:
        return True
    return bool(c.up) and all(_gh_stage_seen(normalize(s), c.moved, c.line.home, i == 0) for i, s in enumerate(c.up))


def _gh_body_why(c: _GhCmd) -> str:
    n = c.n
    if "-e" in n or "--editor" in n:
        return "`gh … --editor`: thân do lệnh editor sinh"
    for f, val in _gh_flag_values(n[2:], GH_TEXT_FLAGS):
        if _gh_body_dynamic(val, c):
            return f"thân `{f}` dựng lúc chạy bằng khâu guard không thấy chữ (`$(…)`/backtick/`$biến`)"
        path = None
        if f in ("--body-file", "--input") or (f == "-F" and n[1] != "api"):
            path = val
        elif f in ("-F", "--field") and "=@" in val:
            path = val.split("=@", 1)[1]
        if path is None:
            continue
        bad = not _gh_stdin_seen(c) if path in GH_STDIN_PATHS else _gh_path_bad(path, c.moved, c.line.home)
        if bad:
            return f"thân `{f} {path}` từ stdin/tệp guard không lần được (ống, đổi thư mục, `HOME`)"
    return ""


def _gh_cmd_why(raw: List[str], moved: bool, line: _GhLine, up: List[List[str]]) -> str:
    n = normalize(raw)
    wrapped = line.func or any(posixpath.basename(t) == "xargs" for t in raw[: len(raw) - len(n)])
    if n[:1] in (["coproc"], ["function"], ["{"]) and "gh" in n:  # `function f { gh …`: thân hàm cùng lệnh đơn
        n, wrapped = n[n.index("gh") :], True
    if len(n) < 2:
        return ""
    if n[0] != "gh":
        return "tên `gh` dựng lúc chạy (AUD-SEC-192)" if GH_DYN_RE.search(n[0]) and n[1] in GH_TOPICS else ""
    kind = _gh_kind(n, line)
    if kind == "deny":
        return "`gh alias`/`extension`/lệnh con lạ — có thể đăng thân guard không thấy (AUD-SEC-193)"
    if kind and wrapped:
        return "`gh` đăng qua hàm/`coproc`/`xargs` — guard không thấy thân (AUD-SEC-191/192)"
    return _gh_body_why(_GhCmd(n, moved, up, line)) if kind else ""


def _gh_strict_why(folded: str, live: str, cwd: Optional[str]) -> str:
    if not re.search(r"gh|\b(?:pr|issue|api|alias|ext)\b", folded):
        return ""
    line = _GhLine(bool(re.search(r"\bHOME=", live)), bool(GH_FUNC_RE.search(live)), set(GH_DYN_RE.findall(live)))
    start = posixpath.normpath(cwd) if cwd else GH_CWD  # `cd <thư mục đang đứng> && …` không tính là đổi thư mục
    toks = tokenize(folded)
    cmds = _commands_with_cwds(toks, start)
    # khâu trước mỗi lệnh đơn trong ống của nó; hai cách chia lệch nhau (không nên xảy ra) → coi như không có ống
    ups = [[s for s in pipe[:k] if s] for pipe in pipelines(toks) for k, st in enumerate(pipe) if st]
    ups = ups if len(ups) == len(cmds) else [[] for _ in cmds]
    for (raw, ds), up in zip(cmds, ups):  # dời thư mục ở BẤT KỲ ứng viên nào (D-347)
        why = _gh_cmd_why(raw, any(d is None or posixpath.normpath(d) != start for d in ds), line, up)
        if why:
            return f"{why} — chỉ `xt.py pr reviewed` đăng dấu review (ADR-0063, AUD-SEC-191/192/193/253)"
    return ""


def _may_be_alias(head: str) -> bool:
    """Tên lệnh `head` (đã bỏ nháy, chưa bỏ thư mục) có chữ cho thấy có thể thành `alias` sau mở rộng của bash không
    (`al${v}ias`, `al?as`). Đường dẫn → không (dựng sẵn không gọi qua đường dẫn); tên hoàn toàn động (`$x`, `$(…)`) →
    không: giới hạn chung của phân tích tĩnh (`r${v}m -rf ~` cũng vậy), biến gán trong lệnh đã được viết lại thành chữ."""
    pat = HEAD_EXPANSION_RE.sub("*", head)
    if "/" in pat or not pat.strip("*"):
        return False
    if not any(c in pat for c in "*?["):
        return pat == "alias"
    return len(pat) > 64 or fnmatch.fnmatchcase("alias", pat)  # `fnmatch` bậc hai với nhiều `[` không đóng (D-273)


def _alias_rule(argv: List[str]) -> None:
    """Lệnh đơn định nghĩa alias (tên lệnh có thể là `alias`, đối số không phải tên trơn: `c=…`, `$d`, glob) → chặn."""
    a = _strip_prefixes(argv)
    if a and _may_be_alias(a[0]) and not all(ALIAS_ARG_OK_RE.fullmatch(x) for x in a[1:]):
        raise ScanTooComplex(f"định nghĩa alias (Claude Code bật `expand_aliases`): {' '.join(a)[:80]}")


def _comment_desyncs_ansi(cmd: str) -> bool:
    """D-274…D-276: `$'` trong comment (một dòng sau đó) hoặc `` `# `` (comment trong backtick nuốt dấu đóng) → chặn.
    Xét trên dòng đã nối `\\`↵ và đã gấp thân heredoc có nháy (dữ liệu, không phải lệnh: thân commit/PR có `` `#` ``
    vẫn chạy). `expand_ansi_c` bỏ qua comment nên nháy trong comment không còn làm lệch `$'…'` của dòng sau."""
    lines = _fold_heredocs(join_continuations(cmd), True).split("\n")
    for line in lines[:-1]:
        if "`#" in line:
            return True
        m = COMMENT_START_RE.search(line)
        if m is not None and "$'" in line[m.start() :]:
            return True
    return False


def _comment_continued(line: str) -> bool:
    return bool((len(line) - len(line.rstrip("\\"))) % 2 and COMMENT_START_RE.search(line))


def _line_index(lines: List[str], tabs: bool) -> Dict[str, List[int]]:
    """Dòng (nguyên văn; `tabs`: bỏ tab đầu dòng như `<<-`) → các chỉ số của nó: tìm dấu kết không quét lại mọi dòng."""
    out: Dict[str, List[int]] = {}
    for j, line in enumerate(lines):
        out.setdefault(line.lstrip("\t") if tabs else line, []).append(j)
    return out


class _HereEnds:
    """Dòng kết heredoc: so NGUYÊN VĂN với dấu kết như bash — `EOF ` hay `EOF` + NBSP không kết (AUD-SEC-200); `<<-`
    chỉ bỏ tab đầu dòng. Chỉ mục dựng một lần mỗi loại."""

    def __init__(self, lines: List[str]) -> None:
        self.lines = lines
        self.index: Dict[bool, Dict[str, List[int]]] = {}

    def find(self, m: "re.Match[str]", start: int) -> Optional[int]:
        """Chỉ số dòng dấu kết đầu tiên từ `start` của heredoc `m`; không có → None (heredoc không đóng)."""
        tabs = m.group().startswith("<<-")
        if tabs not in self.index:
            self.index[tabs] = _line_index(self.lines, tabs)
        rows = self.index[tabs].get(_heredoc_word(m)[0], [])
        k = bisect.bisect_left(rows, start)
        return rows[k] if k < len(rows) else None


def _heredocs(cmd: str) -> List[Tuple[str, "re.Match[str]", List[str]]]:
    """(dòng mở, match, thân) của mọi heredoc (cả trong `$(…)`/`"$(…)"`: `-m "$(cat <<'EOF'`). Không thấy dấu kết → thân
    là phần còn lại."""
    lines = cmd.split("\n")
    return [(lines[o], m, lines[a:b]) for o, m, a, b, _ in _here_scan(cmd)]


def literal_bodies_masked(cmd: str) -> str:
    """Dòng lệnh bỏ thân heredoc có dấu kết trong nháy (`<<'EOF'`): bash không thay `` `…` ``/`$(…)` trong thân đó —
    code span trong message commit (`-m "$(cat <<'EOF'` ↵ ``chặn `rm -rf ~` `` ↵ `EOF`) là chữ, không phải lệnh."""
    lines = cmd.split("\n")
    # giữ dòng dấu kết; heredoc không đóng: phần còn lại vẫn quét như lệnh (AUD-SEC-190)
    drop = {j for _, m, a, b, _ in _here_scan(cmd) if _heredoc_word(m)[1] and b < len(lines) for j in range(a, b)}
    return "\n".join(line for j, line in enumerate(lines) if j not in drop)


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
    """Bỏ thân heredoc (dữ liệu, không phải lệnh) cùng dòng kết — giữ dòng mở. Thân heredoc trong `"$(…)"` giữ lại (quét
    chặt như chữ của thay lệnh; bộ đọc heredoc không lấy `"`/`<<` trong thân làm nháy/heredoc — review #361 lượt 3).
    Heredoc không đóng tới cuối lệnh: phần còn lại giữ như lệnh — đọc sai dấu kết không nuốt lệnh thật (AUD-SEC-190)."""
    return _fold_heredocs(cmd, False)


def _fold_heredocs(cmd: str, subst: bool, escape: bool = False) -> str:
    """`strip_heredocs`; `subst` (cho `_ShellScan`): thay lệnh/mở rộng tham số trong thân heredoc dấu kết không nháy
    (bash thay trước khi đưa vào lệnh) ghép vào ngay sau `<<TAG` của dòng mở (`_heredoc_feed`, review #361); thân CÓ nháy
    trong `"$(…)"` thành dòng trống — chữ, không phải lệnh (`--body "$(cat <<'EOF'` ↵ `Fixed (partially` …; D-270).
    `escape` (cho `tokenize`): thân trong `"$(…)"` thoát `\\`/`"` — shlex đọc thân như chữ trong nháy kép, giữ nguyên
    nội dung (`bash -c "$(cat <<'E'` …), `"` lẻ trong thân không làm lệnh sau đó lọt vào một chuỗi."""
    lines = cmd.split("\n")
    keep = [True] * len(lines)
    adds: Dict[int, List[Tuple[int, str]]] = {}
    for o, m, a, b, in_dq in _here_scan(cmd):
        quoted = _heredoc_word(m)[1]
        if b >= len(lines):
            continue
        if in_dq:
            if subst and quoted:
                lines[a:b] = [""] * (b - a)
            elif escape:
                lines[a:b] = [line.replace("\\", "\\\\").replace('"', '\\"') for line in lines[a:b]]
            continue
        if subst and not quoted:
            adds.setdefault(o, []).append((m.end(), _heredoc_feed("\n".join(lines[a:b]))))
        keep[a : b + 1] = [False] * (b + 1 - a)
    for o, extra in adds.items():
        for pos, text in reversed(extra):
            lines[o] = lines[o][:pos] + text + lines[o][pos:]
    return "\n".join(line for line, k in zip(lines, keep) if k)


def strip_comments(cmd: str, strict: bool = False) -> str:
    """Bỏ comment kiểu bash: `#` ở ĐẦU một từ (đầu chuỗi, sau khoảng trắng hoặc toán tử), ngoài nháy, tới hết dòng.
    `#` giữa từ (`${#A[@]}`, `$#`, `/#/rooms`, `a#b.ts`), trong nháy hoặc sau `\\` là chữ thường (shlex không phân biệt).
    `strict` (đường `tokenize`, chữ đã giải ANSI-C): `)#` không khoảng trắng → `ScanTooComplex` (AUD-SEC-195); đường
    `brace_variants` đọc chuỗi thô (nháy `$'\\''` lệch) nên không chặn ở đó — chặn oan."""
    out: List[str] = []
    quote, word_start, i = "", True, 0
    while i < len(cmd):
        c = cmd[i]
        if c == "#" and word_start and not quote:
            if strict and i and cmd[i - 1] == ")":
                raise ScanTooComplex(PAREN_HASH_WHY)
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
        word_start = (
            not quote and c in WORD_END
        )  # `)#` không khoảng trắng: `strict` chặn ở đường `tokenize` (AUD-SEC-195)
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
    giữ nguyên chuỗi nên lệnh bên trong lọt). `$$'…'` là `$$` + nháy đơn, không phải ANSI-C (AUD-SEC-198)."""
    out: List[str] = []
    i, q, ws = 0, "", True
    while i < len(cmd):
        c = cmd[i]
        if not q and c == "#" and ws:  # comment: chép nguyên tới hết dòng (D-276) —
            e = cmd.find("\n", i)  # nháy trong comment không làm lệch `$'…'` của dòng sau
            e = len(cmd) if e < 0 else e
            out.append(cmd[i:e])
            i = e
        elif c == "\\" and q != "'" or not q and cmd.startswith("$$", i):  # `$$'…'` = `$$` + nháy đơn
            out.append(cmd[i : i + 2])
            i, ws = i + 2, False
        elif not q and cmd.startswith('$"', i):  # `$"…"` (dịch locale) = `"…"`; bỏ `$` (AUD-SEC-225)
            i, ws = i + 1, False
        elif not q and cmd.startswith("$'", i):
            j = i + 2
            while j < len(cmd) and cmd[j] != "'":
                j += 2 if cmd[j] == "\\" else 1
            body = ANSI_ESCAPE_RE.sub(_ansi_c_char, cmd[i + 2 : j])
            out.append("'" + body.replace("'", "'\\''") + "'")
            i, ws = j + 1, False
        else:
            if c == "'" and q in ("", "'") or c == '"' and q in ("", '"'):
                q = "" if q else c
            out.append(c)
            ws = not q and c in WORD_END
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
        elif s.startswith("$$", j):  # `$$'…'` = `$$` + nháy đơn, không phải ANSI-C
            yield j, c
            yield j + 1, c
            j += 2
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
    joined = join_continuations(cmd)
    cmd = expand_ansi_c(_fold_heredocs(joined, False, True))
    strip_comments(cmd, True)  # `)#` chặn TRƯỚC khi `$IFS`/`$(pwd)` bị viết lại (`$(pwd)#` thành `$PWD#`, AUD-SEC-195)
    cmd = IFS_RE.sub(" ", cmd)
    cmd = PWD_SUBST_RE.sub("$PWD", cmd)
    lex = shlex.shlex(strip_comments(cmd, True), posix=True, punctuation_chars="();<>|&\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    lex.commenters = ""  # comment đã bỏ ở strip_comments; mặc định của shlex là "#" (mở comment cả giữa từ)
    try:
        return _with_here_bodies(list(lex), joined)
    except ValueError:  # nháy không đóng: tách thô để vẫn kiểm được (bảo thủ) — xuống dòng là ranh giới lệnh như bash,
        # không phải khoảng trắng (`"` lẻ trong thân heredoc của `"$(cat <<'EOF'` làm shlex lệch; review #361 lượt 3)
        raw = re.split(r"[ \t\r]+|(?=[;&|\n])|(?<=[;&|\n])", cmd)
        return [t if _is_punct(t) else re.sub(r"[\\'\"]", "", t) for t in raw]  # bỏ nháy/`\\`: `\\rm`, `'r'm` (D-276)


class HereWord(str):
    """Token dấu kết của heredoc CÓ NHÁY đã đóng, mang thân (`body`) — chữ bash đưa nguyên vào stdin (AUD-SEC-512)."""

    body = ""


def _with_here_bodies(tokens: List[str], joined: str) -> List[str]:
    """Gắn thân vào dấu kết (`HereWord`) của mọi heredoc có nháy đã đóng: `<<` thứ k là heredoc thứ k của bộ đọc heredoc
    (`_here_scan` — như `_reuse_cmds`; heredoc trong `"$(…)"` không thành token). Số lệch (`$((1<<2))`) → không gắn
    (thân không thấy như cũ)."""
    spans = [s for s in _here_scan(joined) if not s[4]]
    ops = [i for i, t in enumerate(tokens[:-1]) if t == "<<"]
    if not spans or len(ops) != len(spans):
        return tokens
    lines = joined.split("\n")
    for i, (_, m, a, b, _) in zip(ops, spans):
        if _heredoc_word(m)[1] and b < len(lines):
            tokens[i + 1] = word = HereWord(tokens[i + 1])
            word.body = "\n".join(lines[a:b])
    return tokens


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


# Gán biến đầu lệnh/đối số `export`: `TÊN=v` và `TÊN+=v` (bash nối vào giá trị cũ — `X+=1 rm -rf /` vẫn chạy rm,
# AUD-SEC-125). Tên không mang `+`: tách bằng `_assign_split`.
ENV_ASSIGN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\+?=.*")


def _assign_split(t: str) -> Tuple[str, str]:
    """(tên, giá trị) của gán `t` (đã khớp ENV_ASSIGN_RE). `TÊN+=v` nối vào giá trị cũ mà guard không biết → giá trị
    `${TÊN}v`: còn biến (`_expands`), đi theo đường "không biết" sẵn có (khoá git chạy lệnh tính là không an toàn)."""
    name, _, val = t.partition("=")
    return (name[:-1], "${%s}%s" % (name[:-1], val)) if name.endswith("+") else (name, val)


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
        if rest[i] == "-C" and i + 1 < len(rest):  # gọi cho mọi lệnh git (`_ledger_asks`): `git -C` có thể đứng cuối
            dirs.append(rest[i + 1])
        i += 2 if rest[i] in GIT_OPTS_WITH_VALUE else 1
    return dirs


def _git_dir(argv: List[str], cwd: Optional[str]) -> Optional[str]:
    """Thư mục repo mà lệnh git (`git -C a -C b …`) tác động: `cwd` đi qua các `-C`; không biết (biến, `cd -`,
    `~+`/`~-` — AUD-SEC-100) → None."""
    gdir = cwd
    for d in _git_C_dirs(argv):
        known = "$" not in d and not TILDE_DIR_RE.match(d)
        d = posixpath.expanduser(d)
        # `-C` tuyệt đối đặt lại thư mục kể cả khi trước đó không biết (`git -C "$X" -C /abs …`, review #438)
        gdir = posixpath.normpath(posixpath.join(gdir or "", d)) if known and (gdir or d.startswith("/")) else None
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


def _cd_target(n: List[str], cwd: Optional[str], cdpath: bool = False, home: bool = False) -> Optional[str]:
    """Thư mục sau `cd <dir>`; `cd`, `cd -`, `pushd +N`, `cd` kèm cờ lạ hay biến → None (không biết — D-106: đích ghi
    tương đối sau đó thử ở mọi thư mục canh). Chuyển hướng và cờ `-P`/`-L`/`-e`/`--` không đổi đích (AUD-SEC-088).
    Có `CDPATH` (`cdpath`) hay thư mục trước đó không biết: chỉ đích tuyệt đối/`~` giải được. Lệnh đã gán/đọc `HOME`
    (`home`): `~`/`~/…` là không biết như `cd $HOME` (AUD-SEC-414)."""
    args, dashdash = _cd_operands(n[1:])
    if len(args) != 1 or "$" in args[0] or re.search(r"[*?\[]", args[0]) or TILDE_DIR_RE.match(args[0]):
        return None  # biến, glob (`cd .cl*`), `~+`/`~-` (= `$PWD`/`$OLDPWD` — AUD-SEC-097): không biết (D-106)
    if home and HOME_TILDE_RE.match(args[0]):
        return None
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


HOME_TILDE_RE = re.compile(r"~(?=/|$)")  # `~`, `~/…` mở ra `$HOME` (không phải `~user`, `~+`, `~-`)


HOME_PERSIST_HEADS = frozenset(
    "export declare typeset readonly local read mapfile readarray unset getopts let eval coproc".split()
)
HOME_VAR_FLAG_HEADS = {"printf": "-v", "wait": "-p"}  # chỉ ghi biến qua cờ này (`printf -v HOME`, `wait -p HOME`)


def _sets_home(argv: List[str]) -> bool:
    """Lệnh đổi `HOME` BỀN ở shell hiện tại (AUD-SEC-414, review #429): gán đứng riêng (`HOME=…`, chỉ có gán), lệnh
    dựng sẵn ghi biến (`export`/`declare -x`/`read`/`unset`/`printf -v`/`eval`… nhắc HOME), `for HOME in`. Gán tiền tố
    (`HOME=x cmd`, `env HOME=x cmd`) không đổi `~` của shell này — bash mở `~` trước khi áp gán tiền tố."""
    words = [t for t in argv if t not in SHELL_KEYWORDS and not _is_redirect(t)]
    if words[:1] in (["for"], ["select"]):
        return words[1:2] == ["HOME"]
    homes = [t for t in words if t == "HOME" or t.startswith(("HOME=", "HOME+=")) or "HOME" in t and "eval" in words]
    if not homes:
        return False
    if all(ENV_ASSIGN_RE.fullmatch(t) for t in words):
        return True
    head = posixpath.basename(next((t for t in words if not ENV_ASSIGN_RE.fullmatch(t)), ""))
    flag = HOME_VAR_FLAG_HEADS.get(head)
    if flag:
        return any(p == flag and w == "HOME" for p, w in zip(words, words[1:]))
    return head in HOME_PERSIST_HEADS


def _enterable_dir(path: Optional[str]) -> bool:
    """Thư mục có thật và vào được lúc guard kiểm — `cd` tới đó gần như chắc thành công (đặt `OLDPWD`)."""
    return bool(path) and os.path.isdir(str(path)) and os.access(str(path), os.X_OK)


def _is_cd_back(n: List[str]) -> bool:
    """`cd -`/`pushd -` (cả `cd -- -`, `pushd -- -`, cờ `-P`/`-L` đứng trước — bash 5.3): `cd "$OLDPWD"` — thư mục
    KHÔNG BIẾT (AUD-SEC-466: OLDPWD đổi qua gán tiền tố `OLDPWD=X cd -`, `PWD=X` trước `cd`, `false && cd -`… guard
    không theo dõi chắc được); tiền tố `cd … &&` cũng vậy (AUD-SEC-488)."""
    return n[:1] in (["cd"], ["pushd"]) and _cd_operands(n[1:])[0] == ["-"]


Cands = Tuple[Optional[str], ...]  # thư mục ứng viên của một lệnh (T-3672); None = không biết (D-106)
# Mảnh của token tách lệnh (shlex gom `);`, `&\n`, `&&(`): xử lý theo thứ tự
SEP_PIECE_RE = re.compile(r"\|\||&&|\|&|;;&?|;&|[;&|\n()]")
CWD_UNION_MAX = 16  # D-347: số thư mục ứng viên tối đa của một lệnh; vượt → thêm None (không biết, D-106)
CD_LOOP_HEADS = frozenset({"while", "until", "for", "select"})
CD_CHAIN_SEPS = ("&&", "|", "|&")  # vế sau chỉ chạy khi `cd` của tiền tố thành công (`|` gắn chặt hơn `&&`)
CD_MOVE_HEADS = frozenset({"cd", "pushd", "popd"})
# Thân `eval` có thể chứa lệnh đổi thư mục: nhắc tên lệnh, hay có nháy/`\`/`$`/backtick (`c''d`, `c\d` ghép lại sau đọc)
CD_WORD_IN_EVAL_RE = re.compile(r"cd|pushd|popd|eval|[\"'\\$`]")
SimpleCmds = List[Tuple[List[str], List[str]]]  # (argv, mảnh tách đứng sau nó)


def _simple_commands(tokens: List[str]) -> Tuple[List[str], SimpleCmds]:
    """(mảnh tách đứng trước lệnh đầu, [(argv, mảnh tách đứng sau nó)]) — tách theo `SEP_PIECE_RE`."""
    lead: List[str] = []
    out: SimpleCmds = []
    cur: List[str] = []
    for t in tokens:
        if _is_punct(t) and not _is_redirect(t):
            pieces = SEP_PIECE_RE.findall(t)
            if cur:
                out.append((cur, pieces))
                cur = []
            else:
                (out[-1][1] if out else lead).extend(pieces)
        else:
            cur.append(t)
    if cur:
        out.append((cur, []))
    return lead, out


def _joins(after: List[str], seps: Tuple[str, ...]) -> bool:
    """Mảnh sau lệnh là đúng một nối trong `seps`, theo sau chỉ xuống dòng hay `(` mở subshell (`cd x && (a; b)`)."""
    return bool(after) and after[0] in seps and all(p in ("\n", "(") for p in after[1:])


def _cd_physical(n: List[str]) -> bool:
    """`cd -P …`/`pushd -P …` (cả cờ ghép `-LP`), hay `SHELLOPTS` có `physical`: `..` giải theo đường vật lý."""
    flags = itertools.takewhile(lambda a: a != "--", n[1:])
    return "physical" in os.environ.get("SHELLOPTS", "") or any(CD_FLAG_RE.fullmatch(a) and "P" in a for a in flags)


class _CwdFlags:
    """Trạng thái shell ảnh hưởng cách `cd` giải đích (D-347): `CDPATH`, `HOME` gán lại, `cdable_vars`."""

    def __init__(self) -> None:
        self.cdpath = bool(os.environ.get("CDPATH"))
        self.cdable = "cdable_vars" in os.environ.get("BASHOPTS", "")
        self.home = False

    def see(self, argv: List[str]) -> None:
        self.cdpath = self.cdpath or _sets_cdpath(argv)
        self.home = self.home or _sets_home(argv)
        self.cdable = self.cdable or any("cdable_vars" in t for t in argv)


def _exact_prefix(
    cmds: SimpleCmds, start: Optional[str], flags: _CwdFlags
) -> Tuple[List[List[Optional[str]]], List[Optional[str]]]:
    """Tiền tố chính xác (D-347): `cd`/`pushd <đích nguyên văn>` nối bằng `&&` ngay từ đầu lệnh — (tập thư mục sau
    từng `cd` của tiền tố, thư mục còn lại nếu một `cd` của nó hỏng). Mỗi tập giữ đích theo chữ và realpath của đường
    thô như `_cd_step` (AUD-SEC-491: bash rơi về đường vật lý khi đường logic không có, kernel giải `..` của đích ghi
    theo thư mục vật lý); `cd -`/`cd -- -` không thuộc tiền tố (AUD-SEC-488). `cd` chắc thành công khi đích vào được
    lúc kiểm (`isdir` trên đường THÔ như bash: `cd /khong-co/..` hỏng); `-P` (đường vật lý) không thuộc tiền tố."""
    heres: List[Optional[str]] = [start]
    steps: List[List[Optional[str]]] = []
    fallback: List[Optional[str]] = []
    for argv, after in cmds:
        ok = argv[:1] in (["cd"], ["pushd"]) and _joins(after, ("&&",)) and not _cd_physical(argv)
        n = argv if ok and not _is_cd_back(argv) else []
        targets = [_cd_target(n, h, flags.cdpath) for h in heres] if n else [None]
        if None in targets:
            break
        raws = [posixpath.join(h or "/", posixpath.expanduser(_cd_operands(n[1:])[0][0])) for h in heres]
        if not all(map(_enterable_dir, raws)):
            if flags.cdable:  # `cd` hỏng thử `cd "$T"`: không biết
                break
            fallback += heres
        heres = list(dict.fromkeys([*targets, *map(_realpath_safe, raws)]))
        steps.append(heres)
    return steps, fallback


def _cd_step(n: List[str], c: Optional[str], flags: _CwdFlags) -> List[Optional[str]]:
    """Thư mục sau `cd`/`pushd`/`popd` `n` chạy ở `c`: đích theo chữ và theo realpath của đường thô (`cd -P`, `set -P`
    — symlink giải trước `..`); không biết (biến, `cd -`, `popd`, `pushd +N`, CDPATH, `cdable_vars` khi đích chưa có)
    → None."""
    t = None if n[0] == "popd" or _is_cd_back(n) else _cd_target(n, c, flags.cdpath, flags.home)
    if t is None:
        return [None]
    raw = posixpath.join(c or "/", posixpath.expanduser(_cd_operands(n[1:])[0][0]))
    return [t, _realpath_safe(raw), *([None] if flags.cdable and not _enterable_dir(raw) else [])]


def _cd_moves(
    n: List[str], cur: List[Optional[str]], primary: Optional[str], flags: _CwdFlags, repeat: bool
) -> Optional[Tuple[Optional[str], List[Optional[str]]]]:
    """(thư mục của nhánh mọi `cd` thành công, mọi thư mục mới) sau lệnh `n` chạy ở MỘT trong `cur` (D-347); lệnh
    không đổi thư mục → None. `repeat` (vòng lặp, thân hàm): đích tương đối giải lại từ đích mới tới bao đóng — quá
    `CWD_UNION_MAX` thì thêm None — và cộng None (D-351, AUD-SEC-490: thân chạy lại sau `cd` ĐỨNG SAU nó — cuối thân
    vòng, nơi gọi hàm — guard không giải lại từ đó); `eval`/`trap` (thân trap chạy lúc tín hiệu/`DEBUG`, trong shell
    này)/`.`/`source` có `cd`/`eval` → mọi thư mục của thân cộng None (`_body_moves`)."""
    text = _shell_body(n, cur)
    if text is not None:
        return _body_moves(text, cur)
    if not n or n[0] not in CD_MOVE_HEADS:
        return None
    out: List[Optional[str]] = []
    frontier = list(cur)
    while frontier:
        new = [d for c in frontier for d in _cd_step(n, c, flags) if d not in cur and d not in out]
        out += list(dict.fromkeys(new))
        frontier = list(dict.fromkeys(new)) if repeat else []
        if len(out) > CWD_UNION_MAX:
            out.append(None)
            break
    relative = repeat and None in _cd_step(n, None, flags)  # đích không tuyệt đối nguyên văn (cả `..`)
    return _cd_step(n, primary, flags)[0], [*out, *([None] if relative else [])]


UNSEEN_BODY = "\0"  # thân lệnh guard không thấy (argv không chứa được NUL)


def _shell_body(n: List[str], cur: List[Optional[str]]) -> Optional[str]:
    """Chữ lệnh mà `n` chạy trong CHÍNH shell này: `eval` (mọi đối số), `trap` (đối số đầu là thân, sau đó là tín hiệu —
    AUD-SEC-493: `trap 'cd x' DEBUG` từng thành `cd x DEBUG`), `.`/`source` (`_source_text`); lệnh khác → None."""
    args = [a for a in n[1:] if a != "--"]  # `eval -- cd x`, `trap -- 'cd x' DEBUG`
    if n[:1] == ["eval"]:
        return " ".join(args)
    if n[:1] == ["trap"]:
        return " ".join(args[:1])
    return _source_text(n, cur) if n[:1] in (["."], ["source"]) else None


def _source_text(n: List[str], cur: List[Optional[str]]) -> Optional[str]:
    """AUD-SEC-493: chữ mà `.`/`source` chạy — stdin (đường đã `_norm_path`: `/dev/./stdin` — AUD-SEC-511) → chữ stdin
    nhận (`_stdin_feed`), giải như `eval`; tệp thường có sẵn ở mọi thư mục ứng viên → None (giữ hành vi cũ, không đọc
    tệp); còn lại guard không thấy (fd, `/dev`/`/proc` kể cả qua symlink — không `isfile` trên đó, AUD-SEC-513; biến,
    glob, tuỳ chọn như `-p` của bash 5.3, tệp chưa có) → `UNSEEN_BODY`."""
    args = n[2:] if n[1:2] == ["--"] else n[1:]
    path = posixpath.expanduser(args[0]) if args else ""
    if _norm_path(path) in STDIN_SCRIPTS:
        return _stdin_feed(args[1:])
    unseen = not path or path.startswith("-") or _is_punct(path) or bool(re.search(r"[$`*?\[]", path))
    if unseen or not all(c is not None or path.startswith("/") for c in cur):
        return UNSEEN_BODY
    full = [posixpath.join(c or "/", path) for c in cur]
    known = not any(_via_dev(f) for f in full) and all(os.path.isfile(f) for f in full)
    return None if known else UNSEEN_BODY


def _stdin_feed(rest: List[str]) -> str:
    """AUD-SEC-512: chữ stdin của `.`/`source` nhận theo chuyển hướng vào CUỐI (bash áp lần lượt), bất kể chuyển hướng
    khác: here-string chữ nguyên văn, heredoc có nháy đã đóng (`HereWord`) → chữ đó; tệp/fd/heredoc không nháy/chữ có
    mở rộng, không chuyển hướng (stdin của lệnh Bash), số fd khác 0 đứng trước (`3<<<` — hay đối số `3` rồi `<<<`: token
    không giữ khoảng trắng) → `UNSEEN_BODY`."""
    feed = UNSEEN_BODY
    for i, op in enumerate(rest[:-1]):
        fd = rest[i - 1] if i and rest[i - 1].isdigit() else ""
        if not _is_redirect(op) or not (op[0] == "<" or fd == "0"):
            continue
        if fd not in ("", "0"):
            return UNSEEN_BODY
        feed = _here_text(op, rest[i + 1])
    return feed


def _here_text(op: str, word: str) -> str:
    """Chữ stdin nhận từ chuyển hướng `op word`: here-string không `$`/backtick, heredoc có nháy (`HereWord.body`)."""
    if op == "<<<":
        return UNSEEN_BODY if re.search(r"[$`]", word) else word
    return word.body if op == "<<" and isinstance(word, HereWord) else UNSEEN_BODY


def _body_moves(text: str, cur: List[Optional[str]]) -> Optional[Tuple[Optional[str], List[Optional[str]]]]:
    """`_cd_moves` của thân `text` chạy trong shell này: thân có `cd`/`eval` → mọi thư mục của thân giải từ mọi ứng viên,
    cộng None; thân không thấy (`UNSEEN_BODY`) → None (D-106); không đổi thư mục → None."""
    if text == UNSEEN_BODY:
        return None, [None]
    if not CD_WORD_IN_EVAL_RE.search(text):  # đường nhanh: thân không nhắc lệnh đổi thư mục
        return None
    body = tokenize(text)
    if not any(normalize(c)[:1] in (["eval"], *([h] for h in CD_MOVE_HEADS)) for c in split_commands(body)):
        return None
    return None, [*(d for c in cur for _, cs in _commands_with_cwds(body, c) for d in cs), None]


def _commands_with_cwds(tokens: List[str], start: Optional[str]) -> List[Tuple[List[str], Cands]]:
    """Mỗi lệnh đơn kèm TẬP thư mục nó có thể chạy — HỢP MỌI ĐÍCH (D-347, thay mô phỏng luồng điều khiển của T-3672):
    tiền tố `cd <đích nguyên văn> && …` từ đầu lệnh giữ một thư mục (`_exact_prefix`; vế `&&`/`|` nối tiếp chạy ở đó,
    hết chuỗi thì thêm thư mục của `cd` có thể hỏng); sau đó mỗi lệnh xét trên {thư mục đầu} ∪ {mọi đích `cd`/`pushd`
    đứng trước nó, giải từ mọi ứng viên đã có} (`_cd_moves`) — đúng cho mọi `if`/`while`/hàm/ống/subshell/`exit`/`||`
    mà không mô phỏng chúng. Lệnh trong vòng lặp nhận tập ở cuối vòng ngoài cùng; mọi lệnh từ định nghĩa hàm đầu tiên
    và `trap` nhận tập cuối. Phần tử đầu là nhánh mọi `cd` thành công (giữ bảng env/cờ của `res`)."""
    lead, cmds = _simple_commands(tokens)
    walk = _CwdUnion(start, cmds, lead)
    for i, (argv, after) in enumerate(cmds):
        walk.command(i, argv, cmds[i - 1][1] if i else lead, after)
    sets, final = walk.sets, walk.ordered()
    for s, e in walk.spans + ([(walk.loops[0], len(cmds) - 1)] if walk.loops else []):
        sets[s : e + 1] = [[*sets[k], *sets[e]] for k in range(s, e + 1)]
    out: List[Tuple[List[str], Cands]] = []
    for i, (argv, _) in enumerate(cmds):
        late = (walk.func is not None and i >= walk.func) or i in walk.traps
        here = [*sets[i], *final] if late else sets[i]
        out.append((list(argv), tuple(dict.fromkeys(_run_dir(argv, c) for c in here))))
    return out


class _CwdUnion:
    """Trạng thái đi qua các lệnh đơn của `_commands_with_cwds` (D-347): tập `cur` chỉ lớn dần, trừ đích `cd` trong
    subshell `( … )`/`$( … )` — bỏ khi ra khỏi đó (subshell luôn là tiến trình con, không phụ thuộc luồng điều khiển);
    `primary` (nhánh mọi `cd` thành công — chỉ để xếp thứ tự, không thu hẹp tập) không theo `cd` trong ống/nền và trở
    về sau `( … )` cùng cờ `HOME`/`CDPATH`; `)` lẻ (mẫu `case`) → không biết như cũ."""

    def __init__(self, start: Optional[str], cmds: SimpleCmds, lead: List[str]) -> None:
        self.flags = _CwdFlags()
        self.steps, self.fallback = _exact_prefix(cmds, start, self.flags) if not lead else ([], [])
        self.m = len(self.steps)
        self.cur: List[Optional[str]] = [start]
        self.start, self.primary, self.chain = start, start, self.m > 0
        self.stack: List[Tuple[Optional[str], bool, bool, bool, int]] = []
        self.kept: List[Optional[str]] = []  # thêm vào tập không do `cd` (thư mục của `cd` hỏng, `)` lẻ): giữ qua `)`
        self.sets: List[List[Optional[str]]] = []
        self.loops: List[int] = []
        self.spans: List[Tuple[int, int]] = []  # (đầu, cuối) của vòng lặp ngoài cùng đã đóng
        self.func: Optional[int] = None
        self.traps: Set[int] = set()  # lệnh `trap`: thân chạy lúc thoát/nhận tín hiệu — tập cuối

    def add(self, dirs: List[Optional[str]], keep: bool = False) -> None:
        self.kept += dirs if keep else []
        self.cur += [d for d in dirs if d not in self.cur]
        self.cur = self.cur if len(self.cur) <= CWD_UNION_MAX else [*self.cur[:CWD_UNION_MAX], None]

    def ordered(self) -> List[Optional[str]]:
        return [self.primary, *(d for d in self.cur if d != self.primary)] if self.primary in self.cur else self.cur

    def pieces(self, before: List[str]) -> None:
        f = self.flags
        for p in before:
            if p == "(":
                self.stack.append((self.primary, f.cdpath, f.home, f.cdable, len(self.cur)))
            elif p == ")" and self.stack:
                self.primary, f.cdpath, f.home, f.cdable, size = self.stack.pop()
                self.cur = [*self.cur[:size], *(d for d in self.cur[size:] if d in self.kept)]
            elif p == ")":
                self.primary = None
                self.add([None], keep=True)

    def command(self, i: int, argv: List[str], before: List[str], after: List[str]) -> None:
        self.pieces(before)
        lead_kw = itertools.takewhile(lambda t: t in SHELL_KEYWORDS or t in CD_LOOP_HEADS, argv)
        self.loops += [i] * sum(t in CD_LOOP_HEADS for t in lead_kw)
        self.func = i if self.func is None and (after[:2] == ["(", ")"] or argv[:1] == ["function"]) else self.func
        self.flags.see(argv)
        n = normalize(argv)
        self.traps |= {i} if n[:1] == ["trap"] else set()
        repeat = bool(self.loops) or self.func is not None
        if i < self.m:
            self.cur = list(self.steps[i])
            self.primary = self.cur[0]
        elif (moved := _cd_moves(n, self.cur, self.primary, self.flags, repeat)) is not None:
            sub = {"|", "|&"} & {*before, *after[:1]} or after[:1] == ["&"]  # ống/nền: shell con
            self.primary = self.primary if sub else moved[0]
            self.add([moved[0], *moved[1]])
        self.sets.append(self.ordered())
        if argv[:1] == ["done"] and self.loops:
            s = self.loops.pop()
            self.spans += [] if self.loops else [(s, i)]
        if self.chain and i >= self.m and not _joins(after, CD_CHAIN_SEPS):
            bg = after[:1] == ["&"]  # cả danh sách `&&` chạy nền: shell này vẫn ở thư mục đầu
            self.primary = self.start if bg else self.primary
            self.add([*self.fallback, *([self.start] if bg else [])], keep=True)
            self.chain = False


def _commands_with_cwd(tokens: List[str], start: Optional[str], pick: int = 0) -> List[Tuple[List[str], Optional[str]]]:
    """Mỗi lệnh đơn kèm MỘT thư mục: ứng viên thứ `pick` của `_commands_with_cwds` (ứng viên cuối nếu ít hơn) — gọi với
    mọi `pick` dưới `_cwd_picks` thì mỗi cặp (lệnh, ứng viên) được xét ít nhất một lần (D-347)."""
    return [(argv, cands[min(pick, len(cands) - 1)]) for argv, cands in _commands_with_cwds(tokens, start)]


def _cwd_picks(placed: List[Tuple[List[str], Cands]]) -> int:
    """Số ứng viên nhiều nhất của một lệnh đơn (`placed` = `_commands_with_cwds`) — số lượt `pick` phủ mọi ứng viên."""
    return max((len(c) for _, c in placed), default=1)


def _commands_each_cwd(tokens: List[str], start: Optional[str]) -> List[Tuple[List[str], Optional[str]]]:
    """Mọi cặp (lệnh đơn, thư mục ứng viên) — luật xét đích theo thư mục xét ĐỦ mọi ứng viên (D-347)."""
    return [(argv, d) for argv, cands in _commands_with_cwds(tokens, start) for d in cands]


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
VERDICT_RANK = {"deny": 2, "ask": 1}


def _push_refs(args: List[str]) -> List[str]:
    """Đối số vị trí của `git push` (remote, refspec…): sau `--` đầu tiên MỌI token là refspec, kể cả token bắt đầu `-`
    (git parse-options — AUD-SEC-387). Cờ (force, xoá…) vẫn đọc ở mọi vị trí — chiều chặt."""
    k = args.index("--") if "--" in args else len(args)
    return _positionals(args[:k], PUSH_VALUE_OPTS) + args[k + 1 :]


def _stricter(a: Tuple[str, str], b: Tuple[str, str]) -> Tuple[str, str]:
    """Quyết định chặt hơn (deny > ask > cho qua; hoà → `a`). Dùng khi token không đọc được một nghĩa: shlex trả `>` cho
    cả chuyển hướng lẫn `'>'` trong nháy (tên ref hợp lệ) — `git push origin 2>&1` phải xét như không có refspec,
    `git push origin '>' main` phải xét `main` (AUD-SEC-102)."""
    return b if VERDICT_RANK.get(b[0], 0) > VERDICT_RANK.get(a[0], 0) else a


def _git_push(args: List[str], cwd: Optional[str] = None) -> Tuple[str, str]:
    """push: deny --force/--mirror/+refspec và xoá nhánh chính; ask khi đẩy thẳng nhánh chính — kể cả khi không có
    refspec hoặc đích là `HEAD` mà nhánh hiện tại (ở `cwd`) là nhánh chính — và khi `--all`/`--tags` (mọi nhánh/tag)."""
    flags = _short_flags(args)
    force = any(x.startswith("--force") and x != "--force-if-includes" or x == "--mirror" for x in args) or "f" in flags
    refs = _push_refs(args)
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


# AUD-SEC-119 (T-3563): Gate mẫu tối ưu đọc script/baseline từ `origin/main` (optimization-loop.md), nhưng ref remote là
# ref CỤC BỘ: `update-ref refs/remotes/origin/main HEAD`, `fetch . HEAD:refs/remotes/origin/main`, `push . HEAD:origin/main`
# ghi thẳng nó; `tag`/`branch`/`checkout -b`/`switch -c`/`worktree add -b`/`stash branch`/`update-ref` tạo ref cùng tên mà
# git giải trước (`$GIT_DIR/<tên>`, `refs/<tên>`, `refs/tags/`, `refs/heads/` trước `refs/remotes/` — gitrevisions). Chặn
# (deny ở mọi chính sách và mọi pha, không nới ở pha build): ghi/xoá ref dưới `refs/remotes/` (cả `remote set-head <r>
# <nhánh>|-d` — ADR-0071, D-361; `-a` hỏi máy chủ thì qua), tạo/đổi tên/sao chép ref có tên ngắn `<remote>/…`. Tên remote: `git remote` ở repo của lệnh ∪ REMOTE_NAMES (đọc lỗi vẫn giữ tên mặc định), so
# không phân biệt hoa thường (macOS: `refs/heads/Origin/main` là cùng file với ref git tìm khi giải `origin/main`).
# Cho qua: `fetch origin [main]` (refspec cấu hình cập nhật `origin/main`), refspec đúng dạng cấu hình
# `[+]refs/heads/X:refs/remotes/<R>/X` khi <R> là remote ĐÃ cấu hình (tên khác là đường dẫn: `./origin`); xoá/đổi tên ref
# giả đi (`branch -D origin/x`, `tag -d`, `branch -dr` — Gate đỏ chứ không xanh giả); upstream/điểm bắt đầu là ref remote.
# Ghi thẳng `.git/packed-refs`, `.git/refs/remotes/**` và đổi URL/refspec/insteadOf của remote: chặn từ D-366 (khối
# REMOTE_CFG dưới, GIT_HOOK_PATTERNS). Giới hạn đã biết (lệnh cố ý né, D-015 — harness-files.md): ghi thẳng file
# `.git/refs/heads|tags/…`/`.git/<remote>/…`, `.git/refs/replace/…`, `fast-import`; ref trong biến/thay lệnh. Alias git (lệnh con khác tên) được mở và xét như lệnh thật
# (khối "Alias git" dưới); đối số từ stdin (`xargs`/`parallel`/`find -exec {}`) → UNRESOLVED_TARGET (khối "Đối số không
# thấy"). Giới hạn của alias: tệp cấu hình tạo trong CÙNG lệnh Bash rồi mới dùng (`printf … > f && GIT_CONFIG_GLOBAL=f
# git y …` — lúc guard đọc, tệp chưa có), lệnh con là biến (`git $S …`), lệnh xoá biến môi trường (`env -i/-u`, `unset`),
# `includeIf "onbranch:"` định nghĩa alias, thư mục repo là biến (đọc ở gốc dự án), git cũ thiếu một lệnh dựng sẵn trong
# GIT_BUILTINS (alias trùng tên đó chạy mà guard không tra), alias `!` quét ở thư mục của lệnh chứ không ở gốc repo. Rào
# thật của vòng tối ưu là `perf trial` (ADR-0052 §7).
REMOTE_REF_MARK = "ghi ref theo dõi remote"  # dấu của mã REMOTE_REF_FORGE (REASON_CODES)
REMOTE_REF_WHY = REMOTE_REF_MARK + " / tạo ref trùng tên remote ({}) — giả `<remote>/<nhánh>` mà Gate đọc (AUD-SEC-119)"
UNRESOLVED_REF_MARK = "ref đến từ stdin/xargs/find, guard không thấy"  # dấu của UNRESOLVED_TARGET
UNRESOLVED_ARGS_WHY = "git {} ({}): " + UNRESOLVED_REF_MARK + " có phải ref của remote (AUD-SEC-119)"
REMOTE_NAMES = frozenset({"origin", "upstream"})
FETCH_VALUE_OPTS = (
    *("--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--jobs", "--negotiation-tip", "--refmap"),
    *("--upload-pack", "--server-option", "--filter", "--strategy", "--strategy-option"),
)
TAG_VALUE_OPTS = ("--message", "--file", "--local-user", "--cleanup", "--format", "--sort", "--trailer", "--points-at")
TAG_NO_CREATE = {"-l", "-d", "-v", "-n", "--list", "--delete", "--verify", "--contains", "--no-contains", "--merged"}
TAG_NO_CREATE |= {"--no-merged", "--points-at"}
BRANCH_NO_CREATE = {"-l", "-a", "-r", "-d", "-D", "-u", "--list", "--all", "--remotes", "--delete", "--contains"}
BRANCH_NO_CREATE |= {"--no-contains", "--merged", "--no-merged", "--points-at", "--set-upstream-to", "--unset-upstream"}
BRANCH_NO_CREATE |= {"--show-current", "--edit-description"}
BRANCH_RENAME = {"-m", "-M", "-c", "-C", "--move", "--copy"}
BRANCH_VALUE_OPTS = ("--set-upstream-to", "--contains", "--no-contains", "--points-at", "--format", "--sort")
# Lệnh con → (chữ cờ ngắn nhận giá trị, tuỳ chọn dài nhận giá trị) mà GIÁ TRỊ là tên nhánh mới.
NEW_BRANCH_OPTS: Dict[str, Tuple[str, Tuple[str, ...]]] = {
    "checkout": ("bB", ("--orphan",)),
    "switch": ("cC", ("--create", "--force-create", "--orphan")),
    "worktree": ("bB", ()),
}
ParsedOpts = Tuple[Set[str], List[str], List[Tuple[str, str]]]


def _long_match(key: str, opts: Tuple[str, ...]) -> bool:
    """`key` (tuỳ chọn dài) là một trong `opts` hoặc viết tắt của nó — git nhận viết tắt không mơ hồ (`--force-c`)."""
    return key in opts or (key.startswith("--") and len(key) > 3 and any(o.startswith(key) for o in opts))


def _short_cluster(a: str, nxt: List[str], short_val: str) -> Tuple[List[str], List[Tuple[str, str]], int]:
    """Một cụm cờ ngắn (`-fb`, `-bx`): (cờ, [(cờ nhận giá trị, giá trị)], số token kế tiếp bị ăn làm giá trị)."""
    k = next((j for j, c in enumerate(a[1:], 1) if c in short_val), len(a))
    flags = ["-" + c for c in a[1 : k + 1]]
    if k == len(a):
        return flags, [], 0
    took = [a[k + 1 :]] if k + 1 < len(a) else nxt
    return flags, [("-" + a[k], v) for v in took], len(took) if k + 1 == len(a) else 0


# Cờ ngắn có tên dài phủ định được (`-d, --[no-]delete`…): `--no-<tên>` đứng sau huỷ cả dạng ngắn (đo trên git 2.43:
# `branch -d --no-delete X`, `-m --no-move X`, `-l --no-list X` TẠO nhánh X).
NEGATABLE_SHORT = {"--delete": "-d", "--list": "-l", "--copy": "-c", "--move": "-m", "--set-upstream-to": "-u"}


def _negate(flags: Set[str], full: str) -> None:
    """`--no-<x>`: bỏ cờ đã gặp mà nó phủ định — dạng dài (cả viết tắt hai chiều: `--del`/`--no-delete`, `--delete`/
    `--no-del`) và dạng ngắn trong NEGATABLE_SHORT. Bỏ thừa chỉ làm guard coi lệnh là có tạo ref (chiều chặt)."""
    longs = {f for f in flags if f.startswith("--") and not f.startswith("--no-")}
    flags.difference_update(f for f in longs if f.startswith(full) or full.startswith(f))
    flags.difference_update(short for name, short in NEGATABLE_SHORT.items() if name.startswith(full))


def _parse_opts(args: List[str], short_val: str, long_val: Tuple[str, ...]) -> ParsedOpts:
    """(cờ đã gặp, đối số vị trí, [(tuỳ chọn, giá trị)]) theo kiểu parse-options của git: cụm cờ ngắn dừng ở chữ nhận
    giá trị (`-fb x`, `-bx`), `--opt=v`/`--opt v`, viết tắt tuỳ chọn dài, `--no-<x>` huỷ `--<x>`/cờ ngắn của nó đứng
    trước, sau `--` là đối số vị trí."""
    flags: Set[str] = set()
    pos: List[str] = []
    vals: List[Tuple[str, str]] = []
    i = 0
    while i < len(args):
        a, nxt = args[i], args[i + 1 : i + 2]
        i += 1
        if a == "--":
            return flags, pos + args[i:], vals
        if a.startswith("--"):
            key, eq, val = a.partition("=")
            if key.startswith("--no-") and len(key) > 5:
                _negate(flags, "--" + key[5:])
            flags.add(key)
            took = ([val] if eq else nxt) if _long_match(key, long_val) else []
            vals += [(key, v) for v in took]
            i += 0 if eq else len(took)
        elif a.startswith("-") and len(a) > 1:
            short, got, ate = _short_cluster(a, nxt, short_val)
            flags.update(short)
            vals += got
            i += ate
        else:
            pos.append(a)
    return flags, pos, vals


# T-3673: bộ đọc tuỳ chọn dùng chung cho lệnh ngoài git — mục ("", toán hạng) | (chữ cờ ngắn hay tên dài đầy đủ, giá
# trị|None), giữ thứ tự (tar `-C` theo vị trí). Bảng theo lệnh: (chữ cờ ngắn ăn giá trị, mọi tên dài, tên dài bắt buộc
# giá trị, nhận viết tắt). Đọc sai cờ từng làm lọt cả họ lỗ (AUD-SEC-468…477): cụm `-ft D`, dính `-tD`, `--t D`, `--`.
OptItems = List[Tuple[str, Optional[str]]]
OptTable = Tuple[str, Tuple[str, ...], Tuple[str, ...], bool]


def _long_names(name: str, longs: Tuple[str, ...], abbrev: bool = True) -> List[str]:
    """Tên dài đầy đủ như getopt_long/argp/argparse/clap: trùng khớp, hay MỌI tên nhận `name` làm tiền tố — AUD-SEC-495:
    tên mơ hồ ở một bản/hiện thực lại là tên đúng một cờ ở bản khác (`install --d`: coreutils 9.7 báo mơ hồ debug/
    directory, uutils 0.8.0 không có `--debug` nên là `--directory`), nên xét chặt mọi tên khớp; lạ → giữ nguyên. popt
    (rsync) không nhận viết tắt (`abbrev` False)."""
    hits = [x for x in longs if x.startswith(name)] if abbrev and name and name not in longs else []
    return hits or [name or "-"]


def _long_items(a: str, rest: List[str], long_val: Tuple[str, ...], names: List[str]) -> Tuple[OptItems, int]:
    """(mục, số token kế đã ăn) của `--tên[=v]` khớp `names`: tên bắt buộc giá trị ăn token kế; khớp mơ hồ lẫn tên cờ và
    tên ăn giá trị thì token kế CŨNG là toán hạng (chiều chặt — không biết bản nào chạy)."""
    _, eq, val = a[2:].partition("=")
    takers = [x for x in names if x in long_val]
    took = [val] if eq else rest[:1] if takers else []
    items: OptItems = [(x, took[0] if took and (eq or x in takers) else None) for x in names]
    mixed = not eq and bool(took) and len(takers) < len(names)
    return items + ([("", took[0])] if mixed else []), 0 if eq else len(took)


def _getopt(args: List[str], table: OptTable) -> OptItems:
    """Đọc `args` như getopt_long (hoán vị, GNU): cụm cờ ngắn dừng ở chữ ăn giá trị (phần còn lại của cụm, không thì
    token kế), `--tên=v`/`--tên v` (tên bắt buộc giá trị), tên viết tắt, sau `--` và `-` là toán hạng."""
    short_val, longs, long_val, abbrev = table
    out: OptItems = []
    i = 0
    while i < len(args):
        a, i = args[i], i + 1
        if a == "--":
            return out + [("", x) for x in args[i:]]
        if a.startswith("--"):
            items, ate = _long_items(a, args[i:], long_val, _long_names(a[2:].partition("=")[0], longs, abbrev))
            out += items
            i += ate
        elif a.startswith("-") and len(a) > 1:
            flags, got, ate = _short_cluster(a, args[i : i + 1], short_val)
            out += [(f[1:], None) for f in flags[: len(flags) - len(got)]] + [(k[1:], v) for k, v in got]
            i += ate
        else:
            out.append(("", a))
    return out


def _opt_keys(items: OptItems) -> Set[str]:
    return {k for k, _ in items if k}


def _opt_vals(items: OptItems, *keys: str) -> List[str]:
    return [v for k, v in items if k in keys and v is not None]


def _operands(items: OptItems) -> List[str]:
    return [v for k, v in items if not k and v is not None]


def _old_style(args: List[str], short_val: str) -> List[str]:
    """Kiểu cũ của tar/jar (`xfC a d` = `-x -f a -C d`): chữ ăn giá trị lấy token kế theo thứ tự chữ."""
    if not args or not re.fullmatch(r"[A-Za-z0-9]+", args[0]):
        return args
    out, k = [], 1
    for ch in args[0]:
        out.append("-" + ch)
        if ch in short_val and k < len(args):
            out.append(args[k])
            k += 1
    return out + args[k:]


def _has_opt(flags: Set[str], opts: Set[str]) -> bool:
    longs = tuple(o for o in opts if o.startswith("--"))
    return any(f in opts or _long_match(f, longs) for f in flags)


RefNames = Optional[List[str]]  # tên ref lệnh sẽ ghi/tạo; None = không thấy được (đọc từ stdin)
REPLACE_REF_PREFIX = "refs/replace/"  # `git replace` đổi nội dung mọi lệnh git đọc (AUD-SEC-158)


def _update_ref_names(args: List[str], _cwd: Optional[str]) -> RefNames:
    """update-ref: ref là đối số vị trí đầu (cả `-d`); `--stdin` → None."""
    flags, pos, _ = _parse_opts(args, "m", ())
    return None if _has_opt(flags, {"--stdin"}) else pos[:1]


def _replace_names(args: List[str], _cwd: Optional[str]) -> RefNames:
    """replace: mọi dạng ghi `refs/replace/<đối tượng>` (`<obj> <thay>`, `-f`, `--graft`, `--edit`,
    `--convert-graft-file`); liệt kê (không đối số, `-l`/`--list`, `--format`) và xoá (`-d`) thì không (AUD-SEC-158)."""
    flags, pos, _ = _parse_opts(args, "", ())
    if _has_opt(flags, {"-d", "--delete", "-l", "--list"}) or not (pos or _has_opt(flags, {"--convert-graft-file"})):
        return []
    return [REPLACE_REF_PREFIX + (pos[0] if pos else "*")]


def _symbolic_ref_names(args: List[str], _cwd: Optional[str]) -> RefNames:
    """symbolic-ref: ghi khi có `<tên> <ref>` hoặc xoá (`-d`); một đối số = đọc."""
    flags, pos, _ = _parse_opts(args, "m", ())
    return pos[:1] if len(pos) > 1 or _has_opt(flags, {"-d", "--delete"}) else []


def _tag_names(args: List[str], _cwd: Optional[str]) -> RefNames:
    """tag: tên tag mới là đối số vị trí đầu, trừ chế độ liệt kê/xoá/kiểm (`-l`, `-d`, `-v`, `-n<số>`, `--contains`…)."""
    flags, pos, _ = _parse_opts(args, "mFu", TAG_VALUE_OPTS)
    return [] if _has_opt(flags, TAG_NO_CREATE) else pos[:1]


def _branch_names(args: List[str], _cwd: Optional[str]) -> RefNames:
    """branch: tạo (`[-f] <tên> [<điểm>]`) → đối số đầu; `-m/-M/-c/-C [<cũ>] <mới>` → đối số cuối; liệt kê/xoá/upstream
    → không tạo. `-v` có tên vẫn TẠO nhánh (đo trên git 2.43)."""
    flags, pos, _ = _parse_opts(args, "u", BRANCH_VALUE_OPTS)
    if _has_opt(flags, BRANCH_NO_CREATE):
        return []
    return pos[-1:] if _has_opt(flags, BRANCH_RENAME) else pos[:1]


def _new_branch_names(sub: str) -> Callable[[List[str], Optional[str]], RefNames]:
    """Tên nhánh mới là GIÁ TRỊ của cờ: `checkout -b|-B|--orphan`, `switch -c|-C|--create|--force-create|--orphan`,
    `worktree add -b|-B`."""
    short, longs = NEW_BRANCH_OPTS[sub]

    def names(args: List[str], _cwd: Optional[str]) -> RefNames:
        if sub == "worktree" and args[:1] != ["add"]:
            return []
        return [v for _, v in _parse_opts(args, short, longs)[2]]

    return names


def _stash_names(args: List[str], _cwd: Optional[str]) -> RefNames:
    """`stash branch <tên>` tạo nhánh."""
    return _positionals(args[1:2]) if args[:1] == ["branch"] else []


def _remote_names(args: List[str], _cwd: Optional[str]) -> RefNames:
    """remote: `set-head <r> <nhánh>` và `set-head <r> -d` ghi/xoá `refs/remotes/<r>/HEAD` — nhánh mặc định `perf trial`
    đọc khi ngoại tuyến (ADR-0071 §1, D-361); `set-head <r> -a` lấy từ máy chủ → cho qua. Lệnh con khác: giới hạn ở trên."""
    flags, pos, _ = _parse_opts(args, "", ())
    auto = _has_opt(flags, {"-a", "--auto"}) and not _has_opt(flags, {"-d", "--delete"})
    return [f"refs/remotes/{(pos + ['', ''])[1]}/HEAD"] if pos[:1] == ["set-head"] and not auto else []


def _push_names(args: List[str], _cwd: Optional[str]) -> RefNames:
    """push: đích của refspec (`src:dst`; không `:` thì đích = nguồn) — `push . HEAD:origin/main` ghi chính repo này."""
    return [r.split(":")[-1] for r in _push_refs(args)[1:]]


def _canonical_fetch(repo: str, spec: str, remotes: FrozenSet[str]) -> bool:
    """Refspec đúng dạng cấu hình mặc định `[+]refs/heads/X:refs/remotes/<repo>/X` của remote ĐÃ cấu hình."""
    src, _, dst = spec.lstrip("+").partition(":")
    head = re.fullmatch(r"refs/heads/(.+)", src)
    return head is not None and repo in remotes and dst == f"refs/remotes/{repo}/{head.group(1)}"


def _fetch_names(args: List[str], cwd: Optional[str]) -> RefNames:
    """fetch/pull: đích của refspec tường minh (kể cả `--refmap`), trừ dạng cấu hình của remote đã cấu hình; `--stdin`
    → None. `fetch origin main` (không `:`) không có đích tường minh."""
    flags, pos, vals = _parse_opts(args, "joXs", FETCH_VALUE_OPTS)
    if _has_opt(flags, {"--stdin"}):
        return None
    specs = [s for s in pos[1:] + [v for k, v in vals if _long_match(k, ("--refmap",))] if ":" in s]
    remotes = _configured_remotes(cwd) if specs else frozenset()
    repo = pos[0] if pos else ""
    return [s.split(":", 1)[1] for s in specs if not _canonical_fetch(repo, s, remotes)]


def _configured_remotes(cwd: Optional[str]) -> FrozenSet[str]:
    """Remote đã cấu hình ở repo `cwd` (`git remote`); lỗi/quá hạn/không phải repo → rỗng."""
    try:
        r = subprocess.run(["git", "-C", cwd or ".", "remote"], capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return frozenset()
    return frozenset(r.stdout.split()) if r.returncode == 0 else frozenset()


def _short_ref(ref: str) -> Tuple[bool, str]:
    """(dưới `refs/remotes/`, tên ngắn git so khi giải `<remote>/<nhánh>`) — bỏ `+`, `//`, `./`, `refs/`, `refs/heads/`,
    `refs/tags/`; chữ thường."""
    parts = [p for p in ref.lstrip("+").casefold().split("/") if p not in ("", ".")]
    if parts[:2] == ["refs", "remotes"]:
        return True, ""
    if parts[:1] == ["refs"]:
        parts = parts[2:] if parts[1:2] in (["heads"], ["tags"]) else parts[1:]
    return False, "/".join(parts)


def _remote_ref_hit(names: List[str], cwd: Optional[str]) -> str:
    """Tên đầu tiên là ref theo dõi remote hoặc trùng `<remote>/…`; rỗng nếu không. `git remote` chỉ chạy khi cần."""
    replaced = next((x for x in names if x.lstrip("+").startswith(REPLACE_REF_PREFIX)), "")
    if replaced:  # thay đối tượng mà Gate/`pr debt` đọc — cùng hiệu ứng giả `origin/main` (AUD-SEC-158)
        return replaced
    shorts = [(x, *_short_ref(x)) for x in names]
    hit = next((x for x, remote, _ in shorts if remote), "")
    if hit or not any("/" in s for _, _, s in shorts):
        return hit
    remotes = {r.casefold() + "/" for r in REMOTE_NAMES | _configured_remotes(cwd)}
    return next((x for x, _, s in shorts if any(s.startswith(r) for r in remotes)), "")


REMOTE_REF_NAMES: Dict[str, Callable[[List[str], Optional[str]], RefNames]] = {
    "update-ref": _update_ref_names,
    "replace": _replace_names,
    "symbolic-ref": _symbolic_ref_names,
    "tag": _tag_names,
    "branch": _branch_names,
    "checkout": _new_branch_names("checkout"),
    "switch": _new_branch_names("switch"),
    "worktree": _new_branch_names("worktree"),
    "stash": _stash_names,
    "fetch": _fetch_names,
    "pull": _fetch_names,
    "push": _push_names,
    "remote": _remote_names,
}
# Lệnh con git mà `_scan_command` giải repo thật (`git -C`, `cd`): commit (cổng), push (nhánh hiện tại), ghi ref (remote),
# config (đặt alias ghi ref — tên remote của repo đó).
GIT_DIR_SUBS = {"commit", "config", *REMOTE_REF_NAMES}


def _remote_ref_rule(sub: str, args: List[str], cwd: Optional[str]) -> Tuple[str, str]:
    """AUD-SEC-119: deny khi lệnh git ghi ref theo dõi remote hoặc tạo ref trùng tên remote; ref từ stdin hay là file mà
    `find -exec … {}` tìm thấy (`find refs/remotes -exec git update-ref {} HEAD`) → hỏi (unsure)."""
    names = REMOTE_REF_NAMES[sub](args, cwd)
    if names is None:
        return "ask", UNRESOLVED_ARGS_WHY.format(sub, "--stdin")
    if any(FIND_FOUND in x for x in names):
        return "ask", UNRESOLVED_ARGS_WHY.format(sub, "đối số `{}` của find -exec")
    hit = _remote_ref_hit(names, cwd)
    return ("deny", REMOTE_REF_WHY.format(hit) + _fetch_hint(sub, hit)) if hit else ("", "")


def _fetch_hint(sub: str, hit: str) -> str:
    """Gợi ý dạng được cho qua khi chặn refspec của fetch/pull (`main:refs/remotes/origin/main` → nguồn đầy đủ)."""
    if sub not in ("fetch", "pull"):
        return ""
    m = re.fullmatch(r"refs/remotes/([^/]+)/(.+)", hit.lstrip("+"))
    spec = f"refs/heads/{m.group(2)}:refs/remotes/{m.group(1)}/{m.group(2)}" if m else ""
    spec = spec or "refs/heads/<nhánh>:refs/remotes/<remote>/<nhánh>"
    return f"; dạng được cho qua: `git {sub} <remote đã cấu hình> {spec}`"


# D-366 (review #442 🔴, AUD-SEC-523): `perf trial` lấy gốc vòng từ máy chủ `origin` (`ls-remote`) và, ngoại tuyến, từ
# `refs/remotes/origin/HEAD` — đổi NƠI ref theo dõi remote đến từ là giả gốc vòng như ghi thẳng ref. Chặn (deny, mọi pha):
# `remote set-url|set-branches` (mọi remote), `remote add|rename|remove|rm` đụng `origin`; `git config` ghi/xoá khoá
# `remote.<r>.url|pushurl|fetch`, `url.<x>.insteadOf|pushInsteadOf` (mọi phạm vi/tệp), xoá/đổi tên section `remote.*`/
# `url.*`; cùng khoá đặt một lần (`git -c`, `--config-env`, `GIT_CONFIG_KEY_<i>`/`GIT_CONFIG_PARAMETERS` gán cho BẤT KỲ
# lệnh nào — `GIT_CONFIG_COUNT=1 … python3 xt.py perf trial start`). Ghi thẳng `.git/packed-refs`, `.git/refs/remotes/**`
# theo luật tệp metadata Git (GIT_HOOK_PATTERNS). Cho qua: đọc (`remote -v`, `config --get remote.origin.url`), `fetch`.
# Giới hạn còn lại (ADR-0071 §1): cùng uid sửa file trong `.git` ngoài mọi kênh guard thấy — lớp hai là sandbox (ADR-0067).
REMOTE_CFG_KEY_RE = re.compile(r"remote\..+\.(?:url|pushurl|fetch)|url\..+\.(?:insteadof|pushinsteadof)", re.I | re.S)
REMOTE_CFG_WHY = (
    REMOTE_REF_MARK + " gián tiếp: đổi URL/refspec/insteadOf của remote ({}) — gốc vòng `perf trial` (D-366)"
)
REMOTE_CFG_SECTIONS = ("--remove-section", "--rename-section")


def _remote_cmd_hit(args: List[str]) -> str:
    """`git remote …`: `set-url`/`set-branches` (mọi remote); `add|rename|remove|rm` khi tên (cũ hay mới) là `origin`."""
    _, pos, _ = _parse_opts(args, "tm", ("--track", "--master"))
    sub, names = (pos + [""])[0], [p.casefold() for p in pos[1:3]]
    if sub in ("set-url", "set-branches") or (sub in ("add", "rename", "remove", "rm") and "origin" in names):
        return f"git remote {sub}"
    return ""


def _remote_cfg_write(n: List[str]) -> str:
    """`git config` ghi/xoá khoá remote (REMOTE_CFG_KEY_RE) hay xoá/đổi tên section `remote.*`/`url.*`; rỗng nếu không."""
    names = _positionals(n[2:], GIT_CONFIG_VALUE_OPTS)
    sections = any(_long_match(a.partition("=")[0], REMOTE_CFG_SECTIONS) for a in n[2:] if a.startswith("--"))
    if sections or names[:1] in (["remove-section"], ["rename-section"]):
        hit = [a for a in names if a.split(".", 1)[0].lower() in ("remote", "url")]
        return hit[0] if hit else ""
    pos = _git_config_write(n)
    write = len(pos) > 1 or bool(set(n) & GIT_CONFIG_UNSET)
    return pos[0] if pos and write and REMOTE_CFG_KEY_RE.fullmatch(pos[0]) else ""


def _remote_cfg_rule(n: List[str]) -> Tuple[str, str]:
    """Luật lệnh con (`git_rules`): đổi URL/refspec/insteadOf của remote → deny (D-366)."""
    hit = _remote_cmd_hit(n[2:]) if n[1] == "remote" else _remote_cfg_write(n) if n[1] == "config" else ""
    return ("deny", REMOTE_CFG_WHY.format(hit)) if hit else ("", "")


def remote_config_oneshot(argv: List[str], n: List[str], exported: Optional[Dict[str, str]] = None) -> Tuple[str, str]:
    """Khoá remote đặt một lần cho lệnh `argv` (`git -c`, `--config-env`, `GIT_CONFIG_*` gán đầu lệnh hay `export` trước
    đó) — mọi lệnh, không chỉ git (`xt.py` gọi git kế thừa môi trường) → deny."""
    pairs = _git_oneshot_config(argv, exported) if n[:1] == ["git"] else _oneshot_env_pairs(argv, exported)[1]
    hit = next((k for k, _ in pairs if REMOTE_CFG_KEY_RE.fullmatch(k.strip())), "")
    return ("deny", REMOTE_CFG_WHY.format(f"cấu hình một lần `{hit}`")) if hit else ("", "")


# Alias git (AUD-SEC-119, review T-3563, review #306): `git -c alias.x=update-ref x refs/remotes/origin/main HEAD` chạy
# `update-ref` dưới tên khác. Guard mở alias như git (git.c `run_argv` + alias.c `alias_lookup`, đo trên git 2.43): lệnh
# con dựng sẵn KHÔNG BAO GIỜ là alias; MỌI tên khác — bất kể hình dạng (`a.b`, `y_x.z`, `1.x`) — đều được tra. Bảng
# alias do CHÍNH git dựng (`_git_alias_table`): `git -C <repo> [-c/--config-env/--git-dir/--bare của lệnh, giữ thứ tự]
# config --list -z` với môi trường của guard ghi đè bởi biến cấu hình của lệnh (ALIAS_ENV_RE + biến mà `--config-env`
# trỏ tới; gán đầu lệnh ∪ `export` trước đó) — `GIT_CONFIG_COUNT` (git bỏ `KEY_<i>` với i ≥ COUNT, bỏ hết khi thiếu
# COUNT), include/includeIf, thứ tự ưu tiên đều do git xử lý. Tên so như alias.c: cả phần sau `alias.` so strcasecmp
# (subsection `alias.A.B` gọi bằng `git a.b`), mục sau thắng; mục không giá trị bị bỏ qua (git dừng — chiều chặt). Thay
# vào, lặp tới lệnh dựng sẵn rồi xét bản viết lại như lệnh thật; alias `!` là shell → quét như shell lồng. `git config
# --list` chỉ đọc tệp: không chạy fsmonitor/pager/hook/credential/textconv (test đối chứng với git thật); khoá chạy lệnh
# đặt một lần qua mọi kênh là HOOK_BYPASS (`_git_exec_config`). Không giải được (đọc lỗi/quá hạn/hết ngân sách TỔNG
# ALIAS_SECONDS của cả quyết định, khoá hay giá trị đổi bảng alias là biến/thay lệnh, alias vòng hay sâu quá
# ALIAS_MAX_DEPTH, lệnh con là file `find` tìm thấy) → UNRESOLVED_TARGET (strict hỏi, mặc định chặn). Đặt alias trỏ
# `update-ref`, `symbolic-ref` trần hay giá trị đã đủ đối số ghi ref remote (`git config alias.f 'fetch .
# HEAD:refs/remotes/origin/main'`) → chặn lúc đặt; `tag`/`branch`/`fetch` trần thì chỉ xét được lúc dùng. Danh sách lệnh
# dựng sẵn: `git --list-cmds=builtins` của git 2.43, đóng — lệnh dựng sẵn của git mới hơn mà danh sách thiếu vẫn bị tra
# alias (chiều chặt); `git-<tên>` trong PATH được git chạy trước alias, guard vẫn tra alias (chiều chặt).
GIT_BUILTINS = frozenset(
    """add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap
    check-ref-format checkout checkout--worker checkout-index cherry cherry-pick clean clone column commit commit-graph
    commit-tree config count-objects credential credential-cache credential-cache--daemon credential-store describe
    diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack fmt-merge-msg
    for-each-ref for-each-repo format-patch fsck fsck-objects fsmonitor--daemon gc get-tar-commit-id grep hash-object help
    hook index-pack init init-db interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge
    merge-base merge-file merge-index merge-ours merge-recursive merge-recursive-ours merge-recursive-theirs merge-subtree
    merge-tree mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id pickaxe prune
    prune-packed pull push range-diff read-tree rebase receive-pack reflog remote remote-ext remote-fd repack replace
    rerere reset restore rev-list rev-parse revert rm send-pack shortlog show show-branch show-index show-ref
    sparse-checkout stage stash status stripspace submodule--helper switch symbolic-ref tag unpack-file unpack-objects
    update-index update-ref update-server-info upload-archive upload-archive--writer upload-pack var verify-commit
    verify-pack verify-tag version whatchanged worktree write-tree""".split()
)
ALIAS_MAX_DEPTH = 8  # số tầng alias lồng tối đa (git tự dừng ở vòng; guard không dựa vào đó)
ALIAS_SECONDS = (
    5.0  # ngân sách thời gian TỔNG của mọi lần đọc bảng alias trong MỘT quyết định (cả lệnh lồng, find -exec)
)
# Biến của lệnh mà git dùng khi dựng cấu hình — đi cùng lần đọc bảng alias (`GIT_CONFIG` thì chỉ `git config` đọc: bỏ).
ALIAS_ENV_RE = re.compile(
    r"GIT_CONFIG_(?:COUNT|PARAMETERS|GLOBAL|SYSTEM|NOSYSTEM|KEY_\d+|VALUE_\d+)|HOME|XDG_CONFIG_HOME|GIT_DIR"
)
ALIAS_TABLE_KEY_RE = re.compile(r"(?:alias|include|includeif)\..*", re.I | re.S)  # khoá mà giá trị đổi bảng alias
UNRESOLVED_ALIAS_MARK = "alias git guard không giải được"  # dấu của UNRESOLVED_TARGET
UNKNOWN_GIT_OPT_MARK = "tuỳ chọn toàn cục git guard không biết"  # dấu của UNRESOLVED_TARGET (D-216)
SHELL_EXPANDS = set("$`")  # giá trị còn biến/thay lệnh: guard không biết giá trị thật
AliasTable = List[Tuple[str, Optional[str]]]  # (tên sau `alias.`, giá trị; None = không giá trị) theo thứ tự git đọc
AliasRead = Tuple[List[str], Dict[str, str]]  # (tuỳ chọn toàn cục cho `git config`, biến ghi đè môi trường)


def _git_globals(s: List[str]) -> List[Tuple[str, str]]:
    """Tuỳ chọn toàn cục của lệnh git `s` (đã bỏ tiền tố) dạng (tên, giá trị): `-c k=v`, `-ck=v`, `--opt v`, `--opt=v`."""
    out: List[Tuple[str, str]] = []
    i = 1
    while i < len(s) and s[i].startswith("-"):
        a = s[i]
        i += 1
        opt, eq, val = a.partition("=") if a.startswith("--") else (a[:2], "", a[2:])
        if opt in GIT_OPTS_WITH_VALUE and not eq and not val and i < len(s):
            val, i = s[i], i + 1
        # `--exec-path` in giá trị rồi thoát. `--exec-path=` đặt lại đường dẫn, kể cả với giá trị rỗng.
        out.append((opt + eq if opt == "--exec-path" else opt, val))
    return out


def _git_unknown_global(s: List[str]) -> str:
    """Tuỳ chọn toàn cục `--…` đầu tiên của lệnh git `s` (đã bỏ tiền tố) mà guard không biết (ngoài GIT_LONG_FLAGS,
    GIT_OPTS_WITH_VALUE, dạng `=` của GIT_LONG_OPTS_EQ); rỗng nếu không. Không biết nó có ăn token kế không thì cũng
    không biết lệnh con là gì (D-216)."""
    i = 1
    while i < len(s) and s[i].startswith("-"):
        a = s[i]
        known = (
            a in GIT_LONG_FLAGS or a in GIT_OPTS_WITH_VALUE or ("=" in a and a.partition("=")[0] in GIT_LONG_OPTS_EQ)
        )
        if a.startswith("--") and not known:
            return a
        i += 2 if a in GIT_OPTS_WITH_VALUE else 1
    return ""


def _unknown_git_opt_asks(n: List[str], argv: List[str]) -> List[str]:
    """Câu hỏi UNRESOLVED_TARGET khi lệnh git có tuỳ chọn toàn cục guard không biết (D-216, fail-closed)."""
    unknown = _git_unknown_global(_strip_prefixes(argv)) if n[:1] == ["git"] else ""
    return [f"{UNKNOWN_GIT_OPT_MARK} (`{unknown}`) — không biết lệnh con: {' '.join(argv)[:200]}"] if unknown else []


def _expands(text: str) -> bool:
    return bool(SHELL_EXPANDS & set(text))


def _alias_read_args(s: List[str], env: Dict[str, str]) -> Optional[AliasRead]:
    """Đầu vào để git dựng bảng alias như lệnh git `s` (đã bỏ tiền tố) sẽ thấy: tuỳ chọn `-c`/`--config-env`/
    `--git-dir`/`--bare` (giữ thứ tự) và biến ALIAS_ENV_RE của lệnh (`env`) cùng biến mà `--config-env` trỏ tới. None =
    khoá, giá trị của khoá đổi bảng alias (ALIAS_TABLE_KEY_RE), biến chọn tệp/COUNT/PARAMETERS hay `--git-dir` là
    biến/thay lệnh — guard không biết git sẽ thấy gì."""
    over = {k: v for k, v in env.items() if ALIAS_ENV_RE.fullmatch(k)}
    opts: List[str] = []
    pairs: List[Tuple[str, str]] = []
    literal: List[str] = []  # tên biến của `--config-env`, đường dẫn `--git-dir`: phải là chữ
    for opt, val in _git_globals(s):
        key, _, v = val.partition("=")
        if opt == "-c":
            opts += ["-c", val]
            pairs.append((key, v))
        elif opt == "--config-env":
            opts.append("--config-env=" + val)
            over.update((name, env[name]) for name in [v] if name in env)
            pairs.append((key, over.get(v, "")))
            literal.append(v)
        elif opt in ("--git-dir", "--bare"):
            opts.append(f"--git-dir={val}" if opt == "--git-dir" else opt)
            literal.append(val)
    unknown = any(_expands(k) or (_expands(v) and ALIAS_TABLE_KEY_RE.fullmatch(k)) for k, v in pairs)
    return None if unknown or _env_unknown(over) or any(map(_expands, literal)) else (opts, over)


def _env_unknown(over: Dict[str, str]) -> bool:
    """Biến cấu hình của lệnh có giá trị là biến/thay lệnh — trừ `GIT_CONFIG_VALUE_<i>` của khoá chữ không đổi bảng
    alias (`http.extraHeader="X: $T"`: git đọc nguyên chữ, bảng alias không đổi)."""
    for name, v in over.items():
        idx = name[17:] if name.startswith("GIT_CONFIG_VALUE_") else ""
        key = over.get("GIT_CONFIG_KEY_" + idx, os.environ.get("GIT_CONFIG_KEY_" + idx, "")) if idx else ""
        if _expands(v) and not (key and not _expands(key) and not ALIAS_TABLE_KEY_RE.fullmatch(key)):
            return True
    return False


def _existing_dir(d: str) -> str:
    """Thư mục cha gần nhất đã có (`mkdir x && cd x && git …`: lúc guard xét, `x` chưa có)."""
    while not os.path.isdir(d) and posixpath.dirname(d) != d:
        d = posixpath.dirname(d)
    return d


def _alias_entries(raw: bytes) -> AliasTable:
    """Mục `alias.*` của `git config --list -z` (`khoá<LF>giá trị<NUL>`; không giá trị: `khoá<NUL>`), theo thứ tự."""
    out: AliasTable = []
    for item in raw.decode("utf-8", "surrogateescape").split("\0"):
        key, nl, val = item.partition("\n")
        if key[:6].lower() == "alias.":
            out.append((key[6:], val if nl else None))
    return out


def _git_alias_table(
    gdir: str, opts: List[str], over: Dict[str, str], budget: Optional["ScanBudget"]
) -> Optional[AliasTable]:
    """Bảng alias mà git dựng cho lệnh: `git --no-pager -C <gdir> <opts> config --list -z` (stdin rỗng) với môi trường
    của guard ghi đè bởi `over`. None = đọc lỗi/quá hạn/hết ngân sách (fail-closed: UNRESOLVED_TARGET). Thời hạn là phần
    còn lại của ngân sách TỔNG của quyết định (`budget.alias`); cùng đầu vào chỉ đọc một lần. `git config` chỉ đọc tệp,
    không chạy chương trình cấu hình."""
    clock = budget.alias if budget else AliasClock()
    cmd = ["git", "--no-pager", "-C", _existing_dir(gdir), *opts, "config", "--list", "-z"]
    key = (tuple(cmd), tuple(sorted(over.items())))
    left = clock.deadline - time.monotonic()
    if key not in clock.cache and left <= 0:
        return None  # hết ngân sách tổng: không gọi git nữa
    if key not in clock.cache:
        env = {**{k: v for k, v in os.environ.items() if k != "GIT_CONFIG"}, **over}
        try:
            r = subprocess.run(cmd, capture_output=True, stdin=subprocess.DEVNULL, timeout=left, check=False, env=env)
            clock.cache[key] = _alias_entries(r.stdout) if r.returncode == 0 else None
        except (OSError, ValueError, subprocess.SubprocessError):
            clock.cache[key] = None
    return clock.cache[key]


class AliasClock:
    """Ngân sách TỔNG đọc bảng alias của một quyết định (ALIAS_SECONDS): hạn chót chung và bảng đã đọc theo đầu vào."""

    def __init__(self) -> None:
        self.deadline = time.monotonic() + ALIAS_SECONDS
        self.cache: Dict[Tuple[Tuple[str, ...], Tuple[Tuple[str, str], ...]], Optional[AliasTable]] = {}


def _ascii_fold(text: str) -> bytes:
    """Khoá so tên alias như strcasecmp của git: chỉ A–Z thành chữ thường (bytes.lower), byte khác giữ nguyên."""
    return text.encode("utf-8", "surrogateescape").lower()


def _alias_value(table: AliasTable, name: str) -> str:
    """Giá trị alias `name` trong bảng (mục sau thắng, bỏ mục không giá trị); "" = không phải alias."""
    want = _ascii_fold(name)
    vals = [v for k, v in table if v is not None and _ascii_fold(k) == want]
    return vals[-1] if vals else ""


def _git_alias_expand(n: List[str], table: AliasTable) -> Tuple[str, List[str]]:
    """Mở chuỗi alias của lệnh git `n` (đã chuẩn hoá) theo bảng git dựng: ("git", argv thật) · ("shell", [script,
    đối số…]) cho alias `!` · ("unresolved", [lý do]) · ("", []) khi lệnh con không phải alias."""
    seen: List[bytes] = []
    names: List[str] = []
    while len(n) > 1 and n[1] and not n[1].startswith("-") and n[1] not in GIT_BUILTINS:
        fold = _ascii_fold(n[1])
        if fold in seen or len(seen) >= ALIAS_MAX_DEPTH:
            return "unresolved", [f"alias vòng hoặc lồng quá {ALIAS_MAX_DEPTH} tầng: {' → '.join([*names, n[1]])}"]
        val = _alias_value(table, n[1])
        if not val:
            break
        seen.append(fold)
        names.append(n[1])
        if val.startswith("!"):
            return "shell", [val[1:], *n[2:]]
        n = _strip_git_global_opts(["git", *_split_words(val), *n[2:]])
    return ("git", n) if seen else ("", [])


def _alias_def_rule(n: List[str], cwd: Optional[str]) -> Tuple[str, str]:
    """`git config [set|--add|--global…] alias.<tên> <giá trị>` trỏ lệnh ghi ref: `update-ref`, `symbolic-ref` chưa có
    đối số vị trí, hay giá trị đã đủ đối số ghi ref remote → deny. Alias `!` thuộc luật hook (`_git_exec_config`)."""
    pos = _git_config_write(n)
    if len(pos) < 2 or not pos[0].casefold().startswith("alias."):
        return "", ""
    m = _strip_git_global_opts(["git", *_split_words(pos[1])])
    sub, args = (m + [""])[1], m[2:]
    if sub == "update-ref" or (sub == "symbolic-ref" and not _positionals(args)):
        return "deny", REMOTE_REF_WHY.format(f"alias `{pos[0]}` = `{pos[1]}`")
    return _remote_ref_rule(sub, args, cwd) if sub in REMOTE_REF_NAMES else ("", "")


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
    """Luật theo lệnh con của git (bảng GIT_RULES; `push` riêng vì cần thư mục để biết nhánh hiện tại); không có luật → cho qua.
    Ghi ref remote/tạo ref trùng tên remote, đặt alias trỏ lệnh ghi ref (AUD-SEC-119) xét trước, `cwd` để đọc tên remote
    của repo. Lệnh con là alias được mở ở `_git_alias_sources` (bản viết lại quét như lệnh thật)."""
    if len(n) < 2:
        return "", ""
    args = [_git_long(a) for a in n[2:]]
    forged = _remote_ref_rule(n[1], args, cwd) if n[1] in REMOTE_REF_NAMES else _alias_def_rule(n, cwd)
    if forged[0]:
        return forged
    moved = _remote_cfg_rule([*n[:2], *args])  # D-366: đổi URL/refspec/insteadOf của remote
    if moved[0]:
        return moved
    if n[1] == "push":  # AUD-SEC-102: `git push origin 2>&1` trên nhánh chính — chuyển hướng không phải refspec
        return _stricter(_git_push(args, cwd), _git_push(_drop_redirects(args), cwd))
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
# Subject commit squash tường minh (`gh pr merge -t/--subject`, REST/MCP `commit_title`) đè thiết lập repo
# `squash_merge_commit_title: PR_TITLE` — subject dài/sai dạng lên nhánh chính (AUD-HAR-126/128, D-255) → deny phẳng.
SQUASH_SUBJECT_WHY = (
    "đặt subject commit merge tường minh (`--subject`/`-t`/`commit_title`) — subject = tiêu đề PR do thiết lập repo "
    "`squash_merge_commit_title: PR_TITLE` (D-254/D-255): bỏ cờ/khoá đó; sửa tiêu đề bằng `gh pr edit <N> --title …`"
)
# Cờ của `gh pr merge` ăn thêm một token giá trị — không bóc thì giá trị bị hiểu là số PR.
GH_MERGE_VALUE_FLAGS: Tuple[str, ...] = (
    *("--match-head-commit", "-b", "--body", "-F", "--body-file", "-t", "--subject"),
    *("-A", "--author-email", "-R", "--repo"),
)
# `-t` của `gh pr merge`, kể cả gộp sau cờ bool ngắn `-s/-m/-r/-d` (pflag: `-st x`, `-dtx` — review #343).
GH_MERGE_SUBJECT_RE = re.compile(r"-[smrd]*t")
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


# Bộ nạp của `py_run` (_lib.sh — giữ GIỐNG HỆT, test so): chạy `main()` của file .py như module, `-I -B` (AUD-SEC-065),
# biên dịch từ nguồn mỗi lần — pyc giả khớp header vẫn chạy thay guard (AUD-SEC-074, #182).
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


ADMIN_MERGE_WHY = "gh pr merge --admin vượt ruleset nhánh — máy không dùng, người merge trên GitHub"


def _gh_admin_flag(args: List[str]) -> bool:
    """`--admin` vượt ruleset (lớp đỡ CI) — chặn ở mọi chính sách (T-3532)."""
    return any(a == "--admin" or a.startswith("--admin=") for a in args)


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
    if _gh_admin_flag(args):
        return "deny", ADMIN_MERGE_WHY
    if _merge_subject_flag(args):
        return "deny", SQUASH_SUBJECT_WHY
    sha = _flag_value(args, "--match-head-commit")
    if sum(a == "--match-head-commit" or a.startswith("--match-head-commit=") for a in args) > 1:
        sha = None  # gh lấy lần cuối, guard đã kiểm lần đầu — hai pin là không pin
    flags = sorted({a.split("=", 1)[0] for a in args if a.startswith("-")} - MERGE_ALLOW_FLAGS)
    if not sha or flags or repo:
        why = "tự merge cần `--match-head-commit <sha>` từ `xt.py merge-check`, chỉ cờ"
        return _merge_ask(f"{EXTERNAL_ASK} — {why} {', '.join(sorted(MERGE_ALLOW_FLAGS))}", selector, root, repo)
    return _merge_verdict(selector, sha, root)


def _merge_subject_flag(args: List[str]) -> bool:
    """`gh pr merge` có `-t`/`--subject` (cả `--subject=x`, `-tx`, `-st'x'` kiểu pflag) — subject squash tường minh; giá
    trị của cờ khác (`-b "-t x"`) không tính."""
    skip = False
    for a in args:
        if not skip and (a == "--subject" or a.startswith("--subject=") or GH_MERGE_SUBJECT_RE.match(a)):
            return True
        skip = not skip and a in GH_MERGE_VALUE_FLAGS
    return False


def _rm_rule(args: List[str], root: str = "", cwd: Optional[str] = None) -> Tuple[str, str]:
    """rm: deny --no-preserve-root và rm -rf trên đích nguy hiểm (gốc, home, cwd, glob, thư mục `.git`); xoá đệ quy
    ra ngoài gốc dự án (trừ thư mục tạm) → ask (xoá dữ liệu là điểm dừng bắt buộc — stored 01 §3c: `rm -rf ~/x`)."""
    flags = _short_flags(args)
    recursive = "r" in flags or "R" in flags or "--recursive" in args
    force = "f" in flags or "--force" in args
    targets = _positionals(args)
    # Luật đích cố định xét trước: `rm -rf ~` giữ mã RULE_DENY dù $HOME là cha của gốc (runner CI, ~/projects/x)
    if "--no-preserve-root" in args or (recursive and force and any(_dangerous_rm_target(t) for t in targets)):
        return "deny", "rm -rf trên /, ~, $HOME, ., .., *, .git"
    hit = next((t for t in targets if recursive and _wipes_root(t, root, cwd)), "")
    if hit:  # cả `rm -r` không `-f`: vẫn xoá hết cây (chỉ hỏi file chỉ-đọc)
        return "deny", ROOT_WIPE_WHY.format(hit)
    if recursive and force and not targets:  # `xargs rm -rf`, `… | xargs rm -rf`: đích đến từ stdin (AUD-SEC-024)
        return "ask", "rm -rf không có đích trên dòng lệnh (đích từ xargs/stdin) — xoá dữ liệu cần người duyệt"
    outside = [t for t in targets if recursive and root and _outside_project(t, root, cwd)]
    own = _own_worktrees(root, cwd) if outside else set()
    outside = [t for t in outside if _real_target(t, root, cwd) not in own]
    if outside:
        return "ask", f"xoá đệ quy ngoài thư mục dự án ({outside[0]}) — xoá dữ liệu cần người duyệt"
    return "", ""


TEMP_DIRS = ("/tmp", "/var/tmp", "/private/tmp", "/private/var/folders")
ROOT_WIPE_WHY = "xoá đệ quy gốc dự án, thư mục cha hoặc .git của nó ({}) — mất cả dự án và lịch sử"


def _wipes_root(target: str, root: str, cwd: Optional[str]) -> bool:
    """T-2501: đích là gốc dự án, `gốc/*`, `gốc/.git` hay thư mục cha của gốc (`ROOT/..`, `cd .. && rm -rf <gốc>`) —
    kể cả khi gốc nằm trong thư mục tạm. Đích không mở được (biến lạ, `$OLDPWD`) → False: luật khác xét."""
    if not root or OLDPWD_REF_RE.match(target):
        return False
    t = _resolve_target(HOME_REF_RE.sub("~", target), root, cwd)
    if "$" in t or "`" in t:
        return False
    parts = t.split("/")
    k = next((i for i, c in enumerate(parts) if GLOB_RE.search(c)), -1)
    if k >= 0:
        base = "/".join(parts[:k]) or ("/" if t.startswith("/") else ".")
        return _glob_wipes_root(_real_target(base, root, cwd), parts[k], any(parts[k + 1 :]), root)
    p = _real_target(t, root, cwd)
    r = os.path.realpath(root)
    return p == r or (p + "/").startswith(r + "/.git/") or r.startswith(p.rstrip("/") + "/")


GLOB_RE = re.compile(r"[*?\[]")
HOME_REF_RE = re.compile(r"^(\$HOME|\$\{HOME\})(?=/|$)")


def _glob_wipes_root(base: str, pat: str, deeper: bool, root: str) -> bool:
    """Glob `pat` ở thư mục `base` (review 5ef1a14 B2): `base` là gốc → khớp được `.git` (`*`, `.*`, `.g*`, `?*`; có phần
    sau thì chỉ khi chủ ý nhắm `.`); `base` là cha của gốc → khớp tên thư mục dẫn tới gốc."""
    r = os.path.realpath(root)
    if (base + "/").startswith(r + "/.git/"):  # mọi glob dưới `gốc/.git/` (review bb606aa)
        return True
    if base == r:
        return fnmatch.fnmatchcase(".git", pat) and (not deeper or pat.startswith("."))
    under = r.startswith(base.rstrip("/") + "/")
    return under and fnmatch.fnmatchcase(r[len(base.rstrip("/")) + 1 :].split("/")[0], pat)


def _real_target(t: str, root: str, cwd: Optional[str]) -> str:
    return os.path.realpath(os.path.join(cwd or root, os.path.expanduser(_resolve_target(t, root, cwd))))


def _own_worktrees(root: str, cwd: Optional[str]) -> Set[str]:
    """T-2502: worktree phụ đã đăng ký của repo (`git worktree list`) — bỏ gốc chính (dòng đầu) và worktree chứa thư
    mục đang đứng; xoá chúng không mất gì ngoài cây làm việc. Đọc lỗi/hết giờ → rỗng (chặn như cũ)."""
    try:
        r = subprocess.run(
            ["git", "-C", root, "worktree", "list", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    paths = [os.path.realpath(x[9:]) for x in r.stdout.splitlines() if x.startswith("worktree ")]
    here = os.path.realpath(cwd or root)
    return {p for p in paths[1:] if not (here + "/").startswith(p + "/")} if r.returncode == 0 else set()


def _outside_project(target: str, root: str, cwd: Optional[str]) -> bool:
    """Đích (đã mở `~`/`$HOME`, `$PWD`/`~+` = thư mục đang đứng) nằm ngoài gốc dự án và ngoài thư mục tạm; `~-`/
    `$OLDPWD` (thư mục trước, không biết) → True (fail-closed, AUD-SEC-099); biến khác/không rõ → False (fail-open)."""
    if OLDPWD_REF_RE.match(target):
        return True
    t = PWD_REF_RE.sub(".", HOME_REF_RE.sub("~", target))
    if "$" in t or "`" in t:
        return False
    p = os.path.realpath(os.path.join(cwd or root, os.path.expanduser(t)))
    inside = [os.path.realpath(root), *_temp_roots()]
    return not any(p == d or p.startswith(d.rstrip("/") + "/") for d in inside)


# Pha build (ADR-0040): hành động chỉ tác động trong dự án hoặc thư mục tạm cho chạy — vứt thay đổi git cục bộ, ghi file
# bí mật của dự án, `chmod 777`, `dd of=`. Pha có hiệu lực khi CẢ xt.yaml ở cây làm việc LẪN bản đã commit ở nhánh mặc
# định của remote đều `build` (như `merge-check`, ADR-0031: nhánh không tự chuyển sang build cho chính nó); không đọc
# được → harden. `XT_GUARD_POLICY=strict` không nới. Ngoài dự án/tmp, đối ngoại, hàng rào, bằng chứng: giữ nguyên.
PHASE_LINE_RE = re.compile(r"^delivery_phase:[ \t]*([\"']?)([A-Za-z]*)\1[ \t]*(?:#.*)?$", re.M)
DEFAULT_REFS = ("origin/HEAD", "origin/main", "origin/master")
LOCAL_GIT = {"reset", "clean", "checkout", "switch", "restore", "stash"}
# Git dời cây/repo/index/hook ra ngoài cwd: tuỳ chọn toàn cục, khoá cấu hình, mọi biến `GIT_*=` (`GIT_INDEX_FILE=/etc/x`
# làm `reset --hard` ghi đè file đó qua `.lock` — review #214).
GIT_TREE_MOVER_RE = re.compile(
    r"^--(?:git-dir|work-tree|super-prefix|exec-path|namespace)|core\.(?:worktree|hookspath)|^GIT_[A-Z_]+=", re.I
)
_BUILD_PHASE: Dict[str, bool] = {}


def _phase_value(text: str) -> str:
    """Giá trị `delivery_phase` (dòng trùng → dòng cuối, như `yaml_scalar` của xt.py); vắng → rỗng."""
    found = PHASE_LINE_RE.findall(text)
    return str(found[-1][1]) if found else ""


def _committed_phase(xt: str) -> str:
    """`delivery_phase` của xt.yaml đã commit ở nhánh mặc định của remote (ref đầu tiên đọc được); không đọc được → rỗng."""
    return _committed_value(xt, _phase_value)


def _committed_value(xt: str, pick: Callable[[str], str], refs: Tuple[str, ...] = DEFAULT_REFS) -> str:
    """Giá trị `pick(text)` của xt.yaml đã commit ở nhánh mặc định của remote (ref đầu tiên đọc được trong `refs`); không
    đọc được → rỗng. `--no-replace-objects`: `.git/refs/replace/` agent ghi được không thay được blob (review harden)."""
    for ref in refs:
        try:
            r = subprocess.run(
                ["git", "--no-replace-objects", "-C", os.path.dirname(xt), "show", f"{ref}:./xt.yaml"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        if r.returncode == 0:
            return pick(r.stdout)
    return ""


XT_READ_MAX = 1 << 20


def _read_all(path: str) -> str:
    """File thường tới 1 MiB (dòng trùng cuối file thắng như xt.py — review #213; FIFO/thiết bị không đọc — review #214);
    lỗi → rỗng."""
    if not os.path.isfile(path):
        return ""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read(XT_READ_MAX + 1)
    except OSError:
        return ""
    return text if len(text) <= XT_READ_MAX else ""  # dài hơn trần → không biết dòng cuối → harden (review #214 lần 2)


def build_phase(root: str) -> bool:
    """Pha build có hiệu lực cho guard (ADR-0040); tính một lần mỗi tiến trình. `XT_GUARD_PHASE=harden` ép harden (chỉ
    chặt hơn — bộ test luật cũ dùng). Ref remote là ref cục bộ: chống nhầm lẫn, không chống agent cố ý sửa ref (D-015)."""
    if root not in _BUILD_PHASE:
        xt = _xt_yaml_for(root)
        _BUILD_PHASE[root] = (
            os.environ.get("XT_GUARD_POLICY") != "strict"
            and os.environ.get("XT_GUARD_PHASE") != "harden"
            and bool(xt)
            and _phase_value(_read_all(xt)) == "build"
            and _committed_phase(xt) == "build"
        )
    return _BUILD_PHASE[root]


# ADR-0069 (chủ dự án 2026-11-04, D-352): xt.yaml `stage_approval: agent` → agent được `xt.py stage approve` (tự nghiệm thu
# giai đoạn); như `delivery_phase`, chỉ có hiệu lực khi CẢ cây làm việc LẪN bản đã commit ở nhánh mặc định khai — phiên
# không tự cấp quyền cho mình. `init --adopt`, dạng mờ (`$(…)`, biến, glob, stdin) vẫn chặn; `XT_GUARD_POLICY=strict` không nới.
STAGE_APPROVAL_LINE_RE = re.compile(r"^stage_approval:[ \t]*([\"']?)([A-Za-z]*)\1[ \t]*(?:#.*)?$", re.M)
_STAGE_AGENT: Dict[str, bool] = {}


# Ref đọc khoá giai đoạn: KHÔNG `origin/HEAD` — `git remote set-head origin <nhánh agent đẩy>` lật được nó (review harden
# PLAN-harden-2026-11-05 F2); đổi refspec/URL của remote rồi fetch vẫn là giới hạn đã biết (D-015).
STAGE_REFS = ("origin/main", "origin/master")


def _stage_approval_value(text: str) -> str:
    """Giá trị `stage_approval` (dòng trùng → dòng cuối, như `yaml_scalar` của xt.py); vắng → rỗng."""
    found = STAGE_APPROVAL_LINE_RE.findall(text)
    return str(found[-1][1]) if found else ""


def agent_stage_approval(root: str) -> bool:
    """Agent được duyệt giai đoạn (ADR-0069); tính một lần mỗi tiến trình."""
    if root not in _STAGE_AGENT:
        xt = _xt_yaml_for(root)
        _STAGE_AGENT[root] = (
            os.environ.get("XT_GUARD_POLICY") != "strict"
            and bool(xt)
            and _stage_approval_value(_read_all(xt)) == "agent"
            and _committed_value(xt, _stage_approval_value, STAGE_REFS) == "agent"
        )
    return _STAGE_AGENT[root]


def _temp_roots() -> List[str]:
    return [os.path.realpath(d) for d in (*TEMP_DIRS, tempfile.gettempdir(), os.environ.get("TMPDIR", "/tmp"))]


# Ký tự mà shell còn mở rộng (glob `.?` → `..`) hay chỗ giữ đích của find (`{}`): đích không biết trước (review #213).
UNRESOLVED_TARGET_CHARS = set("$`*?[{}")


def _local(target: Optional[str], root: str, cwd: Optional[str], typed: bool = True) -> bool:
    """Đích chắc chắn nằm trong dự án hoặc thư mục tạm (không phải chính gốc thư mục tạm — `chmod -R 777 /tmp` chạm file
    người khác): thư mục đang đứng biết, không biến/backtick/glob/`{}`, không `~-`."""
    if cwd is None or not target or (typed and UNRESOLVED_TARGET_CHARS & set(target)) or OLDPWD_REF_RE.match(target):
        return False
    if FIND_FOUND in target:  # `find /etc -exec chmod 777 {} +`: file tìm thấy dưới gốc của find, không phải trong cwd
        return False
    if os.path.realpath(os.path.join(cwd, os.path.expanduser(target))) in _temp_roots():
        return False
    return not _outside_project(target, root, cwd)


def build_local_secret(target: str, root: str, cwd: Optional[str]) -> bool:
    """Ghi file bí mật trong dự án/tmp ở pha build (ADR-0040) — được phép."""
    return _local(target, root, cwd) and build_phase(root)


def _build_local_git(n: List[str], argv: List[str], root: str, cwd: Optional[str]) -> bool:
    """git vứt thay đổi cục bộ trong repo ở dự án/tmp (trừ `clean -x/-X` — xoá cả `.autopilot/`); git dời cây/repo/index/hook
    (`GIT_TREE_MOVER_RE`) hay `-C` chưa giải → không nới."""
    sub = n[1] if len(n) > 1 else ""
    if sub not in LOCAL_GIT or (sub == "clean" and set("xX") & set(_short_flags(n[2:]))):
        return False
    if any(GIT_TREE_MOVER_RE.search(a) for a in argv) or not all(_local(d, root, cwd) for d in _git_C_dirs(argv)):
        return False
    # thư mục repo suy từ cwd không phải chữ người gõ: tên dự án có `[`/`*` không làm nó "chưa giải" (review #214)
    return _local(_git_dir(argv, cwd), root, cwd, typed=False)


def build_local_command(n: List[str], argv: List[str], root: str, cwd: Optional[str]) -> bool:
    """Lệnh bị luật chặn nhưng chỉ tác động trong dự án/tmp, ở pha build (ADR-0040): git vứt thay đổi cục bộ, `chmod 777`,
    `dd of=`. Đích phải cố định trên dòng lệnh: qua `xargs` (đích từ stdin) → không nới."""
    if any(posixpath.basename(a) == "xargs" for a in argv):
        return False
    targets: List[Optional[str]]
    if n[0] == "git":
        return _build_local_git(n, argv, root, cwd) and build_phase(root)
    if n[0] == "chmod":
        pos = _positionals(n[1:])
        targets = list(pos if any(a.startswith("--reference") for a in n) else pos[1:]) or [None]
    elif n[0] == "dd":
        outs = [a for a in n[1:] if a.startswith("of=")]
        targets = [a[3:] for a in outs if not _dd_safe(a)] if outs else [None]
    else:
        return False
    return all(_local(t, root, cwd) for t in targets) and build_phase(root)


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
    acting = deleting or any(a in FIND_EXEC for a in args[i:]) and not _find_exec_readonly(" ".join(args[i:]))
    hit = next((r for r in roots if acting and _wipes_root(r, root, cwd)), "")
    if hit:  # D-153: theo token (biết `cd`); `find_root_scan` quét chuỗi gốc cho phần token bị shlex cắt
        return "deny", FIND_ROOT_WHY.format(hit)
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


# D-153: `find` có `-delete`/`-exec…` trong CHUỖI GỐC (không qua token — shlex bỏ dấu thoát nên `\(`, `\;` cắt argv).
FIND_WORD_RE = re.compile(r"(?<![\w.-])find(?![\w.-])")
FIND_ACT_RE = re.compile(r"(?<![\w-])-(?:delete|exec|execdir|ok|okdir)(?![\w-])")
FIND_WRITE_RE = re.compile(r"(?<![\w-])-(?:delete|fprint0?|fprintf|fls)(?![\w-])")
FIND_EXEC_CMD_RE = re.compile(r"(?<![\w-])-(?:exec|execdir|ok|okdir)(?![\w-])(?:[ \t]+(\S+))?")
FIND_OUT_RE = re.compile(r"(?<![\w-])-(?:fprint0?|fprintf|fls)[ \t]+(\S+)")
CD_WORD_RE = re.compile(r"(?<![\w.-])(?:cd|pushd|popd)(?![\w.-])")
# D-154: -exec từ gốc được miễn khi chỉ chạy các lệnh đọc này (danh sách đóng — không shell/trình thông dịch/xargs/env)
FIND_ROOT_RO_EXEC = frozenset(
    # không `rg` (`--pre <lệnh>` chạy lệnh tuỳ ý), không `file` (`file -C` ghi magic.mgc)
    "cat grep egrep fgrep ls head tail wc stat du sha256sum sha1sum md5sum basename dirname realpath echo "
    "printf test".split()
)
FIND_ROOT_WHY = (
    "find xoá/-exec bắt đầu từ gốc dự án bị chặn ({}; D-153) — chạy trong thư mục con (vd `find build -name '*.o' "
    "-delete`) hoặc rm đường cụ thể"
)


def _find_starts(rest: str) -> List[str]:
    """Điểm bắt đầu sau một từ `find` trong chuỗi gốc: bỏ `-H/-L/-P/-O<n>/-D <x>/--`, dừng ở từ bắt đầu bằng `-`, `(`,
    `\\(`, `!` hay toán tử shell; nháy và `\\` bị bỏ."""
    out: List[str] = []
    words = iter(rest.split("\n", 1)[0].split())
    for w in words:
        if w in ("-H", "-L", "-P", "--") or re.fullmatch(r"-O\d", w):
            continue
        if w == "-D":
            next(words, None)
            continue
        head = re.split(r"[;&|<>()]", w.replace("\\", "").replace('"', "").replace("'", ""), maxsplit=1)
        if w.startswith(("-", "(", "\\(", "!")) or not head[0] and len(head) > 1:
            break
        out.append(head[0])
        if len(head) > 1:
            break
    return out


def _find_exec_readonly(rest: str) -> bool:
    """D-154: không `-delete`/`-fprint*`/`-fls` và MỌI `-exec`/`-execdir`/`-ok`/`-okdir` chạy lệnh TÊN TRẦN (không `/`
    — `./cat` không phải cat) trong `FIND_ROOT_RO_EXEC`; lệnh là `{}`, biến hay thiếu → không miễn."""
    if FIND_WRITE_RE.search(rest):
        return False
    return all(c.strip("'\"") in FIND_ROOT_RO_EXEC for c in FIND_EXEC_CMD_RE.findall(rest))


def _find_bad_start(s: str, root: str, cwd: Optional[str], moved: bool) -> bool:
    """Điểm bắt đầu rỗng/không xác định, tương đối sau `cd`/`pushd`/`popd` trong cùng lệnh, hay chạm gốc/`.git`."""
    unknown = not s or bool(set(s) & UNRESOLVED_TARGET_CHARS) or (moved and not s.startswith(("/", "~")))
    return unknown or _wipes_root(s, root, cwd)


def find_root_scan(cmd: str, root: str, cwd: Optional[str]) -> str:
    """D-153: lý do chặn khi một `find` có hành động xoá/`-exec` bắt đầu từ gốc dự án, tổ tiên hay `gốc/.git`, không có
    điểm bắt đầu khi đang đứng ở đó, hoặc điểm bắt đầu không xác định (`$`, backtick, glob, `{}`, tương đối sau `cd`);
    hoặc `-fprint*`/`-fls` ghi vào `gốc/.git`. Quét bản bỏ `"`/`'`/`\\` (`fi""nd`, `f\\ind` vẫn là find). Chữ `find`
    trong đối số có nháy cũng tính (AUD-SEC-410 mở, D-329): nhiều lệnh chạy chữ đó (`git rebase --exec`, `make --eval`)."""
    norm = re.sub(r"[\"'\\]", "", join_continuations(cmd))
    for m in FIND_WORD_RE.finditer(norm):
        rest = norm[m.end() :]
        moved = bool(CD_WORD_RE.search(norm, 0, m.start()))
        acting = FIND_ACT_RE.search(rest) and not _find_exec_readonly(rest)
        starts = (_find_starts(rest) or ["."]) if acting else []
        bad = next((s for s in starts if _find_bad_start(s, root, cwd, moved)), None)
        bad = (
            bad if bad is not None else next((o for o in FIND_OUT_RE.findall(rest) if _wipes_root(o, root, cwd)), None)
        )
        if bad is not None:
            return f"Lệnh bị khung chặn ({FIND_ROOT_WHY.format(bad or repr(bad))}): {cmd[:300]}"
    return ""


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


# `--del`, `--delete`, `--delete-after`, cả tên nhiều đoạn `--delete-missing-args` (AUD-SEC-076)
RSYNC_DELETE_RE = re.compile(r"--(?:del|delete(?:-[\w-]+)?)(?:=.*)?")
HOME_ROOT_TARGETS = {"/", "~", "$HOME", "${HOME}"}  # dời đi đâu cũng là mất (`mv ~ ./x`)


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


# Bảng popt của rsync (options.c, RsyncProject/rsync master, đọc 2026-11-04): chữ ngắn ăn giá trị `@BMTef`, tên dài bắt
# buộc giá trị dưới đây; popt KHÔNG nhận tên viết tắt (popt.c `longOptionStrcmp` so cả độ dài) — AUD-SEC-476: bảng cờ
# của ssh (`-P -p -l -o -i -F -J` ăn giá trị) từng nuốt nguồn và làm mất đích.
RSYNC_LONG_VALUE: Tuple[str, ...] = (
    "address",
    "backup-dir",
    "block-size",
    "bwlimit",
    "cc",
    "checksum-choice",
    "checksum-seed",
    "chmod",
)
RSYNC_LONG_VALUE += ("chown", "compare-dest", "compress-choice", "compress-level", "compress-threads", "config")
RSYNC_LONG_VALUE += ("confine-root", "contimeout", "copy-as", "copy-dest", "debug", "dparam", "early-input", "exclude")
RSYNC_LONG_VALUE += ("exclude-from", "files-from", "filter", "groupmap", "iconv", "include", "include-from", "info")
RSYNC_LONG_VALUE += ("link-dest", "log-file", "log-file-format", "log-format", "max-alloc", "max-delete", "max-size")
RSYNC_LONG_VALUE += ("min-size", "modify-window", "nice", "only-write-batch", "out-format", "outbuf", "partial-dir")
RSYNC_LONG_VALUE += ("password-file", "port", "protocol", "read-batch", "remote-option", "rsh", "rsync-path")
RSYNC_LONG_VALUE += ("skip-compress", "sockopts", "stderr", "stop-after", "stop-at", "suffix", "temp-dir", "time-limit")
RSYNC_LONG_VALUE += ("timeout", "usermap", "write-batch", "zc", "zl", "zt")
RSYNC_OPTS: OptTable = ("@BMTef", (), RSYNC_LONG_VALUE, False)


def _rsync_pos(args: List[str]) -> List[str]:
    """Toán hạng của rsync (nguồn…, đích) theo bảng popt riêng."""
    return _operands(_getopt(args, RSYNC_OPTS))


def _rsync_wipes(args: List[str], root: str, cwd: Optional[str]) -> List[str]:
    """`rsync --delete` lên đích local ngoài dự án; `--remove-source-files` xoá nguồn ngoài dự án."""
    pos = _rsync_pos(args)
    out = [s for s in pos[:-1] if _outside_project(s, root, cwd)] if "--remove-source-files" in args else []
    deleting = pos and any(RSYNC_DELETE_RE.fullmatch(a) for a in args) and not REMOTE_SPEC_RE.match(pos[-1])
    return out + ([pos[-1]] if deleting and _outside_project(pos[-1], root, cwd) else [])


def _mv_wipes(args: List[str], root: str, cwd: Optional[str]) -> List[str]:
    """`mv` dời gốc/home (đi đâu cũng mất) hoặc dời thư mục ngoài dự án sang chỗ khác ngoài dự án (`mv ~/x /tmp/y`);
    dời một file ngoài dự án (`mv ~/Downloads/a.zip /tmp/`) là đổi chỗ, không phải xoá."""
    t_dirs, pos, _ = _copy_opts("mv", args)
    srcs, dest = (pos, t_dirs[-1]) if t_dirs else (pos[:-1], pos[-1] if pos else "")
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


DD_SAFE_OUT = {"of=/dev/null", "of=/dev/stdout", "of=/dev/stderr"}


def _dd_out_path(arg: str) -> str:
    """Đường `of=` đã chuẩn hoá (`//dev/sda`, `/tmp/../dev/sda` → `/dev/sda` — review #214)."""
    return re.sub("^/+", "/", posixpath.normpath(arg[3:])) if arg.startswith("of=/") else arg[3:]


def _dd_safe(arg: str) -> bool:
    return "of=" + _dd_out_path(arg) in DD_SAFE_OUT


def _dd_device_out(arg: str) -> bool:
    """`dd of=/dev/<thiết bị>` (không `if=` thì đọc stdin — vẫn ghi thô lên đĩa); `/dev/null|stdout|stderr` vô hại."""
    path = _dd_out_path(arg)
    return arg.startswith("of=") and (path == "/dev" or path.startswith("/dev/")) and not _dd_safe(arg)


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
    if name == "dd" and any(x.startswith("if=") or _dd_device_out(x) for x in args):  # `dd of=/dev/sda` (review #213)
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
MCP_MERGE_KEYS = {"owner", "repo", "pullNumber", "expectedHeadSha", "merge_method", "commit_message"}


# Dấu review trên PR mà steward/`pr next` tin (ADR-0027) — chỉ `xt.py pr reviewed` đăng (gọi `gh api` từ tiến trình
# python, không qua tool Bash/MCP). Đăng tay = bằng chứng review giả, né "reviewer năng lực cao hơn" (D-161, AUD-SEC-069).
# Đúng dạng dấu mà `xt.py` đọc (`head=<40 hex> verdict=…`) hoặc head ghép lúc chạy (`head=$(git rev-parse HEAD)`,
# `$H`, backtick — re-review #159); mã nguồn/tài liệu nhắc dạng dấu (`head={head}`, `head=<sha>`) không khớp.
REVIEW_MARK_RE = re.compile(
    r"<!--\s*xt-review\s+v1\s+head=(?:[0-9a-f]{40}|[$`%][^>]{0,200}?)\s+verdict=(?:clean|blocking|inconclusive|debt|[$`%])"
)
# `gh api` chỉ khi GHI (cờ trường/`--input`/phương thức ghi) — `gh api … --jq` đọc comment không bị chặn (review #159).
GH_POST_RE = re.compile(
    # cờ toàn cục giữa nhóm và lệnh con (`gh pr -R o/r comment`), cờ trường dính (`-fbody=…`), `close/reopen -c` —
    # AUD-SEC-193; tên cờ `-{1,2}\w[\w-]*` khớp một cách duy nhất (`[\w-]+` sau `-{1,2}` là ReDoS 2^n — review lát C)
    r"\bgh\b.*?\b(?:(?:pr|issue)(?:\s+-{1,2}\w[\w-]*(?:[=\s]+[^\s-]\S*)?)*\s+(?:comment|review|create|edit|close|reopen)\b"
    r"|api\b.*?(?:\s-[fF]|\s--(?:field|raw-field|input)\b|\s(?:-X\s*|--method[=\s]+)(?:POST|PATCH|PUT)\b))",
    re.S,
)
GH_TEXT_NOISE_RE = re.compile(r"['\"\\]")


def _gh_post_text(text: str) -> bool:
    """Chữ thô có thể chứa `gh` đăng chữ — cả sau khi bỏ nháy/`\\` và thay `${IFS}` (`g''h pr co\\mment`): lọc nhanh
    trước khi quét không được bỏ qua dạng mà token (đã bỏ nháy) thấy là `gh` đăng chữ (review #361 lượt 2)."""
    return bool(GH_POST_RE.search(text) or GH_POST_RE.search(IFS_RE.sub(" ", GH_TEXT_NOISE_RE.sub("", text))))


# Tool MCP đăng chữ lên PR/issue mà steward đọc dấu từ đó (commit file nhắc dấu thì không — review #159).
MCP_REVIEW_POST_RE = re.compile(
    r"mcp__.+__\w*(?:issue_comment|pull_request_review_write|comment_to_pending_review|reply_to_pull_request_comment"
    r"|create_pull_request|update_pull_request|issue_write)\w*"  # `issue_write`, `sub_issue_write` — AUD-SEC-344
)
REVIEW_FORGE_WHY = (
    "ghi tay bằng chứng review (dấu `xt-review v1` trên PR) — chỉ `xt.py pr reviewed` đăng (ADR-0026/0027)"
)
# Sổ giai đoạn sản phẩm (ADR-0058) — chỉ `xt.py stage …` ghi; duyệt/công nhận giai đoạn là việc của người.
STAGE_LEDGER = "docs/autopilot/STAGE.json"
STAGE_APPROVE_WHY = (
    "duyệt giai đoạn sản phẩm (`xt.py stage approve`/`init --adopt`) — chỉ người, ngoài phiên agent (ADR-0058);"
    " `stage approve` dạng chữ rõ được khi xt.yaml ở cây VÀ bản đã commit ở nhánh chính khai `stage_approval: agent`"
    " (ADR-0069)"
)


def _vague(tok: str) -> bool:
    """Token mờ với guard: mở rộng lúc chạy (`$`, backtick) hay glob (`appro?e`, `x?.py`) — AUD-SEC-155."""
    return _opaque(tok) or any(c in tok for c in "*?[")


# `-m xt`, `-mxt`, `-Bm xt`, `-m scripts.xt` (cờ ngắn ghép của python; module dạng gói)
XT_MODULE_RE = re.compile(r"-[A-Za-z]*m((?:[\w.]*\.)?xt)?")
XT_MODULE_NAME_RE = re.compile(r"(?:[\w.]*\.)?xt")
STDIN_FEEDERS = ("xargs", "parallel")  # thêm đối số từ stdin vào lệnh
FD_NAME_RE = re.compile(r"\d+|\{\w+\}")  # fd trước chuyển hướng: `2>`, `{fd}>`
# Lệnh chỉ đọc/so/chép file, không chạy script — `cat scripts/xt.py "$F"` không phải gọi `xt.py`
STAGE_READERS = frozenset(
    {"cat", "grep", "rg", "git", "ruff", "black", "mypy", "shellcheck", "wc", "head", "tail", "less", "more", "bat"}
    | {"diff", "ls", "cp", "mv", "ln", "sed", "awk", "file", "stat", "echo", "printf", "sha256sum", "md5sum", "touch"}
    | {"vim", "vi", "nano", "code", "chmod", "rm"}
)


def _xt_sub(n: List[str], i: int) -> Tuple[int, str]:
    """(vị trí, lệnh con) của `xt.py` từ `n[i]`, sau tuỳ chọn toàn cục (`--framework X`, cả viết tắt `--fr X`); cờ mờ,
    giá trị `--framework` mờ/thiếu (`$(`, `<(` cắt lệnh; `--framework=` rỗng) → lệnh con mờ `$`."""
    k = i
    while k < len(n) and n[k].startswith("-"):
        if _vague(n[k]) or n[k].endswith("="):
            return k, "$"
        if len(n[k]) > 2 and "=" not in n[k] and "--framework".startswith(n[k]):
            if k + 1 >= len(n) or _vague(n[k + 1]):
                return k, "$"
            k += 2
        else:
            k += 1
    return k, (n[k] if k < len(n) else "")


def _xt_named(n: List[str], k: int) -> bool:
    """`n[k]` gọi `xt.py` theo tên: đường `…/xt.py`, `-m xt`, `-mxt`, `-Bm xt`, `-m scripts.xt`."""
    m = XT_MODULE_RE.fullmatch(n[k])
    module = k > 0 and bool(XT_MODULE_NAME_RE.fullmatch(n[k])) and bool(XT_MODULE_RE.fullmatch(n[k - 1]))
    return posixpath.basename(n[k]) == "xt.py" or bool(m and m.group(1)) or module


def _no_redirects(args: List[str]) -> List[str]:
    """Bỏ chuyển hướng, đích và fd đứng trước nó (`2>/dev/null`, `{fd}>f`, `> "$LOG"` không phải đối số của lệnh);
    đích bị cắt (`> >(cat)`, `2>$(mktemp)` — tách lệnh ở `(`) hay thiếu → token mờ `$`."""
    out: List[str] = []
    skip = False
    for i, t in enumerate(args):
        nxt = args[i + 1] if i + 1 < len(args) else ""
        if skip:
            skip = False
        elif _is_redirect(t):
            skip = True
            out += ["$"] if nxt in ("", "$") or _is_punct(nxt) else []
        elif not (FD_NAME_RE.fullmatch(t) and _is_redirect(nxt)):
            out.append(t)
    return out


def _placeholders(argv: List[str], feeds: bool) -> Set[str]:
    """Chuỗi thay chỗ do lệnh khác điền lúc chạy: `xargs -I R|-IR|-i[R]|-0I R|--replace[=R]` (khi có xargs/parallel);
    mẫu `{…}` của `find -exec`/`parallel` tính riêng ở `_approves_stage`."""
    out: Set[str] = set()
    for i, t in enumerate(argv if feeds else []):
        r = _xargs_replace(argv[i : i + 2])
        out |= {r} if r and (t.startswith("--replace") or XARGS_REPLACE_RE.fullmatch(t)) else set()
    return out


def _approves_at(n: List[str], k: int, runs: Tuple[bool, bool], feeds: bool) -> bool:
    """`n[k]` là script `xt.py` (theo tên, hay đường mờ của lệnh chạy script mà lệnh con là `stage`) và lệnh có thể là
    `stage approve`/`init --adopt`. `runs` = (lệnh không chỉ đọc file — `cat scripts/xt.py "$F"` thì không; có `python`
    đứng trước hay là lệnh — đường mờ của `deploy.sh "$APP" stage "$TAG"` thì không)."""
    named = _xt_named(n, k)
    if not named and not (runs[1] and _vague(n[k])):
        return False
    j, sub = _xt_sub(n, k + 1)
    if not named and sub != "stage":
        return False
    if sub != "stage":
        return runs[0] and (_vague(sub) or (feeds and not sub))
    tail = n[j + 1 :]
    act = next((t for t in tail if not t.startswith("-")), "")
    if not act:  # lệnh con từ stdin (`xargs … stage`); không thì argparse đòi lệnh con
        return feeds and not {"-h", "--help"} & set(tail)
    return (
        "approve" in tail or _vague(act) or ("init" in tail and any(t.startswith("--adopt") or _vague(t) for t in tail))
    )


def _approves_stage(argv: List[str]) -> bool:
    """`… xt.py stage approve …` hay `… xt.py stage init --adopt …` (qua `python3`, `env`, đường dẫn bất kỳ) ở MỌI vị
    trí script (`perf sample -- python3 xt.py stage approve`); lệnh con, tuỳ chọn `init`, đường script mờ hay chuỗi
    thay chỗ có thể là chúng nên cũng tính (`stage "$(echo approve)"`, `xargs -I{} … stage {}` — AUD-SEC-155). Luật
    chữ cũ (`_approves_literal`) luôn áp thêm để không bao giờ yếu hơn trước (review #352 lượt 3, D-265)."""
    if _approves_literal(normalize(argv)):
        return True
    feeds = any(posixpath.basename(t) in STDIN_FEEDERS for t in argv)
    ph = _placeholders(argv, feeds)
    n = [
        ("$" if any(p in t for p in ph) or PARALLEL_REPLACE_RE.search(t) or (feeds and t in PARALLEL_ARG_SEPS) else t)
        for t in normalize(_no_redirects(argv))
    ]
    reads = bool(n) and posixpath.basename(n[0]) in STAGE_READERS
    py = False
    for k, t in enumerate(n):
        if _approves_at(n, k, (not reads, k == 0 or py), feeds):
            return True
        py = py or bool(PYTHON_RE.fullmatch(posixpath.basename(t)))
    return False


PLAIN_APPROVE_PY = ("python3", "python")
PLAIN_APPROVE_XT = ("scripts/xt.py", ".xtemplates/scripts/xt.py")  # xt.py của dự án (repo khung · dự án đích)
PLAIN_APPROVE_OPTS = ("--sha", "--note")


def _approve_opts(rest: List[str]) -> bool:
    """Sau `stage approve` chỉ có `--sha`/`--note` kèm giá trị (`--sha X` hay `--sha=X`)."""
    i = 0
    while i < len(rest):
        if "=" in rest[i] and rest[i].split("=", 1)[0] in PLAIN_APPROVE_OPTS:
            i += 1
        elif rest[i] in PLAIN_APPROVE_OPTS and i + 1 < len(rest):
            i += 2
        else:
            return False
    return True


def _plain_approve(argv: List[str], root: str, cwd: Optional[str], single: bool) -> bool:
    """Dạng DUY NHẤT ADR-0069 cho qua: cả lệnh Bash là MỘT lệnh đơn `[python3|python] <xt.py của dự án> stage approve`
    chỉ với `--sha`/`--note`, không token mờ. Review harden F1 (PLAN-harden-2026-11-05): `env -u CLAUDECODE …`, `unset …;`,
    gán biến (`CLAUDE_PROJECT_DIR=`, `PYTHONPATH=`), cờ trình thông dịch (`-c`, `-m pdb`, `-i`), xt.py ngoài dự án, nối
    lệnh hay lệnh lồng đều rơi về luật ADR-0058 (deny). Đường tương đối chỉ khi thư mục chạy là gốc dự án."""
    if not single or any(_vague(t) for t in argv):
        return False
    rest = argv[1:] if argv[:1] and argv[0] in PLAIN_APPROVE_PY else argv
    here = cwd is not None and os.path.realpath(cwd) == os.path.realpath(root)
    own = {os.path.join(root, p) for p in PLAIN_APPROVE_XT} | (set(PLAIN_APPROVE_XT) if here else set())
    return len(rest) >= 3 and rest[0] in own and rest[1:3] == ["stage", "approve"] and _approve_opts(rest[3:])


def _stage_approve_denied(argv: List[str], root: str, cwd: Optional[str] = None, single: bool = False) -> bool:
    """Lệnh duyệt giai đoạn bị chặn: mọi dạng (ADR-0058), trừ dạng chữ rõ của `_plain_approve` khi `agent_stage_approval`
    (ADR-0069)."""
    return _approves_stage(argv) and not (_plain_approve(argv, root, cwd, single) and agent_stage_approval(root))


def _approves_literal(n: List[str]) -> bool:
    """Luật chữ: `xt.py … stage … approve` hay `… stage … init … --adopt` sau `xt.py` đầu tiên."""
    at = next((k for k, t in enumerate(n) if posixpath.basename(t) == "xt.py"), len(n))
    rest = n[at + 1 :]
    if "stage" not in rest:
        return False
    tail = rest[rest.index("stage") + 1 :]
    return "approve" in tail or ("init" in tail and any(t.startswith("--adopt") for t in tail))


# AUD-SEC-498 (D-377): script trình thông dịch nạp `xt` trong tiến trình — guard không thấy lệnh con (`xt.main([…])`,
# `runpy.run_path('scripts/xt.py')`, `exec(open(…).read())`, `python3 -m runpy xt …`). Thư viện đọc của xt
# (`xt.parse_plan`, `xt.review_debt` — Kiểm PM-PLAN-001, Gate audit) vẫn qua khi script không có tên/chữ rủi ro.
# Phân tích tĩnh chữ nguyên văn: tên dựng lúc chạy qua đường guard không thấy vẫn lọt (AUD-SEC-161).
XT_INPROC_WHY = (
    "duyệt giai đoạn sản phẩm (AUD-SEC-498) có thể chạy trong tiến trình: script trình thông dịch nạp `xt` (`import xt`"
    " kèm `main`/`stage`/`approve`/`adopt`/biến môi trường/truy cập động; `runpy`, `import_module`, `exec`/`eval` chữ"
    " không rõ; `-m runpy xt`) — guard không thấy lệnh con; gọi `python3 scripts/xt.py <lệnh>`"
)
XT_INPROC_DEPTH = 3  # số tầng `exec('…')` lồng đọc lại; sâu hơn → chặt
# Hàm nạp/chạy mã theo tên hay đường (gọi theo tên hay thuộc tính: `runpy.run_path`, `from runpy import run_path`)
XT_INPROC_LOADERS = frozenset(
    {"run_path", "run_module", "_run_module_as_main", "_run_code", "spec_from_file_location", "SourceFileLoader"}
    | {"SourcelessFileLoader", "load_source", "load_module", "import_module", "find_spec", "exec_module", "__import__"}
)
XT_INPROC_BUILTINS = frozenset({"exec", "eval", "compile", "execfile", "__import__"})  # chỉ khi gọi như builtin
XT_INPROC_BUILTIN_MODS = frozenset({"builtins", "__builtins__"})  # `builtins.exec(…)`
XT_INPROC_NAME_RE = re.compile(r"(?:.*[/\\.])?xt(?:\.pyc?)?", re.S)  # `xt`, `scripts.xt`, `scripts/xt.py`
# Tên/chữ thư viện đọc của xt không cần — đi cùng `import xt` thì chặn (gọi CLI, sửa biến agent, truy cập động)
XT_INPROC_RISKY_RE = re.compile(
    r"main|stage|approv|adopt|environ|putenv|unsetenv|CLAUDE|AI_AGENT|[gsd]etattr|^vars$|^dir$|globals|locals"
    r"|__dict__|__getattribute__|attrgetter|methodcaller|getmembers|^exec|^eval$|^compile$|__import__|import_module"
    r"|builtins|modules|__loader__|__spec__",
    re.I,
)
# Script không phải Python hợp lệ: luật chữ (`import … xt`, tên hàm nạp)
XT_INPROC_TEXT_RE = re.compile(
    r"\b(?:import|from)\b[^;\n]*\bxt\b(?![\w-])|\b(?:runpy|run_path|run_module|spec_from_file_location"
    r"|Source(?:less)?FileLoader|load_source|import_module|__import__|execfile)\b"
)
RUNPY_OPT_RE = re.compile(r"-[A-Za-z]*m(runpy)?")  # `-m runpy`, `-mrunpy`, `-Bm runpy`


def _xt_inproc_text(script: str) -> bool:
    """Luật chữ cho script không phân tích được: nhắc nạp `xt` hay hàm nạp mã."""
    return bool(XT_INPROC_TEXT_RE.search(script))


def _xt_inproc_python(script: str, depth: int) -> bool:
    """Script Python nạp `xt` trong tiến trình theo cách guard không thấy lệnh con: lời gọi hàm nạp có đối số không rõ
    hay trỏ `xt`, hoặc `import xt` kèm tên/chữ rủi ro. Không phải Python → luật chữ; `exec('…')` lồng đọc lại tới
    `XT_INPROC_DEPTH` tầng, sâu hơn thì chặt."""
    import ast

    if depth >= XT_INPROC_DEPTH:
        return True
    try:
        nodes = list(ast.walk(ast.parse(script)))
    except Exception:  # SyntaxError, ValueError (NUL), RecursionError: không phải Python — luật chữ
        return _xt_inproc_text(script)
    if any(isinstance(n, ast.Call) and _xt_loader_call(n, depth) for n in nodes):
        return True
    return any(_xt_imports(n) for n in nodes) and any(_xt_risky(n) for n in nodes)


def _xt_loader_call(call: Any, depth: int) -> bool:
    """`call` (ast.Call) là hàm nạp mã mà một đối số không phải chữ nguyên văn, là tên/đường `xt`, có mở rộng shell,
    hay (cho `exec('…')`) là script lại nạp `xt`."""
    import ast

    f = call.func
    owner = f.value if isinstance(f, ast.Attribute) else None
    name = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else ""
    builtin = isinstance(f, ast.Name) or (isinstance(owner, ast.Name) and owner.id in XT_INPROC_BUILTIN_MODS)
    if name not in XT_INPROC_LOADERS and not (builtin and name in XT_INPROC_BUILTINS):
        return False
    for a in [*call.args, *(k.value for k in call.keywords)]:
        v = a.value if isinstance(a, ast.Constant) else None
        if not isinstance(a, ast.Constant):
            return True
        text = v.decode("utf-8", "replace") if isinstance(v, bytes) else v if isinstance(v, str) else ""
        if XT_INPROC_NAME_RE.fullmatch(text) or _opaque(text) or (text and _xt_inproc_python(text, depth + 1)):
            return True
    return False


def _xt_imports(node: Any) -> bool:
    """`import xt`, `import scripts.xt`, `from xt import …`, `from scripts import xt`."""
    import ast

    if isinstance(node, ast.Import):
        return any("xt" in a.name.split(".") for a in node.names)
    if isinstance(node, ast.ImportFrom):
        return "xt" in (node.module or "").split(".") or any(a.name == "xt" for a in node.names)
    return False


def _xt_risky(node: Any) -> bool:
    """Tên (biến, thuộc tính, tên nhập, `*`) hay chữ nguyên văn rủi ro khi đi cùng `import xt`."""
    import ast

    if isinstance(node, ast.alias):
        words = [node.name, node.asname or ""]
    elif isinstance(node, ast.Constant):
        words = [node.value] if isinstance(node.value, str) else []
    else:
        words = [getattr(node, "id", "") if isinstance(node, ast.Name) else getattr(node, "attr", "")]
    return any(w == "*" or XT_INPROC_RISKY_RE.search(w) for w in words if w)


def _xt_inproc_argv(argv: List[str]) -> bool:
    """`python3 -m runpy <mô-đun>` mà mô-đun là `xt` (`xt`, `scripts.xt`, `…/xt.py`) hay mờ."""
    n = _interp_argv(argv) if argv else []
    if not n or not PYTHON_RE.fullmatch(posixpath.basename(n[0])):
        return False
    for i, t in enumerate(n):
        m = RUNPY_OPT_RE.fullmatch(t)
        at = i + 1 if m and m.group(1) else i + 2 if m and n[i + 1 : i + 2] == ["runpy"] else 0
        if at and at < len(n):
            mod = n[at]
            return bool(XT_INPROC_NAME_RE.fullmatch(mod)) or _vague(mod)
    return False


def xt_inproc_asks(cmd: str, tokens: List[str], cwd: Optional[str]) -> List[str]:
    """AUD-SEC-498: script trình thông dịch (`-c`, stdin, heredoc, here-string, ống) hay `-m runpy` nạp `xt` trong
    tiến trình → cùng nhóm chặn với duyệt giai đoạn (STAGE_APPROVE)."""
    scripts = [_nfkc(s) for s, _ in _interp_scripts_at(cmd, tokens, cwd)]
    hit = any(_xt_inproc_python(s, 0) for s in scripts) or any(_xt_inproc_argv(c) for c in split_commands(tokens))
    return [XT_INPROC_WHY] if hit else []


def _forges_review(argv: List[str]) -> bool:
    """Lệnh `gh` đăng/sửa comment, review, thân PR/issue (hoặc `gh api`) mang dấu review — chỉ argv của lệnh thật,
    không phải chữ trong heredoc/chuỗi của lệnh khác (script sửa tài liệu nhắc tới dấu)."""
    n = normalize(argv)
    return (
        bool(n) and n[0] == "gh" and bool(GH_POST_RE.search(" ".join(n))) and bool(REVIEW_MARK_RE.search(" ".join(n)))
    )


REVIEW_BODY_FILES_MAX = 8  # số nguồn thân tối đa mỗi lệnh `gh` đăng chữ — vượt thì coi như không đọc được
# Thân comment GitHub tối đa 65 536 ký tự (≤ 256 KiB UTF-8): lớn hơn thì không đọc — coi như không đọc được; cùng trần
# số nguồn giữ một quyết định trong ngân sách quét (review #354 lượt 3)
REVIEW_BODY_FILE_BYTES = 1 << 18
# File mà lệnh đọc (`$(head -40 CHANGELOG.md)`, `grep x f |`) chỉ góp một phần vào thân: quét cả file tới trần lớn hơn
# (8 lệnh × 8 MiB vẫn trong ngân sách giờ của hook) thay vì chặn oan file > 256 KiB (AUD-SEC-177)
REVIEW_READ_BYTES = 1 << 23
STDIN_READERS = ("cat", "tac", "head", "tail")  # `cat f | gh … -F -`, `--body "$(cat f)"`
READER_VALUE_OPTS = ("-n", "-c", "--lines", "--bytes")  # tuỳ chọn của lệnh đọc ăn giá trị (`head -n "$N" f`)
STDIN_PATHS = ("-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0")  # thân đọc từ stdin
# Dấu nối cấp ngoài (`2>&1`, `&>f`, `<&3` không phải); ngoặc subshell cũng là ranh giới đoạn lệnh
SEG_SEP_RE = re.compile(r"\|\||&&|\|&?|;;?|\n|(?<![<>&])&(?![>&])|[()]")
SCAN_PLAIN_RE = re.compile(r"[^\\'\"`$<>()|&;\n#]+")  # ký tự không đổi trạng thái quét ở ngữ cảnh nào
BACKTICK_ESCAPE_RE = re.compile(r"\\([\\`$])")  # thân backtick: `\``, `\\`, `\$` là ký tự đã thoát
POST_NEST_MAX = 4  # số tầng thay lệnh lồng được đọc nguồn thân; sâu hơn → nguồn mờ (chặn)


def _null_device(path: str) -> bool:
    """`path` là thiết bị null thật (ký tự; Linux: số thiết bị 1:3) — không chỉ tên `/dev/null` mà root có thể thay bằng
    symlink tới file mang dấu (AUD-SEC-183)."""
    try:
        st = os.stat(path)
    except OSError:
        return False
    return stat.S_ISCHR(st.st_mode) and (sys.platform != "linux" or st.st_rdev == os.makedev(1, 3))


def _file_has_mark(path: str, cwd: Optional[str], limit: int = REVIEW_BODY_FILE_BYTES) -> bool:
    """Nguồn thân `path` (tương đối với `cwd`) có thể mang dấu review: có dấu (chữ thô, rồi cả chuỗi JSON — `gh api
    --input` viết `<` thành `\\u003c`), hay có mà guard không đọc được (mờ/glob, fd của shell, không phải file thường,
    quá cỡ, lỗi đọc/giải mã kể cả JSON lồng quá sâu) — chiều chặt (AUD-SEC-157, review #354). Chưa có thì `gh` cũng
    không đọc được — trừ khi lệnh trước trong chuỗi tạo ra nó (chữ dấu trong chuỗi lệnh đã bị quét; do chương trình khác
    sinh ra là giới hạn đã ghi). Mở `O_NONBLOCK` rồi `fstat`: FIFO đổi chỗ sau khi kiểm không làm guard treo."""
    if path == os.devnull and _null_device(path):  # `gh … < /dev/null` tắt prompt — thân rỗng
        return False
    if _vague(path) or _dev_path(path):  # fd/stdin/thiết bị (cả `/dev/./stdin`): không đọc — AUD-SEC-511/513
        return True
    full = os.path.join(cwd or ".", os.path.expanduser(path))
    try:
        os.lstat(full)
    except FileNotFoundError:
        return False
    except OSError:  # đường quá dài, quyền… — có thể có mà guard không thấy
        return True
    try:
        fd = os.open(full, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(fd, encoding="utf-8", errors="replace") as fh:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_size > limit:
                return True
            text = fh.read(limit + 1)  # file lớn lên sau `fstat` không làm đọc quá trần
        if len(text) > limit or REVIEW_MARK_RE.search(text):
            return True
        return any(REVIEW_MARK_RE.search(t) for t in _strings(json.loads(text)))
    except ValueError:  # không phải JSON: chữ thô đã quét
        return False
    except Exception:  # OSError, RecursionError (JSON lồng sâu) … — không đọc được thì coi như có dấu
        return True


def _stdin_redirects(argv: List[str]) -> List[str]:
    """Đích chuyển hướng vào stdin của lệnh: `< f`, `0<> f`/`<> f`; `<&N` là fd của shell (`/dev/fd/N` — guard không
    đọc được, AUD-SEC-176)."""
    out: List[str] = []
    for i, t in enumerate(argv[:-1]):
        if t in ("<", "<>"):
            out.append(argv[i + 1])
        elif t == "<&" and argv[i + 1] != "-":  # `<&-` đóng stdin; `<&3-` chuyển fd 3 (review #357)
            out.append("/dev/fd/" + argv[i + 1].removesuffix("-"))
    return out


def _reader_files(n: List[str], argv: List[str]) -> List[str]:
    """File mà `cat`/`head`/`tail`/`tac` đọc: đối số không phải tuỳ chọn (bỏ giá trị của `-n`/`-c` của `head`/`tail` —
    với `cat`, `-n` là cờ, AUD-SEC-174) sau khi bỏ chuyển hướng (`2>/dev/null`), cộng đích `< f` (AUD-SEC-176); không
    có file hay `-` → đọc stdin (`-`). `n` = argv đã bỏ chuyển hướng và chuẩn hoá, `n[0]` thuộc `STDIN_READERS`."""
    valued = n[0] in ("head", "tail")
    out = [
        t
        for i, t in enumerate(n[1:], 1)
        if (t[:1] != "-" or t == "-") and not (valued and n[i - 1] in READER_VALUE_OPTS)
    ]
    return out + _stdin_redirects(argv) or ["-"]


NO_FILE_READ = frozenset({"echo", "printf"})  # đối số là chữ, không phải file
# không đối số thì cũng không đọc stdin (`$(date)`, `$(git log -1)`) — lệnh khác không file → đọc stdin
NO_STDIN_READ = frozenset({"date", "git", "gh", "pwd", "ls", "whoami", "hostname", "uname", "id", "nproc", "true"})
SCRIPT_FIRST = frozenset({"grep", "egrep", "fgrep", "rg", "sed", "awk", "gawk", "mawk", "nawk", "jq"})
SCRIPT_OPT_RE = re.compile(r"-[A-Za-z]*[ef].*|--(?:regexp|file|expression|from-file)(?:=.*)?")  # mẫu/script qua cờ
# Thư mục chỉ là nguồn của lệnh đọc đệ quy (`grep -r x docs`, `rg`, `tar`); lệnh khác nhận thư mục (`ls docs`, `du -sh
# docs`, `git log -- docs`, `make -C docs`) không in nội dung file trong đó (review #361)
RECURSIVE_READERS = frozenset({"rg", "ag", "ack", "tar", "bsdtar", "zip", "7z"})
RECURSIVE_FLAG_READERS = frozenset({"grep", "egrep", "fgrep", "zgrep", "ugrep", "diff"})
RECURSIVE_OPT_RE = re.compile(r"-[A-Za-z]*[rR][A-Za-z]*|--(?:dereference-)?recursive|(?:--directories=)?recurse")
# Lệnh chỉ in số đếm/kích thước/tên/băm — chạy qua `xargs` (`git ls-files | xargs wc -l`) thì đầu ra mang tên đọc từ
# stdin (lỗi `2>&1` in lại tên), không mang nội dung file
FEED_SAFE = frozenset(
    {"wc", "ls", "du", "stat", "file", "md5sum", "sha1sum", "sha256sum", "sha512sum", "b2sum", "cksum"}
)
FEED_FILE_OPT_RE = re.compile(r"-[0-9A-Za-z]*a.*|--arg-file(?:=.*)?")  # `xargs -a f`: tên lấy từ file
FIND_RUN = frozenset({"-exec", "-execdir", "-ok", "-okdir", "-files0-from"})  # `find` in nội dung/đọc tên từ file
DIR_OK = "\0"  # tiền tố nguồn của lệnh không đệ quy: là thư mục thì bỏ (`clean_text` thay NUL — không có trong lệnh)
HERE_OPS = ("<<", "<<<")  # stdin của lệnh là heredoc/here-string của chính nó, không phải stdin chung


def _recursive(n: List[str]) -> bool:
    flagged = n[0] in RECURSIVE_FLAG_READERS and any(RECURSIVE_OPT_RE.fullmatch(t) for t in n[1:])
    return n[0] in RECURSIVE_READERS or flagged


def _fed_files(n: List[str], argv: List[str]) -> List[str]:
    """Lệnh chạy qua `xargs`/`parallel` (tên lấy từ stdin): lệnh thuộc `FEED_SAFE` đọc stdin (`-`) — tên trong đó có
    thể hiện ra; lệnh khác, không lệnh (`xargs` = `echo`) hay `xargs -a f` → nguồn mờ."""
    k = next(i for i, t in enumerate(argv) if posixpath.basename(t) in STDIN_FEEDERS)
    opts = argv[k + 1 :]
    cut = next((i for i, t in enumerate(opts) if n and posixpath.basename(t) == n[0]), len(opts))
    safe = bool(n) and n[0] in FEED_SAFE and not any(FEED_FILE_OPT_RE.fullmatch(t) for t in opts[:cut])
    return ["-"] if safe else ["$"]


def _plain_files(n: List[str], argv: List[str]) -> List[str]:
    """File mà lệnh không phải `cat`/`head`… có thể đọc ra stdout: mọi đối số không phải tuỳ chọn (bỏ mẫu/script đầu
    của `grep`/`sed`/`awk`/`jq` khi không qua `-e`/`-f`) cộng đích `< f`; thư mục bỏ qua trừ lệnh đọc đệ quy (`DIR_OK`);
    `find` chỉ in tên (có `-exec`… → nguồn mờ); không file → stdin (`-`), trừ `NO_STDIN_READ`."""
    if n[0] == "find":
        return ["$"] if FIND_RUN & set(n) else []
    pos = [t for t in n[1:] if t == "-" or t[:1] != "-"]  # cả `''` (script rỗng của `sed ''`)
    if n[0] in SCRIPT_FIRST and not any(SCRIPT_OPT_RE.fullmatch(t) for t in n[1:]):
        pos = pos[1:]
    soft = "" if _recursive(n) else DIR_OK
    out = [t if t in STDIN_PATHS else soft + t for t in pos if t] + _stdin_redirects(argv)
    return out or ([] if n[0] in NO_STDIN_READ else ["-"])


def _any_reader_files(argv: List[str]) -> List[str]:
    """File mà lệnh bất kỳ có thể đọc ra stdout (AUD-SEC-186, chiều chặt): `cat`/`head`… như `_reader_files`; lệnh chạy
    qua `xargs`/`parallel` như `_fed_files`; `echo`/`printf` không đọc file; lệnh khác như `_plain_files`. Lệnh có
    heredoc/here-string của chính nó không đọc stdin chung."""
    n = normalize(_no_redirects(argv))
    if any(posixpath.basename(t) in STDIN_FEEDERS for t in argv):
        out = _fed_files(n, argv)
    elif not n or n[0] in NO_FILE_READ:
        return []
    else:
        out = _reader_files(n, argv) if n[0] in STDIN_READERS else _plain_files(n, argv)
    return [f for f in out if f not in STDIN_PATHS] if any(t in HERE_OPS for t in argv) else out


ScanSpan = Tuple[str, str, int, int]  # (loại: `$` thay lệnh, backtick, `<`/`>` thay tiến trình; thân; đầu; sau cuối)
PARAM_RE = re.compile(r"\$[A-Za-z_0-9{@*#?$!-]")  # mở rộng tham số (`$x`, `${a[0]}`, `$1`) — không `$(`/`$'`
COMMENT_AFTER = frozenset(" \t\n;&|<>(")  # `#` sau chúng mở comment; sau `)` thì không (`$(x)#y` là một từ)


class Stage(NamedTuple):
    """Đoạn lệnh: chữ, toán tử nối sau nó, thay lệnh ngoài cùng (vị trí trong `text`), có mở rộng tham số (mọi tầng,
    ngoài nháy đơn)."""

    text: str
    op: str
    spans: List[ScanSpan]
    param: bool


class _ShellScan:
    """Quét chữ lệnh như bash — nháy đơn/kép, `\\`, `$'…'`, backtick, `$(…)`, `<(…)`/`>(…)`, comment — để tách ĐOẠN LỆNH
    ở dấu nối cấp ngoài (`;`, `&&`, `||`, `|`, `&`, xuống dòng, ngoặc subshell) và lấy thân thay lệnh ngoài cùng của mỗi
    đoạn. Backtick ghép tuần tự theo ngữ cảnh nháy, không theo chữ thô: backtick nguyên văn đứng trước không làm lệch cặp
    (AUD-SEC-181); `#` trong `$'…'` không mở comment (review #361). `heredoc`: chữ là thân heredoc không nháy — như
    trong nháy kép mà `"` là chữ. `open`: còn nháy/thay lệnh chưa đóng — không phân tích được."""

    def __init__(self, text: str, heredoc: bool = False) -> None:
        self.text, self.start, self.param = text, 0, False
        self.stack: List[Tuple[str, int]] = [("h", 0)] if heredoc else []  # (loại ngữ cảnh, vị trí thân)
        self.base, self.subs = len(self.stack), 0  # `subs` = số thay lệnh đang mở trong `stack`
        self.stages: List[Stage] = []
        self.spans: List[ScanSpan] = []
        i = 0
        while i < len(text):
            i = self._step(i)
        self._cut(len(text), len(text), "")
        self.open = len(self.stack) > self.base

    def _cut(self, a: int, b: int, op: str) -> None:
        o = self.start
        spans = [(k, body, x - o, y - o) for k, body, x, y in self.spans]
        self.stages.append(Stage(self.text[o:a], op, spans, self.param))
        self.spans, self.start, self.param = [], b, False

    def _step(self, i: int) -> int:
        plain = SCAN_PLAIN_RE.match(self.text, i)
        if plain:
            return plain.end()
        c, top = self.text[i], (self.stack[-1][0] if self.stack else "")
        if c == "\\":
            return i + 2
        self.param = self.param or bool(PARAM_RE.match(self.text, i))
        if top in ('"', "h"):
            return self._quoted(i, top)
        if c == "#":
            return self._comment(i)
        if self.text.startswith("$$", i):  # `$$'…'` = `$$` + nháy đơn, không phải ANSI-C
            return i + 2
        if c == "'" or self.text.startswith("$'", i):
            return _skip_single(self.text, i)
        return self._close(i) or self._open(i, False) or self._word(i)

    def _quoted(self, i: int, top: str) -> int:
        if self.text[i] == '"' == top:
            self.stack.pop()
            return i + 1
        return self._open(i, True) or i + 1

    def _comment(self, i: int) -> int:
        if i and self.text[i - 1] == ")":
            raise ScanTooComplex(PAREN_HASH_WHY)
        if i and self.text[i - 1] not in COMMENT_AFTER:
            return i + 1
        eol = self.text.find("\n", i)
        return len(self.text) if eol < 0 else eol  # giữ `\n`: vẫn là ranh giới đoạn

    def _open(self, i: int, quoted: bool) -> int:
        t = self.text
        if t.startswith("$(", i) or (not quoted and t.startswith(("<(", ">("), i)):
            self.stack.append((t[i], i + 2))
        elif t[i] == "`":
            self.stack.append(("`", i + 1))
        else:
            return 0
        self.subs += 1
        return self.stack[-1][1]  # thân bắt đầu ngay sau dấu mở

    def _close(self, i: int) -> int:
        top, c = (self.stack[-1][0] if self.stack else ""), self.text[i]
        if not (c == "`" == top or (c == ")" and top in ("$", "<", ">", "("))):
            return 0
        kind, body = self.stack.pop()
        self.subs -= kind != "("
        if kind != "(" and not self.subs:
            self.spans.append((kind, self.text[body:i], body - (1 if kind == "`" else 2), i + 1))
        return i + 1

    def _word(self, i: int) -> int:
        c = self.text[i]
        if c == '"' or (c == "(" and self.stack):
            self.stack.append((c, i))
            return i + 1
        sep = None if self.stack else SEG_SEP_RE.match(self.text, i)
        if sep:
            self._cut(i, sep.end(), sep.group())
            return sep.end()
        return i + 1


def _heredoc_feed(body: str) -> str:
    """Chữ ghép vào dòng mở heredoc không nháy: thay lệnh trong thân (bash thay trước khi đưa vào lệnh) và dấu có mở
    rộng tham số, dạng here-string mà argv bỏ qua; thay lệnh không đóng → `$(` làm cả chuỗi lệnh mờ."""
    scan = _ShellScan(body, heredoc=True)
    if scan.open:
        return " $("
    spans = "".join(scan.text[a:b] for st in scan.stages for _, _, a, b in st.spans)
    param = any(st.param for st in scan.stages)
    return f' <<<"{spans}{"$_" if param else ""}"' if spans or param else ""


def _scan(text: str) -> _ShellScan:
    """`_ShellScan` trên chữ lệnh đã nối dòng; thân heredoc bỏ, trừ thay lệnh trong thân không nháy — ghép vào dòng mở
    (review #361); comment do bộ quét bỏ (hiểu `$'…'`)."""
    return _ShellScan(_fold_heredocs(join_continuations(text), True))


# Chữ thay chỗ thay lệnh khi đọc argv một đoạn — mờ như nó (không `$` trơn: `_no_redirects` dành nó cho đích bị cắt)
SUBST_WORD = "$_"


def _stage_argv(st: Stage) -> List[str]:
    """argv của đoạn lệnh: thay lệnh → chữ mờ `SUBST_WORD`, thay tiến trình (`<(…)`/`>(…)`) → `/dev/null` (fd không
    mang thân; nguồn của thân nó tính riêng) — `$(…)` không nháy không cắt mất đối số sau nó (`--body $(…) -F f`); các
    thay lệnh liền nhau thành một chữ (từ dài làm `shlex` chậm bậc hai)."""
    parts: List[str] = []
    pos = 0
    for kind, _, a, b in st.spans:
        word = os.devnull if kind in ("<", ">") else SUBST_WORD
        if not (a == pos and word == SUBST_WORD and "".join(parts[-1:]).endswith(SUBST_WORD)):
            parts += [st.text[pos:a], word]
        pos = b
    return next(iter(split_commands(tokenize("".join(parts) + st.text[pos:]))), [])


class _Sources:
    """Nguồn thân gom được: `own` — file `gh` đăng chữ đọc làm thân (trần 256 KiB); `read` — file lệnh khác đọc góp vào
    thân (trần 8 MiB; tiền tố `DIR_OK` = thư mục thì bỏ); `param` — `gh` có mở rộng tham số; `posts` — thấy `gh` đăng
    chữ (hay lệnh bọc nó). `-`/`/dev/stdin` = đọc stdin. Tập có thứ tự (dict): gộp lại cùng nguồn qua nhiều thay lệnh
    giống nhau không làm danh sách nở theo hàm mũ."""

    def __init__(self, own: Optional[List[str]] = None, read: Optional[List[str]] = None, posts: bool = False) -> None:
        self.own, self.read = dict.fromkeys(own or []), dict.fromkeys(read or [])
        self.param, self.posts = False, posts

    def stdin(self) -> bool:
        return any(f in self.own or f in self.read for f in STDIN_PATHS)

    def merge(self, other: "_Sources") -> "_Sources":
        self.own.update(other.own)
        self.read.update(other.read)
        return self._flags(other)

    def add(self, other: "_Sources", stdin: bool = True) -> "_Sources":
        """Gộp `other` — mọi nguồn của nó thành `read` (`stdin=False`: bỏ `-` của nó)."""
        for src in (other.own, other.read):
            self.read.update((f, None) for f in src if stdin or f not in STDIN_PATHS)
        return self._flags(other)

    def _flags(self, other: "_Sources") -> "_Sources":
        self.param, self.posts = self.param or other.param, self.posts or other.posts
        return self


class _BodyScan:
    """Ngữ cảnh đọc nguồn thân của một quyết định: nhớ kết quả theo (thân, tầng) — thay lệnh giống nhau chỉ quét một lần
    (5 tầng × 2 thay lệnh từng tốn ~80 s ở 256 KiB, review #361) — và hạn giờ của `ScanBudget`: hết giờ → `TimeoutError`
    → `_review_forge_hit` coi như có dấu."""

    def __init__(self, budget: Optional["ScanBudget"]) -> None:
        self.deadline = budget.deadline if budget else time.monotonic() + SCAN_SECONDS
        self.memo: Dict[Tuple[str, str, str, int], _Sources] = {}
        self.scans: Dict[Tuple[str, str], _ShellScan] = {}
        self.argvs: Dict[str, List[str]] = {}

    def tick(self) -> None:
        if time.monotonic() > self.deadline:
            raise TimeoutError("hết hạn giờ quét nguồn thân")

    def argv(self, st: Stage) -> List[str]:
        if st.text not in self.argvs:
            self.argvs[st.text] = _stage_argv(st)
        return self.argvs[st.text]

    def cached(self, key: Tuple[str, str, str, int], work: Callable[[], _Sources]) -> _Sources:
        if key not in self.memo:
            self.tick()
            self.memo[key] = work()
        return self.memo[key]


def _span_scan(ctx: _BodyScan, sp: ScanSpan, depth: int) -> Optional[_ShellScan]:
    """Kết quả quét thân thay lệnh — trong backtick `\\`` là backtick lồng; còn mở hay lồng quá sâu → None."""
    if depth >= POST_NEST_MAX:
        return None
    kind, body = sp[0], sp[1]
    if (kind, body) not in ctx.scans:
        ctx.scans[kind, body] = _scan(BACKTICK_ESCAPE_RE.sub(r"\1", body) if kind == "`" else body)
    scan = ctx.scans[kind, body]
    return None if scan.open else scan


def _span_gh(ctx: _BodyScan, sp: ScanSpan, depth: int) -> _Sources:
    """Nguồn thân của `gh` đăng chữ lồng trong thay lệnh của lệnh khác (`x=$(gh … -F f)`)."""

    def work() -> _Sources:
        scan = _span_scan(ctx, sp, depth)
        return _Sources(own=["`"], posts=True) if scan is None else _gh_sources(ctx, scan, depth + 1)

    return ctx.cached(("g", sp[0], sp[1], depth), work)


def _stage_files(argv: List[str]) -> List[str]:
    """`_any_reader_files` — trừ `gh` đăng chữ: đối số của nó không phải file nó in ra (nguồn của nó tính riêng)."""
    return [] if _gh_posts(argv) else _any_reader_files(argv)


def _scan_reads(ctx: _BodyScan, scan: _ShellScan, depth: int) -> _Sources:
    """File mọi đoạn lệnh của `scan` đọc ra, cả đích `< f` (`read`/`mapfile`/`done < f`) và trong thay lệnh; `-` của
    lệnh sau ống là ống đó, không phải stdin chung (review #361)."""
    out = _Sources()
    for k, st in enumerate(scan.stages):
        argv = ctx.argv(st)
        piped = k > 0 and scan.stages[k - 1].op in ("|", "|&")
        out.read.update(
            (f, None) for f in _stage_files(argv) + _stdin_redirects(argv) if not (piped and f in STDIN_PATHS)
        )
        for sp in st.spans:
            out.add(_span_files(ctx, sp, depth))
    return out


def _span_files(ctx: _BodyScan, sp: ScanSpan, depth: int) -> _Sources:
    """File mà lệnh trong thân thay lệnh đọc ra (`$(cat -- f | head)`, `$(< f)`, `` `head -c N f` ``, lồng nhau);
    `$(cat)` → `-` (stdin); `gh` đăng chữ trong thân thì nguồn của nó cũng tính. Không phân tích được → nguồn mờ."""

    def work() -> _Sources:
        scan = _span_scan(ctx, sp, depth)
        if scan is None:
            return _Sources(read=["`"])
        return _scan_reads(ctx, scan, depth + 1).add(_gh_sources(ctx, scan, depth + 1))

    return ctx.cached(("f", sp[0], sp[1], depth), work)


def _gh_wrapped(argv: List[str]) -> bool:
    """Lệnh khác bọc `gh` đăng chữ trong chuỗi của nó (`sh -c 'gh … -F -' < f`) — guard không biết `gh` đọc gì từ stdin
    của nó (AUD-SEC-180)."""
    return not _gh_posts(argv) and bool(GH_POST_RE.search(" ".join(argv)))


def _gh_files(argv: List[str]) -> List[str]:
    """File cờ của `gh` đăng chữ trong argv — cả khi bị bọc (`xargs -I{} gh …`, `find … -exec gh … {} ;`, `parallel gh
    …`); giá trị là chuỗi thay chỗ lệnh bọc điền lúc chạy (`{}`, `-I R`) → nguồn mờ (AUD-SEC-179)."""
    k = next((i for i, t in enumerate(argv) if posixpath.basename(t) == "gh"), len(argv))
    args = normalize(argv[k:])[1:]
    files = _gh_api_files(args) if args[:1] == ["api"] else _gh_flag_files(args, split_at=False)
    ph = _placeholders(argv, any(posixpath.basename(t) in STDIN_FEEDERS for t in argv))
    return ["$" if PARALLEL_REPLACE_RE.search(f) or any(p in f for p in ph) else f for f in files]


def _nested_gh(ctx: _BodyScan, st: Stage, argv: List[str], depth: int) -> Tuple[_Sources, bool]:
    """(nguồn, có đọc stdin) của `gh` đăng chữ lồng trong thay lệnh của đoạn không phải `gh`: trong `$(…)`/`<(…)` nó
    đọc stdin của đoạn; trong `>(…)` stdin của nó là đầu ra của chính đoạn — nguồn là file đoạn đó đọc (review #361)."""
    out, stdin = _Sources(), False
    for sp in st.spans:
        if not _gh_post_text(sp[1]):
            continue
        sub = _span_gh(ctx, sp, depth)
        piped = sub.stdin()
        feeds = _any_reader_files(argv) if sp[0] == ">" and piped else []
        out.read.update(dict.fromkeys(feeds))
        stdin = stdin or (any(f in STDIN_PATHS for f in feeds) if sp[0] == ">" else piped)
        out.add(sub, sp[0] != ">")
    return out, stdin


def _body_sources(ctx: _BodyScan, st: Stage, depth: int) -> Tuple[_Sources, bool]:
    """(nguồn, có đọc stdin) của một đoạn lệnh: `gh` đăng chữ — `gh api -F k=@f`/`--field k=@f`/`--input f`, `gh
    pr|issue -F f`/`--body-file f` (giá trị nguyên văn, kể cả `x=@y`), `< f` (cả trước tên lệnh), file đọc trong thay
    lệnh sống của đoạn; lệnh bọc `gh` (`sh -c '…' < f`) — đích stdin, đọc stdin khi là shell/trình thông dịch; đoạn khác
    — nguồn của `gh` đăng chữ lồng trong thay lệnh (`_nested_gh`)."""
    argv = ctx.argv(st)
    if _gh_posts(argv):
        out = _Sources(own=_gh_files(argv) + _stdin_redirects(argv), posts=True)
        out.param = st.param
        for sp in st.spans:
            out.add(_span_files(ctx, sp, depth))
        return out, out.stdin()
    out, stdin = _nested_gh(ctx, st, argv, depth)
    if not _gh_wrapped(argv):
        return out, stdin
    head = posixpath.basename((normalize(argv) or [""])[0])
    out.own.update(dict.fromkeys(_gh_files(argv) + _stdin_redirects(argv)))
    out.param, out.posts = out.param or "$" in st.text, True
    return out, stdin or head in INTERPRETERS


SHELL_LEVEL_WORDS = {"exec", "}", "done", "fi", "esac"}  # chuyển hướng của chúng đổi stdin của lệnh khác


def _feed_sources(ctx: _BodyScan, st: Stage, depth: int) -> _Sources:
    """Nguồn một đoạn lệnh đưa vào stdin của `gh`: đoạn ghi vào ống (`cat f |`) — file của lệnh đọc và thay lệnh của
    nó; đoạn cấp shell hay nhóm lệnh (`exec < f`, `{ …; } < f`, `(…) <<< \\`cat f\\``, `done < f` — AUD-SEC-180) —
    đích stdin và thay lệnh của nó."""
    argv = ctx.argv(st)
    level = set(_no_redirects(argv)) <= SHELL_LEVEL_WORDS
    if st.op not in ("|", "|&") and not level:
        return _Sources()
    out = _Sources(read=_stdin_redirects(argv) if level else _stage_files(argv))
    for sp in st.spans:
        out.add(_span_files(ctx, sp, depth))
    return out


def _gh_sources(ctx: _BodyScan, scan: _ShellScan, depth: int) -> _Sources:
    """Nguồn của mọi `gh` đăng chữ trong chuỗi đã quét; `gh` đọc stdin thì thêm nguồn đưa vào stdin."""
    out, stdin = _Sources(), False
    for st in scan.stages:
        src, piped = _body_sources(ctx, st, depth)
        out.merge(src)
        stdin = stdin or piped
    for st in scan.stages if stdin else []:
        out.merge(_feed_sources(ctx, st, depth))
    return out


def _present(src: str, cwd: Optional[str]) -> bool:
    """Nguồn đọc có thể góp thân: tên mờ/fd, hay có trên đĩa (thư mục với lệnh không đệ quy thì không) — trần số nguồn
    đếm sau bước này, tên không có không làm chặn oan (review #361)."""
    path = src.lstrip(DIR_OK)
    if _vague(path) or _dev_path(path):
        return True
    full = os.path.join(cwd or ".", os.path.expanduser(path))
    try:
        os.lstat(full)
    except FileNotFoundError:
        return False
    except OSError:  # đường quá dài, quyền… — có thể có mà guard không thấy
        return True
    return not (src.startswith(DIR_OK) and os.path.isdir(full))


def _sources_marked(ctx: _BodyScan, found: _Sources, cwd: Optional[str]) -> bool:
    """Nguồn thân có (thể có) dấu: quá `REVIEW_BODY_FILES_MAX` nguồn (file `gh` đọc, cộng file lệnh khác đọc mà có trên
    đĩa) → coi như có; mỗi nguồn đọc một lần, kiểm hạn giờ trước mỗi file."""
    own = [f for f in found.own if f not in STDIN_PATHS]
    named = (f for f in found.read if f not in STDIN_PATHS and f.lstrip(DIR_OK) not in found.own and _present(f, cwd))
    names = list(itertools.islice(named, max(REVIEW_BODY_FILES_MAX + 1 - len(own), 0)))  # dừng khi đã quá trần
    if len(own) + len(names) > REVIEW_BODY_FILES_MAX:
        return True
    checks = [(f, REVIEW_BODY_FILE_BYTES) for f in own] + [(f.lstrip(DIR_OK), REVIEW_READ_BYTES) for f in names]
    for path, limit in checks:
        ctx.tick()
        if _file_has_mark(path, cwd, limit):
            return True
    return False


def _forges_review_cmd(cmd: str, tokens: List[str], cwd: Optional[str], budget: Optional["ScanBudget"] = None) -> bool:
    """Lệnh Bash đăng/sửa comment hay thân PR/issue mang dấu review: dấu nằm trong argv `gh`, ở bất kỳ đâu trong chuỗi
    lệnh (heredoc, `printf … > f &&`, `printf '…%s…' | gh -F -`) hay trong nguồn thân của chính lệnh `gh` đó
    (`_body_sources`; không đọc được → chặn) — AUD-SEC-157. Lệnh không đăng thì chữ nhắc dấu không bị chặn; file chỉ được
    nhắc tên (`--body "xem docs/ops/AUDIT-STATUS.md"`) không phải nguồn thân. `gh` có mở rộng tham số (`--body "$x"`) →
    nguồn là mọi file chuỗi lệnh đọc (review #361); token thấy `gh` đăng chữ mà bộ quét không thấy → mờ."""
    posts = [c for c in split_commands(tokens) if _gh_posts(c)]
    if posts and (REVIEW_MARK_RE.search(cmd) or any(_forges_review(c) for c in posts)):
        return True
    if not posts and not _gh_post_text(cmd):
        return False
    ctx, scan = _BodyScan(budget), _scan(cmd)
    if scan.open:
        return True
    found = _gh_sources(ctx, scan, 0)
    if posts and not found.posts:
        return True
    if found.param or _own_written(found, tokens, cwd):
        found.add(_scan_reads(ctx, scan, 0))
    return _sources_marked(ctx, found, cwd)


def _own_written(found: _Sources, tokens: List[str], cwd: Optional[str]) -> bool:
    """File thân của `gh` do chính chuỗi lệnh ghi ra (`cat f > x.md; gh … -F - < x.md`, `cp f x.md`, `>> x.md`) hay chưa
    có trên đĩa (lệnh trước sẽ tạo): file đọc lúc kiểm không phải thân thật → nguồn là mọi file chuỗi lệnh đọc (review
    #361 lượt 2)."""
    own = {posixpath.normpath(f) for f in found.own if f not in STDIN_PATHS}
    written = {posixpath.normpath(t) for c in split_commands(tokens) for t in write_targets(normalize(c), c)}
    return bool(own & written) or not all(_present(f, cwd) for f in own)


def _review_forge_hit(cmd: str, tokens: List[str], cwd: Optional[str], budget: Optional["ScanBudget"] = None) -> bool:
    """`_forges_review_cmd` mà lỗi khi quét (đầu vào lạ, hết hạn giờ) thì coi như có dấu — không để ngoại lệ thoát khỏi
    `bash_decision` (hook fail-open, tắt mọi luật đứng sau — review #354 lượt 2)."""
    try:
        return _forges_review_cmd(cmd, tokens, cwd, budget)
    except Exception:
        return True


def _gh_posts(argv: List[str]) -> bool:
    """`gh` đăng/sửa comment, review, thân PR/issue, hay `gh api` ghi."""
    n = normalize(argv)
    return bool(n) and n[0] == "gh" and bool(GH_POST_RE.search(" ".join(n)))


def _strings(value: object) -> Iterator[str]:
    """Mọi chuỗi thô trong `tool_input` (cả lồng trong danh sách/đối tượng) — không qua `json.dumps`, vốn thoát ký tự
    điều khiển (`\\n` sau `<!--`) làm regex dấu không khớp (AUD-SEC-156)."""
    stack = [value]
    while stack:
        v = stack.pop()
        if isinstance(v, str):
            yield v
        elif isinstance(v, dict):  # cả khoá — như `json.dumps` trước đây (review #354 lượt 3)
            stack.extend([*v.keys(), *v.values()])
        elif isinstance(v, list):
            stack.extend(v)


def mcp_decision(tool_name: str, tool_input: Dict[str, object], root: str) -> Tuple[str, str]:
    if MCP_REVIEW_POST_RE.fullmatch(tool_name) and any(REVIEW_MARK_RE.search(s) for s in _strings(tool_input)):
        return "deny", f"Lệnh bị khung chặn ({REVIEW_FORGE_WHY}): {tool_name}"
    hit = mcp_attribution(tool_name, tool_input, root) or mcp_title(tool_name, tool_input, root)
    if hit:
        return "deny", hit
    if not MCP_MERGE_RE.fullmatch(tool_name):
        return _mcp_actions_verdict(tool_name, tool_input)
    if tool_input.get("commit_title") is not None:  # subject squash tường minh đè PR_TITLE (AUD-HAR-128)
        return "deny", f"Lệnh bị khung chặn ({SQUASH_SUBJECT_WHY}): {tool_name}"
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
    if "commit_title" in fields and len(pos) == 1 and ANY_REST_MERGE_RE.fullmatch(_api_path(pos[0])):
        return "deny", SQUASH_SUBJECT_WHY
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


# `gh api` nhận URL đầy đủ: `https://api.github.com/repos/…`, GHES `https://<host>/api/v3/repos/…` (AUD-SEC-149).
# Host kết thúc ở `/` THÔ đầu tiên (như Go): khớp trước khi giải mã, để `%2F` trong userinfo không cắt host sớm.
API_URL_PREFIX_RE = re.compile(r"[a-z][a-z0-9+.-]*://[^/]*", re.I)
API_V3_RE = re.compile(r"/api/v3(?=/|$)", re.I)


def _api_path(p: str) -> str:
    """Đường dẫn REST như GitHub hiểu: giải mã `%xx`, bỏ query/fragment (`…/%6Derge?x=1` = `…/merge`) và scheme/host
    của URL đầy đủ (`https://api.github.com/repos/…` = `/repos/…`); URL không có đường dẫn giữ nguyên (host tên `graphql`
    vẫn đọc như endpoint graphql — chặt hơn, không nới)."""
    raw = p.split("?", 1)[0].split("#", 1)[0]
    m = API_URL_PREFIX_RE.match(raw)
    if not m or not urllib.parse.unquote(raw[m.end() :]).strip("/"):  # đường dẫn chỉ gồm `%2F` (AUD-SEC-152)
        return urllib.parse.unquote(raw)
    path = urllib.parse.unquote(raw[m.end() :])
    v3 = API_V3_RE.match(path)
    return path[v3.end() :] if v3 else path


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
    if name == "gh" and args[:2] == ["alias", "import"]:  # `alias set`: ADR-0063 lát C chặn trước
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
    if _gh_admin_flag(args[1:]):
        return "deny", ADMIN_MERGE_WHY
    if _merge_subject_flag(args[args.index("merge", 2) + 1 :]):
        return "deny", SQUASH_SUBJECT_WHY
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
        return [_assign_split(t)[0] for t in argv[1:] if ENV_ASSIGN_RE.fullmatch(t)]
    names: List[str] = []
    a = list(argv)
    while a:
        head = posixpath.basename(a[0])
        if ENV_ASSIGN_RE.fullmatch(a[0]):
            names.append(_assign_split(a.pop(0))[0])
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


# CLI agent KHÁC Claude Code không chạy hook của khung; chạy nó với cờ tự duyệt = đường vòng quanh guard (LOOP-STOP-028).
# Cờ `--x giá-trị` so cả `--x=giá-trị`. Nguồn 2026-10-18: docs CLI của Codex, Gemini, Copilot, opencode, aider, cursor
# (`cursor-agent` chưa xác minh), Amp (`--dangerously-allow-all`, chưa thấy ở docs chính thức).
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
# Tên binary khác của cùng CLI: Cursor CLI cài `agent` cùng `cursor-agent` (AUD-SEC-377, review #418) — tên chung nên
# chặn cả công cụ khác tên `agent` dùng cờ trùng (hướng chặt, LOOP-STOP-028).
AGENT_CLI_ALIASES = {"agent": "cursor-agent"}


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


def _agent_cli(n: List[str], explicit: bool = False) -> Tuple[str, List[str], str]:
    """(tên CLI agent, tham số, tên chung đã gọi — `agent` — khi gọi qua đường dẫn tường minh (`explicit`: `./bin/agent`)
    hay trình chạy gói (`npx agent`); binary trần `agent` giữ luật của `cursor-agent` — review #426) khi lệnh gọi một CLI
    agent khác Claude Code (trực tiếp hoặc qua npx/uvx/pipx…)."""
    name, i = posixpath.basename(n[0]), 1
    t = max(_runner_target(n), _py_runner_target(n))
    if t >= 0:
        name, i = n[t], t + 1
    name = AGENT_CLI_PKGS.get(_pkg_base(name), _pkg_base(name))
    alias = name if name in AGENT_CLI_ALIASES and (explicit or t >= 0) else ""
    name = AGENT_CLI_ALIASES.get(name, name)
    args = n[i:]
    if t >= 0 and args[:1] == ["--"]:  # `npx <gói> -- <args>`: `--` của trình chạy, không phải của CLI
        args = args[1:]
    return (name, args, alias) if name in AGENT_SELF_APPROVE else ("", [], "")


# AUD-SEC-385 (review #420/#426): tên chung `agent` gọi qua đường dẫn tường minh (`./bin/agent`) hay `npx agent` — `-f`/
# `--force` chỉ tính là tự duyệt khi có `-p`/`--print` (cả cụm `-fp`); binary trần `agent` và `cursor-agent` như base
# (tài liệu Cursor: `-f` "Force allow commands unless explicitly denied", không cần `--print`).
AGENT_ALIAS_PRINT_ONLY = {"agent": frozenset({"-f", "--force"})}
AGENT_PRINT_RE = re.compile(r"--print|-[A-Za-z]*p[A-Za-z]*")


def _alias_skips(alias: str, args: List[str]) -> FrozenSet[str]:
    """Cờ tự duyệt không tính khi gọi bằng tên chung mà không có `-p`/`--print` (trước `--`)."""
    opts = itertools.takewhile(lambda a: a != "--", args)
    printing = any(AGENT_PRINT_RE.fullmatch(a) for a in opts)
    return frozenset() if printing else AGENT_ALIAS_PRINT_ONLY.get(alias, frozenset())


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
    name, args, alias = _agent_cli(n, "/" in "".join(_strip_prefixes(argv)[:1]))
    if not name:
        return ""
    env = AGENT_SELF_APPROVE_ENV.get(name, "")
    if env and (env in _env_assigns(argv) or env in exported):
        return f"CLI agent `{name}` với `{env}` tự duyệt mọi lệnh ngoài guard — bỏ qua hook của dự án (LOOP-STOP-028)"
    skip = _alias_skips(alias, args)
    for k, a in enumerate(args):
        if a == "--":
            break
        hit = _self_approve_flag(name, a, args[k + 1] if k + 1 < len(args) else "")
        if hit and hit not in skip:
            return (
                f"CLI agent `{name}` với `{hit}` tự duyệt mọi lệnh ngoài guard — bỏ qua hook của dự án (LOOP-STOP-028)"
            )
    return ""


def hook_bypass(
    argv: List[str], n: List[str], exported: Tuple[str, ...] = (), env: Optional[Dict[str, str]] = None
) -> str:
    """Lý do hỏi nếu lệnh tắt/bỏ qua hook của dự án; chuỗi rỗng nếu không. `exported`: tên biến đã `export` trước đó
    trong chuỗi; `env`: biến (kèm giá trị) mà chuỗi lệnh đã đặt (`_track_env`)."""
    claude = _claude_args(n) or []
    hit = _bypass_marker(argv, n, claude)
    if hit:
        return f"lệnh đặt `{hit}` (tắt hook của khung)"
    if _git_hooks_off(n):
        return "tắt git hook của dự án (`core.hooksPath`) — bỏ qua hook của dự án"
    rewrite = _git_config_rewrite_why(n)
    if rewrite:
        return rewrite
    key = _git_exec_config(n, argv, env) if n[:1] == ["git"] else ""
    if key and GIT_APPENDED_KEY_RE.match(key):
        return (
            f"khoá cấu hình git một lần bị nối thêm (`{key}`) — không biết khoá nào, có thể là khoá chạy lệnh ngoài guard"
            " — bỏ qua hook của dự án"
        )
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
    r"|sendemail\.(.+\.)?(\w*cmd|smtpserver)|init\.templatedir|uploadpack\.packobjectshook|submodule\..+\.update|delta\.pager"
    r"|gc\.recentobjectshook|interactive\.difffilter|imap\.tunnel|instaweb\.httpd"  # AUD-SEC-461, git-config(1) 2.43.0
    # AUD-SEC-485: `sendemail.<identity>.*` (`git help --config` 2.43.0) — `sendmailCmd`/`smtpServer` là đường lệnh
    r"|.+\.(textconv|clean|smudge|process|driver|cmd|command|program|helper|uploadpack|receivepack|path)",
    re.I,
)
# Khoá cấu hình một lần nối thêm (`GIT_CONFIG_KEY_0+=core.fsmonitor`, `GIT_CONFIG_PARAMETERS+=…` — `_assign_split`):
# phần đầu là giá trị cũ guard không biết → có thể là khoá chạy lệnh bất kỳ (AUD-SEC-125).
GIT_APPENDED_KEY_RE = re.compile(r"\$\{GIT_CONFIG_(?:KEY_\d+|PARAMETERS)\}")
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
    found = ""  # git ghi vào `--file` CUỐI (review #438: `--file <trần>/config --file .git/config`)
    for k, a in enumerate(n[2:], start=2):
        if a in ("-f", "--file") and k + 1 < len(n):
            found = n[k + 1]
        elif a.startswith("--file="):
            found = a.split("=", 1)[1]
    return found


def _git_config_edit(n: List[str]) -> bool:
    """`git config -e|--edit` (cả viết tắt `--ed`, cụm cờ ngắn có `e`) hay lệnh con `git config edit`: trình soạn thảo
    ghi nội dung tuỳ ý vào tệp cấu hình — luật khoá không thấy (AUD-SEC-452)."""
    args = list(itertools.takewhile(lambda a: a != "--", n[2:]))
    pos = [a for a in args if not a.startswith("-")]  # thô: tên tệp của `-f X` cũng vào đây → xét hai chỗ đầu
    return "edit" in pos[:2] or any(
        _long_match(a, ("--edit",)) or re.fullmatch(r"-[A-Za-z]*e[A-Za-z]*", a) for a in args
    )


def _git_exec_value_unsafe(key: str, value: str) -> bool:
    """Giá trị đặt cho khoá chạy lệnh có thể chạy lệnh tuỳ ý: chỉ giá trị khớp nguyên văn `GIT_SAFE_VALUES` là an toàn."""
    v = value.strip()
    return not any(k.fullmatch(key) and ok.fullmatch(v) for k, ok in GIT_SAFE_VALUES)


# AUD-SEC-456: section mà `git config --remove-section|--rename-section` (cả lệnh con `remove-section|rename-section`)
# xoá/dời đi là bỏ khoá bảo vệ — `core` (hooksPath, khoá chạy lệnh), `include`/`includeIf` (tệp có thể đặt hooksPath),
# `alias`. Đích của `--rename-section` thêm khoá vào section mới: khoá chạy lệnh nằm trong section có tên con
# (`filter.x.clean`, `remote.x.uploadpack`) hay section riêng (`credential.helper`, `core.*`) → chỉ cho đích không tên
# con thuộc danh sách dưới (không có khoá chạy lệnh trong git-config(1)); tên là biến/glob → không biết, chặn. `gc` bị
# loại (AUD-SEC-461: `gc.recentObjectsHook` chạy lệnh — đối chiếu `git help --config` của git 2.43.0).
GIT_CONFIG_GUARDED_SECTIONS = frozenset({"core", "include", "includeif", "alias"})
GIT_CONFIG_RENAME_SAFE = frozenset(
    "user author committer color push pull status log i18n column advice rerere pack tag fetch".split()
)
GIT_CONFIG_INCLUDE_KEY_RE = re.compile(r"include\.path|includeif\..+\.path", re.I)


def _git_config_rewrite_why(n: List[str]) -> str:
    """`git config --edit` (mọi phạm vi: dự án, `--global`, `-C <repo trần>` — AUD-SEC-455: trình soạn thảo ghi cấu
    hình luật khoá không thấy) và xoá/đổi tên section chứa khoá bảo vệ, `--unset` khoá include (AUD-SEC-456)."""
    if n[:2] != ["git", "config"]:
        return ""
    if _git_config_edit(n):
        return "`git config --edit`: trình soạn thảo ghi cấu hình git guard không đọc (khoá chạy lệnh, `core.hooksPath`) — bỏ qua hook của dự án (AUD-SEC-455)"
    opts = [a.partition("=")[0] for a in n[2:] if a.startswith("--")]
    pos = _positionals(n[2:], GIT_CONFIG_VALUE_OPTS)
    sub = pos[0] if pos[:1] and pos[0] in ("remove-section", "rename-section", "unset") else ""
    names = pos[1:] if sub else pos
    remove = sub == "remove-section" or any(_long_match(o, ("--remove-section",)) for o in opts)
    rename = sub == "rename-section" or any(_long_match(o, ("--rename-section",)) for o in opts)
    unset = sub == "unset" or bool(set(n) & GIT_CONFIG_UNSET) or any(_long_match(o, ("--unset-all",)) for o in opts)

    def unknown(name: str) -> bool:
        return bool(re.search(r"[$`*?\[\\]", name))

    def guarded(name: str) -> bool:
        return unknown(name) or name.split(".", 1)[0].lower() in GIT_CONFIG_GUARDED_SECTIONS

    hit = ""
    if (remove or rename) and names[:1] and guarded(names[0]):
        hit = names[0]
    elif rename and names[1:2] and (unknown(names[1]) or names[1].lower() not in GIT_CONFIG_RENAME_SAFE):
        hit = names[1]
    elif unset and names[:1] and (unknown(names[0]) or GIT_CONFIG_INCLUDE_KEY_RE.fullmatch(names[0])):
        hit = names[0]
    if not hit:
        return ""
    return (
        f"`git config` xoá/đổi tên section hay khoá bảo vệ (`{hit}`: hooksPath, khoá chạy lệnh, alias, include)"
        " — bỏ qua hook của dự án (AUD-SEC-456)"
    )


def _git_hooks_off(n: List[str]) -> bool:
    """`git config [--global] core.hooksPath <x>` hoặc `--unset core.hooksPath` (husky `.husky/_` mất): git hook của dự
    án thôi chạy cho mọi commit sau."""
    pos = _git_config_write(n)
    return bool(pos) and pos[0].lower() == "core.hookspath" and (len(pos) > 1 or bool(set(n) & GIT_CONFIG_UNSET))


def _git_oneshot_config(argv: List[str], exported: Optional[Dict[str, str]] = None) -> List[Tuple[str, str]]:
    """(khoá, giá trị) cấu hình một lần của lệnh git `argv` qua MỌI kênh (review #306): `-c k=v`/`-ck=v`,
    `--config-env[=]k=VAR`, mọi `GIT_CONFIG_KEY_<i>`/`GIT_CONFIG_VALUE_<i>` (kể cả i ≥ COUNT — chiều chặt),
    `GIT_CONFIG_PARAMETERS`. Biến = gán ở đầu lệnh ∪ `exported` (gán/`export` ở lệnh trước trong chuỗi — D-216). VAR của
    `--config-env` không gán ở đâu cả, không có trong môi trường của guard (có thể đến từ `source`, `read`…) → giá trị
    `${VAR}`: guard không biết, khoá chạy lệnh tính là không an toàn (như `_push_spread_opt`)."""
    env, pairs = _oneshot_env_pairs(argv, exported)
    for opt, val in _git_globals(_strip_prefixes(argv)):
        key, _, v = val.partition("=")
        if opt == "-c":
            pairs.append((key, v))
        elif opt == "--config-env":
            pairs.append((key, env.get(v, os.environ.get(v, "${" + v + "}"))))
    return pairs


def _oneshot_env_pairs(
    argv: List[str], exported: Optional[Dict[str, str]] = None
) -> Tuple[Dict[str, str], List[Tuple[str, str]]]:
    """(biến của lệnh, [(khoá, giá trị)] từ `GIT_CONFIG_KEY_<i>`/`VALUE_<i>` và `GIT_CONFIG_PARAMETERS`): gán đầu lệnh ∪
    `exported` — dùng cho cả lệnh không phải git (biến kế thừa xuống git con, D-366)."""
    s = _strip_prefixes(argv)
    env = {**(exported or {}), **_assign_values(argv[: len(argv) - len(s)])}
    keys = sorted((k for k in env if re.fullmatch(r"GIT_CONFIG_KEY_\d+", k)), key=lambda k: int(k[15:]))
    pairs = [(env[k], env.get("GIT_CONFIG_VALUE_" + k[15:], "")) for k in keys]
    pairs += [(k, v) for w in _split_words(env.get("GIT_CONFIG_PARAMETERS", "")) for k, _, v in [w.partition("=")]]
    return env, pairs


def _git_exec_config(n: List[str], argv: Optional[List[str]] = None, exported: Optional[Dict[str, str]] = None) -> str:
    """Khoá git chạy lệnh tuỳ ý: đặt bằng `git config` hoặc một lần (`-c`, `--config-env`, `GIT_CONFIG_*`); rỗng nếu
    không. Khoá là biến (`-c "$K=$V"`, `GIT_CONFIG_PARAMETERS=$P`) chưa xét ở đây (giới hạn — harness-files.md)."""
    pos = _git_config_write(n)
    if len(pos) >= 2 and GIT_EXEC_KEY_RE.fullmatch(pos[0]) and _git_exec_value_unsafe(pos[0], pos[1]):
        return pos[0]
    one_shot = _git_oneshot_config(argv, exported) if argv and n[:1] == ["git"] else []
    # URL `ext::` chỉ ở lệnh con nhận URL/cấu hình và ở cấu hình một lần — không quét `commit -m "… ext:: …"`.
    scan = n[2:] if n[1:2] and n[1] in GIT_URL_SUBCMDS else []
    scan += [f"{k}={v}" for k, v in one_shot]
    if any(GIT_EXT_URL_RE.search(a) for a in scan):  # `git fetch ext::…`, `remote add x ext::…`, `insteadOf`
        return "ext::"
    for key, val in one_shot:
        if GIT_APPENDED_KEY_RE.match(key) or GIT_EXEC_KEY_RE.fullmatch(key) and _git_exec_value_unsafe(key, val):
            return key
    return ""


# `<>`: mở đọc-ghi (tạo file nếu chưa có) — `exec 3<> .env`, `1<> .env` là ghi (review #186 lần 3); số fd đứng trước
# (`3<>`) là token riêng sau khi tách
REDIRECTS = (">", ">>", ">|", "&>", "&>>", "<>")


# Bảng getopt của cp/mv/ln/install — HỢP tên dài của coreutils 9.7 (`--help`, đo 2026-11-05: cp `--keep-directory-symlink`,
# mv `--exchange`) và uutils 0.8.0 (`install`/`ln` mặc định của Ubuntu 26.04: install `--unprivileged`; uutils cp/mv
# chưa xác minh) — AUD-SEC-495. `-t`/`-S` (install thêm `-g -m -o`) ăn giá trị; tên dài viết tắt được (`--t D` =
# `--target-directory D` — AUD-SEC-469), viết tắt mơ hồ xét mọi tên khớp (`_long_names`).
_COPY_LONG = ("backup", "help", "no-target-directory", "suffix", "target-directory", "verbose", "version")
_CP_MV = ("context", "debug", "force", "interactive", "no-clobber", "strip-trailing-slashes", "update")
_CP_ONLY: Tuple[str, ...] = (
    "archive",
    "attributes-only",
    "copy-contents",
    "dereference",
    "link",
    "no-dereference",
    "no-preserve",
)
_CP_ONLY += ("one-file-system", "parents", "preserve", "recursive", "reflink", "remove-destination", "sparse")
_CP_ONLY += ("keep-directory-symlink",)
_LN_ONLY = ("directory", "force", "interactive", "logical", "no-dereference", "physical", "relative", "symbolic")
_INSTALL_ONLY: Tuple[str, ...] = (
    "compare",
    "context",
    "debug",
    "directory",
    "group",
    "mode",
    "owner",
    "preserve-context",
)
_INSTALL_ONLY += ("preserve-timestamps", "strip", "strip-program", "unprivileged")
_COPY_VAL = ("suffix", "target-directory")  # bắt buộc giá trị ở cả bốn lệnh
COPY_OPT_TABLES: Dict[str, OptTable] = {
    "cp": ("St", _COPY_LONG + _CP_MV + _CP_ONLY + ("symbolic-link",), _COPY_VAL + ("no-preserve", "sparse"), True),
    "mv": ("St", _COPY_LONG + _CP_MV + ("exchange", "no-copy"), _COPY_VAL, True),
    "ln": ("St", _COPY_LONG + _LN_ONLY, _COPY_VAL, True),
    "install": ("Sgmot", _COPY_LONG + _INSTALL_ONLY, _COPY_VAL + ("group", "mode", "owner", "strip-program"), True),
}


def _copy_opts(name: str, args: List[str]) -> Tuple[List[str], List[str], Set[str]]:
    """(thư mục `-t`, toán hạng, khoá cờ) của cp/mv/ln/install."""
    items = _getopt(args, COPY_OPT_TABLES[name])
    return _opt_vals(items, "t", "target-directory"), _operands(items), _opt_keys(items)


def _copy_targets(name: str, args: List[str]) -> List[str]:
    """cp/install/ln: thư mục `-t` hoặc đích cuối; mv: cả nguồn (bị dời đi = xoá ở chỗ cũ) lẫn đích (AUD-SEC-019);
    `install -d|--directory D…` tạo MỌI toán hạng (AUD-SEC-495)."""
    t_dirs, pos, keys = _copy_opts(name, args)
    if name == "install" and keys & {"d", "directory"}:
        return pos + t_dirs
    if t_dirs:  # `-t DIR nguồn…`: file đích là DIR/<tên nguồn>
        dests = [posixpath.join(t, posixpath.basename(s.rstrip("/"))) for t in t_dirs for s in pos]
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
    pos = _rsync_pos(args)
    return pos[-1:] if len(pos) >= 2 and ":" not in pos[-1] else []


def _scp_dest(args: List[str]) -> List[str]:
    """`scp [cờ] nguồn… đích`: đích cục bộ (không `host:`/`scp://`) bị ghi như `cp` (AUD-SEC-449, review #438); `-t D`
    (chế độ nhận ẩn của OpenSSH, ghi tệp từ stdin vào D — scp.c, chưa đo: máy không có scp) → D."""
    items = _getopt(args, SCP_OPTS)
    pos = _operands(items)
    many = len(pos) >= 2 or "t" in _opt_keys(items)
    return pos[-1:] if pos and many and not REMOTE_SPEC_RE.match(pos[-1]) else []


SCP_OPTS: OptTable = ("cDFiJloPSX", (), (), False)  # scp(1) OpenSSH: cờ ngắn ăn giá trị, không tên dài


def _patch_targets(args: List[str]) -> List[str]:
    """patch [tuỳ chọn] [file gốc [file patch]]: file gốc bị sửa tại chỗ; `-o f` ghi ra f."""
    pos = _positionals(args, ("-i", "-o", "-d", "-B", "-r", "-z", "-V", "-D", "-F", "-g", "--output", "--input"))
    return pos[:1] + _flag_values(args, ("-o", "--output"))


# `w f`, `1w f`, `$w f`, `/a/!w f`, `s/a/b/w f`, `s|a|b|w f`: lệnh `w` của sed (sau địa chỉ/cờ của `s`) ghi file; `W f`
# (GNU: ghi dòng đầu của pattern space) cũng ghi file (AUD-SEC-398); GNU nhận tên tệp dính liền (`Wf`) và lệnh đầu dòng
# sau xuống dòng (`1{` ↵ `W f` ↵ `}`) — review adr-guard. Bắt rộng (`s/a/w/` cho đích giả `/`): đích chỉ xét vùng rào.
SED_WRITE_RE = re.compile(r"(?:^|[0-9]|[^\w\s][gpIiMme0-9]*)[ \t]*[wW][ \t]*([^;\n}]+)", re.M)
AWK_WRITE_RE = re.compile(r">>?[ \t]*\"([^\"\n]+)\"")  # `print > "f"` trong chương trình awk


def _sed_scripts(args: List[str]) -> List[str]:
    """Script của sed: giá trị `-e`/`--expression`, không có thì đối số vị trí đầu."""
    exprs = _flag_values(args, ("-e", "--expression"))
    return exprs or _positionals(args, ("-f", "--file", "-l", "--line-length"))[:1]


def _sed_writes(args: List[str]) -> List[str]:
    return [m.group(1).strip() for sc in _sed_scripts(args) for m in SED_WRITE_RE.finditer(sc)]


# Đọc chương trình sed như GNU sed 4.9 (review adr-guard lượt 2 🟠): `SED_WRITE_RE` bắt rộng cho đích trong vùng rào; miễn
# trừ AUD-SEC-384 cần biết chương trình CÓ lệnh ghi thật hay không — chữ `w` trong mẫu/thay thế (`s/Week/…/`) không tính.
SED_ADDR_CHARS = frozenset(" \t\n;0123456789$,~+!")  # số dòng, `$`, khoảng, bước, phủ định, phân cách lệnh
SED_PLAIN_CMDS = frozenset("{}=dDgGhHlLnNpPxzFqQ")  # lệnh không đối số (số sau q/Q/l/L đọc như địa chỉ — vô hại)
SED_LABEL_CMDS = frozenset("btT:v")  # đối số tới `;`/xuống dòng (GNU 4.9: `:a;w f` ghi f — đã chạy)
SED_FLAG_CHARS = frozenset("gpiImM0123456789 \t")  # cờ của `s` không ghi/chạy gì


def _sed_has_write(script: str, bad: str = "wWe") -> bool:
    """Chương trình có lệnh ghi tệp (`w`/`W`, cờ `w` của `s`) hay chạy shell (`e`, cờ `e`); đọc không chắc → True.
    `bad`: chữ lệnh coi là có hại (ADR-0066 thêm `r`/`R` — đọc tệp khác)."""
    i = 0
    while i < len(script):
        i = _sed_skip_address(script, i)
        if i < 0 or (i < len(script) and script[i] in bad):
            return True
        i = _sed_command_end(script, i) if i < len(script) else i
        if i < 0:
            return True
    return False


def _sed_skip_address(s: str, i: int) -> int:
    """Vị trí ký tự lệnh sau địa chỉ (`1`, `$`, `/re/I`, `\\%re%`, `a,+2`, `0~3`, `!`) và dấu phân cách; -1 = mẫu không đóng."""
    while i < len(s) and i >= 0:
        if s[i] in SED_ADDR_CHARS:
            i += 1
        elif s[i] in "/\\":
            i = _sed_part_end(s, i + 1 + (s[i] == "\\"), s[i + (s[i] == "\\") : i + 1 + (s[i] == "\\")], True)
            while 0 <= i < len(s) and s[i] in "IM":
                i += 1
        else:
            break
    return i


def _sed_command_end(s: str, i: int) -> int:
    """Vị trí sau lệnh ở `s[i]` (không phải `w`/`W`/`e`); -1 = lệnh lạ hay đọc không chắc."""
    c = s[i]
    if c in SED_PLAIN_CMDS:
        return i + 1
    if c in "aicrR#":
        return _sed_line_end(s, i, c in "aic")
    if c in SED_LABEL_CMDS:
        return min((k for k in (s.find(";", i), s.find("\n", i)) if k >= 0), default=len(s))
    if c not in "sy":
        return -1
    d = s[i + 1 : i + 2]
    if not d or d.isalnum() or d.isspace() or d == "\\":
        return -1
    j = _sed_part_end(s, _sed_part_end(s, i + 2, d, c == "s"), d, False)
    while c == "s" and 0 <= j < len(s) and s[j] in SED_FLAG_CHARS:
        j += 1
    return -1 if c == "s" and 0 <= j < len(s) and s[j] not in ";\n}" else j


def _sed_part_end(s: str, i: int, d: str, regex: bool) -> int:
    """Vị trí sau dấu phân cách `d` đóng phần bắt đầu ở `s[i]`: `\\x` là một ký tự; trong mẫu (`regex`), biểu thức ngoặc
    `[…]` (`]` đầu là chữ; `\\` trong ngoặc là chữ) chứa được `d` (`s/[/]/X/` — GNU 4.9); xuống dòng trơn/không đóng → -1."""
    while 0 <= i < len(s):
        c = s[i]
        if c == d:
            return i + 1
        if c == "\n":
            return -1
        if regex and c == "[":
            k = i + 1 + (s[i + 1 : i + 2] == "^")
            k = s.find("]", k + (s[k : k + 1] == "]"))
            i = k + 1 if k >= 0 else -1
            continue
        i += 2 if c == "\\" else 1
    return -1


def _sed_line_end(s: str, i: int, text: bool) -> int:
    """Vị trí sau dòng của lệnh có đối số tới hết dòng (`r f`, `# c`); văn bản `a`/`i`/`c` nối dòng kết bằng `\\`."""
    j = s.find("\n", i)
    while text and j > 0 and s[j - 1] == "\\":
        j = s.find("\n", j + 1)
    return len(s) if j < 0 else j + 1


def _awk_targets(args: List[str]) -> List[str]:
    """awk: `-i inplace` sửa tại chỗ các file đầu vào; `print > "f"` trong chương trình ghi f."""
    pos = _positionals(args, ("-f", "-v", "-F", "-i", "--include", "--file", "--assign", "--field-separator"))
    prog = [] if _flag_values(args, ("-f", "--file")) else pos[:1]
    out = [m.group(1) for p in prog for m in AWK_WRITE_RE.finditer(p)]
    inplace = "inplace" in _flag_values(args, ("-i", "--include"))
    return out + (pos[len(prog) :] if inplace else [])


def _tar_dest(args: List[str]) -> List[str]:
    """Thư mục giải nén của `tar -x … -C d` (tạo/liệt kê lưu trữ với `-C` chỉ đọc thư mục đó) và tệp archive mà chế độ
    tạo/ghi archive ghi ra (`tar -czf F` — AUD-SEC-475)."""
    opts = _tar_opts(args)
    dirs = _opt_vals(opts, "C", "directory") if _opt_keys(opts) & TAR_EXTRACT else []
    return dirs + _tar_archives(opts)


# Tuỳ chọn truyền qua biến môi trường, ghép vào trước argv (AUD-SEC-474): GNU tar `TAR_OPTIONS` (đo trên tar 1.35: kiểu
# cũ `xf` vẫn đọc được), UnZip `UNZIP`/`UNZIPOPT` (đo trên UnZip 6.00 Debian) — gán đầu lệnh, `env`, `export` trước đó.
ENV_OPTS = {"tar": ("TAR_OPTIONS",), "gtar": ("TAR_OPTIONS",), "unzip": ("UNZIP", "UNZIPOPT")}


def _with_env_opts(n: List[str], argv: List[str], env: Optional[Dict[str, str]]) -> List[str]:
    """`n` với tuỳ chọn từ biến môi trường của lệnh ghép vào sau tên lệnh (kiểu cũ của tar nở trước); tar thêm `TAPE`
    (`_with_tape`)."""
    names = ENV_OPTS.get(n[0], ()) if n else ()
    tar = bool(n) and n[0] in TAR_NAMES
    vals = {**(env or {}), **_assign_values(argv[: len(argv) - len(_strip_prefixes(argv))])} if names or tar else {}
    extra = [w for k in names for w in _split_words(vals.get(k, ""))]
    out = [n[0], *extra, *(_old_style(n[1:], TAR_SHORT_VALUE) if n[0] != "unzip" else n[1:])] if extra else n
    return _with_tape(out, vals.get("TAPE")) if tar else out


def _with_tape(n: List[str], tape: Optional[str]) -> List[str]:
    """AUD-SEC-492: GNU tar (1.35, `archive_name_array` mặc định) và bsdtar dùng biến `TAPE` làm archive khi không có
    `-f`/`--file` (kể cả từ `TAR_OPTIONS`) — ghi khi tạo/nối, đọc khi giải nén: xét như `--file=TAPE`."""
    if tape is None or _opt_vals(_tar_opts(n[1:]), "f", "file"):
        return n
    return [n[0], "--file=" + tape, *_old_style(n[1:], TAR_SHORT_VALUE)]


def _extract_here(n: List[str]) -> List[str]:
    """Mọi thư mục lệnh giải nén ghi vào, cả đích ngầm `.` = thư mục đang đứng (AUD-SEC-458/462). `tar|gtar|bsdtar`
    đọc cờ theo `_tar_opts` (chữ ăn giá trị dừng cụm: `-xfO a` là archive `O`, không phải ra stdout; `-xC d`,
    `--directory=d`, kiểu cũ `xfC a d`), trừ ra stdout (`-O`, `--to-stdout`, `--to-command`); `unzip` (`-P -d` là mật
    khẩu `-d`), `7z x|e`, `cpio -i`, `jar x`, `python -m zipfile -e` theo `_unpack_dirs`; `pax -r` (`_pax_dirs`)."""
    name, args = (n[0], n[1:]) if n else ("", [])
    if name in TAR_NAMES:
        keys = _opt_keys(_tar_opts(args))
        return [] if keys & {"O", "to-stdout", "to-command"} else _tar_extract_dirs(args)
    return _pax_dirs(args) if name == "pax" else _unpack_dirs(name, args)


PAX_SHORT_VALUE = "bfopsxBEGTU"  # cờ ngắn của pax(1) POSIX ăn một giá trị


def _pax_dirs(args: List[str]) -> List[str]:
    """`pax -r` (đọc) giải nén vào thư mục đang đứng; `-r -w` (chép) ghi vào toán hạng cuối; không `-r` → không ghi."""
    flags, pos, _ = _parse_opts(args, PAX_SHORT_VALUE, ())
    if "-r" not in flags:
        return []
    return pos[-1:] if "-w" in flags else ["."]


def _pax_archive(args: List[str]) -> List[str]:
    """`pax -w -f F` (ghi archive, không `-r`) ghi F (AUD-SEC-475)."""
    flags, _, vals = _parse_opts(args, PAX_SHORT_VALUE, ())
    return [v for k, v in vals if k == "-f"] if "-w" in flags and "-r" not in flags else []


UNIQ_VALUE_OPTS = ("-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars")


def _uniq_output(args: List[str]) -> List[str]:
    """Toán hạng thứ hai của `uniq [cờ] [IN [OUT]]` — `-` là toán hạng (stdin), sau `--` mọi token là toán hạng."""
    words = _no_redirects(args)
    k = words.index("--") if "--" in words else len(words)
    head = words[:k]
    pos = [
        a for i, a in enumerate(head) if (a == "-" or a[:1] != "-") and (i == 0 or head[i - 1] not in UNIQ_VALUE_OPTS)
    ]
    return (pos + words[k + 1 :])[1:2]


def _archive_writer(name: str) -> Callable[[List[str]], List[str]]:
    """Hàm đích ghi của trình tạo archive `name` (`_archive_outputs` định nghĩa sau, gọi lúc chạy)."""
    return lambda a: _archive_outputs(name, a)


FILE_WRITERS: Dict[str, Callable[[List[str]], List[str]]] = {
    "curl": _curl_outputs,
    "wget": _wget_outputs,
    "rsync": _rsync_dest,
    "scp": _scp_dest,
    "patch": _patch_targets,
    "sort": lambda a: _flag_values(a, ("-o", "--output")),
    "awk": _awk_targets,
    "gawk": _awk_targets,
    "tar": _tar_dest,
    "gtar": _tar_dest,
    "bsdtar": _tar_dest,
    "unzip": lambda a: _unzip_parse(a)[0],
    # tệp archive tạo ra là đích ghi (AUD-SEC-475)
    **{k: _archive_writer(k) for k in ("zip", "jar", "ar", "cpio", "pax", "7z", "7za", "7zr", "7zz")},
    "split": lambda a: _positionals(a, ("-l", "-b", "-C", "-n", "-a", "-t", "--additional-suffix"))[1:2],
    "csplit": lambda a: _flag_values(a, ("-f", "--prefix")),
    "dd": lambda a: [x[3:] for x in a if x.startswith("of=")],  # review #186 lần 2: `dd of=.env` là ghi
    "uniq": _uniq_output,  # review #426: `uniq IN OUT` ghi OUT (`uniq - x.sh <<< '…'`)
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
    "update-index": lambda a: [p.rsplit(",", 1)[-1] for p in _positionals(a)],  # `--cacheinfo m,sha,path`
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
    created = _py_archive(args)[1] if PY_UNPACK_RE.fullmatch(name) else []  # `python -m zipfile -c F` (AUD-SEC-475)
    return out + created + _inplace_targets(name, args)


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


PERM_CMDS = ("chmod", "chown", "chgrp", "chattr", "setfacl")
PERM_NO_TARGET_WHY = "đổi quyền không rõ đích (xargs/stdin) — guard không thấy file"
PERM_VALUE_FLAGS: Tuple[str, ...] = ("-m", "--modify", "-x", "--remove", "-M", "--modify-file", "-X", "--remove-file")
PERM_VALUE_FLAGS += ("--set", "--set-file", "--restore", "-v", "-p")  # setfacl, chattr


def _fence_glob(target: str, root: str) -> bool:
    """Glob (`.claude/*/guard.py`) shell nở ra file hàng rào — so theo đoạn như shell: `*` không qua `/`, không khớp
    dotfile (T-3532)."""
    pat = _rel_dir(target, root).split("/")
    if not set("".join(pat)) & set("*?["):
        return False
    try:
        names = os.listdir(os.path.join(root, ".claude", "hooks"))
    except OSError:
        names = ["guard.py"]
    known = [*FENCE_DIRS, ".claude/settings.json", ".claude/settings.local.json"]
    segs = [k.split("/") for k in [*known, *(".claude/hooks/" + f for f in names)]]
    return any(
        len(k) == len(pat) and all((s[:1] != "." or p[:1] == ".") and fnmatch.fnmatchcase(s, p) for p, s in zip(pat, k))
        for k in segs
    )


def _is_fence(target: str, root: str) -> bool:
    if not target or _norm_path(target).startswith("/dev/"):  # `/dev/../<gốc>/…` không phải thiết bị (AUD-SEC-511)
        return False
    rel = _rel_dir(target, root)
    return rel in FENCE_DIRS or _match_any(rel, FENCE_PATTERNS) or _fence_glob(target, root)


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
    ("docs", frozenset({"autopilot"})),  # sổ giai đoạn `STAGE_LEDGER` (AUD-SEC-512)
    ("docs/autopilot", frozenset({posixpath.basename(STAGE_LEDGER)})),
)
UP_LEAD_RE = re.compile(r"^(?:\.\.(?:/|$))+")  # `..` đầu đường đã chuẩn hoá


def _where(t: str, root: str, cwd: Optional[str]) -> List[str]:
    """Các đích có thể của `t`: thư mục biết → một đích (`_resolve_target`); không biết (None) → gốc dự án cộng thư mục
    canh nào có file đó hoặc tên được canh (D-106). `~-/x`, `$OLDPWD/x` = `x` ở thư mục không biết (AUD-SEC-097)."""
    old = OLDPWD_REF_RE.match(t)
    if old:
        return _where(t[old.end() :].lstrip("/") or ".", root, None)
    if cwd is not None:
        return _fd_where(_resolve_target(t, root, cwd), root, cwd)
    t = PROJECT_REF_RE.sub(lambda _: root, t, count=1)
    pwd = PWD_REF_RE.match(t)  # `$PWD/x` khi thư mục không biết = `x` tương đối
    t = (t[pwd.end() :].lstrip("/") or ".") if pwd else t
    if not t or t.startswith(("/", "~", "$")):
        return _fd_where(t, root, None)
    return _unknown_where(t, root)


# AUD-SEC-521: fd mở trên THƯ MỤC (`exec 3< d`, `{fd}< d`, `< d`) — `/dev/fd/3/f` là `d/f` (kernel theo liên kết của fd
# rồi đi tiếp). Tiền tố fd giải theo chữ như AUD-SEC-511 (`/dev/./fd/3`, `//dev/fd/3`, `/dev/../dev/fd/3`).
FD_DIR_RE = re.compile(r"/dev/(?:fd/\d+|std(?:in|out|err))|/proc/[^/]+/fd/\d+")
# Đích của `<` (không `<<`, `<<<`, `<>`, `<&`, `<(`) trong chữ lệnh, kể cả lệnh lồng: nguyên văn, có nháy hay không;
# không phân theo số fd (`4<&3` sao chép, `{fd}<` không biết số) — mọi thư mục mở là ứng viên cho mọi `/dev/fd/N/…`.
FD_OPEN_RE = re.compile(r"(?<!<)<(?![<>&(])[ \t]*(?:'([^']*)'|\"([^\"$`\\]*)\"|([^\s;&|()<>`$'\"\\]+))")
FD_DIRS: contextvars.ContextVar[Tuple[str, ...]] = contextvars.ContextVar("FD_DIRS", default=())


def _fd_open_dirs(cmd: str) -> Tuple[str, ...]:
    """Đường nguyên văn mà `cmd` mở để đọc bằng `<` (ứng viên thư mục của `/dev/fd/N/…` — AUD-SEC-521)."""
    return tuple(dict.fromkeys(next(g for g in m.groups() if g is not None) for m in FD_OPEN_RE.finditer(cmd)))


def _fd_dir_tail(path: str) -> Optional[str]:
    """Phần đuôi của `path` sau tiền tố fd đầu tiên khi giải theo chữ (`/dev//fd/./3/a/../b` → `a/../b`, `..` của đuôi
    giữ nguyên: nó leo từ thư mục của fd); không có tiền tố fd hay không có đuôi (`/dev/fd/3`) → None."""
    if not path.startswith("/"):
        return None
    parts, stack = path.split("/"), cast(List[str], [])
    for i, part in enumerate(parts):
        if part == "..":
            stack = stack[:-1]
        elif part not in ("", "."):
            stack.append(part)
        if 2 <= len(stack) <= 4 and FD_DIR_RE.fullmatch("/" + "/".join(stack)):
            return "/".join(p for p in parts[i + 1 :] if p not in ("", ".")) or None
    return None


def _fd_where(t: str, root: str, cwd: Optional[str]) -> List[str]:
    """`t` dưới thư mục mở trên fd (AUD-SEC-521): đuôi ở thư mục không biết (D-106), ở mọi thư mục mở bằng `<` trong
    lệnh (`FD_DIRS`), và — khi đuôi leo bằng `..` — ở gốc hệ thống; `t` khác giữ nguyên. Thư mục mở chỉ ghép một tầng
    (`exec 3< /dev/fd/3` không lặp vô hạn)."""
    tail = _fd_dir_tail(t)
    if tail is None:
        return [t]
    up = UP_LEAD_RE.sub("", tail)
    out = [t, *_where(tail, root, None), *(_where("/" + up, root, cwd) if up != tail else [])]
    dirs, token = FD_DIRS.get(), FD_DIRS.set(())
    try:
        return out + [x for d in dirs for x in _where(posixpath.join(d, tail), root, cwd)]
    finally:
        FD_DIRS.reset(token)


def _unknown_where(t: str, root: str) -> List[str]:
    """`_where` của đích tương đối `t` ở thư mục không biết: gốc dự án cộng thư mục canh có tệp đó hay tên được canh;
    `..` đầu đường (AUD-SEC-512/520: `cd "$X"; printf x > ../.autopilot/x`) leo được tới gốc hay thư mục canh — xét cả
    phần sau các `..`."""
    rel = UP_LEAD_RE.sub("", posixpath.normpath(t)) or "."
    out: List[str] = []
    for x in [t] if rel == posixpath.normpath(t) else [t, rel]:
        out.append(posixpath.normpath(posixpath.join(root, x)))
        for d, names in UNKNOWN_CWD_DIRS:
            p = posixpath.normpath(posixpath.join(root, d, x))
            if os.path.lexists(p) or x.split("/", 1)[0] in names:
                out.append(p)
    return out


def _perm_asks(n: List[str], argv: List[str], root: str, cwd: Optional[str]) -> List[str]:
    """Đổi quyền git hook/hàng rào (`chmod 000 guard.py` → hook fail-open); đích từ xargs/file → chặn."""
    pos = _positionals(n[1:], PERM_VALUE_FLAGS if n[0] in PERM_CMDS[3:] else ())  # chmod: `-x` là mode
    asks = [GIT_HOOK_WHY.format(t) for t in pos if any(_git_hook_target(x, root) for x in _where(t, root, cwd))]
    asks += [FENCE_WHY.format(t) for t in pos if any(_is_fence(x, root) for x in _where(t, root, cwd))]
    hidden = _xargs_wrapped(argv) or any(a.split("=")[0] == "--restore" for a in n)
    return asks + ([PERM_NO_TARGET_WHY] if hidden else [])


def _write_asks(
    n: List[str], argv: List[str], root: str, cwd: Optional[str] = None, env: Optional[Dict[str, str]] = None
) -> List[str]:
    """Câu hỏi xác nhận cho file hàng rào/bí mật/cổng/migration mà lệnh có thể ghi (bỏ qua /dev/*). `cwd` None = thư
    mục đang đứng không biết (D-106, `_where`); `env`: biến chuỗi lệnh đã đặt (`TAR_OPTIONS`, `UNZIP` — AUD-SEC-474)."""
    n = _with_env_opts(n, argv, env)
    asks = _perm_asks(n, argv, root, cwd) if n and n[0] in PERM_CMDS else []
    cfg = _git_config_file(n)
    find_evidence = _find_evidence_targets(n[1:]) if n[:1] == ["find"] else []
    # AUD-SEC-458: giải nén không nêu thư mục ghi vào thư mục đang đứng — xét như `-C .`/`-d .` (chỉ ở đây: `.` không
    # là đích của luật tệp-vừa-ghi-rồi-chạy, ADR-0066); AUD-SEC-470: chép VÀO thư mục → cả `đích/<tên nguồn>`
    targets = [*write_targets(n, argv), *([cfg] if cfg else []), *_extract_here(n), *_copied_into(n, root, cwd)]
    found = [x for t in find_evidence for x in _where(t, root, cwd) if t not in targets]
    asks += [EVIDENCE_WHY.format(t) for t in found if _target_kind(t, root) == "evidence"]
    asks += [FENCE_WHY.format(t) for t in found if _is_fence(t, root)]
    # AUD-SEC-424: ghi THÔ `>> ~/.gitconfig` (`git config -f ~/.gitconfig <khoá>` do luật khoá của git config xét)
    # review #431: cả đích đã giải theo thư mục đang đứng (`cd /etc && >> gitconfig`), như vòng `.git/config` dưới đây
    # AUD-SEC-435: cả realpath của đích (symlink tên trung tính `lnk` -> `~/.gitconfig` có sẵn lúc kiểm)
    asks += [
        GIT_HOOK_WHY.format(x)
        for t in targets
        if t != cfg
        for x in [t, *_where(t, root, cwd), *_real_targets(t, root, cwd)]
        if _global_git_config(x)
    ]
    # AUD-SEC-439: tệp gitfile `.git` (`gitdir: …`) trỏ repo sang thư mục git khác — ghi (không xoá) như `.git/config`
    # AUD-SEC-449: đích là THƯ MỤC của Git dir có thật (`cp f gd/`, `tar -xf a -C gd`, `rsync -a d/ gd/`) — như `.git`
    if not n or n[0] not in REUSE_DELETERS and n[:2] != ["git", "rm"]:
        asks += [
            GIT_HOOK_WHY.format(t)
            for t in targets
            if any(_gitfile_target(x, root) or _git_dir_target(x, root) for x in _where(t, root, cwd))
        ]
    # AUD-SEC-452: `git config --file <Git dir>/config <khoá>` như `git -C <Git dir> config <khoá>` — luật khoá xét
    # (khoá chạy lệnh/hooksPath vẫn chặn); `--edit` hay tệp cũng là đích ghi khác thì vẫn như ghi thô
    keyed = (
        set(_where(cfg, root, cwd)) if cfg and cfg not in write_targets(n, argv) and not _git_config_edit(n) else set()
    )
    for target in (x for t in targets for x in _where(t, root, cwd)):
        kind = _target_kind(target, root)
        if _is_fence(target, root):
            asks.append(FENCE_WHY.format(target))
        elif target and _git_hook_target(target, root, target in keyed):
            asks.append(GIT_HOOK_WHY.format(target))
        elif kind == "secret":
            asks += [] if build_local_secret(target, root, cwd) else [f"ghi file bí mật qua Bash: {target}"]
        elif kind in ("gate", "migration"):
            asks.append(f"sửa cấu hình cổng/CI/harness/migration qua Bash ({target}) — nói rõ lý do")
        elif kind == "evidence":
            asks.append(EVIDENCE_WHY.format(target))
        elif kind == "capability":
            asks.append(CAPABILITY_WHY.format(f"ghi {target} qua Bash"))
        elif _existing_test(target, root):
            asks.append(f"sửa/xoá test ĐÃ CÓ qua Bash ({target}) — làm yếu test là nới cổng (LOOP-CI-001)")
    restored = [(t, _target_kind(x, root)) for t in _git_file_targets(n) for x in _where(t, root, cwd)]
    asks += [
        f"ghi file bí mật qua Bash (git lấy từ commit khác): {t}"
        for t, k in restored
        if k == "secret" and not build_local_secret(t, root, cwd)
    ]
    asks += _ledger_asks(n, argv, root, cwd)
    return asks + [EVIDENCE_WHY.format(f"git {n[1]} {t}") for t, k in restored if k == "evidence"]


# sổ giai đoạn và thư mục tổ tiên của nó (`docs/autopilot`, `docs`)
LEDGER_PATHS = tuple(STAGE_LEDGER.rsplit("/", i)[0] for i in range(STAGE_LEDGER.count("/") + 1))


def _ledger_hit(rel: str) -> bool:
    """`rel` (có thể là glob, khớp từng cấp như shell — `docs/*` gồm `docs/autopilot`, `docs/*.md` thì không) là sổ giai
    đoạn hay thư mục tổ tiên của nó: xoá/dời/khôi phục/chép đè là ghi tay sổ (AUD-HAR-154)."""
    parts = rel.split("/")
    return any(
        len(p.split("/")) == len(parts) and all(map(fnmatch.fnmatchcase, p.split("/"), parts)) for p in LEDGER_PATHS
    )


def _removed_targets(n: List[str]) -> List[str]:
    """Đích bị xoá/dời đi/ghi đè cả cây: `rm`/`unlink`/`shred`, nguồn của `mv`/`git mv`, `git rm`, `find … -delete`,
    pathspec của `git checkout <rev> --`/`git restore -s`."""
    name, args = (n[0], n[1:]) if n else ("", [])
    if name == "git" and args[:1] in (["rm"], ["mv"]):
        pos = _positionals(args[1:])
        return pos if args[0] == "rm" else pos[:-1]
    if name == "mv":
        t_dirs, pos, _ = _copy_opts("mv", args)
        return pos if t_dirs else pos[:-1]
    if name in ("rm", "unlink", "shred"):
        return _positionals(args)
    return _find_ledger_roots(args) if name == "find" else _git_file_targets(n)


def _find_ledger_roots(args: List[str]) -> List[str]:
    """Gốc của `find … -delete` có thể trúng sổ: không bộ lọc tên, bộ lọc phủ định, hay mẫu tên/đường khớp một cấp của sổ
    (`-name '*.json'`, `-path '*autopilot*'`) — `find docs -name evidence -delete` không đụng sổ."""
    expr = args[_find_parts(args)[1] :]
    vals = [expr[k + 1].lower() for k, a in enumerate(expr[:-1]) if a in FIND_NAME_TESTS]
    names = [p.rsplit("/", 1)[-1].lower() for p in LEDGER_PATHS]
    hit = not vals or bool({"!", "-not"} & set(expr))
    hit = hit or any(fnmatch.fnmatchcase(m, posixpath.basename(v) or v) or m in v for v in vals for m in names)
    return _find_delete_roots(args) if hit else []


def _git_path_dir(n: List[str], argv: List[str], cwd: Optional[str]) -> Optional[str]:
    """Thư mục mà pathspec của lệnh git tính từ: thư mục đang đứng qua các `-C` (`_git_dir`; không biết → None). Lệnh
    khác git → `cwd`. `--work-tree` không xét (D-281): git khớp pathspec theo đường chỉ mục tính từ gốc cây, chưa có
    mô hình đúng — giữ như trước (`cwd`)."""
    return _git_dir(argv, cwd) if n[:1] == ["git"] else cwd


def _ledger_asks(n: List[str], argv: List[str], root: str, cwd: Optional[str]) -> List[str]:
    """Ghi tay sổ giai đoạn qua thư mục: xoá/dời thư mục tổ tiên (`rm -r docs/autopilot`, `git mv docs …`, cả qua
    `git -C docs`), hay chép/dời/liên kết vào thư mục có sẵn mà tên nguồn là tên sổ (`cp x/STAGE.json
    docs/autopilot/`) — AUD-HAR-154."""
    removed = dict.fromkeys(_removed_targets(n))  # đích trùng chỉ giải một lần (`realpath` tốn theo độ sâu thư mục)
    base = _git_path_dir(n, argv, cwd) if removed else cwd  # chỉ đọc `-C` khi có đích xoá/dời
    found = dict.fromkeys(x for t in removed for x in _where(t, root, base))
    hits = [x for x in found if _ledger_hit(_rel_dir(x, root))]
    hits += [j for j in _copied_into(n, root, cwd) if _ledger_hit(_rel_dir(j, root))]
    hits += [x for t in _merge_roots(n) for x in _where(t, root, cwd) if _ledger_hit(_rel_dir(x, root))]
    hits += [posixpath.join(root, STAGE_LEDGER)] if _merge_renamed(n) else []
    return [EVIDENCE_WHY.format(h) for h in dict.fromkeys(hits)]


def _copy_into_positionals(n: List[str]) -> List[str]:
    """Đối số vị trí của lệnh chép/dời VÀO thư mục có sẵn (nguồn…, đích): `cp`/`mv`/`install`/`ln`, cả `rsync`
    (`rsync -a src/* docs/autopilot/` — AUD-SEC-340), `scp` đích cục bộ; `-t D` → (nguồn…, D); lệnh khác → rỗng."""
    if n[:1] and n[0] in COPY_OPT_TABLES:
        t_dirs, pos, _ = _copy_opts(n[0], n[1:])
        return pos + t_dirs[-1:]
    if n[:1] == ["scp"]:
        return _operands(_getopt(n[1:], SCP_OPTS))
    return _rsync_pos(n[1:]) if n[:1] == ["rsync"] else []


def _copied_into(n: List[str], root: str, cwd: Optional[str]) -> List[str]:
    """`đích/<tên nguồn>` khi lệnh chép/dời VÀO thư mục (đích kết `/` hay đã là thư mục): `cp -r X/.claude .` gộp đè
    `./.claude` có sẵn — luật đích bảo vệ phải xét cả đường này, không chỉ `.` (AUD-SEC-470)."""
    pos = _copy_into_positionals(n)
    if len(pos) < 2 or REMOTE_SPEC_RE.match(pos[-1]):
        return []
    dirs = [d for d in _where(pos[-1], root, cwd) if pos[-1].endswith("/") or os.path.isdir(os.path.join(root, d))]
    return [posixpath.join(d, x) for d in dirs for s in pos[:-1] for x in _copied_names(n, s)]


def _copied_names(n: List[str], src: str) -> List[str]:
    """`_copied_name`; cp giữ đường thì CẢ tên cuối — `--parents` có thể đến từ viết tắt mơ hồ (`--p`: parents/preserve,
    AUD-SEC-495) mà bản chạy thật hiểu khác."""
    name = _copied_name(n, src)
    base = posixpath.basename(src.rstrip("/"))
    return [name] if n[:1] != ["cp"] or name == base else [name, base]


def _keeps_path(n: List[str]) -> bool:
    """Chép giữ đường nguồn dưới đích (review lượt 2): `cp --parents` (cả tiền tố `--pa…`), `rsync -R/--relative`."""
    if n[:1] == ["cp"]:
        return "parents" in _copy_opts("cp", n[1:])[2]
    keys = _opt_keys(_getopt(n[1:], RSYNC_OPTS)) if n[:1] == ["rsync"] else set()
    return bool(keys & {"R", "relative"})


def _copied_name(n: List[str], src: str) -> str:
    """Đường mà nguồn `src` nhận dưới thư mục đích: tên cuối; giữ đường (`_keeps_path`) → cả đường nguồn (rsync: phần sau
    `/./` nếu có), bỏ `/` đầu."""
    src = src.rstrip("/")
    if not _keeps_path(n):
        return posixpath.basename(src)
    src = src.split("/./", 1)[1] if n[0] == "rsync" and "/./" in src else src
    return posixpath.normpath(src.lstrip("/"))


def _dot_source(s: str) -> bool:
    """Nguồn `x/.` (hay `.`): cp/rsync chép NỘI DUNG vào đích, không tạo thư mục con."""
    return s.rstrip("/").endswith("/.") or s.rstrip("/") == "."


def _merge_roots(n: List[str]) -> List[str]:
    """Thư mục mà lệnh GỘP nội dung không biết trước vào (AUD-SEC-248): `cp -T`/`--no-target-directory` và nguồn `x/.`
    (đích nhận nội dung nguồn, không phải thư mục con; đích cuối hay `-t`/`--target-directory`), `rsync` nguồn kết `/`
    hay `/.`, `tar -x` (`-C`/`--directory`/`--one-top-level`, vắng = thư mục đang đứng). Đích là sổ giai đoạn hay tổ
    tiên của nó → ghi tay sổ (`_ledger_hit`)."""
    name, args = (n[0], n[1:]) if n else ("", [])
    if name in ("cp", "install"):
        t_dirs, pos, keys = _copy_opts(name, args)
        srcs, dest = (pos, t_dirs[-1]) if t_dirs else (pos[:-1], pos[-1] if len(pos) > 1 else "")
        no_t = not t_dirs and bool(keys & {"T", "no-target-directory"})
        return [dest] if dest and (no_t or any(map(_dot_source, srcs))) else []
    if name == "rsync":
        pos = _rsync_pos(args)
        return pos[-1:] if any(s.endswith("/") or _dot_source(s) for s in pos[:-1]) else []
    return _tar_extract_dirs(args) if name in TAR_NAMES else _unpack_dirs(name, args)


# Trình giải nén ngoài `tar` (AUD-SEC-340): thư mục đích của `unzip -d` (cả trong cụm `-qd D`), `7z x|e -o…`, `cpio -i
# -D …`/`cpio -p <đích>`, `jar x` (review lượt 2), `python -m zipfile|tarfile -e A [D]`; vắng cờ đích = thư mục đang
# đứng. Chế độ chỉ liệt kê/kiểm/in ra stdout → không ghi. `tar`/`gtar`/`bsdtar`: `TAR_NAMES`.
SEVEN_ZIP = ("7z", "7za", "7zr", "7zz")
PY_UNPACK_RE = re.compile(r"python[\d.]*")
# UnZip 6.00 (unzip.c `uz_opts`, đo trên bản Debian): `-` trong cụm phủ định chữ cờ KẾ TIẾP, kể cả sang token sau
# (`-l --l`, `-l- -l`, `--- -l` đều giải nén); `-d -P -O -I` ăn giá trị (phần còn lại của cụm, không thì token kế);
# chữ cờ chỉ đọc (cùng nhóm thì cộng/trừ chung); tuỳ chọn sau tên zip là mẫu tên tệp, trừ `-d` — AUD-SEC-473.
UNZIP_READ = {"l": "v", "v": "v", "t": "t", "c": "c", "p": "c", "z": "z", "Z": "Z"}
# AUD-SEC-489: `tflag`/`cflag` (`-t`, `-c`/`-p`) là bật/tắt — phủ định một lần tắt hẳn (`-tt --t` giải nén); `vflag`
# (`-l`/`-v`) và `zflag` mới là bộ đếm trừ theo số `-` (đo trên UnZip 6.00 Debian)
UNZIP_SWITCH = frozenset("tc")


def _unzip_flag(counts: Dict[str, int], key: str, neg: int) -> None:
    """Áp một chữ cờ chỉ đọc nhóm `key` có `neg` dấu `-` phủ định đứng trước vào `counts` theo ngữ nghĩa UnZip 6.00."""
    if key in UNZIP_SWITCH:
        counts[key] = 0 if neg else 1
    else:
        counts[key] = max(counts.get(key, 0) - neg, 0) if neg else counts.get(key, 0) + 1


def _unzip_parse(args: List[str]) -> Tuple[List[str], bool]:
    """(thư mục `-d`, chỉ đọc/liệt kê/in ra stdout) của `unzip`."""
    counts: Dict[str, int] = {}
    neg, dirs, i, seen_zip = 0, [], 0, False
    while i < len(args):
        a, i = args[i], i + 1
        if a[:1] != "-" or a == "-" or (seen_zip and a[:2] != "-d"):
            seen_zip = True
            continue
        for j, c in enumerate(a[1:], 2):
            if c == "-":
                neg += 1
                continue
            if c in "dPOI":
                val = a[j:] or (args[i] if i < len(args) else None)
                i += 0 if a[j:] else 1
                dirs += [val] if c == "d" and val is not None else []
                neg = 0
                break
            _unzip_flag(counts, UNZIP_READ.get(c, ""), neg)
            neg = 0
    return dirs, any(v for k, v in counts.items() if k)


def _unzip_dirs(args: List[str]) -> List[str]:
    """Thư mục đích của `unzip`: `-d D`, `-dD`, cụm `-qd D`; vắng = thư mục đang đứng; chế độ đọc → []."""
    dirs, reading = _unzip_parse(args)
    return [] if reading else (dirs or ["."])


# CPython: cụm cờ của trình thông dịch (`-Im tarfile`, `-mtarfile`), `-W`/`-X`/`--check-hash-based-pycs` ăn giá trị,
# `-c`/`--`/tên script thì không còn `-m`. Mô-đun lưu trữ đọc đối số bằng argparse (Lib/tarfile.py, Lib/zipfile/
# __init__.py của 3.13): {tên dài: (chữ ngắn, nargs)}; tên dài nhận tiền tố duy nhất (`--e` = `--extract`) — AUD-SEC-472.
PY_ARCHIVE_OPTS: Dict[str, Dict[str, Tuple[str, int]]] = {  # nargs −1 = `+`
    "tarfile": {"verbose": ("v", 0), "filter": ("", 1), "list": ("l", 1), "extract": ("e", -1), "create": ("c", -1)},
    "zipfile": {"metadata-encoding": ("", 1), "list": ("l", 1), "extract": ("e", 2), "create": ("c", -1)},
}
PY_ARCHIVE_OPTS["tarfile"]["test"] = PY_ARCHIVE_OPTS["zipfile"]["test"] = ("t", 1)


def _py_module(args: List[str]) -> Tuple[str, List[str]]:
    """(mô-đun của `-m`, đối số của nó) theo cách CPython đọc dòng lệnh; không có `-m` → ("", [])."""
    i = 0
    while i < len(args):
        a, i = args[i], i + 1
        if a == "--check-hash-based-pycs":
            i += 1
        elif a[:1] != "-" or a in ("-", "--"):
            return "", []
        elif a[:2] != "--":
            for j, c in enumerate(a[1:], 2):
                if c in "cm":
                    mod = a[j:] or (args[i] if i < len(args) else "")
                    return (mod, args[i + (0 if a[j:] else 1) :]) if c == "m" else ("", [])
                if c in "WX":
                    i += 0 if a[j:] else 1
                    break
    return "", []


def _argparse(args: List[str], table: Dict[str, Tuple[str, int]]) -> Dict[str, List[str]]:
    """Giá trị (lần cuối) của từng tuỳ chọn theo argparse: `-eA`, `-e=A`, cụm cờ không giá trị (`-ve`), `--ext=A`, tiền tố
    duy nhất; nargs `+` ăn mọi token không bắt đầu bằng `-`, số n ăn tối đa n token. Token thừa → khoá "" (argparse báo
    lỗi; người gọi đọc theo chiều chặt)."""
    out: Dict[str, List[str]] = {}
    args, i = list(args), 0
    while i < len(args):
        a, i = args[i], i + 1
        if a[:1] != "-" or a in ("-", "--"):
            out.setdefault("", []).extend(args[i:] if a == "--" else [a])
            i = len(args) if a == "--" else i
            continue
        if a[:2] == "--":
            name, eq, val = a[2:].partition("=")
            hits = [k for k in table if k.startswith(name)]
            key, explicit = (name if name in table else hits[0] if len(hits) == 1 else ""), (val if eq else None)
        else:
            key = next((k for k, (s, _) in table.items() if s and s == a[1]), "")
            explicit = a[3:] if a[2:3] == "=" else a[2:] or None
        if not key:
            continue
        nargs = table[key][1]
        if nargs == 0:
            args[i:i] = ["-" + explicit] if explicit and a[:2] != "--" else []
            out[key] = []
            continue
        k = i
        while explicit is None and k < len(args) and args[k][:1] != "-" and (nargs < 0 or k - i < nargs):
            k += 1
        out[key], i = ([explicit] if explicit is not None else args[i:k]), k
    return out


def _py_archive(args: List[str]) -> Tuple[List[str], List[str]]:
    """(thư mục giải nén, tệp archive tạo ra) của `python -m tarfile|zipfile`: tarfile `-e A [D]` (vắng D = thư mục đang
    đứng), zipfile `-e A D`; `-c F nguồn…` ghi F (AUD-SEC-475). Sai số đối số → argparse/mô-đun báo lỗi, không ghi."""
    mod, rest = _py_module(args)
    table = PY_ARCHIVE_OPTS.get(mod)
    if table is None:
        return [], []
    got = _argparse(rest, table)
    ext = got.get("extract", [])
    dirs = ext[1:2] if len(ext) == 2 else ["."] if len(ext) == 1 and mod == "tarfile" else []
    # token thừa (`-e A -v out`: Python 3.13 báo lỗi, không ghi) — chiều chặt: cả `.` lẫn token đó là đích
    stray = got.get("", []) if "extract" in got else []
    return (dirs or ["."] * bool(stray)) + stray, got.get("create", [])[:1]


# jar của JDK (`jar --help`, JDK 21): cụm đầu (có hay không `-`) là kiểu cũ (`xf a.jar`, `-cvfm a m`); sau đó kiểu GNU
# (`-x -f a`, `--file=a`), tên dài không viết tắt; chế độ ở MỌI token (`jar -v -x -f a` — AUD-SEC-473).
JAR_LONG_VALUE: Tuple[str, ...] = (
    "file",
    "generate-index",
    "main-class",
    "manifest",
    "release",
    "module-version",
    "hash-modules",
)
JAR_LONG_VALUE += ("module-path", "date", "dir")
JAR_OPTS: OptTable = ("Cefimp", (), JAR_LONG_VALUE, False)


def _jar_opts(args: List[str]) -> OptItems:
    old = bool(args) and bool(re.fullmatch(r"-?[A-Za-z0-9]+", args[0]))
    return _getopt(_old_style([args[0].lstrip("-"), *args[1:]], "fme") if old else args, JAR_OPTS)


def _jar_extract(items: OptItems) -> bool:
    keys = _opt_keys(items)
    return bool(keys & {"x", "extract"}) and not keys & {"c", "t", "u", "create", "list", "update"}


# GNU ar 2.42 (`ar --help`, binutils ar.c): token đầu không `-` là cụm khoá (`xv`); tên dài qua getopt_long (viết tắt
# được: `--o=D`, `--outp D`), `--plugin`/`--target`/`--output`/`--record-libdeps` ăn giá trị; khoá cũng có thể là toán
# hạng đầu sau các tuỳ chọn (`ar --target T x a.a`) — AUD-SEC-473.
_AR_VALUE = ("output", "plugin", "record-libdeps", "target")
AR_OPTS: OptTable = ("", _AR_VALUE + ("help", "thin", "version"), _AR_VALUE, True)


def _ar_parse(args: List[str]) -> Tuple[str, List[str], OptItems]:
    """(chữ khoá/sửa đổi, toán hạng sau khoá, mục tuỳ chọn) của `ar`."""
    items = _getopt(["-" + args[0], *args[1:]] if args and args[0][:1] != "-" else args, AR_OPTS)
    letters, pos = "".join(k for k, _ in items if len(k) == 1), _operands(items)
    if not set(letters) & set("dmpqrstx") and pos:
        letters, pos = letters + pos[0], pos[1:]
    return letters, pos, items


def _ar_archive(args: List[str]) -> List[str]:
    """Tệp archive mà `ar r|q|m|d|s` ghi: toán hạng sau khoá, bỏ thành viên mốc (`a`/`b`/`i`) và số đếm (`N`)."""
    letters, pos, _ = _ar_parse(args)
    skip = bool(set(letters) & set("abi")) + ("N" in letters)
    return pos[skip : skip + 1] if set(letters) & set("rqmds") else []


# GNU cpio (src/main.c, argp + ARGP_IN_ORDER): chữ ngắn ăn giá trị, mọi tên dài (viết tắt được) — chữ `t` trong
# `-idHtar` là giá trị của `-H`, không phải liệt kê (AUD-SEC-468); `-iD D`, `--dir=D`, `--ext` (AUD-SEC-477).
CPIO_LONG_VALUE: Tuple[str, ...] = (
    "block-size",
    "directory",
    "file",
    "format",
    "io-size",
    "message",
    "owner",
    "pattern-file",
)
CPIO_LONG_VALUE += ("rename-batch-file", "rsh-command", "warning")
_CPIO_FLAGS = "absolute-filenames append create debug dereference device-independent dot extract force-local help"
_CPIO_FLAGS += " ignore-devno link list make-directories no-absolute-filenames no-preserve-owner nonmatching null"
_CPIO_FLAGS += " numeric-uid-gid only-verify-crc pass-through preserve-modification-time quiet rename renumber-inodes"
_CPIO_FLAGS += " reproducible reset-access-time sparse swap swap-bytes swap-halfwords to-stdout unconditional usage"
_CPIO_FLAGS += " verbose version"
CPIO_OPTS: OptTable = ("CDEFHIMORW", CPIO_LONG_VALUE + tuple(_CPIO_FLAGS.split()), CPIO_LONG_VALUE, True)


CPIO_LISTING = frozenset({"t", "list", "to-stdout"})  # `cpio -it`: chỉ liệt kê (AUD-SEC-462)


def _cpio_dirs(args: List[str]) -> List[str]:
    items = _getopt(args, CPIO_OPTS)
    keys, dirs = _opt_keys(items), _opt_vals(items, "D", "directory")
    if keys & {"p", "pass-through"}:
        return dirs + _operands(items)[-1:]
    listing = (keys & CPIO_LISTING) - _ambiguous_longs(args, CPIO_OPTS, CPIO_LISTING)
    return (dirs or ["."]) if keys & {"i", "extract"} and not listing else []


def _ambiguous_longs(args: List[str], table: OptTable, neg: FrozenSet[str]) -> Set[str]:
    """AUD-SEC-517: tên mà `--viết-tắt` mơ hồ mở ra (`_long_names`) khi không phải mọi tên đều thuộc tập phủ định `neg`
    — phủ định lấy GIAO các tên khớp, không lấy hợp (`cpio -i --li`: link/list — không được coi là chỉ liệt kê)."""
    out: Set[str] = set()
    for a in (x for x in args if x.startswith("--")):
        names = set(_long_names(a[2:].partition("=")[0], table[1], table[3]))
        out |= names if len(names) > 1 and not names <= neg else set()
    return out


def _cpio_archive(args: List[str]) -> List[str]:
    """`cpio -o` ghi archive ra `-O F`/`-F F`/`--file=F` (AUD-SEC-475)."""
    items = _getopt(args, CPIO_OPTS)
    return _opt_vals(items, "O", "F", "file") if _opt_keys(items) & {"o", "create"} else []


def _seven_zip(args: List[str]) -> Tuple[List[str], List[str]]:
    """(thư mục giải nén, archive ghi) của 7z: lệnh và khoá chuyển không phân biệt hoa thường (chưa đo: máy không có 7z
    — theo tài liệu 7-Zip, mục cmdline/syntax.htm); `x|e` giải vào `-o<D>` (vắng = `.`), `a|u|d|rn` ghi archive."""
    pos = _positionals(args)
    cmd = pos[0].lower() if pos else ""
    dirs = [a[2:] for a in args if a[:2].lower() == "-o"] or ["."]
    return (dirs if cmd in ("x", "e") else []), (pos[1:2] if cmd in ("a", "u", "d", "rn") else [])


def _unpack_dirs(name: str, args: List[str]) -> List[str]:
    if name == "unzip":
        return _unzip_dirs(args)
    if PY_UNPACK_RE.fullmatch(name):
        return _py_archive(args)[0]
    if name == "jar":
        items = _jar_opts(args)
        return (_opt_vals(items, "C", "dir") or ["."]) if _jar_extract(items) else []
    if name in SEVEN_ZIP:
        return _seven_zip(args)[0]
    if name == "ar":  # `ar x|-xv a.a [thành viên…]` giải vào thư mục đang đứng, `--output D` (AUD-SEC-462)
        letters, _, items = _ar_parse(args)
        return (_opt_vals(items, "output") or ["."]) if "x" in letters else []
    return _cpio_dirs(args) if name == "cpio" else []


def _archive_outputs(name: str, args: List[str]) -> List[str]:
    """Tệp archive mà lệnh tạo/ghi archive ghi ra (AUD-SEC-475): `zip F`, `jar c|u` kèm `f`, `ar r|q`, `cpio -o`, `7z a`,
    `pax -w -f`, `python -m zipfile|tarfile -c F` (tar: `_tar_dest`)."""
    if name == "zip":
        return _positionals(args, ZIP_VALUE_OPTS)[:1] + _flag_values(args, ("-O", "--out", "--output-file"))
    if name == "jar":
        items = _jar_opts(args)
        return _opt_vals(items, "f", "file") if _opt_keys(items) & {"c", "u", "create", "update"} else []
    if name == "ar":
        return _ar_archive(args)
    if name == "cpio":
        return _cpio_archive(args)
    if name in SEVEN_ZIP:
        return _seven_zip(args)[1]
    return _pax_archive(args) if name == "pax" else _py_archive(args)[1] if PY_UNPACK_RE.fullmatch(name) else []


# Info-ZIP zip 3.0 (`zip -h2`): tuỳ chọn là cả token (`-tt`, `-ds`), các tuỳ chọn ăn giá trị dưới; toán hạng đầu là
# archive, `-O`/`--out` là tệp ra.
ZIP_VALUE_OPTS: Tuple[str, ...] = (
    "-b",
    "-n",
    "-t",
    "-tt",
    "-P",
    "-Z",
    "-s",
    "-ds",
    "-O",
    "-TT",
    "-lf",
    "--out",
    "--temp-path",
)
ZIP_VALUE_OPTS += ("--password", "--suffixes", "--compression-method", "--split-size", "--from-date", "--before-date")
ZIP_VALUE_OPTS += ("--unzip-command", "--logfile-path", "--output-file")


def _merge_renamed(n: List[str]) -> bool:
    """Giải nén mà tên đích viết lại bằng mẫu (`tar --transform/--xform`, `bsdtar -s`): đích không biết trước → coi như
    có thể ghi sổ (AUD-SEC-340)."""
    if not n or n[0] not in TAR_NAMES or not _tar_extract_dirs(n[1:]):
        return False
    keys = _opt_keys(_tar_opts(n[1:]))
    return bool(keys & {"transform", "xform"}) or (n[0] == "bsdtar" and "s" in keys)


# Bảng argp của GNU tar 1.35 (`tar --help`, đo 2026-11-04): chữ ngắn ăn giá trị; mọi tên dài (viết tắt được nếu là
# tiền tố của đúng một tên: `--dir=` = `--directory=`, `--ge` = `--get`; mơ hồ như `--fil` thì tar báo lỗi) và tên bắt
# buộc giá trị (`--exclude -O` là mẫu `-O`, không phải ra stdout — AUD-SEC-471). Kiểu cũ `xfC a d`: `_old_style`.
TAR_SHORT_VALUE = "bCfFgHIKLNTVX"
TAR_LONG_VALUE: Tuple[str, ...] = (
    "add-file",
    "after-date",
    "blocking-factor",
    "checkpoint-action",
    "directory",
    "exclude",
)
TAR_LONG_VALUE += ("exclude-from", "exclude-ignore", "exclude-ignore-recursive", "exclude-tag", "exclude-tag-all")
TAR_LONG_VALUE += ("exclude-tag-under", "file", "files-from", "format", "group", "group-map", "hole-detection")
TAR_LONG_VALUE += ("index-file", "info-script", "label", "level", "listed-incremental", "mode", "mtime")
TAR_LONG_VALUE += ("new-volume-script", "newer", "newer-mtime", "no-quote-chars", "owner", "owner-map", "pax-option")
TAR_LONG_VALUE += ("quote-chars", "quoting-style", "record-size", "rmt-command", "rsh-command", "sort")
TAR_LONG_VALUE += ("sparse-version", "starting-file", "strip-components", "suffix", "tape-length", "to-command")
TAR_LONG_VALUE += ("transform", "use-compress-program", "volno-file", "warning", "xattrs-exclude", "xattrs-include")
TAR_LONG_VALUE += ("xform",)
_TAR_FLAGS = "absolute-names acls anchored append atime-preserve auto-compress backup block-number bzip2 catenate"
_TAR_FLAGS += " check-device check-links checkpoint clamp-mtime compare compress concatenate confirmation create"
_TAR_FLAGS += " delay-directory-restore delete dereference diff exclude-backups exclude-caches exclude-caches-all"
_TAR_FLAGS += " exclude-caches-under exclude-vcs exclude-vcs-ignores extract force-local full-time get gunzip gzip"
_TAR_FLAGS += " hard-dereference help ignore-case ignore-command-error ignore-failed-read ignore-zeros incremental"
_TAR_FLAGS += " interactive keep-directory-symlink keep-newer-files keep-old-files list lzip lzma lzop multi-volume"
_TAR_FLAGS += " no-acls no-anchored no-auto-compress no-check-device no-delay-directory-restore no-ignore-case"
_TAR_FLAGS += " no-ignore-command-error no-null no-overwrite-dir no-recursion no-same-owner no-same-permissions"
_TAR_FLAGS += " no-seek no-selinux no-unquote no-verbatim-files-from no-wildcards no-wildcards-match-slash no-xattrs"
_TAR_FLAGS += " null numeric-owner occurrence old-archive one-file-system one-top-level overwrite overwrite-dir"
_TAR_FLAGS += " portability posix preserve-order preserve-permissions read-full-records recursion recursive-unlink"
_TAR_FLAGS += " remove-files restrict same-order same-owner same-permissions seek selinux show-defaults"
_TAR_FLAGS += " show-omitted-dirs show-snapshot-field-ranges show-stored-names show-transformed-names skip-old-files"
_TAR_FLAGS += " sparse test-label to-stdout totals touch uncompress ungzip unlink-first unquote update usage utc"
_TAR_FLAGS += " verbatim-files-from verbose verify version wildcards wildcards-match-slash xattrs xz zstd"
TAR_OPTS: OptTable = (TAR_SHORT_VALUE, TAR_LONG_VALUE + tuple(_TAR_FLAGS.split()), TAR_LONG_VALUE, True)
TAR_SUFFIX_RE = re.compile(r"\.(?:tar(?:\.\w+)?|t[gbx]z|tbz2|taz|tz2?|tlz|tzst)$")
TAR_EXTRACT = {"x", "extract", "get"}
TAR_WRITE_ARCHIVE = {"c", "r", "u", "A", "create", "append", "update", "catenate", "concatenate", "delete"}


def _tar_opts(args: List[str]) -> OptItems:
    """(cờ, giá trị) và ("", toán hạng) của `tar` theo thứ tự (`_getopt` trên bảng TAR_OPTS, kiểu cũ đã nở)."""
    return _getopt(_old_style(args, TAR_SHORT_VALUE), TAR_OPTS)


def _tar_archives(opts: OptItems) -> List[str]:
    """Tệp archive mà `tar -c/-r/-u/-A/--delete` ghi (`-f F`, `--file=F`; `-` là stdout) — AUD-SEC-475."""
    return [v for v in _opt_vals(opts, "f", "file") if v != "-"] if _opt_keys(opts) & TAR_WRITE_ARCHIVE else []


def _tar_extract_dirs(args: List[str]) -> List[str]:
    """Mọi thư mục `tar` có thể giải nén vào: `-C` cộng dồn (`-C docs -C autopilot` = `docs/autopilot`), cả thư mục
    `--one-top-level[=D]` (vắng D = tên archive bỏ đuôi); không `-C` = `.`; không giải nén → rỗng (review #405)."""
    opts = _tar_opts(args)
    if not _opt_keys(opts) & TAR_EXTRACT:
        return []
    cur, dirs = ".", []
    for k, v in opts:
        if k in ("C", "directory") and v:
            cur = posixpath.join(cur, v)
            dirs.append(cur)
        elif not k and not dirs:  # thành viên nêu trước `-C` đầu tiên giải vào thư mục đang đứng (AUD-SEC-471)
            dirs.append(".")
    archive = posixpath.basename(next((v for k, v in opts if k in ("f", "file") and v), ""))
    tops = [v if v is not None else TAR_SUFFIX_RE.sub("", archive) for k, v in opts if k == "one-top-level"]
    return (dirs or ["."]) + [posixpath.join(cur, t) for t in tops if t]


def _rel_dir(target: str, root: str) -> str:
    """`rel_path` bỏ `/` cuối; đích `/` (hay `//`) giữ là `/` — rỗng từng bị coi là gốc dự án (`cp x /` thành cổng)."""
    rel = rel_path(target, root)
    return rel.rstrip("/") or rel[:1]


def _target_kind(target: str, root: str) -> str:
    """classify_path của đích ghi; đích là THƯ MỤC cổng (`cp x .claude/hooks/`) cũng là cổng."""
    if not target or _norm_path(target).startswith("/dev/"):
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
    if not target or _norm_path(target).startswith("/dev/"):
        return False
    rel = rel_path(target, root)
    return _match_any(rel, TEST_PATTERNS) and os.path.isfile(os.path.join(root, rel))


def _commit_hooks_path(argv: List[str]) -> bool:
    """Lệnh commit/push đặt `core.hooksPath` qua `-c`, biến `GIT_CONFIG_KEY_<n>` (git ≥ 2.31) hay `GIT_CONFIG_PARAMETERS`
    (git đọc như `-c`: `'core.hooksPath'='/dev/null'` — review lượt 2 AUD-SEC-352). `--config-env=core.hooksPath=VAR`
    (`=` dính liền) bóc tiền tố trước khi so (AUD-SEC-383/389). Khoá không nguyên văn sau `-c`/`--config-env`
    (`k=$(echo core.hooksPath); git -c "$k=/dev/null" commit` — review blk-guard) có thể là `core.hooksPath` → tính."""
    low = [a.lower().removeprefix("--config-env=") for a in argv]
    return any(
        a.startswith("core.hookspath=")
        or re.fullmatch(r"git_config_key_\d+\+?=core\.hookspath", a)
        or (a.startswith("git_config_parameters") and "core.hookspath" in a)
        for a in low
    ) or any(_dyn_config_key(a, b) for a, b in zip(argv, argv[1:] + [""]))


def _dyn_config_key(opt: str, nxt: str) -> bool:
    """`-c KEY=…`, `--config-env KEY=…`, `--config-env=KEY=…` mà KEY có mở rộng chưa giải (`$`, backtick)."""
    key = (
        opt.removeprefix("--config-env=") if opt.startswith("--config-env=") else nxt if opt in GIT_CONFIG_OPTS else ""
    )
    return bool(re.search(r"[$`]", key.partition("=")[0]))


GIT_CONFIG_OPTS = ("-c", "--config-env")


PUSH_NO_VERIFY_RE = re.compile(r"--no-veri(?:fy?)?")  # git nhận tiền tố duy nhất của cờ dài (`--no-ver` mơ hồ)


def _mark_push_no_verify(n: List[str], argv: List[str], res: Dict[str, object]) -> None:
    """`git push --no-verify` (trước `--`) hay `core.hooksPath` qua `-c`/`GIT_CONFIG_KEY_<n>`: bỏ hook `pre-push` —
    đặt cờ `push_no_verify` cho adapter host khác chặn (AUD-SEC-352). Không đổi quyết định của hook Claude Code."""
    args = list(itertools.takewhile(lambda a: a != "--", n[2:]))
    if n[:2] == ["git", "push"] and (any(PUSH_NO_VERIFY_RE.fullmatch(a) for a in args) or _commit_hooks_path(argv)):
        res["push_no_verify"] = True


def _carry_push_no_verify(res: Dict[str, object], budget: "ScanBudget") -> None:
    """Cờ `push_no_verify` của lệnh lồng (`bash -c 'git push --no-verify'`, cùng ngân sách quét) lên kết quả gốc."""
    if res.get("push_no_verify") or budget.push_no_verify:
        res["push_no_verify"] = budget.push_no_verify = True


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
    r"\bclaude(?:[\s_-]+[\d.]+)*[\s_-]+(?:opus|sonnet|haiku|fable|mythos|instant)\b",  # `Claude Opus 5`, `claude-3-5-sonnet`
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
    k = bisect.bisect_right(seps, pos, key=lambda se: se[1])  # `seps` theo thứ tự, không chồng: tìm nhị phân
    start = seps[k - 1][1] if k else 0
    k = bisect.bisect_left(seps, pos, key=lambda se: se[0])
    return start, seps[k][0] if k < len(seps) else len(line)


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
    seps: Dict[str, List[Tuple[int, int]]] = {}  # dòng mở → dấu nối: nhiều heredoc một dòng không quét lại dòng
    for opener, m, body in _heredocs(join_continuations(cmd)):  # nối dòng `\` như shell (`git commit \` ↵ `-F - <<E`)
        if opener not in seps:
            seps[opener] = _unquoted_seps(opener)
        if pat.search(_commit_window(opener, m.start(), seps[opener])):
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
GH_PR_TEXT_RE = re.compile(r"(?<![\w-])gh\s+pr(?:\s+(?:-R|--repo)(?:\s+|=)\S+)?\s+(?:create|new|edit|merge)\b")
GH_PR_TEXT_OPTS = {"-t": "m", "--title": "m", "--subject": "m", "-b": "m", "--body": "m", "-F": "F", "--body-file": "F"}
# cờ bool ngắn đứng trước `-t/-b/-F` gộp kiểu pflag: `create -dt x`, `-fdbX`, `-et x` (`--editor`), `merge -sdb x`
# (AUD-SEC-188)
GH_PR_BOOL_SHORT = {"create": "dfwe", "new": "dfwe", "edit": "", "merge": "smrd"}


def _gh_pr_text_args(args: List[str]) -> Optional[List[Tuple[str, str]]]:
    """(loại, giá trị) của tiêu đề/thân trong `gh pr …` (sau `pr`, bỏ `-R/--repo x`); không phải create/edit/merge → None."""
    rest = list(args)
    while rest[:1] in (["-R"], ["--repo"]) or rest[:1] and rest[0].startswith("--repo="):
        rest = rest[2:] if rest[0] in ("-R", "--repo") else rest[1:]
    if rest[:1] not in (["create"], ["new"], ["edit"], ["merge"]):  # `new`: alias của `create`
        return None
    bools = GH_PR_BOOL_SHORT[rest[0]]
    short = re.compile(f"-{f'[{bools}]*' if bools else ''}([tbF])(=?)(.*)", re.S)
    out: List[Tuple[str, str]] = []
    for i, x in enumerate(rest[1:], 1):
        nxt = rest[i + 1] if i + 1 < len(rest) else ""
        key, sep, val = x.partition("=")
        m = short.fullmatch(x)
        if x in GH_PR_TEXT_OPTS or (m and not m.group(2) and not m.group(3)):  # `-t x`, `-dt x`
            out.append((GH_PR_TEXT_OPTS["-" + m.group(1)] if m else GH_PR_TEXT_OPTS[x], nxt))
        elif sep and key in GH_PR_TEXT_OPTS and key[:2] == "--":
            out.append((GH_PR_TEXT_OPTS[key], val))
        elif m:  # `-tfeat: x`, `-t=x`, `-dbX`, `-dF=f` (pflag)
            out.append((GH_PR_TEXT_OPTS["-" + m.group(1)], m.group(3)))
    return out


COMMIT_AFTER_WRITE_WHY = (
    "Tách lệnh: sửa file trước, `git commit` ở lệnh riêng — cổng commit chạy trên cây trước khi lệnh chạy, phần "
    "đứng trước ({}) sẽ vào commit mà cổng chưa thấy (cổng đỏ thì nó cũng không chạy)"
)
TREE_READONLY_GIT = {("git", "add"), ("git", "status"), ("git", "diff"), ("git", "log")}


def _tree_readonly(argv: List[str]) -> bool:
    """Lệnh đứng trước `git commit` không ghi cây: `cd`, `export`/gán biến, `true`, `git add|status|diff|log`, `cat`/
    `echo`/`printf` (message qua ống: `cat <<'EOF' | git commit -F -`) — không chuyển hướng ra file (trừ /dev/null),
    không `--output`."""
    n = normalize(argv)
    if any(t in REDIRECTS and argv[i + 1 : i + 2] != ["/dev/null"] or "`" in t for i, t in enumerate(argv)):
        return False  # backtick chạy lệnh như `$(…)` (review 5ef1a14 M2)
    if any(a.startswith("--output") for a in n):
        return False
    return not n or n[0] in ("cd", "export", "true", "cat", "echo", "printf") or tuple(n[:2]) in TREE_READONLY_GIT


def _commit_after_write(commands: List[Tuple[List[str], Optional[str]]]) -> str:
    """T-2503: `git commit` đi sau lệnh có thể ghi file trong CÙNG lệnh Bash → lý do chặn; không thì rỗng."""
    for k, (argv, _) in enumerate(commands):
        if normalize(argv)[:2] != ["git", "commit"]:
            continue
        bad = next((b for b, _ in commands[:k] if not _tree_readonly(b)), None)
        if bad is not None:
            return COMMIT_AFTER_WRITE_WHY.format(" ".join(bad)[:120])
    return ""


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
# `issue_write` của server GitHub MCP PATCH issue theo số — số đó có thể là PR (AUD-SEC-344): `method` khác `create`
# (vắng = chiều chặt) sửa được tiêu đề/thân PR như `update_pull_request`; `create` tạo issue, không phải PR.
MCP_ISSUE_WRITE_RE = re.compile(r"mcp__.+__(?:sub_)?issue_write")


def _mcp_issue_update(tool_name: str, tool_input: Dict[str, object]) -> bool:
    return bool(MCP_ISSUE_WRITE_RE.fullmatch(tool_name)) and tool_input.get("method") != "create"


# `actions_run_trigger` (AUD-SEC-344): chạy workflow/xoá log như `gh workflow run`/`gh api -X DELETE` → hỏi (mặc định
# cho chạy, strict hỏi — ADR-0018); chạy lại/huỷ lần chạy như `gh run rerun|cancel` → không phản đối.
MCP_ACTIONS_TRIGGER_RE = re.compile(r"mcp__.+__actions_run_trigger")
ACTIONS_RERUN_METHODS = frozenset({"rerun_workflow_run", "rerun_failed_jobs", "cancel_workflow_run"})


def _mcp_actions_verdict(tool_name: str, tool_input: Dict[str, object]) -> Tuple[str, str]:
    if not MCP_ACTIONS_TRIGGER_RE.fullmatch(tool_name) or tool_input.get("method") in ACTIONS_RERUN_METHODS:
        return "", ""
    return "ask", f"{EXTERNAL_ASK} — chạy/xoá workflow qua MCP ({tool_name}), như `gh workflow run`"


def mcp_attribution(tool_name: str, tool_input: Dict[str, object], root: str) -> str:
    """Lý do chặn khi tool MCP ghi PR/commit mang tên model/URL phiên ở dự án `ai_attribution: forbid`; không thì rỗng.
    URL phiên do chính máy chủ MCP gắn thêm sau khi hook cho qua thì guard không thấy — CI/review là lớp sau."""
    pr_text = MCP_TEXT_RE.fullmatch(tool_name) or _mcp_issue_update(tool_name, tool_input)
    if not pr_text or not AI_ATTRIBUTION_KEY_RE.search(_read_head(_xt_yaml_for(root))):
        return ""
    texts = [v for v in (tool_input.get(k) for k in MCP_TEXT_KEYS) if isinstance(v, str)]
    hit = next((m.group(0) for t in texts for m in [AI_ATTRIBUTION_RE.search(t)] if m), "")
    if not hit:
        return ""
    return (
        f"Ghi công AI qua {tool_name} bị khung chặn (`{hit}` — xt.yaml `ai_attribution: forbid`, LOOP-HARNESS-027): "
        "bỏ dòng tên model/URL phiên khỏi tiêu đề/thân/message rồi gọi lại."
    )


# Tiêu đề PR và subject commit kiểm LÚC ĐẶT (LOOP-HARNESS-029, D-255) — cùng luật workflow `pr-title`, `merge-check` và
# `xt.py pr title-check` (D-056; test đối chiếu với xt.py). Subject commit chỉ ép độ dài: commit merge/revert của git
# không theo type. `pr_title_check: off` ở xt.yaml gần nhất → bỏ. Giá trị guard không đọc được lúc quyết định (`$…`,
# backtick, `--fill`, message qua ống) → cho qua; CI `pr-title`/BASE-REPO-005 là lớp sau.
PR_TITLE_TYPES = ("feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert")
PR_TITLE_RE = re.compile(rf"({'|'.join(PR_TITLE_TYPES)})(\([a-z0-9._/-]+\))?!?: .+")
PR_TITLE_MAX = 100
PR_TITLE_OFF_RE = re.compile(r"^pr_title_check:[ \t]*([\"']?)off\1[ \t]*(?:#.*)?$", re.M)
# Cờ của `gh pr create|edit` ăn một token giá trị — bóc để `-b "-t x"` không bị đọc thành tiêu đề.
GH_PR_VALUE_FLAGS = {
    *("-b", "--body", "-F", "--body-file", "-B", "--base", "-H", "--head", "-a", "--assignee", "-l", "--label"),
    *("-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template", "-R", "--repo"),
    *("--add-assignee", "--add-label", "--add-project", "--add-reviewer", "--remove-assignee", "--remove-label"),
    *("--remove-project", "--remove-reviewer", "--recover"),
}
MCP_PR_TITLE_RE = re.compile(r"mcp__.+__(create_pull_request|update_pull_request)")
MCP_COMMIT_RE = re.compile(r"mcp__.+__(create_or_update_file|push_files|delete_file)")
COMMIT_MESSAGE_OPTS = {"-m": "m", "--message": "m", "-F": "F", "--file": "F"}
TITLE_FIX = (
    f"viết lại dạng `<type>(scope): mô tả` ≤ {PR_TITLE_MAX} ký tự rồi chạy lại "
    "(kiểm trước: `xt.py pr title-check '<tiêu đề>'`)"
)
# AUD-SEC-386 (review #420): `issue_write` sửa theo số mà issue có thể là PR — guard không tra nên tiêu đề issue thường
# cũng bị luật PR (đánh đổi có chủ ý, AUD-SEC-344); lý do nói rõ để agent không tưởng luật sai.
ISSUE_AS_PR_NOTE = (
    "; `issue_write` sửa theo số và issue có thể là PR — guard không tra nên áp luật tiêu đề PR; issue thường: tiêu đề"
    " dạng trên vẫn hợp lệ, hay chỉ sửa thân/nhãn"
)


def _opaque(text: str) -> bool:
    """Chữ shell còn mở rộng lúc chạy (biến, `$(…)`, backtick) — guard không biết giá trị thật."""
    return "$" in text or "`" in text


def pr_title_problem(title: str) -> str:
    """Lỗi của tiêu đề PR theo luật `pr-title` ('' = hợp lệ); `Revert "…"` của nút Revert được miễn như merge-check."""
    title = title.strip()
    if title.startswith('Revert "'):
        return ""
    bad = [f"dài {len(title)} ký tự > {PR_TITLE_MAX}"] if len(title) > PR_TITLE_MAX else []
    if not PR_TITLE_RE.fullmatch(title):
        bad.append(f"sai dạng `<type>(scope): mô tả` (type: {'|'.join(PR_TITLE_TYPES)})")
    return "; ".join(bad)


def commit_subject_problem(message: str) -> str:
    """Subject (dòng không trống đầu tiên, như git dọn) dài hơn PR_TITLE_MAX → lỗi; '' = hợp lệ hoặc không đọc được."""
    subject = next((ln.rstrip() for ln in message.splitlines() if ln.strip()), "")
    if _opaque(subject) or len(subject) <= PR_TITLE_MAX:
        return ""
    return f"subject dài {len(subject)} ký tự > {PR_TITLE_MAX}"


def commit_msg_problem(path: str, root: str) -> str:
    """Lý do chặn cho git hook `commit-msg` (ADR-0064 lát C — sàn cho công cụ không có hook chặn): subject quá
    PR_TITLE_MAX (LOOP-HARNESS-029); ghi công AI khi xt.yaml khai `ai_attribution: forbid` (LOOP-HARNESS-027). Dòng `#`
    bị bỏ như git dọn message. '' = cho qua."""
    text = "\n".join(ln for ln in _read_head(path).splitlines() if not ln.startswith("#"))
    problem = commit_subject_problem(text)
    if problem:
        return f"Commit bị khung chặn ({problem} — LOOP-HARNESS-029): rút gọn dòng đầu ≤ {PR_TITLE_MAX} ký tự."
    hit = AI_ATTRIBUTION_RE.search(text) if AI_ATTRIBUTION_KEY_RE.search(_read_head(_xt_yaml_for(root))) else None
    if hit:
        return (
            f"Commit ghi công AI bị khung chặn (`{hit.group(0)}` — xt.yaml `ai_attribution: forbid`, LOOP-HARNESS-027): "
            "bỏ dòng tên model/URL phiên."
        )
    return ""


def _gh_pr_titles(args: List[str]) -> List[str]:
    """Giá trị `-t/--title` của `gh pr create|edit` (sau `pr`, bỏ `-R/--repo x`); lệnh khác → []."""
    rest = list(args)
    while rest[:1] in (["-R"], ["--repo"]) or rest[:1] and rest[0].startswith("--repo="):
        rest = rest[2:] if rest[0] in ("-R", "--repo") else rest[1:]
    if rest[:1] not in (["create"], ["new"], ["edit"]):
        return []
    # pflag: `-t` gộp sau cờ bool ngắn của `create` (`-dt x`, `-ftx`); `-t=x` là giá trị `x` (review #343).
    short = re.compile(r"-t(=?)(.*)" if rest[0] == "edit" else r"-[dfw]*t(=?)(.*)", re.S)
    out: List[str] = []
    skip = False
    for i, x in enumerate(rest[1:], 1):
        if skip:
            skip = False
            continue
        key, sep, val = x.partition("=")
        m = short.fullmatch(x)
        if x == "--title" or m and not m.group(1) and not m.group(2):
            out.append(rest[i + 1] if i + 1 < len(rest) else "")
            skip = True
        elif sep and key == "--title":
            out.append(val)
        elif m:  # `-tfeat: x`, `-t=feat: x`, `-dtfeat: x`
            out.append(m.group(2))
        skip = skip or x in GH_PR_VALUE_FLAGS
    return out


def _commit_message(args: List[str], gdir: str, bodies: List[str]) -> Optional[str]:
    """Message của `git commit` guard đọc được: `-m` đầu tiên (subject nằm ở đó), file `-F`, thân heredoc (`-F -`,
    `-m "$(cat <<E…)"`); không có/không đọc được → None."""
    for i, x in enumerate(args):
        key, sep, val = x.partition("=")
        m = COMMIT_SHORT_VALUE_RE.match(x)
        if x in COMMIT_MESSAGE_OPTS:
            kind, v = COMMIT_MESSAGE_OPTS[x], args[i + 1] if i + 1 < len(args) else ""
        elif sep and key in ("--message", "--file"):
            kind, v = COMMIT_MESSAGE_OPTS[key], val
        elif m and m.group(2) in "mF" and not x.startswith("--"):
            kind, v = m.group(2), x[m.end() :] or (args[i + 1] if i + 1 < len(args) else "")
        else:
            continue
        if v == "-" and kind == "F" or kind == "m" and "$(" in v:
            return bodies[0] if bodies else None
        return (_read_head(posixpath.join(gdir, v)) or None) if kind == "F" else v
    return None


def title_rule(cmd: str, commands: List[Tuple[List[str], Optional[str]]], root: str) -> str:
    """Lý do chặn khi `gh pr create|edit` đặt tiêu đề sai luật `pr-title` hoặc `git commit` có subject quá dài; không thì
    rỗng (LOOP-HARNESS-029)."""
    for argv, here in commands:
        target = _attribution_target(argv, here, root)
        if target is None or PR_TITLE_OFF_RE.search(_read_head(_xt_yaml_for(target[0]))):
            continue
        gdir, _, kind = target
        n = normalize(argv)
        if kind == "pr":
            bad = next(
                ((t, p) for t in _gh_pr_titles(n[2:]) if not _opaque(t) for p in [pr_title_problem(t)] if p), None
            )
            if bad:
                return f"Tiêu đề PR bị khung chặn ({bad[1]}: {bad[0][:100]!r} — LOOP-HARNESS-029, D-056): {TITLE_FIX}."
            continue
        message = _commit_message(n[2:], gdir, _heredoc_bodies(cmd))
        problem = commit_subject_problem(message) if message is not None else ""
        if problem:
            return (
                f"Commit bị khung chặn ({problem} — LOOP-HARNESS-029: subject có thể thành subject commit squash): "
                f"rút gọn dòng đầu ≤ {PR_TITLE_MAX} ký tự, chi tiết đưa xuống thân rồi chạy lại."
            )
    return ""


def mcp_title(tool_name: str, tool_input: Dict[str, object], root: str) -> str:
    """Tiêu đề PR (`create|update_pull_request`) và subject commit (`create_or_update_file`, `push_files`, `delete_file`)
    qua tool MCP — cùng luật `title_rule`; không thì rỗng."""
    if PR_TITLE_OFF_RE.search(_read_head(_xt_yaml_for(root))):
        return ""
    title, message = tool_input.get("title"), tool_input.get("message")
    pr = MCP_PR_TITLE_RE.fullmatch(tool_name) or _mcp_issue_update(tool_name, tool_input)
    if pr and isinstance(title, str) and pr_title_problem(title):
        note = "" if MCP_PR_TITLE_RE.fullmatch(tool_name) else ISSUE_AS_PR_NOTE
        return f"Tiêu đề PR qua {tool_name} bị khung chặn ({pr_title_problem(title)} — LOOP-HARNESS-029{note}): {TITLE_FIX}."
    if MCP_COMMIT_RE.fullmatch(tool_name) and isinstance(message, str) and commit_subject_problem(message):
        return (
            f"Commit qua {tool_name} bị khung chặn ({commit_subject_problem(message)} — LOOP-HARNESS-029): rút gọn "
            f"dòng đầu ≤ {PR_TITLE_MAX} ký tự rồi gọi lại."
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


def _chain_assign(exported: Dict[str, str], c: List[str]) -> None:
    """Gộp biến mà lệnh `c` đặt cho các lệnh sau trong cùng chuỗi vào `exported`: `export`/`declare`… hay gán trần
    (`F=x; git …` — chiều chặt: gán trần cũng tính; `unset` không trừ)."""
    s = _strip_prefixes(c)
    if not s or s[0] in DECLARE_CMDS:
        exported.update(_assign_values(c))


def _track_env(res: Dict[str, object], argv: List[str]) -> Dict[str, str]:
    """Môi trường (tên → giá trị) mà chuỗi lệnh đã đặt tới lệnh `argv` (kể cả nó), như `_git_alias_sources` (D-216)."""
    prev = res.get("exported_env")
    env: Dict[str, str] = dict(prev) if isinstance(prev, dict) else {}
    _chain_assign(env, argv)
    res["exported_env"] = env
    return env


def _command_verdict(
    n: List[str], argv: List[str], root: str, cwd: Optional[str], gdir: Optional[str]
) -> Tuple[str, str]:
    """`command_rules` rồi nới việc chỉ trong dự án/tmp ở pha build (ADR-0040)."""
    verdict = command_rules(n, root, (gdir if n[0] == "git" else cwd) or root)
    forged = verdict[1].startswith(REMOTE_REF_MARK)  # giả ref remote: không nới ở pha build (AUD-SEC-119)
    return ("", "") if verdict[0] in BLOCKING and not forged and build_local_command(n, argv, root, cwd) else verdict


def _git_metadata_creation_ask(n: List[str]) -> str:
    """AUD-SEC-445: không để init/clone tự chuyển `.git` thành gitfile (kể cả cờ dài viết tắt)."""
    if n[:2] not in (["git", "init"], ["git", "clone"]):
        return ""
    options = itertools.takewhile(lambda token: token != "--", n[2:])
    if any(_long_match(token.partition("=")[0], ("--separate-git-dir",)) for token in options):
        return GIT_HOOK_WHY.format("--separate-git-dir (AUD-SEC-445)")
    return ""


def _creates_bare_git_dir(argv: List[str]) -> bool:
    n = normalize(argv)
    if n[:2] not in (["git", "init"], ["git", "clone"]):
        return False
    options, _, _ = _parse_opts(n[2:], "", ())
    return _has_opt(options, {"--bare", "--mirror"}) or ("--bare", "") in _git_globals(_strip_prefixes(argv))


def _pending_git_metadata(path: str) -> bool:
    """Đuôi metadata có thể thuộc Git dir chưa được tạo khi guard kiểm cả chuỗi lệnh Bash."""
    return GIT_METADATA_TAIL_RE.search("/" + _norm_path(path).lstrip("/")) is not None


# AUD-SEC-452: cờ không nhận giá trị / tuỳ chọn nhận giá trị ở token kế của `git init|clone` (git-init(1), git-clone(1))
# — để tìm thư mục repo trần được tạo; gặp cờ khác (viết tắt, cụm cờ ngắn) → thư mục không biết (chiều chặt)
BARE_CREATE_FLAGS = frozenset(
    "--bare --mirror -q --quiet -n --no-checkout -l --local --no-hardlinks -s --shared --progress --no-tags"
    " --single-branch --no-single-branch -v --verbose --no-reject-shallow --reject-shallow --remote-submodules"
    " --no-remote-submodules --shallow-submodules --no-shallow-submodules --sparse --also-filter-submodules"
    " --recurse-submodules --no-recurse-submodules".split()  # `--recurse-submodules[=<pathspec>]`: giá trị chỉ qua `=`
)
BARE_CREATE_VALUE_OPTS = frozenset(
    "-b --initial-branch --branch --object-format --ref-format --template --separate-git-dir -o --origin -u"
    " --upload-pack --reference --reference-if-able --depth -c --config --filter -j --jobs --shallow-since"
    " --shallow-exclude --server-option --bundle-uri".split()
)
# Lệnh mà chuỗi có repo trần vừa tạo vẫn được khớp đích theo đúng thư mục repo đó (AUD-SEC-452); lệnh khác (ln/mv/cp/rm,
# shell lồng, trình thông dịch, biến làm tên lệnh…) có thể dời/nhân bản/trỏ thư mục mới tạo → mọi đuôi metadata (#435)
PENDING_BARE_PLAIN_HEADS = frozenset("printf echo cat tee touch mkdir true false test [ ls pwd cd head tail wc".split())
PENDING_BARE_GIT_SUBS = frozenset("init clone status log diff show add".split())


def _bare_git_created(argv: List[str], here: Optional[str]) -> Optional[str]:
    """Thư mục repo trần lệnh `argv` tạo (`git init --bare X`, `git clone --bare|--mirror U X`, kể cả `-C`); không
    tạo → None; tạo mà không biết chắc chỗ (biến, cờ lạ, `GIT_DIR`, clone không nêu thư mục) → ''."""
    if not _creates_bare_git_dir(argv):
        return None
    s = _strip_prefixes(argv)
    base = _git_dir(argv, here)
    if (
        base is None
        or any("GIT_DIR" in t for t in argv)
        or {"--git-dir", "--work-tree"} & {o for o, _ in _git_globals(s)}
    ):
        return ""
    n = normalize(argv)
    pos: List[str] = []
    args = iter(n[2:])
    for a in args:
        if a == "--":
            pos += list(args)
        elif a in BARE_CREATE_VALUE_OPTS:
            next(args, None)
        elif a.startswith("-") and not (a in BARE_CREATE_FLAGS or a.startswith("--") and "=" in a):
            return ""
        elif not a.startswith("-"):
            pos.append(a)
    want = 1 if n[1] == "init" else 2
    if len(pos) > want or (n[1] == "clone" and len(pos) < want):
        return ""
    d = pos[want - 1] if len(pos) == want else "."
    if re.search(r"[$`*?\[\\]", d) or (d.startswith("~") and not HOME_TILDE_RE.match(d)):
        return ""
    return posixpath.join(_git_C_raw(argv, here), posixpath.expanduser(d))


def _git_C_raw(argv: List[str], here: Optional[str]) -> str:
    """Thư mục của `git -C …` dạng THÔ chưa chuẩn hoá (AUD-SEC-467: `-C lnk init --bare ../F` là lnk vật lý rồi `..`
    — `_phys_dir` giải khi so)."""
    raw = here or "/"
    for c in _git_C_dirs(argv):
        raw = posixpath.join(raw, posixpath.expanduser(c))
    return raw


def _phys_dir(path: str) -> str:
    """AUD-SEC-467: khoá so thư mục vật lý của đường tuyệt đối CHƯA chuẩn hoá — realpath (symlink giải trước `..` như
    kernel) rồi casefold (hệ tệp không phân biệt hoa/thường: `Fq` = `fq`); `..` sau phần chưa có lúc kiểm → '' (không
    chắc — khớp mọi đuôi metadata như #435)."""
    parts = path.split("/")
    if any(part == ".." and not os.path.isdir("/".join(parts[:k]) or "/") for k, part in enumerate(parts)):
        return ""
    return _realpath_safe(path).casefold()


def _pending_bare(cmd: str, commands: List[Tuple[List[str], Optional[str]]]) -> Optional[FrozenSet[str]]:
    """Repo trần tạo trong chuỗi (AUD-SEC-446) — tập thư mục; phần tử '' = khớp mọi đuôi metadata như #435 (không biết
    thư mục, hay chuỗi có lệnh ngoài `PENDING_BARE_PLAIN_HEADS`); None = không tạo."""
    created = _created_git_dirs(commands)
    return frozenset(created | ({""} if created and _pending_bare_broad(cmd, commands) else set())) or None


def _created_git_dirs(commands: List[Tuple[List[str], Optional[str]]]) -> Set[str]:
    """Repo trần tạo (`_bare_git_created`) và Git dir giả dựng (`_fake_git_dirs`) trong chuỗi; '' = không biết chỗ."""
    created = {d for argv, here in commands if (d := _bare_git_created(argv, here)) is not None}
    return created | _fake_git_dirs(commands)


def _fake_git_dirs(commands: List[Tuple[List[str], Optional[str]]]) -> Set[str]:
    """AUD-SEC-454: thư mục D mà chuỗi tự dựng thành Git dir — ghi `D/HEAD` hay tạo `D/objects` (`mkdir`) — để ghi
    `D/config`/`D/hooks/*` trong cùng lệnh xét như ghi metadata repo trần đang chờ (không theo thứ tự: `config` ghi trước
    `HEAD` vẫn thành Git dir). Thư mục không biết (`here` None với đường tương đối, biến) → '' (mọi đuôi metadata)."""
    out: Set[str] = set()
    for argv, n, here in _env_commands(commands):
        out |= _copied_git_dirs(n, here)
        paths = [(p, "HEAD") for p in write_targets(n, argv)]
        if n[:1] == ["mkdir"]:
            paths += [(p, "objects") for p in _positionals(n[1:], ("-m", "--mode", "--context"))]
        for path, mark in paths:
            parts = posixpath.expanduser(path).split("/")  # thô: `..`/symlink do `_phys_dir` giải (AUD-SEC-467)
            for k in [k for k, part in enumerate(parts) if part == mark and (mark == "objects" or k == len(parts) - 1)]:
                d = "/".join(parts[:k]) or ("/" if path.startswith("/") else ".")
                unknown = re.search(r"[$`*?\[]", d) or (here is None and not d.startswith("/"))
                full = posixpath.join(here or "/", d)
                # T-3674: thư mục đã có `.git` (gốc dự án) — git dò thấy `.git` trước, không nhận chính nó là Git dir;
                # chỉ `GIT_DIR`/`--git-dir` tường minh mới nhận (đã chặn riêng: `_git_cfg_env_why`, `hook_bypass`).
                # AUD-SEC-487: chỉ `.git` làm git dừng dò (gitfile, Git dir hợp lệ) — `.git` rỗng/hỏng git bỏ qua
                if unknown or not _stops_git_discovery(posixpath.join(full, ".git")):  # đường thô: kernel giải `..`
                    out.add("" if unknown else full)
    return out


GIT_DIR_COPIERS = ("cp", "rsync", "scp")


def _copied_git_dirs(n: List[str], here: Optional[str]) -> Set[str]:
    """AUD-SEC-465: dựng Git dir bằng sao chép — `cp -r .git d`, `cp -a <trần> d`, `rsync -a .git/ d/`, `scp -r` — nguồn
    tên `.git` hay là Git dir có thật lúc kiểm → đích (đích chưa có) và `đích/<tên nguồn>` (đích đã là thư mục) thành Git
    dir đang chờ; đích là biến/tương đối khi thư mục không biết → '' (mọi đuôi metadata)."""
    if not n or n[0] not in GIT_DIR_COPIERS:
        return set()
    pos = _copy_into_positionals(n)  # (nguồn…, đích), `-t D` đã đưa về cuối
    srcs, dest = pos[:-1], pos[-1] if pos else ""
    out: Set[str] = set()
    for src in srcs:
        p = posixpath.normpath(posixpath.expanduser(src))
        rel = not p.startswith("/")
        absolute = "" if here is None and rel else _norm_path(posixpath.join(here or "/", p))
        if posixpath.basename(p) != ".git" and not (absolute and _git_metadata_dir(absolute)):
            continue
        d = posixpath.expanduser(dest)
        if re.search(r"[$`*?\[]", d) or (here is None and not d.startswith("/")):
            out.add("")
            continue
        d = posixpath.join(here or "/", d)
        out |= {d, posixpath.join(d, posixpath.basename(p))}
    return out


def _pending_bare_broad(cmd: str, commands: List[Tuple[List[str], Optional[str]]]) -> bool:
    for argv, _ in commands:
        n = normalize([t for t in argv if t not in SHELL_KEYWORDS])
        if n[:1] == ["git"] and n[1:2] and n[1] in PENDING_BARE_GIT_SUBS or not n or n[0] in PENDING_BARE_PLAIN_HEADS:
            continue
        return True
    return "$" in cmd or "`" in cmd


def _pending_bare_hit(path: str, here: Optional[str], pending: Optional[FrozenSet[str]]) -> bool:
    """Đích ghi `path` (tính từ `here`) có thể là metadata của repo trần đang chờ tạo (AUD-SEC-446/452): khớp đuôi và
    tiền tố là thư mục được tạo — hoặc không chắc (thư mục không biết, tiền tố qua symlink, tập có `''`). Chuỗi không
    có lệnh dời/nhân bản/trỏ thư mục (`_pending_bare_broad`) nên tiền tố khác thư mục được tạo không thành repo đó."""
    if not pending or not _pending_git_metadata(path):
        return False
    p = posixpath.expanduser(path)
    if "" in pending or re.search(r"[$`*?\[]", p) or (here is None and not p.startswith("/")):
        return True
    # AUD-SEC-467: so khoá vật lý (`_phys_dir`) của cả đường thô lẫn đường đã chuẩn hoá — `lnk/../F` khác chữ `deep/F`
    made = {_phys_dir(c) for c in pending}
    if "" in made:
        return True
    raw = posixpath.join(here or "/", p)
    for absolute in (raw, _norm_path(raw)):
        for m in GIT_METADATA_TAIL_RE.finditer(absolute):
            key = _phys_dir(absolute[: m.start()] or "/")
            if not key or key in made:
                return True
    absolute = _norm_path(raw)
    return any(  # tiền tố qua symlink (#435)
        _realpath_safe(absolute[: m.start()] or "/") != (absolute[: m.start()] or "/")
        for m in GIT_METADATA_TAIL_RE.finditer(absolute)
    )


def _pending_git_write_asks(
    commands: List[Tuple[List[str], Optional[str]]], pending: Optional[FrozenSet[str]]
) -> List[str]:
    """AUD-SEC-446: repo trần tạo trong cùng lệnh chưa có HEAD; tách việc tạo khỏi ghi thô đuôi metadata của nó.
    AUD-SEC-494: giải nén vào thư mục D (cả `TAR_OPTIONS=-CD`, `UNZIP=-dD`, ngầm `cd D && tar -x`) có thể ghi `D/hooks/*`
    — xét như ghi `D/hooks`, chỉ khi D liên quan repo trần/Git dir giả có thật (`_extract_pending_hit`, AUD-SEC-514)."""
    unknown = "" in _created_git_dirs(commands)
    made = {_phys_dir(c) for c in pending or () if c}
    asks: List[str] = []
    for argv, n, here in _env_commands(commands):
        asks += [GIT_HOOK_WHY.format(p) for p in write_targets(n, argv) if _pending_bare_hit(p, here, pending)]
        hits = [d for d in _extract_here(n) if _extract_pending_hit(d, here, made, unknown)]
        asks += [GIT_HOOK_WHY.format(posixpath.join(d, "hooks")) for d in hits]
    return asks


def _extract_pending_hit(d: str, here: Optional[str], made: Set[str], unknown: bool) -> bool:
    """AUD-SEC-514: giải nén vào D (tính từ `here`) có thể ghi `hooks/*` của repo trần đang chờ/Git dir giả khi D là, nằm
    trong hay chứa (archive mang `X/hooks/…`) thư mục đó (khoá vật lý `made`), hay không biết (D có mở rộng, `here` None,
    thư mục tạo không biết chỗ — `unknown`). Phần tử '' của `_pending_bare_broad` (chuỗi có tar/unzip) KHÔNG tính: mọi
    đích giải nén từng bị coi là trúng."""
    if not made and not unknown:
        return False
    p = posixpath.expanduser(d)
    if unknown or "" in made or re.search(r"[$`*?\[]", p) or (here is None and not p.startswith("/")):
        return True
    key = _phys_dir(posixpath.join(here or "/", p))
    k = key.rstrip("/") + "/"
    return not key or any(k.startswith(m + "/") or m.startswith(k) for m in made)


def _env_commands(
    commands: List[Tuple[List[str], Optional[str]]],
) -> Iterator[Tuple[List[str], List[str], Optional[str]]]:
    """AUD-SEC-494: (argv, `normalize(argv)` đã ghép tuỳ chọn từ biến môi trường — `_with_env_opts`, gán đầu lệnh và
    `export`/gán trần đứng trước trong chuỗi như `_track_env` —, thư mục) — bộ đọc đích ghi/giải nén dùng chung cho repo
    trần đang chờ và Git dir giả, như `_write_asks`."""
    env: Dict[str, str] = {}
    for argv, here in commands:
        _chain_assign(env, argv)
        yield argv, _with_env_opts(normalize(argv), argv, env), here


def _discover_bare_git_dir(path: str, ceilings: str, across: Tuple[str, ...], objdir: bool = False) -> str:
    """Tìm Git dir trần ở thư mục đang đứng hoặc cha, dừng ở worktree, ceiling hay ranh giới hệ tệp như Git. `objdir`:
    nhánh git chạy với `GIT_OBJECT_DIRECTORY` (`_git_metadata_dir`, AUD-SEC-496) — tường minh, không đọc môi trường
    guard (AUD-SEC-510: người gọi dò cả hai nhánh); miễn `.git` (`_stops_git_discovery`) KHÔNG nới theo biến — biến có
    thể không tới git (`env -u`, `unset`), lúc đó `.git` thiếu `objects` không dừng dò."""
    stop = {_realpath_safe(item) for item in ceilings.split(os.pathsep) if os.path.isabs(item)}
    cross = any(value.lower() not in ("", "false", "no", "off", "0") for value in across)
    directory = _realpath_safe(path)
    while True:
        if _stops_git_discovery(os.path.join(directory, ".git")):  # AUD-SEC-487: `.git` hỏng git bỏ qua
            return ""
        if _git_metadata_dir(directory, objdir):
            return directory
        parent = os.path.dirname(directory)
        if parent == directory or parent in stop or not cross and os.path.ismount(directory):
            return ""
        directory = parent


def _explicit_bare_cwd(command: List[str], cwd: Optional[str]) -> Optional[str]:
    """`git --bare` lấy Git dir tại đúng vị trí cờ, sau các `-C` đứng trước nó."""
    leading = ["git"]
    for flag, value in _git_globals(command):
        if flag == "--bare":
            return _git_dir(leading, cwd) or cwd or ""  # `-C "$X"` chưa giải: thử thư mục ứng viên (AUD-SEC-449)
        if flag == "-C":
            leading.extend((flag, value))
    return None


def _bare_git_config_ask(
    n: List[str], argv: List[str], cwd: Optional[str], env: Dict[str, str], dirs: FrozenSet[str] = frozenset()
) -> str:
    """AUD-SEC-446: chặn khóa chạy lệnh có sẵn trong config repo trần; `git config` vẫn đọc được để chẩn đoán.
    AUD-SEC-449: thư mục chạy không biết (`cd "$X"`, `git -C "$X"`) → thử như D-106 ở mọi thư mục đã biết của quyết
    định (`dirs`: gốc, thư mục bắt đầu, đích `cd` đã giải) — repo trần nào trong đó có khoá nguy hiểm thì chặn; gốc dự
    án có `.git` nên `cd "$X" && git status` vẫn qua."""
    if n[:1] != ["git"] or not n[1:2] or n[1] in ("init", "clone", "config"):
        return ""
    known = cwd is not None and _git_dir(argv, cwd) is not None
    bases = [cwd] if known else sorted({*dirs, *([cwd] if cwd else [])})
    return next((a for b in bases if b and (a := _bare_git_config_from(argv, b, env))), "")


def _bare_git_config_from(argv: List[str], cwd: str, env: Dict[str, str]) -> str:
    """`_bare_git_config_ask` với thư mục bắt đầu `cwd`; `-C` chưa giải (`$X`) → thử chính `cwd` (ứng viên D-106)."""
    directory = _git_dir(argv, cwd) or cwd
    command = _strip_prefixes(argv)
    prefix = argv[: len(argv) - len(command)]
    inline = _assign_values(prefix)
    # Chỉ gán tiền tố trực tiếp chắc chắn tới git; gán trần hoặc `env -u` có thể không đặt ceiling như guard thấy.
    ceilings = inline.get("GIT_CEILING_DIRECTORIES", "") if all(ENV_ASSIGN_RE.fullmatch(t) for t in prefix) else ""
    across = "GIT_DISCOVERY_ACROSS_FILESYSTEM"
    values = os.environ.get(across, ""), env.get(across, ""), inline.get(across, "")
    bare = _explicit_bare_cwd(command, cwd)
    if bare is not None:
        return _bare_config_read_ask(bare)
    # AUD-SEC-510: `GIT_OBJECT_DIRECTORY` (thừa hưởng, chuỗi, tiền tố) có thể không tới git (`unset`, `env -u`, `env -i`)
    # — dò cả nhánh có lẫn không biến, nhánh nào gặp khoá nguy hiểm thì chặn
    branches = dict.fromkeys((False, any(OBJECT_DIR_ENV in m for m in (os.environ, env, inline)))) if directory else {}
    found = [_discover_bare_git_dir(directory, ceilings, values, o) for o in branches]
    return next((a for b in found if (a := _bare_config_read_ask(b))), "")


def _bare_config_read_ask(bare: str) -> str:
    """Khoá chạy lệnh trong config (và config.worktree) của Git dir `bare`; rỗng → không có."""
    if not bare:
        return ""
    common = _git_dir_pointer(os.path.join(bare, "commondir")) or bare
    return _git_config_read_ask(os.path.join(common, "config")) or _git_config_read_ask(
        os.path.join(bare, "config.worktree")
    )


def _git_config_read_ask(config: str) -> str:
    """Đọc riêng tệp config, không theo include; xét cả config.worktree nếu tệp có mặt (AUD-SEC-446)."""
    if not os.path.isfile(config):
        return ""
    try:
        result = subprocess.run(
            ["git", "--no-pager", "config", "--file", config, "--no-includes", "--null", "--list"],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=1,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return GIT_HOOK_WHY.format(f"{config} (AUD-SEC-446: không đọc được)")
    for item in os.fsdecode(result.stdout).split("\0"):
        key, _, value = item.partition("\n")
        if key.lower() == "core.hookspath" or GIT_EXEC_KEY_RE.fullmatch(key) and _git_exec_value_unsafe(key, value):
            return GIT_HOOK_WHY.format(f"{config} ({key}, AUD-SEC-446)")
    return ""


def _scan_command(
    argv: List[str],
    root: str,
    res: Dict[str, object],
    asks: List[str],
    cwd: Optional[str] = None,
    dirs: FrozenSet[str] = frozenset(),
) -> Optional[str]:
    """Quét một lệnh đơn: thêm câu hỏi vào `asks`, ghi cờ commit (kèm thư mục commit) vào `res`; trả lý do deny nếu phải chặn.
    `dirs`: thư mục đã biết của quyết định (ứng viên khi `cwd` không biết — AUD-SEC-449)."""
    env = _track_env(res, argv)
    n = normalize(argv)
    if not n:  # chỉ chuyển hướng: `exec 3> .env`, `> .env` (review #186 lần 2) — vẫn là ghi
        asks.extend(_write_asks(n, argv, root, cwd))
        return None
    _alias_rule(argv)
    asks.extend(_unknown_git_opt_asks(n, argv))
    # `commit`/`push` tác động lên repo ở `cd …`/`git -C …`; thư mục không rõ → push dùng gốc dự án (hỏi > cho qua).
    # Lệnh git ghi ref (AUD-SEC-119) cũng cần repo thật để đọc tên remote của nó.
    gdir = _git_dir(argv, cwd) if n[0] == "git" and n[1:2] and n[1] in GIT_DIR_SUBS else None
    # Lệnh khác git (rm/find) xét đích theo thư mục đang đứng sau `cd` (`cd ~ && rm -rf projects`).
    decision, why = _stricter(_command_verdict(n, argv, root, cwd, gdir), remote_config_oneshot(argv, n, env))
    if decision == "deny":
        return f"Lệnh bị khung chặn ({why}): {' '.join(argv)[:300]}. Muốn làm thật thì người dùng tự chạy."
    if decision == "ask":
        asks.append(f"{why}: {' '.join(argv)[:200]}")
    if decision == "allow":  # chỉ hiệu lực khi cả lệnh Bash là đúng một lệnh này (bash_decision)
        res["allow"] = why
    bypass = (
        hook_bypass(argv, n, _track_exports(res, argv, n), env)
        or _git_metadata_creation_ask(n)
        or _bare_git_config_ask(n, argv, cwd, env, dirs)
    )
    if bypass:
        asks.append(f"{bypass}: {' '.join(argv)[:200]}")
    asks.extend(_write_asks(n, argv, root, cwd, env))
    if n[0] in (*DB_CLIENTS, "docker", "podman") and decision != "ask":  # `PGHOST=… psql`: normalize đã bóc phần gán
        pairs = [_assign_split(t) for t in argv[: len(argv) - len(n)] if ENV_ASSIGN_RE.fullmatch(t)]
        assigns = [f"{k}={v}" for k, v in pairs]
        docker = [v for k, v in pairs if k == "DOCKER_HOST" and _docker_remote(v)]
        remote = next((h for h in _env_hosts(assigns) if not _is_local_host(h)), "") or next(iter(docker), "")
        if remote:
            asks.append(f"{EGRESS_ASK} — {n[0]} tới máy chủ {remote}: {' '.join(argv)[:200]}")
    # AUD-SEC-430: cả `export GIT_CONFIG_KEY_0=core.hooksPath …; git commit` (biến đã đặt ở lệnh trước trong chuỗi)
    if n[:2] == ["git", "commit"] and _commit_hooks_path(argv + [f"{k}={v}" for k, v in env.items()]):
        # `git -c core.hooksPath=… commit`, `GIT_CONFIG_KEY_n=core.hooksPath … git commit` = --no-verify: git hook của
        # dự án không chạy — cùng câu hỏi như --no-verify (strict hỏi người; mặc định cổng của khung vẫn chạy).
        res["no_verify"] = True
        asks.append("commit với `core.hooksPath` bỏ qua git hook — cần người xác nhận lý do")
    _git_cfg_hook_ask(n, argv, env, res, asks, root, cwd)
    _mark_push_no_verify(n, argv, res)
    if n[:2] == ["git", "commit"]:
        # Cổng chạy ở repo NHẬN commit (`cd ../khac && git commit`, `git -C ../khac commit`), không phải gốc phiên.
        res["commit_dir"] = gdir or ""
        return _scan_commit(n[2:], res, asks)
    return None


SCAN_CALLS = 600  # số lệnh con tối đa MỖI quyết định (lệnh bình thường dùng < 20)
SCAN_SECONDS = 8.0  # hạn giờ quét một quyết định; hook có timeout 1200 s — quá hạn thì lệnh chạy không qua guard
MAX_REWRITE = 8  # số lần viết lại CÙNG lệnh (thay biến, lệnh bọc) lồng nhau; vượt → chặn (`flock l ` ×10 + lệnh)
CMD_MAX_CHARS = 262144  # lệnh dài hơn → chặn: quét gần bậc hai theo độ dài (4 MB từng mất > 600 s, quá timeout hook)
REWRITE_MAX_CHARS = 65536  # bản viết lại dài hơn (biến 4 KB nhân lên nhiều lần) → chặn, không quét chậm hay bỏ qua


class ScanBudget:
    """Ngân sách quét MỘT quyết định: số lệnh con, hạn giờ, tập script đã quét (chặn nổ tổ hợp của bản viết lại như
    `a="$a$a"` lặp, `flock l flock l …`). Hết ngân sách → chặn (fail-closed), không để guard chạy quá hạn rồi bị bỏ qua."""

    current_alias: Optional[AliasClock] = None  # ngân sách alias của quyết định gốc gần nhất (lời gọi lồng dùng chung)

    def __init__(self, nested: bool = False) -> None:
        self.calls = SCAN_CALLS
        self.deadline = time.monotonic() + SCAN_SECONDS
        self.seen: Set[Tuple[str, Optional[str], bool]] = set()  # (script, thư mục chạy, lỏng): khác thư mục vẫn quét
        # ADR-0063, lỏng theo NGUỒN (review lát A 🔴): bản guard tự dựng (thay biến, alias git, `read <<<`) và chữ trích
        # chiều chặt từ chương trình khác (sed/awk/perl/m4, lời gọi thực thi) không qua tập con chuẩn — luật nguy hiểm vẫn
        # áp đủ. Chỉ con của chữ TRÍCH (`extracted`) mới lỏng theo; script lấy nguyên văn (`sh -c`, `eval`, lệnh bọc)
        # luôn chặt, cùng chuỗi ở hai nguồn thì chặt thắng.
        self.loose: Set[str] = set()
        self.extracted: Set[str] = set()
        self.push_no_verify = False  # có lệnh (cả lồng) `git push --no-verify` — cờ cho adapter (AUD-SEC-352)
        self.nested_deny: Tuple[str, str] = ("", "")  # (lý do, mã) của lệnh lồng bị chặn gần nhất — mã đi lên lệnh gốc
        # AUD-SEC-449: thư mục đã biết trong cả quyết định (ứng viên khi lệnh git chạy ở thư mục không biết) và repo trần
        # tạo trong cùng lệnh (đi vào shell lồng: `git init --bare X && sh -c 'printf x > X/config'`)
        self.dirs: Set[str] = set()
        self.pending_bare: Optional[FrozenSet[str]] = None
        # AUD-SEC-481: alias git đặt trong cùng lệnh (`git config alias.u …`) — shell lồng/`eval` gọi nó dùng chung bảng
        self.aliases: List[Tuple[str, Optional[str]]] = []
        # Đọc bảng alias: ngân sách TỔNG của quyết định gốc — lệnh con của `find -exec` được quét bằng quyết định mới
        # (nested) vẫn tiêu chung, không được thêm ALIAS_SECONDS mỗi lần.
        if not nested or ScanBudget.current_alias is None:
            ScanBudget.current_alias = AliasClock()
        self.alias = ScanBudget.current_alias

    def exhausted(self) -> bool:
        self.calls -= 1
        return self.calls < 0 or self.overdue()

    def overdue(self) -> bool:
        """Quá hạn giờ (không tiêu lượt gọi) — cho vòng lặp dài trong một lượt quét."""
        return time.monotonic() > self.deadline


# Độ sâu shell lồng được quét (`bash -c "bash -c '…'"`); sâu hơn → hỏi (mặc định: chặn — AUD-SEC-063). 4: `find -exec`
# tốn một bậc, `find … -exec bash -c '… sh -c "…"'` thật vẫn quét được (review #159).
MAX_NEST = 4
NEST_ASK = "shell lồng quá sâu"


SHELL_OPTS_WITH_VALUE = {"-o", "+o", "-O", "+O", "--rcfile", "--init-file"}
# Đường dẫn tới chính stdin: `bash /dev/stdin <<E` đọc lệnh từ heredoc như `bash <<E` (AUD-SEC-028).
STDIN_SCRIPTS = frozenset({"/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"})


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
    rest = [a for a in _no_redirects(n) if a != "$"]  # cả số fd trước chuyển hướng (`bash 0<<E`, `2>/dev/null`)
    has_c, script = _shell_script_arg(rest)
    stdin = script is None or _norm_path(script) in STDIN_SCRIPTS  # `/dev/./stdin`, `//dev/stdin` (AUD-SEC-511)
    return not has_c and stdin and "-n" not in rest  # `bash -n`: chỉ kiểm cú pháp


def _stdin_source(n: List[str], fed: FrozenSet[str] = STDIN_SCRIPTS) -> bool:
    """`source /dev/stdin`, `. /dev/fd/0` (cả sau `--`): shell hiện tại chạy chữ từ stdin như `bash <<<`/`bash <<E`
    (AUD-SEC-098); `fed`: tên file đọc ra chữ đó (`/dev/fd/3` khi `3< <(…)` — `_procsub_fd`)."""
    args = n[2:] if n[1:2] == ["--"] else n[1:]
    return bool(args) and _norm_path(args[0]) in fed  # `/dev/./stdin` (AUD-SEC-511)


def _shell_c_script(argv: List[str]) -> Optional[str]:
    """Chuỗi lệnh của `sh -c '<lệnh>'` (cả cờ gộp `-lc`, `-ec`, sau `-o pipefail`, `--norc`…); None nếu không phải."""
    n = normalize(argv)
    if not n or n[0] not in SHELLS:
        return None
    has_c, script = _shell_script_arg(n)
    return script if has_c else None


def _heredoc_scripts(
    cmd: str, pred: Callable[[List[str]], bool] = _stdin_shell, budget: Optional[ScanBudget] = None
) -> List[str]:
    """Thân heredoc đưa vào shell (`bash <<'E'` … `E`; `pred` chọn lệnh nhận) — là lệnh, không phải dữ liệu. Mỗi dòng mở
    tìm dấu nối một lần, mỗi pipeline tách token một lần (`cat <<A <<A …` × n: cũ tách lại mỗi heredoc — bậc hai, n=2000
    ~58 s); quá hạn `budget` → chặn (D-271)."""
    out: List[str] = []
    seps: Dict[str, List[Tuple[int, int]]] = {}
    hits: Dict[Tuple[str, int, int], bool] = {}
    for opener, m, body in _heredocs(join_continuations(cmd)):
        if budget is not None and budget.overdue():
            raise ScanTooComplex("quá hạn khi đọc heredoc vào shell/trình thông dịch")
        if opener not in seps:
            seps[opener] = _unquoted_seps(opener)
        start, end = _segment_at(opener, m.start(), seps[opener])
        key = (opener, start, end)
        if key not in hits:
            hits[key] = any(pred(c) for c in split_commands(tokenize(opener[start:end])))
        if hits[key]:
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
    return list(dict.fromkeys(body for spans in _span_readings(cmd, _backtick_spans) for _, _, body in spans))


def _span_readings(cmd: str, finder: Callable[..., List[Span]]) -> List[List[Span]]:
    """Các cách đọc thay lệnh của `cmd`: đọc `$'…'` như bash (AUD-SEC-241) và, khi khác, cách đọc cũ (`$'` = `$` + nháy
    đơn). Bộ tìm không biết comment: `$'\\''` ↵ `# c'` ↵ `` `rm` `` chỉ cách đọc cũ thấy (hai cái lệch bù nhau) — dùng
    cả hai, chỉ thêm, không bớt so với bản cũ (D-279)."""
    spans = finder(cmd)
    if "$'" not in cmd and "$$" not in cmd:
        return [spans]
    old = finder(cmd, ansi=False)
    return [spans] if old == spans else [spans, old]


def _dollar_quote_end(cmd: str, i: int) -> int:
    """Ngoài nháy: `$'…'` (ANSI-C, `\\'` không đóng) ở `i` → vị trí sau nó; `$$` trước `'`/`$` → vị trí sau `$$`
    (`$$'…'` là `$$` + nháy đơn, `$$$'…'` là `$$` + ANSI-C); khác → 0. Bộ tìm thay lệnh từng đọc `$'\\''` như `'\\'` +
    `'` mở nháy nên bỏ qua thay lệnh sau đó (AUD-SEC-241)."""
    if cmd.startswith("$$", i) and cmd[i + 2 : i + 3] in ("'", "$"):
        return i + 2
    return _skip_single(cmd, i) if cmd.startswith("$'", i) else 0


def _backtick_spans(cmd: str, ansi: bool = True) -> List[Span]:
    """Backtick ngoài nháy đơn; `ansi=False`: cách đọc cũ, `$'…'` như nháy đơn thường (`_span_readings`)."""
    out: List[Span] = []
    quote, start, i = "", -1, 0
    while i < len(cmd):
        c = cmd[i]
        skip = 0 if quote or start >= 0 or not ansi else _dollar_quote_end(cmd, i)
        if skip or c == "\\" and quote != "'":
            i = skip or i + 2
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
    return list(dict.fromkeys(body for spans in _span_readings(cmd, _dollar_spans) for _, _, body in spans))


ARITH_SCAN_MAX = 4096  # `$((` chưa thấy ngoặc đóng trong chừng này ký tự → coi là thay lệnh (quét, không bỏ qua)


def _paren_pairs(cmd: str) -> Dict[int, int]:
    """Vị trí `(` → vị trí `)` khớp nó trong cả chuỗi (đếm thô, không theo nháy), một lượt — `_arith_at` không quét lại
    từ mỗi `$((` (800 `$((` lồng × 256 KiB từng tốn ~11 s, review #361)."""
    out: Dict[int, int] = {}
    stack: List[int] = []
    for m in re.finditer(r"[()]", cmd):
        if m.group() == "(":
            stack.append(m.start())
        elif stack:
            out[stack.pop()] = m.start()
    return out


def _arith_at(cmd: str, i: int, pairs: Optional[Dict[int, int]] = None) -> bool:
    """`$((` ở `i` là số học `$((…))`: ngoặc trong đóng (trong `ARITH_SCAN_MAX` ký tự) ngay trước ngoặc ngoài. Không thì
    bash lùi về thay lệnh có subshell (`"$((gh … -F -) < f)"`) — thân phải được quét như lệnh (AUD-SEC-180). `pairs` =
    `_paren_pairs(cmd)` tính sẵn."""
    if not cmd.startswith("$((", i):
        return False
    j = (_paren_pairs(cmd) if pairs is None else pairs).get(i + 2, len(cmd))
    return j < i + ARITH_SCAN_MAX and cmd.startswith(")", j + 1)


def _dollar_spans(cmd: str, ansi: bool = True) -> List[Span]:
    """`$(…)` ngoài nháy đơn; `ansi=False`: cách đọc cũ, `$'…'` như nháy đơn thường (`_span_readings`)."""
    out: List[Span] = []
    pairs = _paren_pairs(cmd) if "$((" in cmd else {}
    quote, i = "", 0
    while i < len(cmd):
        c = cmd[i]
        skip = 0 if quote or not ansi else _dollar_quote_end(cmd, i)
        if skip or c == "\\" and quote != "'":
            i = skip or i + 2
            continue
        if c in "'\"" and quote in ("", c) and (c == '"' or quote != '"'):
            quote = "" if quote == c else c
        elif quote != "'" and cmd.startswith("$(", i) and not _arith_at(cmd, i, pairs):
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
    return ["\n".join(body) for _, m, body in _heredocs(join_continuations(cmd)) if not _heredoc_word(m)[1]]


def _eval_scripts(tokens: List[str]) -> List[str]:
    """`eval '<lệnh>'`: shell ghép các đối số rồi chạy như một dòng lệnh."""
    out = [" ".join(n[1:]) for c in split_commands(tokens) for n in [normalize(c)] if n[:1] == ["eval"] and n[1:]]
    for c in split_commands(tokens):  # `trap '<lệnh>' SIGNAL`: bash chạy thân như `eval` (AUD-SEC-226)
        n = [a for a in normalize(c) if a != "--"]
        if n[:1] == ["trap"] and len(n) > 1 and n[1] not in ("-", "-p", "-l"):
            out.append(n[1])
    return out


# AUD-SEC-251: công cụ không phải shell nhưng tự chạy lệnh shell — chuỗi lệnh ở các chỗ này quét như `sh -c`. Chiều
# chặt: xét mọi đối số (chương trình sed/awk có thể ở `-e`, `--expression=`, vị trí đầu); khớp thừa chỉ chặn khi chữ
# khớp là lệnh nguy hiểm. Ngoài phạm vi: chương trình trong file (`sed -f`, `awk -f`, đầu vào m4 từ file).
SED_NAMES = {"sed", "gsed"}
AWK_NAMES = {"awk", "gawk", "mawk", "nawk"}
TAR_NAMES = {"tar", "gtar", "bsdtar"}
# `e command` của GNU sed ăn hết dòng (cả `;` — đo GNU sed 4.9), khoảng trắng sau `e` không bắt buộc (`erm …`); đứng sau
# MỌI ký tự không phải chữ (địa chỉ `/re/`, `\%re%`, `\,re,`, `$`, số, `;{}!`) hoặc sau cờ địa chỉ `I`/`M` (`/x/Ie …`) —
# AUD-SEC-270. Chiều chặt: khớp thừa trong chỗ thay chỉ chặn khi phần sau là lệnh nguy hiểm.
SED_EXEC_CMD_RE = re.compile(r"(?:(?<![A-Za-z])|(?<=[^A-Za-z][IM]))e[ \t]*([^\n]*\S)")
# `s<d>…<d>thay<d>cờ` có cờ `e`: chỗ thay thành lệnh; thử ở MỌI vị trí `s` (lookahead) để một khớp thừa không nuốt khớp thật.
SED_SUBST_RE = re.compile(r"(?=s([^\\\n\w\s])((?:\\.|(?!\1)[^\\\n])*)\1((?:\\.|(?!\1)[^\\\n])*)\1([A-Za-z0-9]*))")
AWK_PIPE_RE = re.compile(r'\|&?\s*"((?:[^"\\]|\\.)*)"|"((?:[^"\\]|\\.)*)"\s*\|&?\s*getline')
AWK_EXEC_HINT_RE = re.compile(r"\bsystem\s*\(|\|")
TAR_CMD_LONG = ("--to-command", "--use-compress-program", "--info-script", "--new-volume-script", "--rsh-command")
M4_EXEC_RE = re.compile(r"\be?syscmd\s*\(")
# Perl/Ruby/PHP chạy shell không cần ngoặc: `system q(…)`, `exec "…"`, backtick, `qx{…}`, `%x(…)`, `open(F, "cmd|")`.
QUOTE_EXEC_FAMILIES = {"perl", "ruby", "php"}
QUOTE_EXEC_HINT_RE = re.compile(
    r"\b(?:system|exec|qx|open|popen|shell_exec|passthru|proc_open|spawn|readpipe|pcntl_exec|Open3|capture[23]e?"
    r"|popen[23]e?|open[23]|IO\.(?:read|readlines|foreach|binread|write)|Kernel\.open|URI\.open)\b|`|%x"
    # readpipe/Open3/pcntl_exec: AUD-SEC-280; IPC::Open2/3 `open3(…)`, Ruby `IO.read("|lệnh")`: AUD-SEC-292
)
SED_SCAN_MAX = 4096  # chương trình sed dài hơn mà có `s<dấu>` → chặn "quá phức tạp" (AUD-PERF-005)
# ADR-0063 lớp mã động. GNU sed nhận MỌI ký tự (cả chữ) làm dấu của `s` (AUD-SEC-294); `e` trần cả sau cờ `I`/`M`.
SED_ADDR = r"(?:\d+(?:~\d+)?|\$|/(?:\\.|[^/\\\n])*/[IM]*|[+~]\d+)"  # + GNU `first~step`, `,+N`, `,~N`
SED_ANY_SUBST_RE = re.compile(  # `s` ở vị trí lệnh (đầu, sau `;`/xuống dòng/`{}`, sau địa chỉ) — không quét chữ thay
    rf"(?:^|[;\n{{}}])\s*(?:{SED_ADDR}(?:\s*,\s*{SED_ADDR})?)?\s*!?\s*"
    r"s([^\\\n])((?:\\.|(?!\1)[^\\\n])*)\1((?:\\.|(?!\1)[^\\\n])*)\1([A-Za-z0-9]*)"
)
SED_BARE_E_RE = re.compile(r"(?:^|[^A-Za-z]|(?<=[^A-Za-z][IM]))(?<!\$\{)e[ \t]*(?:$|[;}\n])")  # `${e}`: biến shell
# awk chạy lệnh mà chữ lệnh không phải chuỗi nguyên văn: `system($0)`, `print … | cmd`, `x | getline`.
# + `system("" $0)` (ghép chuỗi), `print | "sh"` (ống tới shell) — review lát B
AWK_DYN_EXEC_RE = re.compile(
    r'\bsystem\s*\((?!\s*"[^"]*"\s*\))|\bprintf?\b[^;}\n]*\|&?\s*(?:[^"\s|&]|"(?:\S*/)?(?:ba|da|z|k|mk)?sh\b)'
    r'|[^"\s|]\s*\|&?\s*getline\b'
)
VAR_WRITER_CMDS = {"mapfile", "readarray", "read", "declare", "typeset", "local", "export", "readonly", "let"}
SPECIAL_VAR_TOKEN_RE = re.compile(r"(?:BASH_ENV|PS[0-4]|PROMPT_COMMAND)(?:\[[^\]]*\])?(?:\+?=.*)?", re.S)
SED_S_HINT_RE = re.compile(r"s[^\\\n\w\s]")
SED_PROG_LONG = ("--expression",)  # tên dài nhận chương trình sed (viết tắt `--e`, `--expr` như getopt)
AWK_PROG_LONG = ("--source",)  # gawk `--source=…`
QUOTE_LIKE_RE = re.compile(r"(?:\b(?:qq|qx|qw|q)|%[xqQwW]?)\s*([^\w\s])")  # + `qw(rm -rf /)` (review lát B)
QUOTE_PAIRS = {"(": ")", "[": "]", "{": "}", "<": ">"}
BACKTICK_BODY_RE = re.compile(r"`([^`]*)`")
# AUD-SEC-250: bash tự mở rộng giá trị prompt (`set -x` mở rộng PS4, `${x@P}`), gọi lại lệnh (`mapfile -C`,
# `compgen -C`, `compgen -W` mở rộng danh sách từ), nạp file `BASH_ENV` ở mọi bash không tương tác. `ENV` chỉ nạp ở shell
# tương tác (đo dash/bash 2026-11-01) nên không xét.
PROMPT_ASSIGN_RE = re.compile(r"(?:PS[0-4]|PROMPT_COMMAND)\+?=(.*)", re.S)  # cả `+=` (AUD-SEC-271)
ANY_ASSIGN_RE = re.compile(r"[A-Za-z_]\w*(?:\[[^]]*\])?\+?=(.*)", re.S)
BASH_ENV_RE = re.compile(r"BASH_ENV\+?=(.+)", re.S)
# Chương trình chỉ đọc/in dữ liệu, không chạy lệnh từ đối số: `BASH_ENV=…` trong đối số của chúng là chữ (AUD-SEC-254).
BASH_ENV_DATA_CMDS = {"echo", "printf", "grep", "egrep", "fgrep", "rg", "ag", "git", "cat", "head", "tail", "wc", "jq"}
QUOTE_SCAN_MAX = 4096  # tổng ký tự chuỗi/thân trích Perl/Ruby/PHP được quét (AUD-PERF-004/007); vượt → chặn
QUOTE_JOIN_MAX = 64  # số chuỗi tối đa nối khoảng trắng để quét lời gọi dạng danh sách; vượt → chặn
BASH_ENV_MARK = "bash con nạp file guard không quét"  # mã OPAQUE_EXEC (REASON_CODES)
CALLBACK_OPTS = {"mapfile": "C", "readarray": "C", "compgen": "CW", "complete": "CW"}


def _bundled_values(args: List[str], letters: str) -> List[str]:
    """Giá trị của cờ ngắn `letters` kể cả dính/gộp (`-C x`, `-Cx`, `-tC x`); cờ dài bỏ qua."""
    out: List[str] = []
    for i, a in enumerate(args):
        if a[:1] != "-" or a.startswith("--"):
            continue
        k = next((k for k, ch in enumerate(a[1:], 1) if ch in letters), 0)
        if k:
            out.append(a[k + 1 :] or (args[i + 1] if i + 1 < len(args) else ""))
    return out


def _sed_exec_scripts(args: List[str]) -> List[str]:
    """Lệnh mà chương trình sed chạy: `e lệnh` và chỗ thay của `s///e` (bỏ `\\` thoát)."""
    out: List[str] = []
    for prog in dict.fromkeys([*args, *_tool_programs(args, SED_PROG_LONG, "e")]):  # thô (luật cũ) + chương trình tách
        if len(prog) > SED_SCAN_MAX and SED_S_HINT_RE.search(prog):  # lookahead mọi `s` bậc hai (AUD-PERF-005)
            raise ScanTooComplex("chương trình sed quá dài để quét lệnh `e`/`s///e`")
        out += [m[1] for m in SED_EXEC_CMD_RE.finditer(prog)]
        out += [re.sub(r"\\(.)", r"\1", m[3]) for m in SED_SUBST_RE.finditer(prog) if "e" in m[4]]
    return out


def _tool_programs(args: List[str], long_opts: Tuple[str, ...], short: str) -> List[str]:
    """Chương trình sed/awk ở MỌI dạng cờ (review #392 🔴): đối số trần, `-e X`, dính/gộp `-eX`/`-neX`, `--expression=X`/
    `--expression X` và tên dài viết tắt ≥ 3 ký tự như getopt (`--e=…`), gawk `--source`. Chiều chặt: giá trị cờ khác
    (tên file `-f`) cũng có thể lọt vào danh sách — chỉ chặn khi chữ đó là lệnh nguy hiểm."""
    out: List[str] = []
    i = 0
    while i < len(args):
        a, nxt = args[i], (args[i + 1] if i + 1 < len(args) else "")
        key, eq, val = a.partition("=")
        if a == "--":  # hết cờ: chương trình/tệp còn lại kể cả bắt đầu bằng `-` (AUD-SEC-296)
            return out + args[i + 1 :]
        if a.startswith("--") and len(key) >= 3 and any(o.startswith(key) for o in long_opts):
            out.append(val if eq else nxt)
            i += 1 if eq else 2
            continue
        k = a.find(short, 1) if a[:1] == "-" and not a.startswith("--") else -1
        if k > 0:
            out.append(a[k + 1 :] or nxt)
            i += 1 if a[k + 1 :] else 2
            continue
        out += [] if a[:1] == "-" else [a]
        i += 1
    return out


def _sed_runs_input(args: List[str]) -> bool:
    """Chương trình sed chạy pattern space như lệnh: `e` trần (không đối số) hoặc `s///` có cờ `e` (AUD-SEC-256/279)."""
    return any(_sed_exec_prog(p) for p in _tool_programs(args, SED_PROG_LONG, "e"))


def _sed_exec_prog(p: str, anchored: bool = False) -> bool:
    """Chữ `p` có thể là chương trình sed chạy pattern space: `e` trần (cả sau cờ địa chỉ `I`/`M` nhiều chữ — AUD-SEC-295,
    review lát B), `s///e` mọi dấu ở vị trí lệnh (AUD-SEC-294) HOẶC — trừ khi `anchored` (đối số có thể là tên tệp) —
    theo luật cũ ở mọi `s` (giữ luật cũ: địa chỉ GNU lạ — review lát B 🔴)."""
    if SED_BARE_E_RE.search(re.sub(r"/[IM]+", "/", p)):
        return True
    rules = (SED_ANY_SUBST_RE,) if anchored else (SED_ANY_SUBST_RE, SED_SUBST_RE)
    return any("e" in m[4] for rx in rules for m in rx.finditer(p))


def _dyn_exec_check(placed: "PlacedCmds") -> None:
    """ADR-0063 lớp mã động: công cụ chạy chữ guard không thấy như lệnh → chặn (không đoán nội dung): sed `e`/`s///e`
    (pattern space là đầu vào), awk `system(`/ống với lệnh không phải chuỗi nguyên văn, chương trình sed/awk đọc từ stdin
    (`-f -`), ghi `BASH_ENV`/`PS0…PS4`/`PROMPT_COMMAND` bằng lệnh dựng sẵn (`printf -v`, `mapfile`, `read`, `declare`…)."""
    for c, _ in placed:
        n = normalize(c)
        name, args = (n[0], n[1:]) if n else ("", [])
        why = _dyn_exec_why(name, args) or _special_var_why(c, name, args)
        if why:
            raise ScanTooComplex(f"ngoài tập con guard đọc chắc — {why}: {' '.join(c)[:80]} (ADR-0063)")


def _dyn_exec_why(name: str, args: List[str]) -> str:
    if name not in SED_NAMES and name not in AWK_NAMES:
        return ""
    if _stdin_program(args):
        return "chương trình sed/awk đọc từ stdin (AUD-SEC-302)"
    # chương trình thật CỘNG mọi đối số (bảng cờ không đủ: `-i.prev`, `--line-length 5`, `-F ' '` — review lát B 🔴)
    real = _real_programs(args, SED_PROG_LONG if name in SED_NAMES else AWK_PROG_LONG)
    loose = [a for a in args if a[:1] != "-"]  # bảng cờ không đủ (`-i.prev`, `--line-length 5`, `-F ' '`): mọi đối số
    if name in SED_NAMES:
        hit = any(_sed_exec_prog(p, anchored=True) for p in real + loose)  # luật cũ (mọi `s`) chỉ ở `_sed_runs_input`
        return "sed chạy pattern space bằng `e` (AUD-SEC-288/294/295)" if hit else ""
    hit = any(AWK_DYN_EXEC_RE.search(p) for p in real + loose)
    return "awk chạy lệnh dựng từ dữ liệu (AUD-SEC-296/297)" if hit else ""


def _real_programs(args: List[str], long_opts: Tuple[str, ...]) -> List[str]:
    """Chương trình sed/awk THẬT (không chiều chặt): giá trị `-e`/`--expression`/`--source`; không có thì đối số vị trí
    đầu (sau `--` vẫn tính). Tên tệp và giá trị `-f`/`-v`/`-l` không phải chương trình."""
    exp: List[str] = []
    pos: List[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            pos += args[i + 1 :]
            break
        step, val = _program_opt(a, args[i + 1] if i + 1 < len(args) else "", long_opts)
        exp += [val] if val is not None else []
        pos += [a] if step == 0 else []
        i += step or 1
    return exp or pos[:1]


def _program_opt(a: str, nxt: str, long_opts: Tuple[str, ...]) -> Tuple[int, Optional[str]]:
    """(số đối số cờ `a` ăn — 0 = đối số vị trí, giá trị chương trình nếu là cờ chương trình) của một đối số sed/awk."""
    key, eq, val = a.partition("=")
    if a.startswith("--"):
        prog = len(key) >= 3 and any(o.startswith(key) for o in long_opts)
        return (1 if eq or not prog else 2), ((val if eq else nxt) if prog else None)
    if a[:1] != "-" or a == "-":
        return 0, None
    k = next((j for j, ch in enumerate(a[1:], 1) if ch in "efvl"), 0)
    if not k:
        return 1, None
    rest = a[k + 1 :]
    return (1 if rest else 2), ((rest or nxt) if a[k] == "e" else None)


def _stdin_program(args: List[str]) -> bool:
    """`-f -`, `-f/dev/stdin`, `--file=-`: chương trình đến từ stdin."""
    long_file = [i for i, a in enumerate(args) if len(a) >= 4 and "--file".startswith(a.partition("=")[0])]  # `--fi`
    vals = _bundled_values(args, "f") + [args[i].partition("=")[2] for i in long_file if "=" in args[i]]
    vals += [args[i + 1] for i in long_file if "=" not in args[i] and i + 1 < len(args)]
    return any(v and posixpath.normpath(v) in STDIN_PATHS for v in vals)  # `/dev//stdin` (review lát B)


def _special_var_why(c: List[str], name: str, args: List[str]) -> str:
    """Biến bash tự chạy (`BASH_ENV`, prompt) ở gán tiền tố (`PS4[0]=…`) hoặc là đối số của lệnh dựng sẵn ghi biến
    (`printf -v`, `mapfile`, `read`, `declare`, `export`…)."""
    prefix = [t for t in c[: len(c) - len(args)] if ANY_ASSIGN_RE.fullmatch(t)]  # cả `PS4[0]=…` đứng một mình
    if name in ("mapfile", "readarray", "read") or (name == "printf" and "-v" in args):  # giá trị tính lúc chạy
        prefix += args
    elif name in VAR_WRITER_CMDS:
        prefix += [a for a in args if "=" in a]
    hit = any(SPECIAL_VAR_TOKEN_RE.fullmatch(t) and _special_value_live(t) for t in prefix)
    return "ghi biến bash tự chạy (`BASH_ENV`/`PS0…PS4`/`PROMPT_COMMAND`, AUD-SEC-287/291/299/300)" if hit else ""


def _special_value_live(tok: str) -> bool:
    """Gán biến tự chạy nguy hiểm: không `=` (tên đưa cho `printf -v`/`mapfile`), `BASH_ENV` khác rỗng, hoặc giá trị prompt
    có mở rộng (`$`, backtick, `\\`) — `PS4='+ '` và `BASH_ENV=` thì cho (review lát B)."""
    name, eq, val = tok.partition("=")
    return not eq or (name.startswith("BASH_ENV") and bool(val)) or any(x in val for x in "$`\\")


def _tool_runs_stdin(argv: List[str]) -> bool:
    """Lệnh lấy chữ từ stdin làm lệnh shell: awk có `system(`/ống, sed có `e`/`s///e` (AUD-SEC-279)."""
    n = normalize(argv)
    name, args = (n[0], n[1:]) if n else ("", [])
    if name in AWK_NAMES:
        return any(AWK_EXEC_HINT_RE.search(a) for a in _tool_programs(args, AWK_PROG_LONG, "e"))
    return name in SED_NAMES and _sed_runs_input(args)


def _stdin_exec_inputs(cmd: str, tokens: List[str], placed: PlacedCmds, budget: Optional[ScanBudget]) -> Placed:
    """Chữ thấy được đi vào stdin của awk/sed chạy lệnh từ đầu vào: here-string, ống từ echo/printf (AUD-SEC-279)."""
    tools = [(c, here) for c, here in placed if _tool_runs_stdin(c)]  # một lần mỗi lệnh (AUD-PERF-010)
    out: Placed = [(c[i + 1], here) for c, here in tools for i, a in enumerate(c[:-1]) if a == "<<<"]
    dirs, i = [here for _, here in placed], 0
    for pipe in pipelines(tokens):
        for feed, down, here in zip(_pipe_feeds(pipe), pipe[1:], dirs[i + 1 : i + len(pipe)]):
            out += [(t, here) for t in feed or []] if feed and _tool_runs_stdin(down) else []  # một lần mỗi khâu
        i += len(pipe)
    runs = list(dict.fromkeys(here for _, here in tools))  # heredoc vào awk/sed (review #392)
    bodies = _heredoc_scripts(cmd, _tool_runs_stdin, budget) if runs else []
    return out + [(body, d) for body in bodies for d in runs]


def _awk_exec_scripts(args: List[str]) -> List[str]:
    """Chương trình awk có `system(`/ống: mọi chuỗi nguyên văn (lệnh có thể qua biến) và chuỗi ghép của chúng."""
    out: List[str] = []
    if any(AWK_EXEC_HINT_RE.search(a) for a in args):  # `-v c='lệnh'` → `system(c)` (AUD-SEC-256); chỉ in → không quét
        out += [v.split("=", 1)[-1] for v in _bundled_values(args, "v")]
    for prog in args:
        if AWK_EXEC_HINT_RE.search(prog):
            lits = [_literal(m) for m in LITERAL_RE.finditer(prog)]
            out += lits + ["".join(lits)] + _exec_api_scripts([prog])
            out += [m[1] if m[1] is not None else m[2] for m in AWK_PIPE_RE.finditer(prog)]
    return out


def _tar_exec_scripts(args: List[str]) -> List[str]:
    """Giá trị các tuỳ chọn tar chạy lệnh: `--to-command`, `-I/--use-compress-program`, `-F/--info-script`,
    `--checkpoint-action=exec=…` (tên dài viết tắt ≥ 4 ký tự như getopt)."""
    out = _bundled_values(args, "IF")
    if args[:1] and re.fullmatch(r"[A-Za-z]+", args[0]) and set(args[0]) & set("IF"):
        out += args[1:]  # cụm cờ kiểu cũ không gạch (`tar xIf 'lệnh' a.tar`) — giá trị theo thứ tự cờ (AUD-SEC-256)
    for i, a in enumerate(args):
        key, eq, val = a.partition("=")
        val = val if eq else (args[i + 1] if i + 1 < len(args) else "")
        if len(key) >= 4 and any(o.startswith(key) for o in TAR_CMD_LONG):
            out.append(val)
        elif len(key) >= 4 and "--checkpoint-action".startswith(key):
            out += [val, val.split("=", 1)[-1]]
    return out


def _tool_exec_scripts(argv: List[str]) -> List[str]:
    """Lệnh shell mà sed/awk/tar hoặc builtin gọi lại (`mapfile -C`, `compgen -C/-W`) chạy (AUD-SEC-250/251)."""
    n = normalize(argv)
    name, args = (n[0], n[1:]) if n else ("", [])
    if name in SED_NAMES:
        return _sed_exec_scripts(args)
    if name in AWK_NAMES:
        return _awk_exec_scripts(args)
    if name in TAR_NAMES:
        return _tar_exec_scripts(args)
    return _bundled_values(args, CALLBACK_OPTS[name]) if name in CALLBACK_OPTS else []


def _prompt_scripts(cmd: str, tokens: List[str]) -> List[str]:
    """Giá trị bash mở rộng như prompt: gán `PS0…PS4`/`PROMPT_COMMAND` (cả sau `export`/`declare`); có `${…@P}` → mọi
    giá trị gán trong lệnh (biến nào được mở rộng không theo dõi — chiều chặt)."""
    out = [m[1] for t in tokens for m in [PROMPT_ASSIGN_RE.fullmatch(t)] if m]
    # `printf -v PS4 …` (AUD-SEC-281): `_special_var_why` chặn thẳng (ADR-0063 lát B), không cần quét giá trị
    if re.search(r"@P\}", cmd):
        out += [m[1] for t in tokens for m in [ANY_ASSIGN_RE.fullmatch(t)] if m]
    return out


def _env_scan_tokens(argv: List[str]) -> List[str]:
    """Token có thể là phép gán `BASH_ENV`: MỌI token như luật cũ (lệnh bọc `command`/`nohup`/`timeout`/`xargs env …` —
    review #389 🔴), trừ đối số của chương trình cuối khi nó chỉ đọc/in dữ liệu (`grep 'BASH_ENV=f'`, `echo`, thân
    `git commit` — AUD-SEC-254): khi đó chỉ phần đứng trước chương trình (tiền tố gán, lệnh bọc) được xét."""
    n = normalize(argv)
    if n and posixpath.basename(n[0]) in BASH_ENV_DATA_CMDS:
        return argv[: len(argv) - len(n)]
    return argv


def _bash_env_asks(tokens: List[str]) -> List[str]:
    """`BASH_ENV=<file>`/`+=`: mọi bash không tương tác về sau nạp file đó — guard không đọc nội dung → chặn."""
    found = [t for c in split_commands(tokens) for t in _env_scan_tokens(c) if BASH_ENV_RE.fullmatch(t)]
    return [f"BASH_ENV: {BASH_ENV_MARK} ({t[:120]})" for t in found]


def _quote_body(script: str, m: "re.Match[str]") -> str:
    """Thân của toán tử trích kiểu Perl/Ruby (`q(…)`, `qx{…}`, `%x[…]`, `q!…!`) bắt đầu ở `m`."""
    opener = m[1]
    closer = QUOTE_PAIRS.get(opener)
    if closer:
        return _balanced(script, m.end(), opener, closer)
    end = script.find(opener, m.end())
    return script[m.end() : end if end >= 0 else len(script)]


def _quote_exec_scripts(script: str) -> List[str]:
    """Script Perl/Ruby/PHP có dấu chạy shell: mọi chuỗi nguyên văn, thân `q…`/`%x…`, thân backtick, và chuỗi ghép."""
    script = _nfkc(script)
    if not QUOTE_EXEC_HINT_RE.search(script):
        return []
    lits = [_literal(m) for m in LITERAL_RE.finditer(script)]
    lits += [_quote_body(script, m) for m in QUOTE_LIKE_RE.finditer(script)]
    lits += BACKTICK_BODY_RE.findall(script)
    lits = list(dict.fromkeys(lits))
    if sum(map(len, lits)) > QUOTE_SCAN_MAX:  # thân `%(`/`q(` lồng chồng lấn: quét từng cái gần n³ (AUD-PERF-004)
        raise ScanTooComplex("script Perl/Ruby/PHP có quá nhiều chuỗi/thân trích để quét lệnh shell")
    # ba lần quét: mỗi chuỗi một dòng lệnh, chuỗi ghép, và chuỗi nối khoảng trắng — lời gọi dạng danh sách đối số
    # `system("rm", "-rf", "/")`, `pcntl_exec("/bin/rm", ["-rf", "/"])` (AUD-SEC-298)
    if len(lits) > QUOTE_JOIN_MAX:  # nối mọi chuỗi bằng khoảng trắng tốn theo số chuỗi (review lát B, perf)
        raise ScanTooComplex(f"script Perl/Ruby/PHP có hơn {QUOTE_JOIN_MAX} chuỗi cùng dấu chạy lệnh")
    # nối khoảng trắng: lời gọi dạng danh sách đối số có/không ngoặc (`system "rm", "-rf", "/"`, `exec {…} …`,
    # `pcntl_exec ("/bin/rm", [...])` — review lát B 🔴); `"|lệnh"` của Ruby `IO.read`
    return ["\n".join(lits), "".join(lits), " ".join(x.lstrip("| ") for x in lits)]


def _m4_exec_scripts(text: str) -> List[str]:
    """Đối số `syscmd(…)`/`esyscmd(…)` trong đầu vào m4, bỏ dấu trích của m4 (`` ` `` và `'`)."""
    out = [_balanced(text, m.end(), "(", ")") for m in M4_EXEC_RE.finditer(text)]
    return [s.replace("`", "").replace("'", "") for s in out]


def _is_m4(argv: List[str]) -> bool:
    return normalize(argv)[:1] == ["m4"]


def _m4_inputs(cmd: str, tokens: List[str], placed: PlacedCmds, budget: Optional[ScanBudget]) -> Placed:
    """Lệnh m4 chạy từ đầu vào thấy được: here-string, `-D` giá trị, ống vào m4, heredoc vào m4."""
    out: Placed = []
    for c, here in placed:
        if _is_m4(c):
            texts = [c[i + 1] for i, a in enumerate(c[:-1]) if a == "<<<"] + [a for a in c[1:] if a.startswith("-D")]
            out += [(s, here) for t in texts for s in _m4_exec_scripts(t)]
    dirs, i = [here for _, here in placed], 0
    for pipe in pipelines(tokens):
        for feed, down, here in zip(_pipe_feeds(pipe), pipe[1:], dirs[i + 1 : i + len(pipe)]):
            out += [(s, here) for t in feed or [] if _is_m4(down) for s in _m4_exec_scripts(t)]
        i += len(pipe)
    m4_dirs = list(dict.fromkeys(here for c, here in placed if _is_m4(c)))
    bodies = _heredoc_scripts(cmd, _is_m4, budget) if m4_dirs else []
    return out + [(s, d) for body in bodies for s in _m4_exec_scripts(body) for d in m4_dirs]


def _tool_exec_sources(
    cmd: str, tokens: List[str], placed: PlacedCmds, interp: Placed, start: Optional[str], budget: Optional[ScanBudget]
) -> Tuple[Placed, List[str]]:
    """(lệnh lồng, câu hỏi chặn) từ công cụ tự chạy lệnh và chỗ bash tự mở rộng (AUD-SEC-250/251)."""
    _dyn_exec_check(placed)
    out: Placed = [(s, here) for c, here in placed for s in _tool_exec_scripts(c)]
    out += [(s, start) for s in _prompt_scripts(cmd, tokens)]
    if _interp_families(tokens, start) & QUOTE_EXEC_FAMILIES:
        out += [(s, here) for raw, here in interp for s in _quote_exec_scripts(raw)]
    out += _m4_inputs(cmd, tokens, placed, budget)
    out += _stdin_exec_inputs(cmd, tokens, placed, budget)
    return [(s, d) for s, d in out if s.strip()], _bash_env_asks(tokens)


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


def _nested_pairs(
    cmd: str,
    tokens: List[str],
    placed: PlacedCmds,
    start: Optional[str],
    budget: Optional[ScanBudget] = None,
    pick: int = 0,
) -> Placed:
    """Lệnh chạy lồng (AUD-SEC-017) kèm thư mục nó chạy (AUD-SEC-094): `sh -c '…'`, `eval '…'`, backtick, `$(…)`,
    `$(cat <<E …)`, `<( )`, thân heredoc mở rộng, `echo/printf '…' | sh`, here-string/heredoc vào shell. `pick`: ứng
    viên thư mục đang xét (`_commands_with_cwd`, D-347)."""
    moved = any(here != start for _, here in placed)
    out: Placed = [(s, here) for c, here in placed for s in [_shell_c_script(c)] if s]
    out += [(s, here) for c, here in placed for s in _eval_scripts(c)]
    out += _span_pairs(strip_heredocs(literal_bodies_masked(cmd)), _backtick_spans, start, moved, pick)
    out += _span_pairs(strip_heredocs(cmd), _dollar_spans, start, moved, pick)
    out += [(b, here) for sc, here in list(out) for b in _cat_heredoc_bodies(sc)]
    out += _procsub_scripts(tokens, _token_dirs(tokens, placed))
    visited = list(dict.fromkeys([start, *(here for _, here in placed)]))
    bodies = [s for body in _expanded_heredocs(cmd) for s in _dollar_scripts(body) + _backtick_scripts(body)]
    out += [(s, d) for s in bodies for d in visited]  # thân heredoc mở rộng: thư mục mọi lệnh (chiều chặt)
    out += _shell_feeds(tokens, placed)
    out += [(s, here) for c, here in placed for s in _here_strings(c)]
    shells = dict.fromkeys([start, *(here for c, here in placed if _stdin_shell(c))])
    return out + [(body, d) for body in _heredoc_scripts(cmd, budget=budget) for d in shells]


def _span_pairs(
    text: str, finder: Callable[[str], List[Span]], start: Optional[str], moved: bool, pick: int = 0
) -> Placed:
    """Thân thay lệnh (`finder` = `_dollar_spans`/`_backtick_spans`) kèm thư mục lệnh chứa nó; không lệnh nào dời thư
    mục → mọi thân ở `start`."""
    out: Placed = []
    for spans in _span_readings(text, finder):
        dirs = _span_dirs(text, spans, start, pick) if moved and spans else [start] * len(spans)
        out += [(body, d) for (_, _, body), d in zip(spans, dirs)]
    return list(dict.fromkeys(out))


def _span_dirs(text: str, spans: List[Span], start: Optional[str], pick: int = 0) -> List[Optional[str]]:
    """Thư mục của lệnh chứa mỗi thay lệnh trong `text`: thay span thứ K bằng dấu `$__xt_span_K_`, tách lệnh, đọc dấu
    trong argv của `_commands_with_cwd` (`cd .claude && echo "$(…)"` chạy trong `.claude`). Không thấy dấu (span trong
    comment) → `start`."""
    parts: List[str] = []
    pos = 0
    for k, (a, b, _) in enumerate(spans):
        parts += [text[pos:a], SPAN_MARK.format(k)]
        pos = b
    found: Dict[int, Optional[str]] = {}
    for c, here in _commands_with_cwd(tokenize("".join(parts) + text[pos:]), start, pick):
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
            elif feed and (rs := _xargs_replace_script(down)):  # `echo 'rm -rf ~' | xargs -I{} sh -c {}` (review #405)
                out += [(rs[1].replace(rs[0], ln), here) for s in feed for ln in s.split("\n") if ln.strip()]
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


LEDGER_DIR_PARTS = STAGE_LEDGER.split("/")[:-1]
LEDGER_NAME = posixpath.basename(STAGE_LEDGER)


def _names_evidence(t: str) -> bool:
    """Từ nhắc bằng chứng `.autopilot`/tên file bằng chứng — mọi lệnh ghi phía sau xargs đều chặn (luật cũ)."""
    low = t.lower()
    return ".autopilot" in low or posixpath.basename(low) in EVIDENCE_NAMES


def _names_ledger(t: str) -> bool:
    """Từ ở nguồn ống có thể chỉ sổ giai đoạn (AUD-SEC-340, review lượt 2): mẫu khớp tên sổ mà thư mục (nếu có) khớp đuôi
    thư mục sổ (`STAGE*`, `docs/autopilot/*`, `*/autopilot/*` — `PLAN-*.md`, `/tmp/d/STAGE.json` thì không), hay chính
    thư mục sổ/tổ tiên (`docs`, `./docs/`, `autopilot`, `/x/docs/autopilot` — mẫu toàn ký tự đại diện như `*` không)."""
    parts = [p for p in t.split("/") if p not in ("", ".")]
    if not parts:
        return False
    if fnmatch.fnmatchcase(LEDGER_NAME, parts[-1]):
        dirs, k = parts[:-1], min(len(parts) - 1, len(LEDGER_DIR_PARTS))
        tail = all(map(fnmatch.fnmatchcase, LEDGER_DIR_PARTS[len(LEDGER_DIR_PARTS) - k :], dirs[len(dirs) - k :]))
        if tail if dirs else _has_alnum(parts[-1]):
            return True
    if t.startswith("/"):  # tuyệt đối: đuôi là `docs`, `docs/autopilot` của một gốc nào đó
        pairs = [(LEDGER_DIR_PARTS[:b], parts[-b:]) for b in range(1, len(LEDGER_DIR_PARTS) + 1)]
    else:  # tương đối: cả từ (bỏ `..` đầu) là một đoạn liền của thư mục sổ — thư mục đang đứng không biết
        rel = list(itertools.dropwhile(lambda p: p == "..", parts))
        pairs = [(x, rel) for x in LEDGER_DIR_SLICES]
    return any(len(x) == len(w) and _has_alnum(w[0]) and all(map(fnmatch.fnmatchcase, x, w)) for x, w in pairs)


LEDGER_DIR_SLICES = [
    LEDGER_DIR_PARTS[a:b] for a in range(len(LEDGER_DIR_PARTS)) for b in range(a + 1, len(LEDGER_DIR_PARTS) + 1)
]


def _has_alnum(s: str) -> bool:
    return any(c.isalnum() for c in s)


def _xargs_fed_dest(down: List[str], inner: List[str]) -> bool:
    """Chữ từ ống có thể là ĐÍCH ghi của lệnh sau xargs: mọi lệnh ghi trừ nguồn của `cp`/`install`/`ln` (chỗ thay `-I R`
    không ở đích; nối vào cuối mà có `-t` — `xargs -I{} cp {} /tmp/`, `xargs cp -t /tmp/bk` chép RA)."""
    if posixpath.basename(inner[0]) not in ("cp", "install", "ln"):
        return True
    mark = _xargs_replace(down[1 : len(down) - len(inner)])
    target, pos, _ = _copy_opts(posixpath.basename(inner[0]), inner[1:])
    if mark is None:
        return not target
    return any(mark in d for d in target or pos[-1:])


def _xargs_evidence(tokens: List[str], cmd: str) -> List[str]:
    """`<nguồn nhắc .autopilot> | xargs <lệnh ghi/xoá>`: đích đến từ stdin nên guard không thấy file — nguồn đã nói rõ
    là bằng chứng của autopilot thì chặn như ghi tay (ADR-0026); nguồn có thể chỉ sổ giai đoạn (`_names_ledger`) mà chữ
    từ ống là đích ghi (`_xargs_fed_dest`) → cũng chặn (AUD-SEC-340). Ống xét cả trên token còn nháy của `cmd`: dấu có
    nháy/thoát (`find docs \\( -name STAGE.json \\)`, `';'`) là đối số, không tách lệnh — nguồn không mất (AUD-SEC-393)."""
    asks: List[str] = []
    quoted = [[[_dequote(w) for w in c] for c in p] for p in pipelines(_raw_tokens(cmd) or [])]
    for pipe in [*pipelines(tokens), *quoted]:
        for up, down in zip(pipe, pipe[1:]):
            inner = normalize(down)
            if (
                posixpath.basename(down[0]) != "xargs"
                or not inner[:1]
                or posixpath.basename(inner[0]) not in XARGS_WRITERS
            ):
                continue
            skips = _xargs_file_editor(down, inner) and _find_skips_ledger(up)
            ledger = any(map(_names_ledger, up)) and _xargs_fed_dest(down, inner) and not skips
            if any(map(_names_evidence, up)) or ledger:
                asks.append(EVIDENCE_WHY.format(f"đích từ ống `{' '.join(up)[:60]}` vào xargs {inner[0]}"))
    return asks


# AUD-SEC-384: nguồn ống `find` mà mọi nhánh in ra đều qua bộ lọc tên/đường dẫn không thể khớp sổ giai đoạn
# (`find docs -name '*.md'`, `find . -path ./docs -prune -o -name '*.py' -print`) không liệt kê sổ. Chỉ đọc biểu thức trong
# tập con: thử nghiệm đã biết, `-o`, in bằng `-print`/`-print0`; khác (ngoặc, phủ định, `-printf`/`-exec`/`-fprint` in chữ
# tuỳ ý, cờ lạ, đối số thiếu) → không chứng minh được, giữ chặn.
FIND_TESTS_1 = frozenset(
    "-name -iname -path -ipath -wholename -iwholename -type -xtype -maxdepth -mindepth -mtime -mmin -newer -size".split()
)
FIND_TESTS_0 = frozenset("-a -and -empty -readable -writable -executable -true -false -depth -xdev -prune".split())
FIND_PRINTS = ("-print", "-print0")
LEDGER_FIND_NAME = ("-name", "-iname")  # tên khác `FIND_NAME_TESTS` (luật `.autopilot` cũ) — không ghi đè
LEDGER_FIND_PATH = ("-path", "-ipath", "-wholename", "-iwholename")
# Lượt 2 (review blk-guard): find còn in THƯ MỤC tổ tiên của sổ (`-name autopilot`, `-path docs/autopilot`, nhánh `-prune`
# in ngầm) — lệnh ghép đường (`xargs -I{} cp x {}/STAGE.json`) hay ghi vào thư mục (cp/mv/install/ln, perl/sh chạy mã) ghi
# được sổ. Chỉ miễn cho lệnh sửa NỘI DUNG file tại chỗ, thư mục không ghi được: `sed` không `-I`/`--replace`, không theo
# symlink (`--follow-symlinks`: file `.md` là symlink tới sổ).
XARGS_FILE_EDITORS = ("sed",)


def _xargs_file_editor(down: List[str], inner: List[str]) -> bool:
    """Lệnh sau xargs chỉ sửa nội dung từng file nhận từ ống (thư mục/tổ tiên của sổ in ra thì lỗi, không ghi). Không
    miễn (AUD-SEC-396): xargs lấy đối số từ tệp (`-a`/`--arg-file`, cả cờ gộp), sed đọc chương trình từ tệp (`-f`/`--file`,
    cả cờ gộp — guard không đọc), chương trình có lệnh ghi `w`/`W` hay chạy shell `e` thật (`_sed_has_write` — chữ `w`
    trong mẫu/thay thế không tính, review adr-guard lượt 2)."""
    opts = down[1 : len(down) - len(inner)]
    return (
        posixpath.basename(inner[0]) in XARGS_FILE_EDITORS
        and _xargs_replace(opts) is None
        and not any(a.startswith("--f") or _short_cluster_has(a, "f") for a in inner[1:])
        and not any(a.startswith("--a") or _short_cluster_has(a, "a") for a in opts)
        and not any(map(_sed_has_write, _sed_scripts(inner[1:])))
    )


def _short_cluster_has(a: str, letter: str) -> bool:
    """`a` là cờ ngắn (gộp) có chữ `letter` (`-f`, `-nf`, `-0a`)."""
    return a.startswith("-") and not a.startswith("--") and letter in a[1:]


def _find_skips_ledger(up: List[str]) -> bool:
    """Lệnh nguồn là `find` chắc chắn không in đường dẫn sổ giai đoạn (AUD-SEC-384)."""
    n = normalize(up)
    if n[:1] != ["find"]:
        return False
    expr = list(itertools.dropwhile(lambda t: t[:1] not in "-!()," or t in ("-H", "-L", "-P"), n[1:]))
    branches = _find_branches(expr)
    explicit = any(t in FIND_PRINTS for t in expr)
    return branches is not None and all(_find_branch_skips(b, explicit) for b in branches)


def _find_branches(expr: List[str]) -> Optional[List[List[Tuple[str, str]]]]:
    """Biểu thức `find` thành các nhánh `-o`, mỗi nhánh là dãy (thử nghiệm, đối số); None = ngoài tập con đọc chắc."""
    branches: List[List[Tuple[str, str]]] = [[]]
    i = 0
    while i < len(expr):
        t = expr[i]
        if t in ("-o", "-or"):
            branches.append([])
        elif t in FIND_TESTS_1 and i + 1 < len(expr):
            branches[-1].append((t, expr[i + 1]))
            i += 1
        elif t in FIND_TESTS_0 or t in FIND_PRINTS:
            branches[-1].append((t, ""))
        else:
            return None
        i += 1
    return branches


def _find_branch_skips(branch: List[Tuple[str, str]], explicit: bool) -> bool:
    """Nhánh không in sổ: gặp bộ lọc loại sổ TRƯỚC lệnh in, hoặc nhánh không in khi biểu thức có `-print` ở nhánh khác."""
    for t, arg in branch:
        if t in FIND_PRINTS:
            return False
        if t in LEDGER_FIND_NAME + LEDGER_FIND_PATH and not _find_pat_may_match(t, arg):
            return True
    return explicit


def _find_pat_may_match(test: str, pat: str) -> bool:
    """Mẫu `-name`/`-path` có thể khớp sổ: `-name` so tên sổ; `-path` (`*` khớp cả `/`) so phần chữ sau `*` cuối với đuôi
    đường dẫn sổ. `[`/`?`/`\\` (fnmatch của find khác Python: `[^…]`, `\\.`) → coi như khớp; mẫu không nguyên văn (`$(…)`,
    `$VAR` chưa giải, backtick — review blk-guard) → coi như khớp."""
    name, pat = (LEDGER_NAME.lower(), pat.lower()) if test.startswith("-i") else (LEDGER_NAME, pat)
    if re.search(r"[$`]", pat):
        return True
    if test in LEDGER_FIND_NAME:
        return bool(re.search(r"[\[\\]", pat)) or fnmatch.fnmatchcase(name, pat)
    tail = pat.rsplit("*", 1)[-1]
    return bool(re.search(r"[?\[\\]", tail)) or name.endswith(tail) or tail.endswith(name)


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
    out: List[str] = []
    for ansi in (True, False) if "$'" in base or "$$" in base else (True,):  # hai cách đọc `$'` (`_span_readings`)
        spans = sorted(_dollar_spans(base, ansi) + _backtick_spans(base, ansi))
        outer = [sp for k, sp in enumerate(spans) if not any(o[0] <= sp[0] and sp[1] <= o[1] for o in spans[:k])]
        variants = [base]
        for start, end, body in reversed(outer):
            vals = _subst_words(body)
            variants = [v[:start] + val + v[end:] for v in variants for val in vals][: LIFT_PICKS * LIFT_PICKS]
        out += variants if outer else []
    return list(dict.fromkeys(out))


def _push_subst_rule(cmd: str, root: str, cwd: str) -> Tuple[str, List[str]]:
    """`git push origin $(echo main)`: luật push trên bản đã thay giá trị; đích là thay lệnh không tính được → hỏi
    (unsure → chặn). Trả (lý do deny, câu hỏi)."""
    base = strip_heredocs(cmd)
    variants = _subst_variants(base) if "push" in base else []
    seen = {tuple(a) for a, _ in _commands_each_cwd(tokenize(base), cwd)} if variants else set()
    asks: List[str] = []
    for argv, here in (c for v in variants for c in _commands_each_cwd(tokenize(v), cwd)):
        n = normalize(argv)
        if n[:2] != ["git", "push"] or tuple(argv) in seen:
            continue
        if any(SUBST_MARK in r for r in _push_refs(n[2:])[1:]):
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
    for r in (r for r in _push_refs(n[2:])[1:] if VAR_USE_RE.search(r)):
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
        for argv, here in _commands_each_cwd(tokenize(variant), cwd):
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


ASSIGN_ANY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\+?=.*", re.S)  # giá trị có thể nhiều dòng (`x='bash <<E …'`)
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


def _record_assigns(c: List[str], env: Dict[str, str], pick: int = 0, home0: Optional[str] = None) -> None:
    """`x='…'`, `export x=…`, `declare -x x=…`: gán đứng riêng (không kèm lệnh) có hiệu lực cho các lệnh sau; `for x in
    a b`: x lấy từ thứ `pick` của danh sách. `x+=…` nối vào giá trị đã ghi (`c=r; c+=m; $c` → `rm`); giá trị cũ không
    biết → bỏ ghi nhận (biến thành không biết, AUD-SEC-125). `home0` (lệnh nhắc HOME — AUD-SEC-414): `~` trong giá trị
    mở NGAY lúc gán, theo HOME đã ghi nhận hay home thật `home0` (`x=~; HOME=/tmp/y; rm -rf $x` xoá home thật — review
    #429)."""
    c = [t for t in c if t not in SHELL_KEYWORDS] if c[0] in SHELL_KEYWORDS else c  # `then x=…`, `do x=…`, `{ x=…`
    words = _for_values(c)
    if words:
        env[c[1]] = _sub_vars(words[min(pick, len(words) - 1)], env)[:VAR_VALUE_MAX]
        return
    # review #429: cờ của declare/typeset (`-x`, `-g`, `+x`) không làm mất ghi nhận gán
    words = [t for t in c[1:] if t[:1] not in "-+"] if c[:1] and c[0] in DECLARE_CMDS else c
    if words and all(ASSIGN_ANY_RE.fullmatch(t) for t in words):
        for t in words:
            k, _, v = t.partition("=")
            val = _sub_vars(v if home0 is None else _sub_tilde(v, {"HOME": env.get("HOME", home0)}), env)
            if k.endswith("+"):  # nối vào giá trị đã ghi; dài quá trần thì bỏ luôn (không giữ giá trị cũ đã sai)
                k = k[:-1]
                old = env.pop(k, None)
                if old is None:
                    continue
                val = old + val
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


def _expand_tokens(tokens: List[str], pick: int, split: bool, tilde: bool = False) -> List[str]:
    """Dòng token với biến đã gán thay bằng giá trị theo thứ tự xuất hiện; dấu `;`/`&&`/`|`/chuyển hướng giữ nguyên nên
    `cd $D`, `echo "$x" | sh` còn đủ ngữ cảnh. `split`: token chỉ là `$x` được tách từ như shell không nháy. `tilde`
    (AUD-SEC-414, bản THÊM — bản không thay `~` vẫn quét): `~` CHỮ có sẵn trong token (trước khi thay biến) mở theo
    HOME đã gán bằng chữ, cả gán tiền tố cho lệnh đó (`HOME=x bash -c '… ~/f'`)."""
    env: Dict[str, str] = {}
    out: List[str] = []
    cur: List[str] = []
    local: Dict[str, str] = {}
    home0 = posixpath.expanduser("~") if any("HOME" in t for t in tokens) else None
    for t in tokens:
        if _is_punct(t) and not _is_redirect(t):
            if cur:
                _record_assigns(cur, env, pick, home0)
            cur, local = [], {}
            out.append(t)
            continue
        cur.append(t)
        if tilde and t.startswith("HOME="):  # chiều chặt: cả gán đứng sau từ lệnh (`env HOME=x …`, đối số `export`)
            local["HOME"] = _sub_vars(t[5:], env)
        scope = {**env, **local} if local else env
        lit = _sub_tilde(t, scope) if tilde else t
        sub = _sub_vars(lit, scope) if scope or "${" in lit else lit
        out += _split_words(sub) if split and VAR_REF_RE.fullmatch(t) and sub != t else [sub]
    return out


# AUD-SEC-414: `~` đầu từ (cả sau `=`/`:` của gán, trong chữ `-c`) mở ra `$HOME` — sau gán `HOME=<chữ>` guard thay giá trị
# rồi quét lại như `$HOME` (`HOME=.claude; rm -f ~/settings.json`). Chiều chặt: cả `~` sau nháy (`expanduser("~/x")`
# trong `python3 -c`; bản quét lại chỉ thêm chặn).
TILDE_RE = re.compile(r"(?<![^\s=:;&|(`'\"])~(?=/|$|[\s;&|)`:'\"])", re.M)


def _sub_tilde(text: str, env: Dict[str, str]) -> str:
    home = env.get("HOME")
    return TILDE_RE.sub(lambda _: home, text) if home is not None and "~" in text else text


def _var_scripts(tokens: List[str]) -> List[str]:
    """Cả dòng lệnh sau khi thay biến đã gán bằng chữ nguyên văn (`x='rm -rf ~'; eval "$x"`, `D=.autopilot; cd $D`,
    `cmd=…; echo "$cmd" | sh`, `for d in a b; do rm $d`): quét lại như một lệnh. Không thấy gán từ `read`/thay lệnh."""
    base = _join_tokens(tokens)
    picks = min(VAR_FOR_PICKS, max([1, *(_for_words(c) for c in split_commands(tokens))]))
    seen = {base}
    out: List[str] = []
    # AUD-SEC-414: bản thay `~`/HOME gán tiền tố (`HOME=x bash -c '…$HOME…'`) là bản THÊM
    tildes = (False, True) if "HOME" in base and ("~" in base or "HOME=" in base) else (False,)
    for pick, split, tilde in itertools.product(range(picks), (False, True), tildes):
        script = _join_tokens(_expand_tokens(tokens, pick, split, tilde))
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
    variants = [text, *[a for a in [_array_lifted(base)] if a]]  # AUD-SEC-405: mảng chữ nguyên văn đã thay phần tử
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
    *("flock", "watch", "script", "su", "busybox", "toybox", "coproc", "ionice", "chrt", "taskset", "fakeroot"),
    "unshare",
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
        if sub["decision"] == "deny" and sub.get("code") in (BUDGET, UNPARSED):  # không đọc chắc: không hạ thành hỏi
            raise ScanTooComplex(f"lệnh trong container: {sub['reason']} (AUD-SEC-247)")
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
        key = (script, cwd, script in budget.loose)  # lượt chặt và lượt lỏng cùng chuỗi là hai lượt (review lát A 🔴)
        # … trừ khi lượt CHẶT cùng chuỗi, cùng thư mục đã chạy: chặt áp mọi luật của lỏng cộng tập con chuẩn, con của nó
        # chặt theo — lượt lỏng sau không đổi được quyết định, chỉ tiêu ngân sách (AUD-PERF-015)
        if key in budget.seen or (script, cwd, False) in budget.seen:
            continue
        if not deeper and len(script) > REWRITE_MAX_CHARS:
            return f"Lệnh quá phức tạp để guard quét hết (bản thay biến dài {len(script)} ký tự): chia nhỏ lệnh."
        budget.seen.add(key)
        sub = bash_decision(script, root, cwd, depth + deeper, budget, 0 if deeper else rewrites + 1)
        budget.push_no_verify = budget.push_no_verify or bool(sub.get("push_no_verify"))
        if sub["decision"] == "deny":
            budget.nested_deny = (str(sub["reason"]), str(sub.get("code") or ""))
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
    picks: int = 1,
) -> str:
    """Quét đệ quy lệnh lồng; trả lý do deny (rỗng nếu không), thêm câu hỏi vào `asks`. Lệnh trong container không
    đụng file máy → chặn/hỏi của nó thành hỏi (ra mạng, thêm gói vẫn là việc thật). `picks`: số ứng viên thư mục
    nhiều nhất của một lệnh (`_cwd_picks`) — nguồn lồng lấy ở mọi ứng viên (D-347)."""
    if max([0, *(_for_words(c) for c in split_commands(tokens))]) > VAR_FOR_PICKS:
        return f"Lệnh quá phức tạp để guard quét hết (vòng `for` hơn {VAR_FOR_PICKS} giá trị khác nhau): chia nhỏ lệnh."
    asks += _opaque_shells(tokens) + _xargs_evidence(tokens, cmd)
    push_deny, push_asks = _unresolved_push(cmd, tokens, root, cwd or root)
    if push_deny:
        return push_deny
    asks += push_asks
    asks += _container_asks(_wrapped_scripts(tokens)[1], depth, budget)  # mọi lệnh, không cắt (review #82)
    rewritten: Placed = []
    nested: Placed = []
    for pick in range(picks):  # mỗi cặp (lệnh, thư mục ứng viên) ít nhất một lượt (D-347)
        rw_at, ns_at, opaque = _nested_sources(cmd, tokens, cwd, root, budget, pick)
        rewritten, nested = list(dict.fromkeys(rewritten + rw_at)), list(dict.fromkeys(nested + ns_at))
        asks += opaque
    for here, (rw, ns) in _moved_groups(rewritten, nested, cwd).items():
        moved = _scan_scripts(rw, root, here, depth, asks, 0, budget, rewrites)
        moved = moved or _scan_scripts(ns, root, here, depth, asks, 1, budget)
        if moved:
            return moved
    return _scan_scripts([s for s, _ in rewritten], root, cwd, depth, asks, 0, budget, rewrites) or _scan_scripts(
        [s for s, _ in nested], root, cwd, depth, asks, 1, budget
    )


def _nested_sources(
    cmd: str,
    tokens: List[str],
    start: Optional[str],
    root: str,
    budget: Optional["ScanBudget"] = None,
    pick: int = 0,
) -> Tuple[Placed, Placed, List[str]]:
    """MỘT danh sách nguồn lệnh lồng cho cả lượt quét ở thư mục ban đầu lẫn sau `cd`/`pushd`/`env -C` (AUD-SEC-087,
    AUD-SEC-094 — hai danh sách riêng từng lệch nhau): (bản viết lại cùng lệnh, lệnh lồng, câu hỏi chặn), mỗi script
    kèm thư mục nó chạy. Bản viết lại: thay biến/gán thay lệnh (cả dòng, gồm `cd`) và hậu tố lệnh bọc (`flock`,
    `script -qc`, `su -c`, `watch`…), lệnh git gọi alias. Lệnh lồng: `_nested_pairs`, lệnh bọc trên máy (`uv run bash
    -c`), `os.system` trong script trình thông dịch, ống giải mã vào shell, ssh chạy tại máy này, magic ipython, alias
    git `!`. `root`: repo đọc alias bền khi thư mục lệnh không biết; `budget`: ngân sách đọc alias của quyết định;
    `pick`: ứng viên thư mục của mỗi lệnh (`_commands_with_cwd`; bên gọi lặp mọi ứng viên — D-347)."""
    placed = _commands_with_cwd(tokens, start, pick)
    alias_rw, alias_ns, alias_asks = _git_alias_sources(placed, root, budget)
    built: Placed = [(s, start) for s in _var_scripts(tokens)] + alias_rw + [(s, start) for s in _lifted_scripts(cmd)]
    built += _patch_fence_scripts(cmd, placed, start)  # AUD-SEC-414: đích `patch`/`git apply` trong thân heredoc
    runner = [(s, here) for c, here in placed for s in _runner_scripts(c)]
    decoded, opaque = _decoded_pipes(tokens, [here for _, here in placed])
    nested = _nested_pairs(cmd, tokens, placed, start, budget, pick)
    nested += [(s, here) for c, here in placed for s in _wrapped_scripts(c)[0]]
    interp = _interp_scripts_at(cmd, tokens, start, budget)
    loose = [(s, here) for raw, here in interp for s in _exec_api_scripts([raw])]
    nested += [
        (s, here) for raw, here in interp for s in _exec_api_verbatim([raw])
    ]  # sh đọc nguyên văn: chặt (AUD-SEC-307)
    tool_nested, tool_asks = _tool_exec_sources(cmd, tokens, placed, interp, start, budget)
    loose += tool_nested
    opaque += tool_asks
    nested += decoded + [(s, here) for c, here in placed for s in _ssh_local_scripts(c)]
    jobs = [(c, here, *_parallel_jobs(c)) for c, here in placed]
    nested += [(s, here) for _, here, scripts, _ in jobs for s in scripts]
    opaque += [f"{why}: {' '.join(c)[:200]}" for c, _, _, why in jobs if why]
    nested += _ipython_nested(cmd, tokens, start) + alias_ns
    nested += [(s, start) for s in [_heredoc_run(cmd)] if s]  # D-324: thân heredoc có nháy ghi ra tệp rồi chạy
    if budget is not None:
        _mark_loose(budget, cmd, built, loose, runner + nested)
    return built + runner, nested + loose, opaque + alias_asks


def _mark_loose(budget: ScanBudget, cmd: str, built: Placed, extracted: Placed, verbatim: Placed) -> None:
    """ADR-0063: ghi nguồn lỏng (bản guard dựng, chữ trích) — con của chữ trích lỏng theo; chữ bash đọc nguyên văn
    (`verbatim`) luôn chặt, kể cả khi trùng chuỗi với chữ lỏng hay cha lỏng (review lát A 🔴)."""
    inherited = verbatim if cmd in budget.extracted else []
    budget.extracted.update(s for s, _ in extracted + inherited)
    budget.loose.update(s for s, _ in built + extracted + inherited)
    budget.loose.difference_update(s for s, _ in ([] if inherited else verbatim))


def _assign_values(tokens: List[str]) -> Dict[str, str]:
    """Gán biến `TÊN=giá trị` trong `tokens` (tiền tố của lệnh, đối số của `export`)."""
    return dict(_assign_split(t) for t in tokens if ENV_ASSIGN_RE.fullmatch(t))


# Đối số không thấy (review #306 G): `… | xargs git update-ref` nối ref từ stdin vào cuối, `xargs -I{} git tag {}` /
# `parallel git tag {} ::: …` thay vào chỗ `{}`. Lệnh con ghi ref (REMOTE_REF_NAMES, kể cả sau khi mở alias) nhận đối số
# đó → UNRESOLVED_TARGET như tiền lệ `xargs git push` (T-1523) — đối số từ stdin còn có thể là CỜ (`-b origin/main`,
# `--no-delete`). Cho qua khi phần thấy được đã khoá chế độ không tạo ref bất kể đối số thêm (đo trên git 2.43):
# `branch -D` (`-d` thì không — `--no-delete` từ stdin bật lại tạo nhánh), `tag -d` (chế độ loại trừ, cờ khác lỗi 129),
# `--` trước chỗ thay (`checkout --`: phần sau là đường dẫn), `stash <lệnh con ≠ branch>`, `worktree <lệnh con ≠ add>`;
# hoặc chuỗi thay không nằm trong đối số của lệnh con (`xargs -I{} git -C {} pull`). `find -exec … {}`: `_remote_ref_rule`.
XARGS_REPLACE_RE = re.compile(r"-[0rtpx]*([Ii])(.*)")  # `-I R`, `-IR`, `-i[R]`, cả cụm `-0I{}`
PARALLEL_REPLACE_RE = re.compile(r"\{[^{}\s]*\}")  # chuỗi thay của GNU parallel: `{}`, `{.}`, `{/}`, `{1}`…
PARALLEL_ARG_SEPS = {":::", "::::", ":::+", "::::+"}
Fed = Optional[Callable[[str], bool]]  # nhận ra token bị thay bằng đối số không thấy; None = nối vào cuối
# Tuỳ chọn của GNU parallel (`options_hash` trong src/parallel; Getopt::Long `bundling`, `require_order`): chữ ngắn ăn
# giá trị, cờ ngắn, tên dài ăn giá trị, tên dài là cờ. Ngoài các bảng này (tên viết tắt, bản mới, giá trị tuỳ chọn
# `-i`/`-e`/`-l`) → không biết có ăn token kế không, nên cũng không biết token nào là mẫu lệnh: đã gặp tuỳ chọn lạ ở
# bất kỳ chỗ nào thì `_parallel_jobs` quét các nhóm `:::` như không có mẫu (chiều chặt). Bổ sung đối chiếu man page
# parallel(1) Debian unstable (bản 20240222, manpages.debian.org, đọc 2026-10-28): cờ `resume` `resume-failed`
# `retry-failed` `ctag` `csv` `plain` `transfer`; ăn giá trị `memsuspend` `group-by` `ctagstring`.
PARALLEL_SHORT_VALUE = set("aBCdDEHIjJLnNPsSUW")
PARALLEL_SHORT_FLAGS = set("0ghkmMpqrtTuvVxXY")
PARALLEL_LONG_VALUE = set(
    """arg-file arg-file-sep argfilesep arg-sep argsep basefile bf block block-size blocksize colsep col-sep
    compress-program ctagstring decompress-program delay delimiter env group-by halt halt-on-error header jl joblog jobs
    load max-args max-chars max-procs max-replace-args memfree memsuspend nice parens profile recend recstart res result
    results retries return
    rpl semaphorename semaphoretimeout ssh sshdelay sshlogin sshloginfile slf tagstring tag-string tempdir termseq
    term-seq tf timeout tmpdir transferfile transfer-file transferfiles transfer-files trc trim wd workdir work-dir
    """.split()
)
PARALLEL_LONG_FLAGS = set(
    """bar bg cat citation cleanup compress csv ctag dry-run dryrun eta fg fifo files group gnu help keep-order
    keeporder lb line-buffer linebuffer link no-keep-order no-notice no-run-if-empty nonall nonotice null onall pipe
    pipe-part pipepart plain plus progress quote resume resume-failed retry-failed shellquote shuf silent tag tee transfer
    tty ungroup verbose version will-cite xapply xargs
    """.split()
)
PARALLEL_SEP_OPTS = {"arg-sep": 0, "argsep": 0, "arg-file-sep": 1, "argfilesep": 1}  # 0 = `:::`, 1 = `::::`
PARALLEL_JOBS_MAX = 64  # tổ hợp nhóm `:::` tối đa quét lồng; hơn: không mẫu → UNRESOLVED_TARGET, có thể có → từng token
PARALLEL_UNSEEN_MARK = "lệnh của parallel guard không thấy"  # dấu của UNRESOLVED_TARGET


def _parallel_opt(tok: str) -> Tuple[str, Optional[bool], str]:
    """(tên, ăn token kế — None = không biết, giá trị viết liền) của tuỳ chọn `tok` của parallel (`-kj2`, `--jobs=2`)."""
    if tok.startswith("--"):
        name, eq, val = tok[2:].partition("=")
        if eq or name in PARALLEL_LONG_FLAGS:
            return name, False, val
        return name, (True if name in PARALLEL_LONG_VALUE else None), ""
    for k, ch in enumerate(tok[1:], 1):
        if ch in PARALLEL_SHORT_VALUE:
            return ch, k == len(tok) - 1, tok[k + 1 :]
        if ch not in PARALLEL_SHORT_FLAGS:
            return ch, None, ""
    return "", False, ""


def _parallel_jobs(c: List[str]) -> Tuple[List[str], str]:
    """`parallel [tuỳ chọn] ::: a b [:::|:::+ …]` KHÔNG có mẫu lệnh chạy mỗi đối số (tổ hợp các nhóm) như một dòng lệnh
    shell (AUD-SEC-121) → (dòng lệnh để quét lồng, lý do UNRESOLVED_TARGET khi dấu tách đổi qua tên viết tắt hay quá
    PARALLEL_JOBS_MAX tổ hợp). Nhóm rỗng thành [""] như GNU parallel (nguồn rỗng thay bằng chuỗi rỗng). Có mẫu lệnh →
    ([], ""): đối số là dữ liệu (`_stdin_fed`, `_runner_scripts`). Nhóm đọc từ tệp (`::::`, `-a`, `--arg-file`) coi như
    [""] — guard không đọc nội dung tệp, như chạy tệp script (`bash cmds.txt`) — các nhóm `:::` thấy được vẫn quét. Đã
    gặp tuỳ chọn lạ: không biết token nào là giá trị, token nào là mẫu → coi như không mẫu (chiều chặt); khi đó quá
    PARALLEL_JOBS_MAX tổ hợp mà có thể có mẫu (token trước `:::`) thì quét từng token của từng nhóm (review #308). Không
    `:::`/`-a` (đọc stdin) chưa xét ở đây."""
    s = _strip_prefixes(c)
    if not s or posixpath.basename(s[0]) != "parallel":
        return [], ""
    seps, files = [":::", ":::+"], ["::::", "::::+"]
    i, odd, why = _parallel_head(s, seps, files)
    end = next((k for k in range(i, len(s)) if s[k] in seps + files), len(s))
    if why or (end > i and not odd):
        return [], why
    groups: List[List[str]] = []
    from_file = False
    for t in s[end:]:  # s[end] là dấu tách: nhóm đầu luôn có trước đối số đầu
        if t in seps + files:
            from_file = t in files
            groups.append([""] if from_file else [])  # tên tệp không phải lệnh; nội dung tệp không thấy
        elif not from_file:
            groups[-1].append(t)
    if any(groups):
        groups = [g or [""] for g in groups]
    total = 1
    for g in groups:
        total = min(total * len(g), PARALLEL_JOBS_MAX + 1)
    if total > PARALLEL_JOBS_MAX and end > i:
        return [t for g in groups for t in g if t], ""
    if total > PARALLEL_JOBS_MAX:
        return [], f"{PARALLEL_UNSEEN_MARK} (quá {PARALLEL_JOBS_MAX} tổ hợp đối số)"
    return ([" ".join(p) for p in itertools.product(*groups)] if groups else []), ""


def _parallel_head(s: List[str], seps: List[str], files: List[str]) -> Tuple[int, bool, str]:
    """Bỏ tuỳ chọn của `parallel` (`s[0]`): (chỉ số token đầu sau tuỳ chọn, đã gặp tuỳ chọn lạ — giữ suốt, lý do
    UNRESOLVED_TARGET). `--arg-sep`/`--arg-file-sep` đổi `seps`/`files` tại chỗ; viết tắt `--arg-s`, `--argf`… → không
    biết dấu tách/tệp đối số."""
    i, odd = 1, False
    while i < len(s) and s[i].startswith("-") and s[i] not in seps + files:
        tok = s[i]
        i += 1
        if tok == "--":
            break
        name, takes, val = _parallel_opt(tok)
        if takes and i < len(s):
            val, i = s[i], i + 1
        odd = odd or takes is None
        if name in PARALLEL_SEP_OPTS:
            (files if PARALLEL_SEP_OPTS[name] else seps)[:] = [val, val + "+"]
        if takes is None and name.startswith("arg"):
            return i, odd, f"{PARALLEL_UNSEEN_MARK} (tuỳ chọn `{tok}`)"
    return i, odd, ""


def _xargs_replace(opts: List[str]) -> Optional[str]:
    """Chuỗi thay của `xargs -I R|-IR|-i[R]|--replace[=R]` trong tuỳ chọn của xargs; None = nối đối số vào cuối."""
    for i, t in enumerate(opts):
        if t.startswith("--replace"):
            return t.partition("=")[2] or "{}"
        m = XARGS_REPLACE_RE.fullmatch(t)
        if m:
            later = opts[i + 1] if m.group(1) == "I" and i + 1 < len(opts) else "{}"
            return m.group(2) or later
    return None


def _stdin_fed(c: List[str], s: List[str]) -> Tuple[List[str], bool, Fed]:
    """(argv git, có nhận đối số không thấy, cách nhận) của lệnh `c` (`s` = đã bỏ tiền tố): `xargs [-I R] git …`,
    `parallel [cờ] git …|'git …' [::: …]`; lệnh khác → (s, False, None)."""
    head = c[: len(c) - len(s)]
    base = [posixpath.basename(t) for t in head]
    if "xargs" in base:
        mark = _xargs_replace(head[len(base) - base[::-1].index("xargs") :])
        return s, True, (lambda t: mark in t) if mark else None
    if not s or posixpath.basename(s[0]) != "parallel":
        return s, False, None
    end = next((k for k, t in enumerate(s) if t in PARALLEL_ARG_SEPS), len(s))
    for k in range(1, end):
        words = _split_words(s[k]) if " " in s[k] else [s[k]]
        if words and posixpath.basename(words[0]) == "git":
            g = words + s[k + 1 : end]
            replaced = any(PARALLEL_REPLACE_RE.search(t) for t in g)
            return g, True, (lambda t: bool(PARALLEL_REPLACE_RE.search(t))) if replaced else None
    return s, False, None


def _fixed_no_create(sub: str, seen: List[str]) -> bool:
    """Phần đối số thấy được `seen` đã khoá lệnh con vào chế độ không tạo/ghi ref, bất kể đối số thêm phía sau."""
    if sub == "tag":
        return _has_opt(_parse_opts(seen, "mFu", TAG_VALUE_OPTS)[0], {"-d", "--delete"})
    if sub == "branch":
        return "-D" in _parse_opts(seen, "u", BRANCH_VALUE_OPTS)[0]
    if sub in ("stash", "worktree") and seen[:1] and not seen[0].startswith("-"):
        return seen[0] != {"stash": "branch", "worktree": "add"}[sub]
    return sub in NEW_BRANCH_OPTS and "--" in seen


def _fed_ref_why(n: List[str], fed: Fed, shell: bool = False) -> str:
    """Lệnh git `n` (đã mở alias) nhận đối số không thấy (`fed`): lý do UNRESOLVED_TARGET nếu nó có thể ghi/tạo ref
    remote; rỗng nếu không. `shell`: `n` = [script, đối số…] của alias `!` — đối số lạ đi thẳng vào script."""
    if shell:
        return UNRESOLVED_ARGS_WHY.format("<alias !>", "alias `!` nhận đối số từ xargs/parallel")
    if len(n) < 2 or (fed is not None and fed(n[1])):
        return UNRESOLVED_ARGS_WHY.format("<lệnh con>", "lệnh con đến từ stdin")
    sub, args = n[1], n[2:]
    if sub not in REMOTE_REF_NAMES:
        return ""
    k = len(args) if fed is None else next((i for i, a in enumerate(args) if fed(a)), -1)
    if k < 0 or _fixed_no_create(sub, args[:k]):
        return ""
    return UNRESOLVED_ARGS_WHY.format(sub, "đối số từ xargs/parallel")


def _alias_resolve(
    n: List[str],
    g: List[str],
    gdir: str,
    env: Dict[str, str],
    budget: Optional["ScanBudget"],
    defined: Optional[AliasTable] = None,
) -> Tuple[str, List[str]]:
    """Mở alias của lệnh git `n` (`g` = argv chưa chuẩn hoá, `env` = biến của lệnh) bằng bảng git dựng ở `gdir` nối
    thêm alias đặt ở lệnh trước trong cùng chuỗi (`defined`, AUD-SEC-464 — mục sau thắng): như `_git_alias_expand`,
    lệnh con không phải alias → ("", n); lệnh con là file `find -exec {}` tìm thấy (`find update-ref -exec git {} …`)
    hay không đọc được cấu hình → ("unresolved", [lý do])."""
    if FIND_FOUND in n[1]:
        return "unresolved", ["lệnh con là file `find` tìm thấy"]
    read = _alias_read_args(g, env)
    table = _git_alias_table(gdir, *read, budget) if read else None
    if table is None:
        return "unresolved", ["không đọc được cấu hình alias của lệnh (biến, lỗi, quá hạn)"]
    kind, out = _git_alias_expand(n, [*table, *(defined or [])])
    return (kind, out) if kind else ("", n)


def _git_alias_sources(
    placed: PlacedCmds, root: str, budget: Optional["ScanBudget"]
) -> Tuple[Placed, Placed, List[str]]:
    """Lệnh git gọi alias (AUD-SEC-119) hay nhận đối số không thấy (xargs/parallel): (bản viết lại thay alias bằng lệnh
    thật, giữ tuỳ chọn toàn cục như `-C`; script của alias `!` kèm repo nó chạy; câu hỏi UNRESOLVED_TARGET). Mọi lệnh con
    ngoài GIT_BUILTINS đều tra bảng alias do git dựng với cấu hình của lệnh (`_alias_read_args`) — môi trường = gán đầu
    lệnh ∪ gán/`export` ở lệnh trước trong cùng chuỗi (chiều chặt: gán trần cũng tính)."""
    rewritten: Placed = []
    nested: Placed = []
    asks: List[str] = []
    exported: Dict[str, str] = {}
    # alias đặt ở lệnh trước trong chuỗi — bảng của git chưa có lúc kiểm (AUD-SEC-464); cả alias tầng ngoài đặt (shell
    # lồng, `eval` — AUD-SEC-481, giữ trong ngân sách của quyết định)
    defined: AliasTable = list(budget.aliases) if budget is not None else []
    for c, here in placed:
        s = _strip_prefixes(c)
        _chain_assign(exported, c)
        g, wrapped, fed = _stdin_fed(c, s)
        n = normalize(g)
        pos = _git_config_write(n)
        if len(pos) > 1 and pos[0][:6].lower() == "alias.":  # mọi phạm vi/tệp (`--global`, `-f`): chiều chặt
            defined.append((pos[0][6:], pos[1]))
            if budget is not None and defined[-1] not in budget.aliases:
                budget.aliases.append(defined[-1])
            continue
        sub = n[1] if n[:1] == ["git"] and len(n) > 1 else ""
        aliased = bool(sub) and not sub.startswith("-") and sub not in GIT_BUILTINS
        if n[:1] != ["git"] or not (aliased or wrapped):
            continue
        gdir = _git_dir(g, here) or root
        env = {**exported, **_assign_values(c[: len(c) - len(s)])}
        kind, out = _alias_resolve(n, g, gdir, env, budget, defined) if aliased else ("", n)
        why = "" if not wrapped or kind == "unresolved" else _fed_ref_why(out, fed, kind == "shell")
        asks += [f"{why}: {' '.join(c)[:200]}"] if why else []
        if kind == "git":
            rewritten.append((_join_tokens([*g[: len(g) - len(n) + 1], *out[1:]]), here))
        elif kind == "shell":
            nested.append((" ".join([out[0], _join_tokens(out[1:])]), gdir))
        elif kind:
            asks.append(f"{UNRESOLVED_ALIAS_MARK} ({out[0]}): {' '.join(c)[:200]}")
    return rewritten, nested, asks


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
# ghi cả cây vào thư mục đích trong script (gộp nội dung không biết trước — AUD-SEC-248)
TREE_WRITE_RE = re.compile(r"\b(copytree|copy_tree|unpack_archive|extractall|cpSync|cp_r|copy_entry)\b\s*(\(?)")
# AUD-SEC-340: thêm (chỉ dạng gọi có ngoặc) — `tarfile/zipfile.extract(m, DST)`, fs-extra `copySync`/`moveSync`, Node
# `fs.cp`/`fs.promises.cp`, Perl File::Copy::Recursive `dircopy`/`dirmove`/`rcopy`/`rmove`.
TREE_CALL_RE = re.compile(r"\b(extract|copySync|moveSync|cp|dircopy|dirmove|rcopy|rmove)\s*(\()")
# Chép/dời VÀO đích (thư mục có sẵn nhận `đích/tên nguồn`): `shutil.copy/copy2/copyfile/move`, `os.rename(s)`,
# fs-extra `copy`/`move`, Perl `File::Copy` `copy`/`move`/`mv`, `fcopy`.
INTO_WRITE_RE = re.compile(r"\b(copy2?|copyfile|copy_file|move|renames?|fcopy|mv)\s*(\()")


def _call_args(script: str, m: "re.Match[str]") -> List[str]:
    """Các đối số (chữ nguồn) của lời gọi bắt đầu ở `m`: trong ngoặc (`f(a, b)`), hay tới hết dòng/`;` khi gọi không
    ngoặc (Ruby `FileUtils.cp_r 'a', 'b'`); tách ở dấu phẩy ngoài ngoặc/chuỗi (`_first_arg`)."""
    rest = _balanced(script, m.end(), "(", ")") if m.group(2) else re.split(r"[\n;]", script[m.end() :], maxsplit=1)[0]
    return _split_args(rest)


def _split_args(rest: str) -> List[str]:
    """Tách chữ nguồn các đối số ở dấu phẩy ngoài ngoặc/chuỗi (`_first_arg`); mỗi vòng tiêu ít nhất một ký tự."""
    parts: List[str] = []
    while rest.strip():
        parts.append(_first_arg(rest))
        rest = rest[len(parts[-1]) + 1 :]
    return parts


def _tree_write_dests(script: str) -> List[str]:
    """Chuỗi nguyên văn ở đối số ĐÍCH của lời gọi ghi cả cây (`copytree(src, DST)`, `unpack_archive(f, DST)`,
    `extractall(DST)`): nguồn hay chuỗi khác trong script không phải đích (review #405 — `copytree("docs", "/tmp/x")`
    từng bị chặn oan)."""
    out: List[str] = []
    for m in itertools.chain(TREE_WRITE_RE.finditer(script), TREE_CALL_RE.finditer(script)):
        args = _call_args(script, m)
        out += [_literal(x) for a in (args if m.group(1) == "extractall" else args[1:]) for x in LITERAL_RE.finditer(a)]
    return out


def _into_write_dests(script: str) -> List[Tuple[Optional[str], str]]:
    """(nguồn nếu là MỘT chuỗi nguyên văn, chuỗi ở đối số đích) của lời gọi chép/dời VÀO đích (`INTO_WRITE_RE`)."""
    out: List[Tuple[Optional[str], str]] = []
    for m in INTO_WRITE_RE.finditer(script):
        args = _call_args(script, m)
        src = PLAIN_LITERAL_RE.fullmatch(args[0]) if args else None
        out += [(_literal(src) if src else None, _literal(x)) for a in args[1:] for x in LITERAL_RE.finditer(a)]
    return out


def _ledger_dest_hits(script: str, root: str, here: Optional[str]) -> List[str]:
    """Đích ghi trong script trúng sổ giai đoạn (AUD-SEC-248/340): lời gọi ghi cả cây vào sổ hay tổ tiên của nó; chép/
    dời vào sổ hay thư mục sổ (tên nguồn không quyết được: `fs-extra.copy` gộp nội dung thư mục); vào `docs` khi nguồn
    không phải chữ nguyên văn hay tên nguồn là `autopilot`."""
    out = [
        lit for lit in _tree_write_dests(script) if any(_ledger_hit(_rel_dir(x, root)) for x in _where(lit, root, here))
    ]
    for src, lit in _into_write_dests(script):
        rels = [_rel_dir(x, root) for x in _where(lit, root, here)]
        top = src is None or posixpath.basename(src.rstrip("/")) == LEDGER_DIR_PARTS[-1]
        if any(_ledger_hit(r) and (r != LEDGER_PATHS[-1] or top) for r in rels):
            out.append(lit)
    return out


HOME_EXPR_RE = re.compile(
    r"expanduser\(\s*['\"]~/?['\"]\s*\)|Path\.home\(\)|environ(?:\[|\.get\()\s*['\"]HOME['\"]|getenv\(\s*['\"]HOME['\"]|homedir\(\)"
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
    return _interp_opts(n)[0]


def _interp_opts(n: List[str]) -> Tuple[List[str], int, bool]:
    """(script trong phần cờ — `_interp_opt_scripts`, vị trí sau phần cờ: file script, `-`, `--`; hết argv nếu `-m`,
    gặp cờ kết thúc phần cờ như `-m`)."""
    m = INTERP_RE.fullmatch(n[0]) if n else None
    spec = INTERP_SHORT_OPTS.get(INTERP_FAMILY.get(m[1], m[1])) if m else None
    out: List[str] = []
    i, stop = 1, False
    while spec and not stop and i < len(n) and n[i][:1] == "-" and n[i] not in ("-", "--"):
        nxt = n[i + 1] if i + 1 < len(n) else None
        if n[i].startswith("--"):
            script, width = _long_opt(n[i], nxt)
        else:
            script, width, stop = _short_opt(n[i], nxt, spec)
        out += [script] if script is not None else []
        i = len(n) if stop else i + width
    return out, i, stop


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


def _interp_scripts_at(
    cmd: str, tokens: List[str], cwd: Optional[str], budget: Optional[ScanBudget] = None
) -> List[Tuple[str, Optional[str]]]:
    """(script, thư mục nó chạy) — `cd .claude && python3 -c '…'` chạy trong `.claude` (AUD-SEC-085). Thân heredoc gắn
    với thư mục của mọi lệnh trình thông dịch đọc stdin trong lệnh (không có thì `cwd`). Script qua stdin bằng
    here-string (`python3 <<< '…'`) hay ống (`echo '…' | node`) cũng tính (D-105)."""
    out: List[Tuple[str, Optional[str]]] = []
    stdin_dirs: List[Optional[str]] = []
    placed = _commands_with_cwds(tokens, cwd)  # mọi thư mục ứng viên (T-3672: `cd` có thể hỏng)
    for c, cands in placed:
        n = _interp_argv(c)  # cả sau lệnh chạy hộ (`uv run python -c …` — AUD-SEC-093)
        if n and INTERP_RE.fullmatch(n[0]):
            out += [(s, here) for s in _inline_scripts(n) for here in cands]
        if _stdin_interp(c):
            stdin_dirs += cands
            out += [(c[i + 1], here) for i, a in enumerate(c[:-1]) if a == "<<<" for here in cands]
    i, places = 0, [d for _, d in placed]  # dựng một lần: dựng lại mỗi pipeline từng bậc hai (review #361 lượt 2)
    for pipe in pipelines(tokens):
        for feed, down, downs in zip(_pipe_feeds(pipe), pipe[1:], places[i + 1 : i + len(pipe)]):
            out += [(s, here) for s in feed or [] if _stdin_interp(down) for here in downs]
        i += len(pipe)
    dirs = list(dict.fromkeys(stdin_dirs)) or [cwd]
    return out + [(body, d) for body in _heredoc_scripts(cmd, _stdin_interp, budget) for d in dirs]


# Lời gọi chạy lệnh shell từ trình thông dịch (`os.system('…')`, `subprocess.run(['rm','-rf','~'])`, `execSync('…')`):
# chuỗi nguyên văn trong đối số là lệnh thật. Chỉ xét chuỗi nằm trong lời gọi này (không phải mọi chuỗi trong script).
EXEC_CALL_RE = re.compile(
    r"\b(os\.(?:system|popen|exec\w*|spawn\w*|posix_spawnp?)|subprocess\.\w+|Popen|check_output|check_call|getoutput"
    r"|create_subprocess_(?:shell|exec)|execSync|execFileSync|spawnSync|execFile|spawn|exec|system|popen)\s*\("
)
# Lời gọi mà argv KHÔNG nằm ở đối số đầu (AUD-SEC-342): Python `os.exec*`/`os.spawn*` (sau đường dẫn — và chế độ của
# spawn — là danh sách argv đủ, hay argv0, arg1… rời; `posix_spawn(path, argv, env)`), `create_subprocess_exec(prog,
# *args)`; Node `spawn`/`execFile` (tên chương trình + mảng đối số). Lua `os.execute('…')` là lệnh shell — không ở đây.
PY_OS_EXEC_RE = re.compile(r"os\.(?:exec[lv]p?e?|(spawn)[lv]p?e?|posix_spawnp?)")
NODE_FILE_EXEC = frozenset({"spawn", "spawnSync", "execFile", "execFileSync"})
# `shell=<giá trị>` khác `False`/`None`/`0` (review lượt 2: `shell=1`, `shell=flag`) → chặt: phần tử đầu là lệnh shell
SHELL_TRUE_RE = re.compile(r"\bshell\s*=(?!=)\s*(?!(?:False|None|0)\b)[^\s,)]")
EXECUTABLE_KW_RE = re.compile(r"executable\s*=(?!=)\s*(.*)", re.S)  # `Popen([...], executable="/bin/sh")`
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


PLAIN_LITERAL_RE = re.compile(
    r"""\s*[rRuU]?(?:'\'\'((?:(?!'\'\').)*)'\'\'|\"\"\"((?:(?!\"\"\").)*)\"\"\""""
    r"""|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")\s*""",
    re.S,
)  # một chuỗi (cả nháy ba — review #405), không f/ghép


def _exec_api_verbatim(scripts: List[str]) -> List[str]:
    """Chuỗi mà sh/bash đọc NGUYÊN VĂN trong lời gọi thực thi (AUD-SEC-307): đối số đầu là MỘT chuỗi trơn
    (`os.system('…')`, `popen`, `subprocess.run('…', shell=True)`), hay phần tử sau `-c` của argv dạng danh sách mà phần
    tử đầu là shell (`subprocess.run(["bash", "-c", "…"])`, cả tuple và argv ở đối số sau: `os.execvp("bash", [...])`,
    `spawnSync("bash", ["-c", "…"])`), phần tử đầu của danh sách khi `shell=True` (AUD-SEC-342). Chuỗi ghép/f-string
    guard tự dựng → không (giữ lỏng)."""
    out: List[str] = []
    for script in map(_nfkc, scripts):
        for name, args in _exec_calls(script):
            first = args[0] if args else ""
            items, shell = _exec_items(name, args)
            if items is not None:  # bóc env/timeout/busybox, cờ như bash thật: `-lc`, `-c -x S` (review #405)
                out += _argv_shell_scripts(items, shell)
            if first[:1] != "[" and (lit := PLAIN_LITERAL_RE.fullmatch(first)):  # luật cũ giữ (OR — #352/#372)
                out.append(_literal(lit))
    return out


def _exec_items(name: str, args: List[str]) -> Tuple[Optional[List[str]], bool]:
    """(argv của lời gọi — đối số sau hay danh sách/tuple ở đối số đầu, None nếu không có; có `shell=` truthy không).
    `executable="…"` (không shell) là chương trình chạy thật thay argv[0]: `Popen(["x", "-c", S], executable="/bin/sh")`
    chạy `sh -c S` (review lượt 2)."""
    argv = _exec_argv(name, args)
    items = argv if argv is not None else _seq_items(args[0] if args else "")
    shell = argv is None and bool(SHELL_TRUE_RE.search(",".join(args[1:])))
    exe = [lit for a in args[1:] if (m := EXECUTABLE_KW_RE.fullmatch(a)) and (lit := PLAIN_LITERAL_RE.fullmatch(m[1]))]
    if items and exe and not shell:
        items = [_literal(exe[-1])] + items[1:]
    return items, shell


def _argv_shell_scripts(items: List[str], shell_true: bool) -> List[str]:
    """Chuỗi sh đọc nguyên văn từ argv: phần tử đầu khi `shell=True` (POSIX: `sh -c args[0]` — AUD-SEC-342), không thì
    phần tử sau `-c` khi argv chạy shell."""
    if shell_true:
        return items[:1]
    items = normalize(items)
    has_c, s = _shell_script_arg(items) if items[:1] and items[0] in SHELLS else (False, None)
    return [s] if has_c and s is not None else []


# Vùng chuỗi và chú thích `#…`/`//…` tới hết dòng của script (AUD-SEC-342): nháy lẻ trong chú thích (`# don't`) không
# mở chuỗi nuốt lời gọi tới nháy kế. Đọc nhầm `//` (chia nguyên Python) hay `#` thành chú thích có thể nuốt nháy MỞ và
# đổi chẵn lẻ mọi nháy sau (review lượt 2 🔴) → không thay cách tính cũ: lời gọi chỉ bị bỏ khi nằm trong chuỗi theo CẢ
# HAI cách tính (`STR_ANY_RE` cũ làm sàn).
CODE_SPAN_RE = re.compile(STR_ANY_RE.pattern + r"|#[^\n]*|//[^\n]*", re.S)


def _string_spans(rx: "re.Pattern[str]", script: str) -> Tuple[List[int], List[int]]:
    """(điểm đầu, điểm cuối) các vùng chuỗi `'…'`/`"…"` theo `rx` (bỏ vùng chú thích của `CODE_SPAN_RE`)."""
    spans = [m.span() for m in rx.finditer(script) if m.group(0)[:1] in "'\""]
    return [a for a, _ in spans], [b for _, b in spans]


def _in_string(pos: int, spans: Tuple[List[int], List[int]]) -> bool:
    k = bisect.bisect_right(spans[0], pos) - 1
    return k >= 0 and pos < spans[1][k]


def _exec_calls(script: str) -> List[Tuple[str, List[str]]]:
    """(tên, chữ nguồn từng đối số — từ khoá `args=`/`file=`… đã về đúng chỗ) của lời gọi thực thi KHÔNG nằm trong
    chuỗi (`.write("os.system('…')")` là chữ)."""
    old, new = _string_spans(STR_ANY_RE, script), _string_spans(CODE_SPAN_RE, script)
    out: List[Tuple[str, List[str]]] = []
    for m in EXEC_CALL_RE.finditer(script):
        if not (_in_string(m.start(), old) and _in_string(m.start(), new)):
            out.append((m.group(1), _kw_positional(_split_args(_balanced(script, m.end(), "(", ")")))))
    return out


# Đối số theo từ khoá đứng thay vị trí (review lượt 2): `subprocess.run(args=[…])`, `os.execvp(file=…, args=[…])`,
# `os.spawnv(mode=…, file=…, args=[…])` — thứ tự tên là thứ tự tham số của các API này.
EXEC_KW_SLOTS = ("mode", "file", "path", "args", "argv")
EXEC_KW_RE = re.compile(r"(\w+)\s*=(?!=)\s*(.*)", re.S)


def _kw_positional(args: List[str]) -> List[str]:
    """Giá trị các từ khoá `EXEC_KW_SLOTS` (theo thứ tự tham số) chèn sau các đối số vị trí đứng đầu; đối số khác giữ
    nguyên chữ và thứ tự (`shell=True`, `executable=…` — luật sau đọc chữ; không có từ khoá chỗ → y như cũ)."""
    args = [a.strip() for a in args]
    kws = [EXEC_KW_RE.fullmatch(a) for a in args]
    slots = {m.group(1): m.group(2).strip() for m in kws if m and m.group(1) in EXEC_KW_SLOTS}
    keep = [a for a, m in zip(args, kws) if not (m and m.group(1) in EXEC_KW_SLOTS)]
    lead = len(list(itertools.takewhile(lambda m: m is None, kws)))
    return keep[:lead] + [slots[k] for k in EXEC_KW_SLOTS if k in slots] + keep[lead:]


def _seq_items(arg: str) -> Optional[List[str]]:
    """Chuỗi nguyên văn trong danh sách/tuple `[…]`/`(…)` (đối số argv); không phải → None."""
    if arg[:1] not in ("[", "("):
        return None
    return [_literal(x) for x in LITERAL_RE.finditer(_balanced(arg, 1, arg[0], "]" if arg[0] == "[" else ")"))]


def _exec_argv(name: str, args: List[str]) -> Optional[List[str]]:
    """argv của lời gọi mà argv KHÔNG ở đối số đầu (`PY_OS_EXEC_RE`, `create_subprocess_exec`, `NODE_FILE_EXEC`);
    lời gọi khác → None (đối số đầu là lệnh shell hay argv)."""
    py = PY_OS_EXEC_RE.fullmatch(name)
    if py:  # sau đường dẫn (spawn: sau chế độ và đường dẫn): danh sách argv đủ, hay argv0, arg1… rời
        rest = args[2:] if py.group(1) else args[1:]
        seq = _seq_items(rest[0]) if rest else None
        return seq if seq is not None else [_literal(x) for a in rest for x in LITERAL_RE.finditer(a)]
    if name == "create_subprocess_exec":
        return [_literal(x) for a in args for x in LITERAL_RE.finditer(a)]
    if name in NODE_FILE_EXEC and args and PLAIN_LITERAL_RE.fullmatch(args[0]):
        tail = _seq_items(args[1]) if len(args) > 1 else None
        return [_literal(x) for x in LITERAL_RE.finditer(args[0])] + (tail or [])
    return None


def _exec_api_scripts(scripts: List[str]) -> List[str]:
    """Chuỗi lệnh trong đối số ĐẦU của lời gọi thực thi: `os.system('…')` (kể cả `f'…'`, `r'…'`, nháy ba, ghép
    `'rm' + ' -rf ~'`) → lệnh shell; `subprocess.run([…])`/tuple `(…)` → các phần tử ghép thành một lệnh (danh sách
    với `shell=True`: phần tử đầu là lệnh shell); argv ở đối số sau (`os.execvp`, `spawnSync`) ghép như danh sách
    (AUD-SEC-342). Chuỗi khác trong script (`print('…')`) là dữ liệu, không quét."""
    out: List[str] = []
    for script in map(_nfkc, scripts):
        for name, args in _exec_calls(script):
            first = args[0] if args else ""
            seq, shell = _exec_items(name, args)
            found = [shlex.join(seq)] if seq else []
            found += seq[:1] if seq and shell else []
            if first[:1] != "[" and LITERAL_RE.search(first):  # luật cũ giữ (OR); `(…)`: cả chuỗi trong ngoặc
                found.append("".join(_literal(x) for x in LITERAL_RE.finditer(first)))
            out += dict.fromkeys(found)
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


def interp_write_asks(
    cmd: str,
    tokens: List[str],
    root: str,
    cwd: Optional[str] = None,
    pending_bare: Optional[FrozenSet[str]] = None,
) -> List[str]:
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
        # `copytree(…, "docs/autopilot")`, `unpack_archive(…, "docs")` — AUD-SEC-248; `shutil.move(…, "docs/autopilot")`,
        # `t.extract(m, "docs")`, `dircopy(…, "docs/autopilot")` — AUD-SEC-340
        asks += [EVIDENCE_WHY.format(lit) for lit in _ledger_dest_hits(script, root, here)]
        hint, ro, probe = bool(WRITE_HINT_RE.search(script)), _ReadOnly(script, families), _WriteProbe(script)
        asks += [
            a
            for raw in _script_literals(script, families) + (_ipython_magic_words(script) if ipython else [])
            if (a := _interp_literal_ask(script, raw, root, here, hint, ro, probe, pending_bare))
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


def _ledger_tail(lit: str, script: str) -> bool:
    """Chuỗi là đuôi của đường sổ (`STAGE.json`, `autopilot/STAGE.json`) mà script nhắc nguyên văn mọi cấp thư mục sổ
    (`docs`, `autopilot` — trong một chuỗi hay nhiều): `Path("docs", "autopilot", "STAGE.json")`, `Path("docs") /
    "autopilot" / "STAGE.json"` (AUD-SEC-340). Tên sổ trong thư mục tạm hay chỉ là chữ ghi ra file khác thì không
    (review lượt 2)."""
    if not ("/" + STAGE_LEDGER).endswith("/" + lit):
        return False
    named = {p for x in LITERAL_RE.finditer(script) for p in _literal(x).split("/")}
    return set(LEDGER_DIR_PARTS) <= named


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
    pending_bare: Optional[FrozenSet[str]] = None,
) -> str:
    """Câu hỏi cho chuỗi `raw` trong script. Là hàng rào/cấu hình git/bí mật/bằng chứng (thử ở mọi thư mục canh khi
    `here` không biết — D-106) → câu mang dấu chặn, TRỪ khi toàn script chỉ gồm thao tác đọc (`ro`, D-105: mặc định
    chặn, không liệt kê API ghi). Cổng/năng lực mà script có dấu hiệu ghi (`hint`) → hỏi thường; khác → ''."""
    lit = PERL_OPEN_MODE_RE.sub("", raw)  # perl 2 đối số `open(F, ">f")`: chế độ dính vào tên file
    for target in _where(lit, root, here):
        rel = rel_path(target, root)
        kind = path_kind(rel, root) if ("/" in lit or "." in lit) and lit not in ("..", ".") else ""
        # tên sổ giai đoạn đứng riêng (`Path("docs/autopilot", "STAGE.json")`, `os.path.join(…, "STAGE.json")`) như
        # đường đủ — AUD-SEC-340
        kind = "evidence" if _ledger_tail(lit, script) else kind
        fence = _is_fence(target, root)
        git_hook = (
            _gitfile_target(target, root)
            or _global_git_config(target)
            or _git_hook_target(target, root)
            or _pending_bare_hit(target, here, pending_bare)
        )
        if not (fence or git_hook or kind in ("secret", "evidence")):
            continue
        if kind == "secret" and not (fence or git_hook) and build_local_secret(target, root, here):
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


# D-105: chỉ thao tác ĐỌC được phép trong script nhắc đường dẫn được canh; lời gọi khác, gán thuộc tính, nội suy có
# biểu thức, backtick, `flag(s)`, mode ghi → chặn. Phân tích theo từ (không AST): đa ngôn ngữ, chặt.
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


# AUD-SEC-084: đường dẫn gán cho biến (`f='.env'`, `p = Path('…')`, `b = a`) rồi là đối số ĐƯỜNG DẪN của lời gọi ghi/xoá
# → chặn như ghi trực tiếp; biến chỉ in/đọc/làm NỘI DUNG không tính. Còn hở: ghép chuỗi/format, dict, hàm tự viết.
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
            out.append(tuple(a.split("=", 1)))  # type: ignore[arg-type]  # đã có "=" nên đúng hai phần
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


def _gh_flag_files(args: List[str], split_at: bool = True) -> List[str]:
    """Giá trị của cờ đọc file (`GH_FILE_FLAGS`) ở mọi dạng: `--body-file f`, `--body-file=f`, `-F f`, `-Ff`, `-F=f`
    (review PR #182); giá trị `k=@f` thêm cả `f` (`split_at` — `gh pr|issue -F x=@y` đọc file tên nguyên văn thì tắt)."""
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
        out += [val, val.split("@", 1)[1]] if split_at and "=@" in val else [val]
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
    bodies = _dollar_scripts(line) + _backtick_scripts(line) if "$(" in line or "`" in line else []
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


# D-155/D-162: tên lệnh có glob (`/usr/bin/fi?d`, `/bin/r?`, `[r]m`, `ba?h -c …`) — shell mở ra tên thật, guard so tên theo
# chữ nên từng bỏ lọt. Danh sách đóng: lệnh có luật riêng (xoá/ghi/leo quyền), shell, wrapper; không đoán theo hệ tệp
# (kết quả không đổi theo máy, tệp tạo giữa lệnh vẫn bị tính).
GLOB_COMMANDS = tuple(
    sorted(
        {"rm", "find", "shred", "unlink", "rsync", "mv", "dd", "sudo", "doas", "git", "env", "mkfs", "eval", "source"}
        | {"curl", "wget", "gh", "cp", "tee", "ln", "install", "sed", "truncate", "tar", "unzip", "awk", "patch"}
        | {"chmod", "chown", "ssh", "scp", "claude", "kubectl", "docker", "podman", "terraform", "tofu", "pulumi"}
        | {"helm", "aws", "gcloud", "az", "nerdctl", "docker-compose", "podman-compose"}
        | set(FILE_WRITERS)
        | INTERPRETERS
        | WRAPPERS
        | RUNNERS
    )
)
# Biểu thức ngoặc: `[…]` có thể chứa `[:lớp:]`, `[.x.]`, `[=x=]` lồng bên trong (`[[:lower:][:digit:]]`). Các nhánh loại
# trừ nhau theo ký tự đầu (không lượng từ chồng lấp) — dạng `.*?` trong vòng `+` từng backtrack hàm mũ trên `[[:a:]…` không đóng
GLOB_BRACKET_RE = re.compile(r"\[!?\]?(?:[^\[\]]|\[:[^\]]*:\]|\[\.[^\]]*\.\]|\[=[^\]]*=\]|\[(?![:.=]))*\]")
GLOB_POSIX_RE = re.compile(r"\[[:.=]")
# Từ đầu lệnh trong chuỗi gốc: đứng sau đầu chuỗi/khoảng trắng/`; & | ( ) ` { !` và trước khoảng trắng/dấu nối lệnh — từ trong
# nháy (`'/bin/r?'`) không khớp: shell không mở glob trong nháy
GLOB_WORD_BEFORE, GLOB_WORD_AFTER = r"(?<![^\s;&|()`{!])", r"(?![^\s;&|()<>`}])"


GLOB_HEAD_MAX = 256  # tên lệnh dài hơn: không đưa vào fnmatch (bậc hai theo độ dài mẫu, review #248)
GLOB_MAX_HEADS = 8  # số tên lệnh glob khác nhau tối đa mỗi lệnh — quá thì chặn trước khi dựng bản viết lại (D-167)
# D-167: tên lệnh glob CHỈ xét khi là đường tới thư mục bin hệ thống (thư mục không glob) — cách thật để gọi lệnh qua glob;
# mẫu `case`, số học, nhóm regex, mảng không bao giờ có dạng này nên không chặn oan theo cấu trúc (bộ tách cú pháp bằng
# token của D-163…D-166 không hội tụ qua 8 lượt review). Tên trần glob (`s?`) chỉ mở theo tệp ở thư mục đang đứng.
GLOB_BIN_DIRS = frozenset(
    {"/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin", "/opt/homebrew/bin"}
    | {"~/bin", "~/.local/bin", "$HOME/bin", "$HOME/.local/bin", "${HOME}/bin", "${HOME}/.local/bin"}
)


def _segment_commands(tokens: List[str]) -> Iterator[List[str]]:
    """Từng lệnh đơn (sau gán biến/wrapper/từ khoá) — rỗng bỏ qua; phần tử mảng `NAME=( … )` không phải lệnh."""
    start = 0
    for end in [i for i, t in enumerate(tokens) if _is_punct(t) and not _is_redirect(t)] + [len(tokens)]:
        array = start >= 2 and tokens[start - 1] == "(" and tokens[start - 2].endswith("=")
        rest = [] if array else _strip_prefixes(tokens[start:end])
        if rest:
            yield rest
        start = end + 1


def _glob_names(head: str, bare: bool = False) -> List[str]:
    """Tên nhạy cảm mà tên lệnh `head` (đường tới thư mục bin hệ thống, phần tên có glob) có thể mở ra. Thư mục khác/có
    glob, phần tên không glob hay chỉ toàn `*`/`?`, quá dài → rỗng: không đoán. `bare` = lệnh không đối số: `sudo`/`doas`/
    `mkfs` trơn vô hại nên bỏ. Bash coi `[^x]` như `[!x]`, `[[:alpha:]]`/`[[.r.]]`/`[[=r=]]` là lớp ký tự — Python
    `fnmatch` không → đổi trước khi so."""
    directory, base = posixpath.split(head)
    directory = posixpath.normpath(re.sub("^/+", "/", directory)) if directory.startswith("/") else directory
    if directory not in GLOB_BIN_DIRS or not GLOB_RE.search(base) or not base.strip("*?") or len(base) > GLOB_HEAD_MAX:
        return []
    pat = GLOB_BRACKET_RE.sub(lambda m: "?" if GLOB_POSIX_RE.search(m[0]) else m[0], base).replace("[^", "[!")
    return [n for n in GLOB_COMMANDS if fnmatch.fnmatchcase(n, pat) and not (bare and n in ("sudo", "doas", "mkfs"))]


def _glob_heads(tokens: List[str]) -> Dict[str, List[str]]:
    """Từ đầu lệnh có glob (chữ nguyên, sau gán biến/wrapper) của từng lệnh đơn → các tên nhạy cảm nó có thể mở ra."""
    heads: Dict[str, List[str]] = {}
    for rest in _segment_commands(tokens):
        names = _glob_names(rest[0], len(rest) == 1)
        if names:
            heads[rest[0]] = list(dict.fromkeys([*heads.get(rest[0], []), *names]))
    return heads


def _scan_glob_rewrites(
    cmd: str,
    tokens: List[str],
    root: str,
    cwd: Optional[str],
    depth: int,
    asks: List[str],
    budget: "ScanBudget",
    rw: int,
) -> str:
    """Quét bản viết lại theo tên glob (D-162/D-167); quá `GLOB_MAX_HEADS` tên glob hay lệnh dài quá `REWRITE_MAX_CHARS`
    → chặn TRƯỚC khi dựng (bản viết lại tốn số tên × độ dài lệnh — review #248 lượt 8: dựng trước rồi mới xét ngân sách
    từng cạn bộ nhớ → guard chết → lệnh đi tiếp)."""
    heads = _glob_heads(tokens)
    if len(heads) > GLOB_MAX_HEADS or (heads and len(cmd) > REWRITE_MAX_CHARS):
        return "Lệnh quá phức tạp để guard quét hết (vượt ngân sách quét: nhiều tên lệnh glob — D-167): chia nhỏ lệnh."
    return _scan_scripts(_glob_rewrites(cmd, tokens, heads), root, cwd, depth, asks, 0, budget, rw)


def _glob_rewrites(cmd: str, tokens: List[str], heads: Dict[str, List[str]]) -> List[str]:
    """Bản viết lại CHUỖI LỆNH GỐC (giữ heredoc, `<(`, nháy, gán biến) cho MỖI tên nhạy cảm khớp mẫu glob của tên một lệnh
    đơn: mọi lần xuất hiện của từ đó thay cùng lúc. Quét như shell lồng — `bash_decision` đệ quy chịu ngân sách và
    `rewrites`, nên `/bin/[bcenx]* …` lồng nhiều tầng bị chặn thay vì quét mãi (D-162)."""
    out: List[str] = []
    for head, names in heads.items():
        word = re.compile(GLOB_WORD_BEFORE + re.escape(head) + GLOB_WORD_AFTER)
        if word.search(cmd):
            out += [word.sub(name, cmd) for name in names]  # tên từ danh sách đóng: không có `\`
        else:  # từ có đoạn nháy/`\` ở chuỗi gốc (`r?''`, `"/bin/"r?`): ghép lại từ token — mất heredoc nhưng không lọt
            out += [
                " ".join(t if _is_punct(t) else shlex.quote(name if t == head else t) for t in tokens) for name in names
            ]
    return out


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
    `depth` = độ sâu shell lồng (`sh -c`, heredoc/pipe vào shell) đang quét. Guard không phân định được cách bash đọc
    lệnh (`ScanTooComplex`) → chặn, không đoán. Thư mục mở bằng `<` trong chữ lệnh (cả lệnh lồng) cộng dồn vào `FD_DIRS`
    suốt lần quét (AUD-SEC-521)."""
    token = FD_DIRS.set(tuple(dict.fromkeys((*FD_DIRS.get(), *_fd_open_dirs(cmd)))))
    try:
        return _bash_decision(cmd, root, cwd, depth, budget, rewrites)
    except ScanTooComplex as e:
        reason = f"Lệnh quá phức tạp để guard quét hết ({e}): {clean_text(cmd)[:200]}{BUDGET_REWRITE}"
        out: Dict[str, object] = {
            "decision": "deny",
            "reason": reason,
            "commit": False,
            "no_verify": False,
            "commit_dir": "",
            "code": BUDGET,
        }
        out.update(getattr(e, "flags", {}))  # review #433 R1: giữ cờ bỏ hook (`no_verify`/`push_no_verify`) cho adapter
        return out
    finally:
        FD_DIRS.reset(token)


def _clean_strict(cmd: str, budget: ScanBudget) -> Tuple[str, bool]:
    """(`clean_text(cmd)`, có áp tập con chuẩn không — ADR-0063). Chữ lỏng giữ lỏng sau khi làm sạch để script con của
    nó cũng lỏng (`_nested_sources`)."""
    strict = cmd not in budget.loose
    extracted = cmd in budget.extracted
    cmd = clean_text(cmd)
    if not strict:
        budget.loose.add(cmd)
    if extracted:
        budget.extracted.add(cmd)
    return cmd, strict


def _nested_deny_result(res: Dict[str, object], reason: str, budget: ScanBudget) -> Dict[str, object]:
    """Lệnh lồng bị chặn → lệnh gốc chặn cùng lý do; lệnh lồng ngoài tập con đọc chắc (mã BUDGET) thì lệnh gốc cũng
    mang mã BUDGET (autonomy-bench phân loại theo mã)."""
    res.update(decision="deny", reason=reason)
    if budget.nested_deny == (reason, BUDGET):
        res["code"] = BUDGET
    return res


def _budget_track(
    budget: ScanBudget, cmd: str, commands: List[Tuple[List[str], Optional[str]]], root: str, cwd: Optional[str]
) -> Optional[FrozenSet[str]]:
    """Ghi vào ngân sách của quyết định (dùng chung với shell lồng) thư mục đã biết (AUD-SEC-449) và repo trần tạo trong
    chuỗi — kể cả ở tầng ngoài (`git init --bare X && sh -c 'printf x > X/config'`); trả repo trần đang chờ của lệnh."""
    budget.dirs.update({root, *(here for _, here in commands if here), *([cwd] if cwd else [])})
    # AUD-SEC-453/454: cả lệnh đơn (`sh -c 'git init --bare X'` lồng chỉ có một lệnh; `tee d/HEAD d/config`) — repo trần
    # tạo ở tầng trong được ghi vào ngân sách để tầng ngoài xét lại sau khi quét lồng (`_late_pending_asks`)
    pending = _pending_bare(cmd, commands)
    if budget.pending_bare is not None:
        broad = frozenset({""}) if _pending_bare_broad(cmd, commands) else frozenset()
        pending = budget.pending_bare | (pending or frozenset()) | broad
    budget.pending_bare = pending
    return pending


def _cwd_scan(
    placed: List[Tuple[List[str], Cands]], root: str, res: Dict[str, object], asks: List[str], dirs: FrozenSet[str]
) -> str:
    """Quét từng lệnh đơn (`_scan_command`) ở MỌI thư mục ứng viên của nó (D-347: hợp mọi đích `cd`); ứng viên đầu
    (nhánh mọi `cd` thành công) ghi cờ vào `res`, ứng viên khác quét với bản sao cờ — chặt nhất thắng. `git commit`
    có nhiều ứng viên: thư mục cổng chọn chặt (`_strict_commit_dir`)."""
    for argv, (here, *others) in placed:
        reason = _scan_command(argv, root, res, asks, here, dirs)
        commit_dirs = [str(res["commit_dir"])]
        for other in others:
            copy = dict(res)
            reason = reason or _scan_command(argv, root, copy, asks, other, dirs)
            commit_dirs.append(str(copy["commit_dir"]))
        if others and normalize(argv)[:2] == ["git", "commit"]:
            res["commit_dir"] = _strict_commit_dir(commit_dirs, root)
        if reason:
            return reason
    return ""


def _repo_top(path: str) -> str:
    """Gốc cây làm việc chứa `path` (thư mục có `.git` — thư mục hay gitfile — gần nhất đi lên, theo realpath); không
    có → ''."""
    d = _realpath_safe(path)
    while not os.path.lexists(os.path.join(d, ".git")):
        if posixpath.dirname(d) == d:
            return ""
        d = posixpath.dirname(d)
    return d


def _strict_commit_dir(dirs: List[str], root: str) -> str:
    """Thư mục cổng commit khi `git commit` có nhiều thư mục ứng viên (D-347): mọi ứng viên cùng một cây làm việc (hay
    cùng không thuộc cây nào) → ứng viên đầu; có ứng viên thuộc cây khác dự án → nó (hook hỏi người ở `strict`, như
    `cd ../khac && git commit`); còn lại (thư mục không biết, repo trần lẫn dự án) → '' như thư mục không biết."""
    tops = [_repo_top(d) if d else "" for d in dirs]
    if len(set(tops)) == 1:
        return dirs[0]
    own = _repo_top(root)
    return next((d for d, t in zip(dirs, tops) if t and t != own), "")


def _late_pending_asks(
    cmd: str,
    tokens: List[str],
    commands: List[Tuple[List[str], Optional[str]]],
    root: str,
    cwd: Optional[str],
    before: Optional[FrozenSet[str]],
    budget: ScanBudget,
) -> List[str]:
    """AUD-SEC-453: repo trần tạo trong shell lồng (`sh -c 'git init --bare X' && printf x > X/config`) chỉ biết sau khi
    quét lồng — xét lại đích ghi của tầng này với tập đang chờ mới (chiều ngược của AUD-SEC-449)."""
    late = budget.pending_bare
    if not late or late == before:
        return []
    late = late | (frozenset({""}) if _pending_bare_broad(cmd, commands) else frozenset())
    return interp_write_asks(cmd, tokens, root, cwd, late) + _pending_git_write_asks(commands, late)


def _bash_decision(
    cmd: str, root: str, cwd: Optional[str], depth: int, budget: Optional[ScanBudget], rewrites: int
) -> Dict[str, object]:
    whole = budget is None and depth == 0  # lệnh agent gửi nguyên vẹn (không phải mảnh/lệnh lồng guard cắt ra)
    if budget is None:  # lời gọi gốc: không có `cwd` = gốc dự án; lệnh lồng nhận None = thư mục không biết (D-106)
        cwd = cwd or root
    budget = budget or ScanBudget(nested=depth > 0)
    cmd, strict = _clean_strict(cmd, budget)
    res: Dict[str, object] = {"decision": "", "reason": "", "commit": False, "no_verify": False, "commit_dir": ""}
    if budget.exhausted() or len(cmd) > CMD_MAX_CHARS:
        res.update(
            decision="deny",
            reason=f"Lệnh quá phức tạp để guard quét hết (vượt ngân sách quét): {cmd[:200]}",
            code=BUDGET,
        )
        return res
    _shell_precheck(cmd, strict, cwd)
    _heredoc_precheck(cmd, whole)
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
    placed = _commands_with_cwds(tokens, cwd)
    commands = [(argv, cands[0]) for argv, cands in placed]
    every = [(argv, d) for argv, cands in placed for d in cands]  # luật theo thư mục xét ĐỦ mọi ứng viên (D-347)
    pending_bare = _budget_track(budget, cmd, every, root, cwd)
    asks: List[str] = interp_write_asks(cmd, tokens, root, cwd, pending_bare)
    asks += _pending_git_write_asks(every, pending_bare)
    asks += [REVIEW_FORGE_WHY] if _review_forge_hit(cmd, tokens, cwd, budget) else []
    simple = split_commands(tokens)
    single = whole and len(simple) == 1  # dạng chữ rõ của ADR-0069 chỉ khi cả lệnh là một lệnh đơn (review harden F1)
    asks += [STAGE_APPROVE_WHY] if any(_stage_approve_denied(c, root, cwd, single) for c in simple) else []
    braces = brace_variants(cmd)
    nested_deny = (
        "Lệnh quá phức tạp để guard quét hết (brace expansion quá nhiều biến thể): chia nhỏ lệnh."
        if braces is None
        else _scan_scripts(braces, root, cwd, depth, asks, 0, budget, rewrites)
    ) or _scan_nested(cmd, tokens, root, cwd, depth, asks, budget, rewrites, _cwd_picks(placed))
    nested_deny = nested_deny or _scan_glob_rewrites(cmd, tokens, root, cwd, depth, asks, budget, rewrites)
    if nested_deny:
        return _nested_deny_result(res, nested_deny, budget)
    asks += _late_pending_asks(cmd, tokens, every, root, cwd, pending_bare, budget)
    asks += _git_config_env_asks(tokens, every, root)
    dirs = frozenset(budget.dirs)
    deny_reason = _cwd_scan(placed, root, res, asks, dirs)
    res.pop("exported_env", None)
    _carry_push_no_verify(res, budget)
    deny_reason = deny_reason or find_root_scan(cmd, root, cwd) or _commit_after_write(commands)
    deny_reason = deny_reason or (
        ai_attribution(cmd, every, root) or title_rule(cmd, every, root)
        if res["commit"] or GH_PR_TEXT_RE.search(cmd)
        else ""
    )
    if deny_reason:
        res.update(decision="deny", reason=deny_reason)
        return res
    res.pop("exported", None)
    _argv_shell_check(cmd, tokens, strict, asks, res, root, cwd)
    asks += xt_inproc_asks(cmd, tokens, cwd)  # sau tập con chuẩn: lệnh ngoài tập con giữ mã BUDGET (AUD-SEC-406/415)
    allow = res.pop("allow", "")
    # `allow` bỏ hỏi cho CẢ lệnh Bash → chỉ khi merge đứng một mình và trơn (không gì shell còn mở rộng/chạy thêm).
    if allow and (len(commands) > 1 or not PLAIN_MERGE_RE.fullmatch(cmd.strip())):
        asks.append(f"{EXTERNAL_ASK} — tự merge chỉ khi lệnh đứng một mình")
    if asks:
        res.update(decision="ask", reason=ASK_PREFIX + "; ".join(dict.fromkeys(asks)))
    elif allow:
        res.update(decision="allow", reason=f"Khung cho tự merge (ADR-0013) — {allow}")
    return res


# Chính sách đầu ra (ADR-0018): chỉ CẤM lệnh nguy hiểm/không đảo ngược; `XT_GUARD_POLICY=strict` hỏi. Mỗi kết quả mang
# MÃ (REC-04, đặt ở nơi sinh hoặc suy từ `REASON_CODES`); `apply_policy` ánh xạ qua `POLICY`. Lớp chặn sai lầm, không
# phải ranh giới cách ly (D-015).
OTHER_ASK = "OTHER_ASK"  # ask không nguy hiểm → cho qua (mặc định)
RULE_DENY = "RULE_DENY"  # deny của bộ luật chưa có mã riêng
NO_OBJECTION = "NONE"  # guard không phản đối
RULE_ALLOW = "RULE_ALLOW"  # allow rõ ràng (merge đã qua merge-check)
UNPARSED = "UNPARSED"  # guard lỗi giữa chừng với hành động phải kiểm
BUDGET = "BUDGET"
# Lý do BUDGET kèm cách viết lại (AUD-HAR-199): agent bị chặn biết dạng nào guard đọc chắc thay vì thử lách (LOOP-STOP-025).
BUDGET_REWRITE = (
    " — viết lại: tách thành nhiều lệnh đơn; không lồng shell/heredoc có mở rộng; nội dung dài → ghi file bằng công cụ "
    "Write rồi chạy file"
)
# Nhật ký quyết định của hook cho `xt.py loop stats` (AUD-HAR-199): chỉ ghi khi dự án có `.autopilot/` (vòng autopilot).
GUARD_LOG = "guard-log.jsonl"
LOGGED_MODES = ("bash", "edit", "mcp")


def _log_decision(mode: str, payload: Any, out: Dict[str, object], root: str) -> None:
    """Nối `{ts, session, mode, decision, code}` vào `.autopilot/guard-log.jsonl`. Không có `.autopilot/` → không ghi;
    lỗi ghi bỏ qua — đếm không được đổi quyết định hay làm kẹt hook (fail-open về luồng, ADR-0002)."""
    d = os.path.join(root, ".autopilot")
    if mode not in LOGGED_MODES or not os.path.isdir(d):
        return
    session = payload.get("session_id") if isinstance(payload, dict) else None
    rec = {
        "ts": int(time.time()),
        "session": str(session or "")[:80],
        "mode": mode,
        "decision": str(out.get("decision") or ""),
        "code": str(out.get("code") or ""),
    }
    with contextlib.suppress(OSError), open(os.path.join(d, GUARD_LOG), "a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")


BRACE_OVERFLOW = "BRACE_OVERFLOW"
NEST_TOO_DEEP = "NEST_TOO_DEEP"
UNRESOLVED_TARGET = "UNRESOLVED_TARGET"  # đích của hành động không đảo ngược guard không giải được (T-1523)
# (dấu trong lý do, mã) — thứ tự: dấu cụ thể trước dấu chung ("bằng chứng review" trước "tay bằng chứng").
REASON_CODES: Tuple[Tuple[str, str], ...] = (
    ("push thẳng nhánh chính", "PUSH_MAIN"),
    ("push --all/--tags", "PUSH_ALL"),
    ("xoá đệ quy ngoài thư mục dự án", "WIPE_OUTSIDE"),
    ("xoá đệ quy gốc dự án", "WIPE_OUTSIDE"),
    ("bắt đầu từ gốc dự án bị chặn", "WIPE_OUTSIDE"),
    ("rm -rf không có đích", "WIPE_OUTSIDE"),
    ("find xoá file ngoài thư mục dự án", "WIPE_OUTSIDE"),
    ("xoá thư mục gắn từ máy", "WIPE_OUTSIDE"),
    ("xoá thay đổi đã cất", "STASH_DROP"),
    (DESTROY_ASK, "DESTROY"),
    (AUTO_MERGE_WHY, "AUTO_MERGE_ENABLE"),  # bật auto-merge: deny phẳng ở mọi chính sách (ADR-0036)
    ("--admin vượt ruleset nhánh", "MERGE_ADMIN"),
    (HARD_ASK, "HARD_EXCEPTION"),
    (UNVERIFIED_ASK, "UNVERIFIED"),
    (REVIEW_MISSING_ASK, "REVIEW_MISSING"),
    ("container có quyền máy chủ", "HOST_CONTAINER"),
    ("tắt hook của khung", "HOOK_BYPASS"),
    ("bỏ qua hook của dự án", "HOOK_BYPASS"),
    ("ghi file bí mật qua Bash", "SECRET_WRITE"),
    ("bằng chứng review", "REVIEW_FORGE"),
    ("duyệt giai đoạn sản phẩm", "STAGE_APPROVE"),  # chỉ người duyệt giai đoạn (ADR-0058; agent khi ADR-0069)
    ("tay bằng chứng", "EVIDENCE_HANDWRITE"),  # ghi/xoá tay `.autopilot/` = bằng chứng giả (ADR-0026)
    ("lệnh đã mã hoá/nén", "OPAQUE_EXEC"),  # `… | base64 -d | sh` từ nguồn guard không giải được
    (BASH_ENV_MARK, "OPAQUE_EXEC"),  # `BASH_ENV=f bash -c true`: bash nạp file guard không đọc (AUD-SEC-250)
    (NEST_ASK, NEST_TOO_DEEP),  # lớp lồng không quét được có thể chứa bất kỳ lệnh nào (AUD-SEC-063)
    (UNRESOLVED_PUSH_WHY, UNRESOLVED_TARGET),  # `xargs git push`, `git push origin $(…)` (T-1523)
    (UNRESOLVED_REF_MARK, UNRESOLVED_TARGET),  # `git update-ref --stdin` (AUD-SEC-119)
    (UNRESOLVED_ALIAS_MARK, UNRESOLVED_TARGET),  # alias git đọc lỗi/là biến/vòng (AUD-SEC-119, review T-3563)
    (UNKNOWN_GIT_OPT_MARK, UNRESOLVED_TARGET),  # `git --<lạ> v push …`: không biết lệnh con (D-216)
    (PARALLEL_UNSEEN_MARK, UNRESOLVED_TARGET),  # `parallel --arg-s ,, ,, x`: không biết dấu tách (AUD-SEC-121)
    (REMOTE_REF_MARK, "REMOTE_REF_FORGE"),  # giả `origin/main` mà Gate đọc (AUD-SEC-119, T-3563)
    (PERM_NO_TARGET_WHY, UNRESOLVED_TARGET),  # `… | xargs chmod 000` (T-3532)
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


PERMISSION_MODES = {"Bash": "bash", "Edit": "edit", "Write": "edit", "MultiEdit": "edit", "NotebookEdit": "edit"}


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
        path = tool_input.get("file_path") or tool_input.get("notebook_path")  # NotebookEdit (AUD-HAR-036)
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


# ADR-0064 lát A: schema trung lập cho adapter của công cụ khác — `tool` → chế độ của bộ luật.
# Tên tool (chữ thường) của Claude Code và các host (research 2026-11-02 §8, adapter lát B) → chế độ (AUD-SEC-346).
CORE_MODES = {
    **dict.fromkeys(("bash", "shell", "run_shell_command", "run_terminal_command", "exec_command"), "bash"),
    **dict.fromkeys(("edit", "write", "multiedit", "notebookedit", "write_file", "replace", "create"), "edit"),
    "mcp": "mcp",
}
CORE_ACTION_KEYS = ("command", "path", "tool_name")


def _core_decision(raw: Any) -> Dict[str, object]:
    """`{tool, command|path|tool_name, input, cwd, project_dir}` (ADR-0064) → quyết định của bộ luật. Không phải object →
    không có gì để chặn (stdin rác, LOOP-HARNESS-018); có lệnh/đường/tool mà không suy ra chế độ, hay `command` không phải
    chuỗi → deny UNPARSED — adapter truyền sai tên tool không được thành cho qua im lặng (AUD-SEC-346). Gốc dự án:
    `project_dir` tuyệt đối → `CLAUDE_PROJECT_DIR` → cwd (AUD-HAR-201: host khác Claude không đặt biến đó)."""
    if not isinstance(raw, dict):
        return {"decision": ""}
    tool = str(raw.get("tool") or "").strip().lower()
    mode, cmd = CORE_MODES.get(tool, ""), raw.get("command")
    if (cmd is not None and not isinstance(cmd, str)) or (not mode and any(raw.get(k) for k in CORE_ACTION_KEYS)):
        why = f"core: không suy ra chế độ guard cho tool {tool!r} hay `command` không phải chuỗi — adapter gửi tool bash|edit|mcp"
        return {"decision": "deny", "code": UNPARSED, "reason": why + " (AUD-SEC-346)"}
    tool_input = dict(raw["input"]) if isinstance(raw.get("input"), dict) else {}
    tool_input.setdefault("command", cmd)
    tool_input.setdefault("file_path", raw.get("path"))
    pd = raw.get("project_dir")
    root = pd if isinstance(pd, str) and os.path.isabs(pd) else os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return _rule_decision(
        mode, {"tool_name": raw.get("tool_name"), "tool_input": tool_input, "cwd": raw.get("cwd")}, root
    )


def _core_output(out: Dict[str, object]) -> int:
    """Đầu ra `core`: JSON `{decision: allow|deny, code, reason}` đã qua chính sách mặc định (không `ask` — Codex/Cursor không
    cưỡng chế `ask`); deny → exit 2 (công cụ đọc exit chặn được) và lý do ở stderr."""
    out = apply_policy(out)
    deny = out.get("decision") == "deny"
    doc = {"decision": "deny" if deny else "allow", "code": out.get("code"), "reason": out.get("reason") or ""}
    sys.stdout.write(json.dumps(doc, ensure_ascii=False))
    if deny:
        sys.stderr.write(str(doc["reason"]) + "\n")
    return 2 if deny else 0


def main() -> int:
    """`guard.py bash|edit|mcp [nul]` cho PreToolUse; `guard.py permission` cho PermissionRequest (chế độ suy từ
    `tool_name`; in JSON của hook hoặc không in gì); `guard.py core` cho adapter trung lập (ADR-0064); `guard.py
    commit-msg <file>` cho git hook `commit-msg` (sàn ADR-0064 lát C)."""
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "commit-msg":  # git hook `commit-msg <file>` (ADR-0064 lát C): exit 1 + lý do ở stderr khi chặn
        why = commit_msg_problem(sys.argv[2] if len(sys.argv) > 2 else "", os.getcwd())
        sys.stderr.write(f"✗ {why}\n" if why else "")
        return 1 if why else 0
    payload: Any = None
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if mode == "core":
            out = _core_decision(payload)
        else:
            if mode == "permission":
                mode = permission_mode(payload.get("tool_name"))
            out = _rule_decision(mode, payload, os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    except Exception:  # fail-open về luồng: lỗi của hook không được kẹt phiên — trừ merge (AUD-SEC-032)
        out = _failure_decision(mode, payload, _payload_cmd(payload))
    if sys.argv[1:2] == ["core"]:
        return _core_output(out)
    # strict = hành vi cũ (hỏi): chỉ chặt hơn, không phải công tắc tắt hook.
    if os.environ.get("XT_GUARD_POLICY") != "strict":
        out = apply_policy(out)
    if sys.argv[1:2] != ["permission"]:  # PermissionRequest lặp lại quyết định PreToolUse — đếm một lần
        _log_decision(mode, payload, out, os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    if sys.argv[1:2] == ["permission"]:
        sys.stdout.write(permission_output(out))
    elif sys.argv[2:3] == ["nul"]:
        sys.stdout.write("".join(f"{v}\0" for v in ["ok", *(_sh_field(out.get(k)) for k in NUL_FIELDS)]))
    else:
        sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
