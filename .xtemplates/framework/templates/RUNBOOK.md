---
title: Mẫu RUNBOOK
kind: template
updated: 2026-10-13
---

# Mẫu RUNBOOK.md

> **Ai viết:** người xây, trước khi bàn giao; người trực cập nhật mỗi khi một cảnh báo nổ (SRE Workbook ch. 8). **Giai đoạn:** G5 (bản đầu: deploy/rollback), hoàn chỉnh ở G7–G8.
> **Cổng dùng:** G8 (cảnh báo đã thử kích hoạt, backup đã thử khôi phục), `PM-HANDOVER-003` (người không xây chạy được), `OPS-*` ở [`../15-operations/README.md`](../15-operations/README.md).
> **Luật:** mọi bước là lệnh chép-chạy được, không mô tả chung; không secret (chỉ ghi *nơi* lấy); mỗi cảnh báo có một playbook; bước nào chạy y hệt mỗi lần → tự động hoá thay vì ghi.

````markdown
# RUNBOOK — <Tên dịch vụ> · cập nhật <YYYY-MM-DD> · chủ: <tên>

## 0. Thông tin nhanh
| Mục | Giá trị |
|---|---|
| Môi trường | dev: <url> · staging: <url> · production: <url> |
| Repo / nhánh phát hành | <url> · `main` |
| Hạ tầng | <cloud/vùng/dự án> · IaC: `infra/` |
| Dashboard / log / trace | <url> · <url> · <url> |
| Kho secret | <tên kho, đường dẫn> — KHÔNG ghi giá trị ở đây |
| Trang trạng thái / kênh người dùng | <url> |

## 1. Lệnh vận hành (chép-chạy)
### Kiểm tra sức khoẻ
```bash
curl -fsS https://<domain>/healthz && echo OK
```
### Deploy
```bash
<lệnh deploy, vd: gh workflow run deploy.yml -f env=production -f ref=v1.4.0>
```
### Rollback (≤ 5 phút, đã diễn tập ngày <YYYY-MM-DD>)
```bash
<lệnh rollback về bản trước, vd: <cli> rollback --to <phiên bản trước>>
```
### Migration CSDL (xem docs ở .xtemplates/framework/09-database/migrations.md)
```bash
<lệnh áp migration> · <lệnh lùi migration>
```
### Khôi phục backup (diễn tập gần nhất: <ngày>, thời gian khôi phục đo được: <phút>)
```bash
<lệnh liệt kê backup> · <lệnh khôi phục vào môi trường tách biệt rồi kiểm>
```
### Xoay secret
```bash
<lệnh/thủ tục xoay từng loại: DB, API bên thứ ba, khoá ký>
```
### Bật/tắt cờ tính năng
```bash
<lệnh>
```

## 2. Cảnh báo → playbook
| Cảnh báo (tên đúng như trong hệ thống) | Mức | Nghĩa là gì | Bước xử lý | Nếu không hết |
|---|---|---|---|---|
| `<ten_canh_bao_p95_cao>` | SEV2 | p95 > <ngưỡng> trong <n> phút | 1) xem dashboard <url> 2) kiểm deploy gần nhất `<lệnh>` 3) rollback nếu trùng thời điểm | leo thang mục 4 |
| `<ten_canh_bao_loi_5xx>` | SEV1 | tỷ lệ 5xx > <ngưỡng> | ... | |
| `<backup_that_bai>` | SEV2 | job backup đêm qua lỗi | chạy lại `<lệnh>`; kiểm dung lượng | |

## 3. Việc định kỳ
| Việc | Nhịp | Lệnh/nơi | Chủ |
|---|---|---|---|
| Diễn tập khôi phục backup | quý | mục 1 | |
| Cập nhật phụ thuộc / vá bảo mật | tuần | Dependabot PR | |
| Xoay secret | <nhịp> | mục 1 | |
| Gia hạn domain/chứng chỉ/license | xem docs/handover/renewals.md | | |

## 4. Liên hệ & leo thang
| Vai trò | Tên | Kênh | Giờ | Thay thế |
|---|---|---|---|---|
| Trực chính | | | | |
| Trực phụ | | | | |
| Quyết định rollback/ngừng dịch vụ | | | | |
| Bên thứ ba (hỗ trợ nhà cung cấp) | | <cổng hỗ trợ, SLA> | | |

## 5. Mức hỗ trợ
| SEV | Định nghĩa | Phản hồi | Khắc phục/giảm thiệt hại | Thông báo người dùng |
|---|---|---|---|---|
| 1 | sập / mất hoặc lộ dữ liệu / mất tiền | ≤ <phút> | ngay, mọi lúc | ≤ <phút> qua trang trạng thái |
| 2 | luồng chính lỗi/chậm nặng | ≤ <giờ> | trong giờ làm | khi > <n> người ảnh hưởng |
| 3 | lỗi ngoài luồng chính, có cách lách | ≤ <ngày> | lên lịch | không |
Quy trình sự cố: `.xtemplates/framework/15-operations/incident-response.md`; mẫu post-mortem: `docs/ops/POST-MORTEM-<ngày>.md`.

## 6. Lịch sử thay đổi runbook
| Ngày | Gì | Vì sao (cảnh báo/sự cố nào) |
|---|---|---|
````
