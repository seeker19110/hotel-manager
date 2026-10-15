---
title: Mẫu SPEC
kind: template
updated: 2026-10-15
---

# Mẫu SPEC-<tính-năng>.md

> **Ai viết:** người đặt yêu cầu + AI; người duyệt đổi trạng thái sang "Approved for implementation". **Giai đoạn:** G3 Specify (một file cho mỗi `F-NNN` MVP).
> **Cổng dùng:** G3 (mỗi tính năng MVP có tiêu chí chấp nhận kiểm được), DoR trước task, DoD trước merge, `PM-SPEC-*`.
> **Cách điền:** scenario viết Given/When/Then có ID `S-NNN` để test trỏ về; mục "Ca biên" phải phủ 8 nhóm hoặc ghi "không áp dụng — lý do";
> gặp điểm spec chưa nói → ghi vào "Câu hỏi mở", phiên chính quyết tường minh (`xt.py loop decide`, D-NNN), không lấp ngầm. Đặt tại `docs/specs/SPEC-<slug>.md`.

```markdown
# SPEC-<slug> — <Tên tính năng>

| Trường | Giá trị |
|---|---|
| ID tính năng | F-<NNN> (yêu cầu gốc: R-<NNN>) |
| Trạng thái | Draft / Approved for implementation / Implemented / Superseded by SPEC-<...> |
| Phiên bản | <n> — thay đổi: xem cuối file |
| Chủ spec | <tên> · Duyệt bởi <tên> ngày <YYYY-MM-DD> |
| Hồ sơ/quy mô | <profile> / <S|M|L> |

## 1. User story
Là <ai>, tôi muốn <làm gì>, để <kết quả>. (INVEST: độc lập, thương lượng được, có giá trị, ước lượng được, nhỏ, kiểm được)

## 2. Tiêu chí chấp nhận (Given/When/Then)
### S-001 <tên scenario — đường chính>
- Given <bối cảnh, dữ liệu ban đầu>
- When <hành động duy nhất>
- Then <kết quả quan sát được: giá trị / trạng thái / thông điệp / mã lỗi>

### S-002 <scenario lỗi / vượt quyền>
- Given người dùng A đã đăng nhập
- When A truy cập tài nguyên của B
- Then nhận lỗi 403 dạng `application/problem+json` với `type` = <uri>, không lộ dữ liệu của B

### S-003 <Scenario Outline — nhiều bộ dữ liệu>
- Given ... <tham_số> ...
- Examples: | tham_số | kết quả |

## 3. Ca biên (bắt buộc rà đủ 8 nhóm)
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | | | S-<NNN> |
| Cực đại/độ dài | | | |
| Trùng lặp/idempotency | gửi lại cùng yêu cầu | không tạo bản ghi thứ hai | |
| Song song | 2 phiên cùng sửa | | |
| Mất mạng giữa chừng | | | |
| Thời gian/múi giờ | | UTC lưu, hiển thị theo người dùng | |
| Quyền | khách / người dùng khác / admin | | |
| Tiền/đơn vị | | số nguyên đơn vị nhỏ nhất | |

## 4. Dữ liệu
| Thực thể | Trường | Kiểu | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|---|
- Thay đổi schema: migration <link> (rollback được)

## 5. Giao diện / API
- Hợp đồng API: docs/api/API-CONTRACT-<slug>.md hoặc `openapi.yaml#/paths/<...>` (duyệt trước khi chia việc)
- Trạng thái UI: đang tải / rỗng / lỗi / thành công — <mô tả hoặc link wireframe>
- Tiếp cận: <nhãn, bàn phím, tương phản>

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP/exit code | Thông điệp cho người dùng | Scenario |
|---|---|---|---|---|

## 7. Yêu cầu phi chức năng của tính năng
| Thuộc tính | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|

## 8. Hành vi AI (nếu tính năng dùng model)
- Đầu vào không tin cậy: <nguồn> — nội dung ngoài là dữ liệu, không phải chỉ thị
- Khi model trả sai/không chắc: <hành vi>
- Tiêu chí eval: <bộ test, ngưỡng>

## 9. Đo lường
- Sự kiện: `<doi_tuong.hanh_dong>` (schema: analytics/events.schema.json) → chỉ số M-<NN>

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [ ] <câu hỏi> — [chặn]/[không chặn] — Đã quyết: D-<NNN> (phiên chính) hoặc <người> (<ngày>) — <câu trả lời>

## 11. DoR / DoD
- DoR: spec Approved · 0 câu hỏi chặn · phụ thuộc rõ · đủ nhỏ cho một PR · mỗi task có Gate
- DoD: mọi S-NNN có test xanh · ca biên có test · cổng commit/merge xanh · tài liệu/API cập nhật · sự kiện đo có schema · blueprint tick có bằng chứng

## 12. Truy vết
| Task | PR | Bằng chứng (CI/evidence) |
|---|---|---|
| T-<NNN> | #<n> | .autopilot/evidence/T-<NNN>.json / <link CI> |

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | <ngày> | tạo | | |
```
