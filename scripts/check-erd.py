#!/usr/bin/env python3
"""Đối chiếu bảng DOMAIN-MODEL ↔ ERD (PLAN T-004, kế hoạch §12: ERD trước migration đầu tiên).

Nguồn bảng chuẩn:
  - DOMAIN-MODEL §1 (cột "Bảng"), §7 (cột "Bảng"), §3 (khối SQL phác thảo);
  - bảng hạ tầng bắt buộc theo INV-G5/G6/F4: idempotency_keys, audit_events, outbox, inbox.
ERD phải có tiêu đề "### `<bảng>`" cho mỗi bảng chuẩn, kèm dòng `Chủ module:`; bảng thừa trong ERD bị báo lỗi
(thêm bảng = sửa DOMAIN-MODEL trước — "một chủ đề một nhà").
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOMAIN = ROOT / "docs/design/DOMAIN-MODEL.md"
ERD = ROOT / "docs/design/ERD.md"
INFRA = {"idempotency_keys", "audit_events", "outbox", "inbox"}
TABLE = re.compile(r"`([a-z][a-z0-9]*(?:_[a-z0-9]+)*)`")


def section(text: str, num: int) -> str:
    m = re.search(rf"^## {num}\..*?(?=^## \d+\.|\Z)", text, re.S | re.M)
    return m.group(0) if m else ""


def column_names(block: str, col: int) -> set[str]:
    names: set[str] = set()
    for line in block.splitlines():
        if not line.startswith("|") or line.startswith("|---"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) > col:
            names.update(TABLE.findall(cells[col].split("(")[0]))
    return names


def domain_tables() -> set[str]:
    text = DOMAIN.read_text(encoding="utf-8")
    names = column_names(section(text, 1), 1) | column_names(section(text, 7), 1) | INFRA
    names |= set(re.findall(r"^(\w+)\(organization_id", section(text, 3), re.M))
    return names


def erd_tables(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in re.finditer(r"^### `([a-z0-9_]+)`\n(.*?)(?=^### |^## |\Z)", text, re.S | re.M):
        out[m.group(1)] = m.group(2)
    return out


def main() -> int:
    if not ERD.exists():
        print(f"✗ thiếu {ERD.relative_to(ROOT)}")
        return 1
    want = domain_tables()
    have = erd_tables(ERD.read_text(encoding="utf-8"))
    errors = [f"thiếu trong ERD: {t}" for t in sorted(want - have.keys())]
    errors += [f"ERD có bảng không có trong DOMAIN-MODEL: {t}" for t in sorted(have.keys() - want)]
    errors += [f"{t}: thiếu dòng 'Chủ module:'" for t, body in sorted(have.items()) if "Chủ module:" not in body]
    if errors:
        print("✗ ERD lệch DOMAIN-MODEL:\n  " + "\n  ".join(errors))
        return 1
    print(f"✓ ERD khớp DOMAIN-MODEL: {len(want)} bảng")
    return 0


if __name__ == "__main__":
    sys.exit(main())
