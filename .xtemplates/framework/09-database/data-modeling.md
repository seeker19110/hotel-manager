---
title: Mô hình dữ liệu, chuẩn hoá, khoá, kiểu dữ liệu, soft-delete, audit
kind: module
prefix: DB-MODEL
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, mobile-app, desktop-app, embedded-iot]
updated: 2026-10-16
---

# Mô hình dữ liệu, chuẩn hoá, khoá, kiểu dữ liệu, soft-delete, audit

> Quy tắc thiết kế schema để dữ liệu **đúng ngay từ kiểu**: chọn CSDL theo nhu cầu (PostgreSQL mặc định), khoá chính
> `bigint identity` hoặc UUIDv7, `timestamptz` UTC, tiền mặc định là số nguyên (`numeric` chỉ khi có ADR), ràng buộc ở CSDL, soft-delete chỉ khi
> có lý do, cột audit tối thiểu. Quy ước thời gian/tiền/đơn vị ở mức ứng dụng là của
> [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md); đây là cách **thể hiện
> trong CSDL**.

## Nguyên tắc

1. **Ràng buộc ở CSDL, không chỉ ở code.** `NOT NULL`, `UNIQUE`, `CHECK`, `FOREIGN KEY` là hàng rào cuối cùng; ứng
   dụng (và AI agent) có thể sai, CSDL thì không bỏ qua ràng buộc.
2. **Kiểu đúng trước, tối ưu sau.** `timestamptz` cho mọi mốc thời gian; số nguyên đơn vị nhỏ nhất cho tiền (`numeric` khi có ADR);
   không `float` cho tiền, không `money` (phụ thuộc locale, hỏng khi dump/restore khác `lc_monetary`); `text` thay
   `varchar(n)` trừ khi độ dài là ràng buộc nghiệp vụ.
3. **Chuẩn hoá đến 3NF cho dữ liệu giao dịch**; phi chuẩn hoá có chủ đích (cột tính sẵn, JSONB) phải ghi lý do và
   có cách đồng bộ.
4. **Khoá chính ổn định, vô nghĩa.** Không dùng email/mã nghiệp vụ làm PK (chúng đổi được); PK là `bigint identity`
   hoặc UUIDv7 (RFC 9562 §5.7 — sắp xếp theo thời gian, index locality tốt hơn UUIDv4).
5. **Xoá là quyết định nghiệp vụ.** Mặc định xoá thật + FK `ON DELETE` tường minh; soft-delete chỉ khi cần khôi
   phục/lịch sử, và khi đó mọi truy vấn + UNIQUE phải tính đến nó.
6. **Schema là code có phiên bản** (xem [`migrations.md`](migrations.md)); không sửa tay trên production.

## Quyết định

| Câu hỏi | Mặc định | Thay thế + điều kiện |
|---|---|---|
| CSDL chính | **PostgreSQL 18.6** (major 18 hiện hành; 14 hết hỗ trợ 2026-11-12) | **MySQL 8.4 LTS** (8.4.11; endoflife.date đánh dấu 9.7 cũng LTS — xác minh trang MySQL trước khi chọn 9.x) khi đội/hạ tầng đã chuẩn MySQL · **SQLite 3.54.0** khi dữ liệu cùng máy với ứng dụng, một writer, < ~1 TB (embedded, desktop, mobile, công cụ nội bộ) · **MongoDB 8.3/9.0** chỉ khi tài liệu thật sự không có schema cố định; giấy phép **SSPL** (không OSI) — tránh khi cung cấp dịch vụ quản lý |
| Khoá chính | **`bigint GENERATED ALWAYS AS IDENTITY`** khi id không lộ ra ngoài và không cần sinh ở client | **UUIDv7** (`uuidv7()` có sẵn PostgreSQL 18) khi id sinh ở client/offline, gộp từ nhiều nguồn, hoặc lộ ra URL công khai · **không** UUIDv4 làm PK bảng lớn (index locality kém) · không UUID dạng `text` (lưu 128-bit) |
| Thời gian | `timestamptz` (lưu UTC), `date` cho ngày thuần | `timestamp` (không tz) **chỉ** cho "giờ tường" cố ý (lịch hẹn địa phương) kèm cột `tz` IANA |
| Tiền | **số nguyên đơn vị nhỏ nhất** (`bigint` VND/cent) + cột `currency` ISO 4217 — quy tắc ở [`XC-UNITS-005`](../18-cross-cutting/units-time-and-money.md) | `numeric(p,s)` scale cố định **chỉ khi** cần độ chính xác dưới đơn vị nhỏ nhất (tỷ giá, đơn giá theo gram/kWh) và có ADR; **không** `float/double`, **không** `money` |
| Chuỗi | `text` + `CHECK (length(...) <= n)` khi cần | `varchar(n)` khi chuẩn ngành cố định; `citext`/`lower()` index cho so sánh không phân biệt hoa thường |
| Liệt kê | **bảng tra cứu** (FK) khi giá trị có thuộc tính/đổi theo thời gian | `CHECK (col IN (...))` hoặc enum PostgreSQL khi tập nhỏ, ổn định; enum khó đổi tên/xoá giá trị |
| Dữ liệu bán cấu trúc | Cột thường + JSONB cho phần thật sự biến thiên, có `CHECK (jsonb_typeof(...))` và GIN index khi truy vấn | Không nhét toàn bộ bản ghi vào một cột JSON |
| Xoá | **Xoá thật** + `ON DELETE RESTRICT`/`CASCADE` chọn tường minh (mặc định PostgreSQL là `NO ACTION`) | **Soft-delete** `deleted_at timestamptz NULL` khi cần khôi phục; UNIQUE thành partial index `WHERE deleted_at IS NULL`; hoặc **bảng lưu trữ** (archive) cho dữ liệu lịch sử lớn |
| Audit | `created_at`, `updated_at` (trigger/ORM), `created_by` khi có tác nhân | Bảng lịch sử (append-only) cho dữ liệu pháp lý/tiền — xem [`sensitive-data-and-access.md`](sensitive-data-and-access.md) |
| Nhiều tenant | Cột `tenant_id` + RLS (xem [`sensitive-data-and-access.md`](sensitive-data-and-access.md)) | Schema/CSDL riêng mỗi tenant khi cách ly pháp lý bắt buộc (hồ sơ `saas-multitenant`) |

