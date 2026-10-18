import importlib.util
import io
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

_spec = importlib.util.spec_from_file_location("pr_policy", Path(__file__).with_name("pr-policy.py"))
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

REPO = Path(__file__).resolve().parent.parent
TEMPLATE = (REPO / ".github" / "pull_request_template.md").read_text(encoding="utf-8")
UPGRADE = (REPO / ".github" / "PULL_REQUEST_TEMPLATE" / "major-upgrade.md").read_text(encoding="utf-8")


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


class VerificationEvidenceTest(unittest.TestCase):
    """🟡4: chỉ `exit 0` hoặc link lượt chạy, ngoài chữ có sẵn của mẫu; exit khác 0 không phải bằng chứng."""

    LINE = TEMPLATE.split("## Bằng chứng cổng")[1].split("\n- [ ] ", 1)[1].split("\n", 1)[0]  # dòng gate của mẫu

    def gate(self, text):
        return f"## Bằng chứng cổng\n{text}\n\n## Rủi ro\n"

    def test_tick_dong_mau_roi_ghi_da_chay_van_do(self):
        self.assertFalse(mod.has_verification(self.gate(f"- [x] {self.LINE} đã chạy")))
        # nhãn bị cắt đuôi nhưng vẫn mang chữ `exit 0` có sẵn của mẫu
        self.assertFalse(mod.has_verification(self.gate("- [x] `.xtemplates/scripts/dev-task.sh gate` exit 0 đã chạy")))
        self.assertFalse(mod.has_verification(self.gate(f"- [x] {self.LINE}")))

    def test_exit_khac_0_khong_phai_bang_chung(self):
        for text in ("gate exit 1", "gate exit code 2", "exit 10", "exit 01", "exit code ?", "exit -1"):
            with self.subTest(text=text):
                self.assertFalse(mod.has_verification(self.gate(f"- [x] {text}")))

    def test_exit_0_hoac_link_thi_dat(self):
        for text in ("gate exit 0", "gate exit code 0", "gate exit: 0", "CI https://github.com/o/r/actions/runs/1"):
            with self.subTest(text=text):
                self.assertTrue(mod.has_verification(self.gate(f"- [x] {text}")))
        self.assertTrue(mod.has_verification(self.gate(f"- [x] {self.LINE}: exit 0")))
        self.assertTrue(mod.has_verification(self.gate("- [x] `.xtemplates/scripts/dev-task.sh gate` exit 0 — kết quả exit 0 lúc 10:00")))

    def test_chua_tick_thi_khong_tinh(self):
        self.assertFalse(mod.has_verification(self.gate("- [ ] gate exit 0 https://example.test/x")))
        self.assertFalse(mod.has_verification(""))


def fill_upgrade(text=UPGRADE, **skip):
    """Điền mẫu nâng cấp MAJOR đúng hướng dẫn (bỏ qua các khoá trong `skip` để thử thiếu)."""
    edits = {
        "pkg": ("- Gói / thành phần: …", "- Gói / thành phần: next"),
        "ver": ("- Từ → đến (ghim đúng phiên bản, không dải): … → …", "- Từ → đến (ghim đúng phiên bản, không dải): 15.5.4 → 16.0.1"),
        "why": (
            "- Lý do nâng (lỗ hổng, hết hỗ trợ — ghi ngày EOL —, tính năng cần): …",
            "- Lý do nâng (lỗ hổng, hết hỗ trợ — ghi ngày EOL —, tính năng cần): bản 15 hết hỗ trợ ngày 2026-11-01",
        ),
        "src": ("- Nguồn: …", "- Nguồn: https://nextjs.org/docs/app/guides/upgrading"),
        "gate": (
            "- [ ] `.xtemplates/scripts/dev-task.sh gate` exit 0 — dán kết quả/link CI",
            "- [x] `.xtemplates/scripts/dev-task.sh gate` exit 0 — dán kết quả/link CI: https://github.com/o/r/actions/runs/7",
        ),
        "back": (
            "migration có `down`): …",
            "migration có `down`): revert PR này rồi ghim lại 15.5.4",
        ),
        "risk": ("## Rủi ro\n", "## Rủi ro\nBuild/route lỗi nếu API đổi; phát hiện qua E2E, tắt bằng revert.\n"),
    }
    for key, (a, b) in edits.items():
        if key not in skip:
            assert a in text, a
            text = text.replace(a, b, 1)
    return text


