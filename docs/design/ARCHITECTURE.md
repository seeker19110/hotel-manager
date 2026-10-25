# ARCHITECTURE — sơ đồ C4 mức 1–2 và luồng giao dịch (G4)

> Phiên bản 1 · 2026-10-15 · Draft, chờ duyệt.
> Quyết định stack: [ADR-0001](../adr/0001-modular-monolith-typescript-postgres.md). Mô hình dữ liệu: [DOMAIN-MODEL](DOMAIN-MODEL.md).

## C4 mức 1 — Bối cảnh hệ thống

```mermaid
flowchart LR
  staff["Nhân viên cơ sở<br/>(chủ, quản lý, lễ tân, kế toán,<br/>buồng phòng, kỹ thuật)"]
  tenant["Người thuê / khách lưu trú"]
  support["Hỗ trợ nền tảng<br/>(truy cập tạm thời)"]
  sys["Hotel Manager<br/>(web + PWA + portal)"]
  auth["Better Auth trong apps/web<br/>(danh tính, MFA TOTP — bảng trong Postgres)"]
  mail["Nhà cung cấp email<br/>(chưa chọn)"]
  bank["Ngân hàng / cổng webhook<br/>(sau pilot, khi có hợp đồng)"]
  gov["Cổng khai báo lưu trú<br/>(chỉ xuất mẫu, không tích hợp)"]
  staff --> sys
  tenant --> sys
  support --> sys
  sys --> auth
  sys --> mail
  bank -. webhook có chữ ký .-> sys
  sys -. file xuất thủ công .-> gov
```

## C4 mức 2 — Container

```mermaid
flowchart TB
  subgraph client["Trình duyệt / PWA đã cài"]
    ui["Next.js client<br/>React 19 + Serwist SW<br/>(app shell, không cache PII)"]
  end
  subgraph app["Ứng dụng (một codebase, hai process)"]
    web["apps/web — Next.js 16<br/>route handler / server action<br/>→ packages/app (command/query)"]
    worker["apps/worker — Node 24<br/>pg-boss consumer, outbox relay,<br/>job: nhả hold, nhắc nợ, tạo kỳ"]
  end
  db[("PostgreSQL 17<br/>RLS · EXCLUDE gist · sổ phụ<br/>outbox · inbox · idempotency · pg-boss")]
  files[("Object storage riêng tư<br/>(ảnh công tơ, bàn giao, giấy tờ)<br/>URL ký ngắn hạn")]
  ui -- HTTPS, cookie phiên --> web
  web -- role app_runtime, SET app.org_id --> db
  worker -- role app_worker --> db
  web -- URL ký --> files
  worker --> mail["Email adapter"]
```

## Lớp và quy tắc phụ thuộc

```text
apps/web (UI, HTTP)  ─┐
apps/worker (job)    ─┼─► packages/app (command/query: transaction, quyền, audit, outbox, idempotency)
                      │        └─► packages/domain (quy tắc thuần: giá, kỳ thu, prorata, làm tròn, state machine)
                      │        └─► packages/db (Kysely, SQL, migrations, RLS)
                      └─► (không được gọi thẳng packages/db từ UI)
```

- `packages/domain` không có I/O và không import `db`. Test bằng unit/property test (fast-check).
- `packages/app/<module>` chỉ export qua `index.ts`. Module này không ghi bảng tài chính của module khác. Ví dụ: Lease gọi `billing.createCharges`, không tự INSERT vào `charges`.
- Kiểm quyền hai lớp: `packages/app` dùng `authorize(actor, action, scope)` trước mọi command; RLS ở DB là lớp thứ hai.

## Luồng một command ghi (kế hoạch §11)

```text
1. HTTP POST + Idempotency-Key + phiên
2. Xác minh phiên Better Auth (cookie) → tra memberships → actor {person_id, org_id, roles, property_scopes, limits}
3. BEGIN; SET LOCAL app.org_id = actor.org_id; SET LOCAL app.actor_id = …
4. idempotency: INSERT … ON CONFLICT → nếu đã có kết quả: trả kết quả cũ; khác hash: 422 IDEMPOTENCY_CONFLICT
5. authorize(actor, action, scope) → domain rule → ghi nghiệp vụ (constraint DB là chốt cuối)
6. INSERT audit_events + outbox (cùng transaction)
7. COMMIT → 200/201 kèm command_id
8. worker: outbox → pg-boss → email/push/đối tác; thất bại → retry backoff → dead letter + cảnh báo
```

