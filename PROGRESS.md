# PROGRESS.md — Hotel Manager

> Giai đoạn hiện tại: G5 Dựng nền (autopilot đợt 1) · Cập nhật: 2026-10-15 · Nhánh: claude/gifted-noether-iybenn

## Đang làm
- Autopilot đợt 1 **xong 14/14 task** (T-001…T-014), bằng chứng `.autopilot/evidence/T-001…T-014.json` (exit 0) + CI PR #4. Chờ chủ dự án review/merge PR #4.

## Tiếp theo
1. Chủ dự án: review PR #4; quyết các đề xuất còn treo (E2E + diễn tập PITR vào CI; ruleset/required checks; máy quét mã độc thật; mã hoá cột số giấy tờ).
2. Lập PLAN đợt 2 (luồng nghiệp vụ R-001…R-005 trên lõi đã có: đặt/nhận/trả phòng, hợp đồng, kỳ thu, thanh toán) — trả lời câu hỏi [chặn] đợt 2 trong SPEC trước.
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
- Nợ kỹ thuật chấp nhận: phần pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — phải đối chiếu văn bản gốc trước khi dùng dữ liệu thật.

## Bàn giao phiên
- Commit cuối trên nhánh chính: `502819e7b8bc837f7d51478d90e837c31767efd8` (kế hoạch, PR #3). Đợt 1 nằm ở nhánh `claude/gifted-noether-iybenn` (PR #4, chưa merge) · CI PR #4: quality + gitleaks + dep-audit xanh.
- Lệnh kiểm nhanh: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `pnpm --filter web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh` trước (PG17, pgBackRest, SeaweedFS, Node 24).
- Đang chặn: không.
- Việc dở chưa commit: không.
- Câu hỏi cần người: các đề xuất ở *Tiếp theo* mục 1; câu hỏi [chặn] đợt 2–3 trong SPEC (PO).
