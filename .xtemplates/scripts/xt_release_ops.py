"""Read-only checks for a deployment handoff. No project commands or external target URL are executed."""

from __future__ import annotations

import argparse
import datetime as dt
import http.client
import json
import math
import re
from pathlib import Path
from types import ModuleType
from typing import Any, cast
from urllib.parse import urlsplit

import xt_ops_setup as ops_setup

Doc = dict[str, Any]


def report(doc: Doc, as_json: bool) -> None:
    if as_json:
        print(json.dumps(doc, ensure_ascii=False))
        return
    for key, value in doc.items():
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False)
        print(f"{key}: {value}")


def evidence_file(path: str) -> Doc:
    with Path(path).open("rb") as stream:
        raw = stream.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("quá giới hạn")
    doc = json.loads(raw)
    if not isinstance(doc, dict):
        raise ValueError("cần một object")
    return doc


def current(core: ModuleType, base: Path, env: str) -> Doc | None:
    state = core.read_deploy_ledger(base)["envs"].get(env, {})
    return cast("Doc | None", state.get("current")) if state.get("unknown") is False else None


def dev_health(url: str) -> str | None:
    """One GET to the configured loopback target, bypassing proxies, credentials, DNS and redirects."""
    try:
        p = urlsplit(url)
        if p.scheme != "http" or p.hostname not in {"127.0.0.1", "::1"} or p.path not in {"", "/"}:
            return None
        if p.username is not None or p.password is not None or p.query or p.fragment:
            return None
        conn = http.client.HTTPConnection(p.hostname, p.port, timeout=3)
        try:
            conn.request("GET", "/healthz", headers={"Accept": "application/json"})
            response = conn.getresponse()
            if response.status != 200:
                return None
            data = json.loads(response.read(4097))
            return (
                cast("str | None", data.get("digest"))
                if isinstance(data, dict) and data.get("status") == "ok"
                else None
            )
        finally:
            conn.close()
    except OSError, ValueError, http.client.HTTPException, UnicodeError:
        return None


def matches(candidate: Doc, other: Any) -> bool:
    return isinstance(other, dict) and all(candidate.get(k) == other.get(k) for k in ("content", "digest"))


def release_report(base: Path, path: str | None, candidate: Doc) -> bool:
    if not path:
        return False
    from xt_flow import bind_release_document

    try:
        doc = evidence_file(path)
        bound = bind_release_document(base, doc)
    except OSError, ValueError:
        return False
    promotion = doc.get("promotion")
    deploy: Doc = next((row for row in doc["rows"] if row["id"] == "deploy"), {})
    return (
        bound["verdict"] == "GO"
        and isinstance(promotion, dict)
        and promotion.get("state") == "approved"
        and matches(candidate, doc.get("subject"))
        and doc["subject"].get("head") == doc.get("head") == candidate["head"]
        and (deploy.get("result"), deploy.get("level")) == ("PASS", "BLOCKER")
    )


def signature_inventory(core: ModuleType, base: Path, origin: ops_setup.Origin, head: str) -> bool:
    if head == origin.sha:
        return True
    if not isinstance(origin.tree_sha, str) or not core.COMMIT_SHA_RE.fullmatch(origin.tree_sha):
        return False
    remote = origin.get(f"git/trees/{origin.tree_sha}?recursive=1")
    if not isinstance(remote, dict) or remote.get("truncated") is not False or not isinstance(remote.get("tree"), list):
        return False

    def covered(path: str) -> bool:
        if not path.startswith(origin.prefix):
            return False
        rel = Path(path.removeprefix(origin.prefix))
        return str(rel.parent) in core.GO_NO_GO_DIRS and rel.match("GO-NO-GO*.md")

    listing = core._git(base, "ls-tree", "-r", "-z", "--full-name", head, "--", ".", env=core._go_git_env())
    if listing.returncode:
        return False
    local = {
        path: entry.split()[2]
        for entry, _, path in (line.partition("\t") for line in listing.stdout.split("\0"))
        if path and covered(path)
    }
    upstream = {}
    for node in remote["tree"]:
        if not isinstance(node, dict) or not isinstance(node.get("path"), str) or not isinstance(node.get("sha"), str):
            return False
        if covered(node["path"]):
            upstream[node["path"]] = node["sha"]
    return local == upstream


