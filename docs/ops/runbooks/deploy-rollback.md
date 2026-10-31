---
title: Runbook — deploy và rollback
kind: runbook
updated: 2026-11-01
last_drilled: chưa diễn tập (chưa có VPS)
owner: (chưa gán — Tech Lead)
---

# Deploy và rollback

> **Trạng thái:** `deploy/compose.yaml` có `postgres` (+ pgBackRest), `seaweedfs`, `caddy`, `web` và `worker`; Dockerfile ứng dụng và danh tính CSDL/S3 riêng từng service ở [`deploy/README.md`](../../../deploy/README.md). Sự tồn tại của cấu hình không chứng minh đã dựng/chạy image hoặc triển khai thật; chỉ ghi kết quả khi có bằng chứng tương ứng. VPS/tên miền/SMTP và quyền production vẫn theo AGENTS §6.
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
Nạp `MIGRATION_DATABASE_URL` từ kho bí mật vào tiến trình rồi dùng CLI chính thức ở gốc repo; production đặt `NODE_ENV=production`. Không ghi URL vào lệnh hay dùng URL runtime/worker. Điều kiện role, TLS và cách xử lý lỗi ở [runbook migration](database-migrations.md):
```bash
pnpm --filter @hm/db migrate status
pnpm --filter @hm/db migrate up
pnpm --filter @hm/db migrate status
```
**Role chủ schema:** cần **superuser hoặc `BYPASSRLS`**, ownership hữu hiệu, quyền CREATE và (với owner không superuser) SET ROLE `app_worker` để 0047 tạo `pgboss` đúng owner. Nhiều bảng có `FORCE ROW LEVEL SECURITY`; owner của hàm `SECURITY DEFINER` thiếu BYPASSRLS sẽ không xử lý được dữ liệu xuyên ngữ cảnh của DSAR/purge/retention. CLI kiểm trước DDL và không tự cấp quyền. Không cấp `BYPASSRLS` cho `app_runtime`/`app_worker`.

**Khoá bảng (RK-021):** migration có `CREATE INDEX`/`ALTER TABLE` khoá bảng đích (0048 xây ~58 index). Chạy **ngoài giờ cao điểm**, sau khi kiểm không còn giao dịch dài (`select pid, now()-xact_start, state, left(query,60) from pg_stat_activity where xact_start is not null order by 2 desc`). Migration phải tự đặt `lock_timeout` (0048: 5 s, cục bộ trong transaction của migrator, trả lại giá trị cũ sau khi xong); nếu báo `canceling statement due to lock timeout` thì transaction đã hoàn tác sạch — chờ giao dịch dài kết thúc rồi chạy lại, không tăng timeout. Bảng lớn (hàng trăm nghìn dòng trở lên): tạo index bằng `CREATE INDEX CONCURRENTLY` ngoài migrator rồi mới đánh dấu migration.
Quy tắc: migration mới là file mới, **không sửa migration đã áp**; thay đổi phá vỡ dùng expand → contract qua hai lần phát hành. Migration có `DROP COLUMN`/`RENAME COLUMN`/`ALTER COLUMN … TYPE`/`DROP TABLE`/`ALTER TABLE … RENAME TO` hoặc `.dropColumn()`/`.renameColumn()`/`.dropTable()`/`.renameTo()` của Kysely (từ 0047, phần `up`) phải mang dấu `-- expand-contract: contract sau expand ở release vX.Y.Z — <lý do>` (gạch `-`/`–`/`—`; rào `arch-guards.test.ts`; release phải là bản đã có mục `## [X.Y.Z]` trong `CHANGELOG.md`); CI job `schema-compat` chạy test CSDL của nhánh nền (N−1) trên schema của PR (N), kèm file nền ratchet của PR (`scripts/schema-compat.mjs`) — chạy trên mỗi PR (khôi phục ở pha harden, D-091).

