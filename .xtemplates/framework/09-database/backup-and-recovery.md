---
title: Sao lưu, khôi phục, PITR, diễn tập, RPO/RTO
kind: module
prefix: DB-BACKUP
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, mobile-app, desktop-app, embedded-iot]
updated: 2026-10-14
---

# Sao lưu, khôi phục, PITR, diễn tập, RPO/RTO

> Sao lưu **ở tầng CSDL**: base backup + lưu trữ WAL cho PITR (PostgreSQL), binlog PITR (MySQL), backup API /
> `VACUUM INTO` (SQLite); `pg_dump` chỉ cho logic/di chuyển; RPO/RTO là con số đã **diễn tập khôi phục** chứ không
> phải mục tiêu trên giấy. Kế hoạch DR cấp hệ thống (đa vùng, thứ tự khôi phục dịch vụ, truyền thông) ở
> [`../15-operations/backup-and-disaster-recovery.md`](../15-operations/backup-and-disaster-recovery.md).

## Nguyên tắc

1. **Backup chưa khôi phục thử = không có backup.** Mỗi chu kỳ (tối thiểu hằng quý ở M, hằng tháng ở L) khôi phục
   thật vào môi trường tách biệt, đo RTO thật, kiểm dữ liệu đúng.
2. **RPO/RTO là yêu cầu nghiệp vụ** (NIST SP 800-34 Rev.1: RPO = điểm thời gian phải khôi phục được; RTO = tổng thời
   gian tối đa trong pha khôi phục) — chủ sản phẩm chốt, kỹ thuật chứng minh.
3. **PITR cho dữ liệu giao dịch**: lỗi người (xoá nhầm, migration sai) là nguyên nhân phổ biến nhất; snapshot hằng
   đêm RPO 24 h không đủ.
4. **Backup là dữ liệu nhạy cảm**: mã hoá, quyền tối thiểu, lưu ở tài khoản/vùng khác, bảo vệ chống xoá (object lock /
   versioning) để ransomware hoặc một credential rò rỉ không xoá được cả bản gốc lẫn backup.
5. **Giám sát backup như giám sát production**: cảnh báo khi backup/WAL archive thất bại hoặc trễ; `pg_wal` đầy do
   archive hỏng làm PostgreSQL PANIC.
6. **Cấu hình và bí mật cũng phải khôi phục được**: `postgresql.conf`, `pg_hba.conf`, khoá mã hoá — WAL không chứa chúng.

## Quyết định

| Hệ | Phương pháp mặc định | Dùng khi | Không đủ khi |
|---|---|---|---|
| PostgreSQL tự vận hành | **Base backup + WAL archive** bằng **pgBackRest 2.59.3** (MIT: full/diff/incr, song song, mã hoá, verify) hoặc **WAL-G 3.0.9** (Apache-2.0) | Production M/L, cần PITR | — |
| PostgreSQL managed (RDS/Cloud SQL/Supabase…) | PITR của nền tảng + **export logic định kỳ ra tài khoản khác** | Mọi quy mô | Chỉ dựa vào nền tảng (khoá vendor, xoá project = mất hết) |
| `pg_dump -Fc`/`-Fd -j` | Di chuyển, sao chép sang staging, backup logic bổ sung, dự án S | Dữ liệu nhỏ, RPO giờ/ngày chấp nhận được | Tài liệu PostgreSQL: "generally not the right choice for regular backups of production databases" ngoài trường hợp đơn giản |
| MySQL 8.4 | Full backup (`mysqldump`/Percona XtraBackup — phiên bản chưa xác minh) + **binary log** liên tục → PITR bằng `mysqlbinlog --stop-datetime` | Production | binlog tắt hoặc không lưu |
| SQLite | **Online Backup API** (`sqlite3 .backup`) hoặc `VACUUM INTO` → file snapshot nhất quán, rồi upload | Mobile/desktop/embedded, công cụ nội bộ | **Không** `cp` file đang mở (hỏng); WAL mode cần copy cả `-wal` nếu copy thô |
| MongoDB | `mongodump` cho nhỏ; snapshot volume/Atlas backup có PITR cho lớn | — | Giấy phép SSPL khi tự cung cấp dịch vụ |
| Vector/search index (pgvector trong PG, Meilisearch, OpenSearch) | Tái dựng từ nguồn sự thật (CSDL + pipeline) thay vì backup index; snapshot của Meilisearch/OpenSearch chỉ để rút RTO | Index là dẫn xuất | Index chứa dữ liệu không tái tạo được → coi như CSDL |

