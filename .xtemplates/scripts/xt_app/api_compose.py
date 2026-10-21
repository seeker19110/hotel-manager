"""Màn Ghép blueprint: `GET /api/compose/options`, `GET /api/compose`, `POST /api/blueprint` (SPEC-app §3, T-1931).

Một nguồn sự thật với CLI: danh sách lấy từ `xt.load_docs` theo cùng nhóm `kind` như `xt.py list`, fact từ
`xt.FEATURE_FACTS`; xem trước bằng `xt.compose_split` (mặc định của `compose`, không `--full`, không `--include-may`);
ghi bằng `xt.compose_write` — đúng đường của `compose --out` (giữ tick/miễn trừ theo ID, ghi nguyên tử).
"""

from __future__ import annotations

import threading
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Tuple, cast

from xt_app.server import Ctx, Routes

MAX_MARKDOWN = 512 * 1024
DEFAULT_OUT = "BLUEPRINT.md"
LIST_KEYS = ("industry", "add", "feature")
BODY_KEYS = frozenset({"profile", "scale", "out", *LIST_KEYS})
# Cùng nhóm với `xt.py list profiles|industries|modules` (cmd_list).
MODULE_KINDS = ("module", "baseline", "standard")

Reply = Tuple[int, Dict[str, Any]]
Params = Tuple[str, str, List[str], List[str], List[str]]

# Hai lần ghi đồng thời cùng file: đọc bản cũ → ghép → ghi phải tuần tự, không thì lần sau làm mất tick của lần trước.
_WRITE_LOCK = threading.Lock()


def _bad(message: str) -> Reply:
    return 400, {"error": message}


def _options(ctx: Ctx) -> Reply:
    docs = sorted(ctx.xt.load_docs(ctx.framework)[0], key=lambda d: str(d.rel))

    def by_kind(kind: str) -> List[Dict[str, str]]:
        return [{"slug": str(d.meta.get("slug")), "title": str(d.title)} for d in docs if d.kind == kind]

    return 200, {
        "profiles": by_kind("profile"),
        "industries": by_kind("industry"),
        "modules": [str(d.rel) for d in docs if d.kind in MODULE_KINDS],
        "features": [str(f) for f in ctx.xt.FEATURE_FACTS],
        "scales": [str(s) for s in ctx.xt.SCALES],
    }


def _check_params(ctx: Ctx, profile: Any, scale: Any, lists: Dict[str, Any]) -> Optional[str]:
    if not isinstance(profile, str) or not profile:
        return "thiếu hồ sơ (profile)"
    if scale not in ctx.xt.SCALES:
        return f"quy mô phải là một trong {', '.join(ctx.xt.SCALES)}"
    for key, val in lists.items():
        if not isinstance(val, list) or not all(isinstance(v, str) for v in val):
            return f"{key} phải là danh sách chuỗi"
    return None


def _query_params(ctx: Ctx) -> Tuple[Optional[str], Params]:
    q = ctx.query
    profile, scale = q.get("profile", []), q.get("scale", [])
    lists = {k: q.get(k, []) for k in LIST_KEYS}
    if len(profile) != 1 or len(scale) != 1:
        return "cần đúng một profile và một scale", ("", "", [], [], [])
    err = _check_params(ctx, profile[0], scale[0], lists)
    return err, (profile[0], scale[0], lists["industry"], lists["add"], lists["feature"])


def _count_levels(ctx: Ctx, *texts: str) -> Dict[str, int]:
    counts = {lv: 0 for lv in ctx.xt.LEVELS}
    for text in texts:
        for line in text.splitlines():
            m = ctx.xt.ITEM_RE.match(line)
            if m:
                counts[m["level"]] += 1
    return counts


def _truncate(text: str) -> Tuple[str, bool]:
    raw = text.encode("utf-8")
    if len(raw) <= MAX_MARKDOWN:
        return text, False
    return raw[:MAX_MARKDOWN].decode("utf-8", errors="ignore"), True


def _compose(ctx: Ctx) -> Reply:
    err, (profile, scale, industries, extra, features) = _query_params(ctx)
    if err is not None:
        return _bad(err)
    promoted: List[str] = []
    try:
        main, backlog = ctx.xt.compose_split(
            ctx.framework, profile, industries, scale, False, extra=extra, features=features, promoted=promoted
        )
    except (SystemExit, ValueError, KeyError) as exc:
        return _bad(str(exc))
    markdown, truncated = _truncate(cast(str, main))
    return 200, {
        "counts": _count_levels(ctx, main, backlog),
        "markdown": markdown,
        "truncated": truncated,
        "promoted": [str(i) for i in promoted],
    }


def _out_path(ctx: Ctx, out: Any) -> Optional[Path]:
    """Đường ghi trong dự án: chuỗi POSIX tương đối, đuôi `.md`, không `..`/thành phần ẩn/`\\`; sau resolve nằm trong
    `ctx.base`; file chính và backlog không là symlink hay thư mục. Sai → None."""
    if not isinstance(out, str) or not out.endswith(".md") or "\\" in out or "\x00" in out:
        return None
    rel = PurePosixPath(out)
    if rel.is_absolute() or any(part.startswith(".") for part in rel.parts):
        return None
    base = ctx.base.resolve()
    target = (base / rel).resolve()
    if base not in target.parents:
        return None
    backlog = cast(Path, ctx.xt._backlog_path(target))
    if any(p.is_symlink() or p.is_dir() for p in (base / rel, target, backlog)):
        return None
    return target


def _blueprint(ctx: Ctx) -> Reply:
    body = ctx.body or {}
    unknown = sorted(set(body) - BODY_KEYS)
    if unknown:
        return _bad("tham số lạ: " + ", ".join(unknown))
    lists = {k: body.get(k, []) for k in LIST_KEYS}
    err = _check_params(ctx, body.get("profile"), body.get("scale"), lists)
    if err is not None:
        return _bad(err)
    target = _out_path(ctx, body.get("out", DEFAULT_OUT))
    if target is None:
        return _bad("out phải là đường tương đối .md trong dự án (không .., không file ẩn, không symlink)")
    base = ctx.base.resolve()
    try:
        with _WRITE_LOCK:
            res = ctx.xt.compose_write(
                ctx.framework,
                body["profile"],
                lists["industry"],
                body["scale"],
                False,
                target,
                extra=lists["add"],
                features=lists["feature"],
                quiet=True,
            )
    except (SystemExit, ValueError, KeyError) as exc:
        return _bad(str(exc))
    return 200, {
        "written": [Path(p).relative_to(base).as_posix() for p in res["written"]],
        "kept": int(res["kept"]),
        "dropped": int(res["dropped"]),
        "stale": int(res["stale"]),
    }


ROUTES: Routes = {
    ("GET", "/api/compose/options"): _options,
    ("GET", "/api/compose"): _compose,
    ("POST", "/api/blueprint"): _blueprint,
}

SMOKE = {"/api/compose": "profile=cli-tool&scale=S"}
