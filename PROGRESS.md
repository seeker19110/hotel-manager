# PROGRESS.md — Hotel Manager

> Giai đoạn hiện tại: G5 Dựng nền (autopilot đợt 1) · Cập nhật: 2026-10-15 · Nhánh: claude/gifted-noether-iybenn

## Đang làm
- Autopilot đợt 2 (PLAN duyệt) — Pha 2: T-101…T-108 xong có bằng chứng (`.autopilot/evidence/`), kế tiếp **T-109** hợp đồng (schema/ký/giữ chỗ). PR nháp #5.

## Tiếp theo
1. Chủ repo import ruleset `.github/rulesets/main.json` (Settings → Rules → Rulesets → Import) — agent không có API để bật.
2. Lập PLAN đợt 2: luồng R-001…R-005 (đặt/nhận/trả phòng, hợp đồng, kỳ thu, thanh toán) trên lõi đợt 1; trả lời câu hỏi [chặn] đợt 2 trong SPEC trước. Kèm: chọn máy quét mã độc thật, quyết mã hoá cột số giấy tờ, lưu cơ sở đang chọn (`property_id` của switchOrganization mới chỉ kiểm + trả về), route `GET /api/v1/commands/{id}`.
3. Người làm song song: quan sát 6–10 cơ sở + baseline M-01…M-03; DPIA + pháp lý đối chiếu bản gốc; mua VPS tại VN + kho sao lưu khác máy; chọn SMTP relay; giấy phép mã nguồn.

