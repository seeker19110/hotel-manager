# SCOPE — đóng băng phạm vi và nhật ký thay đổi

> PM-PRIO-004. Phạm vi MVP đóng băng ở cổng G1 (2026-10-15, chủ dự án duyệt — `PROJECT.md` §3). Mọi thay đổi sau đó đi qua file này: ghi **ngày, người quyết, mục bị đẩy ra để bù**, và là một commit sửa `PROJECT.md` có tiêu đề `docs(scope): …` nêu mục bị đổi. Thay đổi chỉ ở SPEC/PLAN mà không đổi bảng §3 thì ghi ở đây một dòng và trỏ D-NNN.

## Điều kiện xét một thay đổi phạm vi
1. Nêu mục (F-NNN hoặc mục Won't) được thêm/bỏ/đổi mức Must–Should–Could và lý do (bằng chứng nhu cầu, ràng buộc pháp lý, rủi ro).
2. Nêu mục bị đẩy ra để bù (hoặc ngày/ngân sách đổi theo); Must không tăng khi chưa bù: nỗ lực P0 đã ở 65% (`PROJECT.md` §3, vượt ngưỡng ≤ 60% khung khuyến nghị).
3. Không cắt test tiền/tồn để bù (kế hoạch §19). Nếu trễ, thứ tự cắt: F-007, F-008, F-011 xuống tối thiểu.
4. Người quyết: chủ dự án; điểm chuyên môn do phiên chính tự duyệt theo AGENTS §5 và ghi `D-NNN` (`docs/autopilot/DECISIONS.md`). Chủ dự án đổi ý lúc nào cũng được.
5. Cập nhật `PROJECT.md` §3, SPEC liên quan và `docs/RISKS.md` (nếu đổi rủi ro) trong cùng PR.

## Nhật ký
| Ngày | Người quyết | Thay đổi | Mục bị đẩy ra / bù | Nguồn |
|---|---|---|---|---|
| 2026-10-15 | chủ dự án | Cổng G1: đóng băng phạm vi F-001…F-016 (Must/Should/Could) và danh sách Won't | — | `PROJECT.md` §3 |
| 2026-10-15 | chủ dự án | Chọn theo backlog: gia hạn/thanh lý đầy đủ, phân bổ thanh toán, khoá kỳ và portal mở rộng là **Must pilot tuần 12** (kế hoạch gốc §04/§19 để ở V1) | chấp nhận rủi ro trễ cao hơn; nếu trễ cắt F-007, F-008, F-011 xuống tối thiểu trước | `PROJECT.md` §3 "Lệch kế hoạch gốc" |
| 2026-10-15 | chủ dự án | Tự host toàn bộ thay Supabase (ngân sách hạ tầng cần ước lại theo báo giá VPS, chưa có) | không đổi danh sách tính năng | ADR-0002, `PROJECT.md` §8 |
| 2026-10-15 | chủ dự án | Duyệt PLAN đợt 2: câu hỏi chặn của F-003/F-004/F-005/F-010 chốt bằng tham số hoá theo cơ sở/tổ chức | không đổi phạm vi; đổi giá trị không cần migration | `docs/autopilot/archive/PLAN-dot-2.md` |
| 2026-10-16 | phiên chính (D-002, D-009) | Đợt 3 hoàn tất F-006, F-007, F-008, F-011, F-012; câu hỏi chặn của đợt 3 chốt bằng tham số hoá | không đổi bảng §3 | `docs/autopilot/DECISIONS.md` |
| 2026-10-16 | phiên chính (D-023, D-028) | Đợt 4 và 5 chỉ làm các mục MUST của blueprint làm được trong repo; mục cần CI/hook/pháp lý/hạ tầng/người → `loop defer` | mục SHOULD (1.284) và các mục MUST cần người nằm ngoài đợt (RK-008); không đổi bảng §3 | `docs/autopilot/BLUEPRINT-GAPS.md`, `docs/RISKS.md` |

F-013 … F-016 (Should/Could) chưa có SPEC ("viết ở đợt V1"); vào phạm vi khi có dòng mới ở nhật ký trên.
