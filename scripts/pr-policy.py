#!/usr/bin/env python3
"""`pr-policy` — kiểm chính sách PR bằng máy (WF-DOC-001, WF-TEAM-003, XC-GREEN-005; PLAN đợt 7 T-607; đợt 9 T-801:
WF-REVIEW-002, WF-SDD-003, LOOP-STOP-005 và nối vào CI — job `pr-policy` ở .github/workflows/pr-policy.yml).

Mặc định CHỈ CẢNH BÁO (exit 0, in `CẢNH BÁO [mã] …`); `--strict` → exit 1 nếu có cảnh báo. Không gọi mạng/GitHub.

Dùng:
  python3 scripts/pr-policy.py --base origin/main [--title "feat(x): …"] [--body-file pr.md] [--labels "a,b"] [--strict]
  git diff --name-only main...HEAD | python3 scripts/pr-policy.py --files - --title "…" --body-file pr.md

Quy tắc:
- WF-DOC-001: đổi bề mặt công khai (registry/schema lệnh, OpenAPI, route API, migration, schema cấu hình, `.env.example`)
  mà không chạm `docs/` và mẫu PR không ghi `- [x] Không cần — lý do: <lý do thật>` → cảnh báo.
- XC-GREEN-005: PR `refactor:`/`perf:` không trộn `feat`/`fix` (xét tiêu đề commit) và phải điền bảng trước–sau
  (mục "Refactor / perf" của mẫu PR: ít nhất một hàng có cả cột Trước và Sau).
- WF-TEAM-003 (DoR): PR `feat:`/`fix:` phải nêu ID (S-NNN, T-NNN, D-NNN, F-NNN, #NNN) ở mục "Mục tiêu / SPEC"; SPEC bị
  sửa trong PR mà đã Approved thì không được còn câu hỏi `[chặn]` chưa tick (dùng `check-blocking-questions.py`).
- WF-REVIEW-002: mô tả PR (khi có `--body-file`) phải có mục tiêu + link spec/issue, cách đã xác minh (lệnh + exit code hoặc
  link CI — không tính phần chữ có sẵn của mẫu), rủi ro + cách rollback.
- WF-SDD-003: PR `feat:` có bản đồ scenario → test ở mục "Tiêu chí chấp nhận" (dòng có S-NNN/AC-NN và đường dẫn test có thật),
  hoặc ghi "không áp dụng — lý do: …".
- XC-GREEN-005 (bổ sung): PR `refactor:`/`perf:` điền hàng "Số test" (trước/sau); số test không giảm, tăng thì diff phải có file test.
- LOOP-STOP-005: (khi có `--labels`) PR chạm đường dẫn tiền/dữ liệu/auth/mật mã (nguồn: `merge_risk_paths` của xt.yaml) phải có
  nhãn `risk:money|data|auth|crypto` tương ứng. Review bắt buộc của người cần ruleset GitHub — ngoài phạm vi script.
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
LINK_OR_ID = re.compile(ID_REF.pattern + r"|https?://\S+")

# LOOP-STOP-005: nhãn risk theo thành phần đường dẫn. Nguồn sự thật của danh sách đường dẫn nhạy cảm là `merge_risk_paths`
# trong xt.yaml (test_pr_policy.py kiểm mọi mục ở đó đều có nhãn). Khớp theo tên thư mục trong đường dẫn.
RISK_DIRS = {
    "risk:money": ("ledger", "money", "deposits", "reconciliation", "shifts", "thu-tien", "ky-thu", "doi-soat"),
    "risk:auth": ("identity", "access", "approvals", "tenancy"),
    "risk:data": (
        "lease",
        "stay",
        "rental",
        "inventory",
        "metering",
        "notifications",
        "hop-dong",
        "chi-so",
        "webhooks",
    ),
    "risk:crypto": ("crypto",),
}
# Đường dẫn gốc (tiền tố) cũng nhạy cảm: API công khai và toàn bộ lớp CSDL.
RISK_PREFIXES = {
    "risk:data": ("apps/web/app/api/", "packages/db/"),
}
TEST_FILE = re.compile(r"\.(?:test|spec)\.[a-z]+$|(?:^|/)test_[^/]+\.py$")
TEST_REF = re.compile(r"[\w@./-]+\.(?:test|spec)\.(?:ts|tsx|mjs|py)\b|(?:[\w@.-]+/)*test_\w+\.py\b")
SCENARIO_REF = re.compile(r"\b(?:S-\d{3}|AC-\d+)\b")
ROLLBACK = re.compile(r"rollback|roll back|quay lại|quay về|hoàn tác|revert|khôi phục|cách tắt|tắt (?:cờ|tính năng)", re.I)


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


def risk_labels(files: list[str]) -> dict[str, list[str]]:
    """Nhãn risk bắt buộc → các file gây ra (rỗng nếu không chạm vùng nhạy cảm)."""
    need: dict[str, list[str]] = {}
    for f in files:
        parts = f.strip().split("/")
        for label, dirs in RISK_DIRS.items():
            if any(p in dirs for p in parts[:-1]):
                need.setdefault(label, []).append(f)
        for label, prefixes in RISK_PREFIXES.items():
            if any(f.startswith(p) for p in prefixes):
                need.setdefault(label, []).append(f)
    return need


def meaningful(text: str) -> str:
    """Chữ thật của một mục (bỏ khoảng trắng, dấu liệt kê, `…`, dấu chấm)."""
    return re.sub(r"[\s\-*•…\.]", "", re.sub(r"\[[ xX]\]", "", text))


def template_labels(section_name: str, root: Path = ROOT) -> list[str]:
    """Nhãn có sẵn (chữ cố định) của các dòng checklist trong mục `section_name` của mẫu PR."""
    path = root / ".github" / "pull_request_template.md"
    if not path.exists():
        return []
    out = []
    for line in section(path.read_text(encoding="utf-8"), section_name).splitlines():
        m = re.match(r"^\s*- \[[ x]\]\s*(.+)$", line, re.I)
        if m:
            out.append(m.group(1).strip())
    return out


def has_verification(body: str, root: Path = ROOT) -> bool:
    """Mục 'Bằng chứng cổng' có dòng đã tick kèm lệnh + exit code hoặc link — ngoài phần chữ cố định của mẫu."""
    text = " ".join(
        re.sub(r"^\s*- \[x\]\s*", "", line, flags=re.I)
        for line in section(body, "Bằng chứng cổng").splitlines()
        if re.match(r"^\s*- \[x\]", line, re.I)
    )
    for label in sorted(template_labels("Bằng chứng cổng", root), key=len, reverse=True):
        text = text.replace(label, "")
    return bool(re.search(r"\bexit(?:\s+code)?\s*[:=]?\s*\d+|https?://\S+", text, re.I))


def test_counts(body: str) -> tuple[int, int] | None:
    """(trước, sau) của hàng 'Số test' trong bảng trước–sau; thiếu/không phải số → None."""
    for line in section(body, "Refactor / perf").splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) >= 3 and cells[0].lower().startswith("số test"):
            nums = [re.sub(r"[.,\s]", "", c) for c in cells[1:3]]
            if all(n.isdigit() for n in nums):
                return int(nums[0]), int(nums[1])
    return None


def check_body(
    body: str,
    title: str | None = None,
    files: list[str] | None = None,
    root: Path = ROOT,
) -> list[tuple[str, str]]:
    """Kiểm độ đầy đủ của mô tả PR (WF-REVIEW-002, WF-SDD-003, XC-GREEN-005 số test). Chỉ gọi khi có nội dung mô tả."""
    warns: list[tuple[str, str]] = []
    files = [f.strip() for f in (files or []) if f.strip()]
    kind = pr_type(title) if title is not None else None

    goal = section(body, "Mục tiêu / SPEC")
    if len(meaningful(goal)) < 12:
        warns.append(("WF-REVIEW-002", "mục 'Mục tiêu / SPEC' còn trống — nêu mục tiêu và link spec/issue"))
    elif kind not in ("feat", "fix") and not LINK_OR_ID.search(goal):
        warns.append(("WF-REVIEW-002", "mục 'Mục tiêu / SPEC' thiếu link/ID spec hoặc issue (S-NNN, T-NNN, D-NNN, #issue, URL)"))

    if not has_verification(body, root):
        warns.append(
            (
                "WF-REVIEW-002",
                "mục 'Bằng chứng cổng': tick và ghi lệnh + exit code hoặc link CI (không tính chữ có sẵn của mẫu)",
            )
        )

    risk = section(body, "Rủi ro")
    if len(meaningful(risk)) < 20 or not ROLLBACK.search(risk):
        warns.append(("WF-REVIEW-002", "mục 'Rủi ro' phải nêu rủi ro và cách rollback/quay lại"))

    if kind == "feat":
        ac = section(body, "Tiêu chí chấp nhận")
        waiver = re.search(r"không áp dụng\s*[—-]\s*lý do:\s*(\S.{6,})", ac, re.I)
        mapped = []
        for line in ac.splitlines():
            if SCENARIO_REF.search(line):
                mapped += TEST_REF.findall(line)
        if not mapped and not waiver:
            warns.append(
                (
                    "WF-SDD-003",
                    "PR feat: mục 'Tiêu chí chấp nhận' phải liệt kê bản đồ S-NNN → đường dẫn test "
                    "(hoặc 'không áp dụng — lý do: …')",
                )
            )
        missing = [t for t in dict.fromkeys(mapped) if t not in files and not (root / t).exists()]
        if missing:
            warns.append(("WF-SDD-003", f"bản đồ scenario → test trỏ tới file không có trong repo/diff: {', '.join(missing[:3])}"))

    if kind in ("refactor", "perf"):
        counts = test_counts(body)
        if counts is None:
            warns.append(("XC-GREEN-005", f"PR {kind}: điền hàng 'Số test' (trước và sau, là số) ở bảng trước–sau"))
        else:
            before, after = counts
            if after < before:
                warns.append(("XC-GREEN-005", f"PR {kind}: số test giảm ({before} → {after}) — refactor không được bỏ test"))
            elif after > before and not any(TEST_FILE.search(f) for f in files):
                warns.append(("XC-GREEN-005", f"PR {kind}: số test tăng ({before} → {after}) nhưng diff không có file test"))
    return warns


def check(
    files: list[str],
    title: str | None = None,
    body: str | None = None,
    commits: list[str] | None = None,
    root: Path = ROOT,
    labels: list[str] | None = None,
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

    # LOOP-STOP-005: chỉ kiểm khi biết nhãn (CI truyền --labels; chạy cục bộ không có nhãn thì bỏ qua).
    if labels is not None:
        have = {label.strip() for label in labels}
        for label, causes in risk_labels(files).items():
            if label not in have:
                shown = ", ".join(causes[:2]) + (" …" if len(causes) > 2 else "")
                warns.append(("LOOP-STOP-005", f"PR chạm vùng nhạy cảm ({shown}) — gắn nhãn '{label}'; người merge (merge-check HUMAN)"))
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
    ap.add_argument("--labels", help="nhãn của PR, cách nhau dấu phẩy ('' = không có nhãn); bỏ qua cờ này = không kiểm nhãn risk")
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
    labels = None if args.labels is None else [x for x in args.labels.split(",") if x.strip()]
    warns = check(files, args.title, body, commits, labels=labels)
    if body is not None:
        warns += check_body(body, args.title, files)
    for code, msg in warns:
        print(f"CẢNH BÁO [{code}] {msg}")
    if not warns:
        print("pr-policy: không có cảnh báo")
    return 1 if warns and args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
