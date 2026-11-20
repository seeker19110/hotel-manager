"""F-151. Inventory local state and protected remote configuration without changing either."""

from __future__ import annotations

import base64
import binascii

import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import subprocess
from types import ModuleType
from typing import Any
from urllib.parse import quote

Doc = dict[str, Any]

OK, MISSING, UNKNOWN, SKIP, OPTIONAL = "đạt", "thiếu", "không đọc được", "không áp dụng", "tuỳ chọn"
BLOCKS = (MISSING, UNKNOWN)
NAME = re.compile(r"[A-Z][A-Z0-9_]{0,99}")
HUMAN = {
    "OPS-IR-006",
    "OPS-IAC-006",
    "SEC-TM-007",
    "SEC-LOG-013",
    "CMP-AUDIT-004",
    "CMP-AI-001",
    "UX-A11Y-017",
    "WF-TEAM-006",
}
KEYS = {
    "release_signoff": ("agent", "Cho agent ký khi bằng chứng đạt điều kiện của phiên bản khung."),
    "release_signoff_scale": ("L", "Đề nghị mở rộng phạm vi ký tới L khi khung hỗ trợ."),
    "stage_approval": ("agent", "Cho agent nghiệm thu giai đoạn trong giới hạn khung."),
    "stage_approval_max": ("3", "Đề nghị mở rộng giai đoạn tối đa khi khung hỗ trợ."),
    "merge_hard_exceptions": ("auto", "Cho steward merge ngoại lệ cứng khi các cổng đạt."),
}


def field(obj: Any, key: str, default: Any = None) -> Any:
    return obj.get(key, default) if isinstance(obj, dict) else default


class Origin:
    """Use only the checkout's GitHub origin. Pin config, plan and ancestry to one remote commit."""

    def __init__(self, core: ModuleType, base: Path) -> None:
        self.core, self.base = core, base
        self.cache: Doc = {}
        git_env = core._go_git_env()
        remote = core._git(base, "config", "--local", "--no-includes", "--get", "remote.origin.url", env=git_env)
        origin = remote.stdout.strip() if remote.returncode == 0 else ""
        self.has_origin = bool(origin)
        self.repo = core.github_origin_slug(origin)
        prefix = core._git(base, "rev-parse", "--show-prefix", env=git_env)
        self.prefix = prefix.stdout.strip() if prefix.returncode == 0 else ""
        default = field(self.get(""), "default_branch")
        commit = self.get(f"commits/{quote(default, safe='')}") if isinstance(default, str) else None
        sha = field(commit, "sha")
        self.tree_sha = field(field(field(commit, "commit"), "tree"), "sha")
        self.sha = sha if isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha) else None
        self.branch = default
        raw = self.file("xt.yaml")
        if not self.has_origin:
            raw = core._committed_xt_text(base, "refs/heads/main") or core._committed_xt_text(base, "refs/heads/master")
        self.cfg = core._yaml_keys(raw) if raw is not None else None

    def get(self, path: str) -> Any:
        if not self.repo:
            return None
        if path in self.cache:
            return self.cache[path]
        endpoint = f"repos/{self.repo}" + (f"/{path}" if path else "")
        try:
            result = subprocess.run(
                ["gh", "api", "--hostname", "github.com", "--method", "GET", endpoint],
                cwd=self.base,
                capture_output=True,
                timeout=15,
                check=False,
                env={**os.environ, "GH_PROMPT_DISABLED": "1"},
            )
            doc = json.loads(result.stdout) if result.returncode == 0 else None
        except OSError, ValueError, subprocess.TimeoutExpired:
            doc = None
        self.cache[path] = doc
        return doc

    def file(self, path: str, *, repo_root: bool = False) -> str | None:
        if not self.sha:
            return None
        path = path if repo_root else self.prefix + path
        doc = self.get(f"contents/{quote(path, safe='/')}?ref={self.sha}")
        if field(doc, "encoding") != "base64" or not isinstance(doc.get("content"), str):
            return None
        try:
            return base64.b64decode("".join(doc["content"].split()), validate=True).decode("utf-8")
        except UnicodeError, binascii.Error, ValueError:
            return None

    def pages(self, path: str, key: str | None = None) -> list[Doc] | None:
        values = []
        for number in range(1, 51):
            data = self.get(f"{path}?per_page=100&page={number}")
            page = field(data, key) if key else data
            if not isinstance(page, list) or any(not isinstance(item, dict) for item in page):
                return None
            values.extend(page)
            if len(page) < 100:
                return values
        return None