class MajorUpgradeTemplateTest(unittest.TestCase):
    """🟠2: mẫu `major-upgrade.md` điền đủ phải qua `--strict`; để trống thì đỏ."""

    TITLE = "chore(deps): nâng next lên 16"
    FILES = ["package.json", "pnpm-lock.yaml"]

    def warns(self, text):
        return mod.check(self.FILES, self.TITLE, text, [self.TITLE], labels=["major"]) + mod.check_body(text, self.TITLE, self.FILES)

    def cli_rc(self, text):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "pr.md"
            f.write_text(text, encoding="utf-8")
            old = sys.stdin
            sys.stdin = io.StringIO("\n".join(self.FILES) + "\n")
            try:
                with redirect_stdout(io.StringIO()):
                    return mod.main(["--files", "-", "--title", self.TITLE, "--body-file", str(f), "--labels", "major", "--strict"])
            finally:
                sys.stdin = old

    def test_dien_du_thi_qua_strict(self):
        self.assertEqual(self.warns(fill_upgrade()), [])
        self.assertEqual(self.cli_rc(fill_upgrade()), 0)

    def test_de_trong_thi_do(self):
        w = self.warns(UPGRADE)
        self.assertGreaterEqual(codes(w).count("WF-REVIEW-002"), 3)  # mục tiêu, bằng chứng, rủi ro/rollback
        self.assertEqual(self.cli_rc(UPGRADE), 1)

    def test_thieu_tung_muc_thi_do(self):
        for missing in ("pkg", "ver", "why", "src", "gate", "risk"):
            with self.subTest(missing=missing):
                self.assertIn("WF-REVIEW-002", codes(self.warns(fill_upgrade(**{missing: True}))))
                self.assertEqual(self.cli_rc(fill_upgrade(**{missing: True})), 1)

    def test_duong_lui_o_muc_trien_khai_duoc_tinh_la_rollback(self):
        text = fill_upgrade(risk=True).replace("## Rủi ro\n", "## Rủi ro\nBuild/route lỗi nếu API đổi; phát hiện qua E2E.\n", 1)
        self.assertEqual(self.warns(text), [])  # rollback nằm ở 'Đường lùi', rủi ro ở 'Rủi ro'
        self.assertIn("WF-REVIEW-002", codes(self.warns(fill_upgrade(risk=True, back=True))))  # không ở đâu cả → đỏ

    def test_nguon_chua_xac_minh_duoc_chap_nhan(self):
        text = fill_upgrade(src=True).replace("- Nguồn: …", "- Nguồn: (chưa xác minh)", 1)
        self.assertEqual(self.warns(text), [])

    def test_chu_co_san_cua_mau_khong_tinh_la_da_dien(self):
        # tick sẵn dòng gate mà không ghi thêm gì → vẫn đỏ; nhãn "Đường lùi" có chữ revert của mẫu không tính là rollback
        text = fill_upgrade(gate=True).replace("- [ ] `.xtemplates", "- [x] `.xtemplates", 1)
        self.assertIn("WF-REVIEW-002", codes(self.warns(text)))
        self.assertIn("WF-REVIEW-002", codes(self.warns(fill_upgrade(back=True, risk=True))))

    def test_mau_chinh_khong_bi_anh_huong(self):
        self.assertTrue(mod.is_upgrade_body(UPGRADE))
        self.assertFalse(mod.is_upgrade_body(TEMPLATE))
        self.assertFalse(mod.is_upgrade_body(fill_upgrade() + "\n## Mục tiêu / SPEC\nx"))


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

    def test_cau_hinh_cong_can_nhan_gate(self):
        for f in (
            "vitest.config.ts",
            "apps/web/playwright.config.ts",
            "biome.json",
            "tsconfig.base.json",
            "apps/web/tsconfig.json",
            "xt.yaml",
            "scripts/check-coverage-ratchet.mjs",
            "scripts/fix-requires-test.mjs",
            ".github/workflows/test-quality.yml",
        ):
            with self.subTest(f=f):
                w = self.warn([f], [])
                self.assertEqual(len(w), 1)
                self.assertIn("risk:gate", w[0])
                self.assertEqual(self.warn([f], ["risk:gate"]), [])

    def test_gan_gate_nhung_khong_phai_file_cong(self):
        self.assertEqual(self.warn(["scripts/check-coverage.mjs", "docs/xt.yaml.md", "apps/web/app/tsconfig.json.bak"], []), [])

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
                    files = {g for gs in mod.RISK_FILES.values() for g in gs}
                    self.assertTrue(
                        glob.rstrip("*").startswith(prefixes) or glob.rstrip("*") in prefixes or glob in files, glob
                    )

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
