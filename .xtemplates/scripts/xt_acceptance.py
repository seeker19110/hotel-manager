"""Kiểm phạm vi nghiệm thu đã review trước khi triển khai, dùng một commit Git làm mốc."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


SCOPE_FILE = "docs/autopilot/ACCEPTANCE.paths"


def git(root: Path, *args: str) -> bytes:
    env = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
    env.update(
        GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0", GIT_GRAFT_FILE=os.devnull
    )
    return subprocess.check_output(
        ["git", "--no-replace-objects", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-C", str(root), *args],
        env=env,
        stderr=subprocess.PIPE,
    )


def tracked_files(root: Path, baseline: str, path: str) -> dict[str, tuple[str, str]]:
    if not path or Path(path).as_posix() != path or Path(path).is_absolute() or ".." in Path(path).parts:
        raise ValueError(f"Đường dẫn phải tương đối từ gốc repo: {path!r}")
    entries = git(root, "ls-tree", "-r", "-z", "--full-tree", baseline, "--", path).split(b"\0")
    files = {}
    for entry in filter(None, entries):
        header, name = entry.split(b"\t", 1)
        mode, _, oid = header.decode("ascii").split()
        if mode not in ("100644", "100755"):
            raise ValueError(f"Mốc nghiệm thu phải chứa file thường: {os.fsdecode(name)!r}")
        files[os.fsdecode(name)] = (mode, oid)
    if not files:
        raise ValueError(f"Không có file đã review tại mốc cho {path!r}")
    return files


def matches(root: Path, name: str, mode: str, oid: str) -> bool:
    path = root / name
    if path.resolve() != path or not path.is_file():
        return False
    with path.open("rb") as stream:
        info = os.fstat(stream.fileno())
        if bool(info.st_mode & stat.S_IXUSR) != (mode == "100755"):
            return False
        digest = hashlib.new("sha256" if len(oid) == 64 else "sha1")
        digest.update(f"blob {info.st_size}\0".encode("ascii"))
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest() == oid


def pinned_scope(root: Path, baseline: str) -> list[str]:
    lines = git(root, "cat-file", "blob", f"{baseline}:{SCOPE_FILE}").decode("utf-8").splitlines()
    paths = [line for line in lines if line and not line.startswith("#")]
    if not paths:
        raise ValueError(f"{SCOPE_FILE} thiếu đường dẫn đến bộ nghiệm thu")
    return [SCOPE_FILE, *paths]


def check(project: Path, baseline: str, paths: list[str]) -> dict[str, object]:
    root = Path(os.fsdecode(git(project, "rev-parse", "--show-toplevel")).rstrip("\n")).resolve()
    if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", baseline):
        raise ValueError("Cần SHA đầy đủ của commit nghiệm thu đã review")
    if git(root, "cat-file", "-t", baseline).strip() != b"commit":
        raise ValueError("Mốc nghiệm thu phải là commit")
    git(root, "merge-base", "--is-ancestor", baseline, "HEAD")
    source = "arguments" if paths else SCOPE_FILE
    paths = paths or pinned_scope(root, baseline)
    files = {}
    for scope in paths:
        files.update(tracked_files(root, baseline, scope))
    changed = {name for name, (mode, oid) in files.items() if not matches(root, name, mode, oid)}
    selections = (
        ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", baseline, "HEAD"],
        ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--cached", baseline],
        ["ls-files", "--others", "-z"],
    )
    for args in selections:
        entries = git(root, *args, "--", *paths).split(b"\0")
        changed.update(os.fsdecode(name) for name in entries if name)
    return {
        "schema": 1,
        "status": "changed" if changed else "unchanged",
        "baseline": baseline,
        "scope": paths,
        "scope_source": source,
        "reviewed_files": len(files),
        "changed": sorted(changed),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("command", choices=["check"])
    parser.add_argument("--base", required=True, help="SHA đầy đủ đã chốt trước công việc triển khai")
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("paths", nargs="*", help=f"mặc định đọc {SCOPE_FILE} từ commit đã review")
    args = parser.parse_intermixed_args(argv)
    try:
        result = check(args.project, args.base, args.paths)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"Không xác minh được mốc nghiệm thu: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=True))
    return int(result["status"] != "unchanged")


if __name__ == "__main__":
    sys.exit(main())
