---
title: Dữ liệu nhạy cảm: mã hoá, RLS, quyền tối thiểu, mặt nạ, xoá
kind: module
prefix: DB-SEC
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, mobile-app, desktop-app, embedded-iot]
updated: 2026-10-14
---

# Dữ liệu nhạy cảm: mã hoá, RLS, quyền tối thiểu, mặt nạ, xoá

> **Kiểm soát kỹ thuật ở tầng CSDL** cho dữ liệu nhạy cảm: phân loại cột, tài khoản tối thiểu theo dịch vụ, TLS bắt
> buộc, Row-Level Security cho đa tenant, mã hoá cột có quản lý khoá, mặt nạ cho môi trường không phải production,
> xoá/ẩn danh theo yêu cầu, audit truy cập. Nghĩa vụ pháp lý (Luật 91/2025/QH15 + NĐ 356/2025/NĐ-CP, GDPR, quyền chủ thể) là của
> [`../16-compliance-privacy/`](../16-compliance-privacy/README.md); bí mật kết nối là của
> [`../12-security/secrets-management.md`](../12-security/secrets-management.md); log sự kiện bảo mật ở
> [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md).

## Nguyên tắc

1. **Phân loại trước, kiểm soát sau.** Mỗi cột thuộc một mức (public / internal / PII / nhạy cảm đặc biệt / bí mật);
   kiểm soát (mã hoá, mặt nạ, lưu giữ) suy ra từ mức, không quyết từng cột tuỳ hứng (ASVS 5.0 V14.1.1).
2. **Quyền tối thiểu theo dịch vụ.** Mỗi ứng dụng/dịch vụ/job một vai trò CSDL riêng, chỉ có quyền cần; không dùng
   superuser/owner cho ứng dụng; migration dùng vai trò khác runtime.
3. **RLS là hàng rào, không phải cách duy nhất.** Ứng dụng vẫn lọc theo tenant/user (defense in depth); RLS bắt lỗi khi
   ứng dụng quên. Owner và superuser **bỏ qua RLS** trừ khi `FORCE ROW LEVEL SECURITY`.
4. **Mã hoá đúng tầng.** TLS cho đường truyền; mã hoá đĩa/volume cho at-rest cơ bản; mã hoá cột cho dữ liệu cần "mất
   CSDL vẫn không đọc được", khoá nằm ngoài CSDL (KMS/HSM). `pgcrypto` chạy trong server: khoá đi qua câu lệnh có
   thể lọt vào log — ưu tiên mã hoá ở ứng dụng với khoá từ KMS.
5. **Production không chảy vào dev/test.** Bản sao cho môi trường khác phải mặt nạ/ẩn danh; AI agent không đọc dữ
   liệu thật.
6. **Xoá là thật.** Yêu cầu xoá của người dùng → xoá hoặc ẩn danh hoá không đảo ngược ở mọi bản sao (kể cả backup
   theo chính sách lưu giữ), không chỉ soft-delete.
7. **Ai đọc gì phải truy vết được** cho dữ liệu nhạy cảm đặc biệt (y tế, tài chính, trẻ em).

## Quyết định

