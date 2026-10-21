"""`GET /api/blueprint` — tiến độ BLUEPRINT.md (SPEC-app §3, màn F-004).

Đếm theo mức và `bad_lines` lấy nguyên từ `xt.blueprint_status`; phần theo module chỉ đọc lại cùng file bằng
`xt.ITEM_RE` và heading `## `…`###### ` (module = heading gần nhất phía trên mục), không có parser riêng.
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Tuple, cast

from xt_app.server import Ctx, Routes

DEFAULT_PATH = "BLUEPRINT.md"
MAX_OPEN = 200
MAX_TEXT = 300
NO_MODULE = "(chưa có module)"
HEADING_RE = re.compile(r"^#{2,6}[ \t]+(\S.*?)[ \t]*#*[ \t]*$")

Reply = Tuple[int, Dict[str, Any]]


def _bad(message: str) -> Reply:
    return 400, {"error": message}


def _rel_path(ctx: Ctx) -> Optional[str]:
    """`path` từ query: POSIX tương đối, không `..`, đuôi `.md`; sai → None."""
    raw = (ctx.query.get("path") or [DEFAULT_PATH])[0]
    if not raw or "\\" in raw or "\x00" in raw:
        return None
    p = PurePosixPath(raw)
    if p.is_absolute() or ".." in p.parts or p.suffix != ".md":
        return None
    return p.as_posix()


def _inside(base: Path, target: Path) -> bool:
    return target.resolve().is_relative_to(base.resolve())


def _scan(ctx: Ctx, files: List[Path]) -> Tuple[Dict[str, List[int]], List[Dict[str, str]]]:
    """Một lượt qua blueprint + backlog: đếm theo module [must_done, must_total, should_done, should_total] và mục MUST mở.
    `~` (miễn/không áp dụng) tính là đã giải quyết — khớp tiêu chí `--strict` (không còn `[ ]`)."""
    item_re = ctx.xt.ITEM_RE
    modules: Dict[str, List[int]] = {}
    opened: List[Dict[str, str]] = []
    for f in files:
        try:
            raw = f.read_text(encoding="utf-8")
        except OSError:  # backlog khai mà thiếu: đã có ở bad_lines của blueprint_status
            continue
        module = NO_MODULE
        for line in unicodedata.normalize("NFC", raw).splitlines():
            h = HEADING_RE.match(line)
            if h:
                module = h[1]
                continue
            m = item_re.match(line)
            if not m or m["level"] == "MAY":
                continue
            row = modules.setdefault(module, [0, 0, 0, 0])
            k = 0 if m["level"] == "MUST" else 2
            row[k + 1] += 1
            if m["state"] != " ":
                row[k] += 1
            elif k == 0:
                opened.append({"id": m["id"], "module": module, "text": m["text"][:MAX_TEXT]})
    return modules, opened


def _check_cmd(ctx: Ctx, rel: str) -> str:
    tool = "scripts/xt.py" if (ctx.base / "scripts" / "xt.py").is_file() else ".xtemplates/scripts/xt.py"
    return f"python3 {tool} blueprint-status {rel} --strict"


def _blueprint(ctx: Ctx) -> Reply:
    rel = _rel_path(ctx)
    if rel is None:
        return _bad("path phải là đường dẫn tương đối trong dự án, đuôi .md, không chứa '..'")
    target = ctx.base / rel
    if not _inside(ctx.base, target):
        return _bad("path nằm ngoài dự án")
    if not target.is_file():
        if "path" not in ctx.query:  # mặc định chưa có (dự án mới cài): 200 rỗng như /api/plan, smoke không đỏ
            return 200, {
                "path": None,
                "levels": None,
                "modules": [],
                "open_must": [],
                "truncated": False,
                "bad_lines": [],
                "check_cmd": None,
            }
        return 404, {"error": f"không có file {rel}"}
    try:
        files = cast("List[Path]", ctx.xt.blueprint_files(target))
        if not all(_inside(ctx.base, f) for f in files):
            return _bad("backlog khai ở frontmatter nằm ngoài dự án")
        status = ctx.xt.blueprint_status(target)
        modules, opened = _scan(ctx, files)
    except (OSError, UnicodeDecodeError):
        return _bad(f"không đọc được {rel} (cần UTF-8)")
    return 200, {
        "path": rel,
        "levels": status["levels"],
        "modules": [
            {"module": k, "must_done": v[0], "must_total": v[1], "should_done": v[2], "should_total": v[3]}
            for k, v in modules.items()
        ],
        "open_must": opened[:MAX_OPEN],
        "truncated": len(opened) > MAX_OPEN,
        "bad_lines": status["bad_lines"],
        "check_cmd": _check_cmd(ctx, rel),
    }


ROUTES: Routes = {("GET", "/api/blueprint"): _blueprint}