- Client timeout ở bước 7 → gọi `GET /api/v1/commands/{command_id}` để lấy kết quả, **không** gửi lệnh mới (kế hoạch §09, §13).
- Lỗi constraint (`23P01` chồng phòng, `23505` trùng) được dịch thành mã nghiệp vụ, không trả lỗi SQL thô.

## Hạn mức theo gói và fair-share worker (IND-SAAS-008, D-123)

- **Gói khai báo trong repo:** `packages/app/src/plans/plans.ts` (`free`, `standard`) — hạn mức số cơ sở, số phòng, số thành viên (kể cả lời mời đang chờ), lệnh ghi/phút/tổ chức, job đồng thời/tổ chức. Đổi hạn mức qua PR. `planFor(orgId)` là MỘT điểm tra cứu; `organizations` chưa có cột gói nên mọi tổ chức dùng `standard` (hạn mức rộng). Khi có thanh toán sẽ đọc gói từ CSDL ở chính hàm này.
- **Kiểm ở command:** `property.create`, `unit.create`, `member.invite` gọi `assertWithinPlan` (`plans/limits.ts`) — đếm bản ghi chưa lưu trữ dưới khoá advisory theo (tổ chức, loại). Bằng hạn mức vẫn tạo được, vượt một ⇒ `409 PLAN_LIMIT_REACHED` (thông điệp ở catalog i18n). Chỉ chặn TẠO MỚI; dữ liệu sẵn có vẫn đọc/sửa.
- **Rate limit lệnh ghi:** route lệnh (`http/command-route.ts`) truyền cho pipeline trần lệnh mới/phút/tổ chức lấy từ `planFor(orgId).commandsPerMinute` (cơ chế đếm sẵn có, xem API-CONTRACT §Rate limit).
- **Fair-share worker:** relay gửi job pg-boss kèm nhóm `{id: organization_id, tier: id gói}` (`apps/worker/src/relay.ts`, `jobGroup`); consumer chạy `DEFAULT_LOCAL_CONCURRENCY` luồng/queue với `groupConcurrency` theo bậc gói (`jobGroupConcurrency()`). Một tổ chức xếp nhiều job chỉ chiếm chừng `jobConcurrency` luồng; luồng còn lại lấy job tổ chức khác. Dùng `groupConcurrency` của pg-boss (đếm job đang chạy theo nhóm ngay trong câu lệnh lấy job, đúng với nhiều worker): trần MỀM — hai luồng lấy job cùng lúc có thể cùng lọt qua trần (tối đa số luồng), nhưng luồng rảnh luôn bỏ qua tổ chức đã đủ trần nên tổ chức khác không đợi hết hàng. Đã đo `localGroupConcurrency` (đếm trong bộ nhớ, chính xác hơn): job bị lấy rồi trả khiến luồng rảnh thăm dò lệch pha, tổ chức nhỏ đôi khi đợi gần hết hàng — không chọn. Test tải hai tổ chức: `apps/worker/src/fair-share.db.test.ts`.

## Môi trường

| Môi trường | CSDL | Auth | File | Email | Ghi chú |
|---|---|---|---|---|---|
| dev | Postgres 17 Docker | Better Auth (cùng DB) | SeaweedFS Docker | bản giả ghi file | dữ liệu giả, seed |
| CI | Postgres 17 (service container/Testcontainers) | phiên Better Auth seed giả | bộ nhớ | bản giả | không mạng ngoài |
| staging | VPS tự host riêng (mua VPS = điểm dừng) | Better Auth | SeaweedFS | SMTP sandbox | dữ liệu giả/ẩn danh |
| production | VPS tự host tại VN + pgBackRest PITR ra kho ngoài máy | Better Auth | SeaweedFS + đồng bộ ngoài máy | SMTP relay đã chọn | chỉ mở sau GO-NO-GO |

## Quan sát tối thiểu (G5)
- Log JSON có `correlation_id`, lọc PII (che số điện thoại, CCCD, token).
- Metrics: p95 theo route, lỗi theo mã, độ trễ outbox, số dead letter, số `reconciliation_break`.
- Healthcheck `/api/health` (DB + hàng đợi). Cảnh báo cấu hình ở G8.
