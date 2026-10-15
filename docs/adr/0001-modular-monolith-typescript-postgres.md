---
status: proposed — phần hosting, xác thực, lưu file, sao lưu bị thay bởi ADR-0002
implementation-status: not-started
date: 2026-10-15
decision-makers: chủ dự án (chờ duyệt ở cổng PLAN)
consulted: kế hoạch gốc v1.0 §11–§13; nghiên cứu docs/research/2026-10-15-stack-va-phap-ly.md
informed: đội phát triển
---

# ADR-0001: Modular monolith TypeScript gồm Next.js, worker Node và PostgreSQL 17; truy cập DB bằng SQL-first (Kysely)

## Bối cảnh và vấn đề
Kế hoạch gốc đã chọn modular monolith TypeScript, Next.js, PostgreSQL managed qua Supabase, worker bền và transactional outbox. Kế hoạch cũng nói rõ V1 chưa cần Redis, Kafka hay microservices. ADR này chốt các phần kế hoạch còn để mở: phiên bản, lớp truy cập dữ liệu, thư viện hàng đợi, cách xác thực, công cụ, cấu trúc repo và hosting.

Lõi nghiệp vụ dựa vào các tính năng PostgreSQL mà ORM thường không biểu diễn được:
- `tstzrange` + `EXCLUDE USING gist` để chống đặt trùng phòng;
- RLS theo tổ chức;
- ràng buộc cân đối bút toán (Σ Nợ = Σ Có);
- khoá hàng khi phân bổ tiền.

## Yếu tố quyết định
- Bất biến tiền/tồn phải nằm **trong cơ sở dữ liệu** và được test trên Postgres thật, không chỉ kiểm ở tầng app.
- Mọi gói là OSI, đang được bảo trì, ghim phiên bản; ưu tiên thư viện chuẩn và ít phụ thuộc.
- Đội 4 FTE, một ngôn ngữ cho web, API và worker.
- Dev và CI không cần tài khoản trả phí. Đổi nhà cung cấp được nhờ SQL thuần và export.
- Runtime DB role không phải owner và không có BYPASSRLS (kế hoạch §12).

## Các phương án đã cân nhắc
1. **Kysely + migration SQL (Kysely Migrator) + pg-boss + Supabase Auth.**
2. Drizzle ORM + drizzle-kit + Graphile Worker.
3. Prisma 8 + Prisma Migrate.
4. Tự viết lớp truy cập bằng `pg` thuần.

## Quyết định
Chọn **phương án 1**:

| Thành phần | Chọn | Phiên bản ghim (xác minh 2026-10-15) | Ghi chú |
|---|---|---|---|
| Runtime | Node.js LTS | 24.x (EOL 2028-04-30) | Chuyển sang 26 LTS bằng một task riêng sau 2026-10-28, khi CI xanh trên 26 |
| Gói | pnpm workspace | 12.11.x | Không dùng Turborepo ở V1: chỉ có 2 app và vài package, `pnpm -r` là đủ |
| Web + API | Next.js App Router · React | 16.4.x · 19.3.x | Route handler/server action chỉ gọi lớp `application`, không chứa quy tắc nghiệp vụ |
| Ngôn ngữ | TypeScript `strict` | 7.0.x. Nếu T-001 thấy Next 16 chưa tương thích TS 7 thì dùng 5.x mới nhất và ghi vào ADR này | |
| CSDL | PostgreSQL | 17 (khớp mặc định Supabase hosted [T]; local dùng image `postgres:17`) | Extension cần có: `btree_gist`, `pgcrypto` |
| Truy cập DB | Kysely (query builder có kiểu) + SQL thô cho constraint/RLS | 0.29.x | Migration là file TS chạy SQL, có `up` và `down` |
| Hàng đợi | pg-boss + bảng `outbox` riêng | 12.x | Nhận job từ outbox, retry, dead letter |
| Xác thực | Supabase Auth (GoTrue): email/mật khẩu, MFA TOTP | supabase-js 2.117.x; local qua Supabase CLI 2.121.x | Server xác minh JWT. Quyền **không** lấy từ claim mà tra `memberships` |
| PWA | Serwist `@serwist/next` | 9.5.x | Không dùng next-pwa (bản cuối 2022) |
| Kiểm thử | Vitest · fast-check · Testcontainers (Postgres thật) · Playwright | 5.0.x · 4.10.x · 12.2.x · 1.64.x | Test bất biến chạy trên Postgres thật |
| Lint/format | Biome | 2.5.x | Một công cụ cho cả lint và format; `biome ci` nằm trong cổng `lint` |
| Hosting | **Chưa chọn — điểm dừng.** Ứng viên có vùng Singapore: Render (worker chạy liên tục [F]), Fly.io `sin` | — | Chọn khi cần môi trường staging; tạo tài khoản là việc của người |