Mục tiêu tham chiếu (đội tự chốt và ghi vào `docs/ops/RPO-RTO.md`): dữ liệu giao dịch có tiền → RPO phút
(WAL archive liên tục), RTO ≤ vài giờ đã đo; dữ liệu nội bộ/S → RPO 24 h snapshot có thể chấp nhận.

## Checklist

- [ ] `DB-BACKUP-001` **MUST** RPO và RTO cho mỗi kho dữ liệu được chủ sản phẩm chốt và ghi trong repo, kèm cơ chế đáp ứng. → Kiểm: `docs/ops/RPO-RTO.md` có bảng kho → RPO → RTO → cơ chế → lần diễn tập gần nhất. · Nguồn: NIST SP 800-34 Rev.1 (RPO/RTO)
- [ ] `DB-BACKUP-002` **MUST** Backup tự động theo lịch, không phụ thuộc người nhớ chạy; thất bại → cảnh báo tới kênh có người trực. → Kiểm: cron/job/nền tảng có lịch; test cố ý làm backup fail → cảnh báo đến. · Nguồn: catalog 09 §1 (`[BLOCKER]` backup có test restore)
- [ ] `DB-BACKUP-003` **MUST** Đã khôi phục thử từ backup vào môi trường tách biệt ít nhất một lần trước khi ra mắt, ghi ngày, thời gian khôi phục đo được và cách kiểm dữ liệu. → Kiểm: `docs/ops/restore-drills.md` có bản ghi (ngày, backup dùng, RTO đo, kiểm tra đã làm, người làm). · Nguồn: lifecycle G8 ("backup đã thử khôi phục") · khung cũ `01-process-and-standards.md` GĐ6
- [ ] `DB-BACKUP-004` **MUST** Backup lưu ở vị trí tách biệt khỏi máy chủ CSDL (tài khoản/vùng/nhà cung cấp khác), mã hoá at rest, quyền ghi tối thiểu; tài khoản ứng dụng không có quyền xoá backup. → Kiểm: cấu hình đích backup (bucket khác tài khoản, KMS/`repo-cipher-type`); IAM policy không có `Delete*` cho tài khoản backup-writer. · Nguồn: OWASP Database Security Cheat Sheet (mã hoá backup, quyền hạn chế) · [`sensitive-data-and-access.md`](sensitive-data-and-access.md)
- [ ] `DB-BACKUP-005` **MUST@L** PostgreSQL production có PITR: `archive_mode = on`, `archive_command`/`archive_library` không ghi đè file, `wal_level ≥ replica`, base backup định kỳ; archive thất bại/trễ là cảnh báo. → Kiểm: `SHOW archive_mode` = on; `pg_stat_archiver.failed_count` có cảnh báo; `archive_timeout` cấu hình; pgBackRest `check` exit 0. · Nguồn: PostgreSQL 18 §25.3 Continuous Archiving and PITR
- [ ] `DB-BACKUP-006` **MUST@L** Diễn tập khôi phục định kỳ (≥ hằng quý; L: hằng tháng) gồm ít nhất một kịch bản PITR tới thời điểm trước một thao tác phá hoại giả lập; RTO đo được ≤ RTO đã chốt. → Kiểm: bản ghi diễn tập; job tự động restore-verify (pgBackRest `restore` + truy vấn kiểm đếm) chạy theo lịch, kết quả lưu. · Nguồn: PostgreSQL 18 §25.3.5 (kiểm dữ liệu sau recovery) · P12
- [ ] `DB-BACKUP-007` **MUST@L** Backup bất biến/chống xoá trong thời gian lưu giữ (object lock, versioning, hoặc repo chỉ-ghi) và chính sách lưu giữ ghi rõ (ví dụ 7 ngày PITR + 12 full tháng). → Kiểm: cấu hình bucket (`ObjectLock`/versioning); pgBackRest `repo-retention-*`; chính sách trong `docs/ops/RPO-RTO.md`. · Nguồn: pgBackRest (đọc repo theo thời điểm trên versioned storage) · [`../12-security/infrastructure-and-network.md`](../12-security/infrastructure-and-network.md)
- [ ] `DB-BACKUP-008` **MUST@L** Trước migration/thao tác hàng loạt trên production: backup/snapshot mới hoặc điểm PITR xác định, ghi trong PR/runbook. → Kiểm: DB-MIG-011; runbook deploy có bước ghi `pg_create_restore_point('<tên>')` hoặc snapshot id. · Nguồn: [`migrations.md`](migrations.md)
- [ ] `DB-BACKUP-009` **MUST@L** Backup toàn vẹn được xác minh tự động (checksum/`pgbackrest verify`, restore thử tự động) và tách biệt vùng địa lý; khôi phục sang vùng khác đã diễn tập. → Kiểm: job verify theo lịch; bản ghi diễn tập đa vùng. · Nguồn: [`../15-operations/backup-and-disaster-recovery.md`](../15-operations/backup-and-disaster-recovery.md)
- [ ] `DB-BACKUP-010` **SHOULD** Cấu hình (`postgresql.conf`, `pg_hba.conf`), extension, khoá mã hoá/bí mật cần cho restore được sao lưu/quản lý riêng và nằm trong kịch bản diễn tập. → Kiểm: IaC/secret manager chứa chúng; runbook restore liệt kê và diễn tập có bước lấy lại. · Nguồn: PostgreSQL 18 §25.3.7 (config không trong WAL)
- [ ] `DB-BACKUP-011` **SHOULD** Backup logic (`pg_dump -Fc` hoặc `-Fd -j n`) bổ sung để di chuyển/khôi phục từng bảng và sang major khác; restore bằng `pg_restore` thử trên CI định kỳ. → Kiểm: job tuần `pg_dump` → `pg_restore` vào CSDL rỗng exit 0. · Nguồn: PostgreSQL 18 pg_dump/pg_restore
- [ ] `DB-BACKUP-012` **SHOULD** Runbook khôi phục có bước-lệnh cụ thể, người được uỷ quyền, cách xác nhận dữ liệu, cách thông báo; được cập nhật sau mỗi diễn tập. → Kiểm: `docs/ops/runbooks/restore-db.md` (mẫu [`../templates/RUNBOOK.md`](../templates/RUNBOOK.md)) có ngày cập nhật ≤ lần diễn tập gần nhất. · Nguồn: [`../15-operations/incident-response.md`](../15-operations/incident-response.md)
- [ ] `DB-BACKUP-013` **SHOULD** Dung lượng và thời gian backup/restore là metric; cảnh báo khi tăng bất thường hoặc `pg_wal` phình do archive hỏng. → Kiểm: dashboard kích thước backup, `pg_stat_archiver`, dung lượng `pg_wal`. · Nguồn: PostgreSQL 18 §25.3 (pg_wal đầy → PANIC)
- [ ] `DB-BACKUP-014` **SHOULD** SQLite: snapshot bằng Backup API/`VACUUM INTO`, không copy file đang mở; đích tải lên có phiên bản. → Kiểm: mã backup dùng API; test restore file snapshot mở được và `PRAGMA integrity_check` = ok. · Nguồn: SQLite backup.html, lang_vacuum.html
- [ ] `DB-BACKUP-015` **SHOULD** MySQL: binlog bật với lưu giữ ≥ RPO, full backup định kỳ, diễn tập `mysqlbinlog --stop-datetime`. → Kiểm: `SHOW VARIABLES LIKE 'log_bin'` = ON; `binlog_expire_logs_seconds` ≥ chu kỳ full; bản ghi diễn tập. · Nguồn: MySQL 8.4 §9.5 Point-in-Time Recovery
- [ ] `DB-BACKUP-016` **MAY** Replica streaming để rút RTO (failover) — nhưng replica không thay backup (xoá nhầm lan sang replica). → Kiểm: tài liệu DR phân biệt HA và backup; vẫn có PITR.
- [ ] `DB-BACKUP-017` **MAY** Nâng major PostgreSQL bằng `pg_upgrade --check` trên bản sao trước, giữ backup đã verify; `--link` chỉ khi hiểu không quay lại được. → Kiểm: runbook nâng cấp; bản ghi thử trên bản sao.
- [ ] `DB-BACKUP-018` **MAY** Dữ liệu dẫn xuất (search/vector index, cache) có script tái dựng từ nguồn sự thật và thời gian tái dựng đo được. → Kiểm: `scripts/reindex.*`; thời gian ghi trong `RPO-RTO.md`.