def target(origin: Origin, env: str) -> dict[str, bool]:
    cfg = origin.cfg or {}
    names = cfg.get("deploy_envs", "").split()
    declared = env in names and all(
        not origin.core.gate_noop(cfg.get(f"{key}_{env}", "")) for key in ("deploy", "smoke", "digest", "rollback")
    )
    raw = origin.file("docs/autopilot/PLAN.md")
    grants = origin.core.parse_grants(raw or "")
    grant = raw is not None and not origin.core.grant_violations(grants, "deploy", {"env": env})
    return {"target_adapter": bool(declared and origin.sha), "remote_grant": grant}


def state(check: bool) -> str:
    return OK if check else MISSING


def row(name: str, status: str, why: str, action: str, verify: str, **extra: Any) -> Doc:
    return {"id": name, "status": status, "reason": why, "action": action, "verify": verify, **extra}


def rules_status(origin: Origin) -> str:
    if not origin.has_origin:
        return MISSING
    listing = origin.pages("rulesets")
    if listing is None:
        return UNKNOWN
    for filename, target_type in (("main.json", "branch"), ("tags.json", "tag")):
        raw = origin.file(f".github/rulesets/{filename}", repo_root=True)
        if raw is None:
            return MISSING if origin.sha else UNKNOWN
        try:
            expected = json.loads(raw)
        except ValueError:
            return UNKNOWN
        found = [i for i in listing if i.get("target") == target_type and i.get("name") == field(expected, "name")]
        if not found:
            return MISSING
        status = match_rules(origin, found[0].get("id"), expected)
        if status != OK:
            return status
    active = origin.get(f"rules/branches/{quote(origin.branch, safe='')}")
    return OK if isinstance(active, list) and active else UNKNOWN


def match_rules(origin: Origin, identifier: Any, expected: Any) -> str:
    if type(identifier) is not int or not isinstance(expected, dict):
        return UNKNOWN
    actual = origin.get(f"rulesets/{identifier}")
    keys = ("name", "target", "conditions", "rules", "bypass_actors", "enforcement")
    if not isinstance(actual, dict) or any(k not in expected or k not in actual for k in keys):
        return UNKNOWN
    if expected["enforcement"] != "active":
        return MISSING
    return state(all(actual[k] == expected[k] for k in keys))


def names_status(origin: Origin, wanted: set[str], secrets: list[Doc] | None) -> str:
    if not wanted:
        return SKIP
    if not origin.has_origin:
        return MISSING
    if secrets is None:
        return UNKNOWN
    return state(wanted <= {i.get("name") for i in secrets if isinstance(i.get("name"), str)})


def deploy_secret_status(origin: Origin, cfg: dict[str, str]) -> str:
    names = cfg.get("deploy_secrets", "").split()
    if not all(NAME.fullmatch(n) for n in names):
        return UNKNOWN
    if not names:
        return SKIP
    return names_status(origin, set(names), origin.pages("actions/secrets", "secrets"))


def budget_valid(cfg: dict[str, str]) -> bool:
    try:
        amount = float(cfg.get("worker_budget_usd", ""))
        turns = int(cfg.get("worker_max_turns", ""))
        return math.isfinite(amount) and amount > 0 and turns > 0
    except ValueError:
        return False


def local_items(core: ModuleType, base: Path) -> list[Doc]:
    human, deferred = UNKNOWN, SKIP
    ids, waits = [], []
    bp = base / "BLUEPRINT.md"
    if bp.is_file():
        result = core.blueprint_status(bp)
        ids = sorted(HUMAN.intersection(result["open_must"]))
        if not result["bad_lines"] and not result["bad_waivers"]:
            human = MISSING if ids else OK
    doc = core.read_state(base)
    if doc is not None:
        waits = sorted(key for key in core._deferred(doc) if core.DEFER_ID_RE.fullmatch(key))
        deferred = MISSING if waits else OK
    elif (core.state_dir(base) / "state.json").exists():
        deferred = UNKNOWN
    switch = core._release_prod_switch(base)
    decision = {"PASS": OK, "FAIL": UNKNOWN, "N/A": MISSING if switch["level"] == "BLOCKER" else SKIP}
    return [
        row(
            "human-musts",
            human,
            "Cần bằng chứng của người chịu trách nhiệm.",
            "Hoàn tất các MUST lớp B đang áp dụng trong BLUEPRINT.md.",
            "blueprint-status",
            ids=ids,
        ),
        row(
            "deferred",
            deferred,
            "Các quyết định được vòng chuyển cho chủ dự án.",
            "Xử lý mục tương ứng trong PLAN.",
            "loop status --json",
            ids=waits,
        ),
        row(
            "prod-switch",
            decision[switch["result"]],
            "Phương án vận hành thật cần người chọn.",
            "Quyết từng đề xuất đang chờ trong DECISIONS.md.",
            "release-check, hàng prod_switch",
        ),
    ]


