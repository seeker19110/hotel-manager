# PROGRESS.md — Hotel Manager

> Giai đoạn hiện tại: G5 Dựng nền (autopilot đợt 1) · Cập nhật: 2026-10-15 · Nhánh: claude/gifted-noether-iybenn

## Đang làm
- Đợt 1 đã merge (PR #4). Đợt 2 nhà trọ: PR #5 (nhánh `claude/gifted-noether-iybenn`) CI xanh nhưng xung đột `BLUEPRINT.md`/`PROGRESS.md` với `main` sau PR #6 — gỡ: lấy BLUEPRINT của PR #5 rồi `compose --out` lại (giữ 87 đạt/36 miễn theo ID).
- Sửa khung X-Templates (nhánh `fix/pipefail-blueprint-path` của repo khung, 1a877b0 + 27e3a9d) và nâng `.xtemplates` ở nhánh `claude/peaceful-bardeen-27pu17`.

## Tiếp theo
1. Áp bản vá CI (job `e2e`, `backup-restore` + required checks) khi có quyền; import ruleset `.github/rulesets/main.json`; quyết máy quét mã độc thật và mã hoá cột số giấy tờ (đợt 2).
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
- 2026-10-15 Chủ dự án giao quyền quyết các điểm treo đợt 1 ("chất lượng cao nhất"): giữ thay đổi CI/gitleaks/pnpm của PR #4; sửa hết gợi ý review (0007 RLS giấy tờ theo cơ sở + files mặc định từ chối; `session.switchOrganization` đúng API-CONTRACT kèm idempotency lưu `idempotency_keys`; cookie `__Host-`); merge PR #4 khi CI xanh. Đưa E2E + PITR vào CI: bản vá đã soạn nhưng bị chặn quyền sửa workflow — chờ chủ dự án cấp quyền hoặc tự áp.
- 2026-10-15 Nâng khung X-Templates lên 4f99dfb — ADR-0008/0009/0010 (phiên chính tự duyệt điểm quyết định, mặc định tự host; autopilot một phiên + hook PreCompact; phản hồi về khung `xt.py feedback`). Blueprint ghép lại giữ trạng thái theo ID (+21 mục mới để `[ ]`, −7 mục ngừng dùng); FB-001…004 = 4 miễn đã duyệt.
- Nợ kỹ thuật chấp nhận: phần pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — phải đối chiếu văn bản gốc trước khi dùng dữ liệu thật.
- 2026-10-15 Sửa khung (theo yêu cầu "fix khung"): bằng chứng/cổng xanh giả khi Gate có ống; cổng commit chạy nhầm repo; verdict/blueprint-status xanh giả; ghép blueprint mất ghi chú/mục riêng; guard lọt `#`, `<<<`, push HEAD ở main, `switch -f`, `rm -rf .git`. Phản hồi FB-005…007. Từ nay task `[~]` trong PLAN phải ghi `— Bỏ: <lý do>`.

## Bàn giao phiên
- Commit cuối trên nhánh chính: `502819e7b8bc837f7d51478d90e837c31767efd8` (kế hoạch, PR #3). Đợt 1 nằm ở nhánh `claude/gifted-noether-iybenn` (PR #4, chưa merge) · CI PR #4: quality + gitleaks + dep-audit xanh.
- Lệnh kiểm nhanh: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `pnpm --filter web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh` trước (PG17, pgBackRest, SeaweedFS, Node 24).
- Đang chặn: không.
- Việc dở chưa commit: không.
- Câu hỏi cần người: các đề xuất ở *Tiếp theo* mục 1; câu hỏi [chặn] đợt 2–3 trong SPEC (PO).
