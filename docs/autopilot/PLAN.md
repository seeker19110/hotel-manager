# docs/autopilot/PLAN.md — Hotel Manager · Đợt 1: nền tảng (G5) + lõi dùng chung

> **Chưa duyệt.** Cổng duyệt duy nhất: người dùng duyệt file này cùng PROJECT, BLUEPRINT, ADR-0001, các SPEC và `docs/design/`.
> Spec gốc: `docs/specs/SPEC-*.md` (F-001…F-012) · Blueprint: `BLUEPRINT.md` (web-app + saas-multitenant + fintech, quy mô M) · Kế hoạch gốc: backlog T009–T024, T033, T041, T073–T074, T099.

## Mục tiêu của kế hoạch này
Khi xong đợt này, repo có hàng rào chất lượng chạy thật: CI, cổng commit, Postgres thật trong test. Repo cũng có lõi mà mọi tính năng pilot dựa vào: tenant/RLS, quyền, idempotency + audit + outbox, allocation chống trùng, sổ phụ cân bằng, file riêng tư, PWA shell. Mỗi phần có test chứng minh bất biến:
- 100 lệnh tranh phòng → 1 allocation;
- 100 lần cùng payload → 1 hiệu lực;
- tổ chức A không đọc được dữ liệu của B.

Tương ứng mốc "Tuần 3–4" và một phần "Tuần 5–6" của kế hoạch gốc.

