import importlib.util
import io
import re
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

_spec = importlib.util.spec_from_file_location("pr_policy", Path(__file__).with_name("pr-policy.py"))
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

TEMPLATE = (Path(__file__).resolve().parent.parent / ".github" / "pull_request_template.md").read_text(encoding="utf-8")


def codes(warns):
    return [c for c, _ in warns]


def body(goal="", docs="- [ ] Không cần — lý do: …", table=""):
    return (
        f"## Mục tiêu / SPEC\n{goal}\n\n## Docs cập nhật / không cần\n{docs}\n\n"
        f"## Refactor / perf — bảng trước–sau\n| Số đo | Trước | Sau |\n|---|---|---|\n{table}\n\n## Migration\n"
    )


class DocsTest(unittest.TestCase):
    def test_doi_registry_khong_cham_docs_thi_canh_bao(self):
        w = mod.check(["packages/app/src/http/registry.ts"], "feat(api): thêm lệnh", body("T-607"))
        self.assertIn("WF-DOC-001", codes(w))

    def test_cac_be_mat_cong_khai_khac(self):
        for f in (
            "apps/web/app/api/v1/x/route.ts",
            "packages/db/migrations/0061_x.ts",
            "packages/app/src/config/schema.ts",
            ".env.example",
            "apps/web/openapi.json",
        ):
            with self.subTest(f=f):
                self.assertIn("WF-DOC-001", codes(mod.check([f])))

    def test_cham_docs_thi_khong_canh_bao(self):
        w = mod.check(["packages/app/src/http/registry.ts", "docs/design/API-CONTRACT.md"], "feat(api): x", body("S-001"))
        self.assertNotIn("WF-DOC-001", codes(w))

    def test_mien_tru_co_ly_do_that(self):
        ok = body("T-1", docs="- [x] Không cần — lý do: chỉ đổi nội bộ, hợp đồng không đổi")
        self.assertNotIn("WF-DOC-001", codes(mod.check([".env.example"], "chore: x", ok)))
        # Tick nhưng bỏ trống/dấu … = không phải lý do.
        for reason in ("…", "", "ko"):
            with self.subTest(reason=reason):
                bad = body("T-1", docs=f"- [x] Không cần — lý do: {reason}")
                self.assertIn("WF-DOC-001", codes(mod.check([".env.example"], "chore: x", bad)))

    def test_khai_da_cap_nhat_ma_khong_co_md(self):
        b = body("T-1", docs="- [x] Đã cập nhật: README")
        self.assertIn("WF-DOC-001", codes(mod.check(["packages/app/src/a.ts"], None, b)))
        self.assertNotIn("WF-DOC-001", codes(mod.check(["packages/app/src/a.ts", "README.md"], None, b)))

    def test_rong_khong_canh_bao(self):
        self.assertEqual(mod.check([]), [])
        self.assertEqual(mod.check(["", "  "]), [])

    def test_file_thuong_khong_canh_bao(self):
        self.assertEqual(mod.check(["packages/app/src/x/y.ts"]), [])


class GreenTest(unittest.TestCase):
    TABLE = "| Dòng mã | 1200 | 1100 |\n"

    def test_refactor_tron_feat(self):
        w = mod.check([], "refactor(x): tách hàm", body(table=self.TABLE), ["refactor: a", "feat(y): thêm b"])
        self.assertIn("XC-GREEN-005", codes(w))

    def test_perf_tron_fix(self):
        w = mod.check([], "perf(x): nhanh hơn", body(table=self.TABLE), ["fix(y): sửa"])
        self.assertIn("XC-GREEN-005", codes(w))

    def test_refactor_thieu_bang_truoc_sau(self):
        w = mod.check([], "refactor(x): tách hàm", body(), ["refactor: a"])
        self.assertEqual(codes(w), ["XC-GREEN-005"])
        w = mod.check([], "refactor(x): a", body(table="| Dòng mã | 1200 | |\n"), [])
        self.assertEqual(codes(w), ["XC-GREEN-005"])

    def test_refactor_dat(self):
        self.assertEqual(mod.check([], "refactor(x): tách hàm", body(table=self.TABLE), ["refactor: a"]), [])

    def test_mau_pr_goc_chua_dien_thi_khong_tinh_la_da_dien(self):
        self.assertFalse(mod.filled_before_after(TEMPLATE))

    def test_tinh_nang_khong_bi_doi_bang(self):
        self.assertNotIn("XC-GREEN-005", codes(mod.check([], "feat(x): a", body("T-1"), ["feat: a"])))