| Nhu cầu | Chọn | Không dùng khi |
|---|---|---|
| Cách ly tenant/user ở CSDL | **RLS PostgreSQL**: `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy theo `current_setting('app.tenant_id', true)` hoặc vai trò; ứng dụng `SET LOCAL` mỗi transaction | Dùng PgBouncer transaction mode mà `SET` không `LOCAL` → rò giữa client; tenant cần cách ly pháp lý → schema/CSDL riêng |
| Mã hoá cột | **Ở ứng dụng** (AES-GCM, khoá từ KMS, envelope encryption, có `key_id` để xoay) | `pgcrypto pgp_sym_encrypt` khi không có KMS và chấp nhận khoá đi qua câu lệnh (tắt log statement cho phiên đó) |
| Hash cho tra cứu dữ liệu mã hoá | HMAC có khoá (không SHA thuần) cột `*_hash` để `WHERE` bằng | Dữ liệu entropy thấp (số điện thoại) vẫn tấn công được → giới hạn tra cứu |
| Mật khẩu | Băm Argon2id/bcrypt **ở ứng dụng** (xem [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md)) | `crypt()` của pgcrypto trong SQL (mật khẩu đi qua server/log) |
| Mặt nạ dữ liệu cho dev/staging | Script ẩn danh hoá sau restore (thay PII bằng dữ liệu giả có cùng hình thái) hoặc dữ liệu tổng hợp (xem [`../14-testing-quality/test-data-and-fixtures.md`](../14-testing-quality/test-data-and-fixtures.md)) | Copy thẳng production |
| Mặt nạ động khi đọc (vai trò hỗ trợ chỉ thấy 4 số cuối) | View/cột tính theo vai trò + `GRANT` trên view, không trên bảng | — |
| Audit truy cập | Bảng audit append-only (ai, khi, bảng, khoá, hành động) qua trigger hoặc tầng ứng dụng; `pgaudit` khi cần theo chuẩn (phiên bản chưa xác minh) | Log mọi SELECT trên bảng lớn (chi phí) → chỉ bảng nhạy cảm đặc biệt |
| Xoá theo yêu cầu | Hàm/job xoá theo `user_id` qua mọi bảng (FK CASCADE hoặc danh sách bảng) + ẩn danh hoá bản ghi phải giữ (hoá đơn) + xoá trong search/cache/backup theo lịch lưu giữ | Soft-delete đơn thuần |
| Cứng hoá máy chủ | CIS Benchmark PostgreSQL 18 v1.0.0 / 17 v1.1.0; `pg_hba.conf` `scram-sha-256` + `hostssl`, không `trust` | — |

## Checklist

- [ ] `DB-SEC-001` **MUST@L** Mỗi cột chứa dữ liệu cá nhân/nhạy cảm được gắn nhãn phân loại (comment hoặc bảng `data_catalog`), là đầu vào cho mã hoá/mặt nạ/lưu giữ. → Kiểm: `docs/db/data-classification.md` hoặc `COMMENT ON COLUMN` chứa `class=PII|SENSITIVE|SECRET`; script liệt kê cột có tên gợi PII (email, phone, dob, address, id_number) chưa gắn nhãn = 0. · Nguồn: OWASP ASVS 5.0 V14.1.1, V14.1.2
- [ ] `DB-SEC-002` **MUST** Ứng dụng kết nối bằng vai trò riêng, không superuser/không owner bảng, chỉ có `SELECT/INSERT/UPDATE/DELETE` trên bảng cần; migration dùng vai trò khác. → Kiểm: `SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname='app'` = false; `\dp` không có quyền thừa; `DATABASE_URL` runtime ≠ `MIGRATION_DATABASE_URL`. · Nguồn: OWASP Database Security Cheat Sheet (least privilege, tài khoản riêng)
- [ ] `DB-SEC-003` **MUST** Kết nối CSDL qua TLS với xác minh chứng chỉ (`sslmode=verify-full`/tương đương), máy chủ từ chối kết nối không mã hoá; không `trust`/`password` trong `pg_hba.conf`. → Kiểm: `pg_hba.conf` chỉ `hostssl` + `scram-sha-256`; connection string có `sslmode=verify-full`; test kết nối `sslmode=disable` bị từ chối. · Nguồn: OWASP Database Security Cheat Sheet (TLS 1.2+)
- [ ] `DB-SEC-004` **MUST** Bí mật kết nối không trong code/log; xoay được không downtime (ứng dụng đọc lại); log truy vấn không in tham số nhạy cảm. → Kiểm: gitleaks 0 phát hiện; `log_statement` ≠ all ở production hoặc tham số bị che; runbook xoay mật khẩu đã thử. · Nguồn: [`../12-security/secrets-management.md`](../12-security/secrets-management.md)
- [ ] `DB-SEC-005` **MUST@L** Môi trường dev/test/CI không chứa dữ liệu cá nhân thật; bản sao từ production phải qua ẩn danh hoá trước khi rời môi trường production. → Kiểm: script `scripts/anonymize.sql` (dự án tự viết) chạy trong pipeline tạo bản sao; test "email thật không tồn tại trong dump dev" (so với danh sách mẫu); AI agent/CI không có credential production. · Nguồn: P11 · [`../16-compliance-privacy/privacy-by-design.md`](../16-compliance-privacy/privacy-by-design.md)
- [ ] `DB-SEC-006` **MUST@L** Có cơ chế xoá/ẩn danh hoá theo `user_id` qua mọi bảng (kể cả bảng dẫn xuất, search index, cache, file), chạy được bằng một lệnh, có test. → Kiểm: `scripts/erase-user.*` + test: sau khi chạy, truy vấn mọi bảng có nhãn PII theo `user_id` = 0 dòng hoặc đã ẩn danh; thời hạn thực hiện theo [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md). · Nguồn: ASVS 5.0 V14.2.7 · [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md)
- [ ] `DB-SEC-007` **MUST@M** Dữ liệu nhiều tenant/user được bảo vệ bằng RLS: mọi bảng có `tenant_id`/`user_id` bật `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `USING` và `WITH CHECK` theo biến phiên đặt bằng `SET LOCAL` trong transaction. → Kiểm: script catalog: 0 bảng có `tenant_id` mà `relrowsecurity = false` hoặc `relforcerowsecurity = false`; test tích hợp: phiên tenant A `SELECT/UPDATE/DELETE` bảng → 0 dòng của B, `INSERT` với `tenant_id` B bị từ chối. · Nguồn: PostgreSQL 18 §5.9 Row Security Policies · CREATE POLICY (USING/WITH CHECK, PERMISSIVE/RESTRICTIVE)
- [ ] `DB-SEC-008` **MUST@L** Vai trò ứng dụng không có `BYPASSRLS` và không là owner bảng; backup chạy bằng vai trò riêng có `row_security = off` để lỗi thay vì âm thầm bỏ dòng. → Kiểm: `pg_roles.rolbypassrls` = false cho app; owner bảng là vai trò migration; job backup đặt `row_security=off`. · Nguồn: PostgreSQL 18 §5.9 (owner/superuser/BYPASSRLS bypass; `row_security = off` lỗi thay vì lọc)
- [ ] `DB-SEC-009` **MUST@L** Dữ liệu mức "nhạy cảm đặc biệt/bí mật" (số định danh, thẻ, y tế, token bên thứ ba) được mã hoá cột ở ứng dụng với khoá từ KMS, có `key_id`, xoay khoá được; không log/plaintext trong cột khác. → Kiểm: cột có hậu tố `_enc` + `_key_id`; test đọc trực tiếp CSDL không thấy plaintext; runbook xoay khoá thử trên staging. · Nguồn: ASVS 5.0 V14.1.2, V14.2.4 · PostgreSQL 18 pgcrypto (chạy trong server, khoá qua câu lệnh)
- [ ] `DB-SEC-010` **MUST@L** Truy cập trực tiếp CSDL production của con người đi qua tài khoản cá nhân, có thời hạn, có ghi log (bastion/`pgaudit`/proxy), không dùng chung tài khoản ứng dụng. → Kiểm: `pg_roles` không có tài khoản chung `admin`; log phiên truy cập lưu ≥ thời hạn chính sách; quyền được cấp tạm có hạn. · Nguồn: OWASP Database Security Cheat Sheet · [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md)
- [ ] `DB-SEC-011` **MUST@L** Chính sách lưu giữ cho mỗi lớp dữ liệu (bao lâu, rồi xoá/ẩn danh) chạy tự động theo lịch; dữ liệu quá hạn không tồn tại. → Kiểm: `docs/db/retention.md` bảng → thời hạn; job xoá theo lịch; test chèn bản ghi quá hạn → bị xoá sau job. · Nguồn: ASVS 5.0 V14.2.7 · [`../16-compliance-privacy/records-and-audit-readiness.md`](../16-compliance-privacy/records-and-audit-readiness.md)
- [ ] `DB-SEC-012` **MUST@L** Truy cập đọc/ghi dữ liệu nhạy cảm đặc biệt được audit append-only (ai, khi, bảng, khoá bản ghi, hành động, lý do) và bảng audit không sửa/xoá được bởi vai trò ứng dụng. → Kiểm: trigger/tầng app ghi `audit_log`; `REVOKE UPDATE, DELETE ON audit_log FROM app`; test sửa audit bị từ chối. · Nguồn: ASVS 5.0 V16 (logging) · hồ sơ `healthcare`/`fintech`
- [ ] `DB-SEC-013` **SHOULD** Máy chủ CSDL cứng hoá theo CIS Benchmark (PostgreSQL 18 v1.0.0) hoặc checklist tương đương của nền tảng managed; sai lệch có lý do. → Kiểm: báo cáo quét (script CIS/`pgdsat` — phiên bản chưa xác minh) lưu trong `docs/ops/`; ngoại lệ ghi rõ. · Nguồn: CIS PostgreSQL Benchmark
- [ ] `DB-SEC-014` **SHOULD** Mặt nạ động theo vai trò: nhân viên hỗ trợ chỉ thấy phần cần (4 số cuối, email che) qua view; quyền cấp trên view, không trên bảng. → Kiểm: `GRANT SELECT ON v_customers_support TO support`; `\dp customers` không có quyền cho `support`; test hiển thị đã che. · Nguồn: ASVS 5.0 V14
- [ ] `DB-SEC-015` **SHOULD** Tra cứu trên cột mã hoá qua cột HMAC có khoá; không SHA thuần cho dữ liệu entropy thấp. → Kiểm: cột `email_hmac`; khoá HMAC từ KMS; không có `sha256(email)` trong code. · Nguồn: [`../12-security/appsec-web.md`](../12-security/appsec-web.md)
- [ ] `DB-SEC-016` **SHOULD** Schema `public`: thu hồi `CREATE` khỏi `PUBLIC` (mặc định từ PostgreSQL 15) và không cấp quyền mặc định rộng; `ALTER DEFAULT PRIVILEGES` cho vai trò đọc báo cáo. → Kiểm: `\dn+ public` không có `C` cho PUBLIC; vai trò `reporting` chỉ SELECT. · Nguồn: PostgreSQL 18 §5.8 Privileges
- [ ] `DB-SEC-017` **SHOULD** Policy RLS đơn giản, dùng cột có index; đo chi phí (EXPLAIN) trên bảng lớn; hàm trong policy không đánh dấu `LEAKPROOF` tuỳ tiện. → Kiểm: EXPLAIN truy vấn chính dưới RLS dùng index `tenant_id`; grep `LEAKPROOF` có lý do. · Nguồn: PostgreSQL 18 CREATE POLICY (LEAKPROOF)
- [ ] `DB-SEC-018` **SHOULD** Dữ liệu nhạy cảm không vào cache/search index/log/sự kiện dưới dạng plaintext trừ khi có cùng kiểm soát; search index chỉ giữ trường cần. → Kiểm: schema sự kiện/index không có cột lớp PII (lint theo `data_catalog`); ARC-INT-015. · Nguồn: ASVS 5.0 V14.2.2
- [ ] `DB-SEC-019` **MAY** Dùng `pgaudit`/log truy cập theo lớp dữ liệu cho bảng nhạy cảm đặc biệt khi yêu cầu kiểm toán ngành. → Kiểm: cấu hình `pgaudit.log` cho bảng/vai trò; log tới hệ quan sát.
- [ ] `DB-SEC-020` **MAY** Ẩn danh hoá thống kê (k-anonymity/tổng hợp) cho dữ liệu phân tích thay vì cấp quyền đọc bảng gốc. → Kiểm: tầng phân tích đọc từ bảng tổng hợp; không có quyền SELECT bảng PII.
- [ ] `DB-SEC-021` **MAY** SQLite trên thiết bị: mã hoá file (SQLCipher — phiên bản/giấy phép chưa xác minh) hoặc mã hoá cột + keystore của nền tảng. → Kiểm: file DB không mở được bằng `sqlite3` thường; khoá trong Keychain/Keystore.

