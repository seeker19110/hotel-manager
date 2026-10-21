#!/usr/bin/env python3
"""check-links.py — kiểm liên kết Markdown nội bộ (tương đối) trên TOÀN repo, không chỉ framework/.

- Mọi `[text](đường/dẫn.md#anchor)` tương đối phải trỏ tới file/thư mục có thật.
- Bỏ qua URL (http:, mailto:…), anchor thuần (#…), nội dung trong code fence (``` hoặc ~~~).
- Link trỏ ra ngoài gốc repo là lỗi (file có trên máy người viết nhưng không có trong repo).
- Bỏ qua thư mục: .git, node_modules, .venv, .autopilot, __pycache__.
Thoát 1 nếu có link hỏng. Chỉ dùng thư viện chuẩn.

`--external` (REC-13) kiểm URL http(s) thay vì link nội bộ — đích `[text](url)`, autolink `<url>` (cách khung ghi
nguồn) và URL trần; bỏ qua URL trong code span/fence (ví dụ minh hoạ) — và phân loại kết quả (chính sách ở
framework/11-autonomous-loop/self-healing-ci.md, mục "Kiểm liên kết ngoài"):
- tạm (5xx, 408, timeout, lỗi mạng): thử lại hữu hạn, còn lỗi thì CẢNH BÁO, không làm đỏ;
- đổi (3xx): CẢNH BÁO, nên cập nhật URL; chết (404/410/4xx khác): LỖI, exit 1;
- chưa xác minh (403/429, trang chặn bot): CẢNH BÁO, không kết luận nội dung.
"""

from __future__ import annotations

import argparse
import re
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if ROOT.name == ".xtemplates":  # cài ở dự án đích (.xtemplates/scripts/) → gốc là dự án, không phải .xtemplates/
    ROOT = ROOT.parent
SKIP_DIRS = {".git", "node_modules", ".venv", ".autopilot", "__pycache__", ".xtemplates"}
LINK_RE = re.compile(r"\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+\"[^\"]*\")?\)")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
URL_RE = re.compile(r"^https?://[^\s]+$")
CODE_SPAN_RE = re.compile(r"(`+)(?!`).*?(?<!`)\1(?!`)")  # `x` và ``x ` y``: URL trong đó là ví dụ, không phải nguồn
AUTOLINK_RE = re.compile(r"<(https?://[^\s<>]+)>")
BARE_URL_RE = re.compile(r"https?://[^\s<>\[\]\"`|]+")
SKIP_HOSTS = {"localhost", "127.0.0.1", "example.com", "example.org", "example.net"}
SKIP_SUFFIXES = (".invalid", ".example", ".test", ".localhost")
RETRY_GET_CODES = {501}  # HEAD bị từ chối → thử lại bằng GET trước khi kết luận; cùng mọi 4xx trừ GONE_CODES
GONE_CODES = {404, 410}  # HEAD 404/410 đủ kết luận "không còn" — không gọi GET
USER_AGENT = "xtemplates-check-links/1 (+https://github.com/)"
Fetcher = Callable[[str, float], int]


def iter_md(root: Path) -> Iterator[Path]:
    for p in sorted(root.rglob("*.md")):
        if any(part in SKIP_DIRS for part in p.relative_to(root).parts):
            continue
        yield p


def iter_lines(root: Path) -> Iterator[tuple[Path, int, str]]:
    """(file, số dòng, dòng) của mọi dòng Markdown nằm ngoài code fence."""
    for p in iter_md(root):
        fence: str | None = None
        for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), start=1):
            m = FENCE_RE.match(line)
            if m and (fence is None or m.group(1) == fence):
                fence = None if fence else m.group(1)
                continue
            if not fence:
                yield p, n, line


def _unangle(target: str) -> str:
    return target[1:-1] if target.startswith("<") else target


def iter_links(root: Path) -> Iterator[tuple[Path, int, str]]:
    """(file, số dòng, đích) của mọi link Markdown ngoài code fence; đích đã bỏ `<>`."""
    for p, n, line in iter_lines(root):
        for target in LINK_RE.findall(line):
            yield p, n, _unangle(target)


def line_urls(line: str) -> list[str]:
    """URL http(s) trong một dòng: đích `[text](url)`, autolink `<url>`, URL trần; bỏ qua mọi thứ trong code span."""
    rest = CODE_SPAN_RE.sub(" ", line)
    urls = [_unangle(t) for t in LINK_RE.findall(rest)]
    rest = LINK_RE.sub(" ", rest)
    urls += AUTOLINK_RE.findall(rest)
    rest = AUTOLINK_RE.sub(" ", rest)
    for raw in BARE_URL_RE.findall(rest):
        url = raw.rstrip(".,;:!?*_'")
        while url.endswith(")") and url.count(")") > url.count("("):  # `(xem https://a/b)` → bỏ `)` đóng câu
            url = url[:-1]
        urls.append(url)
    return urls


def check(root: Path) -> list[str]:
    errors: list[str] = []
    for p, n, target in iter_links(root):
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