## Bẫy thường gặp

- **Chỉ dựa vào nền tảng managed**: xoá nhầm project/tài khoản bị khoá → mất cả backup. Tránh: DB-BACKUP-004 (export sang tài khoản khác).
- **`pg_dump` hằng đêm gọi là "có PITR"**: RPO thực 24 h. Tránh: DB-BACKUP-005.
- **`archive_command = cp`** không kiểm tồn tại → ghi đè WAL; hoặc archive hỏng im lặng → `pg_wal` đầy → PANIC. Tránh: lệnh `test ! -f … && cp`, cảnh báo `failed_count` (DB-BACKUP-005/013).
- **Backup trên cùng đĩa/máy** → mất máy mất cả hai. Tránh: DB-BACKUP-004.
- **Credential ứng dụng có quyền xoá bucket backup** → ransomware/một rò rỉ xoá sạch. Tránh: DB-BACKUP-004/007.
- **Chưa bao giờ restore**: phát hiện backup rỗng/mã hoá không mở được đúng ngày sự cố. Tránh: DB-BACKUP-003/006.
- **`cp` file SQLite đang chạy** (đặc biệt WAL mode) → bản sao hỏng. Tránh: DB-BACKUP-014.
- **Replica = backup**: `DELETE` nhầm được replay trong vài ms. Tránh: DB-BACKUP-016.
- **Khôi phục được dữ liệu nhưng mất khoá mã hoá cột** → dữ liệu vô dụng. Tránh: DB-BACKUP-010.
- **RPO/RTO "mục tiêu" chưa đo**: lời khai, không bằng chứng (P1). Tránh: bản ghi diễn tập có số đo.