## Bẫy thường gặp

- **Owner bảng = tài khoản ứng dụng** → RLS bị bỏ qua hoàn toàn mà test "có policy" vẫn xanh. Tránh: `FORCE ROW LEVEL SECURITY` + owner riêng (DB-SEC-007/008).
- **`SET app.tenant_id` không `LOCAL` qua PgBouncer transaction mode** → biến dính kết nối server, tenant khác đọc được. Tránh: `SET LOCAL` trong transaction (DB-SEC-007).
- **Covert channel qua ràng buộc**: UNIQUE/FK bỏ qua RLS → đoán được sự tồn tại bản ghi tenant khác qua lỗi unique. Tránh: khoá duy nhất gồm `tenant_id`; lỗi trả chung chung (tài liệu PostgreSQL §5.9).
- **`pgp_sym_encrypt(data, 'khoá')` với `log_statement = all`** → khoá nằm trong log. Tránh: mã hoá ở ứng dụng (DB-SEC-009).
- **Dump production về máy dev "để debug"** → PII trên laptop, trong CI, trong prompt AI. Tránh: DB-SEC-005.
- **Soft-delete coi là "đã xoá theo yêu cầu"** → vi phạm quyền xoá. Tránh: DB-SEC-006.
- **Mật khẩu băm trong SQL** (`crypt()`), hash SHA thuần cho email → tra ngược. Tránh: băm ở ứng dụng, HMAC có khoá.
- **`sslmode=require` tưởng đã an toàn** — không xác minh chứng chỉ, MITM được. Tránh: `verify-full` (DB-SEC-003).
- **Mã hoá cột nhưng khoá lưu trong biến môi trường của cùng máy CSDL** → mất máy mất cả hai. Tránh: KMS + envelope.
- **Backup chạy dưới RLS bằng vai trò app** → dump thiếu dòng mà không báo. Tránh: `row_security = off` cho vai trò backup (DB-SEC-008).

