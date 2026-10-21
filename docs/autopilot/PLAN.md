# docs/autopilot/PLAN.md — Hotel Manager · Đợt 16: hoàn thiện ở dev — phần còn lại của audit 🟢

> **Cổng duyệt: phiên chính tự duyệt 2026-10-21** (AGENTS §5; D-089 ở `docs/autopilot/DECISIONS.md`). Tiếp đợt 15 (`archive/PLAN-dot-15.md`, PR #116 chờ người merge); xếp chồng cùng nhánh (D-088).

## Tóm tắt cổng duyệt (≤ 30 dòng)
- **Mục tiêu:** đóng các phát hiện 🟢 còn mở của audit 2026-10-19 làm được trong repo: múi giờ hiển thị/"hôm nay" theo cơ sở, rào CSDL theo vai trò cho ghi hồ sơ người và phiếu thu (phòng thủ chiều sâu), N+1 khi xem trước kỳ thu, tài liệu lệch mã.
- **Không làm (lý do ở D-089):** AUD-SEC-003 bác bỏ — ma trận SPEC-access xếp đảo thanh toán vào "Phân bổ tiền, điều chỉnh có lý do" (= `payment.allocate`); AUD-DATA-005/006, AUD-PERF-002 (ghi theo dòng, chưa đo được hại), AUD-XFEAT-005 phần mã `DUPLICATE` (đổi mã lỗi là breaking API); AUD-HAR-001 chờ chủ dự án.
- **Stack:** giữ nguyên; không thêm phụ thuộc. Migration mới 0065 (chỉ thêm policy, có `down`).
- **Task:** 6 (T-1601…T-1606), 2 lát. Sửa lỗi có test đỏ trước.
- **Rủi ro:** (R1) policy RESTRICTIVE mới chặn nhầm luồng hợp lệ (worker, nhập liệu, check-in tạo khách) — chạy toàn bộ test DB; (R2) gom truy vấn kỳ thu đổi kết quả tiền — so khớp từng đồng với bản cũ trên cùng dữ liệu.
- **Điểm dừng:** PR chạm CSDL/tiền ⇒ người merge.
- **Ngân sách:** `--single-session` · 1800 s/lệnh · 24 giờ.

## Mục tiêu của kế hoạch này
Khi xong: mọi giờ hiển thị và mốc "hôm nay" theo `properties.timezone`; vai buồng phòng/kỹ thuật/người thuê không ghi được hồ sơ người hay phiếu thu ngay ở tầng CSDL; xem trước kỳ thu của cơ sở N hợp đồng dùng số truy vấn không tăng theo N; ADR/AGENTS khớp mã.

## Ngân sách (4 con số)
- Số vòng tối đa: bỏ trống (`--single-session`)
- Ngân sách: ≤ 60 USD token
- Timeout mỗi lệnh Gate: 1800 s
- Hạn chót: 24 giờ kể từ `loop init` (`--hours 24`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | chưa có | — | — |
| Hạn mong muốn | 2026-10-22 | nội bộ | cắt T-1604 trước |

## Ủy quyền production
- grant: payments | mode=sandbox | max_per_txn=0 | refund=false
- grant: data_delete | hard_delete=false | max_rows=100
- grant: data_export | pii=false | max_rows=10000
- grant: outbound_messages | live=false | max_per_hour=0
- grant: auth_crypto | custom_crypto=false
- grant: secrets | read_values=false

## Điểm dừng bắt buộc về hành động
- Merge PR chạm `packages/db/*`, tiền, auth (ngoại lệ cứng): người merge.

## Thứ tự & lý do
1. **Lát 1 — múi giờ và tài liệu** (T-1601, T-1602, T-1605): nhỏ, độc lập file.
2. **Lát 2 — CSDL và hiệu năng** (T-1603, T-1604, T-1606): rủi ro cao hơn, tầng sâu, chạy song song vì khác file.

## Task

### Lát 1 — Múi giờ và tài liệu
- [x] `T-1601` AUD-XFEAT-003 + AUD-XFEAT-005 (phần định dạng số): mọi lời gọi `dateTime(…)` trong `apps/web` truyền múi giờ của cơ sở liên quan (không dựa mặc định); `portal/dien-nuoc` dùng helper định dạng chung thay `Intl.NumberFormat` gọi thẳng; rào: `dateTime` bắt buộc tham số múi giờ, không tự dựng Intl ngoài `lib/format.ts` (files: apps/web/app/, apps/web/lib/, apps/web/components/) — Gate: `pnpm vitest run --project unit apps/web/components && pnpm --filter @hm/web exec tsc -p tsconfig.json`
- [x] `T-1602` AUD-XFEAT-002 (phần còn lại): `reports.receivables` tính "hôm nay" theo `properties.timezone` của từng cơ sở (bỏ +7h cố định), `/ky-thu` lấy tháng mặc định theo cơ sở đang xem; test DB: cơ sở múi giờ khác ngày UTC cho đúng số ngày quá hạn (files: packages/app/src/reports/, apps/web/app/ky-thu/) — Gate: `pnpm vitest run --project db packages/app/src/reports`
- [x] `T-1605` Tài liệu: AUD-DOC-002 (ADR-0005 ghi `@serwist/turbopack` thay mục Serwist của ADR-0001, đổi dòng trạng thái ADR-0001, SPEC-pwa/research trỏ ADR mới), AUD-HAR-002 (AGENTS.md §9: dev/CI không cần Docker — `scripts/dev-env-setup.sh`, `pnpm dev:up`), AUD-SEC-003 → "bác bỏ" kèm lý do ở sổ audit (files: docs/adr/, docs/specs/SPEC-pwa.md, docs/research/, AGENTS.md, docs/ops/AUDIT-STATUS.md) — Gate: `pnpm vitest run --project unit scripts && python3 .xtemplates/scripts/xt.py audit check docs/ops/AUDIT-STATUS.md`

### Lát 2 — CSDL và hiệu năng
- [x] `T-1603` AUD-DATA-003 + AUD-DATA-004: migration 0065 thêm policy RESTRICTIVE theo `app.actor_role()` — `persons` INSERT/UPDATE chỉ owner/manager/front_desk/accountant (và đường worker/không actor giữ nguyên như 0064); `payments` ghi và `shift_discrepancies` INSERT chỉ vai được ghi nhận thanh toán theo ma trận SPEC-access; `down` gỡ đúng các policy; test DB đỏ trước: housekeeping/maintenance/tenant INSERT `persons`/`payments` = lỗi RLS, các vai hợp lệ và luồng sẵn có (check-in tạo khách, nhập liệu, worker) vẫn xanh (exec: deep; files: packages/db/src/migrations/, packages/testkit/src/) — Gate: `pnpm vitest run --project db packages/testkit/src/migration-0065 packages/app/src/http/authz-matrix packages/app/src/payments packages/app/src/stay`
- [x] `T-1604` AUD-PERF-001: `billing` `buildPreview` gom truy vấn theo lô (hợp đồng, công tơ, chỉ số, giá) thay vòng lặp mỗi hợp đồng; test DB: cơ sở 1 và 20 hợp đồng (điện + nước) — số truy vấn không tăng theo số hợp đồng (đếm qua log query của Kysely) và kết quả xem trước trùng từng đồng với bản cũ (exec: deep; files: packages/app/src/billing/, packages/app/src/metering/) — Gate: `pnpm vitest run --project db packages/app/src/billing`
- [ ] `T-1606` Rà đợt 16: sổ audit (đã sửa / bác bỏ / còn mở có lý do), PROGRESS (sau: T-1601, T-1602, T-1603, T-1604, T-1605; files: docs/ops/AUDIT-STATUS.md, PROGRESS.md) — Gate: `python3 .xtemplates/scripts/xt.py audit check docs/ops/AUDIT-STATUS.md && python3 .xtemplates/scripts/xt.py progress-check`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| Merge #116 và PR đợt này | chủ dự án (ngoại lệ cứng) | xếp chồng cùng nhánh (D-088) |