def external_urls(root: Path) -> dict[str, str]:
    """URL http(s) duy nhất (bỏ #anchor, bỏ host giả/nội bộ) → vị trí `file:dòng` đầu tiên."""
    found: dict[str, str] = {}
    for p, n, line in iter_lines(root):
        for target in line_urls(line):
            if not URL_RE.match(target):
                continue
            url = target.split("#", 1)[0]
            host = (urlsplit(url).hostname or "").lower()
            if host in SKIP_HOSTS or host.endswith(SKIP_SUFFIXES):
                continue
            found.setdefault(url, f"{p.relative_to(root)}:{n}")
    return found


def classify_status(status: int) -> str:
    """Mã HTTP → `ok` · `moved` (3xx) · `unverified` (401/403/429) · `transient` (5xx/408) · `dead` (còn lại)."""
    if 200 <= status < 300:
        return "ok"
    if 300 <= status < 400:
        return "moved"
    if status in (401, 403, 429):
        return "unverified"
    if status == 408 or 500 <= status < 600:
        return "transient"
    return "dead"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Không đi theo chuyển hướng: 301/308 phải thấy được để báo "đổi", không bị che bằng 200 cuối đường."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def http_status(url: str, timeout: float, opener: urllib.request.OpenerDirector | None = None) -> int:
    """Mã HTTP của URL (HEAD, rồi GET nếu HEAD trả 4xx khác 404/410 hoặc 501 — nhiều máy chủ từ chối HEAD bằng 400/403/
    405 dù trang còn, PR #173). Timeout/lỗi mạng → `OSError` cho người gọi phân loại."""
    op = opener or urllib.request.build_opener(_NoRedirect)
    code = 0
    for method in ("HEAD", "GET"):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT})
        try:
            with op.open(req, timeout=timeout) as resp:
                return int(resp.status)
        except urllib.error.HTTPError as e:
            code = e.code
        if code not in RETRY_GET_CODES and not (400 <= code < 500 and code not in GONE_CODES):
            break
    return code


def check_url(
    url: str,
    fetch: Fetcher,
    *,
    retries: int = 2,
    timeout: float = 15.0,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[str, str]:
    """(loại, chi tiết). Chỉ lỗi tạm và 429 được thử lại (tối đa `retries` lần, lùi 1 s, 2 s, …); 403/404/3xx thì không."""
    category, detail = "transient", "timeout/lỗi mạng"
    for attempt in range(retries + 1):
        if attempt:
            sleep(float(2 ** (attempt - 1)))
        try:
            status = fetch(url, timeout)
        except OSError as e:  # URLError, TimeoutError, ConnectionError… đều là OSError
            category, detail = "transient", f"timeout/lỗi mạng ({type(e).__name__})"
            continue
        category, detail = classify_status(status), f"HTTP {status}"
        if category != "transient" and status != 429:
            break
    return category, detail


def check_external(
    root: Path,
    fetch: Fetcher,
    *,
    retries: int = 2,
    timeout: float = 15.0,
    workers: int = 8,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, list[str]]:
    """Kiểm mọi URL ngoài; trả {loại: ["file:dòng: url — chi tiết", …]} (chỉ loại có mục, `ok` bỏ qua)."""
    urls = external_urls(root)

    def one(url: str) -> tuple[str, str]:
        return check_url(url, fetch, retries=retries, timeout=timeout, sleep=sleep)

    report: dict[str, list[str]] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for url, (category, detail) in zip(sorted(urls), pool.map(one, sorted(urls)), strict=True):
            if category != "ok":
                report.setdefault(category, []).append(f"{urls[url]}: {url} — {detail}")
    return report


EXTERNAL_LABELS = (
    ("dead", "✗ chết (sửa/bỏ link)"),
    ("moved", "! đã đổi (cập nhật URL)"),
    ("transient", "! lỗi tạm sau khi thử lại (kiểm lại lần sau)"),
    ("unverified", "? chưa xác minh (trang chặn bot/đòi đăng nhập, 401/403/429)"),
)


def run_external(root: Path, retries: int, timeout: float) -> int:
    report = check_external(root, http_status, retries=retries, timeout=timeout)
    for key, label in EXTERNAL_LABELS:
        for line in report.get(key, []):
            print(f"{label}: {line}")
    dead = len(report.get("dead", []))
    if dead:
        print(f"\n{dead} liên kết ngoài chết.")
        return 1
    print("✓ Không có liên kết ngoài chết (cảnh báo ở trên chỉ để theo dõi).")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Kiểm liên kết Markdown nội bộ, hoặc URL ngoài với --external.")
    ap.add_argument("root", nargs="?", default=None, help="gốc repo (mặc định: gốc của script)")
    ap.add_argument("--external", action="store_true", help="kiểm URL http(s) thay vì link nội bộ (cần mạng)")
    ap.add_argument("--retries", type=int, default=2, help="số lần thử lại lỗi tạm/429 (mặc định 2)")
    ap.add_argument("--timeout", type=float, default=15.0, help="giây mỗi yêu cầu (mặc định 15)")
    args = ap.parse_args(sys.argv[1:] if argv is None else argv)
    root = Path(args.root).resolve() if args.root else ROOT
    if args.external:
        return run_external(root, max(0, args.retries), args.timeout)
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
