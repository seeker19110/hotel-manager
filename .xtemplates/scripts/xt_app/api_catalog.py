"""Màn Thư viện yêu cầu: `GET /api/catalog` và `GET /api/catalog/module` (SPEC-app §3, T-1922).

Nguồn sự thật là `xt.load_docs` (cùng parser với `validate`/`compose`); tách chữ/`→ Kiểm:`/`· Nguồn:` bằng
`xt.NORM_TAIL_RE`. Nạp một lần mỗi đường khung, nạp lại khi mtime lớn nhất hoặc số file `*.md` đổi.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Dict, List, Tuple

from xt_app.server import Ctx, Routes

MIN_QUERY = 2
MAX_HITS = 200
ROOT_DIR = "."

Reply = Tuple[int, Dict[str, Any]]
Stamp = Tuple[int, int]

_LOCK = threading.Lock()
_CACHE: Dict[str, Tuple[Stamp, List[Any]]] = {}


def _stamp(framework: Path) -> Stamp:
    newest, count = 0, 0
    for path in framework.rglob("*.md"):
        count += 1
        try:
            newest = max(newest, path.stat().st_mtime_ns)
        except OSError:
            continue
    return newest, count


def _docs(ctx: Ctx) -> List[Any]:
    key = str(ctx.framework)
    stamp = _stamp(ctx.framework)
    with _LOCK:
        cached = _CACHE.get(key)
        if cached is None or cached[0] != stamp:
            docs, _errors = ctx.xt.load_docs(ctx.framework)
            cached = (stamp, list(docs))
            _CACHE[key] = cached
        return cached[1]


def _split(ctx: Ctx, text: str) -> Tuple[str, str, str]:
    """(chữ yêu cầu, kiểm, nguồn) của một mục — cắt theo các dấu `→ Kiểm:` / `· Nguồn:`."""
    marks = list(ctx.xt.NORM_TAIL_RE.finditer(text))
    head = text[: marks[0].start()] if marks else text
    parts = {"check": "", "source": ""}
    for i, mark in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        field = "check" if "Kiểm" in mark.group(0) else "source"
        parts[field] = text[mark.end() : end].strip()
    return head.strip(), parts["check"], parts["source"]


def _area_dir(rel: str) -> str:
    return rel.split("/", 1)[0] if "/" in rel else ROOT_DIR


def _is_readme(rel: str) -> bool:
    return rel.rsplit("/", 1)[-1] == "README"


def _counts(doc: Any) -> Dict[str, int]:
    out = {"MUST": 0, "SHOULD": 0, "MAY": 0}
    for it in doc.items:
        out[it.level] += 1
    return out


def _module(doc: Any) -> Dict[str, Any]:
    prefix = doc.meta.get("prefix")
    return {
        "rel": doc.rel,
        "title": doc.title,
        "kind": doc.kind,
        "prefix": str(prefix) if prefix else "",
        "counts": _counts(doc),
    }


def _tree(docs: List[Any]) -> List[Dict[str, Any]]:
    titles = {_area_dir(d.rel): d.title for d in docs if d.rel.count("/") <= 1 and _is_readme(d.rel)}
    areas: Dict[str, Dict[str, Any]] = {}
    for doc in docs:
        if _is_readme(doc.rel):
            continue
        name = _area_dir(doc.rel)
        area = areas.setdefault(name, {"dir": name, "title": titles.get(name, name), "modules": []})
        area["modules"].append(_module(doc))
    return [areas[k] for k in sorted(areas)]


def _hits(ctx: Ctx, docs: List[Any], q: str) -> Tuple[List[Dict[str, Any]], bool]:
    needle = q.casefold()
    hits: List[Dict[str, Any]] = []
    for doc in docs:
        for it in doc.items:
            if needle not in it.id.casefold() and needle not in it.text.casefold():
                continue
            if len(hits) >= MAX_HITS:
                return hits, True
            hits.append({"id": it.id, "level": it.level, "rel": doc.rel, "text": _split(ctx, it.text)[0]})
    return hits, False


def _catalog(ctx: Ctx) -> Reply:
    docs = _docs(ctx)
    body: Dict[str, Any] = {"areas": _tree(docs)}
    raw = ctx.query.get("q")
    if raw is not None:
        q = raw[0].strip()
        if len(q) < MIN_QUERY:
            return 400, {"error": f"tham số q cần ít nhất {MIN_QUERY} ký tự"}
        body["hits"], body["truncated"] = _hits(ctx, docs, q)
    return 200, body


def _item(ctx: Ctx, it: Any) -> Dict[str, Any]:
    text, check, source = _split(ctx, it.text)
    return {"id": it.id, "level": it.level, "scale": it.scale, "text": text, "check": check, "source": source}


def _module_view(ctx: Ctx) -> Reply:
    raw = ctx.query.get("rel")
    rel = raw[0].strip() if raw else ""
    if not rel:
        return 400, {"error": "thiếu tham số rel"}
    doc = next((d for d in _docs(ctx) if d.rel == rel and not _is_readme(d.rel)), None)
    if doc is None:
        return 404, {"error": "không có module này trong khung"}
    return 200, {"rel": doc.rel, "title": doc.title, "kind": doc.kind, "items": [_item(ctx, it) for it in doc.items]}


ROUTES: Routes = {("GET", "/api/catalog"): _catalog, ("GET", "/api/catalog/module"): _module_view}
# Query mẫu cho `xt.py app --smoke` (SPEC-app §2.4): module có ở mọi bản khung (repo khung và `.xtemplates/`).
SMOKE = {"/api/catalog/module": "rel=00-method/conventions"}