## Cổng tự động

| Việc kiểm | Công cụ (phiên bản · giấy phép, xác minh 2026-10-13) | Lệnh/cách | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| RLS bật/forced trên bảng có tenant; app không BYPASSRLS/owner | SQL catalog (`pg_class.relrowsecurity`, `relforcerowsecurity`, `pg_roles`) | `psql -f scripts/db-security-checks.sql` | CI (sau migrate) + production hằng ngày | 0 vi phạm |
| Test cách ly tenant | test tích hợp 2 tenant | `pytest tests/security/test_rls.py` | CI | 0 rò |
| Cột PII chưa phân loại | script so tên cột với `data_catalog` | `python3 scripts/pii-audit.py` | CI | 0 |
| Bí mật trong code | gitleaks (xem [`../12-security/secrets-management.md`](../12-security/secrets-management.md)) | theo module đó | pre-commit + CI | 0 |
| TLS/`pg_hba` | kiểm cấu hình (IaC test/conftest) + test kết nối `sslmode=disable` | script | CI | từ chối |
| Ẩn danh hoá bản sao | `scripts/anonymize.sql` (dự án tự viết) + test | pipeline tạo staging | CI | không có PII mẫu |
| Xoá theo yêu cầu | `scripts/erase-user.*` + test | CI | 0 dòng PII còn lại |
| Lưu giữ/xoá quá hạn | job cron + test | CI nightly | 0 bản ghi quá hạn |
| Cứng hoá máy chủ | CIS Benchmark PostgreSQL 18 v1.0.0 (tài liệu); công cụ quét **chưa xác minh** | báo cáo | hằng quý | sai lệch có lý do |
| Audit log bất biến | test `UPDATE/DELETE audit_log` bằng vai trò app | CI | bị từ chối |

