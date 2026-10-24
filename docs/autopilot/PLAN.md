# docs/autopilot/PLAN.md — Hotel Manager · Đợt 22: hoàn thiện XC-I18N-001 (mọi chuỗi người dùng thấy vào tệp tài nguyên)

> **Cổng duyệt: phiên chính tự duyệt 2026-10-24** (AGENTS §5; D-103, D-104, D-105 ở `docs/autopilot/DECISIONS.md`). Chủ dự án yêu cầu "hoàn thiện dự án" (2026-10-24) ⇒ làm hết phần còn lại của MUST duy nhất máy tự làm được; 89 MUST khác cần người (PROGRESS *Tiếp theo*).

## Tóm tắt cổng duyệt (≤ 30 dòng)
- **Mục tiêu:** XC-I18N-001 ĐẠT — baseline `scripts/i18n-literal-baseline.json` rỗng (1552 → 0) với ngoại lệ có lý do chỉ cho chuỗi KHÔNG phải người dùng thấy; tick MUST kèm Kiểm.
- **Còn lại:** `apps/web/lib/format.ts` 74 · màn web trong `merge_risk_paths` 195 · `packages/app/src` 1280 (lỗi API, email/thông báo, tệp xuất/nhập, PDF, nhật ký/vận hành).
- **D-103:** `lib/format.ts` (server + client cùng import) — nhãn tách: hàm nhận `m`/dùng `t()` ở server; client lấy qua `useMessages()` (khoá `common.`) hoặc `m` prop.
- **D-104:** `packages/app` có catalog riêng `packages/app/messages/vi.json` (cùng định dạng `{message, description}`) + `packages/app/src/i18n.ts` (`t()` typed, chỉ server); `i18n-check` kiểm cả hai catalog; mã lỗi API giữ nguyên (không breaking), chỉ `detail`/thông điệp lấy từ catalog.
- **D-105 (phạm vi):** chuỗi chỉ người vận hành/nhà phát triển thấy (log, mô tả metric, lỗi cấu hình lúc khởi động, mô tả OpenAPI) không thuộc "người dùng thấy" của XC-I18N-001 ⇒ danh sách ngoại lệ **theo tệp, có lý do**, ghi trong baseline, script kiểm lý do không rỗng; mọi tệp khác phải về 0.
- **Lát & PR:** Lát 1 (web `format.ts` + 2 🟢 review #130) và Lát 3 (`packages/app` nền + module ngoài `merge_risk_paths`) đi làn L3; Lát 2 (web màn tiền/hợp đồng) và Lát 4 (`packages/app` module tiền/lưu trú/auth) gom một PR **người merge** cuối cùng (một nhánh — D-088).
- **Stack:** giữ nguyên; không thêm phụ thuộc; không migration.
- **Rủi ro:** (R1) đổi chữ — giữ nguyên từng ký tự, reviewer đối chiếu bằng script; (R2) lỗi API đổi nội dung — test so `detail` cũ/mới; (R3) bundle — `pnpm size`; (R4) PR lớn — tách task ≤ ~150 chuỗi.
- **Điểm dừng:** PR chạm `merge_risk_paths`/auth/crypto ⇒ người merge.
- **Ngân sách:** `--single-session` · 1800 s/lệnh · 24 giờ.

## Mục tiêu của kế hoạch này
Khi xong: `node scripts/i18n-literals.mjs` báo 0 chuỗi ngoài ngoại lệ có lý do; `i18n-check` 0 lỗi trên 2 catalog; XC-I18N-001 `[x]`.

## Ngân sách (4 con số)
- Số vòng tối đa: bỏ trống (`--single-session`)
- Ngân sách: ≤ 80 USD token
- Timeout mỗi lệnh Gate: 1800 s
- Hạn chót: 24 giờ kể từ `loop init` (`--hours 24`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | chưa có | — | — |
| Hạn mong muốn | 2026-10-25 | nội bộ | dừng ở lát đã merge, phần còn lại đợt sau |

## Ủy quyền production
- grant: payments | mode=sandbox | max_per_txn=0 | refund=false
- grant: data_delete | hard_delete=false | max_rows=100
- grant: data_export | pii=false | max_rows=10000
- grant: outbound_messages | live=false | max_per_hour=0
- grant: auth_crypto | custom_crypto=false
- grant: secrets | read_values=false

## Điểm dừng bắt buộc về hành động
- Merge PR Lát 2 + Lát 4 (chạm `merge_risk_paths`, auth/crypto): người merge.

## Thứ tự & lý do
1. Lát 1 → PR (L3). 2. Lát 3 → PR (L3). 3. Lát 2 + Lát 4 → một PR người merge. 4. Lát 5 tick + rà. Chung `vi.json`/baseline ⇒ task tuần tự.

## Task

### Lát 1 — web `format.ts`
- [x] `T-2201` D-103: `apps/web/lib/format.ts` hết chuỗi viết thẳng (nhãn qua `t()` ở server / `useMessages()` hoặc `m` ở client; sửa mọi nơi gọi); thêm 2 🟢 review #130: `common.route_title.*` chỉ dùng ở `loading.tsx` đưa khỏi tiền tố `common.` (giảm payload), `use-command.test.tsx` thêm assert chữ cố định cho 5xx (exec: deep; files: apps/web/lib/, apps/web/app/, apps/web/components/, apps/web/messages/vi.json, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit scripts/i18n.test apps/web && pnpm --filter @hm/web exec tsc -p tsconfig.json`

### Lát 3 — `packages/app` nền + module ngoài `merge_risk_paths`
- [x] `T-2202` D-104 + D-105: catalog `packages/app/messages/vi.json`, `packages/app/src/i18n.ts` (`t()` typed); `scripts/i18n-check.mjs` kiểm cả hai catalog + test; `scripts/i18n-literals.mjs` hỗ trợ mục ngoại lệ theo tệp có lý do (không rỗng, test) — áp cho tệp chỉ vận hành/nhà phát triển thấy (observability, logging, config, http/openapi …, liệt kê từng tệp + lý do); chuyển `packages/app/src/errors.ts`, `packages/app/src/http/` (trừ openapi nếu ngoại lệ) (sau: T-2201; exec: deep; files: packages/app/messages/, packages/app/src/i18n.ts, packages/app/src/errors.ts, packages/app/src/http/, packages/app/src/observability/, packages/app/src/logging/, packages/app/src/config/, scripts/i18n-check.mjs, scripts/i18n-literals.mjs, scripts/i18n.test.mjs, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit scripts/i18n.test packages/app && pnpm -r exec tsc --noEmit -p tsconfig.json`
- [ ] `T-2203` XC-I18N-001: `packages/app/src/{import,exports,files,portal,pipeline,maintenance,housekeeping,today,billing,reports,payments,outbox,audit,retention,privacy}` hết chuỗi viết thẳng qua `t()` của packages/app (văn bản giữ nguyên; tệp xuất CSV/XLSX tiêu đề cột giữ nguyên) (sau: T-2202; files: packages/app/src/, packages/app/messages/vi.json, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit packages/app && pnpm vitest run --project db packages/app/src/import packages/app/src/exports packages/app/src/portal packages/app/src/payments && pnpm -r exec tsc --noEmit -p tsconfig.json`

### Lát 2 — web màn trong `merge_risk_paths` (người merge)
- [ ] `T-2204` XC-I18N-001: `apps/web/app/{hop-dong,ky-thu,thu-tien,doi-soat,chi-so,portal/hop-dong}/**`, `apps/web/components/rental/**`, `apps/web/app/api/**` hết chuỗi viết thẳng (sau: T-2203; files: apps/web/app/hop-dong/, apps/web/app/ky-thu/, apps/web/app/thu-tien/, apps/web/app/doi-soat/, apps/web/app/chi-so/, apps/web/app/portal/hop-dong/, apps/web/components/rental/, apps/web/app/api/, apps/web/messages/vi.json, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit scripts/i18n.test apps/web && pnpm --filter @hm/web exec tsc -p tsconfig.json`

### Lát 4 — `packages/app` module tiền/lưu trú/auth (người merge)
- [ ] `T-2205` XC-I18N-001: `packages/app/src/{stay,notifications}` (sau: T-2204; files: packages/app/src/stay/, packages/app/src/notifications/, packages/app/messages/vi.json, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit packages/app/src/stay packages/app/src/notifications && pnpm vitest run --project db packages/app/src/stay packages/app/src/notifications && pnpm -r exec tsc --noEmit -p tsconfig.json`
- [ ] `T-2206` XC-I18N-001: `packages/app/src/{lease,inventory,access,ledger,metering,deposits,reconciliation,shifts,approvals,identity,auth,crypto,tenancy,rental}` và mọi tệp `packages/app/src` còn trong baseline (sau: T-2205; files: packages/app/src/, packages/app/messages/vi.json, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit packages/app && pnpm vitest run --project db packages/app && pnpm -r exec tsc --noEmit -p tsconfig.json`

### Lát 5 — tick và rà
- [ ] `T-2207` XC-I18N-001 `[x]` kèm Kiểm (baseline chỉ còn ngoại lệ có lý do); PROGRESS, BLUEPRINT-GAPS, audit delta (sau: T-2206; files: BLUEPRINT.md, PROGRESS.md, docs/autopilot/BLUEPRINT-GAPS.md, docs/ops/AUDIT-STATUS.md) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs --strict && python3 .xtemplates/scripts/xt.py progress-check && python3 .xtemplates/scripts/xt.py audit check docs/ops/AUDIT-STATUS.md`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| Merge PR Lát 2 + 4 | chủ dự án (ngoại lệ cứng) | để PR mở, báo người |
| 89 MUST còn lại | chủ dự án | `loop defer` |
