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
- Có bản sao lưu: `docker compose -f deploy/compose.yaml exec -u postgres postgres pgbackrest --stanza=hm info` liệt kê full/diff và dải WAL; lưu nhãn sao lưu và điểm thời gian đích (giờ UTC) vào dòng thời gian.
- Có `deploy/secrets/pgbackrest.conf` (mẫu `deploy/pgbackrest.conf.example`: `repo1-type=s3`, `repo1-cipher-type=aes-256-cbc`, `repo1-cipher-pass`) và **khoá repo** `PGBACKREST_REPO_CIPHER_PASS` từ kho bí mật ngoài máy chủ. Mất khoá = mất bản sao lưu.
- Snapshot ngay trước thao tác theo [INCIDENT-RESPONSE §4](../INCIDENT-RESPONSE.md): nếu cluster hiện tại còn chạy, tạo điểm `select pg_create_restore_point('truoc_khoi_phuc_<mã>')`. Điểm này nằm SAU sự cố nên chỉ dùng để quay về trạng thái ngay trước lúc khôi phục, **không** làm đích cứu dữ liệu (xem B).
- Đích khôi phục: thời điểm trước sự cố (giờ UTC) hoặc điểm `truoc_migrate_<phiên_bản>` có trước sự cố; ghi vào dòng thời gian.
- Thứ tự phụ thuộc: **CSDL → kho file → ứng dụng (web, worker) → kiểm tra**. Không bật ứng dụng khi CSDL chưa kiểm xong.

## Các bước

### A. Cluster tạm để diễn tập (đã chạy được)
```bash
bash scripts/dev-env-setup.sh          # một lần: PostgreSQL 17 + pgBackRest 2.59.3+
bash scripts/db-backup-restore-check.sh   # exit 0 = PITR đúng; xoá cluster tạm khi xong
```
Script: initdb → full backup mã hoá aes-256-cbc → ghi thêm (chỉ có trong WAL) → `pg_create_restore_point` → ghi "nhầm" → `pgbackrest verify` → dừng → restore PITR → so ảnh chụp.

### B. Khôi phục CSDL về một thời điểm (PITR) — vào volume MỚI
Cùng tham số pgBackRest với script diễn tập; chạy bằng `docker compose run` (container tạm, không cần `postgres` đang chạy) chứ không `exec` vào container đã dừng. Stanza `hm`, cấu hình `/etc/pgbackrest/pgbackrest.conf` (gắn từ `deploy/secrets/pgbackrest.conf`), `pg1-path=/var/lib/postgresql/data`. Mọi lệnh compose cần `deploy/.env` đủ biến (`HM_DOMAIN`, `HM_ACME_EMAIL`, `HM_FILES_DOMAIN`, vì compose nội suy cả service caddy). Lớp phủ `deploy/compose.restore.yaml` trỏ volume `pgdata` sang volume mới (đã kiểm `docker compose config`; chưa chạy thật vì chưa có VPS).

**Chọn đích khôi phục — phải là thời điểm TRƯỚC sự cố:**
- `--type=time --target="<UTC hoặc có múi giờ>"`: ngay trước lúc hỏng (ví dụ `2026-10-16 09:30:00+07`), lấy từ dòng thời gian sự cố/audit; hoặc
- `--type=name --target=truoc_migrate_<phiên_bản>`: điểm khôi phục tạo trước migrate ([deploy-rollback](deploy-rollback.md) §2) — chỉ dùng khi sự cố xảy ra sau điểm đó.
- **Không** lấy `truoc_khoi_phuc_<mã>` làm đích: điểm này tạo ở "Điều kiện trước", tức SAU sự cố, khôi phục về đó chỉ cho lại đúng trạng thái đã hỏng. Nó chỉ để quay về trạng thái ngay trước thao tác khôi phục.
- Đích `name`/`xid` nằm trước bản sao lưu mới nhất ⇒ thêm `--set=<nhãn bản sao lưu cũ hơn điểm đó>` (nhãn lấy từ `pgbackrest info`); `--type=time` thì pgBackRest tự chọn bản phù hợp.

Các bước:
1. Dừng ứng dụng và CSDL cũ, **không xoá volume cũ** (đường lùi):
   ```bash
   # dừng web và worker theo cách đã triển khai (chưa nằm trong deploy/compose.yaml), rồi:
   docker compose -f deploy/compose.yaml stop postgres
   ```
   Không để hai cluster cùng đẩy WAL vào một stanza: sau khi khôi phục xong, cluster cũ không được khởi động lại.
2. Tạo volume mới và ghi tên vào `deploy/.env`:
   ```bash
   docker volume create hotel-manager_pgdata_restore
   echo 'HM_RESTORE_VOLUME=hotel-manager_pgdata_restore' >> deploy/.env
   ```
