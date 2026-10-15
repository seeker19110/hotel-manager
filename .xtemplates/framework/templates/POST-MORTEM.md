---
title: Mẫu POST-MORTEM
kind: template
updated: 2026-10-13
---

# Mẫu POST-MORTEM.md

> **Ai viết:** người điều phối sự cố (incident lead) trong vòng vài ngày sau khi đóng sự cố; đội review; lưu `docs/ops/POST-MORTEM-<YYYY-MM-DD>-<slug>.md`.
> **Giai đoạn:** G8 Operate. **Khi nào bắt buộc:** SEV1/SEV2, mọi mất/lộ dữ liệu, phải rollback, giám sát không bắt được lỗi (người dùng báo trước) — xem [`../15-operations/incident-response.md`](../15-operations/incident-response.md).
> **Luật không đổ lỗi:** mô tả hệ thống và quyết định với thông tin có lúc đó, không tên người làm "sai"; mục tiêu là hàng rào mới (P12). Mỗi hành động có **chủ + hạn + issue**; post-mortem chưa review coi như chưa tồn tại (SRE Book ch. 15).

```markdown
# POST-MORTEM — <tiêu đề ngắn> · <YYYY-MM-DD>

| Trường | Giá trị |
|---|---|
| Mức | SEV<1/2/3> |
| Thời lượng | từ <hh:mm UTC> đến <hh:mm UTC> (tổng <phút>) · phát hiện sau <phút> · giảm thiệt hại sau <phút> |
| Điều phối | <tên> · Người viết: <tên> · Review: <tên> ngày <...> |
| Trạng thái | Nháp / Đã review / Đã đóng (mọi hành động xong) |
| Liên kết | issue sự cố #<n> · cảnh báo <tên> · RK-<NNN> (nếu rủi ro đã biết) |

## 1. Tóm tắt (3 câu)
<Chuyện gì xảy ra, ảnh hưởng ai, đã khôi phục bằng cách nào.>

## 2. Ảnh hưởng
- Người dùng: <số/tỷ lệ> · Chức năng: <...> · Dữ liệu/tiền: <có/không — chi tiết> · Nghĩa vụ thông báo (luật/hợp đồng): <có/không — đã gửi ngày>

## 3. Dòng thời gian (UTC, từ nguồn máy: log, CI, chat có dấu thời gian)
| Thời điểm | Sự kiện | Nguồn |
|---|---|---|
| <hh:mm> | nguyên nhân được đưa vào (deploy <SHA> / thay đổi cấu hình / bên thứ ba) | |
| <hh:mm> | triệu chứng đầu tiên | |
| <hh:mm> | phát hiện (cảnh báo / người dùng báo) | |
| <hh:mm> | bắt đầu giảm thiệt hại (rollback / tắt cờ / khôi phục) | |
| <hh:mm> | dịch vụ khôi phục | |
| <hh:mm> | đóng sự cố | |

## 4. Nguyên nhân gốc — 5 Whys
1. Vì sao người dùng bị ảnh hưởng? <...>
2. Vì sao điều đó xảy ra? <...>
3. Vì sao hàng rào (test/CI/review) không chặn? <...>
4. Vì sao giám sát không phát hiện sớm hơn? <...>
5. Vì sao hệ thống cho phép trạng thái này tồn tại? <...>
Yếu tố góp phần khác: <...>

## 5. Cái gì tốt / chưa tốt / may mắn
- Tốt: <...>
- Chưa tốt: <...>
- May mắn (suýt tệ hơn): <...>

## 6. Hành động (mỗi dòng một issue có chủ + hạn)
| Hành động | Loại (vá / phòng ngừa / phát hiện / quy trình) | Chủ | Hạn | Issue | Trạng thái |
|---|---|---|---|---|---|
| <...> | phòng ngừa | <tên> | <ngày> | #<n> | mở |

## 7. Hàng rào mới (bắt buộc ≥ 1)
- <test hồi quy `tests/...` / rule lint / hook / cảnh báo mới / mục checklist> — PR #<n>
- Cập nhật runbook: mục <...> · Cập nhật sổ rủi ro: RK-<NNN>

## 8. Bài học cho khung/đội
<1–3 gạch đầu dòng: điều gì nên vào CLAUDE.md/AGENTS.md, TRAPS, hoặc PR vào khung X-Templates.>
```
