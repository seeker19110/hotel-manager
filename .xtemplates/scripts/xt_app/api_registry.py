"""`GET /api/registry` — màn Registry sản phẩm (ADR-0068 lát E), CHỈ ĐỌC `docs/ops/registry.json` của dự án.

Cùng đường kiểm của `xt.py registry` (`registry_load` → `registry_report`): lệch core/gói so với VERSION khung, ngoại lệ
hết hạn. Không ghi file, không chạy tiến trình. Chưa có file/không hợp lệ → 200 `available: false` kèm lỗi schema.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Dict, List, Tuple

from xt_app.server import Ctx, Routes

MAX_ERRORS = 50
DETAIL_KEYS = ("owner", "type", "risk", "environments", "slo", "release", "exceptions")


def _registry(ctx: Ctx) -> Tuple[int, Dict[str, Any]]:
    rel = str(ctx.xt.REGISTRY_FILE)
    path = ctx.base / rel
    if not path.is_file():
        return 200, {"available": False, "path": rel, "reason": f"chưa có {rel}", "errors": []}
    data, errors = ctx.xt.registry_load(path, ctx.framework)
    if data is None:
        # Lỗi nêu đường tuyệt đối của máy: chỉ trả đường tương đối của dự án.
        shown: List[str] = [str(e).replace(str(path), rel) for e in errors[:MAX_ERRORS]]
        return 200, {"available": False, "path": rel, "reason": f"{rel} không hợp lệ", "errors": shown}
    report = ctx.xt.registry_report(data, ctx.framework, _dt.date.today())
    rows = [{**r, **{k: p[k] for k in DETAIL_KEYS}} for p, r in zip(data["products"], report["products"])]
    return 200, {**report, "available": True, "path": rel, "products": rows}


ROUTES: Routes = {("GET", "/api/registry"): _registry}