3. Khôi phục vào volume mới (`-u postgres` vì chỉ người dùng sở hữu thư mục dữ liệu được chạy; script diễn tập dùng `runuser -u postgres --` khi chạy bằng root). Volume mới rỗng nên **không** cần `--delta`:
   ```bash
   # theo thời điểm trước sự cố
   docker compose -f deploy/compose.yaml -f deploy/compose.restore.yaml run --rm --no-deps -u postgres postgres \
     pgbackrest --stanza=hm --type=time "--target=2026-10-16 09:30:00+07" --target-action=promote restore
   # hoặc theo điểm khôi phục có tên có TRƯỚC sự cố (thêm --set=<nhãn> nếu điểm cũ hơn bản sao lưu mới nhất)
   docker compose -f deploy/compose.yaml -f deploy/compose.restore.yaml run --rm --no-deps -u postgres postgres \
     pgbackrest --stanza=hm --type=name --target=truoc_migrate_<phiên_bản> --target-action=promote restore
   ```
4. Khởi động Postgres trên volume mới; chờ thoát recovery: `select pg_is_in_recovery()` → `f` (script chờ ≤ 120 giây):
   ```bash
   docker compose -f deploy/compose.yaml -f deploy/compose.restore.yaml up -d postgres
   docker compose -f deploy/compose.yaml -f deploy/compose.restore.yaml exec -u postgres postgres psql -U postgres -Atc "select pg_is_in_recovery()"
   ```
   Từ đây **luôn** truyền cả hai `-f` (quên tệp phủ ⇒ compose gắn lại volume cũ).
5. Đặt lại mật khẩu role ứng dụng nếu cluster mới: `packages/db/sql/bootstrap-roles.sql` (tạo `app_runtime`, `app_worker`, giới hạn thời gian) rồi `ALTER ROLE … PASSWORD …` từ kho bí mật. Production đang dùng login luân phiên (`app_runtime_a|_b`, `app_worker_a|_b`) thì chạy lại `packages/db/sql/rotate-login.sql` cho login đang dùng và đặt mật khẩu bằng `\password` (bước 1–2 của [`db-password-rotation.md`](db-password-rotation.md)). Rồi sang mục Xác minh trước khi bật ứng dụng.

#### Phương án cuối: ghi đè tại chỗ bằng `--delta` (KHÔNG đảo ngược — bắt buộc người duyệt)
Chỉ khi không thể dùng volume mới (đĩa/volume không đủ chỗ). `--delta` ghi đè thẳng thư mục dữ liệu hiện tại: file lệch với bản sao lưu bị sửa/xoá, dữ liệu ghi sau điểm đích mất vĩnh viễn (AGENTS §6). Người duyệt (chủ dự án/Tech Lead) ghi tên và giờ duyệt vào dòng thời gian **trước** khi chạy; sao nguyên volume cũ trước, và chỉ làm khi Postgres đã dừng:
```bash
docker compose -f deploy/compose.yaml run --rm --no-deps -u root -v hotel-manager_pgdata:/from:ro -v hm_pgdata_truoc_delta:/to \
  --entrypoint cp postgres -a /from/. /to/
docker compose -f deploy/compose.yaml run --rm --no-deps -u postgres postgres \
  pgbackrest --stanza=hm --delta --type=time "--target=2026-10-16 09:30:00+07" --target-action=promote restore
```
Đích vẫn phải là thời điểm trước sự cố (xem trên). Giữ `hm_pgdata_truoc_delta` tới khi xác minh xong và người duyệt đồng ý xoá.

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
2. `docker compose -f deploy/compose.yaml up -d seaweedfs caddy` (image ghim digest); CSDL dựng bằng B (volume mới, rồi `up -d postgres` như bước B.4). Làm B rồi C.
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
Mặc định (volume mới) volume cũ `hotel-manager_pgdata` còn nguyên: bỏ `HM_RESTORE_VOLUME` khỏi `deploy/.env` và bỏ `-f deploy/compose.restore.yaml` là về lại dữ liệu cũ; không xoá volume cũ trước khi người duyệt. Sai điểm thời gian: tạo volume mới khác và khôi phục lại từ cùng bản sao lưu với `--target` khác (bản sao lưu không bị sửa bởi restore). Với `--delta` chỉ còn bản sao `hm_pgdata_truoc_delta` làm đường lùi.

## Liên hệ và leo thang
IC/Tech Lead và chủ dự án (duyệt khôi phục đè): (chưa gán). Nhà cung cấp kho sao lưu: (chưa chọn). Danh sách: [INCIDENT-RESPONSE §8](../INCIDENT-RESPONSE.md).
