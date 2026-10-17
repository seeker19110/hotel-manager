#!/usr/bin/env python3
"""xt.py — công cụ dòng lệnh của khung X-Templates (chỉ dùng thư viện chuẩn Python >= 3.11).

Lệnh:
  validate                      Kiểm quy ước toàn khung (frontmatter, ID, liên kết, hồ sơ/gói ngành).
  list [profiles|industries|modules]
  compose --profile P [--industry I ...] [--scale S|M|L] [--include-may] [--add MODULE ...] [--out FILE] [--full]
                                Ghép baseline + hồ sơ + gói ngành thành BLUEPRINT.md (MUST theo quy mô) + <tên>-BACKLOG.md
                                (SHOULD/MAY) cho dự án; --full: một file như trước ADR-0012.
  blueprint-status FILE [--strict]
                                Đếm mục đạt/chưa/miễn; --strict: còn MUST chưa đạt -> exit 1.
  loop init --plan FILE [--blueprint FILE] [--max-iterations N] [--hours H] [--single-session]
  loop status [--json]          Verdict máy tính từ PLAN + bằng chứng (không do model tự khai).
  loop record --task T-001 -- <lệnh...>
                                Chạy lệnh kiểm của task, ghi bằng chứng (exit code, thời gian, đuôi output).
  loop block --reason TEXT      Đánh dấu BLOCKED (điểm dừng an toàn — cần người, mọi việc còn lại phụ thuộc nó).
  loop defer --task ID --reason TEXT
                                Việc cần người: bỏ qua, làm việc khác; hết việc → verdict done-pending-human.
  loop checkpoint               Dùng cho PreCompact hook: ghi vị trí làm việc vào state trước khi nén (luôn exit 0).
  loop decide --question Q --option A --option B --choice N --why W --revert R [--prod TEXT] [--log FILE]
                                Phiên chính tự duyệt điểm quyết định, ghi D-NNN vào docs/autopilot/DECISIONS.md.
  loop resume [--reason TEXT]   Người đã xử lý → bỏ BLOCKED, đặt lại đếm lỗi lặp, giữ số vòng/bằng chứng.
  loop stop [--reason TEXT]     Tắt vòng lặp.
  loop hook-stop                Dùng cho Stop hook của Claude Code: đọc JSON stdin, quyết định cho dừng hay chạy tiếp.
  progress-check [FILE]         PROGRESS.md: ≤ 8 KB, đúng 4 mục, SHA ở Bàn giao phiên là tổ tiên HEAD và có trên nhánh chính.
  ci-check [DIR]                Fitness function cho workflow CI (permissions, ghim SHA, timeout, continue-on-error, secret trên PR).
  audit plan [--blueprint F] [--status F] [--json]
                                Dò stack → nhóm audit áp dụng/rút gọn/N/A, công cụ có/thiếu, bằng chứng blueprint cũ, nhóm cần quét lại.
  audit check STATUS [--strict] Kiểm sổ docs/ops/AUDIT-STATUS.md; --strict = Definition of Complete (0 🔴/🟠 mở, mọi nhóm đã quét).
  feedback add --kind K --id ID --symptom S --fix F [--repro R] [--suggest X]
                                Dự án đích ghi lỗi do khung + cách khắc phục → docs/xtemplates-feedback/FB-NNN.md.
  feedback collect [--blueprint F]
                                Tự gom MUST bị miễn và lý do autopilot bị chặn thành FB-NNN (không trùng).
  feedback list [DIR] [--json]  Liệt kê phản hồi.
  feedback aggregate --from DỰ_ÁN=THƯ_MỤC ... [--json]
                                Repo khung: gộp phản hồi nhiều dự án theo (loại, ID), đánh dấu đủ ngưỡng sửa.
  merge-check [--pr PR] [--pr-json F] [--json]
                                Máy quyết khi nào merge PR: merge · wait · update · fix · human · closed (exit 0 = merge).
  doctor [--fix] [--json]       Audit khung đã cài trước /autopilot (Python/git, hook + file hook, skill, AGENTS/CLAUDE,
                                xt.yaml, .gitignore, state, khung hợp lệ); --fix sửa phần an toàn, exit 1 khi còn lỗi.
  stats                         Thống kê số module/mục.

Thoát: 0 = ổn, 1 = vi phạm/chưa đạt, 2 = lỗi dùng lệnh.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import fnmatch
import hashlib
import importlib.util
import itertools
import json
import os
import posixpath
import re
import shlex
import shutil
import subprocess
import tempfile
import sys
import traceback
import unicodedata
import urllib.parse
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Set, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_FRAMEWORK = (SCRIPT_DIR.parent / "framework").resolve()

KINDS = {"method", "index", "module", "baseline", "profile", "industry", "standard", "template", "research", "progress"}
LEVELS = ("MUST", "SHOULD", "MAY")
SCALES = ("S", "M", "L")
# Trần MUST hiệu lực ở quy mô M cho mỗi module/chuẩn; phần vượt là MUST@L — ADR-0004.
MAX_MUST_AT_M = 4
REQUIRED_KEYS = ("title", "kind", "updated")

ITEM_RE = re.compile(
    r"^- \[(?P<state>[ xX~])\] `(?P<id>[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3})` "
    r"\*\*(?P<level>MUST|SHOULD|MAY)(?:@(?P<scale>[SML]))?\*\*\s+(?P<text>\S.*)$"
)
# Dòng "giống mục checklist" nhưng sai định dạng -> báo lỗi thay vì bỏ qua im lặng.
ITEM_LIKE_RE = re.compile(r"^- \[[ xX~]\] `[A-Z][A-Z0-9-]*`")
# Rộng hơn, cho BLUEPRINT/PLAN của dự án: thụt lề, ô lạ (`[-]`), thiếu backtick — dòng như vậy mà không khớp ITEM_RE/TASK_RE
# thì báo lỗi; trước đây bị bỏ qua im lặng nên xoá/sửa hỏng mục MUST vẫn ra "0 MUST mở".
LOOSE_ITEM_RE = re.compile(r"^\s*[-*+]\s*\[[^\]]{0,2}\]\s*`?(?:[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{2,}|T-\d+)\b")
MUST_COUNT_RE = re.compile(r"^\|\s*MUST\s*\|\s*(\d+)\s*\|\s*$", re.M)
FRONT_BLOCK_RE = re.compile(r"\A---\n(.*?)\n---\n", re.S)
BACKLOG_KEY_RE = re.compile(r"^backlog:[ \t]*(\S+)[ \t]*$", re.M)  # BLUEPRINT.md khai file SHOULD/MAY (ADR-0012)
# Lý do miễn trừ: `— Miễn: <lý do>` (hoặc `(Miễn: …)`) ở phần ghi chú — sau `· Nguồn:` cuối nếu có, vì chữ của mục có thể
# tự chứa "— Miễn:" (LOOP-HARNESS-007).
WAIVER_RE = re.compile(r"(?:[—–-]|\()\s*Miễn\s*:\s*[^\s)]")
# `[~]` có hai nghĩa (LOOP-STOP-024, rà stored 23 2026-10-16): `— Không áp dụng: <điều kiện>` — mục không áp vào dự án
# (agent ghi được, kiểm lại được); `— Miễn: <lý do>` — mục CÓ áp dụng mà bỏ/hoãn: ở mức MUST phải kèm lời chủ dự án
# `Duyệt: "<trích nguyên văn>" <YYYY-MM-DD>` hoặc link tới comment/issue. Im lặng không phải duyệt.
NA_RE = re.compile(r"(?:[—–-]|\()\s*Không áp dụng\s*:\s*[^\s)]")
APPROVAL_RE = re.compile(r"Duyệt\s*:\s*(?:[\"“][^\"”]{3,}[\"”]\s*\(?\d{4}-\d{2}-\d{2}|https?://\S+)")
LOOSE_NOTE_RE = re.compile(r"\s(?:[—–-]{1,2}\s*|\()(?:Bằng chứng|Miễn|Không áp dụng|Thiếu)\s*:.*$")
PLAN_SKIP_RE = re.compile(r"(?i)(?:Bỏ|Miễn|Lý do)\s*:\s*\S")
PREFIX_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
LINK_SUB_RE = re.compile(r"(\[[^\]]*\])\(([^)\s]+)\)")
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
TASK_ID_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3,}$")
SECRET_WORDS = r"(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential)"
# Tên khoá chứa bí mật: chứa SECRET_WORDS (nhìn trước rồi ăn trọn từ — `\w++` không quay lui nên tuyến tính cả với từ
# dài lặp từ khoá, AUD-CODE-009), hoặc kết thúc bằng `_pwd`/`_pass`/`_passphrase` (`MYSQL_PWD`, `DB_PASS`) hay đúng là
# `pass`/`passphrase` (AUD-CFG-008) — không bắt `PWD` (thư mục hiện tại) hay `bypass`.
SECRET_KEY = rf"(?:(?=\w*{SECRET_WORDS})\w++|\w+_(?:pwd|pass|passphrase)|pass(?:phrase)?)"
SECRET_RE = re.compile(rf"(?i)(?<!\w)({SECRET_KEY})(\s*[=:]\s*)\S+")
# Dạng bí mật phổ biến khác (AUD-CFG-001): giá trị bị thay bằng *** nhưng giữ tiền tố để còn đọc được ngữ cảnh.
SECRET_PATTERNS = (
    # Giá trị trong nháy trước (có khoảng trắng: `password: "a b"`, `--password="a b"`, `-p"a b"`), rồi mới tới dạng \S+.
    # Mỗi loại nháy một mẫu: nháy loại kia nằm trong giá trị (`"it's a b"`) và nháy chưa đóng (tới hết dòng) cũng che hết
    # (AUD-CFG-006). `(?<!\w)` neo đầu từ: không có nó `\w*` thử mọi vị trí → bậc hai trên dòng dài (reviewer #61).
    (re.compile(rf"(?im)((?<!\w)[\"']?{SECRET_KEY}[\"']?\s*[=:]\s*)\"[^\"\n]*(?:\"|$)"), r'\1"***"'),
    (re.compile(rf"(?im)((?<!\w)[\"']?{SECRET_KEY}[\"']?\s*[=:]\s*)'[^'\n]*(?:'|$)"), r"\1'***'"),
    (re.compile(r"(?i)\b(bearer|basic|token)(\s+)[A-Za-z0-9._~+/=-]{8,}"), r"\1\2***"),
    (re.compile(r"(?i)(--(?:password|passwd|token|secret|api-key)[= ])(\"[^\"]*\"|'[^']*'|\S+)"), r"\1***"),
    # AUD-CFG-002: user rỗng (`redis://:pw@`); token làm user (`https://<key>@`); `curl -u u:p`; `mysql -pPW`; JWT;
    # tiền tố khoá npm/PyPI/Hugging Face/Google/Stripe restricted.
    (re.compile(r"(://[^/\s:@]*:)[^@\s/]+@"), r"\1***@"),
    (re.compile(r"(://)[A-Za-z0-9_-]{16,}@"), r"\1***@"),
    (re.compile(r"(\s(?:-u|--user)[= ]?\s*(?!\d+:\d+\b)[^\s:]+:)\S+"), r"\1***"),  # `-u 1000:1000` = uid:gid (CFG-007)
    (re.compile(r"(\b(?:mysql|mysqldump|mariadb)\b[^\n]{0,200}?\s-p)(\"[^\"]*\"|'[^']*'|\S+)"), r"\1***"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+"), "eyJ***"),
    (re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"), r"\1***"),
    (
        re.compile(
            r"\b(gh[pousr]_|github_pat_|xox[abpr]-|sk_live_|sk_test_|rk_live_|rk_test_|sk-|glpat-|AIza)"
            r"[A-Za-z0-9_-]{8,}"
        ),
        r"\1***",
    ),
    # npm/Hugging Face/PyPI: đúng dạng khoá (độ dài, bảng chữ) — `npm_config_cache`, `hf_hub_download` là định danh
    # thường, từng bị che (AUD-CFG-007).
    (re.compile(r"\b(npm_)[A-Za-z0-9]{36}\b|\b(hf_)[A-Za-z0-9]{20,}\b|\b(pypi-AgE)[A-Za-z0-9_-]{8,}"), r"\1\2\3***"),
    (
        re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(-----END [A-Z ]*PRIVATE KEY-----|\Z)", re.S),
        "-----BEGIN PRIVATE KEY----- ***",
    ),
)


def redact(text: str) -> str:
    for rx, repl in SECRET_PATTERNS:
        text = rx.sub(repl, text)
    return SECRET_RE.sub(r"\1\2***", text)


TASK_RE = re.compile(r"^- \[(?P<state>[ xX~])\] `(?P<id>T-\d{3,})`(?P<rest>.*)$")
GATE_RE = re.compile(r"Gate:\s*`([^`]+)`")


# --------------------------------------------------------------------------- frontmatter


class FrontmatterError(ValueError):
    pass


def parse_frontmatter(text: str) -> Tuple[Dict[str, object], str, int]:
    """Trả (meta, body, số dòng của khối frontmatter). Chỉ hỗ trợ YAML phẳng của khung."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise FrontmatterError("thiếu frontmatter (dòng đầu phải là '---')")
    meta: Dict[str, object] = {}
    for i in range(1, len(lines)):
        line = lines[i]
        if line.strip() == "---":
            body = "\n".join(lines[i + 1 :])
            return meta, body, i + 1
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            raise FrontmatterError(f"dòng frontmatter {i + 1} không có dạng 'khoá: giá trị'")
        key, _, raw = line.partition(":")
        key = key.strip()
        raw = raw.strip()
        if not re.match(r"^[a-z_]+$", key):
            raise FrontmatterError(f"khoá frontmatter không hợp lệ: {key!r}")
        if key in meta:
            raise FrontmatterError(f"khoá frontmatter lặp: {key}")
        meta[key] = _parse_value(raw)
    raise FrontmatterError("frontmatter không có dòng '---' đóng")


def _parse_value(raw: str) -> object:
    if raw.startswith("[") and raw.endswith("]"):
        inner = raw[1:-1].strip()
        if not inner:
            return []
        return [_unquote(p.strip()) for p in inner.split(",") if p.strip()]
    return _unquote(raw)


def _unquote(s: str) -> str:
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return s[1:-1]
    return s


# --------------------------------------------------------------------------- model


@dataclass
class Item:
    id: str
    level: str
    scale: Optional[str]
    text: str
    state: str
    line: int


@dataclass
class Doc:
    path: Path
    rel: str  # đường dẫn tương đối từ framework/, không có .md
    meta: Dict[str, object]
    body: str
    body_offset: int
    items: List[Item] = field(default_factory=list)
    headings: List[str] = field(default_factory=list)

    @property
    def kind(self) -> str:
        return str(self.meta.get("kind", ""))

    @property
    def title(self) -> str:
        return str(self.meta.get("title", self.rel))


def _lines_outside_fences(body: str, first_no: int) -> Iterator[Tuple[int, str]]:
    """(số dòng, dòng) của thân tài liệu, bỏ dòng ``` và nội dung nằm trong code fence."""
    in_fence = False
    for n, line in enumerate(body.splitlines(), start=first_no):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
        elif not in_fence:
            yield n, line


def load_docs(root: Path) -> Tuple[List[Doc], List[str]]:
    docs: List[Doc] = []
    errors: List[str] = []
    for path in sorted(root.rglob("*.md")):
        rel = path.relative_to(root).as_posix()[:-3]
        text = path.read_text(encoding="utf-8")
        try:
            meta, body, offset = parse_frontmatter(text)
        except FrontmatterError as exc:
            errors.append(f"{rel}.md: {exc}")
            continue
        doc = Doc(path=path, rel=rel, meta=meta, body=body, body_offset=offset)
        for n, line in _lines_outside_fences(body, offset + 1):
            m = ITEM_RE.match(line)
            if m:
                doc.items.append(Item(m["id"], m["level"], m["scale"], m["text"].strip(), m["state"], n))
            elif ITEM_LIKE_RE.match(line):
                errors.append(f"{rel}.md:{n}: mục checklist sai định dạng (xem conventions.md §3): {line[:90]}")
            h = HEADING_RE.match(line)
            if h:
                doc.headings.append(h.group(2))
        docs.append(doc)
    return docs, errors


def _as_list(v: object) -> List[str]:
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
    return [str(v)]


def resolve_modules(patterns: Iterable[str], by_rel: Dict[str, Doc]) -> Tuple[List[Doc], List[str]]:
    """Mở rộng danh sách module (cho phép '*') thành Doc theo thứ tự xuất hiện, bỏ trùng."""
    out: List[Doc] = []
    missing: List[str] = []
    seen = set()
    for pat in patterns:
        if "*" in pat:
            hits = sorted(r for r in by_rel if fnmatch.fnmatch(r, pat) and not r.endswith("README"))
            if not hits:
                missing.append(pat)
        else:
            hits = [pat] if pat in by_rel else []
            if not hits:
                missing.append(pat)
        for r in hits:
            if r not in seen and by_rel[r].kind in ("module", "baseline", "standard"):
                seen.add(r)
                out.append(by_rel[r])
    return out, missing


# --------------------------------------------------------------------------- validate


def _check_frontmatter(d: Doc, where: str) -> List[str]:
    """Khoá bắt buộc, `kind` hợp lệ, `updated` dạng ngày, thân bắt đầu bằng tiêu đề `# ...`."""
    errors = [f"{where}: thiếu khoá frontmatter '{key}'" for key in REQUIRED_KEYS if not d.meta.get(key)]
    if d.kind and d.kind not in KINDS:
        errors.append(f"{where}: kind không hợp lệ '{d.kind}'")
    upd = str(d.meta.get("updated", ""))
    if upd and not DATE_RE.match(upd):
        errors.append(f"{where}: 'updated' phải dạng YYYY-MM-DD")
    if not d.headings or not d.body.lstrip().startswith("#"):
        errors.append(f"{where}: nội dung phải bắt đầu bằng tiêu đề '# ...' ngay sau frontmatter")
    return errors


def _check_prefix(d: Doc, where: str, prefixes: Dict[str, str]) -> List[str]:
    """`prefix` bắt buộc khi có mục, đúng dạng, không trùng file khác (ghi nhận vào `prefixes`)."""
    errors: List[str] = []
    prefix = d.meta.get("prefix")
    if d.items:
        if not prefix:
            errors.append(f"{where}: có mục checklist nhưng thiếu 'prefix'")
        elif not PREFIX_RE.match(str(prefix)):
            errors.append(f"{where}: prefix '{prefix}' không hợp lệ")
    if prefix:
        p = str(prefix)
        if p in prefixes and prefixes[p] != where:
            errors.append(f"{where}: prefix '{p}' đã dùng ở {prefixes[p]}")
        prefixes[p] = where
    return errors


def _check_items(d: Doc, where: str, ids: Dict[str, str]) -> List[str]:
    """Từng mục checklist: ID duy nhất toàn khung (ghi nhận vào `ids`), khớp prefix, trạng thái, `→ Kiểm:`, ngưỡng quy mô."""
    errors: List[str] = []
    prefix = d.meta.get("prefix")
    for it in d.items:
        at = f"{where}:{it.line}"
        if it.id in ids:
            errors.append(f"{at}: ID trùng {it.id} (đã có ở {ids[it.id]})")
        ids[it.id] = at
        # fullmatch: prefix SEC và SEC-AUTH đều hợp lệ, nhưng ID SEC-AUTH-001 phải thuộc file SEC-AUTH, không phải file SEC.
        if prefix and not re.fullmatch(re.escape(str(prefix)) + r"-\d{3}", it.id):
            errors.append(f"{at}: ID {it.id} không khớp prefix '{prefix}'")
        if it.state != " ":
            errors.append(f"{at}: mục trong khung phải ở trạng thái '[ ]'")
        if it.level == "MUST" and "→ Kiểm:" not in it.text:
            errors.append(f"{at}: mục MUST {it.id} thiếu '→ Kiểm:'")
        if it.scale and it.level != "MUST":
            errors.append(f"{at}: ngưỡng quy mô '@{it.scale}' chỉ dùng với MUST")
    return errors


def _check_must_cap(d: Doc, where: str) -> List[str]:
    """module/standard: số MUST hiệu lực ở quy mô M không vượt trần (ADR-0004)."""
    n_m = sum(effective_level(it, "M", d.kind) == "MUST" for it in d.items)
    if d.kind in ("module", "standard") and n_m > MAX_MUST_AT_M:
        return [f"{where}: {n_m} MUST hiệu lực ở quy mô M, trần {MAX_MUST_AT_M} — hạ phần vượt thành MUST@L"]
    return []


def _check_sections(d: Doc, where: str) -> List[str]:
    """module/baseline/profile/industry: có `## Checklist` (khi có mục) và `## Nguồn`."""
    if d.kind not in ("module", "baseline", "profile", "industry"):
        return []
    errors: List[str] = []
    if d.items and not any("Checklist" in h for h in d.headings):
        errors.append(f"{where}: thiếu mục '## Checklist'")
    if not any(h.strip().startswith("Nguồn") for h in d.headings):
        errors.append(f"{where}: thiếu mục '## Nguồn'")
    return errors


def _check_applies_to(d: Doc, where: str, profile_slugs: Set[str]) -> List[str]:
    """module/baseline/standard: có `applies_to`, mỗi slug là `all` hoặc hồ sơ có thật."""
    if d.kind not in ("module", "baseline", "standard"):
        return []
    at = _as_list(d.meta.get("applies_to"))
    if not at:
        return [f"{where}: thiếu 'applies_to'"]
    unknown = [a for a in at if a != "all" and a not in profile_slugs]
    if unknown and profile_slugs:
        return [f"{where}: applies_to có slug hồ sơ không tồn tại: {', '.join(unknown)}"]
    return []


def _check_slug_modules(d: Doc, where: str, slugs: Dict[Tuple[str, str], str], by_rel: Dict[str, Doc]) -> List[str]:
    """profile/industry: có `slug` không trùng trong cùng loại (ghi nhận vào `slugs`); mọi module ở `modules` tồn tại."""
    if d.kind not in ("profile", "industry"):
        return []
    errors: List[str] = []
    slug = d.meta.get("slug")
    if not slug:
        errors.append(f"{where}: thiếu 'slug'")
    else:
        slug_key = (d.kind, str(slug))
        if slug_key in slugs:
            errors.append(f"{where}: slug '{slug}' trùng với {slugs[slug_key]}")
        slugs[slug_key] = where
    _, missing = resolve_modules(_as_list(d.meta.get("modules")), by_rel)
    errors.extend(f"{where}: module '{m}' trong 'modules' không tồn tại" for m in missing)
    return errors


def _check_links(d: Doc, where: str) -> List[str]:
    """Liên kết nội bộ tương đối (ngoài code fence) phải trỏ tới file có thật."""
    errors: List[str] = []
    for n, line in _lines_outside_fences(d.body, d.body_offset + 1):
        for target in LINK_RE.findall(line):
            if re.match(r"^[a-z][a-z0-9+.-]*:", target) or target.startswith("#"):
                continue
            path_part = target.split("#", 1)[0]  # không rỗng: target bắt đầu bằng `#` đã bỏ qua ở trên
            if not (d.path.parent / path_part).resolve().exists():
                errors.append(f"{where}:{n}: liên kết hỏng -> {target}")
    return errors


def _check_readmes(root: Path) -> List[str]:
    """Mỗi thư mục con của framework/ phải có README.md (chỉ mục)."""
    return [
        f"{sub.relative_to(root).as_posix()}/: thiếu README.md (chỉ mục thư mục)"
        for sub in sorted(p for p in root.rglob("*") if p.is_dir())
        if not (sub / "README.md").exists()
    ]


def validate(root: Path) -> List[str]:
    """Kiểm quy ước toàn khung. Thứ tự lỗi: lỗi nạp file → từng file (theo thứ tự các nhóm kiểm) → README thư mục."""
    docs, errors = load_docs(root)
    by_rel = {d.rel: d for d in docs}
    ids: Dict[str, str] = {}
    prefixes: Dict[str, str] = {}
    slugs: Dict[Tuple[str, str], str] = {}
    profile_slugs = {str(d.meta.get("slug")) for d in docs if d.kind == "profile"}

    for d in docs:
        where = f"{d.rel}.md"
        errors += _check_frontmatter(d, where)
        errors += _check_prefix(d, where, prefixes)
        errors += _check_items(d, where, ids)
        errors += _check_must_cap(d, where)
        errors += _check_sections(d, where)
        errors += _check_applies_to(d, where, profile_slugs)
        errors += _check_slug_modules(d, where, slugs, by_rel)
        errors += _check_links(d, where)
    return errors + _check_readmes(root)


# --------------------------------------------------------------------------- compose

# Ở quy mô S chỉ "sàn" là bắt buộc: baseline + hồ sơ + gói ngành. MUST của module chuyên sâu
# (kind module/standard) hạ thành SHOULD — xem ADR-0003 và 00-method/lifecycle.md.
FLOOR_KINDS = ("baseline", "profile", "industry")


def effective_level(item: Item, scale: str, doc_kind: str = "baseline") -> str:
    if item.level != "MUST":
        return item.level
    if item.scale and SCALES.index(scale) < SCALES.index(item.scale):
        return "SHOULD"
    if scale == "S" and doc_kind not in FLOOR_KINDS:
        return "SHOULD"
    return item.level


def find_by_slug(docs: List[Doc], kind: str, slug: str) -> Optional[Doc]:
    for d in docs:
        if d.kind == kind and str(d.meta.get("slug")) == slug:
            return d
    return None


