# docs/autopilot/PLAN.md — Hotel Manager · Đợt 15: hoàn thiện ở dev trước production

> **Cổng duyệt: phiên chính tự duyệt 2026-10-21** (AGENTS §5; D-087, D-088 ở `docs/autopilot/DECISIONS.md`). Chủ dự án (2026-10-21): "trước hết chạy dev, hoàn thiện trước mới lên production".
> Kế hoạch đợt 1–2 và đợt 3–14 lưu ở `archive/` (`PLAN-dot-3-14.md`: 110 task, mọi task đã có bằng chứng xanh ở các phiên trước).
> Nền: PR #115 (`pnpm dev:up`, sửa điều hướng `/phong`, CSP dev) — chờ người merge (ngoại lệ cứng). Đợt này xếp chồng trên nhánh của #115.

## Tóm tắt cổng duyệt (≤ 30 dòng)
- **Mục tiêu:** đóng mọi phát hiện 🟢 còn mở của audit 2026-10-19 làm được trong repo, quét nhóm A11Y (nhóm duy nhất "chưa quét"), và cho môi trường dev giữ file tải lên giữa các lần chạy. Không đụng hạ tầng/production.
- **Blueprint:** MUST đạt 351 · miễn 59 · mở 91 (đều cần người — BLUEPRINT-GAPS). Đợt này không nhắm tick MUST mới; mục tiêu là sổ audit sạch hơn và trải nghiệm đúng.
- **Stack:** giữ nguyên (ADR-0001). Không thêm phụ thuộc.
- **Task:** 9 (T-1501…T-1509), 3 lát. Mỗi task một Gate máy kiểm; sửa lỗi có test đỏ trước.
- **Rủi ro:** (R1) đổi cách tính "hôm nay" ở quyền portal là auth/tenancy ⇒ ngoại lệ cứng, người merge; (R2) bắt buộc `SMTP_URL` ở production làm hỏng cấu hình đang chạy — chưa có production, E2E đặt tường minh; (R3) một nhánh duy nhất ⇒ PR #115 lớn dần (D-088).
- **Điểm dừng:** merge PR ngoại lệ cứng (người); không SMTP/ClamAV/VPS thật.
- **Ngân sách:** `--single-session` (trần vòng tự tính) · 1800 s/lệnh · 24 giờ.

## Mục tiêu của kế hoạch này
Khi xong: `pnpm dev:up` giữ ảnh tải lên qua SeaweedFS bền; sổ `docs/ops/AUDIT-STATUS.md` có nhóm A11Y đã quét và các phát hiện 🟢 đã sửa chuyển "đã sửa" kèm bằng chứng; người thuê không mất/không giữ quyền lệch 7 giờ quanh nửa đêm.

