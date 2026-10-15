---
title: Migration có phiên bản, lũy đẳng, đường lùi, expand/contract
kind: module
prefix: DB-MIG
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, mobile-app, desktop-app, embedded-iot]
updated: 2026-10-14
---

# Migration có phiên bản, lũy đẳng, đường lùi, expand/contract

> Mọi thay đổi schema là **file có phiên bản trong repo**, chạy tự động, lũy đẳng, không khoá bảng production lâu,
> có đường lùi đã diễn tập, và theo nhịp **expand → migrate → contract** để code cũ và mới cùng chạy. Đây là "nhà"
> của migration; [`../15-operations/deployment-strategies.md`](../15-operations/deployment-strategies.md) chỉ nói cách
> phối hợp migration với rollout.

## Nguyên tắc

1. **Schema là code**: migration commit cùng PR thay đổi code, review như code, chạy trong CI trên CSDL sạch trước khi merge.
2. **Chỉ tiến, không sửa quá khứ.** Migration đã áp lên môi trường chung là bất biến; sửa sai bằng migration mới.
   Hook chặn sửa file migration đã áp (catalog 23 §4.3 `protect-config.sh`).
3. **Lũy đẳng và tự mô tả**: chạy lại không hỏng (`IF NOT EXISTS`, kiểm trạng thái), tên file nói rõ thay đổi.
4. **Không khoá lâu**: mọi DDL trên bảng đang phục vụ chạy với `lock_timeout` ngắn, index tạo `CONCURRENTLY`, ràng
   buộc thêm `NOT VALID` rồi `VALIDATE`, đổi kiểu cột bằng cột mới + backfill theo lô.
5. **Expand/contract**: thêm trước (cột/bảng mới, nullable, default), đổi code đọc/ghi cả hai, backfill, rồi mới xoá
   cũ ở bản phát hành sau. Code phiên bản N và N+1 phải chạy được trên cùng schema.
