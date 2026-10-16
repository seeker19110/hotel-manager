---
title: Runbook — khôi phục (PostgreSQL PITR + kho file)
kind: runbook
updated: 2026-10-16
last_drilled: "chưa diễn tập trên VPS; script diễn tập dữ liệu giả chạy ở CI (job backup-restore)"
owner: (chưa gán — Tech Lead)
---

# Khôi phục dữ liệu

> Mục tiêu đề xuất (`PROJECT.md` §5, chỉ công bố sau diễn tập): RPO CSDL ≤ 15 phút, RTO ≤ 4 giờ, RPO file ≤ 24 giờ. Chưa có VPS/kho sao lưu thật nên các lệnh dạng compose và rclone dưới đây **chưa diễn tập**; phần pgBackRest PITR đã chạy được trên cluster tạm bằng `bash scripts/db-backup-restore-check.sh` (dữ liệu giả; exit 0 = khôi phục đúng số dòng, Σ Nợ = Σ Có, RLS còn nguyên).
> Khôi phục lên dữ liệu đang chạy là **thao tác không đảo ngược** ⇒ người duyệt trước (AGENTS §6). Mặc định: khôi phục vào cluster **mới**, kiểm, rồi mới chuyển ứng dụng sang.

## Khi nào dùng
Mất/hỏng dữ liệu (xoá nhầm, migration sai, ghi nhầm hàng loạt, ransomware, đĩa hỏng) hoặc diễn tập định kỳ (mỗi quý, do người **không phải** tác giả runbook thực hiện — ghi tên vào `last_drilled`).

## Điều kiện trước
- Có bản sao lưu: `docker compose -f deploy/compose.yaml exec postgres pgbackrest --stanza=hm info` liệt kê full/diff và dải WAL; lưu nhãn sao lưu và điểm thời gian đích (giờ UTC) vào dòng thời gian.
- Có `deploy/secrets/pgbackrest.conf` (mẫu `deploy/pgbackrest.conf.example`: `repo1-type=s3`, `repo1-cipher-type=aes-256-cbc`, `repo1-cipher-pass`) và **khoá repo** `PGBACKREST_REPO_CIPHER_PASS` từ kho bí mật ngoài máy chủ. Mất khoá = mất bản sao lưu.
- Snapshot ngay trước thao tác theo [INCIDENT-RESPONSE §4](../INCIDENT-RESPONSE.md): nếu cluster hiện tại còn chạy, tạo điểm `select pg_create_restore_point('truoc_khoi_phuc_<mã>')`.
- Thứ tự phụ thuộc: **CSDL → kho file → ứng dụng (web, worker) → kiểm tra**. Không bật ứng dụng khi CSDL chưa kiểm xong.

## Các bước

### A. Cluster tạm để diễn tập (đã chạy được)
```bash
bash scripts/dev-env-setup.sh          # một lần: PostgreSQL 17 + pgBackRest 2.59.3+
bash scripts/db-backup-restore-check.sh   # exit 0 = PITR đúng; xoá cluster tạm khi xong
```
Script: initdb → full backup mã hoá aes-256-cbc → ghi thêm (chỉ có trong WAL) → `pg_create_restore_point` → ghi "nhầm" → `pgbackrest verify` → dừng → restore PITR → so ảnh chụp.

### B. Khôi phục CSDL về một thời điểm (PITR)
Dùng cùng lệnh với script, thay đường dẫn theo cấu hình thật. Trong container `postgres` của `deploy/compose.yaml` (stanza `hm`, cấu hình ở `/etc/pgbackrest/pgbackrest.conf`):
1. Dừng ứng dụng (web, worker) để không ghi thêm; `docker compose -f deploy/compose.yaml stop postgres`.
2. Khôi phục **vào volume mới** (khuyến nghị) hoặc dùng `--delta` để ghi đè vùng dữ liệu hiện tại (không đảo ngược):
   ```bash
   # theo thời điểm (UTC+7 ghi rõ múi giờ)
   pgbackrest --stanza=hm --delta --type=time "--target=2026-10-16 09:30:00+07" --target-action=promote restore
   # hoặc theo điểm khôi phục có tên (đúng như script diễn tập)
   pgbackrest --stanza=hm --delta --type=name --target=truoc_khoi_phuc_<mã> --target-action=promote restore
   ```
   Chạy bằng người dùng sở hữu thư mục dữ liệu (`postgres`; script dùng `runuser -u postgres --` khi chạy bằng root).
