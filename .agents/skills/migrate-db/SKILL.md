---
name: migrate-db
description: Thay đổi schema/dữ liệu cơ sở dữ liệu an toàn khi đang phục vụ — expand/contract thay cho sửa tại chỗ, DDL có lock_timeout, index CONCURRENTLY, ràng buộc NOT VALID rồi VALIDATE, backfill theo lô lũy đẳng, đường lùi đã thử, backup trước khi chạm dữ liệu thật. Dùng khi thêm/đổi/xoá bảng, cột, index, ràng buộc, đổi kiểu, chuyển dữ liệu, viết migration, khi người dùng nói "đổi schema", "migration", "đổi tên cột", hoặc gõ /migrate-db.
argument-hint: "<thay đổi schema/dữ liệu cần làm>"
---

# /migrate-db — không khoá bảng, không mất dữ liệu, luôn lùi được

`<FW>` = `.xtemplates/framework` ở dự án đích, `framework` ở repo khung. Luật: `<FW>/09-database/` — `DB-MIG-001…012`,
backup `DB-BACKUP-008`. Migration đã áp lên môi trường chung **không sửa** (`DB-MIG-003`); đổi migration đã áp = sửa cổng (`LOOP-STOP-003`).

## 1. Thiết kế (trước khi viết file)
1. Ghi thay đổi đích và **mọi chỗ đọc/ghi** cột/bảng đó (`grep` code, job, báo cáo, view).
2. Chia **expand/contract** (`DB-MIG-008`): (a) thêm cấu trúc mới, tương thích code cũ → (b) code ghi cả hai/đọc mới → (c) backfill →
   (d) chuyển đọc hoàn toàn → (e) xoá cũ ở bản phát hành **sau**. Mỗi bước một migration, mỗi bước deploy được độc lập.
3. Ước lượng kích thước bảng; bảng lớn → mọi bước phải không khoá lâu.

## 2. Viết migration
4. File có phiên bản, áp bằng công cụ của dự án (`DB-MIG-001`), lũy đẳng (`DB-MIG-004`: `IF NOT EXISTS`, kiểm trước khi chèn).
5. DDL trên bảng đang phục vụ: `SET lock_timeout` ngắn + `statement_timeout` (`DB-MIG-005`); index `CREATE INDEX CONCURRENTLY` ngoài
   transaction (`DB-MIG-006`); FK/CHECK `NOT VALID` rồi `VALIDATE CONSTRAINT` bước sau (`DB-MIG-007`).
6. Backfill theo lô có giới hạn + nghỉ, lũy đẳng, tiếp tục được khi đứt (`DB-MIG-010`); không gom vào migration DDL.
7. Ghi **đường lùi** (`DB-MIG-009`): migration down đã chạy thử, hoặc nhãn lùi bằng bước tiến kèm lý do.
8. Migration chạy tách khỏi khởi động app (`DB-MIG-012`).

## 3. Kiểm
9. Chạy toàn bộ migration trên CSDL sạch, rồi lên lần hai (lũy đẳng), rồi down → up (`DB-MIG-002`). Test của code ở cả trạng thái
   trước và sau từng bước expand/contract.
10. Có dữ liệu mẫu cỡ thật: đo thời gian và khoá (`pg_locks`/`EXPLAIN`) trên bản sao; vượt ngưỡng → chia nhỏ hơn.
11. Trước khi chạm dữ liệu production: backup/snapshot mới hoặc PITR đã kiểm (`DB-MIG-011`, `DB-BACKUP-008`). Áp lên dữ liệu
    người dùng thật là điểm dừng (§Điểm dừng bắt buộc về hành động, `LOOP-STOP-021`): `xt.py loop defer` kèm kế hoạch, không tự chạy.

## Báo cáo
Các bước expand/contract và PR tương ứng · lệnh kiểm + exit code (up, up lần 2, down→up) · thời gian/khoá đo được · đường lùi · việc chờ người.
