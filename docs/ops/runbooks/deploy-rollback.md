---
title: Runbook — deploy và rollback
kind: runbook
updated: 2026-10-16
last_drilled: chưa diễn tập (chưa có VPS)
owner: (chưa gán — Tech Lead)
---

# Deploy và rollback

> **Trạng thái:** `deploy/compose.yaml` hiện chỉ có `postgres` (+ pgBackRest), `seaweedfs`, `caddy`. Dockerfile cho `web`/`worker` đã có ở `deploy/` nhưng **chưa build thật** và compose chưa có service tương ứng (Caddy đã trỏ sẵn `web:3000`; danh tính CSDL/S3 riêng từng service: [`deploy/README.md`](../../../deploy/README.md)); mua VPS/tên miền/SMTP là điểm dừng của chủ dự án. Các bước ứng dụng ghi theo thiết kế, đánh dấu "(chờ Dockerfile)". Deploy production là thao tác cần người duyệt (AGENTS §6).
> Không chạy lệnh nào dưới đây lên dữ liệu thật trước khi có người duyệt.

## Khi nào dùng
Phát hành bản mới lên VPS; hoặc quay lại bản trước khi bản mới gây sự cố ([INCIDENT-RESPONSE](../INCIDENT-RESPONSE.md) §3.3).

## Điều kiện trước
- PR đã merge vào `main` với CI xanh (`quality`, `e2e`, `backup-restore`, `gitleaks`, `dep-audit`).
- Biết **phiên bản đang chạy** (tag/digest image) để rollback; ghi vào dòng thời gian.
- Môi trường: `deploy/.env` (`HM_DOMAIN`, `HM_ACME_EMAIL`, `HM_FILES_DOMAIN`), `deploy/secrets/` đủ tệp (xem [secret-leak](secret-leak.md)); biến ứng dụng khớp `.env.example` (schema env kiểm lúc khởi động — thiếu biến thì tiến trình dừng và nêu tên).
- Có thay đổi CSDL ⇒ làm mục "Backup trước migrate".

## Các bước

### 1. Kiểm trước deploy
```bash
curl -fsS https://<domain>/api/ready        # đang ready trước khi đổi gì
docker compose -f deploy/compose.yaml ps
```

### 2. Backup trước migrate (bắt buộc khi có migration mới)
```bash
docker compose -f deploy/compose.yaml exec -u postgres postgres pgbackrest --stanza=hm check
docker compose -f deploy/compose.yaml exec -u postgres postgres pgbackrest --stanza=hm --type=incr backup
docker compose -f deploy/compose.yaml exec -u postgres postgres pgbackrest --stanza=hm info   # ghi nhãn bản vừa tạo
docker compose -f deploy/compose.yaml exec -u postgres postgres psql -U postgres -d <db> -c "select pg_create_restore_point('truoc_migrate_<phiên_bản>')"
```
Không tiếp tục nếu `check`/`backup` lỗi. Điểm khôi phục `truoc_migrate_<phiên_bản>` là đường lùi chắc chắn (xem [restore](restore.md) mục B).

### 3. Áp migration
Hiện **chưa có lệnh `migrate` riêng** (test/E2E gọi `migrateToLatest`). Cho tới khi có script chính thức, chạy từ máy có mã nguồn và `DATABASE_URL` của role chủ schema (không phải `app_runtime`), sau khi role đã tạo bằng `packages/db/sql/bootstrap-roles.sql`:
```bash
cd packages/db && DATABASE_URL=<url role chủ schema> node --input-type=module -e '
import pg from "pg"; import { Kysely, PostgresDialect } from "kysely";
import { migrateToLatest } from "./src/index.ts";
const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) }) });
try { await migrateToLatest(db); } finally { await db.destroy(); }'
```
**Giả định về role chủ schema:** role chạy migration (và vì thế sở hữu bảng + mọi hàm `SECURITY DEFINER`) phải là **superuser hoặc có `BYPASSRLS`**. Nhiều bảng bật `FORCE ROW LEVEL SECURITY` (áp cả cho owner) và chỉ có policy theo ngữ cảnh tổ chức/người dùng; hàm definer chạy bằng quyền owner nên nếu owner bị RLS thì: `app.purge_organization` không xoá được hàng theo tổ chức và `INSERT org_deletion_certificates` (chỉ có policy SELECT) bị chặn (0070), `app.dsar_erase_account`/`app.dsar_export_data` không đọc/ghi được `memberships`, `dsar_requests`… (0069), các hàm `app.purge_*` của job dọn (0056/0066) không thấy hàng. Kiểm trước khi áp: `select rolsuper, rolbypassrls from pg_roles where rolname = current_user;` phải có ít nhất một cột `true` (test/E2E chạy bằng superuser của cluster tạm nên không lộ lỗi này). Không cấp `BYPASSRLS` cho `app_runtime`/`app_worker`.