def _pick_sources(docs: List[Doc], profile: str, industries: List[str]) -> Tuple[Doc, List[Doc]]:
    """Hồ sơ + các gói ngành theo slug; không có thì thoát kèm gợi ý lệnh `list`."""
    prof = find_by_slug(docs, "profile", profile)
    if prof is None:
        raise SystemExit(f"Không có hồ sơ '{profile}'. Xem: xt.py list profiles")
    inds: List[Doc] = []
    for s in industries:
        ind = find_by_slug(docs, "industry", s)
        if ind is None:
            raise SystemExit(f"Không có gói ngành '{s}'. Xem: xt.py list industries")
        inds.append(ind)
    return prof, inds


def _applies(d: Doc, profile: str, extra_rels: Set[str]) -> bool:
    """Module có áp dụng cho hồ sơ không? `--add` là lựa chọn có chủ đích của người dùng → bỏ lọc `applies_to`."""
    if d.rel in extra_rels:
        return True
    at = _as_list(d.meta.get("applies_to"))
    return not at or "all" in at or profile in at


def _compose_order(docs: List[Doc], profile: str, prof: Doc, inds: List[Doc], extra: List[str]) -> List[Doc]:
    """Thứ tự ghép: baseline → module (hồ sơ, ngành, `--add`) → hồ sơ → ngành; bỏ trùng, lọc `applies_to`."""
    by_rel = {d.rel: d for d in docs}
    baseline = sorted((d for d in docs if d.kind == "baseline"), key=lambda d: d.rel)
    patterns: List[str] = []
    for src in [prof, *inds]:
        patterns.extend(_as_list(src.meta.get("modules")))
    patterns.extend(extra)
    mods, missing = resolve_modules(patterns, by_rel)
    bad_extra = [m for m in missing if m in extra]
    if bad_extra:
        raise SystemExit("Module --add không tồn tại: " + ", ".join(bad_extra) + " (xem: xt.py list modules)")

    extra_rels = {d.rel for d in resolve_modules(extra, by_rel)[0]}
    ordered: List[Doc] = []
    seen = set()
    for d in [*baseline, *mods, prof, *inds]:
        if d.rel in seen:
            continue
        if d.kind in ("module", "baseline", "standard") and not _applies(d, profile, extra_rels):
            continue
        seen.add(d.rel)
        ordered.append(d)
    return ordered


def _compose_sections(
    root: Path, ordered: List[Doc], scale: str, include_may: bool, levels: Tuple[str, ...] = LEVELS
) -> Tuple[List[str], Dict[str, int]]:
    """Mỗi tài liệu có mục thành một phần `### tiêu đề` + danh sách mục ở mức hiệu lực theo quy mô; đếm theo mức.
    `levels`: chỉ in mục ở các mức này (đếm vẫn đủ); phần không còn mục nào thì bỏ."""
    counts = {lv: 0 for lv in LEVELS}
    sections: List[str] = []
    for d in ordered:
        rows = []
        for it in d.items:
            lv = effective_level(it, scale, d.kind)
            if lv == "MAY" and not include_may:
                continue
            counts[lv] += 1
            if lv in levels:
                rows.append(f"- [ ] `{it.id}` **{lv}** {_rebase_links(it.text, d.rel, _rel_link(root))}")
        if not rows:
            continue
        link = f"{_rel_link(root)}/{d.rel}.md"
        sections.append(f"### {d.title}\n\nNguồn khung: [`{d.rel}.md`]({link})\n\n" + "\n".join(rows))
    return sections, counts


def _compose_header(
    profile: str,
    ind_slugs: List[str],
    extra: List[str],
    scale: str,
    today: str,
    counts: Dict[str, int],
    include_may: bool,
    link_root: str,
    backlog: Optional[str] = None,
) -> List[str]:
    """Frontmatter + đầu trang + bảng đếm mục của BLUEPRINT.md (các dòng, chưa nối). `backlog`: tên file SHOULD/MAY."""
    ind_names = ", ".join(ind_slugs) or "(không)"
    # xt.py nằm cạnh framework/ theo cùng gốc liên kết: dự án đích `.xtemplates/scripts/xt.py`, repo khung `scripts/xt.py`.
    xt_cmd = posixpath.join(posixpath.dirname(link_root), "scripts", "xt.py")
    header = [
        "---",
        "title: Blueprint dự án",
        "kind: blueprint",
        f"profile: {profile}",
        f"industries: [{', '.join(ind_slugs)}]",
        f"extra: [{', '.join(extra)}]",
        f"scale: {scale}",
        f"generated: {today}",
        *([f"backlog: {backlog}"] if backlog else []),
        "---",
        "",
        "# Blueprint dự án",
        "",
        f"> Sinh bởi `xt.py compose` ngày {today} — hồ sơ **{profile}**, ngành **{ind_names}**, quy mô **{scale}**.",
        "> Trạng thái: `[ ]` chưa · `[x]` đạt (kèm bằng chứng ở PR/CI) · `[~]` kèm `— Không áp dụng: <điều kiện>` hoặc",
        '> `— Miễn: <lý do>` (MUST thêm `Duyệt: "<lời chủ dự án>" <ngày>` hoặc link — LOOP-STOP-024).',
        f"> Kiểm tiến độ: `python3 {xt_cmd} blueprint-status BLUEPRINT.md --strict` (còn MUST chưa đạt → exit 1).",
        *(
            [
                f"> File này chỉ chứa MUST ở quy mô {scale}; SHOULD/MAY ở [`{backlog}`]({backlog}) — không chặn verdict,"
                " `blueprint-status` đọc cả hai, ghép lại thì mục chuyển file theo ID (ADR-0012)."
            ]
            if backlog
            else []
        ),
        "",
        "| Mức | Số mục |",
        "|---|---|",
        f"| MUST | {counts['MUST']} |",
        f"| SHOULD | {counts['SHOULD']} |",
    ]
    if include_may:
        header.append(f"| MAY | {counts['MAY']} |")
    header.append("")
    return header


def compose(
    root: Path,
    profile: str,
    industries: List[str],
    scale: str,
    include_may: bool,
    today: Optional[str] = None,
    extra: Optional[List[str]] = None,
) -> str:
    extra = extra or []
    ordered, ind_slugs = _compose_sources(root, profile, industries, extra)
    today = today or _dt.date.today().isoformat()
    sections, counts = _compose_sections(root, ordered, scale, include_may)
    header = _compose_header(profile, ind_slugs, extra, scale, today, counts, include_may, _rel_link(root))
    return "\n".join(header) + "\n" + "\n\n".join(sections) + "\n"


def _compose_sources(root: Path, profile: str, industries: List[str], extra: List[str]) -> Tuple[List[Doc], List[str]]:
    """Tài liệu theo thứ tự ghép + slug gói ngành; khung lỗi/hồ sơ lạ → SystemExit."""
    docs, errors = load_docs(root)
    if errors:
        raise SystemExit("Khung có lỗi, chạy 'xt.py validate' trước:\n  " + "\n  ".join(errors[:20]))
    prof, inds = _pick_sources(docs, profile, industries)
    return _compose_order(docs, profile, prof, inds, extra), [str(i.meta.get("slug")) for i in inds]


def compose_split(
    root: Path,
    profile: str,
    industries: List[str],
    scale: str,
    include_may: bool,
    today: Optional[str] = None,
    extra: Optional[List[str]] = None,
    backlog_name: str = "BLUEPRINT-BACKLOG.md",
) -> Tuple[str, str]:
    """ADR-0012: (BLUEPRINT.md chỉ MUST hiệu lực ở quy mô, backlog SHOULD/MAY). Agent đọc file chính mỗi vòng; quy mô
    chỉ đổi nhãn nên bản một file nặng như nhau ở S/M/L (web-app + ecommerce ~690 KB), MUST ở S chỉ ~40 KB."""
    extra = extra or []
    ordered, ind_slugs = _compose_sources(root, profile, industries, extra)
    today = today or _dt.date.today().isoformat()
    link_root = _rel_link(root)
    must, counts = _compose_sections(root, ordered, scale, include_may, ("MUST",))
    rest, _ = _compose_sections(root, ordered, scale, include_may, ("SHOULD", "MAY"))
    header = _compose_header(profile, ind_slugs, extra, scale, today, counts, include_may, link_root, backlog_name)
    bl_header = [
        "---",
        "title: Blueprint dự án — backlog SHOULD/MAY",
        "kind: blueprint-backlog",
        f"scale: {scale}",
        f"generated: {today}",
        "---",
        "",
        "# Blueprint dự án — backlog SHOULD/MAY",
        "",
        f"> Sinh cùng blueprint chính bởi `xt.py compose` ngày {today}, quy mô **{scale}** (ADR-0012). Mục ở đây không",
        "> chặn verdict; làm khi còn ngân sách. Trạng thái như blueprint chính: `[x]` đạt kèm bằng chứng · `[~]` miễn",
        "> trừ ghi `— Miễn: <lý do>` / `— Không áp dụng: <điều kiện>`. Đổi quy mô thì ghép lại: mục chuyển file theo ID.",
        "",
        "| Mức | Số mục |",
        "|---|---|",
        f"| SHOULD | {counts['SHOULD']} |",
        *([f"| MAY | {counts['MAY']} |"] if include_may else []),
        "",
    ]
    main = "\n".join(header) + "\n" + "\n\n".join(must) + "\n"
    return main, "\n".join(bl_header) + "\n" + "\n\n".join(rest) + "\n"


def _note_segment(line: str) -> str:
    """Phần ghi chú của dòng mục: sau `· Nguồn:` cuối (chữ của mục có thể tự chứa "— Miễn:"), không có thì cả dòng."""
    i = line.rfind("· Nguồn:")
    return line[i:] if i >= 0 else line


def _carried_note(old_line: str, new_line: str) -> str:
    """Ghi chú dự án thêm sau chữ của mục: chữ không đổi → giữ NGUYÊN phần đuôi (mọi định dạng); chữ đổi → tìm ghi chú
    `— Bằng chứng/Miễn/Thiếu:` (cả `-`, `–`, `(Miễn: …)`) trong phần ghi chú."""
    old_body, new_body = old_line[5:], new_line[5:]
    if old_body.startswith(new_body):
        return old_body[len(new_body) :]
    seg = _note_segment(old_line)
    nm = LOOSE_NOTE_RE.search(seg)
    return nm.group(0) if nm else ""


def carry_states(old: str, new: str, framework_ids: Optional[Set[str]] = None) -> Tuple[str, int]:
    """Chuyển ô trạng thái + ghi chú (— Bằng chứng/Miễn/Thiếu: …) từ blueprint cũ sang bản ghép mới theo ID.
    Có `framework_ids`: mục cũ có ID KHÔNG thuộc khung (mục riêng của dự án) được giữ nguyên ở cuối, không mất im lặng."""
    prev: Dict[str, Tuple[str, str]] = {}
    for line in unicodedata.normalize("NFC", old).splitlines():
        m = ITEM_RE.match(line)
        if m:
            prev[m["id"]] = (m["state"], line)
    kept, lines, new_ids = 0, [], set()
    for line in new.splitlines():
        m = ITEM_RE.match(line)
        if m:
            new_ids.add(m["id"])
        if m and m["id"] in prev:
            state, old_line = prev[m["id"]]
            note = _carried_note(old_line, line)
            if (state, note) != (" ", ""):
                line = f"- [{state}]{line[5:]}{note}"
                kept += 1
        lines.append(line)
    own = [ln for i, (_, ln) in prev.items() if framework_ids is not None and i not in new_ids | framework_ids]
    if own:
        lines += ["", "## Mục riêng của dự án (giữ từ bản trước khi ghép lại)", "", *own]
    return "\n".join(lines) + "\n", kept


def _rebase_links(text: str, doc_rel: str, link_root: str) -> str:
    """Liên kết tương đối trong mục (tính từ file module) -> tính từ BLUEPRINT.md qua link_root."""
    base = posixpath.dirname(doc_rel)

    def sub(m: "re.Match[str]") -> str:
        target = m.group(2)
        if re.match(r"^[a-z][a-z0-9+.-]*:", target) or target.startswith(("#", "/")):
            return m.group(0)
        return f"{m.group(1)}({link_root}/{posixpath.normpath(posixpath.join(base, target))})"

    return LINK_SUB_RE.sub(sub, text)


def _rel_link(root: Path) -> str:
    """Đường dẫn tới framework/ để đặt trong blueprint (ưu tiên vị trí cài trong dự án)."""
    return os.environ.get("XT_FRAMEWORK_LINK", ".xtemplates/framework")


# --------------------------------------------------------------------------- blueprint-status


def blueprint_backlog(path: Path, raw: str) -> Optional[Path]:
    """File SHOULD/MAY khai ở frontmatter `backlog:` của blueprint (ADR-0012), tính từ thư mục của blueprint."""
    fm = FRONT_BLOCK_RE.match(raw)
    m = BACKLOG_KEY_RE.search(fm[1]) if fm else None
    return path.parent / m[1] if m else None


def blueprint_files(path: Path) -> List[Path]:
    """Blueprint + file backlog nó khai (nếu có) — mọi file mang mục có trạng thái/bằng chứng."""
    try:
        bl = blueprint_backlog(path, path.read_text(encoding="utf-8"))
    except OSError:
        return [path]
    return [path, bl] if bl else [path]


def blueprint_status(path: Path) -> Dict[str, Any]:
    """Đếm blueprint + backlog nó khai; khai mà mất file → `bad_lines` (mục SHOULD/MAY không được mất im lặng)."""
    raw = path.read_text(encoding="utf-8")
    s = blueprint_status_text(raw)
    bl = blueprint_backlog(path, raw)
    if bl is None:
        return s
    if not bl.is_file():
        s["bad_lines"].append(f"thiếu file backlog {bl.name} khai ở frontmatter")
        return s
    b = blueprint_status_text(bl.read_text(encoding="utf-8"), where=f"{bl.name} ")
    for lv in LEVELS:
        for k, v in b["levels"][lv].items():
            s["levels"][lv][k] += v
    for key in ("open_must", "bad_waivers", "bad_lines"):
        s[key] += b[key]
    return s


def blueprint_status_text(raw: str, where: str = "") -> Dict[str, Any]:
    total = {lv: {"open": 0, "done": 0, "waived": 0} for lv in LEVELS}
    bad_waivers: List[str] = []
    open_must: List[str] = []
    bad_lines: List[str] = []
    text = unicodedata.normalize("NFC", raw)
    for n, line in enumerate(text.splitlines(), start=1):
        m = ITEM_RE.match(line)
        if not m:
            if LOOSE_ITEM_RE.match(line):  # ô lạ/thụt lề/thiếu backtick: không đếm được → không được coi là "không có"
                bad_lines.append(f"{where}dòng {n}: {line.strip()[:60]}")
            continue
        st = m["state"]
        lv = m["level"]
        if st == " ":
            total[lv]["open"] += 1
            if lv == "MUST":
                open_must.append(m["id"])
        elif st == "~":
            total[lv]["waived"] += 1
            seg = _note_segment(line)
            if not (WAIVER_RE.search(seg) or NA_RE.search(seg)):
                bad_waivers.append(f"{m['id']} ({where}dòng {n})")
            elif lv == "MUST" and not NA_RE.search(seg) and not APPROVAL_RE.search(seg):
                bad_waivers.append(f"{m['id']} ({where}dòng {n}: MUST `Miễn` thiếu `Duyệt:` của chủ dự án)")
        else:
            total[lv]["done"] += 1
    hm = MUST_COUNT_RE.search(text)
    expected = int(hm.group(1)) if hm else None
    counted = sum(total["MUST"].values())
    if expected is not None and counted < expected:  # mục MUST bị xoá khỏi file: bảng đầu trang vẫn nhớ tổng
        bad_lines.append(f"chỉ thấy {counted}/{expected} mục MUST so với bảng đầu trang (mục bị xoá?)")
    return {"levels": total, "open_must": open_must, "bad_waivers": bad_waivers, "bad_lines": bad_lines}


# --------------------------------------------------------------------------- loop (autopilot)


PROJECT_MARKERS = (".autopilot", "xt.yaml", ".xtemplates")
PENDING_HUMAN = "done-pending-human"  # verdict: mọi việc tự làm được đã xong, còn việc `loop defer` chờ người
ASKING_MODES = ("default", "plan", "acceptEdits")  # permission_mode khiến phiên đứng chờ người bấm duyệt
DEFER_ID_RE = re.compile(r"^(?:T-\d{3,}|[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3})$")  # task PLAN hoặc ID mục blueprint


def project_dir() -> Path:
    """Gốc dự án, theo thứ tự: `CLAUDE_PROJECT_DIR` (hook luôn đặt) → cha của `.xtemplates/` khi đây là bản cài
    (`<gốc>/.xtemplates/scripts/xt.py`, như dev-task.sh) → thư mục cha gần nhất (tính cả cwd) có dấu hiệu khung
    (`.autopilot`/`xt.yaml`/`.xtemplates`) → thư mục cha gần nhất có `.git` → cwd (AUD-XFEAT-001).
    Dấu hiệu khung xét trước `.git` để repo git lồng (submodule, apps/web) không thắng gốc dự án."""
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        return Path(env).resolve()
    if SCRIPT_DIR.parent.name == ".xtemplates":
        return SCRIPT_DIR.parent.parent.resolve()
    cwd = Path(os.getcwd()).resolve()
    chain = (cwd, *cwd.parents)
    for markers in (PROJECT_MARKERS, (".git",)):
        hit = next((d for d in chain if any((d / m).exists() for m in markers)), None)
        if hit:
            return hit
    return cwd