## Checklist

- [ ] `DB-MODEL-001` **MUST** Kiểu cột mốc thời gian theo CSDL: `timestamptz` (PostgreSQL) / `TIMESTAMP` lưu UTC + ứng dụng đặt `time_zone='+00:00'` (MySQL) / RFC 3339 UTC `TEXT` hoặc epoch ms `INTEGER` (SQLite); `timestamp without time zone` chỉ cho cột "giờ tường" có ghi lý do. Nguyên tắc (UTC, tz IANA): xem [`XC-UNITS-001`](../18-cross-cutting/units-time-and-money.md). → Kiểm: lint schema (grep `timestamp without time zone`/`timestamp(` trong migration) = 0 ngoài allowlist có comment; test chèn `'2026-01-01T00:00:00+07:00'` đọc ra đúng tức thời. · Nguồn: PostgreSQL 18 §8.5.1.3 (timestamptz lưu UTC)
- [ ] `DB-MODEL-002` **MUST** Kiểu cột tiền: `bigint` (số nguyên đơn vị nhỏ nhất) + cột `currency char(3)` ISO 4217; `numeric(p,s)` scale cố định chỉ ở cột có ADR (tỷ giá, đơn giá dưới đơn vị nhỏ nhất); không `real`/`double precision`/`float`, không kiểu `money` (phụ thuộc `lc_monetary`). Nguyên tắc: xem [`XC-UNITS-005`](../18-cross-cutting/units-time-and-money.md). → Kiểm: lint schema cấm kiểu `real|double precision|float|money` ở cột có tên/nghĩa tiền; mọi cột tiền `numeric` có trong danh sách của ADR. · Nguồn: PostgreSQL 18 §8.1.2 numeric, §8.2 money (locale/lc_monetary)
- [ ] `DB-MODEL-003` **MUST@L** Khoá chính là `bigint GENERATED ALWAYS AS IDENTITY` (id nội bộ) hoặc UUIDv7 lưu kiểu `uuid` (không `text`); không dùng trường nghiệp vụ (email, mã) làm PK; UUIDv4 không làm PK bảng lớn. Nguyên tắc ID công khai/token: xem [`XC-UNITS-011`](../18-cross-cutting/units-time-and-money.md). → Kiểm: `pg_dump --schema-only` + script kiểm kiểu PK; ADR nếu ngoại lệ. · Nguồn: RFC 9562 §2.1, §5.7, §6.11, §6.13 · PostgreSQL 18 `uuidv7()`
- [ ] `DB-MODEL-004` **MUST** Mọi FK khai báo `ON DELETE` tường minh (`RESTRICT`/`CASCADE`/`SET NULL`), có index trên cột FK. → Kiểm: truy vấn catalog liệt kê FK không có index / FK không ghi hành động; CI đỏ khi > 0. · Nguồn: PostgreSQL 18 CREATE TABLE (referential actions; `NO ACTION` mặc định)
- [ ] `DB-MODEL-005` **MUST** Cột không được rỗng là `NOT NULL`; bất biến nghiệp vụ đơn giản là `CHECK` (số lượng ≥ 0, `ends_at > starts_at`, trạng thái ∈ tập); tính duy nhất là `UNIQUE` (kể cả duy nhất theo tenant). → Kiểm: test chèn dữ liệu xấu ở tầng CSDL bị từ chối (không qua ORM); script đếm cột nullable không có lý do. · Nguồn: P6 · P7
- [ ] `DB-MODEL-006` **MUST@L** Soft-delete (nếu dùng) có `deleted_at timestamptz NULL`; mọi UNIQUE liên quan là partial index `WHERE deleted_at IS NULL`; truy vấn mặc định lọc bản ghi đã xoá qua view/scope duy nhất. → Kiểm: test tạo lại bản ghi trùng khoá sau khi soft-delete thành công; test truy vấn công khai không trả bản ghi đã xoá; grep scope/view dùng ở mọi repository. · Nguồn: PostgreSQL 18 CREATE INDEX (partial + UNIQUE)
- [ ] `DB-MODEL-007` **MUST@L** Bảng có `created_at timestamptz NOT NULL DEFAULT now()` và `updated_at` cập nhật tự động (trigger hoặc ORM), cộng `created_by/updated_by` khi có tác nhân. → Kiểm: script catalog liệt kê bảng thiếu hai cột; test update làm `updated_at` đổi. · Nguồn: catalog 23 §4.1 (open-code-review rule: migration timestamptz)
- [ ] `DB-MODEL-008` **MUST@L** Dữ liệu nhiều tenant có `tenant_id NOT NULL` trên mọi bảng nghiệp vụ, nằm trong UNIQUE/FK composite, và được RLS bảo vệ. → Kiểm: script catalog: 0 bảng nghiệp vụ thiếu `tenant_id`; test RLS ở [`sensitive-data-and-access.md`](sensitive-data-and-access.md). · Nguồn: hồ sơ `saas-multitenant`
- [ ] `DB-MODEL-009` **MUST@L** Schema được ghi thành tài liệu sinh từ CSDL (ERD/bảng cột) có cổng drift; không vẽ tay. → Kiểm: lệnh sinh (`atlas schema inspect`, `pg_dump --schema-only`, `prisma`/`drizzle` introspect, `schemaspy`…) trong CI; diff với file đã commit = 0. · Nguồn: catalog 23 §6.4 (sinh từ mã + cổng drift)
- [ ] `DB-MODEL-010` **SHOULD** Mô hình dữ liệu có từ điển dữ liệu: mỗi bảng/cột quan trọng có mô tả (`COMMENT ON`) và phân loại nhạy cảm (public/internal/PII/secret). → Kiểm: `COMMENT` phủ ≥ 90% bảng; cột PII gắn nhãn (comment hoặc bảng phân loại) — dùng ở [`sensitive-data-and-access.md`](sensitive-data-and-access.md). · Nguồn: OWASP ASVS 5.0 V14.1.1 (phân loại dữ liệu nhạy cảm)
- [ ] `DB-MODEL-011` **SHOULD** Dùng `text` + `CHECK` thay `varchar(n)` tuỳ tiện; mã định danh ngoài (mã đơn, số hoá đơn) có `UNIQUE` và định dạng `CHECK` regex. → Kiểm: lint schema; test chèn mã sai định dạng bị từ chối. · Nguồn: P6
- [ ] `DB-MODEL-012` **SHOULD** Phi chuẩn hoá (cột tổng, cache đếm, JSONB) có ghi lý do trong comment/ADR và có job/trigger đồng bộ + test "tính lại từ nguồn = giá trị cache". → Kiểm: test đối chiếu; comment trên cột. · Nguồn: P5
- [ ] `DB-MODEL-013` **SHOULD** Trạng thái nghiệp vụ (đơn hàng, thanh toán) là máy trạng thái: bảng/CHECK liệt kê trạng thái, chuyển trạng thái kiểm ở một hàm/service duy nhất, lịch sử chuyển được ghi. → Kiểm: test chuyển trạng thái không hợp lệ bị từ chối; bảng `*_status_history`. · Nguồn: [`../01-baseline/data-correctness.md`](../01-baseline/data-correctness.md)
- [ ] `DB-MODEL-014` **SHOULD** Cột JSONB có `CHECK` kiểu/khoá bắt buộc và GIN index khi truy vấn theo nội dung; schema JSON của cột commit trong repo. → Kiểm: `contracts/db/<table>.<col>.schema.json`; test chèn JSON sai bị từ chối. · Nguồn: PostgreSQL 18 JSON types
- [ ] `DB-MODEL-015` **SHOULD** Bảng lớn theo thời gian (log, sự kiện, đo lường) phân vùng theo khoảng (range) ngay từ đầu khi dự kiến vượt bộ nhớ máy chủ; có chính sách xoá/lưu trữ phân vùng cũ. → Kiểm: `\d+` cho thấy partitioned table; job detach/drop phân vùng theo lịch. · Nguồn: PostgreSQL 18 §5.12 (partition khi bảng > RAM; vài nghìn partition là trần hợp lý)
- [ ] `DB-MODEL-016` **SHOULD** Cột văn bản so sánh không phân biệt dấu/hoa thường (tên, email) có chiến lược rõ: `citext`, hoặc index trên `lower(f_unaccent(col))` với `f_unaccent` là hàm bọc **IMMUTABLE** gọi `public.unaccent('public.unaccent'::regdictionary, $1)` — `unaccent()` của extension là STABLE nên PostgreSQL từ chối nó trực tiếp trong index biểu thức và cột generated (xem [`search-and-vector.md`](search-and-vector.md)). → Kiểm: migration tạo index biểu thức chạy được trên Postgres thật; test tìm "Nguyễn" khớp "nguyen" nếu nghiệp vụ yêu cầu. · Nguồn: [`search-and-vector.md`](search-and-vector.md)
- [ ] `DB-MODEL-017` **SHOULD** Dùng identity thay `serial`; sequence không được giả định liên tục (gap là bình thường); số thứ tự nghiệp vụ liên tục (hoá đơn) sinh bằng bảng đếm có khoá. → Kiểm: grep `serial` trong migration mới = 0; test số hoá đơn liên tục dưới đồng thời. · Nguồn: PostgreSQL 18 §5.3 Identity Columns
- [ ] `DB-MODEL-018` **MAY** Bảng lịch sử append-only (event sourcing nhẹ) cho thực thể cần tái dựng trạng thái theo thời gian; trạng thái hiện tại là projection. → Kiểm: test tái dựng từ lịch sử = trạng thái hiện tại.
- [ ] `DB-MODEL-019` **MAY** Dùng `GENERATED ALWAYS AS (...) STORED` cho cột dẫn xuất thay vì tính ở ứng dụng. → Kiểm: cột generated trong schema; không có code ghi cột đó.
- [ ] `DB-MODEL-020` **MAY** SQLite: bật `PRAGMA foreign_keys=ON` mỗi kết nối, `STRICT` tables (3.37+), WAL mode; thời gian lưu ISO-8601 UTC. → Kiểm: test FK bị từ chối; `PRAGMA journal_mode` = wal; schema có `STRICT`.

