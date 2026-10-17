import importlib.util
import io
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


if __name__ == "__main__":
    unittest.main()
