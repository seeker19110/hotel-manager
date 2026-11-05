---
title: Mẫu chính sách xử lý lỗ hổng
kind: template
updated: 2026-11-02
---

# Mẫu docs/ops/VULN-SLA.md

> **Ai viết:** người phụ trách bảo mật/vận hành; chủ dự án duyệt hạn. **Giai đoạn:** G5 (trước bản phát hành đầu), rà
> mỗi năm. **Cổng dùng:** `OPS-MAINT-004` ([`../15-operations/maintenance-and-lifecycle.md`](../15-operations/maintenance-and-lifecycle.md)),
> `SEC-SUPPLY-030` ([`../12-security/supply-chain.md`](../12-security/supply-chain.md)).
> **Luật:** hạn tính từ lúc công cụ quét báo, không từ lúc người đọc; lỗ hổng đang bị khai thác thật (danh mục KEV) vào
> nhóm hạn ngắn nhất bất kể điểm; quá hạn thì ghi ngoại lệ có chủ + ngày hết hạn, không im lặng. Số trong mẫu là ví dụ —
> đội tự chốt.

````markdown
# Chính sách xử lý lỗ hổng — <Tên dự án> · cập nhật <YYYY-MM-DD> · chủ: <tên>

## 1. Nguồn quét
| Lớp | Công cụ | Lịch | Nơi xem kết quả |
|---|---|---|---|
| Phụ thuộc | <pip-audit / npm audit / osv-scanner> | <mỗi PR + hằng tuần> | <CI job> |
| Image | <trivy/grype> | <mỗi build + hằng tuần> | <…> |
| Host/cloud | <…> | <…> | <…> |

## 2. Hạn xử lý theo mức
| Mức | Điều kiện | Hạn vá hoặc giảm thiểu | Ai được duyệt ngoại lệ |
|---|---|---|---|
| Khẩn | có trong danh mục KEV hoặc khai thác thật đã biết | <48 giờ> | <…> |
| Critical | CVSS ≥ 9,0 | <7 ngày> | <…> |
| High | CVSS 7,0–8,9 | <30 ngày> | <…> |
| Medium | CVSS 4,0–6,9 | <90 ngày> | <…> |
| Low | còn lại | <đợt bảo trì kế> | <…> |

## 3. Ngoại lệ đang mở
| Lỗ hổng | Thành phần | Lý do chưa vá | Biện pháp tạm | Chủ | Hết hạn ngoại lệ |
|---|---|---|---|---|---|
| <CVE-…> | <…> | <chưa có bản vá upstream> | <tắt tính năng X> | <tên> | <YYYY-MM-DD> |
````