## Ngân sách (4 con số)
- Số vòng tối đa: bỏ trống (`--single-session`)
- Ngân sách: ≤ 60 USD token
- Timeout mỗi lệnh Gate: 1800 s (`XT_RECORD_TIMEOUT`, mặc định)
- Hạn chót: 24 giờ kể từ `loop init` (`--hours 24`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | chưa có | — | — |
| Hạn mong muốn | 2026-10-22 | nội bộ | cắt lát 3 trước |

## Ủy quyền production
- grant: payments | mode=sandbox | max_per_txn=0 | refund=false
- grant: data_delete | hard_delete=false | max_rows=100
- grant: data_export | pii=false | max_rows=10000
- grant: outbound_messages | live=false | max_per_hour=0
- grant: auth_crypto | custom_crypto=false
- grant: secrets | read_values=false

## Điểm dừng bắt buộc về hành động
- Merge PR ngoại lệ cứng (auth/mật mã/tiền/CSDL — `merge-check` trả `hard`): người merge.
- SMTP/ClamAV/VPS/tên miền/secret thật; gửi email ra ngoài.

## Thứ tự & lý do
1. **Lát 1 — quét A11Y + cấu hình an toàn** (T-1501…T-1503): nhóm audit duy nhất chưa quét; hai sửa nhỏ một hàm.
2. **Lát 2 — thống nhất chéo tính năng** (T-1504…T-1506): lỗi đúng/sai thật cho người dùng (quyền lệch múi giờ, danh sách cắt im lặng, 401 thiếu mã tra cứu).
3. **Lát 3 — dev bền + tài liệu + rà đợt** (T-1507…T-1509).

## Task

> Gate chạy bằng `set -o pipefail; python3 .xtemplates/scripts/xt.py loop record --task T-xxx -- '<Gate>'`. E2E dùng cổng riêng, không chạy song song với `loop verify`.

### Lát 1 — Quét A11Y và cấu hình an toàn
- [x] `T-1501` Nhóm 6 A11Y của audit: chạy axe trên MỌI route (E2E 320 px của `ux-guards.spec.ts`) + bàn phím; ghi `docs/ops/AUDIT-STATUS.md` nhóm 6 "đã quét" kèm SHA, phạm vi đã/chưa (trình đọc màn hình thật là việc người — STD-A11Y-004); phát hiện mới vào bảng (files: docs/ops/AUDIT-STATUS.md) — Gate: `E2E_PORT=3320 pnpm --filter @hm/web exec playwright test ux-guards && python3 .xtemplates/scripts/xt.py audit check docs/ops/AUDIT-STATUS.md`
- [x] `T-1502` AUD-CFG-001: production không còn mặc định `SMTP_URL=fake://local` — thiếu biến ở production thì khởi động lỗi nêu tên biến; dev/test giữ mặc định; `fake://` ở production chỉ khi đặt tường minh (E2E); test đỏ trước (files: packages/app/src/config/) — Gate: `pnpm vitest run --project unit packages/app/src/config`
- [x] `T-1503` AUD-SEC-002: `createDecipheriv(…, { authTagLength: 16 })` (và cipher) ở `pii.ts`; test: tag cắt ngắn bị từ chối (files: packages/app/src/crypto/) — Gate: `pnpm vitest run --project unit packages/app/src/crypto`

### Lát 2 — Thống nhất chéo tính năng
- [x] `T-1504` AUD-XFEAT-002 (phần quyền): `portal/access.ts` `tenantProperties` so `lease_occupants.to_on` với ngày địa phương của CƠ SỞ (`properties.timezone`) thay `current_date` (UTC của phiên CSDL); test DB: người ở cùng rời ngày D — lúc 23:30 giờ VN ngày D còn quyền, 00:30 ngày D+1 hết quyền (exec: deep; files: packages/app/src/portal/) — Gate: `pnpm vitest run --project db packages/app/src/portal/portal-access`
- [x] `T-1505` AUD-XFEAT-001: `reservation.list` trần 200 thành hằng `RESERVATION_LIST_LIMIT` (export); `/dat-phong` và `/lich-phong` hiện thông báo "đang hiện N đặt phòng đầu — thu hẹp khoảng ngày" khi chạm trần; test unit thông báo + `list-limits` vẫn xanh (files: packages/app/src/stay/reservations.ts, apps/web/app/dat-phong/, apps/web/app/lich-phong/, apps/web/components/) — Gate: `pnpm vitest run --project unit packages/app/src/http/list-limits apps/web/components`
- [x] `T-1506` AUD-XFEAT-004: `GET /api/v1/me` 401 có `correlation_id` + header `x-correlation-id` như mọi route; test (files: apps/web/app/api/v1/me/, packages/app/src/http/) — Gate: `pnpm vitest run --project unit packages/app/src/http`

### Lát 3 — Dev bền, tài liệu, rà đợt
- [x] `T-1507` Dev: `pnpm dev:up` dùng SeaweedFS bền ở `.dev/s3` khi có `weed` (`startS3Server({ dir })` giữ dữ liệu, không xoá khi dừng), không có `weed` thì về S3 giả trong bộ nhớ kèm cảnh báo; test testkit cho tuỳ chọn `dir` (files: packages/testkit/src/s3-server.ts, apps/web/scripts/dev-stack.ts, README.md) — Gate: `pnpm vitest run --project unit packages/testkit/src/s3-server && pnpm --filter @hm/web exec tsc -p tsconfig.json`
- [x] `T-1508` Tài liệu lệch mã: AUD-DOC-001 (README 0.2.0, compose có web+worker), AUD-DOC-003 (`INV-L*`), AUD-DOC-004 (`APPROVAL_NOT_EXECUTABLE` vào API-CONTRACT), AUD-ARCH-001 (trần pool RUNBOOK), AUD-CI-002 (chú thích khôi phục `commit-lint` theo tác giả PR) (files: README.md, docs/, packages/app/src/reports/reports.ts, .github/workflows/commit-lint.yml) — Gate: `python3 .xtemplates/scripts/xt.py ci-check .github/workflows && pnpm vitest run --project unit scripts`
- [ ] `T-1509` Rà đợt 15: `AUDIT-STATUS.md` chuyển các phát hiện đã sửa sang "đã sửa" kèm PR; PROGRESS (sau: T-1501, T-1502, T-1503, T-1504, T-1505, T-1506, T-1507, T-1508; files: docs/ops/AUDIT-STATUS.md, PROGRESS.md) — Gate: `python3 .xtemplates/scripts/xt.py audit check docs/ops/AUDIT-STATUS.md && python3 .xtemplates/scripts/xt.py progress-check`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| Merge #115 và PR đợt này | chủ dự án (ngoại lệ cứng) | đợt xếp chồng trên cùng nhánh |
| Trình đọc màn hình thật, thiết bị thật | người kiểm tay (STD-A11Y-004) | axe + bàn phím trong E2E |