def protected_signoff(core: ModuleType, base: Path, origin: ops_setup.Origin, candidate: Doc) -> bool:
    """Re-read the current signature artifact from the remote default branch instead of trusting an exported JSON verdict."""
    docs = core._signed_go_no_go(base)
    if not docs or not origin.sha or not signature_inventory(core, base, origin, candidate["head"]):
        return False
    for path, local in docs:
        signed = origin.file(path)
        if not signed or signed != local or not core._go_no_go_signed(signed):
            return False
        if core._approval_problem(base, path, signed, candidate):
            return False
        agent = any(name.casefold() == core.RELEASE_AGENT_NAME for name in core._go_signers(signed))
        if agent and (origin.cfg or {}).get("release_signoff") != "agent":
            return False
    return True


def rehearsal(core: ModuleType, base: Path, args: argparse.Namespace) -> Doc:
    row, artifacts = core._release_artifacts(base)
    if not row or row["result"] != "PASS" or not artifacts:
        raise ValueError("release_artifacts chưa được build và kiểm")
    tree, head, readable = core._release_tree(base)
    candidate, why = core._release_subject(
        base, artifacts, head, tree_readable=readable, tree_clean=tree["result"] == "PASS"
    )
    if why or not core._deploy_sha256(candidate.get("digest")):
        raise ValueError("không tính được định danh ứng viên")
    dev = current(core, base, "dev")
    if not dev or not matches(candidate, dev.get("subject")):
        raise ValueError("biên nhận dev chưa xác nhận đúng nội dung và artifact")
    url = core._xt_keys(base).get("url_dev", "")
    if dev.get("url") != url or dev_health(url) != candidate["digest"]:
        raise ValueError("digest phục vụ ở URL dev cục bộ không khớp")
    origin = ops_setup.Origin(core, base)
    ready = ops_setup.target(origin, args.env)
    ready["declared_secret_names"] = origin.cfg is not None and ops_setup.deploy_secret_status(origin, origin.cfg) in (
        ops_setup.OK,
        ops_setup.SKIP,
    )
    ready["clean_checkout"] = tree["result"] == "PASS"
    relation = origin.get(f"compare/{head}...{origin.sha}") if origin.sha else None
    ready["ancestor"] = isinstance(relation, dict) and relation.get("status") in {"ahead", "identical"}
    ready["release_report"] = release_report(base, args.release, candidate)
    ready["protected_signoff"] = protected_signoff(core, base, origin, candidate)
    all_ready = all(ready.values())
    return {
        "schema": 1,
        "mode": "rehearsal",
        "environment": args.env,
        "dev_verified": True,
        "deployed_to_target": False,
        "subject": {key: candidate[key] for key in ("head", "content", "digest")},
        "preflight": ready,
        "handoff": "ready_for_pipeline_review" if all_ready else "pending",
        "next": "Kiểm lại release-check, grant và ancestry trong job phát hành của dự án trước khi triển khai."
        if all_ready
        else "Hoàn tất các bằng chứng chưa đạt rồi chạy lại rollout-drill --require-ready.",
    }


def rollout(core: ModuleType, args: argparse.Namespace) -> int:
    if not core.DEPLOY_ENV_NAME.fullmatch(args.env) or args.env == "dev":
        return 2
    base = core.loop_root(core.project_dir())
    try:
        doc = rehearsal(core, base, args)
    except (core.DeployError, OSError, ValueError, TypeError) as exc:
        reason = str(exc) if type(exc) is ValueError and str(exc) in DRILL_FAILURES else "không đọc được bằng chứng"
        report(
            {"schema": 1, "mode": "rehearsal", "dev_verified": False, "deployed_to_target": False, "reason": reason},
            args.json,
        )
        return 1
    report(doc, args.json)
    return int(args.require_ready and doc["handoff"] == "pending")