6. **Đường lùi là bằng chứng, không phải lời hứa.** Mỗi migration có cách lùi (migration bù trừ hoặc "không lùi — khôi
   phục từ backup/PITR") và đã thử ít nhất trên staging.
7. **Tách DDL và dữ liệu**: backfill/di chuyển dữ liệu lớn là job theo lô có thể dừng/tiếp, không nằm trong transaction DDL.

## Quyết định

| Stack | Công cụ mặc định (phiên bản · giấy phép, xác minh 2026-10-13) | Thay thế + điều kiện |
|---|---|---|
| Mọi stack, schema-as-code | **Atlas 1.3.0** (Community Apache-2.0; `migrate lint`, `schema plan`, drift detection **chỉ có ở bản thương mại**) | Dùng squawk/eugene để lint thay cho `migrate lint` |
| Java/Kotlin/JVM | **Flyway 13.10.0** (Community Apache-2.0; undo/dry-run/check là tính năng trả phí — xác minh trang edition trước khi dựa vào) | **Liquibase 5.0.4** (Apache-2.0; rollback script tự viết) khi cần XML/YAML changelog hoặc nhiều CSDL |
| Node/TypeScript | **Drizzle Kit 0.31.11** + drizzle-orm 0.45.4 (Apache-2.0) khi muốn SQL gần | **Prisma Migrate**: npm `latest` = 8.0.0-rc.22 (**rc**), bản ổn định `prev` 7.10.0 — ghim 7.10.0 cho production đến khi 8.0 GA; Prisma không tự sinh down migration |
| Python | **Alembic 1.20.0** (MIT, có `downgrade()`) | `django.db.migrations` khi dùng Django |
| Go | **golang-migrate 4.20.1** (MIT; cặp `.up.sql`/`.down.sql`) | Atlas, goose (chưa xác minh phiên bản) |
| Supabase | **Supabase CLI 2.120.0** (MIT; `migration new` / `db diff` / `db reset` / `db push`; **không có rollback** — `migration repair` chỉ sửa bảng theo dõi) | Atlas trên cùng Postgres |
| SQLite (mobile/desktop) | Migration theo `PRAGMA user_version` + script tuần tự trong app; thư viện của framework (Room/Core Data/sqlx) | — |
| MySQL 8.4 | Công cụ theo stack ở trên + `ALGORITHM=INSTANT/INPLACE, LOCK=NONE` khi được | `pt-online-schema-change`/`gh-ost` cho bảng rất lớn (phiên bản chưa xác minh) |
| Kiểm an toàn migration PostgreSQL | **squawk 2.68.0** (Apache-2.0/MIT) hoặc **eugene 0.8.3** (MIT, phân tích khoá) | Cả hai khi quy mô L |

Đường lùi (chọn một cho mỗi migration, ghi trong file):

| Loại thay đổi | Đường lùi |
|---|---|
| Thêm cột/bảng/index | Migration bù trừ xoá (chỉ khi code đã ngừng dùng) |
| Đổi tên/kiểu cột | Không "lùi" — làm theo expand/contract: cột mới song song, lùi = dừng dùng cột mới |
| Xoá cột/bảng (contract) | Chỉ chạy sau ≥ 1 bản phát hành không dùng; lùi = khôi phục từ backup/PITR (xem [`backup-and-recovery.md`](backup-and-recovery.md)) |
| Backfill dữ liệu | Job lũy đẳng, lùi = chạy job ngược hoặc giữ cột cũ đến khi contract |

## Checklist

- [ ] `DB-MIG-001` **MUST** Mọi thay đổi schema là file migration có phiên bản trong repo, áp bằng công cụ, không sửa tay trên môi trường chung. → Kiểm: bảng lịch sử migration (`schema_migrations`/`flyway_schema_history`/`alembic_version`…) khớp file trong repo; script drift (`atlas schema diff` / `supabase db diff` / `prisma migrate diff`) = rỗng trong CI. · Nguồn: P5 · catalog 23 §4.3 (Supabase migrations)
- [ ] `DB-MIG-002` **MUST@L** CI chạy toàn bộ migration trên CSDL sạch (và trên bản sao schema staging) trước khi merge; thất bại → đỏ. → Kiểm: job CI `migrate` với CSDL ephemeral (service container/testcontainers) exit 0. · Nguồn: [`../10-workflow/ci-cd-pipeline.md`](../10-workflow/ci-cd-pipeline.md)
- [ ] `DB-MIG-003` **MUST** Migration đã áp lên môi trường chung không được sửa; CI/hook chặn sửa file migration cũ. → Kiểm: checksum của công cụ (Flyway/Liquibase/Atlas) hoặc script so SHA file migration với nhánh chính; hook `deny` khi sửa `migrations/<đã áp>`. · Nguồn: catalog 23 §4.3 (`protect-config.sh`) · `research/2026-10-13-stored-catalog-extraction.md`
- [ ] `DB-MIG-004` **MUST@L** Migration lũy đẳng: chạy lần 2 trên CSDL đã áp không lỗi, không trùng dữ liệu. → Kiểm: job CI chạy migrate 2 lần liên tiếp exit 0; migration dữ liệu dùng `ON CONFLICT DO NOTHING`/kiểm tồn tại. · Nguồn: catalog 23 §4.1 (rule migration lũy đẳng)
- [ ] `DB-MIG-005` **MUST@L** Mọi DDL trên bảng đang phục vụ chạy với `SET lock_timeout` ngắn (và `statement_timeout`), tự động thử lại khi timeout, không chờ vô hạn. → Kiểm: migration runner hoặc đầu file có `SET lock_timeout = '<n>s'`; test chạy migration khi có transaction giữ khoá → thất bại nhanh rồi retry, không treo. · Nguồn: PostgreSQL 18 `lock_timeout`
- [ ] `DB-MIG-006` **MUST@L** Index trên bảng có dữ liệu tạo bằng `CREATE INDEX CONCURRENTLY` (ngoài transaction); sau thất bại phải xoá index INVALID. → Kiểm: squawk rule `require-concurrent-index-creation` / eugene; truy vấn `pg_index WHERE NOT indisvalid` = 0 sau migrate. · Nguồn: PostgreSQL 18 CREATE INDEX (CONCURRENTLY; invalid index)
- [ ] `DB-MIG-007` **MUST@L** Thêm ràng buộc (FK/CHECK) trên bảng lớn bằng `NOT VALID` rồi `VALIDATE CONSTRAINT` ở bước sau; `SET NOT NULL` qua CHECK `IS NOT NULL NOT VALID` → validate → set. → Kiểm: squawk rule `adding-foreign-key-constraint`/`adding-not-nullable-field`; review checklist. · Nguồn: PostgreSQL 18 ALTER TABLE (NOT VALID, scan skip khi có CHECK)
- [ ] `DB-MIG-008` **MUST** Không đổi kiểu/đổi tên cột đang dùng tại chỗ; dùng expand/contract: cột mới → code ghi cả hai → backfill theo lô → chuyển đọc → xoá cũ ở phát hành sau. → Kiểm: squawk rule `ban-drop-column`/`renaming-column`/`changing-column-type` chặn trong CI; PR contract trỏ PR expand đã phát hành. · Nguồn: PostgreSQL 18 ALTER TABLE (ALTER TYPE rewrite + double disk)
- [ ] `DB-MIG-009` **MUST@L** Mỗi migration ghi đường lùi: migration bù trừ (down) đã test trên staging, hoặc nhãn `-- rollback: restore-from-backup` kèm link runbook. → Kiểm: lint đầu file có `-- rollback:`; job CI chạy up → down → up cho migration có down. · Nguồn: P8 · khung cũ `quality-supplements.md` §2 (rollback Supabase = bù trừ hoặc restore)
- [ ] `DB-MIG-010` **MUST@L** Backfill dữ liệu lớn chạy theo lô có giới hạn (batch + sleep/throttle), lũy đẳng, có thể dừng/tiếp, không trong cùng transaction DDL. → Kiểm: script backfill có `batch_size`, điểm tiếp tục (`last_id`), test dừng giữa chừng rồi chạy lại = kết quả đúng. · Nguồn: PostgreSQL 18 §14.4 (bulk load) · P8
- [ ] `DB-MIG-011` **MUST@M** Trước migration chạm dữ liệu production: backup/snapshot mới (hoặc PITR đã kiểm) và kế hoạch lùi ghi trong PR. → Kiểm: PR template có mục "Backup trước migrate: <link>"; runbook deploy có bước kiểm backup. · Nguồn: [`backup-and-recovery.md`](backup-and-recovery.md) · khung cũ `01-process-and-standards.md` GĐ6
- [ ] `DB-MIG-012` **MUST@L** Migration chạy tách khỏi khởi động ứng dụng (job riêng trước rollout), code mới tương thích schema cũ và ngược lại trong cửa sổ rollout. → Kiểm: pipeline có bước `migrate` trước `deploy`; test tích hợp chạy code N+1 trên schema N (và N trên N+1 sau expand). · Nguồn: [`../15-operations/deployment-strategies.md`](../15-operations/deployment-strategies.md)
- [ ] `DB-MIG-013` **SHOULD** Lint migration tự động (squawk/eugene/Atlas lint) trong pre-commit và CI với bộ rule đã chọn ghi ở repo. → Kiểm: `.squawk.toml`/cấu hình commit; job CI chạy. · Nguồn: squawk docs
- [ ] `DB-MIG-014` **SHOULD** Tên file migration có timestamp + mô tả (`20261013120000_add_orders_tenant_id.sql`); CI chặn hai migration cùng số/trùng timestamp từ hai nhánh. → Kiểm: script kiểm trùng số (như `pre-push-gate.sh` xboss). · Nguồn: catalog 23 §4.3 (`pre-push-gate.sh` trùng số migration)
- [ ] `DB-MIG-015` **SHOULD** Thêm cột có `DEFAULT` không volatile (PostgreSQL 11+ không rewrite); tránh `DEFAULT now()`-kiểu volatile trên bảng lớn trong một bước. → Kiểm: squawk rule `adding-field-with-default`; review. · Nguồn: PostgreSQL 18 ALTER TABLE Notes
- [ ] `DB-MIG-016` **SHOULD** MySQL: DDL chỉ rõ `ALGORITHM=INSTANT|INPLACE, LOCK=NONE`; thất bại nếu không hỗ trợ thay vì âm thầm COPY. → Kiểm: lint grep ALTER TABLE thiếu `ALGORITHM`; CI chạy trên MySQL cùng major. · Nguồn: MySQL 8.4 Online DDL
- [ ] `DB-MIG-017` **SHOULD** Seed/fixture tách khỏi migration (migration không chứa dữ liệu mẫu); dữ liệu tham chiếu bắt buộc (bảng tra cứu) là migration dữ liệu lũy đẳng. → Kiểm: thư mục `seeds/` riêng; migration dữ liệu dùng upsert. · Nguồn: [`../14-testing-quality/test-data-and-fixtures.md`](../14-testing-quality/test-data-and-fixtures.md)
- [ ] `DB-MIG-018` **SHOULD** Diễn tập lùi trên staging cho mỗi phát hành chạm schema; kết quả ghi trong PR/ghi chú phát hành. → Kiểm: ghi chú phát hành có mục "đã thử lùi: <ngày, môi trường>". · Nguồn: P8
- [ ] `DB-MIG-019` **MAY** Dùng Atlas declarative (`schema apply` từ HCL/SQL mong muốn) khi đội muốn schema-as-code; vẫn commit migration sinh ra. → Kiểm: `atlas migrate diff` không tạo thay đổi mới trong CI.
- [ ] `DB-MIG-020` **MAY** Mobile/desktop SQLite: migration kiểm `PRAGMA user_version`, chạy trong transaction, có test nâng từ mọi phiên bản app còn được hỗ trợ. → Kiểm: test ma trận phiên bản cũ → mới.

## Bẫy thường gặp

- **`CREATE INDEX` thường trên bảng lớn giờ cao điểm** → khoá ghi hàng phút. Tránh: DB-MIG-006.
- **`CREATE INDEX CONCURRENTLY` thất bại để lại index INVALID** vẫn tốn chi phí ghi. Tránh: kiểm `indisvalid` sau migrate.
- **`ALTER COLUMN TYPE` tại chỗ** → rewrite toàn bảng + gấp đôi đĩa + khoá. Tránh: DB-MIG-008.
- **Không `lock_timeout`** → một transaction treo chặn DDL, DDL chặn mọi truy vấn phía sau → sập. Tránh: DB-MIG-005.
- **Sửa migration cũ để "sửa lỗi"** → checksum lệch, môi trường khác nhau. Tránh: DB-MIG-003.
- **"Rollback" trên Supabase/Prisma tưởng là có sẵn** — không; `migration repair` chỉ sửa bảng theo dõi, Prisma không sinh down. Tránh: DB-MIG-009.
- **Dùng Prisma `latest` = 8.0.0-rc** cho production (npm tag latest đang là rc ngày 2026-10-13). Tránh: ghim bản ổn định.
- **Backfill trong một transaction** hàng chục triệu dòng → WAL phình, replica trễ, khoá. Tránh: DB-MIG-010.
- **Code mới cần cột mới nhưng migrate chạy sau deploy** → lỗi 500 trong cửa sổ rollout. Tránh: DB-MIG-012.
- **AI agent "làm cổng xanh" bằng cách sửa/xoá migration** — hook phải chặn (catalog 12 §3, 23 §4.3).

## Cổng tự động

| Việc kiểm | Công cụ (phiên bản · giấy phép, xác minh 2026-10-13) | Lệnh/cách | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Lint an toàn migration PostgreSQL | squawk 2.68.0 · Apache-2.0/MIT | `squawk --config .squawk.toml migrations/*.sql` | pre-commit + CI | 0 lỗi |
| Phân tích khoá | eugene 0.8.3 · MIT | `eugene lint migrations/` / `eugene trace` trên CSDL test | CI | 0 cảnh báo mức cao |
| Áp migration trên CSDL sạch, chạy 2 lần | công cụ migration của stack + service container | `atlas migrate apply` / `flyway migrate` / `alembic upgrade head` ×2 | CI | exit 0 cả hai lần |
| Up → down → up | như trên (khi có down) | `alembic downgrade -1 && alembic upgrade head` | CI | exit 0 |
| Drift schema ↔ migration | Atlas 1.3.0 Apache-2.0 / `supabase db diff` / `prisma migrate diff` | `atlas schema diff --from env://... --to file://schema.sql` | CI | rỗng |
| Trùng số migration, sửa file đã áp | script (như xboss `pre-push-gate.sh`) + hook PreToolUse `deny` | `scripts/check-migrations.sh` (dự án tự viết) | pre-push + hook + CI | 0 |
| Index INVALID sau migrate | SQL `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid` | trong job CI/post-deploy | CI + post-deploy | 0 dòng |
| Tương thích N/N+1 | test tích hợp chạy code cũ trên schema mới | ma trận CI | CI | xanh |

## Nguồn

- PostgreSQL 18: CREATE INDEX (CONCURRENTLY, invalid) <https://www.postgresql.org/docs/current/sql-createindex.html>; ALTER TABLE Notes (NOT VALID/VALIDATE, SET NOT NULL skip scan, ALTER TYPE rewrite, default không rewrite) <https://www.postgresql.org/docs/current/sql-altertable.html>; `lock_timeout`/`statement_timeout` <https://www.postgresql.org/docs/current/runtime-config-client.html>; §14.4 Populating <https://www.postgresql.org/docs/current/populate.html> — xác minh 2026-10-13.
- MySQL 8.4 Online DDL (`ALGORITHM=INSTANT/INPLACE/COPY`, `LOCK=NONE`): <https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html> — xác minh 2026-10-13.
- Supabase — Database migrations (`migration new`, `db diff`, `db reset`, `db push`; không có rollback): <https://supabase.com/docs/guides/deployment/database-migrations> — xác minh 2026-10-13.
- Atlas Community Edition (Apache-2.0; `migrate lint`/drift là tính năng trả phí): <https://atlasgo.io/community-edition>; atlas 1.3.0 (brew) — xác minh 2026-10-13.
- Phiên bản xác minh 2026-10-13: Flyway 13.10.0 (brew Apache-2.0; Maven Central flyway-core 13.10.0 2026-10-08), Liquibase 5.0.4 (Maven Central 2026-08-20; brew 4.33.0), golang-migrate 4.20.1 MIT (brew), Alembic 1.20.0 MIT (PyPI), drizzle-kit 0.31.11 MIT + drizzle-orm 0.45.4 Apache-2.0 (npm), Prisma dist-tags `latest` 8.0.0-rc.22 / `prev` 7.10.0 (<https://registry.npmjs.org/-/package/prisma/dist-tags>), Supabase CLI 2.120.0 MIT (npm), squawk-cli 2.68.0 (npm), eugene 0.8.3 MIT (crates.io). Flyway edition (undo/dry-run trả phí): trang community không liệt kê chi tiết — **(chưa xác minh đầy đủ)**.
- Khung cũ `quality-supplements.md` §2 (quy trình migration Supabase, nghĩa đúng của rollback), `01-process-and-standards.md` GĐ6 — commit `1b80fe4`.
- Catalog `seeker19110/stored` 23 §4.1 (rule migration lũy đẳng/timestamptz), 23 §4.3 (`protect-config.sh` deny sửa migration đã áp; `pre-push-gate.sh` trùng số), 12 §3 — đọc 2026-10-13.