class DorTest(unittest.TestCase):
    def test_feat_thieu_id(self):
        self.assertIn("WF-TEAM-003", codes(mod.check([], "feat(x): thêm", body("Làm cho nhanh"))))

    def test_fix_co_id(self):
        for goal in ("S-013", "T-607", "D-034", "F-016", "sửa #12"):
            with self.subTest(goal=goal):
                self.assertNotIn("WF-TEAM-003", codes(mod.check([], "fix(x): sửa", body(goal))))

    def test_chu_thich_html_khong_tinh_la_id(self):
        self.assertIn("WF-TEAM-003", codes(mod.check([], "feat(x): a", body("<!-- T-123 -->"))))

    def test_docs_chore_khong_can_id(self):
        self.assertNotIn("WF-TEAM-003", codes(mod.check([], "docs: sửa lỗi chính tả", body(""))))

    def test_spec_approved_con_cau_chan(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "docs" / "specs").mkdir(parents=True)
            (root / "docs/specs/SPEC-a.md").write_text(
                "| Trạng thái | Approved |\n- [ ] Prorata — [chặn] — hỏi: PO\n", encoding="utf-8"
            )
            (root / "docs/specs/SPEC-b.md").write_text(
                "| Trạng thái | Draft |\n- [ ] Prorata — [chặn] — hỏi: PO\n", encoding="utf-8"
            )
            (root / "docs/specs/SPEC-c.md").write_text(
                "| Trạng thái | Approved |\n- [x] Prorata — [chặn] — **Quyết 2026-10-15:** x\n", encoding="utf-8"
            )
            w = mod.check(
                ["docs/specs/SPEC-a.md", "docs/specs/SPEC-b.md", "docs/specs/SPEC-c.md", "docs/specs/SPEC-xoa.md"],
                root=root,
            )
            self.assertEqual([m.split(":")[0] for c, m in w if c == "WF-TEAM-003"], ["docs/specs/SPEC-a.md"])