(Đã thử trên cluster tạm: áp 46 migration, không lỗi.) **Khoá bảng (RK-021):** migration có `CREATE INDEX`/`ALTER TABLE` khoá bảng đích (0048 xây ~58 index). Chạy **ngoài giờ cao điểm**, sau khi kiểm không còn giao dịch dài (`select pid, now()-xact_start, state, left(query,60) from pg_stat_activity where xact_start is not null order by 2 desc`). Migration phải tự đặt `lock_timeout` (0048: 5 s, cục bộ trong transaction của migrator, trả lại giá trị cũ sau khi xong); nếu báo `canceling statement due to lock timeout` thì transaction đã hoàn tác sạch — chờ giao dịch dài kết thúc rồi chạy lại, không tăng timeout. Bảng lớn (hàng trăm nghìn dòng trở lên): tạo index bằng `CREATE INDEX CONCURRENTLY` ngoài migrator rồi mới đánh dấu migration.
Quy tắc: migration mới là file mới, **không sửa migration đã áp**; thay đổi phá vỡ dùng expand → contract qua hai lần phát hành. Migration có `DROP COLUMN`/`RENAME COLUMN`/`ALTER COLUMN … TYPE`/`DROP TABLE`/`ALTER TABLE … RENAME TO` hoặc `.dropColumn()`/`.renameColumn()`/`.dropTable()`/`.renameTo()` của Kysely (từ 0047, phần `up`) phải mang dấu `-- expand-contract: contract sau expand ở release vX.Y.Z — <lý do>` (gạch `-`/`–`/`—`; rào `arch-guards.test.ts`; release phải là bản đã có mục `## [X.Y.Z]` trong `CHANGELOG.md`); CI job `schema-compat` chạy test CSDL của nhánh nền (N−1) trên schema của PR (N), kèm file nền ratchet của PR (`scripts/schema-compat.mjs`) — chạy trên mỗi PR (khôi phục ở pha harden, D-091).

### 4. Triển khai ứng dụng (chờ Dockerfile)
```bash
git fetch && git checkout <tag hoặc SHA đã merge>
docker compose -f deploy/compose.yaml pull          # image hạ tầng ghim digest
docker compose -f deploy/compose.yaml up -d postgres seaweedfs caddy
# (chờ Dockerfile) build/pull web, worker rồi: docker compose -f deploy/compose.yaml up -d web worker
```
Ứng dụng tương thích ngược với schema cũ một phiên bản (expand-contract) để bước 3 và 4 không cần dừng dịch vụ.

### 5. Kiểm sau deploy
```bash
curl -fsS https://<domain>/api/health                # 200 {"status":"ok"}
curl -fsS https://<domain>/api/ready                 # 200, database/storage/scanner = ok
curl -fsS -H "Authorization: Bearer $(node scripts/metrics-token.mjs)" https://<domain>/api/metrics | head
```
Theo dõi 30 phút: `hm_worker_heartbeat_age_seconds` < 120, `hm_outbox_oldest_unpublished_age_seconds` < 300, tỷ lệ 5xx trong log Caddy; chạy luồng smoke bằng tài khoản kiểm thử.

## Rollback
Quyết định rollback: IC (INCIDENT-RESPONSE §2). Giảm thiệt hại trước, tìm nguyên nhân sau.

### Chỉ đổi ứng dụng (migration không đổi hoặc đã tương thích ngược)
```bash
git checkout <tag/SHA bản trước>
# (chờ Dockerfile) docker compose -f deploy/compose.yaml up -d web worker
curl -fsS https://<domain>/api/ready
```

### Có migration mới cần lùi
1. **Ưu tiên** ứng dụng bản trước + giữ schema mới (expand-contract nên bản cũ vẫn chạy). Dùng cách này nếu migration chỉ thêm.
2. Lùi từng migration bằng `down` (chỉ khi migration mới **chưa có dữ liệu thật phụ thuộc**; `down` bị chặn hoặc mất dữ liệu ở cột/bảng mới — đọc file migration trước, có người duyệt):
   ```bash
   cd packages/db && DATABASE_URL=<url role chủ schema> node --input-type=module -e '
   import pg from "pg"; import { Kysely, PostgresDialect } from "kysely";
   import { createMigrator } from "./src/index.ts";
   const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) }) });
   let code = 0;
   try {
     const res = await createMigrator(db).migrateDown();
     console.log(JSON.stringify(res.results ?? []));
     if (res.error) { console.error("migrateDown LỖI:", String(res.error)); code = 1; }
   } finally { await db.destroy(); }
   process.exit(code);'
   ```
   **Lùi code trước, migration sau:** với `0063_email_budget`, chạy `down` khi bản mới còn chạy ⇒ vòng gửi email dừng (không có hàm xin ngân sách) và `/api/metrics` trả 500 (thiếu `app.email_budget_metrics`). Triển khai lại bản trước rồi mới lùi migration; `down` xoá bảng bộ đếm `email_budget_days` (chỉ mất bộ đếm ngày, không mất thư).
   Mỗi lần chạy lùi **một** migration (đã thử trên cluster tạm: lùi `0046_observability`). Kysely không ném lỗi khi `down` hỏng mà trả `res.error`: lệnh trên in lỗi ra stderr và thoát mã 1 (mã 0 = lùi xong, hoặc không còn gì để lùi: `[]`); mã ≠ 0 thì dừng, đọc lỗi, không chạy lại khi chưa hiểu. Không dùng `migrateDownAll` ngoài test.
3. Không đủ ⇒ khôi phục PITR về điểm `truoc_migrate_<phiên_bản>` ([restore](restore.md) mục B) — mất dữ liệu ghi sau điểm đó; cần người duyệt.

## Xác minh
`/api/ready` 200; chỉ số mục 5 bình thường; phiên bản đang chạy khớp bản mong muốn (ghi trong dòng thời gian); không còn cảnh báo `page` từ `deploy/prometheus/alerts.yml`.

## Liên hệ và leo thang
Người duyệt deploy production và người quyết rollback: (chưa gán). Danh sách: [INCIDENT-RESPONSE §8](../INCIDENT-RESPONSE.md).
