#!/usr/bin/env python3
"""check-links.py — kiểm liên kết Markdown nội bộ (tương đối) trên TOÀN repo, không chỉ framework/.

- Mọi `[text](đường/dẫn.md#anchor)` tương đối phải trỏ tới file/thư mục có thật.
- Bỏ qua URL (http:, mailto:…), anchor thuần (#…), nội dung trong code fence (``` hoặc ~~~).
- Link trỏ ra ngoài gốc repo là lỗi (file có trên máy người viết nhưng không có trong repo).
- Bỏ qua thư mục: .git, node_modules, .venv, .autopilot, __pycache__.
Thoát 1 nếu có link hỏng. Chỉ dùng thư viện chuẩn.
"""

from __future__ import annotations

import re
import sys
from collections.abc import Iterator
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if ROOT.name == ".xtemplates":  # cài ở dự án đích (.xtemplates/scripts/) → gốc là dự án, không phải .xtemplates/
    ROOT = ROOT.parent
SKIP_DIRS = {".git", "node_modules", ".venv", ".autopilot", "__pycache__", ".xtemplates"}
LINK_RE = re.compile(r"\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+\"[^\"]*\")?\)")
FENCE_RE = re.compile(r"^\s*(```|~~~)")


def iter_md(root: Path) -> Iterator[Path]:
    for p in sorted(root.rglob("*.md")):
        if any(part in SKIP_DIRS for part in p.relative_to(root).parts):
            continue
        yield p


def check(root: Path) -> list[str]:
    errors: list[str] = []
    for p in iter_md(root):
        fence: str | None = None
        for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), start=1):
            m = FENCE_RE.match(line)
            if m and (fence is None or m.group(1) == fence):
                fence = None if fence else m.group(1)
                continue
            if fence:
                continue
            for target in LINK_RE.findall(line):
                target = target[1:-1] if target.startswith("<") else target
                if re.match(r"^[a-z][a-z0-9+.-]*:", target) or target.startswith("#"):
                    continue
                path_part = target.split("#", 1)[0]  # rỗng chỉ với `<>` → thư mục chứa file, luôn tồn tại
                # Đường dẫn tuyệt đối từ gốc repo (/docs/x.md) cũng chấp nhận.
                resolved = (root / path_part.lstrip("/")) if path_part.startswith("/") else (p.parent / path_part)
                if not resolved.exists():
                    errors.append(f"{p.relative_to(root)}:{n}: liên kết hỏng -> {target}")
                elif not resolved.resolve().is_relative_to(root.resolve()):
                    errors.append(f"{p.relative_to(root)}:{n}: liên kết trỏ ra ngoài repo -> {target}")
    return errors


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT
    errors = check(root)
    for e in errors:
        print(f"✗ {e}")
    if errors:
        print(f"\n{len(errors)} liên kết hỏng.")
        return 1
    print("✓ Mọi liên kết Markdown nội bộ đều trỏ tới file có thật.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
