#!/usr/bin/env python3
"""xt.py — công cụ dòng lệnh của khung X-Templates (chỉ dùng thư viện chuẩn Python >= 3.11).

Lệnh:
  validate                      Kiểm quy ước toàn khung (frontmatter, ID, liên kết, hồ sơ/gói ngành).
  list [profiles|industries|modules]
  compose --profile P [--industry I ...] [--scale S|M|L] [--include-may] [--add MODULE ...] [--out FILE]
                                Ghép baseline + hồ sơ + gói ngành thành BLUEPRINT.md cho dự án.
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
  ci-check [DIR]                Fitness function cho workflow CI (permissions, ghim SHA, timeout, continue-on-error).
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
PREFIX_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
LINK_SUB_RE = re.compile(r"(\[[^\]]*\])\(([^)\s]+)\)")
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
TASK_ID_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3,}$")
NOTE_RE = re.compile(r"\s—\s(?:Bằng chứng|Miễn|Thiếu):.*$")
SECRET_RE = re.compile(r"(?i)\b(\w*(?:token|secret|passw(?:or)?d|api[_-]?key)\w*)(\s*[=:]\s*)\S+")
# Dạng bí mật phổ biến khác (AUD-CFG-001): giá trị bị thay bằng *** nhưng giữ tiền tố để còn đọc được ngữ cảnh.
SECRET_PATTERNS = (
    (re.compile(r"(?i)\b(bearer|basic|token)(\s+)[A-Za-z0-9._~+/=-]{8,}"), r"\1\2***"),
    (re.compile(r"(?i)([\"']?\w*(?:token|secret|passw(?:or)?d|api[_-]?key)\w*[\"']?\s*:\s*)\"[^\"]*\""), r'\1"***"'),
    (re.compile(r"(?i)(--(?:password|passwd|token|secret|api-key)[= ])\S+"), r"\1***"),
    (re.compile(r"(://[^/\s:@]+:)[^@\s/]+@"), r"\1***@"),
    (re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"), r"\1***"),
    (re.compile(r"\b(gh[pousr]_|github_pat_|xox[abpr]-|sk_live_|sk_test_|sk-|glpat-)[A-Za-z0-9_-]{8,}"), r"\1***"),
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
    root: Path, ordered: List[Doc], scale: str, include_may: bool
) -> Tuple[List[str], Dict[str, int]]:
    """Mỗi tài liệu có mục thành một phần `### tiêu đề` + danh sách mục ở mức hiệu lực theo quy mô; đếm theo mức."""
    counts = {lv: 0 for lv in LEVELS}
    sections: List[str] = []
    for d in ordered:
        rows = []
        for it in d.items:
            lv = effective_level(it, scale, d.kind)
            if lv == "MAY" and not include_may:
                continue
            counts[lv] += 1
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
) -> List[str]:
    """Frontmatter + đầu trang + bảng đếm mục của BLUEPRINT.md (các dòng, chưa nối)."""
    ind_names = ", ".join(ind_slugs) or "(không)"
    header = [
        "---",
        "title: Blueprint dự án",
        "kind: blueprint",
        f"profile: {profile}",
        f"industries: [{', '.join(ind_slugs)}]",
        f"extra: [{', '.join(extra)}]",
        f"scale: {scale}",
        f"generated: {today}",
        "---",
        "",
        "# Blueprint dự án",
        "",
        f"> Sinh bởi `xt.py compose` ngày {today} — hồ sơ **{profile}**, ngành **{ind_names}**, quy mô **{scale}**.",
        "> Trạng thái: `[ ]` chưa · `[x]` đạt (kèm bằng chứng ở PR/CI) · `[~]` miễn trừ — bắt buộc ghi `— Miễn: <lý do>`.",
        "> Kiểm tiến độ: `python3 scripts/xt.py blueprint-status BLUEPRINT.md --strict` (còn MUST chưa đạt → exit 1).",
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
    docs, errors = load_docs(root)
    if errors:
        raise SystemExit("Khung có lỗi, chạy 'xt.py validate' trước:\n  " + "\n  ".join(errors[:20]))
    prof, inds = _pick_sources(docs, profile, industries)
    extra = extra or []
    ordered = _compose_order(docs, profile, prof, inds, extra)
    today = today or _dt.date.today().isoformat()
    sections, counts = _compose_sections(root, ordered, scale, include_may)
    ind_slugs = [str(i.meta.get("slug")) for i in inds]
    header = _compose_header(profile, ind_slugs, extra, scale, today, counts, include_may)
    return "\n".join(header) + "\n" + "\n\n".join(sections) + "\n"


def carry_states(old: str, new: str) -> Tuple[str, int]:
    """Chuyển ô trạng thái + ghi chú (— Bằng chứng/Miễn/Thiếu: …) từ blueprint cũ sang bản ghép mới theo ID."""
    prev: Dict[str, Tuple[str, str]] = {}
    for line in unicodedata.normalize("NFC", old).splitlines():
        m = ITEM_RE.match(line)
        if m:
            nm = NOTE_RE.search(line)
            prev[m["id"]] = (m["state"], nm.group(0) if nm else "")
    kept, lines = 0, []
    for line in new.splitlines():
        m = ITEM_RE.match(line)
        if m and prev.get(m["id"], (" ", "")) != (" ", ""):
            state, note = prev[m["id"]]
            line = f"- [{state}]{line[5:]}{note}"
            kept += 1
        lines.append(line)
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


def blueprint_status(path: Path) -> Dict[str, Any]:
    return blueprint_status_text(path.read_text(encoding="utf-8"))


def blueprint_status_text(raw: str) -> Dict[str, Any]:
    total = {lv: {"open": 0, "done": 0, "waived": 0} for lv in LEVELS}
    bad_waivers: List[str] = []
    open_must: List[str] = []
    text = unicodedata.normalize("NFC", raw)
    for n, line in enumerate(text.splitlines(), start=1):
        m = ITEM_RE.match(line)
        if not m:
            continue
        st = m["state"]
        lv = m["level"]
        if st == " ":
            total[lv]["open"] += 1
            if lv == "MUST":
                open_must.append(m["id"])
        elif st == "~":
            total[lv]["waived"] += 1
            if "Miễn:" not in line:
                bad_waivers.append(f"{m['id']} (dòng {n})")
        else:
            total[lv]["done"] += 1
    return {"levels": total, "open_must": open_must, "bad_waivers": bad_waivers}


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


def _verdict_task(t: Dict[str, Any], base: Path, deferred: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Một task trong PLAN: chưa làm → continue (trừ khi đang chờ người); đã tick mà thiếu/lệch bằng chứng → verify;
    ổn (hoặc miễn) thì None."""
    if t["state"] == " " and t["id"] in deferred:
        return None
    if t["state"] == " ":
        return {"verdict": "continue", "task": t["id"], "reason": f"làm task {t['id']}: {t['title']}"}
    if t["state"] != "x":
        return None
    ev = read_evidence(t["id"], base)
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
    if not same_command(ev.get("cmd") or "", t["gate"]):
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
    deferred = _deferred(st)
    for t in tasks:
        v = _verdict_task(t, base, deferred)
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
        return {"verdict": "continue", "reason": "mục miễn trừ thiếu lý do: " + ", ".join(s["bad_waivers"][:5])}
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