def state_dir(base: Optional[Path] = None) -> Path:
    return (base or project_dir()) / ".autopilot"


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def _read_json_obj(p: Path) -> Optional[Dict[str, Any]]:
    """Đọc file JSON là object; thiếu, hỏng hoặc không phải object → None (fail-open)."""
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def read_state(base: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    return _read_json_obj(state_dir(base) / "state.json")


def write_atomic(path: Path, text: str) -> None:
    """Ghi file qua tệp tạm rồi đổi tên: lỗi giữa chừng không để lại file dở."""
    path.parent.mkdir(parents=True, exist_ok=True)
    # Tên tạm ngẫu nhiên, tạo độc quyền (O_EXCL): không đi theo symlink đặt sẵn, hai tiến trình không đè nhau (AUD-HAR-009).
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def write_state(state: Dict[str, Any], base: Optional[Path] = None) -> None:
    write_atomic(state_dir(base) / "state.json", json.dumps(state, ensure_ascii=False, indent=2) + "\n")


def parse_plan(path: Path) -> List[Dict[str, Any]]:
    tasks = []
    for line in path.read_text(encoding="utf-8").splitlines():
        m = TASK_RE.match(line)
        if not m:
            continue
        g = GATE_RE.search(m["rest"])
        tasks.append(
            {
                "id": m["id"],
                "state": m["state"].lower(),
                "gate": g.group(1) if g else None,
                "title": m["rest"].strip(" —-")[:120],
                "rest": m["rest"],
            }
        )
    return tasks


def read_evidence(task_id: str, base: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    return _read_json_obj(state_dir(base) / "evidence" / f"{task_id}.json")


def _verdict_loop_state(st: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Trạng thái vòng lặp: chưa bật / bị chặn / lỗi lặp / hết ngân sách (vòng, hạn) → verdict dừng; ổn thì None."""
    if not st.get("active"):
        fv = st.get("final_verdict")
        if isinstance(fv, dict) and fv.get("verdict"):  # phiên sau thấy vòng trước kết thúc thế nào (vd chờ người)
            return {"verdict": "inactive", "reason": f"vòng lặp đã kết thúc — {fv['verdict']}: {fv.get('reason', '')}"}
        return {"verdict": "inactive", "reason": "vòng lặp chưa bật"}
    if st.get("blocked"):
        return {"verdict": "blocked", "reason": st.get("blocked_reason", "cần người quyết định")}
    if st.get("same_failure_count", 0) >= st.get("max_same_failure", 3):
        return {
            "verdict": "blocked",
            "reason": f"cùng một lỗi lặp {st.get('same_failure_count')} lần ({st.get('last_failure_task')}) — dừng để người xem",
        }
    if st.get("iterations", 0) >= st.get("max_iterations", 50):
        return {"verdict": "budget", "reason": f"đã chạm trần {st.get('max_iterations')} vòng"}
    deadline = st.get("deadline")
    if deadline and now_iso() > deadline:
        return {"verdict": "budget", "reason": f"quá hạn {deadline}"}
    return None


def _deferred(st: Dict[str, Any]) -> Dict[str, Any]:
    """`loop defer`: {ID: {"reason", "at"}} — việc chờ người, vòng lặp bỏ qua để làm việc khác (ADR-0009)."""
    d = st.get("deferred")
    return d if isinstance(d, dict) else {}


def _evidence_time_problem(ev: Optional[Dict[str, Any]]) -> str:
    """Bằng chứng ghi tay (AUD-HAR-024): thời điểm kết thúc ở tương lai hoặc trước lúc bắt đầu → không tin."""
    if not ev:
        return ""
    raw_s, raw_f = str(ev.get("started") or ""), str(ev.get("finished") or "")
    started, finished = _parse_iso(raw_s), _parse_iso(raw_f)
    if (raw_s and started is None) or (raw_f and finished is None):
        return f"có thời điểm không đọc được ({raw_s or '—'} → {raw_f or '—'})"
    if finished and finished > _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(minutes=5):
        return f"có thời điểm kết thúc ở tương lai ({raw_f})"
    if started and finished and finished < started:
        return f"có thời điểm kết thúc ({raw_f}) trước lúc bắt đầu ({raw_s})"
    return ""


def _evidence_before(ev: Dict[str, Any], started: str) -> bool:
    """Bằng chứng kết thúc trước `loop init` — so thời điểm, không so chuỗi (offset khác nhau, AUD-CODE-008)."""
    raw = str(ev.get("finished") or "")
    if not started or not raw:
        return bool(started)  # không ghi lúc kết thúc → coi là cũ
    fin, init = _parse_iso(raw), _parse_iso(started)
    return fin is not None and init is not None and fin < init  # không đọc được → `_evidence_time_problem` báo


def _parse_iso(text: str) -> Optional[_dt.datetime]:
    """ISO 8601 → datetime có múi giờ (không ghi múi = UTC) để so đúng giữa các offset; không đọc được → None."""
    try:
        d = _dt.datetime.fromisoformat(text.replace("Z", "+00:00")) if text else None
    except ValueError:
        return None
    return d.replace(tzinfo=_dt.timezone.utc) if d and d.tzinfo is None else d


def _verdict_task(
    t: Dict[str, Any], base: Path, deferred: Dict[str, Any], started: str = ""
) -> Optional[Dict[str, Any]]:
    """Một task trong PLAN: chưa làm → continue (trừ khi đang chờ người); đã tick mà thiếu/lệch/cũ bằng chứng → verify;
    bỏ `[~]` phải ghi lý do; ổn thì None. `started`: lúc `loop init` — bằng chứng cũ hơn là của vòng trước (PLAN cũ)."""
    if t["state"] == " " and t["id"] in deferred:
        return None
    if t["state"] == " ":
        return {"verdict": "continue", "task": t["id"], "reason": f"làm task {t['id']}: {t['title']}"}
    if t["state"] != "x":
        if PLAN_SKIP_RE.search(t["rest"]):
            return None
        return {"verdict": "verify", "task": t["id"], "reason": f"task {t['id']} bỏ `[~]` mà không ghi `— Bỏ: <lý do>`"}
    ev = read_evidence(t["id"], base)
    if ev is not None and _evidence_before(ev, started):
        return {
            "verdict": "verify",
            "task": t["id"],
            "reason": f"bằng chứng {t['id']} có từ trước lần loop init này (vòng/PLAN trước) — chạy lại loop record",
        }
    odd = _evidence_time_problem(ev)
    if odd:
        return {"verdict": "verify", "task": t["id"], "reason": f"bằng chứng {t['id']} {odd} — chạy lại loop record"}
    if ev is None or ev.get("exit_code") != 0:
        return {
            "verdict": "verify",
            "task": t["id"],
            "reason": f"task {t['id']} đã tick nhưng chưa có bằng chứng xanh — chạy: xt.py loop record --task {t['id']} -- <lệnh kiểm>",
        }
    if not t["gate"]:
        return {
            "verdict": "verify",
            "task": t["id"],
            "reason": f"task {t['id']} không có Gate máy kiểm — thêm `Gate:` + lệnh trong backtick vào PLAN rồi `loop record`",
        }
    if not same_command(ev.get("cmd") or "", redact(t["gate"])):  # bằng chứng lưu lệnh đã che bí mật
        return {
            "verdict": "verify",
            "task": t["id"],
            "reason": f"task {t['id']} khai Gate `{t['gate']}` nhưng bằng chứng chạy lệnh khác",
        }
    return None


def _verdict_plan(base: Path, st: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """PLAN phải có và có task; task đầu tiên chưa ổn quyết định verdict; mọi task ổn thì None."""
    plan = base / st.get("plan", "docs/autopilot/PLAN.md")
    if not plan.exists():
        return {"verdict": "blocked", "reason": f"không thấy PLAN: {plan}"}
    tasks = parse_plan(plan)
    if not tasks:
        return {"verdict": "blocked", "reason": "PLAN không có task dạng - [ ] `T-001` ..."}
    bad = [
        f"dòng {n}"
        for n, ln in enumerate(plan.read_text(encoding="utf-8").splitlines(), start=1)
        if LOOSE_ITEM_RE.match(ln) and not TASK_RE.match(ln)
    ]
    if bad:  # thụt lề/thiếu backtick/ID lạ: task bị bỏ qua im lặng thì vòng lặp khai "xong" sớm
        return {
            "verdict": "verify",
            "reason": "PLAN có dòng task sai định dạng (cần - [ ] `T-NNN` …): " + ", ".join(bad[:5]),
        }
    deferred = _deferred(st)
    for t in tasks:
        v = _verdict_task(t, base, deferred, str(st.get("started") or ""))
        if v:
            return v
    return None


def _verdict_blueprint(base: Path, st: Dict[str, Any]) -> Dict[str, Any]:
    """Mọi task đã ổn: còn MUST mở / miễn trừ thiếu lý do trong blueprint → continue, không thì done."""
    bp = st.get("blueprint")
    bpp = base / bp if bp else None
    if bpp is None or not bpp.exists():
        # Không khai "blueprint sạch" khi không hề kiểm blueprint (loop init thiếu --blueprint hoặc file mất).
        why = "không kiểm blueprint: loop init không có --blueprint" if bpp is None else f"không thấy blueprint {bp}"
        return {"verdict": "done", "reason": f"mọi task có bằng chứng xanh ({why})"}
    s = blueprint_status(bpp)
    open_must = [i for i in s["open_must"] if i not in _deferred(st)]
    if open_must:
        return {
            "verdict": "continue",
            "task": open_must[0],
            "reason": f"còn {len(open_must)} mục MUST của blueprint chưa đạt (đầu tiên: {open_must[0]})",
        }
    if s["bad_waivers"]:
        return {"verdict": "continue", "reason": "mục miễn trừ không hợp lệ: " + ", ".join(s["bad_waivers"][:5])}
    if s["bad_lines"]:
        return {
            "verdict": "continue",
            "reason": "blueprint có dòng mục sai định dạng: " + "; ".join(s["bad_lines"][:3]),
        }
    return {"verdict": "done", "reason": "mọi task có bằng chứng xanh và blueprint không còn MUST mở"}


def loop_verdict(base: Optional[Path] = None) -> Dict[str, Any]:
    """Tính verdict CHỈ từ artifact trên đĩa. Model không tự khai 'xong'."""
    base = base or project_dir()
    st = read_state(base) or {}  # không có state ≡ chưa bật: `_verdict_loop_state` trả inactive
    v = _verdict_loop_state(st) or _verdict_plan(base, st) or _verdict_blueprint(base, st)
    return _with_pending_human(v, base, st) if v["verdict"] == "done" else v


def _still_open(base: Path, st: Dict[str, Any]) -> set[str]:
    """ID còn mở: task `[ ]` trong PLAN + MUST mở trong blueprint (nếu có)."""
    ids = {t["id"] for t in parse_plan(base / st.get("plan", "docs/autopilot/PLAN.md")) if t["state"] == " "}
    bp = st.get("blueprint")
    if bp and (base / bp).exists():
        ids.update(blueprint_status(base / bp)["open_must"])
    return ids


def _with_pending_human(v: Dict[str, Any], base: Path, st: Dict[str, Any]) -> Dict[str, Any]:
    """Mọi việc tự làm được đã xong nhưng còn việc `loop defer` chưa xong → `done-pending-human` (gom một lần cho người)."""
    deferred = _deferred(st)
    if not deferred:
        return v
    open_ids = _still_open(base, st)
    pending = [{"id": i, "reason": d.get("reason", "") if isinstance(d, dict) else ""} for i, d in deferred.items()]
    pending = [p for p in pending if p["id"] in open_ids]
    if not pending:
        return v
    items = "; ".join(f"{p['id']} ({p['reason']})" for p in pending)
    return {
        "verdict": PENDING_HUMAN,
        "reason": f"mọi việc tự làm được đã xong; chờ người {len(pending)} việc: {items}",
        "pending_human": pending,
    }


def failure_signature(task: str, code: int, output: str) -> str:
    tail = "\n".join(output.strip().splitlines()[-20:])
    norm = re.sub(r"\d+", "N", tail)  # bỏ số dòng/thời gian để cùng lỗi ra cùng chữ ký
    return hashlib.sha256(f"{task}|{code}|{norm}".encode()).hexdigest()[:16]


def same_command(a: str, b: str) -> bool:
    """So lệnh theo token shell (nháy/khoảng trắng khác nhau vẫn là cùng lệnh)."""
    try:
        return shlex.split(a) == shlex.split(b)
    except ValueError:
        return a.strip() == b.strip()


def _record_timeout() -> Optional[int]:
    try:
        return int(os.environ.get("XT_RECORD_TIMEOUT", "1800"))
    except ValueError:
        print("✗ XT_RECORD_TIMEOUT phải là số giây nguyên dương", file=sys.stderr)
        return None


def run_gate_shell(cmd_str: str, base: Path, timeout: int) -> Tuple[int, str]:
    """Chạy lệnh Gate: bash -o pipefail, không phải /bin/sh của shell=True — `test | tee log` phải đỏ khi test đỏ
    (sh lấy exit của lệnh cuối ống nên từng ghi bằng chứng exit 0 cho Gate đỏ — xanh giả, FB từ dự án đích)."""
    try:
        proc = subprocess.run(
            ["bash", "-o", "pipefail", "-c", cmd_str], cwd=base, capture_output=True, text=True, timeout=timeout
        )
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired as exc:
        return 124, f"timeout: {exc}"
    except FileNotFoundError:
        return 127, "bash: không có trong PATH — loop record cần bash (như hook và dev-task.sh)"


VERIFIED_FILE = "verified.json"
FINGERPRINT_MAX_FILE = 10 * 1024 * 1024  # file chưa track lớn hơn: chỉ tính tên + kích thước


def tree_fingerprint(base: Path) -> Optional[str]:
    """sha256 của cây làm việc: HEAD + diff so HEAD + tên/nội dung file chưa track (trừ `.autopilot/`). Không phải repo
    git → None (không kiểm được, bỏ qua kiểm cuối)."""
    head = _git(base, "rev-parse", "HEAD")
    if head.returncode != 0:
        return None
    excl = ":(exclude).autopilot"
    h = hashlib.sha256(head.stdout.encode())
    h.update(_git(base, "diff", "HEAD", "--binary", "--", ".", excl).stdout.encode())
    for name in _git(base, "ls-files", "--others", "--exclude-standard", "-z", "--", ".", excl).stdout.split("\0"):
        f = base / name
        if not name or not f.is_file():
            continue
        h.update(name.encode() + b"\0")
        size = f.stat().st_size
        h.update(f.read_bytes() if size <= FINGERPRINT_MAX_FILE else str(size).encode())
    return h.hexdigest()


def loop_verify(base: Optional[Path] = None) -> int:
    """Kiểm lại cuối (LOOP-DESIGN-022): chạy lại MỌI Gate của task đã tick trên cây hiện tại, một lần cho mỗi lệnh,
    ghi `.autopilot/verified.json` kèm dấu vân tay cây. Stop hook chỉ nhận `done` khi file này xanh và khớp cây: bắt cả
    bằng chứng sửa tay lẫn task sau làm hỏng Gate của task trước."""
    base = base or project_dir()
    timeout = _record_timeout()
    if timeout is None:
        return 2
    st = read_state(base) or {}
    plan = base / st.get("plan", "docs/autopilot/PLAN.md")
    tasks = [t for t in parse_plan(plan) if t["state"] == "x" and t["gate"]] if plan.exists() else []
    before = tree_fingerprint(base)
    results: List[Dict[str, Any]] = []
    for t in tasks:
        if any(same_command(t["gate"], r["gate"]) for r in results):
            continue
        code, out = run_gate_shell(t["gate"], base, timeout)
        tail = redact("\n".join(out.strip().splitlines()[-20:]))
        results.append({"task": t["id"], "gate": t["gate"], "exit_code": code, "output_tail": tail})
        print(f"[xt] verify {t['id']}: exit {code}")
    after = tree_fingerprint(base)
    stable = before == after
    ok = stable and all(r["exit_code"] == 0 for r in results)
    for r in results:
        r["gate"] = redact(r["gate"])
    rec = {"fingerprint": after, "ok": ok, "stable": stable, "finished": now_iso(), "results": results}
    d = state_dir(base)
    d.mkdir(parents=True, exist_ok=True)
    write_atomic(d / VERIFIED_FILE, json.dumps(rec, ensure_ascii=False, indent=2) + "\n")
    if not stable:
        print("✗ Gate làm đổi cây làm việc (format/sinh file?) — commit thay đổi rồi chạy lại `loop verify`")
    print(f"[xt] kiểm lại cuối: {'XANH' if ok else 'ĐỎ'} ({len(results)} Gate) — .autopilot/{VERIFIED_FILE}")
    return 0 if ok else 1


def final_check(base: Path) -> Optional[str]:
    """Lý do chưa được dừng vì chưa kiểm lại cuối trên cây hiện tại; None nếu đã xanh và khớp (hoặc không phải git)."""
    fp = tree_fingerprint(base)
    if fp is None:
        return None
    rec = _read_json_obj(state_dir(base) / VERIFIED_FILE) or {}
    if rec.get("fingerprint") == fp and rec.get("ok") is True:
        return None
    if rec.get("fingerprint") == fp:
        red = [str(r.get("task")) for r in rec.get("results", []) if isinstance(r, dict) and r.get("exit_code") != 0]
        return "kiểm lại cuối ĐỎ (" + (", ".join(red) or "cây đổi khi chạy Gate") + ") — sửa rồi chạy lại `loop verify`"
    return (
        "mọi task có bằng chứng nhưng chưa kiểm lại cuối trên cây hiện tại — chạy "
        "`python3 .xtemplates/scripts/xt.py loop verify` (chạy lại mọi Gate một lần; LOOP-DESIGN-022)"
    )


def loop_record(task: str, cmd: List[str], base: Optional[Path] = None) -> int:
    base = base or project_dir()
    st = read_state(base) or {}
    timeout = _record_timeout()
    if timeout is None:
        return 2
    started = now_iso()
    # Một đối số = chuỗi shell nguyên văn (cho phép `a && b`, ống); nhiều đối số = argv, ghép bằng shlex để giữ nháy (AUD-HAR-002).
    cmd_str = cmd[0] if len(cmd) == 1 else shlex.join(cmd)
    code, out = run_gate_shell(cmd_str, base, timeout)
    ev: Dict[str, Any] = {
        "task": task,
        "cmd": redact(cmd_str),
        "exit_code": code,
        "started": started,
        "finished": now_iso(),
        "head": _git_head(base),
        "output_tail": redact("\n".join(out.strip().splitlines()[-40:])),
    }
    d = state_dir(base) / "evidence"
    d.mkdir(parents=True, exist_ok=True)
    write_atomic(d / f"{task}.json", json.dumps(ev, ensure_ascii=False, indent=2) + "\n")
    if st:
        if code == 0:
            st["same_failure_count"] = 0
            st["last_failure_signature"] = None
        else:
            sig = failure_signature(task, code, out)
            if sig == st.get("last_failure_signature"):
                st["same_failure_count"] = st.get("same_failure_count", 0) + 1
            else:
                st["same_failure_count"] = 1
                st["last_failure_signature"] = sig
            st["last_failure_task"] = task
        write_state(st, base)
    print(f"[xt] {task}: exit {code} — bằng chứng: .autopilot/evidence/{task}.json")
    if code != 0:
        print(ev["output_tail"][-2000:])
    return code


def _git_head(base: Path) -> Optional[str]:
    try:
        r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=base, capture_output=True, text=True, timeout=10)
        return (r.stdout.strip() or None) if r.returncode == 0 else None  # repo chưa commit: không ghi "HEAD" giả
    except (OSError, subprocess.TimeoutExpired):
        return None


def _payload_field(text: str, key: str) -> Optional[str]:
    """Một trường chuỗi trong stdin JSON của hook; thiếu/hỏng → None (fail-open)."""
    try:
        data = json.loads(text or "{}")
    except json.JSONDecodeError:
        return None
    val = data.get(key) if isinstance(data, dict) else None
    return val if isinstance(val, str) else None


def _mode_warning(mode: Optional[str]) -> str:
    if mode not in ASKING_MODES:
        return ""
    return (
        f" ⚠ Phiên ở chế độ hỏi quyền `{mode}`: người vắng thì phiên đứng chờ — chạy autopilot bằng "
        "`claude --permission-mode auto` (settings dự án không đặt được chế độ này)."
    )


def _stop_reason(st: Dict[str, Any], v: Dict[str, Any], mode: Optional[str]) -> str:
    one = (
        " Chế độ một phiên: context đầy thì để compaction tự nén (PreCompact ghi checkpoint), không bàn giao; "
        "chỉ bàn giao khi gần trần vòng/giờ."
        if st.get("single_session")
        else ""
    )
    return (
        f"[autopilot vòng {st['iterations']}/{st.get('max_iterations', 50)}] Chưa xong: {v['reason']}. "
        "Làm tiếp theo PLAN; chạy `python3 .xtemplates/scripts/xt.py loop record --task <ID> -- <lệnh kiểm>` "
        "để ghi bằng chứng; commit+push sau mỗi task. Quyết định chuyên môn: tự duyệt bằng `xt.py loop decide`. "
        "Việc cần người (điểm dừng về hành động): `xt.py loop defer --task <ID> --reason ...` rồi làm việc khác; "
        "chỉ `xt.py loop block --reason ...` khi mọi việc còn lại đều phụ thuộc nó." + one + _mode_warning(mode)
    )


def hook_stop(stdin_text: str, base: Optional[Path] = None) -> Tuple[str, int]:
    """Quyết định của Stop hook. Trả (stdout JSON hoặc '', exit code). Luôn fail-open khi có lỗi.
    Verdict chỉ dựa vào file trên đĩa; từ stdin chỉ lấy `permission_mode` để cảnh báo phiên sẽ đứng chờ hỏi quyền."""
    base = base or project_dir()
    v = loop_verdict(base)
    st = read_state(base)
    if st and st.get("active") and v["verdict"] in ("done", PENDING_HUMAN):
        why = final_check(base)
        v = {"verdict": "verify", "reason": why} if why else v
    mode = _payload_field(stdin_text, "permission_mode")
    if st and mode:
        st["permission_mode"] = mode
    if v["verdict"] in ("continue", "verify") and st:
        st["iterations"] = st.get("iterations", 0) + 1
        st["last_verdict"] = v
        write_state(st, base)
        return json.dumps({"decision": "block", "reason": _stop_reason(st, v, mode)}, ensure_ascii=False), 0
    if st and st.get("active") and v["verdict"] in ("done", "blocked", "budget", PENDING_HUMAN):
        st["active"] = False
        st["ended"] = now_iso()
        st["final_verdict"] = v
        write_state(st, base)
    return "", 0


# --------------------------------------------------------------------------- progress-check

PROGRESS_MAX_BYTES = 8192
PROGRESS_SECTIONS = ("Đang làm", "Tiếp theo", "Quyết định", "Bàn giao phiên")
SHA_TOKEN_RE = re.compile(r"`([0-9a-fA-F]{7,40})`")
FENCE_RE = re.compile(r"^\s*(```|~~~)")


GIT_TIMEOUT = 60  # giây; git treo (ổ mạng, khoá index) không được làm treo cổng — BASE-ERR-004


def _git(cwd: Path, *args: str) -> "subprocess.CompletedProcess[str]":
    cmd = ["git", "-C", str(cwd), *args]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=GIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, "", f"git quá {GIT_TIMEOUT} s")


def progress_sections(text: str) -> List[Tuple[str, List[str]]]:
    """Các mục `## ` (bỏ qua heading trong code fence ``` / ~~~) cùng dòng thân của từng mục."""
    sections: List[Tuple[str, List[str]]] = []
    fence: Optional[str] = None
    for line in text.splitlines():
        m = FENCE_RE.match(line)
        if m and (fence is None or m.group(1) == fence):
            fence = None if fence else m.group(1)
        if fence is None and not m and line.startswith("## "):
            name = re.sub(r"\s+#+\s*$", "", line[3:]).strip()  # bỏ dấu # đóng kiểu ATX
            sections.append((unicodedata.normalize("NFC", name), []))
        elif sections:
            sections[-1][1].append(line)
    return sections


def progress_base_ref(repo: Path) -> Optional[str]:
    """Nhánh chính để kiểm SHA bàn giao còn sống sau squash-merge.

    `XT_PROGRESS_BASE` (rỗng = tắt) > `origin/HEAD` > `origin/main` > `origin/master`; không có thì bỏ qua.
    """
    env = os.environ.get("XT_PROGRESS_BASE")
    if env is not None:
        return env.strip() or None
    head = _git(repo, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD").stdout.strip()
    for ref in (head, "origin/main", "origin/master"):
        if ref and _git(repo, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").returncode == 0:
            return ref
    return None


def _progress_reachable(repo: Path, sha: str) -> bool:
    """SHA là tổ tiên của HEAD — hoặc của một đầu trong file MERGE_HEAD khi đang merge (kể cả octopus), vì commit
    merge sẽ chứa nó (AUD-HAR-020). Đọc file thay vì tên ref để nhánh/tag tên `MERGE_HEAD` không lọt."""
    heads = ["HEAD"]
    merge_head = repo / _git(repo, "rev-parse", "--git-path", "MERGE_HEAD").stdout.strip()
    if merge_head.is_file():
        heads += merge_head.read_text(encoding="utf-8").split()
    return any(_git(repo, "merge-base", "--is-ancestor", sha, ref).returncode == 0 for ref in heads)


def progress_check(path: Path) -> List[str]:
    """Luật PROGRESS.md (mẫu templates/PROGRESS.md): ≤ 8 KB, đúng 4 mục, SHA bàn giao là tổ tiên HEAD
    (hoặc MERGE_HEAD khi đang merge) và nằm trên nhánh chính (squash-merge xoá SHA của nhánh PR → nhánh chính đỏ sau merge).

    Trả danh sách vi phạm; ném OSError khi không đọc được file hoặc không chạy được git.
    """
    raw = path.read_bytes()
    errors: List[str] = []
    if len(raw) > PROGRESS_MAX_BYTES:
        errors.append(f"{len(raw)} byte > {PROGRESS_MAX_BYTES} — chuyển lịch sử sang CHANGELOG.md/docs/")
    sections = progress_sections(raw.decode("utf-8", errors="replace"))
    names = tuple(n for n, _ in sections)
    if names != PROGRESS_SECTIONS:
        errors.append(
            "mục `## ` phải đúng thứ tự "
            + " · ".join(PROGRESS_SECTIONS)
            + "; đang có: "
            + (" · ".join(names) or "(không có)")
        )
    handover = next((body for n, body in sections if n == PROGRESS_SECTIONS[-1]), None)
    if handover is None:
        return errors
    shas = list(dict.fromkeys(m.group(1).lower() for line in handover for m in SHA_TOKEN_RE.finditer(line)))
    if not shas:
        errors.append("mục Bàn giao phiên không ghi SHA commit (dạng `abc1234`)")
        return errors
    repo = path.resolve().parent
    if _git(repo, "rev-parse", "--git-dir").returncode != 0:
        raise OSError(f"không phải repo git: {repo}")
    shallow = _git(repo, "rev-parse", "--is-shallow-repository").stdout.strip() == "true"
    hint = " (clone nông — CI cần checkout `fetch-depth: 0`)" if shallow else ""
    base = progress_base_ref(repo)
    for sha in shas:
        if _git(repo, "rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}").returncode != 0:
            errors.append(f"SHA `{sha}` không phải commit có trong lịch sử{hint}")
        elif not _progress_reachable(repo, sha):
            errors.append(f"SHA `{sha}` không phải tổ tiên của HEAD (squash/rebase làm mất?){hint}")
        elif base and _git(repo, "merge-base", "--is-ancestor", sha, base).returncode != 0:
            errors.append(
                f"SHA `{sha}` chưa nằm trên `{base}` — squash-merge sẽ làm nhánh chính đỏ; "
                f"ghi SHA đã có trên nhánh chính (`git fetch` nếu `{base}` cũ)"
            )
    return errors


# --------------------------------------------------------------------------- ci-check

# Khoá đầu dòng (`- uses:`) hoặc trong flow mapping (`- {uses: ..., continue-on-error: true}`).
KEY_AT = r"(?:^\s*(?:-\s+)?|[{,]\s*)"
USES_RE = re.compile(KEY_AT + r"uses:\s*['\"]?([^'\"\s#,}]+)")
COE_RE = re.compile(KEY_AT + r"continue-on-error:\s*([^#,}]*)")
WRITE_ALL_RE = re.compile(KEY_AT + r"permissions:\s*['\"]?write-all")
PINNED_RE = re.compile(r"@[0-9a-f]{40}$")
DOCKER_PINNED_RE = re.compile(r"@sha256:[0-9a-f]{64}$")
BLOCK_SCALAR_RE = re.compile(r":\s*[|>][-+0-9]*\s*(?:#.*)?$")
CI_ALLOW = "ci-check-allow:"
ON_KEY_RE = re.compile(r"""^['"]?on['"]?\s*:""")
PR_TRIGGER_RE = re.compile(r"(?<![\w-])pull_request(?:_target)?(?![\w-])")
# `secrets.X` (X khác GITHUB_TOKEN), `secrets[...]`, `toJSON(secrets)`, `secrets: inherit`.
SECRET_REF_RE = re.compile(
    r"\bsecrets\.(?!GITHUB_TOKEN\b)[A-Za-z_]|\bsecrets\[|\(\s*secrets\s*\)|^\s*(?:-\s+)?secrets:\s*inherit\b"
)


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _allowed(line: str) -> bool:
    """Ngoại lệ có chủ đích: comment `# ci-check-allow: <lý do>` trên cùng dòng (lý do bắt buộc)."""
    _, sep, reason = line.partition(CI_ALLOW)
    return bool(sep) and bool(reason.strip())


def _ci_lines(text: str) -> List[Tuple[int, str]]:
    """(số dòng, dòng) có nghĩa: bỏ dòng trống, comment và nội dung block scalar (`run: |`)."""
    lines: List[Tuple[int, str]] = []
    scalar_indent: Optional[int] = None
    for no, line in enumerate(text.splitlines(), 1):
        if scalar_indent is not None:
            if not line.strip() or _indent(line) > scalar_indent:
                continue
            scalar_indent = None
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        lines.append((no, line))
        if BLOCK_SCALAR_RE.search(line):
            scalar_indent = _indent(line)
    return lines


def _ci_unpinned_error(no: int, code: str) -> Optional[str]:
    """`uses:` ngoài chưa ghim: action ghim SHA 40 ký tự, `docker://` ghim `@sha256:`; `./local` miễn."""
    m = USES_RE.search(code)
    ref = m.group(1) if m else ""
    if ref.startswith("docker://"):
        return None if DOCKER_PINNED_RE.search(ref) else f"dòng {no}: `{ref}` chưa ghim digest `@sha256:`"
    if ref and not ref.startswith("./") and not PINNED_RE.search(ref):
        return f"dòng {no}: `{ref}` chưa ghim SHA 40 ký tự"
    return None


def _ci_line_errors(no: int, line: str) -> List[str]:
    """Luật theo dòng: `write-all`, `continue-on-error`, `uses:` chưa ghim (trừ dòng có `# ci-check-allow: <lý do>`)."""
    if _allowed(line):
        return []
    code = line.split(" #", 1)[0]
    errors: List[str] = []
    if WRITE_ALL_RE.search(code):
        errors.append(f"dòng {no}: `write-all` — khai quyền tối thiểu theo job")
    coe = COE_RE.search(code)
    if coe and coe.group(1).strip().strip("'\"") != "false":
        errors.append(f"dòng {no}: `continue-on-error` trên job/bước — ngoại lệ ghi `# {CI_ALLOW} <lý do + hạn>`")
    unpinned = _ci_unpinned_error(no, code)
    if unpinned:
        errors.append(unpinned)
    return errors


def _ci_jobs(lines: List[Tuple[int, str]]) -> List[Tuple[int, str, List[str]]]:
    """Job = khoá con trực tiếp của `jobs:`; thân job = các dòng thụt sâu hơn tới khoá job kế tiếp."""
    jobs_at = next((i for i, (_, ln) in enumerate(lines) if ln.startswith("jobs:")), None)
    if jobs_at is None:
        return []
    body = list(itertools.takewhile(lambda x: _indent(x[1]) > 0, lines[jobs_at + 1 :]))
    job_indent = _indent(body[0][1]) if body else 0
    jobs: List[Tuple[int, str, List[str]]] = []
    for no, ln in body:
        if _indent(ln) == job_indent:
            jobs.append((no, ln.strip().rstrip(":"), []))
        else:  # dòng đầu của body luôn ở job_indent nên jobs đã có phần tử
            jobs[-1][2].append(ln)
    return jobs


def _ci_timeout_errors(lines: List[Tuple[int, str]]) -> List[str]:
    """Mọi job phải có `timeout-minutes` (trừ job gọi reusable workflow bằng `uses:`)."""
    errors: List[str] = []
    for no, name, job_lines in _ci_jobs(lines):
        child = min((_indent(x) for x in job_lines), default=0)
        keys = {x.strip().split(":", 1)[0] for x in job_lines if _indent(x) == child}
        if not keys & {"uses", "timeout-minutes", "<<"}:  # `<<: *anchor` không giải được theo dòng → bỏ qua
            errors.append(f"dòng {no}: job `{name}` thiếu `timeout-minutes`")
    return errors


def _ci_on_pull_request(lines: List[Tuple[int, str]]) -> bool:
    """Khối `on:` cấp workflow có trigger `pull_request` (hoặc `pull_request_target`), mọi dạng khai (chuỗi/mảng/map)."""
    in_on = False
    for _, ln in lines:
        if _indent(ln) == 0:
            in_on = bool(ON_KEY_RE.match(ln))
        if in_on and PR_TRIGGER_RE.search(ln.split(" #", 1)[0]):
            return True
    return False


def _ci_pr_secret_errors(lines: List[Tuple[int, str]]) -> List[str]:
    """WF-CI-023: workflow chạy trên PR thì job không có `environment:` không được chạm secret ngoài `GITHUB_TOKEN`.

    Ngoại lệ có chủ đích: `# ci-check-allow: <lý do>` trên dòng đó. Chỉ thấy dòng ngoài block scalar (`run: |`).
    """
    if not _ci_on_pull_request(lines):
        return []
    errors: List[str] = []
    for jno, name, job_lines in _ci_jobs(lines):
        child = min((_indent(x) for x in job_lines), default=0)
        if any(_indent(x) == child and x.strip().startswith("environment:") for x in job_lines):
            continue
        for ln in job_lines:
            if SECRET_REF_RE.search(ln.split(" #", 1)[0]) and not _allowed(ln):
                errors.append(
                    f"job `{name}` (dòng {jno}) chạm secret ngoài `GITHUB_TOKEN` trong workflow có `pull_request` — "
                    f"chuyển sang push nhánh chính/`workflow_dispatch` hoặc job có `environment:` kèm reviewer"
                )
                break  # một lỗi mỗi job
    return errors


def ci_check_text(text: str) -> List[str]:
    """Fitness function cho một workflow GitHub Actions (đọc theo dòng, chỉ thư viện chuẩn).

    Luật: `permissions:` cấp workflow · không `write-all` · `uses:` ngoài ghim SHA 40 ký tự (`docker://` ghim `@sha256:`) ·
    mọi job có `timeout-minutes` (trừ job gọi reusable workflow) · không `continue-on-error` · workflow có `pull_request`
    thì job không `environment:` không chạm secret ngoài `GITHUB_TOKEN` (WF-CI-023).
    Bỏ qua nội dung block scalar (`run: |`) để script shell không gây báo nhầm.
    """
    lines = _ci_lines(text)
    errors: List[str] = []
    if not any(ln.startswith("permissions:") for _, ln in lines):
        errors.append("thiếu `permissions:` cấp workflow (mặc định `contents: read`)")
    for no, line in lines:
        errors += _ci_line_errors(no, line)
    return errors + _ci_timeout_errors(lines) + _ci_pr_secret_errors(lines)


def ci_check(workflows: Path) -> Dict[str, List[str]]:
    files = sorted(p for p in workflows.iterdir() if p.suffix in (".yml", ".yaml") and p.is_file())
    return {p.name: ci_check_text(p.read_bytes().decode("utf-8", errors="replace")) for p in files}


# --------------------------------------------------------------------------- audit

AUDIT_GROUPS: Tuple[Tuple[int, str, str], ...] = (
    (1, "ARCH", "Kiến trúc & ranh giới"),
    (2, "SEC", "Bảo mật"),
    (3, "CODE", "Chất lượng mã"),
    (4, "TEST", "Kiểm thử"),
    (5, "PERF", "Hiệu năng"),
    (6, "A11Y", "A11y & UX"),
    (7, "DEP", "Phụ thuộc"),
    (8, "CI", "CI/CD"),
    (9, "DOC", "Tài liệu"),
    (10, "DATA", "Dữ liệu"),
    (11, "CFG", "Cấu hình & bí mật"),
    (12, "XFEAT", "Thống nhất chéo tính năng"),
    (13, "HAR", "Harness & quy trình agent"),
)
AUDIT_CODES = {code: no for no, code, _ in AUDIT_GROUPS}
GROUP_STATES = ("chưa quét", "đã quét", "rút gọn", "N/A")
FINDING_STATES = ("mở", "đã sửa", "chấp nhận", "bác bỏ")
FINDING_LEVELS = ("🔴", "🟠", "🟢")
EVIDENCE_KINDS = ("đo được:", "suy luận:", "chưa biết:")
FINDING_ID_RE = re.compile(r"^AUD-([A-Z0-9]+)-(\d{3})$")
PLACEHOLDER_RE = re.compile(r"<[^<>\s|][^<>|]*>")

LANG_EXT = {
    "python": (".py",),
    "js/ts": (".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"),
    "go": (".go",),
    "rust": (".rs",),
    "java/kotlin": (".java", ".kt", ".kts"),
    "dotnet": (".cs", ".fs"),
    "php": (".php",),
    "ruby": (".rb",),
    "dart": (".dart",),
    "swift": (".swift",),
    "shell": (".sh", ".bash"),
}
MANIFESTS = {
    "package.json",
    "pyproject.toml",
    "setup.py",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "composer.json",
    "Gemfile",
    "pubspec.yaml",
    "Package.swift",
}
LOCKFILES = {
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "uv.lock",
    "poetry.lock",
    "Pipfile.lock",
    "go.sum",
    "Cargo.lock",
    "composer.lock",
    "Gemfile.lock",
    "pubspec.lock",
    "packages.lock.json",
}
UI_EXT = (".html", ".tsx", ".jsx", ".vue", ".svelte", ".css", ".scss")
SKIP_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".xtemplates",
    "vendor",
    "dist",
    "build",
    ".autopilot",
}

# Công cụ gợi ý theo nhóm: (tên, ngăn xếp áp dụng hoặc None = mọi repo). "xt:" = lệnh có sẵn của khung.
AUDIT_TOOLS: Dict[int, Tuple[Tuple[str, Optional[str]], ...]] = {
    1: (("lint-imports", "python"), ("depcruise", "js/ts"), ("go", "go")),
    2: (("gitleaks", None), ("semgrep", None), ("osv-scanner", None), ("bandit", "python")),
    3: (
        ("ruff", "python"),
        ("mypy", "python"),
        ("vulture", "python"),
        ("eslint", "js/ts"),
        ("biome", "js/ts"),
        ("tsc", "js/ts"),
        ("knip", "js/ts"),
        ("golangci-lint", "go"),
        ("shellcheck", "shell"),
        ("jscpd", None),
    ),
    4: (("coverage", "python"), ("pytest", "python"), ("vitest", "js/ts"), ("jest", "js/ts"), ("go", "go")),
    5: (("k6", None), ("lighthouse", "ui")),
    6: (("playwright", "ui"), ("axe", "ui")),
    7: (
        ("osv-scanner", None),
        ("pip-audit", "python"),
        ("npm", "js/ts"),
        ("govulncheck", "go"),
        ("cargo-audit", "rust"),
    ),
    8: (("xt:ci-check", None), ("actionlint", None), ("zizmor", None)),
    9: (("xt:progress-check", None), ("lychee", None)),
    11: (("gitleaks", None),),
    13: (("xt:blueprint-status", None), ("xt:progress-check", None)),
}


def split_md_row(line: str) -> List[str]:
    """Tách một dòng bảng Markdown theo `|` không thoát (`\\|` là ký tự trong ô)."""
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", s)]


def md_tables(text: str) -> Dict[str, List[Dict[str, str]]]:
    """Bảng đầu tiên dưới mỗi heading `## `: {tên heading: [dòng dạng dict theo tiêu đề cột]} (bỏ code fence)."""
    out: Dict[str, List[Dict[str, str]]] = {}
    heading: Optional[str] = None
    header: Optional[List[str]] = None
    fence: Optional[str] = None
    for line in text.splitlines():
        m = FENCE_RE.match(line)
        if m and (fence is None or m.group(1) == fence):
            fence = None if fence else m.group(1)
            continue
        if fence:
            continue
        if line.startswith("## "):
            heading, header = unicodedata.normalize("NFC", line[3:].strip()), None
            continue
        if heading is None or (heading in out and header is None):
            continue
        if not line.lstrip().startswith("|"):
            if header is not None:  # hết bảng: chỉ lấy bảng đầu tiên của mỗi heading
                header, heading = None, None
            continue
        cells = split_md_row(line)
        if header is None:
            header = [unicodedata.normalize("NFC", c) for c in cells]
            out[heading] = []
        elif all(re.fullmatch(r":?-{3,}:?", c) for c in cells if c):
            continue
        else:
            out[heading].append(dict(zip(header, cells + [""] * (len(header) - len(cells)))))
    return out


def _repo_files(root: Path) -> List[str]:
    r = _git(root, "ls-files", "-z")
    if r.returncode == 0 and r.stdout:
        return [f for f in r.stdout.split("\0") if f and not set(Path(f).parts) & SKIP_DIRS]
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            files.append(os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/"))
    return files


def audit_signals(root: Path, files: Optional[List[str]] = None) -> Dict[str, Any]:
    files = _repo_files(root) if files is None else files
    names = [posixpath.basename(f) for f in files]
    langs = {}
    for lang, exts in LANG_EXT.items():
        n = sum(1 for f in files if f.endswith(exts))
        if n:
            langs[lang] = n
    ui = [f for f in files if f.endswith(UI_EXT)]
    db = [f for f in files if "/migrations/" in f"/{f}" or f.endswith((".sql", "schema.prisma", "alembic.ini"))]
    tests = [
        f
        for f in files
        if re.search(r"(^|/)(tests?|__tests__|spec)/", f)
        or re.search(r"(_test\.go|\.(test|spec)\.[jt]sx?|(^|/)test_[^/]+\.py)$", f)
    ]
    sig = {
        "files": len(files),
        "langs": langs,
        "manifests": sorted({n for n in names if n in MANIFESTS or re.match(r"requirements.*\.txt$", n)}),
        "lockfiles": sorted({n for n in names if n in LOCKFILES}),
        "ui": len(ui),
        "mobile": any(f.startswith(("android/", "ios/")) for f in files) or "pubspec.yaml" in names,
        "service": sorted(
            {
                n
                for n in names
                if n in ("Dockerfile", "compose.yaml", "docker-compose.yml", "Procfile", "serverless.yml")
            }
        ),
        "db": len(db),
        "ci": sorted(f for f in files if f.startswith(".github/workflows/") or f == ".gitlab-ci.yml"),
        "tests": len(tests),
        "iac": sum(1 for f in files if f.endswith(".tf")),
        "docs": sum(1 for f in files if f.endswith(".md")),
        "harness": sorted(n for n in ("AGENTS.md", "xt.yaml", "PROGRESS.md", "BLUEPRINT.md") if n in files)
        + ([".claude/"] if any(f.startswith(".claude/") for f in files) else []),
        "framework_repo": "framework/00-method/conventions.md" in files and "scripts/xt.py" in files,
    }
    return sig


def audit_applicability(sig: Dict[str, Any]) -> Dict[int, Tuple[str, str]]:
    code = {k: v for k, v in sig["langs"].items() if k != "shell"}
    has_code = bool(code) or bool(sig["langs"].get("shell"))
    has_ui = sig["ui"] > 0 or sig["mobile"]
    lang_txt = ", ".join(f"{k} {v}" for k, v in sig["langs"].items()) or "không có mã"
    a: Dict[int, Tuple[str, str]] = {}
    a[1] = ("áp dụng", lang_txt) if has_code else ("N/A", "không có file mã nguồn")
    a[2] = ("áp dụng", "mọi repo: secret toàn lịch sử, quyền CI, chuỗi cung ứng")
    a[3] = ("áp dụng", lang_txt) if has_code else ("N/A", "không có file mã nguồn")
    a[4] = ("áp dụng", f"{sig['tests']} file test") if has_code else ("N/A", "không có mã để test")
    if has_ui or sig["service"]:
        a[5] = ("áp dụng", "có UI/dịch vụ")
    elif has_code:
        a[5] = ("rút gọn", "không UI/dịch vụ chạy liên tục: đo thời gian lệnh chính")
    else:
        a[5] = ("N/A", "không có mã")
    a[6] = (
        ("áp dụng", f"{sig['ui']} file UI" + (", mobile" if sig["mobile"] else ""))
        if has_ui
        else ("N/A", "không có UI (*.html/*.tsx/*.jsx/*.vue/*.svelte/*.css, android/, ios/)")
    )
    if sig["manifests"] or sig["lockfiles"]:
        a[7] = (
            "áp dụng",
            "manifest: "
            + ", ".join(sig["manifests"] or ["—"])
            + "; lock: "
            + ", ".join(sig["lockfiles"] or ["không có"]),
        )
    else:
        a[7] = ("rút gọn", "không manifest/lockfile: chỉ action CI, công cụ cài trong CI, runtime")
    a[8] = (
        ("áp dụng", f"{len(sig['ci'])} workflow") if sig["ci"] else ("áp dụng", "KHÔNG có CI — bản thân là phát hiện")
    )
    a[9] = ("áp dụng", f"{sig['docs']} file .md")
    a[10] = (
        ("áp dụng", f"{sig['db']} file migration/SQL/schema")
        if sig["db"]
        else ("N/A", "không có migration/SQL/schema CSDL")
    )
    a[11] = (
        ("áp dụng", "mã/dịch vụ đọc cấu hình")
        if has_code or sig["service"]
        else ("rút gọn", "chỉ secret trong file/lịch sử")
    )
    a[12] = ("áp dụng", "nhiều module/tính năng") if has_code else ("N/A", "không có mã")
    if sig["harness"]:
        a[13] = ("áp dụng", ", ".join(sig["harness"]) + (" · repo khung" if sig["framework_repo"] else ""))
    else:
        a[13] = ("N/A", "chưa cài harness khung (không AGENTS.md/xt.yaml/.claude/)")
    return a


def _tool_present(root: Path, name: str) -> bool:
    if name.startswith("xt:"):
        return True
    if shutil.which(name) or (root / "node_modules" / ".bin" / name).exists():
        return True
    return name in ("coverage", "pytest", "mypy", "ruff", "vulture", "bandit", "pip-audit") and bool(
        importlib.util.find_spec(name.replace("-", "_"))
    )


def audit_tools(root: Path, sig: Dict[str, Any], appl: Dict[int, Tuple[str, str]]) -> Dict[int, Dict[str, List[str]]]:
    stacks = set(sig["langs"]) | ({"ui"} if sig["ui"] or sig["mobile"] else set())
    out: Dict[int, Dict[str, List[str]]] = {}
    for no, tools in AUDIT_TOOLS.items():
        if appl[no][0] == "N/A":
            continue
        rel = [t for t, st in tools if st is None or st in stacks]
        if rel:
            out[no] = {
                "có": [t for t in rel if _tool_present(root, t)],
                "thiếu": [t for t in rel if not _tool_present(root, t)],
            }
    return out


EVIDENCE_REF_RE = re.compile(r"(?<![\w/.-])((?:[\w.-]+/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,5})(?::\d+(?:[-,]\d+)*)?")


def _resolve_ref(ref: str, files: List[str]) -> Optional[str]:
    if ref in files:
        return ref
    hits = [f for f in files if f.endswith("/" + ref)]
    return hits[0] if len(hits) == 1 else None


def _line_written_at(root: Path, rel_bp: str, no: int) -> Optional[int]:
    """Epoch commit của dòng `no` trong blueprint (git blame); None khi chưa commit hoặc không blame được."""
    blame = _git(root, "blame", "-L", f"{no},{no}", "--porcelain", "--", rel_bp)
    t = re.search(r"^committer-time (\d+)$", blame.stdout, re.M)
    if blame.returncode != 0 or not t or blame.stdout.startswith("0000000"):
        return None
    return int(t.group(1))


def _files_changed_after(root: Path, refs: Iterable[str], written: int, mtime_cache: Dict[str, int]) -> List[str]:
    """Trong `refs` (đã sắp), file có commit mới nhất muộn hơn `written`; `mtime_cache` giữ thời gian đã hỏi git."""
    changed = []
    for ref in refs:
        if ref not in mtime_cache:
            ct = _git(root, "log", "-1", "--format=%ct", "--", ref).stdout.strip()
            mtime_cache[ref] = int(ct) if ct.isdigit() else 0
        if mtime_cache[ref] > written:
            changed.append(ref)
    return changed


def blueprint_stale_evidence(root: Path, blueprint: Path, files: List[str]) -> List[Dict[str, Any]]:
    """Mục [x]/[~] trích file mà file đó đổi SAU commit ghi dòng bằng chứng/miễn trừ → cần xác minh lại."""
    try:
        lines = blueprint.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    rel_bp = os.path.relpath(blueprint.resolve(), root.resolve()).replace(os.sep, "/")
    mtime_cache: Dict[str, int] = {}
    out = []
    for no, line in enumerate(lines, 1):
        m = ITEM_RE.match(line)
        if not m or m.group("state") not in "xX~":
            continue
        note = re.search(r"\s—\s(Bằng chứng|Miễn|Không áp dụng):(.*)$", line)
        if not note:
            continue
        refs = {
            r for r in (_resolve_ref(x, files) for x in EVIDENCE_REF_RE.findall(note.group(2))) if r and r != rel_bp
        }
        if not refs:
            continue
        written = _line_written_at(root, rel_bp, no)
        if written is None:
            continue
        changed = _files_changed_after(root, sorted(refs), written, mtime_cache)
        if changed:
            out.append({"id": m.group("id"), "kind": note.group(1), "files": changed})
    return out


def _path_groups(path: str) -> List[int]:
    name = posixpath.basename(path)
    g: List[int] = []
    if path.startswith(".github/workflows/") or name == ".gitlab-ci.yml":
        g += [8, 2]
    if name in MANIFESTS or name in LOCKFILES or re.match(r"requirements.*\.txt$", name):
        g += [7, 2]
    if re.search(r"(^|/)(tests?|__tests__|spec)/", path) or re.search(
        r"(_test\.go|\.(test|spec)\.[jt]sx?|test_[^/]+\.py)$", path
    ):
        g.append(4)
    if "/migrations/" in f"/{path}" or path.endswith((".sql", "schema.prisma")):
        g.append(10)
    if name in ("AGENTS.md", "CLAUDE.md", "xt.yaml", "PROGRESS.md", "BLUEPRINT.md") or path.startswith(".claude/"):
        g.append(13)
    if name.startswith(".env") or name in ("Dockerfile", "compose.yaml", "docker-compose.yml"):
        g += [11, 8]
    if path.endswith(UI_EXT):
        g += [6, 5]
    if path.endswith(".md"):
        g.append(9)
    if any(path.endswith(e) for exts in LANG_EXT.values() for e in exts) and 4 not in g:
        g += [1, 2, 3, 12]
    return sorted(set(g))


def audit_status_groups(status: Path) -> Dict[int, Dict[str, str]]:
    rows = md_tables(status.read_text(encoding="utf-8")).get("Nhóm", [])
    out: Dict[int, Dict[str, str]] = {}
    for r in rows:
        if r.get("#", "").isdecimal():  # không isdigit: "²" là digit nhưng int() văng ValueError
            out[int(r["#"])] = r
    return out


def audit_rescan(root: Path, status: Path) -> Dict[int, str]:
    """Nhóm cần quét lại: chưa quét · SHA không còn trong lịch sử · có file đổi kể từ SHA quét."""
    groups = audit_status_groups(status)
    out: Dict[int, str] = {}
    for no, _, _ in AUDIT_GROUPS:
        r = groups.get(no)
        if r is None or r.get("Trạng thái") == "chưa quét":
            out[no] = "chưa quét"
            continue
        if r.get("Trạng thái") == "N/A":
            continue
        sha = r.get("SHA", "").strip("` ")
        if not sha or _git(root, "merge-base", "--is-ancestor", sha, "HEAD").returncode != 0:
            out[no] = f"SHA `{sha or '—'}` không còn là tổ tiên HEAD — quét lại từ đầu"
            continue
        changed = [
            f for f in _git(root, "diff", "--name-only", f"{sha}..HEAD").stdout.splitlines() if no in _path_groups(f)
        ]
        if changed:
            out[no] = f"{len(changed)} file đổi từ `{sha[:7]}` (vd {', '.join(changed[:3])})"
    return out


def audit_plan(root: Path, blueprint: Optional[Path] = None, status: Optional[Path] = None) -> Dict[str, Any]:
    files = _repo_files(root)
    sig = audit_signals(root, files)
    appl = audit_applicability(sig)
    plan: Dict[str, Any] = {
        "root": str(root),
        "head": (_git(root, "rev-parse", "HEAD").stdout.strip() or None),
        "signals": sig,
        "groups": [
            {"no": no, "code": code, "name": name, "state": appl[no][0], "reason": appl[no][1]}
            for no, code, name in AUDIT_GROUPS
        ],
        "tools": {str(k): v for k, v in audit_tools(root, sig, appl).items()},
        "stale_evidence": (
            [e for f in blueprint_files(blueprint) for e in blueprint_stale_evidence(root, f, files)]
            if blueprint
            else []
        ),
        "rescan": {str(k): v for k, v in audit_rescan(root, status).items()} if status and status.exists() else None,
    }
    return plan


def _sha_ok(root: Path, sha: str) -> Optional[str]:
    if not re.fullmatch(r"[0-9a-fA-F]{7,40}", sha):
        return "SHA không hợp lệ"
    if _git(root, "rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}").returncode != 0:
        return f"SHA `{sha}` không có trong lịch sử (clone nông? quét lại?)"
    if _git(root, "merge-base", "--is-ancestor", sha, "HEAD").returncode != 0:
        return f"SHA `{sha}` không phải tổ tiên HEAD — quét lại nhóm này"
    return None


def _audit_scan_errors(no: int, r: Dict[str, str], root: Path, in_git: bool) -> List[str]:
    """Nhóm đã quét/rút gọn: có Ngày quét YYYY-MM-DD và SHA (khi ở trong git, SHA phải là tổ tiên HEAD)."""
    errors: List[str] = []
    sha = r.get("SHA", "").strip("` ")
    if not DATE_RE.match(r.get("Ngày", "")):
        errors.append(f"nhóm {no}: thiếu Ngày quét YYYY-MM-DD")
    if not sha:
        errors.append(f"nhóm {no}: thiếu SHA lúc quét")
    elif in_git and (msg := _sha_ok(root, sha)):
        errors.append(f"nhóm {no}: {msg}")
    return errors


def _audit_group_row(
    r: Dict[str, str], strict: bool, root: Path, in_git: bool, seen_no: Dict[int, int], counts: Dict[str, int]
) -> List[str]:
    """Một dòng bảng `## Nhóm`: số nhóm, mã, trạng thái, ghi chú, dữ liệu quét. Ghi nhận vào `seen_no`/`counts`."""
    no_s, code, state, note = r.get("#", ""), r.get("Mã", ""), r.get("Trạng thái", ""), r.get("Ghi chú", "")
    if not no_s.isdecimal() or int(no_s) not in AUDIT_CODES.values():
        return [f"nhóm `{no_s}`: số nhóm phải 1–{len(AUDIT_GROUPS)}"]
    no = int(no_s)
    seen_no[no] = seen_no.get(no, 0) + 1
    errors: List[str] = []
    if AUDIT_CODES.get(code) != no:
        errors.append(f"nhóm {no}: mã `{code}` phải là `{AUDIT_GROUPS[no - 1][1]}`")
    if state not in GROUP_STATES:
        errors.append(f"nhóm {no}: trạng thái `{state}` không thuộc {' · '.join(GROUP_STATES)}")
        return errors
    counts[f"nhóm {state}"] = counts.get(f"nhóm {state}", 0) + 1
    if state in ("N/A", "rút gọn") and not note:
        errors.append(f"nhóm {no}: `{state}` phải ghi lý do/phạm vi ở Ghi chú")
    if state in ("đã quét", "rút gọn"):
        errors += _audit_scan_errors(no, r, root, in_git)
    if strict and state == "chưa quét":
        errors.append(f"nhóm {no}: chưa quét (--strict)")
    return errors


def _audit_group_errors(
    tables: Dict[str, List[Dict[str, str]]], strict: bool, root: Path, in_git: bool, counts: Dict[str, int]
) -> List[str]:
    """Bảng `## Nhóm`: từng dòng hợp lệ, rồi mỗi nhóm 1–N phải có đúng một dòng."""
    errors: List[str] = []
    seen_no: Dict[int, int] = {}
    for r in tables.get("Nhóm", []):
        errors += _audit_group_row(r, strict, root, in_git, seen_no, counts)
    if "Nhóm" in tables:
        for no, _, _ in AUDIT_GROUPS:
            if seen_no.get(no, 0) != 1:
                errors.append(f"nhóm {no}: phải có đúng 1 dòng (đang có {seen_no.get(no, 0)})")
    return errors


def _audit_finding_form_errors(r: Dict[str, str], where: str) -> List[str]:
    """Hình thức một phát hiện: không còn chỗ trống của mẫu, ID `AUD-<MÃ>-NNN`, mức, trạng thái, tóm tắt."""
    errors: List[str] = []
    fid, lv, st = r.get("ID", ""), r.get("Mức", ""), r.get("Trạng thái", "")
    # `<x>` trong code là nội dung thật
    if any(PLACEHOLDER_RE.search(re.sub(r"`[^`]*`", "", v)) for v in r.values()):
        errors.append(f"{where}: còn chỗ trống của mẫu `<...>`")
    m = FINDING_ID_RE.match(fid)
    if not m or m.group(1) not in AUDIT_CODES:
        errors.append(f"{where}: ID phải dạng AUD-<MÃ>-NNN với MÃ thuộc {', '.join(AUDIT_CODES)}")
    if lv not in FINDING_LEVELS:
        errors.append(f"{where}: mức `{lv}` phải là 🔴/🟠/🟢")
    if st not in FINDING_STATES:
        errors.append(f"{where}: trạng thái `{st}` không thuộc {' · '.join(FINDING_STATES)}")
    if not r.get("Tóm tắt"):
        errors.append(f"{where}: thiếu Tóm tắt")
    return errors


def _audit_finding_evidence_errors(r: Dict[str, str], where: str) -> List[str]:
    """Bằng chứng mở đầu đúng loại (🔴 không dựa trên `chưa biết:`); 🔴/🟠 chưa bác bỏ phải có Gate."""
    errors: List[str] = []
    lv, st, ev, gate = r.get("Mức", ""), r.get("Trạng thái", ""), r.get("Bằng chứng", ""), r.get("Gate", "")
    if not ev.startswith(EVIDENCE_KINDS):
        errors.append(f"{where}: Bằng chứng phải mở đầu `đo được:` / `suy luận:` / `chưa biết:`")
    elif lv == "🔴" and ev.startswith("chưa biết:") and st != "bác bỏ":
        errors.append(f"{where}: 🔴 không thể dựa trên `chưa biết:` — đo hoặc hạ mức")
    if lv in ("🔴", "🟠") and st != "bác bỏ" and not ("`" in gate or gate.startswith("tay:")):
        errors.append(f"{where}: {lv} phải có Gate (lệnh trong backtick hoặc `tay: <bước>`)")
    return errors


def _iso_date(text: str) -> Optional[_dt.date]:
    """`YYYY-MM-DD` → date; ngày không có thật (2026-13-45) → None thay vì văng ValueError."""
    try:
        return _dt.date.fromisoformat(text)
    except ValueError:
        return None


def _audit_finding_closure_errors(r: Dict[str, str], where: str, today: _dt.date) -> List[str]:
    """Trạng thái kết thúc phải kèm ghi chú: `đã sửa` có PR/SHA · `chấp nhận` có chủ + hạn chưa quá · `bác bỏ` có lý do."""
    errors: List[str] = []
    st, note = r.get("Trạng thái", ""), r.get("Ghi chú", "")
    if st == "đã sửa" and not re.search(r"#\d+|\b[0-9a-f]{7,40}\b", note):
        errors.append(f"{where}: `đã sửa` phải ghi PR (#N) hoặc SHA ở Ghi chú")
    if st == "chấp nhận":
        owner = re.search(r"chủ:\s*\S", note)
        due = re.search(r"hạn:\s*(\d{4}-\d{2}-\d{2})", note)
        due_date = _iso_date(due.group(1)) if due else None
        if not owner or not due:
            errors.append(f"{where}: `chấp nhận` phải ghi `chủ: <ai>` và `hạn: YYYY-MM-DD`")
        elif due_date is None:
            errors.append(f"{where}: hạn `{due.group(1)}` không phải ngày hợp lệ")
        elif due_date < today:
            errors.append(f"{where}: chấp nhận rủi ro đã quá hạn {due.group(1)}")
    if st == "bác bỏ" and not note:
        errors.append(f"{where}: `bác bỏ` phải ghi lý do ở Ghi chú")
    return errors


def _audit_finding_errors(
    tables: Dict[str, List[Dict[str, str]]], strict: bool, today: _dt.date, counts: Dict[str, int]
) -> List[str]:
    """Bảng `## Phát hiện`: kiểm từng dòng (hình thức → bằng chứng/Gate → kết thúc), đếm mức×trạng thái, báo ID trùng."""
    errors: List[str] = []
    ids: Dict[str, int] = {}
    for r in tables.get("Phát hiện", []):
        fid, lv, st = r.get("ID", ""), r.get("Mức", ""), r.get("Trạng thái", "")
        where = fid or "(dòng thiếu ID)"
        ids[fid] = ids.get(fid, 0) + 1
        errors += _audit_finding_form_errors(r, where)
        errors += _audit_finding_evidence_errors(r, where)
        errors += _audit_finding_closure_errors(r, where, today)
        if lv in FINDING_LEVELS and st in FINDING_STATES:
            counts[f"{lv} {st}"] = counts.get(f"{lv} {st}", 0) + 1
            if strict and st == "mở" and lv in ("🔴", "🟠"):
                errors.append(f"{where}: {lv} còn mở (--strict)")
    return errors + [f"{i}: ID trùng {n} lần" for i, n in ids.items() if i and n > 1]


def audit_check(
    status: Path, strict: bool = False, today: Optional[_dt.date] = None
) -> Tuple[List[str], Dict[str, int]]:
    """Kiểm sổ AUDIT-STATUS.md theo templates/AUDIT-STATUS.md. Trả (lỗi, đếm). Ném OSError khi không đọc được."""
    today = today or _dt.date.today()
    tables = md_tables(status.read_text(encoding="utf-8"))
    root = status.resolve().parent
    in_git = _git(root, "rev-parse", "--git-dir").returncode == 0
    counts: Dict[str, int] = {}
    errors = [f"thiếu bảng `## {name}`" for name in ("Nhóm", "Phát hiện") if name not in tables]
    errors += _audit_group_errors(tables, strict, root, in_git, counts)
    errors += _audit_finding_errors(tables, strict, today, counts)
    return errors, counts


# --------------------------------------------------------------------------- doctor (audit khung trước /autopilot)

# Hook bắt buộc cho autopilot một phiên (ADR-0002/0009): thiếu Stop = vòng không có máy kiểm; PostToolUse chỉ format.
DOCTOR_HOOK_EVENTS = {
    "SessionStart": "error",
    "PreCompact": "error",
    "PreToolUse": "error",
    "Stop": "error",
    "PostToolUse": "warn",
}
DOCTOR_SKILLS = ("autopilot", "gate", "audit", "blueprint", "research", "review", "adr", "handover")
DOCTOR_AGENTS = ("executor", "researcher", "reviewer")
DOCTOR_YAML_KEYS = ("lint", "typecheck", "test", "build")  # LOOP-HARNESS-008
HOOK_REF_RE = re.compile(r"\.claude/hooks/([\w.-]+(?:/[\w.-]+)*)")
HOOK_SIBLING_RE = re.compile(r'\$\(dirname "\$0"\)/([\w.-]+)')  # file hook nạp/gọi cạnh nó (_lib.sh, guard.py)
YAML_KEY_RE = re.compile(r"^([A-Za-z_][\w-]*):[ \t]*(.*?)[ \t]*$")
LOOP_GATE_KEYS = ("lint", "test")  # ADR-0011: trong vòng autopilot, hai khoá này rỗng/no-op thì dev-task.sh ĐỎ
GATE_NOOP_RE = re.compile(r"true|:|exit( 0)?|(echo|printf)(\s.*)?")  # khớp is_noop() trong dev-task.sh
AUTOPILOT_IGNORES = (".autopilot/", ".autopilot", "/.autopilot/", "/.autopilot")
# Công cụ memory ngoài cho coding agent (LOOP-HARNESS-021); khớp theo token trong tên plugin/MCP server.
MEMORY_TOOLS = ("engram", "claude-mem", "agentmemory", "mem0", "openmemory", "basic-memory")
MEMORY_TOOL_RE = re.compile(r"(?<![a-z0-9])(" + "|".join(re.escape(t) for t in MEMORY_TOOLS) + r")(?![a-z0-9])")
INSTALL_HINT = "người chạy lại `python3 <bản clone X-Templates>/scripts/install.py <gốc dự án>`"


@dataclass
class Finding:
    """Một phát hiện của `xt.py doctor`; `fix` là sửa an toàn, đảo ngược được (None = cần người/agent sửa tay)."""

    code: str
    level: str  # "error" | "warn"
    msg: str
    fix: Optional[Callable[[], str]] = None


def template_body(text: str) -> str:
    """Như `install.py`: bỏ frontmatter; mẫu bọc nội dung trong khối ```markdown thì chỉ lấy phần trong khối."""
    lines = text.splitlines()
    opened = bool(lines) and lines[0].strip() == "---"
    close = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None) if opened else None
    if close is not None:
        text = "\n".join(lines[close + 1 :]).lstrip("\n") + "\n"
        lines = text.splitlines()
    start = next((i for i, ln in enumerate(lines) if ln.strip() == "```markdown"), None)
    if start is None:
        return text
    end = next((i for i in range(start + 1, len(lines)) if lines[i].strip() == "```"), len(lines))
    return "\n".join(lines[start + 1 : end]).strip("\n") + "\n"


def _fix_template(base: Path, fw: Path, name: str) -> Optional[Callable[[], str]]:
    """Sửa = tạo `name` từ mẫu khung (copy-if-absent như install.py); mẫu không có → không sửa được."""
    src = fw / "templates" / name
    if not src.is_file():
        return None

    def fix() -> str:
        with (base / name).open("x", encoding="utf-8") as fh:  # "x": file vừa xuất hiện thì lỗi, không đè
            fh.write(template_body(src.read_text(encoding="utf-8")))
        return f"tạo {name} từ mẫu khung"

    return fix


def _fix_append(path: Path, block: str, what: str) -> Callable[[], str]:
    def fix() -> str:
        with path.open("a", encoding="utf-8") as fh:
            fh.write(block)
        return what

    return fix


def _fix_rename(src: Path, dst: Path, what: str) -> Callable[[], str]:
    def fix() -> str:
        src.rename(dst)
        return what

    return fix


def _doctor_runtime() -> List[Finding]:
    out = []
    if sys.version_info < (3, 11):
        out.append(Finding("runtime", "error", f"Python {sys.version.split()[0]} < 3.11 — xt.py và hook cần ≥ 3.11"))
    out += [
        Finding("runtime", "error", f"thiếu `{t}` trên PATH — hook, cổng commit và commit/push của autopilot cần nó")
        for t in ("git", "bash")
        if not shutil.which(t)
    ]
    return out


def _doctor_scripts() -> List[Finding]:
    out = []
    if not (SCRIPT_DIR / "dev-task.sh").is_file():
        out.append(
            Finding("scripts", "error", f"thiếu {SCRIPT_DIR / 'dev-task.sh'} — cổng commit không chạy; {INSTALL_HINT}")
        )
    if framework_version() == "unknown":
        out.append(
            Finding("scripts", "warn", f"thiếu file VERSION của khung — không biết bản đang cài; {INSTALL_HINT}")
        )
    return out


def _doctor_framework(fw: Path) -> List[Finding]:
    if not fw.is_dir():
        return [Finding("framework", "error", f"không thấy thư mục khung {fw}; {INSTALL_HINT}")]
    errors = validate(fw)
    if not errors:
        return []
    return [
        Finding(
            "framework",
            "error",
            f"khung lệch quy ước ({len(errors)} lỗi, vd: {errors[0]}) — xem `xt.py validate`; "
            f"bản cài `.xtemplates/` không sửa tay: {INSTALL_HINT}",
        )
    ]


def _hook_commands(hooks: Dict[str, Any]) -> Iterator[str]:
    """Mọi chuỗi `command` trong khoá `hooks` của settings.json; cấu trúc lạ thì bỏ qua."""
    for groups in hooks.values():
        for g in groups if isinstance(groups, list) else []:
            for h in (g.get("hooks") if isinstance(g, dict) else None) or []:
                if isinstance(h, dict) and isinstance(h.get("command"), str):
                    yield h["command"]


def _syntax_error(p: Path) -> Optional[str]:
    """Lỗi cú pháp của file hook (.py: compile; .sh: `bash -n`); None nếu ổn hoặc không kiểm được."""
    if p.suffix == ".py":
        try:
            compile(p.read_text(encoding="utf-8"), str(p), "exec")
        except (SyntaxError, ValueError) as exc:
            return str(exc)
        return None
    if p.suffix != ".sh" or not shutil.which("bash"):
        return None
    r = subprocess.run(["bash", "-n", str(p)], capture_output=True, text=True, check=False, timeout=GIT_TIMEOUT)
    return (r.stderr.strip() or f"bash -n exit {r.returncode}") if r.returncode else None


def _doctor_hook_files(base: Path, hooks: Dict[str, Any], deep: bool) -> List[Finding]:
    """File hook settings.json trỏ tới (và file chúng nạp cạnh nó) phải có — hook fail-open nên thiếu file = mất hàng rào
    mà không ai thấy; `deep` thì kiểm cả cú pháp."""
    hook_dir = base / ".claude" / "hooks"
    direct = {m for cmd in _hook_commands(hooks) for m in HOOK_REF_RE.findall(cmd)}
    present = [hook_dir / n for n in sorted(direct) if (hook_dir / n).is_file()]
    siblings = {s for p in present for s in HOOK_SIBLING_RE.findall(p.read_text(encoding="utf-8", errors="replace"))}
    names = sorted(direct | siblings)
    out = [
        Finding(
            "hooks", "error", f"hook cần .claude/hooks/{n} nhưng file không có — hook lặng lẽ cho qua; {INSTALL_HINT}"
        )
        for n in names
        if not (hook_dir / n).is_file()
    ]
    for n in names if deep else []:
        err = _syntax_error(hook_dir / n) if (hook_dir / n).is_file() else None
        if err:
            out.append(Finding("hooks", "error", f".claude/hooks/{n} lỗi cú pháp: {_one_line(err)[:200]}"))
    return out


def _doctor_settings(base: Path, deep: bool) -> List[Finding]:
    p = base / ".claude" / "settings.json"
    if not p.is_file():
        return [
            Finding("hooks", "error", f"không có .claude/settings.json — autopilot chạy không hook; {INSTALL_HINT}")
        ]
    hooks = (_read_json_obj(p) or {}).get("hooks")
    if not isinstance(hooks, dict):
        return [Finding("hooks", "error", f".claude/settings.json hỏng hoặc không có khoá `hooks`; {INSTALL_HINT}")]
    out = [
        Finding("hooks", lv, f"settings.json thiếu hook {ev}; {INSTALL_HINT} (`merge_hooks` tự thêm, giữ hook riêng)")
        for ev, lv in DOCTOR_HOOK_EVENTS.items()
        if not hooks.get(ev)
    ]
    return out + _doctor_hook_files(base, hooks, deep)


def _doctor_harness_parts(base: Path) -> List[Finding]:
    claude = base / ".claude"
    missing = [f"skills/{s}/SKILL.md" for s in DOCTOR_SKILLS if not (claude / "skills" / s / "SKILL.md").is_file()]
    missing += [f"agents/{a}.md" for a in DOCTOR_AGENTS if not (claude / "agents" / f"{a}.md").is_file()]
    pending = sorted(
        p.relative_to(base).as_posix() for p in (*base.glob("*.xtemplates-new"), *claude.rglob("*.xtemplates-new"))
    )
    out = []
    if missing:
        out.append(Finding("harness", "warn", f".claude/ thiếu {', '.join(missing)}; {INSTALL_HINT}"))
    if pending:
        out.append(
            Finding(
                "harness",
                "warn",
                f"bản mới của khung chưa gộp: {', '.join(pending)} — so sánh, gộp vào file gốc rồi xoá bản `*.xtemplates-new` "
                "(file trong .claude/hooks hoặc settings là điểm dừng: để người gộp)",
            )
        )
    return out


def _imports_agents(text: str) -> bool:
    return any(line.strip() == "@AGENTS.md" for _, line in _lines_outside_fences(text, 1))


def _doctor_docs(base: Path, fw: Path) -> List[Finding]:
    out = [
        Finding(
            "docs",
            "warn" if name == "PROGRESS.md" else "error",
            f"thiếu {name} — luật/trạng thái phiên không được nạp",
            _fix_template(base, fw, name),
        )
        for name in ("AGENTS.md", "CLAUDE.md", "PROGRESS.md")
        if not (base / name).exists()
    ]
    claude = base / "CLAUDE.md"
    if claude.is_file() and not _imports_agents(claude.read_text(encoding="utf-8", errors="replace")):
        out.append(
            Finding(
                "docs",
                "error",
                "CLAUDE.md không có dòng `@AGENTS.md` ngoài code block — Claude Code không nạp AGENTS.md (XC-DOCAI-002)",
                _fix_append(claude, "\n@AGENTS.md\n", "thêm dòng `@AGENTS.md` vào cuối CLAUDE.md"),
            )
        )
    return out


def _yaml_blank(value: str) -> bool:
    return value in ("", '""', "''")


def gate_noop_keys(base: Path) -> List[str]:
    """Khoá `lint`/`test` khai trong xt.yaml mà rỗng hoặc không kiểm gì — dev-task.sh sẽ ĐỎ trong vòng (ADR-0011).
    Khoá vắng không tính: dev-task.sh còn tự dò theo stack."""
    p = base / "xt.yaml"
    if not p.is_file():
        return []
    keys = {m[1]: yaml_scalar(m[2]) for m in map(YAML_KEY_RE.match, p.read_text(encoding="utf-8").splitlines()) if m}
    vals = {k: keys[k].strip() for k in LOOP_GATE_KEYS if k in keys}
    return [k for k, v in vals.items() if not v or GATE_NOOP_RE.fullmatch(v)]


def yaml_scalar(raw: str) -> str:
    """Giá trị YAML phẳng như dev-task.sh `yaml_get`: bỏ comment `#` (đầu giá trị hoặc sau khoảng trắng, ngoài nháy —
    AUD-HAR-025), rồi bỏ nháy khi bọc cả hai đầu."""
    out, quote, prev = [], "", " "
    for c in raw:
        if c == "#" and not quote and prev in " \t":
            break
        if c in "'\"" and (not quote or quote == c):
            quote = "" if quote else c
        out.append(c)
        prev = c
    return re.sub(r"^([\"'])(.*)\1$", r"\2", "".join(out).strip())


def _doctor_xt_yaml(base: Path, fw: Path) -> List[Finding]:
    p, legacy = base / "xt.yaml", base / "xs.yaml"
    if not p.is_file():
        fix = (
            _fix_rename(legacy, p, "đổi tên xs.yaml → xt.yaml (ADR-0007)")
            if legacy.is_file()
            else _fix_template(base, fw, "xt.yaml")
        )
        msg = "thiếu xt.yaml — dev-task.sh/cổng commit không có lệnh khai báo (LOOP-HARNESS-008)"
        return [Finding("xt-yaml", "error", msg, fix)]
    keys = {m[1]: m[2] for m in map(YAML_KEY_RE.match, p.read_text(encoding="utf-8").splitlines()) if m}
    out = []
    missing = [k for k in DOCTOR_YAML_KEYS if k not in keys]
    if missing:
        out.append(
            Finding(
                "xt-yaml", "warn", f"xt.yaml thiếu khoá {', '.join(missing)} — khai đủ, chuỗi rỗng nếu không áp dụng"
            )
        )
    blank = [k for k in DOCTOR_YAML_KEYS if k in keys and _yaml_blank(keys[k])]
    if blank:
        noop = " — cổng commit đang là no-op" if len(blank) == len(DOCTOR_YAML_KEYS) else ""
        out.append(
            Finding(
                "xt-yaml",
                "warn",
                f"xt.yaml để trống {', '.join(blank)}{noop}: điền lệnh thật theo stack trước khi tick task (task đầu PLAN)",
            )
        )
    return out


def _doctor_gitignore(base: Path) -> List[Finding]:
    gi = base / ".gitignore"
    lines = gi.read_text(encoding="utf-8", errors="replace").splitlines() if gi.is_file() else []
    if any(ln.strip() in AUTOPILOT_IGNORES for ln in lines):
        return []
    block = "\n# X-Templates: trạng thái autopilot cục bộ\n.autopilot/\n"
    return [
        Finding(
            "gitignore",
            "error",
            "`.autopilot/` chưa nằm trong .gitignore — state/bằng chứng cục bộ có thể bị commit (LOOP-HARNESS-006)",
            _fix_append(gi, block, "thêm `.autopilot/` vào .gitignore"),
        )
    ]


def _doctor_state(base: Path) -> List[Finding]:
    p = state_dir(base) / "state.json"
    if not p.exists():
        return []
    st = read_state(base)
    if st is None:
        backup = p.with_name("state.json.hong-" + _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
        return [
            Finding(
                "state",
                "error",
                ".autopilot/state.json hỏng (không phải JSON object) — verdict của vòng lặp sẽ sai",
                _fix_rename(p, backup, f"chuyển state hỏng sang {backup.name} (`loop init` tạo lại)"),
            )
        ]
    out = []
    if st.get("blocked"):
        reason = st.get("blocked_reason") or "?"
        out.append(Finding("state", "warn", f"autopilot đang BLOCKED: {reason} — người xử lý rồi `loop resume`"))
    plan = st.get("plan")
    if st.get("active") and plan and not (base / str(plan)).is_file():
        out.append(Finding("state", "warn", f"vòng lặp đang bật nhưng không còn PLAN `{plan}` — `loop init` lại"))
    return out


def _doctor_legacy(base: Path) -> List[Finding]:
    out = []
    if (base / ".xstored").is_dir():
        out.append(Finding("legacy", "warn", f"còn `.xstored/` của bản ≤ 2.x (ADR-0007); {INSTALL_HINT} để chuyển"))
    if (base / "xs.yaml").is_file() and (base / "xt.yaml").is_file():
        out.append(
            Finding("legacy", "warn", "có cả xs.yaml và xt.yaml — dev-task chỉ đọc xt.yaml; gộp tay rồi xoá xs.yaml")
        )
    return out


def _doctor_git(base: Path) -> List[Finding]:
    if shutil.which("git") and _git(base, "rev-parse", "--git-dir").returncode != 0:
        return [Finding("git", "warn", "không phải repo git — autopilot cần commit + push từng task")]
    return []


def _doctor_progress(base: Path) -> List[Finding]:
    p = base / "PROGRESS.md"
    if not p.is_file():
        return []
    try:
        errors = progress_check(p)
    except OSError as exc:
        errors = [str(exc)]
    if not errors:
        return []
    more = f" (+{len(errors) - 1} lỗi khác)" if len(errors) > 1 else ""
    return [Finding("progress", "warn", f"PROGRESS.md: {_one_line(errors[0])}{more} — xem `xt.py progress-check`")]


def _doctor_merge(base: Path) -> List[Finding]:
    """merge_autonomy ≥ L2 mà settings còn luật ask cho `gh pr merge`: luật ask luôn hỏi (kể cả hook allow, chế độ
    auto/bypass) nên không bao giờ tự merge. Bản cài cũ giữ permissions khi `install.py` gộp lại (ADR-0013)."""
    if merge_config(base)[0] < 2:
        return []
    perms = (_read_json_obj(base / ".claude" / "settings.json") or {}).get("permissions")
    asks = perms.get("ask") if isinstance(perms, dict) else None
    hit = [a for a in asks or [] if isinstance(a, str) and a.startswith("Bash(gh pr merge")]
    if not hit:
        return []
    msg = f"merge_autonomy ≥ L2 nhưng settings.json permissions.ask còn {', '.join(hit)} — luật ask luôn hỏi người"
    return [Finding("merge", "warn", msg + "; người xoá dòng đó để guard + `xt.py merge-check` quyết (ADR-0013)")]


def _claude_user_paths() -> Optional[Tuple[Path, Path]]:
    """(settings.json, .claude.json) cấp người dùng của Claude Code; `CLAUDE_CONFIG_DIR` dời cả hai (cách engram tìm).
    None khi không xác định được home (HOME trống, không có passwd): bỏ phần cấp người dùng, không làm vỡ `loop init`."""
    root = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    if root:
        cfg = Path(root).expanduser()
        return cfg / "settings.json", cfg / ".claude.json"
    try:
        home = Path.home()
    except RuntimeError:
        return None
    return home / ".claude" / "settings.json", home / ".claude.json"


def _enabled_plugins(base: Path, user_settings: Optional[Path]) -> List[str]:
    """Plugin bật hiệu lực: `enabledPlugins` cấp người dùng → dự án → cục bộ, cấp sau thắng cấp trước."""
    state: Dict[str, bool] = {}
    files = (user_settings, base / ".claude" / "settings.json", base / ".claude" / "settings.local.json")
    for p in [f for f in files if f is not None]:
        plugins = (_read_json_obj(p) or {}).get("enabledPlugins")
        if isinstance(plugins, dict):
            state.update({str(k): v is True for k, v in plugins.items()})
    return [k for k, on in state.items() if on]


def _mcp_servers(base: Path, user_json: Optional[Path]) -> List[str]:
    """Tên MCP server: `.claude.json` (gốc = cấp người dùng, `projects.<dự án>` = cấp cục bộ) và `.mcp.json` của dự án."""
    cfg = (_read_json_obj(user_json) if user_json else None) or {}
    projects = cfg.get("projects")
    local = projects.get(str(base)) if isinstance(projects, dict) else None
    sources = [cfg.get("mcpServers"), local.get("mcpServers") if isinstance(local, dict) else None]
    sources.append((_read_json_obj(base / ".mcp.json") or {}).get("mcpServers"))
    return sorted({str(k) for s in sources if isinstance(s, dict) for k in s})


def _doctor_memory(base: Path) -> List[Finding]:
    """LOOP-HARNESS-021: bật tối đa một công cụ memory ngoài; `.engram/` (Git Sync của engram) không nằm trong git.
    Chỉ đọc tên plugin/server, không in giá trị cấu hình."""
    user = _claude_user_paths()
    names = [f"plugin {p}" for p in _enabled_plugins(base, user[0] if user else None)]
    names += [f"MCP {s}" for s in _mcp_servers(base, user[1] if user else None)]
    found: Dict[str, List[str]] = {}
    for name in names:
        for tool in sorted(set(MEMORY_TOOL_RE.findall(name.lower()))):
            found.setdefault(tool, []).append(name)
    out = []
    if len(found) > 1:
        seen = "; ".join(f"{t} ({', '.join(w)})" for t, w in sorted(found.items()))
        msg = (
            f"đang bật {len(found)} công cụ memory ngoài: {seen} — cùng hook đầu phiên/mỗi prompt nên context nhân lên"
        )
        out.append(Finding("memory", "warn", msg + "; giữ tối đa một, tắt phần còn lại (LOOP-HARNESS-021)"))
    if shutil.which("git") and _git(base, "ls-files", "--", ".engram").stdout.strip():
        msg = "`.engram/` (Git Sync của engram) đang nằm trong git — repo công khai: tắt `engram sync` và gỡ khỏi git"
        out.append(
            Finding("memory", "warn", msg + "; repo riêng: gitleaks quét `.engram/` trước commit (LOOP-HARNESS-021)")
        )
    return out


def doctor_findings(base: Path, fw: Path, deep: bool = True) -> List[Finding]:
    """Audit khung đã cài trong dự án (hoặc repo khung) trước khi chạy autopilot. `deep=False` bỏ phần chậm
    (validate khung, cú pháp hook, progress-check) — dùng ở `loop init`."""
    out = _doctor_runtime() + _doctor_scripts() + _doctor_settings(base, deep) + _doctor_harness_parts(base)
    out += _doctor_docs(base, fw) + _doctor_xt_yaml(base, fw) + _doctor_gitignore(base)
    out += _doctor_state(base) + _doctor_legacy(base) + _doctor_git(base) + _doctor_merge(base) + _doctor_memory(base)
    if deep:
        out += _doctor_framework(fw) + _doctor_progress(base)
    return out


def doctor_fix(findings: List[Finding]) -> Tuple[List[str], List[Finding]]:
    """Chạy các sửa an toàn; trả (mô tả đã sửa, phát hiện mới cho sửa thất bại)."""
    fixed: List[str] = []
    failed: List[Finding] = []
    for f in findings:
        if f.fix is None:
            continue
        try:
            fixed.append(f.fix())
        except OSError as exc:
            failed.append(Finding(f.code, "error", f"sửa thất bại ({f.msg}): {exc}"))
    return fixed, failed


# --------------------------------------------------------------------------- merge-check (ADR-0013)

MERGE_FIELDS = (
    "number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,labels,statusCheckRollup,files"
)
FAST_LANE_MAX_LINES = 150  # vị từ làn nhanh, 11-autonomous-loop/stop-points-and-escalation.md
GH_TIMEOUT = 60
# Đường dẫn nhạy cảm → làn chuẩn (người merge). Bắt rộng có chủ đích: báo oan chỉ làm người phải bấm merge.
RISK_PATH_RES: Tuple[Tuple[str, "re.Pattern[str]"], ...] = (
    ("bí mật", re.compile(r"(^|/)(\.env|secrets?/)|\.(pem|key|p12)$", re.I)),
    ("auth", re.compile(r"(^|[/_.-])(auth|login|session|passw|permission|rbac|acl)", re.I)),
    ("thanh toán", re.compile(r"(^|[/_.-])(payment|billing|checkout|invoice|refund)", re.I)),
    ("mật mã", re.compile(r"(^|[/_.-])(crypt|signing|jwt)", re.I)),
    ("schema", re.compile(r"(^|/)migrations?/|(^|/)schema\.|\.sql$|(^|/)prisma/", re.I)),
    ("cổng/CI", re.compile(r"(^|/)(\.github|\.claude|\.xtemplates)/|ruleset", re.I)),
    ("nguồn gói", re.compile(r"(^|/)(\.npmrc|\.yarnrc(\.yml)?|\.pypirc|pip\.(conf|ini)|uv\.toml|bunfig\.toml)$")),
    ("ảnh/container", re.compile(r"(^|/)(Dockerfile[^/]*|Containerfile[^/]*|(docker-)?compose[^/]*\.ya?ml)$", re.I)),
    (
        "phụ thuộc",
        re.compile(
            r"(^|/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|pyproject\.toml|uv\.lock|poetry\.lock"
            r"|requirements[^/]*\.txt|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock))$"
        ),
    ),
)
# File cổng/luật agent khớp ở gốc hoặc bất kỳ thư mục con (như `_match_any` của guard). Phải chứa mọi mẫu
# `GATE_PATTERNS` của `.claude/hooks/guard.py` — test giữ hai nhà khớp nhau (AUD-HAR-021); thêm luật agent.
MERGE_GATE_GLOBS = (
    *(".github/workflows/*", ".github/rulesets/*", ".github/dependabot.yml", ".gitlab-ci.yml"),
    *(".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/*", ".xtemplates/*"),
    *("eslint.config.*", ".eslintrc*", "biome.json*", ".oxlintrc*", "tsconfig*.json", "jsconfig*.json"),
    *("vitest.config.*", "jest.config.*", "playwright.config.*", "lighthouserc*", ".lighthouserc*"),
    *("pyproject.toml", "setup.cfg", "mypy.ini", "pyrightconfig.json", "ruff.toml", ".coveragerc"),
    *("codecov.yml", ".codecov.yml", ".pre-commit-config.yaml", ".husky/*", "lefthook.yml", ".lintstagedrc*"),
    *("commitlint.config.*", "xt.yaml", "dev-task.sh", "Makefile", "justfile", ".gitleaks.toml", ".gitleaksignore"),
    *(".semgrep*", "sonar-project.properties", "requirements-dev.txt"),
    *("pytest.ini", "tox.ini", "noxfile.py", "conftest.py", "vite.config.*", ".flake8", ".golangci.y*ml"),
    *(".nycrc*", ".c8rc*", "phpunit.xml*", "karma.conf.*", ".mocharc*"),
    *("AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".cursor/rules/*"),
    *(".stylelintrc*", "stylelint.config.*", "*-snapshots/*", "__snapshots__/*"),
    # Năng lực agent (LOOP-STOP-023; khớp `CAPABILITY_PATTERNS` của guard): MCP server, plugin, skill — PR chỉ đổi những
    # file này + một test từng vào làn nhanh (rà stored 2026-10-16).
    *(".mcp.json", "mcp.json", ".claude.json", ".claude-plugin/*", ".codex/*", ".gemini/*", "SKILL.md"),
)


def _gate_path(path: str) -> bool:
    parts = path.split("/")
    return any(fnmatch.fnmatchcase("/".join(parts[i:]), g) for i in range(len(parts)) for g in MERGE_GATE_GLOBS)


LOCKFILE_RE = re.compile(
    r"(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|uv\.lock|poetry\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$"
)
DOC_PATH_RE = re.compile(r"(^|/)docs?/|\.(md|mdx|rst|txt)$|(^|/)(LICENSE|NOTICE)[^/]*$", re.I)
TEST_PATH_RE = re.compile(r"(^|/)(tests?|__tests__|spec|e2e)/|(_test|\.test|\.spec|_spec)\.[^/]+$|(^|/)test_[^/]+$")
MONO_DIRS = ("packages", "apps", "services", "libs", "crates", "modules")
CI_RED = {"FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"}
CI_PENDING = {"PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"}


def _ci_buckets(rollup: List[Dict[str, Any]]) -> Tuple[List[str], List[str], List[str]]:
    """(check đỏ, check đang chạy, check xanh) từ `statusCheckRollup` (CheckRun: status/conclusion; StatusContext:
    state). Xanh = SUCCESS; SKIPPED/NEUTRAL không thuộc nhóm nào — không phải bằng chứng (AUD-HAR-023)."""
    red: List[str] = []
    pending: List[str] = []
    green: List[str] = []
    for c in rollup:
        name = str(c.get("name") or c.get("context") or "?")
        if c.get("__typename") == "StatusContext":
            st = str(c.get("state", ""))
        else:
            st = str(c.get("conclusion") or "") if c.get("status") == "COMPLETED" else "PENDING"
        if st in CI_RED:
            red.append(name)
        elif st in CI_PENDING:
            pending.append(name)
        elif st == "SUCCESS":
            green.append(name)
    return red, pending, green


def _package_of(path: str) -> str:
    parts = path.split("/")
    if parts[0] in MONO_DIRS and len(parts) > 2:
        return "/".join(parts[:2])
    return parts[0] if len(parts) > 1 else "."


# Ngoại lệ cứng (`LOOP-STOP-005`, "Ngoại lệ cứng" của stop-points-and-escalation.md): tiền thật, dữ liệu người dùng
# thật, xác thực/phân quyền, mật mã, bí mật — luôn người merge, kể cả ở L3 (ADR-0016, D-012; AUD-HAR-042).
HARD_RISK_TAGS = ("bí mật", "auth", "thanh toán", "mật mã")
HARD_RISK_LABELS = {"risk:auth", "risk:payment", "risk:pii", "risk:crypto", "risk:admin", "risk:secret"}


def _risky_paths(pr: Dict[str, Any]) -> List[str]:
    """Đường dẫn của PR kể cả tên cũ khi đổi tên (dời workflow ra khỏi `.github/` = tắt CI — AUD-HAR-022)."""
    files = [f for f in pr.get("files") or [] if isinstance(f, dict)]
    return [str(f.get("path", "")) for f in files] + [str(f["previous"]) for f in files if f.get("previous")]


def merge_hard_reasons(pr: Dict[str, Any], risk_paths: List[str]) -> List[str]:
    """Lý do thuộc ngoại lệ cứng (rỗng = không): nhãn `HARD_RISK_LABELS`, đường dẫn bí mật/auth/thanh toán/mật mã,
    `merge_risk_paths` của dự án (chủ dự án tự khai là nhạy cảm)."""
    risky = _risky_paths(pr)
    labels = [str(lb.get("name", "")) for lb in pr.get("labels") or [] if isinstance(lb, dict)]
    out = [f"nhãn rủi ro: {n}" for n in labels if n in HARD_RISK_LABELS]
    for tag, rx in RISK_PATH_RES:
        hit = [p for p in risky if rx.search(p)]
        if tag in HARD_RISK_TAGS and hit:
            out.append(f"đường dẫn nhạy cảm ({tag}): {', '.join(hit[:3])}")
    own = [p for p in risky if any(fnmatch.fnmatch(p, g) for g in risk_paths)]
    if own:
        out.append(f"đường dẫn nhạy cảm (merge_risk_paths): {', '.join(own[:3])}")
    return out


def merge_lane_reasons(pr: Dict[str, Any], risk_paths: List[str]) -> List[str]:
    """Lý do PR KHÔNG thuộc làn nhanh (rỗng = làn nhanh): ngoại lệ cứng, nhãn `risk:` khác, đường dẫn schema/cổng/phụ
    thuộc, > 150 dòng, > 1 gói, đổi mã không đổi test. Tài liệu không tính gói/test; lockfile không tính dòng (nhưng
    tính rủi ro phụ thuộc)."""
    files = [f for f in pr.get("files") or [] if isinstance(f, dict)]
    paths = [str(f.get("path", "")) for f in files]
    risky = _risky_paths(pr)
    out = merge_hard_reasons(pr, risk_paths)
    labels = [str(lb.get("name", "")) for lb in pr.get("labels") or [] if isinstance(lb, dict)]
    out += [f"nhãn rủi ro: {n}" for n in labels if n.startswith("risk:") and n not in HARD_RISK_LABELS]
    for tag, rx in RISK_PATH_RES:
        hit = [p for p in risky if rx.search(p) or (tag == "cổng/CI" and _gate_path(p))]
        if tag not in HARD_RISK_TAGS and hit:
            out.append(f"đường dẫn nhạy cảm ({tag}): {', '.join(hit[:3])}")
    lines = sum(
        int(f.get("additions", 0)) + int(f.get("deletions", 0))
        for f in files
        if not LOCKFILE_RE.search(str(f.get("path", ""))) and not DOC_PATH_RE.search(str(f.get("path", "")))
    )
    if lines > FAST_LANE_MAX_LINES:
        out.append(f"{lines} dòng > {FAST_LANE_MAX_LINES} (không tính tài liệu/lockfile)")
    code = [p for p in paths if not DOC_PATH_RE.search(p) and not LOCKFILE_RE.search(p)]
    pkgs = sorted({_package_of(p) for p in code if not TEST_PATH_RE.search(p)})
    if len(pkgs) > 1:
        out.append(f"nhiều gói: {', '.join(pkgs[:4])}")
    if pkgs and not any(TEST_PATH_RE.search(p) for p in code):
        out.append("đổi mã mà không đổi test")
    return out


def _merge_blockers(pr: Dict[str, Any]) -> Optional[Tuple[str, List[str]]]:
    """Trạng thái chặn merge bất kể làn, theo thứ tự: đóng → nháp → xung đột → CI → review đòi sửa → tụt sau → chưa tính."""
    if pr.get("state") != "OPEN":
        return "closed", [f"PR đã {pr.get('state')}"]
    if pr.get("isDraft"):
        return "wait", ["PR nháp"]
    if pr.get("mergeable") == "CONFLICTING" or pr.get("mergeStateStatus") == "DIRTY":
        return "fix", ["xung đột với nhánh đích — merge nhánh đích vào rồi giải"]
    red, pending, green = _ci_buckets([c for c in pr.get("statusCheckRollup") or [] if isinstance(c, dict)])
    if red:
        return "fix", [f"CI đỏ: {', '.join(red)}"]
    if pending:
        return "wait", [f"CI đang chạy: {', '.join(pending)}"]
    if not green:
        return "human", ["không có check CI nào xanh — không có bằng chứng"]
    if pr.get("reviewDecision") == "CHANGES_REQUESTED":
        return "fix", ["reviewer yêu cầu sửa"]
    if pr.get("mergeStateStatus") == "BEHIND":
        return "update", ["nhánh tụt sau nhánh đích — cập nhật rồi chờ CI chạy lại"]
    if pr.get("mergeable") != "MERGEABLE":
        return "wait", ["GitHub chưa tính xong mergeable"]
    return None


def _stacked_blocker(pr: Dict[str, Any]) -> Optional[Tuple[str, List[str]]]:
    """PR chồng (ADR-0014): nhắm nhánh khác nhánh mặc định → merge vào đó là merge vào nhánh sắp chết (squash) → chờ."""
    base, default = pr.get("baseRefName"), pr.get("defaultBranch")
    if base and default and base != default:
        return "wait", [
            f"PR nhắm `{base}`, không phải nhánh mặc định `{default}` — PR chồng: chờ PR đáy merge, đổi đích về "
            f"`{default}`, merge `{default}` vào nhánh này rồi chạy lại merge-check"
        ]
    return None


def merge_decision(pr: Dict[str, Any], autonomy: int = 1, risk_paths: Optional[List[str]] = None) -> Dict[str, Any]:
    """Máy quyết khi nào merge PR (ADR-0013). verdict: merge · wait · update · fix · human · closed.
    `merge` chỉ khi làn nhanh + CI xanh + mức tự chủ ≥ L2 (L3: mọi làn trừ ngoại lệ cứng `LOOP-STOP-005` — ADR-0015,
    ADR-0016); lệnh merge ghim `--match-head-commit` (có commit mới → lệch). `hard` = lý do ngoại lệ cứng, tính cả khi
    PR còn chờ CI để guard không bật auto-merge cho nó ngay lúc mở PR."""
    n = pr.get("number", "")
    lane_reasons = merge_lane_reasons(pr, risk_paths or [])
    hard = merge_hard_reasons(pr, risk_paths or [])
    lane = "chuẩn" if lane_reasons else "nhanh"
    blocked = _merge_blockers(pr) or _stacked_blocker(pr)
    if blocked:
        verdict, reasons = blocked
    elif hard:
        verdict, reasons = "human", [f"ngoại lệ cứng (LOOP-STOP-005): {'; '.join(hard)}", *lane_reasons[len(hard) :]]
    elif lane_reasons and autonomy < 3:
        verdict, reasons = "human", lane_reasons
    elif autonomy < 2:
        verdict, reasons = (
            "human",
            [f"đủ làn nhanh nhưng mức tự chủ L{autonomy} < L2 — người merge (xt.yaml merge_autonomy)"],
        )
    elif pr.get("reviewDecision") == "REVIEW_REQUIRED":
        verdict, reasons = "human", ["ruleset đòi review của người"]
    elif lane_reasons:  # L3 (ADR-0015): làn chuẩn tự merge — ghi đúng làn (AUD-CODE-010)
        verdict, reasons = "merge", [f"L3 (ADR-0015): làn chuẩn, CI xanh, không xung đột — {'; '.join(lane_reasons)}"]
    else:
        verdict, reasons = "merge", ["làn nhanh, CI xanh, không xung đột"]
    base, head = pr.get("baseRefName") or "main", pr.get("headRefOid", "")
    nxt = {
        "merge": f"gh pr merge {n} --squash --match-head-commit {head}",
        "update": f"git fetch origin {base} && git merge origin/{base} && git push (hoặc gh pr update-branch {n})",
        "wait": "chờ rồi chạy lại merge-check",
        "fix": "sửa, push, chạy lại merge-check",
        "human": "để người merge; báo cáo lý do",
        "closed": "",
    }[verdict]
    return {
        "pr": n,
        "repo": pr.get("repo", ""),  # `chủ/repo` (REST) — guard so với owner/repo của tool MCP merge
        "head": pr.get("headRefOid", ""),
        "verdict": verdict,
        "lane": lane,
        # L3 (ADR-0015): guard cho bật auto-merge của GitHub ngay khi mở PR — trừ PR chồng (nhắm nhánh sắp bị xoá).
        "autonomy": autonomy,
        "stacked": _stacked_blocker(pr) is not None,
        "hard": hard,  # ngoại lệ cứng: guard không bật auto-merge (ADR-0016)
        "reasons": reasons,
        "next": nxt,
        # Phiên chặn GraphQL (`gh pr merge` không chạy): cùng merge ghim head qua REST (ADR-0014).
        **(
            {
                "next_rest": f"gh api -X PUT repos/{{owner}}/{{repo}}/pulls/{n}/merge -f sha={head} -f merge_method=squash"
            }
            if verdict == "merge"
            else {}
        ),
    }


def merge_config(base: Path) -> Tuple[int, List[str], List[str]]:
    """(mức tự chủ, glob nhạy cảm riêng, ghi chú) từ xt.yaml: `merge_autonomy: L0..L4` (mặc định L1),
    `merge_risk_paths: "glob, glob"`. Giá trị lạ → L1 (an toàn) kèm ghi chú."""
    p = base / "xt.yaml"
    raw = p.read_text(encoding="utf-8") if p.is_file() else ""
    keys = {m[1]: yaml_scalar(m[2]) for m in map(YAML_KEY_RE.match, raw.splitlines()) if m}
    level = keys.get("merge_autonomy", "L1")
    notes: List[str] = []
    if not re.fullmatch(r"L[0-4]", level):
        notes.append(f"merge_autonomy '{level}' không hợp lệ (L0–L4) — dùng L1")
        level = "L1"
    globs = [g.strip() for g in keys.get("merge_risk_paths", "").split(",") if g.strip()]
    return int(level[1]), globs, notes


class PrInputError(Exception):
    """Không lấy/đọc được JSON của PR — `merge-check` thoát 2."""


def _gh_api(path: str, paginate: bool = False) -> List[Any]:
    """`gh api` (REST, không GraphQL — phiên Claude Code chặn GraphQL) → danh sách giá trị JSON; `--paginate` in mỗi
    trang một giá trị liền nhau (`[…][…]`) nên đọc lần lượt. `{owner}`/`{repo}`/`{branch}` do gh thay theo repo hiện tại."""
    cmd = ["gh", "api", *(["--paginate"] if paginate else []), path]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=GH_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PrInputError(f"không chạy được gh ({exc}) — cài/đăng nhập gh hoặc dùng --pr-json") from exc
    if r.returncode != 0:
        raise PrInputError(f"gh api {path} lỗi: {_one_line(r.stderr)}")
    dec, rest, out = json.JSONDecoder(), r.stdout.strip(), []
    while rest:
        val, end = dec.raw_decode(rest)
        out.append(val)
        rest = rest[end:].lstrip()
    return out


def _gh_one(path: str) -> Dict[str, Any]:
    vals = _gh_api(path)
    return vals[0] if vals and isinstance(vals[0], dict) else {}


def _gh_items(path: str) -> List[Dict[str, Any]]:
    """Mọi phần tử object của các trang mảng (`--paginate`)."""
    return [x for page in _gh_api(path, True) if isinstance(page, list) for x in page if isinstance(x, dict)]


PR_URL_RE = re.compile(r"github\.com/([^/\s]+)/([^/\s]+)/pull/(\d+)")


def _pr_target(pr_arg: Optional[str]) -> Tuple[str, str]:
    """(tiền tố REST `repos/<chủ>/<repo>`, số PR) từ số (`7`, `#7`), URL PR, hoặc tên nhánh (mặc định nhánh hiện tại)."""
    repo = "repos/{owner}/{repo}"
    if pr_arg and pr_arg.lstrip("#").isdigit():
        return repo, pr_arg.lstrip("#")
    m = PR_URL_RE.search(pr_arg or "")
    if m:
        return f"repos/{m[1]}/{m[2]}", m[3]
    head = urllib.parse.quote(pr_arg or "{branch}", safe="/{}")
    found = _gh_items(f"{repo}/pulls?head={{owner}}:{head}&state=open&per_page=100")
    if not found:
        raise PrInputError(f"không có PR mở cho nhánh {pr_arg or 'hiện tại'}")
    return repo, str(found[0].get("number", ""))


def _review_decision(reviews: List[Dict[str, Any]], merge_state: str) -> str:
    """Như `reviewDecision` của GraphQL: review mới nhất của mỗi người (bỏ COMMENTED; DISMISSED xoá). REST không cho biết
    ruleset/branch protection đòi review, nên `mergeable_state` BLOCKED (GitHub tính cả protection cổ điển) → cần người."""
    latest: Dict[str, str] = {}
    for rv in reviews:
        user, st = (rv.get("user") or {}).get("login"), str(rv.get("state", "")).upper()
        if user and st in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            latest[str(user)] = st
    states = set(latest.values())
    if "CHANGES_REQUESTED" in states:
        return "CHANGES_REQUESTED"
    if merge_state == "BLOCKED":
        return "REVIEW_REQUIRED"
    return "APPROVED" if "APPROVED" in states else ""


def _pr_rest(pr_arg: Optional[str]) -> Dict[str, Any]:
    """Dựng JSON dạng `gh pr view --json MERGE_FIELDS` chỉ bằng REST — `merge_decision` dùng nguyên như trước."""
    repo, n = _pr_target(pr_arg)
    pr = _gh_one(f"{repo}/pulls/{n}")
    head = pr.get("head")
    if not isinstance(head, dict):
        raise PrInputError(f"JSON của PR #{n} không đọc được: thiếu `head`")
    sha = str(head.get("sha", ""))
    merge_state = str(pr.get("mergeable_state") or "unknown").upper()
    reviews = _gh_items(f"{repo}/pulls/{n}/reviews?per_page=100")
    runs = [
        c
        for page in _gh_api(f"{repo}/commits/{sha}/check-runs?per_page=100", True)
        if isinstance(page, dict)
        for c in page.get("check_runs") or []
        if isinstance(c, dict)
    ]
    statuses = [
        s for s in _gh_one(f"{repo}/commits/{sha}/status?per_page=100").get("statuses") or [] if isinstance(s, dict)
    ]
    # Chạy lại một check trên CÙNG head (sửa tiêu đề PR, re-run) tạo check-run mới cùng tên, cùng app: chỉ lần mới nhất
    # (id lớn nhất) có hiệu lực, như GitHub tính — lần cũ đỏ từng che lần mới xanh (#58). Khoá gồm app: check cùng tên
    # của app khác là check khác, không được che nhau (AUD-CODE-007).
    latest: Dict[str, Dict[str, Any]] = {}
    for c in runs:
        app = c.get("app")
        key = f"{app.get('id') if isinstance(app, dict) else ''}/{c.get('name')}"
        if key not in latest or int(c.get("id") or 0) >= int(latest[key].get("id") or 0):
            latest[key] = c
    rollup = [
        {
            "__typename": "CheckRun",
            "name": c.get("name"),
            "status": str(c.get("status", "")).upper(),
            "conclusion": str(c.get("conclusion") or "").upper(),
        }
        for c in latest.values()
    ]
    rollup += [
        {"__typename": "StatusContext", "context": s.get("context"), "state": str(s.get("state", "")).upper()}
        for s in statuses
    ]
    files = _gh_items(f"{repo}/pulls/{n}/files?per_page=100")
    mergeable = pr.get("mergeable")  # REST: true · false · null (GitHub đang tính)
    raw_base = pr.get("base")
    base: Dict[str, Any] = raw_base if isinstance(raw_base, dict) else {}
    base_repo: Dict[str, Any] = base["repo"] if isinstance(base.get("repo"), dict) else {}
    extra = {
        k: str(v)
        for k, v in (
            ("repo", base_repo.get("full_name")),
            ("baseRefName", base.get("ref")),
            ("defaultBranch", base_repo.get("default_branch")),
        )
        if v
    }
    return {
        **extra,
        "number": pr.get("number", n),
        "state": "MERGED" if pr.get("merged") else str(pr.get("state", "")).upper(),
        "isDraft": bool(pr.get("draft")),
        "mergeable": "MERGEABLE" if mergeable is True else "CONFLICTING" if mergeable is False else "UNKNOWN",
        "mergeStateStatus": merge_state,
        "reviewDecision": _review_decision(reviews, merge_state),
        "headRefOid": sha,
        "labels": [{"name": lb.get("name", "")} for lb in pr.get("labels") or [] if isinstance(lb, dict)],
        "statusCheckRollup": rollup,
        "files": [
            {
                "path": f.get("filename", ""),
                **({"previous": f["previous_filename"]} if f.get("previous_filename") else {}),
                "additions": f.get("additions", 0),
                "deletions": f.get("deletions", 0),
            }
            for f in files
        ],
    }


def load_pr(args: argparse.Namespace) -> Dict[str, Any]:
    """JSON của PR: `--pr-json FILE|-` (định dạng `gh pr view --json MERGE_FIELDS`) hoặc lấy qua REST; lỗi → PrInputError."""
    try:
        if not args.pr_json:
            return _pr_rest(args.pr)
        text = sys.stdin.read() if args.pr_json == "-" else Path(args.pr_json).read_text(encoding="utf-8")
        data = json.loads(text)
    except (OSError, json.JSONDecodeError) as exc:
        raise PrInputError(f"JSON của PR không đọc được: {exc}") from exc
    if not isinstance(data, dict):
        raise PrInputError("JSON của PR không đọc được: không phải object")
    return data


# --------------------------------------------------------------------------- CLI


def cmd_validate(args: argparse.Namespace) -> int:
    errors = validate(args.framework)
    if errors:
        for e in errors:
            print(f"✗ {e}")
        print(f"\n{len(errors)} lỗi.")
        return 1
    docs, _ = load_docs(args.framework)
    n_items = sum(len(d.items) for d in docs)
    print(f"✓ Khung hợp lệ: {len(docs)} file, {n_items} mục checklist.")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    docs, _ = load_docs(args.framework)
    what = args.what
    kinds = {"profiles": ("profile",), "industries": ("industry",), "modules": ("module", "baseline", "standard")}[what]
    for d in sorted(docs, key=lambda d: d.rel):
        if d.kind in kinds:
            slug = d.meta.get("slug")
            label = f"{slug:<22}" if slug else f"{d.rel:<48}"
            print(f"{label} {d.title}  ({len(d.items)} mục)")
    return 0


def _backlog_path(out: Path) -> Path:
    return out.with_name(f"{out.stem}-BACKLOG{out.suffix}")


def _carry_into(fw: Path, olds: List[Path], main: str, backlog: Optional[str]) -> Tuple[str, Optional[str]]:
    """Ghép lại: giữ tick/miễn trừ/bằng chứng theo ID từ mọi file cũ (bản một file hoặc chính + backlog), mục chuyển
    file khi đổi quy mô vẫn giữ trạng thái; mục riêng của dự án về cuối file chính."""
    fw_ids = {it.id for d in load_docs(fw)[0] for it in d.items}
    old = "\n".join(p.read_text(encoding="utf-8") for p in olds)
    main, kept = carry_states(old, main, fw_ids)
    if backlog is not None:
        backlog, kept_bl = carry_states(old, backlog)
        kept += kept_bl
    print(f"↺ Giữ trạng thái {kept} mục theo ID từ bản cũ", file=sys.stderr)
    own = [m["id"] for m in map(ITEM_RE.match, main.splitlines()) if m and m["id"] not in fw_ids]
    if own:
        print(f"↺ Giữ {len(own)} mục riêng của dự án ở cuối: {', '.join(own[:10])}", file=sys.stderr)
    return main, backlog


def cmd_compose(args: argparse.Namespace) -> int:
    out_path = Path(args.out) if args.out else None
    bl_path = _backlog_path(out_path or Path("BLUEPRINT.md"))
    src = (args.framework, args.profile, args.industry or [], args.scale, args.include_may)
    backlog: Optional[str] = None
    if args.full:
        main = compose(*src, extra=args.add or [])
    else:
        main, backlog = compose_split(*src, extra=args.add or [], backlog_name=bl_path.name)
    if out_path is None:
        sys.stdout.write(main)
        if backlog is not None:
            n = sum(1 for ln in backlog.splitlines() if ITEM_RE.match(ln))
            print(f"ℹ {n} mục SHOULD/MAY không in — dùng --out (ghi kèm {bl_path.name}) hoặc --full", file=sys.stderr)
        return 0
    olds = [p for p in (out_path, bl_path) if p.exists()]
    if olds:
        main, backlog = _carry_into(args.framework, olds, main, backlog)
    write_atomic(out_path, main)
    if backlog is not None:
        write_atomic(bl_path, backlog)
    print(f"✓ Đã ghi {args.out}" + (f" + {bl_path.name}" if backlog is not None else ""))
    return 0


def cmd_blueprint_status(args: argparse.Namespace) -> int:
    s = blueprint_status_text(sys.stdin.read()) if args.file == "-" else blueprint_status(Path(args.file))
    ok = not s["open_must"] and not s["bad_waivers"] and not s["bad_lines"]
    if args.json:  # hợp đồng máy đọc: {"levels", "open_must", "bad_waivers", "bad_lines", "ok"}
        print(json.dumps({**s, "ok": ok}, ensure_ascii=False))
        return 0 if ok or not args.strict else 1
    for lv in LEVELS:
        c = s["levels"][lv]
        print(f"{lv:<7} đạt {c['done']:>4} · miễn {c['waived']:>4} · chưa {c['open']:>4}")
    if s["bad_waivers"]:
        print("✗ Miễn trừ không hợp lệ (thiếu lý do; MUST `Miễn` cần `Duyệt:`): " + ", ".join(s["bad_waivers"]))
    for b in s["bad_lines"]:
        print(f"✗ Sai định dạng/thiếu mục: {b}")
    if s["open_must"]:
        print(f"Còn {len(s['open_must'])} mục MUST chưa đạt: " + ", ".join(s["open_must"][:15]))
    return 0 if ok or not args.strict else 1


def _loop_init(args: argparse.Namespace, base: Path) -> int:
    for path in (args.plan, args.blueprint):  # blueprint gõ nhầm → verdict lặng lẽ bỏ qua blueprint (AUD-HAR-016)
        if path and not (base / path).exists():
            print(f"✗ Không thấy {path}", file=sys.stderr)
            return 2
    deadline = None
    if args.hours is not None:
        deadline = (
            (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(hours=args.hours)).replace(microsecond=0).isoformat()
        )
    max_iterations = args.max_iterations
    if max_iterations is None:  # một phiên: trần theo khối lượng PLAN (~4 vòng/task), không theo số mặc định
        # ADR-0012: chỉ đếm task `[ ]` — MUST của blueprint đã gom vào task, cộng thêm là đếm hai lần
        n_open = sum(t["state"] == " " for t in parse_plan(base / args.plan))
        max_iterations = max(20, 4 * n_open) if args.single_session else 50
    state = {
        "active": True,
        "started": now_iso(),
        "plan": args.plan,
        "blueprint": args.blueprint,
        "single_session": args.single_session,
        "max_iterations": max_iterations,
        "max_same_failure": 3,
        "iterations": 0,
        "deadline": deadline,
        "same_failure_count": 0,
        "blocked": False,
    }
    write_state(state, base)
    issues = [f.msg for f in doctor_findings(base, args.framework, deep=False) if f.level == "error"]
    if issues:  # không chặn (fail-open về luồng, ADR-0002) nhưng phải thấy: vòng thiếu hook = không có máy kiểm
        more = f" (+{len(issues) - 3})" if len(issues) > 3 else ""
        print(
            f"⚠ Audit khung còn {len(issues)} lỗi — chạy `xt.py doctor --fix`: " + "; ".join(issues[:3]) + more,
            file=sys.stderr,
        )
    noop = gate_noop_keys(base)
    if noop:  # PLAN thường điền xt.yaml ở task đầu nên không chặn init, nhưng cổng đỏ tới khi điền
        print(
            f"⚠ Cổng sẽ ĐỎ trong vòng (ADR-0011): xt.yaml để {', '.join(noop)} rỗng/no-op"
            " — khai lệnh thật trước khi tick task (LOOP-HARNESS-008)",
            file=sys.stderr,
        )
    print(
        f"✓ Autopilot bật: plan={args.plan} trần={max_iterations} vòng"
        + (f", hạn {deadline}" if deadline else "")
        + (" · chế độ một phiên" if args.single_session else "")
    )
    return 0


def _status_notes(st: Dict[str, Any], base: Path) -> List[str]:
    """Dòng phụ của `loop status` (SessionStart nạp lại sau compaction): chế độ, việc chờ người, quyền, checkpoint.
    Checkpoint cũ hơn bằng chứng mới nhất thì ẩn — công việc đã đi tiếp, in lại sẽ dẫn sai chỗ."""
    notes = ["chế độ một phiên: compaction tự nén, không bàn giao vì context"] if st.get("single_session") else []
    notes += [
        f"chờ người: {i} — {d.get('reason', '') if isinstance(d, dict) else ''}" for i, d in _deferred(st).items()
    ]
    warn = _mode_warning(st.get("permission_mode")) if st.get("active") else ""
    notes += [warn.strip()] if warn else []
    cp = st.get("checkpoint")
    newer = (_evidence_latest(base) or {}).get("finished") or ""
    if isinstance(cp, dict) and str(newer) <= str(cp.get("at")):
        ev = cp.get("last_evidence") or {}
        notes.append(
            f"checkpoint trước nén {cp.get('at')} ({cp.get('trigger')}): đang ở {cp.get('task') or '—'}; "
            f"lệnh kiểm cuối {ev.get('task', '—')} `{ev.get('cmd', '')}` exit {ev.get('exit_code', '—')}; "
            f"file chưa commit: {', '.join(cp.get('dirty') or []) or 'không'}; "
            f"lỗi lặp {cp.get('same_failure_count', 0)} lần ({cp.get('last_failure_task') or '—'})"
        )
    return notes


def _loop_status(args: argparse.Namespace, base: Path) -> int:
    v = loop_verdict(base)
    st = read_state(base) or {}
    v["iterations"] = st.get("iterations", 0)
    if args.json:
        extra = {k: st.get(k) for k in ("single_session", "permission_mode", "checkpoint")}
        print(json.dumps({**v, **extra, "deferred": _deferred(st)}, ensure_ascii=False))
    else:
        print(f"verdict: {v['verdict']} — {v['reason']}")
        for n in _status_notes(st, base):
            print(f"  · {n}")
    return 0


def _loop_record(args: argparse.Namespace, base: Path) -> int:
    cmd = args.cmd[1:] if args.cmd[:1] == ["--"] else list(args.cmd)  # chỉ bỏ `--` phân cách đầu tiên
    if not cmd:
        print("✗ Thiếu lệnh kiểm sau '--'", file=sys.stderr)
        return 2
    return loop_record(args.task, cmd, base)


def _loop_block(args: argparse.Namespace, base: Path) -> int:
    st = read_state(base) or {"active": True}
    st.update({"blocked": True, "blocked_reason": args.reason, "blocked_at": now_iso()})
    write_state(st, base)
    print(f"■ BLOCKED: {args.reason}")
    return 0


DECISION_ID_RE = re.compile(r"^### D-(\d{3,})\b", re.M)
PROD_SWITCH_LABEL = "Khi chạy thật (đề xuất, chủ dự án quyết ở G7):"
DECISIONS_HEADER = (
    "# Nhật ký quyết định tự duyệt\n\n"
    "> Ghi bởi `xt.py loop decide`. Phiên chính tự duyệt điểm quyết định theo tiêu chí chất lượng cuối "
    "(`LOOP-STOP-018`, ADR-0008 của khung). Người xem lại bất cứ lúc nào; đổi ý → quyết định mới ghi "
    '"thay D-NNN", không sửa mục cũ.\n'
)


def _one_line(text: str) -> str:
    """Gộp khoảng trắng/xuống dòng: một trường = một dòng, không chèn được tiêu đề Markdown giả."""
    return " ".join(text.split())


def _decision_choice(options: List[str], choice: str) -> Optional[str]:
    """`--choice` là nguyên văn một phương án (ưu tiên, kể cả phương án là số) hoặc số thứ tự ASCII từ 1; không khớp → None."""
    if choice in options:
        return choice
    if re.fullmatch(r"[0-9]+", choice) and 1 <= int(choice) <= len(options):
        return options[int(choice) - 1]
    return None


def _loop_decide(args: argparse.Namespace, base: Path) -> int:
    options = list(dict.fromkeys(o for o in map(_one_line, args.option) if o))
    question, why, revert = _one_line(args.question), _one_line(args.why), _one_line(args.revert)
    chosen = _decision_choice(options, _one_line(args.choice))
    problems = [
        msg
        for bad, msg in (
            (len(options) < 2, "cần ≥ 2 phương án khác nhau (--option)"),
            (chosen is None, "--choice phải là số thứ tự hoặc nguyên văn một --option"),
            (not (question and why and revert), "--question, --why, --revert không được rỗng"),
        )
        if bad
    ]
    if problems:
        print("✗ " + "; ".join(problems), file=sys.stderr)
        return 2
    log = (base / args.log).resolve()
    if not log.is_relative_to(base.resolve()) or log.is_dir():  # không ghi ra ngoài dự án / vào thư mục
        print(f"✗ --log phải là file trong dự án: {args.log}", file=sys.stderr)
        return 2
    text = log.read_text(encoding="utf-8") if log.exists() else DECISIONS_HEADER
    did = f"D-{max((int(n) for n in DECISION_ID_RE.findall(text)), default=0) + 1:03d}"
    entry = (
        f"\n### {did} · {now_iso()} · {question}\n\n"
        f"- Phương án: " + " · ".join(f"({i}) {o}" for i, o in enumerate(options, 1)) + "\n"
        f"- Chọn: {chosen}\n- Lý do (tiêu chí chất lượng cuối): {why}\n- Đường lùi: {revert}\n"
    )
    prod = _one_line(args.prod or "")
    if prod:  # mặc định tự host khi phát triển; đề xuất dịch vụ cho chạy thật gom ở đây cho G7 (ADR-0008)
        entry += f"- {PROD_SWITCH_LABEL} {prod}\n"
    write_atomic(log, text.rstrip("\n") + "\n" + entry)
    print(f"✓ {did} tự duyệt: {chosen} → {args.log}")
    return 0


def _defer_problem(st: Dict[str, Any], task: str, reason: str, base: Path) -> Optional[str]:
    """Lý do từ chối defer: thiếu lý do, ID không còn mở (gõ nhầm/đã xong), hoặc né bế tắc máy (task đang lỗi lặp)."""
    if not reason:
        return "--reason rỗng — ghi người cần làm gì"
    if (base / st.get("plan", "docs/autopilot/PLAN.md")).exists() and task not in _still_open(base, st):
        return "ID không phải task `[ ]` trong PLAN hay mục MUST mở của blueprint"
    if st.get("same_failure_count", 0) > 0 and st.get("last_failure_task") == task:
        return "task đang lỗi — sửa hoặc đổi cách; lỗi lặp lần 3 máy tự BLOCKED, defer không dùng để né"
    return None


def _loop_defer(args: argparse.Namespace, base: Path) -> int:
    cur = read_state(base)
    if not cur:
        print("✗ Chưa có vòng lặp (chạy loop init trước)", file=sys.stderr)
        return 2
    problem = _defer_problem(cur, args.task, _one_line(args.reason), base)
    if problem:
        print(f"✗ Không defer {args.task}: {problem}", file=sys.stderr)
        return 2
    cur["deferred"] = {**_deferred(cur), args.task: {"reason": _one_line(args.reason), "at": now_iso()}}
    write_state(cur, base)
    print(
        f"⏸ {args.task} chờ người: {_one_line(args.reason)} — làm tiếp việc khác; gom cho người khi hết việc tự làm được"
    )
    return 0


def _evidence_latest(base: Path) -> Optional[Dict[str, Any]]:
    files = sorted((state_dir(base) / "evidence").glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    ev = next((e for e in map(_read_json_obj, files) if e), None)  # file mới nhất hỏng → lùi về file trước
    return {k: ev.get(k) for k in ("task", "cmd", "exit_code", "finished")} if ev else None


def loop_checkpoint(stdin_text: str, base: Path) -> None:
    """PreCompact: ghi vị trí làm việc vào state để SessionStart(compact) nạp lại. Không có vòng lặp → không làm gì."""
    st = read_state(base)
    if not st:
        return
    v = loop_verdict(base)
    try:  # quotePath=false: tên file tiếng Việt giữ nguyên; thiếu git trong PATH → bỏ qua, vẫn ghi checkpoint
        out = (
            _git(base, "-c", "core.quotePath=false", "status", "--porcelain").stdout if (base / ".git").exists() else ""
        )
    except OSError:
        out = ""
    dirty = out.splitlines()
    st["checkpoint"] = {
        "at": now_iso(),
        "trigger": _payload_field(stdin_text, "trigger") or "?",
        "verdict": v["verdict"],
        "task": v.get("task"),
        "head": _git_head(base),
        "dirty": [line[3:] for line in dirty[:20]],
        "last_evidence": _evidence_latest(base),
        "same_failure_count": st.get("same_failure_count", 0),
        "last_failure_task": st.get("last_failure_task"),
    }
    mode = _payload_field(stdin_text, "permission_mode")
    if mode:
        st["permission_mode"] = mode
    write_state(st, base)


def _loop_checkpoint(args: argparse.Namespace, base: Path) -> int:
    try:
        loop_checkpoint(sys.stdin.read() if not sys.stdin.isatty() else "", base)
    except Exception as exc:  # luôn exit 0: PreCompact exit 2 sẽ CHẶN compaction (phiên kẹt vì context đầy)
        print(f"[xt checkpoint] lỗi, bỏ qua: {type(exc).__name__}: {exc}", file=sys.stderr)
    return 0


def _loop_resume(args: argparse.Namespace, base: Path) -> int:
    cur = read_state(base)
    if not cur:
        print("✗ Chưa có vòng lặp (chạy loop init trước)", file=sys.stderr)
        return 2
    cleared = list(_deferred(cur))
    cur.update(
        {
            "active": True,
            "blocked": False,
            "blocked_reason": None,
            "same_failure_count": 0,
            "last_failure_signature": None,
            "resumed_at": now_iso(),
            "resume_reason": args.reason,
        }
    )
    cur.pop("ended", None)
    cur.pop("final_verdict", None)
    cur.pop("deferred", None)  # người đã xử lý: việc chờ quay lại hàng làm; còn cần người thì agent defer lại
    write_state(cur, base)
    print(f"▶ Autopilot tiếp tục (vòng {cur.get('iterations', 0)}/{cur.get('max_iterations', 50)}): {args.reason}")
    if cleared:
        print("  việc chờ người quay lại hàng làm: " + ", ".join(cleared))
    return 0


def _loop_stop(args: argparse.Namespace, base: Path) -> int:
    cur = read_state(base)
    if cur:
        cur.update(
            {
                "active": False,
                "ended": now_iso(),
                "stop_reason": args.reason,
                "final_verdict": {"verdict": "stopped", "reason": args.reason},
            }
        )
        write_state(cur, base)
    print("■ Autopilot tắt.")
    return 0


def _loop_hook_stop(args: argparse.Namespace, base: Path) -> int:
    try:
        out, code = hook_stop(sys.stdin.read() if not sys.stdin.isatty() else "", base)
    except Exception as exc:  # fail-open: hook lỗi không được kẹt phiên
        print(f"[xt hook-stop] lỗi, cho dừng: {type(exc).__name__}: {exc}", file=sys.stderr)
        # BASE-ERR-009: stacktrace + chuỗi nguyên nhân (`__cause__`/`__context__`) không cắt.
        print("".join(traceback.format_exception(exc)), end="", file=sys.stderr)
        return 0
    if out:
        print(out)
    return code


# Bảng tra `loop <lệnh con>` -> hàm xử lý (args, thư mục dự án) -> exit code.
LOOP_HANDLERS: Dict[str, Callable[[argparse.Namespace, Path], int]] = {
    "init": _loop_init,
    "status": _loop_status,
    "record": _loop_record,
    "block": _loop_block,
    "decide": _loop_decide,
    "defer": _loop_defer,
    "checkpoint": _loop_checkpoint,
    "resume": _loop_resume,
    "stop": _loop_stop,
    "hook-stop": _loop_hook_stop,
    "verify": lambda args, base: loop_verify(base),
}


def cmd_loop(args: argparse.Namespace) -> int:
    base = project_dir()
    handler = LOOP_HANDLERS.get(args.loop_cmd)
    return handler(args, base) if handler else 2


CHANGELOG_GROUPS = ("Added", "Changed", "Deprecated", "Removed", "Fixed", "Security")
CHANGELOG_VERSION_RE = re.compile(r"## \[(\d+)\.(\d+)\.(\d+)\] - (\d{4}-\d{2}-\d{2})(?: \[YANKED\])?")


def _changelog_sections(text: str) -> List[Tuple[str, List[str]]]:
    """[(heading `## …`, [tên nhóm `### …`])] theo thứ tự trong file."""
    out: List[Tuple[str, List[str]]] = []
    fence = False
    for line in text.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            fence = not fence
        if fence:
            continue
        if line.startswith("## "):
            out.append((line.rstrip(), []))
        elif line.startswith("### ") and out:
            out[-1][1].append(line[4:].strip())
    return out


def _changelog_group_errors(head: str, groups: List[str], unreleased: bool) -> List[str]:
    errors = [
        f"{head}: nhóm `### {g}` không thuộc {'/'.join(CHANGELOG_GROUPS)}"
        for g in groups
        if (g.split() or [""])[0] not in CHANGELOG_GROUPS
    ]
    if unreleased:  # bản đã phát hành là lịch sử (tag đã cắt) — chỉ chặn trùng ở phần đang viết
        kinds = Counter((g.split() or [""])[0] for g in groups)
        errors += [f"{head}: nhóm `### {g}` trùng" for g, n in kinds.items() if n > 1]
    return errors


def _changelog_date_errors(head: str, raw: str, dates: List[_dt.date]) -> List[str]:
    """Ngày ISO 8601 hợp lệ và không tăng so với bản đứng trước (mới hơn) trong file."""
    try:
        d = _dt.date.fromisoformat(raw)
    except ValueError:
        return [f"`{head}`: ngày `{raw}` không hợp lệ"]
    errs = [f"`{head}`: ngày phải giảm dần theo bản (bản cũ không mới hơn bản mới)"] if dates and d > dates[-1] else []
    dates.append(d)
    return errs


def changelog_check(text: str, version: Optional[str]) -> List[str]:
    """Keep a Changelog 1.1.0 (BASE-REPO-007): `## [Unreleased]` đầu tiên, bản có ngày ISO 8601, giảm dần,
    nhóm chuẩn, không trùng nhóm trong Unreleased; bản mới nhất == `VERSION` (nếu có)."""
    sections = _changelog_sections(text)
    if not sections or sections[0][0] != "## [Unreleased]":
        return ["mục `## ` đầu tiên phải là `## [Unreleased]`"]
    errors = _changelog_group_errors(*sections[0], unreleased=True)
    versions: List[Tuple[int, ...]] = []
    dates: List[_dt.date] = []
    for head, groups in sections[1:]:
        m = CHANGELOG_VERSION_RE.fullmatch(head)
        if not m:
            errors.append(f"`{head}`: phải dạng `## [X.Y.Z] - YYYY-MM-DD` (X.Y.Z không pre-release, ngày ISO 8601)")
            continue
        v = tuple(int(x) for x in m.groups()[:3])
        if versions and v >= versions[-1]:
            errors.append(f"`{head}`: phiên bản phải giảm dần (bản mới nhất trước)")
        versions.append(v)
        errors += _changelog_date_errors(head, m.group(4), dates)
        errors += _changelog_group_errors(head, groups, unreleased=False)
    latest = ".".join(map(str, versions[0])) if versions else None
    if version and latest != version:
        errors.append(f"VERSION = {version} nhưng bản mới nhất trong CHANGELOG là {latest or '(không có)'}")
    return errors


def cmd_changelog_check(args: argparse.Namespace) -> int:
    path = Path(args.file)
    vfile = path.parent / "VERSION"
    version = vfile.read_text(encoding="utf-8").strip() if vfile.is_file() else None
    errors = changelog_check(path.read_text(encoding="utf-8"), version)
    for e in errors:
        print(f"✗ {args.file}: {e}")
    if not errors:
        print(
            f"✓ {args.file}: Keep a Changelog — Unreleased đầu, bản có ngày, giảm dần, khớp VERSION {version or '—'}."
        )
    return 1 if errors else 0


def cmd_progress_check(args: argparse.Namespace) -> int:
    errors = progress_check(Path(args.file))
    for e in errors:
        print(f"✗ {args.file}: {e}")
    if not errors:
        print(f"✓ {args.file}: ≤ {PROGRESS_MAX_BYTES} byte, đủ 4 mục, SHA bàn giao là tổ tiên HEAD.")
    return 1 if errors else 0


def cmd_ci_check(args: argparse.Namespace) -> int:
    d = Path(args.dir or ".github/workflows")
    if not d.is_dir():
        if args.dir:  # chỉ định rõ mà không có → sai cách dùng
            raise OSError(f"không thấy thư mục workflow: {d}")
        print(f"– Không có {d} — bỏ qua.")
        return 0
    results = ci_check(d)
    bad = 0
    for name, errors in results.items():
        for e in errors:
            print(f"✗ {d / name}: {e}")
        bad += len(errors)
    if not bad:
        print(
            f"✓ {len(results)} workflow: permissions, ghim SHA, timeout, không continue-on-error, không secret trên PR."
        )
    return 1 if bad else 0


def cmd_audit(args: argparse.Namespace) -> int:
    root = project_dir()
    if args.audit_cmd == "plan":
        bp = (
            Path(args.blueprint)
            if args.blueprint
            else (root / "BLUEPRINT.md" if (root / "BLUEPRINT.md").exists() else None)
        )
        st = Path(args.status) if args.status else root / "docs" / "ops" / "AUDIT-STATUS.md"
        plan = audit_plan(root, bp, st)
        if args.json:
            print(json.dumps(plan, ensure_ascii=False, indent=2))
            return 0
        sig = plan["signals"]
        print(f"Audit plan — {root} @ {(plan['head'] or 'không có git')[:12]}")
        print(
            f"Tín hiệu: {sig['files']} file · mã: {', '.join(f'{k} {v}' for k, v in sig['langs'].items()) or 'không'}"
            f" · test {sig['tests']} · UI {sig['ui']} · CSDL {sig['db']} · CI {len(sig['ci'])}"
            f" · harness: {', '.join(sig['harness']) or 'không'}" + (" · REPO KHUNG" if sig["framework_repo"] else "")
        )
        print("\nNhóm:")
        for g in plan["groups"]:
            tools = plan["tools"].get(str(g["no"]))
            tool_txt = (
                f"  [có: {', '.join(tools['có']) or '—'} · thiếu: {', '.join(tools['thiếu']) or '—'}]" if tools else ""
            )
            print(f"  {g['no']:>2} {g['code']:<5} {g['state']:<8} {g['reason']}{tool_txt}")
        if plan["stale_evidence"]:
            print(
                f"\nBằng chứng/miễn trừ blueprint trỏ file đã đổi sau khi ghi ({len(plan['stale_evidence'])}) — xác minh lại:"
            )
            stale = plan["stale_evidence"]
            for e in stale[:25]:
                print(f"  {e['id']:<18} {e['kind']:<10} ← {', '.join(e['files'])}")
            if len(stale) > 25:
                print(f"  … và {len(stale) - 25} mục nữa (--json để xem hết)")
        if plan["rescan"] is not None:
            print("\nQuét lại theo AUDIT-STATUS:" + ("" if plan["rescan"] else " không nhóm nào đổi"))
            for no, why in plan["rescan"].items():
                print(f"  {no:>2} {AUDIT_GROUPS[int(no) - 1][1]:<5} {why}")
        print(
            "\nCông cụ thiếu → bằng chứng nhóm đó là `chưa biết:` cho tới khi cài/chạy được. Phương pháp: framework/00-method/audit.md"
        )
        return 0
    errors, counts = audit_check(Path(args.file), strict=args.strict)
    for e in errors:
        print(f"✗ {args.file}: {e}")
    summary = " · ".join(f"{k} {v}" for k, v in sorted(counts.items())) or "trống"
    print(("✗" if errors else "✓") + f" {args.file}: {summary}" + (" (--strict)" if args.strict else ""))
    return 1 if errors else 0


# --------------------------------------------------------------------------- feedback (dự án đích → khung, ADR-0010)

FEEDBACK_DIR = "docs/xtemplates-feedback"
FEEDBACK_KINDS = ("cong-cu", "hook-chan-nham", "hook-lot", "muc-sai", "tai-lieu", "mien-tru", "bi-chan")
FEEDBACK_FIELDS = (
    ("framework", "Khung"),
    ("date", "Ngày"),
    ("kind", "Loại"),
    ("id", "ID"),
    ("symptom", "Triệu chứng"),
    ("repro", "Tái hiện"),
    ("fix", "Cách khắc phục"),
    ("suggest", "Đề xuất cho khung"),
    ("source", "Nguồn"),
)
FB_FILE_RE = re.compile(r"^FB-(\d{3,})\.md$")
FB_LINE_RE = re.compile(r"^- (?P<label>[^:]+): (?P<value>.*)$")


def _framework_version(base: Path) -> str:
    """Phiên bản khung đang cài: `.xtemplates/VERSION` (dự án đích) hoặc `VERSION` (repo khung)."""
    for p in (base / ".xtemplates" / "VERSION", base / "VERSION"):
        if p.is_file():
            return _one_line(p.read_text(encoding="utf-8")) or "?"
    return "?"


def feedback_entries(d: Path) -> List[Dict[str, str]]:
    """Đọc mọi `FB-NNN.md` trong thư mục → [{file, framework, kind, id, …}] theo số tăng dần; dòng lạ bỏ qua."""
    labels = {lab: key for key, lab in FEEDBACK_FIELDS}
    out = []
    files = sorted((p for p in d.glob("FB-*.md") if FB_FILE_RE.match(p.name)), key=lambda p: int(p.name[3:-3]))
    for f in files:
        e = {"file": f.name}
        for line in f.read_text(encoding="utf-8").splitlines():
            m = FB_LINE_RE.match(line)
            if m and m["label"] in labels:
                e[labels[m["label"]]] = m["value"]
        out.append(e)
    return out


def write_feedback(base: Path, entry: Dict[str, str]) -> str:
    """Ghi một phản hồi thành `FB-NNN.md` kế tiếp; mọi trường gộp một dòng và qua `redact` (LOOP-FB-003)."""
    d = base / FEEDBACK_DIR
    nums = [int(m[1]) for p in d.glob("FB-*.md") if (m := FB_FILE_RE.match(p.name))] if d.is_dir() else []
    fid = f"FB-{max(nums, default=0) + 1:03d}"
    e = {"framework": _framework_version(base), "date": now_iso(), **entry}
    clean = {k: redact(_one_line(e.get(k, ""))) for k, _ in FEEDBACK_FIELDS}
    body = "".join(f"- {lab}: {clean[k] or '—'}\n" for k, lab in FEEDBACK_FIELDS)
    write_atomic(d / f"{fid}.md", f"# {fid} · {clean['kind']} · {clean['id']}\n\n{body}")
    return fid


def _feedback_add(args: argparse.Namespace, base: Path) -> int:
    if not (_one_line(args.symptom) and _one_line(args.fix)):
        print("✗ --symptom và --fix không được rỗng", file=sys.stderr)
        return 2
    entry = {"kind": args.kind, "id": args.id, "symptom": args.symptom, "repro": args.repro or "", "fix": args.fix}
    fid = write_feedback(base, {**entry, "suggest": args.suggest or "", "source": "tay"})
    print(f"✓ {fid} → {FEEDBACK_DIR}/{fid}.md (xem lại trước khi commit: không dữ liệu/mã của dự án)")
    return 0


def _collect_candidates(base: Path, blueprint: str) -> List[Dict[str, str]]:
    """Tín hiệu máy có sẵn: MUST bị miễn trong blueprint, lý do `blocked`/verdict cuối `blocked` của autopilot."""
    out = []
    bp = base / blueprint
    if bp.is_file():
        for line in bp.read_text(encoding="utf-8").splitlines():
            m = ITEM_RE.match(line)
            if m and m["state"] == "~" and m["level"] == "MUST":
                key = next((k for k in ("Miễn:", "Không áp dụng:") if k in line), "")
                why = line.split(key, 1)[1].strip() if key else "(thiếu lý do)"
                out.append({"kind": "mien-tru", "id": m["id"], "symptom": f"MUST bị miễn: {why}", "fix": "miễn trừ"})
    st = read_state(base) or {}
    fv_raw = st.get("final_verdict")
    fv: Dict[str, Any] = fv_raw if isinstance(fv_raw, dict) else {}
    reason = st.get("blocked_reason") or (fv.get("reason") if fv.get("verdict") == "blocked" else None)
    if reason:
        tid = st.get("last_failure_task") or "loop"
        out.append({"kind": "bi-chan", "id": str(tid), "symptom": f"autopilot bị chặn: {reason}", "fix": "người xử lý"})
    return out


def _feedback_collect(args: argparse.Namespace, base: Path) -> int:
    d = base / FEEDBACK_DIR
    seen = {e.get("source") for e in feedback_entries(d)} if d.is_dir() else set()
    added = []
    for c in _collect_candidates(base, args.blueprint):
        source = f"collect:{c['kind']}:{c['id']}:{_one_line(c['symptom'])[:80]}"
        if redact(source) in seen:
            continue
        added.append(write_feedback(base, {**c, "source": source}))
        seen.add(redact(source))
    print(f"✓ Thêm {len(added)} phản hồi tự gom" + (f": {', '.join(added)}" if added else " (không có tín hiệu mới)"))
    return 0


def _feedback_list(args: argparse.Namespace, base: Path) -> int:
    d = Path(args.dir) if args.dir else base / FEEDBACK_DIR
    entries = feedback_entries(d) if d.is_dir() else []
    if args.json:
        print(json.dumps(entries, ensure_ascii=False))
    for e in [] if args.json else entries:
        print(f"{e['file']}  {e.get('kind', '?'):<15} {e.get('id', '?'):<16} {e.get('symptom', '')[:90]}")
    return 0


def feedback_aggregate(sources: List[Tuple[str, Path]]) -> List[Dict[str, Any]]:
    """Gộp phản hồi nhiều dự án theo (loại, ID). `ready` = ≥ 2 dự án cùng báo hoặc có bước tái hiện (ADR-0010)."""
    groups: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for project, d in sources:
        for e in feedback_entries(d) if d.is_dir() else []:
            key = (e.get("kind", "?"), e.get("id", "?"))
            g = groups.setdefault(key, {"kind": key[0], "id": key[1], "projects": [], "items": []})
            g["projects"] = sorted(set(g["projects"]) | {project})
            # FB có thể đã sửa tay sau `feedback add` → che lại trước khi ra PR nháp ở repo khung public (AUD-CFG-002).
            g["items"].append({"project": project, **{k: redact(v) if isinstance(v, str) else v for k, v in e.items()}})
    out = list(groups.values())
    for g in out:
        has_repro = any(i.get("repro", "—") not in ("", "—") for i in g["items"])
        g["ready"] = len(g["projects"]) >= 2 or has_repro
    return sorted(out, key=lambda g: (not g["ready"], -len(g["projects"]), g["kind"], g["id"]))


def _feedback_aggregate(args: argparse.Namespace, base: Path) -> int:
    sources = []
    for spec in args.source:
        project, sep, path = spec.partition("=")
        if not (sep and project and path):
            print(f"✗ --from phải dạng <dự-án>=<thư mục>: {spec}", file=sys.stderr)
            return 2
        sources.append((project, Path(path)))
    groups = feedback_aggregate(sources)
    if args.json:
        print(json.dumps(groups, ensure_ascii=False))
        return 0
    print(
        "| Đủ ngưỡng | Loại | ID | Dự án | Triệu chứng (đầu tiên) | Cách khắc phục (đầu tiên) |\n|---|---|---|---|---|---|"
    )
    for g in groups:
        first = g["items"][0]
        cells = [
            "✅" if g["ready"] else "—",
            g["kind"],
            f"`{g['id']}`",
            ", ".join(g["projects"]),
            first.get("symptom", "").replace("|", "\\|")[:160],
            first.get("fix", "").replace("|", "\\|")[:160],
        ]
        print("| " + " | ".join(cells) + " |")
    return 0


FEEDBACK_HANDLERS: Dict[str, Callable[[argparse.Namespace, Path], int]] = {
    "add": _feedback_add,
    "collect": _feedback_collect,
    "list": _feedback_list,
    "aggregate": _feedback_aggregate,
}


def cmd_feedback(args: argparse.Namespace) -> int:
    return FEEDBACK_HANDLERS[args.fb_cmd](args, project_dir())


def _print_doctor(base: Path, findings: List[Finding], fixed: List[str], fixing: bool) -> None:
    print(f"Audit khung — {base} (khung {framework_version()})")
    for what in fixed:
        print(f"🔧 đã sửa: {what}")
    for f in sorted(findings, key=lambda f: f.level != "error"):
        hint = "  (sửa được: `xt.py doctor --fix`)" if f.fix and not fixing else ""
        print(f"{'✗' if f.level == 'error' else '⚠'} [{f.code}] {f.msg}{hint}")
    n_err = sum(f.level == "error" for f in findings)
    tail = f"{n_err} lỗi · {len(findings) - n_err} cảnh báo · {len(fixed)} đã sửa"
    if n_err:
        print(f"✗ Chưa sẵn sàng cho autopilot: {tail} — sửa lỗi ✗ trước `loop init`")
    else:
        print(f"✓ Sẵn sàng cho autopilot: {tail}")


def cmd_merge_check(args: argparse.Namespace) -> int:
    """Máy quyết khi nào merge PR đã mở (ADR-0013). exit 0 chỉ khi verdict = merge."""
    try:
        pr = load_pr(args)
    except PrInputError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 2
    autonomy, risk_paths, notes = merge_config(project_dir())
    d = merge_decision(pr, autonomy, risk_paths)
    if args.json:
        print(json.dumps({**d, "notes": notes}, ensure_ascii=False))
    else:
        print(f"{d['verdict'].upper()} · PR #{d['pr']} · làn {d['lane']}")
        for r in [*d["reasons"], *notes]:
            print(f"  - {r}")
        if d["next"]:
            print(f"→ {d['next']}")
    return 0 if d["verdict"] == "merge" else 1


def cmd_doctor(args: argparse.Namespace) -> int:
    base = project_dir()
    findings = doctor_findings(base, args.framework)
    fixed: List[str] = []
    if args.fix:
        fixed, failed = doctor_fix(findings)
        findings = doctor_findings(base, args.framework) + failed
    errors = sum(f.level == "error" for f in findings)
    if args.json:  # hợp đồng máy đọc: {"ok", "base", "version", "fixed", "findings": [{code, level, msg, fixable}]}
        rows = [{"code": f.code, "level": f.level, "msg": f.msg, "fixable": f.fix is not None} for f in findings]
        doc = {"ok": not errors, "base": str(base), "version": framework_version(), "fixed": fixed, "findings": rows}
        print(json.dumps(doc, ensure_ascii=False))
    else:
        _print_doctor(base, findings, fixed, args.fix)
    return 1 if errors else 0


def cmd_stats(args: argparse.Namespace) -> int:
    docs, _ = load_docs(args.framework)
    by_kind: Dict[str, int] = {}
    levels = {lv: 0 for lv in LEVELS}
    for d in docs:
        by_kind[d.kind] = by_kind.get(d.kind, 0) + 1
        for it in d.items:
            levels[it.level] += 1
    print("File theo loại: " + ", ".join(f"{k}={v}" for k, v in sorted(by_kind.items())))
    print("Mục theo mức:   " + ", ".join(f"{k}={v}" for k, v in levels.items()))
    print(f"Tổng mục:       {sum(levels.values())}")
    return 0


def _defer_id(value: str) -> str:
    if not DEFER_ID_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(
            f"ID không hợp lệ: {value!r} (cần T-NNN hoặc ID mục blueprint như SEC-AUTH-001)"
        )
    return value


def _task_id(value: str) -> str:
    if not TASK_ID_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(f"ID không hợp lệ: {value!r} (dạng T-001 hoặc ID blueprint như BASE-SEC-001)")
    return value


def framework_version() -> str:
    """Phiên bản khung: file VERSION cạnh thư mục scripts/ (repo khung hoặc .xtemplates/ của dự án)."""
    try:
        return (SCRIPT_DIR.parent / "VERSION").read_text(encoding="utf-8").strip()
    except OSError:
        return "unknown"


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="xt.py",
        description="Công cụ khung X-Templates",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="ví dụ:\n"
        "  xt.py list profiles\n"
        "  xt.py compose --profile web-app --industry fintech --scale M --out BLUEPRINT.md\n"
        "  xt.py blueprint-status BLUEPRINT.md --strict\n"
        "  xt.py loop record --task T-001 -- python3 -m unittest\n\n"
        "mã thoát: 0 ổn · 1 vi phạm/chưa đạt · 2 sai cách dùng hoặc không đọc được file/thư mục",
    )
    p.add_argument("--version", action="version", version=f"%(prog)s {framework_version()}")
    p.add_argument(
        "--framework",
        type=Path,
        default=Path(os.environ.get("XT_FRAMEWORK", DEFAULT_FRAMEWORK)),
        help="thư mục framework/ (mặc định: cạnh scripts/)",
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("validate").set_defaults(fn=cmd_validate)
    pl = sub.add_parser("list")
    pl.add_argument("what", choices=["profiles", "industries", "modules"])
    pl.set_defaults(fn=cmd_list)
    pc = sub.add_parser("compose")
    pc.add_argument("--profile", required=True)
    pc.add_argument("--industry", action="append")
    pc.add_argument("--scale", choices=SCALES, default="M")
    pc.add_argument("--include-may", action="store_true")
    pc.add_argument(
        "--add",
        action="append",
        metavar="MODULE",
        help="ghép thêm module/glob ngoài hồ sơ (vd 13-ai-engineering/*), bỏ lọc applies_to",
    )
    pc.add_argument(
        "--out", help="ghi FILE (MUST theo quy mô) + <tên>-BACKLOG.md (SHOULD/MAY) cạnh nó; ghép lại giữ trạng thái"
    )
    pc.add_argument("--full", action="store_true", help="một file chứa mọi mức như trước ADR-0012 (không tách backlog)")
    pc.set_defaults(fn=cmd_compose)
    pm = sub.add_parser("merge-check", help="máy quyết khi nào merge PR đã mở (ADR-0013)")
    pm.add_argument("--pr", help="số/URL/nhánh của PR (mặc định PR của nhánh hiện tại)")
    pm.add_argument(
        "--pr-json",
        help=f"đọc JSON `gh pr view --json {MERGE_FIELDS}` từ FILE hoặc - (stdin) thay vì gọi REST qua `gh api`",
    )
    pm.add_argument("--json", action="store_true", help="in JSON (pr, verdict, lane, reasons, next, notes)")
    pm.set_defaults(fn=cmd_merge_check)
    pb = sub.add_parser("blueprint-status")
    pb.add_argument("file", help="BLUEPRINT.md, hoặc - để đọc stdin")
    pb.add_argument("--strict", action="store_true", help="exit 1 khi còn MUST mở hoặc miễn trừ thiếu lý do")
    pb.add_argument("--json", action="store_true", help="in JSON (levels, open_must, bad_waivers, bad_lines, ok)")
    pb.set_defaults(fn=cmd_blueprint_status)
    plp = sub.add_parser("loop")
    lsub = plp.add_subparsers(dest="loop_cmd", required=True)
    li = lsub.add_parser("init")
    li.add_argument("--plan", default="docs/autopilot/PLAN.md")
    li.add_argument("--blueprint")
    li.add_argument(
        "--max-iterations", type=int, help="mặc định 50; với --single-session: max(20, 4 × số task chưa làm)"
    )
    li.add_argument(
        "--single-session",
        action="store_true",
        help="chạy tới xong trong một phiên: compaction thay bàn giao, việc cần người dùng loop defer (ADR-0009)",
    )
    li.add_argument("--hours", type=float)
    ls = lsub.add_parser("status")
    ls.add_argument("--json", action="store_true")
    lr = lsub.add_parser("record")
    lr.add_argument("--task", required=True, type=_task_id)
    lr.add_argument("cmd", nargs=argparse.REMAINDER)
    lb = lsub.add_parser("block")
    lb.add_argument("--reason", required=True)
    lde = lsub.add_parser("defer", help="việc cần người: bỏ qua để làm việc khác, gom cuối phiên (done-pending-human)")
    lde.add_argument("--task", required=True, type=_defer_id, help="T-NNN trong PLAN hoặc ID mục blueprint")
    lde.add_argument("--reason", required=True)
    lsub.add_parser("checkpoint", help="dùng bởi PreCompact hook: ghi vị trí làm việc trước khi nén; luôn exit 0")
    lsub.add_parser("verify", help="kiểm lại cuối: chạy lại mọi Gate trên cây hiện tại (Stop hook đòi trước khi done)")
    ld = lsub.add_parser("decide", help="phiên chính tự duyệt một điểm quyết định, ghi nhật ký D-NNN (LOOP-STOP-018)")
    ld.add_argument("--question", required=True)
    ld.add_argument("--option", action="append", required=True, help="một phương án; lặp ≥ 2 lần")
    ld.add_argument("--choice", required=True, help="số thứ tự (từ 1) hoặc nguyên văn phương án chọn")
    ld.add_argument("--why", required=True, help="lý do theo tiêu chí chất lượng cuối")
    ld.add_argument("--revert", required=True, help="đường lùi nếu người đổi ý")
    ld.add_argument("--prod", help="đề xuất chuyển sang dịch vụ khác khi chạy thật (phương án chọn là tự host)")
    ld.add_argument("--log", default="docs/autopilot/DECISIONS.md")
    lrs = lsub.add_parser("resume")
    lrs.add_argument("--reason", default="người đã xử lý điểm dừng")
    lst = lsub.add_parser("stop")
    lst.add_argument("--reason", default="dừng thủ công")
    lsub.add_parser("hook-stop")
    plp.set_defaults(fn=cmd_loop)
    pcl = sub.add_parser("changelog-check")
    pcl.add_argument("file", nargs="?", default="CHANGELOG.md")
    pcl.set_defaults(fn=cmd_changelog_check)
    pp = sub.add_parser("progress-check")
    pp.add_argument("file", nargs="?", default="PROGRESS.md")
    pp.set_defaults(fn=cmd_progress_check)
    pci = sub.add_parser("ci-check")
    pci.add_argument("dir", nargs="?", help="thư mục workflow (mặc định .github/workflows, không có thì bỏ qua)")
    pci.set_defaults(fn=cmd_ci_check)
    pau = sub.add_parser("audit")
    asub = pau.add_subparsers(dest="audit_cmd", required=True)
    aplan = asub.add_parser("plan")
    aplan.add_argument("--blueprint", help="mặc định BLUEPRINT.md ở gốc dự án nếu có")
    aplan.add_argument("--status", help="mặc định docs/ops/AUDIT-STATUS.md")
    aplan.add_argument("--json", action="store_true")
    achk = asub.add_parser("check")
    achk.add_argument("file", help="docs/ops/AUDIT-STATUS.md")
    achk.add_argument("--strict", action="store_true", help="Definition of Complete: 0 🔴/🟠 mở, mọi nhóm đã quét/N/A")
    pau.set_defaults(fn=cmd_audit)
    pfb = sub.add_parser("feedback", help="phản hồi lỗi/cách khắc phục từ dự án đích về khung (ADR-0010)")
    fsub = pfb.add_subparsers(dest="fb_cmd", required=True)
    fa = fsub.add_parser("add", help="ghi một phản hồi FB-NNN (lỗi do khung, không phải lỗi dự án)")
    fa.add_argument("--kind", required=True, choices=FEEDBACK_KINDS)
    fa.add_argument("--id", required=True, help="ID mục checklist, lệnh xt.py hoặc tên hook/skill")
    fa.add_argument("--symptom", required=True)
    fa.add_argument("--fix", required=True, help="cách đã khắc phục trong dự án")
    fa.add_argument("--repro", help="bước tái hiện tối thiểu, không dữ liệu/mã của dự án")
    fa.add_argument("--suggest", help="đề xuất sửa khung")
    fc = fsub.add_parser("collect", help="tự gom MUST bị miễn + lý do autopilot bị chặn thành FB-NNN (không trùng)")
    fc.add_argument("--blueprint", default="BLUEPRINT.md")
    fl = fsub.add_parser("list")
    fl.add_argument("dir", nargs="?", help=f"mặc định {FEEDBACK_DIR}")
    fl.add_argument("--json", action="store_true")
    fg = fsub.add_parser("aggregate", help="repo khung: gộp phản hồi nhiều dự án theo (loại, ID)")
    fg.add_argument("--from", dest="source", action="append", required=True, metavar="DỰ_ÁN=THƯ_MỤC")
    fg.add_argument("--json", action="store_true")
    pfb.set_defaults(fn=cmd_feedback)
    pdr = sub.add_parser("doctor", help="audit khung đã cài (harness, xt.yaml, khung, state) trước /autopilot")
    pdr.add_argument("--fix", action="store_true", help="sửa an toàn, đảo ngược được (không đụng hook/settings)")
    pdr.add_argument("--json", action="store_true")
    pdr.set_defaults(fn=cmd_doctor)
    sub.add_parser("stats").set_defaults(fn=cmd_stats)
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    args.framework = Path(args.framework).resolve()
    if args.cmd in ("validate", "list", "compose", "stats") and not args.framework.is_dir():
        print(f"✗ Không thấy thư mục khung: {args.framework}", file=sys.stderr)
        return 2
    try:
        rc: int = args.fn(args)
        return rc
    except OSError as exc:  # file thiếu/không đọc được: một dòng dễ hiểu; XT_DEBUG=1 để xem traceback
        if os.environ.get("XT_DEBUG"):
            raise
        print(f"✗ {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
