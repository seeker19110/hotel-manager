import importlib.util
import tempfile
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "check_blocking_questions", Path(__file__).with_name("check-blocking-questions.py")
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


class OpenBlockingTest(unittest.TestCase):
    def test_bat_cau_chan_chua_tick(self):
        text = "\n".join(
            [
                "- [ ] Prorata — [chặn] — hỏi: PO",
                "- [ ] Mốc giờ — [chặn F-003] — hỏi: PO",
                "- [ ] Hoàn credit — [chặn pilot] — hỏi: PO",
            ]
        )
        self.assertEqual([n for n, _ in mod.open_blocking(text)], [1, 2, 3])

    def test_bo_qua_cau_da_tick_va_khong_chan(self):
        text = "\n".join(
            [
                "- [x] Prorata — [chặn] — **Quyết 2026-10-15:** …",
                "- [ ] Ghi nhận doanh thu — [không chặn pilot] — hỏi: kế toán",
                "Câu [chặn] trong văn xuôi không phải mục danh sách",
                "  - [ ] mục con không có nhãn",
            ]
        )
        self.assertEqual(mod.open_blocking(text), [])

    def test_main_spec_khong_ton_tai(self):
        self.assertEqual(mod.main(["khong-ton-tai-xyz"]), 1)
        self.assertEqual(mod.main([]), 2)

    def test_approved_specs_chi_lay_spec_approved(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "SPEC-a.md").write_text("| Trạng thái | Approved — chốt |\n", encoding="utf-8")
            (root / "SPEC-b.md").write_text("| Trạng thái | Draft — chờ duyệt |\n", encoding="utf-8")
            (root / "SPEC-c.md").write_text("| Trạng thái | Approved |\n- [ ] Q — [chặn]\n", encoding="utf-8")
            self.assertEqual(mod.approved_specs(root), ["a", "c"])

    def test_repo_moi_spec_approved_khong_con_cau_chan(self):
        self.assertTrue(len(mod.approved_specs()) >= 5)
        self.assertEqual(mod.main(["--approved"]), 0)


if __name__ == "__main__":
    unittest.main()