def loop_record(task: str, cmd: List[str], base: Optional[Path] = None) -> int:
    base = base or project_dir()
    st = read_state(base) or {}
    try:
        timeout = int(os.environ.get("XT_RECORD_TIMEOUT", "1800"))
    except ValueError:
        print("✗ XT_RECORD_TIMEOUT phải là số giây nguyên dương", file=sys.stderr)
        return 2
    started = now_iso()
    # Một đối số = chuỗi shell nguyên văn (cho phép `a && b`, ống); nhiều đối số = argv, ghép bằng shlex để giữ nháy (AUD-HAR-002).
    cmd_str = cmd[0] if len(cmd) == 1 else shlex.join(cmd)
    try:
        proc = subprocess.run(cmd_str, shell=True, cwd=base, capture_output=True, text=True, timeout=timeout)
        code, out = proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired as exc:
        code, out = 124, f"timeout: {exc}"
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


def ci_check_text(text: str) -> List[str]:
    """Fitness function cho một workflow GitHub Actions (đọc theo dòng, chỉ thư viện chuẩn).

    Luật: `permissions:` cấp workflow · không `write-all` · `uses:` ngoài ghim SHA 40 ký tự (`docker://` ghim `@sha256:`) ·
    mọi job có `timeout-minutes` (trừ job gọi reusable workflow) · không `continue-on-error`.
    Bỏ qua nội dung block scalar (`run: |`) để script shell không gây báo nhầm.
    """
    lines = _ci_lines(text)
    errors: List[str] = []
    if not any(ln.startswith("permissions:") for _, ln in lines):
        errors.append("thiếu `permissions:` cấp workflow (mặc định `contents: read`)")
    for no, line in lines:
        errors += _ci_line_errors(no, line)
    return errors + _ci_timeout_errors(lines)


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
        note = re.search(r"\s—\s(Bằng chứng|Miễn):(.*)$", line)
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
        "stale_evidence": blueprint_stale_evidence(root, blueprint, files) if blueprint else [],
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


