import importlib.util
import tempfile
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "check_blueprint_evidence", Path(__file__).with_name("check-blueprint-evidence.py")
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


class EvidenceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        (self.root / "packages").mkdir()
        (self.root / "packages" / "a.test.ts").write_text("x")
        wf = self.root / ".github" / "workflows"
        wf.mkdir(parents=True)
        (wf / "ci.yml").write_text("on: push\njobs:\n  quality:\n    runs-on: x\n  e2e:\n    runs-on: x\n")

    def tearDown(self):
        self.dir.cleanup()

    def check(self, text):
        return [(n, i, why) for n, i, why in mod.problems(text, self.root, mod.ci_jobs(self.root))]

    def test_tick_co_bang_chung_hop_le(self):
        text = "- [x] `A-1` **MUST** Mô tả · Bằng chứng: `packages/a.test.ts#S-001`, `ci:e2e`"
        self.assertEqual(self.check(text), [])

    def test_tick_thieu_bang_chung(self):
        self.assertEqual(self.check("- [x] `A-1` **MUST** Mô tả"), [(1, "A-1", "đã tick nhưng thiếu 'Bằng chứng:'")])

    def test_bang_chung_rong_duong_dan_sai_job_sai(self):
        text = "\n".join(
            [
                "- [x] `A-1` **MUST** x · Bằng chứng: chạy tay",
                "- [x] `A-2` **SHOULD** x · Bằng chứng: `packages/khong-co.ts`",
                "- [x] `A-3` **MUST** x · Bằng chứng: `ci:deploy`",
                "- [x] `A-4` **MUST** x · Bằng chứng: `../ngoai-repo.txt`",
            ]
        )
        self.assertEqual([i for _, i, _ in self.check(text)], ["A-1", "A-2", "A-3", "A-4"])

    def test_mien_tru_can_ly_do(self):
        text = "\n".join(
            [
                "- [~] `B-1` **MUST** x — Miễn: ngoài V1 — chủ dự án duyệt",
                "- [~] `B-2` **MUST** x",
                "- [~] `B-3` **MUST** x — Miễn:   ",
            ]
        )
        self.assertEqual([i for _, i, _ in self.check(text)], ["B-2", "B-3"])

    def test_bo_qua_muc_chua_tick_va_van_xuoi(self):
        text = "- [ ] `C-1` **MUST** x\nVăn xuôi `[x]` Bằng chứng: không phải mục\n  - [x] mục con"
        self.assertEqual(self.check(text), [])

    def test_main_tra_ma_thoat(self):
        bp = self.root / "BLUEPRINT.md"
        bp.write_text("- [x] `A-1` **MUST** x · Bằng chứng: `packages/a.test.ts`\n")
        self.assertEqual(mod.main(["x", str(bp)]), 0)
        bp.write_text("- [x] `A-1` **MUST** x\n")
        self.assertEqual(mod.main(["x", str(bp)]), 1)


class RepoBlueprintTest(unittest.TestCase):
    """BLUEPRINT.md thật của repo phải sạch: job `pr-policy` chạy unittest này, nên PR làm hỏng bằng chứng (vd tên trigger
    trong `…` bị hiểu là đường dẫn — PR #49) đỏ ngay ở PR thay vì chỉ lộ ra khi `loop verify`."""

    def test_blueprint_cua_repo_khong_loi(self):
        root = Path(__file__).resolve().parent.parent
        text = (root / "BLUEPRINT.md").read_text(encoding="utf-8")
        self.assertEqual(mod.problems(text, root, mod.ci_jobs(root)), [])


if __name__ == "__main__":
    unittest.main()
