"""Test scripts/install.py và scripts/check-links.py."""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
import unittest.mock as mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import install
import xt


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.target = Path(tempfile.mkdtemp())

    def run_install(self, *extra) -> int:
        return install.main([str(self.target), "--label", "test", *extra])

    def test_fresh_install_layout(self):
        self.assertEqual(self.run_install(), 0)
        self.assertTrue((self.target / ".xtemplates" / "framework" / "00-method" / "conventions.md").exists())
        self.assertTrue((self.target / ".xtemplates" / "scripts" / "xt.py").exists())
        self.assertEqual((self.target / ".xtemplates" / "VERSION").read_text(encoding="utf-8").strip(), "test")
        self.assertTrue((self.target / ".claude" / "settings.json").exists())
        self.assertTrue((self.target / ".claude" / "hooks" / "stop-guard.sh").exists())
        self.assertTrue((self.target / ".claude" / "skills" / "autopilot" / "SKILL.md").exists())
        self.assertIn(".autopilot/", (self.target / ".gitignore").read_text(encoding="utf-8"))
        for name in ("AGENTS.md", "CLAUDE.md", "PROGRESS.md", "xt.yaml"):
            self.assertTrue((self.target / name).exists(), name)
            self.assertFalse(
                (self.target / name).read_text(encoding="utf-8").startswith("---"), f"{name} còn frontmatter"
            )

    def test_installed_progress_is_body_of_template(self):
        # Mẫu PROGRESS bọc 4 mục trong ```markdown — dự án đích phải nhận đúng 4 mục, không phải trang hướng dẫn.
        self.run_install()
        text = (self.target / "PROGRESS.md").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("# PROGRESS.md"), text[:80])
        self.assertEqual(tuple(n for n, _ in xt.progress_sections(text)), xt.PROGRESS_SECTIONS)

    def test_dev_task_root_in_target_project(self):
        # AUD-HAR-001: thiếu CLAUDE_PROJECT_DIR, .xtemplates/scripts/dev-task.sh từng lấy gốc = .xtemplates/ → "xanh giả".
        self.run_install()
        (self.target / "xt.yaml").write_text('build: ""\ntypecheck: ""\nlint: ""\ntest: "false"\n', encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
        script = self.target / ".xtemplates" / "scripts" / "dev-task.sh"
        r = subprocess.run(["bash", str(script), "gate"], capture_output=True, text=True, env=env, cwd="/")
        self.assertNotEqual(r.returncode, 0, r.stderr)
        self.assertIn("GATE ĐỎ ở 'test'", r.stderr)
        (self.target / "xt.yaml").write_text('test: "true"\n', encoding="utf-8")
        r = subprocess.run(["bash", str(script), "gate"], capture_output=True, text=True, env=env, cwd="/")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("GATE XANH (1 lệnh)", r.stderr)

    def test_dev_task_noop_is_not_reported_green(self):
        self.run_install()
        (self.target / "xt.yaml").write_text('build: ""\ntypecheck: ""\nlint: ""\ntest: ""\n', encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
        r = subprocess.run(
            ["bash", str(self.target / ".xtemplates/scripts/dev-task.sh"), "gate"],
            capture_output=True,
            text=True,
            env=env,
        )
        self.assertEqual(r.returncode, 0)
        self.assertIn("KHÔNG CHẠY LỆNH NÀO", r.stderr)
        self.assertNotIn("GATE XANH", r.stderr)

    def test_check_links_fence_angle_and_outside_root(self):
        # AUD-DOC-019: ~~~ fence, link <có dấu cách>, link ra ngoài gốc repo.
        repo = Path(tempfile.mkdtemp())
        outside = repo.parent / (repo.name + "-ngoai.md")
        outside.write_text("x", encoding="utf-8")
        (repo / "có dấu cách.md").write_text("x", encoding="utf-8")
        (repo / "a.md").write_text(
            "~~~\n[x](khong-co.md)\n~~~\n[ok](<có dấu cách.md>)\n[hỏng](<không có.md>)\n[ngoài](../"
            + outside.name
            + ")\n",
            encoding="utf-8",
        )
        r = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "check-links.py"), str(repo)], capture_output=True, text=True
        )
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertNotIn("khong-co.md", r.stdout)
        self.assertIn("không có.md", r.stdout)
        self.assertIn("ra ngoài repo", r.stdout)
        self.assertEqual(r.stdout.count("✗"), 2)

    def test_installed_check_links_uses_project_root(self):
        self.run_install()
        (self.target / "doc.md").write_text("[hỏng](khong-co.md)\n", encoding="utf-8")
        r = subprocess.run(
            [sys.executable, str(self.target / ".xtemplates/scripts/check-links.py")], capture_output=True, text=True
        )
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("doc.md:1", r.stdout)

    def test_installed_xt_validates_and_composes(self):
        self.run_install()
        xt = self.target / ".xtemplates" / "scripts" / "xt.py"
        r = subprocess.run([sys.executable, str(xt), "validate"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout)
        r = subprocess.run(
            [
                sys.executable,
                str(xt),
                "compose",
                "--profile",
                "web-app",
                "--scale",
                "M",
                "--out",
                str(self.target / "BLUEPRINT.md"),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("kind: blueprint", (self.target / "BLUEPRINT.md").read_text(encoding="utf-8"))

    def test_does_not_overwrite_user_files(self):
        self.run_install()
        agents = self.target / "AGENTS.md"
        agents.write_text("của tôi\n", encoding="utf-8")
        hook = self.target / ".claude" / "hooks" / "stop-guard.sh"
        hook.write_text("# hook tôi đã sửa\n", encoding="utf-8")
        self.run_install()
        self.assertEqual(agents.read_text(encoding="utf-8"), "của tôi\n")
        self.assertEqual(hook.read_text(encoding="utf-8"), "# hook tôi đã sửa\n")
        self.assertTrue(hook.with_name("stop-guard.sh.xtemplates-new").exists())
        self.run_install("--force-harness")
        self.assertNotEqual(hook.read_text(encoding="utf-8"), "# hook tôi đã sửa\n")

    def test_install_merges_hooks_into_existing_settings(self):
        # AUD-HAR-003: settings.json có sẵn từng chỉ sinh .xtemplates-new → hook copy mà không chạy.
        settings = self.target / ".claude" / "settings.json"
        settings.parent.mkdir(parents=True)
        settings.write_text('{"permissions": {"allow": ["Bash(make *)"]}}\n', encoding="utf-8")
        self.run_install()
        d = json.loads(settings.read_text(encoding="utf-8"))
        self.assertEqual(d["permissions"], {"allow": ["Bash(make *)"]})
        self.assertIn("PreToolUse", d["hooks"])
        before = settings.read_text(encoding="utf-8")
        self.run_install()  # chạy lại: không nhân đôi hook
        self.assertEqual(settings.read_text(encoding="utf-8"), before)

    def test_install_updates_pristine_harness(self):
        # AUD-HAR-004: hook đã cài mà người dùng chưa sửa phải được cập nhật khi khung có bản mới.
        self.run_install()
        hook = self.target / ".claude" / "hooks" / "stop-guard.sh"
        manifest = json.loads((self.target / ".xtemplates" / "harness.sha256.json").read_text(encoding="utf-8"))
        self.assertIn(".claude/hooks/stop-guard.sh", manifest)
        old = "# bản khung cũ\n"
        hook.write_text(old, encoding="utf-8")
        manifest[".claude/hooks/stop-guard.sh"] = install.sha256(old.encode())  # giả lập: lần cài trước là bản cũ
        (self.target / ".xtemplates" / "harness.sha256.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.run_install()
        self.assertEqual(
            hook.read_text(encoding="utf-8"), (ROOT / ".claude/hooks/stop-guard.sh").read_text(encoding="utf-8")
        )
        self.assertFalse(hook.with_name("stop-guard.sh.xtemplates-new").exists())

    def test_install_symlink_not_followed(self):
        # AUD-HAR-010: symlink treo ở đích không được đi theo ra ngoài dự án.
        outside = Path(tempfile.mkdtemp())
        (self.target / "CLAUDE.md").symlink_to(outside / "pwn.md")
        self.run_install()
        self.assertFalse((outside / "pwn.md").exists())
        self.assertTrue((self.target / "CLAUDE.md").is_symlink())

    def test_with_github_warns_required_checks(self):
        # AUD-CI-003: ruleset mẫu đòi check mà workflow không được copy.
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(self.run_install("--with-github"), 0)
        self.assertIn("required check: quality", err.getvalue())

    def test_with_github_copies_guardrails_without_overwrite(self):
        self.assertEqual(self.run_install(), 0)
        self.assertFalse((self.target / ".github").exists())
        self.assertEqual(self.run_install("--with-github"), 0)
        rs = self.target / ".github" / "rulesets" / "main.json"
        self.assertTrue(rs.exists())
        self.assertTrue((self.target / ".github" / "pull_request_template.md").exists())
        rs.write_text("{}\n", encoding="utf-8")
        self.run_install("--with-github")
        self.assertEqual(rs.read_text(encoding="utf-8"), "{}\n")
        self.assertTrue(rs.with_name("main.json.xtemplates-new").exists())

    def test_refuses_self_and_missing(self):
        self.assertEqual(install.main([str(ROOT), "--label", "x"]), 2)
        self.assertEqual(install.main([str(self.target / "khong-co"), "--label", "x"]), 2)


class LegacyMigrationTest(unittest.TestCase):
    """ADR-0007: dự án cài bản ≤ 2.x (`.xstored/`, `xs.yaml`) chạy lại install là sang tên mới."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.target = Path(tmp.name).resolve()

    def install_quiet(self) -> tuple[int, str]:
        err = io.StringIO()
        with redirect_stderr(err):
            code = install.main([str(self.target), "--label", "t"])
        return code, err.getvalue()

    def make_legacy_install(self) -> Path:
        """Cài bản hiện tại rồi đổi về bố cục 2.x; hook stop-guard giả lập bản cũ chưa sửa (hash khớp manifest)."""
        self.install_quiet()
        legacy = self.target / ".xstored"
        (self.target / ".xtemplates").rename(legacy)
        (self.target / "xt.yaml").rename(self.target / "xs.yaml")
        (self.target / "xs.yaml").write_text('test: "true"\n', encoding="utf-8")
        hook = self.target / ".claude" / "hooks" / "stop-guard.sh"
        old = 'XS="$(xs_py)" || exit 0  # .xstored/scripts/xs.py\n'
        hook.write_text(old, encoding="utf-8")
        manifest = json.loads((legacy / "harness.sha256.json").read_text(encoding="utf-8"))
        manifest[".claude/hooks/stop-guard.sh"] = install.sha256(old.encode())
        (legacy / "harness.sha256.json").write_text(json.dumps(manifest), encoding="utf-8")
        (self.target / "AGENTS.md").write_text("Chạy `python3 .xstored/scripts/xs.py list`.\n", encoding="utf-8")
        return hook

    def test_upgrade_moves_dir_yaml_and_updates_pristine_hook(self):
        hook = self.make_legacy_install()
        code, err = self.install_quiet()
        self.assertEqual(code, 0, err)
        self.assertFalse((self.target / ".xstored").exists())
        self.assertTrue((self.target / ".xtemplates" / "scripts" / "xt.py").is_file())
        self.assertFalse((self.target / "xs.yaml").exists())
        self.assertEqual((self.target / "xt.yaml").read_text(encoding="utf-8"), 'test: "true"\n')
        self.assertEqual(hook.read_text(encoding="utf-8"), (ROOT / ".claude/hooks/stop-guard.sh").read_text("utf-8"))
        self.assertIn(".xstored/ → .xtemplates/", err)
        self.assertIn("xs.yaml → xt.yaml", err)
        self.assertIn("còn nhắc tên cũ", err)
        self.assertIn("AGENTS.md", err)
        self.assertNotIn("stop-guard.sh", err.split("còn nhắc tên cũ")[1])

    def test_new_manifest_wins_and_legacy_dir_without_manifest_is_removed(self):
        self.install_quiet()
        manifest = (self.target / ".xtemplates" / "harness.sha256.json").read_text(encoding="utf-8")
        (self.target / ".xstored").mkdir()
        (self.target / ".xstored" / "harness.sha256.json").write_text("{}", encoding="utf-8")
        self.install_quiet()
        self.assertEqual((self.target / ".xtemplates" / "harness.sha256.json").read_text(encoding="utf-8"), manifest)
        (self.target / ".xstored").mkdir()
        code, err = self.install_quiet()
        self.assertEqual(code, 0)
        self.assertFalse((self.target / ".xstored").exists())
        self.assertNotIn("còn nhắc tên cũ", err)

    def test_both_yaml_files_are_kept_with_warning(self):
        self.install_quiet()
        (self.target / "xs.yaml").write_text("test: cu\n", encoding="utf-8")
        code, err = self.install_quiet()
        self.assertEqual(code, 0)
        self.assertEqual((self.target / "xs.yaml").read_text(encoding="utf-8"), "test: cu\n")
        self.assertIn("có cả xs.yaml và xt.yaml", err)

    def test_legacy_symlink_is_not_followed(self):
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        (outside / "giu.txt").write_text("x", encoding="utf-8")
        (self.target / ".xstored").symlink_to(outside)
        code, _ = self.install_quiet()
        self.assertEqual(code, 0)
        self.assertTrue((self.target / ".xstored").is_symlink())
        self.assertTrue((outside / "giu.txt").exists())

    def test_legacy_refs_scans_workflows_and_skips_binary(self):
        wf = self.target / ".github" / "workflows"
        wf.mkdir(parents=True)
        (wf / "ci.yml").write_text("run: XS_DEBUG=1 bash scripts/dev-task.sh gate\n", encoding="utf-8")
        (self.target / ".claude" / "bin").mkdir(parents=True)
        (self.target / ".claude" / "bin" / "blob").write_bytes(b"\xff\xfe.xstored")
        (self.target / "README.md").write_text("Dùng .xtemplates/scripts/xt.py và xt.yaml.\n", encoding="utf-8")
        self.assertEqual(install.legacy_refs(self.target), [".github/workflows/ci.yml"])

    def test_legacy_refs_catches_xs_py_and_skips_shipped_files(self):
        hooks = self.target / ".claude" / "hooks"
        hooks.mkdir(parents=True)
        (hooks / "my-hook.sh").write_text('X="$(xs_py)" || exit 0\n', encoding="utf-8")
        shutil.copy2(ROOT / ".claude/hooks/_lib.sh", hooks / "_lib.sh")  # bản khung giữ bí danh XS_ROOT/xs_py
        self.assertEqual(install.legacy_refs(self.target), [".claude/hooks/my-hook.sh"])

    def test_upgrade_warns_loudly_about_kept_legacy_hook(self):
        self.make_legacy_install()
        kept = self.target / ".claude" / "hooks" / "pre-bash-guard.sh"
        kept.write_text(
            kept.read_text(encoding="utf-8").replace("XT_ROOT", "XS_ROOT") + "# sửa tay\n", encoding="utf-8"
        )
        code, err = self.install_quiet()
        self.assertEqual(code, 0, err)
        self.assertIn("HOOK còn tên cũ", err)
        listed = err.split("HOOK còn tên cũ")[1].splitlines()[0]
        self.assertIn(".claude/hooks/pre-bash-guard.sh", listed)
        self.assertNotIn("pre-bash-guard.sh.xtemplates-new", listed)  # bản mới của khung, không phải tên cũ


def make_fake_src(base: Path, ruleset: str | None = None) -> Path:
    """Khung giả tối thiểu: không research/, không templates/, không VERSION — để chạm nhánh 'thiếu'."""
    src = base / "khung"
    (src / "framework").mkdir(parents=True)
    (src / "framework" / "x.md").write_text("x\n", encoding="utf-8")
    (src / "scripts").mkdir()
    for f in ("xt.py", "dev-task.sh", "check-links.py"):
        (src / "scripts" / f).write_text("# giả\n", encoding="utf-8")
    (src / ".claude").mkdir()
    (src / ".claude" / "settings.json").write_text('{"hooks": {}}\n', encoding="utf-8")
    for d in install.HARNESS_DIRS:
        (src / ".claude" / d).mkdir()
    if ruleset is not None:
        (src / ".github" / "rulesets").mkdir(parents=True)
        (src / ".github" / "rulesets" / "main.json").write_text(ruleset, encoding="utf-8")
        (src / ".github" / "pull_request_template.md").write_text("pr\n", encoding="utf-8")
        (src / ".github" / "dependabot.yml").write_text("version: 2\n", encoding="utf-8")
    return src


class InstallEdgeTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        # git không được dò ngược lên thư mục cha (TMPDIR nằm trong một repo → framework_label nhặt nhầm SHA)
        ceiling = mock.patch.dict(os.environ, {"GIT_CEILING_DIRECTORIES": str(self.tmp.parent)})
        ceiling.start()
        self.addCleanup(ceiling.stop)
        self.target = self.tmp / "dich"
        self.target.mkdir()

    def install_quiet(self, *extra) -> tuple[int, str]:
        err = io.StringIO()
        with redirect_stderr(err):
            code = install.main([str(self.target), "--label", "t", *extra])
        return code, err.getvalue()

    def test_strip_frontmatter_unclosed_keeps_text(self):
        self.assertEqual(install.strip_frontmatter("---\ntitle: x\nkhông đóng\n"), "---\ntitle: x\nkhông đóng\n")
        self.assertEqual(install.strip_frontmatter("---\na: 1\n---\n\nthân\n"), "thân\n")
        self.assertEqual(install.strip_frontmatter(""), "")

    def test_write_atomic_writes_and_cleans_temp_on_failure(self):
        f = self.tmp / "out.json"
        install.write_atomic(f, "nội dung Đ\n")
        self.assertEqual(f.read_text(encoding="utf-8"), "nội dung Đ\n")
        with mock.patch.object(install.os, "replace", side_effect=OSError("đĩa đầy")):
            with self.assertRaises(OSError):
                install.write_atomic(f, "mới\n")
        self.assertEqual(f.read_text(encoding="utf-8"), "nội dung Đ\n")  # bản cũ còn nguyên
        self.assertEqual([p.name for p in self.tmp.iterdir() if p.name.endswith(".tmp")], [])  # không rác

    def test_merge_hooks_symlink_destination_is_skipped(self):
        outside = self.tmp / "ngoai.json"
        outside.write_text("{}", encoding="utf-8")
        dst = self.tmp / "settings.json"
        dst.symlink_to(outside)
        src = self.tmp / "src.json"
        src.write_text('{"hooks": {"Stop": [{"hooks": [{"command": "x"}]}]}}', encoding="utf-8")
        with redirect_stderr(io.StringIO()) as err:
            self.assertEqual(install.merge_hooks(src, dst), "skipped-symlink")
        self.assertIn("bỏ qua symlink", err.getvalue())
        self.assertEqual(outside.read_text(encoding="utf-8"), "{}")

    def test_merge_hooks_invalid_or_missing_json_is_reported(self):
        src = self.tmp / "src.json"
        src.write_text('{"hooks": {}}', encoding="utf-8")
        dst = self.tmp / "settings.json"
        dst.write_text("{không phải json", encoding="utf-8")
        with redirect_stderr(io.StringIO()) as err:
            self.assertEqual(install.merge_hooks(src, dst), "invalid-json")
        self.assertIn("HOOK CHƯA ĐĂNG KÝ", err.getvalue())
        self.assertEqual(dst.read_text(encoding="utf-8"), "{không phải json")  # không đè
        with redirect_stderr(io.StringIO()):
            self.assertEqual(install.merge_hooks(src, self.tmp / "khong-co.json"), "invalid-json")

    def test_install_with_invalid_existing_settings_keeps_it(self):
        settings = self.target / ".claude" / "settings.json"
        settings.parent.mkdir()
        settings.write_text("{hỏng", encoding="utf-8")
        code, err = self.install_quiet()
        self.assertEqual(code, 0)
        self.assertEqual(settings.read_text(encoding="utf-8"), "{hỏng")
        self.assertIn("invalid-json 1", err)

    def test_framework_label_variants(self):
        self.assertEqual(install.framework_label("v9"), "v9")
        src = self.tmp / "khung"
        src.mkdir()
        with mock.patch.object(install, "SRC", src):
            self.assertEqual(install.framework_label(None), "unknown")  # thiếu VERSION, không phải git repo
            (src / "VERSION").write_text("1.2.3\n", encoding="utf-8")
            ok = subprocess.CompletedProcess([], 0, stdout="abc1234\n", stderr="")
            with mock.patch.object(install.subprocess, "run", return_value=ok) as run:
                self.assertEqual(install.framework_label(None), "1.2.3 (abc1234)")
            self.assertIn(str(src), run.call_args.args[0])
            for result in (
                subprocess.CompletedProcess([], 128, stdout="", stderr="not a repo"),
                subprocess.CompletedProcess([], 0, stdout="  \n", stderr=""),
            ):
                with mock.patch.object(install.subprocess, "run", return_value=result):
                    self.assertEqual(install.framework_label(None), "1.2.3")
            for exc in (OSError("không có git"), subprocess.TimeoutExpired("git", 10)):
                with mock.patch.object(install.subprocess, "run", side_effect=exc):
                    self.assertEqual(install.framework_label(None), "1.2.3")

    def test_no_harness_skips_claude_dir_and_manifest(self):
        code, _ = self.install_quiet("--no-harness")
        self.assertEqual(code, 0)
        self.assertFalse((self.target / ".claude").exists())
        self.assertFalse((self.target / ".xtemplates" / "harness.sha256.json").exists())
        self.assertTrue((self.target / ".xtemplates" / "framework").is_dir())
        self.assertTrue((self.target / "AGENTS.md").exists())

    def test_preexisting_modified_hook_gets_new_file_and_no_manifest_entry(self):
        hook = self.target / ".claude" / "hooks" / "stop-guard.sh"
        hook.parent.mkdir(parents=True)
        hook.write_text("# của tôi\n", encoding="utf-8")
        code, err = self.install_quiet()
        self.assertEqual(code, 0)
        self.assertEqual(hook.read_text(encoding="utf-8"), "# của tôi\n")
        self.assertTrue(hook.with_name("stop-guard.sh.xtemplates-new").exists())
        self.assertIn(".xtemplates-new", err)
        manifest = json.loads((self.target / ".xtemplates" / "harness.sha256.json").read_text(encoding="utf-8"))
        self.assertNotIn(".claude/hooks/stop-guard.sh", manifest)  # không biết hash bản cài → không ghi
        self.assertIn(".claude/hooks/session-start.sh", manifest)

    def test_missing_root_template_is_skipped(self):
        with mock.patch.dict(install.ROOT_TEMPLATES, {"KHONG-CO.md": "KHONG-CO.md"}):
            code, _ = self.install_quiet()
        self.assertEqual(code, 0)
        self.assertFalse((self.target / "KHONG-CO.md").exists())
        self.assertTrue((self.target / "AGENTS.md").exists())

    def test_gitignore_is_appended_not_replaced(self):
        gi = self.target / ".gitignore"
        gi.write_text("node_modules/\n", encoding="utf-8")
        code, err = self.install_quiet()
        self.assertEqual(code, 0)
        self.assertEqual(
            gi.read_text(encoding="utf-8"),
            "node_modules/\n\n# X-Templates: trạng thái autopilot cục bộ\n.autopilot/\n",
        )
        self.assertIn("thêm .autopilot/", err)
        self.install_quiet()  # chạy lại: đã có dòng → không nhân đôi
        self.assertEqual(gi.read_text(encoding="utf-8").count(".autopilot/"), 1)

    def test_minimal_framework_without_research_templates_or_version(self):
        with mock.patch.object(install, "SRC", make_fake_src(self.tmp)):
            code, err = self.install_quiet()
        self.assertEqual(code, 0, err)
        xt_dir = self.target / ".xtemplates"
        self.assertFalse((xt_dir / "research").exists())
        self.assertTrue((xt_dir / "framework" / "x.md").exists())
        self.assertEqual((xt_dir / "VERSION").read_text(encoding="utf-8"), "t\n")
        self.assertFalse((self.target / "AGENTS.md").exists())  # không có mẫu → không tạo
        self.assertTrue((self.target / ".claude" / "settings.json").exists())

    def test_with_github_unreadable_or_checkless_ruleset_has_no_warning(self):
        cases = {
            "không phải json": "{không phải json",
            "thiếu khoá rules": "{}",
            "rules không có check": '{"rules": [{"type": "deletion"}]}',
        }
        for name, content in cases.items():
            with self.subTest(name):
                target = self.tmp / ("dich-" + str(len(name)))
                target.mkdir()
                src = make_fake_src(self.tmp / ("src-" + str(len(name))), ruleset=content)
                err = io.StringIO()
                with mock.patch.object(install, "SRC", src), redirect_stderr(err):
                    self.assertEqual(install.main([str(target), "--label", "t", "--with-github"]), 0)
                self.assertNotIn("required check", err.getvalue())
                self.assertEqual((target / ".github" / "rulesets" / "main.json").read_text(encoding="utf-8"), content)
                self.assertTrue((target / ".github" / "dependabot.yml").exists())

    def test_run_as_script(self):
        r = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "install.py"), str(self.target), "--label", "cli", "--no-harness"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.target / ".xtemplates" / "VERSION").read_text(encoding="utf-8"), "cli\n")
        self.assertIn("[install] Xong.", r.stderr)


class CheckLinksTest(unittest.TestCase):
    def test_repo_links_ok(self):
        r = subprocess.run([sys.executable, str(ROOT / "scripts" / "check-links.py")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_detects_broken(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "a.md").write_text(
            "[x](b.md) [ok](#h) [url](https://x) `[no](c.md)`\n```\n[in-fence](d.md)\n```\n", encoding="utf-8"
        )
        r = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "check-links.py"), str(tmp)], capture_output=True, text=True
        )
        self.assertEqual(r.returncode, 1)
        self.assertIn("b.md", r.stdout)
        self.assertNotIn("d.md", r.stdout)


if __name__ == "__main__":
    unittest.main()
