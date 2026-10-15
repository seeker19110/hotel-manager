#!/usr/bin/env python3
"""install.py — cài khung X-Templates vào một dự án đích (mọi hệ điều hành, chỉ cần Python >= 3.11).

Kết quả trong dự án đích:
  .xtemplates/framework/        bản sao thư viện yêu cầu (chỉ đọc; cập nhật bằng cách chạy lại install)
  .xtemplates/research/         bản nghiên cứu nền mà module trích dẫn
  .xtemplates/scripts/xt.py     công cụ compose / blueprint-status / loop
  .xtemplates/scripts/dev-task.sh
  .xtemplates/VERSION           SHA/nhãn phiên bản khung đã cài
  .claude/settings.json, hooks/, skills/, agents/   harness (COPY-IF-ABSENT: không đè file đã có; bản mới ghi .xtemplates-new)
  .github/rulesets/main.json, pull_request_template.md, dependabot.yml   chỉ khi --with-github (copy-if-absent)
  AGENTS.md, CLAUDE.md, PROGRESS.md, xt.yaml       từ framework/templates (copy-if-absent, bỏ frontmatter YAML; mẫu bọc ```markdown thì lấy phần trong)

Dự án đã cài bản ≤ 2.x (`.xstored/`, `xs.py`, `xs.yaml`, `XS_*`): chạy lại install là chuyển sang tên mới (ADR-0007) —
  giữ manifest hash, đổi `xs.yaml` → `xt.yaml`, xoá bản sao `.xstored/`; file người dùng còn nhắc tên cũ được liệt kê để sửa tay.

Dùng:
  python3 scripts/install.py <thư-mục-dự-án> [--force-harness] [--no-harness] [--with-github] [--label v1.0.0]
  (chạy từ bản clone của X-Templates; hoặc: python3 -c "$(curl ...)" KHÔNG được khuyến khích — tải về, kiểm checksum rồi chạy)
Thoát 0 = ổn; 2 = lỗi tham số.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from collections import Counter
from collections.abc import Callable
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent
HARNESS_FILES = ["settings.json"]
HARNESS_DIRS = ["hooks", "skills", "agents"]
ROOT_TEMPLATES = {
    "AGENTS.md": "AGENTS.md",
    "CLAUDE.md": "CLAUDE.md",
    "PROGRESS.md": "PROGRESS.md",
    "xt.yaml": "xt.yaml",
}
# Tên trước 3.0.0 (ADR-0007): dự án đã cài bản ≤ 2.x được chuyển tự động khi chạy lại install.
LEGACY_DIR = ".xstored"
LEGACY_YAML = "xs.yaml"
LEGACY_RE = re.compile(r"\.xstored\b|\bxs\.(?:py|yaml)\b|\bXS_[A-Z]|\bxs_py\b")
# --with-github: hàng rào GitHub mẫu của khung (copy-if-absent). Workflow KHÔNG copy vì job quality phụ thuộc stack.
GITHUB_FILES = [".github/rulesets/main.json", ".github/pull_request_template.md", ".github/dependabot.yml"]


def log(msg: str) -> None:
    print(f"[install] {msg}", file=sys.stderr)


def strip_frontmatter(text: str) -> str:
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                return "\n".join(lines[i + 1 :]).lstrip("\n") + "\n"
    return text


def template_body(text: str) -> str:
    """Bỏ frontmatter; mẫu bọc nội dung trong khối ```markdown (PROGRESS.md) thì chỉ lấy phần trong khối."""
    text = strip_frontmatter(text)
    lines = text.splitlines()
    start = next((i for i, ln in enumerate(lines) if ln.strip() == "```markdown"), None)
    if start is None:
        return text
    end = next((i for i in range(start + 1, len(lines)) if lines[i].strip() == "```"), len(lines))
    return "\n".join(lines[start + 1 : end]).strip("\n") + "\n"


