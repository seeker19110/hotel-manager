"""`GET /api/overview` — số liệu màn Tổng quan (SPEC-app §3): verdict vòng, MUST đạt/tổng, task mở, việc chờ người."""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from xt_app.server import Ctx, Routes, _read_version

DEFAULT_PLAN = "docs/autopilot/PLAN.md"


def _blueprint(ctx: Ctx) -> Optional[Dict[str, int]]:
    """MUST đạt/tổng theo cách `blueprint status` in (đạt = `done`; tổng = đạt + miễn + chưa); file hỏng → None."""
    path = ctx.base / "BLUEPRINT.md"
    if not path.is_file():
        return None
    try:
        must = ctx.xt.blueprint_status(path)["levels"]["MUST"]
        done = int(must["done"])
        return {"must_done": done, "must_total": done + int(must["waived"]) + int(must["open"])}
    except (OSError, ValueError, KeyError, TypeError):  # UnicodeDecodeError là ValueError
        return None


def _plan_file(ctx: Ctx, state: Dict[str, Any]) -> Optional[str]:
    """Đường PLAN (POSIX, tương đối `base`): PLAN của vòng nếu là file nằm trong dự án, không thì PLAN mặc định, không có → None."""
    root = ctx.base.resolve()
    rel = state.get("plan")
    for cand in (rel if isinstance(rel, str) else "", DEFAULT_PLAN):
        full = (root / cand).resolve() if cand else root
        if cand and full.is_file() and full.is_relative_to(root):
            return full.relative_to(root).as_posix()
    return None


def _plan(ctx: Ctx, state: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    rel = _plan_file(ctx, state)
    if rel is None:
        return None
    try:
        tasks = ctx.xt.parse_plan(ctx.base / rel)
    except (OSError, ValueError):
        return None
    return {"path": rel, "open": sum(1 for t in tasks if t["state"] == " ")}


def _verdict(ctx: Ctx) -> Dict[str, str]:
    """`loop_verdict`; state/PLAN hỏng làm nó ném → "blocked" kèm lý do (màn Tổng quan không được 500 vì dữ liệu hỏng)."""
    try:
        v = ctx.xt.loop_verdict(ctx.base)
        return {"verdict": str(v["verdict"]), "reason": str(v["reason"])}
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        return {"verdict": "blocked", "reason": f"không đọc được trạng thái vòng: {type(e).__name__}"}


def _overview(ctx: Ctx) -> Tuple[int, Dict[str, Any]]:
    state = ctx.xt.read_state(ctx.base) or {}
    return 200, {
        "project": ctx.base.name,
        "version": _read_version(ctx),
        "loop": _verdict(ctx),
        "blueprint": _blueprint(ctx),
        "plan": _plan(ctx, state),
        "pending_human": len(ctx.xt._deferred(state)),
    }


ROUTES: Routes = {("GET", "/api/overview"): _overview}