## Cổng tự động

| Việc kiểm | Công cụ (phiên bản · giấy phép, xác minh 2026-10-13) | Lệnh/cách | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Backup + WAL archive chạy và toàn vẹn | pgBackRest 2.59.3 · MIT | `pgbackrest --stanza=main check` · `pgbackrest info` · `pgbackrest verify` | cron + cảnh báo | exit 0; backup mới nhất ≤ chu kỳ |
| Thay thế | WAL-G 3.0.9 · Apache-2.0 | `wal-g backup-list` + verify | cron | như trên |
| Restore-verify tự động | script: restore vào container tạm + truy vấn kiểm | `scripts/restore-drill.sh` (dự án tự viết) | CI nightly/tuần | exit 0; RTO đo ≤ chốt |
| Archive thất bại / pg_wal phình | `pg_stat_archiver.failed_count`, dung lượng `pg_wal` | exporter + cảnh báo | production | failed_count không tăng |
| pg_dump → pg_restore | PostgreSQL 18 client tools | `pg_dump -Fd -j 4 … && pg_restore -d verify …` | CI tuần | exit 0 |
| Quyền xoá backup | IaC policy test (OPA/conftest, phiên bản theo lockfile) | `conftest test iam/` | CI | 0 policy cho phép Delete cho app role |
| SQLite snapshot | `sqlite3 db ".backup out.db"` + `PRAGMA integrity_check` | script | CI/app | `ok` |
| MySQL binlog | `SHOW VARIABLES LIKE 'log_bin'` | script kiểm | CI/production | ON |

## Nguồn

- PostgreSQL 18 docs: §25 Backup and Restore <https://www.postgresql.org/docs/current/backup.html>; §25.3 Continuous Archiving and PITR (archive_command không ghi đè, pg_wal đầy → PANIC, kiểm dữ liệu sau recovery, config ngoài WAL) <https://www.postgresql.org/docs/current/continuous-archiving.html>; pg_dump (không phải lựa chọn cho backup production thường xuyên; `-Fc`, `-Fd -j`) <https://www.postgresql.org/docs/current/app-pgdump.html>; pg_upgrade <https://www.postgresql.org/docs/current/pgupgrade.html> — xác minh 2026-10-13.
- NIST SP 800-34 Rev.1 (Contingency Planning Guide, 2010) — định nghĩa RPO/RTO: <https://csrc.nist.gov/glossary/term/recovery_point_objective>, <https://csrc.nist.gov/glossary/term/recovery_time_objective> — xác minh 2026-10-13.
- pgBackRest 2.59.3 MIT: <https://pgbackrest.org/>, <https://formulae.brew.sh/api/formula/pgbackrest.json>; WAL-G 3.0.9 Apache-2.0: <https://formulae.brew.sh/api/formula/wal-g.json> — xác minh 2026-10-13.
- MySQL 8.4 §9.5 Point-in-Time Recovery: <https://dev.mysql.com/doc/refman/8.4/en/point-in-time-recovery.html> — xác minh 2026-10-13.
- SQLite Online Backup API: <https://www.sqlite.org/backup.html>; `VACUUM INTO`: <https://www.sqlite.org/lang_vacuum.html> — xác minh 2026-10-13.
- OWASP Database Security Cheat Sheet (mã hoá backup, quyền): <https://cheatsheetseries.owasp.org/cheatsheets/Database_Security_Cheat_Sheet.html> — xác minh 2026-10-13.
- Catalog `seeker19110/stored` 09 §1 (backup có test restore là BLOCKER); khung cũ `01-process-and-standards.md` GĐ6 ("đã thử khôi phục một lần"), `quality-supplements.md` §2 (backup trước migration) — commit `1b80fe4`.