DRILL_FAILURES = {
    "release_artifacts chưa được build và kiểm",
    "không tính được định danh ứng viên",
    "biên nhận dev chưa xác nhận đúng nội dung và artifact",
    "digest phục vụ ở URL dev cục bộ không khớp",
}


def finite(value: Any) -> bool:
    return type(value) in (float, int) and math.isfinite(value) and value >= 0


def field_metrics(data: Doc) -> Doc:
    requests, errors, p95 = (data.get(key) for key in ("requests", "errors", "p95_ms"))
    if type(requests) is not int or requests < 1 or type(errors) is not int or not 0 <= errors <= requests:
        raise ValueError
    if not finite(p95):
        raise ValueError
    return {"requests": requests, "errors": errors, "error_pct": 100 * (errors / requests), "p95_ms": p95}


def confirmed_after(core: ModuleType, base: Path, env: str, digest: str) -> dt.datetime:
    ledger = core.read_deploy_ledger(base)
    slot = ledger["envs"].get(env, {})
    if slot.get("unknown") is not False or (slot.get("current") or {}).get("served_digest") != digest:
        raise ValueError
    event: Doc = next((item for item in reversed(ledger["events"]) if item["env"] == env), {})
    when = core._deploy_utc(event.get("finished"))
    if event.get("result") not in {"deployed", "rolled_back"} or event.get("served_digest") != digest or not when:
        raise ValueError
    return cast(dt.datetime, when)


def field_window(core: ModuleType, data: Doc, deployed: dt.datetime, max_age: float | None) -> Doc:
    start, end, exported = (core._deploy_utc(data.get(key)) for key in ("started", "finished", "exported_at"))
    now = dt.datetime.now(dt.timezone.utc)
    if not start or not end or not exported or not (deployed <= start < end <= exported <= now):
        raise ValueError
    if max_age is not None and (now - end).total_seconds() / 3600 > max_age:
        raise ValueError
    return {"started": start.isoformat(), "finished": end.isoformat(), "exported_at": exported.isoformat()}


def field_check(core: ModuleType, args: argparse.Namespace) -> int:
    if not core.DEPLOY_ENV_NAME.fullmatch(args.env) or not finite(args.max_p95_ms) or not finite(args.max_error_pct):
        return 2
    if (
        args.max_error_pct > 100
        or args.max_p95_ms == 0
        or (args.max_age_hours is not None and not finite(args.max_age_hours))
    ):
        return 2
    try:
        data = evidence_file(args.field)
        source = data.get("source")
        if (
            data.get("env") != args.env
            or not isinstance(source, str)
            or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", source)
        ):
            raise ValueError
        digest = data.get("digest")
        if not isinstance(digest, str) or not core._deploy_sha256(digest):
            raise ValueError
        deployed = confirmed_after(core, core.loop_root(core.project_dir()), args.env, digest)
        metrics = field_metrics(data)
        window = field_window(core, data, deployed, args.max_age_hours)
    except core.DeployError, OSError, ValueError, OverflowError:
        report(
            {"schema": 1, "verdict": "invalid_evidence", "next": "Xuất lại cửa sổ đo cho receipt hiện tại."}, args.json
        )
        return 1
    limits = {"p95_ms": args.max_p95_ms, "error_pct": args.max_error_pct}
    breaches = [key for key, limit in limits.items() if metrics[key] > limit]
    report(
        {
            "schema": 1,
            "env": args.env,
            "digest": digest,
            "provenance": "operator_supplied_export",
            "window": window,
            "metrics": metrics,
            "limits": limits,
            "breaches": breaches,
            "verdict": "regression" if breaches else "pass",
            "next": "Mở sự cố cho digest này, ghi cửa sổ đo vào task sửa lỗi và bổ sung test hồi quy trước phát hành lại."
            if breaches
            else "Tiếp tục thu thập cửa sổ SLO theo RUNBOOK.",
        },
        args.json,
    )
    return int(bool(breaches))