### 4. Triển khai ứng dụng bằng digest đã kiểm
Hạ tầng postgres/seaweedfs/caddy phải được thiết lập riêng trước. Dựng và đẩy image một lần; lấy digest và manifest đã qua staging, không dựng lại ở production. Dùng công cụ [promote và rollback](operations-tools.md):
```bash
node scripts/ops/run.mjs promote <manifest.json> deploy/compose.yaml <state-dir> https://<domain>
```
Lệnh chỉ thay web/worker, chờ ready rồi kiểm version/header. State-dir nằm ngoài checkout. Lỗi tự áp lại bản tốt trước nếu có nhưng vẫn trả exit khác 0; chưa có bản tốt thì phải phục hồi thủ công. Ứng dụng dùng expand-contract; kiểm N−1 trong CI trước khi đổi schema.

### 5. Kiểm sau deploy
```bash
node scripts/ops/run.mjs smoke https://<domain> <version>
curl -fsS -H "Authorization: Bearer $(node scripts/metrics-token.mjs)" https://<domain>/api/metrics | head
```
Theo dõi 30 phút: `hm_worker_heartbeat_age_seconds` < 120, `hm_outbox_oldest_unpublished_age_seconds` < 300, tỷ lệ 5xx trong log Caddy; chạy luồng smoke bằng tài khoản kiểm thử.

## Rollback
Quyết định rollback: IC (INCIDENT-RESPONSE §2). Giảm thiệt hại trước, tìm nguyên nhân sau.

### Chỉ đổi ứng dụng (migration không đổi hoặc đã tương thích ngược)
```bash
node scripts/ops/run.mjs rollback deploy/compose.yaml <state-dir> https://<domain>
```
Lệnh lấy manifest trước trong lịch sử, áp đúng digest rồi smoke; không down CSDL. Nếu tiến trình chết giữa lúc deploy, đối chiếu `last-attempt.json` và container thực tế; `releases.json` chỉ ghi lần thành công gần nhất.

### Có migration mới cần lùi
1. **Ưu tiên** ứng dụng bản trước + giữ schema mới (expand-contract nên bản cũ vẫn chạy). Dùng cách này nếu migration chỉ thêm.
2. Chỉ down khi đã đánh giá dữ liệu phụ thuộc, backup và toàn bộ khoảng migration cần gỡ. Chọn rõ **bản sẽ giữ lại**, có người duyệt theo quyền môi trường. Ví dụ schema 0078 muốn giữ 0077:
   ```bash
   pnpm --filter @hm/db migrate down --to 0077_persons_bootstrap_scope --confirm-down
   pnpm --filter @hm/db migrate status
   ```
   **Lùi code trước, migration sau:** với `0063_email_budget`, chạy `down` khi bản mới còn chạy ⇒ vòng gửi email dừng (không có hàm xin ngân sách) và `/api/metrics` trả 500 (thiếu `app.email_budget_metrics`). Triển khai lại bản trước rồi mới lùi migration; `down` xoá bảng bộ đếm `email_budget_days` (chỉ mất bộ đếm ngày, không mất thư).
   CLI yêu cầu đích đã áp đứng trước bản hiện tại và cờ xác nhận; đích cách nhiều bản sẽ gỡ nhiều migration. Lỗi trả JSON an toàn + exit 1, không in URL/thông điệp DB thô; dừng và đối chiếu [runbook migration](database-migrations.md). Down 0074 bị chặn khi còn claim purge, 0076 bị chặn khi đã có audit DSAR: giữ schema và rollback ứng dụng, không xoá claim/audit để vượt guard. Không dùng `migrateDownAll` ngoài test.
3. Không đủ ⇒ khôi phục PITR về điểm `truoc_migrate_<phiên_bản>` ([restore](restore.md) mục B) — mất dữ liệu ghi sau điểm đó; cần người duyệt.

## Xác minh
`/api/ready` 200; chỉ số mục 5 bình thường; phiên bản đang chạy khớp bản mong muốn (ghi trong dòng thời gian); không còn cảnh báo `page` từ `deploy/prometheus/alerts.yml`.

## Liên hệ và leo thang
Người duyệt deploy production và người quyết rollback: (chưa gán). Danh sách: [INCIDENT-RESPONSE §8](../INCIDENT-RESPONSE.md).
