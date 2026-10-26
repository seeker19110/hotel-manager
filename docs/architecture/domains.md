# Miền nghiệp vụ ↔ mã nguồn, và hướng phụ thuộc cho phép

> Ranh giới module (ARC-MOD-004; kiến trúc modular monolith theo [ADR-0001](../adr/0001-modular-monolith-typescript-postgres.md)). Thuật ngữ và tên bảng: [DOMAIN-MODEL](../design/DOMAIN-MODEL.md); sơ đồ: [ARCHITECTURE](../design/ARCHITECTURE.md).
> `scripts/process-docs.test.mjs` kiểm: mọi thư mục `packages/app/src/*` có một dòng ở bảng 2 (và ngược lại), mọi import chéo thư mục tuân thủ thứ tự tầng ở bảng 3 (trừ vòng đã biết ở `packages/app/src/arch-guards.baseline.json`), mã trong `packages/*` không import `apps/*`.
> Ngày đo: 2026-10-16.

## 1. Các gói và hướng phụ thuộc
| Gói | Được phụ thuộc vào | Không được |
|---|---|---|
| `apps/web`, `apps/worker` | `@hm/app` (và `@hm/db`, `@hm/testkit` cho khởi tạo/test) | chứa quy tắc nghiệp vụ; route handler và job chỉ gọi lớp `packages/app` |
| `packages/app` | `@hm/domain`, `@hm/db` | import `apps/*` |
| `packages/domain` | không gì ngoài thư viện thuần (zod…) | I/O: `kysely`, `pg`, `fs`, `http`, `@hm/app`, `@hm/db` (test `arch-guards.test.ts`) |
| `packages/db` | `kysely`, `pg` | `@hm/app`, `@hm/domain` |
| `packages/testkit` | các gói trên, chỉ dùng trong test | được import từ mã sản phẩm |

Thư mục của `packages/domain/src` (quy tắc thuần): `access` (ma trận quyền, `authorize`) · `billing` (engine kỳ thu, làm tròn) · `date` (ngày ISO: `isIsoDate`, `isoDateOr`) · `format` (định dạng hiển thị qua `Intl`: tiền, ngày) · `import` (kiểm giá trị dòng import) · `money` (tiền số nguyên) · `payments` (đối soát thuần, QR, sao kê CSV) · `state` (máy trạng thái) · `stay` (giá lưu trú, thông báo lưu trú) · `text` (chuỗi tuỳ chọn: thiếu ≠ rỗng ≠ 0 — `blankToNull`, `firstNonBlank`, `keepIfUndefined`) · `units` (hằng đơn vị byte/thời gian, ADR-0003).

## 2. Thư mục `packages/app/src/*` ↔ miền
Miền theo ranh giới của ADR-0001 (kế hoạch §11); cột "Tầng" dùng ở mục 3. Việc gán thư mục vào miền theo mục đích thực tế của mã.