## Ngân sách (4 con số) — đề xuất, người chốt khi duyệt
- Số vòng tối đa: **60** (`--max-iterations 60`)
- Ngân sách: **≤ 150 USD** token cho đợt này (đề xuất). Hết ngân sách thì bàn giao và dừng.
- Timeout mỗi lệnh Gate: **1800 s** (`XT_RECORD_TIMEOUT`, mặc định)
- Ngày hết hạn: **48 giờ** kể từ `loop init` (`--hours 48`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | chưa có | — | — |
| Hạn mong muốn | tuần 4 kể từ ngày đội khởi động | trễ mốc pilot tuần 12 | cắt T-011/T-012 sang đợt 2; không hạ cổng |

## Điểm dừng bắt buộc (`python3 .xtemplates/scripts/xt.py loop block --reason "..."`)
- Tạo tài khoản, dịch vụ trả phí hoặc hosting (Supabase cloud, Render/Fly, nhà cung cấp email). Dev/CI chỉ dùng Docker cục bộ.
- Secret thật, deploy staging/production, gửi email ra ngoài.
- Bật ruleset GitHub hoặc đổi required checks; đổi cấu hình cổng/CI/hook sau khi T-001 đã chốt.
- Spec hở hoặc mâu thuẫn: khi một câu hỏi **[chặn]** trong SPEC chạm tới task đang làm, dừng hỏi PO (prorata, làm tròn, giờ nhận/trả mặc định…).
- Dữ liệu thật của người dùng, kể cả mẫu hoá đơn chưa ẩn danh.
- Chọn giấy phép mã nguồn sản phẩm.
- Hai lần cùng lỗi Gate với hai cách tiếp cận khác nhau (máy tự BLOCKED ở lần 3).

## Thứ tự và lý do
1. **Lát 0 — hàng rào** (T-001, T-002). Chưa có cổng thì mọi bằng chứng sau đều vô nghĩa.
2. **Lát 1 — tenant + quyền + command pipeline** (T-003…T-006). Đây là rủi ro R01 (truy cập chéo tenant), lỗi mức này chặn pilot. Mọi command sau đều đi qua pipeline này.
3. **Lát 2 — lõi tồn và tiền** (T-007, T-008). Rủi ro R02/R03 (bán trùng, ghi tiền trùng), là đường găng của kế hoạch §19.
4. **Lát 3 — file, sao lưu, PWA shell, E2E xương sống** (T-009…T-012).

## Task

> Gate dùng script do T-001 tạo. Trước T-001 chưa có `package.json` nên Gate của T-001 kiểm chính cổng.
> `scripts/dev-task.sh` ở đây là `.xtemplates/scripts/dev-task.sh`.

### Lát 0 — Hàng rào chất lượng (F-000)
- [ ] `T-001` Dựng pnpm workspace (apps/web Next 16, apps/worker, packages/domain|app|db|testkit), TypeScript strict (kiểm tương thích TS 7, nếu lỗi thì dùng 5.x và ghi vào ADR-0001), Biome, Vitest; điền `xt.yaml` (lint = `biome ci` + typecheck dự án; test; build); workflow `.github/workflows/ci.yml` job `quality` chạy đúng `dev-task.sh gate` trên Node 24 — Gate: `.xtemplates/scripts/dev-task.sh gate`
- [ ] `T-002` Schema env (Zod) validate lúc khởi động (BASE-CFG-002), `.env.example` khớp schema, che secret khi dump (BASE-CFG-005), job `gitleaks` + `dep-audit` (`pnpm audit --prod`) trong CI — Gate: `pnpm vitest run packages/app/src/config`

### Lát 1 — Tenant, quyền, command pipeline (F-001)
- [ ] `T-003` packages/db: runner migration Kysely (up/down), Postgres 17 qua Testcontainers, extension `btree_gist`/`pgcrypto`, role `app_runtime`/`app_worker` (không owner, không BYPASSRLS), bảng `organizations`, `properties`, `floors`, `room_types`, `units`, `persons`, `memberships` với FK ghép `organization_id` + RLS theo `app.org_id` (INV-G1, INV-G2) — Gate: `pnpm test:db -- tenancy`
- [ ] `T-004` Xác thực: Supabase Auth local (Supabase CLI), đổi token → cookie phiên HttpOnly, `/api/v1/me`, chọn tổ chức qua membership, MFA bắt buộc cho owner/manager/accountant, thu hồi membership → phiên mất quyền ngay (SPEC-access S-xxx) — Gate: `pnpm vitest run packages/app/src/access/auth`
- [ ] `T-005` `authorize(actor, action, scope)` + ma trận quyền từ SPEC-access-and-property, phạm vi cơ sở, hạn mức tiền; bộ test chéo tenant dùng chung (factory hai tổ chức) cho mọi query — Gate: `pnpm test:db -- access`
- [ ] `T-006` Command pipeline: idempotency (INV-G5), `audit_events` + `outbox` cùng transaction (INV-G6), `GET /api/v1/commands/{id}`, problem+json theo API-CONTRACT; worker pg-boss relay outbox → handler giả, retry/backoff/dead letter — Gate: `pnpm test:db -- command-pipeline`

### Lát 2 — Lõi tồn phòng và sổ tiền (F-002, F-005)
- [ ] `T-007` Inventory: `allocations` tstzrange + EXCLUDE gist (INV-I1/I2), hold có `expires_at` + nhả đúng một lần (INV-I3), `blocks`, trạng thái phòng 3 chiều, chuyển phòng nguyên tử; test 100 lệnh song song tranh một phòng → đúng 1 thành công — Gate: `pnpm test:db -- inventory`
- [ ] `T-008` Ledger: `packages/domain/money` (một hàm làm tròn, property test fast-check), `journal_entries`/`journal_lines` cân bằng (trigger deferred, INV-F1), append-only (INV-G4), bút toán đảo, `inbox` unique cho webhook mô phỏng (INV-F4); test 100 lần cùng payload → 1 hiệu lực; tái hiện ví dụ 3.580.000/1.580.000 và 1.430.000/930.000 — Gate: `pnpm test:db -- ledger`

### Lát 3 — File, phục hồi, PWA, xương sống E2E (F-009, F-012)
- [ ] `T-009` File riêng tư: adapter storage (local/S3-compatible), URL ký ≤ 5 phút cấp sau kiểm quyền, allowlist MIME + magic bytes, giới hạn dung lượng, bỏ EXIF; housekeeping xin URL giấy tờ → 404 (TM-06, TM-07) — Gate: `pnpm test:db -- files`
- [ ] `T-010` Sao lưu/khôi phục thử với dữ liệu giả: `scripts/db-backup-restore-check.sh` dump → restore sang DB mới → so số dòng và Σ bút toán (backlog T099) — Gate: `bash scripts/db-backup-restore-check.sh`
- [ ] `T-011` Design system tối thiểu (form, lỗi, trạng thái tải/rỗng/lỗi, vùng chạm ≥ 44px), PWA manifest + Serwist app shell, báo mất mạng, SW không cache route PII (SPEC-pwa) — Gate: `pnpm --filter web exec playwright test pwa`
- [ ] `T-012` E2E xương sống: đăng nhập (seed giả) → chọn tổ chức → danh sách phòng của cơ sở được phép, kèm kiểm axe (WCAG 2.2 AA) — Gate: `pnpm --filter web exec playwright test smoke`

### Các đợt sau (chưa phải task máy — chi tiết hoá khi đợt 1 xong và SPEC được duyệt)
- Đợt 2 — Trọ: F-003 hợp đồng/bàn giao · F-004 công tơ/kỳ thu · F-005 phiếu/thu/phân bổ/cọc/QR/đối soát thủ công · F-010 import.
- Đợt 3 — Khách sạn và vận hành: F-006 booking/lưu trú/folio · F-007 buồng phòng/sự cố · F-008 portal · F-011 thông báo · F-012 báo cáo/xuất.
- Đợt 4 — Cổng pilot (G7): E2E R-001…R-005, kiểm tải k6, `GO-NO-GO.md`, `blueprint-status --strict`. Song song, người làm: DPIA, pháp lý, chọn hosting, UAT, pilot.

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| Docker trong môi trường chạy agent/CI | runner GitHub Actions có Docker | không có Docker → test DB chạy bằng service container trong CI; local dùng Postgres cài sẵn |
| Supabase CLI local | image Docker của Supabase | Auth giả (JWT ký bằng khoá test) cho test; tích hợp thật để sau |
| Quyết định PO cho câu hỏi [chặn] trong SPEC | PO | đợt 1 không phụ thuộc; đợt 2 sẽ dừng hỏi |

## Ước lượng (agent + review người)
| Task | P50 | P90 |
|---|---|---|
| T-001 | 0,5 ngày | 1 ngày |
| T-002, T-009, T-010, T-012 | 0,5 ngày mỗi task | 1 ngày |
| T-003…T-008 | 1 ngày mỗi task | 2 ngày |
| T-011 | 1 ngày | 1,5 ngày |
Tổng P50 khoảng 9 ngày, P85 khoảng 14 ngày. Không dùng con số P50 làm ngày hứa.
