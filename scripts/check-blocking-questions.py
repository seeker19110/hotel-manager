#!/usr/bin/env python3
"""Cổng "0 câu [chặn]" (DoR của SPEC): exit ≠ 0 nếu SPEC được nêu còn câu hỏi `[chặn…]` chưa tick.

Dùng: python3 scripts/check-blocking-questions.py lease metering-billing …   (tên theo docs/specs/SPEC-<tên>.md)
Câu `[không chặn]` không tính. Câu đã quyết ghi `- [x] … — **Quyết …:** …` (một chỗ quyết, có ngày).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

OPEN_BLOCKING = re.compile(r"^\s*- \[ \] .*\[chặn[^\]]*\]")
SPECS_DIR = Path(__file__).resolve().parent.parent / "docs" / "specs"


def open_blocking(text: str) -> list[tuple[int, str]]:
    """Các dòng (số dòng, nội dung rút gọn) còn câu hỏi [chặn] chưa tick."""
    return [(i, line.strip()[:160]) for i, line in enumerate(text.splitlines(), 1) if OPEN_BLOCKING.match(line)]


def main(argv: list[str]) -> int:
    if not argv:
        print("dùng: check-blocking-questions.py <spec> [<spec> …]", file=sys.stderr)
        return 2
    failed = False
    for name in argv:
        path = SPECS_DIR / f"SPEC-{name}.md"
        if not path.is_file():
            print(f"✗ không có {path.relative_to(SPECS_DIR.parent.parent)}", file=sys.stderr)
            failed = True
            continue
        found = open_blocking(path.read_text(encoding="utf-8"))
        for line_no, text in found:
            print(f"✗ SPEC-{name}.md:{line_no}: {text}", file=sys.stderr)
        failed = failed or bool(found)
        if not found:
            print(f"✓ SPEC-{name}.md: 0 câu [chặn] mở")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