| Thư mục | Miền | Tầng | Vai trò |
|---|---|---|---|
| `access` | Access | B | Xác định người thao tác (`resolveActor`), ngữ cảnh tổ chức, khôi phục MFA |
| `pipeline` | Access | B | Command pipeline: idempotency, quyền, audit + outbox cùng transaction, lỗi → problem+json (điểm công khai `index.ts`) |
| `identity` | Access | C | Giấy tờ nhận dạng: mã hoá AES-256-GCM, blind index, che hiển thị |
| `approvals` | Access | C | Yêu cầu duyệt có hạn mức, cấm tự duyệt |
| `actor-core` | Access | A | Kiểu `Actor`/`Role` và `AccessError` thuần (không I/O) cho cả `access` và `pipeline`; tách ra để hai module không import vòng (điểm công khai `index.ts`) |
| `auth` | Nền | A | Better Auth (email/mật khẩu, TOTP, OTP người thuê), khoá tài khoản |
| `inventory` | Property & Inventory | C | Lịch tài nguyên, allocation, hold, block, phòng và đơn vị |
| `rental` | Lease | C | Truy vấn chỉ đọc cho giao diện nhà trọ (RLS quyết định phạm vi) |
| `lease` | Lease | E | Hợp đồng thuê, bàn giao, phụ lục, thanh lý |
| `stay` | Reservation & Stay | E | Đặt phòng, lưu trú, folio, trả phòng, giá, thông báo lưu trú |
| `metering` | Pricing & Meter | C | Dịch vụ, đơn giá hiệu lực, công tơ, chỉ số |
| `billing` | Billing & Ledger | E | Vòng đời kỳ thu: tạo, xem trước, duyệt, phát hành |
| `ledger` | Billing & Ledger | D | Sổ phụ, inbox ngân hàng, số dư đầu kỳ, chốt kỳ |
| `deposits` | Billing & Ledger | D | Cọc, hoàn và khấu trừ qua duyệt |
| `shifts` | Billing & Ledger | C | Ca quầy, tiền mặt dự kiến |
| `payments` | Payment & Reconciliation | D | Thanh toán và phân bổ |
| `reconciliation` | Payment & Reconciliation | D | Ghép giao dịch ngân hàng, tự ghi tiền, break đối soát |
| `housekeeping` | Housekeeping & Maintenance | C | Việc buồng phòng |
| `maintenance` | Housekeeping & Maintenance | C | Phiếu sự cố/sửa chữa |
| `notifications` | Notification & Integration | C | Thông báo trong app, email qua outbox, nhắc hạn, huỷ đăng ký |
| `files` | Notification & Integration | C | File riêng tư: kiểm magic bytes, quét clamd, S3, URL ký, staging ngoài transaction |
| `import` | Chuyển dữ liệu | E | Import Excel/CSV: xem trước, xác nhận, hạn giữ |
| `portal` | Portal | E | Mời người thuê, portal người thuê, liên kết khách |
| `audit` | Audit & Reporting | C | Nhật ký audit |
| `reports` | Audit & Reporting | C | Báo cáo thu/nợ/cọc/công suất |
| `exports` | Audit & Reporting | E | Xuất dữ liệu có xác thực lại và hạn link |
| `today` | Audit & Reporting | C | Màn Hôm nay theo vai trò |
| `observability` | Nền | A | Metric Prometheus, `/api/ready` |
| `outbox` | Nền | A | Schema zod payload sự kiện outbox (worker validate, T-401) |
| `retention` | Nền | A | Chính sách hạn giữ + job dọn bảng sự kiện (outbox đã phát, idempotency hết hạn, lần gửi thông báo đã xong) qua hàm CSDL của migration 0056 (điểm công khai `index.ts`, T-505) |
| `analytics` | Nền | A | Analytics sản phẩm tự host (T-2309, D-118): schema sự kiện allowlist một nơi, `track()` là điểm gửi duy nhất (cấm PII, mặc định không ghi tới khi có đồng ý), ghi `product_events` (migration 0067); lớp command gọi qua `trackCommand` (điểm công khai `index.ts`) |
| `logging` | Nền | A | Log JSON có cấu trúc, che bí mật/PII, sự kiện bảo mật |
| `crypto` | Nền | A | Mã hoá PII, khoá xoay |
| `config` | Nền | A | Schema biến môi trường, cấu hình worker |
| `db` | Nền | A | Pool kết nối Postgres có trần thời gian |
| `server` | Nền | E | Ngữ cảnh server (composition root): nối auth, db, storage, scanner |
| `http` | Cổng HTTP | F | Lớp HTTP không phụ thuộc Next: lõi route (`command-route`), registry command/query, OpenAPI, bảo mật header/CSRF, webhook, route adapter của module (tải file, tải import, huỷ đăng ký email, khách xem lưu trú) |
| `testing` | Kiểm thử | F | Helper test dùng chung trong packages/app (không vào bundle sản phẩm) |
| `privacy` | Quyền riêng tư | E | Đồng ý theo mục đích (`consent_records`, T-2310) và quyền chủ thể DSAR (`dsar_requests`, hạn theo vùng, worker xuất/xoá tài khoản — T-2311, D-123; dùng `files` cho URL ký, `pipeline` cho hạn mức), test đối chiếu data-map ↔ catalog CSDL |
| `tenancy` | Access | E | Vòng đời xoá tổ chức (T-2312, D-125): yêu cầu/huỷ (owner, xác thực lại qua `privacy.isRecentReauth`), trạng thái, job purge (`app.purge_organization`, object `files` trước), chứng nhận xoá; cùng test cách ly tenant (RLS) |

## 3. Hướng phụ thuộc cho phép giữa các thư mục
Tầng từ thấp lên cao: **A** nền · **B** lõi lệnh · **C** miền đơn · **D** tiền · **E** miền ghép · **F** cổng.

- Một thư mục chỉ import thư mục **cùng tầng hoặc thấp hơn**. Ví dụ `ledger` (D) được import `approvals` (C) nhưng không được import `stay` (E).
- Import cùng tầng được phép nhưng không được tạo vòng mới (rào ARC-MOD-004 ở `arch-guards.test.ts`, nền ratchet `arch-guards.baseline.json`).
- Không còn vòng phụ thuộc nền (T-409): `access` ↔ `pipeline` được gỡ bằng `actor-core` (tầng A, `access/actor.ts` xuất lại kiểu để đường import cũ vẫn dùng); `http` ↔ (`exports`, `files`, `import`, `notifications`, `portal`, `server`, `stay`) được gỡ bằng cách chuyển route adapter (`file-upload`, `import-upload`, `unsubscribe`, `guest-stay`) từ thư mục miền vào `http/` — module miền không còn import `http`. Nền `canh_trong_vong` ở `arch-guards.baseline.json` rỗng; vòng mới là test đỏ ngay.
- Chỉ `http` (F) được biết mọi miền (registry command/query); `server` (E) là nơi duy nhất ráp `auth`, `db`, kho file và máy quét thành ngữ cảnh.
- Thư mục mới ở `packages/app/src` phải thêm một dòng ở bảng 2 (chọn miền và tầng) trong cùng PR; test sẽ đỏ nếu thiếu.
- Biên module công khai (ARC-MOD-005): module chỉ import module khác qua `<module>/index.ts`. Hiện `actor-core` và `pipeline` đã có `index.ts` và không còn ai import tệp nội bộ của chúng. Các module còn lại chưa có `index.ts`: nền ratchet `import_noi_bo` ở `arch-guards.baseline.json` ghi 132 cạnh 'module nguồn → tệp nội bộ module đích' (nền cũ trước khi thêm `pipeline/index.ts` là 182); cạnh mới → `arch-guards.test.ts` đỏ, cạnh đã chuyển sang `index.ts` mà còn trong nền → test đòi xoá. `packages/app/src/index.ts` (gốc `@hm/app`) xuất lại hàm công khai cho `apps/*` và không thuộc module nào.