## Bẫy thường gặp

- **`timestamp` không tz + server đổi múi giờ** → dữ liệu lệch 7 giờ im lặng. Tránh: DB-MODEL-001.
- **`float` cho tiền** → `0.1 + 0.2 ≠ 0.3`, tổng sổ cái lệch vài đồng; **`money`** vỡ khi restore ở locale khác. Tránh: DB-MODEL-002.
- **UUIDv4 làm PK bảng hàng trăm triệu dòng** → index phân mảnh, chèn chậm; RFC 9562 ghi khác biệt có thể tới một bậc. Tránh: UUIDv7/bigint (DB-MODEL-003).
- **Soft-delete nửa vời**: UNIQUE(email) chặn đăng ký lại sau khi "xoá"; truy vấn quên lọc `deleted_at`. Tránh: DB-MODEL-006.
- **Xoá theo yêu cầu người dùng chỉ soft-delete** → không đạt quyền xoá (Luật 91/2025/QH15 Đ.14 + NĐ 356/2025/NĐ-CP — xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md); GDPR Art. 17). Tránh: xoá thật/ẩn danh hoá — xem [`sensitive-data-and-access.md`](sensitive-data-and-access.md) và [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md).
- **FK không index** → `DELETE` cha quét toàn bảng con, khoá lâu. Tránh: DB-MODEL-004.
- **Enum PostgreSQL cho trạng thái hay đổi** → không xoá/đổi tên giá trị được, migration khó. Tránh: bảng tra cứu hoặc CHECK (bảng Quyết định).
- **Mọi thứ vào JSONB** → mất ràng buộc, không index, ứng dụng tự parse. Tránh: DB-MODEL-014.
- **Chọn MongoDB/Redis vì "nhanh"** mà không đọc giấy phép (SSPL/RSALv2) và nhu cầu giao dịch. Tránh: bảng Quyết định + [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md).

