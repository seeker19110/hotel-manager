---
title: Mẫu RPO-RTO
kind: template
updated: 2026-11-02
---

# Mẫu docs/ops/RPO-RTO.md

> **Ai viết:** chủ sản phẩm chốt con số, người xây ghi cách đạt và bằng chứng thử khôi phục. **Giai đoạn:** G4 (chốt),
> G8 (thử khôi phục thật). **Cổng dùng:** `DB-BACKUP-001` ([`../09-database/backup-and-recovery.md`](../09-database/backup-and-recovery.md)),
> `OPS-DR-001` ([`../15-operations/backup-and-disaster-recovery.md`](../15-operations/backup-and-disaster-recovery.md)).
> **Luật:** mỗi kho dữ liệu và mỗi dịch vụ hướng người dùng một dòng; RPO/RTO không có lần thử khôi phục ghi ngày +
> bằng chứng là con số chưa chứng minh.

````markdown
# RPO / RTO — <Tên hệ thống> · cập nhật <YYYY-MM-DD> · chủ: <tên> · người duyệt: <chủ sản phẩm>

## 1. Kho dữ liệu
| Kho | Dữ liệu | RPO (mất tối đa) | RTO (khôi phục trong) | Cách đạt | Thử khôi phục gần nhất | Thời gian đo | Bằng chứng |
|---|---|---|---|---|---|---|---|
| <PostgreSQL prod> | <đơn hàng, người dùng> | <5 phút> | <1 giờ> | <PITR + WAL archive> | <YYYY-MM-DD> | <42 phút> | <log/PR/ảnh chụp> |
| <Object storage> | <file người dùng> | <24 giờ> | <4 giờ> | <versioning + bản sao vùng khác> | <YYYY-MM-DD> | <…> | <…> |
| <Search/vector index> | dẫn xuất — dựng lại từ nguồn | không áp dụng | <…> | script dựng lại `<lệnh>` | <YYYY-MM-DD> | <…> | <…> |

## 2. Dịch vụ hướng người dùng
| Dịch vụ | RPO | RTO | Phụ thuộc (kho ở §1) | Kịch bản DR (vùng/nhà cung cấp hỏng) | Diễn tập gần nhất |
|---|---|---|---|---|---|
| <API chính> | <…> | <…> | <PostgreSQL prod> | <`RUNBOOK.md#dr`> | <YYYY-MM-DD> |

## 3. Chênh lệch và việc còn nợ
- <Kho X đo được RTO 3 giờ > mục tiêu 1 giờ → task T-NNN, hạn YYYY-MM-DD>.
````
