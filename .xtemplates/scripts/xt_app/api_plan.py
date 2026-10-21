"""`GET /api/plans`, `GET /api/plan` — PLAN của dự án (SPEC-app §3, màn F-005).

Đếm, đợt song song, giao file, chu trình, ghi chú hỏng và việc defer đều lấy từ hàm của CLI qua `ctx.xt`
(`parse_plan`, `plan_waves`, `plan_ready`, `plan_overlaps`, …): cùng một nguồn với `xt.py plan waves --json`.
Không khai `SMOKE`: không có PLAN nào vẫn trả 200 rỗng, nên smoke không cần query mẫu.
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Tuple, cast

from xt_app.server import Ctx, Routes

PLAN_DIR = "docs/autopilot"
DEFAULT_PLAN = f"{PLAN_DIR}/PLAN.md"
DEFAULT_MAX = 5
TASK_KEYS = ("id", "state", "title", "gate", "after", "files", "tier")

Reply = Tuple[int, Dict[str, Any]]


def _rel_md(raw: str) -> Optional[str]:
    """POSIX tương đối, không `..`, đuôi `.md`; sai → None."""
    if not raw or "\\" in raw or "\x00" in raw:
        return None
    p = PurePosixPath(raw)
    if p.is_absolute() or ".." in p.parts or p.suffix != ".md":
        return None
    return p.as_posix()


def _inside(base: Path, rel: str) -> bool:
    return (base / rel).resolve().is_relative_to(base.resolve())


def _state(ctx: Ctx) -> Dict[str, Any]:
    st = ctx.xt.read_state(ctx.base)
    return cast(Dict[str, Any], st) if isinstance(st, dict) else {}


def _active_plan(st: Dict[str, Any]) -> Optional[str]:
    raw = st.get("plan")
    return _rel_md(raw) if isinstance(raw, str) else None


def _counts(tasks: List[Dict[str, Any]]) -> Dict[str, int]:
    states = [t["state"] for t in tasks]
    return {"open": states.count(" "), "done": states.count("x"), "dropped": states.count("~")}


def _plans(ctx: Ctx) -> Reply:
    active = _active_plan(_state(ctx))
    plans: List[Dict[str, Any]] = []
    for f in sorted((ctx.base / PLAN_DIR).glob("PLAN*.md"), key=lambda p: p.name):
        rel = f"{PLAN_DIR}/{f.name}"
        if not f.is_file() or not _inside(ctx.base, rel):
            continue
        try:
            tasks = ctx.xt.parse_plan(f)
        except (OSError, UnicodeDecodeError):
            continue
        plans.append({"path": rel, **_counts(tasks), "active": rel == active})
    return 200, {"plans": plans}


def _max_parallel(ctx: Ctx) -> Optional[int]:
    raw = (ctx.query.get("max") or [str(DEFAULT_MAX)])[0]
    if not raw.isascii() or not raw.isdigit():
        return None
    n = int(raw)
    return n if 1 <= n <= 10 else None


def _default_path(ctx: Ctx, st: Dict[str, Any]) -> Optional[str]:
    """PLAN của vòng, rồi `docs/autopilot/PLAN.md`; không có file nào → None."""
    for rel in (_active_plan(st), DEFAULT_PLAN):
        if rel and _inside(ctx.base, rel) and (ctx.base / rel).is_file():
            return rel
    return None


def _sections(tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    index: Dict[Optional[str], Dict[str, Any]] = {}
    for t in tasks:
        sec = index.get(t["section"])
        if sec is None:
            sec = {"title": t["section"], "tasks": []}
            index[t["section"]] = sec
            out.append(sec)
        sec["tasks"].append({k: t[k] for k in TASK_KEYS})
    return out


def _deferred(ctx: Ctx, st: Dict[str, Any]) -> Dict[str, str]:
    raw = ctx.xt._deferred(st)
    return {k: str(v.get("reason", "") if isinstance(v, dict) else v) for k, v in raw.items()}


def _body(ctx: Ctx, rel: Optional[str], tasks: List[Dict[str, Any]], st: Dict[str, Any], mx: int) -> Dict[str, Any]:
    x = ctx.xt
    deferred = x._deferred(st)
    waves = x.plan_waves(tasks, deferred, mx)
    return {
        "path": rel,
        "sections": _sections(tasks),
        "waves": waves["waves"],
        "blocked": waves["blocked"],
        "overlaps": x.plan_overlaps(x.plan_ready(tasks, deferred)),
        "cycles": x.plan_cycle_nodes(tasks),
        "unknown_after": x.plan_unknown_after(tasks),
        "bad_links": x.plan_bad_links(tasks),
        "deferred": _deferred(ctx, st),
    }


def _plan(ctx: Ctx) -> Reply:
    mx = _max_parallel(ctx)
    if mx is None:
        return 400, {"error": "`max` phải là số nguyên từ 1 đến 10"}
    st = _state(ctx)
    raw = ctx.query.get("path")
    if raw:
        rel = _rel_md(raw[0])
        if rel is None or not _inside(ctx.base, rel):
            return 400, {"error": "`path` phải là đường dẫn .md tương đối trong dự án, không có `..`"}
    else:
        rel = _default_path(ctx, st)
        if rel is None:
            return 200, _body(ctx, None, [], st, mx)
    target = ctx.base / rel
    try:
        tasks = ctx.xt.parse_plan(target) if target.is_file() else None
    except (OSError, UnicodeDecodeError):
        tasks = None
    if tasks is None:
        return 404, {"error": f"Không thấy PLAN: {rel}"}
    return 200, _body(ctx, rel, tasks, st, mx)


ROUTES: Routes = {("GET", "/api/plans"): _plans, ("GET", "/api/plan"): _plan}