## Cổng tự động

| Việc kiểm | Công cụ (phiên bản · giấy phép, xác minh 2026-10-13) | Lệnh/cách | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Lint SQL migration (kiểu cấm, serial, timestamp không tz) | sqlfluff 4.4.0 · MIT (rule tuỳ biến) + script grep | `sqlfluff lint migrations/` + `python3 scripts/db-lint.py` | pre-commit + CI | 0 vi phạm |
| Migration an toàn PostgreSQL | squawk 2.68.0 · Apache-2.0/MIT (xem [`migrations.md`](migrations.md)) | `squawk migrations/*.sql` | pre-commit + CI | 0 lỗi |
| FK thiếu index / FK thiếu hành động / bảng thiếu audit cột | truy vấn catalog `pg_constraint`/`pg_index` trong script | `psql -f scripts/db-checks.sql` | CI (sau migrate) | 0 dòng |
| Drift tài liệu schema | atlas 1.3.0 (Apache-2.0, community) `schema inspect` / `pg_dump --schema-only` | so với `docs/db/schema.sql` | CI | diff = 0 |
| Ràng buộc chặn dữ liệu xấu | test tích hợp chèn trực tiếp qua SQL | `pytest tests/db/` | CI | test xanh |
| Test unit schema (hàm, trigger, ràng buộc) | pgTAP 1.3.4 · PostgreSQL License | `pg_prove tests/db/*.sql` | CI | 100% pass |