def remote_items(origin: Origin) -> list[Doc]:
    cfg = origin.cfg or {}
    secrets = origin.pages("actions/secrets", "secrets")
    protected = UNKNOWN if origin.has_origin and origin.cfg is None else None
    secret_status = deploy_secret_status(origin, cfg)
    envs = [
        env for env in cfg.get("deploy_envs", "").split() if env != "dev" and origin.core.DEPLOY_ENV_NAME.fullmatch(env)
    ]
    targets = {env: target(origin, env) for env in envs}
    authorized = bool(targets) and all(all(checks.values()) for checks in targets.values())
    missing_keys = [f"+ {k}: {v} — {why}" for k, (v, why) in KEYS.items() if cfg.get(k) != v]
    updates = field(origin.get("automated-security-fixes"), "enabled")
    launcher = origin.file(".github/workflows/worker.yml", repo_root=True)
    return [
        row(
            "repo",
            state(origin.has_origin),
            "Chủ dự án chọn tổ chức và quyền truy cập.",
            "Tạo repo rồi đặt Git remote origin.",
            "git remote get-url origin",
        ),
        row(
            "bot-token",
            names_status(origin, {"XT_STEWARD_TOKEN"}, secrets),
            "Quyền CI do chủ repo cấp.",
            "Đặt secret XT_STEWARD_TOKEN theo RUNBOOK-PR-STEWARD.",
            "GET actions/secrets (chỉ tên)",
        ),
        row(
            "ruleset",
            rules_status(origin),
            "Bảo vệ nhánh và tag cần quản trị repo.",
            "So cấu hình main.json và tags.json, nhập ruleset đang thiếu và kiểm danh sách bypass.",
            "GET rulesets và rules/branches của nhánh mặc định",
        ),
        row(
            "gated-keys",
            protected or (OPTIONAL if missing_keys else OK),
            "Chủ dự án chọn giới hạn tự chủ.",
            "Giữ quyền duyệt hiện tại hoặc merge riêng từng thay đổi cần thiết.",
            "xt.yaml đã commit trên nhánh chính",
            changes=missing_keys,
        ),
        row(
            "deploy-target",
            protected or state(authorized),
            "Đích, rollback và phạm vi ủy quyền thuộc chủ dự án.",
            "Khai bốn lệnh cho đích và cấp grant deploy đúng môi trường trong PLAN đã duyệt.",
            "commands ở main và grant-check deploy env=<env>",
            environments=targets,
        ),
        row(
            "deploy-secrets",
            protected or secret_status,
            "Chủ tài khoản cấp quyền đích.",
            "Tạo các tên khai trong deploy_secrets từ hệ quản lý bí mật của dự án.",
            "GET actions/secrets (chỉ tên)",
        ),
        row(
            "worker-budget",
            protected or state(budget_valid(cfg)),
            "Ngân sách thuộc người trả phí.",
            "Đặt worker_budget_usd và worker_max_turns dương trên main.",
            "xt.yaml trên nhánh chính",
        ),
        row(
            "worker-launcher",
            OK if launcher else UNKNOWN,
            "Nơi chạy worker do chủ dự án vận hành.",
            "Kiểm workflow worker.yml hoặc xác nhận lịch chạy ngoài repo.",
            "GET workflow trên nhánh chính; lịch ngoài repo cần kiểm tay",
        ),
        row(
            "security-updates",
            state(updates) if type(updates) is bool else UNKNOWN,
            "Cài đặt bảo mật cần quản trị repo.",
            "Bật Dependabot security updates trong Settings.",
            "GET automated-security-fixes",
        ),
    ]