def cmd_compose(args: argparse.Namespace) -> int:
    out = compose(args.framework, args.profile, args.industry or [], args.scale, args.include_may, extra=args.add or [])
    if args.out:
        out_path = Path(args.out)
        if out_path.exists():  # ghép lại: giữ tick/miễn trừ/bằng chứng theo ID, không mất công audit
            out, kept = carry_states(out_path.read_text(encoding="utf-8"), out)
            print(f"↺ Giữ trạng thái {kept} mục theo ID từ bản cũ", file=sys.stderr)
        write_atomic(out_path, out)
        print(f"✓ Đã ghi {args.out}")
    else:
        sys.stdout.write(out)
    return 0


def cmd_blueprint_status(args: argparse.Namespace) -> int:
    s = blueprint_status_text(sys.stdin.read()) if args.file == "-" else blueprint_status(Path(args.file))
    ok = not s["open_must"] and not s["bad_waivers"]
    if args.json:  # hợp đồng máy đọc: {"levels", "open_must", "bad_waivers", "ok"}
        print(json.dumps({**s, "ok": ok}, ensure_ascii=False))
        return 0 if ok or not args.strict else 1
    for lv in LEVELS:
        c = s["levels"][lv]
        print(f"{lv:<7} đạt {c['done']:>4} · miễn {c['waived']:>4} · chưa {c['open']:>4}")
    if s["bad_waivers"]:
        print("✗ Miễn trừ thiếu lý do: " + ", ".join(s["bad_waivers"]))
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
        n_open = len(_still_open(base, {"plan": args.plan, "blueprint": args.blueprint}))  # task [ ] + MUST mở
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
        print(f"✓ {len(results)} workflow: permissions, ghim SHA, timeout, không continue-on-error.")
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
                why = line.split("Miễn:", 1)[1].strip() if "Miễn:" in line else "(thiếu lý do)"
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
            g["items"].append({"project": project, **e})
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
    pc.add_argument("--out")
    pc.set_defaults(fn=cmd_compose)
    pb = sub.add_parser("blueprint-status")
    pb.add_argument("file", help="BLUEPRINT.md, hoặc - để đọc stdin")
    pb.add_argument("--strict", action="store_true", help="exit 1 khi còn MUST mở hoặc miễn trừ thiếu lý do")
    pb.add_argument("--json", action="store_true", help="in JSON (levels, open_must, bad_waivers, ok)")
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
