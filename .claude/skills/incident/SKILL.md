---
name: incident
description: Xử lý sự cố và phân tích nguyên nhân gốc — giảm thiệt hại trước (rollback, tắt feature flag), ghi dòng thời gian và mọi lệnh đã chạy, tìm nguyên nhân gốc bằng bằng chứng (log, metric, diff deploy), viết post-mortem không đổ lỗi với hành động khắc phục có chủ và hạn. Dùng khi production lỗi/chậm/sập, cảnh báo SLO, dữ liệu sai, người dùng báo sự cố, cần viết post-mortem/RCA, hoặc gõ /incident.
argument-hint: "<triệu chứng | cảnh báo | link sự cố>"
---

# /incident — cầm máu trước, hiểu sau, không đổ lỗi

`<FW>` = `.xtemplates/framework` ở dự án đích, `framework` ở repo khung. Luật: `<FW>/15-operations/incident-response.md`
(`OPS-IR-001…008`); mẫu `<FW>/templates/POST-MORTEM.md`, `RUNBOOK.md`. Chạm dữ liệu thật, tiền thật, khoá/dịch vụ trả phí là
điểm dừng (§Điểm dừng bắt buộc về hành động, `LOOP-STOP-021`): đề xuất lệnh, `xt.py loop defer`, không tự chạy.

## 1. Phân loại và mở bản ghi (≤ 5 phút)
1. Mức độ theo định nghĩa SEV của dự án (`OPS-IR-001`); phạm vi: ai bị ảnh hưởng, từ lúc nào, còn tiếp diễn không.
2. Mở bản ghi sự cố (`OPS-IR-002`): giờ phát hiện, triệu chứng, người điều phối. Mọi lệnh/thay đổi từ đây ghi kèm giờ (`OPS-IR-005`).

## 2. Giảm thiệt hại trước khi tìm nguyên nhân (`OPS-IR-004`)
3. Có deploy/đổi cấu hình gần thời điểm bắt đầu → **rollback** hoặc tắt feature flag theo `RUNBOOK.md` là phương án đầu.
4. Không rollback được: giảm tải, chặn đường lỗi, chuyển chế độ chỉ đọc. Thao tác lên dữ liệu thật cần snapshot ngay trước (`OPS-IR-006`).
5. Xác nhận đã cầm máu bằng **chính tín hiệu** đã báo động (metric/SLO/log), không bằng cảm giác.

## 3. Nguyên nhân gốc (sau khi ổn định)
6. Dòng thời gian từ dữ liệu: deploy, đổi cấu hình, đột biến metric, log lỗi đầu tiên, tác động bên ngoài.
7. Tái hiện ở môi trường không phải production rồi khoanh vùng theo `/debug` (lệnh đỏ → giả thuyết bác bỏ được → nguyên nhân).
8. Hỏi "vì sao lọt" cho từng lớp bảo vệ: test, review, cảnh báo, rollout. Nguyên nhân là **điều kiện hệ thống**, không phải một người.

## 4. Post-mortem và khắc phục
9. Viết theo `POST-MORTEM.md`, không đổ lỗi (`OPS-IR-007`): tác động, dòng thời gian, nguyên nhân, điều đã tốt, điều may mắn.
10. Hành động khắc phục có chủ + hạn (`OPS-IR-008`), ưu tiên **cổng máy**: test hồi quy, cảnh báo mới, guard, kiểm trong CI.
    Mỗi hành động thành task trong PLAN hoặc issue.
11. Bài học về công cụ/môi trường → `TRAPS.md`; runbook thiếu bước → sửa `RUNBOOK.md` trong cùng PR.

## Báo cáo
Mức độ · thời gian phát hiện → cầm máu → khôi phục · hành động giảm thiệt hại · nguyên nhân gốc + bằng chứng · danh sách khắc phục (chủ, hạn) · việc chờ người.
