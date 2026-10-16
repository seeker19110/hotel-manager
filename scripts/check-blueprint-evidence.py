#!/usr/bin/env python3
"""Kiểm bằng chứng của BLUEPRINT.md (PLAN đợt 2 T-118; luật "bằng chứng, không lời khai").

- Mục `[x]` phải có `Bằng chứng:` kèm ≥ 1 tham chiếu trong dấu backtick: đường dẫn trong repo (file/thư mục tồn tại; cho phép
  hậu tố `#…` chỉ phần trong file) hoặc job CI dạng `ci:<job>` (job có thật trong `.github/workflows/*.yml`).
- Mục `[~]` phải có `— Miễn: <lý do>` không rỗng.
Thoát 1 nếu có mục vi phạm; in từng dòng lỗi (số dòng, mã mục, lý do).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ITEM = re.compile(r"^- \[(?P<state>[ x~])\] `(?P<id>[A-Z0-9][A-Z0-9-]*)` \*\*(?P<level>MUST|SHOULD|MAY)\*\*")
TICK = re.compile(r"`([^`]+)`")
JOB = re.compile(r"^  ([A-Za-z0-9_-]+):\s*$", re.M)


def ci_jobs(root: Path) -> set[str]:
    jobs: set[str] = set()
    for wf in sorted((root / ".github" / "workflows").glob("*.y*ml")):
        text = wf.read_text(encoding="utf-8")
        start = text.find("\njobs:")
        if start >= 0:
            jobs.update(JOB.findall(text[start:]))
    return jobs


def problems(text: str, root: Path, jobs: set[str]) -> list[tuple[int, str, str]]:
    out: list[tuple[int, str, str]] = []
    for n, line in enumerate(text.splitlines(), start=1):
        m = ITEM.match(line)
        if not m:
            continue
        item = m.group("id")
        if m.group("state") == "~":
            reason = line.split("— Miễn:", 1)[1].strip() if "— Miễn:" in line else ""
            if not reason:
                out.append((n, item, "miễn trừ thiếu '— Miễn: <lý do>'"))
            continue
        if m.group("state") != "x":
            continue
        if "Bằng chứng:" not in line:
            out.append((n, item, "đã tick nhưng thiếu 'Bằng chứng:'"))
            continue
        refs = TICK.findall(line.split("Bằng chứng:", 1)[1])
        if not refs:
            out.append((n, item, "'Bằng chứng:' không có tham chiếu trong `…`"))
            continue
        for ref in refs:
            if ref.startswith("ci:"):
                if ref[3:] not in jobs:
                    out.append((n, item, f"job CI không tồn tại: {ref}"))
                continue
            path = ref.split("#", 1)[0]
            if not path or path.startswith("/") or ".." in Path(path).parts or not (root / path).exists():
                out.append((n, item, f"đường dẫn bằng chứng không tồn tại: {ref}"))
    return out


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("Dùng: check-blueprint-evidence.py BLUEPRINT.md", file=sys.stderr)
        return 2
    path = Path(argv[1])
    root = path.resolve().parent
    text = path.read_text(encoding="utf-8")
    bad = problems(text, root, ci_jobs(root))
    ticked = sum(1 for line in text.splitlines() if (m := ITEM.match(line)) and m.group("state") == "x")
    for n, item, why in bad:
        print(f"{path}:{n}: {item}: {why}", file=sys.stderr)
    print(f"[blueprint-evidence] {ticked} mục [x] · {len(bad)} lỗi")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
