---
title: Vòng đời dự án và các cổng
kind: method
updated: 2026-10-15
---

# Vòng đời dự án và các cổng

> Mọi dự án đi qua **9 giai đoạn**, mỗi giai đoạn kết thúc bằng **một cổng** có đầu ra kiểm được. Dự án nhỏ
> đi nhanh qua cổng nhưng không bỏ cổng. Dự án có sẵn (brownfield) bắt đầu ở G0 với "đọc repo" thay cho "ý tưởng".

## Bảng giai đoạn

| GĐ | Tên | Câu hỏi trả lời | Đầu ra bắt buộc | Cổng (máy/người kiểm) |
|---|---|---|---|---|
| G0 | **Khung (Frame)** | Vấn đề gì, cho ai, đo thành công thế nào? | `PROJECT.md` mục Vấn đề + Người dùng + Chỉ số thành công | Có ≥1 chỉ số đo được; phạm vi "không làm" ghi rõ |
| G1 | **Phân loại (Classify)** | Phần mềm loại gì, ngành gì, quy mô nào? | Hồ sơ + gói ngành + quy mô S/M/L; `BLUEPRINT.md` sinh bằng `xt.py compose` | `xt.py compose` chạy được; blueprint commit vào repo |
| G2 | **Nghiên cứu (Research)** | Công nghệ/phiên bản nào, ràng buộc pháp lý gì? | ADR chọn stack; bảng phiên bản kèm ngày xác minh; danh sách luật áp dụng | Mỗi phiên bản có nguồn + ngày; luật ngành có số hiệu |
| G3 | **Đặc tả (Specify)** | Xây chính xác cái gì? | Spec tính năng (luồng, dữ liệu, API, ca biên, tiêu chí chấp nhận dạng Given/When/Then) | Mỗi tính năng MVP có tiêu chí chấp nhận kiểm được |
| G4 | **Thiết kế (Design)** | Kiến trúc, dữ liệu, giao diện, mối đe doạ? | Sơ đồ C4 mức 1–2; schema; hợp đồng API; threat model; wireframe/tokens | Threat model có biện pháp cho mỗi mối đe doạ mức cao |
| G5 | **Dựng nền (Scaffold)** | Hàng rào chất lượng đã chạy chưa? | Repo + CI (lint/type/test/scan) + môi trường + secrets + observability tối thiểu | CI xanh trên commit rỗng tính năng; cổng commit chặn được lỗi |
| G6 | **Xây (Build)** | Tính năng đã chạy đúng chưa? | Code + test theo từng lát dọc (vertical slice); mỗi lát một PR | PR qua cổng merge; blueprint tick theo bằng chứng |
| G7 | **Kiểm & phát hành (Verify & Release)** | Đủ tốt để người thật dùng chưa? | Báo cáo GO/NO-GO; E2E luồng chính; bảo mật; hiệu năng; a11y; tài liệu; kế hoạch rollback | `xt.py blueprint-status --strict` = 0 MUST mở; 0 mục BLOCKER |
| G8 | **Vận hành & tiến hoá (Operate)** | Có chạy ổn và tốt dần lên không? | SLO + cảnh báo; runbook; quy trình sự cố; post-mortem; lịch bảo trì phụ thuộc | Cảnh báo đã thử kích hoạt; backup đã thử khôi phục |

## Quy tắc chung của cổng

1. **Cổng chỉ có đạt/không đạt.** "Gần đạt" là không đạt.
2. **Đầu ra là file trong repo**, không phải đoạn chat. Phiên sau đọc được.
3. **Cổng máy trước**: cái gì kiểm bằng lệnh thì phải có lệnh; người chỉ duyệt phần còn lại.
4. **Quay lui được**: phát hiện sai ở GĐ sau → quay về GĐ gây ra, sửa đầu ra gốc, không vá ở hạ nguồn.
5. **Dự án có sẵn**: G0 = đọc repo (stack thật, cấu trúc, CI, test, nợ kỹ thuật) → G1 sinh blueprint → audit theo [`audit.md`](audit.md)
   blueprint với hiện trạng (mục nào đã đạt có bằng chứng thì tick) → các GĐ sau chỉ làm phần còn thiếu, tăng dần,
   **không áp đặt stack mới**.

## Quy mô S/M/L — làm nhẹ đi chứ không bỏ

| Quy mô | Ví dụ | Khác biệt |
|---|---|---|
| **S** | Prototype, công cụ nội bộ, MVP chưa có người dùng thật | G2–G4 gộp thành một tài liệu ngắn; chỉ **sàn** bắt buộc: MUST của baseline + hồ sơ + gói ngành; MUST của module chuyên sâu và mọi `MUST@M`/`MUST@L` thành SHOULD (ADR-0003) |
| **M** | Production có người dùng thật, đội nhỏ | Đủ 9 GĐ; mọi `MUST` và `MUST@M` bắt buộc — tối đa 4 mỗi module (ADR-0004) |
| **L** | Quy mô lớn, nhiều đội, dữ liệu nhạy cảm, ngành bị quản lý | Thêm `MUST@L`; review bảo mật độc lập; diễn tập DR; tuân thủ có kiểm toán |

## Ánh xạ sang chế độ tự động

Khi chạy **autopilot** (xem [`../11-autonomous-loop/README.md`](../11-autonomous-loop/README.md)): G0–G4 diễn ra trong
pha *lập kế hoạch* và kết thúc bằng **một cổng duyệt duy nhất** — phiên chính tự duyệt `PLAN.md` theo tiêu chí chất
lượng cuối và ghi `D-NNN` (ADR-0008). Sau đó G5–G7 chạy tự động trong vòng lặp có bằng chứng; điểm quyết định chuyên
môn tự duyệt và ghi lại, chỉ dừng ở các **điểm dừng bắt buộc về hành động** (thao tác không thể hoàn tác, tiền thật, dữ
liệu người dùng thật, đối ngoại/production, nới cổng) — xem [`../11-autonomous-loop/stop-points-and-escalation.md`](../11-autonomous-loop/stop-points-and-escalation.md).

## Nguồn

- Khung cũ X-stored `01-process-and-standards.md` (9 giai đoạn + cổng), commit `1b80fe4`.
- `seeker19110/projects-template` `docs/framework/standard-delivery.md` (9 cổng Frame→Reconcile), đọc 2026-10-13.
- C4 model: <https://c4model.com/> (xác minh 2026-10-13).
