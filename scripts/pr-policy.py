#!/usr/bin/env python3
"""`pr-policy` — kiểm chính sách PR bằng máy (WF-DOC-001, WF-TEAM-003, XC-GREEN-005; PLAN đợt 7 T-607).

Mặc định CHỈ CẢNH BÁO (exit 0, in `CẢNH BÁO [mã] …`); `--strict` → exit 1 nếu có cảnh báo. Không gọi mạng/GitHub.

Dùng:
  python3 scripts/pr-policy.py --base origin/main [--title "feat(x): …"] [--body-file pr.md] [--strict]
  git diff --name-only main...HEAD | python3 scripts/pr-policy.py --files - --title "…" --body-file pr.md

Quy tắc:
- WF-DOC-001: đổi bề mặt công khai (registry/schema lệnh, OpenAPI, route API, migration, schema cấu hình, `.env.example`)
  mà không chạm `docs/` và mẫu PR không ghi `- [x] Không cần — lý do: <lý do thật>` → cảnh báo.
- XC-GREEN-005: PR `refactor:`/`perf:` không trộn `feat`/`fix` (xét tiêu đề commit) và phải điền bảng trước–sau
  (mục "Refactor / perf" của mẫu PR: ít nhất một hàng có cả cột Trước và Sau).
- WF-TEAM-003 (DoR): PR `feat:`/`fix:` phải nêu ID (S-NNN, T-NNN, D-NNN, F-NNN, #NNN) ở mục "Mục tiêu / SPEC"; SPEC bị
  sửa trong PR mà đã Approved thì không được còn câu hỏi `[chặn]` chưa tick (dùng `check-blocking-questions.py`).
- Tiêu đề PR: Conventional Commits, ≤ 72 ký tự (cùng luật với job CI hiện có).
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TITLE = re.compile(r"^(?P<type>[a-z]+)(?:\([^)]+\))?!?: \S")
TYPES = {"feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"}

# Bề mặt công khai: đổi ở đây là đổi hành vi/hợp đồng mà người dùng/vận hành/client thấy.
PUBLIC_SURFACE = (
    re.compile(r"^packages/app/src/http/(registry|command-inputs|openapi)\.ts$"),
    re.compile(r"^apps/web/app/api/.+/route\.ts$"),
    re.compile(r"^apps/web/openapi\.json$"),
    re.compile(r"^packages/db/(src/)?migrations/.+"),
    re.compile(r"^packages/app/src/config/(schema|worker)\.ts$"),
    re.compile(r"^\.env\.example$"),
)
ID_REF = re.compile(r"\b(?:S-\d{3}|T-\d{3,4}|D-\d{3}|F-\d{3}|Q-\d+)\b|(?<!\w)#\d+\b")


def load_blocking_checker():
    spec = importlib.util.spec_from_file_location(
        "check_blocking_questions", Path(__file__).with_name("check-blocking-questions.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def pr_type(title: str) -> str | None:
    m = TITLE.match(title.strip())
    return m.group("type") if m and m.group("type") in TYPES else None


def section(body: str, heading: str) -> str:
    """Nội dung dưới `## <heading…>` tới `## ` kế tiếp (bỏ chú thích HTML)."""
    m = re.search(rf"^## {re.escape(heading)}[^\n]*\n(.*?)(?=^## |\Z)", body, re.M | re.S)
    return re.sub(r"<!--.*?-->", "", m.group(1), flags=re.S) if m else ""


def docs_waiver(body: str) -> bool:
    """Mẫu PR có `- [x] Không cần — lý do: <lý do thật>` (không phải chỗ trống/dấu …)."""
    for line in section(body, "Docs cập nhật").splitlines():
        m = re.match(r"^- \[x\] Không cần — lý do:\s*(.*)$", line.strip(), re.I)
        if m and len(m.group(1).strip(" .…")) >= 8:
            return True
    return False


def docs_updated_claim(body: str) -> bool:
    for line in section(body, "Docs cập nhật").splitlines():
        m = re.match(r"^- \[x\] Đã cập nhật:\s*(.*)$", line.strip(), re.I)
        if m and len(m.group(1).strip(" .…")) >= 3:
            return True
    return False


def filled_before_after(body: str) -> bool:
    """Bảng trước–sau có ≥ 1 hàng dữ liệu với cả hai cột Trước/Sau không rỗng."""
    for line in section(body, "Refactor / perf").splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) >= 3 and not set("".join(cells)) <= set("-: ") and cells[0].lower() != "số đo":
            if cells[1] and cells[2]:
                return True
    return False


def check(
    files: list[str],
    title: str | None = None,
    body: str | None = None,
    commits: list[str] | None = None,
    root: Path = ROOT,
) -> list[tuple[str, str]]:
    warns: list[tuple[str, str]] = []
    files = [f.strip() for f in files if f.strip()]

    kind = None
    if title is not None:
        kind = pr_type(title)
        if kind is None or len(title.strip()) > 72:
            warns.append(("PR-TITLE", f"tiêu đề phải dạng '<type>(scope): mô tả' và ≤ 72 ký tự: {title!r}"))

    # WF-DOC-001
    surface = [f for f in files if any(p.match(f) for p in PUBLIC_SURFACE)]
    if surface and not any(f.startswith("docs/") for f in files):
        if body is None or not (docs_waiver(body)):
            shown = ", ".join(surface[:3]) + (" …" if len(surface) > 3 else "")
            warns.append(
                (
                    "WF-DOC-001",
                    f"đổi bề mặt công khai ({shown}) mà không chạm docs/ — cập nhật tài liệu cùng PR, "
                    "hoặc tick 'Không cần — lý do: …' ở mẫu PR",
                )
            )
    if body is not None and docs_updated_claim(body) and not any(f.startswith("docs/") or f.endswith(".md") for f in files):
        warns.append(("WF-DOC-001", "mẫu PR khai 'Đã cập nhật' tài liệu nhưng diff không có file .md nào"))

    # XC-GREEN-005
    if kind in ("refactor", "perf"):
        mixed = [c for c in (commits or []) if pr_type(c) in ("feat", "fix")]
        if mixed:
            warns.append(("XC-GREEN-005", f"PR {kind}: không trộn tính năng/sửa lỗi — commit lẫn vào: {mixed[0]!r}"))
        if body is not None and not filled_before_after(body):
            warns.append(("XC-GREEN-005", f"PR {kind}: điền bảng trước–sau (mục 'Refactor / perf' của mẫu PR)"))

    # WF-TEAM-003 (DoR)
    if kind in ("feat", "fix") and body is not None and not ID_REF.search(section(body, "Mục tiêu / SPEC")):
        warns.append(("WF-TEAM-003", f"PR {kind}: mục 'Mục tiêu / SPEC' phải nêu ID (S-NNN, T-NNN, D-NNN, F-NNN hoặc #issue)"))
    specs = [f for f in files if re.match(r"^docs/specs/SPEC-[^/]+\.md$", f)]
    if specs:
        blocking = load_blocking_checker()
        for f in specs:
            path = root / f
            if not path.exists():  # file bị xoá trong PR
                continue
            text = path.read_text(encoding="utf-8")
            if blocking.APPROVED.search(text) and blocking.open_blocking(text):
                warns.append(("WF-TEAM-003", f"{f}: SPEC đã Approved nhưng còn câu hỏi [chặn] chưa tick"))
    return warns


def git(*args: str) -> list[str]:
    out = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line.strip()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", help="nhánh gốc: lấy file đổi và tiêu đề commit từ `git diff/log BASE...HEAD`")
    ap.add_argument("--files", help="'-' = đọc danh sách file đổi từ stdin (mỗi dòng một đường dẫn)")
    ap.add_argument("--title", help="tiêu đề PR")
    ap.add_argument("--body-file", help="file chứa mô tả PR (theo mẫu .github/pull_request_template.md)")
    ap.add_argument("--strict", action="store_true", help="có cảnh báo → exit 1")
    args = ap.parse_args(argv)

    if args.base:
        files = git("diff", "--name-only", f"{args.base}...HEAD")
        commits = git("log", "--format=%s", f"{args.base}..HEAD")
    elif args.files == "-":
        files, commits = sys.stdin.read().splitlines(), []
    else:
        ap.error("cần --base hoặc --files -")
    body = Path(args.body_file).read_text(encoding="utf-8") if args.body_file else None
    warns = check(files, args.title, body, commits)
    for code, msg in warns:
        print(f"CẢNH BÁO [{code}] {msg}")
    if not warns:
        print("pr-policy: không có cảnh báo")
    return 1 if warns and args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
