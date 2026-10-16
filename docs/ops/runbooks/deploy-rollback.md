---
title: Runbook — deploy và rollback
kind: runbook
updated: 2026-10-16
last_drilled: chưa diễn tập (chưa có VPS)
owner: (chưa gán — Tech Lead)
---

# Deploy và rollback

> **Trạng thái:** `deploy/compose.yaml` hiện chỉ có `postgres` (+ pgBackRest), `seaweedfs`, `caddy`. Dockerfile cho `web`/`worker` **chưa có** (Caddy đã trỏ sẵn `web:3000`); mua VPS/tên miền/SMTP là điểm dừng của chủ dự án. Các bước ứng dụng ghi theo thiết kế, đánh dấu "(chờ Dockerfile)". Deploy production là thao tác cần người duyệt (AGENTS §6).
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
docker compose -f deploy/compose.yaml exec postgres pgbackrest --stanza=hm check
docker compose -f deploy/compose.yaml exec postgres pgbackrest --stanza=hm --type=incr backup
docker compose -f deploy/compose.yaml exec postgres pgbackrest --stanza=hm info   # ghi nhãn bản vừa tạo
docker compose -f deploy/compose.yaml exec postgres psql -U postgres -d <db> -c "select pg_create_restore_point('truoc_migrate_<phiên_bản>')"
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
(Đã thử trên cluster tạm: áp 46 migration, không lỗi.) Quy tắc: migration mới là file mới, **không sửa migration đã áp**; thay đổi phá vỡ dùng expand → contract qua hai lần phát hành.

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
   Mỗi lần chạy lùi **một** migration (đã thử trên cluster tạm: lùi `0046_observability`). Kysely không ném lỗi khi `down` hỏng mà trả `res.error`: lệnh trên in lỗi ra stderr và thoát mã 1 (mã 0 = lùi xong, hoặc không còn gì để lùi: `[]`); mã ≠ 0 thì dừng, đọc lỗi, không chạy lại khi chưa hiểu. Không dùng `migrateDownAll` ngoài test.
3. Không đủ ⇒ khôi phục PITR về điểm `truoc_migrate_<phiên_bản>` ([restore](restore.md) mục B) — mất dữ liệu ghi sau điểm đó; cần người duyệt.

## Xác minh
`/api/ready` 200; chỉ số mục 5 bình thường; phiên bản đang chạy khớp bản mong muốn (ghi trong dòng thời gian); không còn cảnh báo `page` từ `deploy/prometheus/alerts.yml`.

## Liên hệ và leo thang
Người duyệt deploy production và người quyết rollback: (chưa gán). Danh sách: [INCIDENT-RESPONSE §8](../INCIDENT-RESPONSE.md).
