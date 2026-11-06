# RPO / RTO — Hotel Manager · cập nhật 2026-11-06 · chủ: người vận hành · người duyệt: chủ sản phẩm (**chưa chốt**)

> **Trạng thái: ĐỀ XUẤT.** Số lấy từ `PROJECT.md` §5 và `docs/ops/SLO.md` (SLO-PITR). Chủ sản phẩm chưa chốt và chưa có lần
> thử khôi phục trên hạ tầng thật, nên các con số **chưa chứng minh** và không được công bố ra ngoài (`DB-BACKUP-001`,
> `OPS-DR-001`). Khi chốt: ghi tên người duyệt và ngày ở dòng đầu; sau mỗi lần diễn tập: điền ngày, thời gian đo, bằng chứng.

## 1. Kho dữ liệu
| Kho | Dữ liệu | RPO (mất tối đa) | RTO (khôi phục trong) | Cách đạt | Thử khôi phục gần nhất | Thời gian đo | Bằng chứng |
|---|---|---|---|---|---|---|---|
| PostgreSQL 17 (production) | tổ chức, phòng, hợp đồng, kỳ thu, cọc, sổ cái, lưu trú, audit, hàng đợi pg-boss, outbox | ≤ 15 phút | ≤ 4 giờ | pgBackRest: full + WAL archive liên tục, PITR vào volume mới ([restore](runbooks/restore.md) §B) | chưa có trên production; cluster tạm (dữ liệu giả) chạy được | — | `bash scripts/db-backup-restore-check.sh` (exit 0: đúng số dòng, Σ Nợ = Σ Có, RLS còn nguyên) |
| SeaweedFS (bucket `S3_BUCKET`) | file người dùng (giấy tờ, ảnh, file xuất) | ≤ 24 giờ | ≤ 4 giờ (sau CSDL) | đồng bộ hằng ngày ra kho ngoài máy bằng `rclone` (ADR-0002, [restore](runbooks/restore.md) §C) — job đồng bộ **chưa có** | chưa | — | — |
| Log ứng dụng (OTel Collector → file JSONL) | log vận hành đã che PII (`deploy/otel/collector.yaml`) | không áp dụng — chấp nhận mất khi máy hỏng tới khi có kho log ngoài máy | không áp dụng | xoay vòng 14 ngày trên máy; kho log lâu dài là quyết định triển khai | — | — | — |
| Prometheus | số đo dẫn xuất | không áp dụng — dựng lại từ đầu | ≤ 1 giờ (chạy lại container) | cấu hình trong `deploy/prometheus/` | — | — | — |

## 2. Dịch vụ hướng người dùng
| Dịch vụ | RPO | RTO | Phụ thuộc (kho ở §1) | Kịch bản DR (máy/nhà cung cấp hỏng) | Diễn tập gần nhất |
|---|---|---|---|---|---|
| Web (Next.js) + worker | theo PostgreSQL / SeaweedFS | ≤ 4 giờ | PostgreSQL, SeaweedFS | dựng máy mới → CSDL → kho file → web/worker theo digest đã phát hành ([restore](runbooks/restore.md) §D, [deploy-rollback](runbooks/deploy-rollback.md)) | chưa |

## 3. Chênh lệch và việc còn nợ
- Chủ sản phẩm chốt hoặc sửa các con số §1–§2 (đang `loop defer` ở `DB-BACKUP-001`).
- Chưa có VPS và kho ngoài máy: chưa diễn tập PITR production, chưa có job `rclone` đồng bộ file (`OPS-DR-*`, `DB-BACKUP-002…004`).
- Sau diễn tập đầu: đo RTO thật; vượt mục tiêu thì mở task kèm hạn.