Cấu trúc repo dự kiến:

```text
apps/web          Next.js: UI, route handler, PWA
apps/worker       Node: pg-boss consumer, outbox relay, job định kỳ
packages/domain   quy tắc thuần (giá, kỳ thu, prorata, làm tròn, state machine) — không I/O
packages/db       Kysely types, migrations, RLS, seed giả
packages/app      command/query handlers (transaction, kiểm quyền, audit, outbox)
packages/testkit  fixtures, Testcontainers, factory dữ liệu giả
```

Ranh giới module (kế hoạch §11): Access · Property & Inventory · Lease · Reservation & Stay · Pricing & Meter · Billing & Ledger · Payment & Reconciliation · Housekeeping & Maintenance · Notification & Integration · Audit & Reporting. Mỗi module có thư mục riêng trong `packages/app` và `packages/domain`. Module chỉ được gọi module khác qua API công khai `index.ts`. Quy tắc này kiểm bằng lint import của Biome hoặc bằng test kiến trúc.

### Hệ quả
- Tốt:
  - Constraint, RLS và bút toán viết bằng SQL nên đọc và review trực tiếp được.
  - Kysely sinh kiểu từ schema.
  - Không cần dịch vụ ngoài Postgres.
  - Dev và CI chạy offline với Docker.
- Xấu:
  - Tự viết nhiều SQL hơn ORM.
  - Kysely 0.x có thể đổi API, nên ghim minor và cập nhật qua Dependabot.
  - Supabase Auth ràng buộc vào nhà cung cấp. Giảm rủi ro bằng cách giữ bảng `persons`/`memberships` của mình và chỉ lưu `auth_user_id`.
- Việc phải làm tiếp: T-001 (scaffold, kiểm TS 7), T-003 (role DB + RLS), task chọn hosting ở đợt G5.

### Xác nhận
- `package.json` ghim đúng các major ở bảng trên.
- `pnpm test:db` chạy migration lên Postgres 17 trong Testcontainers, rồi chạy test: chồng phòng bị từ chối, bút toán lệch bị từ chối, role runtime không có `BYPASSRLS`.

## Ưu / nhược từng phương án
### 1. Kysely + SQL
- Tốt: biểu diễn được mọi tính năng Postgres, có kiểu, nhẹ, MIT.
- Xấu: ít "phép màu" hơn, phải tự viết migration.

### 2. Drizzle
- Tốt: có `pgPolicy` cho RLS [F], schema-as-code.
- Xấu: chưa xác minh được tstzrange/EXCLUDE [X], nên lõi chống trùng vẫn phải viết SQL thô. Vẫn là 0.x.

### 3. Prisma 8
- Tốt: hệ sinh thái lớn.
- Xấu: tag `latest` đang là bản rc [F]; range/exclusion/RLS phải đi qua `Unsupported`/SQL thô; lớp engine dày.

### 4. `pg` thuần
- Tốt: không thêm phụ thuộc.
- Xấu: không có kiểu từ schema, dễ sai cột khi refactor.

## Thông tin thêm
- Liên quan: `docs/design/DOMAIN-MODEL.md`, `docs/design/ARCHITECTURE.md`, `docs/design/THREAT-MODEL.md`.
- Nguồn: `docs/research/2026-10-15-stack-va-phap-ly.md`.