## Quyết định
- 2026-10-15 Repo hotel-manager chuyển thành repo sản phẩm; khung X-Templates 2.0.0 cài ở `.xtemplates/` (người dùng chọn).
- 2026-10-15 Đợt tự động đầu chỉ lập kế hoạch G0–G4, chưa viết code (người dùng chọn).
- 2026-10-15 Tự host toàn bộ (người dùng chọn): Postgres 17 + pgBackRest, Better Auth, SeaweedFS, Caddy, SMTP relay — ADR-0002. Dev/CI không mua dịch vụ.
- 2026-10-15 Blueprint: web-app + saas-multitenant + fintech, quy mô M (4 miễn đã duyệt: IND-FIN-009/010, IND-SAAS-005/012). Khung chưa có gói ngành lưu trú.
- 2026-10-15 Stack đề xuất ở ADR-0001 (proposed): Node 24 · Next 16.4 · PostgreSQL 17 · Kysely · pg-boss · Serwist (auth/storage/sao lưu: ADR-0002) · Vitest/Playwright/Testcontainers · Biome · pnpm.
- 2026-10-15 Review độc lập bộ kế hoạch: 6 🔴 · 21 🟠 · 19 🟢 — đã sửa trong DOMAIN-MODEL 1.2, SPEC v2, API-CONTRACT, THREAT-MODEL 1.1, PLAN (14 task).
- 2026-10-15 Chủ dự án duyệt PLAN đợt 1 (PR #3 merge): pilot theo backlog; mặc định tham số hoá cho câu hỏi [chặn] đợt 1; 4 miễn blueprint; 70 vòng / 48 giờ / 1800 s / ≤ 150 USD.
- 2026-10-15 Import trong workspace dùng đuôi `.ts` (`allowImportingTsExtensions`) để Turbopack, Vitest, tsc, Node cùng hiểu.
- 2026-10-15 Hook cổng commit không chạy được vì phiên mở ở `/home/user` (không thấy `xt.yaml`) → mọi commit qua `scripts/commit-gated.sh` (exit code thật).
- 2026-10-15 Relay outbox và liệt kê tổ chức đi qua hàm SECURITY DEFINER phạm vi hẹp; không mở BYPASSRLS/policy rộng cho worker.
- 2026-10-15 CI đỏ từ T-009 do 3 file test cùng bắn 100 lệnh song song qua pool 120 trên Postgres CI 100 kết nối → pool runtime ≤ 20 + cluster cục bộ đặt `max_connections=100` như CI (hàng rào: lỗi cạn kết nối lộ ra ở máy). Gitleaks bắt hằng mật khẩu giả trong test T-006 → ghép chuỗi lúc chạy + fingerprint ở `.gitleaksignore`.
- 2026-10-15 PWA: Serwist 9.5.13 bản Turbopack (`@serwist/turbopack`, SW bundle bằng esbuild qua route `/serwist/sw.js`); precache chỉ asset tĩnh + icon + `/offline`; tắt `cacheOnNavigation`/`reloadOnOnline` mặc định của Serwist (trái S-005/S-008); layout render động để Next gắn nonce CSP.
- 2026-10-15 Ngữ cảnh tổ chức của web: cookie `hm_org` (API: header `X-Org-Id`) chỉ để CHỌN; mọi request vẫn `resolveActor` tra membership.
- 2026-10-15 E2E chạy cục bộ bằng Chromium có sẵn (`/opt/pw-browsers`, Playwright 1.64.1 qua `executablePath`); chưa đưa E2E và diễn tập PITR vào CI (đổi CI là điểm dừng — chờ duyệt).
- 2026-10-15 Review độc lập T-011…T-014: 0 🔴 · 6 🟠 · 11 🟢. Đã sửa 🟠1–5 (GPS trong ảnh phụ sau EOI, object mồ côi → `ctx.onRollback` bù trừ, strip ảnh chặn event loop, WAL không ra kho ngoài + URL ký không qua Caddy, đổi tổ chức không xoá dữ liệu máy) và 🟢 1–5, 9, 11. Còn treo: 🟠6 (đổi CI/gitleaks cần duyệt), 🟢 RLS giấy tờ theo cơ sở, RLS mặc định từ chối owner_type mới, cookie `__Host-`, chuẩn hoá phản hồi chọn tổ chức theo API-CONTRACT.
- 2026-10-15 Chủ dự án giao quyền quyết các điểm treo đợt 1 ("chất lượng cao nhất"): giữ thay đổi CI/gitleaks/pnpm của PR #4; sửa hết gợi ý review (0007 RLS giấy tờ theo cơ sở + files mặc định từ chối; `session.switchOrganization` đúng API-CONTRACT kèm idempotency lưu `idempotency_keys`; cookie `__Host-`); merge PR #4 khi CI xanh. Đưa E2E + PITR vào CI: bản vá đã soạn nhưng bị chặn quyền sửa workflow — chờ chủ dự án cấp quyền hoặc tự áp.
- 2026-10-15 Đợt 2, quyết trong lúc chạy (theo SPEC khi ERD/ma trận lệch): lễ tân ĐỌC ca/thanh toán trong phạm vi nhưng chỉ GHI cái của mình (để trả 403 đúng S-028/S-034); kế toán đóng/đối chiếu ca, không mở ca; kế toán thấy yêu cầu duyệt (403 khi duyệt, S-033); hạn mức phân bổ mặc định của quản lý = 5.000.000 đ (trước là 0 → quản lý không phân bổ được); tiền mặt dự kiến tính từ sổ phụ; đảo tiền mặt khi ca gốc đã chốt → dòng CASH vào ca đang mở của người đảo. Gate `pnpm test:db -- x` chạy toàn bộ test DB (pnpm không lọc). Bài học lặp: `loop record … | tail` nuốt exit code → luôn `set -o pipefail`.
- 2026-10-15 T-107: webhook không có người dùng ⇒ thanh toán hệ thống `source='bank_auto'` (`recorded_by`/`confirmed_by` NULL như `files.uploaded_by`), chỉ worker (`app_worker`, policy riêng) ghi, chỉ khi có webhook đã xác minh (trigger) và khớp đúng 1 phiếu không vượt số còn; còn lại vào `reconciliation_breaks`. Dấu vân tay giao dịch = mã + số tiền (bỏ thời điểm: sao kê chỉ có ngày). VietQR theo 3 chuỗi mẫu tự khớp CRC — văn bản NAPAS gốc (chưa xác minh), kiểm lại trước G7. Break do vai trò `payment.confirm_transfer` (owner/manager/accountant) xử lý; QR cho người thuê tự xem chờ cổng người thuê.
- 2026-10-15 T-108: khoá kỳ theo `business_date` cơ sở (chỉ ngày đã qua, chỉ tiến; mở khoá từ ngày X nhả mọi khoá ≥ X), trigger PERIOD_LOCKED trên `journal_entries`/`payments` (+`charges` ở T-113). Điều chỉnh chỉ GIẢM, luôn qua duyệt người khác (INV-G4), ghi kỳ mở bằng phiếu `adjustment` âm; số còn phải thu = cột sinh `invoices.open_amount`. Tăng tiền = phiếu phí mới. Báo cáo đọc từ sổ phụ; xuất CSV để SPEC-audit-reporting (job xuất).
- Nợ kỹ thuật chấp nhận: phần pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — phải đối chiếu văn bản gốc trước khi dùng dữ liệu thật.

## Bàn giao phiên
- Commit cuối trên nhánh chính: `07ba2a8639c13db751773a98da3ae6114cfad249` (đợt 1, PR #4, CI xanh 6/6).
- Lệnh kiểm nhanh: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `pnpm --filter web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh` trước.
- Đang chặn: không. Autopilot: tắt.
- Việc dở chưa commit: không.
- Câu hỏi cần người: mục *Tiếp theo* 1–3.