def inventory(core: ModuleType, base: Path) -> Doc:
    origin = Origin(core, base)
    try:
        dev = core.read_deploy_ledger(base)["envs"].get("dev", {})
        dev_digest = field(dev.get("current"), "served_digest") if dev.get("unknown") is False else None
        dev_state = "deployed" if dev_digest else "absent"
    except core.DeployError:
        dev_state, dev_digest = "unreadable", None
    return {
        "schema": 1,
        "dev": {"state": dev_state, "digest": dev_digest},
        "items": remote_items(origin) + local_items(core, base),
        "head": core._git_head(base),
        "at": dt.datetime.now(dt.timezone.utc).date().isoformat(),
        "main_sha": origin.sha,
    }


def markdown(doc: Doc) -> str:
    dev = doc["dev"]["digest"] or ("không đọc được" if doc["dev"]["state"] == "unreadable" else "chưa có")
    lines = [f"# Thiết lập một lần — bản dev: {dev}", ""]
    todo = [i for i in doc["items"] if i["status"] in BLOCKS]
    if todo:
        lines.extend(["| Mục | Trạng thái | Vì sao | Việc cần làm | Máy kiểm |", "|---|---|---|---|---|"])
        lines.extend(f"| {i['id']} | {i['status']} | {i['reason']} | {i['action']} | {i['verify']} |" for i in todo)
    else:
        lines.append("Không còn việc thiết lập bắt buộc.")
    for item in doc["items"]:
        if item["status"] == OPTIONAL:
            lines.extend(["", "## Tuỳ chọn — quyền chủ dự án có thể bật", ""])
            lines.extend(f"- {change}" for change in item["changes"])
    lines.extend(["", f"UTC {doc['at']} · HEAD {doc['head'] or '—'} · dev {dev}"])
    return "\n".join(lines) + "\n"


def owner_script(doc: Doc) -> str:
    lines = [
        "#!/bin/sh",
        "set -eu",
        "# Chủ repo chọn đúng kho trước khi tự chạy.",
        ': "${GH_REPO:?set GH_REPO to OWNER/REPO}"',
        'gh repo view "$GH_REPO" --json nameWithOwner',
        'printf "Nhập lại OWNER/REPO để tiếp tục: "',
        "read -r confirmed",
        '[ "$confirmed" = "$GH_REPO" ] || exit 1',
    ]
    items = {item["id"]: item["status"] for item in doc["items"]}
    if items["bot-token"] == MISSING:
        lines.append('gh secret set XT_STEWARD_TOKEN --repo "$GH_REPO"')
    if items["ruleset"] == MISSING:
        lines.extend(
            [
                "# Chỉ đặt XT_NEW_RULESET_FILE sau khi kiểm đúng ruleset này chưa tồn tại trên repo đã chọn.",
                'case "${XT_NEW_RULESET_FILE:-}" in',
                "  .github/rulesets/main.json|.github/rulesets/tags.json)",
                "    export GH_REPO",
                '    gh api --method POST "repos/{owner}/{repo}/rulesets" --input "$XT_NEW_RULESET_FILE" ;;',
                '  "") ;;',
                "  *) exit 2 ;;",
                "esac",
            ]
        )
    if items["security-updates"] == MISSING:
        lines.append('gh api --method PUT "repos/$GH_REPO/automated-security-fixes"')
    lines.append("# Các mục còn lại dùng hướng dẫn trong admin-plan. Chạy lại admin-plan để kiểm.")
    return "\n".join(lines)


def command(core: ModuleType, args: argparse.Namespace) -> int:
    base = core.loop_root(core.project_dir())
    out = None
    if args.out:
        out = core._inside(base, args.out)
        if not out or out.suffix.lower() != ".md" or any(part.startswith(".") for part in out.relative_to(base).parts):
            return 2
        if out.exists() and not out.read_text(encoding="utf-8").startswith("# Thiết lập một lần — bản dev:"):
            return 2
    doc = inventory(core, base)
    if out:
        core.write_atomic(out, markdown(doc), keep_mode=True)
    print(json.dumps(doc, ensure_ascii=False) if args.json else owner_script(doc) if args.script else markdown(doc))
    return int(doc["dev"]["state"] == "unreadable" or any(i["status"] in BLOCKS for i in doc["items"]))
