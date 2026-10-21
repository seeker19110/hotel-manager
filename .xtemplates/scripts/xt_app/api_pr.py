"""`GET /api/prs`, `GET /api/pr-stats` — màn PR (SPEC-app §3), CHỈ ĐỌC GitHub (ADR-0038 §2, RK-3 của PLAN-3.14).

GitHub đọc qua `ctx.xt._gh_api` (REST `gh api <đường>` — luôn GET); hành động kế tính bằng chính chuỗi của `pr next`
(`_pr_rest` → `_merge_eval` → `pr_next`, hàm thuần) nhưng KHÔNG ghi sổ review (bước nhớ `standard_seen` của `xt.py pr next`), không
gắn nhãn, không merge, không đăng comment. Không có `gh`/chưa đăng nhập/hết giờ/lỗi REST → 200 `available: false`.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Dict, List, Tuple

from xt_app.server import Ctx, Routes

OPEN_PRS = "repos/{owner}/{repo}/pulls?state=open&per_page=100"
DAYS_DEFAULT = 7
DAYS_MAX = 90
# Dữ liệu GitHub lạ (thiếu khoá, sai kiểu), git/file không đọc được không được làm màn PR 500.
_DATA_ERRORS = (KeyError, TypeError, ValueError, AttributeError, OSError)


def _one_line(exc: BaseException) -> str:
    text = " ".join(str(exc).split())
    return text[:300] or type(exc).__name__


def _unavailable(exc: BaseException) -> Tuple[int, Dict[str, Any]]:
    return 200, {"available": False, "reason": _one_line(exc)}


def _reasons(out: Dict[str, Any], d: Dict[str, Any]) -> List[str]:
    """Lý do: `why` của `pr next` trước, rồi lý do `merge-check` chưa nằm trong nó."""
    why = str(out.get("why") or "")
    rest = [str(r) for r in d.get("reasons") or [] if str(r) not in why]
    return ([why] if why else []) + rest


def _pr_row(ctx: Ctx, item: Dict[str, Any]) -> Dict[str, Any]:
    """Một dòng PR: như `xt.py pr next` bỏ bước ghi `standard_seen` vào sổ — chỉ áp trong bộ nhớ."""
    xt, n = ctx.xt, str(item.get("number", ""))
    head = item.get("head")
    row: Dict[str, Any] = {
        "number": item.get("number"),
        "title": str(item.get("title") or ""),
        "head_sha": str(head.get("sha") or "") if isinstance(head, dict) else "",
    }
    try:
        pr = xt._pr_rest(n, local_check=False)
        d, _notes = xt._merge_eval(pr)
        rec = dict(xt._pr_record(xt.read_reviews(ctx.base), str(d["pr"])))
        if d.get("lane") == "chuẩn" or xt._standard_seen(pr):
            rec["standard_seen"] = True
        out = xt.pr_next(
            d,
            bool(pr.get("autoMergeRequest")),
            xt.with_published(rec, pr.get("xtReviews"), bool(pr.get("reviewIdentity"))),
        )
    except (xt.PrInputError, *_DATA_ERRORS) as exc:
        return {**row, "lane": "", "action": "error", "reasons": [_one_line(exc)]}
    return {
        **row,
        "head_sha": str(out.get("head") or row["head_sha"]),
        "lane": str(d.get("lane") or ""),
        "action": str(out.get("action") or ""),
        "reasons": _reasons(out, d),
    }


def _prs(ctx: Ctx) -> Tuple[int, Dict[str, Any]]:
    try:
        items = ctx.xt._gh_items(OPEN_PRS)
    except (ctx.xt.PrInputError, *_DATA_ERRORS) as exc:
        return _unavailable(exc)
    return 200, {"available": True, "prs": [_pr_row(ctx, it) for it in items]}


def _days(ctx: Ctx) -> int:
    raw = ctx.query.get("days")
    if not raw:
        return DAYS_DEFAULT
    text = raw[0].strip()
    if not (text.isascii() and text.isdigit()) or not 1 <= int(text) <= DAYS_MAX:
        raise ValueError(text)
    return int(text)


def _pr_stats(ctx: Ctx) -> Tuple[int, Dict[str, Any]]:
    try:
        days = _days(ctx)
    except ValueError:
        return 400, {"error": f"`days` phải là số nguyên 1–{DAYS_MAX}"}
    xt = ctx.xt
    now = _dt.datetime.now(_dt.timezone.utc)
    try:
        prs, runs = xt._pr_stats_fetch("repos/{owner}/{repo}", now - _dt.timedelta(days=days))
        stats = xt.pr_stats(prs, runs, now, days)
    except (xt.PrInputError, *_DATA_ERRORS) as exc:
        return _unavailable(exc)
    return 200, {**dict(stats), "available": True}


ROUTES: Routes = {("GET", "/api/prs"): _prs, ("GET", "/api/pr-stats"): _pr_stats}