def copy_tree_replace(src: Path, dst: Path) -> None:
    """Copy vào thư mục tạm rồi mới thay: lỗi giữa chừng không để dst mất/dở."""
    tmp = dst.with_name(dst.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.copytree(src, tmp, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    if dst.exists():
        shutil.rmtree(dst)
    tmp.rename(dst)


MANIFEST = ".xtemplates/harness.sha256.json"


def write_atomic(path: Path, text: str) -> None:
    """Ghi qua tệp tạm cùng thư mục rồi đổi tên — lỗi giữa chừng không để settings/manifest dở (BASE-DATA-009)."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_manifest(target: Path) -> dict[str, str]:
    try:
        data = json.loads((target / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def copy_if_absent(
    src: Path,
    dst: Path,
    force: bool = False,
    transform: Callable[[str], str] | None = None,
    installed_hash: str | None = None,
) -> str:
    """Trả 'copied' | 'kept' | 'updated' | 'updated-new' | 'skipped-symlink'.

    Không bao giờ đè file người dùng đã sửa (trừ force). File còn đúng hash bản khung đã cài lần trước
    (`installed_hash`, người dùng chưa sửa) thì cập nhật tại chỗ — bản sửa hook tới được dự án đã cài (AUD-HAR-004).
    Đích là symlink → bỏ qua, không đi theo (AUD-HAR-010).
    """
    data = src.read_bytes()
    if transform:
        data = transform(data.decode("utf-8")).encode("utf-8")
    dst.parent.mkdir(parents=True, exist_ok=True)
    new = dst.with_name(dst.name + ".xtemplates-new")
    if dst.is_symlink() or new.is_symlink():
        log(f"  ⚠ bỏ qua symlink {dst} (không ghi qua liên kết)")
        return "skipped-symlink"
    status = "copied"
    if dst.exists() and not force:
        current = dst.read_bytes()
        if current == data:
            return "kept"
        if installed_hash is None or sha256(current) != installed_hash:
            new.write_bytes(data)
            return "updated-new"
        status = "updated"
    dst.write_bytes(data)
    if src.suffix == ".sh":
        dst.chmod(dst.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)
    return status


def merge_hooks(src: Path, dst: Path) -> str:
    """settings.json của dự án đã có: thêm khoá `hooks` của khung còn thiếu (giữ nguyên permissions và hook riêng).

    Trước đây file có sẵn chỉ sinh `.xtemplates-new` nên hook đã copy mà không chạy (AUD-HAR-003).
    """
    if dst.is_symlink():
        log(f"  ⚠ bỏ qua symlink {dst}")
        return "skipped-symlink"
    try:
        ours = json.loads(src.read_text(encoding="utf-8"))
        theirs = json.loads(dst.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log(
            f"  ⚠ {dst}: không đọc được JSON ({exc}) — HOOK CHƯA ĐĂNG KÝ, gộp tay từ .claude/settings.json.xtemplates-new"
        )
        return "invalid-json"
    hooks = theirs.setdefault("hooks", {})
    added = 0
    for event, entries in ours.get("hooks", {}).items():
        have = {h.get("command") for e in hooks.get(event, []) for h in e.get("hooks", [])}
        for entry in entries:
            cmds = [h.get("command") for h in entry.get("hooks", [])]
            if not any(c in have for c in cmds):
                hooks.setdefault(event, []).append(entry)
                added += 1
    if not added:
        return "kept"
    write_atomic(dst, json.dumps(theirs, ensure_ascii=False, indent=2) + "\n")
    return "merged-hooks"


def framework_label(explicit: str | None) -> str:
    """Nhãn ghi vào .xtemplates/VERSION: --label, hoặc '<VERSION> (<git sha>)' của bản khung đang cài."""
    if explicit:
        return explicit
    version = (SRC / "VERSION").read_text(encoding="utf-8").strip() if (SRC / "VERSION").exists() else "unknown"
    try:
        r = subprocess.run(
            ["git", "-C", str(SRC), "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=10
        )
        if r.returncode == 0 and r.stdout.strip():
            return f"{version} ({r.stdout.strip()})"
    except (OSError, subprocess.TimeoutExpired):
        pass
    return version


def target_error(target: Path) -> str | None:
    """Lý do không cài được vào `target` (None nếu hợp lệ)."""
    if not target.is_dir():
        return f"✗ không phải thư mục: {target}"
    if target == SRC:
        return "✗ không cài khung vào chính repo khung"
    return None


def install_framework(xt_dir: Path, label: str | None) -> None:
    """Bước 1: framework + research + scripts + VERSION + README vào .xtemplates/ — thay thế toàn bộ (bản chỉ đọc)."""
    copy_tree_replace(SRC / "framework", xt_dir / "framework")
    # research/ đi kèm vì module trong framework/ trỏ tới nguồn nghiên cứu bằng đường dẫn tương đối.
    if (SRC / "research").is_dir():
        copy_tree_replace(SRC / "research", xt_dir / "research")
    (xt_dir / "scripts").mkdir(exist_ok=True)
    for f in ("xt.py", "dev-task.sh", "check-links.py"):
        shutil.copy2(SRC / "scripts" / f, xt_dir / "scripts" / f)
    (xt_dir / "scripts" / "dev-task.sh").chmod(0o755)
    version = framework_label(label)
    (xt_dir / "VERSION").write_text(version + "\n", encoding="utf-8")
    (xt_dir / "README.md").write_text(
        "# .xtemplates/\n\nBản sao khung X-Templates (chỉ đọc). Cập nhật: chạy lại `install.py` từ bản khung mới.\n"
        "Ghép blueprint: `python3 .xtemplates/scripts/xt.py compose --profile <p> --scale <S|M|L> --out BLUEPRINT.md`.\n",
        encoding="utf-8",
    )
    log(f"✓ .xtemplates/framework + scripts (phiên bản {version})")


def install_settings(target: Path, force_harness: bool, stats: Counter[str]) -> None:
    """settings.json của harness: dự án đã có (không --force-harness) thì gộp khoá hooks, chưa có thì copy."""
    settings = target / ".claude" / "settings.json"
    if settings.exists() and not force_harness:
        r = merge_hooks(SRC / ".claude" / "settings.json", settings)
        stats[r] += 1
        if r == "merged-hooks":
            log("  .claude/settings.json: đã thêm khoá hooks của khung (giữ nguyên quyền và hook riêng)")
    else:
        stats[copy_if_absent(SRC / ".claude" / "settings.json", settings, force_harness)] += 1


def harness_sources() -> list[Path]:
    """File harness của khung cần copy ngoài settings.json: HARNESS_FILES khác settings + mọi file trong HARNESS_DIRS."""
    sources = [SRC / ".claude" / f for f in HARNESS_FILES if f != "settings.json"]
    for d in HARNESS_DIRS:
        sources += [p for p in sorted((SRC / ".claude" / d).rglob("*")) if p.is_file() and "__pycache__" not in p.parts]
    return sources


def copy_harness_files(
    target: Path, force_harness: bool, manifest: dict[str, str], stats: Counter[str]
) -> dict[str, str]:
    """Copy-if-absent từng file harness; trả manifest mới (hash bản khung đã cài, giữ hash cũ nếu file người dùng đã sửa)."""
    new_manifest: dict[str, str] = {}
    for src in harness_sources():
        rel = src.relative_to(SRC).as_posix()
        r = copy_if_absent(src, target / rel, force_harness, installed_hash=manifest.get(rel))
        stats[r] += 1
        if r in ("copied", "updated", "kept"):
            new_manifest[rel] = sha256(src.read_bytes())
        elif rel in manifest:
            new_manifest[rel] = manifest[rel]
    return new_manifest


def install_harness(target: Path, force_harness: bool) -> None:
    """Bước 2: harness .claude/ — copy-if-absent, ghi manifest hash, báo thống kê."""
    stats: Counter[str] = Counter()
    manifest = load_manifest(target)
    install_settings(target, force_harness, stats)
    new_manifest = copy_harness_files(target, force_harness, manifest, stats)
    write_atomic(target / MANIFEST, json.dumps(new_manifest, indent=2, sort_keys=True) + "\n")
    log("✓ .claude/: " + " · ".join(f"{k} {v}" for k, v in sorted(stats.items())))
    if stats.get("updated-new"):
        log("  ⚠ có file .xtemplates-new: bạn đã sửa bản cũ — so sánh và gộp tay bản mới của khung")


def install_root_templates(target: Path) -> None:
    """Bước 3: file gốc từ framework/templates — copy-if-absent, bỏ frontmatter."""
    for name, tmpl in ROOT_TEMPLATES.items():
        tsrc = SRC / "framework" / "templates" / tmpl
        if not tsrc.exists():
            continue
        r = copy_if_absent(tsrc, target / name, False, transform=template_body)
        log(f"  {name}: {r}")


def ruleset_required_checks() -> list[str]:
    """Tên các required status check trong ruleset mẫu (rỗng nếu không đọc/không có)."""
    try:
        rules = json.loads((SRC / ".github/rulesets/main.json").read_text(encoding="utf-8"))["rules"]
        return [
            c["context"]
            for r in rules
            if r["type"] == "required_status_checks"
            for c in r["parameters"]["required_status_checks"]
        ]
    except (OSError, ValueError, KeyError):
        return []


def install_github(target: Path) -> None:
    """Bước 3b (--with-github): ruleset mẫu + PR template + Dependabot (copy-if-absent), cảnh báo required check."""
    for gh in GITHUB_FILES:
        r = copy_if_absent(SRC / gh, target / gh, False)
        log(f"  {gh}: {r}")
    checks = ruleset_required_checks()
    # AUD-CI-003: workflow không được copy (phụ thuộc stack) → import ruleset trước khi có job sẽ khoá merge
    if checks:
        log(
            f"  ⚠ ruleset mẫu đòi required check: {', '.join(checks)} — tạo workflow có job ĐÚNG tên trước khi import, "
            "hoặc sửa danh sách check trong .github/rulesets/main.json; nếu không, mọi PR sẽ treo chờ check"
        )


def ensure_gitignore(target: Path) -> None:
    """Bước 4: .gitignore thêm `.autopilot/` nếu thiếu (tạo mới nếu chưa có file)."""
    gi = target / ".gitignore"
    line = ".autopilot/"
    if gi.exists():
        if line not in gi.read_text(encoding="utf-8").splitlines():
            with gi.open("a", encoding="utf-8") as fh:
                fh.write(f"\n# X-Templates: trạng thái autopilot cục bộ\n{line}\n")
            log("  .gitignore: thêm .autopilot/")
    else:
        gi.write_text(f"# X-Templates: trạng thái autopilot cục bộ\n{line}\n", encoding="utf-8")
        log("  .gitignore: tạo mới")


def migrate_legacy(target: Path) -> None:
    """Bước 0 (bản ≤ 2.x): giữ manifest hash để hook chưa sửa vẫn cập nhật tại chỗ, xoá bản sao chỉ đọc `.xstored/`
    (cài lại được), đổi `xs.yaml` → `xt.yaml` — dev-task.sh chỉ đọc tên mới, để nguyên thì cổng thành no-op."""
    legacy = target / LEGACY_DIR
    if legacy.is_dir() and not legacy.is_symlink():
        old_manifest = legacy / "harness.sha256.json"
        if old_manifest.is_file() and not (target / MANIFEST).exists():
            shutil.copy2(old_manifest, target / MANIFEST)
        shutil.rmtree(legacy)
        log(f"  {LEGACY_DIR}/ → .xtemplates/ (đã xoá bản sao cũ, giữ manifest hash)")
    old_yaml, new_yaml = target / LEGACY_YAML, target / "xt.yaml"
    if old_yaml.is_file() and not new_yaml.exists():
        old_yaml.rename(new_yaml)
        log(f"  {LEGACY_YAML} → xt.yaml")
    elif old_yaml.is_file():
        log(f"  ⚠ có cả {LEGACY_YAML} và xt.yaml — dev-task.sh chỉ đọc xt.yaml; gộp tay rồi xoá {LEGACY_YAML}")


def legacy_refs(target: Path) -> list[str]:
    """File của dự án còn nhắc tên trước 3.0.0 — copy-if-absent không đè file người dùng nên chỉ báo để sửa tay.
    Bỏ qua file trùng byte với bản khung (`_lib.sh`/`_compat.sh` cố ý giữ bí danh tên cũ — AUD-HAR-021)."""
    candidates = [*target.glob("*.md"), target / "xt.yaml", *(target / ".claude").rglob("*")]
    candidates += (target / ".github" / "workflows").glob("*")
    hits = []
    for p in candidates:
        if not p.is_file():
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        rel = p.relative_to(target).as_posix()
        shipped = SRC / rel.removesuffix(".xtemplates-new")
        if LEGACY_RE.search(text) and not (shipped.is_file() and shipped.read_bytes() == p.read_bytes()):
            hits.append(rel)
    return sorted(hits)


def install(target: Path, force_harness: bool, no_harness: bool, label: str | None, with_github: bool = False) -> int:
    target = target.resolve()
    error = target_error(target)
    if error:
        log(error)
        return 2
    xt_dir = target / ".xtemplates"
    xt_dir.mkdir(exist_ok=True)

    migrate_legacy(target)
    install_framework(xt_dir, label)
    if not no_harness:
        install_harness(target, force_harness)
    install_root_templates(target)
    if with_github:
        install_github(target)
    ensure_gitignore(target)
    stale = legacy_refs(target)
    hooks = [f for f in stale if f.startswith(".claude/hooks/")]
    if hooks:
        log(
            "  ⚠ HOOK còn tên cũ (bản ≤ 2.x bạn đã sửa, được giữ nguyên): "
            + ", ".join(hooks)
            + " — đường dẫn .xstored/ không còn nên cổng commit/hàng rào có thể KHÔNG chạy; gộp ngay bản .xtemplates-new hoặc đổi tay"
        )
    if stale:
        log(
            "  ⚠ còn nhắc tên cũ (.xstored/xs.py/xs.yaml/XS_*/xs_py) — đổi tay sang .xtemplates/xt.py/xt.yaml/XT_*/xt_py: "
            + ", ".join(stale)
        )

    log(
        "Xong. Bước tiếp: đọc AGENTS.md, điền xt.yaml, rồi `python3 .xtemplates/scripts/xt.py list profiles` → compose BLUEPRINT.md."
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Cài khung X-Templates vào dự án đích")
    p.add_argument("target", help="thư mục gốc dự án đích")
    p.add_argument("--force-harness", action="store_true", help="đè .claude/ của dự án bằng bản khung")
    p.add_argument("--no-harness", action="store_true", help="không copy .claude/")
    p.add_argument("--label", help="nhãn phiên bản ghi vào .xtemplates/VERSION (mặc định: git SHA)")
    p.add_argument(
        "--with-github", action="store_true", help="copy ruleset mẫu, PR template, Dependabot vào .github/ (không đè)"
    )
    a = p.parse_args(argv)
    return install(Path(a.target), a.force_harness, a.no_harness, a.label, a.with_github)


if __name__ == "__main__":
    sys.exit(main())
