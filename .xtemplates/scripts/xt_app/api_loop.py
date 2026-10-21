"""Màn Vòng tự động (SPEC-app §3): `GET /api/loop`, `GET /api/decisions?q=`, `GET /api/adrs`."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from xt_app.api_overview import _verdict
from xt_app.server import Ctx, Routes

DECISIONS_FILE = "docs/autopilot/DECISIONS.md"
ADR_DIR = "docs/adr"
MAX_DECISIONS = 200
_HEAD_RE = re.compile(r"^### (D-\d{3,}) · (\S+) · (.*)$")
_OPT_SPLIT_RE = re.compile(r" · \(\d+\) ")
_OPT_FIRST_RE = re.compile(r"^\(1\) ")
_FIELDS = (
    ("- Phương án:", "options"),
    ("- Chọn:", "choice"),
    ("- Lý do (tiêu chí chất lượng cuối):", "why"),
    ("- Đường lùi:", "revert"),
)
_ADR_FILE_RE = re.compile(r"^(\d{4})-.*\.md$")
_ADR_TITLE_RE = re.compile(r"^# ADR-\d+:\s*(.*?)\s*$")
_ADR_STATUS = "- **Trạng thái:**"
_XT_ERRORS = (OSError, ValueError, KeyError, TypeError, AttributeError)


def _stats(ctx: Ctx) -> Optional[Dict[str, Any]]:
    """`loop stats`; lỗi hoặc chưa có lần chạy Gate nào → None."""
    try:
        s = ctx.xt.loop_stats(ctx.base)
    except _XT_ERRORS:
        return None
    return s if isinstance(s, dict) and s.get("runs") else None


def _deferred(ctx: Ctx, state: Dict[str, Any]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for did, d in ctx.xt._deferred(state).items():
        info = d if isinstance(d, dict) else {}
        out.append({"id": str(did), "reason": str(info.get("reason", "")), "at": str(info.get("at", ""))})
    return out


def _loop(ctx: Ctx) -> Tuple[int, Dict[str, Any]]:
    try:
        state = ctx.xt.read_state(ctx.base) or {}
    except _XT_ERRORS:
        state = {}
    return 200, {
        **_verdict(ctx),
        "iterations": state.get("iterations") if state else None,
        "max_iterations": state.get("max_iterations"),
        "deadline": state.get("deadline"),
        "deferred": _deferred(ctx, state),
        "checkpoint": state.get("checkpoint"),
        "stats": _stats(ctx) if state else None,
    }


def _options(raw: str) -> List[str]:
    return [o for o in _OPT_SPLIT_RE.split(_OPT_FIRST_RE.sub("", raw, count=1)) if o]


def _parse_decisions(text: str) -> List[Dict[str, Any]]:
    """Mục `### D-NNN · <at> · <câu hỏi>` + các dòng trường do `loop decide` ghi; thứ tự trong file."""
    items: List[Dict[str, Any]] = []
    cur: Optional[Dict[str, Any]] = None
    for line in text.splitlines():
        head = _HEAD_RE.match(line)
        if head:
            cur = {"id": head[1], "at": head[2], "question": head[3].strip()}
            cur.update(options=[], choice="", why="", revert="")
            items.append(cur)
            continue
        if line.startswith("### "):
            cur = None
        for label, key in _FIELDS:
            if cur is not None and line.startswith(label):
                val = line[len(label) :].strip()
                cur[key] = _options(val) if key == "options" else val
    return items


def _haystack(d: Dict[str, Any]) -> str:
    parts = [d["id"], d["at"], d["question"], d["choice"], d["why"], d["revert"], *d["options"]]
    return "\n".join(parts).casefold()


def _decisions(ctx: Ctx) -> Tuple[int, Dict[str, Any]]:
    path = ctx.base / DECISIONS_FILE
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, ValueError):
        return 200, {"decisions": [], "truncated": False}
    items = _parse_decisions(text)[::-1]  # mới nhất trước
    q = (ctx.query.get("q") or [""])[0].strip().casefold()
    if q:
        items = [d for d in items if q in _haystack(d)]
    return 200, {"decisions": items[:MAX_DECISIONS], "truncated": len(items) > MAX_DECISIONS}


def _adr(path: Any, number: int, rel: str) -> Dict[str, Any]:
    title, status = "", ""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, ValueError):
        lines = []
    for line in lines:
        m = _ADR_TITLE_RE.match(line)
        if m and not title:
            title = m[1]
        if line.startswith(_ADR_STATUS) and not status:
            status = line[len(_ADR_STATUS) :].strip()
    return {"number": number, "title": title, "status": status, "path": rel}


def _adrs(ctx: Ctx) -> Tuple[int, Dict[str, Any]]:
    folder = ctx.base / ADR_DIR
    found = sorted((int(m[1]), p) for p in folder.glob("*.md") if p.is_file() and (m := _ADR_FILE_RE.match(p.name)))
    return 200, {"adrs": [_adr(p, n, f"{ADR_DIR}/{p.name}") for n, p in found]}


ROUTES: Routes = {
    ("GET", "/api/loop"): _loop,
    ("GET", "/api/decisions"): _decisions,
    ("GET", "/api/adrs"): _adrs,
}