3. Khởi động Postgres; chờ thoát recovery: `select pg_is_in_recovery()` → `f` (script chờ ≤ 120 giây).
4. Đặt lại mật khẩu role ứng dụng nếu cluster mới: `packages/db/sql/bootstrap-roles.sql` (tạo `app_runtime`, `app_worker`, giới hạn thời gian) rồi `ALTER ROLE … PASSWORD …` từ kho bí mật.

### C. Khôi phục kho file (bucket SeaweedFS)
Bucket riêng tư `hm-files` (tên ví dụ ở `deploy/s3.json.example`; thực tế = biến `S3_BUCKET`). Theo ADR-0002, file được đồng bộ mỗi ngày ra kho ngoài máy bằng `rclone` (RPO ≤ 24 giờ) — **job đồng bộ chưa có trong repo; chưa diễn tập**:
```bash
# mẫu: remote "backup" = kho ngoài máy, "hm" = SeaweedFS S3 (rclone config từ kho bí mật)
rclone lsd backup:                                  # xác nhận kho sao lưu truy cập được
rclone copy backup:hm-files-backup hm:hm-files --checksum --dry-run   # xem trước
rclone copy backup:hm-files-backup hm:hm-files --checksum              # chỉ chép, không xoá bên đích
```
Sau khôi phục CSDL, đối chiếu: hàng `files` ở trạng thái `ready` mà thiếu object sẽ lỗi khi người dùng mở ảnh; liệt kê bằng cách so khoá object trong bucket với `files.storage_key` (job hạn giữ chỉ xoá object rồi mới đánh dấu `deleted`, nên object thừa an toàn hơn object thiếu).

### D. Dựng lại hạ tầng và ứng dụng
1. VPS mới: cài Docker, kéo repo, tạo `deploy/secrets/` (`postgres_password`, `pgbackrest.conf`, `s3.json`) từ kho bí mật, `deploy/.env` (`HM_DOMAIN`, `HM_ACME_EMAIL`, `HM_FILES_DOMAIN`).
2. `docker compose -f deploy/compose.yaml up -d postgres seaweedfs caddy` (image ghim digest). Làm B rồi C.
3. Triển khai web + worker theo [deploy-rollback](deploy-rollback.md) (Dockerfile ứng dụng chưa có — chờ).
4. Xoay bí mật nếu máy cũ bị xâm nhập: [secret-leak](secret-leak.md).

## Xác minh
Chạy truy vấn sau trên cluster đã khôi phục (cùng kiểm tra với `scripts/db-backup-restore-check.sh`, đọc bằng `psql` hoặc `node packages/testkit/src/backup-fixture.ts summary <url>`):
```sql
select (select count(*) from journal_entries) as journal_entries,
       (select coalesce(sum(debit),0)  from journal_lines) as sum_debit,
       (select coalesce(sum(credit),0) from journal_lines) as sum_credit,
       (select count(*) from pg_policies where schemaname = 'public') as rls_policies;
```
- `sum_debit = sum_credit`; `rls_policies > 0`; số dòng khớp ảnh chụp trước sự cố (nếu có) hoặc hợp lý với thời điểm đích.
- `curl -fsS https://<domain>/api/ready` → `{"status":"ready"}` với `database`, `storage`, `scanner` đều `ok`.
- Mở một hợp đồng/kỳ thu mẫu (bằng tài khoản kiểm thử) và một ảnh đã tải: xem được.
- Ghi RTO đo được (phút) và ngày diễn tập vào `last_drilled`; so với mục tiêu RTO.

## Hoàn tác / đường lùi
Trước `--delta`, giữ bản sao nguyên volume cũ (`docker volume` snapshot hoặc đổi tên) cho tới khi xác minh xong; không xoá cluster cũ trước khi người duyệt. Sai điểm thời gian: khôi phục lại từ cùng bản sao lưu với `--target` khác (bản sao lưu không bị sửa bởi restore).

## Liên hệ và leo thang
IC/Tech Lead và chủ dự án (duyệt khôi phục đè): (chưa gán). Nhà cung cấp kho sao lưu: (chưa chọn). Danh sách: [INCIDENT-RESPONSE §8](../INCIDENT-RESPONSE.md).