## Nguồn

- PostgreSQL 18 docs: §8.5 Date/Time (timestamptz lưu UTC) <https://www.postgresql.org/docs/current/datatype-datetime.html>; §8.1 Numeric <https://www.postgresql.org/docs/current/datatype-numeric.html>; §8.2 Money <https://www.postgresql.org/docs/current/datatype-money.html>; `uuidv7()` <https://www.postgresql.org/docs/current/functions-uuid.html>; Identity columns <https://www.postgresql.org/docs/current/ddl-identity-columns.html>; CREATE TABLE (referential actions) <https://www.postgresql.org/docs/current/sql-createtable.html>; Partitioning <https://www.postgresql.org/docs/current/ddl-partitioning.html> — xác minh 2026-10-13.
- RFC 9562 UUIDs (obsoletes RFC 4122; §5.7 UUIDv7; §6.11 sortable; §6.13 lưu 128-bit): <https://www.rfc-editor.org/rfc/rfc9562> — xác minh 2026-10-13.
- Phiên bản (endoflife.date, xác minh 2026-10-13): PostgreSQL 18.6 (14 EOL 2026-11-12) <https://endoflife.date/api/postgresql.json>; MySQL 8.4.11 LTS, 9.7.2 (lts: true) <https://endoflife.date/api/mysql.json>; SQLite 3.54.0 <https://endoflife.date/api/sqlite.json>; MongoDB 9.0.2 / 8.3.11 <https://endoflife.date/api/mongodb.json>.
- Giấy phép: MongoDB Community = SSPL (từ 2018-10-16) <https://www.mongodb.com/legal/licensing/community-edition>; OSI: SSPL không phải open source (2021-01-19) <https://opensource.org/blog/the-sspl-is-not-an-open-source-license>; Redis/Valkey xem [`../05-architecture/resilience-and-scalability.md`](../05-architecture/resilience-and-scalability.md) — xác minh 2026-10-13.
- SQLite — When to use: <https://www.sqlite.org/whentouse.html>; WAL: <https://www.sqlite.org/wal.html> — xác minh 2026-10-13.
- OWASP ASVS 5.0 V14 Data Protection (14.1.1 phân loại): <https://github.com/OWASP/ASVS/blob/master/5.0/en/0x23-V14-Data-Protection.md> — xác minh 2026-10-13.
- Công cụ: sqlfluff 4.4.0 MIT (PyPI); squawk-cli 2.68.0 (npm); atlas 1.3.0 Apache-2.0 (brew); pgTAP 1.3.4 (PGXN) — xác minh 2026-10-13.
- Catalog `seeker19110/stored` 23 §4.1 (dhcb rule: migration lũy đẳng/timestamptz), 23 §6.4; khung cũ `quality-supplements.md` mục "Số & tiền" (commit `1b80fe4`).