## Nguồn

- PostgreSQL 18 docs: §5.9 Row Security Policies (default-deny, FORCE, BYPASSRLS, covert channel qua ràng buộc, `row_security = off`) <https://www.postgresql.org/docs/current/ddl-rowsecurity.html>; CREATE POLICY (USING/WITH CHECK, PERMISSIVE/RESTRICTIVE, LEAKPROOF) <https://www.postgresql.org/docs/current/sql-createpolicy.html>; pgcrypto (chạy trong server, khoá qua câu lệnh, side channel) <https://www.postgresql.org/docs/current/pgcrypto.html>; §5.8 Privileges / ALTER DEFAULT PRIVILEGES <https://www.postgresql.org/docs/current/ddl-priv.html>; CREATE ROLE (BYPASSRLS, NOLOGIN) <https://www.postgresql.org/docs/current/sql-createrole.html> — xác minh 2026-10-13.
- OWASP Database Security Cheat Sheet (TLS, least privilege, tài khoản riêng, credential, hardening, mã hoá backup): <https://cheatsheetseries.owasp.org/cheatsheets/Database_Security_Cheat_Sheet.html> — xác minh 2026-10-13.
- OWASP ASVS 5.0 V14 Data Protection (14.1.1 phân loại L2; 14.1.2 bảo vệ at rest L2; 14.2.2 cache; 14.2.4; 14.2.7 lưu giữ/xoá L3): <https://github.com/OWASP/ASVS/blob/master/5.0/en/0x23-V14-Data-Protection.md> — xác minh 2026-10-13.
- CIS Benchmarks PostgreSQL (18 v1.0.0, 17 v1.1.0, 16 v1.1.0): <https://www.cisecurity.org/benchmark/postgresql> — xác minh 2026-10-13.
- PgBouncer transaction mode và `SET` rò giữa client: <https://www.pgbouncer.org/config.html> — xác minh 2026-10-13.
- Pháp lý: Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 + NĐ 356/2025/NĐ-CP (hiệu lực 01/01/2026), quyền chủ thể, DPIA — xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) (số hiệu, hiệu lực và văn bản sửa đổi xác minh ở đó); `research/2026-10-13-stored-catalog-extraction.md` (NĐ 217/2026, 207/2026, 70/2025 ghi theo docs nội bộ, **chưa xác minh**).
- Catalog `seeker19110/stored` 13 §6b (thiếu xoá dữ liệu cá nhân/GDPR/nghị định dữ liệu cá nhân VN cũ trong ảnh CRM), 23 §4.1 (`validateAuth()` + user_id từ token chống IDOR) — đọc 2026-10-13.