class TitleAndCliTest(unittest.TestCase):
    def test_tieu_de(self):
        for t in ("lung tung", "feat: ", "Feat(x): a", "feat(x): " + "a" * 80, "khac(x): a", ""):
            with self.subTest(t=t):
                self.assertIn("PR-TITLE", codes(mod.check([], t)))
        for t in ("feat(api): thêm lệnh", "fix: sửa", "refactor(core)!: đổi", "docs(x): tiếng Việt có dấu ✓"):
            with self.subTest(t=t):
                self.assertNotIn("PR-TITLE", codes(mod.check([], t)))

    def test_pr_type(self):
        self.assertEqual(mod.pr_type("perf(a): b"), "perf")
        self.assertIsNone(mod.pr_type("wip: b"))

    def test_cli_chi_canh_bao_tru_khi_strict(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "pr.md"
            f.write_text(body("Làm"), encoding="utf-8")
            import sys

            old = sys.stdin
            try:
                for strict, expected in ((False, 0), (True, 1)):
                    sys.stdin = io.StringIO(".env.example\n")
                    out = io.StringIO()
                    argv = ["--files", "-", "--title", "feat(x): a", "--body-file", str(f)] + (["--strict"] if strict else [])
                    with redirect_stdout(out):
                        rc = mod.main(argv)
                    self.assertEqual(rc, expected)
                    self.assertIn("CẢNH BÁO [WF-DOC-001]", out.getvalue())
                sys.stdin = io.StringIO("docs/a.md\n")
                out = io.StringIO()
                with redirect_stdout(out):
                    self.assertEqual(mod.main(["--files", "-", "--title", "docs: a", "--strict"]), 0)
                self.assertIn("không có cảnh báo", out.getvalue())
            finally:
                sys.stdin = old


def full(
    goal="Làm rào máy cho PR. Spec: S-001, task T-801.",
    gate="- [x] `.xtemplates/scripts/dev-task.sh gate` exit 0 (build · typecheck · lint · test) — exit 0, CI https://github.com/o/r/actions/runs/1",
    ac="- [x] S-001 → `scripts/test_pr_policy.py` (test_tieu_de)",
    risk="Chỉ đổi công cụ kiểm; sai thì job pr-policy đỏ nhầm. Rollback: revert PR này.",
    table="| Số test (`pnpm test`) | 10 | 10 |\n",
):
    return (
        f"## Mục tiêu / SPEC\n{goal}\n\n## Bằng chứng cổng\n{gate}\n\n## Tiêu chí chấp nhận\n{ac}\n\n"
        f"## Refactor / perf — bảng trước–sau\n| Số đo | Trước | Sau |\n|---|---|---|\n{table}\n## Rủi ro\n{risk}\n\n## Checklist bảo mật\n"
    )


class ReviewBodyTest(unittest.TestCase):
    def run_body(self, body, title="feat(ci): rào PR", files=None):
        return codes(mod.check_body(body, title, files or []))

    def test_mo_ta_day_du_dat(self):
        self.assertEqual(self.run_body(full()), [])

    def test_mau_pr_goc_chua_dien_bi_bat_ca_bon_muc(self):
        w = self.run_body(TEMPLATE)
        self.assertEqual(w.count("WF-REVIEW-002"), 3)
        self.assertIn("WF-SDD-003", w)

    def test_thieu_muc_tieu(self):
        for goal in ("", "…", "<!-- chỉ chú thích -->", "ngắn"):
            with self.subTest(goal=goal):
                self.assertIn("WF-REVIEW-002", self.run_body(full(goal=goal)))

    def test_muc_tieu_khong_co_id_tru_feat_fix(self):
        self.assertIn("WF-REVIEW-002", self.run_body(full(goal="Sửa lỗi chính tả trong tài liệu"), "docs: chính tả"))
        for ok in ("Sửa chính tả, xem https://example.test/issue/3", "Sửa chính tả theo T-801"):
            with self.subTest(goal=ok):
                self.assertEqual(self.run_body(full(goal=ok), "docs: chính tả"), [])
        # feat/fix thiếu ID đã do WF-TEAM-003 (check) báo, check_body không báo trùng.
        self.assertNotIn("WF-REVIEW-002", self.run_body(full(goal="Làm cho nhanh hơn nhiều"), "fix(x): nhanh"))

    def test_xac_minh_phai_co_lenh_va_exit_hoac_link(self):
        label = mod.template_labels("Bằng chứng cổng")[0]
        self.assertIn("WF-REVIEW-002", self.run_body(full(gate=f"- [x] {label}")))  # tick nguyên chữ mẫu
        self.assertIn("WF-REVIEW-002", self.run_body(full(gate=f"- [ ] {label} — exit 0")))  # không tick
        self.assertIn("WF-REVIEW-002", self.run_body(full(gate="- [x] đã chạy rồi, xanh")))
        self.assertEqual(self.run_body(full(gate="- [x] đã chạy gate: exit 0")), [])
        self.assertEqual(self.run_body(full(gate="- [x] CI https://github.com/o/r/actions/runs/9")), [])
        self.assertEqual(self.run_body(full(gate="- [x] gate exit code 0")), [])
        self.assertIn("WF-REVIEW-002", self.run_body(full(gate="- [x] exit code ?")))

    def test_rui_ro_phai_co_rollback(self):
        self.assertIn("WF-REVIEW-002", self.run_body(full(risk="Có thể ảnh hưởng ca thu tiền của lễ tân nếu sai.")))
        self.assertIn("WF-REVIEW-002", self.run_body(full(risk="Rollback")))  # quá ngắn
        self.assertIn("WF-REVIEW-002", self.run_body(full(risk="")))
        for ok in ("Sai thì chặn nhầm PR hợp lệ; quay lại bằng revert.", "Ảnh hưởng nhỏ — khôi phục từ bản sao lưu PITR."):
            with self.subTest(risk=ok):
                self.assertEqual(self.run_body(full(risk=ok)), [])


class ScenarioMapTest(unittest.TestCase):
    def run_body(self, ac, title="feat(x): thêm", files=None):
        return [(c, m) for c, m in mod.check_body(full(ac=ac), title, files or []) if c == "WF-SDD-003"]

    def test_feat_co_ban_do_dat(self):
        self.assertEqual(self.run_body("- [x] S-001 → `scripts/test_pr_policy.py`"), [])
        self.assertEqual(self.run_body("- [x] AC-01: `scripts/pr-policy.py` ↔ test_tieu_de trong `scripts/test_pr_policy.py`"), [])

    def test_feat_thieu_ban_do(self):
        for ac in ("- [ ] …", "", "- [x] làm xong", "- [x] S-001 xong rồi", "- [x] `scripts/test_pr_policy.py` không có ID"):
            with self.subTest(ac=ac):
                self.assertEqual(len(self.run_body(ac)), 1)

    def test_mien_tru_co_ly_do(self):
        self.assertEqual(self.run_body("không áp dụng — lý do: thay đổi công cụ, không có scenario"), [])
        self.assertEqual(len(self.run_body("không áp dụng — lý do: ")), 1)
        self.assertEqual(len(self.run_body("không áp dụng — lý do: ngắn")), 1)

    def test_test_khong_ton_tai_bi_bat(self):
        w = self.run_body("- [x] S-001 → `scripts/khong-co.test.mjs`")
        self.assertEqual(len(w), 1)
        self.assertIn("khong-co.test.mjs", w[0][1])
        # file có trong diff (mới thêm) thì được.
        self.assertEqual(self.run_body("- [x] S-001 → `scripts/khong-co.test.mjs`", files=["scripts/khong-co.test.mjs"]), [])

    def test_chi_ap_dung_cho_feat(self):
        for t in ("fix(x): a", "docs: a", "refactor(x): a", "perf(x): a", "test: a", "chore: a"):
            with self.subTest(t=t):
                self.assertEqual(self.run_body("- [ ] …", title=t), [])
        self.assertEqual(self.run_body("- [ ] …", title=None), [])


class RefactorTestCountTest(unittest.TestCase):
    def run_body(self, table, files=None, title="refactor(x): tách"):
        return [m for c, m in mod.check_body(full(table=table), title, files or []) if c == "XC-GREEN-005"]

    def test_test_counts(self):
        self.assertEqual(mod.test_counts(full(table="| Số test | 2.346 | 2.350 |\n")), (2346, 2350))
        self.assertEqual(mod.test_counts(full(table="| Số test (`pnpm test`) | 10 | 10 |\n")), (10, 10))
        self.assertEqual(mod.test_counts(full(table="| Số test | 10 | |\n")), None)
        self.assertEqual(mod.test_counts(full(table="| Số test | mười | 10 |\n")), None)
        self.assertEqual(mod.test_counts(full(table="| Dòng mã | 1 | 2 |\n")), None)
        self.assertEqual(mod.test_counts(TEMPLATE), None)

    def test_khong_doi_dat(self):
        self.assertEqual(self.run_body("| Số test | 10 | 10 |\n"), [])

    def test_thieu_hang_so_test(self):
        self.assertEqual(len(self.run_body("| Dòng mã | 1200 | 1100 |\n")), 1)

    def test_giam_so_test_bi_bat(self):
        w = self.run_body("| Số test | 10 | 9 |\n", files=["a.test.ts"])
        self.assertEqual(len(w), 1)
        self.assertIn("giảm", w[0])

    def test_tang_phai_co_file_test(self):
        self.assertEqual(len(self.run_body("| Số test | 10 | 12 |\n", files=["src/a.ts"])), 1)
        for f in ("src/a.test.ts", "e2e/x.spec.ts", "scripts/test_pr_policy.py", "scripts/a.test.mjs"):
            with self.subTest(f=f):
                self.assertEqual(self.run_body("| Số test | 10 | 12 |\n", files=["src/a.ts", f]), [])

    def test_perf_cung_tinh_va_feat_khong(self):
        self.assertEqual(len(self.run_body("| Dòng mã | 1 | 2 |\n", title="perf(x): nhanh")), 1)
        self.assertEqual(self.run_body("| Dòng mã | 1 | 2 |\n", title="feat(x): a"), [])


class RiskLabelTest(unittest.TestCase):
    def warn(self, files, labels):
        return [m for c, m in mod.check(files, labels=labels) if c == "LOOP-STOP-005"]

    def test_chua_co_nhan_thi_bao(self):
        w = self.warn(["packages/app/src/ledger/post.ts"], [])
        self.assertEqual(len(w), 1)
        self.assertIn("risk:money", w[0])

    def test_co_nhan_dat(self):
        self.assertEqual(self.warn(["packages/app/src/ledger/post.ts"], ["risk:money", "x"]), [])
        self.assertEqual(self.warn(["packages/app/src/identity/a.ts"], [" risk:auth "]), [])

    def test_nhan_sai_van_bao(self):
        self.assertEqual(len(self.warn(["packages/app/src/identity/a.ts"], ["risk:money"])), 1)

    def test_nhieu_vung_can_nhieu_nhan(self):
        w = self.warn(["packages/app/src/ledger/a.ts", "packages/app/src/crypto/b.ts", "packages/db/src/migrations/0064_x.ts"], ["risk:money"])
        self.assertEqual(sorted(re.search(r"risk:\w+", m).group(0) for m in w), ["risk:crypto", "risk:data"])

    def test_tien_to_goc(self):
        self.assertEqual(len(self.warn(["apps/web/app/api/v1/x/route.ts"], [])), 1)
        self.assertEqual(len(self.warn(["packages/db/src/x.ts"], [])), 1)

    def test_khong_cham_vung_nhay_cam(self):
        self.assertEqual(self.warn(["scripts/a.mjs", "docs/x.md", "README.md", "ledger.md"], []), [])
        self.assertEqual(self.warn([], []), [])

    def test_khong_truyen_nhan_thi_bo_qua(self):
        self.assertEqual(self.warn(["packages/app/src/ledger/post.ts"], None), [])

    def test_moi_muc_merge_risk_paths_cua_xt_yaml_deu_co_nhan(self):
        text = (Path(__file__).resolve().parent.parent / "xt.yaml").read_text(encoding="utf-8")
        raw = re.search(r'^merge_risk_paths:\s*"([^"]+)"', text, re.M).group(1)
        known = {d for dirs in mod.RISK_DIRS.values() for d in dirs}
        prefixes = tuple(p for ps in mod.RISK_PREFIXES.values() for p in ps)
        for glob in (g.strip() for g in raw.split(",")):
            with self.subTest(glob=glob):
                m = re.fullmatch(r"\*/([\w-]+)/\*", glob)
                if m:
                    self.assertIn(m.group(1), known)
                else:
                    self.assertTrue(glob.rstrip("*").startswith(prefixes) or glob.rstrip("*") in prefixes, glob)

    def test_cli_labels(self):
        import sys

        old = sys.stdin
        try:
            for labels, expected in (("", 1), ("risk:money", 0)):
                sys.stdin = io.StringIO("packages/app/src/ledger/a.ts\n")
                out = io.StringIO()
                with redirect_stdout(out):
                    rc = mod.main(["--files", "-", "--labels", labels, "--strict"])
                self.assertEqual(rc, expected)
        finally:
            sys.stdin = old


class WholeTemplateTest(unittest.TestCase):
    def test_mau_pr_dien_that_dat(self):
        """Mẫu PR thật, điền đúng hướng dẫn, qua mọi rào (check + check_body)."""
        b = TEMPLATE
        b = b.replace("## Mục tiêu / SPEC\n", "## Mục tiêu / SPEC\nNối pr-policy vào CI (T-801).\n", 1)
        b = b.replace("- [ ] `.xtemplates/scripts/dev-task.sh gate` exit 0", "- [x] `.xtemplates/scripts/dev-task.sh gate` exit 0", 1)
        b = b.replace("hoặc link job CI `quality`\n", "hoặc link job CI `quality`: exit 0\n", 1)
        b = b.replace("## Tiêu chí chấp nhận\n", "## Tiêu chí chấp nhận\n- [x] S-001 → `scripts/test_pr_policy.py`\n", 1)
        b = b.replace("## Rủi ro\n", "## Rủi ro\nSai thì job đỏ nhầm; rollback bằng revert PR.\n", 1)
        w = mod.check(["scripts/pr-policy.py", "docs/x.md"], "feat(ci): pr-policy", b, ["feat(ci): pr-policy"], labels=[]) + mod.check_body(
            b, "feat(ci): pr-policy", ["scripts/pr-policy.py"]
        )
        self.assertEqual(w, [])


if __name__ == "__main__":
    unittest.main()
