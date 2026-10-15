# docs/autopilot/PLAN.md — Hotel Manager · Đợt 1: nền tảng (G5) + lõi dùng chung

> **Duyệt bởi chủ dự án ngày 2026-10-15** (PR #3 đã merge; đồng ý phạm vi pilot theo backlog, mặc định tham số hoá cho câu hỏi [chặn] đợt 1, 4 mục miễn blueprint, 4 con số ngân sách).
> Kiến trúc: ADR-0001 + ADR-0002 (tự host). Spec gốc: `docs/specs/SPEC-*.md` (F-001…F-012) · Blueprint: `BLUEPRINT.md` (web-app + saas-multitenant + fintech, quy mô M) · Kế hoạch gốc: backlog T009–T024, T033, T041, T073–T074, T099.

## Mục tiêu của kế hoạch này
Khi xong đợt này, repo có hàng rào chất lượng chạy thật: CI, cổng commit, Postgres thật trong test. Repo cũng có lõi mà mọi tính năng pilot dựa vào: tenant/RLS, quyền, idempotency + audit + outbox, allocation chống trùng, sổ phụ cân bằng, file riêng tư, PWA shell. Mỗi phần có test chứng minh bất biến:
- 100 lệnh tranh phòng → 1 allocation;
- 100 lần cùng payload → 1 hiệu lực;
- tổ chức A không đọc được dữ liệu của B.

Tương ứng mốc "Tuần 3–4" và một phần "Tuần 5–6" của kế hoạch gốc.

## Ngân sách (4 con số) — đề xuất, người chốt khi duyệt
- Số vòng tối đa: **70** (`--max-iterations 70`)
- Ngân sách: **≤ 150 USD** token cho đợt này (đề xuất). Hết ngân sách thì bàn giao và dừng.
- Timeout mỗi lệnh Gate: **1800 s** (`XT_RECORD_TIMEOUT`, mặc định)
- Ngày hết hạn: **48 giờ** kể từ `loop init` (`--hours 48`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | chưa có | — | — |
| Hạn mong muốn | tuần 4 kể từ ngày đội khởi động | trễ mốc pilot tuần 12 | cắt T-011/T-012 sang đợt 2; không hạ cổng |

## Điểm dừng bắt buộc (`python3 .xtemplates/scripts/xt.py loop block --reason "..."`)
- Mua VPS/tên miền, cấp quyền SSH, chọn vị trí dữ liệu (VN hay nước ngoài), đăng ký SMTP relay. Dev/CI chỉ dùng Docker cục bộ (ADR-0002).
- Secret thật, deploy staging/production, gửi email ra ngoài.
- Bật ruleset GitHub hoặc đổi required checks; đổi cấu hình cổng/CI/hook sau khi T-002 đã chốt (mọi job CI của đợt 1 nằm trong T-002).
- Spec hở hoặc mâu thuẫn: khi một câu hỏi **[chặn]** trong SPEC chạm tới task đang làm, dừng hỏi PO (prorata, làm tròn, giờ nhận/trả mặc định…).
- Dữ liệu thật của người dùng, kể cả mẫu hoá đơn chưa ẩn danh.
- Chọn giấy phép mã nguồn sản phẩm.
- Hai lần cùng lỗi Gate với hai cách tiếp cận khác nhau (máy tự BLOCKED ở lần 3).

## Câu hỏi [chặn] mà đợt 1 chạm tới — chạy bằng mặc định **tham số hoá** (người duyệt PLAN = chấp nhận cách này)
| Câu hỏi | Task | Cách xử lý trong đợt 1 |
|---|---|---|
| Giờ chốt ngày kinh doanh (access Q-01) | T-005 | Cột cấu hình theo cơ sở, mặc định 00:00; đổi giá trị không cần migration |
| MFA cho người có quyền tiền (access Q-06) | T-006 | Bắt buộc MFA cho mọi membership có quyền xác nhận/hoàn tiền |
| Ngưỡng thử sai, hết phiên (access Q-07) | T-006 | 5 lần sai → khoá 15 phút; phiên rảnh 12 giờ; là tham số |
| Khôi phục MFA (access Q-08) | — | Không làm ở đợt 1; chặn pilot |
| Ô ma trận chờ PO, hạn mức hoàn/xác nhận (access 5.3, ledger mục 10) | T-007 | Hạn mức nằm trong bảng cấu hình; mặc định = đề xuất ở SPEC |
| Quy tắc làm tròn (metering/ledger) | T-010 | Hàm nhận `rounding_rule`; mặc định `HALF_UP_1`; mỗi chứng từ lưu quy tắc đã dùng (INV-G3) |
Các câu [chặn] khác (prorata, giờ nhận/trả, huỷ, ghi nhận doanh thu…) chỉ chạm đợt 2–3 → dừng hỏi khi tới.

## Thứ tự và lý do
1. **Lát 0 — môi trường + hàng rào** (T-001…T-003). Không chạy được Gate thì không có bằng chứng; chưa có cổng thì mọi bằng chứng sau đều vô nghĩa.
2. **Lát 1 — ERD, tenant, quyền, command pipeline** (T-004…T-008). Đây là rủi ro R01 (truy cập chéo tenant), lỗi mức này chặn pilot. Mọi command sau đều đi qua pipeline này.
3. **Lát 2 — lõi tồn và tiền** (T-009, T-010). Rủi ro R02/R03 (bán trùng, ghi tiền trùng), là đường găng của kế hoạch §19.
4. **Lát 3 — file, sao lưu, PWA shell, E2E xương sống** (T-011…T-014).

## Task

> Gate dùng script do T-001 tạo. Trước T-001 chưa có `package.json` nên Gate của T-001 kiểm chính cổng.
> `scripts/dev-task.sh` ở đây là `.xtemplates/scripts/dev-task.sh`.

### Lát 0 — Môi trường và hàng rào chất lượng (F-000)
- [x] `T-001` Môi trường chạy không cần Docker cho agent: `scripts/dev-env-setup.sh` cài PostgreSQL 17 + pgBackRest ≥ 2.59.3 từ kho PGDG, SeaweedFS 4.48 (binary `weed`), Node 24 + pnpm 12 (idempotent, không cần root khi đã có); `scripts/dev-env-check.sh` in phiên bản và thoát ≠ 0 nếu thiếu/sai major — Gate: `bash scripts/dev-env-check.sh`
- [x] `T-002` Dựng pnpm workspace (apps/web Next 16, apps/worker, packages/domain|app|db|testkit), TypeScript strict (kiểm TS 7, lỗi thì 5.x + ghi ADR-0001), Biome, Vitest, lockfile đóng băng (`--frozen-lockfile`, BASE-DEP-002); điền `xt.yaml`; **toàn bộ CI ở task này** (`.github/workflows/ci.yml`): job `quality` chạy `dev-task.sh gate` trên Node 24 + service Postgres 17, `gitleaks`, `dep-audit` (`pnpm audit --prod`), kiểm license (chặn AGPL/GPL trong phụ thuộc chạy, BASE-DEP-005), action ghim SHA + `permissions` tối thiểu (SEC-SUPPLY-001, BASE-GATE-010), lịch quét hằng tuần (SEC-SUPPLY-006) — Gate: `.xtemplates/scripts/dev-task.sh gate`
- [x] `T-003` Schema env (Zod) validate lúc khởi động (BASE-CFG-002), `.env.example` khớp schema, che secret khi dump (BASE-CFG-005); logger JSON có `correlation_id`, che PII/secret (BASE-ERR-005/006/007), sự kiện bảo mật (SEC-LOG-001); test build client không chứa biến secret (TM-10) — Gate: `pnpm vitest run packages/app/src/config packages/app/src/logging`

### Lát 1 — Dữ liệu, tenant, quyền, command pipeline (F-001)
- [x] `T-004` ERD chi tiết + từ điển dữ liệu (`docs/design/ERD.md`: mọi bảng ở DOMAIN-MODEL §1/§7, cột, khoá, chủ module, ví dụ ghi sổ) — tiền đề migration theo kế hoạch §12; `scripts/check-erd.sh` đối chiếu danh sách bảng DOMAIN-MODEL ↔ ERD — Gate: `bash scripts/check-erd.sh`
- [x] `T-005` packages/db: runner migration Kysely (up/down); `pnpm test:db` dùng `TEST_DATABASE_URL` nếu có (service Postgres 17 của CI), không thì tự dựng cluster Postgres 17 tạm từ binary của T-001 (không cần Docker); extension `btree_gist`/`pgcrypto`; role `app_runtime`/`app_worker` (không owner, không BYPASSRLS); bảng tổ chức/cơ sở/tầng/loại phòng/phòng/cá nhân/thành viên/phạm vi với FK ghép `organization_id`; RLS **FORCE** + `WITH CHECK` (DB-SEC-007); `statement_timeout`, `idle_in_transaction_session_timeout` (DB-TX-003, TM-13) (INV-G1, INV-G2) — Gate: `pnpm test:db -- tenancy`
- [x] `T-006` Xác thực: Better Auth ≥ 1.7.9 trên Postgres (adapter Kysely/`pg`), chỉ bật email/mật khẩu + `twoFactor` + quản lý phiên (test liệt kê plugin), cookie phiên HttpOnly, `/api/v1/me`, chọn tổ chức qua membership; MFA bắt buộc cho owner/manager/accountant và mọi membership có quyền xác nhận/hoàn tiền (access Q-06, mặc định); khoá tạm sau 5 lần sai, phiên rảnh 12 giờ (Q-07, tham số); thu hồi membership → mất quyền ngay — Gate: `pnpm test:db -- auth`
- [x] `T-007` `authorize(actor, action, scope)` + ma trận quyền 5.3 của SPEC-access-and-property; hạn mức tiền là **tham số** trong bảng cấu hình theo tổ chức (giá trị mặc định = đề xuất, PO đổi không cần sửa mã); bộ test chéo tenant dùng chung; ngoài phạm vi → 404 — Gate: `pnpm test:db -- access`
- [x] `T-008` Command pipeline: idempotency (INV-G5), `audit_events` append-only (SEC-LOG-007) + `outbox` cùng transaction (INV-G6), bọc retry lỗi 40001/40P01 (DB-TX-002), `GET /api/v1/commands/{id}` (`committed|in_progress|failed`), problem+json; kiểm `Origin` cho ghi + CSP có nonce (TM-09); khung state machine khai báo + property test mọi cặp chuyển không hợp lệ (IND-FIN-005); worker pg-boss relay outbox, payload job mang `organization_id` (IND-SAAS-003), retry/backoff/dead letter — Gate: `pnpm test:db -- command-pipeline`

### Lát 2 — Lõi tồn phòng và sổ tiền (F-002, F-005)
- [ ] `T-009` Inventory: `allocations` tstzrange + EXCLUDE gist (INV-I1/I2), hold có `expires_at` + nhả đúng một lần (INV-I3), `blocks`, trạng thái phòng 3 chiều, chuyển phòng nguyên tử; test 100 lệnh song song tranh một phòng → đúng 1 thành công — Gate: `pnpm test:db -- inventory`
- [ ] `T-010` Lõi sổ tiền: `packages/domain/money` (một hàm làm tròn nhận `rounding_rule`, mặc định `HALF_UP_1` theo đề xuất; property test fast-check; ví dụ 3.580.000/1.580.000 và 1.430.000/930.000 ở mức hàm tính); `journal_entries`/`journal_lines` cân bằng (trigger deferred, INV-F1), append-only (INV-G4), bút toán đảo; `inbox` + `bank_transactions` unique (INV-F4, INV-F4b) với adapter `sim`: 100 lần cùng payload → 1 inbox, 1 bank transaction. (Phiếu, payment, phân bổ và INV-F2 thuộc đợt 2.) — Gate: `pnpm test:db -- ledger`

### Lát 3 — File, phục hồi, PWA, xương sống E2E (F-009, F-012)
- [ ] `T-011` File riêng tư: adapter S3 tới SeaweedFS 4.48 (binary cục bộ của T-001 hoặc container trong CI), khoá object có tiền tố `organization_id` (IND-SAAS-003), bảng `files`/`identity_documents`, URL ký ≤ 5 phút cấp sau kiểm quyền, allowlist MIME + magic bytes, giới hạn dung lượng, bỏ EXIF; housekeeping xin URL giấy tờ → 404 (TM-06, TM-07) — Gate: `pnpm test:db -- files`
- [ ] `T-012` Sao lưu/khôi phục thử với dữ liệu giả: `scripts/db-backup-restore-check.sh` dùng Postgres 17 + pgBackRest (repo cục bộ mã hoá): full backup → ghi thêm → PITR về mốc trước khi ghi → so số dòng và Σ bút toán; kèm `deploy/compose.yaml` ghim digest postgres/seaweedfs/caddy cho VPS (chưa triển khai) (backlog T099, ADR-0002) — Gate: `bash scripts/db-backup-restore-check.sh`
- [ ] `T-013` Design system tối thiểu (form, lỗi, trạng thái tải/rỗng/lỗi, vùng chạm ≥ 44px), PWA manifest + Serwist app shell, báo mất mạng, SW không cache route PII (SPEC-pwa) — Gate: `pnpm --filter web exec playwright test pwa`
- [ ] `T-014` E2E xương sống: đăng nhập (seed giả) → chọn tổ chức → danh sách phòng của cơ sở được phép, kèm kiểm axe (WCAG 2.2 AA) — Gate: `pnpm --filter web exec playwright test smoke`

### Các đợt sau (chưa phải task máy — chi tiết hoá khi đợt 1 xong và SPEC được duyệt)
- Đợt 2 — Trọ: F-003 hợp đồng/bàn giao · F-004 công tơ/kỳ thu · F-005 phiếu/thu/phân bổ/cọc/QR/đối soát thủ công · F-010 import.
- Đợt 3 — Khách sạn và vận hành: F-006 booking/lưu trú/folio · F-007 buồng phòng/sự cố · F-008 portal · F-011 thông báo · F-012 báo cáo/xuất.
- Đợt 4 — Cổng pilot (G7): E2E R-001…R-005, kiểm tải k6, `GO-NO-GO.md`, `blueprint-status --strict`. Song song, người làm: DPIA, pháp lý, chọn hosting, UAT, pilot.

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| Môi trường agent không có Docker daemon | kho PGDG, GitHub releases (mạng phiên hiện tại truy cập được) | T-001 cài Postgres 17/pgBackRest/SeaweedFS trực tiếp; Gate chạy cục bộ ra exit code cho `loop record`; CI (Docker) là kiểm chứng thứ hai trước merge. Container phiên bị thu hồi → chạy lại `dev-env-setup.sh` (nên đưa vào setup script của môi trường) |
| Quyết định PO cho câu hỏi [chặn] trong SPEC | PO | đợt 1 không phụ thuộc; đợt 2 sẽ dừng hỏi |

## Ước lượng (agent + review người)
| Task | P50 | P90 |
|---|---|---|
| T-001, T-003, T-004, T-011, T-014 | 0,5 ngày mỗi task | 1 ngày |
| T-002 (scaffold + toàn bộ CI) | 1 ngày | 1,5 ngày |
| T-005…T-010 | 1 ngày mỗi task | 2 ngày |
| T-012 (PITR + compose), T-013 | 1 ngày | 2 ngày |
Tổng P50 khoảng 12 ngày, P85 khoảng 18 ngày. Không dùng con số P50 làm ngày hứa.
